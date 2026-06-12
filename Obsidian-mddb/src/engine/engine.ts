/**
 * MDDBEngine — 统一顶层 facade
 *
 * 所有上层模块（视图层、命令面板、设置面板）通过此接口访问核心能力。
 *
 * Milestone 3 新增：
 * - WAL 管理（写前持久化 → 文件写入 → SQLite 提交）
 * - 冷启动流程（manifest → 校验 → 重放 → ready）
 * - 文件变更监视（自改识别 + 外部变更处理）
 * - 分批重扫调度
 * - 死信管理
 *
 * 参考：runtime-architecture.md §2, v2 roadmap Milestone 1/2/3
 */

import type {
  SchemaSummary,
  EngineEventType,
  EngineStatus,
  DataChangedEvent,
  StateChangedEvent,
  ErrorEvent,
  Disposable,
  RecordInput,
  RecordPatch,
  WriteOptions,
  WriteResult,
} from '../core/types';
import type { ResultOrError } from '../core/result';
import type { Query, ResultSet } from '../query/types';
import type { RawQueryOptions } from '../query/engine';
import type { FileParseResult, VaultScanResult } from '../parse/pipeline';
import type { EngineDiagnostics } from './diagnostics';
import type { FileOperator } from '../write/types';
import type { TableSource } from '../core/types';
import type { DeadLetterInfo } from '../wal/dead-letter';
import type { WalEntry, WalOperation, ReplayResult } from '../wal/types';
import type { Transaction } from '../transaction/types';

import { SQLiteAdapter } from '../storage/sqlite-adapter';
import { BindingStore } from '../storage/binding-store';
import { SchemaRegistryStore } from '../storage/schema-registry';
import { FileHashStore } from '../storage/file-hash-store';
import { ParsePipeline } from '../parse/pipeline';
import { QueryEngine } from '../query/engine';
import { DiagnosticsManager } from './diagnostics';
import { CRUDExecutor } from '../write/crud-executor';
import { WalManager, InMemoryWalStore, FileWalStore } from '../wal/wal-manager';
import { DeadLetterHandler } from '../wal/dead-letter';
import { RetryScheduler } from '../wal/retry-scheduler';
import { CacheManifestManager, CURRENT_CACHE_VERSION, CURRENT_SQLITE_SCHEMA_VERSION } from '../cache/cache-manifest';
import { CacheMigration } from '../cache/cache-migration';
import { FileWatcher } from '../rescan/file-watcher';
import { RescanScheduler } from '../rescan/rescan-scheduler';
import { replayAllWals } from '../wal/replay';
import { ok, err } from '../core/result';
import { EngineError, WriteError } from '../core/errors';
import { safeIdent } from '../schema/validators';
import { TransactionManager } from '../transaction/transaction-manager';

export type { EngineDiagnostics };

// 事件回调存储
type EventCallback = (...args: unknown[]) => void;

export class MDDBEngine {
  // Milestone 1/2 子组件
  readonly sqlite: SQLiteAdapter;
  readonly binding: BindingStore;
  readonly schemaRegistry: SchemaRegistryStore;
  readonly fileHash: FileHashStore;
  readonly parsePipeline: ParsePipeline;
  readonly queryEngine: QueryEngine;
  readonly diagnostics: DiagnosticsManager;
  readonly crud: CRUDExecutor;

  // Milestone 3 子组件
  readonly walManager: WalManager;
  readonly deadLetterHandler: DeadLetterHandler;
  readonly retryScheduler: RetryScheduler;
  readonly cacheManifest: CacheManifestManager;
  readonly cacheMigration: CacheMigration;
  readonly fileWatcher: FileWatcher;
  readonly rescanScheduler: RescanScheduler;

  // Milestone 5 子组件
  readonly transactionManager: TransactionManager;

  // 状态
  private _ready = false;
  private _status: EngineStatus = 'starting';
  private eventHandlers = new Map<string, Set<EventCallback>>();
  private _pluginVersion = '0.1.0';
  private _parsing = new Set<string>(); // 防止同一文件并发解析

