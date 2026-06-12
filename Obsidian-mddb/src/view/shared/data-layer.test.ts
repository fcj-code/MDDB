/**
 * DataLayer 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Query, ResultSet } from '../../query/types';
import type { RecordInput, RecordPatch, WriteResult, Disposable } from '../../core/types';

// Mock Engine
class MockEngine {
  private queryHandler?: (q: Query) => { ok: boolean; value?: ResultSet; error?: { message: string } };
  private eventHandlers = new Map<string, (...args: unknown[]) => void>();

  setQueryHandler(handler: (q: Query) => { ok: boolean; value?: ResultSet; error?: { message: string } }) {
    this.queryHandler = handler;
  }

  query(q: Query) {
    return this.queryHandler?.(q) ?? { ok: false, error: { message: 'no handler' } };
  }

  on(event: string, handler: (...args: unknown[]) => void): Disposable {
    this.eventHandlers.set(event, handler);
    return { dispose: () => this.eventHandlers.delete(event) };
  }

  triggerDataChanged() {
    const handler = this.eventHandlers.get('data-changed');
    if (handler) handler({ type: 'insert', table: 'test', storagePk: 'pk-1' });
  }
}

describe('DataLayer', () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = new MockEngine();
  });

  it('executes query and returns results', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any, { refreshStrategy: 'manual', defaultPageSize: 50 });

    engine.setQueryHandler(() => ({
      ok: true,
      value: {
        rows: [{ name: 'test' }],
        columns: [{ name: 'name', type: 'string' }],
        total: 1,
        returned: 1,
      } as ResultSet,
    }));

    const result = await layer.executeQuery({ table: 'test' });
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(1);
  });

  it('captures query errors', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any, { refreshStrategy: 'manual', defaultPageSize: 50 });

    engine.setQueryHandler(() => ({
      ok: false,
      error: { message: 'Table not found' },
    }));

    const result = await layer.executeQuery({ table: 'nonexistent' });
    expect(result).toBeNull();
    expect(layer.getState().error).toBeTruthy();
  });

  it('supports pagination', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any, { refreshStrategy: 'manual', defaultPageSize: 10 });

    let queryCount = 0;
    engine.setQueryHandler((q) => {
      queryCount++;
      return {
        ok: true,
        value: {
          rows: [],
          columns: [{ name: 'x', type: 'string' }],
          total: 50,
          page: q.offset !== undefined ? Math.floor(q.offset / 10) + 1 : 1,
          pageSize: 10,
          totalPages: 5,
          returned: 0,
          queryInfo: { table: 'test', hasMore: (q.offset ?? 0) + 10 < 50 },
        } as ResultSet,
      };
    });

    await layer.executeQuery({ table: 'test' });
    expect(layer.getState().page).toBe(1);

    await layer.nextPage();
    expect(queryCount).toBeGreaterThanOrEqual(2);
  });

  it('auto-refreshes on data-changed event', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any, { refreshStrategy: 'auto', debounceMs: 10 });

    let queryCount = 0;
    engine.setQueryHandler(() => {
      queryCount++;
      return { ok: true, value: { rows: [], columns: [], total: 0, returned: 0 } as ResultSet };
    });

    await layer.executeQuery({ table: 'test' });
    const before = queryCount;

    engine.triggerDataChanged();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(queryCount).toBeGreaterThan(before);
  });

  it('supports sort toggling', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any, { refreshStrategy: 'manual', defaultPageSize: 50 });

    engine.setQueryHandler(() => ({
      ok: true,
      value: { rows: [], columns: [{ name: 'name', type: 'string' }], total: 0, returned: 0 } as ResultSet,
    }));

    await layer.executeQuery({ table: 'test' });
    await layer.toggleSort('name');

    expect(layer.getState().sortFields).toHaveLength(1);
    expect(layer.getState().sortFields[0]!.field).toBe('name');
    expect(layer.getState().sortFields[0]!.direction).toBe('ASC');
  });

  it('calls onStateChange callback', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any, { refreshStrategy: 'manual', defaultPageSize: 50 });

    const states: any[] = [];
    layer.onStateChange = (s) => states.push({ loading: s.loading, error: s.error });

    engine.setQueryHandler(() => ({
      ok: true,
      value: { rows: [{ x: 1 }], columns: [{ name: 'x', type: 'integer' }], total: 1, returned: 1 } as ResultSet,
    }));

    await layer.executeQuery({ table: 'test' });
    expect(states.length).toBeGreaterThan(0);
  });

  it('destroys and cleans up', async () => {
    const { DataLayer } = await import('./data-layer');
    const layer = new DataLayer(engine as any);
    layer.destroy();
    // After destroy, should not crash
    await layer.executeQuery({ table: 'test' });
  });
});
