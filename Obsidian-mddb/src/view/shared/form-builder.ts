import type { SchemaSummary } from '../../core/types';
import type { MDDBEngine } from '../../engine/engine';

export interface FormBuilderOptions {
  mode: 'new' | 'edit';
  values?: Record<string, unknown>;
}

export class FormBuilder {
  /**
   * 渲染表单控件，返回元素和取值函数
   */
  static render(
    engine: MDDBEngine,
    schema: SchemaSummary,
    options?: FormBuilderOptions,
  ): { element: HTMLElement; getValues: () => Record<string, unknown> } {
    const container = document.createElement('div');
    container.addClass('mddb-form-container');

    const fieldInputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    const initialValues = options?.values ?? {};

    // 预加载 ref 表数据
    const refCache = new Map<string, Array<{ value: string; label: string }>>();
    for (const [i, typeExpr] of schema.types.entries()) {
      const refMatch = typeExpr.match(/^ref\((\S+)\)$/);
      if (!refMatch) continue;
      const refTable = refMatch[1]!;
      if (refCache.has(refTable)) continue;
      try {
        const qr = engine.query({ table: refTable, limit: 500 });
        if (qr.ok) {
          const rs = qr.value;
          const refSchema = engine.schemaRegistry.getSchema(refTable);
          const labelField = refSchema?.fields[0] ?? rs.columns.find(c => c.name !== 'storage_pk') ?? rs.columns[0] ?? '';
          const labelColName = typeof labelField === 'string' ? labelField : labelField.name;
          const options = rs.rows.map(r => ({
            value: String(r[labelColName] ?? ''),
            label: String(r[labelColName] ?? ''),
          }));
          refCache.set(refTable, options);
        }
      } catch { /* ignore */ }
    }

    for (const field of schema.fields) {
      const idx = schema.fields.indexOf(field);
      const typeExpr = schema.types[idx] ?? 'string';
      const typeName = typeExpr.split('(')[0]!;
      const required = schema.required[idx] ?? false;
      const row = container.createEl('div', { cls: 'mddb-form-row' });
      row.createEl('label', { cls: 'mddb-form-label', text: `${field}${required ? ' *' : ''}` });

      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const initialVal = initialValues[field];

      if (typeName === 'boolean') {
        input = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
        if (initialVal === true || initialVal === 'true' || initialVal === 1) (input as HTMLInputElement).checked = true;
      } else if (typeName === 'ref') {
        const refTable = typeExpr.match(/^ref\((\S+)\)$/)?.[1] ?? '';
        const opts = refCache.get(refTable) ?? [];
        input = row.createEl('select') as HTMLSelectElement;
        (input as HTMLSelectElement).createEl('option', { text: '--', value: '' });
        for (const opt of opts) {
          (input as HTMLSelectElement).createEl('option', { text: opt.label, value: opt.value });
        }
        if (initialVal) (input as HTMLSelectElement).value = String(initialVal);
      } else if (typeName === 'enum') {
        const enumOptions = typeExpr.match(/\(([^)]+)\)/)?.[1]?.split(',').map(s => s.trim()) ?? [];
        input = row.createEl('select') as HTMLSelectElement;
        for (const opt of enumOptions) {
          (input as HTMLSelectElement).createEl('option', { text: opt, value: opt });
        }
        if (initialVal) (input as HTMLSelectElement).value = String(initialVal);
      } else if (typeName === 'date') {
        input = row.createEl('input', { type: 'date' }) as HTMLInputElement;
        if (initialVal) (input as HTMLInputElement).value = String(initialVal);
      } else {
        input = row.createEl('input', { type: 'text' }) as HTMLInputElement;
        if (initialVal) input.value = String(initialVal);
      }

      fieldInputs.set(field, input);
    }

    return {
      element: container,
      getValues: () => {
        const record: Record<string, unknown> = {};
        for (const [field, input] of fieldInputs) {
          const isCheckbox = 'type' in input && (input as HTMLInputElement).type === 'checkbox';
          const val = isCheckbox ? (input as HTMLInputElement).checked : (input as HTMLSelectElement | HTMLTextAreaElement).value;
          record[field] = val === '' || val === false ? null : val;
        }
        return record;
      },
    };
  }
}
