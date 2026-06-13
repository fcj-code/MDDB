import React from 'react';

interface CardMetadataProps {
  metadata: Record<string, unknown>;
  searchQuery?: string;
}

export function CardMetadata({ metadata, searchQuery }: CardMetadataProps) {
  const entries = Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;

  return (
    <div className="mddb-kanban-item-metadata">
      {entries.map(([key, value]) => (
        <div key={key} className="mddb-kanban-item-metadata-field">
          <span className="mddb-kanban-item-metadata-label">{key}:</span>
          <span className="mddb-kanban-item-metadata-value">
            {searchQuery ? highlightText(String(value), searchQuery) : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
