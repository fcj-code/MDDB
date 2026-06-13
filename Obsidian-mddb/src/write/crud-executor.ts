/**
 * CRUD 执行器 (CRUDExecutor)
 *
 * 单文件 insert/update/delete 的执行入口。
 * 遵循 v2 写入路径：文件先行，SQLite 后提交。
 *
 * 写入路径：
 * 1. 构造 WritePlan
 * 2. 获取文件锁
 * 3. 写前读取目标行并校验 hash
 * 4. 修改 Markdown 文件内容
 * 5. 通过 FileOperator 写文件
 * 6. 文件写成功后更新 SQLite / binding / file_hashes
 * 7. 释放文件锁
 *
 * 参考：v2 roadmap Milestone 2, runtime-architecture.md §3.3
 */

import type {
  SchemaSummary,
  BindingRow,
  SyncState,
  RecordInput,
  RecordPatch,
  WriteOptions,
} from '../core/types';
import type {
  FileOperator,
} from './types';

import { LockManager } from '../lock/lock-manager';
import { assertLineHash, hashLine } from './conflict-detector';
import {
  serializeRow,
  recordInputToValues,
  replaceLine,
  deleteLine,
  appendToBlock,
  simpleHash,
} from './serializer';
import { generateStoragePk, generateTxId } from './write-plan';
import { ConflictError, WriteError, EngineError } from '../core/errors';
import type { SQLiteAdapter } from '../storage/sqlite-adapter';
import type { BindingStore } from '../storage/binding-store';
import type { SchemaRegistryStore } from '../storage/schema-registry';
import type { FileHashStore } from '../storage/file-hash-store';

// ============================================================
// 写入结果
// ============================================================

export interface WriteResult {
  success: boolean;
  storagePk: string;
  lineNumber?: number;
  syncState: SyncState;
  /** 操作涉及的文件路径（Transaction 集成用） */
  filePath?: string;
  /** 操作涉及的表名（Transaction 集成用） */
  tableName?: string;
}

// ============================================================
// SQL 生成辅助（与 index-writer.ts 保持一致的 SQL 策略）
// ============================================================

const TYPE_MAP: Record<string, string> = {
  string: 'TEXT',
  integer: 'INTEGER',
  decimal: 'BIGINT',
  boolean: 'INTEGER',
  date: 'TEXT',
  datetime: 'TEXT',
  enum: 'TEXT',
  text: 'TEXT',
  tags: 'TEXT',
  ref: 'TEXT',
  phone: 'TEXT',
  email: 'TEXT',
};

function sqliteType(typeExpr: string): string {
  const baseName = typeExpr.split('(')[0]!;
  return TYPE_MAP[baseName] ?? 'TEXT';
}

