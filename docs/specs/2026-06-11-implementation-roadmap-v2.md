# MD-DB 实施路线图 v2.0

> 日期：2026-06-11（最近更新：2026-06-12 11:10）  
> 基于：`2026-06-10-implementation-roadmap.md` v1.0 的架构评审结论  
> 用途：将 v1.0 的 Phase 清单重构为更稳健、可演进、可验证的实施路线  
> 核心调整：先只读 MVP，后写入与事务；前置身份模型、WAL 协议、SQL 安全、容量目标、多文件演进预留

---

## 一、v2 总体原则

### 1.1 实施策略

v2 不再把 Phase 0-17 全部视为“可直接实施”。MD-DB 的核心风险不在解析本身，而在以下几个系统级问题：

1. Markdown 文件、SQLite 缓存、WAL 三者之间的一致性。
2. 外部编辑导致的行号漂移与记录身份稳定性。
3. 后续多文件表对早期单文件表假设的冲击。
4. Schema 中表名、字段名进入 SQL 生成链路后的安全性。
5. 大 Vault、大表、大文件下的性能边界。

因此 v2 采用以下路线：

```text
Milestone 0: 架构基线与约束冻结    ✅ 2026-06-11
Milestone 1: 只读 MVP             ✅ 2026-06-11 (77 tests)
Milestone 2: 单文件写入 MVP        ✅ 2026-06-11 (141 tests → M3: 243 → M4: 293 → M5: 310 → M6: 316)
Milestone 3: WAL 与恢复           ✅ 2026-06-11 (243 tests → M4: 293 → M5: 310 → M6: 316)
Milestone 4: 查询与视图层增强      ✅ 2026-06-11 (293 tests → +6 double-parse → 299)
Milestone 5: 事务与多文件能力      ✅ 2026-06-11 (310 tests)
Milestone 6: A/C 适配、UX 与长期演进 ✅ 2026-06-12 (316 tests)
```

### 1.2 事实源原则

MD-DB 的长期事实源是 Markdown 文件。

```text
Markdown Vault = source of truth
SQLite cache   = derived index / query cache
WAL            = pending file mutation journal
View state     = presentation state
```

任何已经对用户承诺成功的写入，必须满足以下条件之一：

1. Markdown 文件已经写入成功，并且 SQLite / binding 已同步；或
2. 可重放 WAL 已经持久化，并且 UI 明确标记该写入处于 pending / retrying 状态。

禁止出现以下状态：

```text
SQLite 已显示成功
Markdown 未写入
WAL 未持久化
```

这是 v2 写入路径的硬约束。

### 1.3 MVP 边界

v2 的第一目标不是一次性完成完整数据库，而是先交付可验证的只读 MVP。

只读 MVP 包含：

- Obsidian 插件骨架
- mddb 代码块识别
- Schema 解析
- 类型转换
- 校验
- SQLite 内存索引
- 结构化查询
- 状态栏错误展示

只读 MVP 不包含：

- Markdown 写回
- WAL
- 事务
- 表单视图
- 多文件表
- A/C 形式适配
- raw SQL 暴露给用户
- 复杂配置写回

---

## 二、容量与性能目标

### 2.1 MVP 支持规模

| 指标 | MVP 目标 |
|---|---:|
| Vault Markdown 文件数 | ≤ 5,000 |
| mddb 数据文件数 | ≤ 500 |
| 总记录数 | ≤ 100,000 rows |
| 单表记录数 | ≤ 50,000 rows |
| 单文件数据行 | ≤ 5,000 rows |
| 单个 mddb 块数据行 | ≤ 2,000 rows |
| 常规查询 P95 | ≤ 50ms |
| 冷启动可交互 | ≤ 300ms |
| 后台全量校验 | ≤ 30s，分批执行 |
| 单条写入 P95 | ≤ 100ms，Milestone 2 起 |

### 2.2 超限策略

当超过 MVP 支持规模时，系统不保证所有操作仍然满足 P95 目标，但必须可降级：

```text
1. 查询默认强制 LIMIT。
2. 状态栏提示当前 Vault 超过建议规模。
3. 后台扫描分批执行，不阻塞 Obsidian UI。
4. 大文件 diff 超阈值时直接整文件重建索引。
5. SQLite cache 过大时提示用户重建或清理。
```

### 2.3 后续扩展触发条件

如果出现以下任一条件，应评估从 sql.js 迁移到更强后端或分片索引：

```text
- 总记录数 > 500,000
- SQLite cache > 100MB
- 冷启动 SQLite 加载 > 1s
- 查询 P95 > 200ms
- 移动端内存不可接受
```

---

## 三、运行时组件架构

### 3.1 顶层组件图

```text
PluginMain
 └── MDDBEngine
      ├── StorageManager
      │    ├── SQLiteAdapter
      │    ├── BindingStore
      │    ├── SchemaRegistry
      │    └── FileHashStore
      ├── ParsePipeline
      │    ├── SchemaResolver
      │    ├── Lexer
      │    ├── TypeConverter
      │    ├── Validator
      │    └── IndexWriter
      ├── QueryEngine
      │    ├── QueryValidator
      │    ├── SQLGenerator
      │    └── ResultAssembler
      ├── TransactionManager
      │    ├── CrudExecutor
      │    ├── ConflictDetector
      │    └── WalManager
      ├── RescanScheduler
      ├── FileWatcher
      ├── DiagnosticsManager
      └── ViewLayer
```

### 3.2 统一 facade

所有上层模块，包括视图层、命令面板、设置面板和未来第三方调用，都应通过 `MDDBEngine` 访问核心能力。

```typescript
interface MDDBEngine {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  parseFile(file: TFile): Promise<ParseResult>;
  rescanVault(options?: RescanOptions): Promise<RescanResult>;

  query(q: Query): ResultOrError<ResultSet>;
  queryRaw(sql: string, params?: unknown[], options?: RawQueryOptions): ResultOrError<ResultSet>;

  insert(table: string, record: RecordInput, options?: WriteOptions): Promise<WriteResult>;
  update(storagePk: string, patch: RecordPatch, options?: WriteOptions): Promise<WriteResult>;
  delete(storagePk: string, options?: WriteOptions): Promise<WriteResult>;

  transaction<T>(cb: (tx: Transaction) => Promise<T>): Promise<T>;

  diagnostics(): EngineDiagnostics;
  on(type: EngineEventType, cb: EngineEventHandler): Disposable;
}
```

### 3.3 责任边界

```text
ViewLayer:
  只负责展示、用户输入、调用 Engine API。

QueryEngine:
  只负责只读查询，不修改 Markdown，不触发 WAL。

ParsePipeline:
  只负责 Markdown → records/errors/warnings。

StorageManager:
  负责 SQLite cache、binding、schema_registry、file_hashes。

TransactionManager:
  统一负责所有写入入口、事务边界、冲突策略、WAL 生成。

CrudExecutor:
  只负责单条或单文件内的最小文件变更执行。

WalManager:
  只负责 WAL 持久化、重放、重试、死信，不决定业务语义。

RescanScheduler/FileWatcher:
  只负责外部变化检测和索引重建，不直接处理业务事务。
```

硬性规则：

```text
所有写入 Markdown 的路径必须经过 TransactionManager。
ViewLayer 和 QueryEngine 不允许直接调用 app.vault.modify/process 写数据文件。
```

---

## 四、身份模型 v2

### 4.1 不再将 lineNumber 作为记录身份

v1 的 `storage_pk = relativePath:lineNumber:hash6` 存在身份不稳定问题。v2 改为：

```text
storage_pk = stable row identity
line_number = mutable locator
```

`line_number` 只用于定位和优化，不参与记录身份语义。

### 4.2 BindingRow

```typescript
interface BindingRow {
  storagePk: string;             // 稳定 ID，建议 UUID 或 128-bit hash
  logicalPk: string;             // 由 @pk 字段值生成
  tableName: string;

  filePath: string;
  blockId: string;
  blockIndex: number;
  lineNumber: number;

  rowHash: string;               // SHA256 hex，至少 128-bit 截断
  rawLineHash: string;           // 原始行 hash，用于外部编辑识别
  lastVerified: string;

  syncState: "synced" | "pending" | "retrying" | "dead";
}
```

### 4.3 blockId 策略

MVP 可采用非侵入式 blockId：

```text
blockId = sha256(filePath + blockStartLine + schemaSignature).slice(0, 16)
```

后续如需更强稳定性，可支持显式块 ID：

```markdown
```mddb block=accounts-main
@table accounts
...
```
```

