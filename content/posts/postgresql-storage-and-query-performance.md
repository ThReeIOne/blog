---
title: "PostgreSQL 数据存储大小与查询效率：从字段到亿级表的完整指南"
date: "2026-03-27"
tags: ["数据库", "PostgreSQL", "性能优化"]
summary: "一个 INT 占几字节，一条 JSONB 记录多大，表到多少行开始变慢，索引能撑到多大——这些问题在设计阶段很少有人认真算，等出了问题才去翻文档。这篇文章把 PostgreSQL 存储大小和查询效率的关键数字整理在一起，从字段级别到亿级表，给你一套可以参考的心理模型。"
---

做系统设计的时候，数据库这块通常是这样的：

"字段类型用 VARCHAR 还是 TEXT？随便，TEXT 吧，省事。"
"这张表会有多少数据？不知道，先建着再说。"
"要不要加索引？加吧，加了肯定没坏处。"

这些决策单独看都没什么大问题，但当数据量真的上来之后，你会发现很多"当时没在意"的细节开始影响查询性能。

这篇文章把 PostgreSQL 存储大小和查询效率的关键数字整理出来，从单个字段的字节数，到表行数达到什么量级开始需要关注，给你一套可以参考的心理模型。

---

## 一、字段级别：每种类型占多大

### 数值类型

| 类型 | 存储大小 | 范围 | 适用场景 |
|------|----------|------|----------|
| `SMALLINT` | 2 字节 | -32768 ~ 32767 | 枚举值、状态码 |
| `INTEGER` / `INT` | 4 字节 | -2.1亿 ~ 2.1亿 | 通用 ID、计数 |
| `BIGINT` | 8 字节 | ±922亿亿 | 雪花 ID、时间戳 ID |
| `SERIAL` | 4 字节 | 同 INTEGER | 自增主键 |
| `BIGSERIAL` | 8 字节 | 同 BIGINT | 大表自增主键 |
| `REAL` | 4 字节 | 6位有效数字 | 浮点数（精度要求不高） |
| `DOUBLE PRECISION` | 8 字节 | 15位有效数字 | 精度要求高的浮点 |
| `NUMERIC(p, s)` | 变长，约 2 字节 + 每 4 位数字 2 字节 | 任意精度 | 金额、汇率（不能有精度损失） |

**几个常见误区：**

`NUMERIC` 存金额是对的，但它是变长类型，比固定长度的 `INTEGER` 或 `BIGINT` 慢，也更占空间。如果金额单位是"分"，用 `BIGINT` 存整数分值是更好的选择。

`REAL` 和 `DOUBLE PRECISION` 都是浮点数，有精度问题：
```sql
SELECT 0.1 + 0.2::real;
-- 结果：0.30000001192093  ← 精度丢失
```
存钱绝对不能用浮点，只能用 `NUMERIC` 或 `BIGINT`。

---

### 字符类型

| 类型 | 存储大小 | 说明 |
|------|----------|------|
| `CHAR(n)` | 固定 n 字节 | 不足 n 位用空格填充，几乎不用 |
| `VARCHAR(n)` | 实际长度 + 1~4 字节 header | 有长度限制 |
| `TEXT` | 实际长度 + 1~4 字节 header | 无长度限制 |

**PostgreSQL 里 VARCHAR 和 TEXT 性能没有区别。** 这和 MySQL 不同——MySQL 里 VARCHAR 和 TEXT 底层存储机制不同，TEXT 有额外开销。PostgreSQL 里两者完全一样，VARCHAR(n) 只是多了个长度检查约束。

所以 PostgreSQL 推荐的做法是：**直接用 TEXT，如果有业务上的长度限制再加 CHECK 约束**。

短字符串（< 2KB）直接存在行内；超过约 2KB 的字段会触发 **TOAST**（The Oversized-Attribute Storage Technique），数据会被压缩并存到独立的 TOAST 表里，主表只存一个指针。这个过程是透明的，但会有额外 I/O 开销。

