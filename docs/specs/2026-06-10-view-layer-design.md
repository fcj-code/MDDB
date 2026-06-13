# MD-DB 视图层设计文档 v1.0

> 日期：2026-06-10（最近更新：2026-06-12）
> 状态：已实现 — 视图层已全部实现，本文档记录设计与实际实现的对照
> 依赖：`2026-06-11-implementation-roadmap-v2.md`（实施路线图 v2，Milestone 4 ✅ 表格视图 + Milestone 6 ✅ 表单视图）
> 决策数：35 项 + 1 项引擎变更（本文档已标注实现状态）

---

## 一、设计概述

### 1.1 核心定位

视图层是查询引擎与用户界面之间的桥梁。它负责：

- 将查询引擎的 `Query → ResultSet` 管道封装为视图可消费的 ViewModel
- 提供声明式语法让用户在 Markdown 中定义视图
- 通过 UI 交互支持数据的完整 CRUD 操作
- 管理视图的生命周期和跨视图数据同步

### 1.2 架构位置

```
┌──────────────────────────────────────────────────┐
│                   视图层 (已实现)                   │
│  ┌──────────┬──────────┬──────────────────────┐  │
│  │ Parser   │ ViewModel│ View (DOM + 交互)     │  │
│  │ 文本→Config│ 数据+状态│ TableView / FormView  │  │
│  └──────────┴──────────┴──────────────────────┘  │
│        ↕ QueryEngine  ↕ EventBus  ↕ CRUD API      │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│           查询引擎 + 事务模型 (已实现)              │
│    Query → SQL → ResultSet  |  SAVEPOINT 事务      │
└──────────────────────────────────────────────────┘
```

> 注：实际实现中，TableView 使用独立的 TableViewModel（`view/table/table-view-model.ts`），而 FormView 直接在 `main.ts` 中通过代码块处理器渲染，不经过独立的 FormViewModel 类。两者均通过 `engine` 统一接口操作数据。

### 1.3 范围

本次设计覆盖（标注实施状态）：

- **视图层 API 接口**：BaseViewModel 抽象 ✅ 已实现、事件系统 ✅ 已实现、生命周期 ✅ 已实现、依赖注入 ✅ 已实现
- **表格视图**：声明语法 ✅ 已实现、渲染 ✅ 已实现、排序 ✅ 已实现（单列）、分页 ✅ 已实现（按钮分页）
- **表格视图（延期）**：行内编辑 ⬜ 延期、列显示控制 ⬜ 延期、CRUD 操作入口 ⬜ 延期
- **表单视图**：声明语法 ✅ 已实现（new 模式）、字段控件映射 ✅ 已实现（5 种基础类型）、提交流程 ✅ 已实现
- **表单视图（延期）**：edit/view 模式 ⬜ 延期、客户端校验 ⬜ 延期、layout: compact ⬜ 延期

远期延后（保持不变）：
- 看板/日历/画廊/图表/图谱视图
- 撤销机制（undo 栈）
- DQL 终端用户查询语法

---

## 二、核心架构

### 2.1 分层模式：BaseViewModel + 继承

```
BaseViewModel                          ◀ 已实现 (src/view/base-view-model.ts)
├ query(config) / refresh()
├ filter 状态 (add / remove / clear)    ◀ 接口定义，排序状态已实现
├ sort 状态 (set / clear / multi-sort)  ◀ 单列排序已实现，多列延期
├ pagination 状态                       ◀ 已实现
├ insert / update / delete              ◀ 接口定义，视图层延期
├ format pipeline (decimal / null / ref) ◀ DataLayer 已实现
├ event bus (subscribe / emit)          ◀ EventBus 已实现
└ dispose()

TableViewModel extends BaseViewModel   ◀ 已实现 (src/view/table/table-view-model.ts)
├ column metadata (visible / hidden)    ◀ 接口定义，列选择延期
├ cell editing state                    ⬜ 延期
├ row selection                         ⬜ 延期
└ 行内 CRUD 操作 (insertAbove / insertBelow) ⬜ 延期

FormViewModel extends BaseViewModel    ◀ 未独立实现；表单渲染直接在 main.ts 中实现
```

