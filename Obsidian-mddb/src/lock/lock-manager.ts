/**
 * LockManager — 文件级异步锁
 *
 * 基于 FIFO 队列实现，确保同一文件的操作严格串行化。
 * - 首个请求者立即获取锁
 * - 后续请求者进入 FIFO 等待队列
 * - 释放时按队列顺序唤醒下一个等待者
 * - 多文件锁按路径排序避免死锁
 * - 支持相同 ownerId 重入
 *
 * 参考：runtime-architecture.md §6, v2 roadmap Milestone 2
 */

import { EngineError } from '../core/errors';

type ReleaseFn = () => void;

interface FileLock {
  ownerId: string;
  reentrantCount: number;
}

interface Waiter {
  ownerId: string;
  resolve: (release: ReleaseFn) => void;
  reject: (err: Error) => void;
}

/**
 * 文件锁管理器
 */
export class LockManager {
  /** 当前持有锁的文件 */
  private locks = new Map<string, FileLock>();

  /** 每个文件的等待队列 */
  private queues = new Map<string, Waiter[]>();

  private _shutdown = false;

  get isShutdown(): boolean {
    return this._shutdown;
  }

  // ============================================================
  // 公共 API
  // ============================================================

  /**
   * 获取单个文件锁
   *
   * - 文件未被锁 → 立即获取
   * - 文件被当前 owner 持有 → 重入计数 +1
   * - 文件被其他 owner 持有 → 进入 FIFO 队列等待
   */
  async acquireLock(filePath: string, ownerId: string): Promise<ReleaseFn> {
    this.assertNotShutdown();

    const currentLock = this.locks.get(filePath);

    // 无锁 → 直接获取
    if (!currentLock) {
      this.locks.set(filePath, { ownerId, reentrantCount: 0 });
      return this.createReleaseFn(filePath, ownerId);
    }

    // 重入
    if (currentLock.ownerId === ownerId) {
      currentLock.reentrantCount++;
      return this.createReentrantReleaseFn(filePath, ownerId);
    }

    // 加入等待队列
    return new Promise<ReleaseFn>((resolve, reject) => {
      const queue = this.queues.get(filePath) ?? [];
      queue.push({ ownerId, resolve, reject });
      this.queues.set(filePath, queue);
    });
  }

  /**
   * 同时获取多个文件锁
   *
   * 路径按排序获取，避免死锁。
   */
  async acquireLocks(filePaths: string[], ownerId: string): Promise<ReleaseFn> {
    this.assertNotShutdown();

    const sorted = [...new Set(filePaths)].sort();
    const releases: ReleaseFn[] = [];

    try {
      for (const fp of sorted) {
        const release = await this.acquireLock(fp, ownerId);
        releases.push(release);
      }
    } catch (e) {
      // 回滚已获取的锁
      for (const r of releases) r();
      throw e;
    }

    // 统一释放函数
    return () => {
      for (const r of releases) r();
    };
  }

  /**
   * 带锁执行单文件操作
   */
  async withFileLock<T>(
    filePath: string,
    ownerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireLock(filePath, ownerId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 带锁执行多文件操作
   */
  async withFileLocks<T>(
    filePaths: string[],
    ownerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireLocks(filePaths, ownerId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 关闭锁管理器：拒绝新锁，清空等待队列
   */
  shutdown(): void {
    this._shutdown = true;

    for (const [, queue] of this.queues) {
      for (const waiter of queue) {
        waiter.reject(new EngineError('LockManager is shut down', 'LOCK_MANAGER_SHUTDOWN'));
      }
    }
    this.queues.clear();
    this.locks.clear();
  }

  // ============================================================
  // 内部
  // ============================================================

  private assertNotShutdown(): void {
    if (this.isShutdown) {
      throw new EngineError('LockManager is shut down', 'LOCK_MANAGER_SHUTDOWN');
    }
  }

  /**
   * 创建释放函数（非重入）
   */
  private createReleaseFn(filePath: string, ownerId: string): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseLock(filePath, ownerId);
    };
  }

  /**
   * 创建释放函数（重入）
   */
  private createReentrantReleaseFn(filePath: string, ownerId: string): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const lock = this.locks.get(filePath);
      if (lock && lock.ownerId === ownerId && lock.reentrantCount > 0) {
        lock.reentrantCount--;
      }
    };
  }

  /**
   * 释放锁并唤醒下一个等待者
   */
  private releaseLock(filePath: string, ownerId: string): void {
    const lock = this.locks.get(filePath);

    // 只有当前持有者能释放
    if (!lock || lock.ownerId !== ownerId) return;

    // 还有重入计数 → 不释放
    if (lock.reentrantCount > 0) {
      lock.reentrantCount--;
      return;
    }

    // 检查等待队列
    const queue = this.queues.get(filePath);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.queues.delete(filePath);

      // 直接将锁转给下一个等待者
      lock.ownerId = next.ownerId;
      lock.reentrantCount = 0;

      // 唤醒等待者，传入释放函数
      next.resolve(this.createReleaseFn(filePath, next.ownerId));
    } else {
      // 无等待者 → 直接释放
      this.locks.delete(filePath);
    }
  }
}
