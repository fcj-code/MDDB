/**
 * WalManager 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WalManager, InMemoryWalStore } from './wal-manager';
import { createWalEntry } from './types';

describe('InMemoryWalStore', () => {
  let store: InMemoryWalStore;

  beforeEach(() => {
    store = new InMemoryWalStore();
  });

  it('stores and retrieves entries', async () => {
    const entry = createWalEntry('tx-1', []);
    await store.save(entry);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.txId).toBe('tx-1');
  });

  it('deletes entries', async () => {
    const entry = createWalEntry('tx-1', []);
    await store.save(entry);
    await store.delete('tx-1');
    expect(await store.loadAll()).toHaveLength(0);
  });

  it('lists by status', async () => {
    const e1 = createWalEntry('tx-1', []);
    const e2 = createWalEntry('tx-2', []);
    e2.status = 'dead';
    await store.save(e1);
    await store.save(e2);

    expect(store.listByStatus('pending')).toHaveLength(1);
    expect(store.listByStatus('dead')).toHaveLength(1);
  });

  it('clears all entries', async () => {
    await store.save(createWalEntry('tx-1', []));
    store.clear();
    expect(await store.loadAll()).toHaveLength(0);
  });
});

describe('WalManager', () => {
  let manager: WalManager;
  let store: InMemoryWalStore;

  beforeEach(() => {
    store = new InMemoryWalStore();
    manager = new WalManager(store);
  });

  describe('createWal', () => {
    it('creates a WAL entry', async () => {
      const entry = await manager.createWal('tx-1', []);
      expect(entry.txId).toBe('tx-1');
      expect(entry.status).toBe('pending');
      expect(store.getAll()).toHaveLength(1);
    });

    it('rejects after shutdown', async () => {
      manager.shutdown();
      await expect(manager.createWal('tx-1', [])).rejects.toThrow('shut down');
    });
  });

  describe('getWal', () => {
    it('returns null for non-existent', async () => {
      expect(await manager.getWal('nonexistent')).toBeNull();
    });

    it('returns existing entry', async () => {
      await manager.createWal('tx-1', []);
      const entry = await manager.getWal('tx-1');
      expect(entry).not.toBeNull();
      expect(entry!.txId).toBe('tx-1');
    });
  });

  describe('updateStatus', () => {
    it('updates entry status', async () => {
      await manager.createWal('tx-1', []);
      await manager.updateStatus('tx-1', 'done');
      const entry = await manager.getWal('tx-1');
      expect(entry!.status).toBe('done');
    });

    it('throws for non-existent', async () => {
      await expect(manager.updateStatus('no-tx', 'done')).rejects.toThrow('WAL not found');
    });
  });

  describe('markOperationCompleted', () => {
    it('records completed operation', async () => {
      const ops = [
        { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
      ];
      await manager.createWal('tx-1', ops);
      await manager.markOperationCompleted('tx-1', 'op-1');
      const entry = await manager.getWal('tx-1');
      expect(entry!.progress.completedOperationIds).toContain('op-1');
    });

    it('ignores duplicate', async () => {
      const ops = [
        { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' },
      ];
      await manager.createWal('tx-1', ops);
      await manager.markOperationCompleted('tx-1', 'op-1');
      await manager.markOperationCompleted('tx-1', 'op-1');
      const entry = await manager.getWal('tx-1');
      expect(entry!.progress.completedOperationIds).toHaveLength(1);
    });
  });

  describe('recordRetry', () => {
    it('records retry and sets next attempt', async () => {
      await manager.createWal('tx-1', []);
      const nextAt = new Date(Date.now() + 5000).toISOString();
      await manager.recordRetry('tx-1', 'some error', nextAt);

      const entry = await manager.getWal('tx-1');
      expect(entry!.retry.count).toBe(1);
      expect(entry!.retry.lastError).toBe('some error');
      expect(entry!.status).toBe('retrying');
    });

    it('sets status to dead when nextAttemptAt is null', async () => {
      await manager.createWal('tx-1', []);
      await manager.recordRetry('tx-1', 'fatal error', null);

      const entry = await manager.getWal('tx-1');
      expect(entry!.status).toBe('dead');
    });
  });

  describe('deleteWal', () => {
    it('deletes entry', async () => {
      await manager.createWal('tx-1', []);
      await manager.deleteWal('tx-1');
      expect(await manager.getWal('tx-1')).toBeNull();
    });
  });

  describe('queries', () => {
    it('getReplayableWals returns pending and retrying', async () => {
      const op = { id: 'op-1', type: 'insertLine' as const, file: 'a.md', content: 'x' };
      await manager.createWal('tx-pending', [op]);
      await manager.createWal('tx-retrying', [{ ...op, id: 'op-2' }]);
      await manager.updateStatus('tx-retrying', 'retrying');
      await manager.createWal('tx-done', [{ ...op, id: 'op-3' }]);
      await manager.updateStatus('tx-done', 'done');

      const replayable = await manager.getReplayableWals();
      expect(replayable).toHaveLength(2);
    });

    it('getDeadWals returns dead entries', async () => {
      await manager.createWal('tx-dead', []);
      await manager.recordRetry('tx-dead', 'error', null);

      const dead = await manager.getDeadWals();
      expect(dead).toHaveLength(1);
    });

    it('getDueRetries returns only retries past due', async () => {
      await manager.createWal('tx-due', []);
      await manager.recordRetry('tx-due', 'err', new Date(Date.now() - 1000).toISOString());

      await manager.createWal('tx-future', []);
      await manager.recordRetry('tx-future', 'err', new Date(Date.now() + 60_000).toISOString());

      const due = await manager.getDueRetries();
      expect(due).toHaveLength(1);
      expect(due[0]!.txId).toBe('tx-due');
    });
  });

  describe('shutdown', () => {
    it('prevents new WAL creation', async () => {
      manager.shutdown();
      await expect(manager.createWal('tx-1', [])).rejects.toThrow('shut down');
    });
  });
});
