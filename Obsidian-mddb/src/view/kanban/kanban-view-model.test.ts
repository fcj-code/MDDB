import { describe, it, expect, vi } from 'vitest';
import { KanbanViewModel } from './kanban-view-model';
import type { KanbanConfig } from './kanban-config';

function createMockEngine() {
  return {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    schemaRegistry: { getSchema: vi.fn() },
  } as any;
}

describe('KanbanViewModel', () => {
  it('groups rows by the groupBy field', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理', 负责人: '张三' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中', 负责人: '李四' },
          { storage_pk: '3', 标题: 'Task C', 状态: '待处理', 负责人: '王五' },
          { storage_pk: '4', 标题: 'Task D', 状态: '已完成', 负责人: '张三' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }, { name: '负责人', type: 'string' }],
        total: 4,
      },
    });

    const config: KanbanConfig = {
      table: 'tasks',
      columns: ['标题', '负责人', '状态'],
      groupBy: '状态',
      limit: 200,
    };

    const vm = new KanbanViewModel('test-1', engine, config);
    await vm.initialize();

    const board = vm.board;
    expect(board.lanes).toHaveLength(3);
    expect(board.lanes.map(l => l.title)).toEqual(expect.arrayContaining(['待处理', '进行中', '已完成']));
  });

  it('moveCard updates groupBy field via engine.update', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 2,
      },
    });
    engine.update.mockResolvedValue({ storagePk: '1' });

    const config: KanbanConfig = {
      table: 'tasks',
      columns: ['标题', '状态'],
      groupBy: '状态',
    };

    const vm = new KanbanViewModel('test-2', engine, config);
    await vm.initialize();
    // Mock query again for refresh after move
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '进行中' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 2,
      },
    });

    const result = await vm.moveCard('1', '待处理', '进行中', 0);
    expect(result).toBe(true);
    expect(engine.update).toHaveBeenCalledWith('1', { 状态: '进行中' }, { force: true });
  });

  it('returns empty lanes when query returns no rows', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }],
        total: 0,
      },
    });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-3', engine, config);
    await vm.initialize();

    expect(vm.board.lanes).toHaveLength(0);
    expect(vm.board.totalCards).toBe(0);
  });

  it('addCard inserts record with groupBy field value', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 1,
      },
    });
    engine.insert.mockResolvedValue({ storagePk: 'new-1' });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-4', engine, config);
    await vm.initialize();

    // Mock refresh data
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理' },
          { storage_pk: 'new-1', 标题: 'New Task', 状态: '待处理' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 2,
      },
    });

    const result = await vm.addCard('待处理', { 标题: 'New Task' });
    expect(result).toBe(true);
    expect(engine.insert).toHaveBeenCalledWith('tasks', { 标题: 'New Task', 状态: '待处理' });
  });

  it('deleteCard calls engine.delete and refreshes', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 2,
      },
    });
    engine.delete.mockResolvedValue({ storagePk: '1' });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-5', engine, config);
    await vm.initialize();

    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 1,
      },
    });

    const result = await vm.deleteCard('1');
    expect(result).toBe(true);
    expect(engine.delete).toHaveBeenCalledWith('1', { force: true });
  });

  it('toggleLaneCollapse toggles collapsed state', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 1,
      },
    });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-6', engine, config);
    await vm.initialize();

    const lane = vm.board.lanes[0]!;
    expect(lane.collapsed).toBe(false);

    vm.toggleLaneCollapse(lane.id);
    expect(lane.collapsed).toBe(true);

    vm.toggleLaneCollapse(lane.id);
    expect(lane.collapsed).toBe(false);
  });

  it('setSearchQuery updates search state', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [],
        columns: [],
        total: 0,
      },
    });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-7', engine, config);
    await vm.initialize();

    expect(vm.searchQuery).toBe('');
    vm.setSearchQuery('test');
    expect(vm.searchQuery).toBe('test');
  });

  it('handles query error gracefully', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: false,
      err: new Error('Query failed'),
    });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-8', engine, config);
    await vm.initialize();

    expect(vm.board.lanes).toHaveLength(0);
    expect(vm.status).toBe('error');
  });
});
