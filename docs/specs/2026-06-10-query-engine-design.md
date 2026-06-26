# MD-DB 查询引擎设计文档 v1.0

> 日期：2026-06-10
> 状态：**已实现** — 查询引擎完整实现（2026-06-13 更新）
> 依赖：`2026-06-10-storage-engine-design.md`（存储引擎）、`2026-06-10-parse-pipeline-design.md`（解析管道）
> 实现：`Obsidian-mddb/src/query/` — types.ts / validator.ts / sql-generator.ts / assembler.ts / engine.ts
> SQLite 适配器：`Obsidian-mddb/src/storage/sqlite-adapter.ts`
> 启动集成：`Obsidian-mddb/src/main.ts`（MDDBPlugin.onload）+ `Obsidian-mddb/src/engine/engine.ts`（MDDBEngine.initialize）

---

## 一、设计概述

### 1.1 核心定位

查询引擎是存储引擎与视图层之间的中间层，负责将结构化查询请求翻译为 SQL 并执行，返回标准化的结果集。

### 1.2 用户与入口

| 用户 | 入口 | 优先级 |
|------|------|:---:|
| 视图层（表格/看板组件） | `QueryEngine.query(q: Query)` — 结构化查询对象 | **当前** |
| 终端用户（笔记作者） | DQL 语法 — 嵌入 Markdown 查询代码块 | 远期 |

当前设计聚焦于视图层的编程接口。DQL 用户语法为远期扩展。

### 1.3 架构位置

```
┌──────────────────────────────────────────────┐
│                  视图层                        │
│       Query Object → query() → ResultSet       │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│              查询引擎 (本次设计)                 │
│  ┌──────────┬───────────┬──────────────────┐  │
│  │ Query    │ SQL       │ Result           │  │
│  │ Validator│ Generator │ Assembler        │  │
│  └──────────┴───────────┴──────────────────┘  │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│            存储引擎（已设计）                     │
│  内存 SQLite + 绑定表 + 用户表                   │
└──────────────────────────────────────────────┘
```

---

## 二、API 设计

### 2.1 抽象层次：结构化查询对象 (C) + Raw SQL 兜底 (A)

视图层 90% 的日常查询使用结构化查询对象，10% 的复杂查询走原生 SQL escape hatch。

### 2.2 顶层接口

```typescript
interface QueryEngine {
  /** 结构化查询入口 */
  query(q: Query): ResultOrError;

  /** Raw SQL escape hatch — 复杂查询（JOIN、子查询、窗口函数）的兜底入口 */
  queryRaw(sql: string, params?: any[]): ResultOrError;
}

type ResultOrError =
  | { ok: true; result: ResultSet }
  | { ok: false; errors: QueryError[] };
```

### 2.3 执行模型

同步执行。数据在内存 SQLite（sql.js/WASM），单表数据量在千行级别，sql.js 同步调用耗时 < 5ms。未来若出现万行级慢查询，可追加 `queryAsync()` 不破坏现有 API。

---

## 三、查询对象 (Query)

### 3.1 核心结构

```typescript
interface Query {
  table: string;                    // 表名，必填
  select?: SelectClause;            // 选择哪些列，默认全部
  filter?: FilterGroup;             // WHERE 条件，默认无
  sort?: SortClause[];              // ORDER BY，默认按 @sort 或写入时序
  limit?: number;                   // 返回行数上限
  offset?: number;                  // 偏移量
  groupBy?: string[];               // GROUP BY 列名列表
  having?: FilterGroup;             // HAVING 条件（配合 groupBy）
  aggregates?: AggregateClause[];   // 聚合函数
  followRefs?: FollowRefClause[];   // ref 字段跟随展开
}
```

> **注意**：raw SQL 走独立方法 `queryRaw()`，Query 对象无 `raw` 字段。保持类型语义统一。

### 3.2 表达能力边界

