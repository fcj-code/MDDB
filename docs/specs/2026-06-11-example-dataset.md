# MD-DB 示例数据集：个人记账系统 v1.0

> 日期：2026-06-11
> 用途：完整端到端示例，覆盖单文件单表、单文件多表、全部 12 种类型、三种 PK 策略、ref 外键关联、边缘情况。
> 可复用为 Phase 1-9 的集成测试用例。

---

## 一、语法符号速查

### 1.1 Schema 与数据：两种围栏

MD-DB 使用**两种独立围栏**，解析逻辑各自统一：

| 围栏 | 内容 | 解析方式 |
|------|------|---------|
| ` ```dmdb-schema ` | `@` 指令块（纯 Schema） | 逐行读 `@` 指令 → 构建 Schema 对象 |
| ` ```mddb ` | 数据行块（纯数据） | 逐行切分字段 → 类型转换 → 验证 |

**多表文件关联**：数据块通过 `schema=` 信息串显式声明所属表（` ```mddb schema=table_name `）。单表文件中可省略。

> **关键规则**：`dmdb-schema` 围栏内只放 `@` 指令，`mddb` 围栏内只放数据行。**不支持** YAML frontmatter、HTML 注释、`mddb` 块内混写 `@` 指令和数据行。

### 1.2 文件内符号

| 符号 | 含义 | 位置 |
|------|------|------|
| ` ```dmdb-schema ` | Schema 块开始 | 文件正文 |
| ` ```mddb ` | 数据块开始 | 文件正文 |
| ` ```mddb schema=X` | 显式关联 Schema（多表文件必须） | 文件正文 |
| ` ``` ` | 围栏块结束 | 文件正文 |
| `@table <name>` | 声明表名 | `dmdb-schema` 块内 |
| `@pk <cols>` | 逻辑主键（`(a,b)` 复合 / `name` 单列 / `$uuid` 自动） | `dmdb-schema` 块内 |
| `@fields <a \| b \| c>` | 字段名列表（`\|` 分隔） | `dmdb-schema` 块内 |
| `@types <t1 \| t2 \| t3>` | 字段类型列表（`\|` 分隔） | `dmdb-schema` 块内 |
| `@required <bool \| bool \| ...>` | 必填标记 | `dmdb-schema` 块内 |
| `@sort <(col DIR)>` | 默认排序 | `dmdb-schema` 块内 |
| `@indexes <idx(col)>` | 建议索引 | `dmdb-schema` 块内 |
| `@relations <col -> table.col>` | 外键关系声明 | `dmdb-schema` 块内 |
| `@nullMarker <str>` | 自定义空值标记（默认 `-`） | `dmdb-schema` 块内 |
| `@strict <true\|false>` | 严格模式（默认 false） | `dmdb-schema` 块内 |
| `\|` | 字段分隔符（数据行） | `mddb` 块内 |
| `\\` | 转义：字面量 `\` | `mddb` 块内 |
| `\|` | 转义：字面量 `\|` | `mddb` 块内 |
| `-` | 空值占位符（默认） | `mddb` 块内 |

### 1.3 数据行字段切分规范

`|` 是数据行字段分隔符。**行首和行尾的 `|` 是可选的**，解析器归一化处理：

```
输入行:  | val1 | val2 | val3 |
归一化:  val1 | val2 | val3       ← 去首尾空白 → 去首 |（如有）→ 去尾 |（如有）
切分:    split('|')
清洗:    每段 .trim()             ← 去除段内前后空白
空值:    '' 或 nullMarker → NULL
```

两步等价写法：

```
| 现金 | 3500.00 | 储蓄 | - | 日常随身现金 |   ← 有首尾 |
  现金 | 3500.00 | 储蓄 | - | 日常随身现金     ← 无首尾 |
