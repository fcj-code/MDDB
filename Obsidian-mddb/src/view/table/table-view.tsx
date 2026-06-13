/**
 * 表格视图 (TableView)
 *
 * Obsidian ItemView 实现，渲染 mddb-table 查询结果。
 * 使用 React 渲染表格。
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { TableApp } from './react/index';
import { TableViewModel } from './table-view-model';
import type { ViewConfig } from '../../query/types';

export const TABLE_VIEW_TYPE = 'mddb-table-view';

export class TableView extends ItemView {
  private viewModel: TableViewModel;
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    engine: any,
    config: ViewConfig,
  ) {
    super(leaf);
    this.viewModel = new TableViewModel(
      `table-${Date.now()}`,
      engine,
      config,
    );
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
    this.root = createRoot(this.contentEl);
    this.root.render(<TableApp viewModel={this.viewModel} />);
    await this.viewModel.initialize();
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.viewModel.destroy();
  }
}
