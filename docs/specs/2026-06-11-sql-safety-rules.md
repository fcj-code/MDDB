# MD-DB SQL 安全规则

> 日期：2026-06-11  
> 状态：✅ 已冻结 — Milestone 0 架构基线  
> 用途：定义 SQL Identifier 验证、raw SQL 分层与访问控制、表达式安全规则，在 Milestone 1 实施前冻结  
> 影响模块：SchemaResolver → SQLGenerator → QueryEngine → ViewLayer

---

## 一、核心原则

```text
1. Markdown 是 Schema 来源 → Schema 中的标识符必须通过校验才能进入 SQL。
2. 所有值必须通过 prepared statement 参数绑定。
3. @sort、@indexes、where 等表达式必须 parse 成 AST 后生成 SQL，禁止直接拼接。
4. raw SQL 是 escape hatch，不是默认路径。
5. 所有表名、列名、索引名必须通过 quoteIdent 或 validateIdent。
6. SQL 安全策略在 schema 与 query 两层分别执行，互不依赖。
```

---

## 二、Identifier 规则

### 2.1 MVP 严格 ASCII 模式

MVP 期间推荐所有 Schema 标识符使用严格 ASCII 子集：

```regex
table name:  /^[A-Za-z_][A-Za-z0-9_]*$/
field name:  /^[A-Za-z_][A-Za-z0-9_]*$/
index name:  /^[A-Za-z_][A-Za-z0-9_]*$/
```

违反规则的标识符 → `SCHEMA_INVALID` 错误，拒绝加载该表。

### 2.2 中文字段名支持（可选）

如果未来需要支持中文列名，必须统一使用 quote 模式：

```typescript
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
```

配置项：

```typescript
// 在 settings.ts 中控制
identifierMode: "ascii" | "quoted";  // MVP 仅支持 ascii
```

```text
quoted 模式下：
1. 所有表名、列名、索引名自动通过 quoteIdent。
2. 不对标识符字符集做限制，但空值或纯空格视为非法。
3. 标识符中可能含有的双引号被转义。
```

### 2.3 公共函数

```typescript
function validateIdent(name: string, context: "table" | "field" | "index"): boolean {
  // MVP: return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

function safeIdent(name: string, mode: IdentifierMode): string {
  if (mode === "ascii") {
    if (!validateIdent(name, "field")) {
      throw new SchemaError(`Invalid identifier: "${name}"`);
    }
    return name;
  }
  // mode === "quoted"
  return quoteIdent(name);
}
```

---

## 三、SQL 生成规则

### 3.1 DDL 生成

所有由 Schema 自动生成的 `CREATE TABLE`、`CREATE INDEX` 等 DDL 必须：

```text
1. 表名与列名全部通过 safeIdent。
2. 列类型使用 SQLite 类型映射白名单。
3. 禁止在 DDL 中拼接来自 Markdown 的 SQL 表达式。
4. DEFAULT 值使用参数绑定或白名单字面量。
```

### 3.2 DQL 生成

结构化查询对象到 SQL 的翻译必须：

```typescript
// ✅ 正确：字段名通过 safeIdent，值通过参数绑定
sql = `SELECT ${fields.map(f => safeIdent(f, mode)).join(", ")}`
     + ` FROM ${safeIdent(table, mode)}`
     + ` WHERE ${safeIdent(field, mode)} = ?`;
params = [value];

// ❌ 禁止：直接拼接
sql = `SELECT ${userInput} FROM ${table}`;  // 禁止
```

### 3.3 @sort 与 @indexes 解析

```text
@sort (日期 ASC, 金额 DESC)
```

必须 parse 为 AST，然后逐字段生成：

```typescript
interface SortClause {
  field: string;
  direction: "ASC" | "DESC";
}

function parseSort(raw: string, schema: SchemaSummary): SortClause[] {
  // 1. 去除括号 trim。
  // 2. 按逗号分割为单个排序项。
  // 3. 每个项分割为 field + direction。
  // 4. 验证 field 在 schema.fields 中。
  // 5. direction 仅允许 ASC / DESC。
  // 6. 验证失败 → SCHEMA_INVALID。
}
```

`@indexes` 同理，需 parse 为 `{ name: string; fields: string[] }` 结构。

### 3.4 WHERE 表达式

FilterGroup 翻译为 WHERE 子句时：

```typescript
// 字段名通过 safeIdent
// 值通过参数绑定
// 操作符使用白名单
const VALID_OPS = ["eq", "neq", "gt", "gte", "lt", "lte",
                   "like", "notLike", "in", "notIn", "isNull", "isNotNull"];

function renderOp(op: FilterOp): string {
  if (!VALID_OPS.includes(op.type)) {
    throw new QueryError(`Unknown operator: ${op.type}`);
  }
  // 返回 SQL 片段，如 "= ?", "LIKE ?", "IS NULL"
}
```

