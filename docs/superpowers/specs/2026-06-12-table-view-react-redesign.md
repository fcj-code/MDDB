# MD-DB 表格视图 React 重建设计

> 日期：2026-06-12（最近更新：2026-06-13）
> 状态：P1-P3 已实施，P4-P6 待开发
> 动机：现有原生 DOM 表格视图交互体验达不到 DataLoom 水平，决定走 React 路线复刻 DataLoom UI/UX

---

## 一、目标

用 React + react-virtuoso 重写 MDDB 的表格视图层，实现类 DataLoom 的交互体验：
- ✅ 虚拟滚动替代分页（万行流畅）
- ✅ 双击编辑 + 类型感知输入
- ✅ 列宽拖拽调整
- ✅ 行操作菜单 + 表单 CRUD
- ⬜ 列拖拽排序 / 列冻结 / 右键菜单
- ⬜ 行拖拽
- ⬜ 搜索/过滤/统计底栏
- ⬜ 丰富单元格类型（tag/multi-tag/file/embed）

## 二、架构

### 2.1 整体关系

```
MDDBEngine (SQLite, 不变)
    │
    ▼
TableViewModel (适配器层, 增强)
    │  - query data → 暴露给 React
    │  - CRUD 操作桥接 engine
    │  - 事件总线通知 React 刷新
    │
    ├── inline-renderer.tsx (代码块)
    │      └── React App (mount via createRoot)
    │
    └── table-view.tsx (ItemView)
           └── React App (mount via createRoot)
```

**原则：**
- 引擎层（MDDBEngine）零改动 ✅
- TableViewModel 保持，作为 React 和 engine 之间的适配器 ✅
- React 只负责渲染，所有数据操作走 TableViewModel → MDDBEngine ✅
- 现有 `mddb-form`、`FormBuilder` 等不受影响 ✅

### 2.2 分阶段计划（更新）

| 阶段 | 内容 | 状态 |
|------|------|:----:|
| **P1** 基础表格 | React 挂载 + 虚拟滚动 + 数据桥接 + 底栏 | ✅ 已实施 |
| **P2** 单元格编辑 | 双击编辑 + 按类型渲染（text/number/date/select/checkbox） | ✅ 已实施 |
| **P3a** 列宽调整 | 列宽拖拽调整（参考 DataLoom） | ✅ 已实施 |
| **P3b** 列交互 | 列拖拽排序 + 列冻结 + 右键菜单 | ⬜ 待开发 |
| **P4** 行操作 | ⠿ 操作菜单 + CRUD 表单弹窗 | ✅ 已实施 |
| **P5** 搜索/过滤 | 搜索栏 + 过滤 + 统计底栏 | ⬜ 待开发 |
| **P6** 丰富单元格 | tag/multi-tag/date/file/embed | ⬜ 待开发 |

## 三、实施详情

