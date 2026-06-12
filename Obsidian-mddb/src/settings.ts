import { App, PluginSettingTab, Setting } from 'obsidian';
import type MDDBPlugin from './main';

export interface MDDBSettings {
  /** 日志级别 */
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  /** 是否在启动时自动扫描 */
  autoScanOnStart: boolean;
  /** 后台重扫间隔（分钟），0 = 禁用 */
  backgroundRescanIntervalMin: number;
}

export const DEFAULT_SETTINGS: MDDBSettings = {
  logLevel: 'warn',
  autoScanOnStart: true,
  backgroundRescanIntervalMin: 60,
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
  }
}
