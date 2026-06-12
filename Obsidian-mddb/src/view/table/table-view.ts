/**
 * 表格视图 (TableView)
 *
 * Obsidian ItemView 实现，渲染 mddb-table 查询结果。
 *
 * 参考：v2 roadmap Milestone 4
 *
 * 注意：本文件在 Obsidian 环境下运行，需要 Obsidian API 类型。
 * 测试环境中使用 TableViewModel 进行单元测试。
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { TableViewModel } from './table-view-model';
import type { ViewConfig } from '../../query/types';

export const TABLE_VIEW_TYPE = 'mddb-table-view';

export class TableView extends ItemView {
  private viewModel: TableViewModel;

  constructor(
    leaf: WorkspaceLeaf,
    engine: any, // MDDBEngine — 使用 any 避免 Obsidian 类型循环依赖
    config: ViewConfig,
  ) {
    super(leaf);
    this.viewModel = new TableViewModel(
      `table-${Date.now()}`,
      engine,
      config,
    );
    this.containerEl = this.contentEl;
  }

  getViewType(): string {
    return TABLE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.viewModel.config.title ?? 'MD-DB Table';
  }

  getIcon(): string {
    return 'table';
  }

  async onOpen(): Promise<void> {
    this.renderLoading();

    this.viewModel.events.on('state-changed', () => {
      this.render();
    });

    await this.viewModel.initialize();
    this.render();
  }

  async onClose(): Promise<void> {
    this.viewModel.destroy();
  }

  async onResize(): Promise<void> {
    // 响应式调整
  }

  // ============================================================
  // 渲染
  // ============================================================

  private render(): void {
    this.containerEl.empty();

    const state = this.viewModel.tableStateValue;

    switch (state.status) {
      case 'loading':
        this.renderLoading();
        break;
      case 'error':
        this.renderError(state.error ?? 'Unknown error');
        break;
      case 'empty':
        this.renderEmpty();
        break;
      case 'ready':
        this.renderTable();
        break;
    }
  }

  private renderLoading(): void {
    this.containerEl.createEl('div', {
      text: 'Loading...',
      cls: 'mddb-loading',
    });
  }

  private renderError(error: string): void {
    const errorEl = this.containerEl.createEl('div', { cls: 'mddb-error' });
    errorEl.createEl('h3', { text: 'Query Error' });
    errorEl.createEl('pre', { text: error });
  }

  private renderEmpty(): void {
    this.containerEl.createEl('div', {
      text: 'No data',
      cls: 'mddb-empty',
    });
  }

  private renderTable(): void {
    const state = this.viewModel.tableStateValue;

    // 标题
    if (this.viewModel.config.title) {
      this.containerEl.createEl('h3', {
        text: this.viewModel.config.title,
        cls: 'mddb-table-title',
      });
    }

    // 表格信息
    const infoEl = this.containerEl.createEl('div', { cls: 'mddb-table-info' });
    infoEl.createSpan({
      text: `${state.totalRows} rows (page ${state.page}/${state.totalPages})`,
    });

    // 表格
    const tableEl = this.containerEl.createEl('table', { cls: 'mddb-table' });

    // 表头
    const thead = tableEl.createEl('thead');
    const headerRow = thead.createEl('tr');
    if (this.viewModel.config.showRowNumbers) {
      headerRow.createEl('th', { text: '#' });
    }
    for (const col of state.columns) {
      const th = headerRow.createEl('th', { text: col.label ?? col.name });
      th.style.textAlign = col.align ?? 'left';
      th.addEventListener('click', () => {
        this.viewModel.toggleSort(col.name);
      });
      th.style.cursor = 'pointer';
      if (state.sortField === col.name) {
        th.setText(`${col.label ?? col.name} ${state.sortDirection === 'ASC' ? '↑' : '↓'}`);
      }
    }

    // 表体
    const tbody = tableEl.createEl('tbody');
    for (let i = 0; i < state.rows.length; i++) {
      const row = state.rows[i]!;
      const tr = tbody.createEl('tr');

      if (this.viewModel.config.showRowNumbers) {
        tr.createEl('td', {
          text: String((state.page - 1) * state.pageSize + i + 1),
          cls: 'mddb-row-num',
        });
      }

      for (const col of state.columns) {
        const val = row.cells[col.name];
        const td = tr.createEl('td');
        td.style.textAlign = col.align ?? 'left';

        if (val === null || val === undefined) {
          td.setText(this.viewModel.config.nullDisplay);
          td.addClass('mddb-null');
        } else {
          td.setText(String(val));
        }
      }
    }

    // 分页控件
    this.renderPagination(state.page, state.totalPages);
  }

  private renderPagination(currentPage: number, totalPages: number): void {
    const paginationEl = this.containerEl.createEl('div', {
      cls: 'mddb-pagination',
    });

    // 上一页
    const prevBtn = paginationEl.createEl('button', {
      text: '← Prev',
      cls: 'mddb-page-btn',
    });
    prevBtn.disabled = currentPage <= 1;
    prevBtn.addEventListener('click', () => this.viewModel.prevPage());

    // 页码信息
    paginationEl.createSpan({
      text: ` Page ${currentPage} / ${totalPages} `,
      cls: 'mddb-page-info',
    });

    // 下一页
    const nextBtn = paginationEl.createEl('button', {
      text: 'Next →',
      cls: 'mddb-page-btn',
    });
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.addEventListener('click', () => this.viewModel.nextPage());
  }
}
