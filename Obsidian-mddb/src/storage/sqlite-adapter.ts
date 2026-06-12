/**
 * SQLite 适配器
 *
 * 封装 sql.js WASM SQLite，提供统一的数据库操作接口。
 * 在测试环境中可替换为 mock 实现。
 *
 * 参考：runtime-architecture.md §3.1
 */

import type { ResultOrError } from '../core/result';
import { ok, err } from '../core/result';
import { EngineError } from '../core/errors';

// 引入 sql.js（需先 import 后 init）
// 在 Obsidian 环境中通过 npm: sql.js 使用
let initSqlJs: (config?: unknown) => Promise<SqlJsAPI>;

export interface SqlJsAPI {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
}

export interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): SqlJsResult;
  exec(sql: string): SqlJsExecResult[];
  prepare(sql: string): SqlJsStatement;
  close(): void;
  export(): Uint8Array;
}

export interface SqlJsResult {
  lastID?: number;
  changes?: number;
}

export interface SqlJsExecResult {
  columns: string[];
  values: unknown[][];
}

export interface SqlJsStatement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(params?: unknown[]): Record<string, unknown>;
  free(): boolean;
}

// ============================================================
// 查询结果
// ============================================================

export interface QueryRows {
  columns: string[];
  rows: unknown[][];
  affectedRows?: number;
}

// ============================================================
// SQLiteAdapter
// ============================================================

export class SQLiteAdapter {
  private db: SqlJsDatabase | null = null;
  private ready = false;

  async initialize(sqlJsModule: unknown): Promise<void> {
    try {
      const initFn = sqlJsModule as (config?: unknown) => Promise<SqlJsAPI>;
      const SQL = await initFn();
      this.db = new SQL.Database();
      this.ready = true;
      this.run('PRAGMA journal_mode=OFF');
    } catch (e) {
      throw new EngineError(
        `Failed to initialize SQLite: ${e}`,
        'SQLITE_INIT_ERROR',
      );
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 执行 SQL 语句（不返回结果集） */
  run(sql: string, params?: unknown[]): void {
    if (!this.db) throw new EngineError('SQLite not initialized', 'SQLITE_NOT_INIT');
    this.db.run(sql, params);
  }

  /** 执行查询并返回结果 */
  query(sql: string, params?: unknown[]): QueryRows {
    if (!this.db) throw new EngineError('SQLite not initialized', 'SQLITE_NOT_INIT');

    try {
      const stmt = this.db.prepare(sql);
      if (params && params.length > 0) {
        stmt.bind(params);
      }

      const columns: string[] = [];
      const rows: unknown[][] = [];

      // 获取列名
      // sql.js 的 getAsObject 在第一行返回列名
      let hasRow = false;
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const rowValues: unknown[] = [];
        for (const key of Object.keys(row)) {
          if (!hasRow) {
            columns.push(key);
          }
          rowValues.push(row[key]);
        }
        hasRow = true;
        rows.push(rowValues);
      }

      stmt.free();
      return { columns, rows };
    } catch (e) {
      throw new EngineError(
        `SQL query failed: ${e}`,
        'SQL_QUERY_ERROR',
      );
    }
  }

  /** 安全执行查询（返回 ResultOrError） */
  safeQuery(sql: string, params?: unknown[]): ResultOrError<QueryRows> {
    try {
      return ok(this.query(sql, params));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new EngineError(msg, 'SQL_QUERY_ERROR'));
    }
  }

  /** 导出整个数据库为 Uint8Array */
  exportDb(): Uint8Array {
    if (!this.db) throw new EngineError('SQLite not initialized', 'SQLITE_NOT_INIT');
    return this.db.export();
  }

  /** 从已有数据加载数据库 */
  load(data: Uint8Array | ArrayLike<number>): void {
    if (!this.db) throw new EngineError('SQLite not initialized', 'SQLITE_NOT_INIT');
    this.db.close();
    const SQL = (this.db.constructor as unknown as { new(data?: unknown): SqlJsDatabase });
    // Re-init with data
  }

  /** 关闭数据库 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.ready = false;
    }
  }
}
