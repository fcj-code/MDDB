import { describe, it, expect } from 'vitest';
import {
  serializeValue,
  escapePipe,
  unescapePipe,
  serializeRow,
  recordInputToValues,
  replaceLine,
  deleteLine,
  appendToBlock,
  simpleHash,
} from './serializer';
import type { SchemaSummary } from '../core/types';

// ============================================================
// Schema fixture
// ============================================================

const ACCOUNTS_SCHEMA: SchemaSummary = {
  table: 'accounts',
  pk: ['name'],
  fields: ['name', 'balance', 'type', 'institution', 'notes'],
  types: ['string', 'decimal(2)', 'enum(储蓄,信用,投资,电子)', 'string', 'text'],
  required: [true, true, true, false, false],
  sort: 'type ASC, balance DESC',
  nullMarker: '-',
};

const TRANSACTIONS_SCHEMA: SchemaSummary = {
  table: 'transactions',
  pk: ['日期', '金额', '商户'],
  fields: ['日期', '金额', '类型', '分类', '账户', '商户', '备注', '标签'],
  types: ['date', 'decimal(2)', 'enum(支出,收入)', 'ref(categories)', 'ref(accounts)', 'string', 'text', 'tags'],
  required: [true, true, true, true, true, true, false, false],
  sort: '日期 ASC',
  nullMarker: '-',
};

// ============================================================
// serializeValue
// ============================================================

describe('serializeValue', () => {
  it('null becomes nullMarker', () => {
    expect(serializeValue(null, 'string', '-')).toBe('-');
    expect(serializeValue(undefined, 'string', '-')).toBe('-');
  });

  it('string type returns String', () => {
    expect(serializeValue('hello', 'string', '-')).toBe('hello');
  });

  it('decimal(2) converts BIGINT back to decimal string', () => {
    // decimal(2) stores value * 100, serializeValue should divide by 100
    // The input is the raw value (not scaled), so it should be formatted
    expect(serializeValue(3500, 'decimal(2)', '-')).toBe('3500.00');
    expect(serializeValue(12850.5, 'decimal(2)', '-')).toBe('12850.50');
    expect(serializeValue(-2100, 'decimal(2)', '-')).toBe('-2100.00');
  });

  it('boolean true returns "true"', () => {
    expect(serializeValue(true, 'boolean', '-')).toBe('true');
    expect(serializeValue(1, 'boolean', '-')).toBe('true');
  });

  it('boolean false returns "false"', () => {
    expect(serializeValue(false, 'boolean', '-')).toBe('false');
    expect(serializeValue(0, 'boolean', '-')).toBe('false');
  });

  it('date preserves YYYY-MM-DD format', () => {
    expect(serializeValue('2024-06-01', 'date', '-')).toBe('2024-06-01');
  });

  it('tags serializes array to #tag format', () => {
    expect(serializeValue(['午餐', '通勤'], 'tags', '-')).toBe('#午餐 #通勤');
    expect(serializeValue('["午餐","通勤"]', 'tags', '-')).toBe('#午餐 #通勤');
  });

  it('ref returns string value', () => {
    expect(serializeValue('支付宝', 'ref(accounts)', '-')).toBe('支付宝');
  });

  it('decimal(4) with custom precision', () => {
    expect(serializeValue(1.2345, 'decimal(4)', '-')).toBe('1.2345');
  });
});

// ============================================================
// escapePipe / unescapePipe
// ============================================================

describe('escapePipe', () => {
  it('escapes pipe character', () => {
    expect(escapePipe('a|b')).toBe('a\\|b');
  });

  it('escapes backslash', () => {
    expect(escapePipe('a\\b')).toBe('a\\\\b');
  });

  it('handles mixed content', () => {
    expect(escapePipe('支付宝|微信')).toBe('支付宝\\|微信');
  });
});

describe('unescapePipe', () => {
  it('restores escaped pipe', () => {
    expect(unescapePipe('a\\|b')).toBe('a|b');
  });

  it('restores escaped backslash', () => {
    expect(unescapePipe('a\\\\b')).toBe('a\\b');
  });
});

// ============================================================
// serializeRow
// ============================================================

