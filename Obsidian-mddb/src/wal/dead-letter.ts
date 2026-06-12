/**
 * 死信处理器 (DeadLetterHandler)
 *
 * 管理进入 dead 状态的 WAL 条目。
 *
 * 参考：v2 roadmap §7.4
 *
 * 死信策略：
 * - pending/retrying: 系统自动重试，UI 展示未同步
 * - dead: 状态栏强提示，诊断面板展示完整信息
 * - 用户可选择：重试、查看冲突、丢弃 WAL、重建索引
 */

import type { WalEntry } from './types';
import type { WalManager } from './wal-manager';

// ============================================================
// 死信信息（提供给诊断面板和 UI）
// ============================================================

export interface DeadLetterInfo {
  txId: string;
  createdAt: string;
  updatedAt: string;
  operationCount: number;
  completedCount: number;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  files: string[];
}

// ============================================================
// 死信处理器
// ============================================================

export class DeadLetterHandler {
  private walManager: WalManager;

  constructor(walManager: WalManager) {
    this.walManager = walManager;
  }

  /**
   * 获取所有死信 WAL 的诊断信息
   */
  async getDeadLetters(): Promise<DeadLetterInfo[]> {
    const deadWals = await this.walManager.getDeadWals();
    return deadWals.map(this.toDeadLetterInfo);
  }

  /**
   * 获取死信数量
   */
  async count(): Promise<number> {
    const deadWals = await this.walManager.getDeadWals();
    return deadWals.length;
  }

  /**
   * 重试单个死信 WAL
   *
   * 重置状态为 pending，清空重试计数。
   * 之后由 RetryScheduler 调度重试。
   */
  async retryDeadLetter(txId: string): Promise<void> {
    const entry = await this.walManager.getWal(txId);
    if (!entry) {
      throw new Error(`Dead letter not found: ${txId}`);
    }

    if (entry.status !== 'dead') {
      throw new Error(`WAL "${txId}" is not in dead status (current: ${entry.status})`);
    }

    // 重置为 pending，清空重试状态
    entry.status = 'pending';
    entry.retry.count = 0;
    entry.retry.lastError = null;
    entry.retry.lastAttemptAt = null;
    entry.retry.nextAttemptAt = null;
    // 不清除已完成的 progress，保留恢复点

    await this.walManager['store'].save(entry);
  }

  /**
   * 丢弃死信 WAL
   *
   * 标记为 done 并删除（不重试）。
   */
  async discardDeadLetter(txId: string): Promise<void> {
    const entry = await this.walManager.getWal(txId);
    if (!entry) {
      throw new Error(`Dead letter not found: ${txId}`);
    }

    if (entry.status !== 'dead') {
      throw new Error(`WAL "${txId}" is not in dead status (current: ${entry.status})`);
    }

    await this.walManager.updateStatus(txId, 'done');
  }

  /**
   * 丢弃所有死信
   */
  async discardAll(): Promise<number> {
    const deadWals = await this.walManager.getDeadWals();
    let count = 0;
    for (const entry of deadWals) {
      await this.walManager.updateStatus(entry.txId, 'done');
      count++;
    }
    return count;
  }

  /**
   * 重试所有死信
   */
  async retryAll(): Promise<number> {
    const deadWals = await this.walManager.getDeadWals();
    let count = 0;
    for (const entry of deadWals) {
      entry.status = 'pending';
      entry.retry.count = 0;
      entry.retry.lastError = null;
      entry.retry.lastAttemptAt = null;
      entry.retry.nextAttemptAt = null;
      await this.walManager['store'].save(entry);
      count++;
    }
    return count;
  }

  // ============================================================
  // 辅助
  // ============================================================

  private toDeadLetterInfo(entry: WalEntry): DeadLetterInfo {
    const files = new Set<string>();
    for (const op of entry.operations) {
      files.add(op.file);
    }

    return {
      txId: entry.txId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      operationCount: entry.operations.length,
      completedCount: entry.progress.completedOperationIds.length,
      retryCount: entry.retry.count,
      maxRetries: entry.retry.maxRetries,
      lastError: entry.retry.lastError,
      lastAttemptAt: entry.retry.lastAttemptAt,
      files: Array.from(files),
    };
  }
}
