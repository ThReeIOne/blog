---
title: "设计一个生产级 Webhook 网关：HookRelay 架构复盘"
date: "2026-03-18"
tags: ["Go", "架构设计", "Webhook", "PostgreSQL", "可靠性"]
summary: "从零设计一个支持多源接入、签名验证、可靠投递和扇出路由的 Webhook 网关，深入分析每个设计决策背后的取舍。"
---

最近开源了 [HookRelay](https://github.com/ThReeIOne/hookrelay)，一个用 Go 写的 Webhook 网关。这篇文章不是使用文档，而是复盘整个设计过程——为什么这样设计，有哪些取舍，踩了哪些坑。

## 问题的起源：Webhook 投递有多难？

Webhook 看起来简单：第三方服务 POST 一个请求到你的接口，你处理就行。但当你真正在生产环境接入 GitHub、Stripe、Slack 等多个服务时，问题就来了：

**1. 可靠性问题**：你的处理服务挂了怎么办？Webhook 发过来没人接，这条事件就丢了。大部分平台只重试有限次数，超时就永久丢失。

**2. 签名验证各不相同**：
- GitHub 用 `X-Hub-Signature-256`，HMAC-SHA256
- Stripe 用 `Stripe-Signature`，带时间戳防重放
- 你自己的内部服务可能用 Bearer Token

**3. 扇出问题**：一个 GitHub push 事件，你可能需要同时通知 CI 系统、消息推送、日志系统。如果直接在接收端处理，耦合严重。

**4. 可观测性缺失**：哪条 Webhook 处理失败了？重试了几次？失败原因是什么？没有可视化就是黑盒。

HookRelay 要解决的核心问题是：**让 Webhook 的接收和处理解耦，同时保证至少一次投递语义**。

## 整体架构

```
外部服务
  │ HTTP POST
  ▼
┌─────────────────┐
│   Receiver      │  ← 验证签名、快速响应 202
│   (无状态)      │
└────────┬────────┘
         │ 写入 PostgreSQL
         ▼
┌─────────────────┐
│   Event Queue   │  ← PostgreSQL SKIP LOCKED 实现的队列
│   (持久化)      │
└────────┬────────┘
         │ 轮询/消费
         ▼
┌─────────────────┐
│   Dispatcher    │  ← 路由规则匹配、扇出、重试
│   (有状态)      │
└────────┬────────┘
         │ HTTP POST
         ▼
    目标服务们
```

这个架构的核心是：**Receiver 必须无状态且极速**，任何耗时操作都不应该在这里发生。接收到 Webhook 后，验证签名、写数据库、返回 202，整个过程目标 < 50ms。

## 签名验证：如何统一处理各种格式

这是最繁琐的部分。我抽象了一个 `Verifier` 接口：

```go
type Verifier interface {
    Verify(r *http.Request, body []byte) error
}
```

针对不同平台实现不同的验证器：

```go
// HMAC 验证器（适用于 GitHub、GitLab 等）
type HMACVerifier struct {
    secret    string
    header    string  // e.g. "X-Hub-Signature-256"
    algorithm string  // e.g. "sha256"
}

func (v *HMACVerifier) Verify(r *http.Request, body []byte) error {
    sig := r.Header.Get(v.header)
    if sig == "" {
        return ErrMissingSignature
    }
    // 移除前缀 "sha256="
    parts := strings.SplitN(sig, "=", 2)
    if len(parts) != 2 {
        return ErrInvalidSignatureFormat
    }

    mac := hmac.New(sha256.New, []byte(v.secret))
    mac.Write(body)
    expected := hex.EncodeToString(mac.Sum(nil))

    // 注意：必须用 hmac.Equal 防止时序攻击
    if !hmac.Equal([]byte(parts[1]), []byte(expected)) {
        return ErrSignatureMismatch
    }
    return nil
}
```

**时序攻击**值得单独讲一下：普通的 `==` 比较字符串时，一旦发现不匹配就立即返回，攻击者可以通过测量响应时间逐字节暴力破解签名。`hmac.Equal` 保证无论匹配还是不匹配，都执行相同数量的操作，消除时序差异。

Stripe 的签名格式更复杂，带有时间戳防重放：

```go
// Stripe 签名：t=timestamp,v1=signature
func (v *StripeVerifier) Verify(r *http.Request, body []byte) error {
    header := r.Header.Get("Stripe-Signature")
    
    parts := parseStripeHeader(header)
    ts, err := strconv.ParseInt(parts["t"], 10, 64)
    if err != nil {
        return ErrInvalidTimestamp
    }
    
    // 防重放：5分钟容忍窗口
    if time.Now().Unix()-ts > 300 {
        return ErrReplayAttack
    }
    
    payload := fmt.Sprintf("%d.%s", ts, body)
    // 后续 HMAC 验证...
}
```

## 为什么用 PostgreSQL 而不是 Redis/Kafka 做队列

这是最多人质疑的设计决策。为什么不用 Redis 或 Kafka？

**Redis 的问题**：Redis 的持久化（RDB + AOF）不是真正的 durability。在极端情况下（如 OS crash 在 fsync 之前），数据可能丢失。对于 Webhook 事件，丢失是不可接受的。当然，你可以用 Redis Streams + AOF always，但此时 Redis 的复杂度已经不低于 PostgreSQL。

**Kafka 的问题**：Kafka 是优秀的，但运维成本高。对于一个 Webhook 网关，你不需要每秒百万级吞吐，你需要的是简单、可靠、可运维。Kafka 的 consumer group、offset 管理、partition 设计，会让一个本来简单的项目变成基础设施负担。

**PostgreSQL SKIP LOCKED**：

```sql
-- 这是 HookRelay 的核心队列实现
BEGIN;

SELECT id, source, payload, target_url, retry_count
FROM webhook_events
WHERE status = 'pending'
  AND next_retry_at <= NOW()
ORDER BY created_at ASC
LIMIT 10
FOR UPDATE SKIP LOCKED;  -- 关键：跳过其他 worker 已锁定的行

-- 处理完成后
UPDATE webhook_events SET status = 'delivered' WHERE id = $1;

COMMIT;
```

`SKIP LOCKED` 是 PostgreSQL 9.5 引入的特性，专为队列场景设计。多个 Dispatcher 并发消费时，每个 worker 只会拿到没被其他 worker 锁定的行，天然避免了重复处理。

**这个方案的上限**：单 PostgreSQL 实例的队列，在我的测试中（4核 8G），可以稳定处理 ~2000 events/s，对绝大多数 Webhook 场景绰绰有余。如果真的需要更高吞吐，才值得引入 Kafka。

## 指数退避重试：细节决定成败

重试看起来简单，但有几个坑：

```go
func (d *Dispatcher) calculateNextRetry(retryCount int) time.Time {
    // 指数退避：1s, 2s, 4s, 8s, 16s, 30s(上限)
    backoff := math.Pow(2, float64(retryCount))
    delay := time.Duration(backoff) * time.Second
    
    // 上限 30 分钟，防止无限增长
    if delay > 30*time.Minute {
        delay = 30 * time.Minute
    }
    
    // Jitter：加入随机抖动，防止"惊群效应"
    // 大量任务同时重试会造成目标服务雪崩
    jitter := time.Duration(rand.Intn(int(delay / 4)))
    delay += jitter
    
    return time.Now().Add(delay)
}
```

**Jitter 为什么重要**：想象 1000 个 Webhook 任务都在 T 时刻重试，目标服务会在那一刻收到 1000 个并发请求，可能直接打挂。加入随机抖动后，这 1000 个请求会分散在一个时间窗口内，给目标服务喘息的机会。

**死信队列**：超过最大重试次数（默认 10 次）后，事件移入 `dead_letter_events` 表，不再自动重试，但保留完整的失败历史，支持人工或程序触发重新投递。

## Payload 转换：JMESPath + Go Template

不同系统对 Webhook payload 的格式要求不同。HookRelay 支持两种转换方式：

```yaml
# 规则配置示例
transforms:
  - type: jmespath
    expression: "{event: event_type, repo: repository.full_name, ref: ref}"
  
  - type: go_template  
    template: |
      {
        "text": "{{ .repository.full_name }} pushed to {{ .ref }}"
      }
```

JMESPath 适合结构化提取，Go Template 适合需要格式重新组装的场景。两种可以串联，先提取再格式化。

## 性能数据

在 4 核 8G 的机器上，单实例 HookRelay 的实测数据：

| 指标 | 数值 |
|------|------|
| 接收吞吐 | ~8000 req/s |
| 投递吞吐 | ~2000 events/s |
| P99 接收延迟 | < 15ms |
| 内存占用（空载） | ~25MB |

接收吞吐远高于投递吞吐，这是故意设计的——接收是无状态的，可以无限横向扩展；投递受限于 PostgreSQL 队列，是系统的瓶颈点，也是最需要关注的地方。

## 还没解决的问题

**1. Webhook 去重**：如果第三方平台因为网络问题重发了同一条 Webhook，HookRelay 会重复投递。需要在源头加幂等键（`X-Webhook-ID` 之类），并在 DB 层做唯一约束。

**2. 顺序保证**：同一个源的 Webhook 不保证顺序（因为并发消费）。对于需要顺序处理的场景（如账户余额变更），需要在应用层自己处理。

**3. 多租户**：目前没有租户隔离，所有规则都在一个全局命名空间。

这些都是后续版本要做的，但我不想为了"设计完美"而推迟开源，先把核心功能做稳。

GitHub: [ThReeIOne/hookrelay](https://github.com/ThReeIOne/hookrelay)
