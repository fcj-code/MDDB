# MD-DB 事务模型设计文档 v1.0

> 日期：2026-06-10
> 状态：草案 — 事务模型完整设计
> 依赖：`2026-06-10-storage-engine-design.md`（存储引擎）、`2026-06-10-parse-pipeline-design.md`（解析管道）、`2026-06-10-query-engine-design.md`（查询引擎）

---

## 一、设计概述

### 1.1 核心定位

事务模型层负责提供跨操作、跨文件的原子性保证，桥接内存 SQLite 事务与文件系统写入之间的鸿沟。

### 1.2 覆盖范围

| 场景 | 说明 |
|------|------|
| **批量写入原子性** | 多条 CRUD 操作打包为原子事务，要么全成功要么全失败 |
| **崩溃一致性** | Obsidian 崩溃或插件异常退出时，内存 SQLite 与 `.md` 文件保持一致 |
| **外部修改冲突** | 用户手动编辑 `.md` 文件的同时引擎尝试写入，保证最终数据正确 |

### 1.3 设计原则

- **不追求完美的跨文件回滚** — Obsidian Vault API 没有跨文件原子性，接受最终一致性
- **单文件事务走快路径** — 90%+ 的场景是单文件操作，使用文件先写策略，零 WAL 开销
- **SQLite 原生事务能力最大化利用** — 不重复造轮子，事务隔离和回滚委托给 SQLite
- **YAGNI** — 不支持 savepoint、不引入全局隐式事务状态

---

## 二、API 设计

### 2.1 混合模式

```
自动事务（autocommit）：每条语句自动包装为独立事务
显式事务（transaction）：调用方控制事务边界，支持跨表操作
```

### 2.2 自动事务 API

```typescript
interface Engine {
  // 单条操作 — 独立事务
  insert(table: string, record: Record): string;           // 返回 storage_pk
  update(table: string, pk: string, data: Partial<Record>): void;
  delete(table: string, pk: string): void;

  // 批量操作 — 单表事务（内部一个事务，写一次文件）
  insertAll(table: string, records: Record[]): string[];
  updateAll(table: string, pkData: Array<{ pk: string; data: Partial<Record> }>): void;
  deleteAll(table: string, pks: string[]): void;

  // 显式事务 — 支持跨表
  transaction<T>(callback: (tx: Transaction) => T): Promise<T>;
}
```

### 2.3 显式事务 API

```typescript
interface Transaction {
  // CRUD（操作累积在同一 SQLite 事务中）
  insert(table: string, record: Record): string;
  update(table: string, pk: string, data: Partial<Record>): void;
  delete(table: string, pk: string): void;
  select(table: string, filter: SimpleFilter): Record[];

  // 查询引擎完整能力 —— 与 Engine.query() 返回类型一致
  query(q: Query): ResultOrError;
  queryRaw(sql: string, params: any[]): ResultOrError;

  // 注：回滚通过 throw 触发，不需要显式 rollback() 方法
}
```

### 2.4 使用示例

```typescript
// 方式 1：自动事务 — 单条操作
engine.insert("accounts", { name: "支付宝", balance: 1000 });
engine.update("accounts", "acc_pk_1", { balance: 950 });

// 方式 2：批量自动事务 — 单表原子写入
engine.insertAll("transactions", [
  { date: "2024-06-01", amount: -50, category: "餐饮" },
  { date: "2024-06-01", amount: -16.50, category: "交通" },
]);

// 方式 3：显式事务 — 跨表原子写入
engine.transaction((tx) => {
  const acc = tx.select("accounts", { name: "支付宝" });
  if (acc.balance < 100) {
    throw new Error("余额不足");  // → SQLite ROLLBACK → 文件不写
  }
  tx.update("accounts", "acc_pk_1", { balance: acc.balance - 50 });
  tx.insert("transactions", { date: "2024-06-01", amount: -50 });
});
```

### 2.5 嵌套事务

采用 **Flat Nesting**（PostgreSQL 行为）：

- 内层 BEGIN/COMMIT → **空操作**（计数器 +1/-1）
- 内层 ROLLBACK → **回滚整个外层事务**
- 不自动创建 SAVEPOINT

行为约定在 API 文档中明确标注，不依赖运行时检测。

### 2.6 路径自动选择

事务提交时自动检测涉及的唯一文件数（通过 touched tables → Schema Registry 映射）：

