/**
 * WAL 重放引擎测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { replayWal } from './replay';
import { createWalEntry } from './types';
import type { FileOperator } from '../write/types';
import type { WalEntry } from './types';

function createMockFileOperator(): FileOperator {
  const files = new Map<string, string>();

  return {
    async readFile(filePath: string): Promise<string> {
      const content = files.get(filePath);
      if (content === undefined) throw new Error(`File not found: ${filePath}`);
      return content;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async processFile(filePath: string, updater: (content: string) => string): Promise<string> {
      const current = files.get(filePath) ?? '';
      const updated = updater(current);
      files.set(filePath, updated);
      return updated;
    },
  };
}

describe('replayWal', () => {
  let fileOp: FileOperator;

  beforeEach(() => {
    fileOp = createMockFileOperator();
  });

  describe('insertLine', () => {
    it('appends content to file', async () => {
      await fileOp.writeFile('test.md', '```mddb\n@table test\n```\n');
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'insertLine',
          file: 'test.md',
          content: 'a|b|c',
        },
      ]);

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(true);
      const content = await fileOp.readFile('test.md');
      expect(content).toContain('a|b|c');
    });

    it('succeeds on first attempt', async () => {
      await fileOp.writeFile('test.md', '```mddb\n@table test\n```\n');
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'insertLine',
          file: 'test.md',
          content: 'data|row',
        },
      ]);

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(true);
      expect(result.completedCount).toBe(1);
      expect(result.operationResults[0]!.skipped).toBe(false);
    });
  });

  describe('idempotent replay', () => {
    it('skips already completed operations', async () => {
      await fileOp.writeFile('test.md', '```mddb\n@table test\n```\n');
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'insertLine',
          file: 'test.md',
          content: 'a|b|c',
        },
      ]);
      entry.progress.completedOperationIds = ['op-1'];

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(true);
      expect(result.operationResults[0]!.skipped).toBe(true);
    });

    it('resumes from first incomplete operation', async () => {
      await fileOp.writeFile('test.md', '```mddb\n@table test\n```\n');
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'insertLine',
          file: 'test.md',
          content: 'first|row',
        },
        {
          id: 'op-2',
          type: 'insertLine',
          file: 'test.md',
          content: 'second|row',
        },
      ]);
      entry.progress.completedOperationIds = ['op-1'];

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(true);
      expect(result.operationResults[0]!.skipped).toBe(true);
      expect(result.operationResults[1]!.skipped).toBe(false);
    });
  });

  describe('conflict detection', () => {
    it('detects hash mismatch for replaceLine', async () => {
      await fileOp.writeFile('test.md', 'line1\nline2\nline3\n');
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'replaceLine',
          file: 'test.md',
          lineNumber: 2,
          beforeHash: 'wronghash',
          afterContent: 'modified',
        },
      ]);

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(false);
      expect(result.operationResults[0]!.error).toContain('does not match expected state');
    });
  });

  describe('replaceLine', () => {
    it('replaces content at given line', async () => {
      await fileOp.writeFile('test.md', 'a|1\nb|2\nc|3\n');
      const content = await fileOp.readFile('test.md');
      const lines = content.split('\n');

      // Make a reliable hash for line 2
      const { simpleHash } = await import('../write/serializer');
      const beforeHash = simpleHash(lines[1]!);

      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'replaceLine',
          file: 'test.md',
          lineNumber: 2,
          beforeHash,
          afterContent: 'b|20',
        },
      ]);

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(true);

      const updated = await fileOp.readFile('test.md');
      expect(updated).toContain('b|20\n');
    });
  });

  describe('deleteLine', () => {
    it('deletes line at given position', async () => {
      await fileOp.writeFile('test.md', 'a\nb\nc\n');
      const content = await fileOp.readFile('test.md');
      const { simpleHash } = await import('../write/serializer');
      const beforeHash = simpleHash('b');

      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'deleteLine',
          file: 'test.md',
          lineNumber: 2,
          beforeHash,
          beforeContent: 'b',
        },
      ]);

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(true);

      const updated = await fileOp.readFile('test.md');
      expect(updated).not.toContain('\nb\n');
    });
  });

  describe('onOperationComplete callback', () => {
    it('calls callback after each successful operation', async () => {
      await fileOp.writeFile('test.md', '```mddb\n@table test\n```\n');
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'insertLine',
          file: 'test.md',
          content: 'row|1',
        },
        {
          id: 'op-2',
          type: 'insertLine',
          file: 'test.md',
          content: 'row|2',
        },
      ]);

      const completedOps: string[] = [];
      const result = await replayWal(entry, fileOp, async (opId) => {
        completedOps.push(opId);
      });

      expect(result.success).toBe(true);
      expect(completedOps).toEqual(['op-1', 'op-2']);
    });
  });

  describe('error handling', () => {
    it('reports file not found error', async () => {
      const entry = createWalEntry('tx-1', [
        {
          id: 'op-1',
          type: 'insertLine',
          file: 'nonexistent.md',
          content: 'data',
        },
      ]);

      const result = await replayWal(entry, fileOp);
      expect(result.success).toBe(false);
      expect(result.operationResults[0]!.success).toBe(false);
      expect(result.operationResults[0]!.error).toBeTruthy();
    });
  });
});
