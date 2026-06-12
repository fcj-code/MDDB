/**
 * 写入计划构造器 (WritePlanBuilder)
 *
 * 根据 insert/update/delete 请求构造 WritePlan，包含序列化的行内容。
 *
 * MVP 单文件写入暂不生成持久化 WAL，但计划结构设计为 WAL-ready：
 * - 每个操作独立可重放
 * - 包含写前 hash 校验信息
 * - 可扩展为 WAL 持久化格式
 *
 * 参考：v2 roadmap Milestone 2
 */

import type { SchemaSummary, BindingRow, RecordInput, RecordPatch } from '../core/types';
import type { WritePlan, WriteOp } from './types';
import { serializeRow, recordInputToValues, simpleHash } from './serializer';

// ============================================================
// TX ID 生成
// ============================================================

let txCounter = 0;

/**
 * 生成唯一事务 ID
 */
export function generateTxId(): string {
  txCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `tx_${ts}_${rand}_${txCounter}`;
}

// ============================================================
// 计划构造器
// ============================================================

/**
 * 构造 INSERT 写入计划
 *
 * @param tableName      表名
 * @param record         键值对记录
 * @param schema         表 Schema
 * @param binding        binding 信息（INSERT 时无旧 binding）
 * @param blockStartLine 目标 mddb 块起始行（围栏行，1-based）
 * @param blockEndLine   目标 mddb 块闭合围栏行（1-based）
 * @param filePath       目标文件路径
 * @param options        可选参数
 * @returns 写入计划
 */
export function buildInsertPlan(
  tableName: string,
  record: RecordInput,
  schema: SchemaSummary,
  binding: BindingRow | null,
  blockStartLine: number,
  blockEndLine: number,
  filePath: string,
  options?: {
    /** 自定义 storagePk */
    storagePk?: string;
    /** 自定义逻辑 PK */
    logicalPk?: string;
  },
): WritePlan {
  const txId = generateTxId();

  // 按 Schema 字段顺序排列值
  const fieldValues = recordInputToValues(record, schema);

  // 序列化为行
  const serialized = serializeRow(fieldValues, schema);

  // 计算 storagePk
  const logicalPk = options?.logicalPk ?? computeLogicalPkFromValues(fieldValues, schema);
  const storagePk = options?.storagePk ?? generateStoragePk(filePath, serialized.line, logicalPk, tableName);

  const op: WriteOp = {
    id: `${txId}_insert_0`,
    type: 'insert',
    tableName,
    filePath,
    blockStartLine,
    blockEndLine,
    contentLine: serialized.line,
    values: fieldValues,
    storagePk,
  };

  return {
    txId,
    operations: [op],
    allFiles: [filePath],
  };
}

/**
 * 构造 UPDATE 写入计划
 *
 * @param tableName  表名
 * @param storagePk  记录标识
 * @param patch      部分更新的字段
 * @param schema     表 Schema
 * @param binding    当前 binding 记录（含 lineNumber、rowHash）
 * @param filePath   文件路径
 * @returns 写入计划
 */
export function buildUpdatePlan(
  tableName: string,
  storagePk: string,
  patch: RecordPatch,
  schema: SchemaSummary,
  binding: BindingRow,
  filePath: string,
): WritePlan {
  const txId = generateTxId();

  // 序列化更新后的行
  // UPDATE 需要知道哪些字段被更新，此处生产 oldValues + patch → newValues
  // 但由于我们不知道 oldValues（需要从 SQLite 读取），序列化阶段只生成补丁信息
  // 实际替换行内容在 CRUDExecutor 中完成

  const op: WriteOp = {
    id: `${txId}_update_0`,
    type: 'replace',
    tableName,
    filePath,
    blockStartLine: 0,
    blockEndLine: 0,
    lineNumber: binding.lineNumber,
    beforeHash: binding.rowHash,
    patch: patch as Record<string, unknown>,
    storagePk,
  };

  return {
    txId,
    operations: [op],
    allFiles: [filePath],
  };
}

/**
 * 构造 DELETE 写入计划
 *
 * @param tableName  表名
 * @param storagePk  记录标识
 * @param binding    当前 binding 记录（含 lineNumber、rowHash）
 * @param filePath   文件路径
 * @returns 写入计划
 */
export function buildDeletePlan(
  tableName: string,
  storagePk: string,
  binding: BindingRow,
  filePath: string,
): WritePlan {
  const txId = generateTxId();

  const op: WriteOp = {
    id: `${txId}_delete_0`,
    type: 'delete',
    tableName,
    filePath,
    blockStartLine: 0,
    blockEndLine: 0,
    lineNumber: binding.lineNumber,
    beforeHash: binding.rowHash,
    storagePk,
  };

  return {
    txId,
    operations: [op],
    allFiles: [filePath],
  };
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 从字段值计算逻辑 PK
 */
function computeLogicalPkFromValues(values: unknown[], schema: SchemaSummary): string {
  const { pk, fields } = schema;
  if (pk.includes('$uuid')) return '';

  const parts = pk.map(pkField => {
    const idx = fields.indexOf(pkField);
    if (idx < 0) return '';
    const v = values[idx];
    return v === null || v === undefined ? '' : String(v);
  });

  return parts.filter(p => p.length > 0).join('\x1F');
}

/**
 * 生成 storagePk（不含 lineNumber）
 *
 * 与 storage/index-writer.ts 中的 generateStoragePk 保持一致的算法。
 */
export function generateStoragePk(
  filePath: string,
  line: string,
  logicalPk: string,
  tableName: string,
): string {
  if (logicalPk) {
    const h = simpleHash(tableName + ':' + logicalPk);
    return `${h}`;
  }
  const h = simpleHash(line);
  return `${h}`;
}
