/**
 * 画廊视图 (GalleryView)
 *
 * Obsidian ItemView 实现，渲染 mddb-gallery 查询结果为卡片网格。
 * 使用 React 渲染。镜像 kanban-view.tsx。
 */

import { App, ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { GalleryApp } from './react/index';
import { GalleryViewModel } from './gallery-view-model';
import type { GalleryConfig } from './gallery-config';
import type { MDDBEngine } from '../../engine/engine';

export const GALLERY_VIEW_TYPE = 'mddb-gallery-view';

export class GalleryView extends ItemView {
  private viewModel: GalleryViewModel;
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    engine: MDDBEngine,
    config: GalleryConfig,
    app: App,
  ) {
    super(leaf);
    this.viewModel = new GalleryViewModel(
      `gallery-${Date.now()}`,
      engine,
      config,
      app,
    );
  }

  getViewType(): string {
    return GALLERY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.viewModel.config.table ?? 'MD-DB Gallery';
  }

  getIcon(): string {
    return 'layout-grid';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    this.root.render(<GalleryApp viewModel={this.viewModel} />);
    await this.viewModel.initialize();
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.viewModel.destroy();
  }
}
