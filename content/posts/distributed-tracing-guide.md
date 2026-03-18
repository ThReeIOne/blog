---
title: "分布式链路追踪实战：从埋点到可视化"
date: "2026-03-14"
tags: ["分布式系统", "可观测性", "Go", "OpenTelemetry"]
summary: "在微服务架构中，一个请求经过十几个服务，出问题怎么排查？本文手把手实现完整的链路追踪系统。"
---

微服务架构下，一个 API 请求可能经过 10+ 个服务。出了问题，没有链路追踪就是大海捞针。

## 核心概念

- **Trace**：一次完整的请求链路，由多个 Span 组成
- **Span**：链路中的一个操作单元（如一次 HTTP 调用、SQL 查询）
- **Context Propagation**：跨服务传递 TraceID

```
请求 → 网关 → 用户服务 → 订单服务 → 支付服务
         ↓         ↓           ↓          ↓
       Span1     Span2       Span3      Span4
       └─────────── Trace ID 贯穿始终 ──────┘
```

## OpenTelemetry 集成

```go
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/trace"
)

func initTracer() func() {
    exporter, _ := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("collector:4317"),
        otlptracegrpc.WithInsecure(),
    )
    tp := tracesdk.NewTracerProvider(
        tracesdk.WithBatcher(exporter),
        tracesdk.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName("order-service"),
        )),
    )
    otel.SetTracerProvider(tp)
    return func() { tp.Shutdown(ctx) }
}
```

## HTTP 中间件自动埋点

```go
// 服务端：自动从请求头提取 TraceID
mux := http.NewServeMux()
handler := otelhttp.NewHandler(mux, "order-service")
http.ListenAndServe(":8080", handler)

// 客户端：自动注入 TraceID 到请求头
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
```

## 数据库查询追踪

```go
import "go.opentelemetry.io/otel/semconv/v1.21.0"

func (r *OrderRepo) GetByID(ctx context.Context, id int64) (*Order, error) {
    ctx, span := tracer.Start(ctx, "OrderRepo.GetByID",
        trace.WithAttributes(
            semconv.DBSystemPostgreSQL,
            semconv.DBStatement("SELECT * FROM orders WHERE id = $1"),
        ),
    )
    defer span.End()

    order := &Order{}
    err := r.db.QueryRowContext(ctx,
        "SELECT * FROM orders WHERE id = $1", id,
    ).Scan(&order.ID, &order.UserID, &order.Amount)

    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }
    return order, err
}
```

## 自定义 Span 和属性

```go
func ProcessPayment(ctx context.Context, order *Order) error {
    ctx, span := tracer.Start(ctx, "ProcessPayment")
    defer span.End()

    // 添加业务属性
    span.SetAttributes(
        attribute.Int64("order.id", order.ID),
        attribute.Float64("order.amount", order.Amount),
        attribute.String("payment.method", order.PaymentMethod),
    )

    // 添加事件（关键节点）
    span.AddEvent("payment.initiated")

    if err := gateway.Charge(ctx, order); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment failed")
        return err
    }

    span.AddEvent("payment.completed")
    return nil
}
```

## 采样策略

```go
// 生产环境不能 100% 采样，太贵了
tp := tracesdk.NewTracerProvider(
    // 1% 基础采样 + 错误必采样
    tracesdk.WithSampler(tracesdk.ParentBased(
        tracesdk.TraceIDRatioBased(0.01),
    )),
)
```

## 最终效果

部署 Jaeger 或 Zipkin 后，你能看到：
- 完整调用链路和耗时分布
- 哪个服务是性能瓶颈
- 错误发生在哪个节点
- 数据库慢查询定位

这就是为什么每个微服务系统都需要链路追踪。
