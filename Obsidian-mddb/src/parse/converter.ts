/**
 * 类型转换器 (TypeConverter)
 *
 * 实现 12 种字段类型的转换器。
 *
 * 参考：parse-pipeline-design.md §4
 */

import { ParseErrorCode, type ParseError } from '../core/errors';

// ============================================================
// 转换结果
// ============================================================

export interface ConversionResult {
  /** 转换后的值（转换失败时为 null） */
  value: unknown;
  /** 转换失败时的错误 */
  error?: ParseError;
}

// ============================================================
// 类型解析
// ============================================================

/** 从完整类型表达式中提取类型名和参数 */
export function parseTypeExpr(typeExpr: string): {
  typeName: string;
  params: string[];
} {
  const trimmed = typeExpr.trim();

  // 带参数的类型: "decimal(2)" "enum(支出,收入)" "ref(accounts)"
  const paramMatch = trimmed.match(/^(\w+)\((.+)\)$/);
  if (paramMatch) {
    const typeName = paramMatch[1]!;
    const paramsStr = paramMatch[2]!;

    // 对于 enum 和 ref，保留参数
    let params: string[];
    if (typeName === 'enum') {
      // enum(值1,值2,值3) — 逗号分隔
      params = splitEnumParams(paramsStr);
    } else if (typeName === 'ref') {
      // ref(tableName)
      params = [paramsStr.trim()];
    } else if (typeName === 'decimal') {
      // decimal(N)
      params = [paramsStr.trim()];
    } else {
      params = [paramsStr];
    }

    return { typeName, params };
  }

  // 无参数类型: "string" "integer" "boolean" 等
  return { typeName: trimmed, params: [] };
}

/** 分割 enum 参数，考虑括号嵌套 */
function splitEnumParams(raw: string): string[] {
  // enum(值1,值2,值3) → [值1, 值2, 值3]
  // 注意：参数内可能含逗号，但不应该出现嵌套括号
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// ============================================================
// 12 种类型转换器
// ============================================================

/** string：原样 trim，永不失败 */
export function convertString(raw: string): ConversionResult {
  return { value: raw.trim() };
}

/** integer：parseInt，正则校验整数 */
export function convertInteger(raw: string): ConversionResult {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return { value: parseInt(trimmed, 10) };
  }
  return {
    value: null,
    error: {
      code: ParseErrorCode.TYPE_CAST_FAILED,
      message: `Cannot cast "${raw}" to integer`,
    },
  };
}

/** decimal(N)：parseFloat × 10^N 存为 BIGINT */
export function convertDecimal(raw: string, precision: number): ConversionResult {
  const trimmed = raw.trim();
  const num = parseFloat(trimmed);
  if (isNaN(num)) {
    return {
      value: null,
      error: {
        code: ParseErrorCode.TYPE_CAST_FAILED,
        message: `Cannot cast "${raw}" to decimal(${precision})`,
      },
    };
  }

  const scaled = Math.round(num * Math.pow(10, precision));
  return { value: scaled };
}

/** boolean：多语言值支持 */
export function convertBoolean(raw: string): ConversionResult {
  const trimmed = raw.trim().toLowerCase();

  const TRUE_VALUES = ['true', 'yes', '1', '是', '对', '真', '✓', 'v'];
  const FALSE_VALUES = ['false', 'no', '0', '否', '错', '假', '✗', 'x'];

  if (TRUE_VALUES.includes(trimmed)) {
    return { value: 1 }; // SQLite INTEGER 0/1
  }
  if (FALSE_VALUES.includes(trimmed)) {
    return { value: 0 };
  }

  return {
    value: null,
    error: {
      code: ParseErrorCode.TYPE_CAST_FAILED,
      message: `Cannot cast "${raw}" to boolean`,
    },
  };
}

/** date：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD */
export function convertDate(raw: string): ConversionResult {
  const trimmed = raw.trim();

  // 匹配 YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
  const dateMatch = trimmed.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!dateMatch) {
    return {
      value: null,
      error: {
        code: ParseErrorCode.TYPE_CAST_FAILED,
        message: `Cannot cast "${raw}" to date — expected YYYY-MM-DD`,
      },
    };
  }

  const y = dateMatch[1]!;
  const m = dateMatch[2]!.padStart(2, '0');
  const d = dateMatch[3]!.padStart(2, '0');

  return { value: `${y}-${m}-${d}` };
}

/** datetime：YYYY-MM-DD HH:MM:SS / ISO 8601 */
export function convertDatetime(raw: string): ConversionResult {
  const trimmed = raw.trim();

  // YYYY-MM-DD HH:MM:SS
  const dtMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  if (dtMatch) {
    return { value: `${dtMatch[1]} ${dtMatch[2]}` };
  }

  // ISO 8601: YYYY-MM-DDTHH:MM:SS 或带时区
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoMatch) {
    return { value: isoMatch[1]! }; // 只保留 YYYY-MM-DDTHH:MM:SS
  }

  return {
    value: null,
    error: {
      code: ParseErrorCode.TYPE_CAST_FAILED,
      message: `Cannot cast "${raw}" to datetime — expected YYYY-MM-DD HH:MM:SS`,
    },
  };
}

