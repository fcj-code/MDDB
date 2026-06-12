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
