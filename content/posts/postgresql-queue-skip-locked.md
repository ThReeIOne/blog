---
title: "用 PostgreSQL 实现可靠消息队列：SKIP LOCKED 与 at-least-once 投递语义"
date: "2026-03-16"
tags: ["数据库", "Go"]
summary: "深入剖析 PostgreSQL SKIP LOCKED 的工作原理，以及如何在不引入 Kafka/RabbitMQ 的情况下实现生产级的可靠消息投递。"
---

在 HookRelay 的设计中，我选择用 PostgreSQL 而不是专门的消息队列系统来实现任务队列。这个选择在技术社区里颇有争议，有人认为这是"错误的工具做错误的事"。这篇文章深入讲这个实现背后的原理，以及它真正的边界在哪里。

## 一个简单问题：如何让多个 Worker 并发消费，且不重复？

假设你有一张任务表，多个 Worker 进程同时从里面取任务处理。最朴素的方案：

```sql
-- Worker 1
SELECT * FROM jobs WHERE status = 'pending' LIMIT 1;
-- Worker 2 同时执行同样的 SQL

-- 结果：两个 Worker 拿到同一条记录，重复处理
```

这是经典的**竞态条件**。

### 方案一：悲观锁 `FOR UPDATE`

```sql
BEGIN;
SELECT * FROM jobs WHERE status = 'pending' LIMIT 1 FOR UPDATE;
-- 处理...
UPDATE jobs SET status = 'done' WHERE id = $1;
COMMIT;
```

`FOR UPDATE` 会锁住查询到的行，其他事务对这行的 `SELECT ... FOR UPDATE` 会**阻塞等待**。

问题：Worker 1 锁住了 job_1，Worker 2 来了，发现 job_1 被锁，**等待**。等 Worker 1 提交后，Worker 2 才能继续，发现 job_1 已经是 `done` 了，再去找下一条。**串行化了**，失去了并发的意义。

### 方案二：乐观锁（CAS 更新）

```sql
-- 用 UPDATE 的原子性代替 SELECT 的锁
UPDATE jobs 
SET status = 'processing', worker_id = $worker_id
WHERE id = (
    SELECT id FROM jobs 
    WHERE status = 'pending' 
    ORDER BY id LIMIT 1
)
AND status = 'pending'  -- 条件检查，防止并发冲突
RETURNING *;
```

如果两个 Worker 同时运行这条 SQL，只有一个会成功更新（因为 UPDATE 是原子的），另一个 `RETURNING` 为空，需要重试。这比方案一好，但高并发时重试率很高，有大量无效操作。

### 方案三：SKIP LOCKED（正确答案）

```sql
BEGIN;
SELECT * FROM jobs 
WHERE status = 'pending' 
ORDER BY created_at
LIMIT 10
FOR UPDATE SKIP LOCKED;  -- 跳过已被锁定的行，而不是等待
COMMIT;
```

`SKIP LOCKED` 是 PostgreSQL 9.5 引入的特性。它的语义是：**如果某行已经被其他事务锁定，直接跳过它，选择下一条未锁定的行**。

这样，Worker 1 和 Worker 2 可以同时运行，各自拿到不同的任务，互不干扰，完全并行。

## SKIP LOCKED 的底层实现原理

理解这个特性，需要先了解 PostgreSQL 的 MVCC（多版本并发控制）和行锁机制。

PostgreSQL 中，每行数据在物理上有一个**行级锁**（tuple lock）。`FOR UPDATE` 会在 row 的 header 中设置 `xmax` 字段（标记当前持有锁的事务 ID），其他事务读到这行时检查 `xmax` 是否是活跃事务：
- 普通 `SELECT`：看不到锁，直接读（MVCC 快照隔离）
- `FOR UPDATE`：检测到锁，根据参数决定等待（默认）或跳过（SKIP LOCKED）
- `NOWAIT`：检测到锁，立即报错

```
行锁在内存中的表示（简化）：
pg_locks 表中：
  locktype: tuple
  relation: jobs 表的 OID
  tuple: 行的物理位置 (page, offset)
  transactionid: 持锁事务 ID
  mode: RowExclusiveLock
  granted: true
```

当扫描到一行时，PostgreSQL 检查该行是否有未完成事务的锁：
- 没有锁：正常加锁并返回
- 有锁 + 普通 `FOR UPDATE`：进入锁等待队列（`LockAcquire`）
- 有锁 + `SKIP LOCKED`：跳过该行，继续扫描下一行

关键的实现细节：**SKIP LOCKED 不会进入等待队列，因此不会触发死锁检测**。这也是它比普通 `FOR UPDATE` 更高效的原因之一——没有锁等待的上下文切换开销。

## 完整的队列实现

```go
type PostgresQueue struct {
    db          *sql.DB
    workerCount int
}

type Job struct {
    ID         int64
    Payload    []byte
    RetryCount int
    Status     string
    NextRetry  time.Time
}

func (q *PostgresQueue) Dequeue(ctx context.Context, batchSize int) ([]*Job, error) {
    tx, err := q.db.BeginTx(ctx, &sql.TxOptions{
        Isolation: sql.LevelReadCommitted, // 不需要 Repeatable Read
    })
    if err != nil {
        return nil, err
    }
    defer tx.Rollback() // 事务提交后这个是 no-op，失败时会回滚释放锁

    rows, err := tx.QueryContext(ctx, `
        SELECT id, payload, retry_count
        FROM jobs
        WHERE status = 'pending'
          AND next_retry_at <= NOW()
        ORDER BY priority DESC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    `, batchSize)
    if err != nil {
        return nil, err
    }

    var jobs []*Job
    var ids []int64
    for rows.Next() {
        j := &Job{}
        if err := rows.Scan(&j.ID, &j.Payload, &j.RetryCount); err != nil {
            return nil, err
        }
        jobs = append(jobs, j)
        ids = append(ids, j.ID)
    }
    rows.Close()

    if len(jobs) == 0 {
        tx.Rollback()
        return nil, nil
    }

    // 标记为 processing（在同一事务内，保证原子性）
    _, err = tx.ExecContext(ctx, `
        UPDATE jobs 
        SET status = 'processing', started_at = NOW()
        WHERE id = ANY($1)
    `, pq.Array(ids))
    if err != nil {
        return nil, err
    }

    // 提交事务，释放行锁
    // 注意：此时其他 Worker 才能看到这些行被标记为 processing
    if err := tx.Commit(); err != nil {
        return nil, err
    }

    return jobs, nil
}
```

