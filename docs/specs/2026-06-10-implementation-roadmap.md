# MD-DB 实施路线图 v1.0

> 日期：2026-06-10（最近更新：2026-06-12）
> 基于：`2026-06-10-storage-engine-design.md` (16 项决策)、`2026-06-10-parse-pipeline-design.md` (17 项决策)、`2026-06-10-query-engine-design.md` (16 项决策)、`2026-06-10-transaction-model-design.md` (14 项决策)
> 用途：为其他 session 或 subagent 提供可独立执行的任务单元
>
> **⚠️ 本文档已被 v2 路线图替代**：`2026-06-11-implementation-roadmap-v2.md`
> v2 将 Phase 清单重构为 Milestone 0-6，修复了身份模型、WAL 协议、Schema 注册表等系统级问题。
> 本文档保留作为 Phase → 实际代码路径的索引参考。v2 路线图是当前实施的事实源。

---

## 一、项目概览

### 1.1 MD-DB 是什么

MD-DB 是一个运行在 **Obsidian 插件环境**中的 Markdown 数据库引擎。它将 `.md` 文件中的结构化数据解析为可查询的内存数据库，提供完整的 CRUD、事务、崩溃恢复能力。

### 1.2 核心架构

```
┌────────────────────────────────────────────────┐
│                 Obsidian 插件进程                 │
├────────────┬───────────────┬───────────────────┤
│ 视图层      │ 查询引擎       │ 存储引擎           │
│ (表格/看板) │ (SQL/DQL)     │                   │
│            │               │ ┌─ 解析管道         │
│            │               │ ├─ 绑定表 (SQLite)  │
│            │               │ ├─ WAL 日志         │
│            │               │ └─ 重扫调度          │
└────────────┴───────────────┴───────────────────┘
          ↕ Obsidian Vault API
┌────────────────────────────────────────────────┐
│              Vault（.md 文件）                     │
└────────────────────────────────────────────────┘
```

### 1.3 设计状态总览

| 模块 | 状态 | 文档 |
|------|:---:|------|
| 存储引擎底层架构 | ✅ 已设计 | `storage-engine-design.md` §1-8 |
| 数据格式 + Schema + 类型 | ✅ 已设计 | `storage-engine-design.md` §9-10 |
| 解析管道 | ✅ 已设计 | `parse-pipeline-design.md` §1-8 |
| 查询引擎 | ✅ 已设计 | `query-engine-design.md` |
| 事务模型 | ✅ 已设计 | `transaction-model-design.md` |
| 视图层接口 | ✅ 已设计 | `2026-06-10-view-layer-design.md` |
| 多文件表 | ⬜ 待设计 | — |
| A/C 形式适配层 | ⬜ 待设计 | — |

---

## 二、实施阶段

### 阅读指南

每个阶段包含以下信息：
- **目标**：完成什么
- **依赖**：必须先完成哪些阶段
- **状态**：✅ 可直接实施 / ⬜ 需先设计
- **设计参考**：从哪里获取详细的规格
- **产出**：应该交付的代码模块
- **关键决策引用**：该阶段实现了哪些已确定的设计决策

---

### Phase 0: 项目脚手架

| 属性 | 内容 |
|------|------|
| **目标** | 搭建 Obsidian 插件骨架 |
| **依赖** | 无 |
| **状态** | ✅ **已完成**（Milestone 1 v2） |

**产出清单**：
```
Obsidian-mddb/
├── manifest.json          # Obsidian 插件声明
├── package.json           # npm 依赖 (sql.js / vitest)
├── tsconfig.json
├── vitest.config.ts       # 新增
├── src/
│   ├── main.ts            # 插件入口，注册生命周期 + mddb-form 处理器
│   ├── settings.ts        # 插件设置面板
│   └── constants.ts       # 路径常量
```

**关键要点**：
- 插件 ID: `md-db`
- 插件名称: `MD-DB`
- 最低 Obsidian 版本: `1.4.0`（需要 Vault API 和自定义代码块渲染）
- SQLite 方案：优先 `sql.js`（纯 WASM，无原生依赖），后期可选迁移到 Obsidian 内置 SQLite

---

### Phase 1: 核心数据结构

| 属性 | 内容 |
|------|------|
| **目标** | 定义 Schema 对象、错误码、ParseResult 等 TypeScript 类型 |
| **依赖** | Phase 0 |
| **状态** | ✅ **已完成**（Milestone 1 v2） |

**实际代码路径**：`Obsidian-mddb/src/core/`

**Schema 对象定义**（参考 `parse-pipeline-design.md` §2.2）：

```typescript
interface Schema {
  table: string;              // 表名
  pk: string[];               // 逻辑主键列名列表
  fields: string[];           // 字段名列表
  types: FieldType[];         // 字段类型列表
  required: boolean[];        // 必填标记（可选，默认全 false）
  sort?: SortClause;          // 默认排序（可选）
  indexes?: string[];         // 建议索引（可选）
  relations?: RelationDef[];  // 外键声明（可选）
  nullMarker: string;         // 空值占位符，默认 "-"
  strict: boolean;            // 严格模式，默认 false
  onDup?: 'skip' | 'overwrite' | 'error';  // PK 冲突策略（后期）
}
```

**FieldType**（完整类型字符串保留参数，供下游格式化）：

```typescript
// FieldType 存储完整类型表达式，而非简化标签
// "decimal(2)"  "enum(储蓄,信用,投资,电子)"  "ref(categories)"  "string"
type FieldType = string;

// ColumnMeta：ResultSet 列元数据，type 字段携带完整类型字符串
interface ColumnMeta {
  name: string;
  type: FieldType;    // ResultAssembler 从此字符串解析精度/枚举值/ref 目标
}
```

**错误码枚举**（参考 `parse-pipeline-design.md` §5.6）：

```typescript
enum ParseErrorCode {
  TYPE_CAST_FAILED = 'TYPE_CAST_FAILED',
  FIELD_COUNT_MISMATCH = 'FIELD_COUNT_MISMATCH',
  REQUIRED_MISSING = 'REQUIRED_MISSING',
  PK_DUPLICATE = 'PK_DUPLICATE',
  SCHEMA_INVALID = 'SCHEMA_INVALID',
  STRICT_ROW_SKIPPED = 'STRICT_ROW_SKIPPED',
}
```

**ParseResult**：

```typescript
interface ParseResult {
  records: Record[];
  errorCount: number;
  warningCount: number;
  errors: ParseError[];
  warnings: ParseWarning[];
}
```

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 存储 §16 | `storage-engine-design.md` | 空值占位符默认 `-` |
| 解析 D13 | `parse-pipeline-design.md` | `-` = NULL = 违反 @required |
| 解析 D15 | `parse-pipeline-design.md` | ParseResult 错误收集格式 |

---

### Phase 2: 绑定表 + SQLite 基础设施

| 属性 | 内容 |
|------|------|
| **目标** | 初始化内存 SQLite，创建系统表 |
| **依赖** | Phase 1 |
| **状态** | ✅ **已完成**（Milestone 1 v2，身份模型升级为 v2） |

