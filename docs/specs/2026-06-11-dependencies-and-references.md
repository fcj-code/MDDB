# MD-DB 依赖项与参考项目分析

> 日期：2026-06-11
> 用途：明确项目技术栈、依赖清单、可复用的 Obsidian API、参考项目的借鉴点

---

## 一、运行时依赖

| 依赖 | 版本 | 大小 | 用途 |
|------|------|------|------|
| `sql.js` | `^1.10` | ~50KB gzip | SQLite WASM 引擎，管理 `_binding` 和用户表。无原生依赖，纯 WebAssembly |
| `obsidian` | `^1.4.0` | — | Obsidian 插件 API 类型定义（`devDependency`，构建时 external） |

> **不需要额外安装的**：SHA256 → Web Crypto API 内置 `crypto.subtle.digest('SHA-256', ...)`；YAML → 手动正则或 `app.metadataCache`；UUID → `crypto.randomUUID()`；文件操作 → Obsidian Vault API。

## 二、构建依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `typescript` | `^5.4` | 编译 |
| `esbuild` | `^0.20` | 打包（Obsidian 社区主流方案，比 Rollup 更快更简单） |
| `@types/node` | `^20` | Node.js 类型 |

> `obsidian` 和 `sql.js` 设为 `esbuild` external。

**`package.json`**：

```json
{
  "name": "obsidian-md-db",
  "id": "md-db",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "scripts": {
    "dev": "esbuild src/main.ts --bundle --external:obsidian --external:sql.js --outfile=main.js --watch",
    "build": "esbuild src/main.ts --bundle --external:obsidian --external:sql.js --outfile=main.js --minify",
    "test": "vitest"
  },
  "dependencies": {
    "sql.js": "^1.10.3"
  },
  "devDependencies": {
    "obsidian": "^1.4.0",
    "typescript": "^5.4.0",
    "esbuild": "^0.20.0",
    "@types/node": "^20.0.0",
    "vitest": "^1.6.0"
  }
}
```

**`manifest.json`**：

```json
{
  "id": "md-db",
  "name": "MD-DB",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Markdown 数据库引擎 — 结构化查询与编辑 .md 文件",
  "isDesktopOnly": false
}
```

---

## 三、Obsidian 官方 API（直接使用清单）

### 3.1 Vault — 文件操作

```typescript
app.vault.getMarkdownFiles(): TFile[]                   // 全量文件扫描
app.vault.getFileByPath(path): TFile | null             // 按路径取文件
app.vault.read(file): Promise<string>                   // 从磁盘读
app.vault.cachedRead(file): Promise<string>             // 缓存读（显示用）
app.vault.create(path, data): Promise<TFile>            // 创建文件
app.vault.delete(file): Promise<void>                   // 删除文件
app.vault.rename(file, newPath): Promise<void>          // 重命名
app.vault.modify(file, data): Promise<void>             // 全量覆盖写
```

### 3.2 Vault — 原子读-改-写（★ 事务核心 API）

```typescript
// 回调期间 Obsidian 保证文件不被其他写入修改
// → MD-DB 单文件事务的手术式行编辑完全依赖此 API
app.vault.process(
  file: TFile,
  fn: (content: string) => string    // 只改数据行，不动自由文本
): Promise<string>
```

### 3.3 文件事件（★ 监视器）

```typescript
app.vault.on('create', (file: TFile) => void)
app.vault.on('modify', (file: TFile) => void)
app.vault.on('delete', (file: TFile) => void)
app.vault.on('rename', (file: TFile, oldPath: string) => void)
```

### 3.4 元数据

```typescript
app.metadataCache.getFileCache(file): CachedMetadata | null
app.metadataCache.on('resolve', (file: TFile) => void)
```

### 3.5 Plugin 注册点

```typescript
this.registerMarkdownCodeBlockProcessor('mddb-table', (source, el, ctx) => {});
this.registerMarkdownCodeBlockProcessor('mddb-form',  (source, el, ctx) => {});
this.addCommand({ id, name, callback });
this.addSettingTab(new MDDBSettingTab(this.app, this));
this.addStatusBarItem().setText('MD-DB: ...');
this.addRibbonIcon('database', 'MD-DB', () => {});
```

### 3.6 数据持久化

```typescript
this.loadData(): Promise<any>     // file_hashes.json / schema_registry.json
this.saveData(data): Promise<void>
```

### 3.7 用户通知

