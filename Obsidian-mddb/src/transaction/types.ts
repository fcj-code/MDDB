/**
 * 事务模块类型定义
 *
 * Milestone 5 新增：
 * - Transaction 接口：显式事务 CRUD API
 * - TransactionManager：事务生命周期管理
 *
 * 参考：v2 roadmap §Milestone 5
 */

import type { RecordInput, RecordPatch, WriteResult } from '../core/types';

// ============================================================
// 事务操作
// ============================================================

export interface UpdatePair {
  storagePk: string;
  patch: RecordPatch;
}

// ============================================================
// Transaction 接口
// ============================================================

/**
 * 事务上下文 —— 在 transaction(cb) 的回调中暴露给用户。
 *
 * 所有操作共享同一个 txId、WAL 条目和 SQLite savepoint。
 * throw 将触发全部回滚（SQLite ROLLBACK, WAL 保留 pending）。
 */
export interface Transaction {
  /** 事务唯一标识 */
  readonly txId: string;

  /** 插入单条记录 */
  insert(table: string, record: RecordInput): Promise<WriteResult>;

  /** 更新单条记录 */
  update(storagePk: string, patch: RecordPatch): Promise<WriteResult>;

  /** 删除单条记录 */
  delete(storagePk: string): Promise<WriteResult>;

  /** 批量插入 */
  insertAll(table: string, records: RecordInput[]): Promise<WriteResult[]>;

  /** 批量更新 */
  updateAll(pairs: UpdatePair[]): Promise<WriteResult[]>;

  /** 批量删除 */
  deleteAll(storagePks: string[]): Promise<WriteResult[]>;

  /** 事务是否仍然活跃 */
  isActive(): boolean;
}

// ============================================================
// 事务执行上下文（内部使用）
// ============================================================

/**
 * 事务执行上下文，由 TransactionManager 创建，
 * 在事务生命周期内传递给各个组件。
 */
export interface TransactionContext {
  txId: string;
  savepointName: string;
  /** 事务收集到的文件路径集合 */
  files: Set<string>;
  /** 事务是否已终止（rollback 或 commit 后） */
  terminated: boolean;
}

// ============================================================
// 事务模式
// ============================================================

export type TransactionMode = 'explicit' | 'autocommit';
