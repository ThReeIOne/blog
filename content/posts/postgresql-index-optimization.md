---
title: "PostgreSQL 索引优化实战：从 EXPLAIN 到高性能查询"
date: "2026-03-17"
tags: ["PostgreSQL", "数据库", "性能优化"]
summary: "用 EXPLAIN ANALYZE 找出慢查询，掌握 B-Tree、GIN、BRIN 索引选型，让查询性能提升 10 倍。"
---

数据库慢查询是后端性能瓶颈的头号杀手。这篇文章教你系统性地分析和优化 PostgreSQL 查询。

## EXPLAIN ANALYZE：性能分析神器

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at > '2026-01-01'
GROUP BY u.id, u.name
ORDER BY order_count DESC
LIMIT 10;
```

关键指标：
- **actual time**：实际执行时间（ms）
- **rows**：实际返回行数
- **Seq Scan vs Index Scan**：全表扫描 vs 索引扫描
- **Buffers: hit/read**：缓存命中 vs 磁盘读取

## 索引类型选型

### B-Tree（默认，最常用）

```sql
-- 适合等值查询、范围查询、排序
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
```

### GIN（全文搜索、数组、JSONB）

```sql
-- JSONB 字段查询
CREATE INDEX idx_products_attrs ON products USING GIN(attributes);

-- 查询
SELECT * FROM products WHERE attributes @> '{"color": "red"}';
```

### BRIN（大表时间序列）

```sql
-- 适合自然有序的大表（如日志、时序数据），占用空间极小
CREATE INDEX idx_logs_created ON logs USING BRIN(created_at);
```

## 复合索引设计原则

遵循 **ESR 规则**：Equality → Sort → Range

```sql
-- 查询条件：WHERE status = 'active' ORDER BY created_at DESC LIMIT 20
-- 正确索引：先等值列，再排序列
CREATE INDEX idx_users_status_created ON users(status, created_at DESC);

-- 错误：把范围列放前面，排序无法利用索引
CREATE INDEX idx_wrong ON users(created_at, status);
```

## 慢查询排查流程

```sql
-- 1. 开启慢查询日志
ALTER SYSTEM SET log_min_duration_statement = 1000; -- 超过1s记录

-- 2. 查看等待事件
SELECT query, wait_event_type, wait_event, state
FROM pg_stat_activity
WHERE state != 'idle';

-- 3. 找出缺失索引
SELECT schemaname, tablename, attname, n_distinct, correlation
FROM pg_stats
WHERE tablename = 'orders';
```

## 实战：优化一个真实慢查询

**优化前**（3200ms）：

```sql
SELECT * FROM orders
WHERE created_at BETWEEN '2026-01-01' AND '2026-03-01'
  AND status = 'completed'
ORDER BY amount DESC;
-- Seq Scan on orders (cost=0..45000 rows=1800000)
```

**加索引后**（12ms）：

```sql
CREATE INDEX idx_orders_status_created_amount
ON orders(status, created_at, amount DESC);
-- Index Scan using idx_orders_... (cost=0.56..1200 rows=850)
```

提升 **266 倍**。

## 索引维护

```sql
-- 重建膨胀的索引（不锁表）
REINDEX INDEX CONCURRENTLY idx_orders_user_id;

-- 查看索引使用率，删除无用索引
SELECT indexname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE idx_scan = 0;  -- 从未被使用的索引
```
