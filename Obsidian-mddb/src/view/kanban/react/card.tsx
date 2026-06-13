import React, { useState, useRef, useCallback } from 'react';
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
  const [isEditing, setIsEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({
      cardId: card.id,
      fromLane: '',
    }));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart(card.id, e);
  }, [card.id, onDragStart]);

  return (
    <div
      className="mddb-kanban-item-wrapper"
      draggable
      onDragStart={handleDragStart}
    >
      <div ref={cardRef} className="mddb-kanban-item">
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
              isEditing={isEditing}
              onStartEdit={() => setIsEditing(true)}
              onCommit={(val) => {
                setIsEditing(false);
                if (val !== card.title) {
                  const titleField = Object.keys(card.raw).find(k =>
                    card.raw[k] === card.title && k !== 'storage_pk'
                  );
                  if (titleField) {
                    onUpdateField(card.id, titleField, val);
                  }
                }
              }}
              onCancel={() => setIsEditing(false)}
              searchQuery={searchQuery}
            />
            <a
              className="mddb-kanban-item-menu-button clickable-icon"
              onClick={(e) => {
                e.stopPropagation();
                const Menu = (window as any).Menu;
                const menu = Menu ? new Menu() : null;
                if (menu) {
                  menu.addItem((item: any) => item
                    .setTitle('Edit')
                    .setIcon('pencil')
                    .onClick(() => onEdit(card.id))
                  );
                  menu.addItem((item: any) => item
                    .setTitle('Delete')
                    .setIcon('trash')
                    .onClick(() => onDelete(card.id))
                  );
                  menu.showAtMouseEvent(e);
                }
              }}
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