```

**一个数据行同时只能采用一种风格**，不允许半边有半边无（如 `| val1 | val2` 以 `|` 开头但结尾没有 `|`）。

**与转义的交互**：归一化发生在转义替换之前，因此首尾的 `|` 只能是分隔符，不能在首尾用 `\|` 来表示字面量管道。

### 1.3 内部引擎符号

| 符号 | 格式 | 说明 |
|------|------|------|
| **Storage PK** | `{相对路径}:{行号}:{sha256[:6]}` | 不可变出生证明 |
| **Logical PK** | `@pk` 列值拼接（`:` 连接） | 业务唯一标识 |
| **row_hash** | `SHA256(原始行)[:16]` | 用于写入前冲突检测 |
| **Binding Table** | `_binding` | SQLite 内存表，串起三层主键 |

---

## 二、Vault 目录结构

```
my-finance/                         ← Obsidian Vault 根
├── .obsidian/
│   └── plugins/md-db/cache/
│       ├── binding.db              ← 解析后生成
│       ├── file_hashes.json        ← 解析后生成
│       └── schema_registry.json    ← 解析后生成
├── reference/
│   ├── accounts.md                 ← 单文件单表（YAML frontmatter Schema）
│   ├── categories.md              ← 单文件单表（@ 块内指令 Schema）
│   └── contacts.md                ← 单文件单表（phone/email/boolean/datetime）
├── transactions/
│   └── 2024-06.md                  ← 单文件单表 + 自由文本混合
├── planning/
│   └── budget-2024.md              ← 单文件双表（多 mddb 块）
└── 财务仪表盘.md                    ← 普通笔记，无 mddb 数据
```

### 2.1 表总览

| 表名 | 文件 | 行数 | PK 策略 | Schema 方式 | 关联 |
|------|------|:---:|---------|------------|------|
| `accounts` | `reference/accounts.md` | 6 | 单列 `name` | YAML frontmatter | ← transactions.账户 |
| `categories` | `reference/categories.md` | 9 | 单列 `code` | @ 块内指令 | ← transactions.分类, budget_items.category |
| `contacts` | `reference/contacts.md` | 3 | 自动 `$uuid` | @ 块内指令 | ← transactions.商户（远期） |
| `transactions` | `transactions/2024-06.md` | 13 | 复合 `(日期,金额,商户)` | @ 块内指令 | → accounts, categories |
| `monthly_budgets` | `planning/budget-2024.md` | 2 | 单列 `month` | @ 块内指令 | — |
| `budget_items` | `planning/budget-2024.md` | 5 | 自动 `$uuid` | @ 块内指令 | → categories |

---

## 三、表定义与数据

### 3.1 `accounts` — 账户表

**文件**：`reference/accounts.md`
**模式**：单表单文件，`dmdb-schema` + `mddb` 分离
**PK 策略**：单列业务主键 `name`

````markdown
```dmdb-schema
@table accounts
@pk name
@fields name | balance | type | institution | notes
@types string | decimal(2) | enum(储蓄,信用,投资,电子) | string | text
@required true | true | true | false | false
@sort (type ASC, balance DESC)
@nullMarker -
```

# 账户列表

日常使用的支付账户和储蓄账户汇总。

```mddb
现金 | 3500.00 | 储蓄 | - | 日常随身现金
支付宝 | 12850.50 | 电子 | - | 主要在线支付渠道\|含余额宝自动转入
微信 | 3200.00 | 电子 | - | 红包和转账专用
招商银行 | 45600.00 | 储蓄 | 招商银行 | 工资卡，每月15日入账
招商信用卡 | -2100.00 | 信用 | 招商银行 | 上月账单未还，额度50000
余额宝 | 18000.00 | 投资 | 支付宝 | 七日年化 2.3%
```
````

**解析后的 Schema 对象**：

```json
{
  "table": "accounts",
  "pk": ["name"],
  "fields": ["name", "balance", "type", "institution", "notes"],
  "types": ["string", "decimal(2)", "enum(储蓄,信用,投资,电子)", "string", "text"],
  "required": [true, true, true, false, false],
  "sort": { "field": "type", "dir": "asc" },
  "nullMarker": "-",
  "strict": false
}
```

**解析后的 _binding 表条目**：

| storage_pk | logical_pk | file_path | line_number | row_hash |
|------------|------------|-----------|:---:|----------|
| `reference/accounts.md:17:a1b2c3` | `现金` | `reference/accounts.md` | 17 | `d4e5f6a7b8c9d0e1` |
| `reference/accounts.md:18:d4e5f6` | `支付宝` | `reference/accounts.md` | 18 | `f1a2b3c4d5e6f7a8` |
| `reference/accounts.md:19:a7b8c9` | `微信` | `reference/accounts.md` | 19 | `b9c0d1e2f3a4b5c6` |
| `reference/accounts.md:20:d0e1f2` | `招商银行` | `reference/accounts.md` | 20 | `d7e8f9a0b1c2d3e4` |
| `reference/accounts.md:21:a3b4c5` | `招商信用卡` | `reference/accounts.md` | 21 | `e5f6a7b8c9d0e1f2` |
| `reference/accounts.md:22:d6e7f8` | `余额宝` | `reference/accounts.md` | 22 | `a3b4c5d6e7f8a9b0` |

> **注**：SHA256 哈希值为示意占位符，实际长度为 6 位十六进制（storage_pk）和 16 位十六进制（row_hash）。

**解析后内存 SQLite 用户表 `accounts`**：

| name | balance | type | institution | notes |
|------|---------|------|-------------|-------|
| `现金` | 350000 | `储蓄` | NULL | `日常随身现金` |
| `支付宝` | 1285050 | `电子` | NULL | `主要在线支付渠道\|含余额宝自动转入` |
| `微信` | 320000 | `电子` | NULL | `红包和转账专用` |
| `招商银行` | 4560000 | `储蓄` | `招商银行` | `工资卡，每月15日入账` |
| `招商信用卡` | -210000 | `信用` | `招商银行` | `上月账单未还，额度50000` |
| `余额宝` | 1800000 | `投资` | `支付宝` | `七日年化 2.3%` |

> **注意**：
> - `decimal(2)` 内部存 BIGINT：`3500.00` → `350000`
> - `-` → SQL NULL
> - `\|` → 还原为字面量 `|`

---

### 3.2 `categories` — 收支分类表

**文件**：`reference/categories.md`
**模式**：单表单文件，`dmdb-schema` + `mddb` 分离
**PK 策略**：单列业务主键 `code`

````markdown
```dmdb-schema
@table categories
@pk code
@fields code | name | type | tags | description
@types string | string | enum(支出,收入) | tags | string
@required true | true | true | false | false
@sort (code ASC)
@relations 分类 <- transactions.分类, budget_items.category
```

# 收支分类

分类编码表，被交易记录和预算引用。

```mddb
food | 餐饮 | 支出 | #日常 #高频 | 日常饮食：三餐、外卖、零食饮料
transport | 交通 | 支出 | #日常 #通勤 | 地铁、公交、打车、加油
shopping | 购物 | 支出 | #消费 | 日用品、服装、数码产品
housing | 居住 | 支出 | #固定 | 房租、水电、物业、网费
entertain | 娱乐 | 支出 | #休闲 | 电影、游戏、旅游、聚餐
medical | 医疗 | 支出 | #健康 | 看病、药品、体检、牙科
salary | 工资 | 收入 | #固定 #主要 | 税后月薪
bonus | 奖金 | 收入 | #浮动 | 年终奖、项目奖、绩效
refund | 退款 | 收入 | #浮动 | 购物退款、报销
```
````

---

### 3.3 `transactions` — 六月交易记录

**文件**：`transactions/2024-06.md`
**模式**：单文件单表 + **自由文本混合**（关键边缘情况）
**PK 策略**：复合主键 `(日期, 金额, 商户)`

````markdown
---
created: 2024-07-01
tags: [财务, 月度]
---

# 2024年6月 收支记录

六月上半月开销明显偏高，主要是因为请客吃饭和父亲节礼物。

```dmdb-schema
@table transactions
@pk (日期, 金额, 商户)
@fields 日期 | 金额 | 类型 | 分类 | 账户 | 商户 | 备注 | 标签
@types date | decimal(2) | enum(支出,收入) | ref(categories) | ref(accounts) | string | text | tags
@required true | true | true | true | true | true | false | false
@sort (日期 ASC)
@indexes idx(分类) | idx(账户)
@relations 分类 -> categories.code, 账户 -> accounts.name
```

```mddb
2024-06-01 | -45.00 | 支出 | food | 现金 | 兰州拉面 | 加了一份牛肉 | #午餐
2024-06-01 | -16.50 | 支出 | transport | 支付宝 | 北京地铁 | - | #通勤
2024-06-01 | 15000.00 | 收入 | salary | 招商银行 | 云篆科技 | 五月工资 | #固定收入
```

六月第二周开始控制开支，午餐自带便当。

```mddb
2024-06-02 | -128.00 | 支出 | food | 微信 | 海底捞 | 请李四吃饭，庆祝他升职 | #聚餐 #社交
2024-06-03 | -35.00 | 支出 | food | 支付宝 | 美团外卖 | 宫保鸡丁 + 米饭 | #午餐
2024-06-03 | -200.00 | 支出 | shopping | 支付宝 | 京东 | 蓝牙耳机替换旧的\|右耳不响了 | #数码
```

```mddb
2024-06-05 | -56.00 | 支出 | medical | 微信 | 叮当快药 | 感冒灵 + 板蓝根 | #药品
2024-06-05 | -89.00 | 支出 | food | 微信 | 西贝莜面村 | 家庭聚餐，三菜一汤 | #家庭 #晚餐
```

六月下半月，开始记账后发现餐饮占比过高，刻意减少外出就餐。

```mddb
2024-06-15 | -89.00 | 支出 | food | 微信 | 西贝莜面村 | 家庭聚餐，三菜一汤 | #家庭 #晚餐
2024-06-18 | -12.00 | 支出 | food | 现金 | 沙县小吃 | 拌面 + 扁食 | #午餐
2024-06-20 | -2000.00 | 支出 | housing | 支付宝 | 链家 | 六月房租 | #固定支出
2024-06-22 | -350.00 | 支出 | shopping | 招商信用卡 | 优衣库 | 两件T恤 + 一条短裤 | #服装
2024-06-28 | 500.00 | 收入 | refund | 支付宝 | 京东 | 蓝牙耳机退货退款 | #退款
```

六月总支出约 3015 元，收入 15500 元，结余 12485 元。
餐饮占比过高（约 400 元），七月需要控制。
````

**物理行号对照**（关键：mddb 块外有自由文本）：

```
L1:  ---
L2:  created: 2024-07-01
L3:  tags: [财务, 月度]
L4:  ---
L5:  (空行)
L6:  # 2024年6月 收支记录
L7:  (空行)
L8:  六月上半月开销明显偏高，主要是因为请客吃饭和父亲节礼物。
L9:  (空行)
L10: ```mddb
L11: @table transactions
L12: @pk (日期, 金额, 商户)
L13: @fields 日期 | 金额 | 类型 | 分类 | 账户 | 商户 | 备注 | 标签
L14: @types date | decimal(2) | enum(支出,收入) | ref(categories) | ref(accounts) | string | text | tags
L15: @required true | true | true | true | true | true | false | false
L16: @sort (日期 ASC)
L17: @indexes idx(分类) | idx(账户)
L18: ```
L19: (空行)
L20: ```mddb
L21: 2024-06-01 | -45.00 | 支出 | food | 现金 | 兰州拉面 | 加了一份牛肉 | #午餐
L22: 2024-06-01 | -16.50 | 支出 | transport | 支付宝 | 北京地铁 | - | #通勤
L23: 2024-06-01 | 15000.00 | 收入 | salary | 招商银行 | 云篆科技 | 五月工资 | #固定收入
L24: ```
L25: (空行)
L26: 六月第二周开始控制开支，午餐自带便当。
L27: (空行)
L28: ```mddb
L29: 2024-06-02 | -128.00 | 支出 | food | 微信 | 海底捞 | 请李四吃饭，庆祝他升职 | #聚餐 #社交
L30: 2024-06-03 | -35.00 | 支出 | food | 支付宝 | 美团外卖 | 宫保鸡丁 + 米饭 | #午餐
L31: 2024-06-03 | -200.00 | 支出 | shopping | 支付宝 | 京东 | 蓝牙耳机替换旧的\|右耳不响了 | #数码
L32: ```
L33: (空行)
L34: ```mddb
L35: 2024-06-05 | -56.00 | 支出 | medical | 微信 | 叮当快药 | 感冒灵 + 板蓝根 | #药品
L36: 2024-06-05 | -89.00 | 支出 | food | 微信 | 西贝莜面村 | 家庭聚餐，三菜一汤 | #家庭 #晚餐
L37: ```
L38: (空行)
L39: 六月下半月，开始记账后发现餐饮占比过高，刻意减少外出就餐。
L40: (空行)
L41: ```mddb
L42: 2024-06-15 | -89.00 | 支出 | food | 微信 | 西贝莜面村 | 家庭聚餐，三菜一汤 | #家庭 #晚餐
L43: 2024-06-18 | -12.00 | 支出 | food | 现金 | 沙县小吃 | 拌面 + 扁食 | #午餐
L44: 2024-06-20 | -2000.00 | 支出 | housing | 支付宝 | 链家 | 六月房租 | #固定支出
L45: 2024-06-22 | -350.00 | 支出 | shopping | 招商信用卡 | 优衣库 | 两件T恤 + 一条短裤 | #服装
L46: 2024-06-28 | 500.00 | 收入 | refund | 支付宝 | 京东 | 蓝牙耳机退货退款 | #退款
L47: ```
L48: (空行)
L49: 六月总支出约 3015 元，收入 15500 元，结余 12485 元。
L50: 餐饮占比过高（约 400 元），七月需要控制。
```

**关键结构特征**：
- Schema 指令在第一个 `mddb` 块（L10-L18），只有 `@` 指令，无数据行
- 数据分散在 4 个 `mddb` 块中（L20-L24, L28-L32, L34-L37, L41-L47）
- 所有数据块共享同一个 `@table transactions`（在 L11 已声明）
- 文件包含 YAML frontmatter（L1-L4）、Markdown 标题（L6）、自由文本（L8, L26, L39, L49-L50）
- 数据行分散在非连续的物理行号上（L21-L23, L29-L31, L35-L36, L42-L46）

**解析后的 Schema 对象**：

```json
{
  "table": "transactions",
  "pk": ["日期", "金额", "商户"],
  "fields": ["日期", "金额", "类型", "分类", "账户", "商户", "备注", "标签"],
  "types": ["date", "decimal(2)", "enum(支出,收入)", "ref(categories)", "ref(accounts)", "string", "text", "tags"],
  "required": [true, true, true, true, true, true, false, false],
  "sort": { "field": "日期", "dir": "asc" },
  "relations": [
    { "field": "分类", "targetTable": "categories", "targetField": "code" },
    { "field": "账户", "targetTable": "accounts", "targetField": "name" }
  ],
  "indexes": ["idx(分类)", "idx(账户)"],
  "nullMarker": "-",
  "strict": false
}
```

**解析后的 _binding 表条目**（仅数据行，共 13 条）：

| # | storage_pk | logical_pk | file_path | line | row_hash |
|---|------------|------------|-----------|:---:|----------|
| 1 | `transactions/2024-06.md:21:x1y2z3` | `2024-06-01:-45.00:兰州拉面` | `transactions/2024-06.md` | 21 | `a1a1a1a1a1a1a1a1` |
| 2 | `transactions/2024-06.md:22:a4b5c6` | `2024-06-01:-16.50:北京地铁` | `transactions/2024-06.md` | 22 | `a2a2a2a2a2a2a2a2` |
| 3 | `transactions/2024-06.md:23:d7e8f9` | `2024-06-01:15000.00:云篆科技` | `transactions/2024-06.md` | 23 | `a3a3a3a3a3a3a3a3` |
| 4 | `transactions/2024-06.md:29:a0b1c2` | `2024-06-02:-128.00:海底捞` | `transactions/2024-06.md` | 29 | `a4a4a4a4a4a4a4a4` |
| 5 | `transactions/2024-06.md:30:d3e4f5` | `2024-06-03:-35.00:美团外卖` | `transactions/2024-06.md` | 30 | `a5a5a5a5a5a5a5a5` |
| 6 | `transactions/2024-06.md:31:a6b7c8` | `2024-06-03:-200.00:京东` | `transactions/2024-06.md` | 31 | `a6a6a6a6a6a6a6a6` |
| 7 | `transactions/2024-06.md:35:d9e0f1` | `2024-06-05:-56.00:叮当快药` | `transactions/2024-06.md` | 35 | `a7a7a7a7a7a7a7a7` |
| 8 | `transactions/2024-06.md:36:a2b3c4` | `2024-06-05:-89.00:西贝莜面村` | `transactions/2024-06.md` | 36 | `a8a8a8a8a8a8a8a8` |
| 9 | `transactions/2024-06.md:42:d5e6f7` | `2024-06-15:-89.00:西贝莜面村` | `transactions/2024-06.md` | 42 | `a9a9a9a9a9a9a9a9` |
| 10 | `transactions/2024-06.md:43:a8b9c0` | `2024-06-18:-12.00:沙县小吃` | `transactions/2024-06.md` | 43 | `b0b0b0b0b0b0b0b0` |
| 11 | `transactions/2024-06.md:44:d1e2f3` | `2024-06-20:-2000.00:链家` | `transactions/2024-06.md` | 44 | `b1b1b1b1b1b1b1b1` |
| 12 | `transactions/2024-06.md:45:a4b5c6` | `2024-06-22:-350.00:优衣库` | `transactions/2024-06.md` | 45 | `b2b2b2b2b2b2b2b2` |
| 13 | `transactions/2024-06.md:46:d7e8f9` | `2024-06-28:500.00:京东` | `transactions/2024-06.md` | 46 | `b3b3b3b3b3b3b3b3` |

**解析后内存 SQLite 用户表 `transactions`**（展示关键行）：

| 日期 | 金额(内部) | 类型 | 分类 | 账户 | 商户 | 备注 | 标签 |
|------|:---:|------|------|------|------|------|------|
| `2024-06-01` | -4500 | `支出` | `food` | `现金` | `兰州拉面` | `加了一份牛肉` | `["午餐"]` |
| `2024-06-01` | -1650 | `支出` | `transport` | `支付宝` | `北京地铁` | NULL | `["通勤"]` |
| `2024-06-01` | 1500000 | `收入` | `salary` | `招商银行` | `云篆科技` | `五月工资` | `["固定收入"]` |
| `2024-06-02` | -12800 | `支出` | `food` | `微信` | `海底捞` | `请李四吃饭，庆祝他升职` | `["聚餐","社交"]` |
| `2024-06-03` | -3500 | `支出` | `food` | `支付宝` | `美团外卖` | `宫保鸡丁 + 米饭` | `["午餐"]` |
| `2024-06-03` | -20000 | `支出` | `shopping` | `支付宝` | `京东` | `蓝牙耳机替换旧的\|右耳不响了` | `["数码"]` |
| `2024-06-28` | 50000 | `收入` | `refund` | `支付宝` | `京东` | `蓝牙耳机退货退款` | `["退款"]` |

> **注意**：
> - L22 备注 `-` → SQL NULL
> - L31 备注含 `\|` → 还原为 `蓝牙耳机替换旧的|右耳不响了`
> - `decimal(2)`：`-45.00` → `-4500`，`15000.00` → `1500000`
> - `tags`：`#午餐` → `["午餐"]`，`#聚餐 #社交` → `["聚餐","社交"]`