function safeIdent(name: string): string {
  // MVP 使用 ascii-only 标识符模式
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

// ============================================================
// CRUDExecutor
// ============================================================

export class CRUDExecutor {
  private lockManager: LockManager;

  constructor(
    /** 文件操作接口 */
    public fileOperator: FileOperator,
    /** SQLite 适配器 */
    private sqlite: SQLiteAdapter,
    /** 绑定表存储 */
    private binding: BindingStore,
    /** Schema 注册表 */
    private schemaRegistry: SchemaRegistryStore,
    /** 文件哈希存储 */
    private fileHash: FileHashStore,
    /** 标识符模式 */
    private identMode: 'ascii' | 'quoted' = 'ascii',
    lockManager?: LockManager,
  ) {
    this.lockManager = lockManager ?? new LockManager();
  }

  get lock(): LockManager {
    return this.lockManager;
  }

  // ============================================================
  // INSERT
  // ============================================================

  /**
   * 插入一条记录
   *
   * 1. 获取 Schema，序列化记录
   * 2. 查找目标 mddb 块位置
   * 3. 获取文件锁
   * 4. 读取文件，在块尾追加行
   * 5. 写文件
   * 6. 更新 SQLite 用户表 + _binding
   * 7. 释放锁
   */
  async insert(
    tableName: string,
    record: RecordInput,
    options?: {
      storagePk?: string;
      txId?: string;
    },
  ): Promise<WriteResult> {
    // 1. Schema
    const schema = this.schemaRegistry.getSchema(tableName);
    if (!schema) {
      throw new EngineError(`Schema not found for table "${tableName}"`, 'SCHEMA_NOT_FOUND', tableName);
    }

    // 2. 文件路径
    const filePath = this.resolveTableFile(tableName);
    if (!filePath) {
      throw new WriteError(`No file registered for table "${tableName}"`, tableName);
    }

    // 3. 序列化
    const fieldValues = recordInputToValues(record, schema);
    const serialized = serializeRow(fieldValues, schema);
    const logicalPk = computeLogicalPk(fieldValues, schema);
    const storagePk = options?.storagePk ?? generateStoragePk(
      filePath,
      serialized.line,
      logicalPk,
      tableName,
    );

    const ownerId = options?.txId ?? storagePk;

    return this.lockManager.withFileLock(filePath, ownerId, async () => {
      // 4. 读取文件
      let content: string;
      try {
        content = await this.fileOperator.readFile(filePath);
      } catch (e) {
        throw new WriteError(
          `Failed to read file "${filePath}": ${e}`,
          tableName,
          filePath,
        );
      }

      // 5. 查找 mddb 块
      const blockEndLine = this.findBlockEndLine(content, tableName);
      if (blockEndLine <= 0) {
        throw new WriteError(
          `No mddb block found for table "${tableName}" in "${filePath}"`,
          tableName,
          filePath,
        );
      }

      // 6. 追加到块尾（闭合围栏前一行的位置）
      const insertLine = blockEndLine; // 闭合围栏行
      const newContent = appendToBlock(content, blockEndLine, serialized.line);

      // 7. 写文件
      try {
        await this.fileOperator.writeFile(filePath, newContent);
      } catch (e) {
        throw new WriteError(
          `Failed to write file "${filePath}": ${e}`,
          tableName,
          filePath,
        );
      }

      // 8. 文件成功 → SQLite
      this.ensureUserTable(schema);
      const insertSQL = this.buildInsertSQL(schema);
      const sqlParams = [storagePk, ...schema.fields.map((field, i) => {
        const val = fieldValues[i];
        if (val === null || val === undefined) return null;
        return this.valueForSQL(val, schema.types[i] ?? 'string');
      })];

      try {
        this.sqlite.run(insertSQL, sqlParams);
      } catch (e) {
        // SQLite 写入失败不应导致 Markdown 回滚
        // 记录错误但继续
        throw new WriteError(
          `SQLite INSERT failed: ${e}`,
          tableName,
          filePath,
        );
      }

      // 9. 写入 _binding
      const newRowHash = hashLine(serialized.line.trimEnd());

      // 后续行 lineNumber + 1（insertLine 之后的行，不包括插入行本身）
      this.binding.shiftLineNumbers(filePath, insertLine, 1);

      this.binding.insert({
        storagePk,
        logicalPk,
        tableName,
        filePath,
        blockId: `blk_${simpleHash(filePath + tableName)}`,
        blockIndex: 0,
        lineNumber: insertLine,
        rowHash: newRowHash,
        rawLineHash: newRowHash,
        lastVerified: new Date().toISOString(),
        syncState: 'synced',
      });

      // 10. 更新 file hash
      this.fileHash.setHash(filePath, simpleHash(newContent));

      return {
        success: true,
        storagePk,
        lineNumber: insertLine,
        syncState: 'synced',
        filePath,
        tableName,
      };
    });
  }

  /**
   * 批量插入
   *
   * 在同一事务上下文中执行多条插入，共享锁范围。
   * 使用 txId 作为锁所有者，支持 LockManager 重入。
   */
  async insertAll(
    tableName: string,
    records: RecordInput[],
    options?: { txId?: string },
  ): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    for (const record of records) {
      const r = await this.insert(tableName, record, options);
      results.push(r);
    }
    return results;
  }

  // ============================================================
  // UPDATE
  // ============================================================

  /**
   * 更新一条记录
   *
   * 1. 根据 storagePk 查 binding
   * 2. 获取文件锁
   * 3. 读取文件，校验行 hash
   * 4. 应用 patch，序列化新行
   * 5. 替换文件行
   * 6. 写文件
   * 7. 更新 SQLite + binding
   */
  async update(
    storagePk: string,
    patch: RecordPatch,
    options?: WriteOptions,
  ): Promise<WriteResult> {
    // 1. Binding
    const binding = this.binding.findByStoragePk(storagePk);
    if (!binding) {
      throw new EngineError(`Binding not found for storagePk "${storagePk}"`, 'BINDING_NOT_FOUND');
    }

    const tableName = binding.tableName;
    const filePath = binding.filePath;
    const schema = this.schemaRegistry.getSchema(tableName);
    if (!schema) {
      throw new EngineError(`Schema not found for table "${tableName}"`, 'SCHEMA_NOT_FOUND', tableName);
    }

    return this.lockManager.withFileLock(filePath, storagePk, async () => {
      // 2. 读取文件
      let content: string;
      try {
        content = await this.fileOperator.readFile(filePath);
      } catch (e) {
        throw new WriteError(`Failed to read file "${filePath}": ${e}`, tableName, filePath);
      }

      // 3. Hash 校验（除非 force）
      let actualLineNumber = binding.lineNumber;
      if (!options?.force) {
        assertLineHash(content, binding.lineNumber, binding.rowHash, filePath, tableName);
      } else {
        // force 模式下重新搜索 storage_pk 定位行
        const found = findLineByPkInContent(content, storagePk);
        if (found > 0) actualLineNumber = found;
      }

      // 4. 读取旧行 → 应用 patch
      const oldLine = content.split('\n')[actualLineNumber - 1]!;
      const newLine = this.applyPatchToLine(oldLine, patch, schema);

      // 5. 替换
      const newContent = replaceLine(content, actualLineNumber, newLine);

      // 6. 写文件
      try {
        await this.fileOperator.writeFile(filePath, newContent);
      } catch (e) {
        throw new WriteError(`Failed to write file "${filePath}": ${e}`, tableName, filePath);
      }

      // 7. 更新 SQLite
      const newRowHash = hashLine(newLine.trimEnd());

      // 构建 UPDATE SET 子句
      const setClauses: string[] = [];
      const setParams: unknown[] = [];

      for (const [field, value] of Object.entries(patch)) {
        const idx = schema.fields.indexOf(field);
        if (idx >= 0) {
          setClauses.push(`${safeIdent(field)} = ?`);
          setParams.push(value === null || value === undefined ? null : this.valueForSQL(value, schema.types[idx]!));
        }
      }

      if (setClauses.length > 0) {
        const updateSQL = `UPDATE ${safeIdent(tableName)} SET ${setClauses.join(', ')} WHERE storage_pk = ?`;
        this.sqlite.run(updateSQL, [...setParams, storagePk]);
      }

      // 8. 更新 binding
      this.binding.updatePosition(storagePk, actualLineNumber, newRowHash);

      // 9. 更新 file hash
      this.fileHash.setHash(filePath, simpleHash(newContent));

      return {
        success: true,
        storagePk,
        lineNumber: actualLineNumber,
        syncState: 'synced',
        filePath,
        tableName,
      };
    });
  }

  // ============================================================
  // DELETE
  // ============================================================

  /**
   * 删除一条记录
   *
   * 1. 根据 storagePk 查 binding
   * 2. 获取文件锁
   * 3. 读取文件，校验 hash
   * 4. 删除行
   * 5. 写文件
   * 6. 删除 SQLite + binding
   * 7. 更新后续行 lineNumber
   */
  async delete(
    storagePk: string,
    options?: WriteOptions,
  ): Promise<WriteResult> {
    const binding = this.binding.findByStoragePk(storagePk);
    if (!binding) {
      throw new EngineError(`Binding not found for storagePk "${storagePk}"`, 'BINDING_NOT_FOUND');
    }

    const tableName = binding.tableName;
    const filePath = binding.filePath;

    return this.lockManager.withFileLock(filePath, storagePk, async () => {
      // 读取文件
      let content: string;
      try {
        content = await this.fileOperator.readFile(filePath);
      } catch (e) {
        throw new WriteError(`Failed to read file "${filePath}": ${e}`, tableName, filePath);
      }

      // Hash 校验（除非 force）
      let actualLineNumber = binding.lineNumber;
      if (!options?.force) {
        assertLineHash(content, binding.lineNumber, binding.rowHash, filePath, tableName);
      } else {
        const found = findLineByPkInContent(content, storagePk);
        if (found > 0) actualLineNumber = found;
      }

      // 删除行
      const newContent = deleteLine(content, actualLineNumber);

      // 写文件
      try {
        await this.fileOperator.writeFile(filePath, newContent);
      } catch (e) {
        throw new WriteError(`Failed to write file "${filePath}": ${e}`, tableName, filePath);
      }

      // 删除 SQLite 用户表记录
      const schema = this.schemaRegistry.getSchema(tableName);
      if (schema) {
        this.sqlite.run(
          `DELETE FROM ${safeIdent(tableName)} WHERE "storage_pk" = ?`,
          [storagePk],
        );
      }

      // 删除 binding
      this.binding.deleteByStoragePk(storagePk);

      // 后续行 lineNumber - 1
      this.binding.shiftLineNumbers(filePath, actualLineNumber, -1);

      // 更新 file hash
      this.fileHash.setHash(filePath, simpleHash(newContent));

      return {
        success: true,
        storagePk,
        syncState: 'synced',
        filePath,
        tableName,
      };
    });
  }

  /**
   * 批量更新
   */
  async updateAll(
    pairs: Array<{ storagePk: string; patch: RecordPatch }>,
  ): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    for (const { storagePk, patch } of pairs) {
      const r = await this.update(storagePk, patch);
      results.push(r);
    }
    return results;
  }

  /**
   * 批量删除
   */
  async deleteAll(storagePks: string[]): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    for (const pk of storagePks) {
      const r = await this.delete(pk);
      results.push(r);
    }
    return results;
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  /**
   * 查找表对应的写入目标文件
   *
   * 多文件表策略：
   * 1. 优先使用标记了 writeTarget 的 source
   * 2. 否则使用第一个 source（兼容单文件表）
   * 3. 无 source 则返回 null
   */
  private resolveTableFile(tableName: string): string | null {
    const entry = this.schemaRegistry.getTable(tableName);
    if (!entry || entry.sources.length === 0) return null;

    // 优先 writeTarget
    const target = entry.sources.find(s => s.writeTarget);
    if (target) return target.file;

    // 默认第一个 source
    return entry.sources[0]!.file;
  }

  /**
   * 在文件内容中查找指定表的 mddb 块的闭合围栏行号
   *
   * 查找策略：
   * 1. `schema=tableName` 在 infoString 中的直接匹配
   * 2. 块内 `@table tableName` 指令匹配
   * 3. 如果文件中只有一个 mddb 块，且该表是文件唯一的 schema → 使用它
   * 4. 返回最后一个匹配的块（多块场景）
   */
  private findBlockEndLine(content: string, tableName: string): number {
    const lines = content.split('\n');
    const FENCE_PATTERN = /^(`{3,})\s*mddb(\s+.*)?$/;
    const CLOSE_FENCE_PATTERN = /^(`{3,})\s*$/;
    const TABLE_DIRECTIVE_PATTERN = /@table\s+(\S+)/;

    const blocks: Array<{ startLine: number; endLine: number; infoString: string; contentLines: string[]; fenceChar: string }> = [];
    let i = 0;

    // 第一阶段：找出所有 mddb 块
    while (i < lines.length) {
      const line = lines[i]!;
      const match = line.match(FENCE_PATTERN);

      if (match) {
        const fenceChar = match[1]!;
        const infoString = (match[2] ?? '').trim();
        const startLine = i + 1;
        const contentLines: string[] = [];
        i++;

        while (i < lines.length) {
          const innerLine = lines[i]!;
          if (CLOSE_FENCE_PATTERN.test(innerLine)) break;
          contentLines.push(innerLine);
          i++;
        }

        const endLine = i + 1; // 1-based
        i++; // skip closing fence

        blocks.push({ startLine, endLine, infoString, contentLines, fenceChar });
      } else {
        i++;
      }
    }

    if (blocks.length === 0) return -1;

    // 第二阶段：查找匹配的块
    let matchedBlock: (typeof blocks)[0] | null = null;

    for (const block of blocks) {
      // 策略 1: infoString 中有 schema=tableName
      const schemaMatch = block.infoString.match(/schema=(\S+)/);
      if (schemaMatch && schemaMatch[1] === tableName) {
        matchedBlock = block;
        continue; // 继续查找，取最后一个匹配
      }

      // 策略 2: 块内有 @table tableName 指令
      const hasTableDirective = block.contentLines.some(
        cl => TABLE_DIRECTIVE_PATTERN.test(cl.trim()) &&
              cl.trim().match(TABLE_DIRECTIVE_PATTERN)![1] === tableName,
      );
      if (hasTableDirective) {
        matchedBlock = block;
        continue;
      }
    }

    // 策略 3: 如果只有一个 mddb 块，使用它
    if (!matchedBlock && blocks.length === 1) {
      matchedBlock = blocks[0]!;
    }

    if (!matchedBlock) return -1;

    return matchedBlock.endLine;
  }

  /**
   * 确保用户表存在
   */
  private ensureUserTable(schema: SchemaSummary): void {
    const columns = schema.fields.map((field, i) => {
      const col = safeIdent(field);
      const type = sqliteType(schema.types[i] ?? 'string');
      return `  ${col} ${type}`;
    });

    const ddl = `CREATE TABLE IF NOT EXISTS ${safeIdent(schema.table)} (\n  storage_pk TEXT,\n${columns.join(',\n')}\n)`;
    this.sqlite.run(ddl);
  }

  /**
   * 构建 INSERT SQL
   */
  private buildInsertSQL(schema: SchemaSummary): string {
    const fieldList = ['storage_pk', ...schema.fields.map(f => safeIdent(f))].join(', ');
    const placeholders = schema.fields.map(() => '?');
    placeholders.unshift('?');
    return `INSERT INTO ${safeIdent(schema.table)} (${fieldList}) VALUES (${placeholders.join(', ')})`;
  }

  /**
   * 将值转换为 SQL 参数
   */
  private valueForSQL(value: unknown, typeExpr: string): unknown {
    const typeName = typeExpr.split('(')[0]!;

    switch (typeName) {
      case 'decimal': {
        const precision = extractPrecision(typeExpr);
        const num = typeof value === 'number' ? value : parseFloat(String(value));
        if (isNaN(num)) return null;
        return Math.round(num * Math.pow(10, precision));
      }
      case 'boolean':
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string') {
          return ['true', 'yes', '1', '是'].includes(value.toLowerCase()) ? 1 : 0;
        }
        return value ? 1 : 0;
      case 'tags':
        if (Array.isArray(value)) return JSON.stringify(value);
        return String(value);
      default:
        return value;
    }
  }

  /**
   * 对一行 Markdown 数据应用 patch
   *
   * 解析旧行 → 对 patched 字段覆写 → 重新序列化
   */
  private applyPatchToLine(oldLine: string, patch: RecordPatch, schema: SchemaSummary): string {
    const rawFields = splitLineFields(oldLine);
    const { types, nullMarker, fields } = schema;

    const currentValues: unknown[] = fields.map((field, i) => {
      if (field in patch) {
        return patch[field]!;
      }
      if (i < rawFields.length) {
        const raw = rawFields[i]!;
        if (raw === '' || raw === nullMarker) return null;
        return raw;
      }
      return null;
    });

    const serialized = serializeRow(currentValues, schema);
    return serialized.line.trimEnd();
  }
}