| 场景 | 入口 | 说明 |
|------|------|------|
| 单表 + 等值过滤 + 排序 + 分页 | `Query` 结构化 | 最常见 |
| 多条件组合（AND/OR 嵌套） | `Query.filter` (FilterGroup) | 递归树结构 |
| 聚合：COUNT/SUM/AVG，按列 GROUP BY | `Query.aggregates` + `groupBy` | — |
| 跨表关联（ref 类型字段跟随） | `Query.followRefs` | 一等公民支持 |
| 两表 JOIN | `queryRaw()` | SQL escape hatch |
| 子查询 / 窗口函数 | `queryRaw()` | SQL escape hatch |

---

## 四、过滤模型 (FilterGroup)

### 4.1 结构

```typescript
/** 简单过滤条件 */
interface SimpleFilter {
  field: string;                    // 列名
  op: FilterOp;                     // 操作符
  value?: unknown;                  // 值（isNull / isNotNull 不需要）
}

/** 操作符 */
type FilterOp =
  | 'eq' | 'neq'                    // 相等/不等
  | 'gt' | 'gte' | 'lt' | 'lte'    // 比较
  | 'like' | 'notLike'              // 模糊匹配
  | 'in' | 'notIn'                  // 集合
  | 'isNull' | 'isNotNull';         // 空值判断

/** 条件 = 简单条件 | 嵌套组 */
type FilterCondition = FilterGroup | SimpleFilter;

/** 条件组——递归树结构，表达 AND/OR 嵌套 */
interface FilterGroup {
  operator: 'AND' | 'OR';                    // 组内条件的逻辑关系（大写）
  conditions: FilterCondition[];
}
```

### 4.2 示例

**简单过滤：**

```typescript
// WHERE 分类 = '餐饮' AND 金额 < -50
{
  operator: 'AND',
  conditions: [
    { field: '分类', op: 'eq', value: '餐饮' },
    { field: '金额', op: 'lt', value: -5000 }     // decimal 存整数（分）
  ]
}
```

**嵌套条件：**

```typescript
// WHERE (分类 = '餐饮' OR 分类 = '交通') AND 金额 < -50
{
  operator: 'AND',
  conditions: [
    {
      operator: 'OR',
      conditions: [
        { field: '分类', op: 'eq', value: '餐饮' },
        { field: '分类', op: 'eq', value: '交通' }
      ]
    },
    { field: '金额', op: 'lt', value: -5000 }
  ]
}
```

**操作符对照表：**

| 操作符 | 含义 | SQL 映射 |
|--------|------|----------|
| `eq` | 等于 | `=` |
| `neq` | 不等于 | `!=` |
| `gt` | 大于 | `>` |
| `gte` | 大于等于 | `>=` |
| `lt` | 小于 | `<` |
| `lte` | 小于等于 | `<=` |
| `like` | 模糊匹配 | `LIKE` |
| `notLike` | 模糊不匹配 | `NOT LIKE` |
| `in` | 集合包含 | `IN (...)` |
| `notIn` | 集合不包含 | `NOT IN (...)` |
| `isNull` | 为空 | `IS NULL` |
| `isNotNull` | 不为空 | `IS NOT NULL` |

### 4.3 SQL 生成规则

递归遍历树：
- `operator: 'AND'` → `AND` 连接
- `operator: 'OR'` → `OR` 连接
- 每个 `FilterGroup` 加括号包裹
- 所有值通过参数化 `?` 绑定，防止 SQL 注入

---

## 五、选择与排序

### 5.1 选择列 (SelectClause)

```typescript
interface SelectClause {
  columns: string[];                // 要返回的列名列表（字段名为 columns 而非 fields）
  distinct?: boolean;               // 是否 DISTINCT 去重
}
```

- 不指定 → 返回全部列
- `groupBy` 查询中，非聚合列必须在 `groupBy` 中出现（标准 SQL 语义）
- 有 `followRefs` 且未指定 `select` 时，展开列自动追加

### 5.2 排序 (SortClause)

```typescript
interface SortClause {
  field: string;                   // 列名
  direction: 'ASC' | 'DESC';      // 字段名为 direction 而非 dir
}
```

