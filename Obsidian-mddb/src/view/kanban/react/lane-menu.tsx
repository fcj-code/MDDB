import React from 'react';
import type { Lane } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';

interface LaneMenuProps {
  lane: Lane;
  viewModel: KanbanViewModel;
  onClose: () => void;
}

export function LaneMenu({ lane, viewModel, onClose }: LaneMenuProps) {
  const handleArchiveAll = async () => {
    for (const card of lane.cards) {
      await viewModel.updateCardField(card.id, viewModel.config.groupBy, 'archived');
    }
    onClose();
  };

  const handleArchiveDone = async () => {
    for (const card of lane.cards) {
      if (card.checked) {
        await viewModel.updateCardField(card.id, viewModel.config.groupBy, 'archived');
      }
    }
    onClose();
  };

  const handleDeleteLane = async () => {
    if (!confirm(`Delete all ${lane.cardCount} cards in "${lane.title}"?`)) return;
    for (const card of lane.cards) {
      await viewModel.deleteCard(card.id);
    }
    onClose();
  };

  return (
    <div style={{
      position: 'absolute',
      background: 'var(--background-primary)',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      zIndex: 100,
      minWidth: '180px',
      padding: '4px 0',
    }}>
      <div style={{ padding: '4px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>
        WIP Limit: {lane.maxItems ?? '—'}
      </div>
      <div style={{ borderTop: '1px solid var(--background-modifier-border)', margin: '4px 0' }} />
      <MenuItem onClick={handleArchiveAll}>Archive all</MenuItem>
      <MenuItem onClick={handleArchiveDone}>Archive done</MenuItem>
      <div style={{ borderTop: '1px solid var(--background-modifier-border)', margin: '4px 0' }} />
      <MenuItem onClick={handleDeleteLane} danger>Delete list</MenuItem>
    </div>
  );
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 12px',
        cursor: 'pointer',
        fontSize: '13px',
        color: danger ? 'var(--text-error)' : 'var(--text-normal)',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--background-modifier-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </div>
  );
}
