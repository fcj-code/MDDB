# MD-DB 表格视图增强设计 — 行内编辑、列显示控制、CRUD 操作

> 日期：2026-06-12（最近更新：2026-06-13）
> 状态：已实施 — 功能已通过 React 重写实现（见 `2026-06-12-table-view-react-redesign.md`）
> 依赖：`2026-06-11-implementation-roadmap-v2.md`（Milestone 4 ✅ 表格视图基础）
> 关联：`2026-06-10-view-layer-design.md`（视图层设计文档，§5 表格视图的补充实施）

---

## 一、目标

在现有只读表格视图基础上，实现三个延期功能：

1. **行内编辑** — 双击单元格进入编辑，Enter/blur 保存，Esc 取消 ✅（React 实现，类型感知）
2. **列显示控制** — 下拉列选择器 + 右键列头菜单，控制列显隐 ⬜ 仍延期
3. **CRUD 操作** — ⠿ 行操作菜单（编辑/删除）+ 工具栏 [+] 新增（表单弹窗）✅（React 实现）

---

## 二、架构决策

### 2.1 统一到 TableViewModel（方案 B）

**决策**：所有表格渲染统一走 `TableViewModel`，`main.ts` 的 `mddb-table` 代码块处理器改为通过 ViewModel 渲染。

**理由**：
- 避免两个渲染路径（`main.ts` 直接渲染 vs `TableView` ItemView）各自独立
- 编辑/列控制/CRUD 状态集中管理，测试覆盖更容易
- 未来代码块渲染和 ItemView 渲染共享同一套能力

**实施状态**：✅ 已实现。ViewModel 为 React 组件提供 `getSnapshot()` + 事件总线驱动刷新。

### 2.2 渲染方式

**决策**：~~新增 InlineTableRenderer~~ → **实际采用 React 重写**（见 `2026-06-12-table-view-react-redesign.md`）。

- ~~`InlineTableRenderer` → 渲染到 `el`（代码块内嵌）~~ ⬜ 已废弃（原生 DOM 方案被 React 取代）
- `TableView`（ItemView）→ 渲染到 `WorkspaceLeaf`（独立标签页）
- React App → 渲染到 `el`（代码块内嵌）+ `WorkspaceLeaf`

### 2.3 FormBuilder

**决策**：将 `main.ts` 中 `mddb-form` 的控件生成逻辑提取为独立 `FormBuilder` 类，供表格工具栏 [+] 和 ⠿ 编辑按钮复用。✅ 已实现

---

## 三、TableViewModel 增强

### 3.1 编辑状态 ✅（React 实现）

```typescript
editingCell: { rowIndex: number; col: string; originalValue: unknown } | null

startEdit(rowIndex: number, col: string): void
commitEdit(newValue: unknown): Promise<boolean>  // 调 engine.update()
cancelEdit(): void                               // 恢复 originalValue
```

**流程**：
1. `startEdit` → 设置 `editingCell`，记录 `originalValue` → 触发 `'edit-start'` 事件
2. BodyCell 切换到编辑控件（类型感知：text/number/date/select/checkbox）
3. `commitEdit` → 从行数据获取 `storagePk` → `engine.update(storagePk, { [col]: newValue }, { force: true })`
   - 成功 → `editingCell = null` → 触发 `'edit-commit'` → 刷新表格
   - 失败 → `editingCell = null` → 触发 `'edit-cancel'`
4. `cancelEdit` → `editingCell = null` → 恢复显示原始值

### 3.2 列可见性 ⬜ 仍延期

```typescript
visibleColumns: Set<string>
toggleColumn(col: string): void
hideColumn(col: string): void
showAllColumns(): void
isColumnVisible(col: string): boolean
```

> 方法已定义，但 UI 入口（列选择器下拉 + 右键菜单）尚未实现。

### 3.3 CRUD ✅（React 实现）

```typescript
actionMenuRow: string | null

toggleActionMenu(storagePk: string): void
closeActionMenu(): void

async deleteRow(storagePk: string): Promise<boolean>
async insertRow(values: Record<string, unknown>): Promise<boolean>
openForm(mode: 'new' | 'edit', storagePk?: string, currentValues?: Record<string, unknown>): void
```

**删除流程**：
1. 用户点击 ⠿ → 删除
2. `engine.delete(storagePk, { force: true })` — 无确认弹窗
3. 成功 → 触发 `'row-deleted'` 事件 → 刷新数据
4. 失败 → 内联错误提示

**新增流程**：
1. 点击 `+New Row` 按钮 → `openForm('new')`
2. 弹窗显示 `FormBuilder` 渲染的表单（所有 Schema 字段）
3. 用户填写 → 点"保存" → `engine.insert(table, values)` → 成功关闭弹窗，刷新数据

**编辑流程**（⠿ → 编辑）：
1. 用户点击 ⠿ → 编辑
2. `openForm('edit', storagePk, currentValues)`
3. 弹窗预填当前值
4. 用户修改 → 点"保存" → `engine.update(storagePk, patch, { force: true })`

### 3.4 列宽调整 ✅（React 实现，参考 DataLoom）

```typescript
setColumnWidth(colName: string, width: number): void
resetColumnWidth(colName: string): void
```

通过表头右边缘 5px 拖拽手柄拖动调整列宽。双击重置为 auto。

### 3.5 新增事件

```typescript
// shared/types.ts 新增事件类型
'edit-start'
| 'edit-commit'
| 'edit-cancel'
| 'column-visibility-changed'
| 'row-deleted'
| 'row-inserted'
| 'action-menu-opened'
| 'action-menu-closed'
```