> **v2 变更**：Phase 2 的 storage_pk 格式 `${relativePath}:${lineNumber}:${hash6}` 已被淘汰。v2 使用 `BindingRow` 模型，storage_pk 基于 `tableName + logicalPk` 的稳定 hash，line_number 仅为可变的定位器。详见 `identity-model.md`。

**实际代码路径**：
```
Obsidian-mddb/src/storage/
├── sqlite-adapter.ts      # SQLite wrapper (sql.js)
├── binding-store.ts       # _binding 表 CRUD（v2 身份模型）
├── schema-registry.ts     # SchemaRegistry v2 持久化
├── file-hash-store.ts     # file_hashes.json
└── index-writer.ts        # DDL 生成 + 记录写入 + storagePk 生成
```

**DDL**（基于示例数据集验证，已修正 `_binding` 结构）：

```sql
CREATE TABLE _binding (
  storage_pk    TEXT PRIMARY KEY,
  logical_pk    TEXT NOT NULL,
  table_name    TEXT NOT NULL,       -- 支持单文件多表
  file_path     TEXT NOT NULL,
  line_number   INTEGER NOT NULL,
  row_hash      TEXT NOT NULL,
  last_verified TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_binding_logical ON _binding(logical_pk, table_name);
CREATE INDEX idx_binding_file ON _binding(file_path, line_number);
CREATE INDEX idx_binding_table ON _binding(table_name);
```
> **变更说明**：`_wal_retry` 表不再在此阶段创建。写入失败重试机制统一使用 Phase 10 的事务级 JSON WAL 文件（`wal/{txId}.json`），与 Phase 16 事务模型共享同一套基础设施。

**Storage PK 生成工具**：

```typescript
function generateStoragePK(
  relativePath: string,
  lineNumber: number,
  rawContent: string  // 未经类型转换的原始行
): string {
  const hash = sha256(rawContent).slice(0, 6);
  return `${relativePath}:${lineNumber}:${hash}`;
}
```

**缓存目录结构**：
```
.obsidian/plugins/md-db/cache/
├── binding.db          # 绑定表 + 索引 SQLite
├── file_hashes.json    # { "文件相对路径": "sha256hex" }
└── schema_registry.json # 所有 @table 文件的 Schema 摘要
```

**`schema_registry.json` 格式**：

```typescript
interface SchemaRegistry {
  version: 1;
  tables: Record<string, {
    file: string;                         // 文件相对路径
    pk: string[];                         // 主键列名列表
    fields: string[];                     // 字段名列表
    types: string[];                      // 类型（含参数如 "decimal(2)"）
    required: boolean[];                  // 必填标记
    sort?: string;                        // "type ASC, balance DESC" 格式
    indexes?: string[];                   // ["idx(分类)", ...]
    relations?: Array<{                   // @relations 声明
      field: string;                      //   本表字段
      targetTable: string;                //   目标表
      targetField: string;                //   目标字段
    }>;
    nullMarker: string;                   // 默认 "-"
    strict: boolean;                      // 默认 false
    rowCount: number;                     // 快照时的行数
  }>;
}
```

> 注意：同一文件可含多张表（如 `budget-2024.md` 包含 `monthly_budgets` 和 `budget_items`），因此用 `table → info` 的 Record 结构，而非 `file → info`。同一 `file` 值可在多个表条目中出现。

---

### Phase 3: Schema 解析器

| 属性 | 内容 |
|------|------|
| **目标** | 从四种来源提取 Schema，按优先级合并 |
| **依赖** | Phase 1 |
| **状态** | ✅ **已完成**（Milestone 1 v2，增加 SQL identifier 安全规则） |

**实际代码路径**：
```
Obsidian-mddb/src/schema/
├── resolver.ts            # 四来源 Schema 解析 + 合并 + frontmatter
├── validators.ts          # validateIdent, parseSortClause, validateSchema
└── resolver.test.ts       # 11 测试
```

**优先级链**（参考 `parse-pipeline-design.md` §2.1）：

```
块内 @ 指令 > 围栏信息串 > 文件 YAML frontmatter > 外部 YAML 引用
```

**四大子模块**：

1. **`@` 指令解析器** — 解析 `@table`、`@pk`、`@fields`、`@types`、`@required`、`@sort`、`@indexes`、`@null_marker`、`@strict` 行
2. **YAML frontmatter 解析器** — 读取 `---\n...\n---`，提取 `mddb:` 字段（参考 §2.1 方式 C）
3. **外部 Schema 加载器** — 读取 `.yaml`/`.yml` 文件，路径解析规则（vault 根 + `./` 相对）
4. **Schema 合并器** — 按优先级覆盖，生成最终 Schema 对象

**Schema 元验证规则**（§2.3）：
- `@table`、`@pk`、`@fields`、`@types` 为必需
- `@fields` 和 `@types` 列数必须相等
- `@required` 如果存在，列数必须与 `@fields` 一致
- `@pk`、`@sort`、`@indexes` 中的列名必须在 `@fields` 中存在

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 解析 D6 | `parse-pipeline-design.md` | Schema 指令 + YAML 统一为同一对象 |
| 解析 D7 | `parse-pipeline-design.md` | 标题行/分隔符行不支持 |
| 解析 D9 | `parse-pipeline-design.md` | 不需要 `---`，`@` 开头即指令 |
| 解析 D10 | `parse-pipeline-design.md` | @schema > 围栏 > frontmatter > 外部引用 |
| 解析 D11 | `parse-pipeline-design.md` | vault 根 + `./` 相对路径 |
| 解析 D12 | `parse-pipeline-design.md` | 围栏信息串仅 `schema=xxx` |

---

### Phase 4: 词法分析器 (Lexer)

| 属性 | 内容 |
|------|------|
| **目标** | 识别 mddb 块、分类行、切分字段 |
| **依赖** | Phase 1, Phase 3 |
| **状态** | ✅ **已完成**（Milestone 1 v2） |

**实际代码路径**：
```
Obsidian-mddb/src/parse/
├── lexer.ts               # extractBlocks, splitFields, classifyLine
├── lexer.test.ts          # 14 测试
```

**核心逻辑**（参考 `parse-pipeline-design.md` §3）：

**1. mddb 块检测**：正则匹配 ` ```mddb` 开始、` ``` ` 结束

**2. 行分类**（块内逐行）：
```
行首是 @ → Schema 指令
空行     → 跳过
其他     → 数据行
```

**3. 转义感知字段切分**：
```
1. 替换转义序列: \| → NONPIPE, \\ → BSLASH
2. split('|')
3. 每个片段还原: NONPIPE → |, BSLASH → \
4. .trim()
```