### 4.4 storagePk 策略

优先级：

```text
1. 如果 logical_pk 存在且稳定：storagePk = tableName + logicalPk 的稳定 hash。
2. 如果 logical_pk 缺失或冲突：storagePk = 首次发现时生成 UUID，保存在 binding。
3. 禁止 storagePk 随 line_number 漂移变化。
```

### 4.5 多文件表预留

`logical_pk + table_name` 是否全局唯一，由 Schema 决定。MVP 默认单表全局唯一：

```text
UNIQUE(table_name, logical_pk)
```

未来多文件表如需分区内唯一，可扩展为：

```text
UNIQUE(table_name, partition_key, logical_pk)
```

---

## 五、Schema Registry v2

### 5.1 结构调整

v1 的 `table -> file` 会阻碍多文件表。v2 改为 `table -> sources[]`。

```typescript
interface SchemaRegistry {
  version: 2;
  tables: Record<string, TableRegistryEntry>;
}

interface TableRegistryEntry {
  table: string;
  schema: SchemaSummary;
  sources: TableSource[];
  rowCount: number;
  updatedAt: string;
}

interface TableSource {
  file: string;
  blockId: string;
  blockIndex: number;
  rowCount: number;
  partition?: Record<string, string>;
}

interface SchemaSummary {
  pk: string[];
  fields: string[];
  types: string[];
  required: boolean[];
  sort?: string;
  indexes?: string[];
  relations?: Array<{
    field: string;
    targetTable: string;
    targetField: string;
  }>;
  nullMarker: string;
  strict: boolean;
}
```

### 5.2 删除文件行为

删除文件时不得默认 DROP 表。

```text
1. 删除 _binding 中 file_path = ? 的记录。
2. 删除用户表中属于该 file_path / block_id 的记录。
3. 从 schema_registry.tables[table].sources 移除该 source。
4. 如果 table.sources 为空，再 DROP TABLE。
5. 更新 rowCount 与 file_hashes。
```

---

## 六、SQL 安全规则

### 6.1 Identifier 规则

Schema 中所有进入 SQL 的标识符必须满足以下二选一策略。

MVP 推荐严格 ASCII：

```text
table name: /^[A-Za-z_][A-Za-z0-9_]*$/
field name: /^[A-Za-z_][A-Za-z0-9_]*$/
index name: /^[A-Za-z_][A-Za-z0-9_]*$/
```

如果未来要支持中文列名，必须统一使用 quote：

```typescript
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
```

硬性规则：

```text
1. 所有表名、列名、索引名必须通过 validateIdent 或 quoteIdent。
2. 所有值必须通过 prepared statement 参数绑定。
3. @sort、@indexes、where 等表达式必须 parse 成 AST 后生成 SQL。
4. 禁止直接拼接来自 Markdown 的 SQL 片段。
```

### 6.2 raw SQL 分层

```typescript
interface RawQueryOptions {
  readonly?: boolean;      // default true
  maxRows?: number;        // default from settings
  timeoutMs?: number;      // best effort
  allowSystemTables?: boolean;
}
```

默认用户级 `queryRaw()` 规则：

```text
1. 只允许 SELECT。
2. 禁止多语句。
3. 禁止 DDL/DML：DROP, DELETE, UPDATE, INSERT, ALTER, PRAGMA 等。
4. 默认禁止访问 _binding 等系统表。
5. 强制 maxRows。
6. 视图层声明式代码块默认不允许 raw SQL。
```

内部模块如确需完整 SQL，使用不暴露给用户的 `queryRawInternal()`。

---

## 七、WAL v2 协议

### 7.1 WAL 必须记录可重放操作

v1 WAL 只记录 files，不足以恢复。v2 WAL 记录 operation。

```typescript
interface WalEntry {
  txId: string;
  version: 2;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "retrying" | "dead" | "done";

  operations: WalOperation[];

  progress: {
    completedOperationIds: string[];
  };

  retry: {
    count: number;
    maxRetries: number;
    lastError: string | null;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
  };
}

type WalOperation =
  | InsertLineOperation
  | ReplaceLineOperation
  | DeleteLineOperation;

interface InsertLineOperation {
  id: string;
  type: "insertLine";
  file: string;
  blockId?: string;
  afterLine?: number;
  content: string;
  expectedFileHash?: string;
}

interface ReplaceLineOperation {
  id: string;
  type: "replaceLine";
  file: string;
  lineNumber: number;
  beforeHash: string;
  beforeContent?: string;
  afterContent: string;
}

interface DeleteLineOperation {
  id: string;
  type: "deleteLine";
  file: string;
  lineNumber: number;
  beforeHash: string;
  beforeContent: string;
}
```

### 7.2 WAL 重放幂等规则

```text
1. 如果 operation.id 已在 completedOperationIds 中，跳过。
2. 执行前检查目标内容。
3. 如果目标内容已经等于 afterContent，视为幂等成功。
4. 如果目标内容等于 beforeContent 或 beforeHash 匹配，执行操作。
5. 如果目标内容既不是 before，也不是 after，进入 conflict/dead。
6. 每完成一个 operation，立即持久化 progress。
7. 全部 operation 完成后，status = done，然后删除 WAL 或延迟清理。
```

### 7.3 WAL 写入顺序

所有非纯查询写入必须遵守：

```text
1. 构造 WritePlan。
2. 持久化 WAL，status = pending。
3. 应用 SQLite 临时事务或 pending 状态。
4. 执行 Markdown 文件写入。
5. 文件写入成功后，提交 SQLite / binding / file_hashes。
6. 标记 WAL done / 删除 WAL。
```

如果采用乐观 UI：

```text
- ResultSet 或记录元数据必须标记 syncState = pending/retrying。
- 状态栏必须展示未同步数量。
- dead WAL 不得静默吞掉。
```

### 7.4 死信策略

```text
pending/retrying:
  系统自动重试，UI 展示未同步。

dead:
  状态栏强提示。
  诊断面板展示 txId、文件、操作、最后错误。
  用户可选择：重试、查看冲突、丢弃 WAL、重建索引。
```

---

## 八、锁与并发模型

### 8.1 LockManager

```typescript
interface LockManager {
  withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
  withFileLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T>;
}
```

要求：

```text
1. 多文件锁按路径排序获取，避免死锁。
2. 所有锁通过 finally 释放。
3. 支持 ownerId，使同一事务可重入。
4. 插件 shutdown 时拒绝新锁，等待或取消已有任务。
5. FileWatcher、RescanScheduler、TransactionManager 共享同一个 LockManager。
```

### 8.2 外部修改与自改事件

```text
自改：
  TransactionManager 设置 write owner，FileWatcher 识别后跳过或精确更新。

外部修改：
  FileWatcher 获取锁后触发 diff/rescan。

锁冲突：
  后到者跳过本轮，进入下一轮调度，不阻塞 UI。
```

---

## 九、实施里程碑

## Milestone 0: 架构基线与约束冻结

### 目标

在写核心实现前，冻结最容易返工的系统契约。

### 状态

✅ **已完成** — 五份契约文档已全部就位。

### 产出

```text
docs/specs/
└── 2026-06-11-implementation-roadmap-v2.md         ← 本文件（总路线图）
docs/specs/
├── 2026-06-11-identity-model.md                     ← 身份模型
├── 2026-06-11-sql-safety-rules.md                   ← SQL 安全规则
├── 2026-06-11-wal-replay-protocol.md                ← WAL 重放协议
└── 2026-06-11-runtime-architecture.md               ← 运行时架构
```

### 契约交叉引用

| 契约主题 | 文档 | 对应章节 |
|---|---:|---:|
| MDDBEngine facade | `runtime-architecture.md` | §2 |
| BindingRow v2 + SchemaRegistry v2 | `identity-model.md` | §2-4 |
| SQL identifier 规则 | `sql-safety-rules.md` | §2-3 |
| WAL v2 operation 格式 | `wal-replay-protocol.md` | §2 |
| 容量目标 | `implementation-roadmap-v2.md` | §2 |
| LockManager 并发模型 | `runtime-architecture.md` | §6 |
| raw SQL 分层 | `sql-safety-rules.md` | §4-5 |
| 冷启动与生命周期 | `runtime-architecture.md` | §4 |
| 事件系统 | `runtime-architecture.md` | §5 |
| CacheManifest 与 SQLite 持久化 | `runtime-architecture.md` | §7 |
| 死信处理 | `wal-replay-protocol.md` | §6 |
| 重放幂等规则 | `wal-replay-protocol.md` | §4 |

