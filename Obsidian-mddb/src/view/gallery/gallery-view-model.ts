/**
 * 画廊视图模型
 *
 * 管理画廊数据的查询、图片解析、CRUD、跨视图同步。
 *
 * 镜像 kanban-view-model.ts；新增封面图解析。
 */

import type { App } from 'obsidian';
import type { Query, ResultSet } from '../../query/types';
import type { GalleryConfig } from './gallery-config';
import type { MDDBEngine } from '../../engine/engine';
import type { Disposable } from '../../core/types';
import { BaseViewModel } from '../base-view-model';
import { ViewConfigBuilder } from '../parser';

// ============================================================
// 画廊运行时数据类型
// ============================================================

export interface GalleryCard {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
  imageUrl: string | null;
}

export interface GalleryData {
  cards: GalleryCard[];
  total: number;
}

// ============================================================
// ViewModel
// ============================================================

export class GalleryViewModel extends BaseViewModel {
  private _data: GalleryData;
  /** 引擎 data-changed 订阅（跨视图 / 外部回灌同步） */
  private _engineSub?: Disposable;
  /** 引擎事件去抖刷新定时器（rescan 会按文件多次 emit） */
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    viewId: string,
    private engine: MDDBEngine,
    private _config: GalleryConfig,
    private app: App,
  ) {
    super(viewId);
    this._data = { cards: [], total: 0 };

    // 订阅引擎数据变更：表单/其他视图写入、外部手改回灌都会 emit，
    // 去抖后刷新，避免与同表其他视图脱钩
    this._engineSub = this.engine.on('data-changed', () => this.scheduleRefresh());
  }

  get config(): GalleryConfig {
    return { ...this._config };
  }

  get data(): GalleryData {
    return this._data;
  }

  /** 当前错误信息（query 失败时供 UI 显示真实原因） */
  get error(): string | undefined {
    return this.state.error;
  }

  /** 暴露引擎给 UI 层（EditModal / FormBuilder 使用） */
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
      this.setState({
        status: this._data.cards.length === 0 ? 'empty' : 'ready',
        lastUpdated: new Date().toISOString(),
      });
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
  // CRUD
  // ============================================================

  async addCard(values: Record<string, unknown>): Promise<boolean> {
    try {
      await this.engine.insert(this._config.table, values);
      this.events.emit({ type: 'data-changed', viewId: this.viewId, data: { action: 'addCard' } });
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

  /** 编辑提交（FormBuilder） */
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
    if (this._config.imageField && !allColumns.includes(this._config.imageField)) {
      allColumns.push(this._config.imageField);
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
    const titleField = this._config.columns[0] ?? 'storage_pk';

    const cards: GalleryCard[] = result.rows.map(row => {
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
        imageUrl: this._config.imageField
          ? resolveImage(this.app, row[this._config.imageField])
          : null,
      };
    });

    this._data = { cards, total: result.total };
  }
}

// ============================================================
// 图片解析
// ============================================================

/**
 * 将 frontmatter 图片字段值解析为可显示 URL。
 * 支持四种写法：![[x]] / [[x]] / ![](x) / 纯路径。
 */
function resolveImage(app: App, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const wiki = raw.match(/^!?\[\[([^\]]+)\]\]$/);   // ![[x]] / [[x]]
  const md = raw.match(/^!\[[^\]]*\]\(([^)]+)\)$/);  // ![](x)
  const path = wiki?.[1] ?? md?.[1] ?? raw;           // 纯路径

  const file = app.metadataCache.getFirstLinkpathDest(path, '');
  return file ? app.vault.getResourcePath(file) : null;
}
