/**
 * FileWatcher 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FileWatcher } from './file-watcher';

describe('FileWatcher', () => {
  let watcher: FileWatcher;

  beforeEach(() => {
    watcher = new FileWatcher();
  });

  describe('event handling', () => {
    it('fires create handler', async () => {
      const events: string[] = [];
      watcher.on('create', (e) => { events.push(e.filePath); });

      await watcher.onFileCreate('test.md');
      expect(events).toContain('test.md');
    });

    it('fires modify handler', async () => {
      const events: string[] = [];
      watcher.on('modify', (e) => { events.push(e.filePath); });

      await watcher.onFileModify('test.md');
      expect(events).toContain('test.md');
    });

    it('fires delete handler', async () => {
      const events: string[] = [];
      watcher.on('delete', (e) => { events.push(e.filePath); });

      await watcher.onFileDelete('test.md');
      expect(events).toContain('test.md');
    });

    it('fires rename handler with old path', async () => {
      const events: Array<{ newPath: string; oldPath: string }> = [];
      watcher.on('rename', (e) => { events.push({ newPath: e.filePath, oldPath: e.oldPath! }); });

      await watcher.onFileRename('old.md', 'new.md');
      expect(events[0]!.newPath).toBe('new.md');
      expect(events[0]!.oldPath).toBe('old.md');
    });

    it('supports multiple handlers', async () => {
      let count = 0;
      watcher.on('create', () => { count++; });
      watcher.on('create', () => { count++; });

      await watcher.onFileCreate('test.md');
      expect(count).toBe(2);
    });

    it('returns unregister function', async () => {
      let count = 0;
      const unregister = watcher.on('create', () => { count++; });
      unregister();

      await watcher.onFileCreate('test.md');
      expect(count).toBe(0);
    });
  });

  describe('self-change detection', () => {
    it('skips self changes by default', async () => {
      const events: string[] = [];
      watcher.on('modify', (e) => { events.push(e.filePath); });

      watcher.registerOwner('write-op-1');
      await watcher.onFileModify('test.md', 'write-op-1');
      expect(events).toHaveLength(0);
    });

    it('processes non-owner modifications', async () => {
      const events: string[] = [];
      watcher.on('modify', (e) => { events.push(e.filePath); });

      watcher.registerOwner('write-op-1');
      await watcher.onFileModify('test.md', 'external-editor');
      expect(events).toHaveLength(1);
    });

    it('processes events after owner unregistered', async () => {
      const events: string[] = [];
      watcher.on('modify', (e) => { events.push(e.filePath); });

      watcher.registerOwner('write-op-1');
      watcher.unregisterOwner('write-op-1');
      await watcher.onFileModify('test.md', 'write-op-1');
      expect(events).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
    it('stops processing events after shutdown', async () => {
      const events: string[] = [];
      watcher.on('create', (e) => { events.push(e.filePath); });

      watcher.shutdown();
      await watcher.onFileCreate('test.md');
      expect(events).toHaveLength(0);
    });
  });
});
