---
title: "PostgreSQL 深度解析：不只是「更好的 MySQL」"
date: "2026-03-20"
tags: ["数据库"]
summary: "PostgreSQL 和 MySQL 都叫关系型数据库，但设计哲学截然不同。这篇文章从架构、数据类型、事务、索引到扩展性，系统拆解 PostgreSQL 的核心机制，并在关键处与 MySQL 做对比——让你真正理解该用哪个，以及为什么。"
---

"为什么不直接用 MySQL？" 这是我每次提到 PostgreSQL 都会遇到的问题。

简短的回答是：MySQL 和 PostgreSQL 都是关系型数据库，但设计哲学不同，适用场景有差异。长的回答就是这篇文章。

## 一、先说清楚两者的定位

MySQL 的设计目标是**简单、快速、易用**。早期版本（5.x 之前）甚至可以牺牲数据一致性换取速度——默认的 MyISAM 引擎不支持事务，`INSERT` 完全不管你的外键约束。这个选择让 MySQL 在 LAMP 时代大放异彩，几乎每个 PHP 网站都在用它。

PostgreSQL 的设计目标是**正确性和标准兼容性**。它从 1986 年的 POSTGRES 研究项目演化而来，始终把 SQL 标准遵从、ACID 完整性、数据类型丰富度放在第一位，代价是早期版本的性能和易用性不如 MySQL。

现在两者的差距已经缩小很多——MySQL 8.0 的 InnoDB 引擎早已支持完整事务，性能也大幅提升。但设计基因的差异仍然存在，在某些场景下会造成实质性影响。

---

## 二、架构差异：进程 vs 线程

这是两者最根本的架构区别，影响了连接管理、内存使用和并发行为。

### PostgreSQL：每连接一个进程

PostgreSQL 为每个客户端连接 fork 一个独立的后台进程（backend process）：

```
客户端 A ──→ backend process 1 (PID: 1234)
客户端 B ──→ backend process 2 (PID: 1235)
客户端 C ──→ backend process 3 (PID: 1236)
              ↓
         shared memory (buffer pool, lock table, etc.)
```

进程间通过共享内存通信。每个进程独立崩溃不会影响其他连接，稳定性好。但进程比线程更重——每个连接消耗约 5-10MB 内存，连接数上去之后内存压力很大。

这也是为什么 **PgBouncer 几乎是 PostgreSQL 生产必备**——它在应用和 PostgreSQL 之间做连接池，用少量长连接服务大量短连接请求。

### MySQL：每连接一个线程

MySQL 为每个连接创建一个线程，线程比进程轻，连接开销更小。MySQL 8.0 默认开启线程缓存（`thread_cache_size`），复用已关闭连接的线程，进一步降低开销。

对于连接数很高（> 1000）的场景，MySQL 的线程模型在连接管理上天然比 PostgreSQL 更轻量。

**实践建议**：
- PostgreSQL：必须上连接池（PgBouncer），把实际连接数控制在 100-200 以内
- MySQL：连接管理问题相对小，但超高并发下仍然建议上连接池（ProxySQL）

---

## 三、事务与 MVCC：两种不同的实现

两者都实现了 MVCC（多版本并发控制），但方式不同，副作用也不同。

### PostgreSQL 的 MVCC：堆内版本

PostgreSQL 的每次 UPDATE 不是"修改原行"，而是**写一个新版本的行**，旧版本暂时保留：

```
原始行:  (xmin=100, xmax=0,   name="Alice", age=28)

执行 UPDATE SET age=29 后:
旧版本:  (xmin=100, xmax=200, name="Alice", age=28)  ← 标记为被事务200删除
新版本:  (xmin=200, xmax=0,   name="Alice", age=29)  ← 事务200创建的新版本
```

`xmin` 是创建该行版本的事务 ID，`xmax` 是删除（或更新）该行版本的事务 ID。查询时，每个事务根据自己的"快照"（snapshot）看到应该看到的版本。

**副作用：表膨胀（Table Bloat）**

旧版本行不会立即删除，需要 VACUUM 进程清理。如果 VACUUM 跟不上写入速度，表文件会持续膨胀，严重时会导致性能下降。这是 PostgreSQL 生产运维中最常见的问题之一。