---

### 3.4 `budget-2024.md` — 预算表（单文件双表）

**文件**：`planning/budget-2024.md`
**模式**：**单文件多表**（两个 `@table` 声明）
**PK 策略**：单列 `month` + 自动 `$uuid`

````markdown
---
created: 2024-01-01
---

# 2024年预算

## 月度总预算

```mddb
@table monthly_budgets
@pk month
@fields month | total_budget | actual_spent | status
@types string | decimal(2) | decimal(2) | enum(on_track,over,warning)
@required true | true | false | false
@sort (month ASC)
@null_marker -
```

```mddb
2024-01 | 8000.00 | 7650.50 | on_track
2024-06 | 8000.00 | - | on_track
```

## 分类预算明细

```mddb
@table budget_items
@pk $uuid
@fields category | month | amount | spent | remain
@types ref(categories) | string | decimal(2) | decimal(2) | decimal(2)
@required true | true | true | false | false
@sort (category ASC)
```

```mddb
- | food | 2024-01 | 2000.00 | 1890.00 | 110.00
- | transport | 2024-01 | 500.00 | 425.50 | 74.50
- | food | 2024-06 | 2000.00 | - | 2000.00
- | housing | 2024-06 | 2500.00 | - | 2500.00
- | shopping | 2024-06 | 1500.00 | - | 1500.00
```
````

