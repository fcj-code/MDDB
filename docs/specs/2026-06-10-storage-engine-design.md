# MD-DB 存储引擎设计文档 v1.0

> 日期：2026-06-10
> 状态：草案 — 已完成存储引擎底层架构设计
> 范围：B 形式（行即记录）作为存储引擎内核统一抽象

---

## 一、设计概述

### 1.1 核心定位

MD-DB 是一个运行在 Obsidian 插件环境中的 Markdown 数据库引擎。存储引擎层负责将 Markdown 文件中的结构化数据解析为可查询的内存数据库，并提供完整的 CRUD、事务、崩溃恢复能力。

### 1.2 统一抽象：B 形式（行即记录）

引擎内核以 **B 形式** 作为统一抽象：

- 一个 `.md` 文件 = 一张表
- 文件中每一行 = 一条记录
- 字段用 `|` 分隔
- 表 Schema 定义在文件头部 HTML 注释块中
- 文件物理顺序 = 写入时序（乱序不管，查询时视图层排序）

### 1.3 架构概览

```
┌────────────────────────────────────────────────┐
│                 Obsidian 插件进程                 │
├────────────┬───────────────┬───────────────────┤
│ 视图层      │ 查询引擎       │ 存储引擎           │
│ (表格/看板) │ (SQL/DQL)     │ (本设计文档范围)     │
│            │               │                   │
│            │               │ ┌─ 解析管道         │
│            │               │ ├─ 绑定表           │
│            │               │ ├─ WAL 日志         │
│            │               │ ├─ 内存 SQLite      │
│            │               │ └─ 重扫调度          │
└────────────┴───────────────┴───────────────────┘
          ↕ Vault API
┌────────────────────────────────────────────────┐
│              Vault（.md 文件）                     │
└────────────────────────────────────────────────┘
```

---

## 二、分层主键系统

### 2.1 三层主键定义

| 层次 | 名称 | 格式 | 作用域 | 创建后是否可变 |
|------|------|------|--------|:---:|
| 第一层 | **存储主键** (Storage PK) | `file_path:line:hash6` | 引擎内部 | **否** |
| 第二层 | **逻辑主键** (Logical PK) | `@pk` 标记列的值 | 查询/关联/外键 | 否 |
| 第三层 | **显示主键** (Display PK) | 视图模板动态生成 | 用户界面 | — |

### 2.2 存储主键

```
格式: {相对文件路径}:{创建时行号}:{内容哈希前6位}
示例: finance/transactions/2024-06.md:8:a3f7b2
```

**关键规则**：
- 存储主键**创建后不可变**——即使行号漂移、内容修改，存储 PK 值本身不更新
- `line_number` 和 `hash` 尽管可变，但只在绑定表中更新，不更新存储 PK
- 存储 PK 是记录的「出生证明」，不是「当前住址」
- 外键引用统一存存储 PK，行号漂移不会导致外键断裂

### 2.3 逻辑主键

在 Schema 中用 `@pk` 标记。三种策略：

| 策略 | Schema 定义 | 示例 | 适用 |
|------|------------|------|------|
| 业务单列 | `@pk name` | `zhangsan` | 天然唯一字段 |
| 业务复合 | `@pk (日期, 金额, 商户)` | `2024-06-01:-45.00:兰州拉面` | 组合唯一 |
| 自动 UUID | `@pk $uuid` | `c8a7-4f3b-...` | 用户不想维护 ID |

引擎强制校验逻辑主键的唯一性约束。

### 2.4 显示主键

不存储在文件中，由视图模板动态生成。

```yaml
display_pk:
  template: "{日期}-{分类}-{金额}元"
  # 渲染: 2024-06-01-餐饮-45.00元
```

### 2.5 `@sort` 排序键

- 与 `@pk` 解耦，独立声明
- 仅用于：查询时的默认 ORDER BY
- 不影响文件物理布局
- 示例：`@sort (日期 ASC, 金额 DESC)`

---

## 三、绑定表（Binding Table）

### 3.1 设计

绑定表是串起三层主键的核心数据结构，运行在内存 SQLite 中。

```sql
CREATE TABLE _binding (
  storage_pk    TEXT PRIMARY KEY,
  logical_pk    TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  line_number   INTEGER NOT NULL,
  row_hash      TEXT NOT NULL,
  last_verified TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_binding_logical ON _binding(logical_pk);
CREATE INDEX idx_binding_file ON _binding(file_path, line_number);
```

### 3.2 字段说明

