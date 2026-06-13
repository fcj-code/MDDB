import React from 'react';
import type { KanbanBoard } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';
import { Lane } from './lane';
import { SearchBar } from './search-bar';

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
          />
        ))}
      </div>
    </div>
  );
}
