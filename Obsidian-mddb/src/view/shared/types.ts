/**
 * 视图层共享类型
 *
 * 参考：v2 roadmap Milestone 4
 */

// ============================================================
// 视图状态
// ============================================================

export type ViewStatus = 'loading' | 'ready' | 'error' | 'empty';

export interface ViewState {
  status: ViewStatus;
  message?: string;
  error?: string;
  lastUpdated: string | null;
}

// ============================================================
// 表格视图状态
// ============================================================

export interface TableViewState extends ViewState {
  columns: ViewColumn[];
  rows: ViewRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sortField?: string;
  sortDirection?: 'ASC' | 'DESC';
}

export interface ViewColumn {
  name: string;
  type: string;
  label?: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
}

export interface ViewRow {
  cells: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

// ============================================================
// 编辑状态
// ============================================================

export interface EditingCell {
  rowIndex: number;
  col: string;
  originalValue: unknown;
}

// ============================================================
// 视图事件
// ============================================================

export type ViewEventType =
  | 'state-changed'
  | 'data-changed'
  | 'sort-changed'
  | 'page-changed'
  | 'error'
  | 'refresh'
  // ★ 编辑相关
  | 'edit-start'
  | 'edit-commit'
  | 'edit-cancel'
  // ★ 列可见性
  | 'column-visibility-changed'
  // ★ CRUD
  | 'row-deleted'
  | 'row-inserted'
  // ★ 操作菜单
  | 'action-menu-opened'
  | 'action-menu-closed';

export interface ViewEvent {
  type: ViewEventType;
  viewId: string;
  data?: unknown;
}
