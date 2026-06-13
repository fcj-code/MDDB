import React, { useState } from 'react';

interface CardFormProps {
  onAdd: (title: string) => void;
}

export function CardForm({ onAdd }: CardFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue('');
  };

  if (!isOpen) {
    return (
      <div className="mddb-kanban-add-card-btn" onClick={() => setIsOpen(true)}>
        + Add a card
      </div>
    );
  }

  return (
    <div className="mddb-kanban-item-form">
      <input
        className="mddb-kanban-item-form-input"
        placeholder="Card title..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') { setIsOpen(false); setValue(''); }
        }}
        autoFocus
      />
      <div className="mddb-kanban-item-form-actions">
        <button className="mddb-kanban-item-form-add-btn" onClick={handleSubmit}>
          Add
        </button>
        <button
          className="mddb-kanban-item-form-cancel-btn"
          onClick={() => { setIsOpen(false); setValue(''); }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