**默认排序优先级**：
1. Query 中指定的 `sort`
2. Schema 中声明的 `@sort`
3. 写入时序（`_binding.line_number`）

---

## 六、聚合

### 6.1 结构

```typescript
interface AggregateClause {
  operations: AggregateOp[];       // 聚合操作列表（实际为对象而非数组）
}

type AggregateOp =
  | { type: 'COUNT'; field?: string; alias?: string }
  | { type: 'SUM'; field: string; alias?: string }
  | { type: 'AVG'; field: string; alias?: string }
  | { type: 'MIN'; field: string; alias?: string }
  | { type: 'MAX'; field: string; alias?: string };
```

### 6.2 示例

```typescript
// SELECT 分类, SUM(金额) as total, COUNT(*) as cnt
// FROM transactions WHERE 金额 < 0
// GROUP BY 分类 HAVING total < -10000

const q: Query = {
  table: 'transactions',
  where: { operator: 'AND', conditions: [
    { field: '金额', op: 'lt', value: 0 }
  ]},
  groupBy: ['分类'],
  aggregates: {
    operations: [
      { type: 'SUM', field: '金额', alias: 'total' },
      { type: 'COUNT', alias: 'cnt' }
    ]
  },
  having: {
    operator: 'AND',
    conditions: [
      { field: 'total', op: 'lt', value: -10000 }   // 引用 aggregate alias
    ]
  }
};
```

**注意**：
- `groupBy` 只声明列名，不需要表达式
- `having` 复用 `FilterGroup`，条件中的 `field` 可以是聚合的 `alias`
- `having` 也可以引用原始列名（标准 SQL 行为）

---

## 七、Ref 跟随展开 (FollowRefClause)

### 7.1 设计

MD-DB 中 `ref(table)` 类型字段存储目标表的 logical_pk 值。查询时，`followRefs` 将关联记录展开为附加列，避免视图层手动二次查询。

### 7.2 结构

```typescript
interface RefFollow {
  field: string;              // 当前表中的 ref 字段名，如 '账户'
  select: string[];           // 目标表的列名（字段名为 select 而非 include）
  alias?: string;             // 结果列前缀，默认 `${field}.`（而非目标表名）
}
```

### 7.3 示例

```typescript
// 查询交易记录，展开关联账户信息
const q: Query = {
  table: 'transactions',
  where: { operator: 'AND', conditions: [
    { field: '日期', op: 'gte', value: '2024-06-01' }
  ]},
  sort: [{ field: '日期', direction: 'ASC' }],
  followRefs: [
    { field: '账户', select: ['账户名', '类型'], alias: 'acc' }
  ],
  limit: 20
};
```

**返回效果**：

```json
{
  "columns": [
    { "name": "日期", "type": "date", "source": "data" },
    { "name": "金额", "type": "decimal", "source": "data" },
    { "name": "账户", "type": "ref", "source": "data" },
    { "name": "acc_账户名", "type": "string", "source": "ref_follow" },
    { "name": "acc_类型", "type": "string", "source": "ref_follow" }
  ],
  "rows": [
    {
      "日期": "2024-06-01",
      "金额": "-45.00",
      "账户": "现金",
      "acc_账户名": "现金钱包",
      "acc_类型": "流动资产"
    }
  ]
}
```

### 7.4 执行策略：两步查询

```
Step 1: SELECT * FROM transactions WHERE 日期 >= '2024-06-01' LIMIT 20
        → 得到主结果集，收集 ref 字段值集合

Step 2: SELECT storage_pk, logical_pk, 账户名, 类型
        FROM accounts WHERE logical_pk IN (vk1, vk2, ...)
        → 内存 hash map 映射 → 按 prefix 展开到每行
```

> **不使用 SQL JOIN**：数据可能跨文件，绑定表解析比 JOIN 更可靠。ref 跟随是"应用层关联"。

### 7.5 边缘情况