**4. 空值检测**：
```
trimmed == '' || trimmed == schema.nullMarker → 标记为 NULL
```

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 解析 D1 | `parse-pipeline-design.md` | ` ```mddb` 围栏块 |
| 解析 D2 | `parse-pipeline-design.md` | 纯 B 形式数据 |
| 解析 D3 | `parse-pipeline-design.md` | `\|` + `\\` 转义 |
| 解析 D8 | `parse-pipeline-design.md` | 相同 @table 追加，不同独立 |
| 解析 D17 | `parse-pipeline-design.md` | `.trim()` 处理空白 |

---

### Phase 5: 类型转换器

| 属性 | 内容 |
|------|------|
| **目标** | 实现 12 种字段类型的转换器 |
| **依赖** | Phase 3, Phase 4 |
| **状态** | ✅ **已完成**（Milestone 1 v2） |

**实际代码路径**：
```
Obsidian-mddb/src/parse/
├── converter.ts           # 12 类型转换器 + formatDisplayValue
├── converter.test.ts      # 32 测试
```

**类型转换器表**（参考 `parse-pipeline-design.md` §4）：

| 类型 | 转换逻辑 | 失败行为 |
|------|---------|:---:|
| `string` | 原样 trim | 永不失败 |
| `integer` | parseInt, 正则 `/^-?\d+$/` | → NULL |
| `decimal(N)` | `parseFloat × 10^N` 存为 BIGINT | → NULL |
| `boolean` | true/yes/1/是→true, false/no/0/否→false | → NULL |
| `date` | YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD | → NULL |
| `datetime` | YYYY-MM-DD HH:MM:SS / ISO 8601 | → NULL |
| `enum(v,…)` | 精确匹配枚举值 | → NULL |
| `text` | 还原转义后原样 | 永不失败 |
| `tags` | 正则 `#tag` 提取，去重 | → `[]` |
| `ref(table)` | 原样保留 + 标记 | 延迟验证 |
| `phone` | 提取数字标准化 | → NULL |
| `email` | trim + 小写 + 正则 | → NULL |

**关键实现细节**：
- **decimal 精度**：`decimal(2)` 内部存为整数（分），例如 `"45.00"` → `4500`
- **boolean 不区分大小写**
- **宽松/严格模式切换**：由 `schema.strict` 控制（§4.3）

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 解析 D4 | `parse-pipeline-design.md` | 转换失败 → NULL + warning（宽松默认） |
| 解析 D12 | `parse-pipeline-design.md` | `@strict true` 时跳过整行 |

---

### Phase 6: 验证器

| 属性 | 内容 |
|------|------|
| **目标** | 字段数、必填、PK 唯一性校验 |
| **依赖** | Phase 2, Phase 5 |
| **状态** | ✅ **已完成**（Milestone 1 v2，PK 逻辑按 v2 身份模型调整） |

> **v2 变更**：PK 唯一性校验改为按 `logicalPk + tableName` 全局唯一，不再依赖行号。

**实际代码路径**：
```
Obsidian-mddb/src/parse/
├── validator.ts           # validateRow/validateRows + ParseResult
├── validator.test.ts      # 9 测试
```

**验证链**（参考 `parse-pipeline-design.md` §5）：

```
字段数校验 → 必填检查 → 逻辑 PK 唯一性
```

**子模块**：

1. **字段数校验** (§5.2)：不足补 NULL / 超出截断（宽松），跳过行（严格）
2. **必填检查** (§5.3)：`@required[i]==true AND values[i]==NULL` → warning
3. **PK 唯一性** (§5.4)：查 `_binding` 表 → first-write-wins。PK 字段值为 NULL → 跳过唯一性检查，直接标记 `REQUIRED_MISSING`（PK 隐式必填）
4. **错误累积** (§5.6)：构建 `ParseResult { records[], errors[], warnings[], counts }`

> **ref 引用不在解析时验证**。目标表可能尚未加载（冷启动、文件解析顺序），ref 值原样写入用户表，统一在查询引擎（Phase 15）的 `followRefs` 中解析——断裂引用返回 NULL，不报错。

**错误码**：`TYPE_CAST_FAILED`, `FIELD_COUNT_MISMATCH`, `REQUIRED_MISSING`, `PK_DUPLICATE`, `SCHEMA_INVALID`, `STRICT_ROW_SKIPPED`

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 解析 D5 | `parse-pipeline-design.md` | 字段数不匹配处理 |
| 解析 D13 | `parse-pipeline-design.md` | `-` = NULL = 违反 @required |
| 解析 D14 | `parse-pipeline-design.md` | PK 冲突 first-write-wins |
| 解析 D15 | `parse-pipeline-design.md` | ParseResult + 日志 |

---

### Phase 7: 索引写入器

| 属性 | 内容 |
|------|------|
| **目标** | 将验证通过的记录写入绑定表和用户表 |
| **依赖** | Phase 2, Phase 6 |
| **状态** | ✅ **已完成**（Milestone 1 v2，storagePk 生成按 v2 调整） |

> **v2 变更**：storage_pk 不再使用 `${relativePath}:${lineNumber}:${hash6}` 格式。改为 `tableName + logicalPk` 的稳定 hash，或 UUID。详见 `identity-model.md`。

**实际代码路径**：`Obsidian-mddb/src/storage/index-writer.ts`

**流程**（参考 `parse-pipeline-design.md` §6）：

```
for each validated record:
  1. 生成 storage_pk = "{相对路径}:{物理行号}:{SHA256[:6]}"
  2. 提取 logical_pk（从 @pk 列值拼接）
  3. 计算 row_hash = SHA256(原始行)[:16]
  4. INSERT _binding
  5. INSERT INTO [table_name] — 自动 CREATE TABLE IF NOT EXISTS
```

**用户表 DDL 自动生成**：根据 Schema 对象的字段和类型，映射到 SQLite 列类型。

| 用户类型 | SQLite 列类型 |
|---------|-------------|
| string, text, enum, ref, email | `TEXT` |
| integer | `INTEGER` |
| decimal(N) | `BIGINT` |
| boolean | `INTEGER` (0/1) |
| date, datetime | `TEXT` (ISO 格式) |
| phone | `TEXT` |
| tags | `TEXT` (JSON 数组) |

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 存储 §2 | `storage-engine-design.md` | storage_pk 格式 |
| 存储 §3 | `storage-engine-design.md` | 绑定表结构 |
| 解析 D16 | `parse-pipeline-design.md` | 物理行号（非数据序号） |

---

### Phase 8: 解析管道集成

| 属性 | 内容 |
|------|------|
| **目标** | 串联 Phase 1-7，提供完整的文件解析入口 |
| **依赖** | Phase 1, 2, 3, 4, 5, 6, 7 |
| **状态** | ✅ **已完成**（Milestone 1 v2） |

**实际代码路径**：
```
Obsidian-mddb/src/parse/pipeline.ts   # ParsePipeline（两遍扫描：dmdb-schema → mddb 数据）
Obsidian-mddb/src/pipeline-integration.test.ts  # 11 集成测试
```

**顶层 API**：

```typescript
// 解析单个文件
function parseFile(file: TFile): ParseResult
// → 内部依次调用: SchemaResolver → Lexer → TypeConverter → Validator → IndexWriter

// 扫描整个 Vault
function parseAllFiles(): Map<string, ParseResult>
// → 遍历 vault.getMarkdownFiles()，过滤含 mddb 块或 @table frontmatter 的文件
```

**参考**：端到端示例在 `parse-pipeline-design.md` §7。

**重入性**：解析器应支持重复调用（全量重扫），写入前应检查 `storage_pk` 是否存在（幂等）。

---

### Phase 9: CRUD 操作

