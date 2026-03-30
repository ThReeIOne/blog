---
title: "SQLAlchemy 连接池：那些年我们配错的参数"
tags: ["数据库", "Python", "SQLAlchemy", "PostgreSQL"]
summary: "pool_size 设大一点就没问题了吧？错。连接池的参数配错不会立刻爆炸，但会在某个流量高峰的下午，用一个莫名其妙的报错来找你算账。这篇文章把 SQLAlchemy 连接池的核心参数讲清楚，顺带复盘三种常见事故场景。"
---

"数据库连接池设多大合适？"

"不知道，先写 100 吧，够用了。"

这段对话我敢说大多数后端都经历过。pool_size 这种参数，不报错就不会有人去细看。直到某天流量一上来，`TimeoutError: QueuePool limit of size 5 overflow 10 reached` 突然出现在告警里，才开始翻文档。

这篇文章把 SQLAlchemy 连接池的核心参数讲清楚，顺带复盘三种典型事故场景，以及生产环境的推荐配置。

---

## 一、先弄清楚连接池在干什么

数据库连接本质上是一个 TCP 连接，建立过程有握手、认证，开销不小。如果每次 SQL 执行都新建连接、用完就关，在高并发下会把大量时间浪费在连接建立上。

连接池的思路很朴素：**提前建好一批连接放着，用的时候借，用完还回去**。

```
应用进程
  ├── 请求 1 ──→ 从池里借连接 ──→ 执行 SQL ──→ 还回去
  ├── 请求 2 ──→ 从池里借连接 ──→ 执行 SQL ──→ 还回去
  └── 请求 3 ──→ 池里没空闲连接 → 等待/报错
                   ↓
              [连接池]
              conn1 (idle)
              conn2 (in use)
              conn3 (idle)
                   ↓
              PostgreSQL Server
```

SQLAlchemy 默认使用 `QueuePool`，这是最常用的连接池实现，下面的参数都以它为准。

---

## 二、四个核心参数，逐一拆解

### `pool_size`：池子里常驻的连接数

```python
engine = create_engine(
    DATABASE_URL,
    pool_size=5  # 默认值
)
```

这是连接池**稳定维持**的连接数量。服务启动后，池子里会逐渐创建最多 `pool_size` 条连接，空闲时也不会主动关闭。

**常见误解**：pool_size 越大越好。

不对。每条连接对 PostgreSQL 来说都是一个进程（是的，PG 每个连接对应一个后端进程，不是线程），会消耗内存和 CPU。生产环境的 PostgreSQL 服务器连接数通常有上限（`max_connections`，默认 100），多个服务实例共享这个上限，盲目调大 pool_size 很容易把 PG 的连接数撑爆。

**合理值**：单个服务实例 `pool_size` 建议 5~20，根据并发量和服务实例数计算，保证 `pool_size × 实例数 < max_connections × 0.8`（留 20% 给 DBA 运维操作）。

---

### `max_overflow`：临时扩容上限

```python
engine = create_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=10  # 默认值
)
```

当池子里所有连接都在用，新请求进来时，可以**临时创建额外的连接**，最多额外创建 `max_overflow` 条。

也就是说，最大并发连接数 = `pool_size + max_overflow`，默认是 5 + 10 = 15。

overflow 连接和普通连接的区别：**用完之后会被关闭，不放回池子里**。毕竟是临时工，任务完成就走。

**什么时候调这个**：流量有明显的峰谷特征，平时 5 条够用，偶尔来一波请求需要撑到 20 条，这时候 overflow 就有价值。如果流量比较平稳，overflow 意义不大，甚至可以设成 0，更容易预测连接数上限。

---

### `pool_timeout`：等连接等多久

```python
engine = create_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=10,
    pool_timeout=30  # 默认 30 秒
)
```

当 `pool_size + max_overflow` 全满，新请求需要排队等待空闲连接。等待超过 `pool_timeout` 秒后，抛出：

```
sqlalchemy.exc.TimeoutError: QueuePool limit of size 5 overflow 10 reached,
connection timed out, timeout 30
```

**常见配置错误**：把 `pool_timeout` 设得很大（比如 300 秒），以为这样可以"避免报错"。实际效果是：请求在连接池里排队 5 分钟，用户早就超时了，而且这 5 分钟里大量请求在积压，服务雪崩的概率更高。

**推荐**：`pool_timeout` 设成 5~10 秒，快速失败，让上游重试或降级，比慢慢等死强。

---

### `pool_recycle`：连接保鲜时间

```python
engine = create_engine(
    DATABASE_URL,
    pool_recycle=3600  # 默认 -1，不回收
)
```

数据库连接长时间不用会被服务端主动断开（PostgreSQL 有 `tcp_keepalives_idle`，防火墙也可能断开空闲连接）。应用侧的连接池不知道连接已经断了，下次借出去执行 SQL 就会报：

```
sqlalchemy.exc.OperationalError: (psycopg2.OperationalError) 
server closed the connection unexpectedly
```

`pool_recycle` 的作用是：超过指定秒数的连接，在借出去之前主动关闭并重建，避免用到"已经死了"的连接。

**推荐**：设成 `1800`（30 分钟），比大多数防火墙的空闲连接超时要短，基本能规避这个问题。

