import React from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
}

export function SearchBar({ value, onChange, onCancel }: SearchBarProps) {
  return (
    <div className="mddb-kanban-search-wrapper">
      <input
        className="mddb-kanban-filter-input"
        type="text"
        placeholder="Search..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            onCancel();
          }
        }}
      />
      {value && (
        <a
          className="mddb-kanban-search-cancel-button clickable-icon"
          onClick={() => { onChange(''); onCancel(); }}
          aria-label="Cancel"
        >
          ✕
        </a>
      )}
    </div>
  );
}