/** enum(v1,v2,...)：精确匹配 */
export function convertEnum(raw: string, enumValues: string[]): ConversionResult {
  const trimmed = raw.trim();

  if (enumValues.includes(trimmed)) {
    return { value: trimmed };
  }

  return {
    value: null,
    error: {
      code: ParseErrorCode.TYPE_CAST_FAILED,
      message: `Cannot cast "${raw}" to enum(${enumValues.join(',')})`,
    },
  };
}

/** text：还原转义后原样保留 */
export function convertText(raw: string): ConversionResult {
  // 保持原样，不 trim 内部空格
  return { value: raw };
}

/** tags：正则 #tag 提取，去重 */
export function convertTags(raw: string): ConversionResult {
  const tagRegex = /#([\p{L}\p{N}_一-鿿_-]+)/gu;
  const tags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(raw)) !== null) {
    const tag = match[1];
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return { value: JSON.stringify(tags) };
}

/** ref(table)：原样保留 + 标记 */
export function convertRef(raw: string): ConversionResult {
  return { value: raw.trim() };
}

/** phone：提取数字标准化 */
export function convertPhone(raw: string): ConversionResult {
  const trimmed = raw.trim();

  // 提取数字部分
  const digits = trimmed.replace(/\D/g, '');

  // 至少 7 位数字才认为是有效号码
  if (digits.length >= 7) {
    return { value: digits };
  }

  return {
    value: null,
    error: {
      code: ParseErrorCode.TYPE_CAST_FAILED,
      message: `Cannot cast "${raw}" to phone — insufficient digits`,
    },
  };
}

/** email：trim + 小写 + 正则 */
export function convertEmail(raw: string): ConversionResult {
  const trimmed = raw.trim().toLowerCase();

  // 基本 email 正则
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(trimmed)) {
    return { value: trimmed };
  }

  return {
    value: null,
    error: {
      code: ParseErrorCode.TYPE_CAST_FAILED,
      message: `Cannot cast "${raw}" to email`,
    },
  };
}

// ============================================================
// 统一转换入口
// ============================================================

/**
 * 根据 FieldType 将字符串值转换为对应类型
 *
 * @param raw        原始字符串
 * @param typeExpr   FieldType 表达式（如 "decimal(2)"）
 * @returns 转换结果，失败时 value = null
 */
export function convertValue(raw: string, typeExpr: string): ConversionResult {
  const { typeName, params } = parseTypeExpr(typeExpr);

  switch (typeName) {
    case 'string':
      return convertString(raw);
    case 'text':
      return convertText(raw);
    case 'integer':
      return convertInteger(raw);
    case 'decimal': {
      const precision = params.length > 0 ? parseInt(params[0]!, 10) : 2;
      return convertDecimal(raw, precision);
    }
    case 'boolean':
      return convertBoolean(raw);
    case 'date':
      return convertDate(raw);
    case 'datetime':
      return convertDatetime(raw);
    case 'enum':
      return convertEnum(raw, params);
    case 'tags':
      return convertTags(raw);
    case 'ref':
      return convertRef(raw);
    case 'phone':
      return convertPhone(raw);
    case 'email':
      return convertEmail(raw);
    default:
      return {
        value: null,
        error: {
          code: ParseErrorCode.TYPE_CAST_FAILED,
          message: `Unknown type: "${typeExpr}"`,
        },
      };
  }
}

/** 批量转换一行字段 */
export function convertRowFields(
  rawFields: string[],
  typeExprs: string[],
  nullMarker: string,
): { values: unknown[]; errors: ParseError[] } {
  const values: unknown[] = [];
  const errors: ParseError[] = [];

  for (let i = 0; i < rawFields.length; i++) {
    const raw = rawFields[i] ?? '';
    const typeExpr = typeExprs[i] ?? 'string';

    // 空值检测
    if (raw.trim() === '' || raw.trim() === nullMarker) {
      values.push(null);
      continue;
    }

    const result = convertValue(raw, typeExpr);
    values.push(result.value);
    if (result.error) {
      errors.push({
        ...result.error,
        field: typeExpr,
        rawValue: raw,
      });
    }
  }

  return { values, errors };
}

/** 将 SQLite 内部值转换为显示格式（用于 ResultSet） */
export function formatDisplayValue(
  value: unknown,
  typeExpr: string,
): string {
  const { typeName, params } = parseTypeExpr(typeExpr);

  if (value === null || value === undefined) return '-';

  switch (typeName) {
    case 'decimal': {
      const precision = params.length > 0 ? parseInt(params[0]!, 10) : 2;
      const num = Number(value);
      return (num / Math.pow(10, precision)).toFixed(precision);
    }
    case 'boolean':
      return value === 1 ? 'true' : 'false';
    case 'tags':
      try {
        const tags = JSON.parse(value as string);
        return (tags as string[]).map((t: string) => `#${t}`).join(' ');
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}