| 字段 | 说明 | 变化频率 |
|------|------|:---:|
| `storage_pk` | 存储主键，创建后不变 | 不变 |
| `logical_pk` | 逻辑主键值，用于查询和关联 | 不变 |
| `file_path` | 当前文件路径 | 低（重命名） |
| `line_number` | 当前行号 | **高**（上方插入/删除导致漂移） |
| `row_hash` | 当前行内容 SHA256 前 16 位 | 中（内容修改） |
| `last_verified` | 上次哈希验证时间 | 高 |

### 3.3 行号漂移维护

当上方发生物理删除时，受影响的行批量更新行号：

```sql
-- 删除第 5 行后，行 6..N 全部上移
UPDATE _binding
SET line_number = line_number - 1
WHERE file_path = ? AND line_number > 5;
```

同时触发全量重扫以验证一致性（见第六章）。

---

## 四、CRUD 操作定义

### 4.1 INSERT（插入）

- **位置**：始终追加到文件末尾
- **流程**：
  1. 生成存储 PK（当前文件路径 + 末尾行号 + 内容哈希）
  2. 提取逻辑主键值（从 `@pk` 列）
  3. 追加行到 `.md` 文件末尾（通过 Vault API）
  4. 插入绑定表条目
  5. 更新内存 SQLite 索引

### 4.2 DELETE（删除）

- **策略**：物理删除，后续行自动上移
- **流程**：
  1. 通过存储 PK 定位当前 `file_path` 和 `line_number`
  2. 删除 `.md` 文件中的对应行（通过 Vault API）
  3. 删除绑定表中对应条目
  4. 批量更新该文件所有 `line_number > 被删行号` 的绑定表条目（line_number - 1）

### 4.3 UPDATE（更新）

- **策略**：原地替换行内容
- **流程**：
  1. 通过存储 PK 定位当前 `file_path` 和 `line_number`
  2. 读目标行，计算哈希，对比绑定表 `row_hash`
  3. 哈希一致 → 替换行内容 → 更新绑定表 `row_hash`
  4. 哈希不一致 → 触发外部修改冲突处理（第六章）

### 4.4 SELECT（查询）

- **策略**：全部在内存 SQLite 中完成，不读文件
- 排序：按 `@sort` 声明（若存在），否则按写入时序
- 分页、过滤、聚合全部下推到 SQLite

---

## 五、写入路径

### 5.1 即时写穿（Write-Through）

所有写操作立即通过 Obsidian Vault API 写入 `.md` 文件：

```
用户编辑 → 更新内存 SQLite → 立即调用 app.vault.modify() 写文件
```

### 5.2 Vault API 代理写入

所有文件写入统一走 Obsidian 的 `app.vault` API：

- `app.vault.modify(file, newContent)` — 替换整个文件内容
- `app.vault.process(file, (content) => modifiedContent)` — 原子读写

**优势**：
- Obsidian 编辑器自动刷新，无需处理外部编辑冲突
- Vault API 内部处理并发和缓存一致性
- 引擎作为 Obsidian 插件原生集成，无需文件锁

### 5.3 写入失败处理：乐观写 + WAL 补偿

```
保存流程:
  1. 更新内存 SQLite → UI 立即响应
  2. 调用 app.vault.modify() 写文件
  3. 成功 → 结束
  4. 失败 → 操作写入 WAL 重试队列 → 后台重试
  5. 重试 10 次仍失败 → 标记 dead → 通知用户
```

**WAL 重试队列**：

```sql
CREATE TABLE _wal_retry (
  id           TEXT PRIMARY KEY,
  storage_pk   TEXT NOT NULL,
  operation    TEXT NOT NULL,     -- INSERT | UPDATE | DELETE
  payload      TEXT NOT NULL,     -- JSON 格式的行内容
  target_file  TEXT NOT NULL,
  retry_count  INTEGER DEFAULT 0,
  max_retries  INTEGER DEFAULT 10,
  last_error   TEXT,
  created_at   TEXT NOT NULL
);
```

**重试策略**：指数退避 1s → 2s → 4s → 8s → 16s → 30s → 60s → 120s → 300s → 600s，最多 10 次。

**死信处理**：
- 全部重试失败 → 标记为 dead
- 状态栏显示 "N 条未同步"
- 用户可手动触发重试
- Obsidian 重启 → 加载持久化 WAL → 重新入队

---

## 六、重扫与一致性保障

### 6.1 三层触发策略

