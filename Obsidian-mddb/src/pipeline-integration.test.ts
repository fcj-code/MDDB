/**
 * 管道集成测试 — 使用 example/ 中的示例数据
 *
 * 测试只读 MVP 的完整路径：
 *   示例文件 → Lexer → TypeConverter → Validator → IndexWriter
 */

import { describe, it, expect } from 'vitest';
import { extractBlocks, splitFields } from './parse/lexer';
import { convertRowFields } from './parse/converter';
import { validateRows } from './parse/validator';
import { resolveSchema } from './schema/resolver';
import { generateCreateTableSQL, generateInsertSQL } from './storage/index-writer';
import { safeIdent, validateSchema } from './schema/validators';
import type { SchemaSummary } from './core/types';

// ============================================================
// 示例数据
// ============================================================

const ACCOUNTS_FILE = [
  '```dmdb-schema',
  '@table accounts',
  '@pk name',
  '@fields name | balance | type | institution | notes',
  '@types string | decimal(2) | enum(储蓄,信用,投资,电子) | string | text',
  '@required true | true | true | false | false',
  '@sort (type ASC, balance DESC)',
  '@nullMarker -',
  '```',
  '',
  '```mddb',
  '现金 | 3500.00 | 储蓄 | - | 日常随身现金',
  '支付宝 | 12850.50 | 电子 | - | 主要在线支付渠道\\|含余额宝自动转入',
  '微信 | 3200.00 | 电子 | - | 红包和转账专用',
  '招商银行 | 45600.00 | 储蓄 | 招商银行 | 工资卡',
  '招商信用卡 | -2100.00 | 信用 | 招商银行 | 上月账单',
  '余额宝 | 18000.00 | 投资 | 支付宝 | 七日年化 2.3%',
  '```',
];

const ACCOUNTS_SCHEMA_LINES = [
  '@table accounts',
  '@pk name',
  '@fields name | balance | type | institution | notes',
  '@types string | decimal(2) | enum(储蓄,信用,投资,电子) | string | text',
  '@required true | true | true | false | false',
  '@sort (type ASC, balance DESC)',
  '@nullMarker -',
];

// ============================================================
// 测试: Schema 解析
// ============================================================

describe('Schema Resolution from example data', () => {
  it('parses accounts.md schema from directives', () => {
    const schema = resolveSchema(ACCOUNTS_SCHEMA_LINES, null, '', {
      identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'accounts.md',
    });

    expect(schema.table).toBe('accounts');
    expect(schema.pk).toEqual(['name']);
    expect(schema.fields).toEqual(['name', 'balance', 'type', 'institution', 'notes']);
    expect(schema.types).toEqual([
      'string', 'decimal(2)', 'enum(储蓄,信用,投资,电子)', 'string', 'text',
    ]);
    expect(schema.sort).toBe('type ASC, balance DESC');
    expect(schema.nullMarker).toBe('-');
  });

  it('validates accounts schema passes', () => {
    const schema = resolveSchema(ACCOUNTS_SCHEMA_LINES, null, '', {
      identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'accounts.md',
    });
    const validation = validateSchema(schema, 'ascii');
    expect(validation.valid).toBe(true);
  });

  it('generates valid CREATE TABLE SQL', () => {
    const schema = resolveSchema(ACCOUNTS_SCHEMA_LINES, null, '', {
      identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'accounts.md',
    });

    const sql = generateCreateTableSQL(schema, 'ascii');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS accounts');
    expect(sql).toContain('balance BIGINT');   // decimal(2) → BIGINT
    expect(sql).toContain('type TEXT');         // enum → TEXT
  });
});

// ============================================================
// 测试: Lexer
// ============================================================

describe('Lexer with example data', () => {
  it('extracts blocks from accounts.md', () => {
    const blocks = extractBlocks(ACCOUNTS_FILE);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.fenceKind).toBe('dmdb-schema');
    expect(blocks[1]!.fenceKind).toBe('mddb');
    expect(blocks[1]!.dataLines).toHaveLength(6);
  });

  it('splits fields with escaped pipe', () => {
    const line = '支付宝 | 12850.50 | 电子 | - | 主要在线支付渠道\\|含余额宝自动转入';
    const fields = splitFields(line);
    expect(fields).toEqual(['支付宝', '12850.50', '电子', '-', '主要在线支付渠道|含余额宝自动转入']);
  });
});

// ============================================================
// 测试: 类型转换
// ============================================================

