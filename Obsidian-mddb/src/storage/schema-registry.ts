/**
 * Schema 注册表存储层
 *
 * 管理 schema_registry.json 的读写，遵循 v2 身份模型（identity-model.md §4）。
 *
 * 参考：identity-model.md §4-5, runtime-architecture.md §8
 */

import type { SchemaRegistry, TableRegistryEntry, TableSource, SchemaSummary } from '../core/types';

export class SchemaRegistryStore {
  private registry: SchemaRegistry = {
    version: 2,
    tables: {},
  };

  private dirty = false;

  /** 获取完整的注册表 */
  getRegistry(): SchemaRegistry {
    return this.registry;
  }

  /** 获取指定表的入口 */
  getTable(table: string): TableRegistryEntry | undefined {
    return this.registry.tables[table];
  }

  /** 添加或更新表的 Schema */
  setTableSchema(table: string, schema: SchemaSummary): void {
    const existing = this.registry.tables[table];

    if (existing) {
      existing.schema = schema;
      existing.updatedAt = new Date().toISOString();
    } else {
      this.registry.tables[table] = {
        table,
        schema,
        sources: [],
        rowCount: 0,
        updatedAt: new Date().toISOString(),
      };
    }

    this.dirty = true;
  }

  /** 添加来源文件 */
  addSource(table: string, source: TableSource): void {
    const entry = this.registry.tables[table];
    if (!entry) return;

    // 去重
    const existing = entry.sources.find(
      s => s.file === source.file && s.blockId === source.blockId,
    );
    if (existing) {
      existing.rowCount = source.rowCount;
    } else {
      entry.sources.push(source);
    }

    entry.rowCount = entry.sources.reduce((sum, s) => sum + s.rowCount, 0);
    entry.updatedAt = new Date().toISOString();
    this.dirty = true;
  }

  /** 删除来源文件 */
  removeSource(table: string, file: string, blockId?: string): void {
    const entry = this.registry.tables[table];
    if (!entry) return;

    entry.sources = entry.sources.filter(s =>
      !(s.file === file && (blockId === undefined || s.blockId === blockId)),
    );

    entry.rowCount = entry.sources.reduce((sum, s) => sum + s.rowCount, 0);
    entry.updatedAt = new Date().toISOString();

    // 如果没有 source 了，删除整表入口
    if (entry.sources.length === 0) {
      delete this.registry.tables[table];
    }

    this.dirty = true;
  }

  /** 删除文件的所有表来源 */
  removeFile(file: string): string[] {
    const affectedTables: string[] = [];

    for (const [table, entry] of Object.entries(this.registry.tables)) {
      const before = entry.sources.length;
      entry.sources = entry.sources.filter(s => s.file !== file);

      if (entry.sources.length < before) {
        entry.rowCount = entry.sources.reduce((sum, s) => sum + s.rowCount, 0);
        entry.updatedAt = new Date().toISOString();

        if (entry.sources.length === 0) {
          delete this.registry.tables[table];
        }

        affectedTables.push(table);
      }
    }

    if (affectedTables.length > 0) this.dirty = true;

    return affectedTables;
  }

  /** 获取所有表名 */
  getTableNames(): string[] {
    return Object.keys(this.registry.tables);
  }

  /** 清除所有注册表数据 */
  clearAll(): void {
    this.registry = { version: 2, tables: {} };
    this.dirty = true;
  }

  /** 获取表 Schema */
  getSchema(table: string): SchemaSummary | undefined {
    const entry = this.registry.tables[table];
    return entry?.schema;
  }

  /** 序列化为 JSON */
  toJson(): string {
    return JSON.stringify(this.registry, null, 2);
  }

  /** 从 JSON 加载 */
  fromJson(json: string): void {
    try {
      const parsed = JSON.parse(json) as SchemaRegistry;
      if (parsed.version === 2) {
        this.registry = parsed;
        this.dirty = false;
      }
    } catch {
      // 解析失败则保留空注册表
      this.registry = { version: 2, tables: {} };
      this.dirty = false;
    }
  }

  /** 是否自上次保存后有变更 */
  isDirty(): boolean {
    return this.dirty;
  }

  /** 重置脏标记 */
  markClean(): void {
    this.dirty = false;
  }
}
