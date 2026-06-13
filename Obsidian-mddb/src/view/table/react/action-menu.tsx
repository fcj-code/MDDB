import React from 'react';

interface Props {
  storagePk: string;
  cells: Record<string, unknown>;
  onEdit: (storagePk: string, cells: Record<string, unknown>) => void;
  onDelete: (storagePk: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

export default function ActionMenu({ storagePk, cells, onEdit, onDelete, isOpen, onToggle }: Props) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onToggle();
      }
    };
    setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => document.removeEventListener('click', handleClick);
  }, [isOpen, onToggle]);

  return (
    <div className="mddb-action-cell" ref={menuRef}>
      <button
        className="mddb-action-btn"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        ⠿
      </button>
      {isOpen && (
        <div className="mddb-action-menu">
          <div
            className="mddb-context-item"
            onClick={(e) => { e.stopPropagation(); onEdit(storagePk, cells); }}
          >
            ✏️ 编辑
          </div>
          <div
            className="mddb-context-item"
            onClick={(e) => { e.stopPropagation(); onDelete(storagePk); }}
          >
            🗑️ 删除
          </div>
        </div>
      )}
    </div>
  );
}