```
┌──────────────┬──────────────┬─────────────────────┐
│ 层次          │ 触发条件      │ 扫描粒度              │
├──────────────┼──────────────┼─────────────────────┤
│ 第一层: 自改   │ 引擎自己的写   │ O(1) 精确行号更新      │
│ 第二层: 事件   │ vault modify  │ diff → 少变更增量     │
│              │ 事件触发      │ → 多变更(>20%)降级全量  │
│ 第三层: 写前   │ 引擎写入前     │ 单行哈希比对           │
│              │              │ → 不匹配触发第二层       │
├──────────────┼──────────────┼─────────────────────┤
│ 兜底: 空闲    │ Obsidian 空闲 │ 全量，节流限制          │
│              │ >5分钟+ >1h  │ 单次最多 10 文件        │
└──────────────┴──────────────┴─────────────────────┘
```

### 6.2 第一层：自改增量

引擎通过 Vault API 写入时精确知道影响范围：

```
INSERT 末尾追加:
  → 插入 binding 新条目
  → 其他行号不变 → 无需更新

DELETE 第 5 行:
  → 删除 binding 对应条目
  → 行 6..N line_number -= 1 (批量 UPDATE)

UPDATE 第 5 行:
  → 更新 row_hash
  → 存储 PK 不变 → 外键不断
```

### 6.3 第二层：事件触发 diff

`vault.on('modify')` 触发时：
1. 取出该文件上次缓存内容
2. 逐行 diff 新旧内容
3. 变化行数 ≤ 20% → 增量更新
4. 变化行数 > 20% → 降级全量重扫

### 6.4 第三层：写前哈希验证

```
写入前:
  1. 读目标行当前内容
  2. 计算哈希 vs binding.row_hash
  3. 一致 → 安全写入
  4. 不一致 → 触发第二层 diff → 再写入
```

### 6.5 兜底：空闲全量

- 触发条件：Obsidian 空闲 > 5 分钟 + 距上次全量 > 1 小时
- 节流：单次最多扫描 10 个文件
- 逐个文件全量重扫，更新绑定表和文件哈希缓存

---

## 七、WAL（预写日志）

### 7.1 设计

- **粒度**：行级 WAL
- **存储位置**：`.obsidian/plugins/md-db/wal/`
- **职责**：崩溃恢复 + 写入失败补偿重试

### 7.2 条目格式

```
INSERT | transactions/2024-06.md | 2024-06-05|-56.00|支出|医疗|支付宝|叮当快药|感冒灵
DELETE | transactions/2024-06.md | storage_pk=transactions/2024-06.md:9:a3f7b2
UPDATE | transactions/2024-06.md | storage_pk=... | new_content=...
```

### 7.3 生命周期

```
写入成功: WAL 条目立即删除
写入失败: WAL 条目进入重试队列，重试成功后删除
崩溃恢复: 启动时重放所有未完成的 WAL 条目
```

---

## 八、冷启动流程

### 8.1 策略：缓存优先 + WAL 重放 + 后台验证

```
阶段 1: 阻塞启动（< 100ms，必须完成）
├── 加载序列化缓存（绑定表 + 索引 SQLite 文件）
├── 重放 WAL 队列中所有未完成条目
└── 引擎标记为就绪 → UI 可用

阶段 2: 后台验证（不阻塞用户）
├── Obsidian 空闲时逐个比对文件内容哈希
├── 哈希不匹配 → 重新解析该文件
├── 哈希匹配 → 跳过
└── 发现差异 → 静默修复绑定表

缓存损坏/不存在 → 降级全量重建
```

### 8.2 缓存结构

```
.obsidian/plugins/md-db/cache/
├── binding.db          # 绑定表 + 索引（SQLite）
├── file_hashes.json    # { "文件相对路径": "sha256hex" }
└── schema_registry.json # 所有 @table 文件的 Schema 摘要
```

### 8.3 缓存失效条件

- `file_hashes.json` 中哈希 ≠ 文件实际 SHA256
- Schema 定义变更（`@fields` 列增减）
- 缓存文件版本不兼容（插件升级）

---

## 九、数据格式规格

### 9.1 B 形式文件格式

```markdown
<!--
@table transactions
@pk (日期, 金额, 商户)
@sort (日期 ASC)
@fields 日期 | 金额 | 类型 | 分类 | 账户 | 商户 | 备注
@types  date | decimal(2) | enum(支出,收入) | string | ref(accounts) | string | text
@required true | true | true | true | true | true | false
@indexes idx(分类) | idx(账户) | idx(金额)
-->

2024-06-01 | -45.00 | 支出 | 餐饮 | 现金 | 兰州拉面 | 加了一份牛肉
2024-06-01 | -16.50 | 支出 | 交通 | 支付宝 | 北京地铁 | -
2024-06-02 | -128.00 | 支出 | 餐饮 | 微信 | 海底捞 | 请李四吃饭
```

