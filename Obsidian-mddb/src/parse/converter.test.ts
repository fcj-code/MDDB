import { describe, it, expect } from 'vitest';
import {
  convertString, convertInteger, convertDecimal, convertBoolean,
  convertDate, convertDatetime, convertEnum, convertText,
  convertTags, convertRef, convertPhone, convertEmail,
  convertValue, convertRowFields, formatDisplayValue, parseTypeExpr,
} from './converter';

describe('parseTypeExpr', () => {
  it('parses simple types', () => {
    expect(parseTypeExpr('string')).toEqual({ typeName: 'string', params: [] });
    expect(parseTypeExpr('integer')).toEqual({ typeName: 'integer', params: [] });
  });

  it('parses parameterized types', () => {
    expect(parseTypeExpr('decimal(2)')).toEqual({ typeName: 'decimal', params: ['2'] });
    expect(parseTypeExpr('enum(支出,收入)')).toEqual({ typeName: 'enum', params: ['支出', '收入'] });
    expect(parseTypeExpr('ref(accounts)')).toEqual({ typeName: 'ref', params: ['accounts'] });
  });

  it('parses decimal with various precisions', () => {
    expect(parseTypeExpr('decimal(0)')).toEqual({ typeName: 'decimal', params: ['0'] });
    expect(parseTypeExpr('decimal(4)')).toEqual({ typeName: 'decimal', params: ['4'] });
  });
});

describe('convertString', () => {
  it('trims and returns string', () => {
    expect(convertString('  hello  ')).toEqual({ value: 'hello' });
    expect(convertString('abc')).toEqual({ value: 'abc' });
  });
});

describe('convertInteger', () => {
  it('parses valid integers', () => {
    expect(convertInteger('42').value).toBe(42);
    expect(convertInteger('-17').value).toBe(-17);
    expect(convertInteger('0').value).toBe(0);
  });

  it('rejects invalid integers', () => {
    expect(convertInteger('12.5').value).toBeNull();
    expect(convertInteger('abc').value).toBeNull();
    expect(convertInteger('').value).toBeNull();
    expect(convertInteger('12a').value).toBeNull();
  });
});

describe('convertDecimal', () => {
  it('converts with precision 2', () => {
    expect(convertDecimal('45.00', 2).value).toBe(4500);
    expect(convertDecimal('45', 2).value).toBe(4500);
    expect(convertDecimal('0.01', 2).value).toBe(1);
  });

  it('converts with precision 0', () => {
    expect(convertDecimal('45', 0).value).toBe(45);
    expect(convertDecimal('45.67', 0).value).toBe(46); // round
  });

  it('rejects invalid decimals', () => {
    expect(convertDecimal('abc', 2).value).toBeNull();
  });
});

describe('convertBoolean', () => {
  it('accepts multiple true values', () => {
    expect(convertBoolean('true').value).toBe(1);
    expect(convertBoolean('yes').value).toBe(1);
    expect(convertBoolean('1').value).toBe(1);
    expect(convertBoolean('是').value).toBe(1);
  });

  it('accepts multiple false values', () => {
    expect(convertBoolean('false').value).toBe(0);
    expect(convertBoolean('no').value).toBe(0);
    expect(convertBoolean('0').value).toBe(0);
  });

  it('rejects invalid booleans', () => {
    expect(convertBoolean('maybe').value).toBeNull();
    expect(convertBoolean('').value).toBeNull();
  });
});

describe('convertDate', () => {
  it('converts YYYY-MM-DD', () => {
    expect(convertDate('2024-06-01').value).toBe('2024-06-01');
    expect(convertDate('2024-6-1').value).toBe('2024-06-01');
  });

  it('converts YYYY/MM/DD', () => {
    expect(convertDate('2024/06/01').value).toBe('2024-06-01');
  });

  it('rejects invalid dates', () => {
    expect(convertDate('01-06-2024').value).toBeNull();
    expect(convertDate('abc').value).toBeNull();
  });
});

describe('convertEnum', () => {
  it('matches exact enum values', () => {
    expect(convertEnum('支出', ['支出', '收入']).value).toBe('支出');
    expect(convertEnum('收入', ['支出', '收入']).value).toBe('收入');
  });

  it('rejects non-matching values', () => {
    expect(convertEnum('投资', ['支出', '收入']).value).toBeNull();
    expect(convertEnum('', ['支出', '收入']).value).toBeNull();
  });
});

