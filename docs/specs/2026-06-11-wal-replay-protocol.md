# MD-DB WAL 重放协议 v2

> 日期：2026-06-11  
> 状态：✅ 已冻结 — Milestone 0 架构基线  
> 用途：定义 WAL v2 的文件格式、操作语义、重放幂等规则、状态机、重试与死信策略  
> 替代：`2026-06-10-storage-engine-design.md` §7（WAL）、`2026-06-10-transaction-model-design.md` §4（WAL 文件设计）的相关部分  
> 实施：Phase 10 / Phase 16 之前必须先阅读本文档

---

## 一、设计目标

```text
1. WAL 必须记录可重放操作，而不是只记录受影响文件。
2. WAL 重放必须幂等（无论重放 1 次还是 N 次，结果相同）。
3. 部分成功的 WAL 可以从中断点继续，不重复已完成的 operation。
4. WAL 写入必须在 Markdown 文件写入之前持久化（写前日志）。
5. 正常路径下 wal/ 目录为空，只有异常路径有文件。
```

---

## 二、文件格式

### 2.1 WalEntry

```typescript
interface WalEntry {
  txId: string;                        // UUID v4
  version: 2;                          // 协议版本
  createdAt: string;                   // ISO 8601
  updatedAt: string;                   // ISO 8601

  status: WalStatus;                   // 当前状态
  operations: WalOperation[];          // 待执行操作列表

  progress: {
    completedOperationIds: string[];   // 已完成操作的 ID 列表
  };

  retry: WalRetryState;
}

type WalStatus = "pending" | "retrying" | "dead" | "done";

interface WalRetryState {
  count: number;                       // 当前重试次数
  maxRetries: number;                  // 默认 10
  lastError: string | null;            // 最后一次错误信息
  lastAttemptAt: string | null;        // ISO 8601
  nextAttemptAt: string | null;        // ISO 8601
}
```

### 2.2 WalOperation 联合类型

```typescript
type WalOperation =
  | InsertLineOperation
  | ReplaceLineOperation
  | DeleteLineOperation;

interface WalOperationBase {
  id: string;                          // 操作 ID，在入 entries 内唯一
}
```

#### InsertLineOperation

```typescript
interface InsertLineOperation extends WalOperationBase {
  type: "insertLine";
  file: string;                        // 目标文件相对路径
  blockId?: string;                    // 目标代码块 ID
  afterLine?: number;                  // 在此行之后插入（省略 = 块尾追加）
  content: string;                     // 要插入的行内容（不含尾换行符）
  expectedFileHash?: string;           // 写入前期望的文件 hash
}
```

语义：

```text
1. 读取 file 的当前内容。
2. 定位目标 block 的末尾（或 afterLine 之后）。
3. 在目标位置追加 content + "\n"。
4. 如果指定了 expectedFileHash，先验证文件 hash。
```

#### ReplaceLineOperation

```typescript
interface ReplaceLineOperation extends WalOperationBase {
  type: "replaceLine";
  file: string;                        // 目标文件相对路径
  lineNumber: number;                  // 目标行号
  beforeHash: string;                  // 期望的当前行 hash
  beforeContent?: string;              // 期望的当前行完整内容（备选）
  afterContent: string;                // 替换后的行内容
}
```

语义：

```text
1. 读取 file，获取 lineNumber 行的当前内容。
2. 计算行 hash。
3. 如果 hash == beforeHash（或完整内容匹配 beforeContent），替换。
4. 如果当前行内容已经 == afterContent，视为幂等成功。
5. 否则 → conflict。
```

#### DeleteLineOperation

```typescript
interface DeleteLineOperation extends WalOperationBase {
  type: "deleteLine";
  file: string;                        // 目标文件相对路径
  lineNumber: number;                  // 目标行号
  beforeHash: string;                  // 期望的当前行 hash
  beforeContent: string;               // 期望的当前行完整内容
}
```

语义：

```text
1. 读取 file，获取 lineNumber 行的当前内容。
2. 计算行 hash。
3. 如果 hash == beforeHash（或完整内容匹配 beforeContent），删除该行。
4. 如果该行已被删除（lineNumber 不存在），视为幂等成功。
5. 否则 → conflict。
```

### 2.3 文件位置

```text
.obsidian/plugins/md-db/wal/{txId}.json
```

目录结构：