| 场景 | 行为 |
|------|------|
| 引用目标存在 | 展开列填充目标表的值 |
| 引用目标不存在（断裂引用） | 展开列值为 NULL，不报错 |
| ref 字段本身为 NULL | 展开列全部 NULL |
| 目标表未加载 | 延迟加载目标表后重试展开，或全部 NULL + warning |

---

## 八、结果集 (ResultSet)

### 8.1 结构

```typescript
interface ResultSet {
  rows: Record<string, any>[];     // 数据行
  columns: ColumnMeta[];           // 列元信息
  total: number;                   // 总行数（不受 limit/offset 影响）
  returned: number;                // 实际返回行数
  page?: number;                   // 当前页码（1-based）
  pageSize?: number;               // 每页行数
  totalPages?: number;             // 总页数
  queryInfo?: {                    // 查询执行信息
    table: string;
    hasMore: boolean;
    durationMs?: number;
  };
}

interface ColumnMeta {
  name: string;                    // 列名
  type: FieldType;                 // 类型表达式，如 'decimal(2)'、'string'
  label?: string;                  // 显示标签
  width?: number;                  // 列宽（视图层设置）
  align?: 'left' | 'center' | 'right';
}

// 实际 FieldType 为 string 别名（完整类型表达式）
// 如 "decimal(2)"、"enum(支出,收入)"、"ref(categories)"
export type FieldType = string;
```

### 8.2 示例

```json
{
  "columns": [
    { "name": "日期", "type": "date" },
    { "name": "金额", "type": "decimal(2)" },
    { "name": "total", "type": "decimal(2)" },
    { "name": "acc.账户名", "type": "string" }
  ],
  "rows": [
    { "日期": "2024-06-01", "金额": "-45.00", "acc.账户名": "现金钱包" },
    { "日期": "2024-06-02", "金额": "-128.00", "acc.账户名": "微信零钱" }
  ],
  "total": 156,
  "returned": 2,
  "page": 1,
  "pageSize": 200,
  "totalPages": 1,
  "queryInfo": { "table": "transactions", "hasMore": false, "durationMs": 3 }
}
```

> **注意**：ref follow 展开列的前缀分隔符为 `.`（如 `acc.账户名`），而非设计文档中的 `_`。

### 8.3 Decimal 显示

引擎内部 decimal(N) 存为 BIGINT（整数，单位为 10^-N）：

```
存储: -1650（分）
ResultSet: "-16.50"（自动格式化）
```

视图层始终看到格式化后的字符串，无感知精度细节。

---

## 九、查询验证

### 9.1 验证模块

`QueryValidator` 在 SQL 生成前同步检查，验证失败返回 `{ ok: false, errors }`，不触达 SQLite。

### 9.2 错误类型

```typescript
// 实际实现为宽松验证，返回错误字符串数组
interface QueryValidationResult {
  valid: boolean;
  errors: string[];
}
```

### 9.3 验证规则

| # | 检查项 | 触发条件 | 说明 |
|---|--------|---------|------|
| 1 | 表名存在 | SchemaRegistry 中无此 `@table` 声明（在 engine.ts 中查，不在 validator 中） | `TABLE_NOT_FOUND` |
| 2 | 列名有效 | `where`/`sort`/`select`/`groupBy` 中的 `field` 不在 Schema 中 | `FIELD_NOT_FOUND` |
| 3 | 操作符有效 | `op` 不在 `eq/neq/gt/gte/lt/lte/like/notLike/in/notIn/isNull/isNotNull` 中 | `INVALID_OPERATOR` |
| 4 | 操作符与值兼容 | `in/notIn` 需要 `value` 为数组，`isNull/isNotNull` 不需要 `value` | `INVALID_VALUE_TYPE` |
| 5 | 分页合理性 | `limit` / `offset` 不能为负数 | 检查不阻止执行 |
| 6 | 聚合操作字段 | `aggregates.operations[].field` 不在 Schema 中 | 宽松警告 |
| 7 | SQL 语法合法 | `queryRaw()` 的 SQL 在 sql.js prepare 阶段失败 | `RAW_QUERY_ERROR` |

**宽松原则**：验证只检查结构合法性。WHERE 条件运行时匹配不到行是正常结果，不是错误。

