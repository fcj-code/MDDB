/**
 * 数据层 — Engine 与视图层的反应式桥接
 *
 * 负责：
 * - 向 Engine 发起查询
 * - 缓存查询结果
 * - 监听 Engine data-changed 事件并自动刷新
 * - 分页、排序、过滤状态管理
 *
 * 参考：v2 roadmap Milestone 4
 */

import type { MDDBEngine } from '../../engine/engine';
import type { Query, ResultSet, SortClause, ViewConfig } from '../../query/types';
import type { Disposable } from '../../core/types';
import { ViewConfigBuilder } from '../parser';

// ============================================================
// 刷新策略
// ============================================================

export type RefreshStrategy = 'auto' | 'manual' | 'debounce';

export interface DataLayerConfig {
  refreshStrategy: RefreshStrategy;
  debounceMs: number;
  defaultPageSize: number;
}

const DEFAULT_CONFIG: DataLayerConfig = {
  refreshStrategy: 'auto',
  debounceMs: 300,
  defaultPageSize: 50,
};

// ============================================================
// 数据层状态
// ============================================================

export interface DataLayerState {
  loading: boolean;
  result: ResultSet | null;
  error: string | null;
  page: number;
  pageSize: number;
  sortFields: SortClause[];
  lastUpdated: number | null;
}

// ============================================================
// 数据层
// ============================================================

export class DataLayer {
  private engine: MDDBEngine;
  private config: DataLayerConfig;
  private state: DataLayerState;
  private disposables: Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private currentQuery: Query | null = null;

  /** 状态变更回调 */
  onStateChange?: (state: DataLayerState) => void;

  constructor(engine: MDDBEngine, config?: Partial<DataLayerConfig>) {
    this.engine = engine;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createInitialState();

    // 监听 Engine 事件
    const disposable = engine.on('data-changed', () => {
      if (this.config.refreshStrategy === 'auto') {
        this.scheduleRefresh();
      }
    });
    this.disposables.push(disposable);
  }

  /** 当前状态快照 */
  getState(): DataLayerState {
    return { ...this.state };
  }

  /** 是否正在加载 */
  get loading(): boolean {
    return this.state.loading;
  }

  /** 当前查询 */
  get query(): Query | null {
    return this.currentQuery;
  }

  // ============================================================
  // 查询
  // ============================================================

  /**
   * 执行查询
   */
  async executeQuery(query: Query): Promise<ResultSet | null> {
    this.currentQuery = query;
    this.state.loading = true;
    this.state.error = null;
    this.emitState();

    try {
      const result = this.engine.query(query);

      if (result.ok) {
        this.state.result = result.value;
        this.state.lastUpdated = Date.now();
        this.state.loading = false;
        this.emitState();
        return result.value;
      } else {
        this.state.error = result.error?.message ?? 'Query failed';
        this.state.loading = false;
        this.emitState();
        return null;
      }
    } catch (e) {
      this.state.error = e instanceof Error ? e.message : String(e);
      this.state.loading = false;
      this.emitState();
      return null;
    }
  }

  /**
   * 通过 ViewConfig 执行查询
   */
  async queryView(config: ViewConfig): Promise<ResultSet | null> {
    const query = ViewConfigBuilder.toQuery(config);
    return this.executeQuery(query);
  }

  /**
   * 刷新（用当前查询重新查询）
   */
  async refresh(): Promise<ResultSet | null> {
    if (!this.currentQuery) return null;
    return this.executeQuery(this.currentQuery);
  }

  // ============================================================
  // 分页
  // ============================================================

  /**
   * 跳转到指定页
   */
  async goToPage(page: number): Promise<ResultSet | null> {
    if (!this.currentQuery) return null;
    const pageSize = this.state.pageSize;
    const offset = (page - 1) * pageSize;
    this.state.page = page;

    const updatedQuery: Query = {
      ...this.currentQuery,
      offset: Math.max(0, offset),
      limit: pageSize,
    };

    return this.executeQuery(updatedQuery);
  }

  /**
   * 下一页
   */
  async nextPage(): Promise<ResultSet | null> {
    if (this.state.result?.queryInfo?.hasMore) {
      return this.goToPage(this.state.page + 1);
    }
    return null;
  }

  /**
   * 上一页
   */
  async prevPage(): Promise<ResultSet | null> {
    if (this.state.page > 1) {
      return this.goToPage(this.state.page - 1);
    }
    return null;
  }

  // ============================================================
  // 排序
  // ============================================================

  /**
   * 切换排序
   */
  async toggleSort(field: string): Promise<ResultSet | null> {
    if (!this.currentQuery) return null;

    const existing = this.state.sortFields.find(s => s.field === field);
    let newSorts: SortClause[];

    if (existing) {
      // 切换方向或移除
      if (existing.direction === 'ASC') {
        newSorts = [{ field, direction: 'DESC' }];
      } else {
        newSorts = [];
      }
    } else {
      newSorts = [{ field, direction: 'ASC' }];
    }

    this.state.sortFields = newSorts;

    const updatedQuery: Query = {
      ...this.currentQuery,
      sort: newSorts.length > 0 ? newSorts : undefined,
      offset: 0, // 重置到第一页
    };

    return this.executeQuery(updatedQuery);
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 销毁数据层，清理资源
   */
  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.currentQuery = null;
    this.state = this.createInitialState();
  }

  // ============================================================
  // 内部
  // ============================================================

  private createInitialState(): DataLayerState {
    return {
      loading: false,
      result: null,
      error: null,
      page: 1,
      pageSize: this.config.defaultPageSize,
      sortFields: [],
      lastUpdated: null,
    };
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refresh();
      this.refreshTimer = null;
    }, this.config.debounceMs);
  }

  private emitState(): void {
    if (this.onStateChange) {
      this.onStateChange(this.state);
    }
  }
}
