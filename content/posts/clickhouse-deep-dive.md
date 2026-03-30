---
title: "ClickHouse 深度解析：架构、存储引擎与核心机制"
tags: ["数据库", "架构"]
summary: "从底层原理到核心机制，系统性地拆解 ClickHouse：它是什么、为什么快、存储引擎怎么工作、SQL 有哪些特性，以及什么场景适合用、什么场景不该用。"
---

ClickHouse 是俄罗斯 Yandex 在 2016 年开源的列式数据库，专为 OLAP（Online Analytical Processing）场景设计。这篇文章不讲某个具体项目的接入经验，而是把 ClickHouse 本身讲透——它的架构是什么样的，为什么查询能这么快，存储引擎的核心机制是什么，以及它的边界在哪里。

## 一、ClickHouse 是什么，不是什么

先把定位说清楚，避免用错场景。

**它是：**
- 列式 OLAP 数据库，专为大规模数据的分析查询优化
- 单表可以达到每秒数百亿行的扫描速度
- 天然支持 SQL，学习成本低
- 写入吞吐极高，适合日志、事件、指标等流式数据场景

**它不是：**
- OLTP 数据库（不支持高效的行级 UPDATE/DELETE）
- 事务数据库（没有完整的 ACID，不支持多行原子事务）
- Key-Value 存储（点查性能远不如 Redis、Cassandra）
- 关系型数据库的替代品（JOIN 能力有限，不适合复杂事务业务）

用一句话概括：**ClickHouse 是为"读少量列、扫描大量行、做聚合计算"这个查询模式量身定做的。**

---

## 二、列存储：ClickHouse 快的根本原因

理解 ClickHouse 的性能，必须先理解列存储和行存储的区别。

### 行存储 vs 列存储

行存储（PostgreSQL、MySQL）把一行数据物理上存放在一起：

```
Row 1: [id=1, name="Alice", age=28, city="Beijing", score=95.5]
Row 2: [id=2, name="Bob",   age=31, city="Shanghai", score=88.0]
Row 3: [id=3, name="Carol", age=25, city="Beijing", score=91.2]
```

列存储（ClickHouse）把同一列的数据物理上存放在一起：

```
id 列:    [1, 2, 3, ...]
name 列:  ["Alice", "Bob", "Carol", ...]
age 列:   [28, 31, 25, ...]
city 列:  ["Beijing", "Shanghai", "Beijing", ...]
score 列: [95.5, 88.0, 91.2, ...]
```

这个区别在 OLAP 查询中产生了巨大差异：

```sql
-- 只需要 score 列
SELECT avg(score) FROM users WHERE city = 'Beijing';
```

- **行存储**：读取每一行的全部字段（id + name + age + city + score），再筛选 city，再提取 score。假设每行 200 字节，扫描 1 亿行需要读 20GB。
- **列存储**：只读 `city` 列（筛选）和 `score` 列（计算），每列可能只有 5-20 字节，读取量 ~2.5GB，节省 87%。

列数越多、查询涉及的列越少，差距越大。真实的宽表（50+ 列）场景下，IO 差距可以超过 10 倍。

### 压缩：列存储的额外红利

同一列的数据类型相同、值域相近，天然适合压缩：

- **字符串列**（如 `city`）：重复值多，LZ4/ZSTD 压缩率极高
- **数值列**（如 `age`）：相邻值差异小，Delta 编码后再压缩，效果惊人
- **枚举型列**（如 `status`）：LowCardinality 字典编码，几乎不占空间
- **时间列**（如 `created_at`）：单调递增，Delta 编码后压缩率 10:1 以上

ClickHouse 默认使用 LZ4 压缩（速度优先），也支持 ZSTD（压缩率更高）。实际生产中，列存 + 压缩通常能让存储体积比行存数据库缩小 5-10 倍。

### 向量化执行：把 CPU 也利用上

光有列存储还不够。ClickHouse 的查询引擎使用**向量化执行（Vectorized Execution）**，每次对一批数据（默认 8192 行，称为一个 Block）做批量运算，而不是逐行处理。

批量运算可以利用现代 CPU 的 SIMD 指令（SSE/AVX），一条指令同时处理 8 或 16 个浮点数。这让 ClickHouse 在计算密集型查询（大量 GROUP BY、聚合、数学计算）上比传统数据库快一个数量级。

---

## 三、MergeTree：ClickHouse 最核心的存储引擎

ClickHouse 有十几种表引擎，但 **MergeTree 家族**是生产中几乎唯一的选择。理解 MergeTree，就理解了 ClickHouse 80% 的核心机制。

### 数据组织：从写入到存储

