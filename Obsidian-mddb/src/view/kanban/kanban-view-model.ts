/**
 * 看板视图模型
 *
 * 管理看板数据的分组、拖拽更新、CRUD、搜索。
 *
 * 参考：kanban-view-design.md §4
 */

import type { Query, ResultSet } from '../../query/types';
import type { KanbanConfig } from './kanban-config';
import type { MDDBEngine } from '../../engine/engine';
import type { Disposable } from '../../core/types';
import { BaseViewModel } from '../base-view-model';
import { ViewConfigBuilder } from '../parser';

// ============================================================
// 看板运行时数据类型
// ============================================================

export interface KanbanBoard {
  lanes: Lane[];
  groupField: string;
  totalCards: number;
}

export interface Lane {
  id: string;
  title: string;
  groupValue: unknown;
  cards: Card[];
  cardCount: number;
  collapsed: boolean;
  maxItems?: number;
  isLoading: boolean;
}

export interface Card {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
  checked?: boolean;
  isEditing?: boolean;
}

// ============================================================
// ViewModel
// ============================================================

export class KanbanViewModel extends BaseViewModel {
  private _board: KanbanBoard;
  private _searchQuery = '';
  /** 用户拖拽后自定义的列顺序（laneId[]），refresh 时保持此顺序 */
  private _laneOrder: string[] = [];
  /** 引擎 data-changed 订阅（跨视图 / 外部回灌同步） */
  private _engineSub?: Disposable;
  /** 引擎事件去抖刷新定时器（rescan 会按文件多次 emit） */
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    viewId: string,
    private engine: MDDBEngine,
    private _config: KanbanConfig,
  ) {
    super(viewId);
    this._board = {
      lanes: [],
      groupField: _config.groupBy,
      totalCards: 0,
    };

    // 订阅引擎数据变更：表单/其他表格/看板写入、外部手改回灌都会 emit，
    // 去抖后刷新，避免与同表其他视图脱钩
    this._engineSub = this.engine.on('data-changed', () => this.scheduleRefresh());
  }

  get config(): KanbanConfig {
    return { ...this._config };
  }

  get board(): KanbanBoard {
    return this._board;
  }

  get searchQuery(): string {
    return this._searchQuery;
  }

  /** 暴露引擎给 UI 层（FormBuilder / modal 使用） */
  getEngine(): MDDBEngine {
    return this.engine;
  }

  // ============================================================
  // 生命周期
  // ============================================================

  async initialize(): Promise<void> {
    this.setState({ status: 'loading' });
    try {
      const result = this.engine.query(this.buildQuery());
      if (!result.ok) {
        this.setState({ status: 'error', error: result.error.message });
        return;
      }
      this.updateFromResult(result.value);
      this.setState({ status: 'ready' });
    } catch (e) {
      this.setState({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async refresh(): Promise<void> {
    await this.initialize();
  }

  /** 引擎事件驱动的去抖刷新（自身 CRUD 仍走显式 refresh，立即生效） */
  private scheduleRefresh(): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      void this.refresh();
    }, 200);
  }

  destroy(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    this._engineSub?.dispose();
    this._engineSub = undefined;
    super.destroy();
  }

  // ============================================================
  // 拖拽更新
  // ============================================================

  async moveCard(
    cardId: string,
    _fromLane: string,
    toLane: string,
    _toIndex: number,
  ): Promise<boolean> {
    try {
      const targetLane = this._board.lanes.find(l => l.id === toLane);
      if (!targetLane) return false;

      await this.engine.update(
        cardId,
        { [this._config.groupBy]: targetLane.groupValue },
        { force: true },
      );
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // CRUD
  // ============================================================

  async addCard(laneId: string, values: Record<string, unknown>): Promise<boolean> {
    try {
      const lane = this._board.lanes.find(l => l.id === laneId);
      if (!lane) return false;

      const record = { ...values, [this._config.groupBy]: lane.groupValue };
      await this.engine.insert(this._config.table, record);
      this.events.emit({ type: 'data-changed', viewId: this.viewId, data: { action: 'addCard', laneId } });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  async deleteCard(cardId: string): Promise<boolean> {
    try {
      await this.engine.delete(cardId, { force: true });
      this.events.emit({ type: 'data-changed', viewId: this.viewId, data: { action: 'deleteCard', cardId } });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  async updateCardField(
    cardId: string,
    field: string,
    value: unknown,
  ): Promise<boolean> {
    try {
      await this.engine.update(cardId, { [field]: value }, { force: true });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  /** 批量更新卡片字段（FormBuilder 提交用） */
  async updateRecord(storagePk: string, values: Record<string, unknown>): Promise<boolean> {
    try {
      await this.engine.update(storagePk, values, { force: true });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // 交互
  // ============================================================

  toggleLaneCollapse(laneId: string): void {
    const lane = this._board.lanes.find(l => l.id === laneId);
    if (lane) {
      lane.collapsed = !lane.collapsed;
      this.events.emit({ type: 'state-changed', viewId: this.viewId, data: { collapsed: lane.collapsed } });
    }
  }

  setSearchQuery(query: string): void {
    this._searchQuery = query;
    this.events.emit({ type: 'state-changed', viewId: this.viewId, data: { search: query } });
  }

  /** 拖拽列重新排序 */
  moveLane(laneId: string, targetLaneId: string): void {
    const idx = this._board.lanes.findIndex(l => l.id === laneId);
    const targetIdx = this._board.lanes.findIndex(l => l.id === targetLaneId);
    if (idx === -1 || targetIdx === -1) return;

    const lane = this._board.lanes.splice(idx, 1)[0]!;
    this._board.lanes.splice(targetIdx, 0, lane);

    // 记录自定义顺序
    this._laneOrder = this._board.lanes.map(l => l.id);
    this.events.emit({ type: 'state-changed', viewId: this.viewId, data: { laneOrder: this._laneOrder } });
  }

  /** 重置列顺序为默认（按分组字段排序） */
  resetLaneOrder(): void {
    this._laneOrder = [];
    this.events.emit({ type: 'state-changed', viewId: this.viewId, data: { laneOrder: null } });
  }

  // ============================================================
  // 内部
  // ============================================================

  private buildQuery(): Query {
    const query: Query = {
      table: this._config.table,
      limit: this._config.limit ?? 200,
    };

    const allColumns = [...this._config.columns];
    if (!allColumns.includes('storage_pk')) {
      allColumns.unshift('storage_pk');
    }
    if (!allColumns.includes(this._config.groupBy)) {
      allColumns.push(this._config.groupBy);
    }

    query.select = { columns: allColumns, distinct: false };

    if (this._config.filter) {
      query.where = ViewConfigBuilder.parseWhere(this._config.filter);
    }

    if (this._config.sort && this._config.sort.length > 0) {
      query.sort = this._config.sort.length === 1
        ? this._config.sort[0]!
        : this._config.sort;
    }

    return query;
  }

  private updateFromResult(result: ResultSet): void {
    const groupField = this._config.groupBy;

    const groups = new Map<string, { title: string; rows: Record<string, unknown>[] }>();

    for (const row of result.rows) {
      const rawValue = row[groupField];
      const key = String(rawValue ?? '(空)');
      if (!groups.has(key)) {
        groups.set(key, { title: key, rows: [] });
      }
      groups.get(key)!.rows.push(row);
    }

    const lanes: Lane[] = [];
    for (const [key, group] of groups) {
      const cards: Card[] = group.rows.map(row => {
        const titleField = this._config.columns[0] ?? groupField;
        const metadata: Record<string, unknown> = {};
        for (const col of this._config.columns) {
          if (col !== titleField && col !== 'storage_pk') {
            metadata[col] = row[col];
          }
        }
        return {
          id: String(row['storage_pk'] ?? ''),
          title: String(row[titleField] ?? ''),
          metadata,
          raw: { ...row },
          checked: false,
        };
      });

      lanes.push({
        id: key,
        title: key,
        groupValue: group.rows[0]?.[groupField],
        cards,
        cardCount: cards.length,
        collapsed: false,
        isLoading: false,
      });
    }

    this._board = {
      lanes,
      groupField,
      totalCards: result.total,
    };

    // 应用用户自定义列顺序
    if (this._laneOrder.length > 0) {
      const ordered = this._laneOrder
        .map(id => this._board.lanes.find(l => l.id === id))
        .filter((l): l is Lane => l !== undefined);
      const remaining = this._board.lanes.filter(l => !this._laneOrder.includes(l.id));
      this._board.lanes = [...ordered, ...remaining];
    }
  }
}
