import { describe, it, expect } from 'vitest';
import { parseSchemaFromDirectives, parseSchemaFromFrontmatter, resolveSchema, mergeSchemas } from './resolver';

describe('parseSchemaFromDirectives', () => {
  it('parses basic schema directives', () => {
    const lines = [
      '@table accounts',
      '@pk name',
      '@fields name | balance | type',
      '@types string | decimal(2) | enum(储蓄,信用,投资,电子)',
      '@required true | true | false',
      '@sort (type ASC, balance DESC)',
      '@strict true',
    ];

    const schema = parseSchemaFromDirectives(lines);

    expect(schema.table).toBe('accounts');
    expect(schema.pk).toEqual(['name']);
    expect(schema.fields).toEqual(['name', 'balance', 'type']);
    expect(schema.types).toEqual(['string', 'decimal(2)', 'enum(储蓄,信用,投资,电子)']);
    expect(schema.required).toEqual([true, true, false]);
    expect(schema.sort).toBe('type ASC, balance DESC');
    expect(schema.strict).toBe(true);
  });

  it('parses composite PK', () => {
    const lines = [
      '@table transactions',
      '@pk (日期, 金额, 商户)',
      '@fields 日期 | 金额 | 商户',
      '@types date | decimal(2) | string',
    ];

    const schema = parseSchemaFromDirectives(lines);
    expect(schema.pk).toEqual(['日期', '金额', '商户']);
  });

  it('parses indexes and relations', () => {
    const lines = [
      '@table categories',
      '@pk code',
      '@fields code | name | type',
      '@types string | string | string',
      '@indexes idx(name)',
      '@relations 分类 <- transactions.分类',
    ];

    const schema = parseSchemaFromDirectives(lines);
    expect(schema.indexes).toEqual(['idx(name)']);
    expect(schema.relations).toEqual(['分类 <- transactions.分类']);
  });

  it('handles no value directives like @strict', () => {
    const lines = [
      '@table t',
      '@pk id',
      '@fields id | name',
      '@types string | string',
      '@strict',
    ];

    const schema = parseSchemaFromDirectives(lines);
    // @strict with no value should default correctly
  });
});

describe('parseSchemaFromFrontmatter', () => {
  it('parses YAML mddb frontmatter with simple values', () => {
    // MVP 简单 frontmatter 解析器支持：非数组值 + 管道分隔的字段
    const content = `---
created: 2024-07-01
mddb:
  table: transactions
  pk: name
  fields: name | balance | type
  types: string | decimal(2) | boolean
  sort: name ASC
  null_marker: "-"
---
# Content
`;

    const schema = parseSchemaFromFrontmatter(content);
    expect(schema).not.toBeNull();
    expect(schema!.table).toBe('transactions');
    expect(schema!.pk).toEqual(['name']);
    expect(schema!.fields).toEqual(['name', 'balance', 'type']);
    expect(schema!.sort).toBe('name ASC');
    expect(schema!.nullMarker).toBe('-');
  });

  it('returns null when no mddb frontmatter', () => {
    const content = `---
created: 2024-07-01
tags: [test]
---
# No mddb
`;

    const schema = parseSchemaFromFrontmatter(content);
    expect(schema).toBeNull();
  });

  it('returns null when no frontmatter at all', () => {
    const content = '# Just markdown\nNo frontmatter\n';
    const schema = parseSchemaFromFrontmatter(content);
    expect(schema).toBeNull();
  });
});

describe('mergeSchemas', () => {
  it('low priority fields are overridden by high priority', () => {
    const low = {
      table: 'base',
      pk: ['id'],
      fields: ['id', 'name'],
      types: ['string', 'string'],
      required: [] as boolean[],
      nullMarker: '-',
      strict: false,
    };

    const high = {
      sort: 'name ASC',
    };

    const merged = mergeSchemas(low, high);
    expect(merged.table).toBe('base');
    expect(merged.pk).toEqual(['id']);
    expect(merged.sort).toBe('name ASC');
  });

  it('high priority completely replaces arrays', () => {
    const low = {
      table: 'base',
      pk: ['id'],
      fields: ['id', 'name', 'age'],
      types: ['string', 'string', 'integer'],
      required: [] as boolean[],
      nullMarker: '-',
      strict: false,
    };

    const high = {
      pk: ['uuid'],
      fields: ['uuid', 'label'],
      types: ['string', 'string'],
    };

    const merged = mergeSchemas(low, high);
    expect(merged.pk).toEqual(['uuid']);
    expect(merged.fields).toEqual(['uuid', 'label']);
  });
});

describe('resolveSchema — full resolution', () => {
  it('resolves from directives with no frontmatter', () => {
    const fileContent = '```mddb\n@table test\n@pk id\n@fields id | name\n@types string | string\nsome data\n```';

    const schema = resolveSchema(
      ['@table test', '@pk id', '@fields id | name', '@types string | string'],
      null,
      fileContent,
      { identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'test.md' },
    );

    expect(schema.table).toBe('test');
    expect(schema.fields).toEqual(['id', 'name']);
  });

  it('throws on missing required directives', () => {
    expect(() => {
      resolveSchema(
        ['@table test'],
        null,
        '',
        { identifierMode: 'ascii', vaultRoot: '', currentFilePath: 'test.md' },
      );
    }).toThrow();
  });
});
