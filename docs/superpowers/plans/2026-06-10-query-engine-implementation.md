# Query Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the MD-DB query engine — translate structured Query objects to SQL, execute against in-memory SQLite, and return standardized ResultSets.

**Architecture:** Three-stage pipeline: QueryValidator (structural validation) → SQLGenerator (Query → SQL + post-processing instructions) → ResultAssembler (sql.js results → ResultSet with decimal formatting and ref following). Exposed via a single `QueryEngine` class with `query()` and `queryRaw()` methods.

**Tech Stack:** TypeScript, sql.js (WASM SQLite), jest/vitest (mocked Obsidian API)

**Spec:** `docs/specs/2026-06-10-query-engine-design.md`

---

## File Map

```
src/query/
├── types.ts                 # All type definitions
├── validator.ts             # QueryValidator — structural validation
├── validator.test.ts        # Tests for validator
├── sql-generator.ts         # SQLGenerator — Query → SQL string
├── sql-generator.test.ts    # Tests for SQL generator
├── assembler.ts             # ResultAssembler — raw results → ResultSet
├── assembler.test.ts        # Tests for assembler
├── engine.ts                # QueryEngine — top-level API
└── engine.test.ts           # Integration tests
```

**Dependencies on existing modules (assumed available):**
- `src/schema/types.ts` — `Schema` interface, `FieldType`
- `src/storage/` — SQLite database instance, binding table access

---

## Task 1: Type Definitions

**Files:**
- Create: `src/query/types.ts`

- [ ] **Step 1: Write all type definitions**

```typescript
// src/query/types.ts

// ─── Query Object ────────────────────────────────────────

export interface Query {
  table: string;
  select?: SelectClause;
  filter?: FilterGroup;
  sort?: SortClause[];
  limit?: number;
  offset?: number;
  groupBy?: string[];
  having?: FilterGroup;
  aggregates?: AggregateClause[];
  followRefs?: FollowRefClause[];
}

export interface SelectClause {
  fields: string[];
}

export interface SortClause {
  field: string;
  dir: 'asc' | 'desc';
}

// ─── Filter Model ────────────────────────────────────────

export type FilterOp =
  | '=' | '!=' | '>' | '<' | '>=' | '<='
  | 'in' | 'not_in'
  | 'like' | 'not_like'
  | 'is_null' | 'is_not_null';

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value?: any | any[];
}

export interface FilterGroup {
  logic: 'and' | 'or';
  conditions: (FilterCondition | FilterGroup)[];
}

// ─── Aggregation ─────────────────────────────────────────

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggregateClause {
  field: string;       // '*' for COUNT(*)
  fn: AggregateFn;
  alias?: string;
}

// ─── Ref Following ───────────────────────────────────────

export interface FollowRefClause {
  field: string;       // ref field name in current table
  include?: string[];  // columns from target table, default all
  prefix?: string;     // column prefix, default target table name
}

// ─── Result Set ──────────────────────────────────────────

export interface ResultSet {
  rows: Record<string, any>[];
  columns: ColumnMeta[];
  total: number;
  page: PageInfo | null;
}

export interface ColumnMeta {
  name: string;
  type: string;
  originalField?: string;
  source: 'data' | 'aggregate' | 'ref_follow';
}

export interface PageInfo {
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ─── Errors ──────────────────────────────────────────────

export enum QueryErrorCode {
  TABLE_NOT_FOUND = 'TABLE_NOT_FOUND',
  FIELD_NOT_FOUND = 'FIELD_NOT_FOUND',
  INVALID_OPERATOR = 'INVALID_OPERATOR',
  INVALID_VALUE_TYPE = 'INVALID_VALUE_TYPE',
  REF_FIELD_NOT_FOUND = 'REF_FIELD_NOT_FOUND',
  AGGREGATE_WITHOUT_GROUPBY = 'AGGREGATE_WITHOUT_GROUPBY',
  SYNTAX_ERROR = 'SYNTAX_ERROR',
}

export interface QueryError {
  code: QueryErrorCode;
  message: string;
  field?: string;
}

// ─── API ─────────────────────────────────────────────────

export type ResultOrError =
  | { ok: true; result: ResultSet }
  | { ok: false; errors: QueryError[] };

// ─── Internal: Post-processing instructions ──────────────

export interface PostProcess {
  followRefs?: FollowRefClause[];
  decimalFields?: { field: string; precision: number }[];
}

export interface GeneratedSQL {
  sql: string;
  postProcess: PostProcess;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to `src/query/types.ts`

- [ ] **Step 3: Commit**

```bash
git add src/query/types.ts
git commit -m "feat(query): add type definitions for query engine"
```

---

## Task 2: QueryValidator

**Files:**
- Create: `src/query/validator.ts`
- Create: `src/query/validator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/query/validator.test.ts
import { QueryValidator } from './validator';
import { Query, QueryErrorCode } from './types';
import { Schema } from '../schema/types';

function makeRegistry(schemas: Record<string, Schema>) {
  return { get: (table: string) => schemas[table] ?? null };
}

