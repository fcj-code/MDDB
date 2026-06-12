/**
 * EventBus 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from './event-bus';
import type { ViewEvent } from './types';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('emits to registered handlers', () => {
    const events: string[] = [];
    bus.on('data-changed', () => events.push('data'));
    bus.on('sort-changed', () => events.push('sort'));

    bus.emit({ type: 'data-changed', viewId: 'v1' });
    bus.emit({ type: 'sort-changed', viewId: 'v1' });

    expect(events).toEqual(['data', 'sort']);
  });

  it('supports wildcard handlers (onAny)', () => {
    const events: ViewEvent[] = [];
    bus.onAny(e => events.push(e));

    bus.emit({ type: 'data-changed', viewId: 'v1' });
    bus.emit({ type: 'error', viewId: 'v1', data: { message: 'err' } });

    expect(events).toHaveLength(2);
  });

  it('returns unregister function', () => {
    let count = 0;
    const unreg = bus.on('refresh', () => count++);
    bus.emit({ type: 'refresh', viewId: 'v1' });
    expect(count).toBe(1);

    unreg();
    bus.emit({ type: 'refresh', viewId: 'v1' });
    expect(count).toBe(1); // unchanged
  });

  it('isolates handler exceptions', () => {
    bus.on('data-changed', () => { throw new Error('handler error'); });
    bus.on('data-changed', () => { /* should still run */ });

    expect(() => bus.emit({ type: 'data-changed', viewId: 'v1' })).not.toThrow();
  });

  it('clears all handlers', () => {
    let count = 0;
    bus.on('data-changed', () => count++);
    bus.clear();
    bus.emit({ type: 'data-changed', viewId: 'v1' });
    expect(count).toBe(0);
  });

  it('tracks handler count', () => {
    bus.on('data-changed', () => {});
    bus.on('sort-changed', () => {});
    bus.onAny(() => {});
    expect(bus.handlerCount).toBe(3);
  });
});
