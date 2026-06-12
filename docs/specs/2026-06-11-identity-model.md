# MD-DB 身份模型 v2

> 日期：2026-06-11  
> 状态：✅ 已冻结 — Milestone 0 架构基线  
> 用途：统一 BindingRow、storagePk、blockId、SchemaRegistry 的身份与关系模型，为所有后续模块提供可引用的身份契约  
> 替代：`2026-06-10-storage-engine-design.md` §2（分层主键系统）与 §3（绑定表）的身份部分

---

## 一、核心原则

### 1.1 lineNumber 不再是记录身份

v1 的 `storage_pk = relativePath:lineNumber:hash6` 存在以下问题：

1. 行号会因上方插入/删除而漂移。
2. `storage_pk` 被承诺不可变，但嵌入的 `lineNumber` 天然可变。
3. 6 位 hash 碰撞概率随数据量增长不可忽略。

v2 原则：

```text
storage_pk = stable row identity，不依赖文件物理位置。
line_number = mutable locator，只用于定位与优化，不参与身份语义。
```

### 1.2 Markdown 是事实源，SQLite 是派生索引

```text
Markdown Vault = source of truth
SQLite cache   = derived index / query cache
WAL            = pending file mutation journal

BindingRow 是连接 Markdown 与 SQLite 的桥梁，不独立存储业务数据。
```

---

## 二、BindingRow v2

### 2.1 定义

```typescript
interface BindingRow {
  // === 记录身份（创建后不变） ===
  storagePk: string;             // 稳定记录 ID，见表 2.2
  logicalPk: string;             // 由 @pk 字段值拼接生成

  // === 表归属 ===
  tableName: string;             // 所属表名

  // === 文件位置（可变的定位信息） ===
  filePath: string;              // 相对 Vault 路径
  blockId: string;               // 所属 mddb 块的稳定标识
  blockIndex: number;            // 块内序号（文件内多块场景）
  lineNumber: number;            // 当前物理行号

  // === 一致性校验 ===
  rowHash: string;               // 当前行内容 SHA256 hex（至少 128-bit 截断）
  rawLineHash: string;           // 原始行字符串 hash，用于外部编辑识别
  lastVerified: string;          // ISO 8601 最后验证时间

  // === 写入状态（仅写路径使用） ===
  syncState: "synced" | "pending" | "retrying" | "dead";
}
```

### 2.2 storagePk 生成策略

优先级：

| 条件 | 策略 | 格式 |
|---|---:|---|
| logicalPk 存在且稳定（非 UUID） | `SHA256(tableName + ":" + logicalPk)[:16]` | `a3f7b29c1e5d8a04` |
| logicalPk 使用 `$uuid` 或缺失 | 首次发现时生成 UUID v4 | `c8a7b3f4-1e5d-4f3b-a8c7-d9e0f1a2b3c4` |
| logicalPk 列值中包含 NULL | 该记录无 logicalPk，生成 UUID | 同上 |

硬性规则：

```text
1. storagePk 创建后不可变，不随 lineNumber 漂移。
2. storagePk 不嵌入 filePath 或 lineNumber。
3. B 形式文件内不显式存储 storagePk。
```

### 2.3 logicalPk 策略

由 Schema 的 `@pk` 声明控制：

| 策略 | Schema 定义 | logicalPk 格式 |
|---|---:|---|
| 单列 | `@pk name` | `值` |
| 复合 | `@pk (日期, 金额, 商户)` | `值1\x1F值2\x1F值3` |
| 自动 UUID | `@pk $uuid` | `c8a7b3f4-...` |

引擎强制同一表内 `logicalPk` 唯一。

### 2.4 blockId 策略

blockId 用于识别记录所属的 ` ```mddb ` 代码块，在单文件多表或多块同表场景中必须稳定。

MVP 非侵入式 blockId（不修改 Markdown 原文）：

```text
blockId = SHA256(filePath + blockStartLine + schemaTableName).slice(0, 16)
```

后续如需更强稳定性，支持显式块 ID：

```markdown
```mddb block=accounts-main
@table accounts
...
```
```

MVP 中 `blockId` 仅供内部校验与定位，不暴露给用户。

---

## 三、Binding 数据库

### 3.1 _binding 表

```sql
CREATE TABLE _binding (
  storage_pk   TEXT PRIMARY KEY,
  logical_pk   TEXT NOT NULL,
  table_name   TEXT NOT NULL,

  file_path    TEXT NOT NULL,
  block_id     TEXT NOT NULL,
  block_index  INTEGER NOT NULL DEFAULT 0,
  line_number  INTEGER NOT NULL,

  row_hash     TEXT NOT NULL,
  raw_line_hash TEXT,
  last_verified TEXT NOT NULL,

  sync_state   TEXT NOT NULL DEFAULT 'synced'
);

