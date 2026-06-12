/**
 * 基础视图模型
 *
 * 所有视图模型（表格、表单等）的基类。
 *
 * 参考：v2 roadmap Milestone 4
 */

import type { ViewState, ViewStatus } from './shared/types';
import { EventBus } from './shared/event-bus';

export abstract class BaseViewModel {
  readonly viewId: string;
  readonly events: EventBus;

  protected state: ViewState;

  constructor(viewId: string) {
    this.viewId = viewId;
    this.events = new EventBus();
    this.state = {
      status: 'loading',
      lastUpdated: null,
    };
  }

  /** 获取状态快照 */
  getState(): ViewState {
    return { ...this.state };
  }

  /** 获取当前状态码 */
  get status(): ViewStatus {
    return this.state.status;
  }

  /** 更新状态并发送事件 */
  protected setState(partial: Partial<ViewState>): void {
    this.state = { ...this.state, ...partial };
    this.events.emit({
      type: 'state-changed',
      viewId: this.viewId,
      data: this.state,
    });
  }

  /** 初始化视图 */
  abstract initialize(): Promise<void>;

  /** 刷新数据 */
  abstract refresh(): Promise<void>;

  /** 销毁清理 */
  destroy(): void {
    this.events.clear();
  }
}