**物理行号对照**：

```
L1:  ---
L2:  created: 2024-01-01
L3:  ---
L4:  (空行)
L5:  # 2024年预算
L6:  (空行)
L7:  ## 月度总预算
L8:  (空行)
L9:  ```mddb
L10: @table monthly_budgets
L11: @pk month
L12: @fields month | total_budget | actual_spent | status
L13: @types string | decimal(2) | decimal(2) | enum(on_track,over,warning)
L14: @required true | true | false | false
L15: @sort (month ASC)
L16: @null_marker -
L17: ```
L18: (空行)
L19: ```mddb
L20: 2024-01 | 8000.00 | 7650.50 | on_track
L21: 2024-06 | 8000.00 | - | on_track
L22: ```
L23: (空行)
L24: ## 分类预算明细
L25: (空行)
L26: ```mddb
L27: @table budget_items
L28: @pk $uuid
L29: @fields category | month | amount | spent | remain
L30: @types ref(categories) | string | decimal(2) | decimal(2) | decimal(2)
L31: @required true | true | true | false | false
L32: @sort (category ASC)
L33: ```
L34: (空行)
L35: ```mddb
L36: - | food | 2024-01 | 2000.00 | 1890.00 | 110.00
L37: - | transport | 2024-01 | 500.00 | 425.50 | 74.50
L38: - | food | 2024-06 | 2000.00 | - | 2000.00
L39: - | housing | 2024-06 | 2500.00 | - | 2500.00
L40: - | shopping | 2024-06 | 1500.00 | - | 1500.00
L41: ```
```