实际占用计算：
- `'hello'` 这个字符串存为 TEXT：5 字节内容 + 1 字节 header = 6 字节
- 一个 36 字符的 UUID 字符串：36 字节 + 1 字节 header = 37 字节
- 对比 `UUID` 类型（见下）：16 字节

---

### 时间类型

| 类型 | 存储大小 | 精度 | 说明 |
|------|----------|------|------|
| `DATE` | 4 字节 | 天 | 只存日期，不存时间 |
| `TIMESTAMP` | 8 字节 | 微秒 | 不含时区，危险 |
| `TIMESTAMPTZ` | 8 字节 | 微秒 | 含时区，推荐 |
| `TIME` | 8 字节 | 微秒 | 只存时间 |
| `INTERVAL` | 16 字节 | 微秒 | 时间段 |

**强烈推荐用 `TIMESTAMPTZ` 而不是 `TIMESTAMP`。**

两者存储大小一样（都是 8 字节），但 `TIMESTAMP` 不存时区信息，存进去是什么就是什么。而 `TIMESTAMPTZ` 在存储时统一转成 UTC，读取时根据会话时区转换输出。

跨时区系统、夏令时、服务迁移，都可能让 `TIMESTAMP` 上存的数据难以正确解读。代价呢？一分钱没有，大小一样。没有理由不用 `TIMESTAMPTZ`。

---

### UUID 类型

| 类型 | 存储大小 | 说明 |
|------|----------|------|
| `UUID` | 16 字节 | 原生 UUID 类型 |
| `TEXT` 存 UUID | 37 字节 | 多了一倍多 |

PostgreSQL 有原生 `UUID` 类型，16 字节，不要用字符串存 UUID。

```sql
-- 好：16 字节
id UUID DEFAULT gen_random_uuid()

-- 差：37 字节，还不能用 UUID 相关函数
id TEXT DEFAULT gen_random_uuid()::text
```

---

### JSONB 类型

这个是重点。`JSONB` 在 PostgreSQL 里非常流行，但很多人对它的实际大小没有直观感受。

**存储机制：**
- `JSON`：原文存储，保留原始格式（含空格、换行），写入快，查询慢
- `JSONB`：解析后以二进制格式存储，有额外开销，写入略慢，查询快，支持索引

实际大小的经验规律：**JSONB 通常比等价的 JSON 文本大 10%~30%，比单独字段建模大 20%~50%**。

用一个真实例子感受一下：

```sql
-- 建个测试表
CREATE TABLE test_jsonb AS
SELECT 
    i AS id,
    jsonb_build_object(
        'name', 'campaign_' || i,
        'budget', (random() * 100000)::int,
        'status', (ARRAY['active','paused','ended'])[floor(random()*3+1)],
        'tags', jsonb_build_array('tag1', 'tag2'),
        'created_at', now()
    ) AS data
FROM generate_series(1, 100000) i;

-- 看平均每行 JSONB 的大小
SELECT avg(pg_column_size(data)) AS avg_jsonb_bytes FROM test_jsonb;
-- 结果约：165 字节/行
```

对比等价的正规化建模：

```sql
-- 单独建字段
name TEXT          -- 约 14 字节
budget INTEGER     -- 4 字节
status TEXT        -- 约 8 字节
tags TEXT[]        -- 约 30 字节
created_at TIMESTAMPTZ -- 8 字节
-- 合计约 64 字节/行
```

同样的数据，JSONB 约 165 字节，正规化建模约 64 字节——**JSONB 大了将近 2.6 倍**。

这个差距在小数据量下无所谓，但如果有 1000 万行：
- 正规化：约 640 MB
- JSONB：约 1.65 GB

---

### JSONB 什么时候用，什么时候不用

先说清楚一点：**JSONB 的查询不是"慢"，而是和正规化建模相比，在不同场景下各有优劣。**

