import { describe, it, expect } from 'vitest';
import { parseKanbanBlock } from './parser';

describe('parseKanbanBlock', () => {
  it('parses a complete kanban block', () => {
    const result = parseKanbanBlock(`
from tasks
show 标题, 负责人, 优先级
group by 状态
where 负责人 = "张三"
sort by 优先级 desc
limit 50
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config).toEqual({
      table: 'tasks',
      columns: ['标题', '负责人', '优先级'],
      groupBy: '状态',
      filter: '负责人 = "张三"',
      sort: [{ field: '优先级', direction: 'DESC' }],
      limit: 50,
    });
  });

  it('requires from and group by', () => {
    const result = parseKanbanBlock('show 标题');
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles minimal config', () => {
    const result = parseKanbanBlock(`
from tasks
group by 状态
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config!.table).toBe('tasks');
    expect(result.config!.groupBy).toBe('状态');
    expect(result.config!.limit).toBe(200);
  });

  it('ignores comments', () => {
    const result = parseKanbanBlock(`
from tasks
# this is a comment
group by 状态
    `.trim());

    expect(result.success).toBe(true);
  });
});