这里有个重要的设计决策：**在同一个事务内完成 SELECT 和 UPDATE**。

如果分成两个步骤（先 SELECT 拿 ID，再 UPDATE），在两个操作之间有个窗口期，另一个 Worker 可能也拿到了同样的 ID。虽然 UPDATE 是原子的，但这引入了不必要的复杂性。同一事务内，SELECT 拿到了行锁，UPDATE 只是修改同样的行，没有额外的锁竞争。

## At-Least-Once 语义与幂等性

PostgreSQL 队列保证的是 **at-least-once**（至少一次）而不是 **exactly-once**（精确一次）。

场景：Worker 取到任务，处理到一半，进程 crash 了。此时任务状态是 `processing`，永远不会被重新消费。

**解决方案：心跳 + 超时重置**

```go
// Worker 在处理任务时，定期更新心跳
func (w *Worker) process(ctx context.Context, job *Job) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()
    
    // 心跳 goroutine
    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                w.db.ExecContext(ctx, `
                    UPDATE jobs SET last_heartbeat = NOW() WHERE id = $1
                `, job.ID)
            case <-ctx.Done():
                return
            }
        }
    }()
    
    // 实际处理
    if err := w.handler(ctx, job); err != nil {
        w.markFailed(job, err)
        return
    }
    w.markDone(job)
}

// 定期扫描超时任务，重置为 pending
func (q *PostgresQueue) RecoverStaleJobs(ctx context.Context) {
    q.db.ExecContext(ctx, `
        UPDATE jobs 
        SET status = 'pending', retry_count = retry_count + 1
        WHERE status = 'processing'
          AND last_heartbeat < NOW() - INTERVAL '30 seconds'
          AND retry_count < max_retries
    `)
}
```

这就是为什么 **at-least-once** 而不是 exactly-once：任务可能被处理了一次（Worker crash 前），然后超时后被重新消费再处理一次。

**应对 at-least-once 的正确姿势是幂等设计**：

```go
// 在任务 payload 中携带幂等键
type SendEmailJob struct {
    IdempotencyKey string  // 唯一标识，通常是业务 ID 的哈希
    UserID         int64
    Template       string
    Variables      map[string]string
}

func (h *EmailHandler) Handle(ctx context.Context, job *Job) error {
    var task SendEmailJob
    json.Unmarshal(job.Payload, &task)
    
    // 检查是否已经发送过
    var sent bool
    h.db.QueryRowContext(ctx, 
        "SELECT EXISTS(SELECT 1 FROM sent_emails WHERE idempotency_key = $1)",
        task.IdempotencyKey,
    ).Scan(&sent)
    
    if sent {
        return nil  // 已发送，幂等返回成功
    }
    
    if err := h.emailClient.Send(ctx, task); err != nil {
        return err
    }
    
    // 记录已发送（与发送操作放在同一事务内更好，但 email 通常不支持事务）
    h.db.ExecContext(ctx,
        "INSERT INTO sent_emails (idempotency_key, sent_at) VALUES ($1, NOW())",
        task.IdempotencyKey,
    )
    return nil
}
```

## 这个方案的性能上限

用 `pgbench` 和真实 HookRelay 负载测试的数据：

| 场景 | 吞吐量 |
|------|-------|
| 单 Worker，无竞争 | ~3,500 jobs/s |
| 10 Workers，SKIP LOCKED | ~12,000 jobs/s |
| 20 Workers，SKIP LOCKED | ~18,000 jobs/s（接近瓶颈） |
| 20 Workers，FOR UPDATE（对比） | ~800 jobs/s（锁等待严重） |

在 10 Workers 时，SKIP LOCKED 的吞吐比 FOR UPDATE 高 **15 倍**。

瓶颈在哪里？当 Worker 数量增多，所有 Worker 都在竞争扫描同一个表的前 N 行，即使 SKIP LOCKED 跳过了已锁的行，**索引扫描本身也会有竞争**（index page 上的 buffer lock）。

超过 ~18,000 jobs/s 后，更多 Worker 已经没有收益，需要考虑分片（多张队列表，Worker 分组消费）或迁移到真正的消息队列系统。

对于 HookRelay 的场景，18,000 events/s 已经远超需求，这个方案完全合适。

## 什么时候应该换 Kafka

明确说清楚这个方案的边界，比鼓吹它万能更重要：

- **> 50,000 events/s**：PostgreSQL 队列无论怎么优化都到头了，换 Kafka
- **需要消息重放**：Kafka 保留历史，可以重放任意时间点的消息；PostgreSQL 队列消费完就没了
- **多消费者组独立消费**：Kafka 的 consumer group 天然支持；PostgreSQL 需要为每个消费者复制一份数据
- **严格的消息顺序**：Kafka 分区内有序；PostgreSQL 在多 Worker 并发下不保证顺序

如果你的场景不涉及以上情况，PostgreSQL 队列的**运维简单性**是真实的优势——不需要维护额外的基础设施，事务性保证更强，调试更直接（直接 SELECT 看队列状态）。