```sql
CREATE TABLE events
(
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    page_url    String,
    duration_ms UInt32
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_type, event_time, user_id)
SETTINGS index_granularity = 8192;
```

写入时发生了什么：

1. **数据写入 Part**：每次 INSERT 创建一个 Part（磁盘上的一个目录），数据在 Part 内按 `ORDER BY` 排序。
2. **列分离存储**：每列独立存为文件（`event_type.bin`、`user_id.bin` 等），加上对应的索引文件（`.mrk`）。
3. **后台 Merge**：ClickHouse 后台进程持续将小 Part 合并（Merge）成大 Part，类似 LSM Tree 的 Compaction。
4. **分区隔离**：不同分区的数据完全隔离，删除一个分区（`ALTER TABLE DROP PARTITION`）是 O(1) 操作，不需要扫描数据。

### 稀疏索引：ClickHouse 的主键索引

MergeTree 的主键索引（Primary Key Index）是**稀疏索引**，而不是 B-Tree 那样的稠密索引。

每 `index_granularity`（默认 8192）行，记录一个索引点，保存该行的 ORDER BY 列值和文件偏移量。

```
索引文件（primary.idx）示意：
行号 0:      (event_type="click", event_time=2026-03-01 00:00:00, user_id=1001)
行号 8192:   (event_type="click", event_time=2026-03-01 02:17:34, user_id=5823)
行号 16384:  (event_type="pageview", event_time=2026-03-01 00:04:21, user_id=221)
...
```

查询时，ClickHouse 用二分查找确定需要读取哪些**粒度（Granule）**，跳过不相关的数据块：

```sql
-- 只需要读 event_type = 'purchase' 的数据
SELECT count() FROM events WHERE event_type = 'purchase';
```

由于 `ORDER BY` 第一列是 `event_type`，所有 `purchase` 数据连续存放，索引能直接定位到这些粒度，跳过 `click`、`pageview` 等所有其他数据。

**关键认知：ORDER BY 决定查询性能。** 把最高频的过滤条件放在 ORDER BY 最前面，这是 ClickHouse 性能调优最重要的一步。

### 分区（Partition）的作用

分区是比稀疏索引更粗粒度的剪枝：满足 `PARTITION BY` 条件的数据存放在同一分区，查询时如果能确定只涉及某几个分区，ClickHouse 直接跳过其他所有分区，甚至不读取索引。

```sql
-- 只查 2026-03 的数据，ClickHouse 直接跳过其他月份的所有文件
SELECT count() FROM events
WHERE toYYYYMM(event_time) = 202603;
```

分区设计原则：
- **时间序列数据**：按天（`toDate`）或按月（`toYYYYMM`）分区，支持高效的时间范围查询和过期数据清理
- **不要过细**：按秒或分钟分区会产生海量小分区，严重影响性能
- **不要按高基数列分区**（如 user_id），会导致分区数量爆炸

### TTL：数据自动过期

ClickHouse 支持在建表时指定 TTL（Time To Live），数据到期后自动删除或转移，不需要手动清理：

```sql
-- 数据保留 30 天
CREATE TABLE logs (...)
ENGINE = MergeTree()
...
TTL event_time + INTERVAL 30 DAY;

-- 更精细：30天内保留完整数据，90天后只保留聚合数据
TTL event_time + INTERVAL 30 DAY,
    event_time + INTERVAL 90 DAY TO VOLUME 'cold_storage';
```

TTL 在 Merge 时触发，不是精确到秒的实时删除，但对于日志、监控等场景已经足够。

---

## 四、MergeTree 家族其他成员

### ReplacingMergeTree：去重

MergeTree 不去重，同一主键可以插入多行。`ReplacingMergeTree` 在 Merge 时对相同 ORDER BY 键的行保留最新版本（或指定版本号最大的）：

```sql
CREATE TABLE user_profile
(
    user_id     UInt64,
    name        String,
    updated_at  DateTime
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY user_id;
```

**注意**：去重发生在 Merge 时，查询时可能读到重复数据。需要用 `FINAL` 关键字强制去重：

```sql
SELECT * FROM user_profile FINAL WHERE user_id = 12345;
```

`FINAL` 会严重影响性能（强制在查询时合并），所以这种模式适合**写入频率低、偶尔更新**的场景，不适合高频写入。

### SummingMergeTree：自动汇总

Merge 时对相同 ORDER BY 键的行做数值列求和，适合预聚合场景：

```sql
CREATE TABLE daily_stats
(
    date        Date,
    service     LowCardinality(String),
    request_cnt UInt64,
    error_cnt   UInt64,
    total_ms    UInt64
)
ENGINE = SummingMergeTree()
ORDER BY (date, service);
```

