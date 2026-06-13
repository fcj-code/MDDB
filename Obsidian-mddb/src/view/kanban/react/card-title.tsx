import React from 'react';

interface CardTitleProps {
  title: string;
  searchQuery?: string;
}

export function CardTitle({
  title,
  searchQuery,
}: CardTitleProps) {
  return (
    <div className="mddb-kanban-item-title">
      {searchQuery ? highlightText(title, searchQuery) : title}
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