describe('serializeRow', () => {
  it('serializes a complete row for accounts', () => {
    const values = ['现金', 3500, '储蓄', null, '日常随身现金'];
    const result = serializeRow(values, ACCOUNTS_SCHEMA);

    expect(result.line).toBe('现金 | 3500.00 | 储蓄 | - | 日常随身现金\n');
    expect(result.rawLineHash).toBeTruthy();
    expect(result.values).toEqual(['现金', '3500.00', '储蓄', '-', '日常随身现金']);
  });

  it('serializes row with escaped content', () => {
    const values = ['支付宝|微信', 12850.5, '电子', null, '主要在线支付渠道|含余额宝自动转入'];
    const result = serializeRow(values, ACCOUNTS_SCHEMA);

    expect(result.line).toContain('支付宝\\|微信');
    expect(result.line).toContain('主要在线支付渠道\\|含余额宝自动转入');
  });

  it('serializes a transactions row', () => {
    const values = ['2024-06-01', -45, '支出', 'food', '现金', '兰州拉面', '加了一份牛肉', ['午餐']];
    const result = serializeRow(values, TRANSACTIONS_SCHEMA);

    expect(result.line).toContain('2024-06-01');
    expect(result.line).toContain('-45.00');
    expect(result.line).toContain('支出');
    expect(result.line).toContain('#午餐');
  });

  it('serializes a row with null values as nullMarker', () => {
    const values = ['测试', 100, '支出', null, null, '商户测试', null, null];
    const result = serializeRow(values, TRANSACTIONS_SCHEMA);

    const parts = result.line.split('|');
    expect(parts[3].trim()).toBe('-'); // 空分类
    expect(parts[4].trim()).toBe('-'); // 空账户
  });
});

// ============================================================
// recordInputToValues
// ============================================================

describe('recordInputToValues', () => {
  it('maps record fields in schema order', () => {
    const record = { name: '现金', balance: 3500, type: '储蓄' };
    const values = recordInputToValues(record, ACCOUNTS_SCHEMA);

    expect(values).toEqual(['现金', 3500, '储蓄', null, null]);
  });

  it('fills missing fields with null', () => {
    const record = { name: '测试' };
    const values = recordInputToValues(record, ACCOUNTS_SCHEMA);

    expect(values).toHaveLength(5);
    expect(values[0]).toBe('测试');
    expect(values[1]).toBeNull();
    expect(values[4]).toBeNull();
  });
});

// ============================================================
// replaceLine
// ============================================================

describe('replaceLine', () => {
  const content = 'line1\nline2\nline3\nline4';

  it('replaces line in the middle', () => {
    const result = replaceLine(content, 2, 'new_line2');
    expect(result).toBe('line1\nnew_line2\nline3\nline4');
  });

  it('replaces first line', () => {
    const result = replaceLine(content, 1, 'new_first');
    expect(result).toBe('new_first\nline2\nline3\nline4');
  });

  it('replaces last line', () => {
    const result = replaceLine(content, 4, 'new_last');
    expect(result).toBe('line1\nline2\nline3\nnew_last');
  });

  it('throws on out of range line number', () => {
    expect(() => replaceLine(content, 10, 'x')).toThrow('out of range');
  });
});

// ============================================================
// deleteLine
// ============================================================

describe('deleteLine', () => {
  const content = 'line1\nline2\nline3\nline4';

  it('deletes line in the middle', () => {
    const result = deleteLine(content, 2);
    expect(result).toBe('line1\nline3\nline4');
  });

  it('deletes first line', () => {
    const result = deleteLine(content, 1);
    expect(result).toBe('line2\nline3\nline4');
  });

  it('deletes last line', () => {
    const result = deleteLine(content, 4);
    expect(result).toBe('line1\nline2\nline3');
  });

  it('throws on out of range', () => {
    expect(() => deleteLine(content, 10)).toThrow('out of range');
  });
});

// ============================================================
// appendToBlock
// ============================================================

describe('appendToBlock', () => {
  const content = '```mddb\nline1\nline2\n```';

  it('appends line before closing fence', () => {
    // blockEndLine = 4 (the fence line, 1-based)
    const result = appendToBlock(content, 4, 'new_line');
    expect(result).toBe('```mddb\nline1\nline2\nnew_line\n```');
  });

  it('appends line to an empty block', () => {
    const emptyBlock = '```mddb\n```';
    const result = appendToBlock(emptyBlock, 2, 'first_line');
    expect(result).toBe('```mddb\nfirst_line\n```');
  });

  it('throws on out of range block end', () => {
    expect(() => appendToBlock(content, 10, 'x')).toThrow('out of range');
  });
});

// ============================================================
// simpleHash
// ============================================================

describe('simpleHash', () => {
  it('produces deterministic 8-char hex', () => {
    const h1 = simpleHash('hello');
    const h2 = simpleHash('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
  });

  it('different strings produce different hashes', () => {
    const h1 = simpleHash('hello');
    const h2 = simpleHash('world');
    expect(h1).not.toBe(h2);
  });
});
