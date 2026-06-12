/**
 * WAL 重放引擎
 *
 * 负责将 WalEntry.operations 按序重放到 Markdown 文件。
 *
 * 重放幂等规则（v2 roadmap §7.2）：
 * 1. 如果 operation.id 已在 completedOperationIds 中，跳过。
 * 2. 执行前检查目标内容。
 * 3. 如果目标内容已经等于 afterContent，视为幂等成功。
 * 4. 如果目标内容等于 beforeContent 或 beforeHash 匹配，执行操作。
 * 5. 如果目标内容既不是 before，也不是 after，进入 conflict/dead。
 * 6. 每完成一个 operation，立即持久化 progress。
 * 7. 全部 operation 完成后，status = done，然后删除 WAL 或延迟清理。
 */

import type { FileOperator } from '../write/types';
import type {
  WalEntry,
  WalOperation,
  ReplayResult,
  ReplayOperationResult,
  InsertLineOperation,
  ReplaceLineOperation,
  DeleteLineOperation,
} from './types';
import { isFullyCompleted } from './types';
import { simpleHash } from '../write/serializer';
import { EngineError, ConflictError } from '../core/errors';

// ============================================================
// 行操作辅助
// ============================================================

/**
 * 在文件内容中查找指定行
 */
function getLine(content: string, lineNumber: number): string | null {
  const lines = content.split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) return null;
  return lines[lineNumber - 1]!;
}

/**
 * 替换指定行
 */
function replaceLineInContent(content: string, lineNumber: number, newLine: string): string {
  const lines = content.split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) return content;
  lines[lineNumber - 1] = newLine;
  return lines.join('\n');
}

/**
 * 删除指定行
 */
function deleteLineInContent(content: string, lineNumber: number): string {
  const lines = content.split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) return content;
  lines.splice(lineNumber - 1, 1);
  return lines.join('\n');
}

/**
 * 在 block 闭合围栏前追加内容
 */
function appendToBlockEnd(content: string, endLine: number, newContent: string): string {
  const lines = content.split('\n');
  const insertAt = Math.min(endLine - 1, lines.length);
  lines.splice(insertAt, 0, newContent);
  return lines.join('\n');
}

// ============================================================
// 内容检查
// ============================================================

function contentHash(content: string): string {
  return simpleHash(content);
}

/**
 * 检查目标行的状态（用于幂等判断）
 *
 * 返回值：
 * - 'match-before': 内容匹配 before（可以执行操作）
 * - 'match-after': 内容已匹配 after（幂等，跳过）
 * - 'conflict': 都不匹配（冲突）
 */
function checkLineState(
  currentContent: string,
  op: ReplaceLineOperation | DeleteLineOperation,
): 'match-before' | 'match-after' | 'conflict' {
  const line = getLine(currentContent, op.lineNumber);
  if (line === null) return 'conflict';

  const lineHash = simpleHash(line);

  // 检查是否匹配 beforeHash
  if (lineHash === op.beforeHash) return 'match-before';

  // 如果提供了 beforeContent，检查原始内容
  if (op.beforeContent !== undefined && line === op.beforeContent) {
    return 'match-before';
  }

  // ReplaceLineOperation：检查目标内容是否已经是 afterContent
  if (op.type === 'replaceLine' && line === op.afterContent) {
    return 'match-after';
  }

  // DeleteLineOperation：检查行内容是否匹配 beforeContent
  if (op.type === 'deleteLine' && line === op.beforeContent) {
    return 'match-before';
  }

  return 'conflict';
}

// ============================================================
// 单操作执行
// ============================================================

export type ExecuteOpResult =
  | { status: 'success' }
  | { status: 'skipped' }
  | { status: 'conflict'; error: string }
  | { status: 'error'; error: string };

/**
 * 执行单个 WAL 操作
 */