```text
.obsidian/plugins/md-db/
├── wal/
│   ├── e7a8b3f4-1e5d-4f3b-a8c7-d9e0f1a2b3c4.json  # pending
│   └── c8a7b3f4-1e5d-4f3b-a8c7-d9e0f1a2b3c4.json  # retrying
├── cache/
│   ├── mddb-cache.sqlite
│   ├── file_hashes.json
│   ├── schema_registry.json
│   └── cache-manifest.json
└── logs/
```

### 2.4 状态编码

| 状态 | 含义 | 允许重试 | 重启时 |
|---|---:|---:|---:|
| `pending` | 刚写入，尚未开始执行 | 是 | 从 0 开始执行 |
| `retrying` | 正在重试中 | 是 | 从 progress 继续 |
| `dead` | 超过 maxRetries | 否，用户手动 | 通知用户 |
| `done` | 全部 operation 完成 | — | 删除 WAL |

---

## 三、写入顺序

### 3.1 标准写入流程（写前日志）

```text
1. 构造 WritePlan（确定所有 operations）。
2. 生成 txId = UUID v4。
3. 持久化 WAL：
   - 写入 wal/{txId}.json，status = pending。
   - fsync（如果环境支持，否则依赖 Obsidian API 的写入保证）。
4. 应用 SQLite 临时事务（可选，取决于文件数）。
5. 逐个执行 operations：
   a. 检查 operationId 是否在 completedOperationIds 中 → 是则跳过。
   b. 执行 vault.process()。
   c. 成功 → 追加 operationId 到 completedOperationIds → 立即持久化 WAL。
   d. 失败 → 停止，status = retrying，重试调度。
6. 全部 operation 完成后：
   - status = done。
   - 延迟清理（保持 30s 供审核，然后删除 WAL 文件）。
```

### 3.2 乐观 UI 模式写入流程

如果 UI 需要在文件写入前就反映变更：

```text
1. 更新 SQLite。
2. 构造 WritePlan。
3. 持久化 WAL（pending）。
4. 设置受影响记录 syncState = pending（不阻塞 UI）。
5. 后台执行 vault.process()。
6. 成功 → syncState = synced → WAL done → 删除 WAL。
7. 失败 → syncState = retrying → 状态栏展示未同步数量。
```

约束：

```text
- ResultSet 或记录元数据必须标记 syncState。
- 状态栏必须展示未同步数量。
- dead WAL 不得静默吞掉。
- 非乐观路径中，WAL 必须先于 SQLite 提交持久化。
```

---

## 四、重放幂等规则

### 4.1 通用重放算法

```typescript
async function replay(entry: WalEntry): Promise<void> {
  for (const op of entry.operations) {
    if (entry.progress.completedOperationIds.includes(op.id)) {
      continue; // 幂等跳过
    }

    try {
      await executeOperation(op);
      entry.progress.completedOperationIds.push(op.id);
      await persistProgress(entry);     // 立即持久化进度
    } catch (err) {
      entry.status = "retrying";
      entry.retry.lastError = err.message;
      await persistProgress(entry);
      scheduleRetry(entry);            // 指数退避
      return;
    }
  }

  // 所有 operation 完成
  entry.status = "done";
  entry.updatedAt = new Date().toISOString();
  await persistProgress(entry);

  // 延迟清理
  setTimeout(() => deleteWalFile(entry.txId), 30_000);
}
```

### 4.2 各操作类型的幂等判断

| 操作 | before 匹配 | after 匹配 | 不一致 |
|---|---:|---:|---:|
| `insertLine` | — | 目标位置已有相同内容 | 忽略/记录 warning |
| `replaceLine` | 替换 | 视为成功 | conflict → dead |
| `deleteLine` | 删除 | 视为成功 | conflict → dead |

```text
insertLine 幂等：
  目标 block 末尾已有 content 的行 → 视为幂等成功（不重复插入）。

replaceLine 幂等：
  lineNumber 内容已等于 afterContent → 视为幂等成功。
  lineNumber 内容等于 beforeContent → 执行替换。

deleteLine 幂等：
  lineNumber 已被删除或不存在 → 视为幂等成功。
  lineNumber 内容匹配 beforeContent → 执行删除。
```

### 4.3 冲突处理

当 operation 执行时发现目标内容既不是 before 也不是 after：

