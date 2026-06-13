/**
 * mddb-kanban 代码块解析器
 *
 * 解析语法：
 * ```mddb-kanban
 * from tasks
 * show 标题, 负责人, 优先级
 * group by 状态
 * where 负责人 = "张三"
 * sort by 优先级 desc
 * limit 200
 * ```
 *
 * 参考：kanban-view-design.md §2.1
 */

import type { KanbanConfig } from './kanban-config';

export interface ParseResult {
  success: boolean;
  config: KanbanConfig | null;
  errors: string[];
}

type DirectiveHandler = (args: string, config: Partial<KanbanConfig>) => string[];

const DIRECTIVES: Record<string, DirectiveHandler> = {
  from: (args, config) => {
    config.table = args.trim();
    return [];
  },
  show: (args, config) => {
    config.columns = args.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  },
  'group by': (args, config) => {
    config.groupBy = args.trim();
    return [];
  },
  where: (args, config) => {
    config.filter = args.trim();
    return [];
  },
  sort: (args, config) => {
    const parts = args.trim().split(/\s+/);
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
      config.limit = n;
    } else {
      return [`Invalid limit value: "${args.trim()}"`];
    }
    return [];
  },
};

export function parseKanbanBlock(content: string): ParseResult {
  const errors: string[] = [];
  const config: Partial<KanbanConfig> = {
    columns: [],
    sort: [],
  };

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Check multi-word directives first ("group by")
    const groupByMatch = line.match(/^group\s+by\s+(.*)$/i);
    if (groupByMatch) {
      DIRECTIVES['group by'](groupByMatch[1]!, config);
      continue;
    }

    // Single-word directives
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
  if (!config.groupBy) {
    errors.push('Missing required directive: "group by"');
    success = false;
  }

  return {
    success,
    config: {
      table: config.table ?? '',
      columns: config.columns ?? [],
      groupBy: config.groupBy ?? '',
      filter: config.filter,
      sort: config.sort && config.sort.length > 0 ? config.sort : undefined,
      limit: config.limit ?? 200,
    },
    errors,
  };
}
