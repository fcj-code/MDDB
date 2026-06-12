/**
 * 表格视图配置
 *
 * 定义表格视图的外观和行为。
 *
 * 参考：v2 roadmap Milestone 4
 */

import type { ViewColumn } from '../shared/types';

export interface TableConfig {
  /** 列配置 */
  columns: ViewColumn[];
  /** 每页行数 */
  pageSize: number;
  /** 是否显示行号 */
  showRowNumbers: boolean;
  /** 是否允许列宽拖动 */
  resizableColumns: boolean;
  /** 空值显示的文本 */
  nullDisplay: string;
  /** 表格标题 */
  title?: string;
  /** 是否只读 */
  readonly: boolean;
}

export const DEFAULT_TABLE_CONFIG: TableConfig = {
  columns: [],
  pageSize: 50,
  showRowNumbers: true,
  resizableColumns: false,
  nullDisplay: '-',
  readonly: true,
};

/**
 * 从 ViewColumn 数组生成默认列宽
 */
export function columnsToConfig(columns: ViewColumn[]): TableConfig {
  return {
    ...DEFAULT_TABLE_CONFIG,
    columns: columns.map(col => ({
      ...col,
      label: col.label ?? col.name,
      align: col.align ?? guessColumnAlign(col.type),
    })),
  };
}

/**
 * 根据字段类型猜测对齐方式
 */
function guessColumnAlign(type: string): 'left' | 'center' | 'right' {
  const numericTypes = ['integer', 'decimal', 'number', 'float', 'BIGINT'];
  if (numericTypes.some(t => type.includes(t))) return 'right';
  if (type === 'boolean') return 'center';
  return 'left';
}