---

## 四、React 组件架构（替代原生 InlineTableRenderer）

> 原 §4 的 `InlineTableRenderer`（原生 DOM）方案已废弃，全部由 React 组件替代。

参见 `2026-06-12-table-view-react-redesign.md` 获取完整设计。核心组件：

| 组件 | 职责 |
|------|------|
| `TableApp` | React 入口，挂载事件订阅，管理 form modal 状态 |
| `TableViewReact` | 虚拟滚动表格（react-virtuoso），表头 + 行 + 底栏 |
| `HeaderCell` | 表头单元格（排序指示 + 列宽拖拽手柄） |
| `BodyCell` | 数据单元格（类型感知编辑控件） |
| `ActionMenu` | ⠿ 操作菜单 |
| `FormModal` | 新增/编辑表单弹窗 |
| `BottomBar` | 行数统计 + `+New Row` 按钮 |
| `ColumnResizeHandle` | 列宽拖拽手柄（参考 DataLoom） |

---

## 五、FormBuilder（从 main.ts 提取）✅ 已实现

`src/view/shared/form-builder.ts`

### 5.1 职责

将 `main.ts:549-590` 的 `parseFormBlock` 和控件生成逻辑提取为独立可复用的模块。

### 5.2 接口

```typescript
class FormBuilder {
  static render(
    engine: MDDBEngine,
    schema: SchemaSummary,
    options?: { mode: 'new' | 'edit'; values?: Record<string, unknown> }
  ): { element: HTMLElement; getValues: () => Record<string, unknown> }
}
```

### 5.3 控件映射

| 类型 | 控件 | 来源 |
|------|------|------|
| `string` | `<input type="text">` | ✅ main.ts 提取 |
| `integer` | `<input type="number">` | ✅ main.ts 提取 |
| `decimal` | `<input type="number" step="0.01">` | ✅ main.ts 提取 |
| `boolean` | checkbox | ✅ main.ts 提取 |
| `date` | `<input type="date">` | ✅ main.ts 提取 |
| `enum` | `<select>` | ✅ main.ts 提取 |
| `ref` | `<select>` (engine.query 加载关联表) | ✅ main.ts 提取 |

---

## 六、文件结构变化（当前状态）

```
src/view/
├── parser.ts                              # 不变
├── base-view-model.ts                     # 不变
├── table/
│   ├── table-view-model.ts                # ★ 增强：编辑/列控制/CRUD/列宽
│   ├── table-view.tsx                     # ★ 修改：挂载 React
│   ├── table-config.ts                    # 不变
│   ├── inline-renderer.tsx                # ★ 修改：挂载 React（替换原生 DOM 方案）
│   └── react/                             # ★ 新增 React 组件目录
│       ├── index.tsx                      #    App 入口（事件订阅 + form modal 管理）
│       ├── action-menu.tsx                #    ⠿ 操作菜单
│       ├── bottom-bar.tsx                 #    底栏
│       ├── form-modal.tsx                 #    新增/编辑表单弹窗
│       └── table/
│           ├── index.tsx                  #    虚拟滚动表格
│           ├── header-cell.tsx            #    表头（排序 + 列宽拖拽）
│           ├── body-cell.tsx              #    数据单元格（类型感知编辑）
│           ├── column-resize-handle.tsx   #    ★ 列宽拖拽手柄
│           └── styles.css                 #    React 表格样式
├── shared/
│   ├── event-bus.ts                       # 不变
│   ├── data-layer.ts                      # 不变
│   ├── types.ts                           # ★ 增强：编辑/列/CRUD 事件类型
│   └── form-builder.ts                    # ★ 新增（从 main.ts 提取）
└── integration.ts                         # 不变

src/main.ts                                # ★ 修改：mddb-table 处理器使用 ViewModel
```

---

## 七、测试策略

| 测试 | 方式 | 覆盖 |
|------|------|------|
| TableViewModel 编辑 | 单元测试 mock engine | `startEdit` → `commitEdit` 调 engine.update / `cancelEdit` 恢复 |
| TableViewModel 列可见性 | 单元测试 | `toggleColumn` 增减 / `showAllColumns` 恢复 / `hideColumn` |
| TableViewModel CRUD | 单元测试 mock engine | `deleteRow` 调 engine.delete / `insertRow` 调 engine.insert |
| TableViewModel 列宽 | 单元测试 | `setColumnWidth` 更新 / `resetColumnWidth` 删除 |
| FormBuilder | 单元测试 | 各类型控件渲染 / `getValues` 收集 / 弹窗生命周期 |
| main.ts 处理器 | 集成测试 | 代码块解析 → ViewModel 创建 → React 挂载 |

---

## 八、实施记录

| 功能 | 实施方式 | 日期 | 状态 |
|------|---------|------|:----:|
| 行内编辑（原生 DOM） | InlineTableRenderer | 2026-06-12 | ⬜ 已废弃 |
| React 基础表格（P1） | 虚拟滚动 + 数据桥接 | 2026-06-12 | ✅ 已实施 |
| 类型感知编辑（P2） | BodyCell 按 type 渲染控件 | 2026-06-12 | ✅ 已实施 |
| CRUD 操作（⠿ + 表单） | ActionMenu + FormModal | 2026-06-12 | ✅ 已实施 |
| ref 类型 inline 编辑 | ref → select 下拉 | 2026-06-13 | ✅ 已实施 |
| 列宽拖拽调整 | ColumnResizeHandle (参考 DataLoom) | 2026-06-13 | ✅ 已实施 |
