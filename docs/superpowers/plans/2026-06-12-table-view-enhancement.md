# 表格视图增强实施计划 — 行内编辑、列显示控制、CRUD 操作

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有只读表格视图基础上，实现行内编辑、列显示控制、CRUD 操作三个延期功能。

**架构：** 方案B — 统一到 TableViewModel，新增 InlineTableRenderer（代码块 DOM 渲染器）和 FormBuilder（表单控件工厂），改造 main.ts 的 mddb-table 处理器。

**Tech Stack:** Obsidian Plugin API, TypeScript, Vitest, sql.js

---

## 文件结构变化

```
src/view/
├── parser.ts                              # 不变
├── base-view-model.ts                     # 不变
├── table/
│   ├── table-view-model.ts                # ★ 增强：编辑/列控制/CRUD 状态+方法
│   ├── table-view-model.test.ts           # ★ 增强：新增功能测试
│   ├── table-view.ts                      # 不变（ItemView）
│   ├── table-config.ts                    # 不变
│   └── inline-renderer.ts                 # ★ 新增：代码块 DOM 渲染器
├── shared/
│   ├── event-bus.ts                       # 不变
│   ├── data-layer.ts                      # 不变
│   ├── types.ts                           # ★ 增强：编辑/列/CRUD 事件类型
│   └── form-builder.ts                    # ★ 新增（从 main.ts 提取）
└── integration.ts                         # 不变

src/main.ts                                # ★ 修改：mddb-table 处理器改为使用 ViewModel
```

---

### Task 1: 增强 shared/types.ts — 新增事件类型和编辑状态类型

**Files:**
- Modify: `Obsidian-mddb/src/view/shared/types.ts`

**Changes:**

```typescript
// 新增编辑状态类型
export interface EditingCell {
  rowIndex: number;
  col: string;
  originalValue: unknown;
}

// 扩展 ViewEventType
export type ViewEventType =
  | 'state-changed'
  | 'data-changed'
  | 'sort-changed'
  | 'page-changed'
  | 'error'
  | 'refresh'
  // ★ 新增
  | 'edit-start'
  | 'edit-commit'
  | 'edit-cancel'
  | 'column-visibility-changed'
  | 'row-deleted'
  | 'row-inserted'
  | 'action-menu-opened'
  | 'action-menu-closed';
```

---

### Task 2: 增强 TableViewModel — 编辑/列控制/CRUD

**Files:**
- Modify: `Obsidian-mddb/src/view/table/table-view-model.ts`
- Modify: `Obsidian-mddb/src/view/table/table-view-model.test.ts`

#### 2.1 新增状态字段

在 `TableViewModel` 类中添加成员变量：

```typescript
// === 编辑状态 ===
editingCell: EditingCell | null = null;

// === 列可见性 ===
visibleColumns: Set<string> = new Set();

// === CRUD ===
actionMenuRow: string | null = null;
```

在 `constructor` 中不需要立即填充 `visibleColumns`，在 `updateFromResult` 首次调用时填充。

#### 2.2 编辑方法

```typescript
startEdit(rowIndex: number, col: string): void {
  const row = this.tableState.rows[rowIndex];
  if (!row) return;
  this.editingCell = {
    rowIndex,
    col,
    originalValue: row.cells[col],
  };
  this.events.emit({ type: 'edit-start', viewId: this.viewId, data: this.editingCell });
}

async commitEdit(newValue: unknown): Promise<boolean> {
  if (!this.editingCell) return false;
  const { rowIndex, col, originalValue } = this.editingCell;

  try {
    const row = this.tableState.rows[rowIndex];
    const storagePk = row.cells['storage_pk'] as string;
    if (!storagePk) throw new Error('No storage_pk for this row');

    await this.engine.update(storagePk, { [col]: newValue });
    this.editingCell = null;
    this.events.emit({ type: 'edit-commit', viewId: this.viewId, data: { rowIndex, col, value: newValue } });
    await this.refresh();
    return true;
  } catch (e) {
    this.editingCell = null;
    this.events.emit({ type: 'edit-cancel', viewId: this.viewId, data: { rowIndex, col, originalValue } });
    return false;
  }
}

cancelEdit(): void {
  if (!this.editingCell) return;
  const { rowIndex, col, originalValue } = this.editingCell;
  this.editingCell = null;
  this.events.emit({ type: 'edit-cancel', viewId: this.viewId, data: { rowIndex, col, originalValue } });
}
```