每次写入当天的增量数据，Merge 时自动累加。查询时用 `sum()` 确保读到正确结果：

```sql
SELECT date, service, sum(request_cnt), sum(error_cnt)
FROM daily_stats
GROUP BY date, service;
```

### AggregatingMergeTree：更复杂的聚合

支持存储聚合函数的中间状态（不仅仅是求和），配合物化视图使用：

```sql
-- 存储 count、sum、quantiles 的中间状态
CREATE TABLE metrics_agg
(
    minute      DateTime,
    service     LowCardinality(String),
    cnt         AggregateFunction(count),
    total_ms    AggregateFunction(sum, UInt64),
    p99_ms      AggregateFunction(quantile(0.99), UInt64)
)
ENGINE = AggregatingMergeTree()
ORDER BY (service, minute);
```

查询时用 `-Merge` 后缀：

```sql
SELECT
    service,
    minute,
    countMerge(cnt),
    sumMerge(total_ms),
    quantileMerge(0.99)(p99_ms)
FROM metrics_agg
GROUP BY service, minute;
```

---

## 五、物化视图：实时预计算

物化视图（Materialized View）是 ClickHouse 中极其重要的性能工具。它在数据写入时**自动触发**，把计算结果实时存入目标表，查询时直接读预计算结果。

```sql
-- 原始日志表
CREATE TABLE access_logs (
    log_time    DateTime,
    status_code UInt16,
    url         String,
    resp_ms     UInt32,
    bytes_sent  UInt32
) ENGINE = MergeTree()
PARTITION BY toDate(log_time)
ORDER BY log_time;

-- 每分钟聚合的物化视图
CREATE MATERIALIZED VIEW access_logs_1min_mv
TO access_logs_1min
AS SELECT
    toStartOfMinute(log_time)    AS minute,
    status_code,
    count()                       AS request_count,
    countIf(status_code >= 500)   AS error_count,
    avg(resp_ms)                  AS avg_resp_ms,
    quantile(0.99)(resp_ms)       AS p99_resp_ms,
    sum(bytes_sent)               AS total_bytes
FROM access_logs
GROUP BY minute, status_code;
```

**工作原理**：每次向 `access_logs` 写入数据，触发物化视图的 SELECT 对**这批新数据**做聚合，结果 INSERT 到 `access_logs_1min`。

**关键限制**：物化视图只处理**新写入的数据**，不会回溯历史数据。如果后来添加物化视图，历史数据需要手动 INSERT 到目标表。

查询 Dashboard 时直接查 `access_logs_1min`，数据量从亿级降到分钟级，查询从秒级降到毫秒级。

---

## 六、ClickHouse SQL 特有语法

ClickHouse 兼容大部分标准 SQL，但有一些独特的扩展值得了解。

### ARRAY JOIN：展开数组

```sql
-- tags 是数组列
SELECT user_id, tag
FROM users
ARRAY JOIN tags AS tag
WHERE tag = 'premium';
```

等价于把数组中每个元素展开成独立的行，比手写 unnest 更高效。

### WITH ROLLUP / CUBE / GROUPING SETS

```sql
-- 同时计算多个维度组合的聚合
SELECT service, endpoint, count()
FROM requests
GROUP BY GROUPING SETS (
    (service, endpoint),
    (service),
    ()
);
```

一次查询返回：按 service+endpoint 的聚合、按 service 的汇总、全局总计。

### SAMPLE：采样查询

数据量极大时，可以对数据采样后快速返回近似结果：

```sql
-- 采样 1/10 的数据，速度提升 10 倍，结果是近似值
SELECT count() * 10 AS approx_count
FROM events SAMPLE 0.1
WHERE event_type = 'purchase';
```

适合对精度要求不高的探索性分析。

### Window Functions：窗口函数

ClickHouse 支持标准窗口函数，语法和 PostgreSQL 基本一致：

```sql
SELECT
    date,
    service,
    requests,
    sum(requests) OVER (PARTITION BY service ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_7d
FROM daily_requests;
```

### -If 和 -Array 聚合函数修饰符

这是 ClickHouse 独有的语法糖，非常实用：

```sql
-- 等价于 COUNT(CASE WHEN status >= 500 THEN 1 END)
SELECT countIf(status >= 500) FROM logs;

-- 对数组列的每个元素求和
SELECT sumArray(tag_scores) FROM posts;
```

---

## 七、数据类型选择指南

选对数据类型对性能影响显著。

### 数值类型

| 场景 | 推荐类型 | 说明 |
|------|----------|------|
| ID（无负数） | UInt64 | 比 Int64 省一半符号位处理 |
| 年龄、状态码 | UInt8/UInt16 | 能用小类型就不用大类型 |
| 金额（精确） | Decimal(18, 4) | 不要用 Float，浮点不精确 |
| 指标（允许近似） | Float64 | 存储小，计算快 |
| 纳秒时间戳 | UInt64 | DateTime64 精度不够时用 |

