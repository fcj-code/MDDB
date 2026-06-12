# MD-DB 运行时架构

> 日期：2026-06-11  
> 状态：✅ 已冻结 — Milestone 0 架构基线  
> 用途：定义 MD-DB 的运行时组件图、MDDBEngine facade、责任边界、生命周期、事件系统、并发模型  
> 影响模块：所有模块——本文档定义了各模块的交互契约

---

## 一、组件图

```
PluginMain
 └── MDDBEngine（唯一顶层 facade）
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
           ├── TableViewModel
           └── FormViewModel
```

### 依赖注入方向

```text
MDDBEngine 唯一持有所有子组件的实例。
子组件之间不直接构造对方，通过 MDDBEngine 注入所需依赖。

具体注入方式：
- PluginMain → 构造 MDDBEngine → 调用 engine.initialize()
- MDDBEngine → 内部构造各 Manager（依赖由构造函数参数传入）
- ViewLayer → 通过 MDDBEngine 的公共方法操作，不直接访问子组件
```

---

## 二、MDDBEngine 统一 facade

### 2.1 接口定义

```typescript
interface MDDBEngine {
  // === 生命周期 ===
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // === 解析 ===
  parseFile(file: TFile): Promise<ParseResult>;
  rescanVault(options?: RescanOptions): Promise<RescanResult>;

  // === 只读查询 ===
  query(q: Query): ResultOrError<ResultSet>;
  queryRaw(sql: string, params?: unknown[], options?: RawQueryOptions):
    ResultOrError<ResultSet>;

  // === 写入（单条自动事务） ===
  insert(table: string, record: RecordInput, options?: WriteOptions):
    Promise<WriteResult>;
  update(storagePk: string, patch: RecordPatch, options?: WriteOptions):
    Promise<WriteResult>;
  delete(storagePk: string, options?: WriteOptions):
    Promise<WriteResult>;
  insertAll(table: string, records: RecordInput[], options?: WriteOptions):
    Promise<WriteResult[]>;
  updateAll(table: string, patches: Array<{pk: string; data: RecordPatch}>,
            options?: WriteOptions): Promise<WriteResult[]>;
  deleteAll(table: string, pks: string[], options?: WriteOptions):
    Promise<WriteResult[]>;

  // === 显式事务 ===
  transaction<T>(cb: (tx: Transaction) => Promise<T>): Promise<T>;

  // === 诊断 ===
  diagnostics(): EngineDiagnostics;

  // === 事件 ===
  on(event: EngineEventType, handler: EngineEventHandler): Disposable;
}
```

### 2.2 关键实现规则

```typescript
// 写入统一入口
// 所有 insert/update/delete 最终委托给 TransactionManager，
// TransactionManager 决定走自动事务还是批量路径。

class MDDBEngineImpl implements MDDBEngine {
  private storage: StorageManager;
  private parsePipeline: ParsePipeline;
  private queryEngine: QueryEngine;
  private txManager: TransactionManager;
  private rescan: RescanScheduler;
  private fileWatcher: FileWatcher;
  private diagnostics: DiagnosticsManager;
  private eventBus: EngineEventBus;

  constructor(private vault: Vault, private settings: Settings) { ... }

  async initialize(): Promise<void> {
    // 1. 初始化 SQLiteAdapter
    // 2. 加载 cache、WAL 重放
    // 3. 初始化 FileWatcher
    // 4. 注册事件监听
    // 5. 后台触发 rescan
  }

  async shutdown(): Promise<void> {
    // 1. 停止 retryLoop
    // 2. 拒绝新锁
    // 3. 等待或取消已有任务
    // 4. flush SQLite cache
    // 5. 释放 SQLite 资源
  }
}
```

---

## 三、子组件职责

### 3.1 StorageManager

```typescript
interface StorageManager {
  sqlite: SQLiteAdapter;         // 直接暴露给 QueryEngine / TransactionManager
  binding: BindingStore;         // _binding 表的 CRUD
  schemaReg: SchemaRegistry;     // schema_registry.json 的读写
  fileHash: FileHashStore;       // file_hashes.json 的读写
}
```

职责：

```text
- 管理 SQLite 连接（MVP：sql.js WASM 实例）。
- 提供 _binding 表的查询与变更方法。
- 管理 schema_registry.json 的序列化与版本升级。
- 管理 file_hashes.json 的序列化。
- 不负责业务逻辑或写入策略。
```

