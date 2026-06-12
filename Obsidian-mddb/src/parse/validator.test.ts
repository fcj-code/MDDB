import { describe, it, expect } from 'vitest';
import { validateRow, validateRows, computeLogicalPk, emptyParseResult } from './validator';
import type { SchemaSummary } from '../core/types';

const sampleSchema: SchemaSummary = {
  table: 'accounts',
  pk: ['name'],
  fields: ['name', 'balance', 'type'],
  types: ['string', 'decimal(2)', 'enum(储蓄,信用,投资,电子)'],
  required: [true, true, false],
  nullMarker: '-',
  strict: false,
};

describe('computeLogicalPk', () => {
  it('computes PK from single column', () => {
    const pk = computeLogicalPk(['现金', 3500, '储蓄'], sampleSchema);
    expect(pk).toBe('现金');
  });

  it('returns null when PK value is null', () => {
    const schema: SchemaSummary = {
      ...sampleSchema,
      pk: ['$uuid'],
    };
    const pk = computeLogicalPk(['现金', 3500, '储蓄'], schema);
    expect(pk).toBeNull();
  });
});

describe('validateRow', () => {
  const baseOptions = {
    strict: false,
    nullMarker: '-',
    existingLogicalPks: new Set<string>(),
    tableName: 'accounts',
    fileName: 'test.md',
  };

  it('validates a correct row', () => {
    const result = validateRow(
      ['现金', 3500, '储蓄'],
      '现金 | 3500 | 储蓄',
      10,
      sampleSchema,
      baseOptions,
    );

    expect(result.record).not.toBeNull();
    expect(result.errors).toHaveLength(0);
    expect(result.record!.values).toEqual(['现金', 3500, '储蓄']);
  });

  it('detects duplicate PK', () => {
    const options = {
      ...baseOptions,
      existingLogicalPks: new Set(['现金']),
    };

    const result = validateRow(
      ['现金', 3500, '储蓄'],
      '现金 | 3500 | 储蓄',
      10,
      sampleSchema,
      options,
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.code).toBe('PK_DUPLICATE');
  });

  it('detects required field missing', () => {
    const result = validateRow(
      [null, 3500, '储蓄'],
      '- | 3500 | 储蓄',
      10,
      sampleSchema,
      baseOptions,
    );

    // PK name is null → REQUIRED_MISSING for PK + PK_DUPLICATE skip
    // The required field "name" is missing
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('strict mode skips row on error', () => {
    const strictSchema: SchemaSummary = { ...sampleSchema, strict: true };
    const options = { ...baseOptions, strict: true };

    const result = validateRow(
      ['现金'],
      '现金',
      10,
      strictSchema,
      options,
    );

    expect(result.record).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles field count mismatch gracefully in loose mode', () => {
    const result = validateRow(
      ['现金', 3500],
      '现金 | 3500',
      10,
      sampleSchema,
      baseOptions,
    );

    // Field count mismatch → error but record is created with NULL padding
    expect(result.record).not.toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.record!.values).toHaveLength(3);
  });
});

describe('validateRows', () => {
  it('validates multiple rows with PK dedup', () => {
    const rows = [
      { rawValues: ['现金', 3500, '储蓄'], rawLine: '现金 | 3500 | 储蓄', lineNumber: 1 },
      { rawValues: ['支付宝', 12850, '电子'], rawLine: '支付宝 | 12850 | 电子', lineNumber: 2 },
    ];

    const result = validateRows(rows, sampleSchema, {
      strict: false,
      nullMarker: '-',
      tableName: 'accounts',
      existingLogicalPks: new Set(),
    });

    expect(result.records).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('detects duplicate PKs across rows as errors', () => {
    const rows = [
      { rawValues: ['现金', 3500, '储蓄'], rawLine: '现金 | 3500 | 储蓄', lineNumber: 1 },
      { rawValues: ['现金', 5000, '投资'], rawLine: '现金 | 5000 | 投资', lineNumber: 2 },
    ];

    const result = validateRows(rows, sampleSchema, {
      strict: false,
      nullMarker: '-',
      tableName: 'accounts',
      existingLogicalPks: new Set(),
    });

    // 宽松模式下两条记录都被添加（first-wins, second gets PK_DUPLICATE error）
    expect(result.records).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe('PK_DUPLICATE');
  });
});