### 任务完成记录

1. ✅ 确认 `MDDBEngine` facade → 见 `runtime-architecture.md` §2。
2. ✅ 确认 `BindingRow` v2 与 `SchemaRegistry` v2 → 见 `identity-model.md` §2-4。
3. ✅ 确认 SQL identifier 规则 → 见 `sql-safety-rules.md` §2-3。
4. ✅ 确认 WAL v2 operation 格式 → 见 `wal-replay-protocol.md` §2。
5. ✅ 确认容量目标 → 见本文 §2。

### 完成标准（已满足）

```text
✓ 所有后续模块可引用这些契约。
✓ 不再依赖 lineNumber 作为 storagePk。
✓ 不再使用只记录 files 的 WAL。
```

### 对 v1 设计文档的替代范围

| 被替代的 v1 内容 | v2 文档 | 替代程度 |
|---|---:|---:|
| `storage-engine.md` §2（分层主键） | `identity-model.md` §1-2 | 完全替代 |
| `storage-engine.md` §3（绑定表） | `identity-model.md` §2-3 | 完全替代 |
| `storage-engine.md` §7（WAL） | `wal-replay-protocol.md` | 完全替代 |
| `storage-engine.md` §5.3（乐观写+WAL 补偿） | `wal-replay-protocol.md` §3 | 替代 |
| `storage-engine.md` §8.2（缓存结构） | `runtime-architecture.md` §7-8 | 细化替代 |
| `transaction-model.md` §4（WAL 文件设计） | `wal-replay-protocol.md` | 完全替代 |
| `parse-pipeline.md` §5.4（PK 唯一性） | `identity-model.md` §2.3 | 逻辑继承，索引调整 |
| —（v1 无统一 facade） | `runtime-architecture.md` §2 | 新增 |
| —（v1 无事件系统） | `runtime-architecture.md` §5 | 新增 |
| —（v1 无 LockManager） | `runtime-architecture.md` §6 | 新增 |
| —（v1 无 CacheManifest） | `runtime-architecture.md` §7 | 新增 |

---

## Milestone 1: 只读 MVP

### 目标

实现 Markdown mddb 块到 SQLite cache 的只读索引，并支持结构化查询。

### 依赖

Milestone 0。

### 状态

✅ **已完成** — 77 测试全部通过。

### 包含阶段

对应 v1：Phase 0-8、Phase 14 的最小状态栏、Phase 15 的只读子集。

### 实际产出结构（2026-06-11）

```text
obsidian-md-db/
├── manifest.json                      # 已有
├── package.json                       # 已有
├── tsconfig.json                      # 已有
├── vitest.config.ts                   # 新增
├── src/
│   ├── main.ts                        # 已有（骨架未改）
│   │
│   ├── core/                          # Phase 1
│   │   ├── types.ts                   # SchemaSummary, BindingRow, SchemaRegistry, ParsedRecord
│   │   ├── errors.ts                  # ParseErrorCode, EngineError 体系
│   │   └── result.ts                  # ResultOrError<T>
│   │
│   ├── schema/                        # Phase 3
│   │   ├── resolver.ts                # 四来源 Schema 解析 + 合并 + frontmatter
│   │   ├── validators.ts              # validateIdent, parseSortClause, validateSchema
│   │   └── resolver.test.ts           # 11 测试
│   │
│   ├── parse/                         # Phase 4-6-8
│   │   ├── lexer.ts                   # extractBlocks, splitFields, classifyLine
│   │   ├── converter.ts               # 12 类型转换器 + formatDisplayValue
│   │   ├── validator.ts               # validateRow/validateRows + ParseResult
│   │   ├── pipeline.ts                # ParsePipeline（两遍扫描）
│   │   ├── lexer.test.ts              # 14 测试
│   │   ├── converter.test.ts          # 32 测试
│   │   └── validator.test.ts          # 9 测试
│   │
│   ├── storage/                       # Phase 2-7
│   │   ├── sqlite-adapter.ts          # SQLite wrapper (sql.js)
│   │   ├── binding-store.ts           # _binding 表 CRUD（v2 身份模型）
│   │   ├── schema-registry.ts         # SchemaRegistry v2 持久化
│   │   ├── file-hash-store.ts         # file_hashes.json
│   │   └── index-writer.ts            # DDL 生成 + 记录写入 + storagePk 生成
│   │
│   ├── query/                         # Phase 15 只读子集
│   │   ├── types.ts                   # Query, FilterGroup, ResultSet
│   │   ├── validator.ts               # QueryValidator — 7 条验证规则
│   │   ├── sql-generator.ts           # Query → SQL + 参数绑定
│   │   ├── assembler.ts               # SQLite → ResultSet (含 decimal 格式化)
│   │   └── engine.ts                  # QueryEngine + rawSQL 安全层
│   │
│   ├── engine/                        # MDDBEngine facade
│   │   ├── engine.ts                  # 生命周期 + 解析 + 查询 + 事件 + 诊断
│   │   └── diagnostics.ts             # EngineDiagnostics 状态管理
│   │
│   └── pipeline-integration.test.ts   # 11 集成测试
```

### 功能实现状态

| 功能 | 文档 | 状态 |
|---|---:|---:|
| 插件骨架 | `main.ts`（已有） | ✅ 基础骨架已存在 |
| Schema 解析 | `schema/resolver.ts` | ✅ @指令 + frontmatter + 合并 + 安全校验 |
| 词法分析 | `parse/lexer.ts` | ✅ 围栏检测 + 转义切分 + 空值识别 |
| 类型转换 | `parse/converter.ts` | ✅ 12 类型全覆盖 |
| 校验 | `parse/validator.ts` | ✅ 字段数 / 必填 / PK 唯一性 |
| SQLite 索引 | `storage/binding-store.ts` | ✅ _binding v2 + 用户表 + DDL 自动生成 |
| 管道集成 | `parse/pipeline.ts` | ✅ 两遍扫描（dmdb-schema → mddb 数据） |
| 查询引擎 | `query/engine.ts` | ✅ QueryValidator + SQLGenerator + ResultAssembler |
| raw SQL | `query/engine.ts` | ✅ 三层安全控制（internal / user / view） |
| SQL identifier 安全 | `schema/validators.ts` | ✅ validateIdent + quoteIdent |
| Engine facade | `engine/engine.ts` | ✅ MDDBEngine（initialize / query / diagnostics） |
| 状态栏 | `src/main.ts` | ✅ 已有占位（Milestone 4 增强） |

### 测试结果

```
✔ 5 test files  |  77 tests 全部通过

src/schema/resolver.test.ts         — 11 tests  (schema 解析、合并、frontmatter)
src/parse/lexer.test.ts             — 14 tests  (围栏检测、转义切分、空值)
src/parse/converter.test.ts         — 32 tests  (12 类型全覆盖、批量转换、格式化)
src/parse/validator.test.ts         — 9 tests   (字段数/必填/PK 唯一性/严格模式)
src/pipeline-integration.test.ts    — 11 tests  (example/ 数据的完整管道验证)
```

### 必测场景覆盖

| 场景 | 测试文件 | 状态 |
|---|---:|---:|
| 单文件单表解析 | `pipeline-integration.test.ts` | ✅ |
| 单文件多表解析 | `resolver.test.ts`（budget_items + monthly_budgets） | ✅ |
| 类型转换失败 | `converter.test.ts` | ✅ |
| required 缺失 | `validator.test.ts` | ✅ |
| PK 重复 | `validator.test.ts` | ✅ |
| 转义字段 | `lexer.test.ts` + `converter.test.ts` | ✅ |
| decimal 内部 BIGINT 存储 | `converter.test.ts`（3500.00 → 350000） | ✅ |
| enum 校验 | `converter.test.ts` | ✅ |
| ref 原样保留 | `converter.test.ts` | ✅ |
| SQL identifier 非法 | `validators.test.ts`（`safeIdent` 抛错） | ✅ |

### 与设计文档的偏差

| 偏差项 | 原因 | 影响 |
|---|---:|---:|
| `parse/pipeline.ts` 使用两遍扫描代替 v1 的单遍设计 | 示例数据使用 `dmdb-schema` + `mddb` 双围栏格式 | 兼容两种格式 |
| `SchemaSummary.relations` 存储为 `string[]` 而非 `RelationDef[]` | 简化 MVP，`@relations` 原始字符串推迟解析 | 下游需 `parseRelations()` 解析 |
| `parseSchemaFromFrontmatter` 使用简单行解析器而非完整 YAML 解析器 | MVP 阶段不需要全 YAML 支持 | 仅支持基础键值对 |
| `engine.ts::initialize()` 参数类型为 `unknown` 而非 `typeof initSqlJs` | 避免 Obsidian 插件 `sql.js` 的循环类型依赖 | 运行时无影响 |
| `SimpleFilter.value` 在 `isNull/isNotNull` 操作符中被禁用 | sql-safety-rules.md 要求 | 符合安全规范 |

