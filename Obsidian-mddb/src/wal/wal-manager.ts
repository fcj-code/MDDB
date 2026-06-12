/**
 * WAL 管理器 (WalManager)
 *
 * 负责 WAL 条目的生命周期管理、持久化、状态转换。
 *
 * 参考：v2 roadmap §7 WAL v2 协议, runtime-architecture.md §6
 *
 * 核心职责：
 * 1. 创建持久化 WAL 条目
 * 2. 管理 pending → retrying → dead/done 状态转换
 * 3. 记录已完成的操作 ID（幂等恢复点）
 * 4. 按状态查询 WAL 条目
 * 5. 关闭时清理资源
 */

import type { FileOperator } from '../write/types';
import type {
  WalEntry,
  WalOperation,
  WalStatus,
  WalStore,
} from './types';
import {
  WAL_VERSION,
  DEFAULT_MAX_RETRIES,
} from './types';
import { EngineError } from '../core/errors';

// ============================================================
// 默认 WAL 存储实现（JSON 文件持久化）
// ============================================================

export class FileWalStore implements WalStore {
  readonly walDir: string;

  constructor(
    private fileOperator: FileOperator,
    walDir: string = '.mddb/wals',
  ) {
    this.walDir = walDir.replace(/\\/g, '/').replace(/\/$/, '');
  }

  private walPath(txId: string): string {
    return `${this.walDir}/${txId}.json`;
  }

  async loadAll(): Promise<WalEntry[]> {
    try {
      const fileList = await this.list();
      const entries: WalEntry[] = [];

      for (const fileName of fileList) {
        if (!fileName.endsWith('.json')) continue;
        const txId = fileName.replace(/\.json$/, '');
        try {
          const entry = await this.load(txId);
          if (entry) entries.push(entry);
        } catch {
          // 跳过损坏的 WAL 文件
        }
      }

      return entries;
    } catch {
      // wals 目录不存在或无权限
      return [];
    }
  }

  async load(txId: string): Promise<WalEntry | null> {
    try {
      const content = await this.fileOperator.readFile(this.walPath(txId));
      const parsed = JSON.parse(content);
      return parsed as WalEntry;
    } catch {
      return null;
    }
  }

  async save(entry: WalEntry): Promise<void> {
    const content = JSON.stringify(entry, null, 2);
    await this.fileOperator.writeFile(this.walPath(entry.txId), content);
  }

  async delete(txId: string): Promise<void> {
    try {
      await this.fileOperator.writeFile(this.walPath(txId), '');
      // 在 FileOperator 接口中无法直接删除文件
      // 写空内容标记删除，加载时过滤
    } catch {
      // 忽略删除失败
    }
  }

  async list(): Promise<string[]> {
    // FileOperator 接口不直接支持目录列表
    // 通过加载全部已知 WAL 来实现遍历
    // 实际使用中由插件层注入支持列表的 FileOperator 扩展
    return [];
  }
}

// ============================================================
// 内存 WAL 存储（用于测试和无持久化场景）
// ============================================================

export class InMemoryWalStore implements WalStore {
  readonly walDir = ':memory:';
  private entries = new Map<string, WalEntry>();

  async loadAll(): Promise<WalEntry[]> {
    return Array.from(this.entries.values()).filter(e => e.status !== 'done');
  }

  async save(entry: WalEntry): Promise<void> {
    this.entries.set(entry.txId, { ...entry, updatedAt: new Date().toISOString() });
  }

  async delete(txId: string): Promise<void> {
    this.entries.delete(txId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.entries.keys());
  }

  /** 按状态查询 */
  listByStatus(status: WalStatus): WalEntry[] {
    return Array.from(this.entries.values()).filter(e => e.status === status);
  }

  /** 获取所有条目 */
  getAll(): WalEntry[] {
    return Array.from(this.entries.values());
  }

  /** 清除所有条目（测试用） */
  clear(): void {
    this.entries.clear();
  }
}

// ============================================================
// WAL 管理器
// ============================================================

export class WalManager {
  private store: WalStore;
  private _shutdown = false;

  constructor(store?: WalStore) {
    this.store = store ?? new InMemoryWalStore();
  }

  /** 设置 WAL 存储实现 */
  setStore(store: WalStore): void {
    if (this._shutdown) {
      throw new EngineError('WalManager is shut down', 'WAL_SHUTDOWN');
    }
    this.store = store;
  }

  /** 获取当前存储 */
  getStore(): WalStore {
    return this.store;
  }