describe('convertTags', () => {
  it('extracts tags from text', () => {
    const result = convertTags('#food #lunch #日常');
    const tags = JSON.parse(result.value as string);
    expect(tags).toContain('food');
    expect(tags).toContain('lunch');
    expect(tags).toContain('日常');
  });

  it('deduplicates tags', () => {
    const result = convertTags('#food #lunch #food');
    const tags = JSON.parse(result.value as string);
    expect(tags).toHaveLength(2);
  });

  it('returns empty array for no tags', () => {
    const result = convertTags('hello world');
    expect(JSON.parse(result.value as string)).toEqual([]);
  });
});

describe('convertPhone', () => {
  it('extracts digits from phone numbers', () => {
    expect(convertPhone('13812345678').value).toBe('13812345678');
    expect(convertPhone('138-1234-5678').value).toBe('13812345678');
  });

  it('rejects too few digits', () => {
    expect(convertPhone('123').value).toBeNull();
  });
});

describe('convertEmail', () => {
  it('validates and lowercases email', () => {
    expect(convertEmail('Alice@Example.com').value).toBe('alice@example.com');
    expect(convertEmail('user@test.org').value).toBe('user@test.org');
  });

  it('rejects invalid emails', () => {
    expect(convertEmail('not-an-email').value).toBeNull();
    expect(convertEmail('').value).toBeNull();
  });
});

describe('convertValue', () => {
  it('routes to correct converter by type expression', () => {
    expect(convertValue('42', 'integer').value).toBe(42);
    expect(convertValue('45.00', 'decimal(2)').value).toBe(4500);
    expect(convertValue('true', 'boolean').value).toBe(1);
    expect(convertValue('2024-06-01', 'date').value).toBe('2024-06-01');
    expect(convertValue('支出', 'enum(支出,收入)').value).toBe('支出');
    expect(convertValue('alice@example.com', 'email').value).toBe('alice@example.com');
  });

  it('handles unknown types gracefully', () => {
    const result = convertValue('test', 'unknown_type');
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });
});

describe('convertRowFields', () => {
  it('converts multiple fields in one row', () => {
    const raw = ['2024-06-01', '-45.00', '支出'];
    const types = ['date', 'decimal(2)', 'enum(支出,收入)'];

    const { values, errors } = convertRowFields(raw, types, '-');
    expect(values).toEqual(['2024-06-01', -4500, '支出']);
    expect(errors).toHaveLength(0);
  });

  it('marks nulls for nullMarker values', () => {
    const raw = ['2024-06-01', '-', '支出'];
    const types = ['date', 'decimal(2)', 'enum(支出,收入)'];

    const { values, errors } = convertRowFields(raw, types, '-');
    expect(values[0]).toBe('2024-06-01');
    expect(values[1]).toBeNull();
    expect(values[2]).toBe('支出');
    expect(errors).toHaveLength(0);
  });

  it('collects conversion errors', () => {
    const raw = ['2024-06-01', 'not-a-number', 'invalid-enum'];
    const types = ['date', 'decimal(2)', 'enum(支出,收入)'];

    const { values, errors } = convertRowFields(raw, types, '-');
    expect(values[1]).toBeNull();  // decimal conversion failed
    expect(values[2]).toBeNull();  // enum conversion failed
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('formatDisplayValue', () => {
  it('formats decimal correctly', () => {
    expect(formatDisplayValue(4500, 'decimal(2)')).toBe('45.00');
    expect(formatDisplayValue(1, 'decimal(2)')).toBe('0.01');
    expect(formatDisplayValue(0, 'decimal(2)')).toBe('0.00');
  });

  it('formats boolean correctly', () => {
    expect(formatDisplayValue(1, 'boolean')).toBe('true');
    expect(formatDisplayValue(0, 'boolean')).toBe('false');
  });

  it('returns null marker for null/undefined', () => {
    expect(formatDisplayValue(null, 'string')).toBe('-');
    expect(formatDisplayValue(undefined, 'string')).toBe('-');
  });
});
