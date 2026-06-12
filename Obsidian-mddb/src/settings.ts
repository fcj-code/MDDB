import { App, PluginSettingTab, Setting } from 'obsidian';
import type MDDBPlugin from './main';

export interface MDDBSettings {
  /** 日志级别 */
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  /** 是否在启动时自动扫描 */
  autoScanOnStart: boolean;
  /** 后台重扫间隔（分钟），0 = 禁用 */
  backgroundRescanIntervalMin: number;
  /** 数据文件路径（相对 vault），空 = vault 根 */
  dataPath: string;
  /** 缓存路径（相对 vault） */
  cachePath: string;
  /** WAL 日志路径（相对 vault） */
  walPath: string;
  /** raw SQL 高级模式开关 */
  rawSqlAdvancedMode: boolean;
  /** 最大查询行数 */
  maxQueryRows: number;
}

export const DEFAULT_SETTINGS: MDDBSettings = {
  logLevel: 'warn',
  autoScanOnStart: true,
  backgroundRescanIntervalMin: 60,
  dataPath: '',
  cachePath: '.mddb/cache',
  walPath: '.mddb/wals',
  rawSqlAdvancedMode: false,
  maxQueryRows: 5000,
};

export class MDDBSettingTab extends PluginSettingTab {
  plugin: MDDBPlugin;

  constructor(app: App, plugin: MDDBPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'MD-DB Settings' });

    new Setting(containerEl)
      .setName('Log level')
      .setDesc('Minimum log level for diagnostics')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            error: 'Error',
            warn: 'Warning',
            info: 'Info',
            debug: 'Debug',
          })
          .setValue(this.plugin.settings.logLevel)
          .onChange(async (value) => {
            this.plugin.settings.logLevel = value as MDDBSettings['logLevel'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auto-scan on start')
      .setDesc('Scan all Markdown files when Obsidian starts')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoScanOnStart)
          .onChange(async (value) => {
            this.plugin.settings.autoScanOnStart = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Background rescan interval')
      .setDesc('Minutes between background rescans (0 = disabled)')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.backgroundRescanIntervalMin))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.backgroundRescanIntervalMin = num;
              await this.plugin.saveSettings();
            }
          }),
      );

    // ── 新增设置 ──

    new Setting(containerEl)
      .setName('Data path')
      .setDesc('Base path for MD-DB data files (relative to vault root)')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.dataPath)
          .onChange(async (value) => {
            this.plugin.settings.dataPath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Cache path')
      .setDesc('Path for cache files (relative to vault root)')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.cachePath)
          .onChange(async (value) => {
            this.plugin.settings.cachePath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('WAL path')
      .setDesc('Path for WAL journal files (relative to vault root)')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.walPath)
          .onChange(async (value) => {
            this.plugin.settings.walPath = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Raw SQL advanced mode')
      .setDesc('Enable raw SQL in query blocks (unsafe)')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.rawSqlAdvancedMode)
          .onChange(async (value) => {
            this.plugin.settings.rawSqlAdvancedMode = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Max query rows')
      .setDesc('Maximum rows returned by any query (default: 5000)')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxQueryRows))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxQueryRows = num;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