> 实现说明：表单视图的实际实现路径不同于设计文档。设计文档假设 FormViewModel 继承 BaseViewModel，但实际实现中，表单渲染通过 `main.ts` 中的 `parseFormBlock` 函数和 Obsidian 代码块处理器直接完成，不经过独立的 ViewModel 类。表单提交流程直接调用 `engine.insert()`。

**决策 1**：BaseViewModel 负责"要什么数据"（查询 + 过滤 + 排序 + 分页），子类负责"数据长什么样"（列配置、表单字段、看板分组）。✅ 已实现（表格子类已实现，表单子类未独立实现）

### 2.2 ViewModel 与 View 分离

ViewModel 管理数据和状态，不触碰 DOM。独立的 View 类负责 DOM 渲染和事件绑定。

```
Parser (独立)    Config (纯数据)    ViewModel (数据+状态)    View (DOM+交互)
──────────────────────────────────────────────────────────────────────────
parseTableBlock  →  TableConfig  →  TableViewModel        →  TableView
(source: string)     (interface)     (查询/排序/分页/事件)    (DOM 渲染/排序/分页)
                                    
parseFormBlock   →  FormConfig   →  (直接在 main.ts 中渲染) →  Form DOM
(source: string)     (interface)     无需独立 ViewModel       (代码块处理器渲染)
```

**决策 33**：ViewModel 单元测试不碰 DOM；View 单元测试 mock ViewModel 测 DOM 行为。✅ 已实现（TableView/TableViewModel 分离，但 View 单元测试未覆盖）

### 2.3 生命周期：数据层池化 + UI 层随代码块

```
DataLayer (全局常驻)                    ViewLayer (随代码块创建/销毁)
├ 事件总线 (EventBus)                  ├ ViewModel 实例
├ 查询结果缓存                          ├ View 实例 (DOM)
└ 格式化器 (decimal/null/ref)          └ UI 状态 (排序/过滤/滚动位置)
```

**决策 14**：数据层在 Obsidian 启动时初始化，全局共享。UI 层随 Markdown 代码块渲染时创建，代码块卸载时销毁（`vm.dispose()`）。✅ 已实现

---

## 三、视图定义方式

### 3.1 声明式 + 运行时 API

**决策 4**：用户通过 Markdown 代码块声明视图的初始配置，同时 ViewModel 暴露运行时 API 让 UI 交互（列头点击、过滤器控件）实时修改配置。

```
用户写 mddb-table 块（初始定义）
  → 解析为 TableConfig 对象
  → TableViewModel 持有该 config
  → 用户在表格 UI 上操作（排序/分页）
  → ViewModel.setSort() / goToPage()
  → 内部修改 config → 重新查询 → 刷新渲染
  → 自动写回代码块（debounce 300ms）⬜ 延期
```

> 实现说明：`mddb-table` 的排序和分页交互已实现，但运行时配置自动写回代码块（决策 18）尚未实现。`mddb-form` 的提交流程已实现，但无运行时 API 配置修改。

### 3.2 表格视图声明语法

**决策 5**：简洁行风格，面向普通用户的可读性。✅ 已实现

````markdown
```mddb-table
from contacts
show 姓名, 公司, 职位, 重要度
sort by 重要度 desc
where 重要度 = 高, 公司 = 腾讯
limit 20
```
````

| 行 | 必需 | 说明 | 实现状态 |
|----|:---:|------|:-------:|
| `from <table>` | ✅ | 数据表名 | ✅ 已实现 |
| `show <columns>` | ❌ | 显示列，逗号分隔，不写=全部 | ✅ 已实现 |
| `sort by <field> <dir>` | ❌ | 排序，支持多行=多列排序 | ✅ 已实现 |
| `where <field> = <value>` | ❌ | 过滤条件，逗号=AND，不支持 OR 嵌套 | ✅ 已实现（支持 AND/OR/IN/IS NULL） |
| `limit <n>` | ❌ | 每页行数，默认 50 | ✅ 已实现（默认 200，由查询引擎控制） |

