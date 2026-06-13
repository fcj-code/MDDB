import React from 'react';
import type { KanbanViewModel } from '../kanban-view-model';
import { Board } from './board';
import './styles.css';

interface KanbanAppProps {
  viewModel: KanbanViewModel;
}

export function KanbanApp({ viewModel }: KanbanAppProps) {
  const [board, setBoard] = React.useState(() => viewModel.board);
  const [searchQuery, setSearchQuery] = React.useState('');

  React.useEffect(() => {
    const update = () => setBoard({ ...viewModel.board });
    const unsub1 = viewModel.events.on('state-changed', update);
    const unsub2 = viewModel.events.on('data-changed', update);
    return () => { unsub1(); unsub2(); };
  }, [viewModel]);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    viewModel.setSearchQuery(query);
  };

  return (
    <Board
      board={board}
      viewModel={viewModel}
      searchQuery={searchQuery}
      onSearchChange={handleSearchChange}
      onDragStart={() => {}}
    />
  );
}
