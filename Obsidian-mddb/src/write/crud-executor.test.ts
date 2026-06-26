/**
 * CRUDExecutor 集成测试
 *
 * 使用 mock SQLiteAdapter + mock BindingStore 测试写入路径。
 * 真实 SQL 执行由 sqlite-adapter 单元测试覆盖。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CRUDExecutor } from './crud-executor';
import { ConflictError, EngineError } from '../core/errors';
import { LockManager } from '../lock/lock-manager';
import type { SchemaSummary, BindingRow, TableSource } from '../core/types';
import type { FileOperator } from './types';
import { simpleHash } from './serializer';

// ============================================================
// Mock SQLiteAdapter
// ============================================================

class MockSQLite {
  private tables = new Map<string, Array<Record<string, unknown>>>();
  private logs: string[] = [];

  run(sql: string, params?: unknown[]): void {
    this.logs.push(`RUN: ${sql} [${params?.join(',') ?? ''}]`);

    if (sql.startsWith('CREATE TABLE')) {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\S+)/);
      if (match) {
        const tableName = match[1]!;
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, []);
        }
      }
    } else if (sql.startsWith('INSERT INTO')) {
      const match = sql.match(/INSERT INTO (\S+)/);
      if (match) {
        const tableName = match[1]!;
        const rows = this.tables.get(tableName) ?? [];
        rows.push({ _params: params });
        this.tables.set(tableName, rows);
      }
    } else if (sql.startsWith('DELETE')) {
      const match = sql.match(/FROM (\S+)/);
      if (match) {
        const tableName = match[1]!;
        this.tables.delete(tableName);
        // Also handle subquery-based delete
      }
    } else if (sql.startsWith('UPDATE')) {
      const match = sql.match(/UPDATE (\S+)/);
      if (match) {
        const tableName = match[1]!;
        // Just log it
      }
    }
  }

  query(sql: string, _params?: unknown[]): { columns: string[]; rows: unknown[][] } {
    this.logs.push(`QRY: ${sql}`);
    return { columns: [], rows: [] };
  }

  getLogs(): string[] {
    return this.logs;
  }

  getTableData(tableName: string): Array<Record<string, unknown>> {
    return this.tables.get(tableName) ?? [];
  }

  initialize(): void {}
  close(): void {}
}

// ============================================================
// Mock BindingStore
// ============================================================

class MockBindingStore {
  private bindings = new Map<string, BindingRow>();
  private initialized = false;

  initialize(): void {
    this.initialized = true;
  }

  insert(row: BindingRow): void {
    this.bindings.set(row.storagePk, { ...row });
  }

  findByStoragePk(storagePk: string): BindingRow | null {
    return this.bindings.get(storagePk) ?? null;
  }

  deleteByStoragePk(storagePk: string): void {
    this.bindings.delete(storagePk);
  }

  updatePosition(storagePk: string, lineNumber: number, rowHash: string): void {
    const row = this.bindings.get(storagePk);
    if (row) {
      row.lineNumber = lineNumber;
      row.rowHash = rowHash;
      row.lastVerified = new Date().toISOString();
    }
  }

  shiftLineNumbers(filePath: string, afterLine: number, delta: number): void {
    for (const [, row] of this.bindings) {
      if (row.filePath === filePath && row.lineNumber > afterLine) {
        row.lineNumber += delta;
      }
    }
  }

  findByFilePath(filePath: string): BindingRow[] {
    return Array.from(this.bindings.values()).filter(b => b.filePath === filePath);
  }

  count(): number {
    return this.bindings.size;
  }
}

// ============================================================
// Mock SchemaRegistryStore
// ============================================================

class MockSchemaRegistry {
  private tables = new Map<string, { schema: SchemaSummary; sources: TableSource[] }>();

  getSchema(table: string): SchemaSummary | undefined {
    return this.tables.get(table)?.schema;
  }

  getTable(table: string): { schema: SchemaSummary; sources: TableSource[] } | undefined {
    return this.tables.get(table);
  }

  setTableSchema(table: string, schema: SchemaSummary): void {
    if (this.tables.has(table)) {
      this.tables.get(table)!.schema = schema;
    } else {
      this.tables.set(table, { schema, sources: [] });
    }
  }

  addSource(table: string, source: TableSource): void {
    const entry = this.tables.get(table);
    if (entry) {
      const existing = entry.sources.find(s => s.file === source.file);
      if (!existing) {
        entry.sources.push(source);
      }
    }
  }
}

// ============================================================
// Mock FileHashStore
// ============================================================

class MockFileHashStore {
  private hashes = new Map<string, string>();

  setHash(filePath: string, hash: string): void {
    this.hashes.set(filePath, hash);
  }

  getHash(filePath: string): string | undefined {
    return this.hashes.get(filePath);
  }
}

// ============================================================
// Fixtures
// ============================================================

const ACCOUNTS_FILE = '```dmdb-schema\n@table accounts\n@pk name\n@fields name | balance | type | institution | notes\n@types string | decimal(2) | enum(储蓄,信用,投资,电子) | string | text\n@required true | true | true | false | false\n@nullMarker -\n```\n\n```mddb\n现金 | 3500.00 | 储蓄 | - | 日常随身现金\n支付宝 | 12850.50 | 电子 | - | 主要在线支付渠道\\|含余额宝自动转入\n微信 | 3200.00 | 电子 | - | 红包和转账专用\n招商银行 | 45600.00 | 储蓄 | 招商银行 | 工资卡\n招商信用卡 | -2100.00 | 信用 | 招商银行 | 上月账单\n余额宝 | 18000.00 | 投资 | 支付宝 | 七日年化 2.3%\n```';

const ACCOUNTS_SCHEMA: SchemaSummary = {
  table: 'accounts',
  pk: ['name'],
  fields: ['name', 'balance', 'type', 'institution', 'notes'],
  types: ['string', 'decimal(2)', 'enum(储蓄,信用,投资,电子)', 'string', 'text'],
  required: [true, true, true, false, false],
  sort: 'type ASC, balance DESC',
  nullMarker: '-',
};

// ============================================================
// 测试
// ============================================================

describe('CRUDExecutor', () => {
  let executor: CRUDExecutor;
  let fileOp: FileOperator;
  let sqlite: MockSQLite;
  let binding: MockBindingStore;
  let schemaReg: MockSchemaRegistry;
  let fileHash: MockFileHashStore;
  let lockMgr: LockManager;

  const FILE_PATH = 'accounts.md';

  beforeEach(() => {
    sqlite = new MockSQLite();
    binding = new MockBindingStore();
    schemaReg = new MockSchemaRegistry();
    fileHash = new MockFileHashStore();
    lockMgr = new LockManager();
    fileOp = createInMemoryFileOp();

    // Register schema
    schemaReg.setTableSchema('accounts', ACCOUNTS_SCHEMA);
    schemaReg.addSource('accounts', { file: FILE_PATH, blockId: '', blockIndex: 0, rowCount: 6 });

    // Load initial file content
    fileOp.writeFile(FILE_PATH, ACCOUNTS_FILE);

    executor = new CRUDExecutor(
      fileOp,
      sqlite as any,
      binding as any,
      schemaReg as any,
      fileHash as any,
      'ascii',
      lockMgr,
    );
  });

  // ============================================================
  // INSERT
  // ============================================================

  describe('insert', () => {
    it('appends a new row to the mddb block', async () => {
      const result = await executor.insert('accounts', {
        name: '测试账户',
        balance: 999.99,
        type: '储蓄',
        institution: '测试银行',
        notes: '测试用账户',
      });

      expect(result.success).toBe(true);
      expect(result.storagePk).toBeTruthy();
      expect(result.syncState).toBe('synced');

      // Verify file content
      const content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('测试账户');
      expect(content).toContain('999.99');

      // Verify binding
      const bindingRecord = binding.findByStoragePk(result.storagePk);
      expect(bindingRecord).toBeTruthy();
      expect(bindingRecord!.tableName).toBe('accounts');
      expect(bindingRecord!.filePath).toBe(FILE_PATH);
    });

    it('inserting with minimal required fields works', async () => {
      const result = await executor.insert('accounts', {
        name: '最小账户',
        balance: 100,
        type: '储蓄',
      });

      expect(result.success).toBe(true);

      const content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('最小账户');
    });

    it('maintains file structure after multiple inserts', async () => {
      // First insert
      await executor.insert('accounts', { name: '账户A', balance: 100, type: '储蓄' });

      // Second insert
      await executor.insert('accounts', { name: '账户B', balance: 200, type: '信用' });

      const content = await fileOp.readFile(FILE_PATH);
      // Both should be in the file
      expect(content).toContain('账户A');
      expect(content).toContain('账户B');
      // Should be after existing data and before closing fence
      expect(content.indexOf('账户A')).toBeGreaterThan(content.indexOf('余额宝'));
      expect(content.indexOf('账户B')).toBeGreaterThan(content.indexOf('账户A'));
    });

    it('throws for non-existent table', async () => {
      await expect(
        executor.insert('nonexistent', { name: 'x' }),
      ).rejects.toThrow('Schema not found');
    });
  });

  // ============================================================
  // UPDATE
  // ============================================================

  describe('update', () => {
    it('replaces row content and updates hash', async () => {
      // First insert a record
      const insertResult = await executor.insert('accounts', {
        name: '待更新',
        balance: 500,
        type: '储蓄',
      });

      const storagePk = insertResult.storagePk;
      // Capture hash as primitive (binding objects may be mutated in-place)
      const oldRowHash = binding.findByStoragePk(storagePk)!.rowHash;

      // Verify file before update
      let content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('500.00');

      // Update
      const result = await executor.update(storagePk, {
        balance: 999,
        notes: '已更新备注',
      });

      expect(result.success).toBe(true);
      expect(result.syncState).toBe('synced');

      // Verify file content changed
      content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('999.00');
      expect(content).toContain('已更新备注');

      // Verify binding hash was updated
      const updatedBinding = binding.findByStoragePk(storagePk)!;
      const recomputedNewHash = simpleHash('待更新 | 999.00 | 储蓄 | - | 已更新备注');
      expect(updatedBinding.rowHash).toBe(recomputedNewHash);
      // Hash must differ from the original insert hash
      expect(updatedBinding.rowHash).not.toBe(oldRowHash);
    });

    it('throws ConflictError when row hash mismatches', async () => {
      const insertResult = await executor.insert('accounts', {
        name: '冲突测试',
        balance: 300,
        type: '储蓄',
      });

      // Directly modify the file to simulate external change
      const content = await fileOp.readFile(FILE_PATH);
      const modified = content.replace('冲突测试', '冲突测试_已外部修改');
      await fileOp.writeFile(FILE_PATH, modified);

      // Now try to update — should detect conflict
      await expect(
        executor.update(insertResult.storagePk, { balance: 999 }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws for non-existent storagePk', async () => {
      await expect(
        executor.update('nonexistent_pk', { balance: 100 }),
      ).rejects.toThrow('Binding not found');
    });
  });

  // ============================================================
  // DELETE
  // ============================================================

  describe('delete', () => {
    it('removes row from file and binding', async () => {
      // Insert a record
      const insertResult = await executor.insert('accounts', {
        name: '待删除',
        balance: 777,
        type: '储蓄',
      });

      expect(binding.count()).toBe(1); // initial bindings are 0 (mock)

      // Delete it
      const result = await executor.delete(insertResult.storagePk);

      expect(result.success).toBe(true);

      // Verify file content no longer has the row
      const content = await fileOp.readFile(FILE_PATH);
      expect(content).not.toContain('待删除');

      // Verify binding was removed
      expect(binding.findByStoragePk(insertResult.storagePk)).toBeNull();
      expect(binding.count()).toBe(0);
    });

    it('adjusts line numbers of subsequent rows', async () => {
      // Insert two records
      const r1 = await executor.insert('accounts', { name: '第一行', balance: 100, type: '储蓄' });
      const r2 = await executor.insert('accounts', { name: '第二行', balance: 200, type: '储蓄' });
      const r3 = await executor.insert('accounts', { name: '第三行', balance: 300, type: '储蓄' });

      const b1 = binding.findByStoragePk(r1.storagePk)!;
      const b2 = binding.findByStoragePk(r2.storagePk)!;
      const b3 = binding.findByStoragePk(r3.storagePk)!;

      // Verify line numbers are increasing
      expect(b1.lineNumber).toBeLessThan(b2.lineNumber);
      expect(b2.lineNumber).toBeLessThan(b3.lineNumber);

      // Delete the second row
      await executor.delete(r2.storagePk);

      // After deletion, b3 should have shifted up by 1 (b1 unchanged)
      // Our mock shiftLineNumbers will update existing binding objects...

      const b1After = binding.findByStoragePk(r1.storagePk)!;
      const b3After = binding.findByStoragePk(r3.storagePk)!;

      // The line numbers should still be sequential
      expect(b1After.lineNumber).toBeLessThan(b3After.lineNumber);

      // Verify file content
      const content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('第一行');
      expect(content).not.toContain('第二行');
      expect(content).toContain('第三行');
    });

    it('throws ConflictError when file was externally modified', async () => {
      const insertResult = await executor.insert('accounts', {
        name: '删除冲突',
        balance: 400,
        type: '储蓄',
      });

      // Modify file externally
      const content = await fileOp.readFile(FILE_PATH);
      const modified = content.replace('删除冲突', '删除冲突_已改');
      await fileOp.writeFile(FILE_PATH, modified);

      await expect(
        executor.delete(insertResult.storagePk),
      ).rejects.toThrow(ConflictError);
    });
  });

  // ============================================================
  // 写入失败时 SQLite 不假成功
  // ============================================================

  describe('write failure safety', () => {
    it('does not commit SQLite if file write fails', async () => {
      // Create a file operator that fails on write
      const failingFileOp: FileOperator = {
        readFile: async () => ACCOUNTS_FILE,
        writeFile: async () => { throw new Error('Disk full'); },
        processFile: async () => { throw new Error('Disk full'); },
      };

      const failExecutor = new CRUDExecutor(
        failingFileOp,
        sqlite as any,
        binding as any,
        schemaReg as any,
        fileHash as any,
        'ascii',
        lockMgr,
      );

      // Attempt write
      await expect(
        failExecutor.insert('accounts', { name: '失败测试', balance: 500, type: '储蓄' }),
      ).rejects.toThrow('Disk full');

      // Verify no binding was created
      expect(binding.count()).toBe(0);
    });
  });

  // ============================================================
  // 批量操作 — Milestone 5
  // ============================================================

  describe('batch operations', () => {
    it('insertAll inserts multiple records with filePath and tableName', async () => {
      const results = await executor.insertAll('accounts', [
        { name: '批量A', balance: 100, type: '储蓄' },
        { name: '批量B', balance: 200, type: '信用' },
      ]);

      expect(results).toHaveLength(2);
      results.forEach((r, i) => {
        expect(r.success).toBe(true);
        expect(r.storagePk).toBeTruthy();
        expect(r.syncState).toBe('synced');
        expect(r.filePath).toBe(FILE_PATH);
        expect(r.tableName).toBe('accounts');
      });

      const content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('批量A');
      expect(content).toContain('批量B');
    });

    it('updateAll updates multiple records', async () => {
      const r1 = await executor.insert('accounts', { name: 'UAllA', balance: 100, type: '储蓄' });
      const r2 = await executor.insert('accounts', { name: 'UAllB', balance: 200, type: '信用' });

      const results = await executor.updateAll([
        { storagePk: r1.storagePk, patch: { balance: 150 } },
        { storagePk: r2.storagePk, patch: { balance: 250 } },
      ]);

      expect(results).toHaveLength(2);
      results.forEach(r => expect(r.success).toBe(true));
    });

    it('deleteAll deletes multiple records', async () => {
      const r1 = await executor.insert('accounts', { name: 'DAllA', balance: 100, type: '储蓄' });
      const r2 = await executor.insert('accounts', { name: 'DAllB', balance: 200, type: '信用' });

      const results = await executor.deleteAll([r1.storagePk, r2.storagePk]);
      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(true);

      const content = await fileOp.readFile(FILE_PATH);
      expect(content).not.toContain('DAllA');
      expect(content).not.toContain('DAllB');
    });

    it('empty insertAll returns empty array', async () => {
      const results = await executor.insertAll('accounts', []);
      expect(results).toHaveLength(0);
    });
  });

  // ============================================================
  // 多次写入同一文件
  // ============================================================

  describe('consecutive writes', () => {
    it('supports multiple operations in sequence', async () => {
      // Insert
      const insertA = await executor.insert('accounts', { name: 'A账户', balance: 100, type: '储蓄' });
      const insertB = await executor.insert('accounts', { name: 'B账户', balance: 200, type: '信用' });

      // Update
      await executor.update(insertA.storagePk, { balance: 150 });
      const updatedBinding = binding.findByStoragePk(insertA.storagePk)!;
      expect(updatedBinding.rowHash).toBeTruthy();

      // Delete
      const deleteResult = await executor.delete(insertB.storagePk);
      expect(deleteResult.success).toBe(true);
      expect(binding.findByStoragePk(insertB.storagePk)).toBeNull();

      // Final file should contain A but not B
      const content = await fileOp.readFile(FILE_PATH);
      expect(content).toContain('A账户');
      expect(content).not.toContain('B账户');
    });
  });

  // ============================================================
  // force 重定位（断点4）
  //
  // storage_pk 是哈希、从不写入行内，旧的 storage_pk 子串搜索必然失败，
  // force 模式因此退化为盲信 binding.lineNumber —— 行号一旦因外部增删
  // 漂移，就会改/删错行。修复后应按 binding.rowHash 内容身份重定位。
  // ============================================================

  describe('force relocation (断点4)', () => {
    /** 在 marker 行之前插入一行，模拟外部编辑使该行下移、binding.lineNumber 变陈旧 */
    function spliceLineBefore(content: string, marker: string, newLine: string): string {
      const lines = content.split('\n');
      const idx = lines.findIndex(l => l.includes(marker));
      lines.splice(idx, 0, newLine);
      return lines.join('\n');
    }

    it('update force：行因外部增删而漂移时，按内容重定位命中正确行（不改邻行）', async () => {
      const r1 = await executor.insert('accounts', { name: '锚点A', balance: 100, type: '储蓄' });

      // 外部编辑：在 '锚点A' 行前插入一行入侵行 → '锚点A' 下移，binding.lineNumber 现指向入侵行
      const shifted = spliceLineBefore(
        await fileOp.readFile(FILE_PATH),
        '锚点A',
        '入侵行 | 0.00 | 储蓄 | - | 不应被改',
      );
      await fileOp.writeFile(FILE_PATH, shifted);

      await executor.update(r1.storagePk, { balance: 888 }, { force: true });

      const afterLines = (await fileOp.readFile(FILE_PATH)).split('\n');
      const anchorLine = afterLines.find(l => l.includes('锚点A'))!;
      const intruderLine = afterLines.find(l => l.includes('入侵行'))!;

      expect(anchorLine).toContain('888');        // 目标行被更新
      expect(intruderLine).toContain('不应被改');   // 邻行内容保持
      expect(intruderLine).not.toContain('888');   // 邻行未被误改
    });

    it('delete force：行漂移时删除正确行（不删邻行）', async () => {
      const r1 = await executor.insert('accounts', { name: '删锚A', balance: 100, type: '储蓄' });

      const shifted = spliceLineBefore(
        await fileOp.readFile(FILE_PATH),
        '删锚A',
        '删入侵行 | 0.00 | 储蓄 | - | 不应被删',
      );
      await fileOp.writeFile(FILE_PATH, shifted);

      await executor.delete(r1.storagePk, { force: true });

      const after = await fileOp.readFile(FILE_PATH);
      expect(after).not.toContain('删锚A');     // 目标行被删
      expect(after).toContain('删入侵行');       // 邻行保留
    });

    it('update force：目标行已被外部删除、无法定位时抛错（不盲写陈旧行号）', async () => {
      const r1 = await executor.insert('accounts', { name: '消失行', balance: 100, type: '储蓄' });

      // 外部删除该行 → rowHash 在文件中无任何匹配
      const content = await fileOp.readFile(FILE_PATH);
      const removed = content.split('\n').filter(l => !l.includes('消失行')).join('\n');
      await fileOp.writeFile(FILE_PATH, removed);

      await expect(
        executor.update(r1.storagePk, { balance: 1 }, { force: true }),
      ).rejects.toThrow(ConflictError);
    });
  });
});

// ============================================================
// 辅助
// ============================================================

function createInMemoryFileOp(): FileOperator {
  const store = new Map<string, string>();

  return {
    async readFile(filePath: string): Promise<string> {
      const content = store.get(filePath);
      if (content === undefined) throw new Error(`File not found: ${filePath}`);
      return content;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      store.set(filePath, content);
      store.set(`_hash_${filePath}`, simpleHash(content));
    },
    async processFile(filePath: string, updater: (content: string) => string): Promise<string> {
      const current = store.get(filePath) ?? '';
      const updated = updater(current);
      store.set(filePath, updated);
      store.set(`_hash_${filePath}`, simpleHash(updated));
      return updated;
    },
  };
}
