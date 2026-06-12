/**
 * 视图事件总线
 *
 * 提供视图层各组件之间的解耦通信。
 *
 * 参考：v2 roadmap Milestone 4
 */

import type { ViewEvent, ViewEventType } from './types';

export type EventHandler = (event: ViewEvent) => void;

export class EventBus {
  private handlers = new Map<ViewEventType, Set<EventHandler>>();
  private wildcardHandlers = new Set<EventHandler>();

  /** 注册事件处理器 */
  on(type: ViewEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** 注册所有事件处理器 */
  onAny(handler: EventHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  /** 触发事件 */
  emit(event: ViewEvent): void {
    // 精确类型处理器
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(event); } catch { /* 单个异常不影响其他 */ }
      }
    }

    // 通配符处理器
    for (const handler of this.wildcardHandlers) {
      try { handler(event); } catch { /* 单个异常不影响其他 */ }
    }
  }

  /** 移除所有处理器 */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  /** 处理器数量 */
  get handlerCount(): number {
    let count = this.wildcardHandlers.size;
    for (const set of this.handlers.values()) {
      count += set.size;
    }
    return count;
  }
}
