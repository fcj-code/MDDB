/**
 * Schema 元验证 + SQL Identifier 安全规则
 *
 * 参考：sql-safety-rules.md §2-3, identity-model.md §4.4
 */

import type { SchemaSummary, IndexDef, RelationDef } from '../core/types';
import { SchemaError } from '../core/errors';

// ============================================================
// Identifier 规则
// ============================================================

export type IdentifierMode = 'ascii' | 'quoted';

/** Unicode 标识符模式（支持中文、下划线开头，后跟字母、数字、中文） */
const IDENT_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** 验证标识符格式（ASCII 或 Unicode） */
export function validateIdent(name: string, context: 'table' | 'field' | 'index'): boolean {
  return IDENT_PATTERN.test(name);
}

/** 安全引用标识符 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 统一安全的标识符处理 */
export function safeIdent(name: string, mode: IdentifierMode): string {
  if (mode === 'ascii') {
    if (!validateIdent(name, 'field')) {
      throw new SchemaError(`Invalid identifier: "${name}" — must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
    }
    return name;
  }
  return quoteIdent(name);
}

// ============================================================
// Sort 子句解析
// ============================================================

export interface ParsedSortClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

/**
 * 将字符串格式 @sort 解析为结构化数组
 * 输入: "日期 ASC, 金额 DESC" 或 "(日期 ASC, 金额 DESC)"
 */
export function parseSortClause(raw: string, validFields: Set<string>): ParsedSortClause[] {
  // 去除外层括号和首尾空白
  let trimmed = raw.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  if (!trimmed) {
    throw new SchemaError('@sort clause is empty');
  }

  const items = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  const result: ParsedSortClause[] = [];

  for (const item of items) {
    // 匹配 "字段名 ASC/DESC" — Unicode 字段名
    const match = item.match(/^([\p{L}\p{N}_]+)\s+(ASC|DESC)$/ui);
    if (!match) {
      throw new SchemaError(`Invalid @sort item: "${item}" — expected format: "field ASC" or "field DESC"`);
    }

    const field = match[1] ?? item.split(/\s+/)[0]!;
    const direction = (match[2] ?? 'ASC').toUpperCase() as 'ASC' | 'DESC';

    if (!validFields.has(field)) {
      throw new SchemaError(`@sort field "${field}" not found in @fields`);
    }

    result.push({ field, direction });
  }

  if (result.length === 0) {
    throw new SchemaError('@sort clause produced no valid sort items');
  }

  return result;
}

// ============================================================
// Index 子句解析
// ============================================================

export interface ParsedIndexDef {
  name: string;
  fields: string[];
}

/**
 * 解析 @indexes 行
 * 输入: "idx(分类) | idx(金额)"
 */
export function parseIndexes(rawItems: string[], validFields: Set<string>): ParsedIndexDef[] {
  const result: ParsedIndexDef[] = [];

  for (const raw of rawItems) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '-') continue;

    // idx(字段名) 或 idx_name(字段名) — Unicode 字段名
    const match = trimmed.match(/^(\w+)\(([\p{L}\p{N}_]+)\)$/u);
    if (!match) {
      throw new SchemaError(`Invalid @indexes format: "${trimmed}" — expected "idx(field)"`);
    }

    const name = match[1]!;
    const field = match[2]!;

    if (!validFields.has(field)) {
      throw new SchemaError(`@indexes field "${field}" not found in @fields`);
    }

    result.push({ name, fields: [field] });
  }

  return result;
}

// ============================================================
// Relations 解析
// ============================================================

export interface ParsedRelation {
  field: string;
  targetTable: string;
  targetField: string;
}

/**
 * 解析 @relations 行
 *
 * 支持格式：
 *   "分类 -> categories.code"           // 正向引用
 *   "分类 <- transactions.分类"          // 反向引用（自动翻转）
 *   "分类 -> categories.code, 账户 -> accounts.name"  // 逗号分隔多条
 *
 * Unicode 字段名（中文等）也支持。
 */
export function parseRelations(rawItems: string[], validFields: Set<string>): ParsedRelation[] {
  const result: ParsedRelation[] = [];

  for (const raw of rawItems) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '-') continue;

    // 先按逗号拆分多条关系（注意 @relations 行可能已由上游按 | 切分）
    const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
      // 正向: field -> targetTable.targetField
      // 反向: field <- targetTable.targetField
      const forwardMatch = part.match(/^([\p{L}\p{N}_]+)\s*->\s*([\p{L}\p{N}_]+)\.([\p{L}\p{N}_]+)$/u);
      // 反向: field <- targetTable.targetField → 翻转
      const reverseMatch = part.match(/^([\p{L}\p{N}_]+)\s*<-\s*([\p{L}\p{N}_]+)\.([\p{L}\p{N}_]+)$/u);

      if (forwardMatch) {
        const field = forwardMatch[1]!;
        const targetTable = forwardMatch[2]!;
        const targetField = forwardMatch[3]!;

        if (!validFields.has(field)) {
          throw new SchemaError(`@relations field "${field}" not found in @fields`);
        }

        result.push({ field, targetTable, targetField });
      } else if (reverseMatch) {
        // 反向引用: "分类 <- transactions.分类"
        // 表示当前表的字段「分类」被 transactions.分类 引用
        // 存储为 ref 关系，方向翻转
        const field = reverseMatch[1]!;
        const refTable = reverseMatch[2]!;
        const refField = reverseMatch[3]!;

        if (!validFields.has(field)) {
          throw new SchemaError(`@relations field "${field}" not found in @fields`);
        }

        // 存为 "refTable.refField ← field" 语义
        result.push({ field, targetTable: refTable, targetField: refField });
      } else {
        // 短格式 "table.field" — 继承上一个 relation 的 field
        const shortMatch = part.match(/^([\p{L}\p{N}_]+)\.([\p{L}\p{N}_]+)$/u);
        if (shortMatch && result.length > 0) {
          const prevField = result[result.length - 1]!.field;
          const targetTable = shortMatch[1]!;
          const targetField = shortMatch[2]!;
          result.push({ field: prevField, targetTable, targetField });
        } else {
          throw new SchemaError(
            `Invalid @relations format: "${part}" — expected "field -> targetTable.targetField" or "field <- targetTable.targetField"`,
          );
        }
      }
    }
  }

  return result;
}

// ============================================================
// Schema 元验证
// ============================================================

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 验证 Schema 对象的完整性
 */
export function validateSchema(schema: Partial<SchemaSummary>, identifierMode: IdentifierMode = 'ascii'): SchemaValidationResult {
  const errors: string[] = [];

  // 必需字段
  if (!schema.table) {
    errors.push('@table is required');
  }
  if (!schema.pk || schema.pk.length === 0) {
    errors.push('@pk is required');
  }
  if (!schema.fields || schema.fields.length === 0) {
    errors.push('@fields is required');
  }
  if (!schema.types || schema.types.length === 0) {
    errors.push('@types is required');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 安全的类型断言
  const fields = schema.fields!;
  const types = schema.types!;

  // 列数匹配
  if (fields.length !== types.length) {
    errors.push(`@fields (${fields.length}) and @types (${types.length}) must have the same number of columns`);
  }

  // required 列数
  if (schema.required && schema.required.length > 0 && schema.required.length !== fields.length) {
    errors.push(`@required (${schema.required.length}) must have the same number of columns as @fields (${fields.length})`);
  }

  // Identifier 验证
  if (identifierMode === 'ascii') {
    try {
      safeIdent(schema.table!, identifierMode);
    } catch (e) {
      errors.push(String(e));
    }

    for (const f of fields) {
      if (!validateIdent(f, 'field')) {
        errors.push(`Invalid field name: "${f}"`);
      }
    }
  }

  // PK 字段必须在 fields 中（$uuid 除外）
  if (schema.pk) {
    for (const pk of schema.pk) {
      if (pk === '$uuid') continue;
      if (!fields.includes(pk)) {
        errors.push(`@pk field "${pk}" not found in @fields`);
      }
    }
  }

  // sort 验证
  if (schema.sort) {
    try {
      parseSortClause(schema.sort, new Set(fields));
    } catch (e) {
      errors.push(String(e));
    }
  }

  // indexes 验证
  if (schema.indexes) {
    try {
      parseIndexes(schema.indexes, new Set(fields));
    } catch (e) {
      errors.push(String(e));
    }
  }

  // relations 验证
  if (schema.relations) {
    try {
      parseRelations(schema.relations, new Set(fields));
    } catch (e) {
      errors.push(String(e));
    }
  }

  // nullMarker 不应为空
  if (schema.nullMarker !== undefined && schema.nullMarker.trim() === '') {
    errors.push('@null_marker cannot be empty');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 验证标识符不进入 SQL 保留字列表（已知风险项）
 * MVP 阶段只验证 ASCII 模式；保留字冲突由 SQLite 异常路径捕获
 */
export function checkReservedWord(name: string): boolean {
  const reserved = [
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE',
    'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'AND', 'OR',
    'NOT', 'IN', 'LIKE', 'IS', 'NULL', 'TRUE', 'FALSE',
    'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
    'AS', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
    'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
    'BEGIN', 'COMMIT', 'ROLLBACK', 'PRAGMA',
  ];
  return reserved.includes(name.toUpperCase());
}