```sql
-- 手动 VACUUM（分析并清理死元组）
VACUUM ANALYZE users;

-- 更激进：回收磁盘空间（会锁表）
VACUUM FULL users;

-- 查看表膨胀情况
SELECT relname, n_dead_tup, n_live_tup,
       round(n_dead_tup::numeric / nullif(n_live_tup, 0) * 100, 2) AS dead_ratio
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

**autovacuum** 是 PostgreSQL 的自动清理进程，默认开启，但在写入密集的场景需要仔细调优参数，否则可能出现 autovacuum 跟不上写入速度的情况。

### MySQL InnoDB 的 MVCC：Undo Log

MySQL InnoDB 的旧版本数据存储在**独立的 Undo Log 段**，而不是和新数据混在同一个表空间。这意味着：

- 表文件本身不会因为 MVCC 膨胀
- 但 Undo Log 可能膨胀（长事务不提交会让 Undo Log 无法清理）

**两者的实质差异**：
- PostgreSQL 的 MVCC 把"历史版本"放在表数据文件里，清理需要 VACUUM
- MySQL 的 MVCC 把"历史版本"放在 Undo Log 里，清理由 Purge 线程处理

对于运维来说，MySQL 在这点上更"透明"——表文件大小更稳定，不需要 DBA 操心 VACUUM 调优。

---

## 四、索引：PostgreSQL 的优势地带

这是 PostgreSQL 相比 MySQL 差距最明显的地方。

### B-Tree：两者都有，但 PostgreSQL 更丰富

两者都支持标准 B-Tree 索引，这是最常用的索引类型。但 PostgreSQL 的 B-Tree 索引支持：

```sql
-- 部分索引（Partial Index）：只索引满足条件的行
CREATE INDEX idx_active_users ON users (email) WHERE is_active = TRUE;
-- 只索引活跃用户，索引体积大幅缩小，查询速度更快

-- 表达式索引（Expression Index）：索引计算结果
CREATE INDEX idx_lower_email ON users (lower(email));
-- 这样 WHERE lower(email) = 'alice@example.com' 就能走索引

-- 覆盖索引（INCLUDE 列）：把额外列放进索引，避免回表
CREATE INDEX idx_users_email ON users (email) INCLUDE (name, created_at);
```

MySQL 8.0 也支持函数索引和不可见索引，但部分索引（Partial Index）MySQL 至今不支持。对于大表中只需要查询一小部分行的场景，部分索引是非常强大的优化手段。

### GIN 索引：全文搜索和数组查询

GIN（Generalized Inverted Index，广义倒排索引）是 PostgreSQL 的特色索引，专为多值数据设计：

```sql
-- 全文搜索
CREATE INDEX idx_articles_fts ON articles USING GIN (to_tsvector('english', content));

SELECT title FROM articles
WHERE to_tsvector('english', content) @@ to_tsquery('postgresql & index');

-- JSONB 字段索引
CREATE INDEX idx_meta ON products USING GIN (metadata);

SELECT * FROM products WHERE metadata @> '{"category": "electronics"}';

-- 数组包含查询
CREATE INDEX idx_tags ON posts USING GIN (tags);

SELECT * FROM posts WHERE tags @> ARRAY['postgresql', 'database'];
```

MySQL 有全文索引（FULLTEXT），但功能和灵活性与 PostgreSQL 的 GIN 索引相差较大，尤其是对中文支持和 JSONB 查询。

### GiST 索引：几何和范围查询

GiST（Generalized Search Tree）用于几何数据、范围类型、全文搜索等：

```sql
-- 地理位置查询（需要 PostGIS 扩展）
CREATE INDEX idx_location ON stores USING GIST (location);
SELECT * FROM stores WHERE ST_DWithin(location, ST_MakePoint(116.4, 39.9), 5000);

-- 范围类型查询
CREATE INDEX idx_schedule ON events USING GIST (time_range);
SELECT * FROM events WHERE time_range && '[2026-03-01, 2026-03-31]'::daterange;
```

MySQL 没有原生等价的索引类型，地理查询需要借助第三方插件。

### BRIN 索引：超大表的时序数据

BRIN（Block Range INdex）存储每个数据块的最小/最大值，体积极小，适合单调递增的大表：

```sql
-- 日志表，时间戳单调递增，BRIN 索引只有几 KB
CREATE INDEX idx_logs_time ON logs USING BRIN (created_at);
```

对于时序数据（日志、监控指标），BRIN 索引占用空间是 B-Tree 的 1/1000，但查询效率在数据有序的情况下仍然很高。

---

## 五、数据类型：PostgreSQL 的另一优势

MySQL 的数据类型基本够用，但 PostgreSQL 在类型系统上要丰富得多。

### JSONB：真正的半结构化数据支持

PostgreSQL 有两种 JSON 类型：
- `JSON`：存储原始文本，每次查询都需要解析
- `JSONB`：二进制存储，支持索引，查询更快

```sql
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name TEXT,
    attributes JSONB
);

INSERT INTO products VALUES (1, 'Laptop', '{"brand": "Dell", "ram": 16, "tags": ["gaming", "work"]}');

-- 字段提取
SELECT attributes->>'brand' FROM products WHERE id = 1;
-- 返回: "Dell"

-- 嵌套查询
SELECT * FROM products WHERE attributes->'ram' > '8'::jsonb;

