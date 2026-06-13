import React, { useState } from 'react';

interface LaneFormProps {
  onAddLane: (title: string) => void;
}

export function LaneForm({ onAddLane }: LaneFormProps) {
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAddLane(trimmed);
    setValue('');
  };

  return (
    <div className="mddb-kanban-lane-form">
      <input
        className="mddb-kanban-lane-form-input"
        placeholder="Add a list..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
        }}
        autoFocus
      />
    </div>
  );
}
