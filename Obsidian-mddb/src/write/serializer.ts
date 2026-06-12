/**
 * 序列化器 (Serializer)
 *
 * 将 RecordInput / 字段值转换为 Markdown B 格式的管道分隔行。
 *
 * B 格式规范：
 * - 字段间以 `|` 分隔，前后允许空格
 * - 值内出现的 `|` 需转义为 `\|`
 * - 值内出现的 `\` 需转义为 `\\`
 * - 空值用 nullMarker（默认 "-"）表示
 *
 * 参考：v2 roadmap Milestone 2, parse-pipeline-design.md
 */

import type { SchemaSummary } from '../core/types';
import type { SerializedRow } from './types';

// ============================================================
// 值序列化
// ============================================================

/**
 * 将单个值序列化为字符串（用于 Markdown 行）
 *
 * 根据字段类型进行格式化，与 parse-pipeline 的 converter 反向。
 */
export function serializeValue(value: unknown, fieldType: string, nullMarker: string): string {
  if (value === null || value === undefined) {
    return nullMarker;
  }

  // 处理各类型的显示格式
  const typeName = fieldType.split('(')[0]!;

  switch (typeName) {
    case 'boolean': {
      // SQLite 存 0/1 → 显示 true/false
      return value === 1 || value === true ? 'true' : 'false';
    }

    case 'decimal': {
      // decimal(N): 输入已是显示值（非 SQLite 内部 BIGINT），直接格式化
      const precision = extractPrecision(fieldType);
      const num = Number(value);
      if (isNaN(num)) return nullMarker;
      return num.toFixed(precision);
    }

    case 'tags': {
      // tags 存 JSON 数组 → 恢复 #tag 空格分隔
      if (typeof value === 'string') {
        try {
          const tags = JSON.parse(value) as string[];
          return (tags as string[]).map(t => `#${t}`).join(' ');
        } catch {
          return value;
        }
      }
      if (Array.isArray(value)) {
        return (value as string[]).map(t => `#${t}`).join(' ');
      }
      return String(value);
    }

    default:
      return String(value);
  }
}

/** 从类型表达式提取精度，如 "decimal(2)" → 2 */
function extractPrecision(typeExpr: string): number {
  const match = typeExpr.match(/\((\d+)\)/);
  return match ? parseInt(match[1]!, 10) : 2;
}

// ============================================================
// 转义
// ============================================================

/**
 * 转义 Markdown 管道分隔行中的特殊字符
 *
 * 规则：
 * - `|` → `\|`
 * - `\` → `\\`
 */
export function escapePipe(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

/**
 * 撤销转义，恢复原始值
 */
export function unescapePipe(value: string): string {
  return value
    .replace(/\\\|/g, '|')
    .replace(/\\\\/g, '\\');
}

// ============================================================
// 行序列化
// ============================================================

/**
 * 将字段值数组序列化为完整的 Markdown 行
 *
 * @param fieldValues  字段值数组（与 schema.fields 顺序一致）
 * @param schema       Schema
 * @returns 序列化结果
 */
export function serializeRow(
  fieldValues: unknown[],
  schema: SchemaSummary,
): SerializedRow {
  const { types, nullMarker } = schema;

  const parts: string[] = [];

  for (let i = 0; i < schema.fields.length; i++) {
    const rawValue = i < fieldValues.length ? fieldValues[i] : null;
    const typeExpr = types[i] ?? 'string';
    const serialized = serializeValue(rawValue, typeExpr, nullMarker);
    const escaped = escapePipe(serialized);
    parts.push(escaped);
  }

  const line = parts.join(' | ');

  return {
    line: line + '\n',
    values: parts,
    rawLineHash: simpleHash(line),
  };
}

/**
 * 将 RecordInput（键值对）按 Schema 字段顺序序列化
 *
 * @param record  键值对记录
 * @param schema  Schema
 * @returns 字段值数组（与 schema.fields 顺序一致）
 */
export function recordInputToValues(
  record: Record<string, unknown>,
  schema: SchemaSummary,
): unknown[] {
  return schema.fields.map(field => {
    if (field in record) {
      return record[field]!;
    }
    return null;
  });
}

// ============================================================
// 行替换
// ============================================================

/**
 * 在 Markdown 文件内容中替换指定行
 *
 * @param content     原始文件内容
 * @param lineNumber  目标行号（1-based）
 * @param newLine     新行内容（含换行符）
 * @returns 替换后的内容
 */
export function replaceLine(content: string, lineNumber: number, newLine: string): string {
  const lines = content.split('\n');

  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new Error(`Line number out of range: ${lineNumber}, total: ${lines.length}`);
  }

  lines[lineNumber - 1] = newLine.endsWith('\n') ? newLine.slice(0, -1) : newLine;
  return lines.join('\n');
}

/**
 * 在 Markdown 文件内容中删除指定行
 *
 * @param content     原始文件内容
 * @param lineNumber  目标行号（1-based）
 * @returns 删除后的内容
 */
export function deleteLine(content: string, lineNumber: number): string {
  const lines = content.split('\n');

  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new Error(`Line number out of range: ${lineNumber}, total: ${lines.length}`);
  }

  lines.splice(lineNumber - 1, 1);
  return lines.join('\n');
}

/**
 * 在 Markdown 文件内容的 mddb 块尾部追加一行
 *
 * @param content      原始文件内容
 * @param blockEndLine mddb 块闭合围栏的行号（1-based）
 * @param newLine      追加的新行内容（含换行符）
 * @returns 追加后的内容
 */
export function appendToBlock(content: string, blockEndLine: number, newLine: string): string {
  const lines = content.split('\n');

  if (blockEndLine < 1 || blockEndLine > lines.length) {
    throw new Error(`Block end line out of range: ${blockEndLine}, total: ${lines.length}`);
  }

  // 在闭合围栏前一行插入新数据行
  const insertAt = blockEndLine - 1; // 闭合围栏行号的前一行
  lines.splice(insertAt, 0, newLine.trimEnd());

  return lines.join('\n');
}

// ============================================================
// 哈希
// ============================================================

/**
 * 简单字符串 hash（32-bit FNV-1a）
 */
export function simpleHash(str: string): string {
  let hash = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
