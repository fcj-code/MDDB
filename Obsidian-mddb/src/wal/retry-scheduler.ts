/**
 * 重试调度器 (RetryScheduler)
 *
 * 负责管理 WAL 重试调度、退避策略和重试队列。
 *
 * 参考：v2 roadmap §7.3-7.4
 *
 * 核心策略：
 * - 指数退避：2^n * 1000ms，上限 60s
 * - ±20% 随机抖动
 * - 最大重试次数后进入 dead
 * - 调度通过定时检查机制触发
 */

import type { FileOperator } from '../write/types';
import type { WalEntry } from './types';
import { computeRetryDelay } from './types';
import type { WalManager } from './wal-manager';
import { replayWal } from './replay';
import type { ReplayResult } from './types';

export interface RetrySchedulerOptions {
  /** 检查重试周期（毫秒） */
  checkIntervalMs: number;
  /** 是否自动启动 */
  autoStart: boolean;
}

const DEFAULT_OPTIONS: RetrySchedulerOptions = {
  checkIntervalMs: 30_000, // 30 秒
  autoStart: false,
};

// ============================================================
// 重试调度器
// ============================================================

export class RetryScheduler {
  private walManager: WalManager;
  private fileOperator: FileOperator;
  private options: RetrySchedulerOptions;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _shutdown = false;

  constructor(
    walManager: WalManager,
    fileOperator: FileOperator,
    options?: Partial<RetrySchedulerOptions>,
  ) {
    this.walManager = walManager;
    this.fileOperator = fileOperator;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this._running;
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 启动定时检查
   */
  start(): void {
    if (this._shutdown) return;
    if (this._running) return;

    this._running = true;
    this.timerId = setInterval(
      () => this.checkRetries(),
      this.options.checkIntervalMs,
    );
  }

  /**
   * 停止定时检查
   */
  stop(): void {
    this._running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * 关闭调度器
   */
  shutdown(): void {
    this.stop();
    this._shutdown = true;
  }

  // ============================================================
  // 重试逻辑
  // ============================================================

  /**
   * 检查并处理到期重试
   *
   * 返回本轮处理的重试结果列表。
   */
  async checkRetries(): Promise<RetryBatchResult> {
    if (this._shutdown) {
      return { processed: 0, succeeded: 0, failed: 0, dead: 0 };
    }

    const dueEntries = await this.walManager.getDueRetries();
    if (dueEntries.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0, dead: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    let dead = 0;

    for (const entry of dueEntries) {
      const result = await this.retryEntry(entry);
      if (result.success) {
        succeeded++;
      } else {
        failed++;
        if (entry.retry.count >= entry.retry.maxRetries) {
          dead++;
        }
      }
    }

    return {
      processed: dueEntries.length,
      succeeded,
      failed,
      dead,
    };
  }

  /**
   * 重试单个 WAL 条目
   */
  async retryEntry(entry: WalEntry): Promise<ReplayResult> {
    let opIndex = 0;

    const result = await replayWal(entry, this.fileOperator, async (opId) => {
      await this.walManager.markOperationCompleted(entry.txId, opId);
      opIndex++;
    });

    if (result.success) {
      // 全部成功 → 标记 done
      await this.walManager.updateStatus(entry.txId, 'done');
    } else {
      // 部分失败 → 检查重试次数
      const retryCount = entry.retry.count + 1;

      if (retryCount >= entry.retry.maxRetries) {
        // 超过最大重试次数 → dead
        await this.walManager.recordRetry(
          entry.txId,
          result.operationResults.find(r => !r.success)?.error ?? 'Unknown error',
          null, // null nextAttemptAt → dead
        );
      } else {
        // 还在重试次数内 → 安排下次重试
        const delay = computeRetryDelay(retryCount);
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        await this.walManager.recordRetry(
          entry.txId,
          result.operationResults.find(r => !r.success)?.error ?? 'Unknown error',
          nextAttemptAt,
        );
      }
    }

    return result;
  }

  /**
   * 立即重试所有 pending 和 retrying 的 WAL
   */
  async retryAll(): Promise<RetryBatchResult> {
    const entries = await this.walManager.getReplayableWals();
    let succeeded = 0;
    let failed = 0;
    let dead = 0;

    for (const entry of entries) {
      const result = await this.retryEntry(entry);
      if (result.success) {
        succeeded++;
      } else {
        failed++;
        if (entry.retry.count >= entry.retry.maxRetries) {
          dead++;
        }
      }
    }

    return {
      processed: entries.length,
      succeeded,
      failed,
      dead,
    };
  }
}

// ============================================================
// 类型
// ============================================================

export interface RetryBatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  dead: number;
}
