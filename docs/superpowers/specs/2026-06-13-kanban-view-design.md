# MD-DB 看板视图设计文档 v1.0

> 日期：2026-06-13
> 状态：设计稿（待实现）
> 参考实现：obsidian-kanban（https://github.com/obsidian-community/obsidian-kanban）— UI/UX 完全复刻
> 依赖：`2026-06-10-view-layer-design.md`（视图层架构模式复用）
> 决策数：12 项

---

## 一、设计概述

### 1.1 核心定位

看板视图（Kanban View）是 MDDB 的第二种可视化视图类型。它将查询引擎返回的扁平数据按指定字段值分组，以"列+卡片"的看板布局展示，支持拖拽交互直接更新数据库记录。

### 1.2 与现有视图的差异

| 维度 | 表格视图 | 看板视图 |
|------|---------|---------|
| 数据布局 | 行列网格 | 按字段值分列，卡片排列 |
| 数据转换 | 直接展示 rows | rows → 按 groupBy 字段分组 → lanes |
| 排序 | DataLayer 服务端排序 | 列内排序（服务端 + 客户端拖拽） |
| 分页 | 按钮分页 | 每列 limit 上限，无翻页 |
| 编辑 | 单元格编辑 → engine.update | 拖拽换列 → engine.update |
| 核心交互 | 排序/列宽/过滤 | 拖拽换列/搜索/列折叠 |

### 1.3 范围

**本次实现覆盖：**

- **声明语法**：`mddb-kanban` 代码块，支持 `from`/`show`/`group by`/`where`/`sort by`/`limit`
- **数据分组**：按 `group by` 字段值自动生成列
- **看板渲染**：Board → Lane → Card 三层 React 组件
- **拖拽更新**：卡片跨列拖拽 → `engine.update()` 写数据库
- **行内编辑**：双击卡片进入编辑（复用 FormModal）
- **快速添加**：列底部输入框添加新卡片
- **搜索过滤**：看板级搜索，实时匹配卡片标题和元数据
- **列操作**：折叠/展开/WIP 限制/删除/归档
- **两种打开方式**：Inline 代码块 + ItemView 独立面板
- **完全复刻 UI**：obsidian-kanban 的视觉风格和交互模式

**本次不覆盖（后续迭代）：**

- 列间拖拽排序
- 自定义列顺序（目前按字段值排序）
- 卡片富文本编辑器
- 跨看板拖拽

---

## 二、声明语法

### 2.1 mddb-kanban 代码块

```mddb-kanban
from tasks
show 标题, 负责人, 优先级, 截止日期
group by 状态
where 负责人 = "张三"
sort by 优先级 desc
limit 200
```

**决策 1**：声明语法遵循现有 `mddb-table` 风格，新增 `group by` 指令。

| 指令 | 必需 | 说明 |
|------|:----:|------|
| `from <table>` | ✅ | 数据表名 |
| `show <columns>` | ❌ | 显示字段，第一个字段作为卡片标题，其余作为元数据 |
| `group by <field>` | ✅ | 按哪个字段的值分组，每个值生成一列 |
| `where <expr>` | ❌ | 过滤条件（复用 parseWhere 引擎） |
| `sort by <field> <dir>` | ❌ | 排序（复用现有解析） |
| `limit <n>` | ❌ | 每列最大卡片数（默认 200） |

### 2.2 KanbanConfig

```typescript
interface KanbanConfig {
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

**决策 2**：`group by` 字段值自动生成列名。查询引擎返回该字段的所有去重值，每个值生成一列。无需用户预定义列。

**决策 3**：列的顺序按字段值的自然顺序排列（字符串/数字排序），后续可扩展自定义列顺序配置。

**决策 4**：`show` 的第一个字段作为卡片标题（支持 Markdown 渲染），其余字段作为卡片下方元数据显示。

---

## 三、数据模型

### 3.1 运行时数据结构

```typescript
interface KanbanBoard {
  lanes: Lane[];
  groupField: string;
  totalCards: number;
}

