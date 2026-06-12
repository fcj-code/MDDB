import { describe, it, expect } from 'vitest';
import { extractBlocks, splitFields, isNullValue, classifyLine, LineKind } from './lexer';

describe('splitFields', () => {
  it('splits by pipe and trims', () => {
    const result = splitFields('2024-06-01 | -45.00 | 支出 | 餐饮');
    expect(result).toEqual(['2024-06-01', '-45.00', '支出', '餐饮']);
  });

  it('handles escaped pipe', () => {
    const result = splitFields('支付宝\\|微信 | 余额 | 备注\\|测试');
    expect(result).toEqual(['支付宝|微信', '余额', '备注|测试']);
  });

  it('handles escaped backslash', () => {
    const result = splitFields('路径\\\\文件');
    expect(result).toEqual(['路径\\文件']);
  });

  it('handles empty fields', () => {
    const result = splitFields('a | | c');
    expect(result).toEqual(['a', '', 'c']);
  });
});

describe('isNullValue', () => {
  it('empty string is null', () => {
    expect(isNullValue('', '-')).toBe(true);
  });

  it('nullMarker value is null', () => {
    expect(isNullValue('-', '-')).toBe(true);
    expect(isNullValue('N/A', 'N/A')).toBe(true);
  });

  it('normal values are not null', () => {
    expect(isNullValue('hello', '-')).toBe(false);
    expect(isNullValue('0', '-')).toBe(false);
    expect(isNullValue('false', '-')).toBe(false);
  });
});

describe('classifyLine', () => {
  it('directive lines start with @', () => {
    expect(classifyLine('@table accounts', 1).kind).toBe(LineKind.Directive);
    expect(classifyLine(' @table accounts', 2).kind).toBe(LineKind.Directive);
  });

  it('data lines are non-empty non-directive', () => {
    expect(classifyLine('现金 | 3500', 3).kind).toBe(LineKind.Data);
    expect(classifyLine('hello', 4).kind).toBe(LineKind.Data);
  });

  it('empty lines are Empty', () => {
    expect(classifyLine('', 5).kind).toBe(LineKind.Empty);
    expect(classifyLine('   ', 6).kind).toBe(LineKind.Empty);
  });
});

describe('extractBlocks', () => {
  it('extracts a single mddb block', () => {
    const lines = [
      'Some text before',
      '```mddb',
      'data1 | val1',
      'data2 | val2',
      '```',
      'Some text after',
    ];

    const blocks = extractBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.fenceKind).toBe('mddb');
    expect(blocks[0]!.content).toEqual(['data1 | val1', 'data2 | val2']);
    expect(blocks[0]!.dataLines).toEqual(['data1 | val1', 'data2 | val2']);
  });

  it('extracts a dmdb-schema block', () => {
    const lines = [
      '```dmdb-schema',
      '@table accounts',
      '@pk name',
      '@fields name | balance',
      '@types string | decimal(2)',
      '```',
      '```mddb',
      '现金 | 3500',
      '```',
    ];

    const blocks = extractBlocks(lines);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.fenceKind).toBe('dmdb-schema');
    expect(blocks[0]!.directives.length).toBeGreaterThan(0);
    expect(blocks[1]!.fenceKind).toBe('mddb');
    expect(blocks[1]!.dataLines).toEqual(['现金 | 3500']);
  });

  it('handles multiple blocks with same table', () => {
    const lines = [
      '```mddb schema=transactions',
      '2024-06-01 | -45.00',
      '```',
      'Some text',
      '```mddb schema=transactions',
      '2024-06-02 | -128.00',
      '```',
    ];

    const blocks = extractBlocks(lines);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.infoString).toContain('schema=transactions');
  });

  it('handles block with info string', () => {
    const lines = [
      '```mddb schema=monthly_budgets',
      '2024-01 | 8000.00',
      '```',
    ];

    const blocks = extractBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.infoString).toBe('schema=monthly_budgets');
  });
});