同时建议开启 `pool_pre_ping`：

```python
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True  # 借连接前发一个 SELECT 1 测活
)
```

两个配合使用，连接健康问题基本可以消灭。

---

## 三、三种典型事故复盘

### 事故一：连接泄漏，池子被慢慢榨干

**现象**：服务刚启动一切正常，跑几个小时后开始报 `QueuePool limit reached`，重启服务就好了，过几小时又出现。

**根因**：有代码路径没有正确释放连接。

```python
# 危险写法——异常时连接不会被释放
def get_user(user_id: int):
    conn = engine.connect()
    result = conn.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_id})
    # 如果这里抛了异常，conn 就泄漏了
    conn.close()
    return result.fetchone()
```

```python
# 正确写法——用 with 语句，异常也会自动释放
def get_user(user_id: int):
    with engine.connect() as conn:
        result = conn.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_id})
        return result.fetchone()
```

SQLAlchemy 的 Session 同理，始终用 `with Session(engine) as session` 或者依赖注入框架管理生命周期，不要手动 `session = Session(engine)` 然后忘了关。

**排查方法**：在 PostgreSQL 里查活跃连接，看哪些是 idle 状态但长时间不动：

```sql
SELECT pid, state, query_start, query, client_addr
FROM pg_stat_activity
WHERE datname = 'your_db_name'
ORDER BY query_start;
```

如果 idle 连接数在持续增长，基本就是泄漏了。

---

### 事故二：连接数打满，上游雪崩

**现象**：某个接口突然慢，同时连接池报 timeout，然后其他接口也开始超时，整个服务挂了。

**根因**：连接池配置（pool_size + max_overflow）相对于并发量太小，加上某个慢 SQL 占着连接不释放，形成了堰塞湖。

这里有个典型的死亡螺旋：
1. 慢 SQL 导致连接占用时间变长
2. 新请求进来拿不到连接，开始排队
3. 排队的请求越来越多，`pool_timeout` 前大家都在等
4. 等待中的请求持续消耗线程/协程资源，服务整体变慢
5. 更多请求进来，循环

**解法**：
- 短期：加大 `pool_size` 或者增加服务实例分散连接
- 根本：找出慢 SQL，加索引或者优化查询
- 防御：给业务层加超时（FastAPI 可以用 `asyncio.wait_for`），别让一个慢接口拖垮全局

---

### 事故三：`server closed the connection unexpectedly`

**现象**：服务低频运行（比如后台任务，每隔几小时跑一次），某次跑的时候报连接断开。

**根因**：连接在池里闲置太久，被 PostgreSQL 或中间网络设备断开了，但池子不知道，把死连接借出去了。

**解法**：

```python
engine = create_engine(
    DATABASE_URL,
    pool_recycle=1800,   # 30 分钟回收
    pool_pre_ping=True   # 借出前测活
)
```

如果是批处理任务，也可以考虑用 `NullPool`——每次都新建连接，用完就关，不缓存：

```python
from sqlalchemy.pool import NullPool

engine = create_engine(DATABASE_URL, poolclass=NullPool)
```

开销大一点，但对于低频任务完全可以接受，省去了连接池管理的心智负担。

---

## 四、生产环境推荐配置

```python
from sqlalchemy import create_engine

engine = create_engine(
    DATABASE_URL,
    # 连接池大小：根据并发量和实例数计算
    # 原则：pool_size × 实例数 < PostgreSQL max_connections × 0.8
    pool_size=10,
    
    # 允许的临时扩容量
    # 流量平稳可以设 0，有明显波峰可以设 5~10
    max_overflow=5,
    
    # 等待超时：快速失败，不要让请求在池子里积压太久
    pool_timeout=10,
    
    # 连接回收：比防火墙空闲超时短，避免用到死连接
    pool_recycle=1800,
    
    # 借出前测活：和 pool_recycle 配合使用
    pool_pre_ping=True,
)
```

如果用 FastAPI + SQLAlchemy async，记得用 `AsyncEngine`，参数和上面一样：

```python
from sqlalchemy.ext.asyncio import create_async_engine

engine = create_async_engine(
    ASYNC_DATABASE_URL,  # postgresql+asyncpg://...
    pool_size=10,
    max_overflow=5,
    pool_timeout=10,
    pool_recycle=1800,
    pool_pre_ping=True,
)
```

---

## 五、一个容易被忽视的坑：多进程部署

如果用 Gunicorn 多 worker 部署 FastAPI，每个 worker 进程都有自己独立的连接池。

假设：`pool_size=10`，Gunicorn 4 个 worker → 实际最大连接数是 `10 × 4 = 40`，不是 10。

算错这个很容易把 PostgreSQL 的 `max_connections`（默认 100）打满，尤其是多个服务共用一个 PG 实例的时候。

**建议**：把所有服务的 `pool_size × 实例数 × worker数` 加起来，保证不超过 `max_connections × 0.8`。超出的话要么调大 PG 的 max_connections，要么上 PgBouncer 做连接代理。

---

连接池这种东西，配错了不会立刻报错，往往是在某个高峰时段才暴露问题。趁着现在没事，把参数对着这篇文章过一遍，比出了事再查要轻松得多。