#### 2.3 列可见性方法

```typescript
toggleColumn(col: string): void {
  if (this.visibleColumns.has(col)) {
    this.visibleColumns.delete(col);
  } else {
    this.visibleColumns.add(col);
  }
  this.events.emit({ type: 'column-visibility-changed', viewId: this.viewId, data: { col, visible: this.visibleColumns.has(col) } });
}

hideColumn(col: string): void {
  this.visibleColumns.delete(col);
  this.events.emit({ type: 'column-visibility-changed', viewId: this.viewId, data: { col, visible: false } });
}

showAllColumns(): void {
  const allCols = this.tableState.columns.map(c => c.name);
  this.visibleColumns = new Set(allCols);
  this.events.emit({ type: 'column-visibility-changed', viewId: this.viewId, data: { all: true } });
}

isColumnVisible(col: string): boolean {
  return this.visibleColumns.has(col);
}
```

#### 2.4 在 updateFromResult 中初始化 visibleColumns

在 `updateFromResult` 方法末尾添加：

```typescript
// 首次初始化 visibleColumns
if (this.visibleColumns.size === 0 && columns.length > 0) {
  this.visibleColumns = new Set(columns.map(c => c.name));
}
```

#### 2.5 CRUD 方法

```typescript
toggleActionMenu(storagePk: string): void {
  this.actionMenuRow = this.actionMenuRow === storagePk ? null : storagePk;
  this.events.emit({
    type: this.actionMenuRow ? 'action-menu-opened' : 'action-menu-closed',
    viewId: this.viewId,
    data: { storagePk },
  });
}

closeActionMenu(): void {
  if (this.actionMenuRow) {
    this.actionMenuRow = null;
    this.events.emit({ type: 'action-menu-closed', viewId: this.viewId });
  }
}

async deleteRow(storagePk: string): Promise<boolean> {
  try {
    await this.engine.delete(storagePk);
    this.closeActionMenu();
    this.events.emit({ type: 'row-deleted', viewId: this.viewId, data: { storagePk } });
    await this.refresh();
    return true;
  } catch (e) {
    return false;
  }
}

async insertRow(values: Record<string, unknown>): Promise<boolean> {
  try {
    const table = this.viewConfig.table;
    await this.engine.insert(table, values);
    this.events.emit({ type: 'row-inserted', viewId: this.viewId });
    await this.refresh();
    return true;
  } catch (e) {
    return false;
  }
}

openForm(mode: 'new' | 'edit', storagePk?: string, currentValues?: Record<string, unknown>): void {
  this.events.emit({
    type: 'data-changed',
    viewId: this.viewId,
    data: { form: { mode, storagePk, values: currentValues } },
  });
}
```

#### 2.6 新增测试

