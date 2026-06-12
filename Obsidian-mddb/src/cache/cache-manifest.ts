/**
 * Cache Manifest 管理器
 *
 * 管理 SQLite cache 的元数据描述文件。
 *
 * 参考：v2 roadmap §3（冷启动流程）, runtime-architecture.md §7
 *
 * CacheManifest 包含：
 * - pluginVersion: 创建该 cache 的插件版本
 * - cacheVersion: cache 格式版本号（用于迁移判断）
 * - sqliteSchemaVersion: SQLite 表结构版本号
 * - createdAt / updatedAt: 时间戳
 */

import type { FileOperator } from '../write/types';

// ============================================================
// 类型定义
// ============================================================

export const CURRENT_CACHE_VERSION = 1;
export const CURRENT_SQLITE_SCHEMA_VERSION = 1;

export interface CacheManifest {
  pluginVersion: string;
  cacheVersion: number;
  sqliteSchemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// 检查结果
// ============================================================

export interface CacheCheckResult {
  /** Cache 是否存在 */
  exists: boolean;
  /** 加载是否成功 */
  valid: boolean;
  /** 是否需要重建 */
  needsRebuild: boolean;
  /** 当前 manifest（如果存在且有效） */
  manifest: CacheManifest | null;
  /** 检查信息 */
  message: string;
}

// ============================================================
// Cache Manifest 管理器
// ============================================================

export class CacheManifestManager {
  private fileOperator: FileOperator;
  private manifestPath: string;

  constructor(
    fileOperator: FileOperator,
    manifestPath: string = '.mddb/cache-manifest.json',
  ) {
    this.fileOperator = fileOperator;
    this.manifestPath = manifestPath;
  }

  /**
   * 获取 manifest 文件路径
   */
  get path(): string {
    return this.manifestPath;
  }

  /**
   * 创建初始 manifest
   */
  createManifest(pluginVersion: string): CacheManifest {
    const now = new Date().toISOString();
    return {
      pluginVersion,
      cacheVersion: CURRENT_CACHE_VERSION,
      sqliteSchemaVersion: CURRENT_SQLITE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 保存 manifest 到文件
   */
  async save(manifest: CacheManifest): Promise<void> {
    const content = JSON.stringify(manifest, null, 2);
    await this.fileOperator.writeFile(this.manifestPath, content);
  }

  /**
   * 从文件加载 manifest
   */
  async load(): Promise<CacheManifest | null> {
    try {
      const content = await this.fileOperator.readFile(this.manifestPath);
      const parsed = JSON.parse(content) as CacheManifest;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 检查 cache 状态并判断是否需要重建
   */
  async check(pluginVersion: string): Promise<CacheCheckResult> {
    const manifest = await this.load();

    if (!manifest) {
      return {
        exists: false,
        valid: false,
        needsRebuild: true,
        manifest: null,
        message: 'Cache manifest not found — full rebuild required',
      };
    }

    // 检查版本号
    if (manifest.cacheVersion < CURRENT_CACHE_VERSION) {
      return {
        exists: true,
        valid: false,
        needsRebuild: true,
        manifest,
        message: `Cache version ${manifest.cacheVersion} < current ${CURRENT_CACHE_VERSION} — rebuild required`,
      };
    }

    if (manifest.sqliteSchemaVersion < CURRENT_SQLITE_SCHEMA_VERSION) {
      return {
        exists: true,
        valid: false,
        needsRebuild: true,
        manifest,
        message: `SQLite schema version ${manifest.sqliteSchemaVersion} < current ${CURRENT_SQLITE_SCHEMA_VERSION} — rebuild required`,
      };
    }

    // 一切正常
    return {
      exists: true,
      valid: true,
      needsRebuild: false,
      manifest,
      message: 'Cache is up to date',
    };
  }

  /**
   * 更新 manifest 的时间戳
   */
  async touch(pluginVersion: string): Promise<void> {
    const manifest = await this.load();
    if (manifest) {
      manifest.updatedAt = new Date().toISOString();
      manifest.pluginVersion = pluginVersion;
      await this.save(manifest);
    }
  }

  /**
   * 删除 manifest（重建前调用）
   */
  async remove(): Promise<void> {
    try {
      await this.fileOperator.writeFile(this.manifestPath, '');
    } catch {
      // 忽略
    }
  }
}
