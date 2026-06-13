import React, { useState, useRef, useCallback } from 'react';
import type { Lane as LaneData } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';
import { LaneHeader } from './lane-header';
import { Card } from './card';
import { CardForm } from './card-form';

interface LaneProps {
  lane: LaneData;
  viewModel: KanbanViewModel;
  searchQuery?: string;
  onDragStart: (cardId: string, e: React.DragEvent) => void;
  onEditCard: (cardId: string) => void;
  onAddCard: (laneId: string) => void;
}

export function Lane({ lane, viewModel, searchQuery, onDragStart, onEditCard, onAddCard }: LaneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.cardId) {
        viewModel.moveCard(data.cardId, data.fromLane, lane.id, 0);
      }
    } catch { /* ignore parse errors */ }
  }, [viewModel, lane.id]);

  const filteredCards = searchQuery
    ? lane.cards.filter(c =>
        c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        Object.values(c.metadata).some(v =>
          String(v).toLowerCase().includes(searchQuery.toLowerCase())
        )
      )
    : lane.cards;

  return (
    <div className="mddb-kanban-lane-wrapper">
      <div
        ref={laneRef}
        className={`mddb-kanban-lane ${lane.collapsed ? 'collapse-horizontal' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={isDragOver ? { outline: '2px dashed var(--interactive-accent)' } : undefined}
      >
        <LaneHeader
          lane={lane}
          onToggleCollapse={() => viewModel.toggleLaneCollapse(lane.id)}
          onMenuOpen={() => {}}
        />

        {!lane.collapsed && (
          <>
            <div className="mddb-kanban-lane-items">
              {filteredCards.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  searchQuery={searchQuery}
                  onDelete={(id) => viewModel.deleteCard(id)}
                  onEdit={onEditCard}
                  onUpdateField={(id, field, value) => viewModel.updateCardField(id, field, value)}
                  onDragStart={(id, e) => onDragStart(id, e)}
                />
              ))}
            </div>
            <CardForm onOpenForm={() => onAddCard(lane.id)} />
          </>
        )}
      </div>
    </div>
  );
}
