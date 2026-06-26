/**
 * 写入前记录校验
 *
 * 在 engine.insert / engine.update 写入磁盘前对记录做校验：
 * - 必填字段不能为空
 * - 类型格式合法（复用 parse/converter 的转换逻辑）
 *
 * enum 取值、ref 存在性不在此校验（表单控件本身已约束）。
 */

import type { SchemaSummary } from '../core/types';
import type { FieldValidationError } from '../core/errors';
import { parseTypeExpr, convertValue } from '../parse/converter';

/** 需要做格式校验的类型 — 这些类型的值若无法转换则视为非法 */
const FORMAT_CHECKED = new Set([
  'integer',
  'decimal',
  'date',
  'datetime',
  'phone',
  'email',
]);

export interface ValidateOptions {
  /** 部分更新：只校验 record 中出现的字段，跳过缺失的必填项 */
  partial?: boolean;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * 校验记录，返回字段错误列表（空数组表示通过）
 */
export function validateRecord(
  schema: SchemaSummary,
  record: Record<string, unknown>,
  options?: ValidateOptions,
): FieldValidationError[] {
  const partial = options?.partial ?? false;
  const errors: FieldValidationError[] = [];

  schema.fields.forEach((field, i) => {
    const present = field in record;

    // 部分更新模式：未提供的字段一律跳过（含必填）
    if (partial && !present) return;

    const value = record[field];
    const required = schema.required[i] ?? false;

    if (isEmpty(value)) {
      if (required) {
        errors.push({ field, message: `「${field}」为必填项` });
      }
      return;
    }

    const typeExpr = schema.types[i] ?? 'string';
    const { typeName } = parseTypeExpr(typeExpr);
    if (!FORMAT_CHECKED.has(typeName)) return;

    const result = convertValue(String(value), typeExpr);
    if (result.error) {
      errors.push({ field, message: result.error.message });
    }
  });

  return errors;
}
