---
title: "Redis 高级用法：从缓存到分布式协调"
date: "2026-03-18"
tags: ["Redis", "缓存", "分布式", "后端"]
---

# Redis 高级用法：从缓存到分布式协调

Redis 不只是缓存，它的数据结构和原子操作让它成为解决分布式问题的利器。

## Cache-Aside（旁路缓存）

```python
async def get_user(user_id: int) -> User:
    cache_key = f"user:{user_id}"
    cached = await redis.get(cache_key)
    if cached:
        return User.model_validate_json(cached)

    user = await db.get_user(user_id)
    if user:
        await redis.setex(cache_key, 300, user.model_dump_json())
    return user

async def update_user(user_id: int, data: dict) -> User:
    user = await db.update_user(user_id, data)
    await redis.delete(f"user:{user_id}")  # 删缓存，下次读时重建
    return user
```

## 分布式锁

```python
class RedisLock:
    def __init__(self, redis, key: str, expire: int = 30):
        self.redis = redis
        self.key = f"lock:{key}"
        self.token = str(uuid.uuid4())
        self.expire = expire

    async def acquire(self, timeout: float = 10) -> bool:
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            ok = await self.redis.set(self.key, self.token, nx=True, ex=self.expire)
            if ok:
                return True
            await asyncio.sleep(0.1)
        return False

    async def release(self):
        # Lua 脚本保证原子性
        script = """
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
        """
        await self.redis.eval(script, 1, self.key, self.token)

    async def __aenter__(self):
        if not await self.acquire():
            raise TimeoutError(f"Failed to acquire lock: {self.key}")
        return self

    async def __aexit__(self, *args):
        await self.release()
```

## 滑动窗口限流

```python
async def rate_limit(user_id: str, limit: int = 100, window: int = 60) -> bool:
    key = f"rate:{user_id}"
    now = time.time()

    pipe = redis.pipeline()
    pipe.zremrangebyscore(key, 0, now - window)
    pipe.zadd(key, {str(now): now})
    pipe.zcard(key)
    pipe.expire(key, window)
    results = await pipe.execute()

    return results[2] <= limit
```

## Redis Streams 消息队列

```python
# 生产者
await redis.xadd("orders", {"order_id": "123", "amount": "99.99"})

# 消费者组
await redis.xgroup_create("orders", "processors", id="0", mkstream=True)

# 消费
messages = await redis.xreadgroup(
    "processors", "worker-1",
    {"orders": ">"},
    count=10, block=5000
)
for stream, msgs in messages:
    for msg_id, data in msgs:
        await process_order(data)
        await redis.xack("orders", "processors", msg_id)
```

## Sorted Set：排行榜

```python
await redis.zadd("leaderboard", {"player:123": 1500.0})

# Top 10
top10 = await redis.zrevrange("leaderboard", 0, 9, withscores=True)

# 用户排名
rank = await redis.zrevrank("leaderboard", "player:123")
```

Redis 的真正价值在于原子操作和丰富的数据结构，熟练运用能解决很多分布式难题。
