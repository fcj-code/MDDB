/**
 * 结果组装器 (ResultAssembler)
 *
 * 将 sql.js 的原始结果格式化为 ResultSet。
 *
 * 参考：query-engine-design.md §8, §14
 */

import type { ColumnMeta, FieldType } from '../core/types';
import type { ResultSet, Query } from './types';
import { formatDisplayValue } from '../parse/converter';
import { parseTypeExpr } from '../parse/converter';

export class ResultAssembler {
  /**
   * 将 SQLite 原始结果组装为 ResultSet
   */
  assemble(
    columns: string[],
    rows: unknown[][],
    query: Query,
    typeMap: Map<string, FieldType>,
  ): ResultSet {
    // 构建 ColumnMeta
    const colMetas: ColumnMeta[] = columns.map(col => ({
      name: col,
      type: typeMap.get(col) ?? 'string',
    }));

    // 构建行对象
    const rowObjects = rows.map(row => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i]!;
        const typeExpr = typeMap.get(col) ?? 'string';
        let value = row[i];

        // decimal 格式化
        if (value !== null && value !== undefined) {
          const { typeName } = parseTypeExpr(typeExpr);
          if (typeName === 'decimal') {
            value = formatDisplayValue(value, typeExpr);
          } else if (typeName === 'boolean') {
            value = formatDisplayValue(value, typeExpr);
          }
        }

        obj[col] = value;
      }
      return obj;
    });

    return {
      rows: rowObjects,
      columns: colMetas,
      total: rowObjects.length,
      returned: rowObjects.length,
    };
  }

  /**
   * 从 SQLite query 结果中提取列类型映射
   */
  extractTypeMap(
    columns: string[],
    schemaFields: string[],
    schemaTypes: FieldType[],
  ): Map<string, FieldType> {
    const typeMap = new Map<string, FieldType>();

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]!;
      const fieldIdx = schemaFields.indexOf(col);
      if (fieldIdx >= 0) {
        typeMap.set(col, schemaTypes[fieldIdx] ?? 'string');
      } else {
        typeMap.set(col, 'string');
      }
    }

    return typeMap;
  }
}