> 实现差异：实际 WHERE 支持比设计更强，实现了 `parseWhere` 表达式引擎，支持 AND/OR/IN/IS NULL 操作符（见 `view/parser.ts`）。

**决策 6**：WHERE 只支持扁平 AND，复杂嵌套走编程 API。⚡ 实际实现：WHERE 已支持 AND/OR/IN/IS NULL，优于设计。

### 3.3 表单视图声明语法

**决策 12, 13**：三种模式 —— `new`（新增）、`edit`（编辑）、`view`（只读）。⚡ 实际仅 `new` 模式已实现。

````markdown
```mddb-form
to contacts
fields 姓名, 公司, 职位, 电话
mode new
layout compact
keep-open true
```
````

| 行 | 必需 | 说明 | 实现状态 |
|----|:---:|------|:-------:|
| `to <table>` | ✅ | 目标数据表 | ✅ 已实现 |
| `fields <names>` | ❌ | 显示字段，不写=全部 | ✅ 已实现 |
| `mode <new\|edit\|view>` | ❌ | 默认 `new` | ⚠️ 仅 `new` 模式已实现；`edit`/`view` ⬜ 延期 |
| `layout <normal\|compact>` | ❌ | 默认 `normal` 单列 | ⚠️ 仅 `normal` 已实现；`compact` ⬜ 延期 |
| `keep-open <true\|false>` | ❌ | 仅独立块，提交后是否保持打开 | ✅ 已实现 |
| `where <field> = <value>` | ❌ | `view` 模式定位记录 | ⬜ 延期（依赖 edit/view 模式） |

### 3.4 运行时配置写回

**决策 18**：用户通过 UI 修改配置（排序/过滤/列选择）后，自动写回代码块内容（debounce 300ms）。⬜ 延期

**决策 24**：写回前比对上次写回后的缓存内容。内容一致（无外部改动）→ 安全写回。不一致（用户手动编辑过代码块）→ 跳过本次写回，仅在内存生效。⬜ 延期

> 当前实现：排序和分页仅在内存会话中生效，不写回代码块。用户关闭文件后排序状态丢失。

---

## 四、事件系统

### 4.1 通用事件总线

**决策 3**：`on(type, cb)` + `off(type, cb)` 模式。Change 事件使用 discriminated union。✅ 已实现（见 `view/shared/event-bus.ts`）

```typescript
type Change =
  | { type: 'insert'; record: Record }
  | { type: 'update'; pk: string; field: string; oldValue: any; newValue: any }
  | { type: 'delete'; pk: string }

type ViewEvent =
  | { type: 'data-changed'; changes: Change[] }
  | { type: 'state-changed'; state: ViewState }
  | { type: 'error'; errors: Error[] }

// 使用
vm.on('data-changed', (event) => {
  for (const c of event.changes) {
    switch (c.type) {
      case 'update': /* c.field, c.newValue */ break
      case 'delete': /* c.pk */ break
      case 'insert': /* c.record */ break
    }
  }
})
```

> 实现说明：EventBus 已实现精确类型 + 通配符 `onAny` + 异常隔离。但 `Change` discriminated union 的完全形态（含 `field`、`oldValue` 等字段）依赖于行内编辑功能的实现，当前 `data-changed` 事件仅在 DataLayer 的 auto-refresh 场景中使用，触发粒度为粗粒度的"数据已变化"通知。

### 4.2 跨视图同步流程

