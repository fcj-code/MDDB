/**
 * 冲突检测器 (ConflictDetector)
 *
 * 写前校验目标行的 hash，检测外部修改或行号漂移。
 *
 * 参考：v2 roadmap Milestone 2
 */

import { ConflictError } from '../core/errors';
import { simpleHash } from './serializer';
import type { FileOperator } from './types';

// ============================================================
// 冲突检测结果
// ============================================================

export interface ConflictCheckResult {
  /** 是否通过检测 */
  ok: boolean;
  /** 行当前内容 */
  currentLine: string;
  /** 行当前 hash */
  currentHash: string;
  /** 预期 hash */
  expectedHash: string;
}

// ============================================================
// 冲突检测
// ============================================================

/**
 * 检测目标行的 hash 是否与预期一致
 *
 * @param fileContent  文件完整内容
 * @param lineNumber   目标行号（1-based）
 * @param expectedHash 预期的行 hash
 * @returns 检测结果
 */
export function checkLineHash(
  fileContent: string,
  lineNumber: number,
  expectedHash: string,
): ConflictCheckResult {
  const lines = fileContent.split('\n');

  if (lineNumber < 1 || lineNumber > lines.length) {
    return {
      ok: false,
      currentLine: '',
      currentHash: '',
      expectedHash,
    };
  }

  const currentLine = lines[lineNumber - 1] ?? '';
  const currentHash = simpleHash(currentLine);

  return {
    ok: currentHash === expectedHash,
    currentLine,
    currentHash,
    expectedHash,
  };
}

/**
 * 验证目标行的 hash，不一致时抛出 ConflictError
 *
 * @param fileContent  文件完整内容
 * @param lineNumber   目标行号（1-based）
 * @param expectedHash 预期 hash
 * @param filePath     文件路径（用于错误报告）
 * @param tableName    表名（用于错误报告）
 * @throws ConflictError 如果 hash 不匹配
 */
export function assertLineHash(
  fileContent: string,
  lineNumber: number,
  expectedHash: string,
  filePath: string,
  tableName: string,
): void {
  const result = checkLineHash(fileContent, lineNumber, expectedHash);

  if (!result.ok) {
    throw new ConflictError(
      `Hash conflict at ${filePath}:${lineNumber}. ` +
      `Expected ${expectedHash}, got ${result.currentHash}. ` +
      'The file has been modified externally.',
      [filePath],
      tableName,
    );
  }
}

/**
 * 从当前行计算 hash（用于 INSERT 后校验）
 */
export function hashLine(line: string): string {
  return simpleHash(line);
}

/**
 * 逐行检测文件内容中多个位置的 hash
 *
 * @param fileContent  文件完整内容
 * @param checks       需要检测的 { lineNumber, expectedHash } 列表
 * @returns 所有失败的检测项
 */
export function checkMultipleHashes(
  fileContent: string,
  checks: Array<{ lineNumber: number; expectedHash: string }>,
): Array<{ lineNumber: number; expectedHash: string; currentHash: string }> {
  const failures: Array<{ lineNumber: number; expectedHash: string; currentHash: string }> = [];

  for (const { lineNumber, expectedHash } of checks) {
    const result = checkLineHash(fileContent, lineNumber, expectedHash);
    if (!result.ok) {
      failures.push({
        lineNumber,
        expectedHash,
        currentHash: result.currentHash,
      });
    }
  }

  return failures;
}
