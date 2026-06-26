/**
 * $uuid（无逻辑 PK）表的索引/绑定/CRUD 回归测试
 *
 * 复现并锁定根因：_binding 的 UNIQUE(table_name, logical_pk) 索引会把所有
 * logical_pk='' 的记录（@pk $uuid 或无 @pk 的内联多记录表）视为冲突，
 * 导致同表只有首条记录能写入 _binding：
 *   - 其余记录无 binding → update/delete 抛 RECORD_NOT_FOUND（编辑/删除无效）
 *   - parseFile 幂等清理按 binding 删除用户表行，只能删到首条 →
 *     每次重解析残留 N-1 条孤儿行累积（5→9→13→17 的重复渲染）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { MDDBEngine } from './engine';
import type { FileOperator } from '../write/types';
import type { Query } from '../query/types';

const FILE = 'gallery-demo.md';

const SCHEMA_BLOCK = [
  '```dmdb-schema',
  '@table gallery_demo',
  '@pk $uuid',
  '@fields title | category | cover',
  '@types string | string | string',
  '@required true | false | false',
  '```',
].join('\n');

const DATA_ROWS = [
  '嵌入式 wiki 链接 | A组 | ![[cover-a.png]]',
  '普通 wiki 链接 | A组 | [[cover-b.png]]',
  'Markdown 图片 | B组 | ![](assets/cover-a.png)',
  '纯相对路径 | B组 | example/assets/cover-b.png',
  '无封面图 | C组 | ',
];

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

const QUERY: Query = {
  table: 'gallery_demo',
  select: { columns: ['storage_pk', 'title', 'category', 'cover'], distinct: false },
  limit: 200,
};

function rows(engine: MDDBEngine): Array<Record<string, unknown>> {
  const res = engine.query(QUERY);
  if (!res.ok) throw new Error(`query failed: ${res.error.message}`);
  return res.value.rows;
}

describe('$uuid 表索引/绑定/CRUD', () => {
  let engine: MDDBEngine;
  let fileOp: FileOperator;

  beforeEach(async () => {
    fileOp = createInMemoryFileOp({ [FILE]: fileWith(DATA_ROWS) });
    engine = new MDDBEngine(fileOp);
    await engine.initialize(() => initSqlJs());
  });

  it('每条记录都写入 _binding（不被 logical_pk 唯一索引折叠）', () => {
    engine.parseFile(fileWith(DATA_ROWS), FILE);

    expect(rows(engine)).toHaveLength(DATA_ROWS.length);
    expect(engine.binding.findByTableName('gallery_demo')).toHaveLength(DATA_ROWS.length);
  });

  it('重复解析保持幂等：不累积孤儿行（复现 5→17 重复渲染）', () => {
    for (let i = 0; i < 4; i++) {
      engine.parseFile(fileWith(DATA_ROWS), FILE);
    }
    expect(rows(engine)).toHaveLength(DATA_ROWS.length);
  });

  it('每张卡片都能删除（复现编辑/删除无效）', async () => {
    engine.parseFile(fileWith(DATA_ROWS), FILE);

    const pks = rows(engine).map(r => String(r['storage_pk']));
    for (const pk of pks) {
      await expect(engine.delete(pk, { force: true })).resolves.toBeDefined();
    }
    expect(rows(engine)).toHaveLength(0);
  });

  it('rebuildCache 丢弃用户表孤儿行（彻底重建）', async () => {
    engine.parseFile(fileWith(DATA_ROWS), FILE);
    expect(rows(engine).length).toBeGreaterThan(0);

    await engine.rebuildCache();

    // 用户表已被 DROP：查询返回错误（no such table）或空结果
    const res = engine.query(QUERY);
    if (res.ok) {
      expect(res.value.rows).toHaveLength(0);
    } else {
      expect(res.error).toBeDefined();
    }
  });
});