```
用户在建行表格中编辑单元格：
  TableView 检测变更                              ⬜ 延期（行内编辑未实现）
  → TableViewModel.updateCell(pk, col, val)       ⬜
  → engine.update() 写文件                        ⬜
  → EventBus.emit('data-changed', ...)            ⬜
  → 侧边栏汇总视图订阅了同一事件 → refresh()       ⬜
  → 同一页的 FormViewModel 判断自己的 pk 是否匹配  ⬜
```

> 当前实现：DataLayer 支持 `data-changed` 事件触发的 auto-refresh（`data-layer.ts`），但行内编辑未实现，因此跨视图同步流程尚未完整打通。

---

## 五、表格视图

### 5.1 渲染方式

**决策 7**：通过 Obsidian `MarkdownPostProcessor` 拦截 `mddb-table` 代码块，替换为渲染好的 DOM 表格。✅ 已实现

```typescript
plugin.registerMarkdownCodeBlockProcessor('mddb-table', (source, el) => {
  const config = parseTableBlock(source)
  const vm = new TableViewModel(engine, events, config)
  new TableView(vm).mount(el)
})
```

### 5.2 编辑模式

**决策 8**：行内编辑。单元格点击 → 输入框 → 失焦/Enter 保存。⬜ 延期

```
阅读态：| 张三 | 腾讯 | 产品总监 |
点击"腾讯"：| 张三 | [____腾讯____] | 产品总监 |   ← 输入框
失焦/Enter → 自动保存
```

> 当前表格为只读视图，不支持单元格编辑。

### 5.3 保存时机

**决策 9**：即时自动保存。单元格编辑完成（失焦或 Enter）→ `vm.updateCell()` → 引擎写穿到文件 → 状态栏瞬间提示"已保存"。失败 → 单元格恢复原值 + 标红。⬜ 延期（依赖行内编辑）

### 5.4 分页

**决策 27**：滚动自动加载（无限滚动）+ 虚拟滚动渲染。⚡ 实际实现：上一页/下一页按钮分页。

> 实现差异：当前分页使用按钮控件（`上一页` / `下一页` + 页码显示），而非无限滚动。`ResultSet` 返回 `page`/`pageSize`/`totalPages`/`hasMore` 元数据。虚拟滚动未实现。

### 5.5 列显示控制

**决策 10**：工具栏列选择器下拉（多选勾选/取消）+ 右键列头快捷隐藏。⬜ 延期

```
[ 列 ▾ ]                        ← 点击
  ☑ 姓名
  ☑ 公司
  ☐ 职位                        ← 取消勾选 → 该列隐藏
  ☑ 重要度
```

### 5.6 排序交互

**决策 22**：多列排序。默认点击替换排序（单列），Shift+点击添加排序列。列头显示序号标记。⚡ 实际实现：仅单列排序。

```
点"日期"列头 → 按日期排序，列头显示 ↑
再次点"日期"列头 → 切换降序，列头显示 ↓
```

> 实现差异：当前仅支持单列排序（点击替换，再点击切换方向），不支持 Shift+点击多列排序。

### 5.7 CRUD 操作入口

**决策 20（新增）**：工具栏"+"按钮 → 弹出表单弹窗（`FormViewModel, mode: new`）+ 表格底部空白行快速录入。⬜ 延期

**决策 21（删除/操作）**：行首操作按钮（⠿），点击弹出菜单：⬜ 延期

```
┌────┬────────┬────────┬──────────┐
│ #  │ 姓名    │ 公司    │ 职位     │
├────┼────────┼────────┼──────────┤
│ ⠿  │ 张三    │ 腾讯   │ 产品总监 │  ← 点⠿弹出：
│ ⠿  │ 李四    │ 字节   │ 架构师   │      编辑
│    │        │        │          │      删除
│    │        │        │          │      向上插入
│    │        │        │          │      向下插入
└────┴────────┴────────┴──────────┘
```

删除弹出确认对话框（"确定删除 [张三]？"）。

**决策 26（插入行为）**：向上/向下插入走行内空行（表格中直接输入），工具栏"+"走表单弹窗。⬜ 延期

