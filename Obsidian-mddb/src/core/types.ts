/**
 * MD-DB 核心类型
 *
 * 本文件定义所有模块共用的基础类型。
 * 模块专用类型放在各模块的 types.ts 中。
 */

import type { ResultOrError } from './result';

// ============================================================
// Schema 相关
// ============================================================

/** 字段类型，存储完整类型表达式，如 "decimal(2)"、"enum(支出,收入)"、"ref(categories)" */
export type FieldType = string;

/** 列元数据 */
export interface ColumnMeta {
  name: string;
  type: FieldType;
}

/** 排序子句 */
export interface SortClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

/** 索引定义 */
export interface IndexDef {
  name: string;
  fields: string[];
}

/** 关系/外键定义 */
export interface RelationDef {
  field: string;
  targetTable: string;
  targetField: string;
}

/** Schema 概要 — 与 SchemaRegistry 共享 */
export interface SchemaSummary {
  table: string;
  pk: string[];
  fields: string[];
  types: FieldType[];
  required: boolean[];
  sort?: string;
  indexes?: string[];
  relations?: string[];
  nullMarker: string;
  strict: boolean;
}

// ============================================================
// 记录类型
// ============================================================

/** 一条解析后的记录（字段值数组） */
export interface ParsedRecord {
  values: unknown[];
  rawLine: string;
  lineNumber: number;
  tableName: string;
}

/** 记录输入（写入时使用） */
export interface RecordInput {
  [field: string]: unknown;
}

/** 记录更新（部分更新） */
export interface RecordPatch {
  [field: string]: unknown;
}

// ============================================================
// 绑定表
// ============================================================

/** 绑定行 — v2 身份模型 */
export interface BindingRow {
  storagePk: string;
  logicalPk: string;
  tableName: string;

  filePath: string;
  blockId: string;
  blockIndex: number;
  lineNumber: number;

  rowHash: string;
  rawLineHash: string;
  lastVerified: string;

  syncState: SyncState;
}

export type SyncState = 'synced' | 'pending' | 'retrying' | 'dead';

// ============================================================
// 引擎事件
// ============================================================

export type EngineEventType =
  | 'data-changed'
  | 'state-changed'
  | 'error'
  | 'wal-created'
  | 'wal-updated'
  | 'wal-dead'
  | 'rescan-started'
  | 'rescan-completed';

export interface DataChangedEvent {
  type: 'insert' | 'update' | 'delete';
  table: string;
  storagePk: string;
}

export interface StateChangedEvent {
  previous: EngineStatus;
  current: EngineStatus;
}

export interface ErrorEvent {
  code: string;
  message: string;
  table?: string;
  file?: string;
  cause?: unknown;
}

export interface WalEvent {
  txId: string;
  status: string;
  fileCount: number;
  retryCount?: number;
}

export interface RescanCompletedEvent {
  fileCount: number;
  errorCount: number;
  durationMs: number;
}

export type EngineEventHandler = {
  'data-changed': (event: DataChangedEvent) => void;
  'state-changed': (event: StateChangedEvent) => void;
  'error': (event: ErrorEvent) => void;
  'wal-created': (event: WalEvent) => void;
  'wal-updated': (event: WalEvent) => void;
  'wal-dead': (event: WalEvent) => void;
  'rescan-started': () => void;
  'rescan-completed': (event: RescanCompletedEvent) => void;
};

export type EngineStatus =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'rebuilding'
  | 'error';

export interface Disposable {
  dispose(): void;
}

// ============================================================
// Schema 注册表（与 schema_registry.json 结构一致）
// ============================================================

export interface SchemaRegistry {
  version: number;
  tables: Record<string, TableRegistryEntry>;
}

export interface TableRegistryEntry {
  table: string;
  schema: SchemaSummary;
  sources: TableSource[];
  rowCount: number;
  updatedAt: string;
}

export interface TableSource {
  file: string;
  blockId: string;
  blockIndex: number;
  rowCount: number;
  partition?: Record<string, string>;
  /** 是否为此表的写入目标（INSERT 路由用） */
  writeTarget?: boolean;
}

// ============================================================
// 写入操作
// ============================================================

export interface WriteOptions {
  /** 乐观 UI 模式（先更新 UI，后台写文件） */
  optimistic?: boolean;
}

export interface WriteResult {
  storagePk: string;
  table: string;
  syncState: SyncState;
  lineNumber?: number;
  /** 操作涉及的文件路径 */
  filePath?: string;
}

export interface WritePlan {
  txId: string;
  operations: WritePlanOperation[];
}

export type WritePlanOperation =
  | { type: 'insert'; file: string; blockId?: string; content: string }
  | { type: 'replace'; file: string; lineNumber: number; beforeHash: string; afterContent: string }
  | { type: 'delete'; file: string; lineNumber: number; beforeHash: string };
