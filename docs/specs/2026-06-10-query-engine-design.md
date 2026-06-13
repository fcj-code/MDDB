# MD-DB 查询引擎设计文档 v1.0

> 日期：2026-06-10
> 状态：**已实现** — 查询引擎完整实现（2026-06-13 更新）
> 依赖：`2026-06-10-storage-engine-design.md`（存储引擎）、`2026-06-10-parse-pipeline-design.md`（解析管道）
> 实现：`src/query/` — types.ts / validator.ts / sql-generator.ts / assembler.ts / engine.ts

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
/** 单个条件 */
interface FilterCondition {
  field: string;                              // 列名
  op: '=' | '!=' | '>' | '<' | '>=' | '<='   // 比较
    | 'in' | 'not_in'                          // 集合
    | 'like' | 'not_like'                      // 模糊匹配
    | 'is_null' | 'is_not_null';               // 空值判断
  value?: any | any[];                         // is_null / is_not_null 不需要 value
}

/** 条件组——递归结构，表达 AND/OR 嵌套 */
interface FilterGroup {
  logic: 'and' | 'or';                         // 组内条件的逻辑关系
  conditions: (FilterCondition | FilterGroup)[];
}
```

### 4.2 示例

**简单过滤：**

```typescript
// WHERE 分类 = '餐饮' AND 金额 < -50
{
  logic: 'and',
  conditions: [
    { field: '分类', op: '=', value: '餐饮' },
    { field: '金额', op: '<', value: -5000 }     // decimal 存整数（分）
  ]
}
```

**嵌套条件：**

```typescript
// WHERE (分类 = '餐饮' OR 分类 = '交通') AND 金额 < -50
{
  logic: 'and',
  conditions: [
    {
      logic: 'or',
      conditions: [
        { field: '分类', op: '=', value: '餐饮' },
        { field: '分类', op: '=', value: '交通' }
      ]
    },
    { field: '金额', op: '<', value: -5000 }
  ]
}
```

### 4.3 SQL 生成规则

递归遍历树：
- `logic: 'and'` → `AND` 连接
- `logic: 'or'` → `OR` 连接
- 每个 `FilterGroup` 加括号包裹

---

## 五、选择与排序

### 5.1 选择列 (SelectClause)

```typescript
interface SelectClause {
  fields: string[];                // 要返回的列名列表
  // 后期可扩展表达式，如 { expr: '金额 / 100', alias: '金额_元' }
}
```

- 不指定 → 返回全部列
- `groupBy` 查询中，非聚合列必须在 `groupBy` 中出现（标准 SQL 语义）
- 有 `followRefs` 且未指定 `select` 时，展开列自动追加

### 5.2 排序 (SortClause)

```typescript
interface SortClause {
  field: string;                   // 列名
  dir: 'asc' | 'desc';
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
  field: string;                    // 聚合的列名，'*' 表示 COUNT(*)
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  alias?: string;                   // 结果列名，默认自动生成如 'sum_amount'
}
```

### 6.2 示例

```typescript
// SELECT 分类, SUM(金额) as total, COUNT(*) as cnt
// FROM transactions WHERE 金额 < 0
// GROUP BY 分类 HAVING total < -10000