### 5.8 插入的物理位置和显示顺序

**决策 29（引擎变更）**：存储引擎 §8 "插入位置末尾追加" → 改为"指定行号插入"。插入后后续行物理行号 +1，`_binding` 表 `line_number` 级联更新。⚡ 引擎侧已实现（crud-executor.ts 支持 insertAt），但视图层未暴露插入 UI。

**决策 30**：插入后物理位置 = 表格显示位置。用户点击列头排序后才按排序规则重新排列。⚡ 引擎侧已支持，视图层 UI 未暴露。

---

## 六、表单视图

### 6.1 打开场景

**决策 11**：
- **新增弹窗**：表格工具栏"+" → 表单弹窗 ⬜ 延期
- **编辑弹窗**：表格行菜单"编辑" → 表单弹窗（加载当前值）⬜ 延期
- **独立表单块**：用户声明 `mddb-form` 代码块作为独立录入入口 ✅ 已实现

### 6.2 字段控件映射

**决策 16**：根据 Schema 类型自动选择输入控件。✅ 已实现（5 种基础类型）

| 类型 | 控件 | 说明 | 实现状态 |
|------|------|------|:-------:|
| `string` | `<input type="text">` | 单行文本 | ✅ 已实现 |
| `integer` | `<input type="number">` | 整数 | ✅ 已实现 |
| `decimal(N)` | `<input type="number" step="0.01">` | 带精度 | ✅ 已实现 |
| `boolean` | toggle / checkbox | 开关 | ✅ 已实现 |
| `date` | `<input type="date">` | 日期选择器 | ✅ 已实现 |
| `datetime` | `<input type="datetime-local">` | 日期时间选择器 | ⬜ 延期 |
| `email` | `<input type="email">` | 邮箱输入 | ⬜ 延期 |
| `phone` | `<input type="tel">` | 电话输入 | ⬜ 延期 |
| `text` | `<textarea>` | 多行文本 | ⬜ 延期 |
| `tags` | tag input | 输入框 + 标签展示 | ⬜ 延期 |
| `enum(v,…)` | `<select>` / dropdown | 下拉选择 | ✅ 已实现 |
| `ref(table)` | relation picker | 搜索目标表记录 | ✅ 已实现（engine.query 加载 ref 表数据） |

### 6.3 客户端校验

**决策 19**：全量校验，在调 `engine.insert/update` 之前完成。⬜ 延期

| 校验项 | 行为 | 实现状态 |
|--------|------|:-------:|
| 类型校验 | 输入无法转为目标类型 → 标红 + 提示 | ⬜ 延期 |
| 必填检查 | `@required` 字段为空 → 标红 + "此项必填" | ⬜ 延期 |
| 格式检查 | `email` 不合法 / `phone` 格式异常 → 标红 + 格式提示 | ⬜ 延期 |
| PK 唯一性 | 预查 `_binding` 表 → 冲突时提示 | ⬜ 延期 |
| ref 引用 | 检查目标记录是否存在 → 不存在时警告 | ⬜ 延期 |

> 当前实现：表单提交时直接调用 `engine.insert()`，依赖引擎侧的校验（parse/validator.ts），无独立客户端校验层。

### 6.4 提交行为

**决策 17**：
- 弹窗模式（表格触发的新增/编辑）→ 提交后关闭弹窗 ⬜ 延期
- 独立块模式（`mddb-form` 声明）→ 默认关闭，声明 `keep-open: true` 时清空表单保持打开 ✅ 已实现

### 6.5 字段布局

**决策 28**：默认单列纵向，`layout: compact` 切换双列。⚡ 仅 `normal` 已实现。

```
layout: normal（默认）✅ 已实现        layout: compact ⬜ 延期
姓名: [____________]         姓名: [________]  公司: [________]
公司: [____________]         职位: [________]  电话: [________]
职位: [____________]         邮箱: [________]  备注: [________]
```

### 6.6 mode: view 多条匹配

