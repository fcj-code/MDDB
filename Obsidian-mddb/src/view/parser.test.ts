/**
 * mddb-table 解析器测试
 */
import { describe, it, expect } from 'vitest';
import { parseTableBlock, ViewConfigBuilder } from './parser';

describe('parseTableBlock', () => {
  it('parses complete table block', () => {
    const result = parseTableBlock(`
from accounts
show name, type, balance
where type = "savings"
sort by balance desc
limit 25
`);
    expect(result.success).toBe(true);
    expect(result.config!.table).toBe('accounts');
    expect(result.config!.columns).toEqual(['name', 'type', 'balance']);
    expect(result.config!.filter).toBe('type = "savings"');
    expect(result.config!.sort).toHaveLength(1);
    expect(result.config!.sort![0]!.field).toBe('balance');
    expect(result.config!.sort![0]!.direction).toBe('DESC');
    expect(result.config!.pageSize).toBe(25);
  });

  it('parses minimal block', () => {
    const result = parseTableBlock('from accounts');
    expect(result.success).toBe(true);
    expect(result.config!.table).toBe('accounts');
    expect(result.config!.columns).toEqual([]);
  });

  it('parses multi-column sort', () => {
    const result = parseTableBlock(`
from transactions
sort by date desc
sort by amount asc
`);
    expect(result.success).toBe(true);
    expect(result.config!.sort).toHaveLength(2);
    expect(result.config!.sort![0]!.field).toBe('date');
    expect(result.config!.sort![0]!.direction).toBe('DESC');
    expect(result.config!.sort![1]!.field).toBe('amount');
    expect(result.config!.sort![1]!.direction).toBe('ASC');
  });

  it('returns error when missing from directive', () => {
    const result = parseTableBlock('show name');
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Missing required directive: "from"');
  });

  it('reports errors for unknown directive but still succeeds', () => {
    const result = parseTableBlock('from accounts\nunknown xyz');
    expect(result.success).toBe(true); // from 存在即可
    expect(result.errors.some(e => e.includes('Unknown directive'))).toBe(true);
    expect(result.config!.table).toBe('accounts');
  });

  it('skips comments and empty lines', () => {
    const result = parseTableBlock(`
# this is a comment

from accounts
show name
`);
    expect(result.success).toBe(true);
    expect(result.config!.table).toBe('accounts');
  });

  it('handles IN clause in where', () => {
    const result = parseTableBlock(`
from accounts
where type IN ("checking", "savings")
`);
    expect(result.success).toBe(true);
    expect(result.config!.filter).toContain('IN');
  });
});

describe('ViewConfigBuilder', () => {
  describe('toQuery', () => {
    it('converts minimal config to query', () => {
      const query = ViewConfigBuilder.toQuery({
        table: 'accounts',
        columns: [],
        readonly: true,
      });
      expect(query.table).toBe('accounts');
      expect(query.select).toBeUndefined();
      expect(query.limit).toBe(50);
    });

    it('converts config with columns', () => {
      const query = ViewConfigBuilder.toQuery({
        table: 'accounts',
        columns: ['name', 'balance'],
        readonly: true,
      });
      expect(query.select).toBeDefined();
      expect(query.select!.columns).toEqual(['name', 'balance']);
    });
  });

  describe('parseWhere', () => {
    it('parses simple equality', () => {
      const result = ViewConfigBuilder.parseWhere('type = "savings"');
      expect(result).toBeDefined();
      expect(result!.conditions[0]).toMatchObject({
        field: 'type',
        op: 'eq',
        value: 'savings',
      });
    });

    it('parses comparison operators', () => {
      const gt = ViewConfigBuilder.parseWhere('amount > 100');
      expect(gt!.conditions[0]).toMatchObject({ field: 'amount', op: 'gt', value: 100 });

      const lte = ViewConfigBuilder.parseWhere('amount <= 50');
      expect(lte!.conditions[0]).toMatchObject({ field: 'amount', op: 'lte', value: 50 });
    });

    it('parses AND conditions', () => {
      const result = ViewConfigBuilder.parseWhere('type = "savings" AND balance > 1000');
      expect(result!.operator).toBe('AND');
      expect(result!.conditions).toHaveLength(2);
    });

    it('parses OR conditions', () => {
      const result = ViewConfigBuilder.parseWhere('type = "checking" OR type = "savings"');
      expect(result!.operator).toBe('OR');
      expect(result!.conditions).toHaveLength(2);
    });

    it('parses IS NULL', () => {
      const result = ViewConfigBuilder.parseWhere('description IS NULL');
      expect(result!.conditions[0]).toMatchObject({
        field: 'description',
        op: 'isNull',
      });
    });

    it('parses IN clause', () => {
      const result = ViewConfigBuilder.parseWhere('type IN ("a", "b", "c")');
      expect(result!.conditions[0]).toMatchObject({
        field: 'type',
        op: 'in',
      });
    });
  });
});