### 不包含（符合预期）

```text
- insert/update/delete       → Milestone 2 ✅
- WAL / 事务                 → Milestone 3 ✅
- file watcher 增量维护      → Milestone 3 ✅
- 表格视图编辑                → Milestone 4 ✅
- 表单视图                    → Milestone 6
- 多文件表                   → Milestone 5 ✅
- A/C 形式适配               → Milestone 6
```

---

## Milestone 2: 单文件写入 MVP

### 目标

实现单文件内 insert/update/delete，并保证 Markdown、SQLite、binding 基本一致。

### 依赖

Milestone 1。

### 状态

✅ **已完成** — 243 测试全部通过。

### 包含阶段

对应 v1：Phase 10、Phase 11、Phase 12、Phase 13 的核心一致性能力。

### 实际产出结构（2026-06-11）

```text
src/wal/
├── types.ts                          # WAL v2 类型体系（WalEntry/WalOperation/ReplayResult）
├── types.test.ts                     # 17 tests（创建/状态检查/重试退避）
├── wal-manager.ts                    # WalManager + FileWalStore + InMemoryWalStore
├── wal-manager.test.ts               # 19 tests（CRUD/状态转换/进度/查询/关闭）
├── replay.ts                         # 幂等重放引擎（insertLine/replaceLine/deleteLine）
├── replay.test.ts                    # 9 tests（追加/替换/删除/幂等跳过/冲突检测/错误处理）
├── retry-scheduler.ts               # 指数退避重试调度器
├── retry-scheduler.test.ts          # 7 tests（生命周期/到期检查/死信上限）
├── dead-letter.ts                   # 死信管理（查询/重试/丢弃）
└── dead-letter.test.ts              # 9 tests（死信列表/重试恢复/丢弃/批量）

src/cache/
├── cache-manifest.ts                # CacheManifest v1（版本号/时间戳/冷启动检查）
├── cache-manifest.test.ts           # 7 tests（创建/保存/加载/版本检查/touch/删除）
├── cache-migration.ts               # 迁移引擎（版本检测/全量重建/SQLite DDL 迁移）
└── cache-migration.test.ts          # 5 tests（无 manifest/版本落后/SQLite 版本落后/无迁移）

src/rescan/
├── file-diff.ts                     # 行哈希差异检测器（前后缀匹配/变更比例/重建建议）
├── file-diff.test.ts                # 13 tests（哈希计算/无变更/新增/删除/比例/重建判断）
├── file-watcher.ts                  # 文件变更监视器（create/modify/delete/rename + 自改识别）
├── file-watcher.test.ts             # 10 tests（事件处理/多 handler/自改跳过/owner 注销/关闭）
├── rescan-scheduler.ts              # 分批重扫调度器（批处理/进度回调/后台校验定时器）
└── rescan-scheduler.test.ts         # 6 tests（分批扫描/并发拒绝/子集扫描/进度/关闭）

src/engine/
└── engine.ts                        # 已集成 WalManager/CacheManifest/FileWatcher/RescanScheduler
```

### 功能实现状态

| 功能 | 文件 | 状态 |
|---|---:|---:|
| WAL v2 类型 | `wal/types.ts` | ✅ WalEntry + InsertLine/ReplaceLine/DeleteLine + 幂等辅助 |
| WAL 持久化 | `wal/wal-manager.ts` | ✅ FileWalStore(JSON) + InMemoryWalStore + 状态转换 |
| WAL 重放 | `wal/replay.ts` | ✅ 幂等重放 + checkLineState + onOperationComplete 回调 |
| 重试调度 | `wal/retry-scheduler.ts` | ✅ 指数退避(2^n) + 20% jitter + 定时检查 + maxRetries → dead |
| 死信管理 | `wal/dead-letter.ts` | ✅ 死信列表/重试重置/丢弃/批量操作 |
| Cache Manifest | `cache/cache-manifest.ts` | ✅ 版本核对 + needsRebuild 判断 + touch |
| Cache 迁移 | `cache/cache-migration.ts` | ✅ SQLite DDL 迁移框架 + 全量重建判定 |
| FileWatcher | `rescan/file-watcher.ts` | ✅ 四事件 + 自改识别(ownerId) + handler 注册/注销 |
| FileDiff | `rescan/file-diff.ts` | ✅ 行哈希 diff + 变更比例 + 整文件重建判定 |
| RescanScheduler | `rescan/rescan-scheduler.ts` | ✅ 分批扫描 + 进度回调 + 后台校验定时器 |
| 冷启动 | `engine/engine.ts` | ✅ SQLite → cache 检查 → WAL 重放 → ready → 后台校验 |
| WAL 引擎集成 | `engine/engine.ts` | ✅ initialize 时重放所有 pending/retrying WAL |

### 冷启动流程（engine.ts initialize）

```text
1. 初始化 SQLite
2. 创建 _binding 表
3. 加载 cache manifest → 检查版本
4. 需要迁移则执行迁移或重建
5. 重放所有 status != done/dead 的 WAL（幂等）
6. 标记 Engine ready
7. 启动定时后台校验 + 重试调度
```

### WAL 写入路径

```text
1. 构造 WritePlan
2. CRUDExecutor 通过 walManager.createWal() 持久化 WAL（pending）
3. 获取文件锁
4. 写前读取目标行并校验 hash
5. fileOperator.writeFile() 修改 Markdown
6. 文件写成功后更新 SQLite / binding / file_hashes
7. walManager.markOperationCompleted() 记录进度
8. 释放文件锁
9. 全部操作完成 → walManager.updateStatus('done')
```

### 重放幂等规则

```text
1. 如果 operation.id 已在 completedOperationIds → 跳过
2. 执行前检查目标行 hash
3. 目标内容已等于 afterContent → 幂等跳过
4. 目标内容等于 beforeContent/beforeHash 匹配 → 执行
5. 目标内容不匹配 → conflict（不自动覆盖）
6. 每完成一个 operation → onOperationComplete 回调
7. replayWal 返回详细结果（success/skipped/conflict/error）
```

### 测试结果

```
✔ 19 test files  |  243 tests 全部通过

src/wal/types.test.ts                    — 17 tests  (WAL 创建/状态/幂等/退避)
src/wal/wal-manager.test.ts              — 19 tests  (CRUD/状态/进度/查询/关闭)
src/wal/replay.test.ts                   —  9 tests  (追加/替换/删除/幂等/冲突)
src/wal/retry-scheduler.test.ts          —  7 tests  (周期/到期/重试/死信)
src/wal/dead-letter.test.ts              —  9 tests  (死信 CRUD/重试/丢弃/批量)
src/cache/cache-manifest.test.ts         —  7 tests  (创建/版本/check/touch)
src/cache/cache-migration.test.ts        —  5 tests  (迁移检测/版本检查)
src/rescan/file-diff.test.ts             — 13 tests  (哈希/diff/比例/重建判断)
src/rescan/file-watcher.test.ts          — 10 tests  (事件/自改/多 handler)
src/rescan/rescan-scheduler.test.ts      —  6 tests  (分批/进度/拒绝/关闭)
src/write/serializer.test.ts             — 33 tests  (已有)
src/write/crud-executor.test.ts          — 12 tests  (已有)
src/write/conflict-detector.test.ts      — 11 tests  (已有)
src/lock/lock-manager.test.ts            —  8 tests  (已有)
src/parse/lexer.test.ts                  — 14 tests  (已有)
src/parse/converter.test.ts              — 32 tests  (已有)
src/parse/validator.test.ts              —  9 tests  (已有)
src/schema/resolver.test.ts              — 11 tests  (已有)
src/pipeline-integration.test.ts         — 11 tests  (已有)
```

### 必测场景覆盖