### 9.1.1 空值占位符

- **默认占位符**：`-`（单连字符）
- **语义**：该字段值为空（NULL）
- **解析行为**：引擎解析时将 `-` 映射为 SQL NULL
- **写入行为**：当字段值为 NULL 时，序列化为 `-`

| 原始行 | 解析后 |
|--------|--------|
| `2024-06-01 \| - \| 支出 \| ...` | 金额字段 = NULL |
| `2024-06-01 \| -16.50 \| - \| ...` | 分类字段 = NULL |

**后期扩展**：支持在 Schema 注释中自定义占位符：

```markdown
<!--
@null_marker: N/A
-->
```

允许用户根据数据类型习惯自定义（如 `N/A`、`--`、`null` 等）。引擎默认 `-`。```

### 9.2 Schema 指令参考

| 指令 | 必需 | 说明 | 示例 |
|------|:---:|------|------|
| `@table` | ✅ | 表名 | `@table transactions` |
| `@pk` | ✅ | 逻辑主键定义 | `@pk (日期, 金额)` 或 `@pk $uuid` |
| `@fields` | ✅ | 字段名列表（`\|` 分隔） | `@fields 日期 \| 金额 \| 分类` |
| `@types` | ✅ | 字段类型列表（`\|` 分隔） | `@types date \| decimal(2) \| string` |
| `@required` | 否 | 必填标记 | `@required true \| true \| false` |
| `@sort` | 否 | 默认排序键 | `@sort (日期 ASC)` |
| `@indexes` | 否 | 建议索引 | `@indexes idx(分类) \| idx(金额)` |
| `@relations` | 否 | 外键关系 | `@relations 联系人 -> contacts.md:name` |

### 9.3 支持的基础类型

| 类型 | 说明 | 存储格式 |
|------|------|----------|
| `string` | 字符串 | 原样 |
| `integer` | 整数 | `42` |
| `decimal(N)` | 定点小数 | `45.00` |
| `boolean` | 布尔 | `true` / `false` |
| `date` | 日期 | `YYYY-MM-DD` |
| `datetime` | 日期时间 | `YYYY-MM-DD HH:MM:SS` |
| `enum(v1,v2,...)` | 枚举 | `支出` / `收入` |
| `text` | 长文本（可含空格/标点） | 支持任意字符 |
| `tags` | 标签数组 | `#tag1 #tag2` |
| `ref(table)` | 外键引用 | 逻辑主键值 |
| `phone` | 手机号格式 | `138xxxx1234` |
| `email` | 邮箱格式 | `user@example.com` |

---

## 十、决策记录

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 引擎内核统一抽象 | B 形式（行即记录） |
| 2 | 主键体系 | 三层：存储 PK / 逻辑 PK / 显示 PK |
| 3 | 存储 PK 可变性 | 创建后不可变 |
| 4 | 行号漂移维护 | 全量重扫更新绑定表 |
| 5 | 删除策略 | 物理删除，后续行上移 |
| 6 | 排序键 | `@sort` 与 `@pk` 解耦，仅管查询排序 |
| 7 | 写入路径 | 即时写穿（Write-Through） |
| 8 | 插入位置 | 始终末尾追加 |
| 9 | 冲突解决 | 统一走 Obsidian Vault API 代理写 |
| 10 | 写入失败 | 乐观写 + WAL 补偿重试 |
| 11 | compact | 不提供，物理顺序不管，查询时排序 |
| 12 | 重扫策略 | 三层触发 + 粒度自适应 |
| 13 | WAL 粒度 | 行级 |
| 14 | WAL 存储 | `.obsidian/plugins/md-db/wal/` |
| 15 | 冷启动 | 缓存优先 + WAL 重放 + 后台哈希验证 |
| 16 | 空值占位符 | 默认 `-`，后期支持 `@null_marker` 自定义 |

---

## 十一、待设计（后续讨论）

- [x] 解析管道（Parse Pipeline）→ 详见 `2026-06-10-parse-pipeline-design.md`
- [ ] 外键引用验证：`ref(table)` 类型的跨文件完整性检查
- [ ] 查询引擎：类 SQL/DQL 语法定义、查询优化器
- [ ] 事务模型：跨行/跨文件事务的具体实现
- [ ] 视图层接口：存储引擎暴露给视图层的 API
- [ ] 多文件表：一张表跨多个 `.md` 文件（分区表场景）
- [ ] A 形式（文件即记录）和 C 形式（块即记录）的适配层
