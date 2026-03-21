---
title: "从零实现分布式链路追踪系统 Prism：ClickHouse、自适应采样与 Context 传播"
date: "2026-03-17"
tags: ["可观测性", "Go"]
summary: "深入剖析 Prism 的设计：为什么选 ClickHouse 而不是 Elasticsearch，自适应采样如何在成本和覆盖率之间取得平衡，以及 Context 传播的实现细节。"
---

[Prism](https://github.com/ThReeIOne/prism) 是我写的一个完整的分布式链路追踪系统，包含 SDK、Collector、存储和 Web UI。这篇文章深入讲设计思路，特别是那些和市面上方案不一样的地方。

## 为什么要自己写，而不是用 Jaeger/Zipkin？

不是说 Jaeger 不好，而是用现有系统让我很难真正理解底层原理。当 Jaeger 在生产出现性能问题时，我不知道该调哪个旋钮。自己从头实现一遍，才能对每个设计决策有真正的感知。

另外，我想用 ClickHouse 做存储——Jaeger 的 ClickHouse 后端是社区维护的，不够稳定。

## 核心数据模型：Trace 和 Span

```go
type Span struct {
    TraceID      [16]byte          // 全局唯一的 Trace 标识
    SpanID       [8]byte           // 当前 Span 的标识
    ParentSpanID [8]byte           // 父 Span（根 Span 的 ParentSpanID 全零）
    Name         string            // 操作名称，如 "HTTP GET /users"
    Kind         SpanKind          // Server/Client/Producer/Consumer/Internal
    StartTime    time.Time
    EndTime      time.Time
    Status       SpanStatus        // Ok/Error/Unset
    Attributes   map[string]any    // 业务属性，如 user.id, db.statement
    Events       []SpanEvent       // 时间点事件，如 "cache miss"
    Links        []SpanLink        // 跨 Trace 关联（如消息队列场景）
    Resource     map[string]string // 进程级属性，如 service.name, host.ip
}
```

`TraceID` 用 16 字节是因为兼容 W3C Trace Context 规范（`traceparent` header）。`SpanID` 用 8 字节。这不是随意的选择——如果你想让你的追踪系统和其他系统互通，就必须遵守这个标准。

## Context 传播：跨进程追踪的关键

链路追踪最难的不是存储，而是**如何在完全不相关的进程之间传递 TraceID**。

### 进程内传播

Go 的 `context.Context` 天然适合携带追踪信息：

```go
type contextKey struct{}

func TraceFromContext(ctx context.Context) *TraceContext {
    if tc, ok := ctx.Value(contextKey{}).(*TraceContext); ok {
        return tc
    }
    return nil
}

func ContextWithTrace(ctx context.Context, tc *TraceContext) context.Context {
    return context.WithValue(ctx, contextKey{}, tc)
}
```

这里有个微妙的设计：用私有类型 `contextKey{}` 作为 key，而不是字符串。这样可以避免不同包之间的 key 冲突——即使两个包都用字符串 `"trace"`，它们也不会互相覆盖。

### 跨进程传播：W3C Trace Context

HTTP 请求跨进程时，通过 `traceparent` header 传递：

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             版本  TraceID(32位hex)               SpanID(16位hex)   采样标志
```

```go
func (p *HTTPPropagator) Inject(ctx context.Context, headers http.Header) {
    tc := TraceFromContext(ctx)
    if tc == nil {
        return
    }
    traceID := hex.EncodeToString(tc.TraceID[:])
    spanID := hex.EncodeToString(tc.SpanID[:])
    flags := "00"
    if tc.Sampled {
        flags = "01"
    }
    headers.Set("traceparent", fmt.Sprintf("00-%s-%s-%s", traceID, spanID, flags))
    
    // 透传业务属性（如 tenant-id）
    if tc.Baggage != nil {
        headers.Set("tracestate", tc.Baggage.Serialize())
    }
}

func (p *HTTPPropagator) Extract(ctx context.Context, headers http.Header) context.Context {
    header := headers.Get("traceparent")
    if header == "" {
        return ctx  // 没有追踪信息，返回原始 ctx
    }
    tc, err := parseTraceparent(header)
    if err != nil {
        return ctx  // 解析失败，不传播错误，静默失败
    }
    return ContextWithTrace(ctx, tc)
}
```

**静默失败**是故意的设计——追踪系统不能影响业务逻辑。即使追踪出了问题，业务也要正常运行。

### gRPC 传播

gRPC 通过 metadata 传播，需要实现 `grpc.UnaryServerInterceptor`：

```go
func TracingInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    // 从 gRPC metadata 提取
    md, ok := metadata.FromIncomingContext(ctx)
    if ok {
        if vals := md.Get("traceparent"); len(vals) > 0 {
            ctx = propagator.Extract(ctx, metadataCarrier(md))
        }
    }
    
    ctx, span := tracer.Start(ctx, info.FullMethod,
        trace.WithSpanKind(trace.SpanKindServer),
    )
    defer span.End()
    
    resp, err := handler(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }
    return resp, err
}
```

## 自适应采样：在成本和覆盖率之间取平衡

这是 Prism 和很多简单实现最大的不同。

**为什么不能 100% 采样？**

一个每秒处理 10000 请求的服务，100% 采样意味着每秒写入 10000+ 个 Span 到存储。假设每个 Span 平均 500 字节，每天的数据量是 500B * 10000 * 86400 ≈ **432GB**。存储成本是不可接受的。

**固定采样率的问题**

固定 1% 采样看起来合理，但有个致命缺陷：如果你的系统每秒只有 5 个错误请求，1% 采样下平均每 200 秒才会采到 1 个错误——错误信息几乎全部丢失。

**自适应采样的核心思路**

```go
type AdaptiveSampler struct {
    baseRate      float64    // 基础采样率，如 0.1 (10%)
    errorRate     float64    // 错误请求采样率，如 1.0 (100%)
    slowThreshold time.Duration  // 慢请求阈值
    slowRate      float64    // 慢请求采样率，如 1.0 (100%)
    
    // 流量控制：每秒最多采样 N 个
    limiter       *rate.Limiter
    
    // 动态调整：根据近期错误率调整基础采样率
    recentErrors  *sliding.Window
    mu            sync.RWMutex
}