---

## 十、边缘情况

| 场景 | 行为 |
|------|------|
| 表不存在 | 验证阶段返回 `TABLE_NOT_FOUND` error |
| 表存在但为空（0 行） | 正常返回 `{ rows: [], total: 0, columns: [...] }` |
| filter 匹配 0 行 | 正常返回 `{ rows: [], total: 0 }`，不是 error |
| `limit=0` | 返回空 rows + total + `hasMore: true/false` |
| `offset >= total` | 返回空 rows + total 不变 + `hasMore: false` |
| ref 跟随的目标表不存在 | 该字段展开列全 NULL，warning 记录到日志 |
| decimal 格式化异常 | 内部整数无法格式化 → 返回原始整数值 + warning |
| raw SQL 语法错误 | sql.js 抛异常 → 捕获 → 返回 `SYNTAX_ERROR` |

---

## 十一、SQL 生成规范

### 11.1 类型映射（SQLite 运行时值）

| Query 中的 value 类型 | 生成的 SQL 字面量 |
|----------------------|------------------|
| `string` | `'value'`（单引号转义） |
| `number`（integer） | `42` |
| `number`（decimal） | 内部整数值，如 `4500` |
| `boolean` | `1` / `0` |
| `null` | `NULL` |
| `any[]`（in/not_in） | `('a', 'b', 'c')` |

### 11.2 参数化（queryRaw 专用）

`queryRaw(sql, params)` 使用 sql.js 的 prepared statement：

```typescript
const stmt = db.prepare("SELECT * FROM txn WHERE amount > ? AND category = ?");
stmt.bind([-5000, '餐饮']);
```

`query(q)` 不需要 params —— 结构化对象已防注入，值直接嵌入生成 SQL。

---

## 十二、模块职责

| 模块 | 输入 | 输出 | 职责 |
|------|------|------|------|
| **QueryValidator** | `Query` 对象 + Schema 注册表 | 验证后的 `Query` 或 `QueryError[]` | 检查表/列存在、操作符兼容、类型匹配 |
| **SQLGenerator** | 已验证的 `Query` | SQL 字符串 + 后处理指令 | 递归遍历 FilterGroup → WHERE 子句；生成聚合/排序/分页/ref 查值 |
| **ResultAssembler** | sql.js 执行结果 + 列元信息 + 后处理指令 | `ResultSet` | 构建 ColumnMeta；执行 ref 跟随 Step 2；decimal 格式化 |

---

## 十三、决策记录

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 主要用户 | 视图层（B），终端用户 DQL 远期 |
| 2 | API 抽象层次 | 结构化查询对象 (C) + raw SQL escape hatch (A) |
| 3 | 查询对象表达能力边界 | 单表/过滤/聚合/ref跟随 ∈ C；JOIN/子查询/窗口函数 ∈ raw SQL |
| 4 | 结果格式 | ResultSet `{ rows, columns, total, page, pageSize, totalPages, queryInfo }` |
| 5 | 执行模型 | 同步，未来按需加异步 |
| 6 | 过滤模型 | 递归 FilterGroup（AND/OR 树）+ 12 种操作符（operator 大写） |
| 7 | 聚合模型 | groupBy + aggregates{ operations[] } + having（复用 FilterGroup） |
| 8 | ref 跟随 | 两步查询，不破坏原始 ref 值，断裂不报错 |
| 9 | raw SQL 入口 | 独立方法 `queryRaw(sql, params)` |
| 10 | 参数化查询 | `query()` 使用 `?` 参数化绑定，`queryRaw()` 同样参数化 |
| 11 | 验证策略 | 宽松验证——只查结构合法性，不阻止执行 |
| 12 | 模块架构 | QueryValidator → SQLGenerator → ResultAssembler |
| 13 | SelectClause | `{ columns: string[], distinct?: boolean }` |
| 14 | SortClause | `{ field, direction: 'ASC'|'DESC' }`，支持单字段或多字段数组 |
| 15 | decimal 显示 | 引擎内部 BIGINT → ResultSet 格式化字符串，视图层无感知 |
| 16 | 边缘情况 | 空表/无匹配/越界=正常空结果；ref 断裂=NULL+warning |
| 17 | 默认 LIMIT | 200（最大 5000） |