| 属性 | 内容 |
|------|------|
| **目标** | 通过 Vault API 实现完整的增删改查 |
| **依赖** | Phase 8 |
| **状态** | ✅ **已完成**（Milestone 2-3 v2，集成 WAL v2 一致性） |

> **v2 变更**：写入路径统一经过 `TransactionManager`。`CRUDExecutor` 只负责单条或单文件内的最小文件变更执行。所有写操作前检查目标行 hash，失败时生成 WAL v2 operation。

**实际代码路径**：
```
Obsidian-mddb/src/write/
├── crud-executor.ts       # insert/update/delete + insertAll/updateAll/deleteAll
├── serializer.ts          # 记录序列化
├── conflict-detector.ts   # 写前哈希比对
├── write-plan.ts          # WritePlan 构造
└── types.ts               # 写入类型定义
```

**操作规格**（参考 `storage-engine-design.md` §4）：

**INSERT**：
```
1. 序列化记录为 B 形式行（字段值用 | 拼接，NULL → nullMarker）
2. 通过 app.vault.process() 在文件末尾追加行
3. 生成 storage_pk（基于新物理行号）
4. INSERT _binding + INSERT [table]
```

**DELETE**：
```
1. 通过 storage_pk 定位 file_path + line_number
2. app.vault.process() 删除该行
3. DELETE _binding WHERE storage_pk = ?
4. UPDATE _binding SET line_number = line_number - 1 WHERE file_path = ? AND line_number > deleted_line
```

**UPDATE**：
```
1. 通过 storage_pk 定位
2. 读目标行的当前内容 → 计算 hash
3. 对比 binding.row_hash：
   一致 → 替换行 → 更新 row_hash
   不一致 → 触发冲突处理 → Phase 11
```

**SELECT**：
```
1. 全部在内存 SQLite 中完成，不读文件
2. 按 @sort 排序，支持 LIMIT/OFFSET/WHERE
```

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 存储 §4 | `storage-engine-design.md` | 物理删除后续行上移 |
| 存储 §7 | `storage-engine-design.md` | 即时写穿 |
| 存储 §8 | `storage-engine-design.md` | 末尾追加 |
| — | — | CRUD 操作写文件后更新 `file_hashes.json` |

---

### Phase 10: 写入路径 + WAL

| 属性 | 内容 |
|------|------|
| **目标** | 乐观写 + 事务级 JSON WAL 补偿重试 |
| **依赖** | Phase 2, Phase 9 |
| **状态** | ✅ **已完成**（Milestone 3 v2，WAL v2 协议） |

> **v2 变更**：WAL 从只记录 `files[]` 升级为记录可幂等重放的 `operations[]`（InsertLine/ReplaceLine/DeleteLine）。支持 `progress.completedOperationIds` 部分进度跟踪。详见 `wal-replay-protocol.md`。

**实际代码路径**：
```
Obsidian-mddb/src/wal/
├── types.ts               # WAL v2 类型体系（WalEntry/WalOperation/ReplayResult）
├── wal-manager.ts         # FileWalStore + InMemoryWalStore
├── replay.ts              # 幂等重放引擎
├── retry-scheduler.ts     # 指数退避重试调度器
├── dead-letter.ts         # 死信管理
├── types.test.ts          # 17 tests
├── wal-manager.test.ts    # 19 tests
├── replay.test.ts         # 9 tests
├── retry-scheduler.test.ts # 7 tests
└── dead-letter.test.ts    # 9 tests
```

**核心流程**：

```
1. 更新内存 SQLite → UI 立即响应
2. 调用 app.vault.modify() 写文件
3. 成功 → 流程结束
4. 失败 → 生成 wal/{txId}.json → 后台指数退避重试
```

**WAL 文件格式**（与 Phase 16 共享同一套基础设施）：

```typescript
// .obsidian/plugins/md-db/wal/{txId}.json
interface WalEntry {
  txId: string;                    // UUID
  createdAt: string;               // ISO 8601
  status: "pending" | "retrying" | "dead";
  files: Array<{
    relativePath: string;          // 待同步的文件路径
    tableName: string;             // 所属表名
  }>;
  retry: {
    count: number;                 // 0..maxRetries
    maxRetries: number;            // 默认 10
    lastError: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;  // 指数退避计算
  };
}
```

> 单次写入失败生成一个 WAL 条目，包含一个文件路径。Phase 16 在此基础上扩展为跨文件事务（多个 `files` 条目）。

**重试与死信**：
- 指数退避：`1s → 2s → 4s → 8s → 16s → 30s → 60s → 120s → 300s → 600s`，最多 10 次
- 全部重试失败 → `status = "dead"` → 状态栏通知 "N 条未同步"
- 死信面板：列出事务 ID、涉及文件、最后失败原因，提供 [重试] [丢弃] 按钮
- Obsidian 重启时：`status != "dead"` 的条目重新入队重试
- 全部同步成功后删除 WAL 文件（正常路径下 `wal/` 目录为空）

**产出清单**：
```
src/wal/
├── types.ts          # WalEntry 类型定义
├── wal-manager.ts    # writeEntry / replayAll / retryLoop
└── wal-manager.test.ts
```

---

### Phase 11: 重扫与一致性

| 属性 | 内容 |
|------|------|
| **目标** | 三层重扫策略 + 写前哈希验证 |
| **依赖** | Phase 9 |
| **状态** | ✅ **已完成**（Milestone 2-3 v2，集成 LockManager） |

> **v2 变更**：增加 `LockManager` 并发控制、`FileDiff` 行哈希差异检测器、`FileWatcher` 自改识别。详见 `runtime-architecture.md` §6。

**实际代码路径**：
```
Obsidian-mddb/src/rescan/
├── file-diff.ts           # 行哈希差异检测
├── file-diff.test.ts      # 13 tests
├── file-watcher.ts        # 文件变更监视器（create/modify/delete/rename + 自改识别）
├── file-watcher.test.ts   # 10 tests
├── rescan-scheduler.ts    # 分批重扫调度
└── rescan-scheduler.test.ts # 6 tests

Obsidian-mddb/src/lock/
├── lock-manager.ts        # withFileLock / withFileLocks
└── lock-manager.test.ts   # 8 tests
```

**三层触发**（参考 `storage-engine-design.md` §6）：

| 层次 | 触发条件 | 行为 |
|------|---------|------|
| **第一层：自改** | 引擎自己的写入 | O(1) 精确行号更新 |
| **第二层：事件** | `vault.on('modify')` | diff → ≤20% 增量 / >20% 全量 |
| **第三层：写前** | 引擎写入前 | 单行哈希比对，不一致触发第二层 |
| **兜底** | Obsidian 空闲 >5min + 距上次 >1h | 全量，节流 10 文件/次 |

**第一层细节**：
- INSERT 末尾追加：仅插入 binding 新条目
- DELETE 第 N 行：删除 binding + 后续行号-1
- UPDATE 第 N 行：更新 row_hash，storage_pk 不变

**第二层细节**：
- 保存文件的上次缓存内容
- 逐行 diff → 变更行号列表
- ≤20% 变更 → 仅处理变更行
- >20% 变更 → 全量重扫该文件

