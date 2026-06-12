/**
 * 查询引擎 (QueryEngine)
 *
 * 三阶段流水线：QueryValidator → SQLGenerator → ResultAssembler
 *
 * Milestone 4 新增：
 * - Ref follow（两步查询：查主表 → 查 ref 目标表 → 合并结果）
 * - 增强分页 metadata（page / pageSize / totalPages / hasMore）
 * - 默认 LIMIT 200（强制安全上限）
 * - 多字段排序
 *
 * 参考：query-engine-design.md, sql-safety-rules.md §4
 */

import type { Query, ResultSet, RefFollow, SortClause } from './types';
import type { ResultOrError } from '../core/result';
import type { SQLiteAdapter } from '../storage/sqlite-adapter';
import type { SchemaRegistryStore } from '../storage/schema-registry';
import type { IdentifierMode } from '../schema/validators';
import { ok, err } from '../core/result';
import { QueryError, EngineError } from '../core/errors';
import { validateQuery } from './validator';
import { SQLGenerator } from './sql-generator';
import { ResultAssembler } from './assembler';

export interface RawQueryOptions {
  readonly?: boolean;
  maxRows?: number;
  timeoutMs?: number;
  allowSystemTables?: boolean;
}

const SYSTEM_TABLES = ['_binding'];
const DML_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA)\b/i;
const MULTI_STMT_PATTERN = /;/g;

export class QueryEngine {
  private sqlGenerator: SQLGenerator;
  private assembler: ResultAssembler;

  constructor(
    private sqlite: SQLiteAdapter,
    private schemaRegistry: SchemaRegistryStore,
    private identMode: IdentifierMode = 'ascii',
  ) {
    this.sqlGenerator = new SQLGenerator(identMode);
    this.assembler = new ResultAssembler();
  }

