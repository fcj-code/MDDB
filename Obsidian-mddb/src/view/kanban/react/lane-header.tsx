import React, { useState, useRef, useEffect } from 'react';
import type { Lane } from '../kanban-view-model';

interface LaneHeaderProps {
  lane: Lane;
  onToggleCollapse: () => void;
  onTitleChange?: (title: string) => void;
  onMenuOpen: (e: React.MouseEvent) => void;
}

export function LaneHeader({
  lane,
  onToggleCollapse,
  onTitleChange,
  onMenuOpen,
}: LaneHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(lane.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(lane.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing, lane.title]);

  const overLimit = lane.maxItems !== undefined && lane.cardCount > lane.maxItems;

  return (
    <div className="mddb-kanban-lane-header-wrapper">
      <div className="mddb-kanban-lane-grip">
        ⠿
      </div>
      <div
        className={`mddb-kanban-lane-collapse ${lane.collapsed ? 'is-collapsed' : ''}`}
        onClick={onToggleCollapse}
      >
        ▾
      </div>
      {isEditing ? (
        <input
          ref={inputRef}
          className="mddb-kanban-lane-title-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onTitleChange?.(editValue);
              setIsEditing(false);
            }
            if (e.key === 'Escape') setIsEditing(false);
          }}
          onBlur={() => {
            onTitleChange?.(editValue);
            setIsEditing(false);
          }}
        />
      ) : (
        <div
          className="mddb-kanban-lane-title"
          onDoubleClick={() => setIsEditing(true)}
        >
          {lane.title}
        </div>
      )}
      <div className={`mddb-kanban-lane-counter ${overLimit ? 'is-over-limit' : ''}`}>
        {lane.cardCount}{lane.maxItems !== undefined ? `/${lane.maxItems}` : ''}
      </div>
      <div className="mddb-kanban-lane-settings-button-wrapper">
        <a
          className="mddb-kanban-lane-settings-button clickable-icon"
          onClick={onMenuOpen}
          aria-label="More options"
        >
          ⋮
        </a>
      </div>
    </div>
  );
}
