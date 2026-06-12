# MD-DB 解析管道设计文档 v1.0

> 日期：2026-06-10
> 状态：草案 — 存储引擎解析管道完整设计
> 范围：B 形式 .md 文件 → 内存 SQLite 的完整解析流程
> 依赖：`2026-06-10-storage-engine-design.md`（存储引擎底层架构）

---

## 一、解析管道概览

### 1.1 完整流程

```
Phase 0: 文件发现    → 遍历 Vault，识别含 mddb 块或 @table 的 .md 文件
Phase 1: Schema 提取 → 解析 @ 指令 / YAML frontmatter / 外部引用，构建 Schema 对象
Phase 2: 行词法分析  → 识别 mddb 围栏块，逐行分类，按 | 切分字段，处理转义
Phase 3: 类型转换    → 每个字段值按 @types 声明转为强类型
Phase 4: 验证        → 类型校验 + 必填检查 + 字段数匹配 + 唯一性 + ref 引用
Phase 5: 写入索引    → 生成 storage_pk → 插入绑定表 → 写入内存 SQLite
```

### 1.2 数据容器：` ```mddb` 围栏代码块

- 文件中的结构化数据以 ` ```mddb` 代码块包裹
- 块外 Markdown 内容为自由文本，解析器跳过
- 同一文件可有多个 mddb 块
- `@table` 同名 → 数据行追加到同一张表
- `@table` 不同名 → 各自独立表

### 1.3 模块架构

```
┌─────────────────────────────────────────────────┐
│                  Parse Pipeline                   │
├──────────┬──────────┬──────────┬────────────────┤
│ Schema   │ Lexer    │ Type     │ Validator      │
│ Resolver │ (Phase 2)│ Converter│ (Phase 4)      │
│ (Phase 1)│          │ (Phase 3)│                │
└──────────┴──────────┴──────────┴────────────────┘
                      │
                      ▼
              Binding Table + 内存 SQLite + WAL
```

---

## 二、Phase 1: Schema 提取

### 2.1 Schema 来源与优先级

```
优先级:  块内 @ 指令  >  围栏信息串  >  文件 YAML frontmatter  >  外部 YAML 引用
         (最具体)      (块级)         (文件级)                   (兜底)
```

#### 方式 A: 块内 @ 指令（最高优先级）

在 ` ```mddb` 块内以 `@` 开头声明：

```markdown
```mddb
@table transactions
@pk (日期, 金额, 商户)
@sort (日期 ASC)
@fields 日期 | 金额 | 类型 | 分类 | 账户 | 商户 | 备注
@types  date | decimal(2) | enum(支出,收入) | string | ref(accounts) | string | text
@required true | true | true | true | true | true | false
@null_marker "-"
@indexes idx(分类) | idx(金额)
@strict false
2024-06-01 | -45.00 | 支出 | 餐饮 | 现金 | 兰州拉面 | 加了一份牛肉
2024-06-01 | -16.50 | 支出 | 交通 | 支付宝 | 北京地铁 | -
```
````

#### 方式 B: 围栏信息字符串

```markdown
```mddb schema=finance/transactions
2024-06-01 | -45.00 | 支出 | 餐饮 | 现金 | 兰州拉面 | 加了一份牛肉
```
````

仅支持 `schema=xxx`，保持简洁。

#### 方式 C: 文件 YAML Frontmatter

```yaml
---
mddb:
  table: transactions
  pk: [日期, 金额, 商户]
  sort: 日期 ASC
  fields: [日期, 金额, 类型, 分类, 账户, 商户, 备注]
  types: [date, decimal(2), enum(支出,收入), string, ref(accounts), string, text]
  required: [true, true, true, true, true, true, false]
  null_marker: "-"
---
```

#### 方式 D: 外部 YAML 引用

```yaml
---
mddb:
  use: finance/transactions
---
```

**路径解析**：
- `finance/transactions` → 相对 Vault 根目录查找 `finance/transactions.yaml`（或 `.yml`）
- `./transactions` → 相对当前文件所在目录查找

### 2.2 Schema 指令参考

