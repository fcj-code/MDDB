import React from 'react';

interface CardFormProps {
  onOpenForm: () => void;
}

export function CardForm({ onOpenForm }: CardFormProps) {
  return (
    <div className="mddb-kanban-add-card-btn" onClick={onOpenForm}>
      + Add a card
    </div>
  );
}