### 3.2 ParsePipeline

```typescript
interface ParsePipeline {
  parseFile(file: TFile): Promise<ParseResult>;
  parseAllFiles(): Promise<Map<string, ParseResult>>;
}
```

流水线：

```text
SchemaResolver → Lexer → TypeConverter → Validator → IndexWriter
```

职责：

```text
- 只解析 Markdown → records/errors/warnings。
- 不接触 Markdown 写入。
- IndexWriter 只更新 SQLite cache，不直接写 Markdown。
```

### 3.3 QueryEngine

```typescript
interface QueryEngine {
  query(q: Query): ResultOrError<ResultSet>;
  queryRaw(sql: string, params: unknown[], options?: RawQueryOptions):
    ResultOrError<ResultSet>;
}
```

流水线：

```text
QueryValidator → SQLGenerator → ResultAssembler
```

职责：

```text
- 只负责只读查询。
- 不修改 Markdown。
- 不触发 WAL。
- queryRaw 受 SQL 安全规则约束，queryRawInternal 无限制。
```

### 3.4 TransactionManager

```typescript
interface TransactionManager {
  insert(table: string, record: RecordInput, options?: WriteOptions):
    Promise<WriteResult>;
  update(storagePk: string, patch: RecordPatch, options?: WriteOptions):
    Promise<WriteResult>;
  delete(storagePk: string, options?: WriteOptions):
    Promise<WriteResult>;

  insertAll(table: string, records: RecordInput[], options?: WriteOptions):
    Promise<WriteResult[]>;
  updateAll(table: string, patches: Array<{pk: string; data: RecordPatch}>,
            options?: WriteOptions): Promise<WriteResult[]>;
  deleteAll(table: string, pks: string[], options?: WriteOptions):
    Promise<WriteResult[]>;

  transaction<T>(cb: (tx: Transaction) => Promise<T>): Promise<T>;
}
```

职责：

```text
- 统一负责所有写入入口。
- 控制事务边界（自动事务 vs 显式事务）。
- 路径选择（单文件文件先写 vs 跨文件 WAL 驱动）。
- 冲突策略选择（乐观锁 vs 最后写入）。
- 调用 CrudExecutor 执行文件变更。
- 调用 WalManager 在需要时生成 WAL。
```

### 3.5 CrudExecutor

```typescript
interface CrudExecutor {
  insertLine(file: string, blockId: string, content: string, afterLine?: number):
    Promise<{lineNumber: number; storagePk: string}>;
  replaceLine(file: string, lineNumber: number, beforeHash: string, afterContent: string):
    Promise<void>;
  deleteLine(file: string, lineNumber: number, beforeHash: string):
    Promise<void>;
}
```

职责：

```text
- 只负责最小文件变更单位的执行。
- 不关心事务边界。
- 不关心冲突策略（由调用方决定）。
- 通过 vault.process() 操作 Markdown。
```

### 3.6 WalManager

```typescript
interface WalManager {
  writeEntry(entry: WalEntry): Promise<void>;
  replayAll(): Promise<void>;
  retryLoop(): void;
  getDeadEntries(): WalEntry[];
  retryDead(txId: string): Promise<void>;
  discardDead(txId: string): Promise<void>;
}
```

职责：

```text
- 只负责 WAL 文件的读写、重放、重试、死信。
- 不决定业务语义（是否生成 WAL、何时生成由 TransactionManager 决定）。
- 不直接操作 Markdown。
```

### 3.7 RescanScheduler

```typescript
interface RescanScheduler {
  scheduleFullScan(options?: ScanOptions): void;
  scheduleBackgroundVerify(): void;
}
```

职责：

```text
- 全量重扫调度。
- Obsidian 空闲时的后台文件哈希比对。
- 分批执行，不阻塞 UI。
```

### 3.8 FileWatcher

```typescript
interface FileWatcher {
  onFileCreate(file: TFile): void;
  onFileModify(file: TFile): void;
  onFileDelete(file: TFile): void;
  onFileRename(file: TFile, oldPath: string): void;
}
```

职责：

```text
- 监听 Obsidian Vault API 事件。
- 识别自改事件（跳过或精确同步）与外部修改事件。
- 触发 RescanScheduler 或增量 diff。
- 通过 LockManager 获取文件锁。
```

