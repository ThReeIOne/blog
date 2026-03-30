---
title: "一条 SQL 把接口拖到 5s，我怎么把它找出来的"
tags: ["数据库", "PostgreSQL", "性能优化", "SQLAlchemy"]
summary: "慢查询排查不神秘，就是一套固定流程：日志定位 → EXPLAIN ANALYZE 分析 → 索引或查询优化。这篇文章从开慢查询日志开始，一步步拆解排查过程，重点讲几个最常见的慢查询模式：缺索引、N+1、隐式类型转换，以及怎么把 SQLAlchemy ORM 生成的 SQL 捞出来看。"
---

下午三点，监控告警：`/api/campaigns` 接口 P99 响应时间突破 5 秒。

流量没有异常，服务器 CPU 和内存都正常，就是慢。这种情况十有八九是数据库查询出了问题。

下面记录一下完整的排查过程。

---

## 一、第一步：开慢查询日志，找到嫌疑 SQL

排查慢查询的起点是日志。PostgreSQL 有内置的慢查询日志，但默认是关着的。

### 临时开启（不重启，立刻生效）

```sql
-- 记录超过 1 秒的查询（单位：毫秒）
ALTER SYSTEM SET log_min_duration_statement = 1000;

-- 同时记录查询计划（可选，有开销，排查完建议关掉）
ALTER SYSTEM SET auto_explain.log_min_duration = 1000;

-- 使配置生效
SELECT pg_reload_conf();
```

生效后，超过阈值的查询会写进 PostgreSQL 的日志文件（通常在 `/var/log/postgresql/` 或者 `pg_log/`）：

```
2026-03-27 15:03:41.123 CST [1234] LOG:  duration: 4821.234 ms  statement:
    SELECT c.id, c.name, c.budget, c.status, u.email
    FROM campaigns c
    LEFT JOIN users u ON c.created_by = u.id
    WHERE c.advertiser_id = 42
    ORDER BY c.created_at DESC
    LIMIT 20
```

找到了：一条查询 campaigns 的 SQL，跑了将近 5 秒。

### 用 pg_stat_statements 捞历史慢查询

如果事故已经过了，可以用 `pg_stat_statements` 扩展查历史数据：

```sql
-- 开启扩展（需要管理员权限）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 找出平均执行时间最长的 10 条查询
SELECT 
    round(mean_exec_time::numeric, 2) AS avg_ms,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

输出类似：

```
 avg_ms  | calls | total_ms | query
---------+-------+----------+-------
 4821.23 |  1847 | 8,905,633 | SELECT c.id, c.name...
  234.56 | 52341 | 12,294,124 | SELECT * FROM ad_materials...
```

第二条虽然单次不慢，但调用次数 52341 次，总耗时反而更高——这是另一个值得优化的点。

---

## 二、第二步：EXPLAIN ANALYZE，看懂执行计划

找到慢 SQL 之后，用 `EXPLAIN ANALYZE` 看它到底在干什么：

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT c.id, c.name, c.budget, c.status, u.email
FROM campaigns c
LEFT JOIN users u ON c.created_by = u.id
WHERE c.advertiser_id = 42
ORDER BY c.created_at DESC
LIMIT 20;
```

> ⚠️ 注意：`EXPLAIN ANALYZE` 会**真正执行这条 SQL**，如果是写操作记得包在事务里然后 ROLLBACK。

输出：

```
Limit  (cost=0.00..4821.23 rows=20 width=156) (actual time=4820.234..4821.123 rows=20 loops=1)
  ->  Sort  (cost=0.00..12543.56 rows=100348 width=156) (actual time=4820.123..4820.456 rows=20 loops=1)
        Sort Key: c.created_at DESC
        Sort Method: external merge  Disk: 8432kB        <- 🚨 这里
        ->  Hash Left Join  (cost=...) (actual time=0.234..4819.789 rows=100348 loops=1)
              ->  Seq Scan on campaigns c  (cost=0.00..8432.48 rows=100348 width=124) (actual time=0.123..3421.234 rows=100348 loops=1)
                    Filter: (advertiser_id = 42)
                    Rows Removed by Filter: 891234        <- 🚨 这里
              ->  Hash  (...)
                    ->  Seq Scan on users u  (...)
```