```typescript
describe('TableViewModel - Editing', () => {
  it('starts editing a cell', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test', engine as any, { table: 'accounts', columns: ['name', 'balance'] });
    await vm.initialize();

    vm.startEdit(0, 'name');
    expect(vm.editingCell).not.toBeNull();
    expect(vm.editingCell!.rowIndex).toBe(0);
    expect(vm.editingCell!.col).toBe('name');
  });

  it('cancels editing restores original value', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test', engine as any, { table: 'accounts', columns: ['name', 'balance'] });
    await vm.initialize();

    vm.startEdit(0, 'name');
    vm.cancelEdit();
    expect(vm.editingCell).toBeNull();
  });
});

describe('TableViewModel - Column Visibility', () => {
  it('toggles column visibility', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test', engine as any, { table: 'accounts', columns: ['name', 'balance'] });
    await vm.initialize();

    expect(vm.isColumnVisible('name')).toBe(true);
    vm.toggleColumn('name');
    expect(vm.isColumnVisible('name')).toBe(false);
    vm.toggleColumn('name');
    expect(vm.isColumnVisible('name')).toBe(true);
  });

  it('hides and shows all columns', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test', engine as any, { table: 'accounts', columns: ['name', 'balance'] });
    await vm.initialize();

    vm.hideColumn('name');
    expect(vm.isColumnVisible('name')).toBe(false);
    vm.showAllColumns();
    expect(vm.isColumnVisible('name')).toBe(true);
    expect(vm.isColumnVisible('balance')).toBe(true);
  });
});

describe('TableViewModel - CRUD', () => {
  it('toggles action menu', async () => {
    const { TableViewModel } = await import('./table-view-model');
    const vm = new TableViewModel('test', engine as any, { table: 'accounts', columns: ['name', 'balance'] });
    await vm.initialize();

    vm.toggleActionMenu('test-pk');
    expect(vm.actionMenuRow).toBe('test-pk');
    vm.toggleActionMenu('test-pk');
    expect(vm.actionMenuRow).toBeNull();
  });
});
```

---

### Task 3: 提取 FormBuilder — 从 main.ts 分离表单控件逻辑

**Files:**
- Create: `Obsidian-mddb/src/view/shared/form-builder.ts`
- Modify: `Obsidian-mddb/src/main.ts`

#### 3.1 form-builder.ts

```typescript
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
```

#### 3.2 简化 main.ts 中 mddb-form 处理器

将 `main.ts` 的 `mddb-form` 处理器（line 181-301）简化为使用 `FormBuilder`：

```typescript
this.registerMarkdownCodeBlockProcessor('mddb-form', async (source, el) => {
  if (el.hasClass('mddb-rendered')) return;
  el.addClass('mddb-rendered');
  el.empty();

  const config = parseFormBlock(source);
  if (!config) {
    el.createEl('div', { cls: 'mddb-error', text: 'MD-DB form: invalid syntax' });
    return;
  }

  const schema = this.engine.schemaRegistry.getSchema(config.table);
  if (!schema) {
    el.createEl('div', { cls: 'mddb-error', text: `Table "${config.table}" not found` });
    return;
  }

  const { element: form, getValues } = FormBuilder.render(this.engine, schema, { mode: config.mode });
  el.appendChild(form);

  const btnRow = form.createEl('div', { cls: 'mddb-form-actions' });
  const submitBtn = btnRow.createEl('button', { text: '保存', cls: 'mddb-form-submit' });
  const statusEl = btnRow.createEl('span', { cls: 'mddb-form-status' });

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    statusEl.setText('Saving...');
    try {
      const record = getValues();
      const result = await this.engine.insert(config.table, record);
      statusEl.setText(`Saved: ${result.storagePk.slice(0, 8)}`);
      if (!config.keepOpen) {
        // 重置表单：移除旧表单，重新渲染
        el.empty();
        const { element: newForm } = FormBuilder.render(this.engine, schema, { mode: config.mode });
        el.appendChild(newForm);
      }
    } catch (e) {
      statusEl.setText(`Error: ${(e as Error).message}`);
    } finally {
      submitBtn.disabled = false;
    }
  });
});
```

---

### Task 4: 创建 InlineTableRenderer — 代码块 DOM 渲染器

**Files:**
- Create: `Obsidian-mddb/src/view/table/inline-renderer.ts`

