/**
 * TableConfig 测试
 */
import { describe, it, expect } from 'vitest';
import { columnsToConfig, DEFAULT_TABLE_CONFIG } from './table-config';

describe('columnsToConfig', () => {
  it('generates config from column array', () => {
    const config = columnsToConfig([
      { name: 'name', type: 'string' },
      { name: 'amount', type: 'decimal(2)' },
    ]);

    expect(config.columns).toHaveLength(2);
    expect(config.columns[0]!.label).toBe('name');
    expect(config.columns[0]!.align).toBe('left');
    expect(config.columns[1]!.label).toBe('amount');
    expect(config.columns[1]!.align).toBe('right');
  });

  it('uses default for empty columns', () => {
    const config = columnsToConfig([]);
    expect(config.columns).toHaveLength(0);
    expect(config.pageSize).toBe(50);
    expect(config.nullDisplay).toBe('-');
  });

  it('aligns center for boolean type', () => {
    const config = columnsToConfig([
      { name: 'active', type: 'boolean' },
    ]);
    expect(config.columns[0]!.align).toBe('center');
  });
});

describe('DEFAULT_TABLE_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_TABLE_CONFIG.pageSize).toBe(50);
    expect(DEFAULT_TABLE_CONFIG.showRowNumbers).toBe(true);
    expect(DEFAULT_TABLE_CONFIG.readonly).toBe(true);
    expect(DEFAULT_TABLE_CONFIG.nullDisplay).toBe('-');
  });
});