  // 配置（'quoted' 支持中文等 Unicode 标识符）
  private identMode: 'ascii' | 'quoted' = 'quoted';

  constructor(fileOperator?: FileOperator) {
    // Milestone 1/2 子组件
    this.sqlite = new SQLiteAdapter();
    this.binding = new BindingStore(this.sqlite);
    this.schemaRegistry = new SchemaRegistryStore();
    this.fileHash = new FileHashStore();
    this.parsePipeline = new ParsePipeline({
      identifierMode: this.identMode,
      vaultRoot: '',
    });
    this.queryEngine = new QueryEngine(
      this.sqlite,
      this.schemaRegistry,
      this.identMode,
    );
    this.diagnostics = new DiagnosticsManager();

    // Milestone 3 子组件（先初始化，后设置 FileOperator）
    this.walManager = new WalManager(new InMemoryWalStore());
    this.deadLetterHandler = new DeadLetterHandler(this.walManager);
    const defaultFO = fileOperator ?? createDefaultFileOperator();
    this.retryScheduler = new RetryScheduler(this.walManager, defaultFO);
    this.cacheManifest = new CacheManifestManager(defaultFO);
    this.cacheMigration = new CacheMigration(this.sqlite, defaultFO);
    this.fileWatcher = new FileWatcher();
    this.rescanScheduler = new RescanScheduler(this.diagnostics);

    // CRUDExecutor（需要 FileOperator）
    this.crud = new CRUDExecutor(
      defaultFO,
      this.sqlite,
      this.binding,
      this.schemaRegistry,
      this.fileHash,
      this.identMode,
    );

    // Milestone 5 TransactionManager
    this.transactionManager = new TransactionManager(
      this.sqlite,
      this.crud,
      this.walManager,
      this.schemaRegistry,
    );

    // 注册重扫回调
    this.rescanScheduler.setRescanCallback(async (batch) => {
      let errors = 0;
      for (const file of batch.files) {
        try {
          this.parseFile(file.content, file.path);
        } catch {
          errors++;
        }
      }
      return { errors };
    });

    // 注册后台校验回调
    this.rescanScheduler.setVerifyCallback(async () => {
      // MVP 暂不实现全量后台校验
      // 后续由 FileHashStore 的比较逻辑补充
    });
  }

  /**
   * 设置文件操作实现（插件层注入，初始化前调用）
   */
  setFileOperator(fop: FileOperator): void {
    if (this._ready) {
      throw new EngineError('Cannot set FileOperator after engine is ready', 'ENGINE_ALREADY_INIT');
    }
    this.crud.fileOperator = fop;

    // 更新依赖 FileOperator 的 M3 组件
    this.retryScheduler['fileOperator'] = fop;
    (this.walManager as any).store = new FileWalStore(fop, '.mddb/wals');
    (this.cacheManifest as any).fileOperator = fop;
    (this.cacheMigration as any).fileOperator = fop;
  }

  /** 引擎是否就绪 */
  get ready(): boolean {
    return this._ready;
  }

