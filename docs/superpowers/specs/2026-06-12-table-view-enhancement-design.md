# MD-DB 表格视图增强设计 — 行内编辑、列显示控制、CRUD 操作

> 日期：2026-06-12
> 状态：已批准
> 依赖：`2026-06-11-implementation-roadmap-v2.md`（Milestone 4 ✅ 表格视图基础）
> 关联：`2026-06-10-view-layer-design.md`（视图层设计文档，§5 表格视图的补充实施）

---

## 一、目标

在现有只读表格视图基础上，实现三个延期功能：

1. **行内编辑** — 双击单元格进入编辑，Enter/blur 保存，Esc 取消
2. **列显示控制** — 下拉列选择器 + 右键列头菜单，控制列显隐
3. **CRUD 操作** — ⠿ 行操作菜单（编辑/删除）、工具栏 [+] 新增（表单弹窗 + 底部快速录入行）

---

## 二、架构决策

### 2.1 统一到 TableViewModel（方案 B）

**决策**：所有表格渲染统一走 `TableViewModel`，`main.ts` 的 `mddb-table` 代码块处理器改为通过 ViewModel 渲染。

**理由**：
- 避免两个渲染路径（`main.ts` 直接渲染 vs `TableView` ItemView）各自独立
- 编辑/列控制/CRUD 状态集中管理，测试覆盖更容易
- 未来代码块渲染和 ItemView 渲染共享同一套能力

### 2.2 InlineTableRenderer

**决策**：新增 `InlineTableRenderer` 类，负责将 `TableViewModel` 的状态渲染到代码块 DOM。与 `TableView`（ItemView）平级，共用 `TableViewModel`。

**区别**：
- `TableView` → 渲染到 `WorkspaceLeaf`（独立标签页）
- `InlineTableRenderer` → 渲染到 `el`（代码块内嵌）

### 2.3 FormBuilder

**决策**：将 `main.ts` 中 `mddb-form` 的控件生成逻辑提取为独立 `FormBuilder` 类，供表格工具栏 [+] 和 ⠿ 编辑按钮复用。

---

## 三、TableViewModel 增强

### 3.1 编辑状态

```typescript
// 新增到 TableViewModel
editingCell: { rowIndex: number; col: string; originalValue: unknown } | null

startEdit(rowIndex: number, col: string): void
commitEdit(): Promise<boolean>      // 调 engine.update()
cancelEdit(): void                  // 恢复 originalValue
```

**流程**：
1. `startEdit` → 设置 `editingCell`，记录 `originalValue` → 触发 `'edit-start'` 事件
2. 用户在输入框中修改 → 输入框受控于 `InlineTableRenderer` 的 DOM 状态
3. `commitEdit` → 从行数据获取 `storagePk` → `engine.update(storagePk, { [col]: newValue })`
   - 成功 → `editingCell = null` → 触发 `'edit-commit'` → 刷新表格
   - 失败 → `editingCell = null` → 恢复单元格显示原始值 → 红色闪烁提示
4. `cancelEdit` → `editingCell = null` → 恢复 `originalValue`

### 3.2 列可见性

```typescript
// 新增到 TableViewModel
visibleColumns: Set<string>         // 默认 = 查询结果的所有列名

toggleColumn(col: string): void     // 存在则移除，不存在则添加
hideColumn(col: string): void       // 从 Set 移除
showAllColumns(): void              // 重置为全部列
isColumnVisible(col: string): boolean
```

**影响**：
- `visibleColumns` 仅影响渲染，不影响查询
- `InlineTableRenderer.renderTable()` 根据 `visibleColumns` 过滤 `state.columns` 和行数据的 `cells`
- 排序、分页、查询全部字段不变

### 3.3 CRUD

```typescript
// 新增到 TableViewModel
actionMenuRow: string | null        // 当前展开 ⠿ 菜单的行 storagePk

toggleActionMenu(storagePk: string): void
closeActionMenu(): void

async insertRow(values: Record<string, unknown>): Promise<boolean>
async deleteRow(storagePk: string): Promise<boolean>
openForm(mode: 'new' | 'edit', storagePk?: string, currentValues?: Record<string, unknown>): void
```

**删除流程**：
1. 用户点击 ⠿ → 删除
2. 直接调 `engine.delete(storagePk)` — 无确认弹窗
3. 成功 → 触发 `'row-deleted'` 事件 → 刷新数据
4. 失败 → 内联错误提示

**新增流程**（两个入口）：

*入口 A：工具栏 [+] 按钮 → 表单弹窗*
1. 点击 [+] → `openForm('new')`
2. 弹窗显示 `FormBuilder` 渲染的表单（所有 Schema 字段）
3. 用户填写 → 点"保存"
4. `engine.insert(table, values)` → 成功关闭弹窗，刷新数据

*入口 B：表格底部快速录入行*
1. 表格末行固定一行空白输入行
2. 每列一个 `<input>`，填完后点"保存"
3. 同 `engine.insert()`

**编辑流程**（⠿ → 编辑）：
1. 用户点击 ⠿ → 编辑
2. `openForm('edit', storagePk, currentValues)`
3. 弹窗预填当前值
4. 用户修改 → 点"保存" → `engine.update(storagePk, patch)`

### 3.4 新增事件

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

## 四、InlineTableRenderer（新增）

`src/view/table/inline-renderer.ts`

### 4.1 职责

