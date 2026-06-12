/**
 * SQL 生成器 (SQLGenerator)
 *
 * 将结构化 Query 对象翻译为 SQL 字符串 + 参数绑定。
 *
 * Milestone 4 新增：
 * - 多字段排序 (SortClause[])
 * - 增强 LIMIT 默认值
 * - ref follow 辅助方法
 *
 * 参考：query-engine-design.md §8-12, sql-safety-rules.md §3-4
 */

import type { Query, FilterGroup, FilterCondition, SimpleFilter, SortClause } from './types';
import { safeIdent, type IdentifierMode } from '../schema/validators';
import { QueryError } from '../core/errors';

export interface GeneratedSQL {
  sql: string;
  params: unknown[];
}

export class SQLGenerator {
  /** 默认查询 LIMIT */
  static readonly DEFAULT_LIMIT = 200;
  /** 最大查询 LIMIT（可通过构造函数覆盖） */
  readonly maxLimit: number;

  constructor(private identMode: IdentifierMode = 'ascii', maxLimit?: number) {
    this.maxLimit = maxLimit ?? SQLGenerator.MAX_LIMIT;
  }

  /** 兼容旧引用的静态常量 */
  static readonly MAX_LIMIT = 5000;

  /** 将 Query 翻译为 SELECT SQL */
  generateQuery(query: Query, validFields?: string[]): GeneratedSQL {
    const params: unknown[] = [];
    const tableName = safeIdent(query.table, this.identMode);

    // SELECT — 支持 SelectColumn: string | { expr: FieldExpression; alias?: string }
    let selectClause: string;
    if (query.select?.columns && query.select.columns.length > 0) {
      const cols = query.select.columns.map(c => {
        const fieldName = typeof c === 'string' ? c : c.expr.field;
        return safeIdent(fieldName, this.identMode);
      }).join(', ');
      selectClause = query.select.distinct ? `SELECT DISTINCT ${cols}` : `SELECT ${cols}`;
    } else if (query.aggregates?.operations && query.aggregates.operations.length > 0) {
      const aggParts = query.aggregates.operations.map(op => {
        const alias = op.alias ? ` AS ${safeIdent(op.alias, this.identMode)}` : '';
        switch (op.type) {
          case 'COUNT':
            return `${op.field ? `COUNT(${safeIdent(op.field, this.identMode)})` : 'COUNT(*)'}${alias}`;
          case 'SUM':
            return `SUM(${safeIdent(op.field!, this.identMode)})${alias}`;
          case 'AVG':
            return `AVG(${safeIdent(op.field!, this.identMode)})${alias}`;
          case 'MIN':
            return `MIN(${safeIdent(op.field!, this.identMode)})${alias}`;
          case 'MAX':
            return `MAX(${safeIdent(op.field!, this.identMode)})${alias}`;
          default:
            throw new QueryError(`Unknown aggregate type: ${(op as { type: string }).type}`);
        }
      });
      selectClause = `SELECT ${aggParts.join(', ')}`;
    } else if (query.groupBy && query.groupBy.length > 0) {
      const cols = query.groupBy.map(g => safeIdent(g, this.identMode)).join(', ');
      selectClause = `SELECT ${cols}`;
    } else {
      selectClause = 'SELECT *';
    }

    // FROM
    const fromClause = `FROM ${tableName}`;

    // WHERE
    let whereClause = '';
    if (query.where) {
      const whereResult = this.generateFilterGroup(query.where, params);
      whereClause = `WHERE ${whereResult}`;
    }

    // GROUP BY
    let groupByClause = '';
    if (query.groupBy && query.groupBy.length > 0) {
      const cols = query.groupBy.map(g => safeIdent(g, this.identMode)).join(', ');
      groupByClause = `GROUP BY ${cols}`;
    }

    // HAVING
    let havingClause = '';
    if (query.having) {
      const havingResult = this.generateFilterGroup(query.having, params);
      havingClause = `HAVING ${havingResult}`;
    }

    // ORDER BY（支持单字段或多字段）
    let orderByClause = '';
    const sortClauses = this.normalizeSort(query.sort);
    if (sortClauses.length > 0) {
      const parts = sortClauses.map(s => {
        const field = safeIdent(s.field, this.identMode);
        const dir = s.direction === 'DESC' ? 'DESC' : 'ASC';
        return `${field} ${dir}`;
      });
      orderByClause = `ORDER BY ${parts.join(', ')}`;
    }

    // LIMIT / OFFSET
    let limitClause = '';
    const limit = query.limit ?? SQLGenerator.DEFAULT_LIMIT;
    const safeLimit = Math.min(limit, this.maxLimit);
    limitClause = `LIMIT ?`;
    params.push(safeLimit);
    if (query.offset !== undefined) {
      limitClause += ` OFFSET ?`;
      params.push(query.offset);
    }

    const parts = [
      selectClause, fromClause, whereClause,
      groupByClause, havingClause, orderByClause, limitClause,
    ].filter(p => p.length > 0);

    return { sql: parts.join(' '), params };
  }

