/**
 * @vitest-environment jsdom
 *
 * 测试：代码块处理器的双重解析问题
 *
 * Obsidian 在切换 leaf（标签页）时，会在多个渲染阶段调用同一个代码块处理器：
 *   - e.sync — 初始 DOM 渲染
 *   - o.postProcess — Markdown 后处理
 * 每个阶段都可能多次调用，且 sourceLen 可能不同。
 *
 * 修复方案：使用 WeakSet 跟踪同一事件循环中已处理过的 el，
 * 在处理器入口处跳过重复调用。
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ============================================================
// 模拟 Obsidian 的 el 元素
// ============================================================

function createMockEl(): HTMLElement {
  return document.createElement('div');
}

// ============================================================
// 模拟的处理器（同步版 — 类似 mddb-table）
// ============================================================

function createSyncHandler() {
  return (source: string, el: HTMLElement): void => {
    el.innerHTML = '';
    const content = document.createElement('div');
    content.className = 'mddb-content';
    content.textContent = `rendered: ${source}`;
    el.appendChild(content);
  };
}

// ============================================================
// 模拟的异步处理器（类似 mddb-form）— 无保护版本
// ============================================================

function createAsyncHandlerUnprotected() {
  return async (source: string, el: HTMLElement): Promise<void> => {
    el.innerHTML = '';
    await new Promise(resolve => setTimeout(resolve, 10));
    const content = document.createElement('div');
    content.className = 'mddb-content';
    content.textContent = `rendered: ${source}`;
    el.appendChild(content);
  };
}

// ============================================================
// 模拟的异步处理器（类似 mddb-form）— WeakSet 保护版
// ============================================================

function createAsyncHandlerWeakSet() {
  const rendering = new WeakSet<HTMLElement>();
  return async (source: string, el: HTMLElement): Promise<void> => {
    if (rendering.has(el)) return;
    rendering.add(el);
    queueMicrotask(() => rendering.delete(el));
    el.innerHTML = '';
    await new Promise(resolve => setTimeout(resolve, 10));
    const content = document.createElement('div');
    content.className = 'mddb-content';
    content.textContent = `rendered: ${source}`;
    el.appendChild(content);
  };
}

// ============================================================
// 测试
// ============================================================

describe('双重解析修复测试', () => {
  describe('同步处理器 (mddb-table)', () => {
    it('el.innerHTML = "" 应防止双重渲染', () => {
      const handler = createSyncHandler();
      const el = createMockEl();
      handler('test', el);
      handler('test', el);
      expect(el.querySelectorAll('.mddb-content').length).toBe(1);
    });

    it('没有 el.innerHTML = "" 时应有双重渲染', () => {
      const el = createMockEl();
      const c1 = document.createElement('div');
      c1.className = 'mddb-content';
      el.appendChild(c1);
      const c2 = document.createElement('div');
      c2.className = 'mddb-content';
      el.appendChild(c2);
      expect(el.querySelectorAll('.mddb-content').length).toBe(2);
    });
  });

  describe('异步处理器 (mddb-form) — 竞态条件', () => {
    it('无保护版本：两次并发调用应导致双重渲染', async () => {
      const handler = createAsyncHandlerUnprotected();
      const el = createMockEl();
      const p1 = handler('test', el);
      const p2 = handler('test', el);
      await Promise.all([p1, p2]);
      expect(el.querySelectorAll('.mddb-content').length).toBeGreaterThan(1);
    });

    it('WeakSet 保护版：同一事件循环中多次调用应只有第一次渲染', async () => {
      const handler = createAsyncHandlerWeakSet();
      const el = createMockEl();
      const p1 = handler('test', el);
      const p2 = handler('test', el);
      await Promise.all([p1, p2]);
      expect(el.querySelectorAll('.mddb-content').length).toBe(1);
    });

    it('WeakSet 保护版：同一事件循环中三次调用应只有第一次渲染', async () => {
      const handler = createAsyncHandlerWeakSet();
      const el = createMockEl();
      const p1 = handler('a', el);
      const p2 = handler('b', el);
      const p3 = handler('c', el);
      await Promise.all([p1, p2, p3]);
      const contents = el.querySelectorAll('.mddb-content');
      expect(contents.length).toBe(1);
      expect(contents[0]!.textContent).toBe('rendered: a');
    });
  });

  describe('综合测试', () => {
    it('同步 + 异步互不影响', async () => {
      const syncHandler = createSyncHandler();
      const asyncHandler = createAsyncHandlerWeakSet();
      const syncEl = createMockEl();
      const asyncEl = createMockEl();
      syncHandler('sync', syncEl);
      syncHandler('sync', syncEl);
      expect(syncEl.querySelectorAll('.mddb-content').length).toBe(1);
      const p1 = asyncHandler('async', asyncEl);
      const p2 = asyncHandler('async', asyncEl);
      await Promise.all([p1, p2]);
      expect(asyncEl.querySelectorAll('.mddb-content').length).toBe(1);
    });
  });
});