---

## 十四、与已有设计文档的关系

| 已有文档 | 本文档关联 |
|---------|-----------|
| `storage-engine-design.md` §4（CRUD） | 查询引擎替代 SELECT 部分的自由 SQL |
| `storage-engine-design.md` §2（三层 PK） | ref 跟随依赖 storage_pk → logical_pk 映射 |
| `parse-pipeline-design.md` §4（类型转换） | decimal 格式化依赖类型系统精度信息 |
| `parse-pipeline-design.md` §2（Schema） | 查询验证依赖 Schema 注册表 |
| `implementation-roadmap.md` Phase 15 | **本文档即为该项的完整设计** |

---

## 十五、实现状态（2026-06-13 更新）

### 15.1 实现清单

| 模块 | 文件 | 状态 | 说明 |
|------|------|:----:|------|
| Type Definitions | `Obsidian-mddb/src/query/types.ts` | ✅ 完成 | 所有类型定义（Query / FilterGroup / AggregateClause / ResultSet / ...） |
| QueryValidator | `Obsidian-mddb/src/query/validator.ts` | ✅ 完成 | 宽松验证规则：字段存在、操作符合法性、分页合理性 |
| SQLGenerator | `Obsidian-mddb/src/query/sql-generator.ts` | ✅ 完成 | SELECT / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT-OFFSET / 聚合 / ref follow |
| ResultAssembler | `Obsidian-mddb/src/query/assembler.ts` | ✅ 完成 | decimal 格式化、类型映射、行对象构建 |
| QueryEngine | `Obsidian-mddb/src/query/engine.ts` | ✅ 完成 | Validator → Generator → Assembler 管道、COUNT(*) 分页计数、raw SQL、ref follow |
| 测试 | `Obsidian-mddb/src/query/*.test.ts` | ✅ 完成 | validator(13) + sql-generator(16) + assembler(6) + engine(5) = 40 tests |

### 15.2 与设计的偏差

| 设计项 | 设计文档 | 实际实现 | 说明 |
|--------|---------|---------|------|
| `SchemaRegistry` 访问方式 | 假设从 schema 模块导入 | `SchemaRegistryStore.getSchema(table)` 直接获取 | 实际通过 SchemaRegistryStore 实例注入 QueryEngine |
| `FilterGroup` 字段名 | 设计文档使用 `filter` 字段 | 实际实现使用 `where` 字段 | 类型定义中过滤条件字段名为 `where` 而非 `filter` |
| 测试框架 | 未指定 | vitest | 与项目现有工具链一致 |
| 路径前缀 | `src/` | `Obsidian-mddb/src/` | 代码位于 Obsidian-mddb 子目录 |

### 15.3 集成点

查询引擎通过以下接口与系统其他部分集成：

```
┌─────────────────────────────────────────────────────────┐
│                    QueryEngine                           │
│                                                         │
│  SchemaRegistry ←── SchemaRegistryStore.getSchema(table)│
│  (Obsidian-mddb/src/storage/schema-registry.ts)          │
│                                                         │
│  SqlDatabase  ←── SQLiteAdapter (sql.js WASM SQLite)    │
│  (Obsidian-mddb/src/storage/sqlite-adapter.ts)           │
│                                                         │
│  SchemaGetter ←── SchemaRegistryStore.get(table)         │
│  (sql-generator.ts 中定义)                                │
└─────────────────────────────────────────────────────────┘
```

**启动集成**（通过 `MDDBEngine`，`Obsidian-mddb/src/engine/engine.ts`）：

QueryEngine 在 MDDBEngine 构造函数中创建，通过 `engine.initialize()` 初始化。MDDBEngine 是顶层 facade，视图层通过 `getEngine()` 全局函数或 `MDDBPlugin.engine` 属性访问。

