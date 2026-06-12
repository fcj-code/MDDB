# MD-DB 视图层设计文档 v1.0

> 日期：2026-06-10
> 状态：草案 — 视图层完整设计
> 依赖：`2026-06-10-query-engine-design.md`（查询引擎）、`2026-06-10-transaction-model-design.md`（事务模型）、`2026-06-10-storage-engine-design.md`（存储引擎）
> 决策数：35 项 + 1 项引擎变更

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
│                   视图层 (本次设计)                 │
│  ┌──────────┬──────────┬──────────────────────┐  │
│  │ Parser   │ ViewModel│ View (DOM + 交互)     │  │
│  │ 文本→Config│ 数据+状态│ TableView / FormView  │  │
│  └──────────┴──────────┴──────────────────────┘  │
│        ↕ QueryEngine  ↕ EventBus  ↕ CRUD API      │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│              查询引擎 + 事务模型 (已设计)            │
│      Query → SQL → ResultSet  |  ACID 事务        │
└──────────────────────────────────────────────────┘
```

### 1.3 范围

本次设计覆盖：
- **视图层 API 接口**：BaseViewModel 抽象、事件系统、生命周期、依赖注入
- **表格视图**：声明语法、渲染、行内编辑、排序、过滤、分页、列控制、CRUD 操作
- **表单视图**：声明语法、字段控件映射、客户端校验、提交流程、模式切换

远期延后：
- 看板/日历/画廊/图表/图谱视图
- 撤销机制（undo 栈）
- DQL 终端用户查询语法

---

## 二、核心架构

### 2.1 分层模式：BaseViewModel + 继承

```
BaseViewModel                          ◀ 所有视图共享
├ query(config) / refresh()
├ filter 状态 (add / remove / clear)
├ sort 状态 (set / clear / multi-sort)
├ pagination 状态
├ insert / update / delete
├ format pipeline (decimal / null / ref)
├ event bus (subscribe / emit)
└ dispose()

TableViewModel extends BaseViewModel   ◀ 表格特有
├ column metadata (visible / hidden)
├ cell editing state
├ row selection
└ 行内 CRUD 操作 (insertAbove / insertBelow)

FormViewModel extends BaseViewModel    ◀ 表单特有
├ load single record by pk
├ field-level validation
├ dirty tracking
└ submit / reset / keepOpen 控制

KanbanViewModel extends BaseViewModel  ◀ 远期
...
```

**决策 1**：BaseViewModel 负责"要什么数据"（查询 + 过滤 + 排序 + 分页），子类负责"数据长什么样"（列配置、表单字段、看板分组）。

### 2.2 ViewModel 与 View 分离

ViewModel 管理数据和状态，不触碰 DOM。独立的 View 类负责 DOM 渲染和事件绑定。

```
Parser (独立)    Config (纯数据)    ViewModel (数据+状态)    View (DOM+交互)
──────────────────────────────────────────────────────────────────────────
parseTableBlock  →  TableConfig  →  TableViewModel        →  TableView
(source: string)     (interface)     (查询/排序过滤/CRUD/事件)  (虚拟滚动/DOM/事件)
```

**决策 33**：ViewModel 单元测试不碰 DOM；View 单元测试 mock ViewModel 测 DOM 行为。

### 2.3 生命周期：数据层池化 + UI 层随代码块

```
DataLayer (全局常驻)                    ViewLayer (随代码块创建/销毁)
├ 事件总线 (EventBus)                  ├ ViewModel 实例
├ 查询结果缓存                          ├ View 实例 (DOM)
└ 格式化器 (decimal/null/ref)          └ UI 状态 (排序/过滤/列选择/滚动位置)
```

**决策 14**：数据层在 Obsidian 启动时初始化，全局共享。UI 层随 Markdown 代码块渲染时创建，代码块卸载时销毁（`vm.dispose()`）。

---

## 三、视图定义方式

### 3.1 声明式 + 运行时 API

**决策 4**：用户通过 Markdown 代码块声明视图的初始配置，同时 ViewModel 暴露运行时 API 让 UI 交互（列头点击、过滤器控件）实时修改配置。

```
用户写 mddb-table 块（初始定义）
  → 解析为 TableConfig 对象
  → TableViewModel 持有该 config
  → 用户在表格 UI 上操作（排序/过滤/勾选列）
  → ViewModel.setSort() / setColumns() / setFilter()
  → 内部修改 config → 重新查询 → 刷新渲染
  → 自动写回代码块（debounce 300ms）