| 文件数 | 路径 | 行为 |
|:---:|------|------|
| `== 1` | **单文件（文件先写）** | SQLite 操作累积 → vault.process() → SQLite COMMIT |
| `> 1` | **跨文件（WAL 驱动）** | SQLite COMMIT → 写 WAL 文件 → 逐个 vault.process() |

对调用方完全透明，不需要显式声明。

---

## 三、执行流程

### 3.1 单文件事务（手术式行编辑，90%+ 场景）

```
engine.transaction((tx) => {
  tx.insert("t", row1);       // → SQLite INSERT（事务中，未提交）
  tx.update("t", pk, data);   // → SQLite UPDATE（事务中，未提交）
  let r = tx.select("t", {}); // → SQLite SELECT（看到 INSERT + UPDATE）
  return r;
});
// commit 阶段 — 以 vault.process() 回调拿到当前文件为底本，手术式修改:
//   1. vault.process(file, (content) => {
//        对每条 SQLite 变更做手术式编辑:
//          INSERT → 在 content 末尾追加 "```mddb schema=X\n新行\n```"
//          UPDATE → 在 content 中定位行号 → 替换该行 → 更新 row_hash
//          DELETE → 在 content 中定位行号 → 删除该行 → 后续行号 -1
//
//        写前哈希比对（Phase 11 第三层）:
//          UPDATE/DELETE 行 → 取 content 中目标行 → 算哈希 → 对比 row_hash
//            不一致 → throw → SQLite ROLLBACK → 触发重扫 → ConflictError
//
//        return 修改后的 content
//      })
//      ├─ 成功 → SQLite COMMIT → 更新 binding 中的 line_number 和 row_hash
//      └─ 失败 → SQLite ROLLBACK → 抛出 WriteError
```

| 步骤 | 失败处理 |
|------|---------|
| vault.process() 内冲突检测 | 回调内 throw → ROLLBACK + 重扫 + ConflictError |
| vault.process() 写盘失败 | ROLLBACK + WriteError |
| 崩溃（SQLite COMMIT 前） | 内存丢失，文件未变 → 一致状态 |

**与旧设计的区别**：以 Obsidian 回调提供的文件当前内容为编辑底本，只改数据行。不碰 mddb 块外的自由文本、YAML frontmatter、Markdown 正文。不需要缓存或模板。

### 3.2 跨文件事务（WAL 驱动）

```
engine.transaction((tx) => {
  tx.insert("accounts", row1);
  tx.insert("transactions", row2);
  return done;
});
// commit 阶段:
//   1. SQLite COMMIT（内存提交，不可回滚）
//   2. 生成 WAL 条目 → 持久化到 .obsidian/.../wal/{txId}.json
//   3. vault.process(fileA) → 成功 → 标记 fileA 已同步（WAL 文件中）
//   4. vault.process(fileB) → 成功 → 标记 fileB 已同步
//   5. 全部完成 → 删除 wal/{txId}.json
//
// 如果步骤 3/4 失败:
//   → WAL 文件保留 → 写入 retry 状态 → 指数退避重试
// 如果步骤 2-4 之间崩溃:
//   → 重启 → 遍历 wal/ 目录 → 重放所有 WAL 条目 → 幂等写入
```

| 步骤 | 失败处理 |
|------|---------|
| 任一 vault.process() | WAL 保留 → 指数退避重试 → 最终一致 |
| 全部重试失败 | WAL 标记 dead → 状态栏通知 → 用户手动处理 |
| 崩溃（WAL 已持久化） | 重启重放 WAL → 幂等写入全部文件 |

**幂等性保证**：重放 = SELECT * FROM table → 生成文件内容 → vault.process()，写入多少次结果相同。

---

## 四、WAL 文件设计

### 4.1 格式

```
.obsidian/plugins/md-db/wal/{txId}.json
```

```typescript
interface WalEntry {
  txId: string;                    // UUID
  createdAt: string;               // ISO 8601
  status: "pending" | "retrying" | "dead";
  files: Array<{
    relativePath: string;          // "finance/accounts.md"
    tableName: string;             // "accounts"
  }>;
  retry: {
    count: number;                 // 0..maxRetries
    maxRetries: number;            // 默认 10
    lastError: string | null;
    lastAttemptAt: string | null;  // ISO 8601
    nextAttemptAt: string | null;  // ISO 8601（指数退避计算）
  };
}
```