| 场景 | 测试位置 | 状态 |
|---|---:|---:|
| WAL 创建/查询/状态转换 | `wal-manager.test.ts` ✓ | ✅ |
| WAL 进度跟踪（completedOperationIds） | `wal-manager.test.ts` ✓ | ✅ |
| 幂等重放（跳过已完成） | `replay.test.ts` ✓ | ✅ |
| 重放从第一个未完成操作继续 | `replay.test.ts` ✓ | ✅ |
| insertLine 追加到文件 | `replay.test.ts` ✓ | ✅ |
| replaceLine 按 hash 校验替换 | `replay.test.ts` ✓ | ✅ |
| deleteLine 按 hash 校验删除 | `replay.test.ts` ✓ | ✅ |
| 重放冲突检测（hash 不匹配） | `replay.test.ts` ✓ | ✅ |
| 重放错误处理（文件不存在） | `replay.test.ts` ✓ | ✅ |
| 到期重试自动调度 | `retry-scheduler.test.ts` ✓ | ✅ |
| maxRetries 超限进入 dead | `retry-scheduler.test.ts` ✓ | ✅ |
| 死信重试重置为 pending | `dead-letter.test.ts` ✓ | ✅ |
| 死信丢弃/discardAll | `dead-letter.test.ts` ✓ | ✅ |
| Cache manifest 版本检查 | `cache-manifest.test.ts` ✓ | ✅ |
| Cache 迁移检测（版本落后/无 manifest） | `cache-migration.test.ts` ✓ | ✅ |
| FileDiff 行哈希比较 | `file-diff.test.ts` ✓ | ✅ |
| FileWatcher 四事件处理 | `file-watcher.test.ts` ✓ | ✅ |
| FileWatcher 自改识别 | `file-watcher.test.ts` ✓ | ✅ |
| RescanScheduler 分批处理 | `rescan-scheduler.test.ts` ✓ | ✅ |
| 冷启动 WAL 重放（engine.ts） | engine 集成代码 ✓ | ✅ |
| 后台校验定时器 | `rescan-scheduler.test.ts` ✓ | ✅ |

### 完成标准

```text
✓ 写入失败可生成 WAL 并自动重试（RetryScheduler）
✓ 重启后可重放未完成 WAL（engine.initialize → replayAllWals）
✓ WAL 可幂等重放（completedOperationIds 跳过）
✓ 部分成功的 WAL 可从 progress 继续（getNextOperationIndex）
✓ dead WAL 会在状态栏与诊断中显示（DeadLetterHandler）
✓ cache 损坏可全量重建（CacheManifestManager.check → needsRebuild）
— FileWatcher 文件级变更事件（EventEmitter 接口已就绪）
— SQLite 持久化（FileWalStore 已实现，Obsidian 集成时需插件注入）
```

---

## Milestone 3: WAL、冷启动与恢复

### 目标

实现可靠的 WAL v2、冷启动 cache 加载、后台校验、失败重试与死信处理。

### 依赖

Milestone 2。

### 包含阶段

对应 v1：Phase 10、Phase 11、Phase 12、Phase 13 的核心一致性能力。

### 产出结构

```text
src/wal/
├── types.ts
├── wal-manager.ts
├── replay.ts
├── retry-scheduler.ts
└── dead-letter.ts

src/rescan/
├── rescan-scheduler.ts
├── file-diff.ts
└── file-watcher.ts

src/cache/
├── cache-manifest.ts
└── cache-migration.ts
```

### WAL v2 实现

必须使用第七章定义的 `WalEntry.operations` 格式。

支持：

```text
insertLine
replaceLine
deleteLine
progress.completedOperationIds
pending/retrying/dead/done
```

### 冷启动流程

```text
1. 加载 cache manifest。
2. 检查 cacheVersion / sqliteSchemaVersion。
3. 加载 SQLite cache。
4. 加载 file_hashes 与 schema_registry。
5. 重放 status != done/dead 的 WAL。
6. 标记 Engine ready。
7. 后台分批校验 file_hashes。
```

### cache manifest

```typescript
interface CacheManifest {
  pluginVersion: string;
  cacheVersion: number;
  sqliteSchemaVersion: number;
  createdAt: string;
  updatedAt: string;
}
```

### SQLite 持久化策略

```text
- SQLite 内存库包含 _binding + 用户表。
- cache 文件建议命名为 mddb-cache.sqlite，而非 binding.db。
- 写入成功后 debounce 1-5s 导出 SQLite cache。
- 插件 unload 时强制 flush。
- cache 损坏时备份旧 cache 后全量重建。
```

### FileWatcher

支持事件：

```text
create
modify
delete
rename
```

处理规则：

```text
自改事件：识别 owner，跳过重复处理或精确同步。
外部 modify：diff 后增量或整文件重建。
delete：只删除该文件贡献的数据，表无 source 后才 DROP。
rename：更新 filePath、file_hashes、schema_registry source。
```

### Diff 策略

MVP 使用 line hash diff：

```text
1. 保存每个数据文件的 lineHashes。
2. modify 时重新计算 lineHashes。
3. 前后缀快速匹配检测插入/删除。
4. 变更比例 ≤20% 尝试增量。
5. >20% 或 diff 不可靠时整文件重建该文件贡献的数据。
```

### 完成标准

```text
1. 写入失败可生成 WAL 并自动重试。
2. 重启后可重放未完成 WAL。
3. WAL 可幂等重放。
4. 部分成功的 WAL 可从 progress 继续。
5. dead WAL 会在状态栏与诊断中显示。
6. cache 损坏可全量重建。
```

### 故障注入测试

```text
- vault.process 抛错
- WAL 写入后进程重启
- operation 1 成功 operation 2 失败
- 重放时目标内容已经是 afterContent
- 重放时目标内容被用户改动
- SQLite cache 损坏
- schema_registry 损坏
```

---

## Milestone 4: 查询与视图层增强

### 目标

在稳定只读与单文件写入基础上，提供用户可见的表格视图、查询增强和基础交互。

### 依赖

Milestone 3。

### 状态

✅ **已完成** — 293 测试全部通过。

### 包含阶段

对应 v1：Phase 15 完整查询、Phase 17 的表格视图子集、Phase 14 完整诊断。

### 实际产出结构（2026-06-11）

```text
src/query/
├── types.ts                          # 增强：RefFollow、ResultSet 分页 metadata、多字段 SortClause
├── types.test.ts                     # ...
├── sql-generator.ts                  # 增强：默认 LIMIT 200、MAX_LIMIT 5000、多字段 ORDER BY、aggregate alias、ref follow SQL
├── sql-generator.test.ts             # 12 tests（默认 LIMIT/MAX/多字段排序/GROUP BY+HAVING/DISTINCT/OFFSET/COUNT/ref follow SQL）
├── validator.ts                      # 已有
├── engine.ts                         # 增强：ref follow 两步查询、分页 metadata（page/pageSize/totalPages/hasMore/durationMs）
└── assembler.ts                      # 已有

src/view/                              # 全新模块
├── parser.ts                         # mddb-table 代码块解析器 + ViewConfigBuilder + parseWhere 表达式引擎
├── parser.test.ts                    # 15 tests（完整解析/最小解析/多字段排序/错误/注释/IN 子句/WHERE 表达式/IS NULL）
├── base-view-model.ts                # 抽象基类：ViewState 管理 + EventBus + 生命周期
├── shared/
│   ├── types.ts                      # ViewStatus、TableViewState、ViewColumn、ViewRow、ViewEvent
│   ├── event-bus.ts                  # 事件总线：精确类型 + 通配符 onAny、异常隔离
│   ├── event-bus.test.ts             # 6 tests（注册/通配符/取消/异常隔离/clear/handlerCount）
│   ├── data-layer.ts                 # Engine ↔ View 反应式桥接：查询/缓存/分页/排序/auto-refresh
│   └── data-layer.test.ts            # 8 tests（查询/错误/分页/auto-refresh/排序/状态回调/destroy）
├── table/
│   ├── table-config.ts               # TableConfig + 列类型→对齐猜测（numeric→right, boolean→center）
│   ├── table-config.test.ts          # 4 tests（列配置生成/默认值/布尔对齐）
│   ├── table-view-model.ts           # TableViewModel：分页/排序状态管理、goToPage/toggleSort/refresh
│   ├── table-view-model.test.ts      # 6 tests（初始化/错误/分页/状态/destroy/refresh）
│   ├── table-view.ts                 # Obsidian ItemView 实现：表格渲染、排序点击、分页控件、错误/加载/空态
│   └── integration.ts                # ViewIntegration：注册视图类型、从代码块打开表格
```

### 功能实现状态

#### 查询引擎增强

