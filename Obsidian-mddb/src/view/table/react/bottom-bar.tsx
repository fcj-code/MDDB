import React from 'react';

interface Props {
  totalRows: number;
  onAddRow: () => void;
}

export default function BottomBar({ totalRows, onAddRow }: Props) {
  return (
    <div className="mddb-react-bottom-bar">
      <span className="mddb-react-bottom-info">{totalRows} rows</span>
      <button className="mddb-react-add-btn" onClick={onAddRow}>
        + New Row
      </button>
    </div>
  );
}