### 4.2 重试策略

指数退避：`1s → 2s → 4s → 8s → 16s → 30s → 60s → 120s → 300s → 600s`，最多 10 次。

### 4.3 生命周期

```
创建:  跨文件事务 SQLite COMMIT 后立即写入
重试:  后台定时器，按指数退避间隔重试
死信:  全部重试失败 → status="dead" → 状态栏通知 "N 条未同步" → 用户可手动重试或丢弃
删除:  所有文件 vault.process() 成功后删除
```

### 4.4 冷启动重放

```
1. 遍历 .obsidian/plugins/md-db/wal/*.json
2. 对每个 WAL 条目（status != "dead"）:
   a. 从 SQLite 的对应表 SELECT * → 生成文件内容
   b. vault.process(file, content) → 幂等写入
   c. 成功 → 标记已同步
3. 全部完成 → 删除所有已完成的 WAL 文件
4. status="dead" 的条目 → 跳过，通知用户
```

### 4.5 死信处理

```
状态栏: "MD-DB: N 条未同步"
点击 → 弹出面板，列出：
  - 事务 ID
  - 创建时间
  - 涉及文件
  - 最后失败原因
  - 操作按钮：[重试] [丢弃]

丢弃 = 删除 WAL 文件 + 接受"内存和文件永久分裂"
```

---

## 五、与 _wal_retry 表的关系

**`_wal_retry` 表（Phase 10 的 SQLite 行级 WAL）被移除。** WAL JSON 文件统一承担：
- 文件同步清单（哪些文件待同步）
- 重试状态（计数、错误、退避计时）
- 死信管理

正常路径下 `wal/` 目录为空（所有文件写入成功后 WAL 文件被删除），只有异常路径才有文件存在。

---

## 六、冲突策略

### 6.1 分层策略

| 场景 | 策略 | 行为 |
|------|------|------|
| **显式事务** | 乐观锁（写前哈希比对） | 冲突 → ROLLBACK → ConflictError → 调用方决定重试 |
| **自动事务** | 最后写入胜出 | 不检查冲突，直接覆盖写入 |

### 6.2 乐观锁机制

复用 Phase 11 第三层（写前哈希验证）已有基础设施：

```
写入前:
  1. 读目标行当前内容 → 计算哈希
  2. 对比 binding.row_hash
  3. 一致 → 安全写入
  4. 不一致 → 放弃写入 → SQLite ROLLBACK → 触发重扫 → 抛出 ConflictError
```

### 6.3 冲突错误

```typescript
class ConflictError extends Error {
  table: string;
  conflictingFiles: string[];
  message: string;  // "外部修改冲突：accounts.md 已被修改，请重试事务"
}
```

### 6.4 为什么自动事务不检查冲突

- 单用户 + 引擎写入耗时 < 100ms
- 用户手动编辑和引擎写入同一行概率极低
- 不值得为极低概率事件增加每次写入的开销

---

## 七、回滚语义

### 7.1 单文件事务

**完美回滚** — vault.process() 失败或冲突 → SQLite ROLLBACK → 调用方收到错误 → 文件和内存均无变更。

### 7.2 跨文件事务

**最终一致性（不可回滚）** — SQLite 已 COMMIT，文件侧通过 WAL 保证最终写入。失败 = 重试，不 = 回滚。

**为什么不能完美回滚**：Vault API 没有跨文件原子性。文件 A 写入成功后，文件 B 失败——文件 A 的修改已不可逆（物理行号模型下无精确补偿操作）。

**务实选择**：跨文件事务是低频场景 × Vault API 写入失败是低频事件 = 极低概率。把复杂度花在"让失败率趋近于零"而非"失败后完美回滚"。

### 7.3 事务内回滚

```typescript
// 通过 throw 触发回滚
engine.transaction((tx) => {
  tx.insert("accounts", row1);
  if (someCondition) {
    throw new Error("业务逻辑拒绝");
    // 单文件 → SQLite ROLLBACK
    // 跨文件 COMMIT 前 → SQLite ROLLBACK, WAL 未创建
  }
  tx.insert("transactions", row2);
});
```

---

## 八、架构位置

