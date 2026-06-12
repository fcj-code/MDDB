/**
 * 重扫调度器 (RescanScheduler)
 *
 * 管理后台重扫和分批扫描。
 *
 * 参考：v2 roadmap §2.2（超限策略）, runtime-architecture.md §5
 *
 * 核心能力：
 * - 分批扫描大 vault（避免阻塞 UI）
 * - 触发事件协调（rescan-started / rescan-completed）
 * - 后台校验扫描
 * - 重扫节流（避免频繁触发）
 */

import type { DiagnosticsManager } from '../engine/diagnostics';
import type { EngineDiagnostics } from '../engine/diagnostics';

// ============================================================
// 类型定义
// ============================================================

export interface RescanBatch {
  files: Array<{ path: string; content: string }>;
  batchIndex: number;
  totalBatches: number;
}

export interface RescanProgress {
  currentBatch: number;
  totalBatches: number;
  processedFiles: number;
  totalFiles: number;
}

export interface RescanSchedulerOptions {
  /** 每批最大文件数 */
  batchSize: number;
  /** 批间延迟（毫秒） */
  batchDelayMs: number;
  /** 是否需要事件通知 */
  emitEvents: boolean;
  /** 后台校验间隔（毫秒），0 表示不自动校验 */
  verifyIntervalMs: number;
}

const DEFAULT_OPTIONS: RescanSchedulerOptions = {
  batchSize: 50,
  batchDelayMs: 50,
  emitEvents: true,
  verifyIntervalMs: 300_000, // 5 分钟
};

// ============================================================
// 重扫调度器
// ============================================================

export type RescanCallback = (batch: RescanBatch) => Promise<{ errors: number }>;
export type VerifyCallback = () => Promise<void>;

export class RescanScheduler {
  private options: RescanSchedulerOptions;
  private diagnostics: DiagnosticsManager;
  private _running = false;
  private _shutdown = false;
  private verifyTimerId: ReturnType<typeof setInterval> | null = null;
  private rescanCallback: RescanCallback | null = null;
  private verifyCallback: VerifyCallback | null = null;

  // 进度回调
  onProgress?: (progress: RescanProgress) => void;

  constructor(
    diagnostics: DiagnosticsManager,
    options?: Partial<RescanSchedulerOptions>,
  ) {
    this.diagnostics = diagnostics;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this._running;
  }

  // ============================================================
  // 回调注册
  // ============================================================

  /**
   * 设置重扫回调（由 Engine 注入）
   */
  setRescanCallback(cb: RescanCallback): void {
    this.rescanCallback = cb;
  }

  /**
   * 设置后台校验回调（由 Engine 注入）
   */
  setVerifyCallback(cb: VerifyCallback): void {
    this.verifyCallback = cb;
  }

  // ============================================================
  // 全量扫描
  // ============================================================

  /**
   * 执行分批全量扫描
   *
   * @param files 所有待扫描文件
   * @param options 可选覆盖选项
   */
  async scanAll(
    files: Array<{ path: string; content: string }>,
    options?: { emitEvents?: boolean },
  ): Promise<RescanAllResult> {
    if (this._shutdown || this._running) {
      return { success: false, totalErrors: 0, totalFiles: files.length, message: 'Scheduler busy or shut down' };
    }

    this._running = true;
    const emitEvents = options?.emitEvents ?? this.options.emitEvents;

    if (emitEvents) {
      // 通知重扫开始
      this.diagnostics.setStatus('rebuilding');
    }

    const batches = this.createBatches(files);
    let totalErrors = 0;

    for (let i = 0; i < batches.length; i++) {
      if (this._shutdown) break;

      const batch = batches[i]!;
      const result = await this.processBatch(batch);

      totalErrors += result.errors;

      // 进度通知
      if (this.onProgress) {
        this.onProgress({
          currentBatch: i + 1,
          totalBatches: batches.length,
          processedFiles: (i + 1) * this.options.batchSize,
          totalFiles: files.length,
        });
      }

      // 批间延迟（让出 UI 线程）
      if (i < batches.length - 1 && this.options.batchDelayMs > 0) {
        await delay(this.options.batchDelayMs);
      }
    }

    this._running = false;

    if (emitEvents) {
      // 通知重扫完成
      if (totalErrors > 0) {
        this.diagnostics.setStatus('degraded');
      } else {
        this.diagnostics.setStatus('ready');
      }
    }

    return {
      success: totalErrors === 0,
      totalErrors,
      totalFiles: files.length,
      message: `Scan completed: ${files.length} files, ${totalErrors} errors`,
    };
  }

  /**
   * 增量扫描指定的文件列表
   */
  async scanFiles(
    files: Array<{ path: string; content: string }>,
  ): Promise<RescanAllResult> {
    if (this._shutdown) return { success: false, totalErrors: 0, totalFiles: files.length, message: 'Scheduler shut down' };

    const result = await this.scanAll(files, { emitEvents: false });

    return result;
  }

  // ============================================================
  // 后台校验
  // ============================================================

  /**
   * 启动定时后台校验
   */
  startVerifyTimer(): void {
    if (this._shutdown) return;
    if (this.verifyTimerId !== null) return;

    this.verifyTimerId = setInterval(async () => {
      if (this._shutdown || this._running) return;
      if (this.verifyCallback) {
        try {
          await this.verifyCallback();
        } catch {
          // 后台校验失败不阻塞
        }
      }
    }, this.options.verifyIntervalMs);
  }

  /**
   * 停止定时后台校验
   */
  stopVerifyTimer(): void {
    if (this.verifyTimerId !== null) {
      clearInterval(this.verifyTimerId);
      this.verifyTimerId = null;
    }
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 关闭调度器
   */
  shutdown(): void {
    this._shutdown = true;
    this.stopVerifyTimer();
    this._running = false;
    this.rescanCallback = null;
    this.verifyCallback = null;
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  private createBatches(files: Array<{ path: string; content: string }>): RescanBatch[] {
    const batches: RescanBatch[] = [];
    const batchSize = this.options.batchSize;

    for (let i = 0; i < files.length; i += batchSize) {
      const chunk = files.slice(i, i + batchSize);
      batches.push({
        files: chunk,
        batchIndex: Math.floor(i / batchSize),
        totalBatches: Math.ceil(files.length / batchSize),
      });
    }

    return batches;
  }

  private async processBatch(batch: RescanBatch): Promise<{ errors: number }> {
    if (!this.rescanCallback) {
      return { errors: 0 };
    }

    try {
      return await this.rescanCallback(batch);
    } catch {
      return { errors: batch.files.length };
    }
  }
}

// ============================================================
// 类型
// ============================================================

export interface RescanAllResult {
  success: boolean;
  totalErrors: number;
  totalFiles: number;
  message: string;
}

// ============================================================
// 辅助
// ============================================================

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