---

### Phase 12: 冷启动

| 属性 | 内容 |
|------|------|
| **目标** | 缓存优先加载 + WAL 重放 + 后台验证 |
| **依赖** | Phase 8, Phase 10, Phase 11 |
| **状态** | ✅ **已完成**（Milestone 2-3 v2，增加 CacheManifest + CacheMigration） |

> **v2 变更**：增加 `CacheManifest`（版本号/时间戳/冷启动检查）和 `CacheMigration` 迁移引擎。冷启动流程在 `engine.initialize()` 中统一管理：SQLite → cache 检查 → WAL 重放 → ready → 后台校验。

**实际代码路径**：
```
Obsidian-mddb/src/cache/
├── cache-manifest.ts      # CacheManifest v1
├── cache-manifest.test.ts # 7 tests
├── cache-migration.ts     # 迁移引擎
└── cache-migration.test.ts # 5 tests

Obsidian-mddb/src/engine/
├── engine.ts              # 生命周期 + 冷启动 + WAL 重放 + 诊断
└── diagnostics.ts         # EngineDiagnostics 状态管理
```

**阶段 1：阻塞启动**（< 100ms）（参考 `storage-engine-design.md` §8）：

```
1. 加载 binding.db（SQLite 文件，Phase 2 产出）
2. 加载 file_hashes.json
3. 加载 schema_registry.json
4. 重放 WAL 中所有未完成条目
5. 标记引擎就绪 → UI 可用
```

**阶段 2：后台验证**（不阻塞用户）：
```
1. Obsidian 空闲时逐个比对 file_hashes
2. 尝试获取文件锁（lockFile），被占 → 跳过此轮等下次空闲
3. 哈希匹配 → 解锁 → 跳过
4. 哈希不匹配 → 重新解析 → 解锁 → 更新 file_hashes
```

**降级**：缓存损坏或不存在 → 全量重建（调用 `parseAllFiles()`）

**并发控制**（Phase 12 + 13 共享）：
- 引擎维护 `lockedFiles: Set<string>` 全局锁
- `parseFile()` 调用前必须 `lockFile(path)`，完成后 `unlockFile(path)`
- Phase 12 后台验证和 Phase 13 文件监视器共享同一把锁——谁先拿到谁处理，另一方跳过该文件等下一轮

---

### Phase 13: 文件监视集成

| 属性 | 内容 |
|------|------|
| **目标** | 响应 Obsidian Vault 事件，保持索引与文件系统同步 |
| **依赖** | Phase 8, Phase 11 |
| **状态** | ✅ **已完成**（Milestone 2 v2） |

> **v2 变更**：delete 事件不再默认 DROP TABLE。先删除 `_binding` 中 `file_path=?` 的记录，从 `schema_registry.tables[table].sources` 移除 source，仅当 `table.sources` 为空时才 DROP TABLE。详见 `schema-registry.ts` 的 `removeFile` 方法。

**实际代码路径**：`Obsidian-mddb/src/rescan/file-watcher.ts`

**四个事件处理器**：

```typescript
vault.on('create', (file: TFile) => {
  // 1. 检查是否为 .md 文件
  // 2. 扫描 frontmatter + mddb 块
  // 3. 如果是数据文件 → 调用 parseFile()
})

vault.on('modify', (file: TFile) => {
  // 1. 尝试获取文件锁，被占 → 跳过（与 Phase 12 共享锁）
  // 2. Phase 11 第二层：diff 后增量/全量重扫
  // 3. 释放文件锁
})

vault.on('delete', (file: TFile) => {
  // DELETE FROM _binding WHERE file_path = ?
  // DROP TABLE IF EXISTS [table]
  // 移除 file_hashes / schema_registry 条目
})

vault.on('rename', (file: TFile, oldPath: string) => {
  // UPDATE _binding SET file_path = ? WHERE file_path = ?
})
```

---

### Phase 14: 状态栏 + 日志

| 属性 | 内容 |
|------|------|
| **目标** | 用户界面反馈：状态栏提示 + 日志查看 |
| **依赖** | Phase 8 |
| **状态** | ✅ **已完成**（Milestone 1/4 v2） |

> **v2 变更**：基础状态栏在 Milestone 1 实现占位，Milestone 4 增强为完整诊断面板（`EngineDiagnostics`），包括 WAL 实时统计、Schema 查询、诊断命令（retry/discard/show）。日志通过 `DiagnosticsManager` 管理。

**实际代码路径**：
```
Obsidian-mddb/src/main.ts               # 状态栏占位
Obsidian-mddb/src/engine/diagnostics.ts  # EngineDiagnostics 增强（uptimeMs, recentErrorCount）
Obsidian-mddb/src/engine/engine.ts       # executeDiagnosticCommand() + getDiagnostics()
```

**状态栏**：
- 显示：`"MD-DB: N tables, X errors, Y warnings"`
- 点击 → 弹出错误详情面板（表格列出所有 error/warning）

**日志系统**：
- 位置：`.obsidian/plugins/md-db/logs/{YYYY-MM-DD}.log`
- 格式：`[HH:MM:SS] [LEVEL] [TABLE] message`
- 滚动策略：保留最近 7 天

---

### Phase 15: 查询引擎 ✅

| 属性 | 内容 |
|------|------|
| **目标** | 实现结构化查询对象 → SQL 翻译 → 标准化 ResultSet 的完整查询引擎 |
| **依赖** | Phase 9 (CRUD), Phase 2 (SQLite 基础设施) |
| **状态** | ✅ **已完成**（Milestone 1/4 v2） |
| **设计参考** | `docs/specs/2026-06-10-query-engine-design.md` (16 项决策) |

**实际代码路径**：
```
Obsidian-mddb/src/query/
├── types.ts              # Query, FilterGroup, ResultSet（含分页 metadata、RefFollow）
├── validator.ts          # QueryValidator — 7 条验证规则
├── sql-generator.ts      # SQLGenerator — Query → SQL（默认 LIMIT 200、MAX 5000、多字段排序、聚合别名）
├── sql-generator.test.ts # 12 tests
├── assembler.ts          # ResultAssembler — 原始结果 → ResultSet（含 decimal 格式化）
└── engine.ts             # QueryEngine + rawSQL 安全层（三层：internal/user/view）
```