```
┌────────────────────────────────────────────────┐
│                  视图层                          │
│         engine.transaction() / insert()          │
└────────────────────┬───────────────────────────┘
                     │
┌────────────────────▼───────────────────────────┐
│              事务模型层 (本次设计)                │
│  ┌───────────────────────────────────────────┐  │
│  │  TransactionManager                       │  │
│  │  ├─ commit(tx) → 自动检测单/跨文件          │  │
│  │  ├─ singleFileCommit(tx) → 文件先写        │  │
│  │  └─ multiFileCommit(tx) → WAL 驱动        │  │
│  ├───────────────────────────────────────────┤  │
│  │  WalManager                              │  │
│  │  ├─ writeEntry(txId, files)              │  │
│  │  ├─ replayAll() → 冷启动                  │  │
│  │  └─ retryLoop() → 后台指数退避             │  │
│  ├───────────────────────────────────────────┤  │
│  │  ConflictDetector                        │  │
│  │  └─ check(file, table) → hash vs binding │  │
│  └───────────────────────────────────────────┘  │
└────────────────────┬───────────────────────────┘
                     │
┌────────────────────▼───────────────────────────┐
│  存储引擎（已有）：SQLite + _binding + 用户表      │
│  查询引擎（已有）：QueryEngine                    │
└────────────────────────────────────────────────┘
           ↕ Vault API
┌────────────────────────────────────────────────┐
│              Vault（.md 文件）                     │
│  .obsidian/plugins/md-db/wal/{txId}.json        │
└────────────────────────────────────────────────┘
```

---

## 九、模块产出

```
src/transaction/
├── types.ts              # Transaction, WalEntry, ConflictError, WriteError
├── transaction.ts         # TransactionManager — begin/commit/rollback, 路径选择
├── wal.ts                # WalManager — 读写 WAL 文件, 重放, 重试循环
├── conflict.ts           # ConflictDetector — 写前哈希比对
└── integration.ts        # 与 Engine 的集成层（包装 CRUD，暴露 transaction API）
```

---

## 十、决策记录

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 事务覆盖范围 | 全覆盖：批量原子性 + 崩溃一致性 + 外部修改冲突 |
| 2 | API 形态 | 混合模式：自动事务（autocommit）+ 显式事务 `engine.transaction(cb)` |
| 3 | 隔离级别 | SQLite 默认，不额外处理，重点在文件层原子性 |
| 4 | 内存-文件桥接 | 分层：单文件 → 文件先写，跨文件 → WAL 驱动 |
| 5 | 冲突策略 | 分层：显式事务 → 乐观锁，自动事务 → 最后写入胜出 |
| 6 | 回滚机制 | 单文件完美回滚，跨文件 WAL 最终一致（向前推进） |
| 7 | 嵌套事务 | 合并到外层（Flat Nesting），不自动创建 SAVEPOINT |
| 8 | tx 对象 API | CRUD + query + queryRaw，回滚通过 throw 触发 |
| 9 | 单文件执行 | SQLite 先行 → commit 时验证冲突 + vault.process() → COMMIT/ROLLBACK |
| 10 | 跨文件执行 | SQLite COMMIT → 持久化 WAL → 逐个 vault.process() → 删 WAL |
| 11 | 自动事务语义 | `insert()` 独立事务，`insertAll()` 批量事务 |
| 12 | WAL 条目格式 | 事务级单 JSON 文件，存文件路径 + 表名，不含数据 |
| 13 | WAL 存储 | 合并到 WAL JSON 文件，移除 `_wal_retry` 表 |
| 14 | 路径选择 | 自动检测：commit 时数涉及的文件数，单文件走快路径 |

---

## 十一、待讨论清单

以下议题在本次会话中未深入讨论，留待后续：

- [ ] **事务错误类型体系**：ConflictError、WriteError、DeadLetterError 等完整错误码定义
- [ ] **事务生命周期钩子**：是否需要 `onCommit` / `onRollback` / `onRetry` 事件
- [ ] **与 Phase 9 CRUD 的关系**：事务模块是替换 Phase 9 的 CRUD 实现，还是在其之上包装
- [ ] **事务超时**：长时间未提交的事务是否需要自动回滚
- [ ] **事务大小限制**：是否限制单个事务的操作数（内存保护）
- [ ] **死信处理 UI 详细设计**：死信面板的交互细节
- [ ] **WAL 文件清理策略**：死信保留多久后自动清除
- [ ] **事务 ID 生成**：UUID v4 vs 时间戳+随机数
- [ ] **幂等写入细节**：重放时如何判断"文件内容已是最新"（文件哈希比对 vs 盲写）
