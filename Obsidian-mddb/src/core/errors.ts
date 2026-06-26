/**
 * MD-DB 错误类型
 *
 * 定义全局错误码、错误类、错误收集结构。
 */

// ============================================================
// 解析错误码
// ============================================================

export enum ParseErrorCode {
  TYPE_CAST_FAILED = 'TYPE_CAST_FAILED',
  FIELD_COUNT_MISMATCH = 'FIELD_COUNT_MISMATCH',
  REQUIRED_MISSING = 'REQUIRED_MISSING',
  PK_DUPLICATE = 'PK_DUPLICATE',
  SCHEMA_INVALID = 'SCHEMA_INVALID',
  STRICT_ROW_SKIPPED = 'STRICT_ROW_SKIPPED',
}

// ============================================================
// 解析错误/警告
// ============================================================

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  table?: string;
  file?: string;
  lineNumber?: number;
  field?: string;
  rawValue?: string;
}

export interface ParseWarning {
  code: string;
  message: string;
  table?: string;
  file?: string;
  lineNumber?: number;
  field?: string;
}

// ============================================================
// 引擎错误
// ============================================================

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly table?: string,
    public readonly file?: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export class SchemaError extends EngineError {
  constructor(message: string, table?: string) {
    super(message, 'SCHEMA_ERROR', table);
    this.name = 'SchemaError';
  }
}

export class QueryError extends EngineError {
  constructor(message: string, table?: string) {
    super(message, 'QUERY_ERROR', table);
    this.name = 'QueryError';
  }
}

export class WriteError extends EngineError {
  constructor(message: string, table?: string, file?: string) {
    super(message, 'WRITE_ERROR', table, file);
    this.name = 'WriteError';
  }
}

export class ConflictError extends EngineError {
  constructor(
    message: string,
    public readonly conflictingFiles: string[],
    table?: string,
  ) {
    super(message, 'CONFLICT_ERROR', table);
    this.name = 'ConflictError';
  }
}

/** 单字段校验错误 */
export interface FieldValidationError {
  field: string;
  message: string;
}

export class ValidationError extends EngineError {
  constructor(
    message: string,
    public readonly fieldErrors: FieldValidationError[],
    table?: string,
  ) {
    super(message, 'VALIDATION_ERROR', table);
    this.name = 'ValidationError';
  }
}
