/**
 * Schema 解析器
 *
 * 从四种来源提取 Schema，按优先级合并。
 *
 * 优先级：块内 @ 指令 > 围栏信息串 > 文件 YAML frontmatter > 外部 YAML 引用
 *
 * 参考：parse-pipeline-design.md §2, identity-model.md §4-5, sql-safety-rules.md §5
 */

import type { SchemaSummary } from '../core/types';
import { SchemaError } from '../core/errors';
import { validateSchema, type IdentifierMode } from './validators';

// ============================================================
// 常量
// ============================================================

const DEFAULT_NULL_MARKER = '-';
const REQUIRED_DIRECTIVES = ['@table', '@pk', '@fields', '@types'] as const;

// ============================================================
// 类型
// ============================================================

export interface SchemaResolution {
  schema: SchemaSummary;
  source: 'directive' | 'info-string' | 'frontmatter' | 'external';
}

export interface SchemaResolverOptions {
  identifierMode: IdentifierMode;
  vaultRoot: string;
  currentFilePath: string;
}

// ============================================================
// @ 指令解析器
// ============================================================

/** 从 @ 指令行中提取 Schema */
export function parseSchemaFromDirectives(lines: string[]): Partial<SchemaSummary> {
  const result: Record<string, string[]> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // 只处理 @ 开头
    if (!trimmed.startsWith('@')) continue;

    // 拆分为指令名和值
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      // 没有值，如 @strict 或 @required
      const name = trimmed.slice(1).trim();
      result[name] = result[name] ?? [];
      continue;
    }

    const name = trimmed.slice(1, spaceIdx).trim();
    const value = trimmed.slice(spaceIdx + 1).trim();

    if (!name || !value) continue;

    result[name] = result[name] ?? [];
    result[name].push(value);
  }

  return buildSchemaFromDirectives(result);
}

/** 将解析出的指令键值对转为 SchemaSummary */
function buildSchemaFromDirectives(directives: Record<string, string[]>): Partial<SchemaSummary> {
  const schema: Partial<SchemaSummary> & Record<string, unknown> = {};

  // @table — 只取一次
  if (directives['table'] && directives['table'].length > 0) {
    schema.table = directives['table'][0];
  }

  // @pk — 支持复合 (a, b, c) 和单列
  if (directives['pk'] && directives['pk'].length > 0) {
    const pkRaw = directives['pk'].join(',');
    schema.pk = parsePkValues(pkRaw);
  }

  // @fields — 支持 | 分隔
  if (directives['fields'] && directives['fields'].length > 0) {
    schema.fields = splitPipeValues(directives['fields'].join(' | '));
  }

  // @types
  if (directives['types'] && directives['types'].length > 0) {
    schema.types = splitPipeValues(directives['types'].join(' | '));
  }

  // @required
  if (directives['required'] && directives['required'].length > 0) {
    schema.required = directives['required'].join(' | ').split('|').map(s => s.trim() === 'true');
  }

  // @sort — 去除外层括号
  if (directives['sort'] && directives['sort'].length > 0) {
    let raw = directives['sort'].join(', ');
    raw = raw.replace(/^\(/, '').replace(/\)$/, '');
    schema.sort = raw.trim();
  }

  // @indexes — 支持 `|` 分隔（如 "idx(分类) | idx(账户)"）
  if (directives['indexes']) {
    const raw = directives['indexes'].join(' | ');
    schema.indexes = splitPipeValues(raw);
  }

  // @relations — 支持 `|` 和逗号分隔
  if (directives['relations']) {
    const raw = directives['relations'].join(' | ');
    schema.relations = splitPipeValues(raw);
  }

  // @null_marker / @nullMarker
  const nullMarker = directives['null_marker'] ?? directives['nullMarker'];
  if (nullMarker && nullMarker.length > 0) {
    schema.nullMarker = nullMarker[0];
  }

  // @strict
  if (directives['strict']) {
    schema.strict = directives['strict'].some(v => v === 'true' || v === 'yes' || v === '1');
  }

  return schema;
}

