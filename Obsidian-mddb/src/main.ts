import { Notice, Plugin, TFile, TFolder } from 'obsidian';
import { DEFAULT_SETTINGS, MDDBSettingTab, type MDDBSettings } from './settings';
import { MDDBEngine } from './engine/engine';
import { ViewIntegration } from './view/integration';
import type { FileOperator } from './write/types';
import { TABLE_VIEW_TYPE } from './view/table/table-view';
import { parseTableBlock } from './view/parser';
import type { VaultScanResult } from './parse/pipeline';
import { FormBuilder } from './view/shared/form-builder';

// sql.js JS 在 esbuild 打包时内联，WASM 通过 fs.readFileSync 加载
// （__dirname 在 Obsidian Electron 中不可靠，且 file:// 被安全策略阻止）
import initSqlJs from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

// 全局引擎实例引用，供视图模块访问
let globalEngine: MDDBEngine | null = null;
export function getEngine(): MDDBEngine | null {
  return globalEngine;
}

export default class MDDBPlugin extends Plugin {
  settings!: MDDBSettings;
  engine!: MDDBEngine;
  viewIntegration!: ViewIntegration;

  async onload() {
    await this.loadSettings();

    // ── 创建引擎 ──
    const fileOperator = this.createFileOperator();
    this.engine = new MDDBEngine(fileOperator, this.settings);
    globalEngine = this.engine;

    // ── 初始化引擎 ──
    try {
      // 用 fs.readFileSync 加载 WASM 二进制 → wasmBinary 绕过 Electron file:// 限制
      const vaultBasePath =
        (this.app.vault.adapter as any).getBasePath?.() ?? '';
      const pluginDir = path.join(vaultBasePath, '.obsidian', 'plugins', 'md-db');
      const wasmPath = path.join(pluginDir, 'sql-wasm.wasm');
      const wasmBinary = fs.readFileSync(wasmPath).buffer as ArrayBuffer;

      // 创建包装 init 函数，sqlite-adapter 内部会调用它
      const initSqlJsWithWasm = () => initSqlJs({ wasmBinary });
      await this.engine.initialize(initSqlJsWithWasm, this.manifest.version);
      new Notice('MD-DB: Engine ready');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`MD-DB: Engine init failed — ${msg}`, 0);
      console.error('MD-DB engine init error:', e);
    }

    // ── 功能区图标 ──
    this.addRibbonIcon('database', 'MD-DB', () => {
      void this.showStats();
    });

    // ── 状态栏 ──
    const statusBarEl = this.addStatusBarItem();
    this.registerInterval(
      window.setInterval(() => {
        if (this.engine.ready) {
          statusBarEl.setText('MD-DB: ready');
        } else {
          statusBarEl.setText('MD-DB: initializing...');
        }
      }, 5000),
    );

    // ── 命令 ──
    this.addCommand({
      id: 'rescan-vault',
      name: 'Rescan vault',
      callback: () => this.rescanVault(),
    });
    this.addCommand({
      id: 'show-stats',
      name: 'Show stats',
      callback: () => this.showStats(),
    });
    this.addCommand({
      id: 'clear-cache',
      name: 'Clear cache and rebuild',
      callback: () => this.clearCache(),
    });
    this.addCommand({
      id: 'retry-dead-wal',
      name: 'Retry dead WAL entries',
      callback: () => this.retryDeadWals(),
    });
    this.addCommand({
      id: 'show-diagnostics',
      name: 'Show diagnostics',
      callback: () => this.showDiagnostics(),
    });
    this.addCommand({
      id: 'clear-logs',
      name: 'Clear logs',
      callback: () => this.clearLogs(),
    });
    this.addCommand({
      id: 'rebuild-cache',
      name: 'Rebuild cache',
      callback: () => this.rebuildCache(),
    });

    // ── 设置面板 ──
    this.addSettingTab(new MDDBSettingTab(this.app, this));

    // ── 视图集成 ──
    this.viewIntegration = new ViewIntegration(this, this.engine);
    this.viewIntegration.registerViews();

