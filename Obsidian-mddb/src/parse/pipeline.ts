/**
 * 解析管道集成 (ParsePipeline) — v2
 *
 * 串联 SchemaResolver → Lexer → TypeConverter → Validator → IndexWriter
 *
 * 两遍扫描：
 *   第一遍：提取所有 `dmdb-schema` 和含 @ 指令的 mddb 块 → 建立 Schema 映射
 *   第二遍：处理数据行，匹配已定义的 Schema
 *
 * 参考：parse-pipeline-design.md §7, v2 roadmap Milestone 1
 */

import type { SchemaSummary, BindingRow } from '../core/types';
import type { ParseError } from '../core/errors';
import type { WriteContext } from '../storage/index-writer';
import type { MddbBlock } from './lexer';

import {
  extractBlocks,
  extractSchemaAndData,
  splitFields,
} from './lexer';
import { convertRowFields } from './converter';
import { validateRows } from './validator';
import { resolveSchema, mergeSchemas, parseSchemaFromDirectives } from '../schema/resolver';
import { writeRecords } from '../storage/index-writer';
import type { IdentifierMode } from '../schema/validators';

// ============================================================
// 解析配置 & 结果
// ============================================================

export interface PipelineConfig {
  identifierMode: IdentifierMode;
  vaultRoot: string;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  identifierMode: 'ascii',
  vaultRoot: '',
};

export interface FileParseResult {
  filePath: string;
  tables: ParsedTable[];
  totalErrors: number;
  totalWarnings: number;
  allErrors: ParseError[];
}

export interface ParsedTable {
  tableName: string;
  schema: SchemaSummary;
  records: unknown[][];
  bindingRows: BindingRow[];
  errorCount: number;
  warningCount: number;
}

export interface VaultScanResult {
  fileResults: FileParseResult[];
  tableCount: number;
  totalRows: number;
  totalErrors: number;
  totalWarnings: number;
}

// ============================================================
// ParsePipeline
// ============================================================

export class ParsePipeline {
  constructor(private config: PipelineConfig = DEFAULT_PIPELINE_CONFIG) {}

