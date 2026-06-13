import React from 'react';
import { TableViewReact } from './table/index';
import FormModal from './form-modal';
import type { TableViewModel } from '../table-view-model';
import './table/styles.css';

interface AppProps {
  viewModel: TableViewModel;
}

export function TableApp({ viewModel }: AppProps) {
  const [snapshot, setSnapshot] = React.useState(() => viewModel.getSnapshot());
  const [formState, setFormState] = React.useState<{
    mode: 'new' | 'edit';
    storagePk?: string;
    values?: Record<string, unknown>;
  } | null>(null);

  React.useEffect(() => {
    const update = () => setSnapshot(viewModel.getSnapshot());
    const unsub1 = viewModel.events.on('state-changed', update);
    const unsub2 = viewModel.events.on('edit-start', update);
    const unsub3 = viewModel.events.on('edit-commit', update);
    const unsub4 = viewModel.events.on('edit-cancel', update);
    const unsub5 = viewModel.events.on('row-deleted', update);
    const unsub6 = viewModel.events.on('row-inserted', update);
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); };
  }, [viewModel]);

  // Get engine and schema for form modals
  const engine = (viewModel as any)['engine'];
  const viewConfig = (viewModel as any)['viewConfig'];
  const table = viewConfig?.table;

  return (
    <div className="mddb-react-app">
      <TableViewReact
        viewModel={viewModel}
        snapshot={snapshot}
        engine={engine}
        onShowForm={(mode, storagePk, cells) => {
          setFormState({ mode, storagePk, values: cells });
        }}
      />
      {formState && table && (
        <FormModal
          engine={engine}
          schema={engine.schemaRegistry.getSchema(table)}
          mode={formState.mode}
          storagePk={formState.storagePk}
          values={formState.values}
          onSave={async (record) => {
            if (formState.mode === 'new') {
              await viewModel.insertRow(record);
            } else if (formState.storagePk) {
              await engine.update(formState.storagePk, record, { force: true });
            }
          }}
          onClose={() => setFormState(null)}
        />
      )}
    </div>
  );
}