**表 1：`monthly_budgets` 的 Schema**：

```json
{
  "table": "monthly_budgets",
  "pk": ["month"],
  "fields": ["month", "total_budget", "actual_spent", "status"],
  "types": ["string", "decimal(2)", "decimal(2)", "enum(on_track,over,warning)"],
  "required": [true, true, false, false],
  "sort": { "field": "month", "dir": "asc" },
  "nullMarker": "-",
  "strict": false
}
```

**表 2：`budget_items` 的 Schema**：

```json
{
  "table": "budget_items",
  "pk": ["$uuid"],
  "fields": ["category", "month", "amount", "spent", "remain"],
  "types": ["ref(categories)", "string", "decimal(2)", "decimal(2)", "decimal(2)"],
  "required": [true, true, true, false, false],
  "sort": { "field": "category", "dir": "asc" },
  "nullMarker": "-",
  "strict": false
}
```

**$uuid PK 行为**：
- 数据行第一列（`category`）写 `-` 是占位符，不是 PK 值
- 引擎解析时检测到 `@pk $uuid`，自动生成 UUID 作为 logical_pk
- storage_pk 仍基于物理行号 + 原始行哈希

**解析后的 _binding 表条目**（同一文件、两张表混合）：

| table_name | storage_pk | logical_pk | file_path | line |
|------------|------------|------------|-----------|:---:|
| `monthly_budgets` | `planning/budget-2024.md:20:m1m1m1` | `2024-01` | `planning/budget-2024.md` | 20 |
| `monthly_budgets` | `planning/budget-2024.md:21:m2m2m2` | `2024-06` | `planning/budget-2024.md` | 21 |
| `budget_items` | `planning/budget-2024.md:36:b1b1b1` | `uuid-c8a7-4f3b-a1b2` | `planning/budget-2024.md` | 36 |
| `budget_items` | `planning/budget-2024.md:37:b2b2b2` | `uuid-d9b8-5e4c-c2d3` | `planning/budget-2024.md` | 37 |
| `budget_items` | `planning/budget-2024.md:38:b3b3b3` | `uuid-e0c9-6f5d-d3e4` | `planning/budget-2024.md` | 38 |
| `budget_items` | `planning/budget-2024.md:39:b4b4b4` | `uuid-f1d0-7g6e-e4f5` | `planning/budget-2024.md` | 39 |
| `budget_items` | `planning/budget-2024.md:40:b5b5b5` | `uuid-g2e1-8h7f-f5g6` | `planning/budget-2024.md` | 40 |

