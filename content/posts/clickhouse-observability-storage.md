---
title: "ClickHouse 在可观测性数据存储中的实战：设计、踩坑与调优"
tags: ["数据库", "可观测性"]
summary: "在 Prism 项目中用 ClickHouse 存储链路追踪数据的真实经历：为什么选它，表结构怎么设计，物化视图如何让聚合查询从秒级降到毫秒级，以及那些让我头疼了好几天的坑。"
---

在 [Prism](https://github.com/ThReeIOne/prism) 的设计阶段，存储选型是最纠结的决策之一。最终选了 ClickHouse，不是因为它是"正确答案"，而是它的特性和可观测性数据的查询模式匹配得出奇地好。

这篇文章不讲 ClickHouse 的基础用法，而是讲在真实项目中遇到的设计问题、踩过的坑，以及最终的解法。

## 为什么可观测性数据天然适合列存

先说结论：链路追踪数据是**宽表、写多读少、聚合查询为主**的典型场景，这正是列存数据库的主场。

一条 Span 的数据模型大约是这样：

```
trace_id, span_id, parent_id, service, name, kind,
start_time, end_time, duration_ns,
status, status_message,
http_method, http_url, http_status_code,
db_system, db_statement, db_rows_affected,
rpc_method, rpc_grpc_status,
error_type, error_message,
host_name, host_ip,
... (可能还有几十个自定义属性)
```

一条 Span 可能有 40+ 个字段，但典型的查询只涉及其中几个：

```sql
-- 找某个时间段内某个服务的慢请求
SELECT trace_id, name, duration_ns
FROM spans
WHERE service = 'payment-service'
  AND start_time BETWEEN '2026-03-19 14:30:00' AND '2026-03-19 14:35:00'
  AND duration_ns > 1000000000
ORDER BY duration_ns DESC
LIMIT 100;
```

在行存数据库（PostgreSQL/MySQL）中，即使只查 3 列，也需要读取每行的全部 40+ 列，再丢弃不需要的部分。在 ClickHouse 中，只读取查询涉及的列，IO 减少 90%+。

更重要的是**压缩率**。同一列的数据类型相同、值域相近，压缩效率极高：
- `service` 列：重复值极多，LowCardinality 编码后几乎不占空间
- `duration_ns` 列：相邻行的值在同一数量级，delta encoding 后压缩率 10:1 以上
- `start_time` 列：单调递增，压缩率同样很高

实测：Prism 存储 1 亿条 Span，ClickHouse 占用 ~12GB，同样数据在 PostgreSQL 中约 180GB。

## 表结构设计：每个决策都有代价

```sql
CREATE TABLE spans
(
    -- 核心标识
    trace_id        FixedString(32),   -- 16字节hex，定长比String更高效
    span_id         String,
    parent_span_id  String,
    
    -- 时间（纳秒精度）
    start_time      DateTime64(9, 'Asia/Shanghai'),
    duration_ns     UInt64,
    
    -- 服务信息（高频过滤列）
    service         LowCardinality(String),  -- 枚举类语义
    name            LowCardinality(String),
    kind            Enum8('server'=1, 'client'=2, 'producer'=3, 'consumer'=4, 'internal'=5),
    
    -- 状态
    status          Enum8('unset'=0, 'ok'=1, 'error'=2),
    status_message  String,
    
    -- 预提取的高频属性（避免 Map 的解析开销）
    http_method     LowCardinality(String)  MATERIALIZED attributes['http.method'],
    http_status     UInt16                  MATERIALIZED toUInt16OrZero(attributes['http.status_code']),
    db_system       LowCardinality(String)  MATERIALIZED attributes['db.system'],
    db_statement    String                  MATERIALIZED attributes['db.statement'],
    
    -- 原始属性（兜底）
    attributes      Map(String, String),
    events          String,   -- JSON array
    
    -- 资源属性
    host_name       LowCardinality(String),
    host_ip         String
)
ENGINE = MergeTree()
PARTITION BY toDate(start_time)
ORDER BY (service, toStartOfMinute(start_time), trace_id)
TTL toDate(start_time) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
```

### 设计决策一：ORDER BY 是 ClickHouse 最重要的旋钮

MergeTree 的 `ORDER BY`（也叫排序键）决定了数据在磁盘上的物理排列顺序，直接影响查询性能。

我选择 `(service, toStartOfMinute(start_time), trace_id)` 的原因：

**最高频的过滤条件是 service**：几乎所有查询都会带 `WHERE service = 'xxx'`，把它放第一位，能跳过绝大多数数据块。

**时间放第二位（精确到分钟而不是秒）**：按时间范围查询很常见，精确到分钟是因为秒级精度会导致排序键的基数太高，块索引（sparse index）的跳过效果变差。

**trace_id 放最后**：精确查单条 Trace 时需要全表扫（除非加 skip index），这是 ClickHouse 针对点查的已知弱点，后面有解决方案。

**坑：ORDER BY 不等于索引**。ClickHouse 使用 sparse index（稀疏索引），每 8192 行（`index_granularity`）记录一个索引点。如果你的过滤条件不在 ORDER BY 中，或者顺序不对，查询会退化为全表扫描。

### 设计决策二：LowCardinality 是免费的午餐

`LowCardinality(String)` 对基数较低（通常 < 10000 个不同值）的列使用字典编码，把字符串替换为整数 ID：

```
原始: "payment-service", "auth-service", "payment-service", "order-service"
编码: {0: "payment-service", 1: "auth-service", 2: "order-service"}
存储: 0, 1, 0, 2  (整数，极高压缩率)
```

对比测试：`service` 列（平均 15 字节的服务名）：
- String：1 亿行占 ~1.2GB
- LowCardinality(String)：1 亿行占 ~38MB，节省 97%

而且 `LowCardinality` 列的 GROUP BY 和 WHERE 性能也更快，因为操作整数比操作字符串快。这是**零成本优化**，能用则用。

### 设计决策三：从 Map 中预提取高频列

`attributes` 是一个 `Map(String, String)`，存储所有 OpenTelemetry 标准属性。但 Map 的查询很慢——每次访问 `attributes['http.method']` 都需要解析整个 Map 结构。

解法是用 `MATERIALIZED` 列在写入时提前提取：

```sql
http_method LowCardinality(String) MATERIALIZED attributes['http.method']
```

写入时自动计算，不需要客户端处理。查询时直接读取 `http_method` 列，速度和普通列一样。

**代价**：增加存储（每个预提取列多占一列空间），增加写入 CPU（计算表达式）。对于高频查询的字段，这个代价完全值得。

## 物化视图：让聚合查询从秒到毫秒

Dashboard 上的 "Service Map"、"P99 趋势图" 这类聚合查询，如果每次都实时扫描原始 spans 表，哪怕 ClickHouse 再快也有延迟，而且 IO 开销大。

物化视图（Materialized View）在数据写入时就实时聚合，查询时读取预计算结果：

```sql
-- 每分钟、每服务、每操作的聚合指标
CREATE MATERIALIZED VIEW spans_metrics_mv
TO spans_metrics  -- 目标表
AS SELECT
    service,
    name,
    toStartOfMinute(start_time)     AS minute,
    countState()                     AS request_count,
    countIfState(status = 'error')   AS error_count,
    sumState(duration_ns)            AS total_duration_ns,
    quantilesState(0.5, 0.95, 0.99)(duration_ns) AS duration_quantiles
FROM spans
GROUP BY service, name, minute;

-- 目标表：AggregatingMergeTree 存储聚合中间状态
CREATE TABLE spans_metrics
(
    service          LowCardinality(String),
    name             LowCardinality(String),
    minute           DateTime,
    request_count    AggregateFunction(count),
    error_count      AggregateFunction(countIf),
    total_duration_ns AggregateFunction(sum, UInt64),
    duration_quantiles AggregateFunction(quantiles(0.5, 0.95, 0.99), UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(minute)
ORDER BY (service, name, minute);
```

查询时用 `-Merge` 后缀函数读取：

```sql
SELECT
    service,
    name,
    minute,
    countMerge(request_count) AS requests,
    countIfMerge(error_count) AS errors,
    quantilesMerge(0.5, 0.95, 0.99)(duration_quantiles)[2] AS p95_ns
FROM spans_metrics
WHERE service = 'payment-service'
  AND minute >= now() - INTERVAL 1 HOUR
GROUP BY service, name, minute
ORDER BY minute;
```

**实测效果**：查询"过去1小时 payment-service 的 P95 延迟趋势"：
- 直接查 spans 表：~1.8 秒（扫描 ~180 万行）
- 查 spans_metrics：~8ms（扫描 60 行，每分钟一行）

降低 225 倍。

## 坑：Too many parts（最让我头疼的错误）

ClickHouse 写入时，每个 INSERT 创建一个数据 Part（类似 LSM Tree 的 MemTable flush）。后台会持续将小 Parts 合并成大 Parts（类似 Compaction）。

如果写入速度太快，Parts 数量超过限制（默认 300 个/分区），ClickHouse 会开始报错：

```
DB::Exception: Too many parts (308). Merges are processing significantly 
slower than inserts.
```

我第一次在生产遇到这个错误是在压测时，每条 Span 单独 INSERT，QPS 才几百就触发了。

**根因**：每次 INSERT 无论写多少行都会创建一个 Part，高频小批量写入是致命的。

**解法**：批量写入，每批至少几千行：

```go
// 错误做法：每条 Span 单独写
for _, span := range spans {
    db.Exec("INSERT INTO spans VALUES (...)", span)
}

// 正确做法：批量写入
const batchSize = 5000
for i := 0; i < len(spans); i += batchSize {
    end := min(i+batchSize, len(spans))
    batch := spans[i:end]
    db.Exec("INSERT INTO spans VALUES ...", buildBatchValues(batch))
}
```

或者使用 ClickHouse 的 `async_insert` 模式，让服务端缓冲并自动合批：

```sql
SET async_insert = 1;
SET wait_for_async_insert = 0;  -- 不等待写入完成，吞吐最大化
```

`async_insert` 让 ClickHouse 在服务端缓冲小批量写入，积累到一定量或时间后统一写盘，对客户端透明。这是 Prism Collector 最终采用的方案。

## 解决点查问题：Bloom Filter 跳过索引

前面提到按 `trace_id` 查完整 Trace 是 ClickHouse 的弱点。ORDER BY 中 `trace_id` 排最后，点查会扫描大量数据块。

解法是给 `trace_id` 加 Bloom Filter 跳过索引：

```sql
ALTER TABLE spans ADD INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4;
```

Bloom Filter 是一种概率数据结构，能快速判断一个值"一定不在"某个数据块中（可能有假阳性，但无假阴性）。`0.01` 是误判率，越小精度越高但占空间越多。

加了 Bloom Filter 后，按 `trace_id` 查询从扫描全部数据块降为只扫描少数几个包含目标 `trace_id` 的块，性能提升 10-50 倍（取决于数据量和块大小）。

## 总结：什么时候选 ClickHouse，什么时候不选

**适合**：
- 写多读少（可观测性数据、日志、事件流）
- 聚合查询为主（Dashboard、趋势分析）
- 数据量大、对压缩率有要求
- 可以接受最终一致性（合并是异步的）

**不适合**：
- 高频点查（按主键查单行）
- 频繁更新/删除（ClickHouse 的 UPDATE/DELETE 是异步的，代价高）
- 需要事务支持（ClickHouse 没有传统意义上的 ACID 事务）
- 数据量小（几百万行以内，PostgreSQL 可能更合适）

对于 Prism 的存储需求，ClickHouse 是目前找到的最合适的答案。但"最合适"不是"完美"——点查的弱点、UPDATE/DELETE 的限制，都是真实存在的约束，在系统设计时需要明确告知使用者。
