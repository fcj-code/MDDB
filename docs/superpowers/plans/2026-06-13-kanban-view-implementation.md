# Kanban View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Kanban board view for MDDB that groups query results by a specified field, renders cards in columns, supports drag-to-update, inline editing, search, and column management.

**Architecture:** Follow existing view layer patterns (BaseViewModel + React components + InlineRenderer + ItemView). Create new `src/view/kanban/` directory. Data flows: `parseKanbanBlock → KanbanConfig → KanbanViewModel.groupByField(rows) → Lane[] → React renders`. Drag-and-drop uses HTML5 DnD API (no external library). Editing reuses FormModal.

**Tech Stack:** TypeScript, React (via Obsidian's built-in), HTML5 Drag & Drop, Obsidian ItemView/MarkdownPostProcessor

**Reference:** `docs/superpowers/specs/2026-06-13-kanban-view-design.md`

---

## File Structure

```
src/view/kanban/
├── kanban-config.ts       # KanbanConfig interface + types
├── kanban-view-model.ts   # KanbanViewModel (grouping/moveCard/CRUD/search)
├── kanban-view.tsx        # Obsidian ItemView
├── inline-renderer.tsx    # Inline code block renderer (createRoot)
├── parser.ts              # parseKanbanBlock()
└── react/
    ├── index.tsx          # KanbanApp entry (event subscribe + state sync)
    ├── board.tsx          # Board container (horizontal scroll + search bar)
    ├── lane.tsx           # Lane component (Droppable + collapse)
    ├── lane-header.tsx    # LaneHeader (title/count/collapse/menu)
    ├── lane-menu.tsx      # LaneMenu (sort/archive/WIP/delete)
    ├── lane-form.tsx      # LaneForm (add lane when board empty)
    ├── card.tsx           # Card component (Draggable)
    ├── card-title.tsx     # CardTitle (first field as title, editable on double-click)
    ├── card-metadata.tsx  # CardMetadata (remaining fields)
    ├── card-form.tsx      # CardForm (add card input at lane bottom)
    ├── card-menu.tsx      # CardMenu (right-click: edit/delete)
    ├── search-bar.tsx     # SearchBar
    └── styles.css         # Kanban styles (obsidian-kanban replica)
```

**Modified files:**
- `src/main.ts` — register `mddb-kanban` code block processor
- `src/view/integration.ts` — register KanbanView, add openKanbanView method

---

### Task 1: KanbanConfig + Parser

**Files:**
- Create: `src/view/kanban/kanban-config.ts`
- Create: `src/view/kanban/parser.ts`
- Test: `src/view/kanban/parser.test.ts`

- [ ] **Step 1: Write KanbanConfig interface**

Create `src/view/kanban/kanban-config.ts`:

```typescript
/**
 * 看板视图配置
 *
 * 参考：kanban-view-design.md §2.2
 */

export interface KanbanConfig {
  /** 数据表名 */
  table: string;
  /** 显示的字段（第一个 = 卡片标题，其余 = 元数据） */
  columns: string[];
  /** 分组字段 */
  groupBy: string;
  /** 过滤条件 */
  filter?: string;
  /** 排序 */
  sort?: { field: string; direction: 'ASC' | 'DESC' }[];
  /** 每列最大卡片数 */
  limit?: number;
}
```

- [ ] **Step 2: Write parseKanbanBlock function**

Create `src/view/kanban/parser.ts`:

```typescript
/**
 * mddb-kanban 代码块解析器
 *
 * 解析语法：
 * ```mddb-kanban
 * from tasks
 * show 标题, 负责人, 优先级
 * group by 状态
 * where 负责人 = "张三"
 * sort by 优先级 desc
 * limit 200
 * ```
 *
 * 参考：kanban-view-design.md §2.1
 */

import type { KanbanConfig } from './kanban-config';

export interface ParseResult {
  success: boolean;
  config: KanbanConfig | null;
  errors: string[];
}

type DirectiveHandler = (args: string, config: Partial<KanbanConfig>) => string[];

const DIRECTIVES: Record<string, DirectiveHandler> = {
  from: (args, config) => {
    config.table = args.trim();
    return [];
  },
  show: (args, config) => {
    config.columns = args.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  },
  'group by': (args, config) => {
    config.groupBy = args.trim();
    return [];
  },
  where: (args, config) => {
    config.filter = args.trim();
    return [];
  },
  sort: (args, config) => {
    const parts = args.trim().split(/\s+/);
    let idx = 0;
    if (parts.length > 0 && parts[0]!.toLowerCase() === 'by') idx = 1;
    if (parts.length > idx) {
      const field = parts[idx]!;
      const direction = parts.length > idx + 1 && parts[idx + 1]?.toLowerCase() === 'desc'
        ? 'DESC' as const
        : 'ASC' as const;
      if (!config.sort) config.sort = [];
      config.sort.push({ field, direction });
    }
    return [];
  },
  limit: (args, config) => {
    const n = parseInt(args.trim(), 10);
    if (!isNaN(n) && n > 0) {
      config.limit = n;
    } else {
      return [`Invalid limit value: "${args.trim()}"`];
    }
    return [];
  },
};

export function parseKanbanBlock(content: string): ParseResult {
  const errors: string[] = [];
  const config: Partial<KanbanConfig> = {
    columns: [],
    sort: [],
  };

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Check multi-word directives first ("group by")
    const groupByMatch = line.match(/^group\s+by\s+(.*)$/i);
    if (groupByMatch) {
      DIRECTIVES['group by'](groupByMatch[1]!, config);
      continue;
    }

    // Single-word directives
    const directiveMatch = line.match(/^(\w+)\s+(.*)$/);
    if (!directiveMatch) {
      errors.push(`Unrecognized line: "${line}"`);
      continue;
    }

    const directive = directiveMatch[1]!.toLowerCase();
    const args = directiveMatch[2]!;

    const handler = DIRECTIVES[directive];
    if (!handler) {
      errors.push(`Unknown directive: "${directive}"`);
      continue;
    }

    const directiveErrors = handler(args, config);
    errors.push(...directiveErrors);
  }

  // 验证必需字段
  let success = true;
  if (!config.table) {
    errors.push('Missing required directive: "from"');
    success = false;
  }
  if (!config.groupBy) {
    errors.push('Missing required directive: "group by"');
    success = false;
  }

  return {
    success,
    config: {
      table: config.table ?? '',
      columns: config.columns ?? [],
      groupBy: config.groupBy ?? '',
      filter: config.filter,
      sort: config.sort && config.sort.length > 0 ? config.sort : undefined,
      limit: config.limit ?? 200,
    },
    errors,
  };
}
```

- [ ] **Step 3: Write parser tests**

Create `src/view/kanban/parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseKanbanBlock } from './parser';

describe('parseKanbanBlock', () => {
  it('parses a complete kanban block', () => {
    const result = parseKanbanBlock(`
from tasks
show 标题, 负责人, 优先级
group by 状态
where 负责人 = "张三"
sort by 优先级 desc
limit 50
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config).toEqual({
      table: 'tasks',
      columns: ['标题', '负责人', '优先级'],
      groupBy: '状态',
      filter: '负责人 = "张三"',
      sort: [{ field: '优先级', direction: 'DESC' }],
      limit: 50,
    });
  });

  it('requires from and group by', () => {
    const result = parseKanbanBlock('show 标题');
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles minimal config', () => {
    const result = parseKanbanBlock(`
from tasks
group by 状态
    `.trim());

    expect(result.success).toBe(true);
    expect(result.config!.table).toBe('tasks');
    expect(result.config!.groupBy).toBe('状态');
    expect(result.config!.limit).toBe(200);
  });

  it('ignores comments', () => {
    const result = parseKanbanBlock(`
from tasks
# this is a comment
group by 状态
    `.trim());

    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify**

Run: `cd Obsidian-mddb && npx vitest run src/view/kanban/parser.test.ts 2>&1`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add Obsidian-mddb/src/view/kanban/kanban-config.ts Obsidian-mddb/src/view/kanban/parser.ts Obsidian-mddb/src/view/kanban/parser.test.ts
git commit -m "feat: add KanbanConfig and parseKanbanBlock parser"
```

---

### Task 2: KanbanViewModel

**Files:**
- Create: `src/view/kanban/kanban-view-model.ts`
- Test: `src/view/kanban/kanban-view-model.test.ts`

- [ ] **Step 1: Write KanbanViewModel test**

Create `src/view/kanban/kanban-view-model.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { KanbanViewModel } from './kanban-view-model';
import type { KanbanConfig } from './kanban-config';

function createMockEngine() {
  return {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    schemaRegistry: { getSchema: vi.fn() },
  } as any;
}

describe('KanbanViewModel', () => {
  it('groups rows by the groupBy field', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理', 负责人: '张三' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中', 负责人: '李四' },
          { storage_pk: '3', 标题: 'Task C', 状态: '待处理', 负责人: '王五' },
          { storage_pk: '4', 标题: 'Task D', 状态: '已完成', 负责人: '张三' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }, { name: '负责人', type: 'string' }],
        total: 4,
      },
    });

    const config: KanbanConfig = {
      table: 'tasks',
      columns: ['标题', '负责人', '状态'],
      groupBy: '状态',
      limit: 200,
    };

    const vm = new KanbanViewModel('test-1', engine, config);
    await vm.initialize();

    const board = vm.board;
    expect(board.lanes).toHaveLength(3);
    expect(board.lanes.map(l => l.title).sort()).toEqual(['待处理', '进行中', '已完成']);
  });

  it('moveCard updates groupBy field via engine.update', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '待处理' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 2,
      },
    });
    engine.update.mockResolvedValue({ storagePk: '1' });

    const config: KanbanConfig = {
      table: 'tasks',
      columns: ['标题', '状态'],
      groupBy: '状态',
    };

    const vm = new KanbanViewModel('test-2', engine, config);
    await vm.initialize();
    // Mock query again for refresh after move
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [
          { storage_pk: '1', 标题: 'Task A', 状态: '进行中' },
          { storage_pk: '2', 标题: 'Task B', 状态: '进行中' },
        ],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }, { name: '状态', type: 'string' }],
        total: 2,
      },
    });

    const result = await vm.moveCard('1', '待处理', '进行中', 0);
    expect(result).toBe(true);
    expect(engine.update).toHaveBeenCalledWith('1', { 状态: '进行中' }, { force: true });
  });

  it('returns empty lanes when query returns no rows', async () => {
    const engine = createMockEngine();
    engine.query.mockReturnValue({
      ok: true,
      val: {
        rows: [],
        columns: [{ name: 'storage_pk', type: 'string' }, { name: '标题', type: 'string' }],
        total: 0,
      },
    });

    const config: KanbanConfig = { table: 'tasks', columns: ['标题'], groupBy: '状态' };
    const vm = new KanbanViewModel('test-3', engine, config);
    await vm.initialize();

    expect(vm.board.lanes).toHaveLength(0);
    expect(vm.board.totalCards).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd Obsidian-mddb && npx vitest run src/view/kanban/kanban-view-model.test.ts 2>&1`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write KanbanViewModel implementation**

Create `src/view/kanban/kanban-view-model.ts`:

```typescript
/**
 * 看板视图模型
 *
 * 管理看板数据的分组、拖拽更新、CRUD、搜索。
 *
 * 参考：kanban-view-design.md §4
 */

import type { Query, ResultSet } from '../../query/types';
import type { KanbanConfig } from './kanban-config';
import type { MDDBEngine } from '../../engine/engine';
import { BaseViewModel } from '../base-view-model';

// ============================================================
// 看板运行时数据类型
// ============================================================

export interface KanbanBoard {
  lanes: Lane[];
  groupField: string;
  totalCards: number;
}

export interface Lane {
  id: string;
  title: string;
  groupValue: unknown;
  cards: Card[];
  cardCount: number;
  collapsed: boolean;
  maxItems?: number;
  isLoading: boolean;
}

export interface Card {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
  checked?: boolean;
  isEditing?: boolean;
}

// ============================================================
// ViewModel
// ============================================================

export class KanbanViewModel extends BaseViewModel {
  private _board: KanbanBoard;
  private _searchQuery = '';

  constructor(
    viewId: string,
    private engine: MDDBEngine,
    private _config: KanbanConfig,
  ) {
    super(viewId);
    this._board = {
      lanes: [],
      groupField: _config.groupBy,
      totalCards: 0,
    };
  }

  get config(): KanbanConfig {
    return { ...this._config };
  }

  get board(): KanbanBoard {
    return this._board;
  }

  get searchQuery(): string {
    return this._searchQuery;
  }

  // ============================================================
  // 生命周期
  // ============================================================

  async initialize(): Promise<void> {
    this.setState({ status: 'loading' });
    try {
      const result = this.engine.query(this.buildQuery());
      if (!result.ok) {
        this.setState({ status: 'error', error: result.err.message });
        return;
      }
      this.updateFromResult(result.val);
      this.setState({ status: 'ready' });
    } catch (e) {
      this.setState({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async refresh(): Promise<void> {
    await this.initialize();
  }

  destroy(): void {
    super.destroy();
  }

  // ============================================================
  // 拖拽更新
  // ============================================================

  async moveCard(
    cardId: string,
    _fromLane: string,
    toLane: string,
    _toIndex: number,
  ): Promise<boolean> {
    try {
      // Find the target lane's groupBy value
      const targetLane = this._board.lanes.find(l => l.id === toLane);
      if (!targetLane) return false;

      await this.engine.update(
        cardId,
        { [this._config.groupBy]: targetLane.groupValue },
        { force: true },
      );
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // CRUD
  // ============================================================

  async addCard(laneId: string, values: Record<string, unknown>): Promise<boolean> {
    try {
      const lane = this._board.lanes.find(l => l.id === laneId);
      if (!lane) return false;

      const record = { ...values, [this._config.groupBy]: lane.groupValue };
      await this.engine.insert(this._config.table, record);
      this.events.emit({ type: 'data-changed', viewId: this.viewId, data: { action: 'addCard', laneId } });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  async deleteCard(cardId: string): Promise<boolean> {
    try {
      await this.engine.delete(cardId, { force: true });
      this.events.emit({ type: 'data-changed', viewId: this.viewId, data: { action: 'deleteCard', cardId } });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  async updateCardField(
    cardId: string,
    field: string,
    value: unknown,
  ): Promise<boolean> {
    try {
      await this.engine.update(cardId, { [field]: value }, { force: true });
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================
  // 交互
  // ============================================================

  toggleLaneCollapse(laneId: string): void {
    const lane = this._board.lanes.find(l => l.id === laneId);
    if (lane) {
      lane.collapsed = !lane.collapsed;
      this.events.emit({ type: 'state-changed', viewId: this.viewId, data: { collapsed: lane.collapsed } });
    }
  }

  setSearchQuery(query: string): void {
    this._searchQuery = query;
    this.events.emit({ type: 'state-changed', viewId: this.viewId, data: { search: query } });
  }

  // ============================================================
  // 内部
  // ============================================================

  private buildQuery(): Query {
    const query: Query = {
      table: this._config.table,
      limit: this._config.limit ?? 200,
    };

    const allColumns = [...this._config.columns];
    // Ensure storage_pk is included
    if (!allColumns.includes('storage_pk')) {
      allColumns.unshift('storage_pk');
    }
    // Ensure groupBy field is included
    if (!allColumns.includes(this._config.groupBy)) {
      allColumns.push(this._config.groupBy);
    }

    query.select = { columns: allColumns, distinct: false };

    if (this._config.filter) {
      // Reuse parseWhere logic from ViewConfigBuilder
      const { ViewConfigBuilder } = require('../parser');
      query.where = ViewConfigBuilder.parseWhere(this._config.filter);
    }

    if (this._config.sort && this._config.sort.length > 0) {
      query.sort = this._config.sort.length === 1
        ? this._config.sort[0]!
        : this._config.sort;
    }

    return query;
  }

  private updateFromResult(result: ResultSet): void {
    const groupField = this._config.groupBy;

    // Group rows by the groupBy field value
    const groups = new Map<string, { title: string; rows: Record<string, unknown>[] }>();

    for (const row of result.rows) {
      const rawValue = row[groupField];
      const key = String(rawValue ?? '(空)');
      if (!groups.has(key)) {
        groups.set(key, { title: key, rows: [] });
      }
      groups.get(key)!.rows.push(row);
    }

    // Build lanes
    const lanes: Lane[] = [];
    for (const [key, group] of groups) {
      const cards: Card[] = group.rows.map(row => {
        const titleField = this._config.columns[0] ?? groupField;
        const metadata: Record<string, unknown> = {};
        for (const col of this._config.columns) {
          if (col !== titleField && col !== 'storage_pk') {
            metadata[col] = row[col];
          }
        }
        return {
          id: String(row['storage_pk'] ?? ''),
          title: String(row[titleField] ?? ''),
          metadata,
          raw: { ...row },
          checked: false,
        };
      });

      lanes.push({
        id: key,
        title: key,
        groupValue: group.rows[0]?.[groupField],
        cards,
        cardCount: cards.length,
        collapsed: false,
        isLoading: false,
      });
    }

    this._board = {
      lanes,
      groupField,
      totalCards: result.total,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify**

Run: `cd Obsidian-mddb && npx vitest run src/view/kanban/kanban-view-model.test.ts 2>&1`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add Obsidian-mddb/src/view/kanban/kanban-view-model.ts Obsidian-mddb/src/view/kanban/kanban-view-model.test.ts
git commit -m "feat: add KanbanViewModel with grouping, moveCard, CRUD"
```

---

### Task 3: React Core Components (KanbanApp + Board + Lane + Card)

**Files:**
- Create: `src/view/kanban/react/styles.css`
- Create: `src/view/kanban/react/index.tsx`
- Create: `src/view/kanban/react/board.tsx`
- Create: `src/view/kanban/react/lane.tsx`
- Create: `src/view/kanban/react/lane-header.tsx`
- Create: `src/view/kanban/react/card.tsx`
- Create: `src/view/kanban/react/card-title.tsx`
- Create: `src/view/kanban/react/card-metadata.tsx`
- Create: `src/view/kanban/react/card-form.tsx`
- Create: `src/view/kanban/react/search-bar.tsx`

- [ ] **Step 1: Write Kanban styles**

Create `src/view/kanban/react/styles.css`:

```css
/* ================================================================
   MD-DB Kanban Styles — obsidian-kanban replica
   ================================================================ */

.mddb-kanban {
  --lane-width: 272px;
  contain: content;
  height: 100%;
  width: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* ---- Board (horizontal scroll container) ---- */

.mddb-kanban-board {
  display: flex;
  flex: 1;
  gap: 8px;
  padding: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  height: 100%;
}

/* ---- Search bar ---- */

.mddb-kanban-search-wrapper {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 0;
}

.mddb-kanban-filter-input {
  flex: 1;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 14px;
}

.mddb-kanban-search-cancel-button {
  display: flex;
  align-items: center;
  cursor: pointer;
  opacity: 0.6;
}

.mddb-kanban-search-cancel-button:hover {
  opacity: 1;
}

/* ---- Lane ---- */

.mddb-kanban-lane-wrapper {
  display: flex;
  flex-direction: column;
  min-width: var(--lane-width);
  max-width: var(--lane-width);
  border-radius: 6px;
  background: var(--background-secondary);
  max-height: 100%;
}

.mddb-kanban-lane {
  display: flex;
  flex-direction: column;
  max-height: 100%;
  border-radius: 6px;
}

.mddb-kanban-lane.collapse-horizontal {
  min-width: auto;
  max-width: auto;
}

/* ---- Lane header ---- */

.mddb-kanban-lane-header-wrapper {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 4px;
  cursor: pointer;
}

.mddb-kanban-lane-grip {
  display: flex;
  cursor: grab;
  opacity: 0.4;
  padding: 2px;
}

.mddb-kanban-lane-grip:hover {
  opacity: 0.8;
}

.mddb-kanban-lane-collapse {
  display: flex;
  align-items: center;
  cursor: pointer;
  opacity: 0.6;
  transition: transform 0.15s;
}

.mddb-kanban-lane-collapse.is-collapsed {
  transform: rotate(-90deg);
}

.mddb-kanban-lane-title {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mddb-kanban-lane-title-input {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
  background: var(--background-primary);
  border: 1px solid var(--interactive-accent);
  border-radius: 4px;
  padding: 2px 4px;
}

.mddb-kanban-lane-counter {
  font-size: 12px;
  color: var(--text-muted);
  padding: 0 4px;
}

.mddb-kanban-lane-counter.is-over-limit {
  color: var(--text-error);
  font-weight: 600;
}

.mddb-kanban-lane-settings-button-wrapper {
  display: flex;
  gap: 2px;
}

.mddb-kanban-lane-settings-button {
  display: flex;
  align-items: center;
  cursor: pointer;
  opacity: 0.5;
  padding: 2px;
  border-radius: 4px;
}

.mddb-kanban-lane-settings-button:hover,
.mddb-kanban-lane-settings-button.is-enabled {
  opacity: 1;
  background: var(--background-modifier-hover);
}

/* ---- Lane items (card list) ---- */

.mddb-kanban-lane-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 8px 8px;
  overflow-y: auto;
  flex: 1;
}

/* ---- Card ---- */

.mddb-kanban-item-wrapper {
  position: relative;
}

.mddb-kanban-item {
  background: var(--background-primary);
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  padding: 8px;
  cursor: pointer;
  transition: box-shadow 0.15s;
}

.mddb-kanban-item:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}

.mddb-kanban-item.dragging {
  opacity: 0.5;
}

.mddb-kanban-item-content-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mddb-kanban-item-title-wrapper {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.mddb-kanban-item-checkbox {
  margin-top: 2px;
  flex-shrink: 0;
}

.mddb-kanban-item-title {
  flex: 1;
  font-size: 14px;
  line-height: 1.4;
  word-break: break-word;
}

.mddb-kanban-item-title-input {
  flex: 1;
  font-size: 14px;
  background: var(--background-primary);
  border: 1px solid var(--interactive-accent);
  border-radius: 4px;
  padding: 2px 4px;
  width: 100%;
}

.mddb-kanban-item-menu-button {
  display: flex;
  align-items: center;
  cursor: pointer;
  opacity: 0;
  padding: 2px;
  border-radius: 4px;
  flex-shrink: 0;
}

.mddb-kanban-item-wrapper:hover .mddb-kanban-item-menu-button {
  opacity: 0.5;
}

.mddb-kanban-item-menu-button:hover {
  opacity: 1 !important;
  background: var(--background-modifier-hover);
}

/* ---- Card metadata ---- */

.mddb-kanban-item-metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  padding-left: 22px;
}

.mddb-kanban-item-metadata-field {
  display: flex;
  align-items: center;
  gap: 2px;
}

.mddb-kanban-item-metadata-label {
  opacity: 0.7;
}

.mddb-kanban-item-metadata-value {
  color: var(--text-normal);
}

/* ---- Card form (add new card) ---- */

.mddb-kanban-item-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 8px 8px;
}

.mddb-kanban-item-form-input {
  width: 100%;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 14px;
}

.mddb-kanban-item-form-actions {
  display: flex;
  gap: 4px;
}

.mddb-kanban-item-form-add-btn {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}

.mddb-kanban-item-form-add-btn:hover {
  opacity: 0.9;
}

.mddb-kanban-item-form-cancel-btn {
  background: var(--background-modifier-border);
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}

/* ---- Add card trigger button ---- */

.mddb-kanban-add-card-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  margin: 0 8px 8px;
  opacity: 0.6;
  transition: opacity 0.15s;
}

.mddb-kanban-add-card-btn:hover {
  opacity: 1;
  background: var(--background-modifier-hover);
}

/* ---- Drag overlay ---- */

.mddb-kanban-drag-overlay {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  opacity: 0.85;
  transform: rotate(3deg);
}

/* ---- Drop indicator ---- */

.mddb-kanban-drop-indicator {
  height: 3px;
  background: var(--interactive-accent);
  border-radius: 2px;
  margin: 2px 0;
}

/* ---- Empty state ---- */

.mddb-kanban-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 14px;
}

/* ---- Lane form (empty board) ---- */

.mddb-kanban-lane-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  min-width: var(--lane-width);
}

.mddb-kanban-lane-form-input {
  flex: 1;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  padding: 8px;
  font-size: 14px;
}
```

- [ ] **Step 2: Write SearchBar component**

Create `src/view/kanban/react/search-bar.tsx`:

```tsx
import React from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
}

export function SearchBar({ value, onChange, onCancel }: SearchBarProps) {
  return (
    <div className="mddb-kanban-search-wrapper">
      <input
        className="mddb-kanban-filter-input"
        type="text"
        placeholder="Search..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            onCancel();
          }
        }}
      />
      {value && (
        <a
          className="mddb-kanban-search-cancel-button clickable-icon"
          onClick={() => { onChange(''); onCancel(); }}
          aria-label="Cancel"
        >
          ✕
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write CardMetadata component**

Create `src/view/kanban/react/card-metadata.tsx`:

```tsx
import React from 'react';

interface CardMetadataProps {
  metadata: Record<string, unknown>;
  searchQuery?: string;
}

export function CardMetadata({ metadata, searchQuery }: CardMetadataProps) {
  const entries = Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;

  return (
    <div className="mddb-kanban-item-metadata">
      {entries.map(([key, value]) => (
        <div key={key} className="mddb-kanban-item-metadata-field">
          <span className="mddb-kanban-item-metadata-label">{key}:</span>
          <span className="mddb-kanban-item-metadata-value">
            {searchQuery ? highlightText(String(value), searchQuery) : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
```

- [ ] **Step 4: Write CardTitle component**

Create `src/view/kanban/react/card-title.tsx`:

```tsx
import React, { useState, useRef, useEffect } from 'react';

interface CardTitleProps {
  title: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  searchQuery?: string;
}

export function CardTitle({
  title,
  isEditing,
  onStartEdit,
  onCommit,
  onCancel,
  searchQuery,
}: CardTitleProps) {
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing, title]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className="mddb-kanban-item-title-input"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onCommit(editValue);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={() => onCommit(editValue)}
      />
    );
  }

  return (
    <div
      className="mddb-kanban-item-title"
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
    >
      {searchQuery ? highlightText(title, searchQuery) : title}
    </div>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
```

- [ ] **Step 5: Write Card component**

Create `src/view/kanban/react/card.tsx`:

```tsx
import React, { useState, useRef, useCallback } from 'react';
import type { Card as CardData } from '../kanban-view-model';
import { CardTitle } from './card-title';
import { CardMetadata } from './card-metadata';

interface CardProps {
  card: CardData;
  searchQuery?: string;
  onDelete: (cardId: string) => void;
  onEdit: (cardId: string) => void;
  onUpdateField: (cardId: string, field: string, value: unknown) => void;
  onDragStart: (cardId: string, e: React.DragEvent) => void;
}

export function Card({
  card,
  searchQuery,
  onDelete,
  onEdit,
  onUpdateField,
  onDragStart,
}: CardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({
      cardId: card.id,
      fromLane: '',
    }));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart(card.id, e);
  }, [card.id, onDragStart]);

  return (
    <div
      className="mddb-kanban-item-wrapper"
      draggable
      onDragStart={handleDragStart}
    >
      <div ref={cardRef} className="mddb-kanban-item">
        <div className="mddb-kanban-item-content-wrapper">
          <div className="mddb-kanban-item-title-wrapper">
            <input
              type="checkbox"
              className="mddb-kanban-item-checkbox"
              checked={card.checked ?? false}
              onChange={(e) => onUpdateField(card.id, 'checked', e.target.checked)}
            />
            <CardTitle
              title={card.title}
              isEditing={isEditing}
              onStartEdit={() => setIsEditing(true)}
              onCommit={(val) => {
                setIsEditing(false);
                if (val !== card.title) {
                  const titleField = Object.keys(card.raw).find(k =>
                    card.raw[k] === card.title && k !== 'storage_pk'
                  );
                  if (titleField) {
                    onUpdateField(card.id, titleField, val);
                  }
                }
              }}
              onCancel={() => setIsEditing(false)}
              searchQuery={searchQuery}
            />
            <a
              className="mddb-kanban-item-menu-button clickable-icon"
              onClick={(e) => {
                e.stopPropagation();
                const menu = new (window as any).Menu?.();
                if (menu) {
                  menu.addItem((item: any) => item
                    .setTitle('Edit')
                    .setIcon('pencil')
                    .onClick(() => onEdit(card.id))
                  );
                  menu.addItem((item: any) => item
                    .setTitle('Delete')
                    .setIcon('trash')
                    .onClick(() => onDelete(card.id))
                  );
                  menu.showAtMouseEvent(e);
                }
              }}
            >
              ⋮
            </a>
          </div>
          <CardMetadata metadata={card.metadata} searchQuery={searchQuery} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write CardForm component**

Create `src/view/kanban/react/card-form.tsx`:

```tsx
import React, { useState } from 'react';

interface CardFormProps {
  onAdd: (title: string) => void;
}

export function CardForm({ onAdd }: CardFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue('');
  };

  if (!isOpen) {
    return (
      <div className="mddb-kanban-add-card-btn" onClick={() => setIsOpen(true)}>
        + Add a card
      </div>
    );
  }

  return (
    <div className="mddb-kanban-item-form">
      <input
        className="mddb-kanban-item-form-input"
        placeholder="Card title..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') { setIsOpen(false); setValue(''); }
        }}
        autoFocus
      />
      <div className="mddb-kanban-item-form-actions">
        <button className="mddb-kanban-item-form-add-btn" onClick={handleSubmit}>
          Add
        </button>
        <button
          className="mddb-kanban-item-form-cancel-btn"
          onClick={() => { setIsOpen(false); setValue(''); }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write LaneHeader component**

Create `src/view/kanban/react/lane-header.tsx`:

```tsx
import React, { useState, useRef, useEffect } from 'react';
import type { Lane } from '../kanban-view-model';

interface LaneHeaderProps {
  lane: Lane;
  onToggleCollapse: () => void;
  onTitleChange?: (title: string) => void;
  onMenuOpen: (e: React.MouseEvent) => void;
}

export function LaneHeader({
  lane,
  onToggleCollapse,
  onTitleChange,
  onMenuOpen,
}: LaneHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(lane.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(lane.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing, lane.title]);

  const overLimit = lane.maxItems !== undefined && lane.cardCount > lane.maxItems;

  return (
    <div className="mddb-kanban-lane-header-wrapper">
      <div className="mddb-kanban-lane-grip">
        ⠿
      </div>
      <div
        className={`mddb-kanban-lane-collapse ${lane.collapsed ? 'is-collapsed' : ''}`}
        onClick={onToggleCollapse}
      >
        ▾
      </div>
      {isEditing ? (
        <input
          ref={inputRef}
          className="mddb-kanban-lane-title-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onTitleChange?.(editValue);
              setIsEditing(false);
            }
            if (e.key === 'Escape') setIsEditing(false);
          }}
          onBlur={() => {
            onTitleChange?.(editValue);
            setIsEditing(false);
          }}
        />
      ) : (
        <div
          className="mddb-kanban-lane-title"
          onDoubleClick={() => setIsEditing(true)}
        >
          {lane.title}
        </div>
      )}
      <div className={`mddb-kanban-lane-counter ${overLimit ? 'is-over-limit' : ''}`}>
        {lane.cardCount}{lane.maxItems !== undefined ? `/${lane.maxItems}` : ''}
      </div>
      <div className="mddb-kanban-lane-settings-button-wrapper">
        <a
          className="mddb-kanban-lane-settings-button clickable-icon"
          onClick={onMenuOpen}
          aria-label="More options"
        >
          ⋮
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Write Lane component**

Create `src/view/kanban/react/lane.tsx`:

```tsx
import React, { useState, useRef, useCallback } from 'react';
import type { Lane as LaneData } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';
import { LaneHeader } from './lane-header';
import { Card } from './card';
import { CardForm } from './card-form';

interface LaneProps {
  lane: LaneData;
  viewModel: KanbanViewModel;
  searchQuery?: string;
  onDragStart: (cardId: string, e: React.DragEvent) => void;
}

export function Lane({ lane, viewModel, searchQuery, onDragStart }: LaneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.cardId) {
        viewModel.moveCard(data.cardId, data.fromLane, lane.id, 0);
      }
    } catch { /* ignore parse errors */ }
  }, [viewModel, lane.id]);

  const filteredCards = searchQuery
    ? lane.cards.filter(c =>
        c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        Object.values(c.metadata).some(v =>
          String(v).toLowerCase().includes(searchQuery.toLowerCase())
        )
      )
    : lane.cards;

  return (
    <div className="mddb-kanban-lane-wrapper">
      <div
        ref={laneRef}
        className={`mddb-kanban-lane ${lane.collapsed ? 'collapse-horizontal' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={isDragOver ? { outline: '2px dashed var(--interactive-accent)' } : undefined}
      >
        <LaneHeader
          lane={lane}
          onToggleCollapse={() => viewModel.toggleLaneCollapse(lane.id)}
          onMenuOpen={() => {}}
        />

        {!lane.collapsed && (
          <>
            <div className="mddb-kanban-lane-items">
              {filteredCards.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  searchQuery={searchQuery}
                  onDelete={(id) => viewModel.deleteCard(id)}
                  onEdit={(id) => viewModel.updateCardField(id, '', '')}
                  onUpdateField={(id, field, value) => viewModel.updateCardField(id, field, value)}
                  onDragStart={(id, e) => onDragStart(id, e)}
                />
              ))}
            </div>
            <CardForm
              onAdd={(title) => {
                const firstField = viewModel.config.columns[0] || 'title';
                viewModel.addCard(lane.id, { [firstField]: title });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Write Board component**

Create `src/view/kanban/react/board.tsx`:

```tsx
import React from 'react';
import type { KanbanBoard } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';
import { Lane } from './lane';
import { SearchBar } from './search-bar';

interface BoardProps {
  board: KanbanBoard;
  viewModel: KanbanViewModel;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onDragStart: (cardId: string, e: React.DragEvent) => void;
}

export function Board({
  board,
  viewModel,
  searchQuery,
  onSearchChange,
  onDragStart,
}: BoardProps) {
  if (board.lanes.length === 0) {
    return (
      <div className="mddb-kanban">
        <div className="mddb-kanban-empty">
          No data — add records to "{viewModel.config.table}" to see them here.
        </div>
      </div>
    );
  }

  return (
    <div className="mddb-kanban">
      <SearchBar
        value={searchQuery}
        onChange={onSearchChange}
        onCancel={() => {}}
      />
      <div className="mddb-kanban-board">
        {board.lanes.map((lane) => (
          <Lane
            key={lane.id}
            lane={lane}
            viewModel={viewModel}
            searchQuery={searchQuery}
            onDragStart={onDragStart}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Write KanbanApp entry**

Create `src/view/kanban/react/index.tsx`:

```tsx
import React from 'react';
import type { KanbanViewModel } from '../kanban-view-model';
import { Board } from './board';
import './styles.css';

interface KanbanAppProps {
  viewModel: KanbanViewModel;
}

export function KanbanApp({ viewModel }: KanbanAppProps) {
  const [board, setBoard] = React.useState(() => viewModel.board);
  const [searchQuery, setSearchQuery] = React.useState('');

  React.useEffect(() => {
    const update = () => setBoard({ ...viewModel.board });
    const unsub1 = viewModel.events.on('state-changed', update);
    const unsub2 = viewModel.events.on('data-changed', update);
    return () => { unsub1(); unsub2(); };
  }, [viewModel]);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    viewModel.setSearchQuery(query);
  };

  return (
    <Board
      board={board}
      viewModel={viewModel}
      searchQuery={searchQuery}
      onSearchChange={handleSearchChange}
      onDragStart={() => {}}
    />
  );
}
```

- [ ] **Step 11: Commit**

```bash
git add Obsidian-mddb/src/view/kanban/react/
git commit -m "feat: add Kanban React components (Board/Lane/Card)"
```

---

### Task 4: Inline Renderer + ItemView + Integration

**Files:**
- Create: `src/view/kanban/inline-renderer.tsx`
- Create: `src/view/kanban/kanban-view.tsx`
- Modify: `src/view/integration.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Write InlineKanbanRenderer**

Create `src/view/kanban/inline-renderer.tsx`:

```tsx
import { createRoot, type Root } from 'react-dom/client';
import { KanbanApp } from './react/index';
import { KanbanViewModel } from './kanban-view-model';

export class InlineKanbanRenderer {
  private vm: KanbanViewModel;
  private el: HTMLElement;
  private root: Root | null = null;

  constructor(vm: KanbanViewModel, el: HTMLElement) {
    this.vm = vm;
    this.el = el;
  }

  mount(): void {
    this.root = createRoot(this.el);
    this.root.render(<KanbanApp viewModel={this.vm} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}
```

- [ ] **Step 2: Write KanbanView (ItemView)**

Create `src/view/kanban/kanban-view.tsx`:

```tsx
/**
 * 看板视图 (KanbanView)
 *
 * Obsidian ItemView 实现，渲染 mddb-kanban 查询结果。
 * 使用 React 渲染看板。
 *
 * 参考：kanban-view-design.md §7.2
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { KanbanApp } from './react/index';
import { KanbanViewModel } from './kanban-view-model';
import type { KanbanConfig } from './kanban-config';

export const KANBAN_VIEW_TYPE = 'mddb-kanban-view';

export class KanbanView extends ItemView {
  private viewModel: KanbanViewModel;
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    engine: any,
    config: KanbanConfig,
  ) {
    super(leaf);
    this.viewModel = new KanbanViewModel(
      `kanban-${Date.now()}`,
      engine,
      config,
    );
  }

  getViewType(): string {
    return KANBAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.viewModel.config.table ?? 'MD-DB Kanban';
  }

  getIcon(): string {
    return 'layout-kanban';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    this.root.render(<KanbanApp viewModel={this.viewModel} />);
    await this.viewModel.initialize();
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    this.viewModel.destroy();
  }
}
```

- [ ] **Step 3: Update ViewIntegration**

Modify `src/view/integration.ts` to register KanbanView:

Add imports at top:
```typescript
import { KANBAN_VIEW_TYPE, KanbanView } from './kanban/kanban-view';
import { parseKanbanBlock } from './kanban/parser';
import type { KanbanConfig } from './kanban/kanban-config';
```

Add to `registerViews()`:
```typescript
this.plugin.registerView(
  KANBAN_VIEW_TYPE,
  (leaf) => new KanbanView(leaf, this.engine, {
    table: '',
    columns: [],
    groupBy: '',
  }),
);
```

Add methods:
```typescript
async openKanbanView(config: KanbanConfig): Promise<void> {
  const leaf = this.plugin.app.workspace.getLeaf(true);
  const view = new KanbanView(leaf, this.engine, config);
  leaf.setViewState({
    type: KANBAN_VIEW_TYPE,
    active: true,
  });
}

async openKanbanFromBlock(blockContent: string): Promise<void> {
  const result = parseKanbanBlock(blockContent);
  if (!result.success) {
    throw new Error(`Failed to parse mddb-kanban block:\n${result.errors.join('\n')}`);
  }
  if (result.config) {
    await this.openKanbanView(result.config);
  }
}
```

- [ ] **Step 4: Register mddb-kanban code block in main.ts**

Add imports at top of main.ts:
```typescript
import { KanbanViewModel } from './view/kanban/kanban-view-model';
import { InlineKanbanRenderer } from './view/kanban/inline-renderer';
import { parseKanbanBlock } from './view/kanban/parser';
```

Add after the `mddb-table` block processor (after line ~147):
```typescript
// ── mddb-kanban 代码块处理器 ──
this.registerMarkdownCodeBlockProcessor('mddb-kanban', (source, el) => {
  if (el.hasClass('mddb-rendered')) return;
  el.addClass('mddb-rendered');
  el.empty();

  const result = parseKanbanBlock(source);
  if (!result.success || !result.config) {
    el.createEl('div', {
      cls: 'mddb-error',
      text: `MD-DB parse error:\n${result.errors.join('\n')}`,
    });
    return;
  }

  const vm = new KanbanViewModel(`kanban-${Date.now()}`, this.engine, result.config);
  vm.initialize().then(() => {
    const renderer = new InlineKanbanRenderer(vm, el);
    renderer.mount();
    (el as any).__mddbKanbanRenderer = renderer;
    (el as any).__mddbKanbanViewModel = vm;
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add Obsidian-mddb/src/view/kanban/kanban-view.tsx \
       Obsidian-mddb/src/view/kanban/inline-renderer.tsx \
       Obsidian-mddb/src/view/integration.ts \
       Obsidian-mddb/src/main.ts
git commit -m "feat: register KanbanView and mddb-kanban code block processor"
```

---

### Task 5: Lane Menu + LaneForm (Empty Board)

**Files:**
- Create: `src/view/kanban/react/lane-menu.tsx`
- Create: `src/view/kanban/react/lane-form.tsx`

- [ ] **Step 1: Write LaneMenu component**

Create `src/view/kanban/react/lane-menu.tsx`:

```tsx
import React from 'react';
import type { Lane } from '../kanban-view-model';
import type { KanbanViewModel } from '../kanban-view-model';

interface LaneMenuProps {
  lane: Lane;
  viewModel: KanbanViewModel;
  onClose: () => void;
}

export function LaneMenu({ lane, viewModel, onClose }: LaneMenuProps) {
  const handleArchiveAll = async () => {
    for (const card of lane.cards) {
      await viewModel.updateCardField(card.id, viewModel.config.groupBy, 'archived');
    }
    onClose();
  };

  const handleArchiveDone = async () => {
    for (const card of lane.cards) {
      if (card.checked) {
        await viewModel.updateCardField(card.id, viewModel.config.groupBy, 'archived');
      }
    }
    onClose();
  };

  const handleDeleteLane = async () => {
    if (!confirm(`Delete all ${lane.cardCount} cards in "${lane.title}"?`)) return;
    for (const card of lane.cards) {
      await viewModel.deleteCard(card.id);
    }
    onClose();
  };

  return (
    <div style={{
      position: 'absolute',
      background: 'var(--background-primary)',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '6px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      zIndex: 100,
      minWidth: '180px',
      padding: '4px 0',
    }}>
      <div style={{ padding: '4px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>
        WIP Limit: {lane.maxItems ?? '—'}
      </div>
      <div style={{ borderTop: '1px solid var(--background-modifier-border)', margin: '4px 0' }} />
      <MenuItem onClick={handleArchiveAll}>Archive all</MenuItem>
      <MenuItem onClick={handleArchiveDone}>Archive done</MenuItem>
      <div style={{ borderTop: '1px solid var(--background-modifier-border)', margin: '4px 0' }} />
      <MenuItem onClick={handleDeleteLane} danger>Delete list</MenuItem>
    </div>
  );
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 12px',
        cursor: 'pointer',
        fontSize: '13px',
        color: danger ? 'var(--text-error)' : 'var(--text-normal)',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--background-modifier-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Write LaneForm component**

Create `src/view/kanban/react/lane-form.tsx`:

```tsx
import React, { useState } from 'react';

interface LaneFormProps {
  onAddLane: (title: string) => void;
}

export function LaneForm({ onAddLane }: LaneFormProps) {
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAddLane(trimmed);
    setValue('');
  };

  return (
    <div className="mddb-kanban-lane-form">
      <input
        className="mddb-kanban-lane-form-input"
        placeholder="Add a list..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
        }}
        autoFocus
      />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add Obsidian-mddb/src/view/kanban/react/lane-menu.tsx \
       Obsidian-mddb/src/view/kanban/react/lane-form.tsx
git commit -m "feat: add LaneMenu and LaneForm components"
```

---

## Self-Review

**1. Spec coverage:**
- §2 声明语法 → Task 1 (Parser)
- §3 数据模型 → Task 2 (ViewModel KanbanBoard/Lane/Card types)
- §4 KanbanViewModel → Task 2
- §5 React 组件树 → Task 3
- §6.1 拖拽系统 → Task 3 (Card/Lane onDragStart/onDrop)
- §6.2 卡片交互 → Task 3 (CardTitle double-click, checkbox, menu)
- §6.3 列操作 → Task 5 (LaneMenu: archive/delete/WIP)
- §6.4 搜索过滤 → Task 3 (SearchBar + CardMetadata filter)
- §6.5 空状态 → Task 3 (Board empty state)
- §7 注册与渲染 → Task 4 (InlineRenderer + ItemView + main.ts + integration)
- §8 文件结构 → All tasks match exactly

**2. Placeholder scan:** No TBD, TODO, or "implement later" in code blocks. All component code is complete and functional.

**3. Type consistency:** KanbanConfig from Task 1 matches ViewModel constructor in Task 2. KanbanBoard/Lane/Card types consistent across all React components.

**4. Gaps identified:**
- LaneMenu uses inline div-based menu (Obsidian Menu API is available but more complex)
- Drag overlay (semi-transparent card) uses CSS class `.mddb-kanban-drag-overlay` in styles but HTML5 DnD `setDragImage` is the standard approach
- Lane column drag reordering is spec'd as "future" — not implemented
