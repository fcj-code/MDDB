/**
 * 画廊视图配置
 *
 * 参考：data-cards 的卡片布局 + kanban-config 结构
 */

export interface GalleryConfig {
  /** 数据表名 */
  table: string;
  /** 显示的字段（第一个 = 卡片标题，其余 = 元数据行） */
  columns: string[];
  /** 封面图字段（值可为 ![[x]] / [[x]] / ![](x) / 纯路径） */
  imageField?: string;
  /** 固定列数；省略 = 响应式 auto-fill */
  gridColumns?: number;
  /** 过滤条件 */
  filter?: string;
  /** 排序 */
  sort?: { field: string; direction: 'ASC' | 'DESC' }[];
  /** 最大卡片数 */
  limit?: number;
}
