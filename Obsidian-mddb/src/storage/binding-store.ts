/**
 * 绑定表存储层 (BindingStore)
 *
 * _binding 表的 CRUD 操作，遵循 v2 身份模型（identity-model.md §2-3）。
 *
 * 参考：identity-model.md §3
 */

import type { BindingRow, SyncState } from '../core/types';
import type { SQLiteAdapter } from './sqlite-adapter';
import { EngineError } from '../core/errors';

export class BindingStore {
  private initialized = false;

  constructor(private sqlite: SQLiteAdapter) {}

  /** 初始化 _binding 表 */
  initialize(): void {
    if (this.initialized) return;

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _binding (
        storage_pk    TEXT PRIMARY KEY,
        logical_pk    TEXT NOT NULL,
        table_name    TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        block_id      TEXT NOT NULL DEFAULT '',
        block_index   INTEGER NOT NULL DEFAULT 0,
        line_number   INTEGER NOT NULL,
        row_hash      TEXT NOT NULL DEFAULT '',
        raw_line_hash TEXT,
        last_verified TEXT NOT NULL,
        sync_state    TEXT NOT NULL DEFAULT 'synced'
      )
    `);

    // 逻辑 PK 唯一约束：仅对“有真实逻辑 PK”的记录强制唯一。
    // $uuid / 无 @pk 的表 logical_pk 为 ''，SQLite 会把多个 '' 视为相等值
    // → 同表多记录折叠成一条 binding，造成重复行累积与编辑/删除失效。
    // 用 partial index 把空 logical_pk 排除在唯一约束外（其身份由 storage_pk 主键区分）。
    // 旧版建立的是无条件唯一索引，先 DROP 以便已有 cache 在重载后自愈。
    this.sqlite.run(`DROP INDEX IF EXISTS idx_binding_logical`);
    this.sqlite.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_binding_logical
      ON _binding(table_name, logical_pk)
      WHERE logical_pk != ''
    `);

    this.sqlite.run(`
      CREATE INDEX IF NOT EXISTS idx_binding_file
      ON _binding(file_path, line_number)
    `);

    this.sqlite.run(`
      CREATE INDEX IF NOT EXISTS idx_binding_table
      ON _binding(table_name)
    `);