```

### 3.2 表格视图声明语法

**决策 5**：简洁行风格，面向普通用户的可读性。

````markdown
```mddb-table
from contacts
show 姓名, 公司, 职位, 重要度
sort by 重要度 desc
where 重要度 = 高, 公司 = 腾讯
limit 20
```
````

| 行 | 必需 | 说明 |
|----|:---:|------|
| `from <table>` | ✅ | 数据表名 |
| `show <columns>` | ❌ | 显示列，逗号分隔，不写=全部 |
| `sort by <field> <dir>` | ❌ | 排序，支持多行=多列排序 |
| `where <field> = <value>` | ❌ | 过滤条件，逗号=AND，不支持 OR 嵌套 |
| `limit <n>` | ❌ | 每页行数，默认 50 |

**决策 6**：WHERE 只支持扁平 AND，复杂嵌套走编程 API。

### 3.3 表单视图声明语法

**决策 12, 13**：三种模式 —— `new`（新增）、`edit`（编辑）、`view`（只读）。

````markdown
```mddb-form
to contacts
fields 姓名, 公司, 职位, 电话
mode new
layout compact
keep-open true
```
````

| 行 | 必需 | 说明 |
|----|:---:|------|
| `to <table>` | ✅ | 目标数据表 |
| `fields <names>` | ❌ | 显示字段，不写=全部 |
| `mode <new\|edit\|view>` | ❌ | 默认 `new` |
| `layout <normal\|compact>` | ❌ | 默认 `normal` 单列，`compact` 双列 |
| `keep-open <true\|false>` | ❌ | 仅独立块，提交后是否保持打开 |
| `where <field> = <value>` | ❌ | `view` 模式定位记录 |

### 3.4 运行时配置写回

**决策 18**：用户通过 UI 修改配置（排序/过滤/列选择）后，自动写回代码块内容（debounce 300ms）。

**决策 24**：写回前比对上次写回后的缓存内容。内容一致（无外部改动）→ 安全写回。不一致（用户手动编辑过代码块）→ 跳过本次写回，仅在内存生效。

---

## 四、事件系统

### 4.1 通用事件总线

**决策 3**：`on(type, cb)` + `off(type, cb)` 模式。Change 事件使用 discriminated union。

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

### 4.2 跨视图同步流程

```
用户在建行表格中编辑单元格：
  TableView 检测变更
  → TableViewModel.updateCell(pk, col, val)
  → engine.update() 写文件
  → EventBus.emit('data-changed', { changes: [{ type: 'update', ... }] })
  → 侧边栏汇总视图订阅了同一事件 → refresh()
  → 同一页的 FormViewModel 判断自己的 pk 是否匹配 → 更新显示
