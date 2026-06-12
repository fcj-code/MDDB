/**
 * 词法分析器 (Lexer)
 *
 * 识别 mddb 围栏块、分类行、切分字段。
 *
 * 参考：parse-pipeline-design.md §3
 */

// ============================================================
// 行分类
// ============================================================

export enum LineKind {
  /** Schema 指令行（@ 开头） */
  Directive = 'directive',
  /** 数据行 */
  Data = 'data',
  /** 空行 */
  Empty = 'empty',
  /** 非 mddb 围栏块内容（自由文本） */
  FreeText = 'free-text',
}

export interface ClassifiedLine {
  kind: LineKind;
  raw: string;
  lineNumber: number;
}

// ============================================================
// mddb 块检测
// ============================================================

export interface MddbBlock {
  /** 围栏类型 */
  fenceKind: 'mddb' | 'dmdb-schema';
  /** 起始行号（围栏行） */
  startLine: number;
  /** 结束行号（围栏行） */
  endLine: number;
  /** 信息字符串（如 schema=transactions） */
  infoString: string;
  /** 块内内容（不含围栏） */
  content: string[];
  /** 分类后的行 */
  lines: ClassifiedLine[];
  /** 块内 @ 指令行 */
  directives: string[];
  /** 块内数据行 */
  dataLines: string[];
}

// ============================================================
// 字段切分
// ============================================================

const NONPIPE = '\x00NP';
const BSLASH = '\x00BS';

/**
 * 转义感知的字段切分
 *
 * 输入: "2024-06-01 | -45.00 | 支出 | 餐饮 | 支付宝\\|微信 | -"
 * 输出: ["2024-06-01", "-45.00", "支出", "餐饮", "支付宝|微信", "-"]
 */
export function splitFields(raw: string): string[] {
  // 1. 替换转义序列
  const escaped = raw
    .replace(/\\\|/g, NONPIPE)
    .replace(/\\\\/g, BSLASH);

  // 2. split('|')
  const parts = escaped.split('|');

  // 3. 每个片段还原
  return parts.map(part => part
    .replace(new RegExp(NONPIPE, 'g'), '|')
    .replace(new RegExp(BSLASH, 'g'), '\\')
    .trim(),
  );
}

/**
 * 检测空值
 *
 * 规则：
 * - trimmed == '' → NULL
 * - trimmed == nullMarker（默认 "-"）→ NULL
 */
export function isNullValue(value: string, nullMarker: string): boolean {
  return value === '' || value === nullMarker;
}

// ============================================================
// 行分类器
// ============================================================

/** 对单独一行进行分类 */
export function classifyLine(rawLine: string, lineNumber: number): ClassifiedLine {
  const trimmed = rawLine.trim();

  if (trimmed.length === 0) {
    return { kind: LineKind.Empty, raw: rawLine, lineNumber };
  }

  if (trimmed.startsWith('@')) {
    return { kind: LineKind.Directive, raw: rawLine, lineNumber };
  }

  return { kind: LineKind.Data, raw: rawLine, lineNumber };
}

// ============================================================
// 围栏块检测
// ============================================================

const FENCE_PATTERN = /^(`{3,})\s*(mddb|dmdb-schema)(\s+.*)?$/;
const CLOSE_FENCE_PATTERN = /^(`{3,})\s*$/;

/**
 * 从完整文件内容中提取所有 mddb 围栏块
 */
export function extractBlocks(lines: string[]): MddbBlock[] {
  const blocks: MddbBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }

    const match = line.match(FENCE_PATTERN);
    if (match) {
      const fenceKind = match[2] as 'mddb' | 'dmdb-schema';
      const infoString = (match[3]?.trim() ?? '');
      const startLine = i;
      const contentLines: string[] = [];
      i++;

      // 找闭合围栏
      while (i < lines.length) {
        const innerLine = lines[i]!;
        if (CLOSE_FENCE_PATTERN.test(innerLine)) {
          break;
        }
        contentLines.push(innerLine);
        i++;
      }

      const endLine = i;
      i++; // 跳过闭合围栏

      // 分类
      const classified: ClassifiedLine[] = [];
      const directives: string[] = [];
      const dataLines: string[] = [];

      for (const [idx, rawLine] of contentLines.entries()) {
        const cl = classifyLine(rawLine, startLine + 1 + idx);
        classified.push(cl);
        if (cl.kind === LineKind.Directive) {
          directives.push(rawLine);
        } else if (cl.kind === LineKind.Data) {
          dataLines.push(rawLine);
        }
        // Empty lines are skipped
      }

      blocks.push({
        fenceKind,
        startLine,
        endLine,
        infoString,
        content: contentLines,
        lines: classified,
        directives,
        dataLines,
      });
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * 将 mddb 围栏块中的内容解析为指令行和数据行的联合
 * 适用于单围栏格式（v2 模式）：
 * ```mddb
 * @table accounts
 * @fields ...
 * data | data
 * ```
 *
 * 如果 fenceKind 是 dmdb-schema，则只取 directives。
 * 如果 fenceKind 是 mddb 且包含 directives，则指令与数据在同一块。
 */
export function extractSchemaAndData(block: MddbBlock): {
  directives: string[];
  dataLines: string[];
  tableNameFromInfo: string | null;
} {
  const infoTable = parseInfoField(block.infoString);

  if (block.fenceKind === 'dmdb-schema') {
    return {
      directives: block.directives,
      dataLines: [],
      tableNameFromInfo: null,
    };
  }

  // mddb block: return directives + data
  return {
    directives: block.directives,
    dataLines: block.dataLines,
    tableNameFromInfo: infoTable,
  };
}

/** 从 infoString 提取 table 名 */
function parseInfoField(infoString: string): string | null {
  const match = infoString.match(/\bschema=(\S+)/);
  return match ? match[1]! : null;
}
