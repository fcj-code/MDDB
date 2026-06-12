/**
 * SQLGenerator 测试（Milestone 4 扩展）
 */
import { describe, it, expect } from 'vitest';
import { SQLGenerator } from './sql-generator';

describe('SQLGenerator', () => {
  const gen = new SQLGenerator('ascii');

  describe('generateQuery', () => {
    it('adds default LIMIT 200', () => {
      const { sql, params } = gen.generateQuery({ table: 'accounts' });
      expect(sql).toContain('LIMIT ?');
      expect(params).toContain(200);
    });

    it('respects custom limit within MAX', () => {
      const { sql, params } = gen.generateQuery({ table: 'accounts', limit: 50 });
      expect(params).toContain(50);
    });

    it('caps limit at MAX_LIMIT', () => {
      const { params } = gen.generateQuery({ table: 'accounts', limit: 99999 });
      expect(params[0]).toBe(5000); // MAX_LIMIT
    });

    it('generates multi-column ORDER BY', () => {
      const { sql } = gen.generateQuery({
        table: 'accounts',
        sort: [
          { field: 'type', direction: 'ASC' },
          { field: 'balance', direction: 'DESC' },
        ],
      });
      expect(sql).toContain('ORDER BY type ASC, balance DESC');
    });

    it('generates single-column sort as before', () => {
      const { sql } = gen.generateQuery({
        table: 'accounts',
        sort: { field: 'name', direction: 'DESC' },
      });
      expect(sql).toContain('ORDER BY name DESC');
    });

    it('generates GROUP BY with HAVING', () => {
      const { sql, params } = gen.generateQuery({
        table: 'transactions',
        groupBy: ['category'],
        aggregates: {
          operations: [{ type: 'SUM', field: 'amount', alias: 'total' }],
        },
        having: {
          operator: 'AND',
          conditions: [{ field: 'amount', op: 'gt', value: 100 }],
        },
      });
      expect(sql).toContain('GROUP BY category');
      expect(sql).toContain('HAVING');
      expect(sql).toContain('SUM(amount) AS total');
      expect(sql).toContain('LIMIT');
    });

    it('generates COUNT aggregate', () => {
      const { sql } = gen.generateQuery({
        table: 'accounts',
        aggregates: {
          operations: [{ type: 'COUNT', alias: 'cnt' }],
        },
      });
      expect(sql).toContain('COUNT(*) AS cnt');
    });

    it('generates DISTINCT select', () => {
      const { sql } = gen.generateQuery({
        table: 'accounts',
        select: { columns: ['type'], distinct: true },
      });
      expect(sql).toContain('SELECT DISTINCT type');
    });

    it('includes OFFSET when provided', () => {
      const { sql, params } = gen.generateQuery({
        table: 'accounts',
        limit: 10,
        offset: 20,
      });
      expect(sql).toContain('OFFSET ?');
      expect(params).toContain(20);
    });
  });

  describe('generateCountQuery', () => {
    it('generates COUNT(*) with same WHERE', () => {
      const { sql, params } = gen.generateCountQuery({
        table: 'accounts',
        where: {
          operator: 'AND',
          conditions: [{ field: 'type', op: 'eq', value: 'savings' }],
        },
      });
      expect(sql).toContain('COUNT(*)');
      expect(sql).toContain('WHERE');
      expect(params).toContain('savings');
    });

    it('generates simple count without WHERE', () => {
      const { sql } = gen.generateCountQuery({ table: 'accounts' });
      expect(sql).toContain('COUNT(*)');
      expect(sql).not.toContain('WHERE');
    });
  });

  describe('generateRefFollowSQL', () => {
    it('generates IN query for ref follow', () => {
      const { sql, params } = gen.generateRefFollowSQL(
        'categories', 'name', ['food', 'transport'], ['name', 'type'],
      );
      expect(sql).toContain('SELECT name, name, type FROM categories');
      expect(sql).toContain('WHERE name IN (?, ?)');
      expect(params).toEqual(['food', 'transport']);
    });
  });
});