| 指令 | 必需 | 说明 | 示例 |
|------|:---:|------|------|
| `@table` | ✅ | 表名（唯一标识） | `@table transactions` |
| `@pk` | ✅ | 逻辑主键 | `@pk (日期, 金额)` 或 `@pk $uuid` |
| `@fields` | ✅ | 字段名列表（`\|` 分隔） | `@fields 日期 \| 金额 \| 分类` |
| `@types` | ✅ | 字段类型列表（`\|` 分隔） | `@types date \| decimal(2) \| string` |
| `@required` | 否 | 必填标记（`\|` 分隔） | `@required true \| true \| false` |
| `@sort` | 否 | 默认排序键 | `@sort (日期 ASC, 金额 DESC)` |
| `@indexes` | 否 | 建议索引 | `@indexes idx(分类) \| idx(金额)` |
| `@relations` | 否 | 外键关系声明 | `@relations 联系人 -> contacts.md:name` |
| `@null_marker` | 否 | 自定义空值标记 | `@null_marker N/A` |
| `@strict` | 否 | 严格校验模式 | `@strict true`（默认 false） |
| `@on_dup` | 否 | 主键冲突策略（后期） | `@on_dup skip\|overwrite\|error` |

**内部 Schema 对象**：行内 `@` 指令和 YAML frontmatter 两种输入格式统一解析为同一个 Schema 对象。两者一一对应：

| 行内指令 | YAML key | 值格式 |
|----------|----------|--------|
| `@table` | `mddb.table` | 字符串 |
| `@pk` | `mddb.pk` | 字符串或字符串数组 |
| `@fields` | `mddb.fields` | `\|` 分隔字符串 或 字符串数组 |
| `@types` | `mddb.types` | `\|` 分隔字符串 或 字符串数组 |
| `@required` | `mddb.required` | `\|` 分隔字符串 或 布尔数组 |
| `@sort` | `mddb.sort` | 字符串 |
| `@null_marker` | `mddb.null_marker` | 字符串 |
| `@strict` | `mddb.strict` | 布尔 |

### 2.3 Schema 元验证

解析器在提取 Schema 后先验证 Schema 本身是否合法：

- `@table`、`@pk`、`@fields`、`@types` 为必需指令
- `@fields` 和 `@types` 的列数必须相等
- `@required` 如果存在，列数必须与 `@fields` 一致
- `@pk` 中声明的列名必须在 `@fields` 中存在
- `@sort` 中声明的列名必须在 `@fields` 中存在
- `@indexes` 中声明的列名必须在 `@fields` 中存在
- `@null_marker` 的值不应与任何实际数据中的正常值冲突（警告级别）

---

## 三、Phase 2: 行词法分析

### 3.1 mddb 块内行识别

```
块内行的判定（逐行扫描）:
  - 行首是 @ → Schema 指令（进入 Phase 1）
  - 空行     → 跳过
  - 其他     → 数据行（进入 Phase 3）
```

### 3.2 字段切分

**转义处理（在 split 之前）**：

```
扫描整行，处理转义序列:
  \|  → 替换为内部标记 NONPIPE（后续还原）
  \\  → 替换为内部标记 BSLASH（后续还原）

split('|') → N 个片段

每个片段还原:
  NONPIPE → |
  BSLASH  → \
```

**示例**：

```
输入: 2024-06-01 | -45.00 | 支出 | 餐饮 | 支付宝\|微信 | 海底捞 | 朋友AA
切分: ["2024-06-01", "-45.00", "支出", "餐饮", "支付宝|微信", "海底捞", "朋友AA"]
                                        ↑ 正确保留管道符
```

### 3.3 空白处理

```
每个片段执行 .trim()（首尾空白去除）
仅空白字符的片段 → 视为空值（""）
空值 + 值为 "-" 或 @null_marker 配置的值 → NULL_SENTINEL
```

### 3.4 空值识别

```
if (trimmed == '' || trimmed == @null_marker_value):
    value = NULL_SENTINEL  // → 传给 Phase 3
```

默认 `@null_marker = "-"`。用户可自定义为 `N/A`、`null` 等。

