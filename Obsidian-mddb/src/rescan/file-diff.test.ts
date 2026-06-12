/**
 * FileDiff 测试
 */
import { describe, it, expect } from 'vitest';
import {
  computeLineHashes,
  diffLines,
  diffContent,
  shouldFullRebuild,
} from './file-diff';

describe('computeLineHashes', () => {
  it('computes hashes for each line (ignoring trailing empty)', () => {
    const result = computeLineHashes('a\nb\nc\n');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0]!.lineNumber).toBe(1);
    expect(result[1]!.lineNumber).toBe(2);
    expect(result[0]!.hash).toBeTruthy();
  });

  it('handles single line content', () => {
    const result = computeLineHashes('a');
    expect(result).toHaveLength(1);
  });

  it('handles empty content', () => {
    const result = computeLineHashes('');
    expect(result).toHaveLength(1); // split('\n') returns ['']
  });
});

describe('diffLines', () => {
  it('detects no changes', () => {
    const oldHashes = computeLineHashes('a\nb\nc');
    const newHashes = computeLineHashes('a\nb\nc');
    const result = diffLines(oldHashes, newHashes);
    expect(result.hasChanges).toBe(false);
    expect(result.stable.length).toBeGreaterThanOrEqual(3);
  });

  it('detects added lines', () => {
    const oldHashes = computeLineHashes('a\nb');
    const newHashes = computeLineHashes('a\nb\nc');
    const result = diffLines(oldHashes, newHashes);
    expect(result.hasChanges).toBe(true);
  });

  it('detects removed lines', () => {
    const oldHashes = computeLineHashes('a\nb\nc');
    const newHashes = computeLineHashes('a\nb');
    const result = diffLines(oldHashes, newHashes);
    expect(result.hasChanges).toBe(true);
  });

  it('calculates change ratio', () => {
    const oldHashes = computeLineHashes('a\nb\nc\nd\ne\n');
    const newHashes = computeLineHashes('a\nx\nc\nd\ne\n');
    const result = diffLines(oldHashes, newHashes);
    expect(result.changeRatio).toBeGreaterThan(0);
    expect(result.changeRatio).toBeLessThan(1);
  });

  it('suggests full rebuild when ratio exceeds threshold', () => {
    const oldHashes = computeLineHashes('a\nb\nc\n');
    const newHashes = computeLineHashes('x\ny\nz\n');
    const result = diffLines(oldHashes, newHashes, 0.2);
    expect(result.suggestFullRebuild).toBe(true);
  });
});

describe('diffContent', () => {
  it('diffs by content directly', () => {
    const result = diffContent('a\nb\nc\n', 'a\nb\nc\n');
    expect(result.hasChanges).toBe(false);
  });

  it('finds changes between versions', () => {
    const result = diffContent('line1\nline2\n', 'line1\nmodified\n');
    expect(result.hasChanges).toBe(true);
  });
});

describe('shouldFullRebuild', () => {
  it('returns true when suggestFullRebuild is true', () => {
    const result = diffContent('a\nb\n', 'x\ny\nz\n', 0.2);
    expect(shouldFullRebuild(result)).toBe(true);
  });

  it('returns false for minor changes (under threshold)', () => {
    const result = diffContent('a\nb\nc\nd\ne\nf', 'a\nmodified\nc\nd\ne\nf');
    expect(shouldFullRebuild(result)).toBe(false); // 1/6 = 16.7% < 20%
  });

  it('returns true for major changes (over threshold)', () => {
    const result = diffContent('a\nb\nc', 'x\ny\nz');
    expect(shouldFullRebuild(result)).toBe(true); // 3/3 = 100% > 20%
  });
});
