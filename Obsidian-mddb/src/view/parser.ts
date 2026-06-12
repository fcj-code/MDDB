/**
 * mddb-table 代码块解析器
 *
 * 将 Obsidian 笔记中的 mddb-table 代码块解析为 ViewConfig。
 *
 * 支持语法：
 * ```mddb-table
 * from accounts
 * show name, type, balance
 * where type = "储蓄"
 * sort by balance desc
 * limit 50
 * ```
 *
 * 参考：v2 roadmap Milestone 4
 */

import type { Query, ViewConfig, SortClause } from '../query/types';

// ============================================================
// 解析结果
// ============================================================

export interface ParseResult {
  success: boolean;
  config: ViewConfig | null;
  errors: string[];
}

// ============================================================
// 行解析器
// ============================================================

type DirectiveHandler = (args: string, config: Partial<ViewConfig>) => string[];

const DIRECTIVES: Record<string, DirectiveHandler> = {
  from: (args, config) => {
    config.table = args.trim();
    return [];
  },
  show: (args, config) => {
    config.columns = args.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  },
  where: (args, config) => {
    config.filter = args.trim();
    return [];
  },
  sort: (args, config) => {
    const parts = args.trim().split(/\s+/);
    // 跳过可选的 "by" 关键字: "sort by balance desc" → ["by", "balance", "desc"]
    let idx = 0;
    if (parts.length > 0 && parts[0]!.toLowerCase() === 'by') idx = 1;
    if (parts.length > idx) {
      const field = parts[idx]!;
      const direction = parts.length > idx + 1 && parts[idx + 1]?.toLowerCase() === 'desc'
        ? 'DESC' as const
        : 'ASC' as const;
      if (!config.sort) config.sort = [];
      config.sort.push({ field, direction });
    }
    return [];
  },
  limit: (args, config) => {
    const n = parseInt(args.trim(), 10);
    if (!isNaN(n) && n > 0) {
      config.pageSize = n;
    } else {
      return [`Invalid limit value: "${args.trim()}"`];
    }
    return [];
  },
};

// ============================================================
// 代码块解析器
// ============================================================

/**
 * 解析 mddb-table 代码块内容
 */
export function parseTableBlock(content: string): ParseResult {
  const errors: string[] = [];
  const config: Partial<ViewConfig> = {
    columns: [],
    sort: [],
  };

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue; // 跳过空行和注释

    // 查找指令前缀
    const directiveMatch = line.match(/^(\w+)\s+(.*)$/);
    if (!directiveMatch) {
      errors.push(`Unrecognized line: "${line}"`);
      continue;
    }

    const directive = directiveMatch[1]!.toLowerCase();
    const args = directiveMatch[2]!;

    const handler = DIRECTIVES[directive];
    if (!handler) {
      errors.push(`Unknown directive: "${directive}"`);
      continue;
    }

    const directiveErrors = handler(args, config);
    errors.push(...directiveErrors);
  }

  // 验证必需字段
  let success = true;
  if (!config.table) {
    errors.push('Missing required directive: "from"');
    success = false;
  }

  return {
    success,
    config: {
      table: config.table ?? '',
      columns: config.columns ?? [],
      filter: config.filter,
      sort: config.sort && config.sort.length > 0 ? config.sort : undefined,
      pageSize: config.pageSize ?? 50,
      readonly: true,
    },
    errors,
  };
}

// ============================================================
// ViewConfig → Query 转换
// ============================================================

export class ViewConfigBuilder {
  /**
   * 将 ViewConfig 转换为 Query
   */
  static toQuery(config: ViewConfig): Query {
    const query: Query = {
      table: config.table,
      limit: config.pageSize ?? 50,
    };

    // SELECT
    if (config.columns && config.columns.length > 0) {
      query.select = {
        columns: config.columns,
        distinct: false,
      };
    }

    // WHERE
    if (config.filter) {
      query.where = ViewConfigBuilder.parseWhere(config.filter);
    }

    // ORDER BY
    if (config.sort && config.sort.length > 0) {
      query.sort = config.sort.length === 1
        ? config.sort[0]!
        : config.sort;
    }

    return query;
  }

  /**
   * 简单 WHERE 表达式解析
   *
   * 支持格式：field = value, field > value, field IN (v1, v2)
   * 支持 AND/OR 组合
   */
  static parseWhere(expr: string): { operator: 'AND' | 'OR'; conditions: any[] } | undefined {
    const trimmed = expr.trim();
    if (!trimmed) return undefined;

    // 分割 AND/OR
    const orParts = trimmed.split(/\s+OR\s+/i);
    if (orParts.length > 1) {
      return {
        operator: 'OR',
        conditions: orParts
          .map(p => this.parseSimpleWhere(p.trim()))
          .filter(Boolean),
      };
    }

    const andParts = trimmed.split(/\s+AND\s+/i);
    if (andParts.length > 1) {
      return {
        operator: 'AND',
        conditions: andParts
          .map(p => this.parseSimpleWhere(p.trim()))
          .filter(Boolean),
      };
    }

    // 单个条件
    const simple = this.parseSimpleWhere(trimmed);
    if (simple) {
      return {
        operator: 'AND',
        conditions: [simple],
      };
    }

    return undefined;
  }

  /**
   * 简单条件解析：field op value
   *
   * 支持操作符：=, !=, >, >=, <, <=, LIKE, IN, IS NULL, IS NOT NULL
   */
  private static parseSimpleWhere(expr: string): any | null {
    // IS NULL / IS NOT NULL
    const nullMatch = expr.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i);
    if (nullMatch) {
      return {
        field: nullMatch[1]!,
        op: nullMatch[2]?.toUpperCase().includes('NOT') ? 'isNotNull' : 'isNull',
      };
    }

    // IN (values)
    const inMatch = expr.match(/^(\w+)\s+IN\s+\((.+)\)$/i);
    if (inMatch) {
      const values = inMatch[2]!.split(',').map(v => {
        const trimmed = v.trim();
        // 去除引号
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
          return trimmed.slice(1, -1);
        }
        const num = Number(trimmed);
        return isNaN(num) ? trimmed : num;
      });
      return {
        field: inMatch[1]!,
        op: 'in',
        value: values,
      };
    }

    // field op value (支持 =, !=, >, >=, <, <=, LIKE)
    const opMatch = expr.match(/^(\w+)\s*(=|!=|>=|<=|>|<|LIKE)\s*(.+)$/i);
    if (opMatch) {
      const field = opMatch[1]!;
      const rawOp = opMatch[2]!;
      const rawValue = opMatch[3]!.trim();

      const opMap: Record<string, string> = {
        '=': 'eq',
        '!=': 'neq',
        '>': 'gt',
        '>=': 'gte',
        '<': 'lt',
        '<=': 'lte',
        'LIKE': 'like',
      };

      const op = opMap[rawOp.toUpperCase()];
      if (!op) return null;

      // 解析值（去除引号、数字转换）
      let value: unknown = rawValue;
      if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
          (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
        value = rawValue.slice(1, -1);
      } else {
        const num = Number(rawValue);
        if (!isNaN(num)) value = num;
      }

      return { field, op, value };
    }

    return null;
  }
}