> **关键设计点**：`_binding` 表需要 `table_name` 列来区分同一文件内的不同表。

---

### 3.5 `contacts` — 联系人表（新增类型覆盖）

**文件**：`reference/contacts.md`
**模式**：单表单文件，`dmdb-schema` + `mddb` 分离
**PK 策略**：自动 `$uuid`（PK 不在字段列表，引擎自动生成）

````markdown
```dmdb-schema
@table contacts
@pk $uuid
@fields name | phone | email | is_favorite | birthday | notes
@types string | phone | email | boolean | date | text
@required true | false | false | false | false | false
@sort (name ASC)
@relations 联系人 <- transactions.商户
```

# 联系人

被交易记录引用，关联付款对象。

```mddb
张三 | 138-1234-5678 | zhangsan@example.com | true | 1990-05-15 | 大学室友，经常聚餐
李四 | 13987654321 | lisi@company.cn | 否 | 1988-11-20 | 前同事，偶尔约饭
王小明 | 18611112222 | wxm@email.cn | true | 1995-03-08 | 表弟，经常一起打游戏
```
````

**新增类型覆盖**：

| 类型 | 示例值 | 内部存储 |
|------|--------|---------|
| `phone` | `138-1234-5678` → `13812345678` | `13812345678` (TEXT) |
| `email` | `zhangsan@example.com` | `zhangsan@example.com` (TEXT) |
| `boolean` | `true`, `否` | `1`, `0` (INTEGER) |
| `date` | `1990-05-15` | `1990-05-15` (TEXT) |

**解析后的 Schema 对象**：

```json
{
  "table": "contacts",
  "pk": ["$uuid"],
  "fields": ["name", "phone", "email", "is_favorite", "birthday", "notes"],
  "types": ["string", "phone", "email", "boolean", "date", "text"],
  "required": [true, false, false, false, false, false],
  "sort": { "field": "name", "dir": "asc" },
  "relations": [
    { "field": "商户", "targetTable": "contacts", "direction": "incoming", "fromTable": "transactions" }
  ],
  "nullMarker": "-",
  "strict": false
}
```

---

## 四、全局内部状态

### 4.1 `schema_registry.json`（解析后生成）

