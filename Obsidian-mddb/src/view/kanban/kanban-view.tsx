/**
 * 看板视图 (KanbanView)
 *
 * Obsidian ItemView 实现，渲染 mddb-kanban 查询结果。
 * 使用 React 渲染看板。
 *
 * 参考：kanban-view-design.md §7.2
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { KanbanApp } from './react/index';
import { KanbanViewModel } from './kanban-view-model';
import type { KanbanConfig } from './kanban-config';

export const KANBAN_VIEW_TYPE = 'mddb-kanban-view';

export class KanbanView extends ItemView {
  private viewModel: KanbanViewModel;
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    engine: any,
    config: KanbanConfig,
  ) {
    super(leaf);
    this.viewModel = new KanbanViewModel(
      `kanban-${Date.now()}`,
      engine,
      config,
    );
  }

  getViewType(): string {
    return KANBAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.viewModel.config.table ?? 'MD-DB Kanban';
  }

  getIcon(): string {
    return 'layout-kanban';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    this.root.render(<KanbanApp viewModel={this.viewModel} />);
    await this.viewModel.initialize();
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.viewModel.destroy();
  }
}
