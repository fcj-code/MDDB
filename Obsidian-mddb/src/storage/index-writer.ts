/**
 * 索引写入器 (IndexWriter)
 *
 * 将验证通过的记录写入 SQLite 用户表 + _binding 表。
 *
 * 参考：parse-pipeline-design.md §6, identity-model.md §2-3
 */

import type { SchemaSummary, ParsedRecord, BindingRow, SyncState } from '../core/types';
import { safeIdent } from '../schema/validators';

/** SQL 类型映射 */
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

/** 从 FieldType 解析基础 SQLite 列类型 */
function sqliteType(typeExpr: string): string {
  // "decimal(2)" → decimal
  const baseName = typeExpr.split('(')[0]!;
  return TYPE_MAP[baseName] ?? 'TEXT';
}

/** 根据 Schema 生成 CREATE TABLE 语句 */
export function generateCreateTableSQL(schema: SchemaSummary, mode: 'ascii' | 'quoted'): string {
  const tableName = safeIdent(schema.table, mode);
  const columns = schema.fields.map((field, i) => {
    const col = safeIdent(field, mode);
    const type = sqliteType(schema.types[i] ?? 'string');
    return `  ${col} ${type}`;
  });

  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  storage_pk TEXT,\n${columns.join(',\n')}\n)`;
}

/** 生成 INSERT 语句 */
export function generateInsertSQL(schema: SchemaSummary, mode: 'ascii' | 'quoted'): string {
  const tableName = safeIdent(schema.table, mode);
  const fieldList = ['storage_pk', ...schema.fields.map(f => safeIdent(f, mode))].join(', ');
  const placeholders = schema.fields.map(() => '?');
  placeholders.unshift('?');
  return `INSERT INTO ${tableName} (${fieldList}) VALUES (${placeholders.join(', ')})`;
}

/** 生成 storagePk（不含 lineNumber） */
export function generateStoragePk(
  filePath: string,
  lineNumber: number,
  rawLine: string,
  logicalPk: string,
  tableName: string,
): string {
  // v2 身份模型：优先使用 logicalPk 的 hash
  if (logicalPk) {
    // 使用简单 hash — 正式版应使用 crypto
    const h = simpleHash(tableName + ':' + logicalPk);
    return `${h}`;
  }

  // fallback: 基于内容的 hash
  const h = simpleHash(rawLine);
  return `${h}`;
}

/** 简单字符串 hash（32-bit FNV-1a，用于 MVP 占位） */
function simpleHash(str: string): string {
  let hash = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 生成 blockId */
export function generateBlockId(filePath: string, blockIndex: number): string {
  const h = simpleHash(filePath + ':' + blockIndex);
  return `blk_${h}`;
}

/** 生成 rowHash */
export function generateRowHash(rawLine: string): string {
  return simpleHash(rawLine);
}

// ============================================================
// IndexWriter
// ============================================================

export interface WriteContext {
  /** sql.js run 方法 */
  run: (sql: string, params?: unknown[]) => void;
  /** sql.js query 方法 */
  query: (sql: string, params?: unknown[]) => { columns: string[]; rows: unknown[][] };
  /** 标识符模式 */
  identMode: 'ascii' | 'quoted';
}

/**
 * 将一组已验证的记录写入 SQLite
 */
export function writeRecords(
  records: ParsedRecord[],
  schema: SchemaSummary,
  context: WriteContext,
  options: {
    filePath: string;
    blockId: string;
    blockIndex: number;
    nullMarker: string;
  },
): BindingRow[] {
  const bindingRows: BindingRow[] = [];

  if (records.length === 0) return bindingRows;

  // 1. 确保用户表存在
  const ddl = generateCreateTableSQL(schema, context.identMode);
  context.run(ddl);

  // 2. 准备 INSERT 语句
  const insertSQL = generateInsertSQL(schema, context.identMode);

  // 3. 写入每条记录
  for (const record of records) {
    // 生成 storagePk
    const logicalPk = computeLogicalPkForIndex(record.values, schema);
    const storagePk = generateStoragePk(
      options.filePath,
      record.lineNumber,
      record.rawLine,
      logicalPk,
      schema.table,
    );

    // 生成 rowHash
    const rowHash = generateRowHash(record.rawLine);

    // 写入用户表（包含 storage_pk 作为第一列）
    const params = [storagePk, ...record.values.map(v => {
      if (v === null || v === undefined) return null;
      return v;
    })];

    try {
      context.run(insertSQL, params);
    } catch (e) {
      // PK 冲突或 UNIQUE 约束冲突
      continue;
    }

    // 写入 _binding
    const bindingRow: BindingRow = {
      storagePk,
      logicalPk,
      tableName: schema.table,
      filePath: options.filePath,
      blockId: options.blockId,
      blockIndex: options.blockIndex,
      lineNumber: record.lineNumber,
      rowHash,
      rawLineHash: rowHash,
      lastVerified: new Date().toISOString(),
      syncState: 'synced',
    };

    try {
      context.run(
        `INSERT INTO _binding
         (storage_pk, logical_pk, table_name, file_path,
          block_id, block_index, line_number,
          row_hash, raw_line_hash, last_verified, sync_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          bindingRow.storagePk, bindingRow.logicalPk, bindingRow.tableName,
          bindingRow.filePath, bindingRow.blockId, bindingRow.blockIndex,
          bindingRow.lineNumber, bindingRow.rowHash, bindingRow.rawLineHash,
          bindingRow.lastVerified, bindingRow.syncState,
        ],
      );
    } catch {
      // 如果 _binding INSERT 失败但用户表已写入，忽略
      // 这只在幂等重扫场景可能发生
      continue;
    }

    bindingRows.push(bindingRow);
  }

  return bindingRows;
}

/** 从记录值计算逻辑 PK（只用于写入，不承担唯一性校验） */
function computeLogicalPkForIndex(values: unknown[], schema: SchemaSummary): string {
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

/** 创建用户表的辅助方法 */
export function ensureTableExists(schema: SchemaSummary, context: WriteContext): void {
  const ddl = generateCreateTableSQL(schema, context.identMode);
  context.run(ddl);
}
