/**
 * MD-DB 引擎诊断
 *
 * 提供引擎状态快照和系统健康信息。
 *
 * Milestone 4 新增：
 * - pendingWalCount / deadWalCount 实时查询
 * - lastError 增强
 * - 诊断命令支持
 *
 * 参考：runtime-architecture.md §3.9, v2 roadmap Milestone 4
 */

import type { EngineStatus } from '../core/types';

export interface EngineDiagnostics {
  engineStatus: EngineStatus;
  tableCount: number;
  rowCount: number;
  pendingWalCount: number;
  deadWalCount: number;
  lastFullScanAt: string | null;
  lastError: DiagnosticError | null;
  cacheSizeBytes: number;
  sqliteMemoryBytes?: number;
  /** 引擎启动时间 */
  uptimeMs?: number;
  /** 启动时间戳 */
  startedAt?: string;
  /** 最近 WAL 错误数 */
  recentErrorCount: number;
}

export interface DiagnosticError {
  code: string;
  message: string;
  at: string;
  table?: string;
  file?: string;
}

// ============================================================
// 诊断命令
// ============================================================

export type DiagnosticCommand =
  | 'rebuild-cache'
  | 'retry-dead-wal'
  | 'discard-dead-wal'
  | 'show-diagnostics'
  | 'export-diagnostics'
  | 'clear-logs';

export interface DiagnosticCommandResult {
  command: DiagnosticCommand;
  success: boolean;
  message: string;
  timestamp: string;
}

// ============================================================
// 诊断管理器
// ============================================================

export class DiagnosticsManager {
  private status: EngineStatus = 'starting';
  private lastFullScanAt: string | null = null;
  private lastError: DiagnosticError | null = null;
  private errorsLog: DiagnosticError[] = [];
  private startedAt: string;

  constructor() {
    this.startedAt = new Date().toISOString();
  }

  /** 引擎启动时间 */
  getStartTime(): string {
    return this.startedAt;
  }

  /** 运行时长（毫秒） */
  getUptimeMs(): number {
    return Date.now() - new Date(this.startedAt).getTime();
  }

  setStatus(status: EngineStatus): void {
    this.status = status;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  setLastFullScanAt(time: string): void {
    this.lastFullScanAt = time;
  }

  recordError(code: string, message: string, table?: string, file?: string): void {
    const error: DiagnosticError = {
      code,
      message,
      at: new Date().toISOString(),
      table,
      file,
    };
    this.lastError = error;
    this.errorsLog.push(error);

    // 保留最近 100 条
    if (this.errorsLog.length > 100) {
      this.errorsLog.shift();
    }
  }

  getRecentErrors(limit = 10): DiagnosticError[] {
    return this.errorsLog.slice(-limit);
  }

  getRecentErrorCount(): number {
    return this.errorsLog.length;
  }

  getDiagnostics(
    tableCount: number,
    rowCount: number,
    pendingWalCount: number,
    deadWalCount: number,
    cacheSizeBytes: number,
    sqliteMemoryBytes?: number,
  ): EngineDiagnostics {
    return {
      engineStatus: this.status,
      tableCount,
      rowCount,
      pendingWalCount,
      deadWalCount,
      lastFullScanAt: this.lastFullScanAt,
      lastError: this.lastError,
      cacheSizeBytes,
      sqliteMemoryBytes,
      uptimeMs: this.getUptimeMs(),
      startedAt: this.startedAt,
      recentErrorCount: this.errorsLog.length,
    };
  }
}