JSONB 本身是二进制存储，查询时不需要解析原始文本，比 `JSON` 类型快很多。配合 GIN 索引，任意 key/value 搜索都很高效。但它比不过正规化建模的场景，是在**字段固定、高频做聚合计算**的情况下。

| 查询类型 | JSONB | 普通列 |
|----------|-------|--------|
| 任意 key 存在性检查 | ✅ GIN 索引，快 | ❌ 无法直接实现 |
| 任意 key/value 搜索 | ✅ 一个 GIN 索引搞定 | ❌ 需要针对每列建索引 |
| 固定字段等值查询 | 🟡 表达式索引可以，但开销比 B-tree 大 | ✅ B-tree 索引更快更省 |
| SUM / AVG 等聚合 | ❌ 每行需要反序列化 JSONB | ✅ 直接计算，快 |
| 结构灵活、行间差异大 | ✅ 天然适合 | ❌ 需要大量 NULL 字段或多表 |

**适合用 JSONB：**
- 字段结构不固定，不同行的 JSON 内容差异很大
- 需要灵活扩展，未来字段会增加
- 半结构化数据，查询模式多变（用 GIN 索引覆盖）

**不适合用 JSONB：**
- 字段固定，且频繁做聚合计算（SUM/AVG/GROUP BY）——正规化建模更高效
- 存储空间敏感的大表（JSONB 比正规化大 1.5~3 倍）
- 每次只查 JSONB 内固定的几个 key——直接建列加 B-tree 索引更快

**一个常见的错误设计：**

```sql
-- 常见但有问题：把所有扩展字段丢进 extra
CREATE TABLE campaigns (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    extra JSONB    -- budget, status, tags, 所有东西都在这里
);
```

看起来灵活，实际上 `WHERE extra->>'status' = 'active'` 这种查询要么全表扫描，要么需要建 GIN 索引（有额外开销）。把频繁查询的字段单独建列，才是正确姿势。

---

## 二、行级别：一行数据实际多大

知道字段大小还不够，PostgreSQL 每行还有自己的 overhead。

**每行的固定开销：23 字节**

这是 PostgreSQL 行头（HeapTupleHeader）的固定大小，包含：
- 事务 ID（xmin/xmax）：8 字节
- 行指针信息：4 字节
- 系统字段（ctid、tableoid 等）：11 字节

**对齐 padding：**

PostgreSQL 会对字段做内存对齐，不同字段组合会有不同的 padding 浪费：

```sql
-- 糟糕的字段顺序，padding 浪费严重
CREATE TABLE bad_order (
    a BOOLEAN,     -- 1 字节 + 7 字节 padding
    b BIGINT,      -- 8 字节
    c BOOLEAN,     -- 1 字节 + 7 字节 padding
    d BIGINT       -- 8 字节
);
-- 实际占用：1+7+8+1+7+8 = 32 字节（数据本身才 18 字节）

-- 好的字段顺序：大字段放前面
CREATE TABLE good_order (
    b BIGINT,      -- 8 字节
    d BIGINT,      -- 8 字节
    a BOOLEAN,     -- 1 字节
    c BOOLEAN      -- 1 字节 + 6 字节 padding（行末尾）
);
-- 实际占用：8+8+1+1+6 = 24 字节
```

字段顺序优化不是必须的，但在行数很大的表上可以节省 10%~20% 的存储。

**估算一行的实际大小：**

```sql
-- 查看单行占用（不含 TOAST 外存数据）
SELECT pg_column_size(t.*) FROM your_table t LIMIT 1;

-- 查看表的平均行大小
SELECT 
    relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    n_live_tup AS row_count,
    pg_size_pretty(pg_total_relation_size(relid) / NULLIF(n_live_tup, 0)) AS avg_row_size
FROM pg_stat_user_tables
WHERE relname = 'your_table';
```

---

## 三、表级别：数据量到多少开始需要关注

