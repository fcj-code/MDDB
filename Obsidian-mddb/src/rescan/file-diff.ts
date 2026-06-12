/**
 * 文件差异检测器 (FileDiff)
 *
 * 基于行哈希的快速文件差异分析。
 *
 * 参考：v2 roadmap §3（Diff 策略）
 *
 * 策略：
 * 1. 保存每个数据文件的 lineHashes
 * 2. modify 时重新计算 lineHashes
 * 3. 前后缀快速匹配检测插入/删除
 * 4. 变更比例 ≤20% 尝试增量
 * 5. >20% 或 diff 不可靠时整文件重建
 */

import { simpleHash } from '../write/serializer';

// ============================================================
// 类型定义
// ============================================================

export interface LineHashEntry {
  /** 行号（1-based） */
  lineNumber: number;
  /** 行内容哈希 */
  hash: string;
  /** 行内容（可选，用于详细 diff） */
  content?: string;
}

export interface DiffResult {
  /** 是否有变更 */
  hasChanges: boolean;
  /** 新增的行 */
  added: Array<{ index: number; hash: string }>;
  /** 删除的行 */
  removed: Array<{ index: number; hash: string }>;
  /** 内容变更的行（hash 不同） */
  changed: Array<{ index: number; oldHash: string; newHash: string }>;
  /** 稳定的行（前后缀快速匹配） */
  stable: Array<{ index: number; hash: string }>;
  /** 变更比例 (0-1) */
  changeRatio: number;
  /** 总行数 */
  totalLines: number;
  /** 是否建议整文件重建 */
  suggestFullRebuild: boolean;
}

// ============================================================
// 核心逻辑
// ============================================================

/**
 * 计算文件内容的行哈希列表
 */
export function computeLineHashes(content: string): LineHashEntry[] {
  const lines = content.split('\n');
  return lines.map((line, index) => ({
    lineNumber: index + 1,
    hash: simpleHash(line),
    content: line,
  }));
}

/**
 * 快速比较两个行哈希列表，生成差异结果
 */
export function diffLines(
  oldHashes: LineHashEntry[],
  newHashes: LineHashEntry[],
  threshold: number = 0.2,
): DiffResult {
  const oldMap = new Map<string, number[]>();
  for (const entry of oldHashes) {
    const list = oldMap.get(entry.hash) ?? [];
    list.push(entry.lineNumber);
    oldMap.set(entry.hash, list);
  }

  const added: Array<{ index: number; hash: string }> = [];
  const stable: Array<{ index: number; hash: string }> = [];
  const changed: Array<{ index: number; oldHash: string; newHash: string }> = [];
  const matched = new Set<number>();

  // 第一遍：完全匹配（hash 相同）
  for (let i = 0; i < newHashes.length; i++) {
    const entry = newHashes[i]!;
    const possibleOld = oldMap.get(entry.hash);

    if (possibleOld && possibleOld.length > 0) {
      // 找到匹配的旧行
      const oldLine = possibleOld.shift()!;
      matched.add(oldLine);
      stable.push({ index: i + 1, hash: entry.hash });
    } else {
      // 新行或变更行，先标记为 added
      added.push({ index: i + 1, hash: entry.hash });
    }
  }

  // 找出未匹配的旧行（removed）
  const removed: Array<{ index: number; hash: string }> = [];
  for (const entry of oldHashes) {
    if (!matched.has(entry.lineNumber)) {
      removed.push({ index: entry.lineNumber, hash: entry.hash });
    }
  }

  // 判断变更类型：如果 added 和 removed 数量接近，可能是变更
  // 简单判断：从 added 和 removed 中配对出 changed
  const changeCount = Math.max(added.length, removed.length);
  const totalLines = Math.max(oldHashes.length, newHashes.length);
  const changeRatio = totalLines > 0 ? changeCount / totalLines : 0;

  // 配对 added/removed 生成 changed
  const pairedCount = Math.min(added.length, removed.length);
  for (let i = 0; i < pairedCount; i++) {
    const a = added[i]!;
    const r = removed[i]!;
    changed.push({
      index: a.index,
      oldHash: r.hash,
      newHash: a.hash,
    });
  }

  // 剩余的 added 和 removed
  const remainingAdded = added.slice(pairedCount);
  const remainingRemoved = removed.slice(pairedCount);

  return {
    hasChanges: changeCount > 0,
    added: remainingAdded,
    removed: remainingRemoved,
    changed,
    stable,
    changeRatio,
    totalLines,
    suggestFullRebuild: changeRatio > threshold,
  };
}

/**
 * 从旧内容和新内容直接计算差异
 */
export function diffContent(
  oldContent: string,
  newContent: string,
  threshold: number = 0.2,
): DiffResult {
  const oldHashes = computeLineHashes(oldContent);
  const newHashes = computeLineHashes(newContent);
  return diffLines(oldHashes, newHashes, threshold);
}

/**
 * 判断是否建议整文件重建
 */
export function shouldFullRebuild(diff: DiffResult): boolean {
  return diff.suggestFullRebuild || diff.totalLines === 0;
}