### 3.9 DiagnosticsManager

```typescript
interface DiagnosticsManager {
  diagnostics(): EngineDiagnostics;
  log(level: LogLevel, table: string, message: string, data?: unknown): void;
  getLogs(date: string): string[];
  clearLogs(): void;
}
```

职责：

```text
- 维护 EngineDiagnostics 快照。
- 日志管理（写入 log 文件、滚动清理）。
- 诊断数据导出。
```

### 3.10 ViewLayer

```typescript
interface ViewLayer {
  registerViewProviders(plugin: Plugin): void;
  // 通过 engine 操作，不直接访问子组件
}
```

职责：

```text
- 只负责展示、用户输入、调用 Engine API。
- 不直接调用 app.vault.modify/process 写数据文件。
- 不直接访问 SQLite 或 binding。
```

---

## 四、生命周期

### 4.1 启动顺序

```
1. Plugin.  onload()
2. new MDDBEngine(vault, settings)
3. engine.initialize()
   a. 加载 CacheManifest
      ├─ cacheVersion 匹配 → 加载 mddb-cache.sqlite + schema_registry + file_hashes
      ├─ cacheVersion 可迁移 → 执行 cache migration
      └─ cacheVersion 不匹配或损坏 → 备份旧 cache → 全量重建
   b. WAL 重放
      ├─ 遍历 wal/*.json
      ├─ status = done → 删除
      ├─ status = dead → 通知用户
      └─ status = pending/retrying → replay()
   c. 注册 FileWatcher 事件
   d. 后台非阻塞：scheduleBackgroundVerify()
   e. 标记 engine.ready = true
4. PluginMain 注册视图层、命令面板、状态栏
```

### 4.2 关闭顺序

```
1. Plugin.  onunload()
2. engine.shutdown()
   a. 停止 WalManager retryLoop
   b. LockManager 拒绝新锁，等待或取消已有任务
   c. flush: SQLite → mddb-cache.sqlite
   d. flush: schema_registry.json + file_hashes.json
   e. 关闭 SQLiteAdapter
   f. 移除事件监听
   g. 标记 engine.ready = false
```

### 4.3 启动状态可见性

```typescript
type EngineStatus = "starting" | "ready" | "degraded" | "rebuilding" | "error";
```

| 状态 | 含义 | UI 行为 |
|---|---:|---|
| `starting` | 启动中，阻塞阶段 | 状态栏不可用 |
| `ready` | 正常可用 | 正常显示 |
| `degraded` | 可用但有 dead WAL 或后台重建中 | 状态栏显示警告 |
| `rebuilding` | 全量重建中 | 状态栏显示进度 |
| `error` | 初始化失败 | 状态栏显示错误，多数功能不可用 |

---

## 五、事件系统

### 5.1 事件类型

```typescript
type EngineEventType =
  | "data-changed"           // 记录变更（insert/update/delete）
  | "state-changed"          // 引擎状态变化（ready/degraded/rebuilding）
  | "error"                  // 可恢复错误（非 fatal）
  | "wal-created"            // 新 WAL 条目生成
  | "wal-updated"            // WAL 进度更新
  | "wal-dead"               // WAL 进入 dead 状态
  | "rescan-started"         // 全量扫描开始
  | "rescan-completed";      // 全量扫描完成

type EngineEventHandler = {
  "data-changed": (event: DataChangedEvent) => void;
  "state-changed": (event: StateChangedEvent) => void;
  "error": (event: ErrorEvent) => void;
  "wal-created": (event: WalEvent) => void;
  "wal-updated": (event: WalEvent) => void;
  "wal-dead": (event: WalEvent) => void;
  "rescan-started": () => void;
  "rescan-completed": (event: RescanCompletedEvent) => void;
}[EngineEventType];
```

### 5.2 事件约束

```typescript
interface Disposable {
  dispose(): void;
}
```

```text
1. 事件通过 engine.on(type, handler) 订阅，返回 Disposable。
2. 视图层销毁时必须 dispose 所有订阅。
3. data-changed 递归保护：同类型事件最大嵌套 10 层。
4. data-changed 触发 TableView 刷新，不触发 FileWatcher 的修改事件。
```

---

## 六、并发模型

### 6.1 LockManager

```typescript
interface LockManager {
  withFileLock<T>(path: string, ownerId: string, fn: () => Promise<T>): Promise<T>;
  withFileLocks<T>(paths: string[], ownerId: string,
                   fn: () => Promise<T>): Promise<T>;
}
```