**Milestone 4 增强**：
- 默认 LIMIT 200（安全上限 MAX 5000）
- 多字段排序（SortClause[]）
- Ref follow 两步查询（主表 → 提取 ref 值 → 目标表 IN 查询 → 合并结果 + 别名前缀）
- 分页 metadata（page / pageSize / totalPages / hasMore / durationMs）
- GROUP BY + HAVING
- raw SQL 三层安全检查（internal / user / view）

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 查询 §1 | `query-engine-design.md` | 视图层（B）为主用户，DQL 远期 |
| 查询 §2 | `query-engine-design.md` | 结构化查询对象 (C) + raw SQL escape hatch (A) |
| 查询 §3 | `query-engine-design.md` | 表达能力边界：单表/过滤/聚合/ref ∈ C；JOIN/子查询 ∈ raw |
| 查询 §4 | `query-engine-design.md` | ResultSet `{ rows, columns, total, page }` |
| 查询 §5 | `query-engine-design.md` | 同步执行模型 |
| 查询 §6 | `query-engine-design.md` | 递归 FilterGroup + 11 种操作符 |
| 查询 §7 | `query-engine-design.md` | groupBy + aggregates[] + having |
| 查询 §8 | `query-engine-design.md` | ref 跟随：两步查询，断裂 = NULL |
| 查询 §9 | `query-engine-design.md` | raw SQL = 独立方法 `queryRaw()` |
| 查询 §10 | `query-engine-design.md` | raw SQL 需要 params，结构化不需要 |
| 查询 §11 | `query-engine-design.md` | 7 条验证规则，宽松模式 |
| 查询 §12 | `query-engine-design.md` | Validator → Generator → Assembler 模块架构 |
| 查询 §13-16 | `query-engine-design.md` | SelectClause、SortClause、decimal、边缘情况 |

---

### Phase 16: 事务模型 ✅

| 属性 | 内容 |
|------|------|
| **目标** | 实现混合模式事务：自动事务 + 显式事务，单文件 WAL 驱动 + 跨文件 WAL 驱动 |
| **依赖** | Phase 9 (CRUD), Phase 10 (WAL 基础设施) |
| **状态** | ✅ **已完成**（Milestone 5 v2，SAVEPOINT 回滚 + WAL 收集 + 批量操作） |

> **v2 变更**：TransactionManager 使用 SAVEPOINT 包装而非 BEGIN/COMMIT 嵌套。事务回调中收集 WalOperation 元数据，提交时统一创建 WAL。

**实际代码路径**：
```
Obsidian-mddb/src/transaction/
├── types.ts              # Transaction 接口 + UpdatePair + TransactionContext + TransactionMode
├── transaction-manager.ts # TransactionManager（SAVEPOINT 回滚 + WAL 收集 + 批量操作）
└── transaction-manager.test.ts # 13 tests（基本事务/回滚/批量/WAL/生命周期）

Obsidian-mddb/src/engine/engine.ts  # 集成：transaction() 公开 API
```

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 事务 §1 | `transaction-model-design.md` | 覆盖范围：批量原子性 + 崩溃一致性 + 外部修改冲突 |
| 事务 §2 | 同上 | 混合模式：autocommit + `engine.transaction(cb)` |
| 事务 §3 | 同上 | 隔离级别：SQLite 默认 |
| 事务 §4 | 同上 | 内存-文件桥接：单文件 → 文件先写，跨文件 → WAL 驱动 |
| 事务 §5 | 同上 | 冲突策略：显式乐观锁 + 自动最后写入胜出 |
| 事务 §6 | 同上 | 回滚：单文件完美回滚，跨文件 WAL 最终一致 |
| 事务 §7 | 同上 | 嵌套事务：Flat Nesting |
| 事务 §8 | 同上 | tx 对象：CRUD + query + queryRaw，throw 触发回滚 |
| 事务 §9 | 同上 | 单文件执行：SQLite 先行 → commit 验证 + vault.process() |
| 事务 §10 | 同上 | 跨文件执行：SQLite COMMIT → WAL 持久化 → 逐个 vault.process() |
| 事务 §11 | 同上 | 自动事务：insert() 独立，insertAll() 批量 |
| 事务 §12 | 同上 | WAL 格式：事务级 JSON 文件，与 Phase 10 共享 |
| 事务 §13 | 同上 | Phase 10 已实现 WalManager，事务模块直接复用 |
| 事务 §14 | 同上 | 路径自动检测：commit 时数涉及文件数 |

---

### Phase 17: 视图层 API ✅

| 属性 | 内容 |
|------|------|
| **目标** | 实现 BaseViewModel 抽象层 + 表格视图 + 表单视图，包含声明式语法、完整 CRUD 交互、跨视图数据同步 |
| **依赖** | Phase 15 (查询引擎), Phase 16 (事务模型) |
| **状态** | ✅ **已完成**（Milestone 4/6 v2） |
| **设计参考** | `docs/specs/2026-06-10-view-layer-design.md` (35 项决策 + 1 项引擎变更) |

**实际代码路径**：
```
Obsidian-mddb/src/view/
├── parser.ts              # parseTableBlock / parseFormBlock（mddb-table + mddb-form）
├── parser.test.ts         # 15 tests
├── base-view-model.ts     # 抽象基类：ViewState 管理 + EventBus + 生命周期
├── integration.ts         # ViewIntegration：注册视图类型、从代码块打开表格
├── shared/
│   ├── types.ts           # ViewStatus、TableViewState、ViewColumn、ViewRow、ViewEvent
│   ├── event-bus.ts       # 事件总线：精确类型 + 通配符 + 异常隔离
│   ├── event-bus.test.ts  # 6 tests
│   ├── data-layer.ts      # Engine ↔ View 反应式桥接：查询/缓存/分页/排序/auto-refresh
│   └── data-layer.test.ts # 8 tests
├── table/
│   ├── table-config.ts    # TableConfig + 列类型→对齐猜测
│   ├── table-config.test.ts # 4 tests
│   ├── table-view-model.ts # 分页/排序状态管理
│   ├── table-view-model.test.ts # 6 tests
│   └── table-view.ts      # Obsidian ItemView 实现
└── double-parse.test.ts   # 6 tests（双重解析竞态验证）
```

> **Milestone 6 增强**：表单视图（mddb-form 代码块解析、类型控件映射、ref 下拉数据加载、提交状态反馈）、双重解析保护（el.hasClass('mddb-rendered') 永久标记）。

**产出清单**：
```
src/view/
├── parser.ts              # parseTableBlock / parseFormBlock
├── base-view-model.ts     # BaseViewModel（查询/CRUD/事件/过滤/排序/格式化）
├── table/
│   ├── table-view-model.ts
│   ├── table-view.ts      # TableView — DOM 渲染、虚拟滚动、事件绑定
│   └── table-config.ts
├── form/
│   ├── form-view-model.ts
│   ├── form-view.ts       # FormView — DOM 渲染、字段控件映射
│   └── form-config.ts
├── shared/
│   ├── event-bus.ts
│   ├── data-layer.ts
│   ├── view-config.ts
│   └── types.ts
└── integration.ts         # registerViewLayer()
```

**关键实现要点**：

- **BaseViewModel 继承体系**：Base 负责查询/过滤/排序/CRUD/事件/分页/格式化；Table 加列元数据/行编辑/行选择；Form 加字段校验/脏跟踪/提交控制
- **ViewModel/View 分离**：ViewModel 不碰 DOM，View 管虚拟滚动和事件绑定
- **声明式语法**：`mddb-table`（`from`/`show`/`sort by`/`where`/`limit`）和 `mddb-form`（`to`/`fields`/`mode`/`layout`/`keep-open`）两种代码块，通过 MarkdownPostProcessor 渲染
- **事件系统**：`on(type, cb)` + discriminated union，`data-changed` / `state-changed` / `error` 三种事件。内置递归保护：同类型事件最大递归深度 10 → 超出丢弃 + 日志告警
- **生命周期**：数据层全局池化（EventBus + 缓存），UI 层随代码块创建/销毁
- **即时写穿**：行内编辑失焦即保存，表单提交走事务
- **多列排序**：默认替换，Shift+点击添加排序列，列头显示序号
- **无限滚动**：滚动自动加载 + 虚拟滚动渲染
- **客户端全量校验**：表单提交前校验类型/必填/格式/PK唯一性/ref引用
- **运行时配置写回**：UI 调整自动写回代码块（debounce 300ms + 脏检测）
- **INSERT 策略**：保持 Phase 9 的「末尾追加」设计。物理行位置 = 写入时序（不变），显示顺序由 `@sort` 控制。表格视图"插入到第 N 行下方"仅影响初始显示位置（如日期默认填当天），不控制物理行号