  /** 生成 COUNT 查询（忽略 LIMIT/OFFSET） */
  generateCountQuery(query: Query): GeneratedSQL {
    const params: unknown[] = [];
    const tableName = safeIdent(query.table, this.identMode);

    let whereClause = '';
    if (query.where) {
      const whereResult = this.generateFilterGroup(query.where, params);
      whereClause = `WHERE ${whereResult}`;
    }

    return {
      sql: `SELECT COUNT(*) as total FROM ${tableName} ${whereClause}`.trim(),
      params,
    };
  }

  /** 生成 ref follow 查询 */
  generateRefFollowSQL(
    targetTable: string,
    targetField: string,
    refValues: unknown[],
    selectFields: string[],
  ): GeneratedSQL {
    const params: unknown[] = [];
    const tableName = safeIdent(targetTable, this.identMode);
    const fieldName = safeIdent(targetField, this.identMode);
    const selectCols = selectFields.map(f => safeIdent(f, this.identMode)).join(', ');

    const placeholders = refValues.map(() => '?').join(', ');
    params.push(...refValues);

    return {
      sql: `SELECT ${fieldName}, ${selectCols} FROM ${tableName} WHERE ${fieldName} IN (${placeholders})`,
      params,
    };
  }

  /** 将单字段或多字段排序规范化为数组 */
  private normalizeSort(sort: SortClause | SortClause[] | undefined): SortClause[] {
    if (!sort) return [];
    if (Array.isArray(sort)) return sort;
    return [sort];
  }

  /** 递归生成 FilterGroup → WHERE 子句 */
  private generateFilterGroup(group: FilterGroup, params: unknown[]): string {
    const parts = group.conditions.map(cond => {
      if ('operator' in cond && 'conditions' in cond) {
        return `(${this.generateFilterGroup(cond as FilterGroup, params)})`;
      }
      return this.generateSimpleFilter(cond as SimpleFilter, params);
    });

    return parts.join(` ${group.operator} `);
  }

  /** 生成简单过滤条件 */
  private generateSimpleFilter(filter: SimpleFilter, params: unknown[]): string {
    const field = safeIdent(filter.field, this.identMode);

    switch (filter.op) {
      case 'eq':
        params.push(filter.value);
        return `${field} = ?`;
      case 'neq':
        params.push(filter.value);
        return `${field} != ?`;
      case 'gt':
        params.push(filter.value);
        return `${field} > ?`;
      case 'gte':
        params.push(filter.value);
        return `${field} >= ?`;
      case 'lt':
        params.push(filter.value);
        return `${field} < ?`;
      case 'lte':
        params.push(filter.value);
        return `${field} <= ?`;
      case 'like': {
        params.push(filter.value);
        return `${field} LIKE ?`;
      }
      case 'notLike': {
        params.push(filter.value);
        return `${field} NOT LIKE ?`;
      }
      case 'in': {
        const values = filter.value as unknown[];
        const placeholders = values.map(() => '?').join(', ');
        params.push(...values);
        return `${field} IN (${placeholders})`;
      }
      case 'notIn': {
        const values = filter.value as unknown[];
        const placeholders = values.map(() => '?').join(', ');
        params.push(...values);
        return `${field} NOT IN (${placeholders})`;
      }
      case 'isNull':
        return `${field} IS NULL`;
      case 'isNotNull':
        return `${field} IS NOT NULL`;
      default:
        throw new QueryError(`Unknown filter op: ${(filter as { op: string }).op}`);
    }
  }

  /** 生成 raw SQL 的计数（用于安全校验） */
  countSelectStatements(sql: string): number {
    return (sql.match(/\bSELECT\b/gi) || []).length;
  }
}
