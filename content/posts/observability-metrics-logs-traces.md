---
title: "可观测性不是监控：重新理解 Metrics、Logs 和 Traces 的边界"
date: "2026-03-19"
tags: ["可观测性", "架构"]
summary: "Metrics、Logs、Traces 被称为可观测性三大支柱，但大多数人对它们的理解停留在工具层面。这篇文章试图回答一个更根本的问题：它们各自能回答什么问题，不能回答什么问题，以及为什么三者缺一不可。"
---

"我们有 Prometheus，有 ELK，有 Jaeger，可观测性做得很好。"

这句话我听过很多次。但当系统出了问题，这些工具摆在眼前，工程师还是不知道从哪里开始排查。问题不在工具，而在于对这三种数据的本质理解是错的。

## 一个具体的故障场景

假设你的支付服务 P99 延迟突然从 80ms 飙升到 3 秒。你有什么工具？

**Metrics（Prometheus）**：你能看到延迟在 14:32 开始上升，能看到同期 CPU 使用率正常，数据库连接池使用率从 60% 升到 95%。

**Logs（ELK）**：你能搜到大量超时错误日志，每条日志都包含 `context deadline exceeded`，有的日志里有用户 ID 和订单 ID。

**Traces（Jaeger）**：你能找到几条具体的慢请求，每条都显示时间花在了 `PostgreSQL.Query` 这个 Span 上，耗时 2800ms，SQL 语句是 `SELECT * FROM orders WHERE user_id = $1`。

三种工具，三个视角，各自回答了不同层次的问题。

## Metrics：世界的聚合快照

Metrics 是时间序列数据，本质是**对世界状态的定期采样和聚合**。

```
http_request_duration_seconds{service="payment", status="200"} histogram
database_connections_active{pool="primary"} gauge
orders_processed_total{region="cn"} counter
```

Metrics 的信息密度很低，但它是**唯一能让你看到历史趋势**的工具。你能回答：

- 这个问题是在什么时间点开始的？
- 问题持续了多久？
- 哪个维度（服务、区域、状态码）出现了异常？
- 和上周同期相比，这是正常波动还是异常？

但 Metrics **永远无法告诉你**：这 3 秒的延迟具体花在哪里了？是哪条 SQL 慢了？哪个用户受影响了？

这是 Metrics 的设计本质决定的：为了存储效率，Metrics 丢弃了个体信息，只保留统计聚合。一个 `histogram` 告诉你 P99 是 3 秒，但它不记得那 1% 的请求是谁，来自哪里，做了什么。

### Metrics 设计的本质取舍

Metrics 的存储成本极低。一个 Prometheus counter，无论你的系统每秒处理 1 万还是 100 万请求，存储开销是一样的——每 15 秒写一个数字。这是它能支撑长期存储（数月乃至数年）的原因，也是它无法携带上下文的原因。

时间序列数据库（TSDB）针对这种数据做了专门优化：
- **Delta encoding**：相邻时间点的值变化不大，存差值而不是绝对值
- **XOR compression**：Gorilla 压缩算法，Facebook 提出，Prometheus 采用
- 压缩后，一个时间序列每个数据点只需约 1.37 字节

这种极致的压缩让 Metrics 成为**长时间窗口告警**的最佳选择。

## Logs：事件的原始记录

日志是**事件的非结构化或半结构化记录**，每条日志对应系统中发生的一件事。

```
2026-03-19T14:32:15.234Z ERROR payment-service order=ORD-789012 user=USR-456 
  msg="database query timeout" duration=2847ms query="SELECT * FROM orders WHERE user_id = ?"
```

日志能回答 Metrics 不能回答的问题：**具体发生了什么，谁受影响了，错误消息是什么？**

但日志也有严重的结构性缺陷：

**它是离散的**。每条日志是独立的，你不知道这条 `database query timeout` 和那条 `order payment failed` 是否属于同一个用户请求的前后两个步骤。你只能靠 `order=ORD-789012` 这样的字段手动关联。

**它是局部的**。这条日志只来自 payment-service，你不知道在这之前，这个请求经过了哪些服务，每个服务花了多长时间。

**它的成本随流量线性增长**。每个请求产生 N 条日志，100 万请求就是 100 万 * N 条日志。高流量系统的日志存储成本是个噩梦。