```

---

## 五、表格视图

### 5.1 渲染方式

**决策 7**：通过 Obsidian `MarkdownPostProcessor` 拦截 `mddb-table` 代码块，替换为渲染好的 DOM 表格。

```typescript
plugin.registerMarkdownCodeBlockProcessor('mddb-table', (source, el) => {
  const config = parseTableBlock(source)
  const vm = new TableViewModel(engine, events, config)
  new TableView(vm).mount(el)
})
```

### 5.2 编辑模式

**决策 8**：行内编辑。单元格点击 → 输入框 → 失焦/Enter 保存。

```
阅读态：| 张三 | 腾讯 | 产品总监 |
点击"腾讯"：| 张三 | [____腾讯____] | 产品总监 |   ← 输入框
失焦/Enter → 自动保存
```

### 5.3 保存时机

**决策 9**：即时自动保存。单元格编辑完成（失焦或 Enter）→ `vm.updateCell()` → 引擎写穿到文件 → 状态栏瞬间提示"已保存"。失败 → 单元格恢复原值 + 标红。

### 5.4 分页

**决策 27**：滚动自动加载（无限滚动）+ 虚拟滚动渲染。滚动到表格底部自动追加下一页，`total` 和 `hasMore` 在底部小字显示。虚拟滚动只渲染视口内 ~20 行 DOM，其余用占位高度。

### 5.5 列显示控制

**决策 10**：工具栏列选择器下拉（多选勾选/取消）+ 右键列头快捷隐藏。

```
[ 列 ▾ ]                        ← 点击
  ☑ 姓名
  ☑ 公司
  ☐ 职位                        ← 取消勾选 → 该列隐藏
  ☑ 重要度
```

### 5.6 排序交互

**决策 22**：多列排序。默认点击替换排序（单列），Shift+点击添加排序列。列头显示序号标记。

```
点"日期"列头 → 按日期排序，列头显示 ①▲
Shift+点"金额"列头 → 按日期优先、金额次之，列头显示 ①▲ ②▼
```

### 5.7 CRUD 操作入口

**决策 20（新增）**：工具栏"+"按钮 → 弹出表单弹窗（`FormViewModel, mode: new`）+ 表格底部空白行快速录入。

**决策 21（删除/操作）**：行首操作按钮（⠿），点击弹出菜单：

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

**决策 26（插入行为）**：向上/向下插入走行内空行（表格中直接输入），工具栏"+"走表单弹窗。

### 5.8 插入的物理位置和显示顺序

**决策 29（引擎变更）**：存储引擎 §8 "插入位置末尾追加" → 改为"指定行号插入"。插入后后续行物理行号 +1，`_binding` 表 `line_number` 级联更新。

**决策 30**：插入后物理位置 = 表格显示位置。用户点击列头排序后才按排序规则重新排列。

---

## 六、表单视图

### 6.1 打开场景

**决策 11**：
- **新增弹窗**：表格工具栏"+" → 表单弹窗
- **编辑弹窗**：表格行菜单"编辑" → 表单弹窗（加载当前值）
- **独立表单块**：用户声明 `mddb-form` 代码块作为独立录入入口

### 6.2 字段控件映射

**决策 16**：根据 Schema 类型自动选择输入控件。

| 类型 | 控件 | 说明 |
|------|------|------|
| `string` | `<input type="text">` | 单行文本 |
| `integer` | `<input type="number">` | 整数 |
| `decimal(N)` | `<input type="number" step="0.01">` | 带精度 |
| `boolean` | toggle / checkbox | 开关 |
| `date` | `<input type="date">` | 日期选择器 |
| `datetime` | `<input type="datetime-local">` | 日期时间选择器 |
| `email` | `<input type="email">` | 邮箱输入 |
| `phone` | `<input type="tel">` | 电话输入 |
| `text` | `<textarea>` | 多行文本 |
| `tags` | tag input | 输入框 + 标签展示 |
| `enum(v,…)` | `<select>` / dropdown | 下拉选择 |
| `ref(table)` | relation picker | 搜索目标表记录 |

### 6.3 客户端校验

**决策 19**：全量校验，在调 `engine.insert/update` 之前完成。

| 校验项 | 行为 |
|--------|------|
| 类型校验 | 输入无法转为目标类型 → 标红 + 提示 |
| 必填检查 | `@required` 字段为空 → 标红 + "此项必填" |
| 格式检查 | `email` 不合法 / `phone` 格式异常 → 标红 + 格式提示 |
| PK 唯一性 | 预查 `_binding` 表 → 冲突时提示 |
| ref 引用 | 检查目标记录是否存在 → 不存在时警告 |

### 6.4 提交行为

**决策 17**：
- 弹窗模式（表格触发的新增/编辑）→ 提交后关闭弹窗
- 独立块模式（`mddb-form` 声明）→ 默认关闭，声明 `keep-open: true` 时清空表单保持打开

### 6.5 字段布局

**决策 28**：默认单列纵向，`layout: compact` 切换双列。

```
layout: normal（默认）        layout: compact
姓名: [____________]         姓名: [________]  公司: [________]
公司: [____________]         职位: [________]  电话: [________]
职位: [____________]         邮箱: [________]  备注: [________]
```

### 6.6 mode: view 多条匹配

**决策 31**：`where` 匹配多条时显示第一条 + 行切换器 "第 N 条 / 共 M 条"。

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

**决策 32**：解析器和 ViewModel 分离。Parser 将声明文本转为配置对象，ViewModel 只接受已解析的 Config。

```typescript
// src/view/parser.ts
function parseTableBlock(source: string): TableConfig
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