**实现此阶段的决策**：

| 决策编号 | 来源 | 内容 |
|---------|------|------|
| 视图 §1-2 | `view-layer-design.md` | BaseViewModel + 继承，分层原则 |
| 视图 §3 | 同上 | 事件系统：`on(type, cb)` + discriminated union |
| 视图 §4-6 | 同上 | 声明式语法：`from`/`show`/`sort by`/`where`/`limit` |
| 视图 §7-9 | 同上 | 渲染方式、行内编辑、即时自动保存 |
| 视图 §10 | 同上 | 列选择器 + 右键隐藏 |
| 视图 §11-13 | 同上 | 表单场景、`to`/`fields`/`mode`、三种模式 |
| 视图 §14 | 同上 | 生命周期：数据层池化 + UI 随块 |
| 视图 §15 | 同上 | 错误展示：状态栏 + 内联 |
| 视图 §16 | 同上 | 表单控件按类型自动映射 |
| 视图 §17-19 | 同上 | 提交行为、配置写回、客户端全量校验 |
| 视图 §20-22 | 同上 | 新增/删除入口、多列排序 |
| 视图 §24-28 | 同上 | 写回并发、依赖注入、插入行为、分页、表单布局 |
| 视图 §29 | 同上 | INSERT 保持末尾追加，显示顺序由 @sort 控制 |
| 视图 §30-35 | 同上 | 排序语义、view 多匹配、解析器、View分离、文件结构、集成入口 |

---

### Phase 18: 多文件表 ✅

| 属性 | 内容 |
|------|------|
| **目标** | 一张表跨多个 .md 文件（分区/分片） |
| **依赖** | Phase 15 |
| **状态** | ✅ **已完成**（Milestone 5 v2） |

> **v2 实现**：`SchemaRegistry` 从 `table → file` 改为 `table → sources[]`。`CrudExecutor.resolveTableFile()` 优先查找 `writeTarget=true` 的 source。文件删除时调用 `schemaRegistry.removeFile()` 移除 source，仅当 `table.sources` 为空时才 DROP TABLE。详见 `schema-registry.ts`。

**实际代码路径**：
```
Obsidian-mddb/src/storage/schema-registry.ts  # TableSource[] + removeFile
Obsidian-mddb/src/write/crud-executor.ts       # resolveTableFile
Obsidian-mddb/src/engine/engine.ts              # onFileDeleted 多文件安全删除
```

**待决策**：
- 分区键声明语法
- 分区裁剪（查询优化器）
- 跨文件聚合
- 分区发现机制

---

### Phase 19: A 形式 + C 形式适配层 ⬜

| 属性 | 内容 |
|------|------|
| **目标** | 文件即记录 (A) 和块即记录 (C) 映射到 B 形式内核 |
| **依赖** | Phase 8 |
| **状态** | **⬜ 待设计**（v2 后置） |

> **v2 状态**：A/C 形式适配已列为 Milestone 6 后置内容，当前未实现。适配原则已确定：内核统一处理 B 形式 Record，A/C adapter 只负责映射与序列化，QueryEngine 不感知源格式，BindingRow 记录 sourceKind。

**待决策**：
- A 形式：YAML frontmatter → B 形式字段映射
- C 形式：块标记语法 → B 形式行映射
- 混合格式 vault 支持
- 翻译层的性能开销

---

### Phase 20: 插件设置 + UX

| 属性 | 内容 |
|------|------|
| **目标** | 插件设置面板、命令面板、功能区图标 |
| **依赖** | Phase 0 |
| **状态** | ✅ **部分已完成**（Milestone 6 v2） |

**实际代码路径**：
```
Obsidian-mddb/src/settings.ts   # MDDBSettingTab + MDDBSettings 类型
```

**已实现**：
- 设置面板：日志级别、自动扫描开关、后台重扫间隔 ✅
- 命令面板：`MD-DB: Rescan vault`、`MD-DB: Show stats`、`MD-DB: Clear cache`、`MD-DB: Retry dead WAL`、`MD-DB: Show diagnostics` ✅

**未实现**：
- 数据路径/缓存路径/WAL 路径配置 ⬜
- raw SQL 高级模式开关 ⬜
- 最大查询行数配置 ⬜
- `MD-DB: Clear logs` / `MD-DB: Rebuild cache` 命令 ⬜

---

## 三、依赖关系图

> **注意**：下方是 v1 的 Phase 依赖图。所有已标记 ✅ 的 Phase 均已在 v2 Milestone 中实施完成。
> 完整实施状态请参考 `2026-06-11-implementation-roadmap-v2.md`。

```
Phase 0: Scaffold ✅
    │
    ├── Phase 1: Data Structures ✅
    │       │
    │       ├── Phase 2: Binding Table + SQLite ✅
    │       │
    │       ├── Phase 3: Schema Resolver ✅
    │       │       │
    │       │       ├── Phase 4: Lexer ✅
    │       │       │       │
    │       │       │       ├── Phase 5: Type Converter ✅
    │       │       │       │
    │       ├─── Phase 6: Validator ✅
    │       │       │
    │       ├─── Phase 7: Writer ✅
    │       │       │
    │       │       ├── Phase 8: Pipeline Integration ✅
    │       │       │       │
    │       │       │  Phase 9: CRUD ✅
    │       │       │       │
    │       │       │       ├── Phase 10: WAL ✅
    │       │       │       ├── Phase 11: Rescan ✅
    │       │       │       ├── Phase 12: Cold Start ✅
    │       │       │       ├── Phase 13: File Watcher ✅
    │       │       │       ├── Phase 14: Status Bar ✅
    │       │       │       │
    │       │       │  Phase 15: Query Engine ✅
    │       │       │       │
    │       │       │       ├── Phase 16: Transaction ✅
    │       │       │       ├── Phase 17: View API ✅
    │       │       │       ├── Phase 18: Multi-file ✅
    │       │       │
    │       │       ├── Phase 19: A/C Adapters ⬜
    │
    └── Phase 20: Settings + UX ✅ (partial)

    v2 test count: 316 tests ✅
    Status: 19/20 phases implemented (Phase 19 ⬜ pending design)
```

---

## 四、决策 → 阶段交叉引用

### 存储引擎决策

> **v2 替代说明**：以下决策中，存储 §2（三层主键）和 §3（storage_pk 不可变）已被 `identity-model.md` 替代。
> 存储 §13（行级 WAL）已被 `wal-replay-protocol.md` 的 WAL v2 operations 替代。
> 详情见 `2026-06-11-implementation-roadmap-v2.md` §十二 替代范围表。