---

## 四、Phase 3: 类型转换

### 4.1 类型转换器规格

| 类型 | 转换规则 | 合法输入示例 | 转换失败 → |
|------|---------|-------------|:---:|
| `string` | 原样保留, trim() | 任意文本 | 永不失败 |
| `integer` | `parseInt(trimmed)`, 检查 `/^-?\d+$/` | `42`, `-17` | NULL |
| `decimal(N)` | 内部存整数 `parseFloat × 10^N`，避免浮点 | `45.00`, `45` | NULL |
| `boolean` | true/yes/1/是 → true ; false/no/0/否 → false | `true`, `是`, `false` | NULL |
| `date` | YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD | `2024-06-01` | NULL |
| `datetime` | YYYY-MM-DD HH:MM:SS / ISO 8601 | `2024-06-01 14:30:00` | NULL |
| `enum(v1,…)` | 精确匹配枚举值，大小写敏感 | `支出`, `收入` | NULL |
| `text` | 还原转义后原样保留 | 含 `\|` `\\` `\n` 文本 | 永不失败 |
| `tags` | 正则提取 `#tag`，去重保持顺序 | `#技术 #重要`→`["技术","重要"]` | `[]` |
| `ref(table)` | 原样保留字符串，标记为外键引用 | `张三` | 延迟验证 |
| `phone` | 提取数字标准化为纯数字串 | `138-1234-5678`→`13812345678` | NULL |
| `email` | trim + 小写，正则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` | `user@example.com` | NULL |

### 4.2 decimal 精度细节

```
@types decimal(2)

存储: BIGINT（整数，单位为 10^-N）
  "45.00" → 4500
  "-16.50" → -1650
  "45" → 4500（自动补全小数位）

显示: 始终格式化回 N 位小数
  4500 → "45.00"

避免 JavaScript 浮点精度问题:
  ❌ parseFloat("45.00") → 45.0（浮点，0.1 + 0.2 问题）
  ✅ 内部整数运算 → 显示时 / 100 → "45.00"
```

### 4.3 宽松 vs 严格模式

| 模式 | 触发 | 转换失败行为 | 字段数不匹配 |
|------|------|-------------|-------------|
| **宽松**（默认） | — | NULL + warning，行继续 | 不足补 NULL / 超出截断 |
| **严格** | `@strict true` | 跳过整行，记录 error | 跳过整行，记录 error |

---

## 五、Phase 4: 验证

### 5.1 验证链

```
类型转换 (Phase 3 已完成)
  → 字段数校验
    → 必填检查 (@required)
      → 枚举约束 (Phase 3 已处理)
        → 逻辑主键唯一性
          → 外键引用完整性 (延迟验证)
```

### 5.2 字段数校验

```
count(values) vs count(@fields):

  相等    → 正常
  少于    → 尾部字段补 NULL (宽松) / 跳过行 (@strict)
  多于    → 尾部截断 (宽松) / 跳过行 (@strict)
```

### 5.3 必填检查

```
for each field i:
  if @required[i] == true AND values[i] == NULL:
    → warning: "必填字段 '{field_name}' 值为空"
    (行继续处理，字段值为 NULL)
```

注意：`-`（空值占位符）= NULL = 违反 `@required`。用户需写实际值（如 `0` 表示零金额）。

### 5.4 逻辑主键唯一性

```
从转换后的记录中提取 @pk 列的值，拼接为 logical_pk

查找:
  SELECT FROM _binding WHERE logical_pk = ? AND table_name = ?

冲突处理:
  先写入的保留 (first-write-wins) — 解析顺序中先出现的记录获胜
  冲突行 → error: "逻辑主键冲突: {logical_pk}"
  冲突行不入库

后期扩展: @on_dup skip|overwrite|error
```

### 5.5 外键引用完整性

```
ref(table) 类型字段:

  目标表已加载:
    → 同步检查: 目标表中是否存在该 logical_pk 值
    → 不存在: warning "外键引用 '{value}' 在表 '{table}' 中不存在"

  目标表未加载（冷启动阶段）:
    → 延迟到后台验证
    → 暂存到 pending_refs 队列
