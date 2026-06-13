/**
 * 看板视图配置
 *
 * 参考：kanban-view-design.md §2.2
 */

export interface KanbanConfig {
  /** 数据表名 */
  table: string;
  /** 显示的字段（第一个 = 卡片标题，其余 = 元数据） */
  columns: string[];
  /** 分组字段 */
  groupBy: string;
  /** 过滤条件 */
  filter?: string;
  /** 排序 */
  sort?: { field: string; direction: 'ASC' | 'DESC' }[];
  /** 每列最大卡片数 */
  limit?: number;
}