/** 解析 PK 表达式："(日期, 金额, 商户)" → ["日期", "金额", "商户"] */
function parsePkValues(raw: string): string[] {
  let trimmed = raw.trim();

  // 去掉外层括号
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

/** 按 | 分割并 trim 每个值 */
function splitPipeValues(raw: string): string[] {
  return raw.split('|').map(s => s.trim()).filter(s => s.length > 0);
}

// ============================================================
// YAML frontmatter 解析器
// ============================================================

/**
 * 从 Markdown 内容中提取 YAML frontmatter 并解析 mddb: 字段
 */
export function parseSchemaFromFrontmatter(content: string): Partial<SchemaSummary> | null {
  // 匹配 ---\n...\n---
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yamlBlock = match[1]!;
  if (!yamlBlock) return null;

  // 简单逐行解析（非完整 YAML 解析器）
  // 查找 mddb: 键
  let building: Record<string, string[]> | null = null;
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();

    // 忽略空行和注释
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 检查是否进入 mddb: 块
    if (trimmed === 'mddb:') {
      building = {};
      continue;
    }

    // 如果在 mddb: 块内（使用原始行的前导空格）
    if (building !== null) {
      const kvMatch = line.match(/^\s{2,}(\w+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1]!;
        const rawValue = kvMatch[2]?.trim() ?? '';

        // 处理数组格式: [a, b, c]
        if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
          const arr = rawValue.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
          building[key] = arr;
        } else if (rawValue === 'true' || rawValue === 'false') {
          building[key] = [rawValue];
        } else if (rawValue) {
          building[key] = [rawValue.replace(/^['"]|['"]$/g, '')];
        }
      }
    }
  }

  // 如果没找到 mddb 字段，返回 null
  if (!building || Object.keys(building).length === 0) {
    return null;
  }

  // 将 building 转为 SchemaSummary
  const schema: Partial<SchemaSummary> = {};

  // 映射 frontmatter 字段名到 @ 指令名（field vs fields 等）
  const fieldMap: Record<string, string> = {
    'table': 'table',
    'pk': 'pk',
    'fields': 'fields',
    'types': 'types',
    'required': 'required',
    'sort': 'sort',
    'indexes': 'indexes',
    'relations': 'relations',
    'null_marker': 'nullMarker',
    'nullMarker': 'nullMarker',
    'strict': 'strict',
  };

  for (const [key, values] of Object.entries(building)) {
    const directiveName = fieldMap[key] ?? key;

    switch (directiveName) {
      case 'table':
      case 'nullMarker':
        schema[directiveName] = values[0];
        break;
      case 'pk':
        schema.pk = values.flatMap(v => parsePkValues(v));
        break;
      case 'fields':
      case 'types':
        schema[directiveName === 'fields' ? 'fields' : 'types'] = values.flatMap(v => splitPipeValues(v));
        break;
      case 'required':
        schema.required = values.map(v => v === 'true');
        break;
      case 'sort':
        schema.sort = values.join(', ');
        break;
      case 'indexes':
        schema.indexes = values;
        break;
      case 'relations':
        schema.relations = values;
        break;
      case 'strict':
        schema.strict = values.some(v => v === 'true');
        break;
    }
  }

  return Object.keys(schema).length > 0 ? schema : null;
}

// ============================================================
// Schema 合并器
// ============================================================

/**
 * 按优先级合并两个 Schema 对象
 * highPriority 的字段覆盖 lowPriority 的字段
 */
export function mergeSchemas(
  lowPriority: Partial<SchemaSummary>,
  highPriority: Partial<SchemaSummary>,
): SchemaSummary {
  const defaults: SchemaSummary = {
    table: '',
    pk: [],
    fields: [],
    types: [],
    required: [],
    nullMarker: DEFAULT_NULL_MARKER,
    strict: false,
  };

  const merged: SchemaSummary = {
    ...defaults,
    ...lowPriority,
    ...highPriority,
    // 数组字段用高优先级的完整替换
    pk: highPriority.pk ?? lowPriority.pk ?? defaults.pk,
    fields: highPriority.fields ?? lowPriority.fields ?? defaults.fields,
    types: highPriority.types ?? lowPriority.types ?? defaults.types,
    required: highPriority.required ?? lowPriority.required ?? defaults.required,
    // 需要显示的覆盖默认
    nullMarker: highPriority.nullMarker ?? lowPriority.nullMarker ?? defaults.nullMarker,
    strict: highPriority.strict ?? lowPriority.strict ?? defaults.strict,
  };

  return merged;
}

// ============================================================
// SchemaResolver （4 来源综合）
// ============================================================

/**
 * 解析 Schema 的顶层入口
 *
 * @param directiveLines  - mddb 块内的 @ 指令行
 * @param infoString      - 围栏信息字符串 (schema=xxx)
 * @param fileContent     - 完整的文件内容（含 frontmatter）
 * @param options         - 解析选项
 * @param externalSchema  - 外部加载的 Schema（可选）
 * @returns 解析并验证后的 SchemaSummary
 * @throws SchemaError 如果验证失败
 */
export function resolveSchema(
  directiveLines: string[],
  infoString: string | null,
  fileContent: string,
  options: SchemaResolverOptions,
  externalSchema?: Partial<SchemaSummary>,
): SchemaSummary {
  // 1. 收集四种来源的 Schema 定义
  const external = externalSchema ?? {};
  const frontmatter = parseSchemaFromFrontmatter(fileContent) ?? {};
  const info = parseInfoString(infoString);
  const directives = parseSchemaFromDirectives(directiveLines);

  // 2. 按优先级合并
  const merged = mergeSchemas(
    mergeSchemas(
      mergeSchemas(external, frontmatter),
      info,
    ),
    directives,
  );

  // 3. 填充默认值
  if (merged.nullMarker === '') merged.nullMarker = DEFAULT_NULL_MARKER;

  // 4. 验证
  const validation = validateSchema(merged, options.identifierMode);
  if (!validation.valid) {
    throw new SchemaError(
      `Schema validation failed: ${validation.errors.join('; ')}`,
      merged.table,
    );
  }

  // 5. 补齐 required 长度（未指定的字段默认 false）
  if (merged.required.length < merged.fields.length) {
    const full = new Array(merged.fields.length).fill(false);
    for (let i = 0; i < merged.required.length; i++) {
      full[i] = merged.required[i];
    }
    merged.required = full;
  }

  return merged as SchemaSummary;
}

/**
 * 解析围栏信息字符串
 * 格式: "schema=accounts" 或 "block=accounts schema=transactions"
 */
function parseInfoString(infoString: string | null): Partial<SchemaSummary> {
  if (!infoString) return {};

  const schema: Partial<SchemaSummary> = {};

  // 解析 key=value 对
  const pairs = infoString.split(/\s+/);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;

    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();

    if (key === 'schema' && value) {
      // 在 info string 中，schema=xxx 表示 tableName
      schema.table = value;
    } else if (key === 'block' && value) {
      // block 标识在解析管道由 Lexer 使用
      // 这里不处理
    }
  }

  return schema;
}

/**
 * 加载外部 YAML 文件中的 Schema 定义
 * placeholder 用于 Milestone 1 当 Obsidian Vault API 不可用时简化
 */
export async function loadExternalSchema(
  ref: string,
  vaultRoot: string,
  currentFilePath: string,
): Promise<Partial<SchemaSummary> | null> {
  // 路径解析：
  // "finance/transactions" → vaultRoot + "finance/transactions.yaml"
  // "./transactions" → 相对于当前文件目录
  let targetPath: string;

  if (ref.startsWith('./')) {
    const dir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/') + 1);
    targetPath = dir + ref.slice(2);
  } else {
    targetPath = ref;
  }

  // 确保有扩展名
  if (!targetPath.endsWith('.yaml') && !targetPath.endsWith('.yml')) {
    targetPath += '.yaml';
  }

  // Milestone 1 MVP: 暂不实现完整的 YAML 文件加载
  // 通过 vault API 读取文件内容后解析
  // 此处返回 null 表示外部引用未解析
  return null;
}