-- 包含查询（可走 GIN 索引）
SELECT * FROM products WHERE attributes @> '{"brand": "Dell"}';

-- 更新某个字段（不需要替换整个对象）
UPDATE products SET attributes = jsonb_set(attributes, '{ram}', '32') WHERE id = 1;
```

MySQL 8.0 的 JSON 类型也支持类似操作，但：
- MySQL JSON 列不能直接建 GIN 倒排索引，只能建基于生成列的索引，操作繁琐
- MySQL JSON 的路径查询语法与 PostgreSQL 不同，且功能稍弱
- PostgreSQL JSONB 的 `@>` 包含操作符配合 GIN 索引，性能极佳

### 数组类型

```sql
-- 直接存数组
CREATE TABLE posts (
    id SERIAL,
    title TEXT,
    tags TEXT[]
);

INSERT INTO posts VALUES (1, '入门教程', ARRAY['postgresql', 'database', 'tutorial']);

-- 数组操作
SELECT * FROM posts WHERE 'postgresql' = ANY(tags);
SELECT array_length(tags, 1) FROM posts;
SELECT unnest(tags) FROM posts;  -- 展开为多行
```

MySQL 没有原生数组类型，需要用 JSON 或关联表模拟。对于标签、权限列表这类场景，PostgreSQL 的数组类型更直观。

### 范围类型

```sql
-- 时间范围
CREATE TABLE reservations (
    room_id INT,
    period TSRANGE  -- 时间戳范围
);

INSERT INTO reservations VALUES (101, '[2026-03-20 14:00, 2026-03-20 16:00)');

-- 查询有没有时间冲突
SELECT * FROM reservations
WHERE room_id = 101
  AND period && '[2026-03-20 15:00, 2026-03-20 17:00)'::tsrange;