将 `TableViewModel` 的状态渲染到代码块的 DOM 元素，处理所有用户交互事件。

### 4.2 渲染区域

```
┌────────────────────────────────────────────────┐
│ [列 ▾]  [+]                        Page 1/3    │  ← 工具栏
├────────────────────────────────────────────────┤
│ ⠿ │ 姓名 ↑ │ 公司  │ 职位    │ 重要度         │  ← 表头（可排序、右键菜单）
├────┼────────┼───────┼─────────┼───────────────┤
│ ⠿ │ 张三    │ 腾讯  │ 产品总监 │ 高            │  ← 数据行（双击编辑）
│ ⠿ │ 李四    │ 字节  │ 架构师   │ 中            │
│ ⠿ │ 王五    │ 阿里  │ 产品经理 │ 中            │
├────┼────────┼───────┼─────────┼───────────────┤
│    │ [____] │ [___] │ [______] │ [_]    [保存] │  ← 底部快速录入行
├────────────────────────────────────────────────┤
│ ← Prev  Page 1/3  Next →         10 rows/page  │  ← 分页控件
└────────────────────────────────────────────────┘
```

### 4.3 渲染方法

```typescript
class InlineTableRenderer {
  constructor(private vm: TableViewModel, private el: HTMLElement) {}

  mount(): void      // 初始渲染 + 注册事件监听
  render(): void     // 完全重渲染（ViewModel 状态变更时调用）
  unmount(): void    // 清理事件监听
}
```

### 4.4 交互处理

| 交互 | 处理位置 | 行为 |
|------|---------|------|
| 点击列头 | `render()` 中 `th.click` | `vm.toggleSort(col)` |
| 右键列头 | `th.contextmenu` | 弹出右键菜单 → 隐藏列/显示所有 |
| 双击单元格 | `td.dblclick` | `vm.startEdit(rowIndex, col)` → 替换为 input |
| 输入框 Enter/blur | input 事件 | `vm.commitEdit()` |
| 输入框 Esc | input 事件 | `vm.cancelEdit()` |
| 点击 ⠿ | button.click | `vm.toggleActionMenu(storagePk)` |
| 菜单"编辑" | 菜单 click | `vm.openForm('edit', storagePk, values)` |
| 菜单"删除" | 菜单 click | `vm.deleteRow(storagePk)` → 重渲染 |
| 工具栏[列▾] | button.click | 展开/收起列选择器下拉 |
| 列选择器勾选 | checkbox.change | `vm.toggleColumn(col)` |
| 工具栏[+] | button.click | `vm.openForm('new')` |
| 底部录入行保存 | button.click | 收集输入值 → `vm.insertRow(values)` |
| 分页按钮 | button.click | `vm.goToPage(n)` |

---

## 五、FormBuilder（从 main.ts 提取）

`src/view/shared/form-builder.ts`

### 5.1 职责

将 `main.ts:549-590` 的 `parseFormBlock` 和控件生成逻辑提取为独立可复用的模块。

### 5.2 接口

```typescript
class FormBuilder {
  /**
   * 渲染表单控件
   * @param schema 目标表的 SchemaSummary
   * @param values 初始值（编辑模式预填）
   * @param options.mode 'new' | 'edit'
   * @returns { element: HTMLElement, getValues: () => Record<string, unknown> }
   */
  static render(
    schema: SchemaSummary,
    values?: Record<string, unknown>,
    options?: { mode?: 'new' | 'edit' }
  ): { element: HTMLElement; getValues: () => Record<string, unknown> }

  /**
   * 创建弹窗
   */
  static createModal(
    engine: MDDBEngine,
    schema: SchemaSummary,
    options: { mode: 'new' | 'edit'; storagePk?: string; values?: Record<string, unknown> }
  ): void
}
```

### 5.3 控件映射（从 main.ts 继承）

| 类型 | 控件 | 来源 |
|------|------|------|
| `string` | `<input type="text">` | main.ts 已有 |
| `integer` | `<input type="number">` | main.ts 已有 |
| `decimal` | `<input type="number" step="0.01">` | main.ts 已有 |
| `boolean` | checkbox | main.ts 已有 |
| `date` | `<input type="date">` | main.ts 已有 |
| `enum` | `<select>` | main.ts 已有 |
| `ref` | `<select>` (engine.query 加载) | main.ts 已有 |

---

## 六、文件结构变化

```
src/view/
├── parser.ts                              # 不变
├── base-view-model.ts                     # 不变
├── table/
│   ├── table-view-model.ts                # ★ 增强：编辑/列控制/CRUD
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

## 七、测试策略

| 测试 | 方式 | 覆盖 |
|------|------|------|
| TableViewModel 编辑 | 单元测试 mock engine | `startEdit` → `commitEdit` 调 engine.update / `cancelEdit` 恢复 |
| TableViewModel 列可见性 | 单元测试 | `toggleColumn` 增减 / `showAllColumns` 恢复 / `hideColumn` |
| TableViewModel CRUD | 单元测试 mock engine | `deleteRow` 调 engine.delete / `insertRow` 调 engine.insert |
| InlineTableRenderer | 集成测试 | 模拟代码块 → 渲染 → 双击 → 输入 → 保存 |
| FormBuilder | 单元测试 | 各类型控件渲染 / `getValues` 收集 / 弹窗生命周期 |
| main.ts 处理器 | 集成测试 | 代码块解析 → ViewModel 创建 → 渲染结果 |
