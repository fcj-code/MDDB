/**
 * EditModal — 复用 FormBuilder 的编辑/新增弹窗
 *
 * 覆盖全屏的半透明遮罩 + 居中弹窗，内部调用 FormBuilder.render() 渲染表单。
 * 支持 edit（预填值）和 new（空白）两种模式。
 */

import React, { useRef, useEffect, useState } from 'react';
import { FormBuilder } from '../../shared/form-builder';
import type { MDDBEngine } from '../../../engine/engine';
import type { SchemaSummary } from '../../../core/types';

interface EditModalProps {
  engine: MDDBEngine;
  table: string;
  initialValues?: Record<string, unknown>;
  title: string;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

export function EditModal({
  engine,
  table,
  initialValues,
  title,
  onSave,
  onClose,
}: EditModalProps) {
  const formRef = useRef<HTMLDivElement>(null);
  const getValuesRef = useRef<(() => Record<string, unknown>) | null>(null);
  const [schema, setSchema] = useState<SchemaSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 获取 schema
  useEffect(() => {
    const s = engine.schemaRegistry.getSchema(table);
    if (!s) {
      setError(`Table "${table}" not found`);
      return;
    }
    setSchema(s);
  }, [engine, table]);

  // 渲染表单（schema 就绪后）
  useEffect(() => {
    if (!schema || !formRef.current) return;

    formRef.current.empty();

    const { element, getValues } = FormBuilder.render(engine, schema, {
      mode: initialValues ? 'edit' : 'new',
      values: initialValues,
    });
    formRef.current.appendChild(element);
    getValuesRef.current = getValues;
  }, [schema]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!getValuesRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const values = getValuesRef.current();
      await onSave(values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mddb-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="mddb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mddb-modal-header">
          <span className="mddb-modal-title">{title}</span>
          <button className="clickable-icon" onClick={onClose} disabled={saving}>
            ✕
          </button>
        </div>

        <div className="mddb-modal-body">
          {error && <div className="mddb-error">{error}</div>}
          <div ref={formRef} />
        </div>

        <div className="mddb-modal-footer">
          <button className="mod-cta" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
