import { describe, it, expect } from 'vitest';
import { LockManager } from './lock-manager';

describe('LockManager', () => {
  // ============================================================
  // 单文件锁
  // ============================================================

  describe('acquireLock / releaseLock', () => {
    it('acquires and releases single file lock', async () => {
      const lm = new LockManager();

      await lm.withFileLock('file1', 'owner1', async () => {
        expect(true).toBe(true);
      });
    });

    it('queues second request while first holds lock', async () => {
      const lm = new LockManager();
      const events: string[] = [];

      const p1 = lm.withFileLock('file1', 'owner1', async () => {
        events.push('start1');
        await new Promise(resolve => setTimeout(resolve, 50));
        events.push('end1');
      });

      // Start p2 after p1 acquires lock
      const p2 = new Promise<void>(resolve => {
        setTimeout(async () => {
          events.push('start2');
          await lm.withFileLock('file1', 'owner2', async () => {
            events.push('inside2');
          });
          events.push('end2');
          resolve();
        }, 10);
      });

      await Promise.all([p1, p2]);

      // inside2 must appear after end1 (serialized access)
      const end1Idx = events.indexOf('end1');
      const inside2Idx = events.indexOf('inside2');
      expect(inside2Idx).toBeGreaterThan(end1Idx);
    });

    it('allows same owner to re-enter', async () => {
      const lm = new LockManager();
      let result = '';

      await lm.withFileLock('file1', 'owner1', async () => {
        result += 'outer-';
        await lm.withFileLock('file1', 'owner1', async () => {
          result += 'inner';
        });
      });

      expect(result).toBe('outer-inner');
    });
  });

  // ============================================================
  // 多文件锁
  // ============================================================

  describe('acquireLocks', () => {
    it('locks multiple files', async () => {
      const lm = new LockManager();

      await lm.withFileLocks(['file1', 'file2'], 'owner1', async () => {
        expect(true).toBe(true);
      });
    });

    it('different owners on different files do not conflict', async () => {
      const lm = new LockManager();
      const events: string[] = [];

      const p1 = lm.withFileLock('fileA', 'owner1', async () => {
        events.push('lockedA');
        await new Promise(resolve => setTimeout(resolve, 30));
        events.push('releaseA');
      });

      const p2 = lm.withFileLock('fileB', 'owner2', async () => {
        events.push('lockedB');
      });

      await Promise.all([p1, p2]);

      expect(events).toContain('lockedA');
      expect(events).toContain('lockedB');
    });

    it('deadlock prevention: sorted acquisition order', async () => {
      const lm = new LockManager();
      const events: string[] = [];

      // Hold fileB first
      const p1 = lm.withFileLock('fileB', 'owner1', async () => {
        events.push('hasB');
        await new Promise(resolve => setTimeout(resolve, 50));
        events.push('releaseB');
      });

      const p2 = new Promise<void>(resolve => {
        setTimeout(async () => {
          // Request in reverse order → LockManager sorts internally
          await lm.withFileLocks(['fileC', 'fileB', 'fileA'], 'owner2', async () => {
            events.push('gotAll');
          });
          resolve();
        }, 10);
      });

      await Promise.all([p1, p2]);

      expect(events).toContain('hasB');
      expect(events).toContain('releaseB');
      expect(events).toContain('gotAll');
    }, 10000);
  });

  // ============================================================
  // shutdown
  // ============================================================

  describe('shutdown', () => {
    it('rejects new locks after shutdown', async () => {
      const lm = new LockManager();
      lm.shutdown();

      await expect(
        lm.withFileLock('file1', 'owner1', async () => {}),
      ).rejects.toThrow('LockManager is shut down');
    });
  });

  // ============================================================
  // 并发竞争
  // ============================================================

  describe('concurrent contention', () => {
    it('serializes access to same file', async () => {
      const lm = new LockManager();
      let sharedCounter = 0;

      const tasks = Array.from({ length: 10 }, (_, i) =>
        lm.withFileLock('shared', `owner_${i}`, async () => {
          const current = sharedCounter;
          await new Promise(resolve => setTimeout(resolve, 5));
          sharedCounter = current + 1;
        }),
      );

      await Promise.all(tasks);

      expect(sharedCounter).toBe(10);
    }, 20000);
  });
});