interface Lane {
  id: string;
  title: string;
  groupValue: unknown;
  cards: Card[];
  cardCount: number;
  collapsed: boolean;
  maxItems?: number;
  isLoading: boolean;
}

interface Card {
  id: string;           // 对应 storage_pk
  title: string;        // show 的第一个字段值
  metadata: Record<string, unknown>;  // show 的其他字段
  raw: Record<string, unknown>;       // 完整记录
  checked?: boolean;
  isEditing?: boolean;
}
```

**决策 5**：卡片 `id` 使用 `storage_pk`，确保与引擎 CRUD 操作一致。

### 3.2 数据流转

```
KanbanConfig
  → QueryEngine.query({ table, columns, filter, sort })
  → ResultSet { rows, columns, total }
  → groupByField(rows)  // 按 groupBy 字段值分组
  → Lane[]              // 每个值 = 一列
  → React 渲染

拖拽移动卡片:
  → engine.update(storagePk, { [groupBy]: 目标列值 }, { force: true })
  → refresh() → 重新分组渲染
```

---

## 四、KanbanViewModel

### 4.1 类设计

新建 `src/view/kanban/kanban-view-model.ts`，继承 `BaseViewModel`，遵循表格视图模式。

```typescript
class KanbanViewModel extends BaseViewModel {
  constructor(viewId: string, engine: MDDBEngine, config: KanbanConfig)

  // ── 生命周期 ──
  async initialize(): Promise<void>    // 首次查询 + 分组
  async refresh(): Promise<void>       // 刷新数据

  // ── 数据访问 ──
  get board(): KanbanBoard
  getLane(laneId: string): Lane | undefined

  // ── 拖拽更新（核心） ──
  async moveCard(cardId: string, fromLane: string, toLane: string, toIndex: number): Promise<boolean>

  // ── CRUD ──
  async addCard(laneId: string, values: Record<string, unknown>): Promise<boolean>
  async deleteCard(cardId: string): Promise<boolean>
  async updateCardField(cardId: string, field: string, value: unknown): Promise<boolean>

  // ── 交互 ──
  toggleLaneCollapse(laneId: string): void
  search(query: string): void

  // ── 内部 ──
  private groupByField(rows: Record<string, unknown>[]): Lane[]
  private buildCard(row: Record<string, unknown>): Card
}
```

**决策 6**：`moveCard` 的语义是"更新记录的 groupBy 字段值"，拖拽完成后调用 `engine.update()` 写数据库，随后 `refresh()` 重新分组渲染。

**决策 7**：搜索在客户端执行（已加载的数据中过滤），不发起新查询。输入时即时匹配卡片标题和元数据内容。

---

## 五、React 组件树

### 5.1 组件层级

```
<KanbanApp>                          ← 事件订阅 + state 同步
  <Board>                            ← 横向滚动容器 + 搜索框
    ├─ <SearchBar />                 ← 搜索输入框
    ├─ <Lane key={id}>               ← 列容器（Droppable）
    │   ├─ <LaneHeader>             ← 列头
    │   │   ├─ <GripIcon />         ← 拖拽手柄（预留）
    │   │   ├─ <CollapseToggle />   ← ▾/▸ 折叠按钮
    │   │   ├─ <LaneTitle />        ← 可编辑标题
    │   │   ├─ <CardCounter />      ← (3/10) WIP 限制显示
    │   │   └─ <LaneMenu />         ← 更多操作菜单
    │   ├─ <Card key={id}>          ← 卡片（Draggable）
    │   │   ├─ <CardCheckbox />     ← checkbox
    │   │   ├─ <CardTitle />        ← 标题字段（Markdown）
    │   │   ├─ <CardMetadata />     ← 元数据行
    │   │   └─ <CardMenuButton />   ← 卡片菜单 ⋮
    │   └─ <CardForm />             ← 底部添加卡片输入框
    └─ <Lane />...
