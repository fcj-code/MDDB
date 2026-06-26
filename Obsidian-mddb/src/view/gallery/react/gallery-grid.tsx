import React from 'react';
import type { GalleryCard } from '../gallery-view-model';
import type { ViewStatus } from '../../shared/types';
import { GalleryCard as GalleryCardView } from './card';

interface GalleryGridProps {
  cards: GalleryCard[];
  status: ViewStatus;
  error?: string;
  gridColumns?: number;
  onEdit: (cardId: string) => void;
  onDelete: (cardId: string) => void;
  onAdd: () => void;
}

export function GalleryGrid({
  cards,
  status,
  error,
  gridColumns,
  onEdit,
  onDelete,
  onAdd,
}: GalleryGridProps) {
  const gridStyle: React.CSSProperties = gridColumns
    ? { gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }
    : {};

  if (status === 'loading') {
    return <div className="mddb-gallery-status">Loading…</div>;
  }
  if (status === 'error') {
    return (
      <div className="mddb-gallery-status mddb-error">
        {error ?? 'Failed to load gallery.'}
      </div>
    );
  }

  return (
    <div className="mddb-gallery">
      <div className="mddb-gallery-toolbar">
        <button className="mddb-gallery-add" onClick={onAdd}>+ Add</button>
      </div>

      {cards.length === 0 ? (
        <div className="mddb-gallery-empty">No cards yet.</div>
      ) : (
        <div
          className={gridColumns ? 'mddb-gallery-grid fixed' : 'mddb-gallery-grid'}
          style={gridStyle}
        >
          {cards.map(card => (
            <GalleryCardView
              key={card.id}
              card={card}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
