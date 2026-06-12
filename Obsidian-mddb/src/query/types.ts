/**
 * 查询类型定义
 *
 * 参考：query-engine-design.md
 * Milestone 4 新增：refFollow、增强分页 metadata、排序多字段
 */

import type { ColumnMeta, FieldType } from '../core/types';

// ============================================================
// 查询对象
// ============================================================

export interface Query {
  /** 目标表名 */
  table: string;
  /** 查询列（省略 = ALL） */
  select?: SelectClause;
  /** 过滤条件 */
  where?: FilterGroup;
  /** 排序（支持多字段） */
  sort?: SortClause | SortClause[];
  /** 聚合 */
  aggregates?: AggregateClause;
  groupBy?: string[];
  having?: FilterGroup;
  /** 分页 */
  limit?: number;
  offset?: number;
  /**
   * 引用跟随
   *
   * 对 ref(targetTable) 类型的字段，自动联表查询目标记录的指定字段。
   * 例如：{ field: "category", follow: { select: ["name", "type"] } }
   */
  followRefs?: RefFollow[];
}

export interface SelectClause {
  columns: string[];
  distinct?: boolean;
}

export interface SortClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

export interface AggregateClause {
  /** 聚合操作列表 */
  operations: AggregateOp[];
}

export type AggregateOp =
  | { type: 'COUNT'; field?: string; alias?: string }
  | { type: 'SUM'; field: string; alias?: string }
  | { type: 'AVG'; field: string; alias?: string }
  | { type: 'MIN'; field: string; alias?: string }
  | { type: 'MAX'; field: string; alias?: string };

// ============================================================
// 引用跟随
// ============================================================

export interface RefFollow {
  /** 当前表的 ref 字段名 */
  field: string;
  /** 从目标表选择的字段 */
  select: string[];
  /** 别名前缀（默认 = field + "."） */
  alias?: string;
}

// ============================================================
// 过滤模型
// ============================================================

export interface FilterGroup {
  operator: 'AND' | 'OR';
  conditions: FilterCondition[];
}

export type FilterCondition =
  | FilterGroup                     // 嵌套组
  | SimpleFilter;                   // 简单过滤

export interface SimpleFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
}

export type FilterOp =
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'notLike'
  | 'in' | 'notIn'
  | 'isNull' | 'isNotNull';

// ============================================================
// 结果集
// ============================================================

export interface ResultSet {
  rows: Record<string, unknown>[];
  columns: ColumnMeta[];
  /** 总行数（未分页前） */
  total: number;
  /** 当前页码（1-based） */
  page?: number;
  /** 每页行数 */
  pageSize?: number;
  /** 总页数（当 pageSize 有值时计算） */
  totalPages?: number;
  /** 实际返回行数 */
  returned: number;
  /** 查询执行信息 */
  queryInfo?: {
    table: string;
    hasMore: boolean;
    durationMs?: number;
  };
}

// ============================================================
// 验证
// ============================================================

export interface QueryValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================
// 视图层查询（简化，由 mddb-table parser 生成）
// ============================================================

export interface ViewQuery {
  table: string;
  show?: string[];
  where?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

/** 视图层配置 */
export interface ViewConfig {
  /** 表名 */
  table: string;
  /** 显示的列 */
  columns: string[];
  /** 过滤表达式 */
  filter?: string;
  /** 排序 */
  sort?: { field: string; direction: 'ASC' | 'DESC' }[];
  /** 每页行数 */
  pageSize?: number;
  /** 是否只读 */
  readonly?: boolean;
}
