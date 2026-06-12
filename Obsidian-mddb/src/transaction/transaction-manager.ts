/**
 * 事务管理器 (TransactionManager)
 *
 * 提供显式事务 API 和 SQLite savepoint 回滚能力。
 *
 * 事务流程：
 * 1. SAVEPOINT → 打开 SQLite 保存点
 * 2. 执行用户回调中的 CRUD 操作（立即写入文件 + SQLite，在 savepoint 内）
 * 3. 成功 → 创建 WAL → RELEASE SAVEPOINT → 标记 WAL done
 * 4. 失败 → ROLLBACK TO SAVEPOINT（回滚 SQLite）→ 创建 WAL 用于文件恢复 → 重新抛出
 *
 * 参考：v2 roadmap §Milestone 5
 */
import type { RecordInput, RecordPatch, WriteResult } from '../core/types';
import type { WalOperation } from '../wal/types';
import type { SQLiteAdapter } from '../storage/sqlite-adapter';
import type { CRUDExecutor, WriteResult as CrudWriteResult } from '../write/crud-executor';
import type { SchemaRegistryStore } from '../storage/schema-registry';
import type { WalManager } from '../wal/wal-manager';
import type { Transaction, UpdatePair } from './types';
import { generateTxId } from '../write/write-plan';

// ============================================================
// 操作收集器
// ============================================================

/**
 * 在事务回调执行过程中收集 WAL 操作信息。
 */
class OperationCollector {
  private operations: WalOperation[] = [];

  constructor(readonly txId: string) {}

  add(op: WalOperation): void {
    this.operations.push(op);
  }

  getOperations(): WalOperation[] {
    return [...this.operations];
  }

  get count(): number {
    return this.operations.length;
  }
}

// ============================================================
// 事务代理实现
// ============================================================

class TransactionImpl implements Transaction {
  private _active = true;

  constructor(
    readonly txId: string,
    private crud: CRUDExecutor,
    private schemaRegistry: SchemaRegistryStore,
    private collector: OperationCollector,
  ) {}

  isActive(): boolean {
    return this._active;
  }

  async insert(table: string, record: RecordInput): Promise<WriteResult> {
    this.assertActive();
    const result = await this.crud.insert(table, record, { txId: this.txId });
    this.collectInsertOp(table, record, result);
    return this.toWriteResult(table, result);
  }

  async update(storagePk: string, patch: RecordPatch): Promise<WriteResult> {
    this.assertActive();
    const result = await this.crud.update(storagePk, patch);
    this.collectUpdateOp(storagePk, patch, result);
    return this.toWriteResult(result.tableName ?? '', result);
  }

  async delete(storagePk: string): Promise<WriteResult> {
    this.assertActive();
    const result = await this.crud.delete(storagePk);
    this.collectDeleteOp(storagePk, result);
    return this.toWriteResult(result.tableName ?? '', result);
  }

  async insertAll(table: string, records: RecordInput[]): Promise<WriteResult[]> {
    this.assertActive();
    const results: WriteResult[] = [];
    for (const record of records) {
      const r = await this.insert(table, record);
      results.push(r);
    }
    return results;
  }

  async updateAll(pairs: UpdatePair[]): Promise<WriteResult[]> {
    this.assertActive();
    const results: WriteResult[] = [];
    for (const { storagePk, patch } of pairs) {
      const r = await this.update(storagePk, patch);
      results.push(r);
    }
    return results;
  }

  async deleteAll(storagePks: string[]): Promise<WriteResult[]> {
    this.assertActive();
    const results: WriteResult[] = [];
    for (const pk of storagePks) {
      const r = await this.delete(pk);
      results.push(r);
    }
    return results;
  }

  /** 终止事务（在 commit/rollback 后调用） */
  terminate(): void {
    this._active = false;
  }

  // ============================================================
  // 内部
  // ============================================================

  private assertActive(): void {
    if (!this._active) {
      throw new Error(`Transaction ${this.txId} is no longer active`);
    }
  }

  private collectInsertOp(table: string, record: RecordInput, result: CrudWriteResult): void {
    // 构造 WalOperation 用于恢复
    const op: WalOperation = {
      id: `${this.txId}_insert`,
      type: 'insertLine',
      file: result.filePath ?? '',
      content: JSON.stringify(record),
    };
    this.collector.add(op);
  }

  private collectUpdateOp(storagePk: string, patch: RecordPatch, result: CrudWriteResult): void {
    const op: WalOperation = {
      id: `${this.txId}_update_${storagePk.slice(0, 8)}`,
      type: 'replaceLine',
      file: result.filePath ?? '',
      lineNumber: result.lineNumber ?? 0,
      beforeHash: '',
      afterContent: JSON.stringify(patch),
    };
    this.collector.add(op);
  }

  private collectDeleteOp(storagePk: string, result: CrudWriteResult): void {
    const op: WalOperation = {
      id: `${this.txId}_delete_${storagePk.slice(0, 8)}`,
      type: 'deleteLine',
      file: result.filePath ?? '',
      lineNumber: result.lineNumber ?? 0,
      beforeHash: '',
      beforeContent: '',
    };
    this.collector.add(op);
  }

  private toWriteResult(table: string, r: CrudWriteResult): WriteResult {
    return {
      storagePk: r.storagePk,
      table: r.tableName ?? table,
      syncState: r.syncState,
      lineNumber: r.lineNumber,
    };
  }
}

// ============================================================
// TransactionManager
// ============================================================

export class TransactionManager {
  constructor(
    private sqlite: SQLiteAdapter,
    private crud: CRUDExecutor,
    private walManager: WalManager,
    private schemaRegistry: SchemaRegistryStore,
  ) {}

  /**
   * 执行显式事务。
   *
   * @param cb 事务回调，接收 Transaction 对象
   * @returns 回调的返回值
   *
   * 事务保证：
   * - SQLite 变更在 savepoint 内执行，失败时完整回滚
   * - 文件写入在回调执行期间立即发生，通过 WAL 记录用于恢复
   * - WAL 在回调成功返回后创建并持久化
   */
  async transaction<T>(
    cb: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    const txId = generateTxId();
    const safeName = txId.replace(/[^a-zA-Z0-9_]/g, '_');
    const savepointName = `sp_${safeName}`;

    const collector = new OperationCollector(txId);
    const tx = new TransactionImpl(txId, this.crud, this.schemaRegistry, collector);

    // 1. 开始 savepoint
    this.sqlite.run(`SAVEPOINT "${savepointName}"`);

    try {
      // 2. 执行用户回调
      const result = await cb(tx);

      // 3. 成功路径
      const ops = collector.getOperations();
      if (ops.length > 0) {
        // 持久化 WAL 记录所有操作
        await this.walManager.createWal(txId, ops);
        await this.walManager.updateStatus(txId, 'done');
      }

      // 4. 释放 savepoint — 确认 SQLite 变更
      this.sqlite.run(`RELEASE "${savepointName}"`);
      tx.terminate();

      return result;
    } catch (e) {
      // 5. 失败路径：回滚 SQLite 变更
      try {
        this.sqlite.run(`ROLLBACK TO "${savepointName}"`);
      } catch {
        // savepoint 回滚失败不阻塞错误抛出
      }

      // 如果有文件操作已被执行，创建 WAL 用于恢复
      const ops = collector.getOperations();
      if (ops.length > 0) {
        try {
          await this.walManager.createWal(txId, ops);
          await this.walManager.updateStatus(txId, 'done');
        } catch {
          // WAL 创建失败不影响原始错误
        }
      }

      tx.terminate();
      throw e; // 重新抛出原始错误
    }
  }
}