const q: Query = {
  table: 'transactions',
  filter: { logic: 'and', conditions: [
    { field: '金额', op: '<', value: 0 }
  ]},
  groupBy: ['分类'],
  aggregates: [
    { field: '金额', fn: 'sum', alias: 'total' },
    { field: '*', fn: 'count', alias: 'cnt' }
  ],
  having: {
    logic: 'and',
    conditions: [
      { field: 'total', op: '<', value: -10000 }   // 引用 aggregate alias
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
interface FollowRefClause {
  field: string;              // 当前表中的 ref 字段名，如 '账户'
  include?: string[];         // 目标表的列名，默认全部，如 ['账户名', '类型']
  prefix?: string;            // 结果列前缀，默认目标表名，如 'accounts'
}
```

### 7.3 示例

```typescript
// 查询交易记录，展开关联账户信息
const q: Query = {
  table: 'transactions',
  filter: { logic: 'and', conditions: [
    { field: '日期', op: '>=', value: '2024-06-01' }
  ]},
  sort: [{ field: '日期', dir: 'asc' }],
  followRefs: [
    { field: '账户', include: ['账户名', '类型'], prefix: 'acc' }
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
  page: PageInfo | null;           // 分页信息
}

interface ColumnMeta {
  name: string;                    // 列名
  type: FieldType['kind'];         // 类型：'string' | 'integer' | 'decimal' | ...
  originalField?: string;          // 聚合/展开列的源字段
  source: 'data'                   // 原始数据列
        | 'aggregate'              // 聚合结果
        | 'ref_follow';            // ref 展开列
}

interface PageInfo {
  offset: number;
  limit: number;
  hasMore: boolean;                // 是否有下一页
}
```

### 8.2 示例

```json
{
  "columns": [
    { "name": "日期", "type": "date", "source": "data" },
    { "name": "金额", "type": "decimal", "source": "data" },
    { "name": "total", "type": "decimal", "source": "aggregate", "originalField": "金额" },
    { "name": "acc_账户名", "type": "string", "source": "ref_follow", "originalField": "账户" }
  ],
  "rows": [
    { "日期": "2024-06-01", "金额": "-45.00", "acc_账户名": "现金钱包" },
    { "日期": "2024-06-02", "金额": "-128.00", "acc_账户名": "微信零钱" }
  ],
  "total": 156,
  "page": { "offset": 0, "limit": 20, "hasMore": true }
}
```

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
interface QueryError {
  code: QueryErrorCode;
  message: string;           // 人类可读
  field?: string;            // 出错的 Query 字段路径
}

enum QueryErrorCode {
  TABLE_NOT_FOUND = 'TABLE_NOT_FOUND',
  FIELD_NOT_FOUND = 'FIELD_NOT_FOUND',
  INVALID_OPERATOR = 'INVALID_OPERATOR',
  INVALID_VALUE_TYPE = 'INVALID_VALUE_TYPE',
  REF_FIELD_NOT_FOUND = 'REF_FIELD_NOT_FOUND',
  AGGREGATE_WITHOUT_GROUPBY = 'AGGREGATE_WITHOUT_GROUPBY',
  SYNTAX_ERROR = 'SYNTAX_ERROR',            // raw SQL 解析失败
}
```

### 9.3 验证规则

| # | 检查项 | 触发条件 | 错误码 |
|---|--------|---------|--------|
| 1 | 表名存在 | 绑定表中无此 `@table` 声明 | `TABLE_NOT_FOUND` |
| 2 | 列名有效 | `filter`/`sort`/`select` 中的 `field` 不在 Schema 中 | `FIELD_NOT_FOUND` |
| 3 | 操作符兼容 | 对 `string` 字段用 `>` 等 | `INVALID_OPERATOR` |
| 4 | 值类型匹配 | 对 `decimal` 字段传字符串 `"abc"` | `INVALID_VALUE_TYPE` |
| 5 | ref 字段存在 | `followRefs[].field` 的列类型不是 `ref()` | `REF_FIELD_NOT_FOUND` |
| 6 | 聚合+分组配对 | `aggregates` 存在但 `groupBy` 为空 | `AGGREGATE_WITHOUT_GROUPBY` |
| 7 | SQL 语法合法 | `queryRaw()` 的 SQL 在 sql.js prepare 阶段失败 | `SYNTAX_ERROR` |

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
| 4 | 结果格式 | ResultSet `{ rows, columns, total, page }` |
| 5 | 执行模型 | 同步，未来按需加异步 |
| 6 | 过滤模型 | 递归 FilterGroup（AND/OR 树）+ 11 种操作符 |
| 7 | 聚合模型 | groupBy + aggregates[] + having（复用 FilterGroup） |
| 8 | ref 跟随 | 两步查询，不破坏原始 ref 值，断裂不报错 |
| 9 | raw SQL 入口 | 独立方法 `queryRaw(sql, params)` |
| 10 | 参数化查询 | `query()` 不需要 params，`queryRaw()` 需要 |
| 11 | 验证策略 | 7 条验证规则，宽松模式——只查结构合法性 |
| 12 | 模块架构 | QueryValidator → SQLGenerator → ResultAssembler |
| 13 | SelectClause | 列名列表，后期可扩展表达式 |
| 14 | SortClause | field + dir，默认走 @sort → 写入时序 |
| 15 | decimal 显示 | 引擎内部整数 → ResultSet 格式化字符串，视图层无感知 |
| 16 | 边缘情况 | 空表/无匹配/越界=正常空结果；ref 断裂=NULL+warning |

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
| Type Definitions | `src/query/types.ts` | ✅ 完成 | 所有类型定义（Query / FilterGroup / AggregateClause / ResultSet / ...） |
| QueryValidator | `src/query/validator.ts` | ✅ 完成 | 7 条验证规则：表存在、字段存在、操作符兼容、ref 检查、聚合分组配对 |
| SQLGenerator | `src/query/sql-generator.ts` | ✅ 完成 | SELECT / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT-OFFSET / 聚合 |
| ResultAssembler | `src/query/assembler.ts` | ✅ 完成 | decimal 格式化、分页信息构建、ref 跟随展开（assembleWithRefs） |
| QueryEngine | `src/query/engine.ts` | ✅ 完成 | Validator → Generator → Assembler 管道、COUNT(*) 分页计数、raw SQL |
| 测试 | `src/query/*.test.ts` | ✅ 完成 | validator(13) + sql-generator(16) + assembler(6) + engine(5) = 40 tests |

### 15.2 与设计的偏差

| 设计项 | 设计文档 | 实际实现 | 说明 |
|--------|---------|---------|------|
| `SchemaRegistry` 接口 | 未明确定义 | 在 `validator.ts` 中定义 | 设计文档未指定接口位置，实现选择了就近放置 |
| `SqlDatabase` 接口 | 未定义 | 在 `engine.ts` 中定义 | 抽离 sql.js 依赖，便于测试 mock |
| 测试框架 | 未指定 | vitest | 与项目现有工具链一致 |
| `SchemaRegistry` 访问方式 | 假设从 schema 模块导入 | `BindingStore.getSchema(table)` 包装 | 实际通过 binding-store 获取 Schema |

### 15.3 集成点

查询引擎通过以下接口与系统其他部分集成：

```
┌─────────────────────────────────────────────────────────┐
│                    QueryEngine                           │
│                                                         │
│  SchemaRegistry ←── BindingStore.getSchema(table)       │
│  (validator.ts 中定义)                                    │
│                                                         │
│  SqlDatabase  ←── sql.js WASM SQLite 实例               │
│  (engine.ts 中定义: exec / prepare)                      │
│                                                         │
│  SchemaGetter ←── SchemaRegistry.get(table)              │
│  (sql-generator.ts 中定义)                                │
└─────────────────────────────────────────────────────────┘
```

### 15.4 待设计（后续）

- [ ] DQL 用户语法：终端用户的 Markdown 查询代码块
- [ ] 查询缓存：重复查询的结果缓存与失效策略
- [ ] 查询性能监控：慢查询日志、执行计划可视化
- [ ] 表达式/计算列：SelectClause 中的计算表达式
- [ ] 全文搜索：text 字段的全文索引
- [ ] Ref 跟随的延迟加载：目标表未加载时的自动重试机制
