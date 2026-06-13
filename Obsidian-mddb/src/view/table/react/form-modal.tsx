import React from 'react';
import { FormBuilder } from '../../shared/form-builder';
import type { SchemaSummary } from '../../../core/types';
import type { MDDBEngine } from '../../../engine/engine';

interface Props {
  engine: MDDBEngine;
  schema: SchemaSummary;
  mode: 'new' | 'edit';
  storagePk?: string;
  values?: Record<string, unknown>;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

export default function FormModal({ engine, schema, mode, storagePk, values, onSave, onClose }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const getValuesRef = React.useRef<(() => Record<string, unknown>) | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const { element, getValues } = FormBuilder.render(engine, schema, { mode, values });
    getValuesRef.current = getValues;
    containerRef.current.appendChild(element);

    // Add submit/cancel buttons
    const btnRow = document.createElement('div');
    btnRow.addClass('mddb-form-actions');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;align-items:center';

    const submitBtn = btnRow.createEl('button', {
      text: mode === 'new' ? '创建' : '保存',
      cls: 'mddb-form-submit',
    });
    submitBtn.style.cssText = 'padding:4px 12px;cursor:pointer';

    const cancelBtn = btnRow.createEl('button', {
      text: '取消',
      cls: 'mddb-form-cancel',
    });
    cancelBtn.style.cssText = 'padding:4px 12px;cursor:pointer';

    const statusEl = btnRow.createEl('span', { cls: 'mddb-form-status' });
    statusEl.style.cssText = 'margin-left:8px;font-size:12px';

    submitBtn.onclick = async () => {
      submitBtn.disabled = true;
      statusEl.setText('Saving...');
      try {
        const record = getValues();
        await onSave(record);
        statusEl.setText('Saved ✓');
        setTimeout(onClose, 500);
      } catch (e) {
        statusEl.setText(`Error: ${(e as Error).message}`);
        submitBtn.disabled = false;
      }
    };

    cancelBtn.onclick = onClose;
    containerRef.current.appendChild(btnRow);
  }, []);

  return (
    <div className="mddb-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mddb-modal">
        <h3 style={{ margin: '0 0 12px', fontSize: '16px' }}>
          {mode === 'new' ? '新增行' : '编辑行'}
        </h3>
        <div ref={containerRef} />
      </div>
    </div>
  );
}
