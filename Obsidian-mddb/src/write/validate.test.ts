import { describe, it, expect } from 'vitest';
import type { SchemaSummary } from '../core/types';
import { validateRecord } from './validate';

function makeSchema(over?: Partial<SchemaSummary>): SchemaSummary {
  return {
    table: 'records',
    pk: ['$uuid'],
    fields: ['name', 'amount', 'due', 'note'],
    types: ['string', 'decimal(2)', 'date', 'string'],
    required: [true, true, false, false],
    nullMarker: '-',
    strict: false,
    ...over,
  };
}

describe('validateRecord', () => {
  it('passes a fully valid record', () => {
    const errors = validateRecord(makeSchema(), {
      name: '账单A',
      amount: '12.50',
      due: '2026-06-26',
      note: '',
    });
    expect(errors).toEqual([]);
  });

  it('flags an empty required field', () => {
    const errors = validateRecord(makeSchema(), {
      name: '',
      amount: '10',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('name');
    expect(errors[0]!.message).toContain('必填');
  });

  it('flags a missing required field (insert mode)', () => {
    const errors = validateRecord(makeSchema(), { amount: '10' });
    expect(errors.map(e => e.field)).toContain('name');
  });

  it('flags an unparseable number', () => {
    const errors = validateRecord(makeSchema(), {
      name: '账单A',
      amount: 'abc',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('amount');
  });

  it('flags an invalid date but allows empty optional date', () => {
    const bad = validateRecord(makeSchema(), {
      name: '账单A',
      amount: '10',
      due: '26/06/2026',
    });
    expect(bad.map(e => e.field)).toEqual(['due']);

    const ok = validateRecord(makeSchema(), {
      name: '账单A',
      amount: '10',
      due: '',
    });
    expect(ok).toEqual([]);
  });

  it('does not format-check string / enum / ref fields', () => {
    const schema = makeSchema({
      fields: ['title', 'kind', 'acct'],
      types: ['string', 'enum(收入,支出)', 'ref(accounts)'],
      required: [true, false, false],
    });
    const errors = validateRecord(schema, {
      title: '任意文本 !@#',
      kind: '任意未在枚举内的值',
      acct: '任意引用',
    });
    expect(errors).toEqual([]);
  });

  it('partial mode skips missing fields including required', () => {
    const errors = validateRecord(
      makeSchema(),
      { amount: '99.99' },
      { partial: true },
    );
    expect(errors).toEqual([]);
  });

  it('partial mode still validates provided fields', () => {
    const errors = validateRecord(
      makeSchema(),
      { amount: 'not-a-number' },
      { partial: true },
    );
    expect(errors.map(e => e.field)).toEqual(['amount']);
  });

  it('accepts numeric (non-string) values', () => {
    const errors = validateRecord(makeSchema(), {
      name: '账单A',
      amount: 12.5,
    });
    expect(errors).toEqual([]);
  });
});