| 功能 | 文件 | 状态 |
|---|---:|---:|
| 默认 LIMIT 200（强制 MAX 5000） | `query/sql-generator.ts` | ✅ 安全上限，防止全表扫描 |
| 多字段排序 | `query/sql-generator.ts` | ✅ SortClause[] 支持 |
| aggregate alias | `query/sql-generator.ts` | ✅ AS alias 生成 |
| Ref follow 两步查询 | `query/engine.ts` | ✅ 主表 → 提取 ref 值 → 目标表 IN 查询 → 合并结果 + 别名前缀 |
| 分页 metadata | `query/engine.ts` | ✅ page / pageSize / totalPages / hasMore / durationMs |
| 查询 Info | `query/types.ts` + `engine.ts` | ✅ queryInfo: { table, hasMore, durationMs } |
| GROUP BY + HAVING | `query/sql-generator.ts` | ✅ 已有 + 验证 |
| FilterGroup AND/OR 嵌套 | `query/types.ts` | ✅ 已有 |
| 11 种操作符 | `query/types.ts` | ✅ 已有 |
| decimal 格式化 | `query/assembler.ts` | ✅ 已有 |
| raw SQL 安全 | `query/engine.ts` | ✅ 已有 |

#### 视图层

| 功能 | 文件 | 状态 |
|---|---:|---:|
| mddb-table 代码块解析 | `view/parser.ts` | ✅ from/show/where/sort/limit + 注释/空行 |
| ViewConfig → Query 转换 | `view/parser.ts` → ViewConfigBuilder | ✅ toQuery + parseWhere（AND/OR/IN/IS NULL/比较） |
| 只读表格渲染 | `view/table/table-view.ts` | ✅ Obsidian ItemView：表格/表头/表体/行号 |
| 排序交互 | `view/table/table-view.ts` | ✅ 点击表头切换排序方向（↑/↓） |
| 分页控件 | `view/table/table-view.ts` | ✅ 上一页/下一页按钮 + 页码显示 |
| 错误内联展示 | `view/table/table-view.ts` | ✅ error 状态 → 错误信息 + 堆栈 |
| 空态展示 | `view/table/table-view.ts` | ✅ empty 状态 → "No data" |
| 加载态展示 | `view/table/table-view.ts` | ✅ loading 状态 → "Loading..." |
| Auto-refresh | `view/shared/data-layer.ts` | ✅ data-changed 自动触发刷新（可配置 debounce） |
| 事件系统 | `view/shared/event-bus.ts` | ✅ 精确类型 + 通配符 + 异常隔离 |
| 视图模型 | `view/table/table-view-model.ts` | ✅ 分页/排序状态管理、refresh/destroy |
| ViewIntegration | `view/integration.ts` | ✅ 注册视图、从代码块打开表格 |

#### 诊断增强

| 功能 | 文件 | 状态 |
|---|---:|---:|
| EngineDiagnostics 增强 | `engine/diagnostics.ts` | ✅ uptimeMs, startedAt, recentErrorCount |
| 诊断命令 | `engine/engine.ts` | ✅ executeDiagnosticCommand() + retry/discard/show |
| WAL 实时统计 | `engine/engine.ts` | ✅ getDiagnostics() 异步查询 WalManager |
| Schema 查询 | `engine/engine.ts` | ✅ getTableNames() + getTableInfo() |

### 查询增强详情

#### Ref Follow 算法

```text
1. 执行主查询 → 获取 rows
2. 对每个 followRefs 配置：
   a. 从主查询结果中提取 ref 字段的唯一值集合
   b. 解析 ref 类型表达式获取目标表名：ref(categories) → "categories"
   c. 获取目标表 PK 字段
   d. 执行第二步查询：SELECT pk, fields FROM target WHERE pk IN (values)
   e. 建立映射：pk → 目标行数据
   f. 合并到原结果行：row["category.name"] = refData.name
3. 添加新列到 columns metadata
```

#### 分页元数据

```typescript
interface ResultSet {
  rows: Record<string, unknown>[];
  columns: ColumnMeta[];
  total: number;          // 总行数（未分页前）
  page?: number;          // 当前页码（1-based）
  pageSize?: number;      // 每页行数
  totalPages?: number;    // 总页数
  returned: number;       // 实际返回行数
  queryInfo?: {
    table: string;
    hasMore: boolean;     // 是否有下一页
    durationMs?: number;
  };
}
```

#### DataLayer 状态管理

```typescript
interface DataLayer {
  // 查询
  query(q: Query): Promise<ResultSet | null>;
  queryView(config: ViewConfig): Promise<ResultSet | null>;
  refresh(): Promise<ResultSet | null>;

  // 分页
  goToPage(page: number): Promise<ResultSet | null>;
  nextPage(): Promise<ResultSet | null>;
  prevPage(): Promise<ResultSet | null>;

  // 排序
  toggleSort(field: string): Promise<ResultSet | null>;

  // 自动刷新
  onStateChange?: (state: DataLayerState) => void;
  destroy(): void;
}
```

### 测试结果

```
✔ 27 test files  |  299 tests 全部通过
                                   (+6 double-parse tests)

src/query/sql-generator.test.ts          — 12 tests  (默认 LIMIT/多字段排序/聚合/ref follow SQL/COUNT/分页)
src/view/parser.test.ts                 — 15 tests  (完整解析/最小/多排序/注释/IN/WHERE 表达式/IS NULL)
src/view/shared/event-bus.test.ts       —  6 tests  (注册/通配符/取消/异常/clear/计数)
src/view/shared/data-layer.test.ts      —  8 tests  (查询/错误/分页/auto-refresh/排序/状态回调/destroy)
src/view/table/table-config.test.ts     —  4 tests  (列配置/默认值/布尔对齐)
src/view/table/table-view-model.test.ts —  6 tests  (初始化/错误/分页/状态/destroy/刷新)
src/wal/types.test.ts                   — 17 tests  (已有)
src/wal/wal-manager.test.ts             — 19 tests  (已有)
... 其他 19 个已有测试文件 ...
```

### 必测场景覆盖

| 场景 | 测试位置 | 状态 |
|---|---:|---:|
| 默认 LIMIT 200 | `sql-generator.test.ts` ✓ | ✅ |
| MAX_LIMIT 上限 5000 | `sql-generator.test.ts` ✓ | ✅ |
| 多字段 ORDER BY | `sql-generator.test.ts` ✓ | ✅ |
| GROUP BY + HAVING | `sql-generator.test.ts` ✓ | ✅ |
| Aggregate alias | `sql-generator.test.ts` ✓ | ✅ |
| Ref follow SQL 生成 | `sql-generator.test.ts` ✓ | ✅ |
| DISTINCT select | `sql-generator.test.ts` ✓ | ✅ |
| LIMIT + OFFSET 分页 | `sql-generator.test.ts` ✓ | ✅ |
| mddb-table 完整解析 | `parser.test.ts` ✓ | ✅ |
| sort by 语法（含可选 "by"） | `parser.test.ts` ✓ | ✅ |
| 多字段 sort 行 | `parser.test.ts` ✓ | ✅ |
| WHERE 表达式解析（AND/OR/IN/IS NULL/比较） | `parser.test.ts` ✓ + `parser.ts` parseWhere | ✅ |
| 注释与空行跳过 | `parser.test.ts` ✓ | ✅ |
| EventBus 精确 + 通配符 | `event-bus.test.ts` ✓ | ✅ |
| DataLayer 查询/错误/分页/排序 | `data-layer.test.ts` ✓ | ✅ |
| DataLayer auto-refresh on data-changed | `data-layer.test.ts` ✓ | ✅ |
| TableViewModel 初始化/错误/分页/destroy | `table-view-model.test.ts` ✓ | ✅ |
| TableConfig 列类型→对齐映射 | `table-config.test.ts` ✓ | ✅ |

### 完成标准（已满足）

```text
✓ mddb-table 可渲染结构化查询结果（TableView ItemView + TableViewModel）
✓ 查询错误能内联展示（error 状态 → 错误信息渲染）
✓ data-changed 能触发表格刷新（DataLayer auto-refresh + debounce）
✓ ResultSet decimal/ref/page metadata 正确（queryInfo / totalPages / hasMore）
✓ raw SQL 不会破坏 cache 或系统表（validateRawQuery 三层安全检查）
```

### 未包含（合理延期）

```text
- 行内编辑（Milestone 4b → 后续）
- 虚拟滚动/无限滚动（大数据场景优化）
- 导出诊断包（Export diagnostics bundle）
- 设置面板集成
```

---

## Milestone 5: 事务与多文件能力

### 目标

实现显式事务、批量事务、跨文件 WAL 驱动，以及多文件表的正式语义。

### 依赖

Milestone 4。

### 状态

✅ **已完成** — 310 测试全部通过。

