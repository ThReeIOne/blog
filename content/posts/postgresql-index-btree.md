---
title: "PostgreSQL 索引原理：B-Tree 从结构到实战"
tags: ["数据库", "PostgreSQL", "索引", "性能优化"]
summary: "PostgreSQL 默认索引是 B-Tree，但大多数人对它的理解停留在「加了索引查询会变快」这一层。这篇文章从 B-Tree 的数据结构出发，讲清楚它是怎么组织数据的、为什么能加速查询、又在哪些情况下会失效，最后给出一套实用的索引设计原则。"
---

PostgreSQL 里建索引就一行 SQL，但「为什么加了索引就快」「为什么有时候加了也没用」这两个问题，大部分人答不清楚。

这篇文章从 B-Tree 的底层结构讲起，把索引的工作原理捋一遍。

---

## 一、为什么需要索引

先从问题出发。

一张有 1000 万行的表，执行：

```sql
SELECT * FROM orders WHERE user_id = 12345;
```

没有索引的情况下，PostgreSQL 只能做 **Sequential Scan（顺序扫描）**——从第一行读到最后一行，逐行判断 `user_id` 是不是 12345。1000 万行全部过一遍，I/O 开销巨大。

有了索引，PostgreSQL 可以直接定位到 `user_id = 12345` 的位置，只读几十行数据就结束了。

这就是索引的本质：**用空间换时间，把随机查找变成有规律的定向查找**。

---

## 二、B-Tree 是什么

PostgreSQL 默认使用 **B-Tree（Balanced Tree，平衡树）** 索引，也是最通用的索引类型。

B-Tree 不是二叉树（Binary Tree），它是多叉的。准确说，PostgreSQL 用的是 **B+ Tree**，B-Tree 的变种。

### 结构长什么样

B+ Tree 由三种节点组成：

```
                    [Root 节点]
                   /           \
          [内部节点]             [内部节点]
         /         \           /         \
     [叶节点]   [叶节点]   [叶节点]   [叶节点]
         ↔           ↔           ↔
        （叶节点之间有双向链表连接）
```

- **Root 节点**：树的入口，只有一个
- **内部节点（Branch）**：存储键值和指向子节点的指针，不存实际数据
- **叶节点（Leaf）**：存储实际的键值 + 指向表中对应行的指针（ctid）

叶节点之间通过双向链表连接，这个设计非常关键，后面会解释为什么。

### 一个具体例子

假设对 `user_id` 建索引，插入了以下数据：

```
user_id: 1, 5, 9, 12, 20, 25, 30, 35, 40
```

B-Tree 会构建成类似这样的结构（简化版）：

```
              [20]
            /      \
        [9]          [30]
       /   \        /    \
   [1,5]  [9,12]  [20,25] [30,35,40]
```

每个叶节点里不只是存键值，还存着一个 **ctid**（tuple id），指向实际的数据行在哪个物理页面的哪个位置。

---

## 三、查询是怎么走索引的

### 等值查询

```sql
SELECT * FROM orders WHERE user_id = 25;
```

PostgreSQL 从 Root 节点出发：

1. Root 节点值是 20，25 > 20，走右子树
2. 右子树内部节点值是 30，25 < 30，走左子树
3. 到达叶节点 `[20, 25]`，找到 user_id = 25
4. 拿到对应的 ctid，去堆表（Heap）里读那一行数据

整个过程只访问了 3 个节点，时间复杂度是 **O(log n)**。

### 范围查询

```sql
SELECT * FROM orders WHERE user_id BETWEEN 20 AND 35;
```

1. 先找到 user_id = 20 的叶节点（同上，走树找到起始位置）
2. 利用叶节点之间的**双向链表**，顺序往右扫描，依次读取 20、25、30、35
3. 遇到 > 35 的值停止

这就是叶节点双向链表设计的价值：**范围查询不用回到树的上层，直接在叶节点层横向遍历**，效率极高。

### 排序查询

```sql
SELECT * FROM orders WHERE user_id > 10 ORDER BY user_id;
```

B-Tree 的叶节点本身是有序的，所以这个查询找到起始位置后直接顺序读，**不需要额外的排序步骤**，`EXPLAIN` 里你不会看到 `Sort` 节点。

---

## 四、索引为什么会失效

理解了 B-Tree 的结构，很多「索引失效」的原因就能讲清楚了。

### 1. 对索引列做函数运算

```sql
-- 失效：对列做了函数变换
SELECT * FROM orders WHERE DATE(created_at) = '2024-01-01';

-- 有效：改为范围查询
SELECT * FROM orders WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02';
```

B-Tree 存的是原始列值，`DATE(created_at)` 是计算出来的，索引里根本没有这个值，只能全表扫描。

解决方案：改写 SQL，或者建**函数索引**：

```sql
CREATE INDEX ON orders (DATE(created_at));
```

### 2. 隐式类型转换

```sql
-- 表定义：user_id VARCHAR
-- 失效：传了整数
SELECT * FROM orders WHERE user_id = 12345;

-- 有效：类型匹配
SELECT * FROM orders WHERE user_id = '12345';
```

