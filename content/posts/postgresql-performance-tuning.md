---
title: "PostgreSQL 性能调优实战指南"
date: "2026-03-12"
tags: ["PostgreSQL", "数据库", "性能优化"]
---

# PostgreSQL 性能调优实战指南

生产环境中的 PostgreSQL 性能问题往往隐藏在查询计划、索引设计和配置参数中。

## 读懂 EXPLAIN ANALYZE

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2026-01-01'
GROUP BY u.id, u.name
ORDER BY order_count DESC
LIMIT 10;
```

关键指标：
- **Seq Scan vs Index Scan**：数据量大时 Seq Scan 是警告信号
- **actual rows vs estimated rows**：差距大说明统计信息过时
- **Buffers: hit vs read**：hit 是内存命中，read 是磁盘 IO

## 索引策略

### 复合索引列序

```sql
-- 查询：WHERE status = 'active' AND created_at > '2026-01-01'
-- 高选择性列放前面
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
```

### 部分索引

```sql
-- 只对未完成的订单建索引，大幅减小索引体积
CREATE INDEX idx_pending_orders ON orders(created_at)
WHERE status = 'pending';
```

### 覆盖索引

```sql
-- INCLUDE 列不参与查找，但能避免回表
CREATE INDEX idx_users_email ON users(email)
INCLUDE (name, created_at);
```

## 关键配置参数

```ini
# postgresql.conf

# 内存：通常设为物理内存的 25%
shared_buffers = 4GB

# 查询规划器使用的有效缓存大小估算
effective_cache_size = 12GB

# 排序/哈希操作每次可用内存
work_mem = 64MB

checkpoint_completion_target = 0.9
wal_buffers = 64MB
```

## 慢查询定位

```sql
-- 开启慢查询日志（1秒以上记录）
ALTER SYSTEM SET log_min_duration_statement = '1000';
SELECT pg_reload_conf();

-- 查看 pg_stat_statements
SELECT query,
       calls,
       round(total_exec_time::numeric, 2) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

## VACUUM 和统计信息

```sql
-- 查看表膨胀情况
SELECT schemaname, tablename,
       n_dead_tup, n_live_tup,
       round(n_dead_tup::numeric / nullif(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_ratio
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY dead_ratio DESC;

VACUUM (VERBOSE, ANALYZE) orders;
```

## 连接池：PgBouncer

生产环境必用 PgBouncer：

```ini
[pgbouncer]
pool_mode = transaction   # 事务级别复用
max_client_conn = 1000
default_pool_size = 20
```

直连 PostgreSQL 支持约 200 并发连接，加 PgBouncer 后可支持数千并发。
