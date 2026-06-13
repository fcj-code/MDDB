import React from 'react';

interface RefOption {
  value: string;
  label: string;
}

interface Props {
  value: unknown;
  columnType: string;
  isEditing: boolean;
  refOptions?: RefOption[];
  width?: number;
  onStartEdit: () => void;
  onCommitEdit: (value: unknown) => void;
  onCancelEdit: () => void;
}

/** 从类型表达式提取基础类型名 */
function baseType(typeExpr: string): string {
  return typeExpr.split('(')[0]!.trim();
}

/** 从 enum(高,中,低) 提取选项 */
function extractEnumOptions(typeExpr: string): string[] {
  const m = typeExpr.match(/\(([^)]+)\)/);
  return m ? m[1]!.split(',').map(s => s.trim()) : [];
}

export default function BodyCell({ value, columnType, isEditing, refOptions, width, onStartEdit, onCommitEdit, onCancelEdit }: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const selectRef = React.useRef<HTMLSelectElement>(null);

  React.useEffect(() => {
    if (isEditing) {
      (inputRef.current ?? selectRef.current)?.focus();
    }
  }, [isEditing]);

  // --- Editing mode: render type-aware control ---
  if (isEditing) {
    const typeName = baseType(columnType);

    // boolean: checkbox
    if (typeName === 'boolean') {
      return (
        <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--editing">
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="checkbox"
            className="mddb-react-inline-checkbox"
            defaultChecked={value === true || value === 'true' || value === 1}
            onChange={(e) => onCommitEdit(e.target.checked)}
          />
        </div>
      );
    }

    // enum: select dropdown
    if (typeName === 'enum') {
      const options = extractEnumOptions(columnType);
      return (
        <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--editing">
          <select
            ref={selectRef}
            className="mddb-react-inline-select"
            defaultValue={String(value ?? '')}
            onChange={(e) => onCommitEdit(e.target.value)}
            onBlur={(e) => onCommitEdit(e.target.value)}
          >
            <option value="">--</option>
            {options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      );
    }

    // number: input type="number"
    if (typeName === 'integer' || typeName === 'decimal') {
      return (
        <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--editing">
          <input
            ref={inputRef}
            type="number"
            className="mddb-react-inline-input"
            defaultValue={String(value ?? '')}
            onBlur={(e) => onCommitEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') onCancelEdit();
            }}
          />
        </div>
      );
    }

    // date: input type="date"
    if (typeName === 'date') {
      return (
        <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--editing">
          <input
            ref={inputRef}
            type="date"
            className="mddb-react-inline-input"
            defaultValue={String(value ?? '')}
            onBlur={(e) => onCommitEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelEdit();
            }}
          />
        </div>
      );
    }

    // ref: select dropdown (like enum, but options from referenced table)
    if (typeName === 'ref') {
      const options = refOptions ?? [];
      return (
        <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--editing">
          <select
            ref={selectRef}
            className="mddb-react-inline-select"
            defaultValue={String(value ?? '')}
            onChange={(e) => onCommitEdit(e.target.value)}
            onBlur={(e) => onCommitEdit(e.target.value)}
          >
            <option value="">--</option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    }

    // default: text input
    return (
      <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--editing">
        <input
          ref={inputRef}
          type="text"
          className="mddb-react-inline-input"
          defaultValue={String(value ?? '')}
          onBlur={(e) => onCommitEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') onCancelEdit();
          }}
        />
      </div>
    );
  }

  // --- Display mode ---
  return (
    <div
      className="mddb-react-cell mddb-react-cell--body"
      onDoubleClick={onStartEdit}
      style={{ width, minWidth: 60, maxWidth: width }}
    >
      {value === null || value === undefined ? (
        <span className="mddb-react-null">-</span>
      ) : (
        <span>{String(value)}</span>
      )}
    </div>
  );
}
