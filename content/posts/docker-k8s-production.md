---
title: "Docker + Kubernetes 生产部署：从容器化到集群管理"
date: "2026-03-15"
tags: ["Docker", "Kubernetes", "DevOps", "运维"]
summary: "手把手教你把应用容器化并部署到 K8s 集群，包括健康检查、滚动更新、资源限制等生产必备配置。"
---

把应用跑在 K8s 上不难，但跑得稳需要踩很多坑。

## Dockerfile 最佳实践

```dockerfile
# 多阶段构建，减小镜像体积
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download  # 先下依赖，利用缓存
COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server

FROM alpine:3.20
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app
COPY --from=builder /app/server .
USER nobody  # 非 root 运行
EXPOSE 8080
ENTRYPOINT ["./server"]
```

关键点：
- **多阶段构建**：Go 二进制从 800MB 缩到 15MB
- **先复制依赖文件**：利用 Docker 层缓存，避免每次重新下载
- **非 root 用户**：安全最佳实践

## K8s Deployment 配置

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # 滚动更新时最多多 1 个 Pod
      maxUnavailable: 0  # 保证零停机
  selector:
    matchLabels:
      app: api-server
  template:
    spec:
      containers:
      - name: api-server
        image: registry/api-server:v1.2.3
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password
```

## 健康检查设计

```go
// Liveness：应用是否存活（失败则重启）
// Readiness：应用是否就绪（失败则摘流量）

http.HandleFunc("/health/live", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
})

http.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
    // 检查数据库连接
    if err := db.Ping(); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
})
```

## HPA 自动扩缩容

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## 常见生产问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| OOMKilled | 内存泄漏或 limit 太低 | 调整 limit，加内存分析 |
| CrashLoopBackOff | 启动失败 | `kubectl logs --previous` 查历史日志 |
| Pending | 资源不足 | `kubectl describe pod` 查事件 |
| ImagePullBackOff | 镜像拉取失败 | 检查 registry 权限和网络 |