```text
1. 停止当前 WAL 执行。
2. 将 WAL status 设为 "dead"。
3. 保留已完成的 completedOperationIds。
4. 记录冲突信息到 lastError。
5. 通知用户：状态栏 + 诊断面板。
6. 用户可选择：
   a. 重试（重新执行全部 operations）。
   b. 查看冲突详情（显示 expected vs actual）。
   c. 丢弃 WAL（删除 WAL 文件，接受内存与文件不一致）。
   d. 重建索引（全量重扫，清除该 WAL）。
```

---

## 五、重试策略

### 5.1 指数退避

```text
退避序列（最多 10 次）：

1s → 2s → 4s → 8s → 16s → 30s → 60s → 120s → 300s → 600s
```

### 5.2 重试调度

```typescript
function scheduleRetry(entry: WalEntry): void {
  if (entry.retry.count >= entry.retry.maxRetries) {
    entry.status = "dead";
    entry.retry.lastError = "Max retries exceeded";
    persistProgressSync(entry);
    notifyDeadEntry(entry);
    return;
  }

  const delay = RETRY_BACKOFF[Math.min(entry.retry.count, RETRY_BACKOFF.length - 1)];
  entry.retry.count += 1;
  entry.retry.nextAttemptAt = new Date(Date.now() + delay * 1000).toISOString();
  persistProgressSync(entry);

  setTimeout(() => attemptRetry(entry), delay * 1000);
}
```

### 5.3 重启时处理

```text
冷启动阶段：
1. 遍历 wal/ 目录中的全部 *.json。
2. status = done 的条目 → 删除。
3. status = dead 的条目 → 跳过，通知用户。
4. status = pending 或 retrying 的条目 → 调用 replay(entry)。
5. 所有 WAL 处理完成后 Engine 标记 ready。
6. 后台继续重试 status = retrying 且 nextAttemptAt 已过的条目。
```

---

## 六、死信处理

### 6.1 生命周期

```text
pending/retrying:
  → 系统自动重试
  → 状态栏显示 "N 条未同步"
  → 诊断面板可查看进度

dead:
  → 状态栏强提示 "N 条写入失败，请处理"
  → 诊断面板列出：
    - 事务 ID
    - 创建时间
    - 涉及文件
    - 操作摘要
    - 最后错误原因
  → 用户操作：
    [重试] → 重置 count 到 0，重新执行
    [查看冲突] → 显示 expected vs actual
    [丢弃] → 删除 WAL 文件，接受不一致
    [重建索引] → 全量重扫，清除所有 dead WAL
```

### 6.2 丢弃语义

```text
丢弃 = 删除 WAL JSON 文件。

此时：
- SQLite cache 可能已经包含未写入 Markdown 的数据。
- Markdown 文件可能缺少某些已成功的更改。
- 系统不再跟踪此不一致。
- 建议用户执行 "重建索引" 来修正。
```

---

## 七、与 Phase 10 / Phase 16 的关系

| 阶段 | 对 WAL 的使用 | 说明 |
|---|---:|---:|
| Phase 10 (WAL) | WalManager 基础设施 | 实现 writeEntry、replayAll、retryLoop、deadLetter |
| Phase 16 (Transaction) | 跨文件事务提交 | 复用 WalManager 生成多 operation 的 WalEntry |

```text
Phase 10 实现：
- WalEntry 的读写持久化。
- replay() 主循环与幂等调度。
- 指数退避 retryLoop。
- dead 信检测。
- 冷启动重放。

Phase 16 扩展：
- 事务 commit 时构造包含多个 operations 的 WalEntry。
- 单文件事务不走 WAL（文件先行路径）。
- 跨文件事务在 SQLite COMMIT 后写 WAL。
```

两阶段共享同一个 `wal/` 目录和 `WalEntry` 格式。

---

## 八、对 v1 WAL 设计的替代

本文档正式替代以下 v1 设计：

| v1 文档 | v1 WAL 行为 | v2 变化 |
|---|---:|---|
| `storage-engine-design.md` §7 | 行级文本 WAL，记录文件+操作+内容 | 结构化 JSON + operation 数组 + progress |
| `storage-engine-design.md` §5.3 | 乐观写 → WAL 补偿 | WAL 先写后执行 |
| `transaction-model-design.md` §4.1 | `WalEntry.files: Array<{relativePath, tableName}>` | 改为 `operations: WalOperation[]` |
| `transaction-model-design.md` §4.4 | 冷启动重放：SELECT * → 生成文件内容 | 逐 operation 重放 |
| `transaction-model-design.md` §4.2 | `_wal_retry` SQLite 表 | 已移除，统一 JSON WAL |