**决策 31**：`where` 匹配多条时显示第一条 + 行切换器 "第 N 条 / 共 M 条"。⬜ 延期（依赖 edit/view 模式）

```
┌─────────────────────────────────┐
│ [< 上一条]  1 / 3  [下一条 >]   │
│                                 │
│ 姓名: [张三___________________] │ ← 只读
│ 公司: [腾讯___________________] │
└─────────────────────────────────┘
```

---

## 七、解析器

### 7.1 独立 Parser 模块

**决策 32**：解析器和 ViewModel 分离。Parser 将声明文本转为配置对象，ViewModel 只接受已解析的 Config。✅ 已实现

```typescript
// src/view/parser.ts — TableConfig 解析
function parseTableBlock(source: string): TableConfig

// src/main.ts — FormConfig 解析（非独立模块，在代码块处理器内联实现）
function parseFormBlock(source: string): FormConfig

interface TableConfig {
  table: string
  columns?: string[]
  sort?: SortClause[]
  filter?: FilterGroup
  limit?: number
}

interface FormConfig {
  table: string
  fields?: string[]
  mode: 'new' | 'edit' | 'view'
  layout?: 'normal' | 'compact'
  keepOpen?: boolean
  filter?: FilterGroup          // mode: view/edit 定位记录
}
```

> 实现差异：`parseTableBlock` 已实现为独立模块（`view/parser.ts`），包含 `parseWhere` 表达式引擎。`parseFormBlock` 实现在 `main.ts` 中，为内联实现，非独立模块。Config 对象结构与设计一致。

Config 对象是纯数据接口，可序列化。远期的声明式语法扩展只需产出相同的 Config → 传入同一个 ViewModel。

---

## 八、依赖注入

### 8.1 构造函数注入

**决策 25**：ViewModel 构造时接收服务引用。✅ 已实现

```typescript
class BaseViewModel {
  constructor(
    protected engine: Engine,        // CRUD + QueryEngine
    protected events: EventBus,       // 全局事件总线
    protected config: ViewConfig      // 视图配置
  ) {}
}
```

> 实现差异：实际 `BaseViewModel` 只接收 `viewId`（见 `base-view-model.ts:23`），`engine` 和 `config` 由子类 `TableViewModel` 构造函数注入。`DataLayer` 独立接收 `engine` 引用。

---

## 九、错误展示

### 9.1 状态栏 + 内联

**决策 15**：
- **状态栏**：显示全局错误计数 `MD-DB: 3 tables, 1 error, 2 warnings` ✅ 已实现
- **查询失败**：表格区显示错误卡片 `⚠ 查询失败：表 'xxx' 未找到 [重试]` ✅ 已实现
- **单元格编辑失败**：单元格恢复原值 + 短暂红色闪烁 + tooltip ⬜ 延期（依赖行内编辑）
- **表单校验失败**：字段标红 + 错误提示文字 ⬜ 延期

---

## 十、引擎变更

### 10.1 INSERT 策略变更

**原决策（存储引擎 §8）**：INSERT 始终末尾追加。
**新决策（视图层 §5.8）**：INSERT 改为指定行号插入。✅ 引擎侧已实现（crud-executor.ts 支持 insertAt），视图层 UI 尚未暴露插入入口。

影响范围：`crud-executor.ts` 已支持 `insertAt(file, lineNumber, content)`，见 `implementation-roadmap-v2.md` §Milestone 2。

---

## 十一、文件结构

