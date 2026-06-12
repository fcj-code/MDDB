/**
 * RetryScheduler 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RetryScheduler } from './retry-scheduler';
import { WalManager, InMemoryWalStore } from './wal-manager';
import type { FileOperator } from '../write/types';

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

describe('RetryScheduler', () => {
  let walManager: WalManager;
  let fileOperator: FileOperator;
  let scheduler: RetryScheduler;

  beforeEach(() => {
    const store = new InMemoryWalStore();
    walManager = new WalManager(store);
    fileOperator = createMockFileOperator();
    scheduler = new RetryScheduler(walManager, fileOperator, { checkIntervalMs: 1000, autoStart: false });
  });

  describe('lifecycle', () => {
    it('starts and stops', () => {
      expect(scheduler.running).toBe(false);
      scheduler.start();
      expect(scheduler.running).toBe(true);
      scheduler.stop();
      expect(scheduler.running).toBe(false);
    });

    it('shutdown stops scheduler', () => {
      scheduler.start();
      scheduler.shutdown();
      expect(scheduler.running).toBe(false);
    });
  });

  describe('checkRetries', () => {
    it('processes due retries', async () => {
      await fileOperator.writeFile('test.md', '```mddb\n@table test\n```\n');
      await walManager.createWal('tx-1', [
        { id: 'op-1', type: 'insertLine' as const, file: 'test.md', content: 'a|b' },
      ]);
      await walManager.recordRetry('tx-1', 'temp error', new Date(Date.now() - 1000).toISOString());

      const result = await scheduler.checkRetries();
      expect(result.processed).toBe(1);
    });

    it('returns zeros when no retries due', async () => {
      const result = await scheduler.checkRetries();
      expect(result.processed).toBe(0);
    });

    it('marks entry as done on successful retry', async () => {
      await fileOperator.writeFile('test.md', '```mddb\n@table test\n```\n');
      await walManager.createWal('tx-1', [
        { id: 'op-1', type: 'insertLine' as const, file: 'test.md', content: 'a|b' },
      ]);
      await walManager.recordRetry('tx-1', 'temp error', new Date(Date.now() - 1000).toISOString());

      await scheduler.checkRetries();

      const entry = await walManager.getWal('tx-1');
      expect(entry!.status).toBe('done');
    });

    it('marks entry as dead after max retries', async () => {
      await walManager.createWal('tx-1', [
        { id: 'op-1', type: 'insertLine' as const, file: 'nonexistent.md', content: 'a|b' },
      ], 1); // maxRetries = 1
      await walManager.recordRetry('tx-1', 'temp error', new Date(Date.now() - 1000).toISOString());

      await scheduler.checkRetries();

      const entry = await walManager.getWal('tx-1');
      expect(entry!.status).toBe('dead');
      expect(entry!.retry.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('retryAll', () => {
    it('retries all pending and retrying entries', async () => {
      await fileOperator.writeFile('a.md', '```mddb\n@table test\n```\n');
      await walManager.createWal('tx-1', [
        { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x|1' },
      ]);
      await walManager.createWal('tx-2', [
        { id: 'op-2', type: 'insertLine' as const, file: 'a.md', content: 'y|2' },
      ]);
      await walManager.updateStatus('tx-2', 'retrying');

      const result = await scheduler.retryAll();
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
    });
  });
});