要求：

```text
1. 多文件锁按路径字典序获取，避免死锁。
2. 所有锁通过 finally 释放。
3. 支持 ownerId 重入：同一 ownerId 可重复获取同一文件的锁。
4. shutdown 时拒绝新锁，等待或取消已有任务（超时后 abort）。
5. FileWatcher、RescanScheduler、TransactionManager 共享同一个 LockManager 实例。
```

### 6.2 外部修改与自改事件

```text
自改：
  TransactionManager 在执行写入前设置一个短暂的 write owner 标记。
  FileWatcher 的 modify 处理器检查：
    - 如果有 write owner → 跳过全量 diff，信任自改增量路径。
    - 如果无 write owner → 外部修改，触发 diff/rescan。

外部修改：
  1. FileWatcher 收到 modify 事件。
  2. 尝试获取文件锁。
  3. 获取成功 → diff/rescan。
  4. 获取失败（被 TransactionManager 持有）→ 跳过本轮，等待下一轮空闲调度。

锁冲突：
  后到者跳过本轮，进入下一轮空闲调度，不阻塞 UI 不重试排队。
```

### 6.3 锁使用场景

| 场景 | 锁类型 | 锁持有时间 |
|---|---:|---:|
| TransactionManager 写入 | `withFileLock` / `withFileLocks` | 写入全程（< 100ms） |
| FileWatcher diff/rescan | `withFileLock` | diff 或 rescan 全程 |
| Background verify | `withFileLock` | 单文件读取 hash 全程 |
| Cold start WAL replay | `withFileLock` | 逐 operation |
| ViewLayer 刷新 | 不持锁 | 只读 |

---

## 七、Cache Manifest

### 7.1 结构

```typescript
interface CacheManifest {
  pluginVersion: string;           // 安装的插件版本
  cacheVersion: number;            // 当前为 2
  sqliteSchemaVersion: number;     // SQLite 表结构版本
  createdAt: string;               // ISO 8601
  updatedAt: string;               // ISO 8601
}
```

### 7.2 版本检查

```text
启动时：
1. 读取 cache-manifest.json。
2. 如果 cacheVersion == 当前 cacheVersion：
   → 直接加载 SQLite、schema_registry、file_hashes。
3. 如果 cacheVersion < 当前 cacheVersion 且在可迁移范围：
   → 执行 CacheMigration。
4. 如果 cacheVersion > 当前 cacheVersion 或不可迁移：
   → 备份旧 cache 到 .backup/ 目录。
   → 全量重建。
```

### 7.3 SQLite 持久化策略

```text
- SQLite 内存库包含 _binding + 用户表。
- cache 文件路径：.obsidian/plugins/md-db/cache/mddb-cache.sqlite。
- 写入成功后 debounce 1-5s 导出 SQLite cache。
- 插件 unload 时强制 flush。
- cache 文件如果不存在或损坏 → 向 CacheManifest 那样备份旧文件后全量重建。
```

---

## 八、持久化文件总览

```text
.obsidian/plugins/md-db/
├── cache/
│   ├── mddb-cache.sqlite          # SQLite cache（binding + 用户表）
│   ├── file_hashes.json           # { "filePath": "sha256hex" }
│   ├── schema_registry.json       # SchemaRegistry v2
│   └── cache-manifest.json        # CacheManifest
│
├── wal/
│   └── {txId}.json               # WalEntry v2
│
├── logs/
│   └── {YYYY-MM-DD}.log          # 日志
│
└── settings.json                  # 插件设置（Obsidian 自动管理）
```

---

## 九、对 v1 架构的替代

本文档正式替代以下 v1 设计中的架构描述部分：

| v1 文档 | v1 内容 | v2 变化 |
|---|---:|---|
| `storage-engine-design.md` §1.3 | 架构概览图 | 更详细的组件层级与职责边界 |
| — | 无统一 facade | 新增 MDDBEngine 顶层接口 |
| — | 无事件系统 | 新增 EngineEventType |
| — | 无 LockManager | 新增文件锁并发模型 |
| — | 无 CacheManifest | 新增缓存版本检查与迁移 |
| `storage-engine-design.md` §8.2 | 缓存结构 | 新增 cache manifest、SQLite 持久化策略 |