    this.initialized = true;
  }

  /** 插入一条绑定记录 */
  insert(row: BindingRow): void {
    this.assertReady();

    this.sqlite.run(
      `INSERT OR ABORT INTO _binding
       (storage_pk, logical_pk, table_name, file_path,
        block_id, block_index, line_number,
        row_hash, raw_line_hash, last_verified, sync_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.storagePk, row.logicalPk, row.tableName, row.filePath,
        row.blockId, row.blockIndex, row.lineNumber,
        row.rowHash, row.rawLineHash, row.lastVerified, row.syncState,
      ],
    );
  }

  /** 通过 storagePk 查询 */
  findByStoragePk(storagePk: string): BindingRow | null {
    this.assertReady();

    const result = this.sqlite.query(
      'SELECT * FROM _binding WHERE storage_pk = ?',
      [storagePk],
    );

    if (result.rows.length === 0) return null;
    return this.rowToBinding(result, result.rows[0]!);
  }

  /** 通过逻辑 PK + 表名查询 */
  findByLogicalPk(logicalPk: string, tableName: string): BindingRow | null {
    this.assertReady();

    const result = this.sqlite.query(
      'SELECT * FROM _binding WHERE logical_pk = ? AND table_name = ?',
      [logicalPk, tableName],
    );

    if (result.rows.length === 0) return null;
    return this.rowToBinding(result, result.rows[0]!);
  }

  /** 按文件路径查询所有绑定 */
  findByFilePath(filePath: string): BindingRow[] {
    this.assertReady();

    const result = this.sqlite.query(
      'SELECT * FROM _binding WHERE file_path = ? ORDER BY line_number',
      [filePath],
    );

    return result.rows.map(row => this.rowToBinding(result, row));
  }

  /** 按表名查询所有绑定 */
  findByTableName(tableName: string): BindingRow[] {
    this.assertReady();

    const result = this.sqlite.query(
      'SELECT * FROM _binding WHERE table_name = ? ORDER BY line_number',
      [tableName],
    );

    return result.rows.map(row => this.rowToBinding(result, row));
  }

  /** 获取指定表的所有逻辑 PK（用于校验） */
  getExistingLogicalPks(tableName: string): Set<string> {
    this.assertReady();

    const result = this.sqlite.query(
      'SELECT logical_pk FROM _binding WHERE table_name = ?',
      [tableName],
    );

    return new Set(result.rows.map(row => String(row[0])));
  }

  /** 删除一条绑定 */
  deleteByStoragePk(storagePk: string): void {
    this.assertReady();
    this.sqlite.run('DELETE FROM _binding WHERE storage_pk = ?', [storagePk]);
  }

  /** 删除一个文件的所有绑定 */
  deleteByFilePath(filePath: string): void {
    this.assertReady();
    this.sqlite.run('DELETE FROM _binding WHERE file_path = ?', [filePath]);
  }

  /** 更新行号和行哈希 */
  updatePosition(storagePk: string, lineNumber: number, rowHash: string): void {
    this.assertReady();
    this.sqlite.run(
      'UPDATE _binding SET line_number = ?, row_hash = ?, last_verified = ? WHERE storage_pk = ?',
      [lineNumber, rowHash, new Date().toISOString(), storagePk],
    );
  }

  /** 批量更新行号（DELETE 后后续行上移） */
  shiftLineNumbers(filePath: string, afterLine: number, delta: number): void {
    this.assertReady();
    this.sqlite.run(
      'UPDATE _binding SET line_number = line_number + ? WHERE file_path = ? AND line_number > ?',
      [delta, filePath, afterLine],
    );
  }

  /** 更新同步状态 */
  updateSyncState(storagePk: string, syncState: SyncState): void {
    this.assertReady();
    this.sqlite.run(
      'UPDATE _binding SET sync_state = ? WHERE storage_pk = ?',
      [syncState, storagePk],
    );
  }

  /** 获取未同步的记录 */
  findPendingSync(): BindingRow[] {
    this.assertReady();

    const result = this.sqlite.query(
      "SELECT * FROM _binding WHERE sync_state != 'synced'",
    );

    return result.rows.map(row => this.rowToBinding(result, row));
  }

  /** 总行数 */
  count(): number {
    this.assertReady();

    const result = this.sqlite.query('SELECT COUNT(*) as cnt FROM _binding');
    return result.rows.length > 0 ? Number(result.rows[0]![0]) : 0;
  }

  /** 清除所有绑定记录 */
  clearAll(): void {
    this.assertReady();
    this.sqlite.run('DELETE FROM _binding');
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private assertReady(): void {
    if (!this.initialized) {
      throw new EngineError('BindingStore not initialized', 'BINDING_NOT_INIT');
    }
  }

  private rowToBinding(result: { columns: string[] }, row: unknown[]): BindingRow {
    const cols = result.columns;
    return {
      storagePk: String(row[cols.indexOf('storage_pk')] ?? ''),
      logicalPk: String(row[cols.indexOf('logical_pk')] ?? ''),
      tableName: String(row[cols.indexOf('table_name')] ?? ''),
      filePath: String(row[cols.indexOf('file_path')] ?? ''),
      blockId: String(row[cols.indexOf('block_id')] ?? ''),
      blockIndex: Number(row[cols.indexOf('block_index')] ?? 0),
      lineNumber: Number(row[cols.indexOf('line_number')] ?? 0),
      rowHash: String(row[cols.indexOf('row_hash')] ?? ''),
      rawLineHash: String(row[cols.indexOf('raw_line_hash')] ?? ''),
      lastVerified: String(row[cols.indexOf('last_verified')] ?? ''),
      syncState: (String(row[cols.indexOf('sync_state')] ?? 'synced') as SyncState),
    };
  }
}
