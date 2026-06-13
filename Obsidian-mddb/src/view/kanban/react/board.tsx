import React, { useState, useCallback } from 'react';
import type { KanbanBoard, Card } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';
import { Lane } from './lane';
import { SearchBar } from './search-bar';
import { EditModal } from './edit-modal';

interface BoardProps {
  board: KanbanBoard;
  viewModel: KanbanViewModel;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onDragStart: (cardId: string, e: React.DragEvent) => void;
}

export function Board({
  board,
  viewModel,
  searchQuery,
  onSearchChange,
  onDragStart,
}: BoardProps) {
  const [editCard, setEditCard] = useState<Card | null>(null);
  const [addCardLaneId, setAddCardLaneId] = useState<string | null>(null);

  const handleEditCard = useCallback((cardId: string) => {
    const card = board.lanes.flatMap(l => l.cards).find(c => c.id === cardId);
    if (card) setEditCard(card);
  }, [board.lanes]);

  const handleSaveEdit = useCallback(async (values: Record<string, unknown>) => {
    if (!editCard) return;
    await viewModel.updateRecord(editCard.id, values);
    setEditCard(null);
  }, [editCard, viewModel]);

  const handleSaveAdd = useCallback(async (values: Record<string, unknown>) => {
    if (!addCardLaneId) return;
    await viewModel.addCard(addCardLaneId, values);
    setAddCardLaneId(null);
  }, [addCardLaneId, viewModel]);

  if (board.lanes.length === 0) {
    return (
      <div className="mddb-kanban">
        <div className="mddb-kanban-empty">
          No data — add records to "{viewModel.config.table}" to see them here.
        </div>
      </div>
    );
  }

  return (
    <div className="mddb-kanban">
      <SearchBar
        value={searchQuery}
        onChange={onSearchChange}
        onCancel={() => {}}
      />
      <div className="mddb-kanban-board">
        {board.lanes.map((lane) => (
          <Lane
            key={lane.id}
            lane={lane}
            viewModel={viewModel}
            searchQuery={searchQuery}
            onDragStart={onDragStart}
            onEditCard={handleEditCard}
            onAddCard={setAddCardLaneId}
            onLaneDrop={(targetId, draggedId) => viewModel.moveLane(draggedId, targetId)}
          />
        ))}
      </div>

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

      {addCardLaneId && (
        <EditModal
          engine={viewModel.getEngine()}
          table={viewModel.config.table}
          title={`New card — ${viewModel.config.table}`}
          onSave={handleSaveAdd}
          onClose={() => setAddCardLaneId(null)}
        />
      )}
    </div>
  );
}
