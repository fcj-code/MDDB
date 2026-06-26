import React, { useCallback } from 'react';
import { Menu } from 'obsidian';
import type { GalleryCard } from '../gallery-view-model';

interface GalleryCardProps {
  card: GalleryCard;
  onEdit: (cardId: string) => void;
  onDelete: (cardId: string) => void;
}

export function GalleryCard({ card, onEdit, onDelete }: GalleryCardProps) {
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
      .onClick(() => onEdit(card.id)),
    );
    menu.addItem((item) => item
      .setTitle('Delete')
      .setIcon('trash')
      .onClick(() => onDelete(card.id)),
    );
    menu.showAtMouseEvent(e.nativeEvent);
  }, [card.id, onEdit, onDelete]);

  return (
    <div className="mddb-gallery-card" onDoubleClick={handleDoubleClick}>
      <div className="mddb-gallery-card-image">
        {card.imageUrl ? (
          <img src={card.imageUrl} alt={card.title} loading="lazy" />
        ) : (
          <div className="mddb-gallery-card-image-placeholder">🖼</div>
        )}
        <a
          className="mddb-gallery-card-menu clickable-icon"
          onClick={handleMenuClick}
        >
          ⋮
        </a>
      </div>
      <div className="mddb-gallery-card-body">
        <div className="mddb-gallery-card-title">{card.title}</div>
        <div className="mddb-gallery-card-meta">
          {Object.entries(card.metadata).map(([key, value]) => (
            <div key={key} className="mddb-gallery-card-meta-row">
              <span className="mddb-gallery-card-meta-key">{key}</span>
              <span className="mddb-gallery-card-meta-val">
                {value === null || value === undefined ? '' : String(value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
