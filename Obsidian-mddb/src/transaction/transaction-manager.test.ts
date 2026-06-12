/**
 * TransactionManager 测试
 *
 * Milestone 5 测试覆盖：
 * - 基本事务（insert/update/delete）
 * - 事务回滚（throw → ROLLBACK）
 * - 批量操作（insertAll/updateAll/deleteAll）
 * - WAL 收集与创建
 * - 事务终止后操作拒绝
 * - 嵌套事务扁平化
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransactionManager } from './transaction-manager';
import type { WriteResult as CrudWriteResult } from '../write/crud-executor';
import type { SchemaSummary, RecordInput, RecordPatch } from '../core/types';

// ============================================================
// Mocks
// ============================================================

class MockSQLite {
  public logs: string[] = [];
  private _savepoints: string[] = [];

  run(sql: string, _params?: unknown[]): void {
    this.logs.push(`RUN: ${sql}`);
    // Track savepoints
    const spMatch = sql.match(/SAVEPOINT\s+"?(\w+)"?/);
    if (spMatch) {
      this._savepoints.push(spMatch[1]!);
    }
    const releaseMatch = sql.match(/RELEASE\s+"?(\w+)"?/);
    if (releaseMatch) {
      const idx = this._savepoints.lastIndexOf(releaseMatch[1]!);
      if (idx >= 0) this._savepoints.splice(idx, 1);
    }
    const rollbackMatch = sql.match(/ROLLBACK TO\s+"?(\w+)"?/);
    if (rollbackMatch) {
      const idx = this._savepoints.lastIndexOf(rollbackMatch[1]!);
      if (idx >= 0) this._savepoints.splice(idx, 1);
    }
  }

  query(sql: string, _params?: unknown[]): { columns: string[]; rows: unknown[][] } {
    this.logs.push(`QRY: ${sql}`);
    return { columns: [], rows: [] };
  }

  get activeSavepoints(): string[] {
    return [...this._savepoints];
  }

  initialize(): void {}
  close(): void {}
  isReady(): boolean { return true; }
}

class MockCRUDExecutor {
  public operations: Array<{ type: string; table?: string; storagePk?: string }> = [];

  // Track what was passed to support filePath/tableName on return
  private insertCount = 0;
  private updateCount = 0;
  private deleteCount = 0;

  async insert(
    table: string,
    record: RecordInput,
    options?: { txId?: string },
  ): Promise<CrudWriteResult> {
    this.insertCount++;
    this.operations.push({ type: 'insert', table });
    return {
      success: true,
      storagePk: `pk_insert_${this.insertCount}_${Date.now()}`,
      lineNumber: 10 + this.insertCount,
      syncState: 'synced',
      filePath: `${table}.md`,
      tableName: table,
    };
  }

  async update(
    storagePk: string,
    _patch: RecordPatch,
  ): Promise<CrudWriteResult> {
    this.updateCount++;
    this.operations.push({ type: 'update', storagePk });
    return {
      success: true,
      storagePk,
      lineNumber: 15 + this.updateCount,
      syncState: 'synced',
      filePath: 'accounts.md',
      tableName: 'accounts',
    };
  }

  async delete(storagePk: string): Promise<CrudWriteResult> {
    this.deleteCount++;
    this.operations.push({ type: 'delete', storagePk });
    return {
      success: true,
      storagePk,
      syncState: 'synced',
      filePath: 'accounts.md',
      tableName: 'accounts',
    };
  }

  get lock() {
    return {
      shutdown: () => {},
    };
  }
}

class MockWalManager {
  public createdWals: Array<{ txId: string; opsCount: number }> = [];
  public statusUpdates: Array<{ txId: string; status: string }> = [];

  async createWal(txId: string, operations: unknown[]): Promise<unknown> {
    this.createdWals.push({ txId, opsCount: operations.length });
    return { txId, operations };
  }

  async updateStatus(txId: string, status: string): Promise<void> {
    this.statusUpdates.push({ txId, status });
  }

  async getReplayableWals(): Promise<unknown[]> { return []; }
  async getDeadWals(): Promise<unknown[]> { return []; }
  shutdown(): void {}
}

class MockSchemaRegistry {
  getTable(_table: string): unknown {
    return {
      schema: { table: _table, fields: ['name', 'value'], types: ['string', 'integer'] },
      sources: [{ file: `${_table}.md`, blockId: '', blockIndex: 0, rowCount: 0 }],
    };
  }
  getSchema(_table: string): unknown {
    return { table: _table, fields: ['name', 'value'], types: ['string', 'integer'] };
  }
}

// ============================================================
// Fixtures
// ============================================================

const TEST_SCHEMA: SchemaSummary = {
  table: 'accounts',
  pk: ['name'],
  fields: ['name', 'balance', 'type'],
  types: ['string', 'decimal(2)', 'string'],
  required: [true, true, false],
  nullMarker: '-',
};

// ============================================================
// 测试
// ============================================================

describe('TransactionManager', () => {
  let sqlite: MockSQLite;
  let crud: MockCRUDExecutor;
  let walManager: MockWalManager;
  let schemaReg: MockSchemaRegistry;
  let txManager: TransactionManager;

  beforeEach(() => {
    sqlite = new MockSQLite();
    crud = new MockCRUDExecutor();
    walManager = new MockWalManager();
    schemaReg = new MockSchemaRegistry();
    txManager = new TransactionManager(
      sqlite as any,
      crud as any,
      walManager as any,
      schemaReg as any,
    );
  });

  describe('basic transaction', () => {
    it('inserts records within a transaction', async () => {
      const result = await txManager.transaction(async (tx) => {
        const r1 = await tx.insert('accounts', { name: 'A', balance: 100, type: '储蓄' });
        const r2 = await tx.insert('accounts', { name: 'B', balance: 200, type: '信用' });
        return { r1, r2 };
      });

      expect(result.r1.storagePk).toBeTruthy();
      expect(result.r1.table).toBe('accounts');
      expect(result.r1.syncState).toBe('synced');
      expect(result.r2.storagePk).toBeTruthy();

      // 2 CRUD operations were executed
      expect(crud.operations.length).toBe(2);
      expect(crud.operations[0]!.type).toBe('insert');
      expect(crud.operations[1]!.type).toBe('insert');

      // WAL was created with 2 operations
      expect(walManager.createdWals.length).toBe(1);
      expect(walManager.createdWals[0]!.opsCount).toBe(2);

      // WAL was marked done
      expect(walManager.statusUpdates.length).toBe(1);
      expect(walManager.statusUpdates[0]!.status).toBe('done');

      // Savepoint was released
      expect(sqlite.activeSavepoints.length).toBe(0);
    });

    it('supports update within a transaction', async () => {
      const result = await txManager.transaction(async (tx) => {
        const insert = await tx.insert('accounts', { name: '测试', balance: 500, type: '储蓄' });
        const updated = await tx.update(insert.storagePk, { balance: 999 });
        return updated;
      });

      expect(result.success !== false).toBe(true);
      expect(result.syncState).toBe('synced');

      // 2 CRUD operations
      expect(crud.operations.length).toBe(2);

      // 2 WAL operations
      expect(walManager.createdWals[0]!.opsCount).toBe(2);
    });

    it('supports delete within a transaction', async () => {
      await txManager.transaction(async (tx) => {
        const insert = await tx.insert('accounts', { name: '删除测试', balance: 300, type: '储蓄' });
        await tx.delete(insert.storagePk);
      });

      // 2 operations
      expect(crud.operations.length).toBe(2);
      expect(walManager.createdWals[0]!.opsCount).toBe(2);
    });
  });

  describe('rollback on throw', () => {
    it('rolls back SQLite changes when callback throws', async () => {
      await expect(
        txManager.transaction(async (tx) => {
          await tx.insert('accounts', { name: '回滚测试', balance: 999, type: '储蓄' });
          throw new Error('Intentional rollback');
        }),
      ).rejects.toThrow('Intentional rollback');

      // CRUD operations were executed (file writes happened)
      expect(crud.operations.length).toBe(1);

      // WAL was created for file recovery
      expect(walManager.createdWals.length).toBe(1);
      expect(walManager.createdWals[0]!.opsCount).toBe(1);

      // WAL was marked done (for file-level recovery)
      expect(walManager.statusUpdates.length).toBe(1);
      expect(walManager.statusUpdates[0]!.status).toBe('done');

      // Savepoint was rolled back
      expect(sqlite.activeSavepoints.length).toBe(0);
      expect(sqlite.logs.some(l => l.includes('ROLLBACK TO'))).toBe(true);
    });

    it('rolls back on async error', async () => {
      await expect(
        txManager.transaction(async () => {
          await txManager.transaction(async (tx) => {
            await tx.insert('accounts', { name: '嵌套', balance: 100, type: '储蓄' });
          });
          throw new Error('outter error');
        }),
      ).rejects.toThrow('outter error');
    });
  });

  describe('batch operations', () => {
    it('insertAll inserts multiple records', async () => {
      await txManager.transaction(async (tx) => {
        const results = await tx.insertAll('accounts', [
          { name: '批量A', balance: 100, type: '储蓄' },
          { name: '批量B', balance: 200, type: '信用' },
          { name: '批量C', balance: 300, type: '投资' },
        ]);
        expect(results).toHaveLength(3);
        results.forEach(r => {
          expect(r.storagePk).toBeTruthy();
          expect(r.table).toBe('accounts');
        });
      });

      // 3 inserts, 3 WAL ops
      expect(crud.operations.length).toBe(3);
      expect(walManager.createdWals[0]!.opsCount).toBe(3);
    });

    it('updateAll updates multiple records', async () => {
      await txManager.transaction(async (tx) => {
        const a = await tx.insert('accounts', { name: 'A', balance: 100, type: '储蓄' });
        const b = await tx.insert('accounts', { name: 'B', balance: 200, type: '信用' });
        const results = await tx.updateAll([
          { storagePk: a.storagePk, patch: { balance: 150 } },
          { storagePk: b.storagePk, patch: { balance: 250 } },
        ]);
        expect(results).toHaveLength(2);
      });

      // 4 operations total (2 inserts + 2 updates)
      expect(crud.operations.length).toBe(4);
    });

    it('deleteAll deletes multiple records', async () => {
      await txManager.transaction(async (tx) => {
        const a = await tx.insert('accounts', { name: 'DelA', balance: 100, type: '储蓄' });
        const b = await tx.insert('accounts', { name: 'DelB', balance: 200, type: '信用' });
        const results = await tx.deleteAll([a.storagePk, b.storagePk]);
        expect(results).toHaveLength(2);
      });

      // 4 operations
      expect(crud.operations.length).toBe(4);
    });
  });

  describe('WAL collection', () => {
    it('creates WAL with correct number of operations', async () => {
      await txManager.transaction(async (tx) => {
        await tx.insert('accounts', { name: 'A', balance: 100, type: '储蓄' });
        await tx.insert('accounts', { name: 'B', balance: 200, type: '信用' });
        await tx.insert('accounts', { name: 'C', balance: 300, type: '投资' });
      });

      expect(walManager.createdWals.length).toBe(1);
      expect(walManager.createdWals[0]!.opsCount).toBe(3);
    });

    it('creates no WAL for empty transactions', async () => {
      await txManager.transaction(async () => {
        // no operations
        return 'nothing';
      });

      expect(walManager.createdWals.length).toBe(0);
      expect(walManager.statusUpdates.length).toBe(0);
    });
  });

  describe('transaction lifecycle', () => {
    it('rejects operations after transaction ends', async () => {
      let savedTx: any;

      await txManager.transaction(async (tx) => {
        savedTx = tx;
        await tx.insert('accounts', { name: '正常', balance: 100, type: '储蓄' });
      });

      // Try to use the same transaction after commit
      await expect(
        savedTx!.insert('accounts', { name: '非法', balance: 200, type: '信用' }),
      ).rejects.toThrow('no longer active');
    });

    it('savepoint is created and released', async () => {
      const savepointLogs: string[] = [];

      // Monkey-patch to capture savepoint names
      const origRun = sqlite.run.bind(sqlite);
      sqlite.run = (sql: string, params?: unknown[]) => {
        savepointLogs.push(sql);
        origRun(sql, params);
      };

      await txManager.transaction(async (tx) => {
        await tx.insert('accounts', { name: 'SV', balance: 50, type: '储蓄' });
      });

      const hasSavepoint = savepointLogs.some(l => l.includes('SAVEPOINT'));
      const hasRelease = savepointLogs.some(l => l.includes('RELEASE'));
      expect(hasSavepoint).toBe(true);
      expect(hasRelease).toBe(true);
    });

    it('isActive returns correct state', async () => {
      await txManager.transaction(async (tx) => {
        expect(tx.isActive()).toBe(true);
        await tx.insert('accounts', { name: '激活', balance: 100, type: '储蓄' });
        expect(tx.isActive()).toBe(true);
      });
    });
  });
});