```
MDDBPlugin.onload 执行顺序 (Obsidian-mddb/src/main.ts):
  1. 创建 MDDBEngine(fileOperator, settings)
     └─ 构造函数内创建 SQLiteAdapter / BindingStore / SchemaRegistryStore / QueryEngine 等子组件
     └─ QueryEngine(this.sqlite, this.schemaRegistry, identMode, maxQueryRows)

  2. engine.initialize(initSqlJsWithWasm, pluginVersion)
     └─ SQLiteAdapter.initialize()     ── sql.js WASM 初始化
     └─ BindingStore.initialize()       ── 创建 _binding 表 + 索引
     └─ Cache manifest 检查 + 迁移
     └─ WAL 重放（冷启动恢复）
     └─ 标记 ready → UI 可用
     └─ 启动后台校验 + 重试调度

  3. 视图集成 + 代码块处理器注册
     └─ TableViewModel / KanbanViewModel 通过 this.engine.query() 调用
```

**存储引擎设计文档关联**：
- Storage Engine Design §8（冷启动）：MDDBEngine.initialize() 实现了完整的"阶段 1: 阻塞启动"（SQLite init + cache manifest 检查 + WAL 重放）；"阶段 2: 后台验证"由 RescanScheduler 在空闲时触发。
- Storage Engine Design §4.4（SELECT 查询）：query() 全部在内存 SQLite 中完成，不读文件。

**视图层集成**：Kanban 和 Table 视图通过 MDDBEngine.query() 调用 QueryEngine.query()。详见 `2026-06-13-kanban-view-design.md`。

### 15.4 待设计（后续）

- [ ] DQL 用户语法：终端用户的 Markdown 查询代码块
- [ ] 查询缓存：重复查询的结果缓存与失效策略
- [ ] 查询性能监控：慢查询日志、执行计划可视化
- [ ] 表达式/计算列：SelectClause 中的计算表达式
- [ ] 全文搜索：text 字段的全文索引
- [ ] Ref 跟随的延迟加载：目标表未加载时的自动重试机制

### 15.5 视图层绑定（QueryEngine → View Layer）

QueryEngine 不直接暴露给视图层，而是通过 MDDBEngine facade 封装：

```
视图层 → MDDBEngine.query() → QueryEngine.query()
视图层 → MDDBEngine.queryRaw() → QueryEngine.queryRaw()
```

**mddb-table 视图** (`Obsidian-mddb/src/view/table/table-view-model.ts`)：
- `TableViewModel` 通过 `DataLayer` 间接调用 `engine.query()`
- `DataLayer` (`Obsidian-mddb/src/view/shared/data-layer.ts`) 提供：查询执行、分页（`goToPage/nextPage/prevPage`）、排序切换（`toggleSort`）、自动刷新（监听 `data-changed` 事件）
- 编辑/删除/新增通过 `engine.update/delete/insert` 直接调用

**mddb-kanban 视图** (`Obsidian-mddb/src/view/kanban/kanban-view-model.ts`)：
- `KanbanViewModel` 直接调用 `engine.query()` 构造 Query（含 groupBy 分组）
- 返回结果在 view model 中按 `groupBy` 字段分组为 lanes
- CRUD 通过 `engine.update/delete/insert` 直接调用
- 拖拽移动通过 `engine.update(cardId, { groupField: newValue })` 实现

**mddb-form 视图** (`Obsidian-mddb/src/view/shared/form-builder.ts`)：
- `FormBuilder.render(engine, schema)` 根据字段类型渲染控件
- ref 字段预加载：`engine.query({ table: refTable, limit: 500 })` 获取选项
- 提交时通过 `engine.insert(table, record)` 写入

**ViewConfig 转换** (`Obsidian-mddb/src/view/parser.ts` - `ViewConfigBuilder`)：
```
ViewConfig  →  Query
table       →  query.table
columns     →  query.select.columns
filter      →  query.where (通过 parseWhere 转换为 FilterGroup)
sort        →  query.sort
pageSize    →  query.limit
```