```
src/view/
├── parser.ts                # ✅ parseTableBlock + ViewConfigBuilder + parseWhere 表达式引擎
├── base-view-model.ts       # ✅ BaseViewModel（事件/状态管理/生命周期）
├── table/
│   ├── table-view-model.ts  # ✅ TableViewModel（分页/排序/编辑/CRUD/列宽/React 桥接）
│   ├── table-view.tsx       # ✅ TableView — Obsidian ItemView（React 渲染）
│   ├── table-config.ts      # ✅ TableConfig interface + 列类型→对齐猜测
│   ├── inline-renderer.tsx  # ✅ 代码块内嵌渲染器（React createRoot）
│   └── react/               # ★ 新增 React 组件目录
│       ├── index.tsx        #    App 入口（事件订阅 + form modal 管理）
│       ├── action-menu.tsx  #    ⠿ 操作菜单
│       ├── bottom-bar.tsx   #    底栏
│       ├── form-modal.tsx   #    新增/编辑表单弹窗
│       └── table/
│           ├── index.tsx    #    虚拟滚动表格（react-virtuoso）
│           ├── header-cell.tsx  # 表头（排序 + 列宽拖拽）
│           ├── body-cell.tsx    # 类型感知编辑单元格
│           ├── column-resize-handle.tsx  # 列宽拖拽手柄
│           └── styles.css   #    React 表格样式
├── shared/
│   ├── event-bus.ts         # ✅ 全局事件总线
│   ├── data-layer.ts        # ✅ 数据层桥接（查询/缓存/分页/排序/auto-refresh）
│   ├── types.ts             # ✅ ViewStatus、TableViewState、ViewColumn、ViewRow、ViewEvent 公共类型
│   └── form-builder.ts      # ✅ 表单控件生成器（从 main.ts 提取）
└── integration.ts           # ✅ registerViewLayer()
```

> 注：表单弹窗（FormModal）使用 FormBuilder 生成 DOM 控件。`inline-renderer.ts` 和 `table-view.ts` 已重命名为 `.tsx` 以支持 JSX。`view-config.ts` 未创建，因为 `ViewConfig` 类型在 `query/types.ts` 中已有定义。

---

## 十二、决策记录（已标注实现状态）