| # | 决策 | 实施阶段 | 参考文档节 |
|---|------|:---:|------|
| 1 | 引擎内核统一抽象 | Phase 1, 4 | `storage-engine-design.md` §1 |
| 2 | 三层主键体系 | Phase 1, 7 | §2 |
| 3 | 存储 PK 不可变 | Phase 7 | §2.2 |
| 4 | 行号漂移维护 | Phase 9 | §3.3 |
| 5 | 物理删除后续行上移 | Phase 9 | §4.2 |
| 6 | @sort 与 @pk 解耦 | Phase 1 | §2.5 |
| 7 | 即时写穿 | Phase 9, 10 | §5.1 |
| 8 | 插入位置末尾追加 | Phase 9 | §4.1 |
| 9 | Vault API 代理写 | Phase 9 | §5.2 |
| 10 | 乐观写 + WAL 补偿 | Phase 10 | §5.3 |
| 11 | 不提供 compact | Phase 9 | §6.1 |
| 12 | 三层重扫策略 | Phase 11 | §6 |
| 13 | 行级 WAL | Phase 10 | §7.1 |
| 14 | WAL 存储位置 | Phase 10 | §7.1 |
| 15 | 缓存优先冷启动 | Phase 12 | §8 |
| 16 | 空值占位符 `-` | Phase 1, 5 | §9.1.1 |

### 解析管道决策

> **v2 替代说明**：以下决策基本保持有效。D16（物理行号）在 v2 中不再作为 storagePk 组成部分，
> 但仍用于定位。v2 新增 SQL identifier 安全规则（`sql-safety-rules.md`）。

| # | 决策 | 实施阶段 | 参考文档节 |
|---|------|:---:|------|
| D1 | ` ```mddb` 围栏块 | Phase 4 | `parse-pipeline-design.md` §1.2 |
| D2 | 纯 B 形式数据 | Phase 4 | §1.2 |
| D3 | `\|` 转义 | Phase 4 | §3.2 |
| D4 | 转换失败宽松默认 | Phase 5 | §4.3 |
| D5 | 字段数不匹配处理 | Phase 6 | §5.2 |
| D6 | @指令 + YAML 统一 | Phase 3 | §2.2 |
| D7 | 不支持标题/分隔符行 | Phase 4 | §3.1 |
| D8 | 多块追加规则 | Phase 4 | §1.2 |
| D9 | 不需要 `---` | Phase 3 | §2.1 |
| D10 | Schema 优先级 | Phase 3 | §2.1 |
| D11 | Schema 路径 | Phase 3 | §2.1 |
| D12 | 围栏信息串 | Phase 3 | §2.1 |
| D13 | `-` = 违反 @required | Phase 6 | §5.3 |
| D14 | PK 冲突 first-write-wins | Phase 6 | §5.4 |
| D15 | ParseResult 错误收集 | Phase 1, 6 | §5.6 |
| D16 | 物理行号 | Phase 7 | §6.1 |
| D17 | .trim() 空白处理 | Phase 4 | §3.3 |

---

## 五、子代理实施指南

> **⚠️ 注意**：v1 Phase 体系已被 v2 Milestone 体系替代。
> 新实施应参考 `2026-06-11-implementation-roadmap-v2.md` 的 Milestone 顺序。
> 以下指南保留供参考，实施前请查阅 v2 文档确认契约变化。

### 5.1 开始前的准备

1. **阅读设计文档**：根据交叉引用表，找到对应阶段的参考章节
2. **检查现有代码**：确认依赖阶段是否已完成，了解已有接口
3. **理解上下文**：每个阶段开头的「决策引用」列出了该阶段落实的设计决策

### 5.2 实施原则

- **依赖顺序**：严格按照依赖图，不跳过依赖阶段
- **测试驱动**：每个阶段应有对应的单元测试，使用设计文档中的示例数据作为测试用例
- **接口优先**：先定义接口，再实现逻辑
- **最小可行**：先实现核心路径，边缘情况后期补充
- **决策追溯**：如果实施中发现需要偏离设计文档，记录原因和替代方案

### 5.3 阶段产出模板

每个阶段完成后应交付：

```
src/
├── [module]/
│   ├── [module].ts       # 核心实现
│   ├── [module].test.ts  # 测试
│   └── types.ts          # 阶段专用类型（如有）
```

### 5.4 并行机会

以下阶段组无相互依赖，可并行开发：

- **组 A**（初始并行）：Phase 1 + Phase 3（Schema 解析器不依赖 Schema 对象之外的 Phase 2 东西）
- **组 B**（中层并行）：Phase 14（状态栏/日志）可与 Phase 9-13 并行
- **组 C**（设计并行）：Phase 15-19 的设计讨论可同时进行

### 5.5 关键技术栈

- **语言**：TypeScript
- **运行环境**：Obsidian Plugin API
- **SQLite**：sql.js（WASM，无原生依赖）
- **测试框架**：jest 或 vitest（mock Obsidian API）
- **哈希**：Node.js crypto 或 Web Crypto API（SHA256）

---

## 六、文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| 存储引擎设计 | `docs/specs/2026-06-10-storage-engine-design.md` | 架构、PK、CRUD、WAL、冷启动（v1） |
| 解析管道设计 | `docs/specs/2026-06-10-parse-pipeline-design.md` | 6 阶段解析流程（v1） |
| 查询引擎设计 | `docs/specs/2026-06-10-query-engine-design.md` | 结构化查询、过滤、聚合、ref 跟随（v1） |
| 事务模型设计 | `docs/specs/2026-06-10-transaction-model-design.md` | 混合事务、WAL 驱动、乐观锁、回滚语义（v1） |
| 视图层设计 | `docs/specs/2026-06-10-view-layer-design.md` | BaseViewModel、表格/表单视图、声明式语法、35 项决策（v1） |
| **实施路线图 v2** 🔥 | **`docs/specs/2026-06-11-implementation-roadmap-v2.md`** | **当前实施的事实源** |
| 身份模型 v2 | `docs/specs/2026-06-11-identity-model.md` | BindingRow v2、storagePk 策略、blockId |
| SQL 安全规则 | `docs/specs/2026-06-11-sql-safety-rules.md` | identifier 规则、raw SQL 分层 |
| WAL 重放协议 | `docs/specs/2026-06-11-wal-replay-protocol.md` | WAL v2 operation 格式、幂等规则 |
| 运行时架构 | `docs/specs/2026-06-11-runtime-architecture.md` | MDDBEngine facade、事件系统、LockManager |
| 查询引擎实施计划 | `docs/superpowers/plans/2026-06-10-query-engine-implementation.md` | 7 任务、40 测试 |
| 架构构思 | `构思v1.0.md` | 原始设计讨论、视图层、路线图 |
| AGENTS.md | `Obsidian-mddb/AGENTS.md` | 项目上下文：架构决策、Schema 规范、编码约定 |
| **本文档** | `docs/specs/2026-06-10-implementation-roadmap.md` | 实施路线图 v1（已归档） |