```json
{
  "version": 1,
  "tables": {
    "accounts": {
      "file": "reference/accounts.md",
      "pk": ["name"],
      "fields": ["name", "balance", "type", "institution", "notes"],
      "types": ["string", "decimal(2)", "enum(储蓄,信用,投资,电子)", "string", "text"],
      "required": [true, true, true, false, false],
      "sort": "type ASC",
      "nullMarker": "-",
      "rowCount": 6
    },
    "categories": {
      "file": "reference/categories.md",
      "pk": ["code"],
      "fields": ["code", "name", "type", "tags", "description"],
      "types": ["string", "string", "enum(支出,收入)", "tags", "string"],
      "required": [true, true, true, false, false],
      "sort": "code ASC",
      "nullMarker": "-",
      "rowCount": 9
    },
    "contacts": {
      "file": "reference/contacts.md",
      "pk": ["$uuid"],
      "fields": ["name", "phone", "email", "is_favorite", "birthday", "notes"],
      "types": ["string", "phone", "email", "boolean", "date", "text"],
      "required": [true, false, false, false, false, false],
      "sort": "name ASC",
      "nullMarker": "-",
      "rowCount": 3
    },
    "transactions": {
      "file": "transactions/2024-06.md",
      "pk": ["日期", "金额", "商户"],
      "fields": ["日期", "金额", "类型", "分类", "账户", "商户", "备注", "标签"],
      "types": ["date", "decimal(2)", "enum(支出,收入)", "ref(categories)", "ref(accounts)", "string", "text", "tags"],
      "required": [true, true, true, true, true, true, false, false],
      "sort": "日期 ASC",
      "indexes": ["idx(分类)", "idx(账户)"],
      "nullMarker": "-",
      "rowCount": 13
    },
    "monthly_budgets": {
      "file": "planning/budget-2024.md",
      "pk": ["month"],
      "fields": ["month", "total_budget", "actual_spent", "status"],
      "types": ["string", "decimal(2)", "decimal(2)", "enum(on_track,over,warning)"],
      "required": [true, true, false, false],
      "sort": "month ASC",
      "nullMarker": "-",
      "rowCount": 2
    },
    "budget_items": {
      "file": "planning/budget-2024.md",
      "pk": ["$uuid"],
      "fields": ["category", "month", "amount", "spent", "remain"],
      "types": ["ref(categories)", "string", "decimal(2)", "decimal(2)", "decimal(2)"],
      "required": [true, true, true, false, false],
      "sort": "category ASC",
      "nullMarker": "-",
      "rowCount": 5
    }
  }
}
```

> 注意：`planning/budget-2024.md` 在 registry 中出现两次（两张表共享同一文件）。

### 4.2 `file_hashes.json`（解析后生成）

```json
{
  "reference/accounts.md": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "reference/categories.md": "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
  "reference/contacts.md": "d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
  "transactions/2024-06.md": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  "planning/budget-2024.md": "58e53f1d8b6a4c8e7f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1"
}
```

### 4.3 完整 `_binding` 表（SQLite 内存，共 35 行）

```sql
SELECT table_name, storage_pk, logical_pk, file_path, line_number
FROM _binding ORDER BY file_path, line_number;
```

| table_name | storage_pk | logical_pk | file_path | line |
|------------|------------|------------|-----------|:---:|
| `accounts` | `reference/accounts.md:11:a1b2c3` | `现金` | `reference/accounts.md` | 11 |
| `accounts` | `reference/accounts.md:12:d4e5f6` | `支付宝` | `reference/accounts.md` | 12 |
| `accounts` | `reference/accounts.md:13:a7b8c9` | `微信` | `reference/accounts.md` | 13 |
| `accounts` | `reference/accounts.md:14:d0e1f2` | `招商银行` | `reference/accounts.md` | 14 |
| `accounts` | `reference/accounts.md:15:a3b4c5` | `招商信用卡` | `reference/accounts.md` | 15 |
| `accounts` | `reference/accounts.md:16:d6e7f8` | `余额宝` | `reference/accounts.md` | 16 |
| `categories` | `reference/categories.md:14:c1c1c1` | `food` | `reference/categories.md` | 14 |
| `categories` | `reference/categories.md:15:c2c2c2` | `transport` | `reference/categories.md` | 15 |
| `contacts` | `reference/contacts.md:14:n1n1n1` | `uuid-xxx-张三` | `reference/contacts.md` | 14 |
| … | … | … | … | … |
| `monthly_budgets` | `planning/budget-2024.md:20:m1m1m1` | `2024-01` | `planning/budget-2024.md` | 20 |
| `monthly_budgets` | `planning/budget-2024.md:21:m2m2m2` | `2024-06` | `planning/budget-2024.md` | 21 |
| `budget_items` | `planning/budget-2024.md:36:b1b1b1` | `uuid-c8a7-4f3b-a1b2` | `planning/budget-2024.md` | 36 |
| … | … | … | … | … |

---

## 五、类型覆盖矩阵

本示例数据集覆盖了设计文档中**全部 12 种**字段类型：

| 类型 | 出现位置 | 示例值 | 边缘情况 |
|------|---------|--------|---------|
| `string` | accounts.name, categories.code, contacts.name | `支付宝`, `food`, `张三` | — |
| `integer` | （本期未使用） | — | 待补充 |
| `decimal(2)` | accounts.balance, transactions.金额 | `12850.50` → `1285050` | 负数、零、大额 |
| `boolean` | contacts.is_favorite | `true`, `否` → `1`, `0` | 多语言布尔值 |
| `date` | transactions.日期, contacts.birthday | `2024-06-01`, `1990-05-15` | — |
| `datetime` | （本期未使用） | — | 待补充 |
| `enum(…)` | accounts.type, categories.type, transactions.类型 | `储蓄`, `支出` | — |
| `text` | accounts.notes, transactions.备注, contacts.notes | `主要在线支付渠道\|含余额宝自动转入` | 转义还原 |
| `tags` | categories.tags, transactions.标签 | `#日常 #高频` → `["日常","高频"]` | 空 → `[]` |
| `ref(table)` | transactions.分类, transactions.账户, budget_items.category | `food`, `现金` | 延迟验证 |
| `phone` | contacts.phone | `138-1234-5678` → `13812345678` | 多种分隔符 |
| `email` | contacts.email | `zhangsan@example.com` | 大小写规范化 |

> `integer` 和 `datetime` 为仅剩的两种未覆盖类型，可在后续补充。

---

## 六、查询示例（对应 Phase 15 QueryEngine）

### 6.1 查看六月所有支出，按金额降序