### 结构化日志：让日志更接近 Metrics

结构化日志（JSON 格式）让日志具备了一定的可查询性：

```json
{
  "timestamp": "2026-03-19T14:32:15.234Z",
  "level": "ERROR",
  "service": "payment-service",
  "trace_id": "4bf92f3577b34da6",
  "order_id": "ORD-789012",
  "user_id": "USR-456",
  "message": "database query timeout",
  "duration_ms": 2847
}
```

注意 `trace_id`——这是日志和链路追踪系统的桥梁，后面细说。

## Traces：请求的因果链

链路追踪记录**一个请求在整个系统中的完整生命周期**，包括它经过的每个服务、每次网络调用、每条 SQL 的耗时。

```
Trace: 4bf92f3577b34da6 (总耗时 2901ms)
├── payment-service: ProcessPayment (2901ms)
│   ├── auth-service: ValidateToken (12ms) ✓
│   ├── order-service: GetOrder (45ms) ✓
│   └── payment-service: PostgreSQL.Query (2847ms) ← 问题在这里
│       SQL: SELECT * FROM orders WHERE user_id = $1
│       rows_scanned: 1,847,293
│       rows_returned: 1
```

一眼就能看出：2847ms 全花在了一条 SQL 上，扫描了 180 万行只返回 1 行——缺索引。

Traces 回答了 Metrics 和 Logs 都无法单独回答的问题：**这个请求为什么慢，时间花在哪里？**

但 Traces 的成本也是最高的。每个 Span 要记录时间戳、服务名、操作名、属性、事件，序列化后通常 500 字节到几 KB。100% 采样下，一个每秒 10000 请求的系统每天会产生数百 GB 的追踪数据。这就是为什么采样是链路追踪系统设计的核心问题之一。

## 三者的关系：互相补充，而非互相替代

理解了各自的本质，再来看它们如何协作：

**告警靠 Metrics**：P99 超过阈值触发告警，这是 Metrics 的主场。不要用日志聚合触发告警，延迟高且成本贵。

**定位时间点靠 Metrics**：告警触发后，先看 Metrics Dashboard，确认"什么时间开始的、哪个维度异常"。

**缩小范围靠 Logs**：确认时间点后，搜索这个时间窗口内的错误日志，找到具体的错误类型和受影响的对象（用户、订单）。

**找到根因靠 Traces**：从日志中拿到 `trace_id`，在追踪系统里拉出完整链路，精确定位耗时最长的操作。

这是一条完整的排查路径：**Metrics → Logs → Traces**，逐层下钻，信息密度递增，成本也递增。

## 一个被忽视的维度：Exemplars

Metrics 和 Traces 之间有个天然的鸿沟——Metrics 是聚合的，无法直接关联到某个具体请求。**Exemplars** 是 OpenMetrics 规范引入的机制，填补了这个鸿沟：

```
# Exemplar 示例
http_request_duration_seconds_bucket{le="0.5"} 24054 # {trace_id="4bf92f3577b34da6"} 0.32 1678..
http_request_duration_seconds_bucket{le="4.0"} 24057 # {trace_id="a3ce929d0e0e4736"} 3.71 1678..
```

Exemplar 在 histogram 的每个桶里附带一个具体请求的 `trace_id`。当你发现 P99 超过 4 秒时，可以直接从 Prometheus 跳转到那条具体的 Trace，不需要手动搜索日志。Grafana 已经原生支持 Exemplars 展示。

这个特性改变了排查流程：从"Metrics → Logs（找 trace_id）→ Traces"缩短为"Metrics → Traces"。

## 可观测性是一种设计能力，不是工具集合

最后回到开头的问题：为什么有了三套工具，排查问题还是很难？

因为**可观测性不是部署工具，而是设计系统时就要考虑的能力**。

一个系统能否被观测，取决于：
1. 代码里有没有在正确的位置埋正确的 Span
2. 日志里有没有携带 `trace_id` 实现跨系统关联
3. Metrics 的 label 设计是否合理（太多 label 会造成基数爆炸）
4. 采样策略是否保证了关键路径（错误、慢请求）不被丢弃

这些都是在写第一行业务代码之前就需要决定的事情。工具只是表达手段，判断力才是核心。