### 3.1 新增依赖

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-virtuoso": "^4.6.0"
  }
}
```

### 3.2 构建配置

**esbuild.config.mjs：** JSX 自动处理，react/react-dom bundled（不 external），入口 `src/main.ts` ✅
**tsconfig.json：** `"jsx": "react-jsx"` ✅

### 3.3 组件架构（当前状态）

#### `src/view/table/react/index.tsx` — App 入口
- 订阅 ViewModel 事件（`state-changed`, `edit-start/commit/cancel`, `row-deleted/inserted`）
- 管理 FormModal 打开/关闭状态
- 获取 engine + table 传递给子组件

#### `src/view/table/react/table/index.tsx` — 虚拟滚动表格（TableViewReact）
- 使用 `react-virtuoso` 的 `TableVirtuoso` 渲染表格
- 过滤 `storage_pk` 列（内部字段，不显示）
- 列宽拖拽：`handleWidthChange` / `handleResetWidth`
- ref 类型预查询：`useMemo` 加载关联表数据作为 select 选项
- ⠿ 操作列：ActionMenu（编辑/删除）
- 空状态处理

#### `src/view/table/react/table/header-cell.tsx` — 表头单元格
- 排序指示器（↑ / ↓）
- **列宽拖拽手柄**（ColumnResizeHandle）
- 双击手柄重置列宽

#### `src/view/table/react/table/body-cell.tsx` — 数据单元格（类型感知）
| 类型表达式 | 编辑控件 |
|-----------|---------|
| `string` / 默认 | `<input type="text">` |
| `integer` / `decimal` | `<input type="number">` |
| `boolean` | `<input type="checkbox">` |
| `date` | `<input type="date">` |
| `enum(高,中,低)` | `<select>` 下拉 |
| `ref(表名)` | `<select>` 下拉（engine.query 加载选项） |

#### `src/view/table/react/table/column-resize-handle.tsx` — 列宽拖拽手柄
- 参考 DataLoom `use-column-resize.ts` 实现
- mousedown → mousemove → mouseup 跟踪位移
- 5px 宽，`cursor: col-resize`，hover/active 变蓝（`--interactive-accent`）

#### 其他组件
- `action-menu.tsx` — ⠿ 操作菜单（编辑/删除）
- `bottom-bar.tsx` — 行数统计 + `+New Row` 按钮
- `form-modal.tsx` — 新增/编辑表单弹窗（使用 FormBuilder）

### 3.4 ViewModel 增强

| 方法 | 用途 |
|------|------|
| `getSnapshot(): TableSnapshot` | React 数据桥接 |
| `startEdit / commitEdit / cancelEdit` | 行内编辑 |
| `deleteRow / insertRow` | CRUD |
| `setColumnWidth / resetColumnWidth` | 列宽调整 |
| `toggleSort` | 排序（已有） |

### 3.5 Hash 冲突处理

CRUD 操作使用 `WriteOptions.force` 跳过 hash 校验：

```typescript
// engine.update / delete 传入 { force: true }
await this.engine.update(storagePk, { [col]: newValue }, { force: true });
await this.engine.delete(storagePk, { force: true });
```

`force` 模式下，`crud-executor.ts` 使用 `findLineByPkInContent()` 重新定位行号（搜索文件内容中的 storage_pk）而非使用 stale binding。

---

## 四、文件结构变化（当前状态）

```
src/view/table/
├── table-view-model.ts          # ★ 增强：getSnapshot / 编辑 / CRUD / 列宽
├── table-view-model.test.ts     # 不变
├── table-view.tsx               # ★ 修改：挂载 React（.tsx）
├── inline-renderer.tsx          # ★ 修改：挂载 React（.tsx）
├── table-config.ts              # 不变
├── react/                       # ★ 新增
│   ├── index.tsx                #    App 入口（事件订阅 + form modal）
│   ├── action-menu.tsx          #    ⠿ 操作菜单
│   ├── bottom-bar.tsx           #    底栏
│   ├── form-modal.tsx           #    表单弹窗
│   └── table/
│       ├── index.tsx            #    虚拟滚动表格（含 ref 预查询）
│       ├── header-cell.tsx      #    表头（排序 + 列宽拖拽）
│       ├── body-cell.tsx        #    类型感知编辑单元格
│       ├── column-resize-handle.tsx  # ★ 列宽拖拽手柄
│       └── styles.css           #    样式
└── styles.css                   # ★ 修改：整合 React 样式

src/core/types.ts                # ★ 增强：WriteOptions.force
src/write/crud-executor.ts       # ★ 增强：force 模式 + findLineByPkInContent
src/engine/engine.ts             # ★ 增强：update/delete 传递 options
```

## 五、成功标准

1. ✅ `npm run build` 通过（esbuild + tsc noEmit）
2. ✅ 表格数据通过 react-virtuoso 虚拟滚动渲染
3. ✅ 排序功能正常（TableViewModel.toggleSort）
4. ✅ 双击编辑可用（类型感知控件）
5. ✅ CRUD（⠿ 菜单编辑/删除 + +New Row 表单弹窗）
6. ✅ 列宽拖拽调整（5px 手柄）
7. ✅ ref 类型 inline 编辑（select 下拉加载关联表）
8. ✅ 321 测试通过（vitest）
9. ✅ 无 React 运行时错误