```

### 5.6 错误收集

```
解析结果:

ParseResult {
  records:      Record[],   // 成功解析的记录
  errorCount:   number,     // 跳过的行数（仅 @strict 模式）
  warningCount: number,     // 警告行数
  errors:       ParseError[],   // { line, col?, field?, code, message }
  warnings:     ParseWarning[], // { line, field?, code, message }
}
```

**错误码体系**（内部，可扩展）：

```
PARSE_OK              // 正常
TYPE_CAST_FAILED      // 类型转换失败
FIELD_COUNT_MISMATCH  // 字段数不匹配
REQUIRED_MISSING      // 必填字段为空
PK_DUPLICATE          // 逻辑主键重复
REF_NOT_FOUND         // 外键引用目标不存在
SCHEMA_INVALID        // Schema 本身不合法
STRICT_ROW_SKIPPED    // 严格模式下跳过行
```

**日志位置**：`.obsidian/plugins/md-db/logs/{date}.log`

**状态栏**：引擎状态栏显示「N errors / M warnings」（当前 Vault 全局计数）

---

## 六、Phase 5: 写入索引

### 6.1 Storage PK 生成

```
格式: {相对文件路径}:{物理行号}:{原始行内容 SHA256 前 6 位}

物理行号 = 文件中的绝对行号（非 mddb 块内相对行号、非数据序号）
  示例: transactions/2024-06.md:11:a3f7b2

规则:
  - 物理行号精确反映文件位置，便于行号漂移维护和写前哈希验证
  - 原始行内容 = 未经类型转换的原始字符串（保证幂等：相同原始内容 → 相同 storage_pk）
  - 创建后不可变
```

### 6.2 写入流程

```
for each validated record:
  1. 生成 storage_pk
  2. 提取 logical_pk（从 @pk 列的值拼接）
  3. 计算 row_hash（原始行内容 SHA256 前 16 位）
  4. INSERT OR REPLACE INTO _binding (storage_pk, logical_pk, file_path, line_number, row_hash, last_verified)
  5. INSERT INTO [table_name] (...) VALUES (...)  // 内存 SQLite
```

---

## 七、完整数据流示例

### 7.1 输入文件

````markdown
---
mddb:
  table: transactions
  pk: [日期, 金额, 商户]
  sort: 日期 ASC
  fields: [日期, 金额, 类型, 分类, 账户, 商户, 备注]
  types: [date, decimal(2), enum(支出,收入), string, ref(accounts), string, text]
  required: [true, true, true, true, true, true, false]
---

六月上半月开销明显偏高，主要是因为请客吃饭。

```mddb
2024-06-01 | -45.00 | 支出 | 餐饮 | 现金 | 兰州拉面 | 加了一份牛肉
2024-06-01 | -16.50 | 支出 | 交通 | 支付宝 | 北京地铁 | -
```

六月下半月开始控制预算。

```mddb
2024-06-15 | -89.00 | 支出 | 餐饮 | 微信 | 西贝莜面村 | 家庭聚餐
2024-06-20 | -200.00 | 支出 | 购物 | 微信 | 优衣库 | 买了两件T恤
```
````

### 7.2 解析过程

```
Phase 1: 提取 frontmatter → Schema 对象
  table: "transactions"
  pk: ["日期", "金额", "商户"]
  fields: ["日期", "金额", "类型", "分类", "账户", "商户", "备注"]
  types: ["date", "decimal(2)", "enum(支出,收入)", "string", "ref(accounts)", "string", "text"]
  ...

Phase 2: 扫描行
  行 6:  "六月上半月开销..." → 非 mddb 块内 → 跳过
  行 11: "2024-06-01 | -45.00 | ..." → mddb 块内数据行 → 切分 7 个值
  行 12: "2024-06-01 | -16.50 | ..." → 同上
  行 17: 空行 → 跳过
  行 18: "六月下半月..." → 非 mddb 块内 → 跳过
  行 22: "2024-06-15 | -89.00 | ..." → mddb 块内数据行
  行 23: "2024-06-20 | -200.00 | ..." → mddb 块内数据行

