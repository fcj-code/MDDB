/**
 * mddb-gallery 代码块解析器
 *
 * 解析语法：
 * ```mddb-gallery
 * from books
 * show title, author, rating
 * image cover
 * where rating >= 4
 * sort by rating desc
 * limit 200
 * columns 4
 * ```
 *
 * 镜像 kanban/parser.ts，新增 image / columns 指令，去掉 group by。
 */

import type { GalleryConfig } from './gallery-config';

export interface ParseResult {
  success: boolean;
  config: GalleryConfig | null;
  errors: string[];
}

type DirectiveHandler = (args: string, config: Partial<GalleryConfig>) => string[];

const DIRECTIVES: Record<string, DirectiveHandler> = {
  from: (args, config) => {
    config.table = args.trim();
    return [];
  },
  show: (args, config) => {
    config.columns = args.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  },
  image: (args, config) => {
    config.imageField = args.trim();
    return [];
  },
  columns: (args, config) => {
    const n = parseInt(args.trim(), 10);
    if (!isNaN(n) && n > 0) {
      config.gridColumns = n;
      return [];
    }
    return [`Invalid columns value: "${args.trim()}"`];
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
      return [];
    }
    return [`Invalid limit value: "${args.trim()}"`];
  },
};

export function parseGalleryBlock(content: string): ParseResult {
  const errors: string[] = [];
  const config: Partial<GalleryConfig> = {
    columns: [],
    sort: [],
  };

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

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
  if (!config.columns || config.columns.length === 0) {
    errors.push('Missing required directive: "show"');
    success = false;
  }

  return {
    success,
    config: {
      table: config.table ?? '',
      columns: config.columns ?? [],
      imageField: config.imageField,
      gridColumns: config.gridColumns,
      filter: config.filter,
      sort: config.sort && config.sort.length > 0 ? config.sort : undefined,
      limit: config.limit ?? 200,
    },
    errors,
  };
}
