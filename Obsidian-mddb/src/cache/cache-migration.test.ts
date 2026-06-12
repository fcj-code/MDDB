/**
 * CacheMigration 测试
 */
import { describe, it, expect } from 'vitest';
import { checkMigration, CacheMigration } from './cache-migration';
import type { CacheManifest } from './cache-manifest';
import { SQLiteAdapter } from '../storage/sqlite-adapter';
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

describe('checkMigration', () => {
  it('needs full rebuild when no manifest', () => {
    const result = checkMigration(null, 1, 1);
    expect(result.needed).toBe(true);
    expect(result.needsFullRebuild).toBe(true);
  });

  it('needs full rebuild when cache version behind', () => {
    const manifest: CacheManifest = {
      pluginVersion: '0.1.0',
      cacheVersion: 0,
      sqliteSchemaVersion: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const result = checkMigration(manifest, 1, 1);
    expect(result.needed).toBe(true);
    expect(result.needsFullRebuild).toBe(true);
  });

  it('needs sqlite migration when schema version behind', () => {
    const manifest: CacheManifest = {
      pluginVersion: '0.1.0',
      cacheVersion: 1,
      sqliteSchemaVersion: 0,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const result = checkMigration(manifest, 1, 1);
    expect(result.needed).toBe(true);
    expect(result.needsFullRebuild).toBe(false);
    expect(result.needsSqliteMigration).toBe(true);
  });

  it('returns not needed when versions match', () => {
    const manifest: CacheManifest = {
      pluginVersion: '0.1.0',
      cacheVersion: 1,
      sqliteSchemaVersion: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const result = checkMigration(manifest, 1, 1);
    expect(result.needed).toBe(false);
  });
});

describe('CacheMigration', () => {
  it('returns null when no migration needed', async () => {
    const sqlite = new SQLiteAdapter();
    const fileOp = createMockFileOperator();
    const migration = new CacheMigration(sqlite, fileOp);

    const manifest: CacheManifest = {
      pluginVersion: '0.1.0',
      cacheVersion: 1,
      sqliteSchemaVersion: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };

    const result = await migration.migrate(manifest, 1, 1);
    expect(result).toBeNull();
  });
});
