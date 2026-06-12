/**
 * 表格视图模型
 *
 * 管理表格视图的数据状态、排序、分页。
 *
 * 参考：v2 roadmap Milestone 4
 */

import type { Query, ViewConfig, ResultSet, SortClause } from '../../query/types';
import type { ViewColumn, ViewRow, TableViewState, ViewStatus } from '../shared/types';
import { BaseViewModel } from '../base-view-model';
import { DataLayer } from '../shared/data-layer';
import { ViewConfigBuilder } from '../parser';
import type { MDDBEngine } from '../../engine/engine';
import { columnsToConfig, type TableConfig } from './table-config';

export class TableViewModel extends BaseViewModel {
  private dataLayer: DataLayer;
  private _config: TableConfig;
  private viewConfig: ViewConfig;
  private tableState: TableViewState;

  constructor(
    viewId: string,
    private engine: MDDBEngine,
    config: ViewConfig,
  ) {
    super(viewId);
    this.viewConfig = config;
    this._config = columnsToConfig(
      config.columns.map(c => ({ name: c, type: 'string' }))
    );
    this._config.pageSize = config.pageSize ?? 50;
    this._config.readonly = config.readonly ?? true;
    if (config.table) {
      this._config.title = `Table: ${config.table}`;
    }

    this.dataLayer = new DataLayer(engine);
    this.tableState = this.createInitialTableState();

    // 监听数据层变更
    this.dataLayer.onStateChange = (state) => {
      if (state.result) {
        this.updateFromResult(state.result);
      }
      if (state.error) {
        this.setState({ status: 'error', error: state.error });
      }
      if (state.loading) {
        this.setState({ status: 'loading' });
      }
    };
  }

  /** 表格配置 */
  get config(): TableConfig {
    return { ...this._config };
  }

  /** 表格状态 */
  get tableStateValue(): TableViewState {
    return { ...this.tableState };
  }

  /** 当前页数据 */
  get currentPageRows(): ViewRow[] {
    return this.tableState.rows;
  }

  /** 总行数 */
  get totalRows(): number {
    return this.tableState.totalRows;
  }

  /** 当前页码 */
  get currentPage(): number {
    return this.tableState.page;
  }

  /** 总页数 */
  get totalPages(): number {
    return this.tableState.totalPages;
  }

  // ============================================================
  // 生命周期
  // ============================================================

  async initialize(): Promise<void> {
    this.setState({ status: 'loading' });
    try {
      const result = await this.dataLayer.queryView(this.viewConfig);
      if (result) {
        this.updateFromResult(result);
        this.setState({ status: 'ready' });
      } else {
        this.setState({ status: 'error', error: this.dataLayer.getState().error ?? 'Query returned no data' });
      }
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

  destroy(): void {
    this.dataLayer.destroy();
    super.destroy();
  }

  // ============================================================
  // 分页
  // ============================================================

  async nextPage(): Promise<void> {
    this.setState({ status: 'loading' });
    const result = await this.dataLayer.nextPage();
    if (result) {
      this.updateFromResult(result);
      this.setState({ status: 'ready' });
    }
  }

  async prevPage(): Promise<void> {
    this.setState({ status: 'loading' });
    const result = await this.dataLayer.prevPage();
    if (result) {
      this.updateFromResult(result);
      this.setState({ status: 'ready' });
    }
  }

  async goToPage(page: number): Promise<void> {
    this.setState({ status: 'loading' });
    const result = await this.dataLayer.goToPage(page);
    if (result) {
      this.updateFromResult(result);
      this.setState({ status: 'ready' });
    }
  }

  // ============================================================
  // 排序
  // ============================================================

  async toggleSort(field: string): Promise<void> {
    this.setState({ status: 'loading' });
    const result = await this.dataLayer.toggleSort(field);
    if (result) {
      this.updateFromResult(result);
      this.setState({ status: 'ready' });
    }
  }

  // ============================================================
  // 内部
  // ============================================================

  private createInitialTableState(): TableViewState {
    return {
      status: 'loading',
      columns: this._config.columns,
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: this._config.pageSize,
      totalPages: 0,
      lastUpdated: null,
    };
  }

  private updateFromResult(result: ResultSet): void {
    const columns: ViewColumn[] = result.columns.map(col => ({
      name: col.name,
      type: col.type,
      label: col.name,
    }));

    const rows: ViewRow[] = result.rows.map(row => ({
      cells: { ...row },
      raw: { ...row },
    }));

    this.tableState = {
      status: 'ready',
      columns,
      rows,
      totalRows: result.total,
      page: result.page ?? 1,
      pageSize: result.pageSize ?? this._config.pageSize,
      totalPages: result.totalPages ?? 1,
      sortField: this.dataLayer.getState().sortFields[0]?.field,
      sortDirection: this.dataLayer.getState().sortFields[0]?.direction,
      lastUpdated: new Date().toISOString(),
    };

    // 更新列配置
    if (columns.length > 0) {
      this._config = columnsToConfig(columns);
      this._config.pageSize = this.tableState.pageSize;
    }
  }
}
