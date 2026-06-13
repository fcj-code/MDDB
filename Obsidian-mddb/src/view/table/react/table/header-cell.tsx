import React from 'react';
import type { ViewColumn } from '../../../shared/types';
import ColumnResizeHandle from './column-resize-handle';

interface Props {
  column: ViewColumn;
  sortField?: string;
  sortDirection?: 'ASC' | 'DESC';
  onSort: () => void;
  onWidthChange: (colName: string, delta: number) => void;
  onResetWidth: (colName: string) => void;
}

export default function HeaderCell({ column, sortField, sortDirection, onSort, onWidthChange, onResetWidth }: Props) {
  const isSorted = sortField === column.name;
  const sortArrow = isSorted
    ? sortDirection === 'ASC' ? ' ↑' : ' ↓'
    : '';

  return (
    <div
      className="mddb-react-cell mddb-react-cell--header"
      onClick={onSort}
      style={{
        textAlign: column.align ?? 'left',
        cursor: 'pointer',
        width: column.width ?? 150,
        minWidth: 60,
        position: 'relative',
      }}
    >
      <span className="mddb-react-header-text">
        {column.label ?? column.name}
        {sortArrow}
      </span>
      <ColumnResizeHandle
        columnName={column.name}
        onWidthChange={onWidthChange}
        onDoubleClick={onResetWidth}
      />
    </div>
  );
}