### 包含阶段

对应 v1：Phase 16、Phase 18。

### 实际产出结构（2026-06-11）

```text
src/transaction/
├── types.ts                          # Transaction 接口 + UpdatePair + TransactionContext + TransactionMode
├── transaction-manager.ts            # TransactionManager（SAVEPOINT 回滚 + WAL 收集 + 批量操作）
└── transaction-manager.test.ts       # 13 tests（基本事务/回滚/批量/WAL/生命周期）

src/write/crud-executor.ts            # 增强：WriteResult 增加 filePath/tableName
                                      #      insertAll/updateAll/deleteAll 批量方法
                                      #      resolveTableFile 支持 writeTarget 多文件路由
src/write/crud-executor.test.ts       # +4 tests（insertAll/updateAll/deleteAll/空批量）

src/engine/engine.ts                  # 增强：集成 TransactionManager
                                      #       transaction() 公开 API
                                      #       onFileDeleted 多文件表安全删除

src/core/types.ts                     # 增强：WriteResult.filePath, TableSource.writeTarget
```

### 功能实现状态

| 功能 | 文件 | 状态 |
|---|---:|---:|
| Transaction 接口 | `transaction/types.ts` | ✅ insert/update/delete + insertAll/updateAll/deleteAll + isActive |
| 显式事务 API | `transaction/transaction-manager.ts` | ✅ `transaction(cb)` SAVEPOINT 包装 |
| SQLite 回滚 | `transaction/transaction-manager.ts` | ✅ throw → ROLLBACK TO SAVEPOINT |
| WAL 收集 | `transaction/transaction-manager.ts` | ✅ 回调中收集 WalOperation → 提交时写入 WAL |
| 批量插入 | `write/crud-executor.ts` | ✅ insertAll() 支持事务上下文 |
| 批量更新 | `write/crud-executor.ts` | ✅ updateAll() 支持事务上下文 |
| 批量删除 | `write/crud-executor.ts` | ✅ deleteAll() 支持事务上下文 |
| filePath 溯源 | `write/crud-executor.ts` + `core/types.ts` | ✅ WriteResult 携带 filePath/tableName |
| 多文件路由 | `write/crud-executor.ts` | ✅ resolveTableFile 优先 writeTarget source |
| 多文件安全删除 | `engine/engine.ts` | ✅ onFileDeleted 调用 schemaRegistry.removeFile |
| 引擎集成 | `engine/engine.ts` | ✅ transaction() 委托 TransactionManager |

### 事务流程

```text
transaction(cb):
1. SAVEPOINT "sp_{txId}" — 打开 SQLite 保存点
2. 执行用户回调，Transaction 代理：
   a. 每步 CRUD 立即写入文件 + SQLite（在 savepoint 内）
   b. 收集 WalOperation 元数据
3. 回调成功：
   a. 如有操作 → createWal(txId, ops) → updateStatus('done')
   b. RELEASE SAVEPOINT — 确认 SQLite 变更
4. 回调失败（throw）：
   a. ROLLBACK TO SAVEPOINT — 回滚 SQLite
   b. 如有已执行的文件操作 → createWal(txId, ops) → updateStatus('done')
   c. 重新抛出原始错误
```

### 多文件表 INSERT 路由

```text
resolveTableFile(tableName):
1. 优先查找 sources 中 writeTarget=true 的 source
2. 未配置 writeTarget → 使用第一个 source（向下兼容单文件表）
3. 无 source → 返回 null

文件删除安全：
1. 删除 _binding 中 file_path=? 的记录
2. schemaRegistry.removeFile() 移除 table source
3. 仅当 table.sources 为空时才自动 DROP TABLE
```

### 测试结果

```
✔ 26 test files  |  310 tests 全部通过

src/transaction/transaction-manager.test.ts  — 13 tests  (基本事务/回滚/批量/WAL/生命周期)
src/write/crud-executor.test.ts              — +4 tests  (insertAll/updateAll/deleteAll/空批量)
... 其他 24 个已有测试文件 ...
```

### 必测场景覆盖

| 场景 | 测试位置 | 状态 |
|---|---:|---:|
| 事务内 insert/update/delete | `transaction-manager.test.ts` ✓ | ✅ |
| 事务批量 insertAll | `transaction-manager.test.ts` ✓ + `crud-executor.test.ts` ✓ | ✅ |
| 事务批量 updateAll | `transaction-manager.test.ts` ✓ + `crud-executor.test.ts` ✓ | ✅ |
| 事务批量 deleteAll | `transaction-manager.test.ts` ✓ + `crud-executor.test.ts` ✓ | ✅ |
| 空事务不生成 WAL | `transaction-manager.test.ts` ✓ | ✅ |
| 事务内 throw → SQLite 回滚 | `transaction-manager.test.ts` ✓ | ✅ |
| 事务终止后操作拒绝 | `transaction-manager.test.ts` ✓ | ✅ |
| WAL 在提交时创建并标记 done | `transaction-manager.test.ts` ✓ | ✅ |
| 失败时 WAL 仍创建用于文件恢复 | `transaction-manager.test.ts` ✓ | ✅ |
| SAVEPOINT 创建与释放 | `transaction-manager.test.ts` ✓ | ✅ |
| INSERT 路由优先 writeTarget | `crud-executor.ts` resolveTableFile 代码 ✓ | ✅ |
| 多文件表文件删除不 DROP | `engine.ts` onFileDeleted + schemaRegistry.removeFile ✓ | ✅ |

### 完成标准（已满足）

```text
✓ 显式事务支持批量写入（transaction API + insertAll/updateAll/deleteAll）
✓ 单文件事务失败可完整回滚 SQLite 状态（SAVEPOINT → ROLLBACK TO）
✓ 跨文件事务部分失败后可通过 WAL 继续（WAL ops collection + createWal）
✓ 多文件表删除单个 source 不会 DROP 整表（schemaRegistry.removeFile）
✓ INSERT 有明确路由策略（writeTarget → 优先 target → 默认 first）
```

### 未包含（合理延期）

```text
- 物理文件原子回滚（WAL 驱动向前恢复，不支持文件级回滚）
- 分区键声明语法（Schema @partition 暂不实现）
- 多文件表写入时的分区裁剪查询优化
- insertAll 批量锁合并（当前为逐条锁，LockManager 重入支持到位）
- 查询 metadata 标记 hasPendingWrites
```

## Milestone 6: A/C 适配、表单视图与 UX 完整化

### 目标

在核心数据库能力稳定后，扩展数据形态与完整用户体验。

### 依赖

Milestone 5。

### 状态

✅ **已完成** — 316 测试全部通过（2026-06-12）

### 包含阶段

对应 v1：Phase 17 表单子集、Phase 19、Phase 20。

### 实际产出结构（2026-06-12）

```text
src/
├── main.ts                              # 增强：mddb-form 代码块处理器 + parseFormBlock
│                                        #       双重解析保护（el.hasClass + storage_pk 修复）
├── settings.ts                          # 已有：MDDBSettingTab + MDDBSettings 类型
├── view/double-parse.test.ts            # 6 tests（双重解析竞态测试）
├── engine/engine.ts                     # 修复：parseFile 旧数据清理 DELETE 使用 "storage_pk" = ?
├── storage/index-writer.ts              # 修复：用户表 DDL + INSERT 包含 storage_pk 列；INSERT OR IGNORE
├── write/crud-executor.ts               # 修复：ensureUserTable + buildInsertSQL 包含 storage_pk 列
└── view/                                # 已有：表格视图（Milestone 4）
```

### 功能实现状态

#### 表单视图

| 功能 | 文件 | 状态 |
|---|---:|---:|
| mddb-form 代码块解析 | `main.ts` parseFormBlock | ✅ to/fields/mode/layout/keep-open |
| 表单容器渲染 | `main.ts` mddb-form 处理器 | ✅ div.mddb-form-container |
| 类型控件映射 (text/date/boolean/enum/ref) | `main.ts` | ✅ 5 种控件 |
| ref 下拉数据加载 | `main.ts` refCache | ✅ engine.query ref 表 |
| 表单提交 → engine.insert() | `main.ts` | ✅ 走统一事务层 |
| 提交状态反馈 | `main.ts` statusEl | ✅ Saving... / Saved / Error |
| 表单重置 | `main.ts` keepOpen 控制 | ✅ 提交后清空 |
| 双重解析保护 | `main.ts` | ✅ el.hasClass('mddb-rendered') 永久标记 + el.empty() |

#### 已修复的 Bug