两个红旗：

1. **`Seq Scan on campaigns`，过滤掉了 891234 行**：说明 campaigns 表上 `advertiser_id` 字段没有索引，全表扫描然后再过滤，代价极高。

2. **`Sort Method: external merge  Disk: 8432kB`**：排序数据量太大，内存放不下，用了磁盘排序，又慢了一截。

### 怎么看 EXPLAIN 输出

几个关键字段：

| 字段 | 含义 |
|------|------|
| `cost=X..Y` | 预估代价，X 是启动代价，Y 是总代价（相对值，不是毫秒） |
| `actual time=X..Y` | 实际执行时间（毫秒），X 是第一行时间，Y 是最后一行时间 |
| `rows=N` | 预估行数 / 实际行数 |
| `Seq Scan` | 全表扫描，通常是问题所在 |
| `Index Scan` / `Index Only Scan` | 用到了索引，好事 |
| `Rows Removed by Filter: N` | 扫了多少行最后被过滤掉，N 越大越浪费 |

---

## 三、最常见的三种慢查询模式

### 模式一：缺索引（最常见）

上面的例子就是。`advertiser_id` 是高频查询条件，但没有索引，导致每次都全表扫描。

**修复**：

```sql
CREATE INDEX CONCURRENTLY idx_campaigns_advertiser_id 
ON campaigns(advertiser_id);
```

`CONCURRENTLY` 选项允许在不锁表的情况下建索引，生产环境建索引必用。

建完再跑 EXPLAIN ANALYZE：

```
Limit  (cost=0.56..85.23 rows=20 width=156) (actual time=0.234..1.123 rows=20 loops=1)
  ->  Index Scan using idx_campaigns_advertiser_id on campaigns c
        (actual time=0.123..0.856 rows=20 loops=1)
        Index Cond: (advertiser_id = 42)
```

从 4821ms 降到 1ms。这就是索引的力量。

**复合索引**：如果同时有排序，可以把排序字段也加进索引：

```sql
-- 同时支持 WHERE advertiser_id = ? ORDER BY created_at DESC
CREATE INDEX CONCURRENTLY idx_campaigns_advertiser_created
ON campaigns(advertiser_id, created_at DESC);
```

---

### 模式二：N+1 查询

这是 ORM 用户的经典陷阱。表面上只调用了一次查询，实际上背后跑了 N+1 条 SQL。

**问题代码**：

```python
# 查 20 条广告活动，然后访问每条的关联数据
campaigns = session.query(Campaign).filter_by(advertiser_id=42).limit(20).all()

for campaign in campaigns:
    print(campaign.materials)  # 每次访问都触发一条 SQL！
```

日志里看到的就是这种：

```
SELECT * FROM campaigns WHERE advertiser_id = 42 LIMIT 20;
SELECT * FROM ad_materials WHERE campaign_id = 1;
SELECT * FROM ad_materials WHERE campaign_id = 2;
SELECT * FROM ad_materials WHERE campaign_id = 3;
... (重复 20 次)
```

一共 21 条 SQL，每条单独走一次网络往返。

**修复**：用 `joinedload` 或 `selectinload` 提前加载关联数据：

```python
from sqlalchemy.orm import joinedload, selectinload

# joinedload：用 JOIN 一次查完（适合一对一或少量关联）
campaigns = (
    session.query(Campaign)
    .options(joinedload(Campaign.materials))
    .filter_by(advertiser_id=42)
    .limit(20)
    .all()
)

# selectinload：用 IN 查询批量加载（适合一对多关联数量较多时）
campaigns = (
    session.query(Campaign)
    .options(selectinload(Campaign.materials))
    .filter_by(advertiser_id=42)
    .limit(20)
    .all()
)
```

从 21 条 SQL 变成 2 条，效果立竿见影。

**怎么发现 N+1**：开启 SQLAlchemy 的 SQL 日志输出，数一数同一种 SQL 是不是在重复：