```typescript
new Notice('message')
this.app.workspace.onLayoutReady(() => {})
```

---

## 四、参考项目

### 4.1 Dataview（`blacksmithgu/obsidian-dataview`）

| 维度 | 内容 |
|------|------|
| **相似度** | ★★★★（最高，同为 Markdown 索引-查询-渲染流水线） |
| **代码规模** | TypeScript，`src/` 约 50 文件 |

**架构流水线**：`Markdown Files → FullIndex → DQL/DataviewJS → Query Engine → Expression Evaluator → View Components → DOM`

**≡ MD-DB 借鉴**：

| Dataview 模块 | MD-DB 对应 |
|--------------|-----------|
| `FullIndex` — 全量文件索引 | 解析管道 Phase 3-8 |
| `DataviewApi` — 公开 API | `QueryEngine.query()` |
| `expression/` — 表达式引擎 | `FilterGroup` + 11 操作符 |
| `MarkdownPostProcessor` — 块渲染 | `mddb-table`/`mddb-form` 处理器 |
| 函数库 | `@types` 类型转换器 |

---

### 4.2 Modal Form（`danielo515/obsidian-modal-form`）

| 维度 | 内容 |
|------|------|
| **相似度** | ★★★（表单模块高度相关） |
| **UI 框架** | Svelte（轻量） |
| **代码规模** | TypeScript + Svelte，`src/` 约 15 文件 |

**表单字段模型**：`{ name, label, description, input: { type }, required }`，支持 text / number / date / time / slider / toggle / select / multi-select / note / dataview 等类型。

**≡ MD-DB 借鉴**：

| Modal Form 特性 | MD-DB 对应 |
|----------------|-----------|
| 字段定义 JSON Schema | `@fields` / `@types` DSL |
| 类型 → UI 控件自动映射 | `mddb-form` 控件选择 |
| autocomplete（Dataview 查询） | `ref(table)` 下拉选择器 |
| `FormResult.asFrontmatterString()` | 序列化为 B 形式行 |
| `openForm(name, { values })` | `mode=edit` 预填值 |

---

### 4.3 DataLoom（`aykutkardas/obsidian-dataloom`）

| 维度 | 内容 |
|------|------|
| **相似度** | ★★★（表格交互高度相关，数据层无关） |
| **UI 框架** | React + Redux（重） |
| **代码规模** | TypeScript + React，`src/` 约 100 文件 |

**⚠️ 核心差异**：DataLoom 用自定义 `.loom` JSON 文件存储，不是 Markdown。数据层不相关。

**≡ MD-DB 借鉴**：

| DataLoom 模块 | MD-DB 对应 |
|-------------|-----------|
| `shared/loom-state/` — 表格状态 | `BaseViewModel` |
| `shared/filter/` — 过滤系统 | `FilterGroup` + `where` |
| `shared/sort-utils.ts` — 排序 | `@sort` + 多列排序 |
| `shared/frontmatter/` — YAML | Phase 3 frontmatter 来源 |
| Cell type 系统（12 种） | 12 种 FieldType 映射参考 |

---

### 4.4 SQLite DB Viewer（`bakanovskii/obsidian-sqlite-db-viewer`）

| 维度 | 内容 |
|------|------|
| **相似度** | ★★（sql.js 集成范本） |
| **核心价值** | sql.js WASM 文件加载路径管理、代码块查询（` ```sqlite-query ``` `）、行编辑 |

---

### 4.5 Obsidian Sample Plugin（`obsidianmd/obsidian-sample-plugin`）

| 维度 | 内容 |
|------|------|
| **相似度** | ★（项目脚手架） |
| **核心价值** | 官方插件模板，manifest.json 规范、esbuild 配置 |

---

## 五、参考价值矩阵

```
                    Dataview    ModalForm   DataLoom    SQLite Viewer   SamplePlugin
                    ════════   ═════════   ════════    ════════════   ═══════════
索引 Markdown 文件     ★★★        —           ★★          —              —
查询引擎              ★★★        —           —           ★★             —
解析管道              ★★         —           ★★          —              —
表单字段 Schema        —          ★★★         —           —              —
表单 UI               —          ★★★         —           —              —
表格渲染              ★          —           ★★★         —              —
过滤/排序 UI          —          —           ★★★         —              —
sql.js 集成           —          —           —           ★★★            —
项目脚手架             —          —           —           —              ★★★
```