const sampleSchema: Schema = {
  table: 'transactions',
  pk: ['日期', '金额', '商户'],
  fields: ['日期', '金额', '类型', '分类', '账户', '商户', '备注'],
  types: [
    { kind: 'date' },
    { kind: 'decimal', precision: 2 },
    { kind: 'enum', values: ['支出', '收入'] },
    { kind: 'string' },
    { kind: 'ref', target: 'accounts' },
    { kind: 'string' },
    { kind: 'text' },
  ] as any,
  required: [true, true, true, true, true, true, false],
  nullMarker: '-',
  strict: false,
};

const registry = makeRegistry({ transactions: sampleSchema });
const validator = new QueryValidator(registry);

describe('QueryValidator', () => {
  test('rejects missing table', () => {
    const q: Query = { table: 'nonexistent' };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.TABLE_NOT_FOUND);
    }
  });

  test('accepts valid table', () => {
    const q: Query = { table: 'transactions' };
    const result = validator.validate(q);
    expect(result.ok).toBe(true);
  });

  test('rejects unknown field in filter', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: 'nonexistent', op: '=', value: 'foo' }],
      },
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.FIELD_NOT_FOUND);
    }
  });

  test('rejects unknown field in sort', () => {
    const q: Query = {
      table: 'transactions',
      sort: [{ field: 'nonexistent', dir: 'asc' }],
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.FIELD_NOT_FOUND);
    }
  });

  test('rejects unknown field in select', () => {
    const q: Query = {
      table: 'transactions',
      select: { fields: ['日期', 'nonexistent'] },
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.FIELD_NOT_FOUND);
    }
  });

  test('rejects > on string field', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '分类', op: '>', value: '餐饮' }],
      },
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.INVALID_OPERATOR);
    }
  });

  test('allows > on decimal field', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '金额', op: '>', value: -5000 }],
      },
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(true);
  });

  test('allows is_null on any field', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '备注', op: 'is_null' }],
      },
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(true);
  });

  test('rejects followRefs on non-ref field', () => {
    const q: Query = {
      table: 'transactions',
      followRefs: [{ field: '分类' }],
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.REF_FIELD_NOT_FOUND);
    }
  });

  test('allows followRefs on ref field', () => {
    const q: Query = {
      table: 'transactions',
      followRefs: [{ field: '账户' }],
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(true);
  });

  test('rejects aggregates without groupBy', () => {
    const q: Query = {
      table: 'transactions',
      aggregates: [{ field: '金额', fn: 'sum' }],
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.AGGREGATE_WITHOUT_GROUPBY);
    }
  });

  test('validates fields in nested filter groups', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [
          {
            logic: 'or',
            conditions: [
              { field: 'nonexistent', op: '=', value: 'foo' },
            ],
          },
        ],
      },
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.FIELD_NOT_FOUND);
    }
  });

  test('rejects groupBy with unknown field', () => {
    const q: Query = {
      table: 'transactions',
      groupBy: ['nonexistent'],
      aggregates: [{ field: '金额', fn: 'sum' }],
    };
    const result = validator.validate(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.FIELD_NOT_FOUND);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/query/validator.test.ts`
Expected: All tests FAIL (module not found)

- [ ] **Step 3: Implement QueryValidator**

```typescript
// src/query/validator.ts
import {
  Query, QueryError, QueryErrorCode,
  FilterGroup, FilterCondition,
} from './types';
import { Schema } from '../schema/types';

const TYPE_OP_COMPAT: Record<string, FilterCondition['op'][]> = {
  string:  ['=', '!=', 'in', 'not_in', 'like', 'not_like', 'is_null', 'is_not_null'],
  integer: ['=', '!=', '>', '<', '>=', '<=', 'in', 'not_in', 'is_null', 'is_not_null'],
  decimal: ['=', '!=', '>', '<', '>=', '<=', 'in', 'not_in', 'is_null', 'is_not_null'],
  boolean: ['=', '!=', 'is_null', 'is_not_null'],
  date:    ['=', '!=', '>', '<', '>=', '<=', 'in', 'not_in', 'is_null', 'is_not_null'],
  datetime:['=', '!=', '>', '<', '>=', '<=', 'in', 'not_in', 'is_null', 'is_not_null'],
  enum:    ['=', '!=', 'in', 'not_in', 'is_null', 'is_not_null'],
  text:    ['=', '!=', 'in', 'not_in', 'like', 'not_like', 'is_null', 'is_not_null'],
  tags:    ['=', '!=', 'is_null', 'is_not_null'],
  ref:     ['=', '!=', 'in', 'not_in', 'is_null', 'is_not_null'],
  phone:   ['=', '!=', 'in', 'not_in', 'is_null', 'is_not_null'],
  email:   ['=', '!=', 'in', 'not_in', 'like', 'not_like', 'is_null', 'is_not_null'],
};

export interface SchemaRegistry {
  get(table: string): Schema | null;
}

export class QueryValidator {
  constructor(private registry: SchemaRegistry) {}

  validate(q: Query): { ok: true } | { ok: false; errors: QueryError[] } {
    const errors: QueryError[] = [];

    const schema = this.registry.get(q.table);
    if (!schema) {
      return {
        ok: false,
        errors: [{ code: QueryErrorCode.TABLE_NOT_FOUND, message: `Table '${q.table}' not found` }],
      };
    }

    const fieldSet = new Set(schema.fields);
    const fieldTypes = new Map<string, Schema['types'][number]>();
    schema.fields.forEach((f, i) => fieldTypes.set(f, schema.types[i]));

    if (q.filter) {
      this.validateFilterGroup(q.filter, fieldSet, fieldTypes, 'filter', errors);
    }

    if (q.sort) {
      for (const s of q.sort) {
        if (!fieldSet.has(s.field)) {
          errors.push({
            code: QueryErrorCode.FIELD_NOT_FOUND,
            message: `Sort field '${s.field}' not found in table '${q.table}'`,
            field: `sort.${s.field}`,
          });
        }
      }
    }

    if (q.select) {
      for (const f of q.select.fields) {
        if (!fieldSet.has(f)) {
          errors.push({
            code: QueryErrorCode.FIELD_NOT_FOUND,
            message: `Select field '${f}' not found in table '${q.table}'`,
            field: `select.${f}`,
          });
        }
      }
    }

    if (q.groupBy) {
      for (const f of q.groupBy) {
        if (!fieldSet.has(f)) {
          errors.push({
            code: QueryErrorCode.FIELD_NOT_FOUND,
            message: `GroupBy field '${f}' not found in table '${q.table}'`,
            field: `groupBy.${f}`,
          });
        }
      }
    }

    if (q.followRefs) {
      for (const fr of q.followRefs) {
        const ft = fieldTypes.get(fr.field);
        if (!ft || ft.kind !== 'ref') {
          errors.push({
            code: QueryErrorCode.REF_FIELD_NOT_FOUND,
            message: `Field '${fr.field}' is not a ref type, cannot follow`,
            field: `followRefs.${fr.field}`,
          });
        }
      }
    }

    if (q.aggregates && q.aggregates.length > 0 && (!q.groupBy || q.groupBy.length === 0)) {
      errors.push({
        code: QueryErrorCode.AGGREGATE_WITHOUT_GROUPBY,
        message: 'Aggregates specified without groupBy',
      });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true };
  }

  private validateFilterGroup(
    group: FilterGroup,
    fieldSet: Set<string>,
    fieldTypes: Map<string, Schema['types'][number]>,
    path: string,
    errors: QueryError[],
  ): void {
    for (let i = 0; i < group.conditions.length; i++) {
      const cond = group.conditions[i];
      const condPath = `${path}.conditions[${i}]`;

      if ('logic' in cond) {
        this.validateFilterGroup(cond as FilterGroup, fieldSet, fieldTypes, condPath, errors);
      } else {
        const fc = cond as FilterCondition;

        if (!fieldSet.has(fc.field)) {
          errors.push({
            code: QueryErrorCode.FIELD_NOT_FOUND,
            message: `Filter field '${fc.field}' not found in table`,
            field: `${condPath}.field`,
          });
          continue;
        }

        const ft = fieldTypes.get(fc.field);
        if (ft) {
          const allowedOps = TYPE_OP_COMPAT[ft.kind] ?? [];
          if (!allowedOps.includes(fc.op)) {
            errors.push({
              code: QueryErrorCode.INVALID_OPERATOR,
              message: `Operator '${fc.op}' not allowed on field '${fc.field}' of type '${ft.kind}'`,
              field: `${condPath}.op`,
            });
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/query/validator.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/query/validator.ts src/query/validator.test.ts
git commit -m "feat(query): add QueryValidator with 7 validation rules"
```

---

## Task 3: SQL Generator — Basic Queries

**Files:**
- Create: `src/query/sql-generator.ts`
- Create: `src/query/sql-generator.test.ts`

- [ ] **Step 1: Write failing tests for basic SQL generation**

```typescript
// src/query/sql-generator.test.ts
import { SQLGenerator } from './sql-generator';
import { Query } from './types';
import { Schema } from '../schema/types';

const sampleSchema: Schema = {
  table: 'transactions',
  pk: ['日期', '金额', '商户'],
  fields: ['日期', '金额', '类型', '分类', '账户', '商户', '备注'],
  types: [
    { kind: 'date' },
    { kind: 'decimal', precision: 2 },
    { kind: 'enum', values: ['支出', '收入'] },
    { kind: 'string' },
    { kind: 'ref', target: 'accounts' },
    { kind: 'string' },
    { kind: 'text' },
  ] as any,
  required: [true, true, true, true, true, true, false],
  nullMarker: '-',
  strict: false,
};

function schemaGetter(table: string): Schema {
  if (table === 'transactions') return sampleSchema;
  throw new Error(`Unknown table: ${table}`);
}

const generator = new SQLGenerator(schemaGetter);

describe('SQLGenerator — Basic Queries', () => {
  test('generates SELECT * for empty query', () => {
    const q: Query = { table: 'transactions' };
    const result = generator.generate(q);
    expect(result.sql).toBe('SELECT * FROM transactions');
  });

  test('generates SELECT with specific columns', () => {
    const q: Query = {
      table: 'transactions',
      select: { fields: ['日期', '金额', '分类'] },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe('SELECT "日期", "金额", "分类" FROM transactions');
  });

  test('generates ORDER BY from sort clause', () => {
    const q: Query = {
      table: 'transactions',
      sort: [
        { field: '日期', dir: 'asc' },
        { field: '金额', dir: 'desc' },
      ],
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      'SELECT * FROM transactions ORDER BY "日期" ASC, "金额" DESC'
    );
  });

  test('generates LIMIT and OFFSET', () => {
    const q: Query = { table: 'transactions', limit: 20, offset: 40 };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      'SELECT * FROM transactions LIMIT 20 OFFSET 40'
    );
  });

  test('generates LIMIT without OFFSET', () => {
    const q: Query = { table: 'transactions', limit: 10 };
    const result = generator.generate(q);
    expect(result.sql).toBe('SELECT * FROM transactions LIMIT 10');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/query/sql-generator.test.ts`
Expected: All tests FAIL

- [ ] **Step 3: Implement basic SQLGenerator**

```typescript
// src/query/sql-generator.ts
import { Query, GeneratedSQL, PostProcess } from './types';
import { Schema } from '../schema/types';

export type SchemaGetter = (table: string) => Schema;

export class SQLGenerator {
  constructor(private getSchema: SchemaGetter) {}

  generate(q: Query): GeneratedSQL {
    const parts: string[] = [];

    // SELECT
    if (q.select) {
      const cols = q.select.fields.map(f => `"${f}"`).join(', ');
      parts.push(`SELECT ${cols}`);
    } else {
      parts.push('SELECT *');
    }

    // FROM
    parts.push(`FROM ${q.table}`);

    // ORDER BY
    if (q.sort && q.sort.length > 0) {
      const orderClauses = q.sort.map(
        s => `"${s.field}" ${s.dir.toUpperCase()}`
      );
      parts.push(`ORDER BY ${orderClauses.join(', ')}`);
    }

    // LIMIT / OFFSET
    if (q.limit !== undefined) {
      parts.push(`LIMIT ${q.limit}`);
    }
    if (q.offset !== undefined) {
      parts.push(`OFFSET ${q.offset}`);
    }

    return {
      sql: parts.join(' '),
      postProcess: {},
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/query/sql-generator.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/query/sql-generator.ts src/query/sql-generator.test.ts
git commit -m "feat(query): add SQLGenerator — basic SELECT, ORDER BY, LIMIT"
```

---

## Task 4: SQL Generator — WHERE Clause (FilterGroups)

**Files:**
- Modify: `src/query/sql-generator.ts`
- Modify: `src/query/sql-generator.test.ts` (add tests)

- [ ] **Step 1: Add failing tests for WHERE clause generation**

```typescript
// Append to src/query/sql-generator.test.ts

describe('SQLGenerator — WHERE Clause', () => {
  test('generates simple equality WHERE', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '分类', op: '=', value: '餐饮' }],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE ("分类" = '餐饮')`
    );
  });

  test('generates AND of multiple conditions', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [
          { field: '分类', op: '=', value: '餐饮' },
          { field: '金额', op: '<', value: -5000 },
        ],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE ("分类" = '餐饮' AND "金额" < -5000)`
    );
  });

  test('generates nested OR inside AND', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [
          {
            logic: 'or',
            conditions: [
              { field: '分类', op: '=', value: '餐饮' },
              { field: '分类', op: '=', value: '交通' },
            ],
          },
          { field: '金额', op: '<', value: -5000 },
        ],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE (("分类" = '餐饮' OR "分类" = '交通') AND "金额" < -5000)`
    );
  });

  test('generates IN clause', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [
          { field: '分类', op: 'in', value: ['餐饮', '交通', '购物'] },
        ],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE ("分类" IN ('餐饮', '交通', '购物'))`
    );
  });

  test('generates IS NULL', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '备注', op: 'is_null' }],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE ("备注" IS NULL)`
    );
  });

  test('generates IS NOT NULL', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '备注', op: 'is_not_null' }],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE ("备注" IS NOT NULL)`
    );
  });

  test('generates LIKE', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '商户', op: 'like', value: '%面%' }],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT * FROM transactions WHERE ("商户" LIKE '%面%')`
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/query/sql-generator.test.ts -t "WHERE"`
Expected: 7 new tests FAIL

- [ ] **Step 3: Add WHERE clause generation to SQLGenerator**

Add these imports at the top of `sql-generator.ts`:
```typescript
import { FilterGroup, FilterCondition } from './types';
```

Add into `generate()`, after the FROM line:
```typescript
    // WHERE
    if (q.filter) {
      parts.push(`WHERE ${this.buildFilterGroup(q.filter)}`);
    }
```

Add these private methods to the class:
```typescript
  private buildFilterGroup(group: FilterGroup): string {
    const clauses = group.conditions.map(c => {
      if ('logic' in c) {
        return this.buildFilterGroup(c as FilterGroup);
      }
      return this.buildCondition(c as FilterCondition);
    });
    const joiner = group.logic === 'and' ? ' AND ' : ' OR ';
    return `(${clauses.join(joiner)})`;
  }

  private buildCondition(cond: FilterCondition): string {
    switch (cond.op) {
      case 'is_null':
        return `"${cond.field}" IS NULL`;
      case 'is_not_null':
        return `"${cond.field}" IS NOT NULL`;
      case 'in':
        return `"${cond.field}" IN (${this.formatValues(cond.value)})`;
      case 'not_in':
        return `"${cond.field}" NOT IN (${this.formatValues(cond.value)})`;
      default:
        return `"${cond.field}" ${cond.op} ${this.formatValue(cond.value)}`;
    }
  }

  private formatValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private formatValues(values: any[]): string {
    return values.map(v => this.formatValue(v)).join(', ');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/query/sql-generator.test.ts`
Expected: All 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/query/sql-generator.ts src/query/sql-generator.test.ts
git commit -m "feat(query): add WHERE clause generation — FilterGroup → SQL"
```

---

## Task 5: SQL Generator — Aggregation & HAVING

**Files:**
- Modify: `src/query/sql-generator.ts`
- Modify: `src/query/sql-generator.test.ts` (add tests)

- [ ] **Step 1: Add failing tests for aggregation**

```typescript
// Append to src/query/sql-generator.test.ts

describe('SQLGenerator — Aggregation', () => {
  test('generates GROUP BY with aggregates', () => {
    const q: Query = {
      table: 'transactions',
      groupBy: ['分类'],
      aggregates: [
        { field: '金额', fn: 'sum', alias: 'total' },
        { field: '*', fn: 'count', alias: 'cnt' },
      ],
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT "分类", SUM("金额") AS "total", COUNT(*) AS "cnt" FROM transactions GROUP BY "分类"`
    );
  });

  test('generates HAVING clause', () => {
    const q: Query = {
      table: 'transactions',
      groupBy: ['分类'],
      aggregates: [
        { field: '金额', fn: 'sum', alias: 'total' },
      ],
      having: {
        logic: 'and',
        conditions: [{ field: 'total', op: '<', value: -10000 }],
      },
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT "分类", SUM("金额") AS "total" FROM transactions GROUP BY "分类" HAVING ("total" < -10000)`
    );
  });

  test('generates auto alias for aggregate without alias', () => {
    const q: Query = {
      table: 'transactions',
      groupBy: ['分类'],
      aggregates: [{ field: '金额', fn: 'avg' }],
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT "分类", AVG("金额") AS "avg_金额" FROM transactions GROUP BY "分类"`
    );
  });

  test('includes WHERE before GROUP BY', () => {
    const q: Query = {
      table: 'transactions',
      filter: {
        logic: 'and',
        conditions: [{ field: '金额', op: '<', value: 0 }],
      },
      groupBy: ['分类'],
      aggregates: [{ field: '金额', fn: 'sum', alias: 'total' }],
    };
    const result = generator.generate(q);
    expect(result.sql).toBe(
      `SELECT "分类", SUM("金额") AS "total" FROM transactions WHERE ("金额" < 0) GROUP BY "分类"`
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/query/sql-generator.test.ts -t "Aggregation"`
Expected: 4 new tests FAIL

- [ ] **Step 3: Add aggregation support to SQLGenerator**

Replace the `generate()` method in `sql-generator.ts`:

```typescript
  generate(q: Query): GeneratedSQL {
    const parts: string[] = [];
    const postProcess: PostProcess = {};

    // SELECT (with aggregates)
    if (q.aggregates && q.aggregates.length > 0) {
      const cols: string[] = [];

      if (q.groupBy) {
        cols.push(...q.groupBy.map(f => `"${f}"`));
      }

      for (const agg of q.aggregates) {
        const alias = agg.alias ?? `${agg.fn}_${agg.field.replace(/\*/g, 'star')}`;
        const expr = agg.field === '*'
          ? 'COUNT(*)'
          : `${agg.fn.toUpperCase()}("${agg.field}")`;
        cols.push(`${expr} AS "${alias}"`);
      }

      parts.push(`SELECT ${cols.join(', ')}`);
    } else if (q.select) {
      const cols = q.select.fields.map(f => `"${f}"`).join(', ');
      parts.push(`SELECT ${cols}`);
    } else {
      parts.push('SELECT *');
    }

    // FROM
    parts.push(`FROM ${q.table}`);

    // WHERE
    if (q.filter) {
      parts.push(`WHERE ${this.buildFilterGroup(q.filter)}`);
    }

    // GROUP BY
    if (q.groupBy && q.groupBy.length > 0) {
      const gbCols = q.groupBy.map(f => `"${f}"`).join(', ');
      parts.push(`GROUP BY ${gbCols}`);
    }

    // HAVING
    if (q.having) {
      parts.push(`HAVING ${this.buildFilterGroup(q.having)}`);
    }

    // ORDER BY
    if (q.sort && q.sort.length > 0) {
      const orderClauses = q.sort.map(
        s => `"${s.field}" ${s.dir.toUpperCase()}`
      );
      parts.push(`ORDER BY ${orderClauses.join(', ')}`);
    }

    // LIMIT / OFFSET
    if (q.limit !== undefined) {
      parts.push(`LIMIT ${q.limit}`);
    }
    if (q.offset !== undefined) {
      parts.push(`OFFSET ${q.offset}`);
    }

    return { sql: parts.join(' '), postProcess };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/query/sql-generator.test.ts`
Expected: All 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/query/sql-generator.ts src/query/sql-generator.test.ts
git commit -m "feat(query): add GROUP BY, aggregates, and HAVING to SQLGenerator"
```

---

## Task 6: ResultAssembler

**Files:**
- Create: `src/query/assembler.ts`
- Create: `src/query/assembler.test.ts`

- [ ] **Step 1: Write failing tests for ResultAssembler**

```typescript
// src/query/assembler.test.ts
import { ResultAssembler } from './assembler';
import { ColumnMeta, GeneratedSQL } from './types';

function mockSqlResult(columns: string[], rows: any[][]): any {
  return { columns, values: rows };
}

describe('ResultAssembler', () => {
  const assembler = new ResultAssembler();

  test('assembles basic result', () => {
    const sqlResult = mockSqlResult(
      ['日期', '金额', '分类'],
      [
        ['2024-06-01', -4500, '餐饮'],
        ['2024-06-02', -12800, '餐饮'],
      ]
    );
    const genSQL: GeneratedSQL = {
      sql: 'SELECT * FROM transactions',
      postProcess: {},
    };
    const columns: ColumnMeta[] = [
      { name: '日期', type: 'date', source: 'data' },
      { name: '金额', type: 'decimal', source: 'data' },
      { name: '分类', type: 'string', source: 'data' },
    ];

    const result = assembler.assemble(sqlResult, genSQL, columns, 156, null);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      '日期': '2024-06-01',
      '金额': '-45.00',
      '分类': '餐饮',
    });
    expect(result.total).toBe(156);
  });

  test('formats decimal values correctly', () => {
    const sqlResult = mockSqlResult(
      ['金额'],
      [[-4500], [0], [12899]]
    );
    const genSQL: GeneratedSQL = {
      sql: 'SELECT "金额" FROM transactions',
      postProcess: { decimalFields: [{ field: '金额', precision: 2 }] },
    };
    const columns: ColumnMeta[] = [
      { name: '金额', type: 'decimal', source: 'data' },
    ];

    const result = assembler.assemble(sqlResult, genSQL, columns, 3, null);

    expect(result.rows[0]['金额']).toBe('-45.00');
    expect(result.rows[1]['金额']).toBe('0.00');
    expect(result.rows[2]['金额']).toBe('128.99');
  });

  test('adds page info when limit is set', () => {
    const sqlResult = mockSqlResult(['x'], [['a'], ['b'], ['c']]);
    const genSQL: GeneratedSQL = { sql: '', postProcess: {} };
    const columns: ColumnMeta[] = [];

    const result = assembler.assemble(sqlResult, genSQL, columns, 100,
      { offset: 0, limit: 3 });

    expect(result.page).toEqual({ offset: 0, limit: 3, hasMore: true });
    expect(result.total).toBe(100);
  });

  test('sets hasMore false when on last page', () => {
    const sqlResult = mockSqlResult(['x'], [['a'], ['b']]);
    const genSQL: GeneratedSQL = { sql: '', postProcess: {} };
    const columns: ColumnMeta[] = [];

    const result = assembler.assemble(sqlResult, genSQL, columns, 2,
      { offset: 0, limit: 10 });

    expect(result.page).toEqual({ offset: 0, limit: 10, hasMore: false });
  });

  test('returns null page when no pagination', () => {
    const sqlResult = mockSqlResult(['x'], [['a']]);
    const genSQL: GeneratedSQL = { sql: '', postProcess: {} };
    const columns: ColumnMeta[] = [];

    const result = assembler.assemble(sqlResult, genSQL, columns, 1, null);

    expect(result.page).toBeNull();
  });

  test('formats decimal in aggregate results', () => {
    const sqlResult = mockSqlResult(
      ['分类', 'total'],
      [['餐饮', -57800], ['交通', -1650]]
    );
    const genSQL: GeneratedSQL = {
      sql: '',
      postProcess: { decimalFields: [{ field: 'total', precision: 2 }] },
    };
    const columns: ColumnMeta[] = [
      { name: '分类', type: 'string', source: 'data' },
      { name: 'total', type: 'decimal', source: 'aggregate', originalField: '金额' },
    ];

    const result = assembler.assemble(sqlResult, genSQL, columns, 2, null);

    expect(result.rows[0]['total']).toBe('-578.00');
    expect(result.rows[1]['total']).toBe('-16.50');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/query/assembler.test.ts`
Expected: All tests FAIL

- [ ] **Step 3: Implement ResultAssembler**

```typescript
// src/query/assembler.ts
import { ResultSet, ColumnMeta, GeneratedSQL, PageInfo } from './types';

interface SqlJsResult {
  columns: string[];
  values: any[][];
}

export class ResultAssembler {
  assemble(
    sqlResult: SqlJsResult,
    genSQL: GeneratedSQL,
    columns: ColumnMeta[],
    total: number,
    pageInfo: { offset: number; limit: number } | null,
  ): ResultSet {
    const decimalFields = new Map<string, number>();
    if (genSQL.postProcess.decimalFields) {
      for (const df of genSQL.postProcess.decimalFields) {
        decimalFields.set(df.field, df.precision);
      }
    }

    const rows: Record<string, any>[] = sqlResult.values.map(row => {
      const obj: Record<string, any> = {};
      sqlResult.columns.forEach((col, i) => {
        const val = row[i];
        const precision = decimalFields.get(col);
        if (precision !== undefined && typeof val === 'number') {
          obj[col] = this.formatDecimal(val, precision);
        } else {
          obj[col] = val;
        }
      });
      return obj;
    });

    let page: PageInfo | null = null;
    if (pageInfo) {
      page = {
        offset: pageInfo.offset,
        limit: pageInfo.limit,
        hasMore: pageInfo.offset + rows.length < total,
      };
    }

    return { rows, columns, total, page };
  }

  assembleWithRefs(
    sqlResult: SqlJsResult,
    genSQL: GeneratedSQL,
    columns: ColumnMeta[],
    total: number,
    pageInfo: { offset: number; limit: number } | null,
    refData: Map<string, Record<string, any>>,
  ): ResultSet {
    const resultSet = this.assemble(sqlResult, genSQL, columns, total, pageInfo);

    const followRefs = genSQL.postProcess.followRefs;
    if (!followRefs || followRefs.length === 0) return resultSet;

    for (const row of resultSet.rows) {
      for (const fr of followRefs) {
        const refValue = row[fr.field];
        const prefix = fr.prefix ?? fr.field;
        const include = fr.include ?? [];

        const targetRow = refData.get(String(refValue));

        if (targetRow && include.length > 0) {
          for (const col of include) {
            row[`${prefix}_${col}`] = targetRow[col] ?? null;
          }
        } else if (targetRow && include.length === 0) {
          for (const [key, val] of Object.entries(targetRow)) {
            row[`${prefix}_${key}`] = val;
          }
        } else {
          const followCols = columns.filter(
            c => c.source === 'ref_follow' && c.originalField === fr.field
          );
          for (const col of followCols) {
            if (col.name !== fr.field) {
              row[col.name] = null;
            }
          }
        }
      }
    }

    return resultSet;
  }

  private formatDecimal(intVal: number, precision: number): string {
    if (!Number.isInteger(intVal)) {
      return String(intVal);
    }
    const divisor = Math.pow(10, precision);
    return (intVal / divisor).toFixed(precision);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/query/assembler.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/query/assembler.ts src/query/assembler.test.ts
git commit -m "feat(query): add ResultAssembler — format decimal, build page info"
```

---

## Task 7: QueryEngine — Integration

**Files:**
- Create: `src/query/engine.ts`
- Create: `src/query/engine.test.ts`

- [ ] **Step 1: Write failing integration tests**

```typescript
// src/query/engine.test.ts
import { QueryEngine } from './engine';
import { Query, QueryErrorCode } from './types';
import { Schema } from '../schema/types';

function makeMockDb() {
  return {
    exec: jest.fn(),
    prepare: jest.fn(),
  };
}

const sampleSchema: Schema = {
  table: 'transactions',
  pk: ['日期', '金额', '商户'],
  fields: ['日期', '金额', '类型', '分类'],
  types: [
    { kind: 'date' },
    { kind: 'decimal', precision: 2 },
    { kind: 'enum', values: ['支出', '收入'] },
    { kind: 'string' },
  ] as any,
  required: [true, true, true, true],
  nullMarker: '-',
  strict: false,
};

function mockSchemaRegistry() {
  return { get: (t: string) => t === 'transactions' ? sampleSchema : null };
}

describe('QueryEngine', () => {
  let db: ReturnType<typeof makeMockDb>;
  let engine: QueryEngine;

  beforeEach(() => {
    db = makeMockDb();
    engine = new QueryEngine(db as any, mockSchemaRegistry());
  });

  test('returns TABLE_NOT_FOUND for missing table', () => {
    const q: Query = { table: 'nonexistent' };
    const result = engine.query(q);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.TABLE_NOT_FOUND);
    }
  });

  test('executes a simple query and returns ResultSet', () => {
    db.exec.mockReturnValue([{
      columns: ['日期', '金额'],
      values: [['2024-06-01', -4500]],
    }]);

    const q: Query = { table: 'transactions' };
    const result = engine.query(q);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rows).toHaveLength(1);
      expect(result.result.rows[0]['金额']).toBe('-45.00');
      expect(result.result.total).toBe(1);
    }
    expect(db.exec).toHaveBeenCalledWith(expect.stringContaining('SELECT'));
  });

  test('executes raw SQL via queryRaw', () => {
    db.exec.mockReturnValue([{
      columns: ['x'],
      values: [[1], [2], [3]],
    }]);

    const result = engine.queryRaw('SELECT * FROM txn WHERE amount > ?', [-5000]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rows).toHaveLength(3);
    }
  });

  test('returns SYNTAX_ERROR for invalid raw SQL', () => {
    db.prepare.mockImplementation(() => {
      throw new Error('syntax error');
    });

    const result = engine.queryRaw('BROKEN SQL!!!');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe(QueryErrorCode.SYNTAX_ERROR);
    }
  });

  test('computes total via COUNT(*) separately from data query', () => {
    db.exec
      .mockReturnValueOnce([{ columns: ['COUNT(*)'], values: [[156]] }])
      .mockReturnValueOnce([{ columns: ['日期'], values: [['2024-06-01']] }]);

    const q: Query = { table: 'transactions', limit: 1 };
    const result = engine.query(q);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.total).toBe(156);
    }
    expect(db.exec).toHaveBeenCalledTimes(2);
    expect(db.exec).toHaveBeenNthCalledWith(1, expect.stringContaining('COUNT(*)'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/query/engine.test.ts`
Expected: All tests FAIL

- [ ] **Step 3: Implement QueryEngine**

```typescript
// src/query/engine.ts
import {
  Query, ResultOrError, QueryErrorCode,
  ColumnMeta,
} from './types';
import { QueryValidator, SchemaRegistry } from './validator';
import { SQLGenerator, SchemaGetter } from './sql-generator';
import { ResultAssembler } from './assembler';

export interface SqlDatabase {
  exec(sql: string, params?: any[]): SqlJsQueryResult[];
  prepare(sql: string): SqlJsStatement;
}

interface SqlJsQueryResult {
  columns: string[];
  values: any[][];
}

interface SqlJsStatement {
  bind(params: any[]): void;
  step(): boolean;
  getAsObject(): Record<string, any>;
  free(): void;
}

export class QueryEngine {
  private validator: QueryValidator;
  private generator: SQLGenerator;
  private assembler: ResultAssembler;

  constructor(
    private db: SqlDatabase,
    schemaRegistry: SchemaRegistry,
  ) {
    const schemaGetter: SchemaGetter = (table: string) => {
      const s = schemaRegistry.get(table);
      if (!s) throw new Error(`Schema not found for table '${table}'`);
      return s;
    };

    this.validator = new QueryValidator(schemaRegistry);
    this.generator = new SQLGenerator(schemaGetter);
    this.assembler = new ResultAssembler();
  }

  query(q: Query): ResultOrError {
    // 1. Validate
    const validation = this.validator.validate(q);
    if (!validation.ok) {
      return validation;
    }

    // 2. Generate SQL
    const generated = this.generator.generate(q);

    // 3. Get total count (if paginated)
    let total = 0;
    if (q.limit !== undefined || q.offset !== undefined) {
      const countSQL = this.buildCountSQL(q);
      const countResult = this.db.exec(countSQL);
      if (countResult.length > 0 && countResult[0].values.length > 0) {
        total = Number(countResult[0].values[0][0]);
      }
    }

    // 4. Execute main query
    let sqlResult: SqlJsQueryResult;
    try {
      const results = this.db.exec(generated.sql);
      sqlResult = results.length > 0 ? results[0] : { columns: [], values: [] };
    } catch (err: any) {
      return {
        ok: false,
        errors: [{ code: QueryErrorCode.SYNTAX_ERROR, message: err.message }],
      };
    }

    // Set total from result if not paginated
    if (q.limit === undefined && q.offset === undefined) {
      total = sqlResult.values.length;
    }

    // 5. Build column metadata
    const columns = this.buildColumnMeta(q, sqlResult);

    // 6. Assemble
    const pageInfo = (q.limit !== undefined || q.offset !== undefined)
      ? { offset: q.offset ?? 0, limit: q.limit ?? sqlResult.values.length }
      : null;

    const resultSet = this.assembler.assemble(
      sqlResult, generated, columns, total, pageInfo
    );

    return { ok: true, result: resultSet };
  }

  queryRaw(sql: string, params?: any[]): ResultOrError {
    // Validate SQL syntax via prepare
    let stmt: SqlJsStatement;
    try {
      stmt = this.db.prepare(sql);
      stmt.free();
    } catch (err: any) {
      return {
        ok: false,
        errors: [{ code: QueryErrorCode.SYNTAX_ERROR, message: err.message }],
      };
    }

    // Execute
    try {
      const results = this.db.exec(sql, params);
      const sqlResult = results.length > 0
        ? results[0]
        : { columns: [], values: [] };

      const columns: ColumnMeta[] = sqlResult.columns.map(name => ({
        name,
        type: 'string',
        source: 'data' as const,
      }));

      const resultSet = this.assembler.assemble(
        sqlResult,
        { sql, postProcess: {} },
        columns,
        sqlResult.values.length,
        null,
      );

      return { ok: true, result: resultSet };
    } catch (err: any) {
      return {
        ok: false,
        errors: [{ code: QueryErrorCode.SYNTAX_ERROR, message: err.message }],
      };
    }
  }

  private buildCountSQL(q: Query): string {
    let sql = `SELECT COUNT(*) FROM ${q.table}`;
    if (q.filter) {
      const generated = this.generator.generate({
        table: q.table,
        filter: q.filter,
      });
      const whereIdx = generated.sql.indexOf('WHERE');
      if (whereIdx >= 0) {
        sql += ' ' + generated.sql.slice(whereIdx);
      }
    }
    return sql;
  }

  private buildColumnMeta(
    q: Query,
    sqlResult: SqlJsQueryResult,
  ): ColumnMeta[] {
    return sqlResult.columns.map(name => {
      const col: ColumnMeta = {
        name,
        type: 'string',
        source: 'data',
      };

      if (q.aggregates) {
        for (const agg of q.aggregates) {
          const alias = agg.alias
            ?? `${agg.fn}_${agg.field.replace(/\*/g, 'star')}`;
          if (alias === name) {
            col.source = 'aggregate';
            col.originalField = agg.field === '*' ? undefined : agg.field;
          }
        }
      }

      return col;
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/query/engine.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/query/engine.ts src/query/engine.test.ts
git commit -m "feat(query): add QueryEngine — Validator → Generator → Assembler pipeline"
```

---

## Plan Summary

| Task | Component | Files | Tests |
|------|-----------|-------|-------|
| 1 | Types | `src/query/types.ts` | — |
| 2 | Validator | `src/query/validator.ts` | 13 |
| 3 | SQL Generator (basic) | `src/query/sql-generator.ts` | 5 |
| 4 | SQL Generator (WHERE) | *(same)* | +7 |
| 5 | SQL Generator (aggregation) | *(same)* | +4 |
| 6 | ResultAssembler | `src/query/assembler.ts` | 6 |
| 7 | QueryEngine integration | `src/query/engine.ts` | 5 |

**Total: 7 tasks, 40 tests, 6 source files, 4 test files**
