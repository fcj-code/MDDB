/**
 * RescanScheduler 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RescanScheduler } from './rescan-scheduler';
import { DiagnosticsManager } from '../engine/diagnostics';

describe('RescanScheduler', () => {
  let diagnostics: DiagnosticsManager;
  let scheduler: RescanScheduler;

  beforeEach(() => {
    diagnostics = new DiagnosticsManager();
    scheduler = new RescanScheduler(diagnostics, {
      batchSize: 10,
      batchDelayMs: 5,
      emitEvents: false,
      verifyIntervalMs: 0,
    });
  });

  describe('scanAll', () => {
    it('processes files in batches', async () => {
      const files = Array.from({ length: 25 }, (_, i) => ({
        path: `file-${i}.md`,
        content: `content-${i}`,
      }));

      let processedCount = 0;
      scheduler.setRescanCallback(async (batch) => {
        processedCount += batch.files.length;
        return { errors: 0 };
      });

      const result = await scheduler.scanAll(files);
      expect(result.totalFiles).toBe(25);
      expect(processedCount).toBe(25);
    });

    it('returns success when no errors', async () => {
      scheduler.setRescanCallback(async () => ({ errors: 0 }));

      const result = await scheduler.scanAll([
        { path: 'a.md', content: 'a' },
      ]);
      expect(result.success).toBe(true);
    });

    it('refuses concurrent scans', async () => {
      scheduler.setRescanCallback(async () => ({ errors: 0 }));

      // First scan
      const p1 = scheduler.scanAll([
        { path: 'a.md', content: 'a' },
      ]);

      // Second scan should be refused
      const p2 = scheduler.scanAll([
        { path: 'b.md', content: 'b' },
      ]);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.success).toBe(true);
      expect(r2.message).toContain('busy');
    });
  });

  describe('scanFiles', () => {
    it('scans subset of files', async () => {
      let processed = 0;
      scheduler.setRescanCallback(async (batch) => {
        processed += batch.files.length;
        return { errors: 0 };
      });

      await scheduler.scanFiles([
        { path: 'a.md', content: 'a' },
        { path: 'b.md', content: 'b' },
      ]);
      expect(processed).toBe(2);
    });
  });

  describe('progress', () => {
    it('reports progress during scan', async () => {
      scheduler.setRescanCallback(async () => ({ errors: 0 }));

      const progressUpdates: number[] = [];
      scheduler.onProgress = (p) => {
        progressUpdates.push(p.currentBatch);
      };

      await scheduler.scanAll(
        Array.from({ length: 25 }, (_, i) => ({
          path: `f-${i}.md`,
          content: `${i}`,
        })),
      );

      expect(progressUpdates.length).toBeGreaterThan(0);
    });
  });

  describe('shutdown', () => {
    it('stops processing', async () => {
      scheduler.setRescanCallback(async () => ({ errors: 0 }));
      scheduler.shutdown();

      const result = await scheduler.scanAll([
        { path: 'a.md', content: 'a' },
      ]);
      expect(result.success).toBe(false);
      expect(result.message).toContain('shut down');
    });
  });
});
