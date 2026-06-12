/**
 * TableViewModel 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Query, ResultSet } from '../../query/types';
import type { Disposable } from '../../core/types';

class MockEngine {
  private queryHandler?: (q: Query) => { ok: boolean; value?: ResultSet; error?: { message: string } };

  setQueryHandler(handler: (q: Query) => { ok: boolean; value?: ResultSet; error?: { message: string } }) {
    this.queryHandler = handler;
  }

  query(q: Query) {
    return this.queryHandler?.(q) ?? { ok: false, error: { message: 'no handler' } };
  }

  on(_event: string, _handler: (...args: unknown[]) => void): Disposable {
    return { dispose: () => {} };
  }
}

describe('TableViewModel', () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = new MockEngine();
    engine.setQueryHandler(() => ({
      ok: true,
      value: {
        rows: [
          { name: 'Alice', type: 'savings', balance: 1000 },
          { name: 'Bob', type: 'checking', balance: 500 },
        ],
        columns: [
          { name: 'name', type: 'string' },
          { name: 'type', type: 'string' },
          { name: 'balance', type: 'decimal(2)' },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        returned: 2,
        queryInfo: { table: 'accounts', hasMore: false, durationMs: 5 },
      } as ResultSet,
    }));
  });

  it('initializes and loads data', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test-view', engine as any, {
      table: 'accounts',
      columns: ['name', 'balance'],
      readonly: true,
    });

    expect(vm.status).toBe('loading');
    await vm.initialize();
    expect(vm.status).toBe('ready');
    expect(vm.currentPageRows).toHaveLength(2);
    expect(vm.totalRows).toBe(2);
  });

  it('handles query errors', async () => {
    engine.setQueryHandler(() => ({
      ok: false,
      error: { message: 'Table not found' },
    }));

    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test-view', engine as any, {
      table: 'nonexistent',
      columns: [],
      readonly: true,
    });

    await vm.initialize();
    expect(vm.status).toBe('error');
  });

  it('manages pagination', async () => {
    engine.setQueryHandler(() => ({
      ok: true,
      value: {
        rows: [],
        columns: [{ name: 'x', type: 'string' }],
        total: 100,
        page: 1,
        pageSize: 50,
        totalPages: 2,
        returned: 0,
        queryInfo: { table: 'test', hasMore: true, durationMs: 5 },
      } as ResultSet,
    }));

    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test-view', engine as any, {
      table: 'test',
      columns: [],
      readonly: true,
    });

    await vm.initialize();
    expect(vm.currentPage).toBe(1);
    expect(vm.totalPages).toBe(2);
  });

  it('provides table state', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test-view', engine as any, {
      table: 'accounts',
      columns: ['name'],
      readonly: true,
    });

    await vm.initialize();
    const state = vm.tableStateValue;
    expect(state.columns).toHaveLength(3); // name, type, balance
    expect(state.totalRows).toBe(2);
  });

  it('cleans up on destroy', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test-view', engine as any, {
      table: 'accounts',
      columns: [],
      readonly: true,
    });
    vm.destroy();
    expect(vm.status).toBe('loading'); // cleared state
  });

  it('supports refresh', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test-view', engine as any, {
      table: 'accounts',
      columns: [],
      readonly: true,
    });

    await vm.initialize();
    let queryCount = 0;
    engine.setQueryHandler(() => {
      queryCount++;
      return { ok: true, value: { rows: [], columns: [{ name: 'x', type: 'string' }], total: 0, returned: 0 } as ResultSet };
    });

    await vm.refresh();
    expect(queryCount).toBe(1);
  });
});