### 字符串类型

- **LowCardinality(String)**：枚举语义的字符串（不同值 < 1万），字典编码，存储和计算都比 String 快
- **FixedString(N)**：定长字符串（如 UUID、Hash），比 String 存储更紧凑
- **String**：其他情况

### 时间类型

- **Date**：只有日期，4 字节，`toDate()` 转换
- **DateTime**：精确到秒，4 字节，Unix timestamp
- **DateTime64(3)**：精确到毫秒；`DateTime64(6)` 到微秒；`DateTime64(9)` 到纳秒

### Nullable：谨慎使用

`Nullable(UInt32)` 会让存储从 UInt32 变成 UInt8（null标志位） + UInt32，同时**禁用**很多性能优化（不能放入 ORDER BY、聚合更慢）。

如果能用 0 或空字符串表示缺失值，就不要用 Nullable。

---

## 八、写入最佳实践

ClickHouse 的写入有一些必须知道的限制，否则很容易踩坑。

### 批量写入，不要逐行插入

每次 INSERT 创建一个 Part。频繁小批量写入导致 Part 数量爆炸，触发 "Too many parts" 错误，系统开始拒绝写入。

**规则：单次 INSERT 至少 1000 行，推荐 1万~10万行。**

```python
# 错误：循环单行插入
for row in rows:
    client.execute("INSERT INTO t VALUES", [row])

# 正确：批量插入
client.execute("INSERT INTO t VALUES", rows)  # rows 是列表
```

### async_insert：让服务端帮你合批

如果客户端无法控制批量大小（比如每条日志单独发），可以开启 async_insert，ClickHouse 会在服务端缓冲并自动合批：

```sql
-- 连接级别开启
SET async_insert = 1;
SET async_insert_max_data_size = 10485760;  -- 10MB 触发写入
SET async_insert_busy_timeout_ms = 200;     -- 200ms 超时触发写入
```

### 避免频繁 ALTER

ClickHouse 的 `ALTER TABLE ... UPDATE/DELETE` 是**异步的**，通过创建新 Part 来实现，代价极高：

```sql
-- 这条语句会触发重写受影响的所有 Part，代价可能很大
ALTER TABLE events DELETE WHERE event_time < '2026-01-01';

-- 正确做法：用分区删除
ALTER TABLE events DROP PARTITION '202601';  -- O(1)，瞬间完成
```

如果业务需要频繁更新单行，ClickHouse 不是正确的选择。

---

## 九、集群与复制

### ReplicatedMergeTree：高可用

MergeTree 的单节点版本没有副本。生产环境用 `ReplicatedMergeTree`，数据通过 ZooKeeper（或 ClickHouse Keeper）协调复制：

```sql
CREATE TABLE events ON CLUSTER my_cluster
(...)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
PARTITION BY ...
ORDER BY ...;
```

`{shard}` 和 `{replica}` 是宏变量，在各节点的配置文件中定义，不同节点填入不同值。

### Distributed：分片查询

`Distributed` 引擎本身不存数据，而是将查询路由到各分片，合并结果返回：

```sql
CREATE TABLE events_distributed ON CLUSTER my_cluster
AS events
ENGINE = Distributed(my_cluster, default, events, rand());
```

写入 `events_distributed` 时，数据按 `rand()`（随机）分发到各分片的 `events` 表；查询 `events_distributed` 时，ClickHouse 并行扫描所有分片后合并结果。

---

## 十、什么场景用，什么场景不用

用一个决策矩阵总结：

**选 ClickHouse 的信号：**
- 数据量 > 1 亿行，或预期快速增长
- 查询模式：大量行 + 少量列 + 聚合计算
- 写入以 Append 为主，更新/删除极少
- 需要按时间范围查询 + 自动过期
- 对查询延迟有要求（Dashboard 需要秒内响应）

**不选 ClickHouse 的信号：**
- 需要按主键高频点查（用 Redis / Cassandra）
- 需要事务（用 PostgreSQL）
- 数据量 < 千万行（PostgreSQL 完全够用，别过度设计）
- 需要频繁 UPDATE 单行（根本不适合列存）
- 团队没人维护分布式系统（单机 PostgreSQL 比集群 ClickHouse 省心得多）

---

ClickHouse 是一个设计极度专注的系统——它把"大规模分析查询"这件事做到了极致，代价是放弃了 OLTP 场景所需的能力。理解它的设计哲学，才能在合适的场景用好它，在不合适的场景果断放弃它。