Phase 3: 类型转换
  行 11:
    日期: "2024-06-01" → "2024-06-01" (date) ✅
    金额: "-45.00" → -4500 (decimal, 内部) ✅
    类型: "支出" → "支出" (enum) ✅
    分类: "餐饮" → "餐饮" (string) ✅
    账户: "现金" → "现金" (ref) ✅
    商户: "兰州拉面" → "兰州拉面" (string) ✅
    备注: "加了一份牛肉" → "加了一份牛肉" (text) ✅

  行 12:
    金额: "-16.50" → -1650 (decimal) ✅
    备注: "-" → NULL (空值占位符)
    → required[6]==false, 不报 warning

Phase 4: 验证
  4 行全部通过。无错误。

Phase 5: 写入
  storage_pk = "transactions/2024-06.md:11:b3f8a2"
  logical_pk = "2024-06-01:-45.00:兰州拉面"
  → INSERT _binding + INSERT transactions
```

---

## 八、决策记录

| # | 决策项 | 结论 |
|---|--------|------|
| D1 | 数据容器 | ` ```mddb` 围栏代码块，块外为自由文本 |
| D2 | 数据格式 | 纯 B 形式（值 + `\|` 分隔），键值对留给后期扩展 |
| D3 | 管道符冲突 | `\|` 转义为字面量 `\|`，`\\` 转义为 `\` |
| D4 | 类型转换失败 | 宽松默认 → NULL + warning；`@strict true` 时跳过整行 |
| D5 | 字段数不匹配 | 宽松默认 → 不足补 NULL / 超出截断；`@strict` 跳过行 |
| D6 | Schema 格式 | 行内 `@` 指令 + YAML frontmatter，内部统一 Schema 对象 |
| D7 | 标题行/分隔符行 | 不支持，简化处理 |
| D8 | 多 mddb 块关系 | 同 `@table` 名 → 追加数据；不同名 → 独立表 |
| D9 | 指令区/数据区分隔 | 不需要 `---`，`@` 开头即指令，其余即数据 |
| D10 | 外部 Schema 引用 | `@schema` > 围栏信息串 > frontmatter `mddb.use` |
| D11 | Schema 路径解析 | 默认相对 Vault 根，`./` 相对当前文件 |
| D12 | 围栏信息字符串 | 仅 `schema=xxx`，保持简洁 |
| D13 | 空值 vs `@required` | `-` = NULL = 违反 `@required` 约束 |
| D14 | 逻辑主键冲突 | first-write-wins；后期支持 `@on_dup` 扩展 |
| D15 | 错误收集 | `ParseResult { errors, warnings }` + 日志文件 |
| D16 | storage_pk 行号 | 文件绝对物理行号（非数据序号） |
| D17 | 空白处理 | 字段值 `.trim()`，全空白字段视为空值 |

---

## 九、与存储引擎设计文档的关系

| 存储引擎设计文档 | 解析管道设计文档 |
|-----------------|-----------------|
| §一 ~ §八：架构、PK、绑定表、CRUD、写入路径、重扫、WAL、冷启动 | §一 ~ §八：解析流程细节 |
| §九：数据格式规格（B 形式文件格式、Schema 指令、类型列表） | §二 ~ §五：Schema 提取、词法、类型转换、验证（实现细节） |
| §十一：待设计项「解析管道」 | **本文档即为该项的完整设计** |

---

## 十、待设计（后续）

- [ ] 查询引擎：类 SQL/DQL 语法定义、查询优化器
- [ ] 事务模型：跨行/跨文件事务的具体实现
- [ ] 视图层接口：存储引擎暴露给视图层的 API
- [ ] 多文件表：一张表跨多个 `.md` 文件（分区表场景）
- [ ] A 形式（文件即记录）和 C 形式（块即记录）的适配层
- [ ] 键值对格式支持：`key: value` 单行 + 多行两种形式作为 B 形式的补充
- [ ] `@on_dup` 指令：主键冲突策略配置（skip / overwrite / error）
