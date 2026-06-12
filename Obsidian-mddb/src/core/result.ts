/**
 * MD-DB ResultOrError 类型
 *
 * 函数式 Either 风格的结果类型，避免抛出异常作为常规控制流。
 */

import type { EngineError } from './errors';

/** 成功结果 */
export interface OkResult<T> {
  ok: true;
  value: T;
}

/** 失败结果 */
export interface ErrResult {
  ok: false;
  error: EngineError;
}

/** Either<T, EngineError> */
export type ResultOrError<T> = OkResult<T> | ErrResult;

/** 创建成功结果 */
export function ok<T>(value: T): OkResult<T> {
  return { ok: true, value };
}

/** 创建失败结果 */
export function err<T = never>(error: EngineError): ErrResult {
  return { ok: false, error };
}