func (s *AdaptiveSampler) ShouldSample(span *Span) SamplingDecision {
    // 规则1：错误请求必采
    if span.Status == StatusError {
        return SampledAlways
    }
    
    // 规则2：慢请求必采
    if span.Duration() > s.slowThreshold {
        return SampledAlways
    }
    
    // 规则3：流量超限时降级
    if !s.limiter.Allow() {
        return NotSampled
    }
    
    // 规则4：基础概率采样，动态调整
    rate := s.currentRate()
    return s.probabilisticSample(rate)
}

func (s *AdaptiveSampler) currentRate() float64 {
    s.mu.RLock()
    defer s.mu.RUnlock()
    
    // 如果近期错误率高，提高基础采样率以捕获更多上下文
    errorRatio := s.recentErrors.Rate()
    if errorRatio > 0.05 {  // 错误率超过 5%
        return math.Min(s.baseRate * (1 + errorRatio * 10), 1.0)
    }
    return s.baseRate
}
```

**Head-based vs Tail-based 采样**

Head-based（在请求开始时决定是否采样）的问题：你不知道这个请求最终会不会出错。可能一个重要的慢请求在 head 时被丢弃了。

Tail-based（在请求完成后决定）更准确，但需要在内存中暂存所有 Span，等 Trace 完整后再决定，内存压力大。

Prism 目前用 Head-based + 错误/慢请求兜底的混合策略，未来计划实现 Tail-based。

## 为什么选 ClickHouse

Trace 数据的查询模式很特殊：

1. 写入量大，读取相对少（主要是排查问题时）
2. 按时间范围查询（最近 1 小时的慢请求）
3. 按 TraceID 精确查询（拿到完整链路）
4. 聚合查询（P99 延迟、错误率趋势）

**Elasticsearch** 做 1 和 3 很好，但聚合查询（4）性能差，存储成本高（索引开销大）。

**ClickHouse** 是列存储，聚合查询极快，压缩率高（相比 Elasticsearch 存储可以小 5-10 倍），但随机读（精确查 TraceID）相对慢。

Prism 的解决方案是**分层存储**：

```sql
-- 主表：按 TraceID 排序，支持精确查询
CREATE TABLE spans (
    trace_id    FixedString(32),
    span_id     String,
    parent_id   String,
    service     LowCardinality(String),  -- LowCardinality 优化重复值
    name        String,
    start_time  DateTime64(9),           -- 纳秒精度
    duration_ns UInt64,
    status      Enum8('ok'=0, 'error'=1, 'unset'=2),
    attributes  Map(String, String),
    -- 预计算的高频查询字段，避免 Map 的解析开销
    http_method LowCardinality(String) MATERIALIZED attributes['http.method'],
    http_status UInt16 MATERIALIZED toUInt16OrZero(attributes['http.status_code'])
)
ENGINE = MergeTree()
PARTITION BY toDate(start_time)
ORDER BY (service, start_time, trace_id)  -- 排序键决定查询性能
TTL toDate(start_time) + INTERVAL 30 DAY  -- 自动过期，控制存储成本

