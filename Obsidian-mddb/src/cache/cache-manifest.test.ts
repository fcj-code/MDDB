/**
 * CacheManifestManager 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManifestManager, CURRENT_CACHE_VERSION } from './cache-manifest';
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

describe('CacheManifestManager', () => {
  let fileOp: FileOperator;
  let manager: CacheManifestManager;

  beforeEach(() => {
    fileOp = createMockFileOperator();
    manager = new CacheManifestManager(fileOp, '.mddb/cache-manifest.json');
  });

  describe('createManifest', () => {
    it('creates manifest with current version', () => {
      const manifest = manager.createManifest('0.1.0');
      expect(manifest.pluginVersion).toBe('0.1.0');
      expect(manifest.cacheVersion).toBe(CURRENT_CACHE_VERSION);
      expect(manifest.createdAt).toBeTruthy();
    });
  });

  describe('save and load', () => {
    it('saves and loads manifest', async () => {
      const manifest = manager.createManifest('0.1.0');
      await manager.save(manifest);

      const loaded = await manager.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.pluginVersion).toBe('0.1.0');
    });

    it('returns null when no manifest', async () => {
      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });
  });

  describe('check', () => {
    it('needs rebuild when no manifest exists', async () => {
      const result = await manager.check('0.1.0');
      expect(result.needsRebuild).toBe(true);
      expect(result.exists).toBe(false);
    });

    it('is valid when manifest is current', async () => {
      const manifest = manager.createManifest('0.1.0');
      await manager.save(manifest);

      const result = await manager.check('0.1.0');
      expect(result.valid).toBe(true);
      expect(result.needsRebuild).toBe(false);
    });
  });

  describe('touch', () => {
    it('updates timestamp', async () => {
      const manifest = manager.createManifest('0.1.0');
      await manager.save(manifest);

      const originalUpdatedAt = manifest.updatedAt;
      await new Promise(resolve => setTimeout(resolve, 10));
      await manager.touch('0.2.0');

      const loaded = await manager.load();
      expect(loaded!.updatedAt).not.toBe(originalUpdatedAt);
      expect(loaded!.pluginVersion).toBe('0.2.0');
    });
  });

  describe('remove', () => {
    it('removes manifest', async () => {
      const manifest = manager.createManifest('0.1.0');
      await manager.save(manifest);
      await manager.remove();

      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });
  });
});
