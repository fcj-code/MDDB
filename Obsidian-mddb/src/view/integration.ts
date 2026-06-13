/**
 * 视图集成
 *
 * 将视图层注册到 Obsidian 插件生命周期中。
 *
 * 参考：v2 roadmap Milestone 4
 */

import { Plugin } from 'obsidian';
import { TABLE_VIEW_TYPE, TableView } from './table/table-view';
import { parseTableBlock } from './parser';
import type { ViewConfig } from '../query/types';
import type { MDDBEngine } from '../engine/engine';
import { KANBAN_VIEW_TYPE, KanbanView } from './kanban/kanban-view';
import { parseKanbanBlock } from './kanban/parser';
import type { KanbanConfig } from './kanban/kanban-config';

// ============================================================
// 视图注册器
// ============================================================

export class ViewIntegration {
  private plugin: Plugin;
  private engine: MDDBEngine;

  constructor(plugin: Plugin, engine: MDDBEngine) {
    this.plugin = plugin;
    this.engine = engine;
  }

  /**
   * 注册所有视图类型
   */
  registerViews(): void {
    this.plugin.registerView(
      TABLE_VIEW_TYPE,
      (leaf) => new TableView(leaf, this.engine, {
        table: '',
        columns: [],
        readonly: true,
      }),
    );

    this.plugin.registerView(
      KANBAN_VIEW_TYPE,
      (leaf) => new KanbanView(leaf, this.engine, {
        table: '',
        columns: [],
        groupBy: '',
      }),
    );
  }

  /**
   * 打开表格视图
   */
  async openTableView(config: ViewConfig): Promise<void> {
    const leaf = this.plugin.app.workspace.getLeaf(true);
    const view = new TableView(leaf, this.engine, config);
    leaf.setViewState({
      type: TABLE_VIEW_TYPE,
      active: true,
    });
    // 视图会通过 onOpen 自动初始化
  }

  /**
   * 从代码块内容创建表格视图
   */
  async openTableFromBlock(blockContent: string): Promise<void> {
    const result = parseTableBlock(blockContent);
    if (!result.success) {
      throw new Error(`Failed to parse mddb-table block:\n${result.errors.join('\n')}`);
    }
    if (result.config) {
      await this.openTableView(result.config);
    }
  }

  /**
   * 解析并返回配置（用于预览等场景）
   */
  parseBlock(blockContent: string) {
    return parseTableBlock(blockContent);
  }

  /**
   * 打开看板视图
   */
  async openKanbanView(config: KanbanConfig): Promise<void> {
    const leaf = this.plugin.app.workspace.getLeaf(true);
    const view = new KanbanView(leaf, this.engine, config);
    leaf.setViewState({
      type: KANBAN_VIEW_TYPE,
      active: true,
    });
  }

  /**
   * 从代码块内容创建看板视图
   */
  async openKanbanFromBlock(blockContent: string): Promise<void> {
    const result = parseKanbanBlock(blockContent);
    if (!result.success) {
      throw new Error(`Failed to parse mddb-kanban block:\n${result.errors.join('\n')}`);
    }
    if (result.config) {
      await this.openKanbanView(result.config);
    }
  }
}