  /** 引擎状态 */
  get status(): EngineStatus {
    return this._status;
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 初始化引擎
   *
   * Milestone 3 冷启动流程：
   * 1. 初始化 SQLite
   * 2. 创建 _binding 表
   * 3. 加载 cache manifest → 检查版本
   * 4. 需要迁移则执行迁移或重建
   * 5. 重放 status != done/dead 的 WAL
   * 6. 标记 Engine ready
   * 7. 启动定时后台校验
   */
  async initialize(sqlJsModule: unknown, pluginVersion?: string): Promise<void> {
    try {
      this._status = 'starting';
      this.emit('state-changed', { previous: 'starting', current: 'starting' });

      if (pluginVersion) this._pluginVersion = pluginVersion;

      // 1. 初始化 SQLite
      await this.sqlite.initialize(sqlJsModule as (config?: unknown) => Promise<unknown>);

      // 2. 初始化 binding 表
      this.binding.initialize();

      // 3. Cache manifest 检查
      const checkResult = await this.cacheManifest.check(this._pluginVersion);
      if (checkResult.needsRebuild) {
        // 需要重建 cache
        this.diagnostics.recordError(
          'CACHE_REBUILD',
          checkResult.message,
        );
        // MVP：重建由上层应用触发 rescanVault
      } else {
        // 检查是否需要 SQLite schema 迁移
        const manifest = checkResult.manifest;
        if (manifest) {
          const migrationResult = await this.cacheMigration.migrate(
            manifest,
            CURRENT_CACHE_VERSION,
            CURRENT_SQLITE_SCHEMA_VERSION,
          );
          if (migrationResult && !migrationResult.success) {
            this.diagnostics.recordError(
              'CACHE_MIGRATION_FAILED',
              migrationResult.error ?? 'Unknown migration error',
            );
          }
        }
      }

      // 4. 重放 WAL
      const replayableWals = await this.walManager.getReplayableWals();
      if (replayableWals.length > 0) {
        const fileOp = this.crud.fileOperator;
        const replayResults = await replayAllWals(
          replayableWals,
          fileOp,
          async (result: ReplayResult) => {
            if (result.success) {
              await this.walManager.updateStatus(result.txId, 'done');
            } else {
              await this.walManager.recordRetry(
                result.txId,
                'Replay failed during cold start',
                null, // dead
              );
              this.emit('wal-dead', {
                txId: result.txId,
                status: 'dead',
                fileCount: 0,
              });
            }
          },
        );

        const failedCount = replayResults.filter(r => !r.success).length;
        if (failedCount > 0) {
          this.diagnostics.recordError(
            'WAL_REPLAY_FAILED',
            `${failedCount} WAL(s) failed during cold start replay`,
          );
        }
      }

      // 5. 标记就绪
      this._ready = true;
      this._status = 'ready';
      this.diagnostics.setStatus('ready');
      this.emit('state-changed', { previous: 'starting', current: 'ready' });

      // 6. 启动后台校验 + 重试调度
      this.rescanScheduler.startVerifyTimer();
      this.retryScheduler.start();
    } catch (e) {
      this._status = 'error';
      this.diagnostics.setStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      this.diagnostics.recordError('ENGINE_INIT_ERROR', msg);
      this.emit('state-changed', { previous: 'starting', current: 'error' });
      this.emit('error', { code: 'ENGINE_INIT_ERROR', message: msg });
    }
  }

  /**
   * 关闭引擎
   */
  async shutdown(): Promise<void> {
    this._status = 'starting';
    this._ready = false;

    // 停止后台任务
    this.rescanScheduler.shutdown();
    this.retryScheduler.shutdown();

    // 关闭锁管理器
    this.crud.lock.shutdown();

    // 关闭文件监视器
    this.fileWatcher.shutdown();

    // 关闭 WAL 管理器
    this.walManager.shutdown();

    // 关闭 SQLite
    this.sqlite.close();

    // 清理事件
    this.eventHandlers.clear();
    this.diagnostics.setStatus('error');
  }

  // ============================================================
  // 解析
  // ============================================================

  /**
   * 解析单个文件 — 从文件内容到 SQLite 索引
   */
  parseFile(fileContent: string, filePath: string): FileParseResult {
    if (!this._ready) {
      throw new EngineError('Engine not initialized', 'ENGINE_NOT_READY');
    }

    // 防止同一文件并发解析（vault 事件 + 自动扫描 + 切 tab 等）
    if (this._parsing.has(filePath)) {
      return { tables: [], totalErrors: 0, totalWarnings: 0, filePath };
    }
    this._parsing.add(filePath);

    try {
      const context = {
        run: (sql: string, params?: unknown[]) => this.sqlite.run(sql, params),
        query: (sql: string, params?: unknown[]) => this.sqlite.query(sql, params),
        identMode: this.identMode,
      };

      // 先清理旧数据 — 使用 storage_pk 直接匹配（rowid 子查询在不同表间无效）
    const oldBindings = this.binding.findByFilePath(filePath);
    for (const b of oldBindings) {
      const tableEntry = this.schemaRegistry.getTable(b.tableName);
      if (tableEntry) {
        try {
          this.sqlite.run(
            `DELETE FROM ${safeIdent(b.tableName, this.identMode)} WHERE "storage_pk" = ?`,
            [b.storagePk],
          );
        } catch { /* 表可能不存在 */ }
      }
    }
    this.binding.deleteByFilePath(filePath);

    const result = this.parsePipeline.parseFile(fileContent, filePath, context);

    // 更新 schema_registry
    for (const table of result.tables) {
      this.schemaRegistry.setTableSchema(table.tableName, table.schema);

      // 注册 source 文件
      const source: TableSource = {
        file: filePath,
        blockId: '',
        blockIndex: 0,
        rowCount: table.records.length,
      };
      this.schemaRegistry.addSource(table.tableName, source);
    }

    // 更新 file hash
    const fileHash = simpleHash(fileContent);
    this.fileHash.setHash(filePath, fileHash);

    return result;
    } finally {
      this._parsing.delete(filePath);
    }
  }

  /**
   * 扫描 Vault 中的多个文件
   */
  rescanVault(files: Array<{ path: string; content: string }>): VaultScanResult {
    if (!this._ready) {
      throw new EngineError('Engine not initialized', 'ENGINE_NOT_READY');
    }

    this.diagnostics.setStatus('rebuilding');
    this.emit('rescan-started');

    const context = {
      run: (sql: string, params?: unknown[]) => this.sqlite.run(sql, params),
      query: (sql: string, params?: unknown[]) => this.sqlite.query(sql, params),
      identMode: this.identMode,
    };

    let totalTableCount = 0;
    let totalRows = 0;
    let totalErrors = 0;
    let totalWarnings = 0;
    const fileResults: FileParseResult[] = [];

    for (const file of files) {
      let result: FileParseResult;
      try {
        // 走 parseFile 入口，确保每次解析前清理旧数据（幂等）
        result = this.parseFile(file.content, file.path);
      } catch (e) {
        result = {
          tables: [],
          totalErrors: 1,
          totalWarnings: 0,
          filePath: file.path,
        };
        this.diagnostics.recordError(
          'FILE_PARSE_ERROR',
          `Failed to parse "${file.path}": ${(e as Error).message ?? e}`,
          undefined,
          file.path,
        );
      }
      fileResults.push(result);
      totalErrors += result.totalErrors;
      totalWarnings += result.totalWarnings;

      for (const table of result.tables) {
        totalTableCount++;
        totalRows += table.records.length;
      }
    }

    this.diagnostics.setLastFullScanAt(new Date().toISOString());

    if (totalErrors > 0) {
      this.diagnostics.setStatus('degraded');
      this._status = 'degraded';
    } else {
      this.diagnostics.setStatus('ready');
      this._status = 'ready';
    }

    this.emit('rescan-completed', {
      fileCount: files.length,
      errorCount: totalErrors,
      durationMs: 0,
    });

    return {
      fileResults,
      tableCount: totalTableCount,
      totalRows,
      totalErrors,
      totalWarnings,
    };
  }

  // ============================================================
  // 查询
  // ============================================================

  query(q: Query): ResultOrError<ResultSet> {
    if (!this._ready) {
      return err(new EngineError('Engine not initialized', 'ENGINE_NOT_READY'));
    }
    return this.queryEngine.query(q);
  }

  queryRaw(sql: string, params?: unknown[], options?: RawQueryOptions): ResultOrError<ResultSet> {
    if (!this._ready) {
      return err(new EngineError('Engine not initialized', 'ENGINE_NOT_READY'));
    }
    return this.queryEngine.queryRaw(sql, params, options);
  }

  // ============================================================
  // 写入 — Milestone 2 单文件 CRUD + Milestone 3 WAL 集成
  // ============================================================

  async insert(_table: string, _record: RecordInput, _options?: WriteOptions): Promise<WriteResult> {
    if (!this._ready) {
      throw new EngineError('Engine not initialized', 'ENGINE_NOT_READY');
    }

    try {
      // WAL 创建设在 CRUDExecutor 内部完成
      // MVP 单文件写入暂不生成 WAL（M3 完整 WAL 通过 CRUDExecutor 集成）
      const result = await this.crud.insert(_table, _record);

      this.emit('data-changed', {
        type: 'insert',
        table: _table,
        storagePk: result.storagePk,
      } as DataChangedEvent);

      return {
        storagePk: result.storagePk,
        table: _table,
        syncState: result.syncState,
        lineNumber: result.lineNumber,
      };
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new WriteError(
        `INSERT failed: ${e instanceof Error ? e.message : String(e)}`,
        _table,
      );
    }
  }

  async update(_storagePk: string, _patch: RecordPatch, _options?: WriteOptions): Promise<WriteResult> {
    if (!this._ready) {
      throw new EngineError('Engine not initialized', 'ENGINE_NOT_READY');
    }

    try {
      const binding = this.binding.findByStoragePk(_storagePk);
      if (!binding) {
        throw new EngineError(`Record not found: ${_storagePk}`, 'RECORD_NOT_FOUND');
      }

      const result = await this.crud.update(_storagePk, _patch);

      this.emit('data-changed', {
        type: 'update',
        table: binding.tableName,
        storagePk: result.storagePk,
      } as DataChangedEvent);

      return {
        storagePk: result.storagePk,
        table: binding.tableName,
        syncState: result.syncState,
        lineNumber: result.lineNumber,
      };
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new WriteError(
        `UPDATE failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async delete(_storagePk: string, _options?: WriteOptions): Promise<WriteResult> {
    if (!this._ready) {
      throw new EngineError('Engine not initialized', 'ENGINE_NOT_READY');
    }

    try {
      const binding = this.binding.findByStoragePk(_storagePk);
      if (!binding) {
        throw new EngineError(`Record not found: ${_storagePk}`, 'RECORD_NOT_FOUND');
      }

      const result = await this.crud.delete(_storagePk);

      this.emit('data-changed', {
        type: 'delete',
        table: binding.tableName,
        storagePk: result.storagePk,
      } as DataChangedEvent);

      return {
        storagePk: result.storagePk,
        table: binding.tableName,
        syncState: result.syncState,
      };
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new WriteError(
        `DELETE failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ============================================================
  // 事务 — Milestone 5
  // ============================================================

  /**
   * 执行显式事务。
   *
   * 在事务回调中执行的所有 CRUD 操作共享：
   * - 同一个 txId
   * - SQLite savepoint（失败时自动回滚）
   * - WAL 条目（用于文件级恢复）
   *
   * 回调中 throw → 自动回滚 SQLite 变更。
   */
  async transaction<T>(cb: (tx: Transaction) => Promise<T>): Promise<T> {
    if (!this._ready) {
      throw new EngineError('Engine not initialized', 'ENGINE_NOT_READY');
    }
    return this.transactionManager.transaction(cb);
  }

  // ============================================================
  // WAL / 死信管理 — Milestone 3
  // ============================================================

  /**
   * 获取所有死信 WAL 的诊断信息
   */
  async getDeadLetters(): Promise<DeadLetterInfo[]> {
    return this.deadLetterHandler.getDeadLetters();
  }

  /**
   * 重试单个死信 WAL
   */
  async retryDeadLetter(txId: string): Promise<void> {
    await this.deadLetterHandler.retryDeadLetter(txId);
    // 触发立即重试
    await this.retryScheduler.retryAll();
  }

  /**
   * 丢弃单个死信 WAL
   */
  async discardDeadLetter(txId: string): Promise<void> {
    await this.deadLetterHandler.discardDeadLetter(txId);
  }

  /**
   * 重试所有死信 WAL
   */
  async retryAllDeadLetters(): Promise<number> {
    const count = await this.deadLetterHandler.retryAll();
    await this.retryScheduler.retryAll();
    return count;
  }

  /**
   * 丢弃所有死信 WAL
   */
  async discardAllDeadLetters(): Promise<number> {
    return this.deadLetterHandler.discardAll();
  }

  // ============================================================
  // 文件变更通知 — Milestone 3
  // ============================================================

  /**
   * 通知文件创建（由 FileWatcher 或上层调用）
   */
  async onFileCreated(filePath: string, content: string): Promise<void> {
    await this.fileWatcher.onFileCreate(filePath);

    if (this._ready) {
      this.parseFile(content, filePath);
    }
  }

  /**
   * 通知文件修改
   */
  async onFileModified(filePath: string, content: string, ownerId?: string): Promise<void> {
    await this.fileWatcher.onFileModify(filePath, ownerId);

    if (this._ready && !ownerId) {
      // 外部修改 → 重新解析
      this.parseFile(content, filePath);
    }
  }

  /**
   * 通知文件删除
   */
  async onFileDeleted(filePath: string): Promise<void> {
    await this.fileWatcher.onFileDelete(filePath);

    if (this._ready) {
      // 多文件表安全删除：
      // 1. 删除 binding 和用户表记录
      this.binding.deleteByFilePath(filePath);
      // 2. 从 schema_registry 移除 source（无 source 时自动 DROP）
      this.schemaRegistry.removeFile(filePath);
      // 3. 更新 file hash
      this.fileHash.remove(filePath);
    }
  }

  // ============================================================
  // 诊断
  // ============================================================

  async getDiagnostics(): Promise<EngineDiagnostics> {
    // 收集 WAL 统计数据
    let pendingWalCount = 0;
    let deadWalCount = 0;

    try {
      const pending = await this.walManager.getReplayableWals();
      pendingWalCount = pending.length;
      const dead = await this.walManager.getDeadWals();
      deadWalCount = dead.length;
    } catch {
      // WAL 查询失败时使用 0
    }

    return this.diagnostics.getDiagnostics(
      this.schemaRegistry.getTableNames().length,
      this.binding.count(),
      pendingWalCount,
      deadWalCount,
      0,
    );
  }

  /**
   * 获取诊断命令执行结果
   */
  async executeDiagnosticCommand(command: string): Promise<{ success: boolean; message: string }> {
    switch (command) {
      case 'retry-dead-wal':
        const retryCount = await this.retryAllDeadLetters();
        return { success: true, message: `Retried ${retryCount} dead WAL(s)` };

      case 'discard-dead-wal':
        const discardCount = await this.discardAllDeadLetters();
        return { success: true, message: `Discarded ${discardCount} dead WAL(s)` };

      case 'show-diagnostics':
        const diag = await this.getDiagnostics();
        return {
          success: true,
          message: [
            `Status: ${diag.engineStatus}`,
            `Tables: ${diag.tableCount}, Rows: ${diag.rowCount}`,
            `WAL: ${diag.pendingWalCount} pending, ${diag.deadWalCount} dead`,
            `Uptime: ${Math.round((diag.uptimeMs ?? 0) / 1000)}s`,
            `Errors: ${diag.recentErrorCount}`,
          ].join('\n'),
        };

      default:
        return { success: false, message: `Unknown command: ${command}` };
    }
  }

  // ============================================================
  // Schema 查询（视图层使用）
  // ============================================================

  /** 获取所有表名 */
  getTableNames(): string[] {
    return this.schemaRegistry.getTableNames();
  }

  /** 获取表信息 */
  getTableInfo(tableName: string) {
    return this.schemaRegistry.getTable(tableName);
  }

  // ============================================================
  // 事件系统
  // ============================================================

  on(event: string, handler: (...args: unknown[]) => void): Disposable {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return {
      dispose: () => {
        this.eventHandlers.get(event)?.delete(handler);
      },
    };
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch {
          // 单个 handler 异常不影响其他
        }
      }
    }
  }
}

function simpleHash(str: string): string {
  let hash = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 默认 FileOperator（内存实现，用于测试和无 Obsidian 环境）
 */
function createDefaultFileOperator(): import('../write/types').FileOperator {
  const store = new Map<string, string>();

  return {
    async readFile(filePath: string): Promise<string> {
      const content = store.get(filePath);
      if (content === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content;
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      store.set(filePath, content);
    },

    async processFile(filePath: string, updater: (content: string) => string): Promise<string> {
      const current = store.get(filePath) ?? '';
      const updated = updater(current);
      store.set(filePath, updated);
      return updated;
    },
  };
}