```typescript
const q: Query = {
  table: 'transactions',
  filter: {
    logic: 'and',
    conditions: [
      { field: '类型', op: '=', value: '支出' }
    ]
  },
  sort: [{ field: '金额', dir: 'asc' }],  // BIGINT: -200000 < -12800 < -4500
  select: { fields: ['日期', '金额', '分类', '商户'] }
};
// → 12 行支出，金额升序（-2000.00 → -12.00）
```

### 6.2 查看餐饮 + 交通支出，展开分类名称

```typescript
const q: Query = {
  table: 'transactions',
  filter: {
    logic: 'or',
    conditions: [
      { field: '分类', op: '=', value: 'food' },
      { field: '分类', op: '=', value: 'transport' }
    ]
  },
  followRefs: [
    { field: '分类', include: ['name', 'type'], prefix: 'cat' }
  ]
};
// → cat_name 列显示 "餐饮"/"交通"
```

### 6.3 本月预算执行情况

```typescript
const q: Query = {
  table: 'monthly_budgets',
  filter: {
    logic: 'and',
    conditions: [
      { field: 'month', op: '=', value: '2024-06' }
    ]
  }
};
// → { month: "2024-06", total_budget: "8000.00", actual_spent: null, status: "on_track" }
```

---

## 七、Phase 测试覆盖矩阵

| Phase | 测试场景 | 数据来源 |
|-------|---------|---------|
| Phase 1 | Schema 对象构造、错误码枚举完整性 | 全部 5 张表的 Schema |
| Phase 2 | SQLite 建表、Storage PK 生成、缓存写入 | accounts (最简) |
| Phase 3 | 四种 Schema 来源解析、合并优先级 | budget-2024 (单文件双表) |
| Phase 4 | 转义切分、空值检测、多块追加 | transactions (多块 + 转义 + 自由文本) |
| Phase 5 | 类型转换、decimal 精度、严格/宽松模式 | accounts (decimal) + categories (tags) |
| Phase 6 | 字段数校验、必填、PK 唯一性、ref 延迟验证 | transactions (复合 PK + ref + 必填) |
| Phase 7 | 绑定表写入、用户表 DDL 自动生成 | budget-2024 (单文件双表) |
| Phase 8 | 端到端 `parseFile()` + `parseAllFiles()` | 整个 Vault |
| Phase 9 | INSERT/DELETE/UPDATE 行级操作 | accounts (单列 PK 最简) |
| Phase 15 | Query → SQL 生成、ref 跟随、聚合、分页 | transactions (复合查询) |
| Phase 16 | 单文件事务、跨文件事务、冲突检测 | budget-2024 (单文件双表事务) |

### 边界条件测试矩阵

| 边界条件 | 文件 | 行号 | 说明 |
|---------|------|:---:|------|
| 转义管道符 `\|` | accounts.md | L12 | `主要在线支付渠道\|含余额宝自动转入` |
| 转义管道符 `\|` | transactions/2024-06.md | L31 | `蓝牙耳机替换旧的\|右耳不响了` |
| NULL 占位符 `-` | accounts.md | L11-L13 | institution 字段 |
| NULL 占位符 `-` | transactions/2024-06.md | L22 | 备注字段 |
| NULL 占位符在 PK 位置 | budget-2024.md | L36-L40 | `$uuid` 自动生成，首列 `-` 是数据非 PK |
| 负数 decimal | accounts.md | L15 | `招商信用卡 balance = -2100.00` |
| 复合主键 | transactions/2024-06.md | L21-L23 | `(日期, 金额, 商户)` |
| 多 mddb 块追加 | transactions/2024-06.md | 4 个数据块 | 共 13 行，分散在非连续行号 |
| 空 mddb 块（仅指令） | transactions/2024-06.md | L10-L18 | 只有 `@` 指令，无数据行 |
| 单文件多表 | budget-2024.md | 2 个 @table | `monthly_budgets` + `budget_items` |
| YAML frontmatter | transactions/2024-06.md | L1-L4 | 文件元数据 |
| 自由文本包围 | transactions/2024-06.md | L6, L8, L26, L39 | Markdown 标题和段落 |
| 同商户不同日期 | transactions/2024-06.md | L35 vs L42 | 西贝莜面村（复合 PK 不冲突） |

---

## 八、修正后的 `_binding` DDL

基于「一个文件可含多张表」的模型，需要增加 `table_name` 列：

```sql
CREATE TABLE _binding (
  storage_pk    TEXT PRIMARY KEY,
  logical_pk    TEXT NOT NULL,
  table_name    TEXT NOT NULL,       -- ← 新增：支持单文件多表
  file_path     TEXT NOT NULL,
  line_number   INTEGER NOT NULL,
  row_hash      TEXT NOT NULL,
  last_verified TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_binding_logical ON _binding(logical_pk, table_name);
--                                                    ↑ 复合唯一：同表内逻辑 PK 唯一
CREATE INDEX idx_binding_file ON _binding(file_path, line_number);
CREATE INDEX idx_binding_table ON _binding(table_name);
```

**变更说明**：
- 新增 `table_name` 列：标识该行所属的表
- `idx_binding_logical` 改为 `(logical_pk, table_name)` 联合唯一索引：不同表可以有相同的 logical_pk
- 新增 `idx_binding_table`：按表名快速检索所有行

**向后兼容**：对于单文件单表场景，`table_name` = 从 `@table` 声明中提取的表名。Phase 2 建表 DDL 应使用此修正版本。
