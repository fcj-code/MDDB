import React from 'react';

interface Props {
  columnName: string;
  onWidthChange: (colName: string, delta: number) => void;
  onDoubleClick?: (colName: string) => void;
}

/**
 * 列宽拖拽手柄 — 参考 DataLoom 实现
 */
export default function ColumnResizeHandle({ columnName, onWidthChange, onDoubleClick }: Props) {
  const mouseDownX = React.useRef(0);
  const [dragging, setDragging] = React.useState(false);

  function handleMouseMove(e: MouseEvent) {
    const dist = e.pageX - mouseDownX.current;
    onWidthChange(columnName, dist);
  }

  function handleMouseUp() {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    setDragging(false);
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.detail >= 2) return; // ignore double-click
    e.preventDefault();
    e.stopPropagation();
    mouseDownX.current = e.pageX;
    setDragging(true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }

  const className = 'mddb-col-resize-handle' + (dragging ? ' mddb-col-resize-handle--dragging' : '');

  return (
    <div
      className={className}
      onMouseDown={handleMouseDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.(columnName);
      }}
    />
  );
}
