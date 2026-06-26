import React, { useState, useCallback } from 'react';
import type { GalleryViewModel, GalleryCard } from '../gallery-view-model';
import { GalleryGrid } from './gallery-grid';
import { EditModal } from '../../kanban/react/edit-modal';
import './styles.css';

interface GalleryAppProps {
  viewModel: GalleryViewModel;
}

export function GalleryApp({ viewModel }: GalleryAppProps) {
  const [data, setData] = useState(() => viewModel.data);
  const [status, setStatus] = useState(() => viewModel.status);
  const [error, setError] = useState(() => viewModel.error);
  const [editCard, setEditCard] = useState<GalleryCard | null>(null);
  const [adding, setAdding] = useState(false);

  React.useEffect(() => {
    const update = () => {
      setData({ ...viewModel.data });
      setStatus(viewModel.status);
      setError(viewModel.error);
    };
    const unsub1 = viewModel.events.on('state-changed', update);
    const unsub2 = viewModel.events.on('data-changed', update);
    return () => { unsub1(); unsub2(); };
  }, [viewModel]);

  const handleEdit = useCallback((cardId: string) => {
    const card = viewModel.data.cards.find(c => c.id === cardId);
    if (card) setEditCard(card);
  }, [viewModel]);

  const handleDelete = useCallback(async (cardId: string) => {
    await viewModel.deleteCard(cardId);
  }, [viewModel]);

  const handleSaveEdit = useCallback(async (values: Record<string, unknown>) => {
    if (!editCard) return;
    await viewModel.updateRecord(editCard.id, values);
    setEditCard(null);
  }, [editCard, viewModel]);

  const handleSaveAdd = useCallback(async (values: Record<string, unknown>) => {
    await viewModel.addCard(values);
    setAdding(false);
  }, [viewModel]);

  return (
    <div className="mddb-gallery">
      <GalleryGrid
        cards={data.cards}
        status={status}
        error={error}
        gridColumns={viewModel.config.gridColumns}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onAdd={() => setAdding(true)}
      />

      {editCard && (
        <EditModal
          engine={viewModel.getEngine()}
          table={viewModel.config.table}
          initialValues={editCard.raw}
          title={`Edit: ${editCard.title}`}
          onSave={handleSaveEdit}
          onClose={() => setEditCard(null)}
        />
      )}

      {adding && (
        <EditModal
          engine={viewModel.getEngine()}
          table={viewModel.config.table}
          title={`New — ${viewModel.config.table}`}
          onSave={handleSaveAdd}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