CREATE UNIQUE INDEX idx_binding_logical ON _binding(table_name, logical_pk);
CREATE INDEX idx_binding_file ON _binding(file_path, line_number);
CREATE INDEX idx_binding_table ON _binding(table_name);
CREATE INDEX idx_binding_sync ON _binding(sync_state) WHERE sync_state != 'synced';
```

### 3.2 变更说明

与 v1 相比的关键变更：

| 字段 | v1 | v2 | 原因 |
|---|---:|---:|---|
| `storage_pk` | `path:line:hash6` | 固定 hash 或 UUID | 稳定性 |
| `logical_pk` | 无全局唯一索引 | `UNIQUE(table_name, logical_pk)` | 逻辑 PK 正确定义 |
| `block_id` | 无 | 新增 | 多块 / 多文件表预留 |
| `block_index` | 无 | 新增 | 块内排序 |
| `raw_line_hash` | 无 | 新增 | 外部编辑 diff 优化 |
| `sync_state` | 无 | 新增 | WAL 可见性管理 |
| `table_name` | 无索引 | 已加索引 | 多表查询优化 |
| `sync_state` 索引 | 无 | 条件索引 | 死信快速查找 |

---

## 四、SchemaRegistry v2

### 4.1 结构

v1 的 `table -> file` 模型会阻碍多文件表。v2 改为 `table -> sources[]`，允许一张表由多个文件贡献。

```typescript
interface SchemaRegistry {
  version: 2;
  tables: Record<string, TableRegistryEntry>;
}

interface TableRegistryEntry {
  table: string;
  schema: SchemaSummary;
  sources: TableSource[];          // 该表来源文件列表
  rowCount: number;                // 快照时的总行数
  updatedAt: string;               // ISO 8601
}

interface TableSource {
  file: string;                    // 文件相对路径
  blockId: string;                 // 代码块 ID
  blockIndex: number;              // 块序号
  rowCount: number;                // 该 source 的行数
  partition?: Record<string, string>; // 分区键（M5+ 使用）
}

interface SchemaSummary {
  pk: string[];
  fields: string[];
  types: string[];
  required: boolean[];
  sort?: string;
  indexes?: string[];
  relations?: Array<{
    field: string;
    targetTable: string;
    targetField: string;
  }>;
  nullMarker: string;
  strict: boolean;
}
```

### 4.2 store 格式

```text
.obsidian/plugins/md-db/cache/schema_registry.json
```

内容为 `SchemaRegistry` 的 JSON 序列化。

### 4.3 删除文件行为

删除文件时不得默认 `DROP TABLE`。

```text
1. 从 _binding 删除 file_path = ? 的全部记录。
2. 从用户表删除属于该 file_path / block_id 的记录。
3. 从 schema_registry.tables[table].sources 移除该 source。
4. 如果 table.sources 为空，DROP TABLE。
5. 更新 rowCount 与 file_hashes。
```

### 4.4 Schema 冲突检测

当同一个 `@table` 名在不同文件中出现不同的 Schema 定义时：

| 差异类型 | 行为 |
|---|---:|
| `@pk` 不同 | 报错，拒绝加载 |
| `@fields` 列名或顺序不同 | 报错，拒绝加载 |
| `@types` 不同 | 报错，拒绝加载 |
| `@required` 不同 | 宽松合并（任一 source 为 true 则 true） |
| `@sort` / `@indexes` / `@null_marker` / `@strict` 不同 | 互不影响，各 block 各自生效 |

优先来源决定 Schema 权威值：

```text
第一次发现该表的文件中的 Schema 为主定义。
后续文件中的 Schema 必须与主定义完全匹配（@fields / @types / @pk）。
```

---

## 五、多文件表预留

### 5.1 logicalPk 唯一性

默认单表全局唯一：

```text
UNIQUE(table_name, logical_pk)
```

未来多文件表如需分区内唯一，扩展为：

```text
UNIQUE(table_name, partition_key, logical_pk)
```

### 5.2 source 级操作

- INSERT：默认追加到该表某个活跃 source 末尾（实现细节由 M5 设计）。
- 删除文件：只移除该文件的 source，表保留。
- 查询：跨所有 source 查询，对 QueryEngine 透明。

### 5.3 分区语法预留

```markdown
<!--
@table transactions
@partition year=2026 month=06
-->
```

或 YAML：

```yaml
mddb:
  table: transactions
  partition:
    year: 2026
    month: 06
```

MVP 不实现分区裁剪，但 SchemaRegistry 结构已预留 `sources[].partition`。

---

## 六、对 v1 设计文档的替代范围

本文档正式替代以下 v1 设计中的对应部分：

| v1 文档 | 节号 | 替代程度 |
|---|---:|---:|
| `storage-engine-design.md` | §2（分层主键） | 完全替代 |
| `storage-engine-design.md` | §3（绑定表） | 完全替代 |
| `storage-engine-design.md` | §9.1.1（空值占位符） | 不影响（保留） |
| `storage-engine-design.md` | §4.2（DELETE 后续行上移） | 不影响（保留） |
| `parse-pipeline-design.md` | §5.4（PK 唯一性） | 逻辑继承，索引调整为 `(table_name, logical_pk)` |
| `transaction-model-design.md` | — | `syncState` 补充写入可见性 |

其余 v1 设计文档中涉及 `storage_pk`、`_binding`、`logical_pk` 的引用，均应以本文档为准。