  /**
   * 解析单个文件（两遍扫描）
   */
  parseFile(
    fileContent: string,
    filePath: string,
    context: WriteContext,
  ): FileParseResult {
    const lines = fileContent.split('\n');
    const blocks = extractBlocks(lines);
    const allErrors: ParseError[] = [];

    // ── 第一遍：建立 Schema 映射 ──
    // schemaByTable: tableName → SchemaSummary
    // schemaByBlockIndex: blockIndex → (tableName, Schema)
    const schemaMap = new Map<string, SchemaSummary>();

    for (const block of blocks) {
      if (block.fenceKind === 'dmdb-schema' && block.directives.length > 0) {
        // dmdb-schema 块：只含 @ 指令
        const schema = resolveSchema(
          block.directives,
          block.infoString,
          fileContent,
          {
            identifierMode: this.config.identifierMode,
            vaultRoot: this.config.vaultRoot,
            currentFilePath: filePath,
          },
        );
        schemaMap.set(schema.table, schema);
      } else if (block.fenceKind === 'mddb' && block.directives.length > 0) {
        // mddb 块含内联 @ 指令
        const schema = resolveSchema(
          block.directives,
          block.infoString,
          fileContent,
          {
            identifierMode: this.config.identifierMode,
            vaultRoot: this.config.vaultRoot,
            currentFilePath: filePath,
          },
        );
        schemaMap.set(schema.table, schema);
      }
    }

    // ── 第二遍：处理数据行 ──
    // 按 tableName 分组数据行
    const tableData = new Map<string, {
      schema: SchemaSummary;
      dataRows: Array<{ rawLine: string; lineNumber: number }>;
    }>();

    for (const block of blocks) {
      if (block.fenceKind !== 'mddb' || block.dataLines.length === 0) continue;

      // 确定该数据块的 Schema
      const tableSchema = this.resolveBlockSchema(block, schemaMap, fileContent, filePath);
      if (!tableSchema) continue;

      const tableName = tableSchema.table;

      if (!tableData.has(tableName)) {
        tableData.set(tableName, { schema: tableSchema, dataRows: [] });
      }

      const entry = tableData.get(tableName)!;

      for (const [idx, rawLine] of block.dataLines.entries()) {
        const physicalLine = block.startLine + 1 + idx;
        entry.dataRows.push({ rawLine, lineNumber: physicalLine });
      }
    }

    // ── 第三遍：类型转换 + 校验 + 写入 ──
    const parsedTables: ParsedTable[] = [];

    for (const [tableName, { schema, dataRows }] of tableData) {
      if (dataRows.length === 0) continue;

      // 转换
      const allRecords: Array<{ rawValues: unknown[]; rawLine: string; lineNumber: number }> = [];

      for (const { rawLine, lineNumber } of dataRows) {
        const rawFields = splitFields(rawLine);

        const { values, errors } = convertRowFields(
          rawFields,
          schema.types,
          schema.nullMarker,
        );

        for (const e of errors) {
          allErrors.push({ ...e, file: filePath });
        }

        allRecords.push({
          rawValues: values,
          rawLine,
          lineNumber,
        });
      }

      // 校验
      const validateResult = validateRows(
        allRecords,
        schema,
        {
          strict: schema.strict,
          nullMarker: schema.nullMarker,
          existingLogicalPks: new Set(),
          tableName: schema.table,
          fileName: filePath,
        },
      );

      for (const e of validateResult.errors) {
        allErrors.push({ ...e, file: filePath });
      }

      // 写入
      const bindingRows = writeRecords(
        validateResult.records,
        schema,
        context,
        {
          filePath,
          blockId: `blk_${simpleHash(filePath + tableName)}`,
          blockIndex: 0,
          nullMarker: schema.nullMarker,
        },
      );

      parsedTables.push({
        tableName,
        schema,
        records: validateResult.records.map(r => r.values as unknown[]),
        bindingRows,
        errorCount: validateResult.errorCount,
        warningCount: validateResult.warningCount,
      });
    }

    const totalErrors = parsedTables.reduce((s, t) => s + t.errorCount, 0);
    const totalWarnings = parsedTables.reduce((s, t) => s + t.warningCount, 0);

    return {
      filePath,
      tables: parsedTables,
      totalErrors,
      totalWarnings,
      allErrors,
    };
  }

  /**
   * 解析单个 mddb 数据块对应的 Schema
   *
   * 搜索顺序：
   * 1. infoString 中 schema=xxx → 查 schemaMap
   * 2. 块内含 @ 指令 → 已由第一遍处理
   * 3. frontmatter → 由 resolveSchema 内部处理
   */
  private resolveBlockSchema(
    block: MddbBlock,
    schemaMap: Map<string, SchemaSummary>,
    fileContent: string,
    filePath: string,
  ): SchemaSummary | null {
    // 如果块内含 @ 指令，schemaMap 已有
    if (block.directives.length > 0) {
      const dirSchema = resolveSchema(
        block.directives,
        block.infoString,
        fileContent,
        {
          identifierMode: this.config.identifierMode,
          vaultRoot: this.config.vaultRoot,
          currentFilePath: filePath,
        },
      );
      return dirSchema;
    }

    // 从 info string 提取表名
    const infoMatch = block.infoString.match(/\bschema=(\S+)/);
    const tableNameFromInfo = infoMatch ? infoMatch[1]! : null;

    if (tableNameFromInfo && schemaMap.has(tableNameFromInfo)) {
      return schemaMap.get(tableNameFromInfo)!;
    }

    // 如果只有一个 schema 定义在文件中，自动匹配
    if (schemaMap.size === 1) {
      return schemaMap.values().next().value!;
    }

    // 尝试从 frontmatter 解析
    if (schemaMap.size === 0) {
      try {
        const schema = resolveSchema(
          [],
          block.infoString,
          fileContent,
          {
            identifierMode: this.config.identifierMode,
            vaultRoot: this.config.vaultRoot,
            currentFilePath: filePath,
          },
        );
        schemaMap.set(schema.table, schema);
        return schema;
      } catch {
        return null;
      }
    }

    // 无法确定 Schema
    return null;
  }
}

// ============================================================
// 辅助
// ============================================================

function simpleHash(str: string): string {
  let hash = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