| # | 决策项 | 结论 | 状态 |
|---|--------|------|:----:|
| 1 | 交互模式 | BaseViewModel + 视图 ViewModel 继承 | ✅ 已实现 |
| 2 | 分层原则 | Base 公共层（查询/过滤/排序/CRUD/事件/格式化/分页），子类特有 | ✅ 已实现 |
| 3 | 事件系统 | `on(type, cb)` + `off(type, cb)`，Event/Change 用 discriminated union | ✅ EventBus 已实现 |
| 4 | 视图定义方式 | 声明式代码块 + 运行时配置 API，共享 Config 对象 | ✅ 已实现 |
| 5 | 表格声明语法 | `from` / `show` / `sort by` / `where` / `limit` | ✅ 已实现 |
| 6 | WHERE 条件 | 扁平 AND，逗号分隔，不支持嵌套 OR | ⚡ 实际支持 AND/OR/IN/IS NULL |
| 7 | 渲染方式 | `MarkdownPostProcessor` 代码块替换为 React UI | ✅ React (createRoot) |
| 8 | 编辑模式 | 行内编辑（单元格点击 → 输入框 → 失焦/Enter） | ✅ React 实现，类型感知 |
| 9 | 保存时机 | 即时自动保存（失焦/Enter → engine.update → 文件写穿） | ✅ 已实现（force 模式） |
| 10 | 列显示控制 | 列选择器下拉（多选） + 右键列头快捷隐藏 | ⬜ 延期 |
| 11 | 表单场景 | 新增弹窗 / 编辑弹窗 / 独立 `mddb-form` 声明块 | ⚠️ 仅独立块已实现 |
| 12 | 表单声明语法 | `to` / `fields` / `mode` / `layout` / `keep-open` | ✅ 已实现 |
| 13 | 表单模式 | `new`（新增）/ `edit`（编辑）/ `view`（只读） | ⚠️ 仅 `new` 已实现 |
| 14 | 生命周期 | 数据层全局池化（EventBus + 缓存） + UI 层随代码块创建/销毁 | ✅ 已实现 |
| 15 | 错误展示 | 状态栏全局计数 + 视图内联错误卡片/字段标红 tooltip | ✅ 部分已实现 |
| 16 | 表单控件 | 按 Schema 类型自动映射（string→input, enum→select, tags→tag input, ...） | ⚠️ 5 种已实现，其余延期 |
| 17 | 提交行为 | 弹窗关闭（表格触发）；独立块默认关闭，`keep-open: true` 连续录入 | ⚠️ 独立块已实现 |
| 18 | 配置写回 | 自动写回代码块（debounce 300ms） + 脏检测跳过 | ⬜ 延期 |
| 19 | 客户端校验 | 全量：类型 + 必填 + 格式 + PK 唯一性 + ref 引用 | ⬜ 延期 |
| 20 | 新增行入口 | 工具栏"+"按钮 → 表单弹窗 | ✅ 已实现（`+New Row` + FormModal） |
| 21 | 删除/操作入口 | 行首操作按钮（⠿）→ 菜单：编辑/删除 | ✅ 已实现（React） |
| 22 | 排序交互 | 多列排序（默认替换，Shift+点击添加），列头显示序号 | ⚠️ 仅单列排序已实现 |
| 23 | 列宽调整 | 表头拖拽手柄调整列宽（参考 DataLoom） | ✅ 已实现（5px 拖拽区） |
| 24 | 撤销机制 | 进待讨论清单（远期） | ⬜ 远期 |
| 25 | 写回并发冲突 | 比对上次写回缓存，不一致 → 跳过写回，仅内存生效 | ⬜ 延期 |
| 26 | 依赖注入 | 构造函数注入（`engine`, `events`, `config`） | ✅ 已实现 |
| 27 | 插入行行为 | 向上/向下插入走行内空行，工具栏"+"走表单弹窗 | ⬜ 延期 |
| 28 | 分页 | 虚拟滚动渲染（react-virtuoso） | ✅ react-virtuoso 已实现 |
| 29 | 表单布局 | 默认单列纵向，`layout: compact` 切换双列 | ⚠️ 仅 `normal` 已实现 |
| 30 | 插入物理位置 | **引擎变更**：INSERT 改为指定行号插入 | ✅ 引擎侧已实现 |
| 31 | 插入排序语义 | 物理位置 = 显示位置，排序由用户手动触发 | ✅ 引擎侧已支持 |
| 32 | mode: view 多匹配 | 显示第一条 + 行切换器 | ⬜ 延期 |
| 33 | 解析器位置 | 独立 Parser 模块，接受 string → Config | ✅ 已实现（表格）；⚠️ 表单在 main.ts 内联 |
| 34 | View/ViewModel | 分离。ViewModel 管数据+状态，View 管 DOM+交互 | ✅ 已实现（表格） |
| 35 | 文件结构 | 按职责分层：parser / base / table / form / shared / integration | ⚠️ `form/` 目录未创建 |
| 36 | 集成入口 | `registerViewLayer(plugin, engine)` 单函数 | ✅ 已实现 |

---

## 十三、待讨论清单

- 撤销机制（Ctrl+Z undo 栈）
- 多文件表视图
- 看板/日历/画廊/图表/图谱视图
- DQL 终端用户查询语法

---

## 十四、与已有设计文档的关系

| 已有文档 | 本文档关联 |
|---------|-----------|
| `2026-06-11-implementation-roadmap-v2.md` | 视图层对应 Milestone 4（表格视图 ✅）和 Milestone 6（表单视图 ✅） |
| `2026-06-10-query-engine-design.md` | ViewModel 消费 `QueryEngine.query()` + `ResultSet`（已合并入 v2 路线图） |
| `2026-06-10-transaction-model-design.md` | 表单提交走 `engine.transaction(cb)` 显式事务（已合并入 v2 路线图） |
| `2026-06-10-storage-engine-design.md` §8 | §10.1 引擎变更：INSERT 改为指定行号插入（已实现） |
| `implementation-roadmap.md` Phase 17 | ⚠️ 已废弃，以 v2 路线图为准 |