-- 排除约束：数据库层面禁止时间冲突
CREATE TABLE reservations (
    room_id INT,
    period TSRANGE,
    EXCLUDE USING GIST (room_id WITH =, period WITH &&)
);
```

用排除约束（EXCLUDE CONSTRAINT）在数据库层面防止时间冲突，这是 PostgreSQL 独有的功能，在 MySQL 中只能靠应用层逻辑实现（有并发漏洞）。

### 其他特色类型

- `UUID`：原生支持，有专用存储格式（16字节），比 VARCHAR(36) 更高效
- `ENUM`：PostgreSQL 的枚举可以添加新值，MySQL 的枚举加新值需要 ALTER TABLE（可能锁表）
- `INET/CIDR`：原生 IP 地址类型，支持子网匹配查询
- `HSTORE`：键值对类型（已被 JSONB 基本取代）

---

## 六、窗口函数与 CTE：分析查询的利器

两者都支持窗口函数和 CTE（Common Table Expressions），但 PostgreSQL 的支持更完整，在 8.4 版本（2009 年）就已完善，而 MySQL 到 8.0（2018 年）才完整支持。

### 窗口函数

```sql
-- 计算每个部门内的薪资排名
SELECT
    name,
    department,
    salary,
    RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dept_rank,
    salary - AVG(salary) OVER (PARTITION BY department) AS diff_from_avg,
    SUM(salary) OVER (ORDER BY hire_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM employees;
```

### 递归 CTE

PostgreSQL 的递归 CTE 可以处理树形结构（组织架构、分类体系、评论回复）：

```sql
-- 查找某员工的所有下属（任意层级）
WITH RECURSIVE subordinates AS (
    -- 基础查询：直接下属
    SELECT id, name, manager_id, 1 AS level
    FROM employees
    WHERE id = 100  -- 从 ID=100 的员工开始

    UNION ALL

    -- 递归：下属的下属
    SELECT e.id, e.name, e.manager_id, s.level + 1
    FROM employees e
    JOIN subordinates s ON e.manager_id = s.id
)
SELECT * FROM subordinates ORDER BY level, name;
```

MySQL 8.0 也支持递归 CTE，语法一致。这一块两者差距不大。

---

## 七、全文搜索

PostgreSQL 内置全文搜索，不需要额外组件：

```sql
-- 建立全文搜索索引
ALTER TABLE articles ADD COLUMN search_vector TSVECTOR;
UPDATE articles SET search_vector = to_tsvector('english', title || ' ' || content);
CREATE INDEX idx_fts ON articles USING GIN (search_vector);

-- 搜索
SELECT title, ts_rank(search_vector, query) AS rank
FROM articles, to_tsquery('english', 'postgresql & index') query
WHERE search_vector @@ query
ORDER BY rank DESC;
```

MySQL 也有 FULLTEXT 索引，但：
- PostgreSQL 支持词干提取（stemming）、停用词、自定义词典，中文需要 zhparser 扩展
- PostgreSQL 支持相关性排序（ts_rank），MySQL 的相关性排序功能较弱
- 两者对中文的支持都需要额外配置，不是开箱即用

对于需要复杂全文搜索的场景，通常还是会选择 Elasticsearch，PostgreSQL 内置的全文搜索更适合简单场景。

---

## 八、扩展性：PostgreSQL 的杀手锏

PostgreSQL 支持扩展（Extension），可以像插件一样加载额外功能，这是 MySQL 没有的能力：

```sql
-- 安装扩展
CREATE EXTENSION IF NOT EXISTS postgis;      -- 地理信息
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- 模糊搜索（trigram）
CREATE EXTENSION IF NOT EXISTS uuid-ossp;   -- UUID 生成
CREATE EXTENSION IF NOT EXISTS timescaledb; -- 时序数据库
CREATE EXTENSION IF NOT EXISTS pgvector;    -- 向量数据库（AI 场景）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements; -- SQL 性能分析
```

**pgvector** 是近两年最火的扩展——让 PostgreSQL 支持向量存储和相似度查询，直接支持 AI 应用的 RAG（检索增强生成）场景：

```sql
CREATE EXTENSION vector;

CREATE TABLE documents (
    id SERIAL PRIMARY KEY,
    content TEXT,
    embedding VECTOR(1536)  -- OpenAI embedding 维度
);

-- 插入向量
INSERT INTO documents (content, embedding) VALUES ('...', '[0.1, 0.2, ...]');

-- 余弦相似度查询（找最相近的文档）
SELECT content, 1 - (embedding <=> '[0.15, 0.18, ...]') AS similarity
FROM documents
ORDER BY embedding <=> '[0.15, 0.18, ...]'
LIMIT 10;
```

**PostGIS** 让 PostgreSQL 成为功能完整的地理信息数据库，支持坐标系转换、空间计算、地图数据存储，是 MySQL 地理功能完全无法比拟的。

---

## 九、复制与高可用

### PostgreSQL

PostgreSQL 的主从复制基于 WAL（Write-Ahead Log）：

- **流复制（Streaming Replication）**：异步或同步，从库实时接收 WAL 并应用
- **逻辑复制（Logical Replication）**：基于逻辑变更（行级别），支持跨版本复制、部分表复制
- **Patroni + etcd**：生产常用的高可用方案，自动故障转移

```sql
-- 查看复制状态
SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       (sent_lsn - replay_lsn) AS replication_lag
FROM pg_stat_replication;
```

### MySQL

MySQL 的复制成熟度更高，方案更多：

- **GTID 复制**：全局事务 ID，保证数据一致性，简化主从切换
- **组复制（Group Replication）**：多主写入，内置冲突检测
- **MySQL InnoDB Cluster**：官方高可用方案，基于组复制
- **ProxySQL + Orchestrator**：生产常用第三方方案

MySQL 在复制和高可用上的生态比 PostgreSQL 更成熟、更多选择，这是 MySQL 的优势。

---

## 十、性能对比：没有绝对答案

网上很多"PostgreSQL vs MySQL 性能对比"的文章，结论往往互相矛盾。原因是性能高度依赖具体场景。

| 场景 | 倾向 | 原因 |
|------|------|------|
| 简单 OLTP（高频读写） | MySQL 略优 | 线程模型，连接开销小 |
| 复杂查询（多表 JOIN） | PostgreSQL 略优 | 查询优化器更强 |
| 全文搜索 | PostgreSQL 优 | GIN 索引更强 |
| 地理数据 | PostgreSQL 大幅优 | PostGIS |
| 写入密集型 | MySQL 略优 | 无 VACUUM 开销 |
| 分析查询（OLAP） | PostgreSQL 优 | 窗口函数、CTE、并行查询更成熟 |
| 向量检索（AI） | PostgreSQL | pgvector |

---

## 十一、怎么选

一个简单的决策框架：

**选 PostgreSQL 的理由：**
- 数据模型复杂（JSONB、数组、范围类型、地理数据）
- 需要复杂查询和分析
- 团队有能力维护（VACUUM 调优、连接池配置）
- 需要 PostGIS、pgvector 等扩展
- 对 SQL 标准兼容性有要求

**选 MySQL 的理由：**
- 团队熟悉 MySQL，迁移成本高
- 简单的 CRUD 场景，不需要复杂特性
- 对连接数要求极高（> 5000 并发连接）
- 需要成熟的主从复制生态

**选哪个都行的情况：**
- 普通 Web 应用的后端数据库（两者都完全够用）

---

MySQL 和 PostgreSQL 都是优秀的数据库，"哪个更好"是个伪命题。但如果你的项目对数据类型、查询复杂度、扩展性有要求，PostgreSQL 往往能让你少写很多业务层的"补丁代码"——那些本来应该由数据库来保证的约束，不用再在应用层重新实现一遍。