```typescript
import { TableViewModel } from './table-view-model';
import { FormBuilder } from '../shared/form-builder';

export class InlineTableRenderer {
  private vm: TableViewModel;
  private el: HTMLElement;
  private disposables: Array<() => void> = [];

  constructor(vm: TableViewModel, el: HTMLElement) {
    this.vm = vm;
    this.el = el;
  }

  mount(): void {
    this.render();
    this.disposables.push(
      this.vm.events.on('state-changed', () => this.render()),
      this.vm.events.on('edit-commit', () => this.render()),
      this.vm.events.on('edit-cancel', () => this.render()),
      this.vm.events.on('column-visibility-changed', () => this.render()),
      this.vm.events.on('row-deleted', () => this.render()),
      this.vm.events.on('row-inserted', () => this.render()),
    );
  }

  private render(): void {
    this.el.empty();
    const state = this.vm.tableStateValue;

    switch (state.status) {
      case 'loading':
        this.renderLoading();
        break;
      case 'error':
        this.renderError(state.error ?? 'Unknown error');
        break;
      case 'empty':
        this.renderEmpty();
        break;
      case 'ready':
        this.renderToolbar();
        this.renderTable();
        this.renderQuickAddRow();
        this.renderPagination();
        break;
    }
  }

  unmount(): void {
    for (const d of this.disposables) d();
    this.disposables = [];
  }

  private renderLoading(): void {
    this.el.createEl('div', { text: 'Loading...', cls: 'mddb-loading' });
  }

  private renderError(error: string): void {
    const errorEl = this.el.createEl('div', { cls: 'mddb-error' });
    errorEl.createEl('h3', { text: 'Query Error' });
    errorEl.createEl('pre', { text: error });
  }

  private renderEmpty(): void {
    this.el.createEl('div', { text: 'No data', cls: 'mddb-empty' });
  }

  private renderToolbar(): void {
    const toolbar = this.el.createEl('div', { cls: 'mddb-toolbar' });

    // 列选择器
    const colBtn = toolbar.createEl('button', { text: '列 ▾', cls: 'mddb-col-selector-btn' });
    colBtn.addEventListener('click', () => {
      const existing = this.el.querySelector('.mddb-col-dropdown');
      if (existing) { existing.remove(); return; }
      this.renderColumnDropdown(toolbar);
    });

    // [+] 新增
    const addBtn = toolbar.createEl('button', { text: '+', cls: 'mddb-add-btn' });
    addBtn.addEventListener('click', () => this.showFormModal('new'));

    const state = this.vm.tableStateValue;
    toolbar.createSpan({ text: `  ${state.totalRows} rows`, cls: 'mddb-toolbar-info' });
  }

  private renderColumnDropdown(toolbar: HTMLElement): void {
    const dropdown = toolbar.createEl('div', { cls: 'mddb-col-dropdown' });
    const cols = this.vm.tableStateValue.columns;
    for (const col of cols) {
      const label = dropdown.createEl('label', { cls: 'mddb-col-option' });
      const cb = label.createEl('input', { type: 'checkbox' });
      cb.checked = this.vm.isColumnVisible(col.name);
      cb.addEventListener('change', () => this.vm.toggleColumn(col.name));
      label.append(` ${col.label ?? col.name}`);
    }
  }

  private renderTable(): void {
    const state = this.vm.tableStateValue;
    const visibleCols = state.columns.filter(c => this.vm.isColumnVisible(c.name));
    if (visibleCols.length === 0) return;

    const table = this.el.createEl('table', { cls: 'mddb-table' });

    // 表头
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: '⠿', cls: 'mddb-action-col' });

    for (const col of visibleCols) {
      const th = headerRow.createEl('th', { text: col.label ?? col.name, cls: 'mddb-header-cell' });
      th.style.textAlign = col.align ?? 'left';
      th.style.cursor = 'pointer';

      if (state.sortField === col.name) {
        th.setText(`${col.label ?? col.name} ${state.sortDirection === 'ASC' ? '↑' : '↓'}`);
      }

      th.addEventListener('click', () => this.vm.toggleSort(col.name));
      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showColumnContextMenu(col.name);
      });
    }

    // 表体
    const tbody = table.createEl('tbody');
    for (let rowIdx = 0; rowIdx < state.rows.length; rowIdx++) {
      const row = state.rows[rowIdx]!;
      const tr = tbody.createEl('tr');
      const storagePk = row.cells['storage_pk'] as string;

      // ⠿
      const actionTd = tr.createEl('td', { cls: 'mddb-action-cell' });
      const actionBtn = actionTd.createEl('button', { text: '⠿', cls: 'mddb-action-btn' });
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showActionMenu(actionBtn, storagePk, row.cells);
      });

      for (const col of visibleCols) {
        const val = row.cells[col.name];
        const td = tr.createEl('td');
        td.style.textAlign = col.align ?? 'left';

        const isEditing = this.vm.editingCell?.rowIndex === rowIdx && this.vm.editingCell?.col === col.name;

        if (isEditing) {
          const input = td.createEl('input', { type: 'text', cls: 'mddb-inline-edit-input' });
          input.value = String(val ?? '');
          input.focus();
          input.select();

          input.addEventListener('blur', () => this.vm.commitEdit(input.value));
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            else if (e.key === 'Escape') this.vm.cancelEdit();
          });
        } else {
          td.addEventListener('dblclick', () => this.vm.startEdit(rowIdx, col.name));
          if (val === null || val === undefined) {
            td.setText('-');
            td.addClass('mddb-null');
          } else {
            td.setText(String(val));
          }
        }
      }
    }
  }

  private renderQuickAddRow(): void {
    const state = this.vm.tableStateValue;
    const visibleCols = state.columns.filter(c => this.vm.isColumnVisible(c.name));
    if (visibleCols.length === 0) return;

    const container = this.el.createEl('div', { cls: 'mddb-quick-add' });
    container.createEl('span', { text: '快速录入: ', cls: 'mddb-quick-add-label' });

    const inputs: HTMLInputElement[] = [];
    for (const col of visibleCols) {
      const input = container.createEl('input', {
        type: 'text', placeholder: col.label ?? col.name, cls: 'mddb-quick-add-input',
      }) as HTMLInputElement;
      inputs.push(input);
    }

    const saveBtn = container.createEl('button', { text: '保存', cls: 'mddb-quick-add-save' });
    saveBtn.addEventListener('click', async () => {
      const values: Record<string, unknown> = {};
      for (let i = 0; i < visibleCols.length; i++) {
        values[visibleCols[i]!.name] = inputs[i]!.value || null;
      }
      const ok = await this.vm.insertRow(values);
      if (ok) for (const inp of inputs) inp.value = '';
    });
  }

  private renderPagination(): void {
    const state = this.vm.tableStateValue;
    const pagination = this.el.createEl('div', { cls: 'mddb-pagination' });

    const prevBtn = pagination.createEl('button', { text: '← Prev', cls: 'mddb-page-btn' });
    prevBtn.disabled = state.page <= 1;
    prevBtn.addEventListener('click', () => this.vm.prevPage());

    pagination.createSpan({ text: ` Page ${state.page} / ${state.totalPages} `, cls: 'mddb-page-info' });

    const nextBtn = pagination.createEl('button', { text: 'Next →', cls: 'mddb-page-btn' });
    nextBtn.disabled = state.page >= state.totalPages;
    nextBtn.addEventListener('click', () => this.vm.nextPage());
  }

  private showColumnContextMenu(colName: string): void {
    const old = this.el.querySelector('.mddb-context-menu');
    if (old) old.remove();

    const menu = this.el.createEl('div', { cls: 'mddb-context-menu' });
    const hideItem = menu.createEl('div', { text: '隐藏列', cls: 'mddb-context-item' });
    hideItem.addEventListener('click', () => { this.vm.hideColumn(colName); menu.remove(); });

    const showAllItem = menu.createEl('div', { text: '显示所有列', cls: 'mddb-context-item' });
    showAllItem.addEventListener('click', () => { this.vm.showAllColumns(); menu.remove(); });

    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', close); }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  private showActionMenu(anchor: HTMLElement, storagePk: string, cells: Record<string, unknown>): void {
    const old = this.el.querySelector('.mddb-action-menu');
    if (old) old.remove();

    const menu = this.el.createEl('div', { cls: 'mddb-action-menu' });

    const editItem = menu.createEl('div', { text: '✏️ 编辑', cls: 'mddb-context-item' });
    editItem.addEventListener('click', () => {
      this.showFormModal('edit', storagePk, cells);
      menu.remove();
    });

    const deleteItem = menu.createEl('div', { text: '🗑️ 删除', cls: 'mddb-context-item' });
    deleteItem.addEventListener('click', async () => {
      menu.remove();
      await this.vm.deleteRow(storagePk);
    });

    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node) && e.target !== anchor) {
          menu.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  private showFormModal(mode: 'new' | 'edit', storagePk?: string, values?: Record<string, unknown>): void {
    const table = this.vm['viewConfig'].table;
    const engine = this.vm['engine'];
    const schema = engine.schemaRegistry.getSchema(table);
    if (!schema) return;

    const overlay = document.createElement('div');
    overlay.addClass('mddb-modal-overlay');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.3);z-index:1000;display:flex;align-items:center;justify-content:center';

    const modal = document.createElement('div');
    modal.addClass('mddb-modal');
    modal.style.cssText = 'background:var(--background-primary);border-radius:8px;padding:20px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto';

    const { element: formEl, getValues } = FormBuilder.render(engine, schema, { mode, values });
    modal.appendChild(formEl);

    const btnRow = modal.createEl('div', { cls: 'mddb-form-actions' });
    const submitBtn = btnRow.createEl('button', { text: mode === 'new' ? '创建' : '保存', cls: 'mddb-form-submit' });
    const cancelBtn = btnRow.createEl('button', { text: '取消', cls: 'mddb-form-cancel' });
    const statusEl = btnRow.createEl('span', { cls: 'mddb-form-status' });

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      statusEl.setText('Saving...');
      try {
        const record = getValues();
        if (mode === 'new') {
          await this.vm.insertRow(record);
        } else if (storagePk) {
          await engine.update(storagePk, record);
        }
        statusEl.setText('Saved ✓');
        setTimeout(() => overlay.remove(), 500);
      } catch (e) {
        statusEl.setText(`Error: ${(e as Error).message}`);
        submitBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }
}
```