    // ── mddb-table 代码块处理器 ──
    this.registerMarkdownCodeBlockProcessor('mddb-table', (source, el) => {
      // 每个 el 只渲染一次 — Obsidian 在 sync + postProcess 等多个阶段重复调用
      if (el.hasClass('mddb-rendered')) return;
      el.addClass('mddb-rendered');

      el.empty();

      const result = parseTableBlock(source);
      if (!result.success || !result.config) {
        el.createEl('div', {
          cls: 'mddb-error',
          text: `MD-DB parse error:\n${result.errors.join('\n')}`,
        });
        return;
      }

      const config = result.config;
      const { engine } = this;

      // 执行查询并渲染
      // 使用字段名字符串数组，确保 sql-generator 能正确处理
      const selectClause = config.columns.length > 0
        ? { columns: config.columns }
        : undefined;

      const query = {
        table: config.table,
        select: selectClause,
        sort: config.sort,
        limit: config.pageSize ?? 200,
      };

      const queryResult = engine.query(query);
      if (!queryResult.ok) {
        el.createEl('div', { cls: 'mddb-error', text: `Query error: ${queryResult.error.message}` });
        return;
      }

      const rs = queryResult.value;

      // 渲染表格
      const table = el.createEl('table', { cls: 'mddb-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      for (const col of rs.columns) {
        headerRow.createEl('th', { text: col.name });
      }

      const tbody = table.createEl('tbody');
      for (const row of rs.rows) {
        const tr = tbody.createEl('tr');
        for (const col of rs.columns) {
          tr.createEl('td', { text: formatCellValue(row[col.name]) });
        }
      }

      // 行数提示
      if (rs.total > rs.rows.length) {
        el.createEl('div', {
          cls: 'mddb-pagination',
          text: `Showing ${rs.rows.length} of ${rs.total} rows`,
        });
      }
    });

    // ── mddb-form 代码块处理器 ──
    this.registerMarkdownCodeBlockProcessor('mddb-form', async (source, el) => {
      // 每个 el 只渲染一次 — Obsidian 在 sync + postProcess 等多个阶段重复调用
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

    // ── 文件变更监听 ──
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith('.md')) return;
        this.app.vault.read(file).then(content => {
          return this.engine.onFileCreated(file.path, content);
        }).catch((err) => {
          // 单个文件解析错误不影响整体 — 如 schema 校验失败、非 mddb 文件等
          if (err && (err as Error).message?.includes('Schema') === false) {
            console.warn('MD-DB onFileCreated:', (err as Error).message ?? err);
          }
        });
      }),
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith('.md')) return;
        this.app.vault.read(file).then(content => {
          return this.engine.onFileModified(file.path, content, 'plugin');
        }).catch((err) => {
          if (err && (err as Error).message?.includes('Schema') === false) {
            console.warn('MD-DB onFileModified:', (err as Error).message ?? err);
          }
        });
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith('.md')) return;
        this.engine.onFileDeleted(file.path).catch((err) => {
          console.warn('MD-DB onFileDeleted:', (err as Error).message ?? err);
        });
      }),
    );

    // ── 自动扫描 ──
    if (this.settings.autoScanOnStart) {
      this.app.workspace.onLayoutReady(() => {
        void this.rescanVault();
      });
    }
  }

  onunload() {
    globalEngine = null;
    // 引擎 shutdown：关闭 SQLite、清理定时器、释放锁
    this.engine?.shutdown().catch((e: unknown) => {
      console.error('MD-DB shutdown error:', e);
    });
  }

  // ── 设置持久化 ───────────────────────────

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<MDDBSettings>,
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── 命令回调 ─────────────────────────────

  private async rescanVault() {
    if (!this.engine.ready) {
      new Notice('MD-DB: Engine not ready');
      return;
    }

    new Notice('MD-DB: Scanning vault...');
    const files: Array<{ path: string; content: string }> = [];

    // 收集所有 Markdown 文件
    const collectMd = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.path.endsWith('.md')) {
          // 读取内容
          try {
            const content = this.app.vault.cachedRead(child);
            files.push({ path: child.path, content: '' });
          } catch {}
        } else if (child instanceof TFolder) {
          collectMd(child);
        }
      }
    };
    collectMd(this.app.vault.getRoot());

    // 分批读取并扫描
    let totalFiles = 0;
    let totalErrors = 0;
    const batchSize = 50;

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      for (const f of batch) {
        try {
          const file = this.app.vault.getAbstractFileByPath(f.path);
          if (file instanceof TFile) {
            f.content = await this.app.vault.cachedRead(file);
          }
        } catch {}
      }

      if (batch.some(f => f.content.length > 0)) {
        // 只传递有内容的文件给引擎
        const withContent = batch.filter(f => f.content.length > 0);
        if (withContent.length > 0) {
          const result = this.engine.rescanVault(withContent);
          totalFiles += result.fileResults.length;
          totalErrors += result.totalErrors;
        }
      }
    }

    if (totalErrors > 0) {
      new Notice(`MD-DB: Scan complete — ${totalFiles} files, ${totalErrors} errors`);
    } else {
      new Notice(`MD-DB: Scan complete — ${totalFiles} files indexed`);
    }
  }

  private async showStats() {
    if (!this.engine.ready) {
      new Notice('MD-DB: Engine not ready');
      return;
    }

    try {
      const diag = await this.engine.getDiagnostics();
      const lines = [
        `Status: ${diag.engineStatus}`,
        `Tables: ${diag.tableCount}`,
        `Rows: ${diag.rowCount}`,
        `WAL pending: ${diag.pendingWalCount}`,
        `WAL dead: ${diag.deadWalCount}`,
        `Errors: ${diag.recentErrorCount}`,
      ];
      new Notice(lines.join(' | '), 8000);
    } catch (e) {
      new Notice(`MD-DB: Stats error — ${e}`);
    }
  }

  private async clearCache() {
    if (!this.engine.ready) {
      new Notice('MD-DB: Engine not ready');
      return;
    }
    new Notice('MD-DB: Cache cleared, rebuilding...');
    // 下次全量扫描会自动重建 cache
    await this.rescanVault();
  }

  private async retryDeadWals() {
    if (!this.engine.ready) {
      new Notice('MD-DB: Engine not ready');
      return;
    }
    const count = await this.engine.retryAllDeadLetters();
    new Notice(`MD-DB: Retried ${count} dead WAL entries`);
  }

  private async showDiagnostics() {
    const result = await this.engine.executeDiagnosticCommand('show-diagnostics');
    new Notice(result.message, 10000);
  }

  private async clearLogs() {
    if (!this.engine.ready) {
      new Notice('MD-DB: Engine not ready');
      return;
    }
    await this.engine.executeDiagnosticCommand('clear-logs');
    new Notice('MD-DB: Logs cleared');
  }

  private async rebuildCache() {
    if (!this.engine.ready) {
      new Notice('MD-DB: Engine not ready');
      return;
    }
    new Notice('MD-DB: Rebuilding cache...');
    await this.engine.rebuildCache();
    // 触发全量扫描以重新填充 cache
    await this.rescanVault();
  }

  // ── FileOperator 实现 ──────────────────

  private createFileOperator(): FileOperator {
    const vault = this.app.vault;

    return {
      async readFile(filePath: string): Promise<string> {
        const file = vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
          throw new Error(`File not found: ${filePath}`);
        }
        return vault.read(file);
      },

      async writeFile(filePath: string, content: string): Promise<void> {
        const file = vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          await vault.modify(file, content);
        } else {
          // 文件不存在 → 创建
          await vault.create(filePath, content);
        }
      },

      async processFile(
        filePath: string,
        updater: (content: string) => string,
      ): Promise<string> {
        const file = vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
          throw new Error(`File not found: ${filePath}`);
        }
        return vault.process(file, updater);
      },
    };
  }
}

// ── 辅助 ──

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return '-';
  if (typeof val === 'number') {
    return String(val);
  }
  return String(val);
}

// ============================================================
// mddb-form 块解析
// ============================================================

interface FormConfig {
  table: string;
  fields: string[];
  mode: 'new' | 'edit';
  layout: 'normal' | 'vertical';
  keepOpen: boolean;
}

function parseFormBlock(source: string): FormConfig | null {
  const config: FormConfig = { table: '', fields: [], mode: 'new', layout: 'normal', keepOpen: false };
  let tableFound = false;

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf(' ');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();

    switch (key) {
      case 'to':
        config.table = val;
        tableFound = true;
        break;
      case 'fields':
        config.fields = val.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'mode':
        config.mode = val === 'edit' ? 'edit' : 'new';
        break;
      case 'layout':
        config.layout = val === 'vertical' ? 'vertical' : 'normal';
        break;
      case 'keep-open':
        config.keepOpen = val === 'true' || val === 'yes';
        break;
    }
  }

  return tableFound ? config : null;
}