```

### 5.2 布局示意

```
┌──────────────────────────────────────────────────────────────────┐
│ [Search...]                                                  ⊕  │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┤
│ 待处理    │ 进行中   │ 已完成   │ 暂停     │          │          │
│ (5) ▾ ⋮  │ (3) ▾ ⋮  │ (8) ▾ ⋮  │ (1) ▾ ⋮  │          │          │
├──────────┼──────────┼──────────┼──────────┤          │          │
│ ☐ 需求文档│ ⚡ 开发  │ ✅ 上线  │ ⏸ 等待  │          │          │
│   张三    │   李四   │   张三   │   王五   │          │          │
│   高优先级 │   进行中  │   已完成  │   暂停   │          │          │
│ ──────── │ ──────── │ ──────── │ ──────── │          │          │
│ ☐ UI设计  │ 🐛 修复  │ ✅ 测试  │          │          │          │
│   李四    │   王五   │   李四   │          │          │          │
│ ──────── │ ──────── │ ──────── │          │          │          │
│ [+ Add]  │ [+ Add]  │ [+ Add]  │ [+ Add]  │          │          │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

**决策 8**：UI 完全复刻 obsidian-kanban 的视觉风格：
- 列宽默认 272px（CSS 变量 `--lane-width`）
- 列背景与 Obsidian 主题一致
- 卡片阴影、圆角、间距与 obsidian-kanban 一致
- 拖拽时半透明 overlay

---

## 六、交互设计

### 6.1 拖拽系统

| 阶段 | 行为 |
|------|------|
| 拖拽开始 | 卡片变为半透明 overlay（鼠标跟随），原位置保持占位 |
| 拖拽悬停 | 目标列高亮边框，卡片间显示灰色插入指示线 |
| 同列拖拽 | 更新排序（预留，本次仅视觉反馈，不写数据库） |
| 跨列拖拽 | `engine.update(storagePk, { groupBy: 目标列值 })` → 刷新 |
| 取消拖拽 | 卡片回到原位 |

**决策 9**：使用 HTML5 Drag and Drop API（与 obsidian-kanban 一致），不引入额外 DnD 库。

### 6.2 卡片交互

| 交互 | 行为 |
|------|------|
| 单击 checkbox | toggle 完成状态 |
| 双击卡片 | 弹出 FormModal 编辑表单（复用现有组件） |
| 右键卡片 | 菜单：编辑 / 删除 |
| 拖拽卡片 | 见 6.1 |

### 6.3 列操作

| 操作 | 行为 |
|------|------|
| 折叠/展开 | 点击 ▾/▸，折叠后列头保持可见，卡片列表隐藏 |
| WIP 限制 | 列菜单设置 maxItems，列头显示 (count/max)，超出标红 |
| 归档所有 | 列内所有卡片移至归档区（`engine.update` 标记为归档） |
| 归档已完成 | 仅归档 checked=true 的卡片 |
| 删除列 | 确认对话框 → 删除列内所有卡片 → 刷新 |

### 6.4 搜索过滤

- 搜索框在 Board 顶部
- 输入即时过滤（匹配标题和元数据）
- 不匹配的卡片隐藏
- 列内所有卡片都不匹配时列保持显示但提示"无匹配"
- 搜索期间禁用拖拽

### 6.5 空状态

- 看板无数据（空结果集）→ 显示"没有数据"
- 列中无卡片 → 列保持显示，底部 `[+ Add]` 按钮可用

---

## 七、注册与渲染

### 7.1 Inline 代码块

在 `main.ts` 注册 `MarkdownPostProcessor`：

```typescript
plugin.registerMarkdownCodeBlockProcessor('mddb-kanban', (source, el) => {
  const result = parseKanbanBlock(source);
  if (!result.success) {
    el.createEl('div', { text: `⚠ ${result.errors.join(', ')}` });
    return;
  }
  const vm = new KanbanViewModel(`kanban-${Date.now()}`, engine, result.config);
  new InlineKanbanRenderer(vm, el).mount();
});
```

