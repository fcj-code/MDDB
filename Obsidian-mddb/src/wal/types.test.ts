/**
 * WAL 类型与辅助函数测试
 */
import { describe, it, expect } from 'vitest';
import {
  createWalEntry,
  isReplayable,
  isFullyCompleted,
  getNextOperationIndex,
  computeRetryDelay,
  WAL_VERSION,
} from './types';

describe('createWalEntry', () => {
  it('creates entry with default values', () => {
    const entry = createWalEntry('tx-1', []);
    expect(entry.txId).toBe('tx-1');
    expect(entry.version).toBe(WAL_VERSION);
    expect(entry.status).toBe('pending');
    expect(entry.progress.completedOperationIds).toEqual([]);
    expect(entry.retry.count).toBe(0);
    expect(entry.retry.maxRetries).toBe(5);
    expect(entry.retry.lastError).toBeNull();
  });

  it('creates entry with operations', () => {
    const ops = [
      { id: 'op-1', type: 'insertLine' as const, file: 'test.md', content: 'a|b|c' },
    ];
    const entry = createWalEntry('tx-2', ops);
    expect(entry.operations).toHaveLength(1);
    expect(entry.operations[0]!.id).toBe('op-1');
  });

  it('creates entry with custom maxRetries', () => {
    const entry = createWalEntry('tx-3', [], 3);
    expect(entry.retry.maxRetries).toBe(3);
  });

  it('sets createdAt and updatedAt', () => {
    const entry = createWalEntry('tx-4', []);
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });
});

describe('isReplayable', () => {
  it('returns true for pending', () => {
    const entry = createWalEntry('tx-1', []);
    expect(isReplayable(entry)).toBe(true);
  });

  it('returns true for retrying', () => {
    const entry = createWalEntry('tx-2', []);
    entry.status = 'retrying';
    expect(isReplayable(entry)).toBe(true);
  });

  it('returns false for done', () => {
    const entry = createWalEntry('tx-3', []);
    entry.status = 'done';
    expect(isReplayable(entry)).toBe(false);
  });

  it('returns false for dead', () => {
    const entry = createWalEntry('tx-4', []);
    entry.status = 'dead';
    expect(isReplayable(entry)).toBe(false);
  });
});

describe('isFullyCompleted', () => {
  it('returns true when all ops completed', () => {
    const ops = [
      { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
      { id: 'op-2', type: 'insertLine' as const, file: 'b.md', content: 'y' },
    ];
    const entry = createWalEntry('tx-1', ops);
    entry.progress.completedOperationIds = ['op-1', 'op-2'];
    expect(isFullyCompleted(entry)).toBe(true);
  });

  it('returns false when some ops not completed', () => {
    const ops = [
      { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
      { id: 'op-2', type: 'insertLine' as const, file: 'b.md', content: 'y' },
    ];
    const entry = createWalEntry('tx-2', ops);
    entry.progress.completedOperationIds = ['op-1'];
    expect(isFullyCompleted(entry)).toBe(false);
  });

  it('returns true when no ops', () => {
    const entry = createWalEntry('tx-3', []);
    expect(isFullyCompleted(entry)).toBe(true);
  });
});

describe('getNextOperationIndex', () => {
  it('returns 0 when nothing completed', () => {
    const ops = [
      { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
      { id: 'op-2', type: 'insertLine' as const, file: 'b.md', content: 'y' },
    ];
    const entry = createWalEntry('tx-1', ops);
    expect(getNextOperationIndex(entry)).toBe(0);
  });

  it('returns index of first incomplete op', () => {
    const ops = [
      { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
      { id: 'op-2', type: 'insertLine' as const, file: 'b.md', content: 'y' },
      { id: 'op-3', type: 'insertLine' as const, file: 'c.md', content: 'z' },
    ];
    const entry = createWalEntry('tx-2', ops);
    entry.progress.completedOperationIds = ['op-1'];
    expect(getNextOperationIndex(entry)).toBe(1);
  });

  it('returns length when all completed', () => {
    const ops = [
      { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
    ];
    const entry = createWalEntry('tx-3', ops);
    entry.progress.completedOperationIds = ['op-1'];
    expect(getNextOperationIndex(entry)).toBe(1);
  });
});

describe('computeRetryDelay', () => {
  it('increases delay with retry count', () => {
    const d1 = computeRetryDelay(0);
    const d2 = computeRetryDelay(1);
    expect(d2).toBeGreaterThan(d1);
  });

  it('caps at approximately 60 seconds (with jitter)', () => {
    const delay = computeRetryDelay(10); // 2^10 = 1024s, capped at 60000 + 20% jitter
    expect(delay).toBeLessThanOrEqual(72_000); // 60_000 * 1.2 = 72_000
  });

  it('adds jitter within ±20%', () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeRetryDelay(2); // base 4000ms
      expect(delay).toBeGreaterThanOrEqual(3200); // 4000 - 20%
      expect(delay).toBeLessThanOrEqual(4800); // 4000 + 20%
    }
  });
});