async function executeOperation(
  op: WalOperation,
  fileOperator: FileOperator,
): Promise<ExecuteOpResult> {
  try {
    switch (op.type) {
      case 'insertLine':
        return await executeInsertLine(op, fileOperator);
      case 'replaceLine':
        return await executeReplaceLine(op, fileOperator);
      case 'deleteLine':
        return await executeDeleteLine(op, fileOperator);
    }
  } catch (e) {
    return {
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function executeInsertLine(
  op: InsertLineOperation,
  fileOperator: FileOperator,
): Promise<ExecuteOpResult> {
  const content = await fileOperator.readFile(op.file);

  // 如果提供了 expectedFileHash，检查文件哈希
  if (op.expectedFileHash) {
    const currentHash = contentHash(content);
    if (currentHash !== op.expectedFileHash) {
      return {
        status: 'conflict',
        error: `File hash mismatch for "${op.file}": expected ${op.expectedFileHash}, got ${currentHash}`,
      };
    }
  }

  // 找到 mddb 块的闭合围栏
  // 简化处理：如果 afterLine 已指定，直接在其后追加
  const targetLine = op.afterLine ?? content.split('\n').length;
  const newContent = appendToBlockEnd(content, targetLine, op.content);

  await fileOperator.writeFile(op.file, newContent);
  return { status: 'success' };
}

async function executeReplaceLine(
  op: ReplaceLineOperation,
  fileOperator: FileOperator,
): Promise<ExecuteOpResult> {
  const content = await fileOperator.readFile(op.file);
  const state = checkLineState(content, op);

  switch (state) {
    case 'match-before': {
      const newContent = replaceLineInContent(content, op.lineNumber, op.afterContent);
      await fileOperator.writeFile(op.file, newContent);
      return { status: 'success' };
    }
    case 'match-after':
      return { status: 'skipped' };
    case 'conflict':
      return {
        status: 'conflict',
        error: `Line ${op.lineNumber} in "${op.file}" does not match expected state (beforeHash: ${op.beforeHash})`,
      };
  }
}

async function executeDeleteLine(
  op: DeleteLineOperation,
  fileOperator: FileOperator,
): Promise<ExecuteOpResult> {
  const content = await fileOperator.readFile(op.file);
  const state = checkLineState(content, op);

  switch (state) {
    case 'match-before': {
      const newContent = deleteLineInContent(content, op.lineNumber);
      await fileOperator.writeFile(op.file, newContent);
      return { status: 'success' };
    }
    case 'match-after':
      // delete 的 after 状态是行已不存在
      return { status: 'skipped' };
    case 'conflict':
      return {
        status: 'conflict',
        error: `Line ${op.lineNumber} in "${op.file}" does not match expected state for delete`,
      };
  }
}

// ============================================================
// 完整重放
// ============================================================

/**
 * 重放 WAL 条目
 *
 * 按照幂等规则执行所有操作。
 * 调用方负责在每次操作后更新 WalManager 的 progress。
 */
export async function replayWal(
  entry: WalEntry,
  fileOperator: FileOperator,
  onOperationComplete?: (opId: string, result: ReplayOperationResult) => Promise<void>,
): Promise<ReplayResult> {
  const completed = new Set(entry.progress.completedOperationIds);
  const operationResults: ReplayOperationResult[] = [];
  let allSuccess = true;

  for (let i = 0; i < entry.operations.length; i++) {
    const op = entry.operations[i]!;

    // 幂等检查：跳过已完成的
    if (completed.has(op.id)) {
      operationResults.push({
        opId: op.id,
        success: true,
        skipped: true,
      });
      continue;
    }

    // 执行操作
    const result = await executeOperation(op, fileOperator);

    switch (result.status) {
      case 'success': {
        const opResult: ReplayOperationResult = {
          opId: op.id,
          success: true,
          skipped: false,
        };
        operationResults.push(opResult);
        if (onOperationComplete) {
          await onOperationComplete(op.id, opResult);
        }
        break;
      }
      case 'skipped': {
        const opResult: ReplayOperationResult = {
          opId: op.id,
          success: true,
          skipped: true,
        };
        operationResults.push(opResult);
        if (onOperationComplete) {
          await onOperationComplete(op.id, opResult);
        }
        break;
      }
      case 'conflict': {
        allSuccess = false;
        operationResults.push({
          opId: op.id,
          success: false,
          skipped: false,
          error: result.error,
        });
        break;
      }
      case 'error': {
        allSuccess = false;
        operationResults.push({
          opId: op.id,
          success: false,
          skipped: false,
          error: result.error,
        });
        break;
      }
    }
  }

  const completedCount = operationResults.filter(r => r.success).length;

  return {
    txId: entry.txId,
    success: allSuccess,
    operationResults,
    completedCount,
    totalCount: entry.operations.length,
  };
}

/**
 * 冷启动时重放所有可重放 WAL
 *
 * 返回每个 WAL 的重放结果列表。
 */
export async function replayAllWals(
  entries: WalEntry[],
  fileOperator: FileOperator,
  onWalComplete?: (result: ReplayResult) => Promise<void>,
): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];

  for (const entry of entries) {
    const result = await replayWal(entry, fileOperator);
    results.push(result);
    if (onWalComplete) {
      await onWalComplete(result);
    }

    // 如果某个 WAL 出现冲突，继续处理下一个
  }

  return results;
}