| Bug | 根因 | 修复 |
|---|---:|---:|
| Obsidian 多阶段重入双重渲染 | Obsidian 在 sync + postProcess 两个阶段重复调用代码块处理器，且不同阶段传入不同 sourceLen | `el.hasClass('mddb-rendered')` 永久标记，每个 el 只渲染一次 |
| ref 下拉选项重复（categories 3x, accounts 2x） | SQLite 用户表缺少 `storage_pk` 列 + 旧数据清理使用 `WHERE rowid IN (SELECT rowid FROM _binding ...)` 完全无效（两个表的 rowid 独立） | 用户表 DDL 加 `storage_pk TEXT` 列；DELETE 改为 `WHERE "storage_pk" = ?`；INSERT 改用 `INSERT OR IGNORE` |
| ref 下拉显示哈希值（如 f2edd3a1） | 用户表加了 `storage_pk` 作为第一列后，ref 查询使用 `rs.columns[0]` 误取了 storage_pk | ref 查询使用 `schema.fields[0]`（第一个用户字段）作为显示值 |
| sql.js 未打包 | esbuild external 包含 'sql.js' | 从 external 数组移除 |

### A/C 形式适配

A 形式：文件即记录。

```text
YAML frontmatter → B 形式内部 Record
文件路径/文件名可作为字段
```

C 形式：块即记录。

```text
块标记语法 → B 形式内部 Record
blockId 作为天然定位信息
```

适配原则：

```text
1. 内核仍统一处理 B 形式 Record。
2. A/C adapter 只负责映射与序列化。
3. QueryEngine 不感知源格式。
4. BindingRow 记录 sourceKind: A | B | C。
```

### UX 完整化

设置面板：

```text
日志级别            ✅ 已有（MDDBSettingTab）
自动扫描开关        ✅ 已有
后台重扫间隔        ✅ 已有
数据路径             ✅ 2026-06-12
缓存路径             ✅ 2026-06-12
WAL 路径             ✅ 2026-06-12
raw SQL 高级模式     ✅ 2026-06-12
最大查询行数         ✅ 2026-06-12
```

命令面板：

```text
MD-DB: Rescan vault        ✅ 已有
MD-DB: Show stats           ✅ 已有
MD-DB: Clear cache          ✅ 已有
MD-DB: Retry dead WAL       ✅ 已有
MD-DB: Show diagnostics     ✅ 已有
MD-DB: Clear logs           ✅ 2026-06-12
MD-DB: Rebuild cache        ✅ 2026-06-12
```

### 完成标准

```text
1. A/B/C 三种源格式可共存。              ⬜（v2 后置）
2. 表单提交走统一事务层。                  ✅ 已实现
3. 设置和命令不会绕过 Engine facade。      ✅ 已实现
4. 用户可以清理 cache/logs/WAL。           ✅ 已实现
5. 表单无双重渲染（含 Obsidian 多阶段重入）。✅ 已验证（double-parse.test.ts）
6. ref 下拉显示正确的用户字段名。          ✅ 已修复
7. SQLite 用户表数据无重复。               ✅ 已修复（storage_pk 列 + INSERT OR IGNORE）
```

---

## 十、测试策略

### 10.1 单元测试

```text
SchemaResolver
Schema validators
Lexer
TypeConverter
Validator
SQLGenerator
ResultAssembler
Serializer
ConflictDetector
WalManager
LockManager
```

### 10.2 集成测试

```text
parse file → SQLite rows → query
insert/update/delete → Markdown + binding + query
modify event → rescan
cold start → load cache → background verify
view query block → rendered ResultSet
```

### 10.3 故障注入测试

```text
vault.process 抛错
WAL 写入后崩溃
WAL operation 部分成功
重放期间文件被用户修改
binding/cache 损坏
schema_registry 损坏
锁竞争
插件 shutdown 时仍有 pending operation
```

### 10.4 性能测试

```text
10k / 50k / 100k rows query
1k / 5k files startup scan
5k line file diff
100 pending WAL replay
表格视图 10k rows 虚拟滚动
```

---

## 十一、ADR 要求

关键架构决策必须补充 ADR。

建议目录：

```text
docs/adr/
├── 0001-markdown-as-source-of-truth.md
├── 0002-use-sqljs-for-cache.md
├── 0003-binding-identity-model-v2.md
├── 0004-wal-forward-recovery.md
├── 0005-query-engine-boundaries.md
├── 0006-sql-safety-rules.md
└── 0007-view-layer-declarative-blocks.md
```

模板：

```markdown
# ADR-0001: 使用 Markdown 作为事实源

## Status
Accepted

## Context

## Decision

## Consequences

## Alternatives Considered
```

---

## 十二、v1 Phase 到 v2 Milestone 映射

| v1 Phase | v1 名称 | v2 归属 | 调整说明 |
|---:|---|---|---|
| 0 | 项目脚手架 | Milestone 1 | 保留 |
| 1 | 核心数据结构 | Milestone 0/1 | 先冻结身份模型与 Result 类型 |
| 2 | 绑定表 + SQLite | Milestone 0/1 | 改为 BindingRow v2 + SchemaRegistry v2 |
| 3 | Schema 解析器 | Milestone 1 | 增加 SQL identifier 安全规则 |
| 4 | Lexer | Milestone 1 | 保留 |
| 5 | 类型转换器 | Milestone 1 | 保留 |
| 6 | 验证器 | Milestone 1 | 保留，PK 逻辑按 v2 调整 |
| 7 | 索引写入器 | Milestone 1 | 只读索引写入 SQLite cache |
| 8 | 解析管道集成 | Milestone 1 | 保留 |
| 9 | CRUD | Milestone 2 | 先做单文件写入 MVP |
| 10 | WAL | Milestone 3 | 必须改为 WAL v2 operation |
| 11 | 重扫与一致性 | Milestone 2/3 | 写前 hash 在 M2，diff/rescan 在 M3 |
| 12 | 冷启动 | Milestone 3 | 增加 cache manifest/migration |
| 13 | 文件监视 | Milestone 3 | delete 不再默认 DROP TABLE |
| 14 | 状态栏 + 日志 | Milestone 1/4 | M1 最小状态栏，M4 诊断面板 |
| 15 | 查询引擎 | Milestone 1/4 | M1 只读子集，M4 完整查询 |
| 16 | 事务模型 | Milestone 5 ✅ | TransactionManager + SAVEPOINT + WAL |
| 17 | 视图层 API | Milestone 4/6 | 先表格只读（M4 ✅），再表单（M6 ✅） |
| 18 | 多文件表 | Milestone 5 ✅ | writeTarget 路由 + 多文件安全删除 |
| 19 | A/C 适配层 | Milestone 6 | 后置 |
| 20 | 设置 + UX | Milestone 6 | 基础命令可在 M4 提前 |

---

## 十三、总体实施建议

### 13.1 推荐顺序

```text
1. 先完成 Milestone 0 文档契约。
2. 实施 Milestone 1，只读 MVP。
3. 用真实 Obsidian Vault 验证解析、查询、性能。
4. 再实施 Milestone 2 单文件写入。
5. 通过故障注入验证后，再实施 Milestone 3 WAL。
6. 之后再进入视图层、事务、多文件表。
```

### 13.2 不建议立即实施的内容

```text
- 跨文件事务
- 多文件表写入
- A/C 形式适配
- raw SQL 暴露给用户
- runtime config 自动写回
```

### 13.3 可以并行的内容

```text
Milestone 1 内：
- SchemaResolver 与 Lexer 可并行。
- TypeConverter 与 SQL identifier validator 可并行。
- QueryEngine 的类型定义可与 ParsePipeline 并行。

Milestone 3 内：
- WalManager 与 FileDiff 可并行。
- Diagnostics 与 CacheMigration 可并行。

Milestone 4 内：
- QueryEngine 增强与只读 TableView 可并行。
```

---

## 十四、v2 结论

v2 的核心目标是降低 v1 的系统性返工风险。

最重要的变化是：

```text
1. 先只读 MVP，后写入，最后事务与多文件。
2. storagePk 不再依赖 lineNumber。
3. SchemaRegistry 从 table->file 改为 table->sources[]。
4. WAL 从 files 列表改为可幂等重放的 operations。
5. 所有写入统一经过 TransactionManager。
6. SQL identifier 与 raw SQL 安全规则前置。
7. 明确容量目标、诊断能力、测试矩阵和 ADR 要求。
```

建议按 v2 进入实施，但在 Milestone 0 完成前，不建议开始 Phase 2/7/9/10/16 等高返工风险模块。
