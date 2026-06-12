/**
 * DeadLetterHandler 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DeadLetterHandler } from './dead-letter';
import { WalManager, InMemoryWalStore } from './wal-manager';

describe('DeadLetterHandler', () => {
  let walManager: WalManager;
  let handler: DeadLetterHandler;

  beforeEach(() => {
    const store = new InMemoryWalStore();
    walManager = new WalManager(store);
    handler = new DeadLetterHandler(walManager);
  });

  describe('getDeadLetters', () => {
    it('returns empty when no dead letters', async () => {
      const letters = await handler.getDeadLetters();
      expect(letters).toHaveLength(0);
    });

    it('returns dead letter info', async () => {
      await walManager.createWal('tx-dead', [
        { id: 'op-1', type: 'insertLine' as const, file: 'test.md', content: 'a|b' },
      ]);
      await walManager.recordRetry('tx-dead', 'fatal error', null);

      const letters = await handler.getDeadLetters();
      expect(letters).toHaveLength(1);
      expect(letters[0]!.txId).toBe('tx-dead');
      expect(letters[0]!.lastError).toBe('fatal error');
      expect(letters[0]!.files).toContain('test.md');
    });
  });

  describe('count', () => {
    it('counts dead letters', async () => {
      await walManager.createWal('tx-1', []);
      await walManager.recordRetry('tx-1', 'err', null);
      expect(await handler.count()).toBe(1);
    });
  });

  describe('retryDeadLetter', () => {
    it('resets dead letter to pending', async () => {
      await walManager.createWal('tx-1', []);
      await walManager.recordRetry('tx-1', 'err', null);
      expect((await walManager.getWal('tx-1'))!.status).toBe('dead');

      await handler.retryDeadLetter('tx-1');
      const entry = await walManager.getWal('tx-1');
      expect(entry!.status).toBe('pending');
      expect(entry!.retry.count).toBe(0);
      expect(entry!.retry.lastError).toBeNull();
    });

    it('throws for non-dead status', async () => {
      await walManager.createWal('tx-1', []);
      await expect(handler.retryDeadLetter('tx-1')).rejects.toThrow('not in dead status');
    });

    it('throws for non-existent', async () => {
      await expect(handler.retryDeadLetter('no-such')).rejects.toThrow('not found');
    });
  });

  describe('discardDeadLetter', () => {
    it('marks dead letter as done', async () => {
      await walManager.createWal('tx-1', []);
      await walManager.recordRetry('tx-1', 'err', null);

      await handler.discardDeadLetter('tx-1');
      const entry = await walManager.getWal('tx-1');
      expect(entry!.status).toBe('done');
    });
  });

  describe('discardAll', () => {
    it('discards all dead letters', async () => {
      await walManager.createWal('tx-1', []);
      await walManager.createWal('tx-2', []);
      await walManager.recordRetry('tx-1', 'err', null);
      await walManager.recordRetry('tx-2', 'err', null);

      const count = await handler.discardAll();
      expect(count).toBe(2);

      expect(await handler.count()).toBe(0);
    });
  });

  describe('retryAll', () => {
    it('resets all dead letters', async () => {
      await walManager.createWal('tx-1', []);
      await walManager.createWal('tx-2', []);
      await walManager.recordRetry('tx-1', 'err', null);
      await walManager.recordRetry('tx-2', 'err', null);

      const count = await handler.retryAll();
      expect(count).toBe(2);

      expect((await walManager.getWal('tx-1'))!.status).toBe('pending');
      expect((await walManager.getWal('tx-2'))!.status).toBe('pending');
    });
  });
});
