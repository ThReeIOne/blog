---
title: "并发模型全景图（二）：FastAPI 的 async/await 怎么用才对"
date: "2026-03-20"
tags: ["FastAPI", "Python", "异步", "并发", "async/await"]
summary: "FastAPI 支持同步和异步两种写法，但很多人不知道什么时候该用哪种，以及混用会有什么后果。这篇文章拆解 FastAPI 的并发模型，讲清楚 async def 和 def 的区别、数据库操作怎么处理、CPU 密集型任务怎么办，以及常见的几个坑。"
---

上一篇讲了进程、线程、协程的基础概念。这篇专门讲 FastAPI，因为它的并发模型有一些反直觉的地方，很容易踩坑。

---

## FastAPI 的并发基础

FastAPI 底层基于 **Starlette**，使用 Python 的 `asyncio` 事件循环，运行在 **Uvicorn**（或 Hypercorn）这类 ASGI 服务器上。

整个架构是这样的：

```
客户端请求
    ↓
Uvicorn（ASGI 服务器）
    ↓
asyncio 事件循环（单线程）
    ↓
FastAPI 路由 → 你的 handler 函数
```

**核心：FastAPI 的主事件循环运行在单线程里。**

---

## async def 和 def 的本质区别

这是最重要的概念，很多人写了很久 FastAPI 都没搞清楚。

### async def：运行在事件循环里

```python
from fastapi import FastAPI
import asyncio

app = FastAPI()

@app.get("/async")
async def async_handler():
    await asyncio.sleep(1)  # 等待期间，事件循环可以处理其他请求
    return {"message": "async"}
```

`async def` 函数是协程，由事件循环调度。执行到 `await` 时，当前协程挂起，事件循环去处理其他请求，等 I/O 完成后再恢复。

**1000 个并发请求打过来，事件循环用一个线程交替处理所有请求，每个请求等 I/O 的时候让别人先跑。**

### def：运行在线程池里

```python
@app.get("/sync")
def sync_handler():
    time.sleep(1)  # 同步阻塞，但 FastAPI 会在线程池里运行
    return {"message": "sync"}
```

`def`（普通同步函数）在 FastAPI 里不是直接运行在事件循环里的——FastAPI 会把它丢到一个**线程池（ThreadPoolExecutor）**里执行，避免阻塞事件循环。

**这个行为很多人不知道：普通 def 函数，FastAPI 自动帮你跑在线程池里。**

### 对比

```
async def handler():
    时间线: [事件循环线程] await → 挂起 → 处理其他请求 → 恢复
    并发数: 受限于 I/O 操作是否真正异步
    线程数: 1

def handler():
    时间线: [线程池] 占用一个线程，sleep 期间线程阻塞
    并发数: 受限于线程池大小（默认 min(32, os.cpu_count() + 4)）
    线程数: 多个
```

---

## 什么时候用 async def，什么时候用 def

### 用 async def 的条件：I/O 操作必须支持异步

```python
# ✅ 正确：使用异步数据库驱动
from sqlalchemy.ext.asyncio import AsyncSession

@app.get("/users/{user_id}")
async def get_user(user_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar()

# ✅ 正确：使用异步 HTTP 客户端
import httpx

@app.get("/proxy")
async def proxy():
    async with httpx.AsyncClient() as client:
        response = await client.get("https://api.example.com/data")
    return response.json()

# ✅ 正确：Redis 异步操作
import aioredis

@app.get("/cached")
async def get_cached(redis = Depends(get_redis)):
    value = await redis.get("my_key")
    return {"value": value}
```

### 用 def 的条件：I/O 操作是同步的，或者纯 CPU 计算

```python
# ✅ 正确：使用同步数据库驱动（SQLAlchemy 同步版本）
from sqlalchemy.orm import Session

@app.get("/users/{user_id}")
def get_user(user_id: int, db: Session = Depends(get_db)):
    return db.query(User).filter(User.id == user_id).first()

# ✅ 正确：调用同步第三方库
@app.get("/report")
def generate_report():
    data = some_sync_library.generate()  # 同步库，无法 await
    return data
```

### 最危险的错误：在 async def 里调用同步阻塞

```python
# ❌ 危险！卡死事件循环
@app.get("/bad")
async def bad_handler():
    import requests
    response = requests.get("https://api.example.com")  # 同步阻塞！
    # 这会让整个事件循环卡住，其他所有请求都无法处理
    return response.json()

# ❌ 危险！同步数据库操作放在 async def 里
@app.get("/also-bad")
async def also_bad(db: Session = Depends(get_sync_db)):
    # 使用同步 SQLAlchemy，会阻塞事件循环
    user = db.query(User).first()
    return user
```

**记住：`async def` 里的任何阻塞调用都会卡死整个服务。**

---

## 数据库操作：同步 vs 异步 SQLAlchemy

这是 FastAPI 项目里最常见的选择。

### 同步 SQLAlchemy（配合 def 路由）

```python
# database.py
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine("postgresql://user:pass@localhost/db")
SessionLocal = sessionmaker(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# main.py
@app.get("/users")
def get_users(db: Session = Depends(get_db)):
    return db.query(User).all()
```

**适用场景**：代码简单直接，不需要超高并发（< 500 QPS），团队不熟悉异步编程。

### 异步 SQLAlchemy（配合 async def 路由）

```python
# database.py
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

engine = create_async_engine("postgresql+asyncpg://user:pass@localhost/db")
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession)

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

# main.py
from sqlalchemy import select

@app.get("/users")
async def get_users(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User))
    return result.scalars().all()
```