  /**
   * 结构化查询
   *
   * 流程：验证 → 查 Schema → 生成 SQL → 执行 → 组装 → ref follow → 返回
   */
  query(q: Query, startTime?: number): ResultOrError<ResultSet> {
    const beganAt = startTime ?? Date.now();

    try {
      // 1. 获取 Schema
      const schemaEntry = this.schemaRegistry.getTable(q.table);
      if (!schemaEntry) {
        return err(new QueryError(`Table "${q.table}" not found`, q.table));
      }

      const validFields = schemaEntry.schema.fields;

      // 2. 验证（宽松模式）
      validateQuery(q, validFields);

      // 3. 生成 SQL
      const { sql, params } = this.sqlGenerator.generateQuery(q, validFields);

      // 4. 执行主查询
      const result = this.sqlite.query(sql, params);

      // 5. 组装结果
      const typeMap = this.assembler.extractTypeMap(
        result.columns,
        schemaEntry.schema.fields,
        schemaEntry.schema.types,
      );

      const results = this.assembler.assemble(
        result.columns,
        result.rows,
        q,
        typeMap,
      );

      // 6. Ref follow：对结果中的 ref 字段执行两步查询
      if (q.followRefs && q.followRefs.length > 0 && results.rows.length > 0) {
        this.executeRefFollow(results, q.followRefs, schemaEntry.schema.types);
      }

      // 7. 总行数（用于分页）
      const countResult = this.sqlite.query(
        this.sqlGenerator.generateCountQuery(q).sql,
        this.sqlGenerator.generateCountQuery(q).params,
      );
      const total = countResult.rows.length > 0
        ? Number(countResult.rows[0]![0])
        : results.rows.length;

      // 8. 分页 metadata
      const limit = q.limit ?? SQLGenerator.DEFAULT_LIMIT;
      const pageSize = limit;
      const page = q.offset !== undefined
        ? Math.floor(q.offset / pageSize) + 1
        : 1;
      const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
      const hasMore = page * pageSize < total;
      const durationMs = Date.now() - beganAt;

      return ok({
        ...results,
        total,
        page,
        pageSize,
        totalPages,
        returned: results.rows.length,
        queryInfo: {
          table: q.table,
          hasMore,
          durationMs,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new QueryError(msg, q.table));
    }
  }

  // ============================================================
  // Ref Follow
  // ============================================================

  /**
   * 对查询结果执行 ref field 的联表查询
   *
   * 流程：
   * 1. 从结果中提取所有 ref 字段的唯一值
   * 2. 对每个 ref follow 配置执行目标表查询
   * 3. 将结果合并到原行中（使用别名前缀）
   */
  private executeRefFollow(
    results: { rows: Record<string, unknown>[]; columns: { name: string; type: string }[] },
    refFollows: RefFollow[],
    typeExprs: string[],
  ): void {
    for (const follow of refFollows) {
      const typeIdx = typeExprs.findIndex(t => t.startsWith(`ref(`));
      if (typeIdx < 0) continue;

      // 收集该字段的唯一值
      const values = new Set<unknown>();
      for (const row of results.rows) {
        const val = row[follow.field];
        if (val !== null && val !== undefined && val !== '') {
          values.add(val);
        }
      }

      if (values.size === 0) continue;

      // 从 typeExpr 中提取目标表名
      const refType = typeExprs[typeIdx]!;
      const targetTable = this.parseRefTarget(refType);
      if (!targetTable) continue;

      // 获取目标表的 Schema 以确定 ref 的 PK 字段
      const targetEntry = this.schemaRegistry.getTable(targetTable);
      if (!targetEntry) continue;

      // 目标表的 PK 字段（用于匹配）
      const targetPkFields = targetEntry.schema.pk;
      const pkField = targetPkFields.length > 0 ? targetPkFields[0]! : 'rowid';

      // 执行第二步查询
      const refSQL = this.sqlGenerator.generateRefFollowSQL(
        targetTable,
        pkField,
        Array.from(values),
        follow.select,
      );
      const refResult = this.sqlite.query(refSQL.sql, refSQL.params);

      // 建立映射：ref value → 目标行数据
      const refMap = new Map<string, Record<string, unknown>>();
      for (const row of refResult.rows) {
        const key = String(row[0] ?? '');
        const data: Record<string, unknown> = {};
        for (let i = 1; i < refResult.columns.length; i++) {
          data[refResult.columns[i]!] = row[i];
        }
        refMap.set(key, data);
      }

      // 合并到原结果行
      const prefix = follow.alias ?? `${follow.field}.`;
      for (const row of results.rows) {
        const refVal = row[follow.field];
        if (refVal !== null && refVal !== undefined) {
          const refData = refMap.get(String(refVal));
          if (refData) {
            for (const [key, val] of Object.entries(refData)) {
              row[`${prefix}${key}`] = val;
            }
          }
        }
      }

      // 添加新列到 columns
      for (const selectField of follow.select) {
        const colName = `${prefix}${selectField}`;
        if (!results.columns.find(c => c.name === colName)) {
          results.columns.push({ name: colName, type: 'string' });
        }
      }
    }
  }

  /**
   * 从类型表达式中解析 ref 目标表名
   * "ref(categories)" → "categories"
   */
  private parseRefTarget(typeExpr: string): string | null {
    const match = typeExpr.match(/^ref\((.+)\)$/);
    return match ? match[1]!.trim() : null;
  }

  // ============================================================
  // 用户级 raw SQL
  // ============================================================

  queryRaw(sql: string, params?: unknown[], options?: RawQueryOptions): ResultOrError<ResultSet> {
    try {
      this.validateRawQuery(sql, options);

      const result = this.sqlite.query(sql, params ?? []);

      const rows = result.rows.map(row => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < result.columns.length; i++) {
          obj[result.columns[i]!] = row[i];
        }
        return obj;
      });

      return ok({
        rows,
        columns: result.columns.map(c => ({ name: c, type: 'string' })),
        total: rows.length,
        returned: rows.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new EngineError(msg, 'RAW_QUERY_ERROR'));
    }
  }

  /**
   * 内部 raw SQL（不受限制）
   */
  queryRawInternal(sql: string, params?: unknown[]): ResultOrError<ResultSet> {
    try {
      const result = this.sqlite.query(sql, params ?? []);
      const rows = result.rows.map(row => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < result.columns.length; i++) {
          obj[result.columns[i]!] = row[i];
        }
        return obj;
      });

      return ok({
        rows,
        columns: result.columns.map(c => ({ name: c, type: 'string' })),
        total: rows.length,
        returned: rows.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new EngineError(msg, 'INTERNAL_QUERY_ERROR'));
    }
  }

  // ============================================================
  // 安全检查
  // ============================================================

  private validateRawQuery(sql: string, options?: RawQueryOptions): void {
    const readonly = options?.readonly ?? true;
    const allowSystemTables = options?.allowSystemTables ?? false;

    if (readonly) {
      if (DML_PATTERN.test(sql)) {
        throw new QueryError('Raw SQL in read-only mode only allows SELECT statements');
      }
    }

    const matches = sql.match(MULTI_STMT_PATTERN);
    if (matches && matches.length > 1) {
      throw new QueryError('Multi-statement SQL is not allowed');
    }

    if (!allowSystemTables) {
      for (const sysTable of SYSTEM_TABLES) {
        if (sql.toLowerCase().includes(sysTable.toLowerCase())) {
          throw new QueryError(`Access to system table "${sysTable}" is not allowed`);
        }
      }
    }
  }
}