这是最实用的部分，直接给出经验阈值。

### 阶段一：< 100 万行——基本不用担心

这个量级下，只要有基本的主键索引，查询通常在毫秒级。全表扫描也快，甚至比走索引还快（PostgreSQL 的查询优化器会自动选择）。

这个阶段的优化方向：**写出正确的 SQL，加上必要的索引，别过度优化**。

### 阶段二：100 万 ~ 1000 万行——索引开始变关键

```
表大小（假设平均行 200 字节）：
100万行 ≈ 200MB
500万行 ≈ 1GB
1000万行 ≈ 2GB
```

这个量级下：
- **没有索引的查询**：开始出现明显慢查询，全表扫描 500MB 的表可能需要几秒
- **有合适索引**：高选择性查询依然毫秒级
- **排序 + 分页**：`OFFSET` 很大时开始变慢（后面详说）

需要开始关注的点：
- 频繁查询的字段是否有索引
- JOIN 的字段是否有索引
- 是否有不必要的全表扫描

### 阶段三：1000 万 ~ 1 亿行——架构开始成为瓶颈

```
表大小：
1000万行 ≈ 2GB
5000万行 ≈ 10GB
1亿行 ≈ 20GB
```

这个量级下，**索引本身的大小也开始变得重要**：

```sql
-- 查看表和索引的大小分布
SELECT
    relname,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_indexes_size(relid)) AS indexes_size,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

典型输出：
```
 table_name  | table_size | indexes_size | total_size
-------------+------------+--------------+------------
 campaigns   | 18 GB      | 6 GB         | 24 GB
```

索引可以占到表总大小的 20%~40%，索引太多会：
1. 拖慢写入速度（每次写入都要更新所有索引）
2. 占用更多内存（索引需要缓存在 shared_buffers 里才快）

这个阶段需要考虑的事情：
- **分区表**：按时间或业务维度分区，让查询只扫描相关分区
- **删除无用索引**：用 `pg_stat_user_indexes` 检查索引使用频率
- **归档冷数据**：把历史数据移到归档表或别的存储

### 阶段四：> 1 亿行——需要专门设计

这个量级下，单表 PostgreSQL 依然能撑，但需要专门设计：

- **分区是必须的**，不是可选的
- **VACUUM 成本很高**，需要合理配置 autovacuum
- **`OFFSET` 分页完全不可用**，需要改用游标分页
- 考虑读写分离、连接池代理（PgBouncer）

```sql
-- 按时间分区示例
CREATE TABLE campaigns (
    id BIGSERIAL,
    created_at TIMESTAMPTZ NOT NULL,
    name TEXT,
    budget INTEGER
) PARTITION BY RANGE (created_at);

CREATE TABLE campaigns_2025 
    PARTITION OF campaigns
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

CREATE TABLE campaigns_2026
    PARTITION OF campaigns
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
```

分区后，`WHERE created_at >= '2026-01-01'` 这样的查询只会扫 2026 分区，无论总数据量多大。

---

## 四、查询效率的几个关键拐点

### OFFSET 分页：数据量大了是个坑

```sql
-- 看起来没问题，实际上是 O(n) 操作
SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 20 OFFSET 10000;
```

PostgreSQL 的 OFFSET 实现是：先扫描前 10020 行，扔掉前 10000 行，返回最后 20 行。OFFSET 越大，扫描的行越多。

**1000 万行的表，OFFSET 到 50 万时，这条查询可能要跑几秒。**

**替代方案：游标分页（Keyset Pagination）**

```sql
-- 第一页
SELECT * FROM campaigns 
ORDER BY created_at DESC, id DESC 
LIMIT 20;