  // ============================================================
  // WAL 生命周期
  // ============================================================

  /**
   * 创建新的 WAL 条目
   *
   * 在文件写入前调用，确保故障后可恢复。
   */
  async createWal(
    txId: string,
    operations: WalOperation[],
    maxRetries: number = DEFAULT_MAX_RETRIES,
  ): Promise<WalEntry> {
    if (this._shutdown) {
      throw new EngineError('WalManager is shut down', 'WAL_SHUTDOWN');
    }

    const entry: WalEntry = {
      txId,
      version: WAL_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
      operations,
      progress: {
        completedOperationIds: [],
      },
      retry: {
        count: 0,
        maxRetries,
        lastError: null,
        lastAttemptAt: null,
        nextAttemptAt: null,
      },
    };

    await this.store.save(entry);
    return entry;
  }

  /**
   * 获取 WAL 条目
   */
  async getWal(txId: string): Promise<WalEntry | null> {
    if (this.store instanceof InMemoryWalStore) {
      const entry = this.store.getAll().find(e => e.txId === txId);
      return entry ?? null;
    }
    return this.store.load(txId);
  }

  /**
   * 更新 WAL 状态
   */
  async updateStatus(txId: string, status: WalStatus): Promise<void> {
    const entry = await this.getWal(txId);
    if (!entry) {
      throw new EngineError(`WAL not found: ${txId}`, 'WAL_NOT_FOUND');
    }
    entry.status = status;
    entry.updatedAt = new Date().toISOString();
    await this.store.save(entry);
  }

  /**
   * 标记一个操作为已完成
   *
   * 每次完成后立即持久化，确保可从中断点继续。
   */
  async markOperationCompleted(txId: string, opId: string): Promise<void> {
    const entry = await this.getWal(txId);
    if (!entry) {
      throw new EngineError(`WAL not found: ${txId}`, 'WAL_NOT_FOUND');
    }

    if (!entry.progress.completedOperationIds.includes(opId)) {
      entry.progress.completedOperationIds.push(opId);
    }
    entry.updatedAt = new Date().toISOString();
    await this.store.save(entry);
  }

  /**
   * 记录重试信息
   */
  async recordRetry(
    txId: string,
    error: string,
    nextAttemptAt: string | null,
  ): Promise<void> {
    const entry = await this.getWal(txId);
    if (!entry) {
      throw new EngineError(`WAL not found: ${txId}`, 'WAL_NOT_FOUND');
    }

    entry.retry.count++;
    entry.retry.lastError = error;
    entry.retry.lastAttemptAt = new Date().toISOString();
    entry.retry.nextAttemptAt = nextAttemptAt;
    entry.status = nextAttemptAt ? 'retrying' : 'dead';
    entry.updatedAt = new Date().toISOString();
    await this.store.save(entry);
  }

  /**
   * 删除 WAL 条目（成功后清理）
   */
  async deleteWal(txId: string): Promise<void> {
    await this.store.delete(txId);
  }

  // ============================================================
  // 查询
  // ============================================================

  /**
   * 获取所有可重放的 WAL（pending 或 retrying）
   */
  async getReplayableWals(): Promise<WalEntry[]> {
    const all = await this.store.loadAll();
    return all.filter(
      e => (e.status === 'pending' || e.status === 'retrying') && e.operations.length > 0,
    );
  }

  /**
   * 获取死信 WAL
   */
  async getDeadWals(): Promise<WalEntry[]> {
    const all = await this.store.loadAll();
    return all.filter(e => e.status === 'dead');
  }

  /**
   * 获取已完成 WAL
   */
  async getDoneWals(): Promise<WalEntry[]> {
    const all = await this.store.loadAll();
    return all.filter(e => e.status === 'done');
  }

  /**
   * 获取待重试的 WAL（nextAttemptAt <= now 的 retrying）
   */
  async getDueRetries(): Promise<WalEntry[]> {
    const all = await this.store.loadAll();
    const now = new Date().toISOString();
    return all.filter(
      e =>
        e.status === 'retrying' &&
        e.retry.nextAttemptAt !== null &&
        e.retry.nextAttemptAt <= now,
    );
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 关闭管理器
   *
   * 阻止新 WAL 创建，但不删除已有 WAL。
   */
  shutdown(): void {
    this._shutdown = true;
  }

  /** 是否已关闭 */
  get isShutdown(): boolean {
    return this._shutdown;
  }
}
