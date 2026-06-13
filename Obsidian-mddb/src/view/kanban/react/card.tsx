import React, { useRef, useCallback } from 'react';
import { Menu } from 'obsidian';
import type { Card as CardData } from '../kanban-view-model';
import { CardTitle } from './card-title';
import { CardMetadata } from './card-metadata';

interface CardProps {
  card: CardData;
  searchQuery?: string;
  onDelete: (cardId: string) => void;
  onEdit: (cardId: string) => void;
  onUpdateField: (cardId: string, field: string, value: unknown) => void;
  onDragStart: (cardId: string, e: React.DragEvent) => void;
}

export function Card({
  card,
  searchQuery,
  onDelete,
  onEdit,
  onUpdateField,
  onDragStart,
}: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({
      cardId: card.id,
      fromLane: '',
    }));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart(card.id, e);
  }, [card.id, onDragStart]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit(card.id);
  }, [card.id, onEdit]);

  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle('Edit')
      .setIcon('pencil')
      .onClick(() => onEdit(card.id))
    );
    menu.addItem((item) => item
      .setTitle('Delete')
      .setIcon('trash')
      .onClick(() => onDelete(card.id))
    );
    menu.showAtMouseEvent(e.nativeEvent);
  }, [card.id, onEdit, onDelete]);

  return (
    <div
      className="mddb-kanban-item-wrapper"
      draggable
      onDragStart={handleDragStart}
    >
      <div ref={cardRef} className="mddb-kanban-item" onDoubleClick={handleDoubleClick}>
        <div className="mddb-kanban-item-content-wrapper">
          <div className="mddb-kanban-item-title-wrapper">
            <input
              type="checkbox"
              className="mddb-kanban-item-checkbox"
              checked={card.checked ?? false}
              onChange={(e) => onUpdateField(card.id, 'checked', e.target.checked)}
            />
            <CardTitle
              title={card.title}
              searchQuery={searchQuery}
            />
            <a
              className="mddb-kanban-item-menu-button clickable-icon"
              onClick={handleMenuClick}
            >
              ⋮
            </a>
          </div>
          <CardMetadata metadata={card.metadata} searchQuery={searchQuery} />
        </div>
      </div>
    </div>
  );
}