类型不匹配时 PostgreSQL 会隐式转换，本质上也是对列做了函数运算，索引失效。

### 3. 联合索引不符合最左前缀

```sql
-- 建了联合索引 (a, b, c)
CREATE INDEX idx_abc ON orders (a, b, c);

-- 有效：用到了最左列 a
SELECT * FROM orders WHERE a = 1;
SELECT * FROM orders WHERE a = 1 AND b = 2;
SELECT * FROM orders WHERE a = 1 AND b = 2 AND c = 3;

-- 失效：跳过了 a，直接查 b
SELECT * FROM orders WHERE b = 2;
SELECT * FROM orders WHERE b = 2 AND c = 3;
```

联合索引在 B-Tree 里是按 `(a, b, c)` 的顺序排列的。跳过 a 去查 b，相当于在一本按姓氏排序的电话本里直接找名字，无法利用排序结构。

### 4. LIKE 以通配符开头

```sql
-- 失效：前缀不确定
SELECT * FROM users WHERE name LIKE '%张%';
SELECT * FROM users WHERE name LIKE '%张';

-- 有效：固定前缀
SELECT * FROM users WHERE name LIKE '张%';
```

B-Tree 是按字典序排列的，`LIKE '张%'` 可以定位到以「张」开头的范围，`LIKE '%张%'` 无法确定范围，只能全扫。

### 5. 低选择性列

```sql
-- status 只有 0/1 两个值，加索引大概率没用
CREATE INDEX ON orders (status);
SELECT * FROM orders WHERE status = 1;
```

如果 `status = 1` 的行占全表 80%，用索引反而更慢——需要大量回表（每次都去堆表读数据），不如顺序扫描来得快。PostgreSQL 的查询优化器会自动判断，这时候会直接走 Seq Scan 忽略索引。

---

## 五、索引的代价

索引不是免费的。

**写入开销**：每次 INSERT / UPDATE / DELETE，PostgreSQL 除了修改堆表，还要维护索引的 B-Tree 结构，保持平衡。索引越多，写入越慢。

**存储开销**：索引是单独的数据结构，要占磁盘空间。一张大表的多个索引，加起来可能比数据本身还大。

**维护开销**：大量删除后，索引里会有很多「死叶子」（已删除的行），需要 VACUUM 清理，否则索引会膨胀。

---

## 六、几种特殊索引

### 唯一索引

```sql
CREATE UNIQUE INDEX ON users (email);
```

B-Tree 结构相同，只是在插入时额外检查键值唯一性。`PRIMARY KEY` 和 `UNIQUE` 约束底层都是唯一索引。

### 部分索引

```sql
-- 只索引未处理的订单
CREATE INDEX ON orders (created_at) WHERE status = 'pending';
```

只把满足条件的行放进索引，体积更小，对特定查询模式非常高效。比如「查所有未处理的订单」这个场景，大部分历史订单都是已处理的，全量索引里 99% 的数据都用不上。

### 函数索引（表达式索引）

```sql
CREATE INDEX ON users (LOWER(email));
```

对表达式的结果建索引，解决前面说的函数运算导致索引失效的问题。

### 联合索引的列顺序

```sql
-- 场景：经常按 (region, dt) 组合查询，偶尔只按 region 查
CREATE INDEX ON dws_traffic_bundle_visibility_1d (region, dt);
```

选择性高的列放前面，更容易在第一步就过滤掉大量数据。如果两列选择性差不多，把更常单独出现在 WHERE 里的列放前面。

---

## 七、怎么看有没有走索引

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE user_id = 12345;
```

关键词：

- `Index Scan` / `Index Only Scan`：走了索引 ✅
- `Seq Scan`：顺序扫描，没走索引（或者优化器认为全扫更快）
- `Bitmap Index Scan` + `Bitmap Heap Scan`：批量走索引，多个范围条件时常见

`Index Only Scan` 是最理想的情况——查询需要的所有列都在索引里，根本不用回表读堆数据，速度最快。

---

## 八、实用原则总结

**什么时候加索引：**
- 频繁出现在 `WHERE`、`JOIN ON`、`ORDER BY` 里的列
- 外键列（PostgreSQL 不自动建，要手动加）
- 唯一约束列

**什么时候不用加：**
- 选择性极低的列（性别、状态码等）
- 写多读少的表（写入性能更重要）
- 小表（全扫比走索引还快）

**联合索引的原则：**
- 等值条件列放前面，范围条件列放后面
- 最左前缀原则，确保最常用的查询能命中
- 能用联合索引覆盖查询（Index Only Scan）是最优解

**维护：**
- 定期 `ANALYZE` 更新统计信息，让优化器做出正确决策
- 用 `pg_stat_user_indexes` 查哪些索引从来没被用过，及时清理
- 大表重建索引用 `REINDEX CONCURRENTLY`，不锁表

---

B-Tree 本质上就是一棵有序的多叉树，所有的查询优化规则都能从这个结构推导出来。理解了结构，「索引为什么失效」就不再是要死记硬背的规则，而是自然而然的结论。
