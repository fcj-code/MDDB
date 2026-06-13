import React, { useState, useRef, useEffect } from 'react';

interface CardTitleProps {
  title: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  searchQuery?: string;
}

export function CardTitle({
  title,
  isEditing,
  onStartEdit,
  onCommit,
  onCancel,
  searchQuery,
}: CardTitleProps) {
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing, title]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className="mddb-kanban-item-title-input"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onCommit(editValue);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={() => onCommit(editValue)}
      />
    );
  }

  return (
    <div
      className="mddb-kanban-item-title"
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
    >
      {searchQuery ? highlightText(title, searchQuery) : title}
    </div>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
