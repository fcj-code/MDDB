import React from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import HeaderCell from './header-cell';
import BodyCell from './body-cell';
import ActionMenu from '../action-menu';
import BottomBar from '../bottom-bar';
import type { TableViewModel, TableSnapshot } from '../../table-view-model';
import type { MDDBEngine } from '../../../engine/engine';

interface Props {
  viewModel: TableViewModel;
  snapshot: TableSnapshot;
  engine?: MDDBEngine;
  onShowForm: (mode: 'new' | 'edit', storagePk?: string, cells?: Record<string, unknown>) => void;
}

export function TableViewReact({ viewModel, snapshot, engine, onShowForm }: Props) {
  const { columns, rows, totalRows, sortField, sortDirection } = snapshot;
  // storage_pk is internal — hide from display
  const visibleColumns = columns.filter(c => c.name !== 'storage_pk');
  const [openMenuPk, setOpenMenuPk] = React.useState<string | null>(null);

  // Drag-resize handler: track last set width per column in a ref for smooth drag
  const lastWidthRef = React.useRef<Record<string, number>>({});
  const handleWidthChange = React.useCallback((colName: string, delta: number) => {
    const base = lastWidthRef.current[colName] ?? snapshot.columns.find(c => c.name === colName)?.width ?? 150;
    const newWidth = Math.max(60, base + delta);
    lastWidthRef.current[colName] = newWidth;
    viewModel.setColumnWidth(colName, newWidth);
  }, [snapshot.columns, viewModel]);

  const handleResetWidth = React.useCallback((colName: string) => {
    viewModel.resetColumnWidth(colName);
  }, [viewModel]);

  // Pre-compute ref options for ref(table) columns
  const refOptionsMap = React.useMemo(() => {
    const map = new Map<string, Array<{ value: string; label: string }>>();
    if (!engine) return map;
    for (const col of columns) {
      const m = col.type.match(/^ref\((\S+)\)$/);
      if (!m) continue;
      const refTable = m[1]!;
      if (map.has(refTable)) continue;
      try {
        const qr = engine.query({ table: refTable, limit: 500 });
        if (qr.ok) {
          const rs = qr.value;
          const refSchema = engine.schemaRegistry.getSchema(refTable);
          const labelField = refSchema?.fields[0] ?? rs.columns.find(c => c.name !== 'storage_pk') ?? rs.columns[0] ?? '';
          const labelColName = typeof labelField === 'string' ? labelField : labelField.name;
          const opts = rs.rows.map(r => ({
            value: String(r[labelColName] ?? ''),
            label: String(r[labelColName] ?? ''),
          }));
          map.set(refTable, opts);
        }
      } catch { /* ignore */ }
    }
    return map;
  }, [engine, columns]);

  if (rows.length === 0 && totalRows === 0) {
    return (
      <div className="mddb-react-table-wrapper">
        <div className="mddb-empty">No data</div>
      </div>
    );
  }

  return (
    <div className="mddb-react-table-wrapper">
      <TableVirtuoso
        style={{ height: '400px', width: '100%' }}
        totalCount={rows.length}
        overscan={20}
        fixedHeaderContent={() => (
          <div className="mddb-react-row">
            <div className="mddb-react-cell mddb-react-cell--header mddb-react-cell--action">
              <span>⠿</span>
            </div>
            {visibleColumns.map((col) => (
              <HeaderCell
                key={col.name}
                column={col}
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={() => viewModel.toggleSort(col.name)}
                onWidthChange={handleWidthChange}
                onResetWidth={handleResetWidth}
              />
            ))}
          </div>
        )}
        itemContent={(index) => {
          const row = rows[index]!;
          const storagePk = row.cells['storage_pk'] as string;
          const isOpen = openMenuPk === storagePk;

          return (
            <>
              <div className="mddb-react-cell mddb-react-cell--body mddb-react-cell--action">
                <ActionMenu
                  storagePk={storagePk}
                  cells={row.cells}
                  isOpen={isOpen}
                  onToggle={() => setOpenMenuPk(isOpen ? null : storagePk)}
                  onEdit={(pk, cells) => {
                    setOpenMenuPk(null);
                    onShowForm('edit', pk, cells);
                  }}
                  onDelete={async (pk) => {
                    setOpenMenuPk(null);
                    await viewModel.deleteRow(pk);
                  }}
                />
              </div>
              {visibleColumns.map((col) => {
                const val = row.cells[col.name];
                const isEditing =
                  viewModel.editingCell?.rowIndex === index &&
                  viewModel.editingCell?.col === col.name;
                const colWidth = col.width ?? 150;

                return (
                  <BodyCell
                    key={`${col.name}-${index}`}
                    value={val}
                    columnType={col.type}
                    refOptions={refOptionsMap.get(col.type.match(/^ref\((\S+)\)$/)?.[1] ?? '')}
                    isEditing={isEditing}
                    width={colWidth}
                    onStartEdit={() => viewModel.startEdit(index, col.name)}
                    onCommitEdit={(newVal) => viewModel.commitEdit(newVal)}
                    onCancelEdit={() => viewModel.cancelEdit()}
                  />
                );
              })}
            </>
          );
        }}
        components={{
          Table: ({ style, ...props }) => (
            <div
              className="mddb-react-table"
              {...props}
              style={{ ...style, display: 'table', tableLayout: 'fixed', width: '100%' }}
            />
          ),
          TableHead: React.forwardRef(({ style, ...props }, ref) => (
            <div
              className="mddb-react-header"
              {...props}
              style={{ ...style, display: 'table-header-group' }}
              ref={ref}
            />
          )),
          TableBody: React.forwardRef(({ style, ...props }, ref) => (
            <div
              className="mddb-react-body"
              {...props}
              style={{ ...style, display: 'table-row-group' }}
              ref={ref}
            />
          )),
          TableRow: ({ style, ...props }) => (
            <div
              className="mddb-react-row"
              {...props}
              style={{ ...style, display: 'table-row' }}
            />
          ),
        }}
      />
      <BottomBar
        totalRows={totalRows}
        onAddRow={() => onShowForm('new')}
      />
    </div>
  );
}
