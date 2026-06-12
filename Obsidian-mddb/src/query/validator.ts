/**
 * 查询验证器 (QueryValidator)
 *
 * 7 条验证规则，宽松模式。
 *
 * 参考：query-engine-design.md §11
 */

import type { Query, FilterGroup, FilterCondition, SimpleFilter, QueryValidationResult } from './types';

const VALID_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'like', 'notLike', 'in', 'notIn',
  'isNull', 'isNotNull',
]);

export function validateQuery(query: Query, validFields?: string[]): QueryValidationResult {
  const errors: string[] = [];

  // 1. table 必需
  if (!query.table || query.table.trim().length === 0) {
    errors.push('query.table is required');
  }

  // 2. select columns 如果存在，必须在 validFields 中
  if (query.select?.columns && query.select.columns.length > 0 && validFields) {
    for (const col of query.select.columns) {
      if (!validFields.includes(col)) {
        errors.push(`Unknown column in select: "${col}"`);
      }
    }
  }

  // 3. sort field 如果在 validFields 中（支持单字段或多字段）
  if (query.sort && validFields) {
    const sorts = Array.isArray(query.sort) ? query.sort : [query.sort];
    for (const s of sorts) {
      if (!validFields.includes(s.field)) {
        errors.push(`Unknown column in sort: "${s.field}"`);
      }
    }
  }

  // 4. groupBy 字段检验
  if (query.groupBy && validFields) {
    for (const field of query.groupBy) {
      if (!validFields.includes(field)) {
        errors.push(`Unknown column in groupBy: "${field}"`);
      }
    }
  }

  // 5. aggregate fields 检验
  if (query.aggregates) {
    for (const op of query.aggregates.operations) {
      if (op.field && validFields && !validFields.includes(op.field)) {
        errors.push(`Unknown column in aggregate: "${op.field}"`);
      }
    }
  }

  // 6. 递归验证 FilterGroup
  if (query.where) {
    validateFilterGroup(query.where, validFields, errors);
  }

  if (query.having) {
    validateFilterGroup(query.having, validFields, errors);
  }

  // 7. 分页合理性
  if (query.limit !== undefined && query.limit < 0) {
    errors.push('limit must be non-negative');
  }
  if (query.offset !== undefined && query.offset < 0) {
    errors.push('offset must be non-negative');
  }

  // 宽松模式：只报告问题，不阻止执行
  return { valid: errors.length === 0, errors };
}

function validateFilterGroup(
  group: FilterGroup,
  validFields: string[] | undefined,
  errors: string[],
): void {
  if (!group.operator || !['AND', 'OR'].includes(group.operator)) {
    errors.push('FilterGroup.operator must be "AND" or "OR"');
  }

  if (!group.conditions || group.conditions.length === 0) {
    errors.push('FilterGroup.conditions must have at least one condition');
    return;
  }

  for (const cond of group.conditions) {
    if ('operator' in cond && 'conditions' in cond) {
      // Nested FilterGroup
      validateFilterGroup(cond as FilterGroup, validFields, errors);
    } else {
      // SimpleFilter
      validateSimpleFilter(cond as SimpleFilter, validFields, errors);
    }
  }
}

function validateSimpleFilter(
  filter: SimpleFilter,
  validFields: string[] | undefined,
  errors: string[],
): void {
  if (validFields && !validFields.includes(filter.field)) {
    errors.push(`Unknown column in filter: "${filter.field}"`);
  }

  if (!VALID_OPS.has(filter.op)) {
    errors.push(`Unknown filter operator: "${filter.op}"`);
  }

  // in / notIn 需要 value 是数组
  if ((filter.op === 'in' || filter.op === 'notIn') && !Array.isArray(filter.value)) {
    errors.push(`Filter operator "${filter.op}" requires an array value`);
  }

  // isNull / isNotNull 不需要 value
  if ((filter.op === 'isNull' || filter.op === 'isNotNull') && filter.value !== undefined) {
    errors.push(`Filter operator "${filter.op}" does not accept a value`);
  }
}