---

## 四、raw SQL 分层

### 4.1 三层访问控制

```text
queryRawInternal → 插件内部模块
  - 完整 SQL（SELECT / DDL / PRAGMA / INSERT 等）
  - 不暴露给用户
  - 用于冷启动、WAL 重放、后台验证

queryRaw（用户级）→ Engine.queryRaw()
  - 仅 SELECT
  - 禁止多语句
  - 禁止系统表
  - 强制 maxRows
  - 可选 timeout

ViewLayer → 视图代码块
  - 仅结构化 Query，默认不允许 raw SQL
  - 用户可在设置中启用 "高级模式" 后获得 queryRaw 权限
```

### 4.2 用户级 queryRaw 接口

```typescript
interface RawQueryOptions {
  readonly?: boolean;           // default true，只允许 SELECT
  maxRows?: number;             // default from settings（默认 1000）
  timeoutMs?: number;           // best effort
  allowSystemTables?: boolean;  // default false
}

interface QueryEngine {
  queryRaw(
    sql: string,
    params?: unknown[],
    options?: RawQueryOptions
  ): ResultOrError<ResultSet>;
}
```

### 4.3 执行前检查

```typescript
function validateRawQuery(sql: string, options: RawQueryOptions): void {
  if (options.readonly !== false) {
    // 使用 sql.js 的 SQL 解析能力或正则检查
    if (isDdlOrDml(sql)) {
      throw new QueryError("Raw SQL in read-only mode only allows SELECT");
    }
  }

  if (isMultiStatement(sql)) {
    throw new QueryError("Multi-statement SQL is not allowed");
  }

  if (options.allowSystemTables !== true) {
    if (referencesSystemTable(sql)) {
      throw new QueryError("Access to system tables is not allowed");
    }
  }
}
```

### 4.4 系统表白名单

```typescript
const SYSTEM_TABLES = ["_binding"];
const SYSTEM_SCHEMAS = ["sqlite_%"];
```

`queryRaw` 默认禁止访问系统表。`queryRawInternal` 不受此限制。

---

## 五、Schema 层安全

### 5.1 SchemaResolver 安全职责

SchemaResolver 在输出 `SchemaSummary` 对象前必须：

```text
1. 验证所有标识符格式（validateIdent）。
2. 解析 @sort 为 SortClause（验证列名）。
3. 解析 @indexes 为 IndexDef（验证列名）。
4. 拒绝包含非法标识符的表。
5. 拒绝字段名与类型列数不匹配的 Schema。
```

### 5.2 列名与 SQLite 保留字

MVP 不维护完整的 SQLite 保留字列表。采用以下策略：

```text
ascii 模式下：
  validateIdent 已排除大部分风险。
  保留字作为列名时 SQLite 可能报错，由异常路径捕获并提示。

quoted 模式下：
  所有标识符通过 quoteIdent 包裹，保留字不影响执行。
```

---

## 六、安全边界检查清单

| 路径 | 检查点 | 违规处理 |
|---|---:|---|
| Schema → DDL | `safeIdent(table)`、`safeIdent(fields[i])` | `SCHEMA_INVALID` |
| Schema → @sort | `parseSort()` 验证字段 | `SCHEMA_INVALID` |
| Schema → @indexes | `parseIndex()` 验证字段 | `SCHEMA_INVALID` |
| Query → SELECT | `safeIdent(field)`、参数绑定 | `QUERY_ERROR` |
| Query → WHERE | 操作符白名单、参数绑定 | `QUERY_ERROR` |
| ViewLayer → Query | 仅结构化对象 | 编译时就无法传入 raw SQL |
| User → queryRaw | `validateRawQuery()` | `QUERY_ERROR` |
| User → queryRaw | `maxRows` clamp | 自动截断 |
| Internal → queryRawInternal | 无限制，但记录审计日志 | — |

---

## 七、附录：SQL 注入风险评估

MD-DB 的安全边界不同于传统 Web 服务：

| 维度 | 传统 Web | MD-DB |
|---|---:|---|
| 攻击者 | 远程匿名用户 | 本地 Markdown 文件作者 |
| 风险 | 数据泄露 / 篡改 | SQLite 缓存损坏 / 插件崩溃 |
| SQLite 实例 | 生产数据库 | 本地 WASM 内存库 |
| 防护目标 | 防数据泄露 | 防缓存破坏与插件异常 |

虽然攻击面窄，但以下场景仍需防护：

```text
1. 用户同步了恶意 .md 文件（来自团队共享 Vault / 插件模板 / obsidian sync）。
2. 用户手动编辑了文件名或字段名，造成了 SQL 语法破坏。
3. 视图层代码块的内容来源于不可信输入。
```

因此所有 SQL identifier 规则和 raw SQL 限制不可绕过。