Config 对象是纯数据接口，可序列化。远期的声明式语法扩展只需产出相同的 Config → 传入同一个 ViewModel。

---

## 八、依赖注入

### 8.1 构造函数注入

**决策 25**：ViewModel 构造时接收服务引用。

```typescript
class BaseViewModel {
  constructor(
    protected engine: Engine,        // CRUD + QueryEngine
    protected events: EventBus,       // 全局事件总线
    protected config: ViewConfig      // 视图配置
  ) {}
}
```

---

## 九、错误展示

### 9.1 状态栏 + 内联

**决策 15**：
- **状态栏**：显示全局错误计数 `MD-DB: 3 tables, 1 error, 2 warnings`
- **查询失败**：表格区显示错误卡片 `⚠ 查询失败：表 'xxx' 未找到 [重试]`
- **单元格编辑失败**：单元格恢复原值 + 短暂红色闪烁 + tooltip
- **表单校验失败**：字段标红 + 错误提示文字

---

## 十、引擎变更

### 10.1 INSERT 策略变更

**原决策（存储引擎 §8）**：INSERT 始终末尾追加。
**新决策（视图层 §5.8）**：INSERT 改为指定行号插入。

影响范围：`Phase 9: CRUD` 实施时需要支持 `insertAt(file, lineNumber, content)`。

---

## 十一、文件结构

```
src/view/
├── parser.ts                # parseTableBlock / parseFormBlock
├── base-view-model.ts       # BaseViewModel（查询/CRUD/事件/过滤/排序/格式化）
├── table/
│   ├── table-view-model.ts  # TableViewModel extends Base
│   ├── table-view.ts        # TableView — DOM 渲染、虚拟滚动、事件绑定
│   └── table-config.ts      # TableConfig interface
├── form/
│   ├── form-view-model.ts   # FormViewModel extends Base
│   ├── form-view.ts         # FormView — DOM 渲染、字段控件映射
│   └── form-config.ts       # FormConfig interface
├── shared/
│   ├── event-bus.ts         # 全局事件总线
│   ├── data-layer.ts        # 数据层池化（缓存、事件路由）
│   ├── view-config.ts       # ViewConfig 公共类型
│   └── types.ts             # Change、ViewEvent 等公共类型
└── integration.ts           # registerViewLayer() — MarkdownPostProcessor 注册
```

---