-- 物化视图：实时聚合，用于 Dashboard 展示
CREATE MATERIALIZED VIEW spans_metrics
ENGINE = AggregatingMergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (service, name, timestamp)
AS SELECT
    service,
    name,
    toStartOfMinute(start_time) AS timestamp,
    countState() AS request_count,
    sumState(duration_ns) AS total_duration,
    quantilesState(0.5, 0.95, 0.99)(duration_ns) AS duration_quantiles,
    countIfState(status = 'error') AS error_count
FROM spans
GROUP BY service, name, timestamp;
```

**物化视图**是 ClickHouse 的杀手锏。每次写入 Span 时，物化视图自动实时聚合，查询 Dashboard 时不需要实时计算，直接读取预聚合结果，延迟从秒级降到毫秒级。

## Collector：高吞吐写入的实现

Collector 接收 SDK 发来的 Span，批量写入 ClickHouse。

```go
type Collector struct {
    ch       chan *Span        // 接收 Span 的 channel
    batch    []*Span           // 当前批次
    batchSize int              // 批次大小上限
    flushInterval time.Duration // 最长等待时间
    db       *clickhouse.Conn
}

func (c *Collector) Run(ctx context.Context) {
    ticker := time.NewTicker(c.flushInterval)
    defer ticker.Stop()
    
    for {
        select {
        case span := <-c.ch:
            c.batch = append(c.batch, span)
            // 批次满了立即 flush
            if len(c.batch) >= c.batchSize {
                c.flush(ctx)
            }
            
        case <-ticker.C:
            // 定时 flush，保证低流量时数据不积压
            if len(c.batch) > 0 {
                c.flush(ctx)
            }
            
        case <-ctx.Done():
            // 优雅退出：flush 剩余数据
            if len(c.batch) > 0 {
                c.flush(context.Background()) // 用新 ctx，不受取消影响
            }
            return
        }
    }
}

func (c *Collector) flush(ctx context.Context) {
    if len(c.batch) == 0 {
        return
    }
    
    batch := c.batch
    c.batch = make([]*Span, 0, c.batchSize) // 重置，继续接收
    
    // ClickHouse 批量插入，一次 INSERT 比多次单行插入快几十倍
    if err := c.db.AsyncInsert(ctx, buildInsertSQL(batch), false); err != nil {
        // 写入失败：记录指标，考虑重试策略
        metrics.CollectorFlushErrors.Inc()
        // TODO: 写入本地缓冲文件，防止数据丢失
    }
}
```

**批量写入的重要性**：ClickHouse 的写入性能在批量模式下远高于单行模式。每次 INSERT 都会创建一个数据 Part，ClickHouse 后台会合并这些 Parts（类似 LSM Tree 的 compaction）。如果每条 Span 都单独 INSERT，会产生大量小 Parts，合并开销极大，还可能触发 ClickHouse 的写入限速（`Too many parts`错误）。

实测数据：单行 INSERT ~500 行/s，批量 INSERT（1000 条/批）~200,000 行/s，相差 400 倍。

## 还在迭代的方向

**Tail-based 采样**：目前是 Head-based，无法基于请求结果决定是否采样。Tail-based 需要在 Collector 层暂存 Span，等 Trace 完整（或超时）后再决定，内存和延迟的权衡还在研究中。

**Span 关联分析**：同一个数据库表被哪些服务访问、哪个服务是下游瓶颈，这类横向分析目前还没有。

**异常检测**：基于历史 P99 数据，自动标记异常慢的请求，而不是让用户手动设置阈值。

GitHub: [ThReeIOne/prism](https://github.com/ThReeIOne/prism)
