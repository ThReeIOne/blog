---
title: "OpenTelemetry 分布式链路追踪实战"
date: "2026-03-16"
tags: ["可观测性", "OpenTelemetry", "分布式系统", "Go"]
---

# OpenTelemetry 分布式链路追踪实战

在微服务架构中，一个请求可能经过十几个服务，定位问题如同大海捞针。分布式链路追踪是解决这一痛点的关键工具。

## 核心概念

- **Trace**：一次完整请求的全链路记录
- **Span**：链路中的单个操作单元，包含开始时间、持续时间、属性和事件
- **Context Propagation**：通过 HTTP Header 跨服务传递追踪上下文

## Go 初始化 Tracer

```go
func InitTracer(ctx context.Context, serviceName, endpoint string) (func(), error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(endpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, err
    }

    res, _ := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion("1.0.0"),
        ),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.TraceIDRatioBased(0.1)),
    )
    otel.SetTracerProvider(tp)

    return func() { tp.Shutdown(ctx) }, nil
}
```

## HTTP 中间件（一行接入）

```go
handler := otelhttp.NewHandler(mux, "my-service")
```

## 手动创建 Span

```go
func (s *OrderService) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    tracer := otel.Tracer("order-service")
    ctx, span := tracer.Start(ctx, "CreateOrder")
    defer span.End()

    span.SetAttributes(
        attribute.String("user.id", req.UserID),
        attribute.Float64("order.amount", req.Amount),
    )

    order, err := s.repo.Create(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    return order, nil
}
```

## gRPC 集成

```go
// 客户端
conn, err := grpc.Dial(addr,
    grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
)

// 服务端
server := grpc.NewServer(
    grpc.StatsHandler(otelgrpc.NewServerHandler()),
)
```

## 采样策略

```go
// 父基采样 + 比例采样（生产环境推荐）
sampler := sdktrace.ParentBased(
    sdktrace.TraceIDRatioBased(0.05), // 5% 采样率
)
```

链路追踪 + 指标 + 日志，三者结合构成完整的可观测性体系。
