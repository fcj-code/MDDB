# Query Engine Implementation Plan

> **状态：✅ 全部完成（2026-06-13）**
>
> 所有 7 个任务已完成。详见下方实现总结。

**Goal:** Implement the MD-DB query engine — translate structured Query objects to SQL, execute against in-memory SQLite, and return standardized ResultSets.

**Architecture:** Three-stage pipeline: QueryValidator (structural validation) → SQLGenerator (Query → SQL + post-processing instructions) → ResultAssembler (sql.js results → ResultSet with decimal formatting and ref following). Exposed via a single `QueryEngine` class with `query()` and `queryRaw()` methods.

**Tech Stack:** TypeScript, sql.js (WASM SQLite), vitest (mocked Obsidian API)

**Spec:** `docs/specs/2026-06-10-query-engine-design.md`

---

## 实现后的实际文件结构

```
src/query/
├── types.ts                 # All type definitions            ✅
├── validator.ts             # QueryValidator — structural validation ✅
├── sql-generator.ts         # SQLGenerator — Query → SQL string ✅
├── sql-generator.test.ts    # Tests for SQL generator          ✅ (12 tests)
├── assembler.ts             # ResultAssembler — raw results → ResultSet ✅
├── engine.ts                # QueryEngine — top-level API      ✅
```

> **注意**：测试文件 `validator.test.ts`、`assembler.test.ts`、`engine.test.ts` 在原计划中被创建但后来移除了。实际现有的测试文件只有 `sql-generator.test.ts`（12 tests）。

---

## 实现状态

### Task 1: Type Definitions ✅

| 步骤 | 状态 |
|------|:----:|
| Step 1: Write all type definitions | ✅ |
| Step 2: Verify TypeScript compiles | ✅ |
| Step 3: Commit | ✅ |

**文件：** `src/query/types.ts`

**实际类型设计与计划的偏差：**

| 类型 | 计划（设计文档） | 实际实现 | 说明 |
|------|---------------|---------|------|
| `Query.where` | `filter?: FilterGroup` | `where?: FilterGroup` | 字段名改为 `where` |
| `Query.followRefs` | `FollowRefClause[]` | `RefFollow[]` | 接口名和结构不同 |
| `FilterGroup.logic` | `'and' \| 'or'` | `operator: 'AND' \| 'OR'` | 字段名改为 `operator`，值大写 |
| `FilterCondition` | `{ field, op, value }` | `SimpleFilter` | 接口名不同 |
| `FilterOp` | `'=' \| '!=' \| '>' \| ...` | `'eq' \| 'neq' \| 'gt' \| ...` | 操作符改为英文缩写 |
| `SelectClause.fields` | `string[]` | `columns: string[]` | 字段名改为 `columns` |
| `SortClause.dir` | `'asc' \| 'desc'` | `direction: 'ASC' \| 'DESC'` | 字段名和值都不同 |
| `AggregateClause` | `{ field, fn, alias }` | `AggregateOp` + 包裹结构 | 聚合改为 `{ operations: [...] }` |
| `ResultSet` | `{ rows, columns, total, page }` | `{ rows, columns, total, returned, page?, ... }` | 增加 `returned`、`pageSize`、`totalPages`、`queryInfo` |

### Task 2: QueryValidator ✅

| 步骤 | 状态 |
|------|:----:|
| Step 1: Write the failing tests | ✅ (原 `validator.test.ts` 已移除) |
| Step 2: Run tests to verify they fail | ✅ |
| Step 3: Implement QueryValidator | ✅ |
| Step 4: Run tests to verify they pass | ✅ |
| Step 5: Commit | ✅ |

**文件：** `src/query/validator.ts`

**与计划的主要差异：**
- 从 class 改为纯函数 `validateQuery(query, validFields)` 导出
- 不再使用 `SchemaRegistry` 接口，而是接收 `validFields?: string[]` 参数
- 宽松模式：只报告问题，不阻止执行
- 验证规则比计划少（不检查操作符类型兼容性）