```python
import logging
logging.getLogger('sqlalchemy.engine').setLevel(logging.INFO)
```

---

### 模式三：隐式类型转换导致索引失效

这个坑比较隐蔽。明明有索引，EXPLAIN 还是走了全表扫描。

**典型场景**：

```python
# campaign_id 在数据库里是 INTEGER，但传了字符串
session.execute(
    text("SELECT * FROM campaigns WHERE campaign_id = :id"),
    {"id": "12345"}  # 字符串！
)
```

PostgreSQL 需要对每一行的 `campaign_id` 做隐式类型转换，才能和字符串 "12345" 比较，索引就用不上了。

```sql
-- 走索引 ✅
SELECT * FROM campaigns WHERE campaign_id = 12345;

-- 全表扫描 ❌（类型不匹配，索引失效）
SELECT * FROM campaigns WHERE campaign_id = '12345';
```

**修复**：传正确的类型，或者显式转换：

```python
# 正确：传 int
{"id": int(campaign_id)}

# 或者 SQL 里显式转换
text("SELECT * FROM campaigns WHERE campaign_id = CAST(:id AS INTEGER)")
```

另一个常见的隐式转换场景：对字段做函数操作。

```sql
-- 全表扫描，索引失效 ❌
SELECT * FROM campaigns WHERE DATE(created_at) = '2026-03-27';

-- 走索引 ✅
SELECT * FROM campaigns 
WHERE created_at >= '2026-03-27 00:00:00' 
  AND created_at < '2026-03-28 00:00:00';
```

原则：**不要对索引字段做函数操作，把转换移到比较值那一侧**。

---

## 四、怎么看 SQLAlchemy ORM 生成的 SQL

ORM 最大的问题是你不知道它实际生成了什么 SQL。几种方式把它捞出来：

### 方式一：开 SQLAlchemy 日志

```python
import logging
logging.basicConfig()
logging.getLogger('sqlalchemy.engine').setLevel(logging.INFO)
```

所有 SQL 都会打到控制台，开发环境调试用。

### 方式二：`compile()` 预览

```python
query = session.query(Campaign).filter_by(advertiser_id=42).limit(20)

# 打印 SQL（不执行）
print(query.statement.compile(
    dialect=postgresql.dialect(),
    compile_kwargs={"literal_binds": True}  # 把参数值也打进去，而不是 :param
))
```

### 方式三：直接 `str(query)` 快速预览

```python
print(str(query))
# 输出：SELECT campaigns.id, campaigns.name, ... FROM campaigns WHERE campaigns.advertiser_id = :advertiser_id_1 LIMIT :param_1
```

参数用占位符，不如方式二直观，但够用。

### 方式四：用 `EXPLAIN` 包一层（推荐）

```python
from sqlalchemy import text

stmt = session.query(Campaign).filter_by(advertiser_id=42).limit(20).statement

# 把 ORM 查询丢给 EXPLAIN ANALYZE
explain_result = session.execute(
    text(f"EXPLAIN (ANALYZE, BUFFERS) {stmt.compile(dialect=postgresql.dialect())}")
)
for row in explain_result:
    print(row[0])
```

直接看执行计划，不用猜。

---

## 五、排查流程总结

遇到慢接口，按这个顺序来：

```
1. pg_stat_statements / 慢查询日志
   └── 定位到具体 SQL

2. EXPLAIN (ANALYZE, BUFFERS)
   └── 看执行计划
       ├── Seq Scan + 大量 Rows Removed → 加索引
       ├── 重复的同类 SQL → N+1，加 joinedload/selectinload
       └── 有索引但没用到 → 检查类型匹配、函数操作

3. 修复后再跑一次 EXPLAIN ANALYZE 验证
   └── 确认走了索引，时间降下来了

4. 用 pg_stat_statements 持续监控
   └── 别让新的慢查询悄悄长出来
```

慢查询排查没什么玄学，就是一套固定的流程。真正麻烦的是那些"看起来没问题但就是慢"的查询——通常是数据量增长到某个临界点之后才暴露，索引选择性不够、统计信息过期、或者查询计划选错了路径。这些留到以后再聊。