// ============================================================
// 模块级辅助
// ============================================================

function splitLineFields(line: string): string[] {
  const NONPIPE = '\x00NP';
  const BSLASH = '\x00BS';
  const escaped = line.replace(/\\\|/g, NONPIPE).replace(/\\\\/g, BSLASH);
  const parts = escaped.split('|');
  return parts.map(part =>
    part
      .replace(new RegExp(NONPIPE, 'g'), '|')
      .replace(new RegExp(BSLASH, 'g'), '\\')
      .trim(),
  );
}

function computeLogicalPk(values: unknown[], schema: SchemaSummary): string {
  const { pk, fields } = schema;
  if (pk.includes('$uuid')) return '';
  const parts = pk.map(pkField => {
    const idx = fields.indexOf(pkField);
    if (idx < 0) return '';
    const v = values[idx];
    return v === null || v === undefined ? '' : String(v);
  });
  return parts.filter(p => p.length > 0).join('\x1F');
}

function extractPrecision(typeExpr: string): number {
  const match = typeExpr.match(/\((\d+)\)/);
  return match ? parseInt(match[1]!, 10) : 2;
}

/**
 * 在文件内容中按行搜索 storage_pk
 * 用于 force 模式下重新定位行号
 */
function findLineByPkInContent(content: string, storagePk: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(storagePk)) {
      return i + 1; // 1-based line number
    }
  }
  return -1;
}