## 十二、决策记录

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 交互模式 | BaseViewModel + 视图 ViewModel 继承 |
| 2 | 分层原则 | Base 公共层（查询/过滤/排序/CRUD/事件/格式化/分页），子类特有 |
| 3 | 事件系统 | `on(type, cb)` + `off(type, cb)`，Event/Change 用 discriminated union |
| 4 | 视图定义方式 | 声明式代码块 + 运行时配置 API，共享 Config 对象 |
| 5 | 表格声明语法 | `from` / `show` / `sort by` / `where` / `limit` |
| 6 | WHERE 条件 | 扁平 AND，逗号分隔，不支持嵌套 OR |
| 7 | 渲染方式 | `MarkdownPostProcessor` 代码块替换为 DOM |
| 8 | 编辑模式 | 行内编辑（单元格点击 → 输入框 → 失焦/Enter） |
| 9 | 保存时机 | 即时自动保存（失焦/Enter → engine.update → 文件写穿） |
| 10 | 列显示控制 | 列选择器下拉（多选） + 右键列头快捷隐藏 |
| 11 | 表单场景 | 新增弹窗 / 编辑弹窗 / 独立 `mddb-form` 声明块 |
| 12 | 表单声明语法 | `to` / `fields` / `mode` / `layout` / `keep-open` |
| 13 | 表单模式 | `new`（新增）/ `edit`（编辑）/ `view`（只读） |
| 14 | 生命周期 | 数据层全局池化（EventBus + 缓存） + UI 层随代码块创建/销毁 |
| 15 | 错误展示 | 状态栏全局计数 + 视图内联错误卡片/字段标红 tooltip |
| 16 | 表单控件 | 按 Schema 类型自动映射（string→input, enum→select, tags→tag input, ...） |
| 17 | 提交行为 | 弹窗关闭（表格触发）；独立块默认关闭，`keep-open: true` 连续录入 |
| 18 | 配置写回 | 自动写回代码块（debounce 300ms） + 脏检测跳过 |
| 19 | 客户端校验 | 全量：类型 + 必填 + 格式 + PK 唯一性 + ref 引用 |
| 20 | 新增行入口 | 工具栏"+"按钮 → 表单弹窗 + 表格底部空白行快速录入 |
| 21 | 删除/操作入口 | 行首操作按钮（⠿）→ 菜单：编辑/删除/向上插入/向下插入 |
| 22 | 排序交互 | 多列排序（默认替换，Shift+点击添加），列头显示序号 |
| 23 | 撤销机制 | 进待讨论清单（远期） |
| 24 | 写回并发冲突 | 比对上次写回缓存，不一致 → 跳过写回，仅内存生效 |
| 25 | 依赖注入 | 构造函数注入（`engine`, `events`, `config`） |
| 26 | 插入行行为 | 向上/向下插入走行内空行，工具栏"+"走表单弹窗 |
| 27 | 分页 | 滚动自动加载（无限滚动） + 虚拟滚动渲染 |
| 28 | 表单布局 | 默认单列纵向，`layout: compact` 切换双列 |
| 29 | 插入物理位置 | **引擎变更**：INSERT 改为指定行号插入 |
| 30 | 插入排序语义 | 物理位置 = 显示位置，排序由用户手动触发 |
| 31 | mode: view 多匹配 | 显示第一条 + 行切换器 |
| 32 | 解析器位置 | 独立 Parser 模块，接受 string → Config |
| 33 | View/ViewModel | 分离。ViewModel 管数据+状态，View 管 DOM+交互 |
| 34 | 文件结构 | 按职责分层：parser / base / table / form / shared / integration |
| 35 | 集成入口 | `registerViewLayer(plugin, engine)` 单函数 |

---

## 十三、待讨论清单

- 撤销机制（Ctrl+Z undo 栈）
- 列宽拖拽调整
- 多文件表视图
- 看板/日历/画廊/图表/图谱视图
- DQL 终端用户查询语法

---

## 十四、与已有设计文档的关系

| 已有文档 | 本文档关联 |
|---------|-----------|
| `query-engine-design.md` | ViewModel 消费 `QueryEngine.query()` + `ResultSet` |
| `transaction-model-design.md` | 表单提交走 `engine.transaction(cb)` 显式事务 |
| `storage-engine-design.md` §8 | §10.1 引擎变更：INSERT 改为指定行号插入 |
| `implementation-roadmap.md` Phase 17 | **本文档即为该项的完整设计** |