describe('Type conversion with example data', () => {
  it('converts accounts data rows', () => {
    const types = ['string', 'decimal(2)', 'enum(储蓄,信用,投资,电子)', 'string', 'text'];

    // 现金行
    const row1 = splitFields('现金 | 3500.00 | 储蓄 | - | 日常随身现金');
    const { values: v1, errors: e1 } = convertRowFields(row1, types, '-');
    expect(e1).toHaveLength(0);
    expect(v1[0]).toBe('现金');
    expect(v1[1]).toBe(350000); // 3500.00 * 100
    expect(v1[2]).toBe('储蓄');
    expect(v1[3]).toBeNull();   // "-" → NULL
    expect(v1[4]).toBe('日常随身现金');

    // 招商信用卡行（负值）
    const row2 = splitFields('招商信用卡 | -2100.00 | 信用 | 招商银行 | 上月账单');
    const { values: v2 } = convertRowFields(row2, types, '-');
    expect(v2[1]).toBe(-210000);
    expect(v2[2]).toBe('信用');
  });

  it('converts transactions with tags', () => {
    const row = splitFields('2024-06-01 | -45.00 | 支出 | food | 现金 | 兰州拉面 | 备注 | #午餐');
    const types = ['date', 'decimal(2)', 'enum(支出,收入)', 'string', 'string', 'string', 'text', 'tags'];
    const { values, errors } = convertRowFields(row, types, '-');

    expect(errors).toHaveLength(0);
    expect(values[0]).toBe('2024-06-01');
    expect(values[1]).toBe(-4500);
    expect(values[2]).toBe('支出');
    const tags = JSON.parse(values[7] as string);
    expect(tags).toContain('午餐');
  });
});

// ============================================================
// 测试: 校验
// ============================================================

describe('Validation with example data', () => {
  const accountSchema = resolveSchema(ACCOUNTS_SCHEMA_LINES, null, '', {
    identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'accounts.md',
  });

  it('all accounts data rows pass', () => {
    const dataLines = [
      '现金 | 3500.00 | 储蓄 | - | 日常随身现金',
      '支付宝 | 12850.50 | 电子 | - | 主要在线支付渠道\\|含余额宝自动转入',
      '微信 | 3200.00 | 电子 | - | 红包和转账专用',
      '招商银行 | 45600.00 | 储蓄 | 招商银行 | 工资卡',
      '招商信用卡 | -2100.00 | 信用 | 招商银行 | 上月账单',
      '余额宝 | 18000.00 | 投资 | 支付宝 | 七日年化 2.3%',
    ];

    const records = dataLines.map((line, i) => {
      const fields = splitFields(line);
      const { values } = convertRowFields(fields, accountSchema.types, '-');
      return { rawValues: values, rawLine: line, lineNumber: i + 1 };
    });

    const result = validateRows(records, accountSchema, {
      strict: false, nullMarker: '-',
      existingLogicalPks: new Set(),
      tableName: 'accounts',
    });

    expect(result.records).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects duplicate PK', () => {
    const schema = resolveSchema([
      '@table tx', '@pk (date, amount, merchant)',
      '@fields date | amount | merchant | note',
      '@types date | decimal(2) | string | text',
      '@required true | true | true | false',
    ], null, '', {
      identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'test.md',
    });

    const records = [
      { rawValues: ['2024-06-01', -4500, 'shop_a', null], rawLine: '...', lineNumber: 1 },
      { rawValues: ['2024-06-01', -4500, 'shop_a', null], rawLine: '...', lineNumber: 2 },
    ];

    const result = validateRows(records, schema, {
      strict: false, nullMarker: '-',
      existingLogicalPks: new Set(),
      tableName: 'tx',
    });

    // 宽松模式：两条记录都被处理，但第二条产生 PK_DUPLICATE 错误
    expect(result.records).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });
});

// ============================================================
// 测试: SQL DDL 生成
// ============================================================

describe('SQL from example schemas', () => {
  it('generates correct DDL and INSERT', () => {
    const schema = resolveSchema(ACCOUNTS_SCHEMA_LINES, null, '', {
      identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'accounts.md',
    });

    const ddl = generateCreateTableSQL(schema, 'ascii');
    expect(ddl).toContain('name TEXT');
    expect(ddl).toContain('balance BIGINT');
    expect(ddl).toContain('type TEXT');

    const insert = generateInsertSQL(schema, 'ascii');
    expect(insert).toContain('INSERT INTO accounts');
    expect(insert).toContain('?, ?, ?, ?, ?');
  });

  it('rejects invalid identifiers', () => {
    expect(() => safeIdent('bad-name!', 'ascii')).toThrow();
    expect(() => safeIdent('good_name', 'ascii')).not.toThrow();
  });
});
