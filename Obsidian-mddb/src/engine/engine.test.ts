/**
 * MDDBEngine 视图↔数据库同步集成测试
 *
 * 覆盖回灌链路（外部/手改文件 → 重解析 → 通知视图）：
 * - 断点2：parseFile 成功后 emit('data-changed')，已打开视图可自动刷新
 * - 断点1/5：自改回声（内容与已知哈希一致）被跳过，避免回声循环；
 *            真外部修改正常回灌索引
 */

import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { MDDBEngine } from './engine';
import type { FileOperator } from '../write/types';
import type { Query } from '../query/types';

// ============================================================
// 测试夹具
// ============================================================

const FILE = 'tasks.md';

const SCHEMA_BLOCK = [
  '```dmdb-schema',
  '@table tasks',
  '@pk id',
  '@fields id | title | status',
  '@types string | string | string',
  '@nullMarker -',
  '```',
].join('\n');

function fileWith(dataRows: string[]): string {
  return `${SCHEMA_BLOCK}\n\n\`\`\`mddb\n${dataRows.join('\n')}\n\`\`\``;
}

function createInMemoryFileOp(initial: Record<string, string>): FileOperator {
  const store = new Map(Object.entries(initial));
  return {
    async readFile(filePath: string): Promise<string> {
      const c = store.get(filePath);
      if (c === undefined) throw new Error(`File not found: ${filePath}`);
      return c;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      store.set(filePath, content);
    },
    async processFile(filePath: string, updater: (content: string) => string): Promise<string> {
      const updated = updater(store.get(filePath) ?? '');
      store.set(filePath, updated);
      return updated;
    },
  };
}

const TASKS_QUERY: Query = {
  table: 'tasks',
  select: { columns: ['id', 'title', 'status'], distinct: false },
  limit: 100,
};

function rowCount(engine: MDDBEngine): number {
  const res = engine.query(TASKS_QUERY);
  if (!res.ok) throw new Error(`query failed: ${res.error.message}`);
  return res.value.rows.length;
}

// ============================================================
// 测试
// ============================================================

describe('MDDBEngine 视图↔数据库同步', () => {
  let engine: MDDBEngine;
  let fileOp: FileOperator;

  beforeEach(async () => {
    fileOp = createInMemoryFileOp({ [FILE]: fileWith(['t1 | Task A | todo']) });
    engine = new MDDBEngine(fileOp);
    await engine.initialize(() => initSqlJs());
    // 初始索引
    engine.parseFile(await fileOp.readFile(FILE), FILE);
  });

  it('外部修改文件后：重解析并 emit data-changed，索引随之更新', async () => {
    // 夹具合法性：初始应为 1 行
    expect(rowCount(engine)).toBe(1);

    const events: unknown[] = [];
    engine.on('data-changed', (e) => events.push(e));

    const newContent = fileWith(['t1 | Task A | todo', 't2 | Task B | doing']);
    await engine.onFileModified(FILE, newContent);

    // 回灌链路必须通知视图层
    expect(events.length).toBeGreaterThan(0);
    // 索引反映外部新增的行
    expect(rowCount(engine)).toBe(2);
  });

  it('自改回声（内容与已知哈希一致）被跳过：不重解析、不 emit', async () => {
    // 模拟插件刚写完文件后 vault 'modify' 回声：内容与已索引内容完全一致
    const echo = await fileOp.readFile(FILE);

    const events: unknown[] = [];
    engine.on('data-changed', (e) => events.push(e));

    await engine.onFileModified(FILE, echo);

    // 回声应被识别并跳过，避免回声循环
    expect(events.length).toBe(0);
    expect(rowCount(engine)).toBe(1);
  });
});
