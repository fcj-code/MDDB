/**
 * 写入模块类型定义
 *
 * 参考：v2 roadmap Milestone 2
 */

import type { SyncState } from '../core/types';

// ============================================================
// 序列化
// ============================================================

/**
 * 已序列化的数据行
 *
 * 包含转换后的 Markdown 行和元数据。
 */
export interface SerializedRow {
  /** 序列化后的完整行（含换行符） */
  line: string;
  /** 字段值数组（序列化后） */
  values: string[];
  /** 行原始哈希（用于冲突检测） */
  rawLineHash: string;
}

// ============================================================
// 文件操作接口
// ============================================================

/**
 * 文件操作抽象层
 *
 * 将 Obsidian vault 操作抽象为接口，便于测试。
 * 实际使用时由 Obsidian 插件层提供实现。
 */
export interface FileOperator {
  /**
   * 读取文件全部内容
   */
  readFile(filePath: string): Promise<string>;

  /**
   * 写入文件全部内容
   */
  writeFile(filePath: string, content: string): Promise<void>;

  /**
   * 原子性地替换文件内容
   *
   * Obsidian 中对应 app.vault.process()。
   */
  processFile(filePath: string, updater: (content: string) => string): Promise<string>;
}

// ============================================================
// 写入计划
// ============================================================

/**
 * 写入操作类型（MVP 不含跨文件事务）
 */
export type WriteOpType = 'insert' | 'replace' | 'delete';

/** 单条写入操作 */
export interface WriteOp {
  id: string;
  type: WriteOpType;
  tableName: string;

  /** 目标文件路径 */
  filePath: string;
  /** 目标块在文件中的行范围（用于定位追加位置） */
  blockStartLine: number;
  blockEndLine: number;

  /** INSERT：追加的内容行 */
  contentLine?: string;
  /** INSERT：序列化的字段值 */
  values?: unknown[];

  /** UPDATE/DELETE：目标行号 */
  lineNumber?: number;
  /** UPDATE/DELETE：写前预期行哈希 */
  beforeHash?: string;
  /** UPDATE：替换后的行内容 */
  afterContent?: string;

  /** UPDATE：部分更新的字段 */
  patch?: Record<string, unknown>;

  /** 生成的 storagePk（UPDATE/DELETE 从 binding 获取） */
  storagePk?: string;
}

/** 写入计划 */
export interface WritePlan {
  txId: string;
  operations: WriteOp[];
  allFiles: string[];
}

// ============================================================
// 写入结果
// ============================================================

/** 写入操作结果 */
export interface WriteOpResult {
  opId: string;
  success: boolean;
  storagePk?: string;
  lineNumber?: number;
  error?: string;
}

/** 完整写入执行结果 */
export interface WriteResult {
  success: boolean;
  txId: string;
  results: WriteOpResult[];
  syncState: SyncState;
}

// ============================================================
// 执行上下文
// ============================================================

/**
 * CRUDExecutor 上下文
 *
 * 包含执行写入所需的所有依赖。
 */
export interface ExecutorContext {
  /** 文件操作实现 */
  fileOperator: FileOperator;

  /** 获取目标块的起始/结束行号 */
  getBlockRange: (filePath: string, tableName: string) => { startLine: number; endLine: number } | null;

  /** 查询 schema */
  getSchema: (tableName: string) => import('../core/types').SchemaSummary | null;

  /** 查询 binding */
  getBinding: (storagePk: string) => import('../core/types').BindingRow | null;
}
