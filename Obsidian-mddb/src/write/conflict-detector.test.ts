import { describe, it, expect } from 'vitest';
import {
  checkLineHash,
  assertLineHash,
  checkMultipleHashes,
  hashLine,
} from './conflict-detector';
import { simpleHash } from './serializer';
import { ConflictError } from '../core/errors';

// ============================================================
// checkLineHash
// ============================================================

describe('checkLineHash', () => {
  const content = 'line1\nline2\nline3\nline4';

  it('returns ok when hash matches', () => {
    const line2Hash = simpleHash('line2');
    const result = checkLineHash(content, 2, line2Hash);

    expect(result.ok).toBe(true);
    expect(result.currentLine).toBe('line2');
    expect(result.currentHash).toBe(line2Hash);
  });

  it('returns not ok when hash differs', () => {
    const result = checkLineHash(content, 2, 'wronghash');

    expect(result.ok).toBe(false);
    expect(result.currentLine).toBe('line2');
    expect(result.currentHash).not.toBe('wronghash');
  });

  it('returns not ok for out of range line', () => {
    const result = checkLineHash(content, 10, 'anything');

    expect(result.ok).toBe(false);
    expect(result.currentLine).toBe('');
  });

  it('detects external modification', () => {
    const content = 'unchanged\nmodified_line\nunchanged';
    const originalHash = simpleHash('modified_line');
    const modifiedContent = 'unchanged\nchanged_content\nunchanged';

    const result = checkLineHash(modifiedContent, 2, originalHash);
    expect(result.ok).toBe(false);
  });
});

// ============================================================
// assertLineHash
// ============================================================

describe('assertLineHash', () => {
  const content = 'line1\nline2\nline3';

  it('passes when hash matches', () => {
    const hash = simpleHash('line2');
    expect(() => assertLineHash(content, 2, hash, 'test.md', 'test_table')).not.toThrow();
  });

  it('throws ConflictError when hash mismatches', () => {
    expect(() =>
      assertLineHash(content, 2, 'wronghash', 'test.md', 'test_table'),
    ).toThrow(ConflictError);
  });

  it('throws ConflictError for out of range line', () => {
    expect(() =>
      assertLineHash(content, 10, 'hash', 'test.md', 'test_table'),
    ).toThrow(ConflictError);
  });
});

// ============================================================
// hashLine
// ============================================================

describe('hashLine', () => {
  it('computes deterministic hash for a line', () => {
    const h1 = hashLine('test | data | here');
    const h2 = hashLine('test | data | here');
    expect(h1).toBe(h2);
  });

  it('different lines produce different hashes', () => {
    const h1 = hashLine('line one');
    const h2 = hashLine('line two');
    expect(h1).not.toBe(h2);
  });
});

// ============================================================
// checkMultipleHashes
// ============================================================

describe('checkMultipleHashes', () => {
  const content = 'alpha\nbeta\ngamma';

  it('returns empty when all match', () => {
    const failures = checkMultipleHashes(content, [
      { lineNumber: 1, expectedHash: simpleHash('alpha') },
      { lineNumber: 2, expectedHash: simpleHash('beta') },
    ]);

    expect(failures).toHaveLength(0);
  });

  it('returns failures when some mismatch', () => {
    const failures = checkMultipleHashes(content, [
      { lineNumber: 1, expectedHash: simpleHash('alpha') },
      { lineNumber: 2, expectedHash: 'wronghash' },
      { lineNumber: 3, expectedHash: simpleHash('gamma') },
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.lineNumber).toBe(2);
  });
});
