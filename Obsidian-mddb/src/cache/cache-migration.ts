/**
 * Cache 迁移引擎
 *
 * 负责 cache 版本检测和迁移逻辑。
 *
 * 参考：v2 roadmap（冷启动流程, cache manifest）
 *
 * 迁移策略：
 * - cacheVersion 落后 → 全量重建（暂不支持增量迁移）
 * - sqliteSchemaVersion 落后 → 执行 DDL 迁移脚本
 * - 损坏的 cache → 备份后全量重建
 */

import type { FileOperator } from '../write/types';
import type { SQLiteAdapter } from '../storage/sqlite-adapter';
import type { CacheManifest } from './cache-manifest';

// ============================================================
// 迁移类型
// ============================================================

export interface MigrationResult {
  /** 是否执行了迁移 */
  migrated: boolean;
  /** 迁移前的版本 */
  fromCacheVersion: number;
  /** 迁移后的版本 */
  toCacheVersion: number;
  /** 迁移步骤 */
  steps: MigrationStep[];
  /** 迁移是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

export interface MigrationStep {
  name: string;
  success: boolean;
  description: string;
  error?: string;
}

// ============================================================
// SQLite Schema 迁移
// ============================================================

/**
 * SQLite 表结构版本迁移映射
 *
 * key: 当前版本 → value: 迁移到下一版本的 SQL 数组
 * MVP 阶段不做增量迁移，但预留扩展点。
 */
const SQLITE_MIGRATIONS: Record<number, string[]> = {
  // v1 是初始版本，无需迁移
};

/**
 * 执行 SQLite schema 迁移
 */
async function migrateSqliteSchema(
  sqlite: SQLiteAdapter,
  fromVersion: number,
  toVersion: number,
): Promise<MigrationStep[]> {
  const steps: MigrationStep[] = [];

  for (let v = fromVersion; v < toVersion; v++) {
    const migrations = SQLITE_MIGRATIONS[v];
    if (!migrations) {
      steps.push({
        name: `schema-v${v}-to-v${v + 1}`,
        success: false,
        description: `No migration defined for SQLite schema v${v} → v${v + 1}`,
        error: `Missing migration for v${v}`,
      });
      continue;
    }

    try {
      for (const sql of migrations) {
        sqlite.run(sql);
      }
      steps.push({
        name: `schema-v${v}-to-v${v + 1}`,
        success: true,
        description: `Migrated SQLite schema from v${v} to v${v + 1}`,
      });
    } catch (e) {
      steps.push({
        name: `schema-v${v}-to-v${v + 1}`,
        success: false,
        description: `Failed to migrate SQLite schema from v${v} to v${v + 1}`,
        error: e instanceof Error ? e.message : String(e),
      });
      // 迁移失败则停止
      break;
    }
  }

  return steps;
}

// ============================================================
// 迁移检查
// ============================================================

export interface MigrationCheck {
  /** 是否需要迁移 */
  needed: boolean;
  /** 是否需要全量重建 cache */
  needsFullRebuild: boolean;
  /** 仅需 SQLite schema 迁移 */
  needsSqliteMigration: boolean;
  /** 说明 */
  reason: string;
}

/**
 * 检查是否需要迁移
 */
export function checkMigration(
  manifest: CacheManifest | null,
  currentCacheVersion: number,
  currentSqliteSchemaVersion: number,
): MigrationCheck {
  if (!manifest) {
    return {
      needed: true,
      needsFullRebuild: true,
      needsSqliteMigration: false,
      reason: 'No existing cache manifest',
    };
  }

  if (manifest.cacheVersion < currentCacheVersion) {
    return {
      needed: true,
      needsFullRebuild: true,
      needsSqliteMigration: false,
      reason: `Cache version ${manifest.cacheVersion} < ${currentCacheVersion}`,
    };
  }

  if (manifest.sqliteSchemaVersion < currentSqliteSchemaVersion) {
    return {
      needed: true,
      needsFullRebuild: false,
      needsSqliteMigration: true,
      reason: `SQLite schema version ${manifest.sqliteSchemaVersion} < ${currentSqliteSchemaVersion}`,
    };
  }

  return {
    needed: false,
    needsFullRebuild: false,
    needsSqliteMigration: false,
    reason: 'Up to date',
  };
}

// ============================================================
// 迁移执行器
// ============================================================

export class CacheMigration {
  private sqlite: SQLiteAdapter;
  private fileOperator: FileOperator;

  constructor(sqlite: SQLiteAdapter, fileOperator: FileOperator) {
    this.sqlite = sqlite;
    this.fileOperator = fileOperator;
  }

  /**
   * 执行 cache 迁移
   *
   * @returns 如果返回 null 表示不需要迁移
   */
  async migrate(
    manifest: CacheManifest | null,
    currentCacheVersion: number,
    currentSqliteSchemaVersion: number,
  ): Promise<MigrationResult | null> {
    const check = checkMigration(manifest, currentCacheVersion, currentSqliteSchemaVersion);

    if (!check.needed) {
      return null;
    }

    if (check.needsFullRebuild) {
      return {
        migrated: true,
        fromCacheVersion: manifest?.cacheVersion ?? 0,
        toCacheVersion: currentCacheVersion,
        steps: [
          {
            name: 'full-rebuild',
            success: true,
            description: 'Full cache rebuild required — drop and recreate',
          },
        ],
        success: true,
      };
    }

    if (check.needsSqliteMigration) {
      const fromVersion = manifest?.sqliteSchemaVersion ?? 0;
      const steps = await migrateSqliteSchema(
        this.sqlite,
        fromVersion,
        currentSqliteSchemaVersion,
      );

      const allSuccess = steps.every(s => s.success);

      return {
        migrated: true,
        fromCacheVersion: manifest?.cacheVersion ?? 0,
        toCacheVersion: currentCacheVersion,
        steps,
        success: allSuccess,
        error: allSuccess ? undefined : 'SQLite schema migration failed',
      };
    }

    return null;
  }
}
