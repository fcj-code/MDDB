/**
 * WAL v2 类型定义
 *
 * 参考：v2 roadmap §7 WAL v2 协议
 *
 * 核心设计：
 * - WalEntry 包含完整的事务上下文和可重放操作列表
 * - 每个 operation 有独立 ID，支持幂等重放
 * - progress.completedOperationIds 记录已完成的操作
 * - 重放引擎从第一个未完成的 operation 继续
 */

// ============================================================
// WAL 条目状态
// ============================================================

export type WalStatus = 'pending' | 'retrying' | 'dead' | 'done';

// ============================================================
// 进度与重试信息
// ============================================================

export interface WalProgress {
  completedOperationIds: string[];
}

export interface WalRetryInfo {
  count: number;
  maxRetries: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}

// ============================================================
// WAL 操作
// ============================================================

export type WalOperation =
  | InsertLineOperation
  | ReplaceLineOperation
  | DeleteLineOperation;

export interface InsertLineOperation {
  id: string;
  type: 'insertLine';
  file: string;
  blockId?: string;
  afterLine?: number;
  content: string;
  expectedFileHash?: string;
}

export interface ReplaceLineOperation {
  id: string;
  type: 'replaceLine';
  file: string;
  lineNumber: number;
  beforeHash: string;
  beforeContent?: string;
  afterContent: string;
}

export interface DeleteLineOperation {
  id: string;
  type: 'deleteLine';
  file: string;
  lineNumber: number;
  beforeHash: string;
  beforeContent: string;
}

// ============================================================
// WAL 条目
// ============================================================

export interface WalEntry {
  txId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  status: WalStatus;
  operations: WalOperation[];
  progress: WalProgress;
  retry: WalRetryInfo;
}

// ============================================================
// 重放结果
// ============================================================

export interface ReplayOperationResult {
  opId: string;
  success: boolean;
  skipped: boolean; // true if already completed (idempotent)
  error?: string;
}

export interface ReplayResult {
  txId: string;
  success: boolean;
  operationResults: ReplayOperationResult[];
  completedCount: number;
  totalCount: number;
}

// ============================================================
// WAL 存储管理
// ============================================================

export interface WalStore {
  /** 持久化存储目录 */
  readonly walDir: string;

  /** 加载所有 WAL 条目 */
  loadAll(): Promise<WalEntry[]>;

  /** 保存单个 WAL 条目 */
  save(entry: WalEntry): Promise<void>;

  /** 删除单个 WAL 条目 */
  delete(txId: string): Promise<void>;

  /** 列出所有 WAL 文件 */
  list(): Promise<string[]>;
}

// ============================================================
// 辅助函数
// ============================================================

/** 默认最大重试次数 */
export const DEFAULT_MAX_RETRIES = 5;

/** WAL 版本号 */
export const WAL_VERSION = 2;

/** 创建新 WalEntry */
export function createWalEntry(
  txId: string,
  operations: WalOperation[],
  maxRetries: number = DEFAULT_MAX_RETRIES,
): WalEntry {
  const now = new Date().toISOString();
  return {
    txId,
    version: WAL_VERSION,
    createdAt: now,
    updatedAt: now,
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
}

/** 判断 WAL 是否可重放 */
export function isReplayable(entry: WalEntry): boolean {
  return entry.status === 'pending' || entry.status === 'retrying';
}

/** 判断 WAL 所有操作是否已完成 */
export function isFullyCompleted(entry: WalEntry): boolean {
  return entry.progress.completedOperationIds.length === entry.operations.length;
}

/** 获取下一个待执行的操作索引 */
export function getNextOperationIndex(entry: WalEntry): number {
  const completed = new Set(entry.progress.completedOperationIds);
  for (let i = 0; i < entry.operations.length; i++) {
    if (!completed.has(entry.operations[i]!.id)) {
      return i;
    }
  }
  return entry.operations.length; // all done
}

/** 计算退避延迟（毫秒） */
export function computeRetryDelay(retryCount: number): number {
  // 指数退避：2^count * 1000ms, 上限 60s
  const delay = Math.min(Math.pow(2, retryCount) * 1000, 60_000);
  // 添加 ±20% 随机抖动
  const jitter = delay * 0.2 * (Math.random() - 0.5);
  return Math.round(delay + jitter);
}