**注意**：需要换数据库驱动：
- PostgreSQL：`psycopg2` → `asyncpg`
- MySQL：`pymysql` → `aiomysql`
- SQLite：`sqlite3` → `aiosqlite`

**适用场景**：高并发场景，I/O 等待时间长（复杂查询、外部 API 调用）。

---

## CPU 密集型任务：不能用协程

协程是单线程的，CPU 密集型任务（加密、图像处理、大量计算）会霸占线程，导致其他请求无法处理。

### 方案一：丢到线程池（适合中等 CPU 工作）

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor

executor = ThreadPoolExecutor(max_workers=4)

def cpu_heavy_task(data):
    # 大量 CPU 计算
    result = 0
    for i in range(10_000_000):
        result += i
    return result

@app.post("/compute")
async def compute(data: dict):
    loop = asyncio.get_event_loop()
    # run_in_executor 把同步函数丢到线程池，不阻塞事件循环
    result = await loop.run_in_executor(executor, cpu_heavy_task, data)
    return {"result": result}
```

### 方案二：丢到进程池（适合重 CPU 工作，绕过 GIL）

```python
from concurrent.futures import ProcessPoolExecutor

process_executor = ProcessPoolExecutor(max_workers=4)

def heavy_ml_task(input_data):
    # 机器学习推理、图像处理等
    import numpy as np
    return np.sum(np.random.random(1_000_000))

@app.post("/ml-inference")
async def ml_inference(data: dict):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(process_executor, heavy_ml_task, data)
    return {"result": result}
```

### 方案三：用 Celery 做异步任务队列（适合超重任务）

```python
# tasks.py
from celery import Celery

celery_app = Celery("tasks", broker="redis://localhost:6379/0")

@celery_app.task
def process_video(video_path: str):
    # 视频转码，可能需要几分钟
    ...
    return result_path

# main.py
@app.post("/upload-video")
async def upload_video(file: UploadFile):
    path = save_file(file)
    task = process_video.delay(path)  # 异步提交，立即返回
    return {"task_id": task.id}

@app.get("/task/{task_id}")
async def get_task_status(task_id: str):
    task = process_video.AsyncResult(task_id)
    return {"status": task.status, "result": task.result}
```

---

## 并发模型选择速查

```
你的路由在做什么？
├── 主要是数据库/网络 I/O
│   ├── 有异步驱动？ → async def + await
│   └── 只有同步驱动？ → def（FastAPI 自动用线程池）
│
├── CPU 密集型计算
│   ├── 计算量中等（< 1s） → def 或 async def + run_in_executor(thread)
│   ├── 计算量重（> 1s） → async def + run_in_executor(process)
│   └── 非常重或需要排队 → Celery 任务队列
│
└── 混合（I/O + CPU）
    → async def，I/O 用 await，CPU 用 run_in_executor
```

---

## 真实项目中的并发配置

### Uvicorn + Gunicorn：多进程 × 单线程事件循环

```bash
# 生产环境推荐：4 个 worker 进程，每个进程一个事件循环
gunicorn app:app -w 4 -k uvicorn.workers.UvicornWorker

# 进程数公式：通常是 CPU 核心数 × 2 + 1
# 8 核机器：gunicorn -w 17
```

```
进程1: [事件循环] → 协程A, 协程B, 协程C ...
进程2: [事件循环] → 协程D, 协程E, 协程F ...
进程3: [事件循环] → 协程G, 协程H, 协程I ...
进程4: [事件循环] → 协程J, 协程K, 协程L ...
```

多进程充分利用多核，每个进程内用事件循环处理高并发 I/O。这是 FastAPI 生产部署的标准方案。

### 连接池配置

```python
# 异步 SQLAlchemy 连接池
engine = create_async_engine(
    DATABASE_URL,
    pool_size=20,        # 连接池大小
    max_overflow=10,     # 超出 pool_size 后最多额外创建的连接
    pool_timeout=30,     # 等待连接的超时时间（秒）
    pool_recycle=3600,   # 连接复用时间（秒），防止数据库断开长连接
)

# 注意：每个 Worker 进程有自己的连接池
# 4 个 Worker × pool_size=20 = 最多 80 个数据库连接
# 要和数据库的 max_connections 对应起来
```

---

## 排查"卡住"问题的思路

遇到请求卡住，按这个顺序排查：

**1. 确认是否在 async def 里调用了同步阻塞**

```python
# 用 asyncio 的调试模式，可以发现阻塞超过 0.1s 的操作
import asyncio
asyncio.get_event_loop().set_debug(True)
```

**2. 检查数据库连接池是否耗尽**

```python
# 查看 SQLAlchemy 连接池状态
print(engine.pool.status())
# QueuePool size=20 overflow=0 get=1 use=1 timeout=30
```

**3. 检查是否有死锁（数据库层面）**

```sql
-- PostgreSQL 查看当前锁等待
SELECT pid, wait_event_type, wait_event, state, query
FROM pg_stat_activity
WHERE wait_event IS NOT NULL;
```

**4. 加超时保护**

```python
@app.get("/safe")
async def safe_handler():
    try:
        # 任何操作都加超时，避免无限等待
        result = await asyncio.wait_for(
            some_async_operation(),
            timeout=10.0  # 10 秒超时
        )
        return result
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="操作超时")
```

---

下一篇：[并发模型全景图（三）：Go 的 goroutine 是怎么工作的](./concurrency-golang-goroutine.md)