### Task 3-5: SQLGenerator ✅

| 步骤 | 状态 |
|------|:----:|
| Create `sql-generator.ts` | ✅ |
| Create `sql-generator.test.ts` | ✅ (12 tests) |
| Basic SELECT, ORDER BY, LIMIT | ✅ |
| WHERE clause (FilterGroups) | ✅ |
| Aggregation & HAVING | ✅ |

**文件：** `src/query/sql-generator.ts`、`src/query/sql-generator.test.ts`

**与计划的主要差异：**
- 使用参数化查询（`?` placeholder + params array）而非值内联
- 默认 `LIMIT 200`，最大 `LIMIT 5000`（`DEFAULT_LIMIT` / `MAX_LIMIT`）
- 支持 `DISTINCT` 选择
- 通过 `SchemaRegistryStore` 间接依赖 Schema，而非直接接收 Schema getter
- 测试使用 `IdentifierMode` 而非直接 SQL 字符串比较

### Task 6: ResultAssembler ✅

| 步骤 | 状态 |
|------|:----:|
| Write failing tests | ✅ (原 `assembler.test.ts` 已移除) |
| Implement ResultAssembler | ✅ |
| Run tests to verify | ✅ |
| Commit | ✅ |

**文件：** `src/query/assembler.ts`

**与计划的主要差异：**
- API 更简单：`assemble(columns, rows, query, typeMap)` 而非接收 `GeneratedSQL` + `PostProcess`
- decimal 格式化通过 `parse/converter.ts` 的 `formatDisplayValue` 实现
- ref 跟随实现在 `QueryEngine.executeRefFollow` 而非 `assembleWithRefs`

### Task 7: QueryEngine Integration ✅

| 步骤 | 状态 |
|------|:----:|
| Write failing integration tests | ✅ (原 `engine.test.ts` 已移除) |
| Implement QueryEngine | ✅ |
| Run tests to verify | ✅ |
| Commit | ✅ |

**文件：** `src/query/engine.ts`

**与计划的主要差异：**
- 依赖 `SQLiteAdapter` + `SchemaRegistryStore` 而非简单 `SqlDatabase` 接口
- `queryRaw()` 支持 `RawQueryOptions`（readonly 检查、系统表保护）
- 分页 metadata 更丰富：`page`、`pageSize`、`totalPages`、`returned`、`queryInfo`
- ref 跟随通过 `executeRefFollow` 私有方法实现，使用两步查询 + 内存 hash map
- 集成了 SQL 安全检查（禁止 DML、禁止多语句、禁止系统表）

---

## 集成点（实际实现）

查询引擎通过 `MDDBEngine` facade 与系统集成：

```
┌─────────────────────────────────────────────────────┐
│                    MDDBEngine                        │
│  (src/engine/engine.ts)                              │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │              QueryEngine                      │   │
│  │  (src/query/engine.ts)                        │   │
│  │                                               │   │
│  │  SQLiteAdapter ← 注入到构造函数               │   │
│  │  SchemaRegistryStore.getTable(table).schema   │   │
│  │  .fields → validFields 传给 validator         │   │
│  │  .types → typeMap 传给 assembler              │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  MDDBEngine.query(q) → this.queryEngine.query(q)     │
│  MDDBEngine.queryRaw(sql, params) → ...queryRaw()   │
└─────────────────────────────────────────────────────┘
```

---

## 测试现状

| 文件 | 测试数 | 状态 |
|------|:-----:|:----:|
| `src/query/sql-generator.test.ts` | 12 | ✅ 全部通过 |

> `validator.test.ts`、`assembler.test.ts`、`engine.test.ts` 在原计划中被创建但后来从工作树中移除。

---

## 后续工作

- [ ] Ref 跟随的实际集成测试（需要跨表 Schema + BindingStore）
- [ ] DQL 用户语法解析器
- [ ] 查询缓存
- [ ] 慢查询日志
- [ ] 计算列/表达式
- [ ] 补齐 validator / assembler / engine 的单元测试