---

### Task 5: 修改 main.ts — mddb-table 处理器改用 ViewModel

**Files:**
- Modify: `Obsidian-mddb/src/main.ts`

**新增 import：**
```typescript
import { TableViewModel } from './view/table/table-view-model';
import { InlineTableRenderer } from './view/table/inline-renderer';
import { FormBuilder } from './view/shared/form-builder';
```

**替换 mddb-table 处理器（line 115-179）：**

```typescript
this.registerMarkdownCodeBlockProcessor('mddb-table', (source, el) => {
  if (el.hasClass('mddb-rendered')) return;
  el.addClass('mddb-rendered');
  el.empty();

  const result = parseTableBlock(source);
  if (!result.success || !result.config) {
    el.createEl('div', { cls: 'mddb-error', text: `MD-DB parse error:\n${result.errors.join('\n')}` });
    return;
  }

  const config = result.config;
  // 确保包含 storage_pk 列（编辑/删除需要）
  if (!config.columns.includes('storage_pk')) {
    config.columns = ['storage_pk', ...config.columns];
  }

  const vm = new TableViewModel(`table-${Date.now()}`, this.engine, config);
  vm.initialize().then(() => {
    const renderer = new InlineTableRenderer(vm, el);
    renderer.mount();
    (el as any).__mddbRenderer = renderer;
    (el as any).__mddbViewModel = vm;
  });
});
```

**修改 parser.ts 中 readonly 默认值（line 131）：**
```typescript
readonly: false,  // 改为 false，表格支持编辑
```

---

### Task 6: 运行测试验证

```bash
cd Obsidian-mddb
npx vitest run
```

预期：所有测试通过（原有 ~316 测试 + 新增 5 个测试全部通过）

---

## 实施顺序

| 顺序 | Task | 产出 |
|:----:|------|------|
| 1 | Task 1: 增强 shared/types.ts | 新增事件类型 + EditingCell 接口 |
| 2 | Task 2: 增强 TableViewModel | 编辑/列控制/CRUD 方法 + 测试通过 |
| 3 | Task 3: 提取 FormBuilder | form-builder.ts + main.ts 简化 |
| 4 | Task 4: 创建 InlineTableRenderer | inline-renderer.ts |
| 5 | Task 5: 修改 main.ts | mddb-table 处理器改用 ViewModel |
| 6 | Task 6: 运行全量测试 | 确认所有测试通过 |