### 7.2 ItemView

新建 `src/view/kanban/kanban-view.tsx`：

```typescript
export const KANBAN_VIEW_TYPE = 'mddb-kanban-view';

export class KanbanView extends ItemView {
  private viewModel: KanbanViewModel;
  private root: Root | null = null;

  getViewType(): string { return KANBAN_VIEW_TYPE; }
  getDisplayText(): string { return this.viewModel.config.table ?? 'MD-DB Kanban'; }
  getIcon(): string { return 'layout-kanban'; }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    this.root.render(<KanbanApp viewModel={this.viewModel} />);
    await this.viewModel.initialize();
  }
}
```

### 7.3 ViewIntegration 扩展

在现有 `ViewIntegration` 中注册看板视图和打开方法。

---

## 八、文件结构

```
src/view/kanban/
├── kanban-config.ts       # KanbanConfig 接口 + 类型
├── kanban-view-model.ts   # KanbanViewModel（分组/拖拽/搜索/CRUD）
├── kanban-view.tsx        # Obsidian ItemView
├── inline-renderer.tsx    # 代码块内联渲染器（createRoot）
├── parser.ts              # mddb-kanban 代码块解析（parseKanbanBlock）
└── react/
    ├── index.tsx          # KanbanApp 入口（事件订阅 + state）
    ├── board.tsx          # Board 容器（搜索 + 横向滚动 + Droppable）
    ├── lane.tsx           # Lane 列组件（Droppable + 折叠）
    ├── lane-header.tsx    # LaneHeader（标题/计数/折叠/菜单）
    ├── lane-menu.tsx      # LaneMenu（排序/归档/WIP/删除）
    ├── lane-form.tsx      # LaneForm（空看板时新增列）
    ├── card.tsx           # Card 卡片组件（Draggable）
    ├── card-title.tsx     # CardTitle（标题字段 Markdown 渲染）
    ├── card-metadata.tsx  # CardMetadata（元数据行）
    ├── card-form.tsx      # CardForm（底部添加卡片输入框）
    ├── card-menu.tsx      # CardMenu（右键菜单）
    ├── search-bar.tsx     # SearchBar
    └── styles.css         # 看板样式（复刻 obsidian-kanban）
```

---

## 九、决策记录

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 声明语法 | `group by` 自动分列，复用现有指令解析模式 |
| 2 | 列生成 | group by 字段的去重值自动生成列，无需预定义 |
| 3 | 列顺序 | 按字段值的自然顺序排序 |
| 4 | 卡片字段映射 | show 第一个字段 = 卡片标题，其余 = 元数据 |
| 5 | 卡片 ID | 使用 storage_pk 作为唯一标识 |
| 6 | 拖拽语义 | 跨列拖拽 = 更新记录 groupBy 字段值 |
| 7 | 搜索方式 | 客户端过滤，不发起新查询 |
| 8 | UI 风格 | 完全复刻 obsidian-kanban 视觉风格 |
| 9 | 拖拽 API | HTML5 Drag and Drop，不引入额外库 |
| 10 | 视图注册 | Inline 代码块 + ItemView 两种方式 |
| 11 | 列菜单 | 复刻 obsidian-kanban：排序/归档/WIP/删除 |
| 12 | 编辑入口 | 双击卡片 → 复用现有 FormModal |

---

## 十、实现顺序

1. **Parser + Config 类型** — `parseKanbanBlock` + `KanbanConfig`
2. **KanbanViewModel** — `groupByField` 分组逻辑 + `moveCard`/CRUD
3. **React 组件（核心）** — `KanbanApp` + `Board` + `Lane` + `Card`
4. **拖拽系统** — HTML5 DnD + overlay + 插入指示线
5. **Inline 渲染器** — `InlineKanbanRenderer` + 代码块注册
6. **ItemView 注册** — `KanbanView` + `ViewIntegration` 扩展
7. **列菜单 + 搜索** — 增强交互功能
8. **样式** — CSS 复刻 obsidian-kanban