-- 下一页：用上一页最后一条记录的 (created_at, id) 作为游标
SELECT * FROM campaigns 
WHERE (created_at, id) < ('2026-03-27 10:00:00', 12345)
ORDER BY created_at DESC, id DESC 
LIMIT 20;
```

这个方案不管翻到第几页，查询时间都是稳定的 O(log n)（走索引）。代价是不能随机跳页，只能上一页/下一页。

### 索引的大小与内存

PostgreSQL 的 `shared_buffers`（默认 128MB，生产通常设为系统内存的 25%）是热数据的缓存。

规律：**常用的索引如果能放进 shared_buffers，查询就快；放不进去，每次都要读磁盘，就慢。**

一个 B-tree 索引的大小粗估：
```
索引大小 ≈ 行数 × (索引字段字节数 + 6 字节指针)
```

举例：campaigns 表 1000 万行，advertiser_id（INTEGER，4 字节）的索引：
```
1000万 × (4 + 6) = 100MB
```

如果 `shared_buffers` 是 4GB，这个 100MB 的索引完全可以常驻内存，查询很快。

如果 `shared_buffers` 只有 256MB，而你有 10 个索引共 800MB，就会频繁 cache miss，查询变慢。

**查看哪些索引最常用，砍掉不用的：**

```sql
SELECT 
    schemaname || '.' || tablename AS table,
    indexname,
    idx_scan AS scans,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC  -- 扫描次数少的在前面，这些候选删除
LIMIT 20;
```

扫描次数为 0 或者很少的索引，大概率可以删掉。

### JSONB 查询的效率

没有索引的 JSONB 查询性能很差，因为每行都要反序列化 JSONB 再查找：

```sql
-- 无索引，全表扫描，很慢
SELECT * FROM campaigns WHERE data->>'status' = 'active';
```

加 GIN 索引：

```sql
CREATE INDEX idx_campaigns_data_gin ON campaigns USING GIN (data);
```

GIN 索引支持任意 JSONB key/value 的查询，但有代价：
- 索引大小通常是 JSONB 字段大小的 50%~100%
- 写入时更新 GIN 索引比普通 B-tree 慢
- 对于高频写入的表，GIN 索引开销明显

如果只需要查某几个固定的 key，用表达式索引更高效：

```sql
-- 只索引 status 字段，比 GIN 小很多
CREATE INDEX idx_campaigns_status ON campaigns ((data->>'status'));
```

---

## 五、实用的大小查询 SQL

平时运维可以常备这几条：

```sql
-- 查看所有表的大小排名
SELECT
    relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_indexes_size(relid)) AS index_size,
    n_live_tup AS row_estimate
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- 查看字段级别的平均大小（对分析存储很有用）
SELECT
    attname AS column_name,
    avg(pg_column_size(attname::text)) AS avg_bytes
FROM information_schema.columns
WHERE table_name = 'campaigns'
GROUP BY attname;

-- 查看数据库总大小
SELECT pg_size_pretty(pg_database_size(current_database()));

-- 查看单个字段的类型和存储大小估算
SELECT
    column_name,
    data_type,
    character_maximum_length
FROM information_schema.columns
WHERE table_name = 'campaigns'
ORDER BY ordinal_position;
```

---

## 总结：几个记得住的数字

| 类型 | 大小 |
|------|------|
| BOOLEAN | 1 字节 |
| INTEGER | 4 字节 |
| BIGINT | 8 字节 |
| TIMESTAMPTZ | 8 字节 |
| UUID（原生）| 16 字节 |
| UUID（TEXT）| 37 字节 |
| 每行固定 overhead | 23 字节 |
| JSONB 比正规化建模 | 大 1.5~3 倍 |

| 数据量 | 关注点 |
|--------|--------|
| < 100 万行 | 加主键和基本索引，别过度优化 |
| 100 万 ~ 1000 万行 | 索引设计、避免全表扫描 |
| 1000 万 ~ 1 亿行 | 索引大小、分区、游标分页 |
| > 1 亿行 | 分区必须、VACUUM 调优、读写分离 |

设计阶段把这些数字带进去估算，比出问题了再优化省力得多。
