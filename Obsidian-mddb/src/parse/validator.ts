/**
 * 解析验证器
 *
 * 验证链：字段数校验 → 必填检查 → 逻辑 PK 唯一性
 *
 * 参考：parse-pipeline-design.md §5, identity-model.md §2.3
 */

import type { SchemaSummary, ParsedRecord } from '../core/types';
import { ParseErrorCode, type ParseError, type ParseWarning } from '../core/errors';

// ============================================================
// ParseResult
// ============================================================

export interface ParseResult {
  records: ParsedRecord[];
  errorCount: number;
  warningCount: number;
  errors: ParseError[];
  warnings: ParseWarning[];
}

export function emptyParseResult(): ParseResult {
  return {
    records: [],
    errorCount: 0,
    warningCount: 0,
    errors: [],
    warnings: [],
  };
}

// ============================================================
// 验证链
// ============================================================

export interface ValidationOptions {
  /** 严格模式：跳过整行而非补充 NULL */
  strict: boolean;
  /** 空值占位符 */
  nullMarker: string;
  /** 已存在的 logicalPk 集合（用于 PK 唯一性校验） */
  existingLogicalPks: Set<string>;
  /** 表名（用于错误报告） */
  tableName: string;
  /** 文件名（用于错误报告） */
  fileName?: string;
}

/**
 * 验证并组装一条数据行
 *
 * 返回 { validatedRecord, errors }。
 * 如果 strict 模式下校验失败，validatedRecord 为 null。
 */
export function validateRow(
  rawValues: unknown[],
  rawLine: string,
  lineNumber: number,
  schema: SchemaSummary,
  options: ValidationOptions,
): { record: ParsedRecord | null; errors: ParseError[]; warnings: ParseWarning[] } {
  const errors: ParseError[] = [];
  const warnings: ParseWarning[] = [];
  const { fields, types, required, pk, nullMarker, strict } = schema;

  // ── 1. 字段数校验 ──
  if (rawValues.length !== fields.length) {
    const error: ParseError = {
      code: ParseErrorCode.FIELD_COUNT_MISMATCH,
      message: `Field count mismatch: expected ${fields.length}, got ${rawValues.length}`,
      table: options.tableName,
      file: options.fileName,
      lineNumber,
    };

    if (strict) {
      return { record: null, errors: [error], warnings: [] };
    }

    // 宽松模式：不足补 NULL / 超出截断
    errors.push(error);
    if (rawValues.length < fields.length) {
      // 补 NULL
      while (rawValues.length < fields.length) {
        rawValues.push(null);
      }
    } else {
      // 截断
      rawValues.length = fields.length;
    }
  }

  // ── 2. 必填字段检查 ──
  for (let i = 0; i < fields.length; i++) {
    if (required[i] && (rawValues[i] === null || rawValues[i] === undefined || rawValues[i] === '')) {
      warnings.push({
        code: ParseErrorCode.REQUIRED_MISSING,
        message: `Required field "${fields[i]}" is missing or null`,
        table: options.tableName,
        file: options.fileName,
        field: fields[i],
        lineNumber,
      });
    }
  }

  // ── 3. PK 隐式必填 ──
  // PK 字段即使未在 @required 中标记，也视为必填
  for (const pkField of pk) {
    if (pkField === '$uuid') continue;

    const pkIdx = fields.indexOf(pkField);
    if (pkIdx >= 0 && (rawValues[pkIdx] === null || rawValues[pkIdx] === undefined)) {
      errors.push({
        code: ParseErrorCode.REQUIRED_MISSING,
        message: `PK field "${pkField}" is implicitly required but missing`,
        table: options.tableName,
        file: options.fileName,
        field: pkField,
        lineNumber,
      });

      if (strict) {
        return { record: null, errors, warnings };
      }

      // 宽松模式下仍然是错误，但继续处理
    }
  }

  // ── 4. 逻辑 PK 唯一性 ──
  if (errors.length === 0) {
    const pkValue = computeLogicalPk(rawValues, schema);

    if (pkValue !== null && options.existingLogicalPks.has(pkValue)) {
      errors.push({
        code: ParseErrorCode.PK_DUPLICATE,
        message: `Duplicate logical PK: "${pkValue}"`,
        table: options.tableName,
        file: options.fileName,
        lineNumber,
      });

      if (strict) {
        return { record: null, errors, warnings };
      }
    }
  }

  // ── 严格模式：有 fatal error 时跳过整行 ──
  if (strict && errors.length > 0) {
    return { record: null, errors, warnings };
  }

  // ── 组装 Record ──
  const record: ParsedRecord = {
    values: rawValues,
    rawLine,
    lineNumber,
    tableName: options.tableName,
  };

  return { record, errors, warnings };
}

/**
 * 计算逻辑主键值
 */
export function computeLogicalPk(values: unknown[], schema: SchemaSummary): string | null {
  const { pk, fields } = schema;

  if (pk.includes('$uuid')) return null; // UUID PK，不在此处生成

  const pkParts = pk.map(pkField => {
    const idx = fields.indexOf(pkField);
    if (idx < 0) return '';
    const val = values[idx];
    return val === null || val === undefined ? '' : String(val);
  });

  const pkValue = pkParts.join('\x1F'); // 复合 PK 用 \x1F 分隔
  return pkValue.length > 0 ? pkValue : null;
}

/**
 * 批量验证多行，含 PK 去重累积
 */
export function validateRows(
  rowResults: Array<{ rawValues: unknown[]; rawLine: string; lineNumber: number }>,
  schema: SchemaSummary,
  options: ValidationOptions,
): ParseResult {
  const result = emptyParseResult();
  const existingPks = new Set(options.existingLogicalPks);

  for (const row of rowResults) {
    const rowOpts: ValidationOptions = {
      ...options,
      existingLogicalPks: existingPks,
    };

    const { record, errors, warnings } = validateRow(
      row.rawValues,
      row.rawLine,
      row.lineNumber,
      schema,
      rowOpts,
    );

    // 收集错误/警告
    for (const e of errors) {
      result.errors.push(e);
      result.errorCount++;
    }
    for (const w of warnings) {
      result.warnings.push(w);
      result.warningCount++;
    }

    // 如果成功，记录 PK
    if (record) {
      const pkValue = computeLogicalPk(record.values, schema);
      if (pkValue) {
        existingPks.add(pkValue);
      }
      result.records.push(record);
    }
  }

  return result;
}
