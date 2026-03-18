---
title: "FastAPI 生产实践：异步、依赖注入与性能调优"
date: "2026-03-16"
tags: ["FastAPI", "Python", "后端", "API"]
summary: "从项目结构到生产部署，分享 FastAPI 在真实项目中踩过的坑和最佳实践。"
---

FastAPI 是目前 Python 生态里性能最好的 Web 框架，但用好它需要理解一些核心概念。

## 项目结构

```
app/
├── api/
│   ├── v1/
│   │   ├── router.py
│   │   ├── users.py
│   │   └── orders.py
├── core/
│   ├── config.py
│   ├── security.py
│   └── database.py
├── models/
│   ├── user.py
│   └── order.py
├── schemas/
│   ├── user.py
│   └── order.py
├── services/
│   ├── user_service.py
│   └── order_service.py
└── main.py
```

## 依赖注入：FastAPI 的灵魂

```python
from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> User:
    payload = decode_jwt(token)
    user = await db.get(User, payload["sub"])
    if not user:
        raise HTTPException(status_code=401)
    return user

@router.get("/profile")
async def get_profile(
    current_user: User = Depends(get_current_user)
):
    return current_user
```

## 异步数据库操作

```python
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

engine = create_async_engine(
    "postgresql+asyncpg://user:pass@localhost/db",
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
)

AsyncSessionLocal = sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)
```

## 统一错误处理

```python
from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.status_code,
            "message": exc.detail,
            "path": str(request.url)
        }
    )
```

## 后台任务与并发

```python
from fastapi import BackgroundTasks

@router.post("/send-report")
async def send_report(
    background_tasks: BackgroundTasks,
    email: str
):
    # 立即返回，邮件后台发送
    background_tasks.add_task(send_email, email, "Report")
    return {"message": "Report queued"}
```

## 性能调优

```python
# 1. 用 uvicorn + gunicorn 多进程
# gunicorn -w 4 -k uvicorn.workers.UvicornWorker app.main:app

# 2. 开启响应压缩
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)

# 3. 合理使用缓存
from functools import lru_cache

@lru_cache(maxsize=128)
def get_settings() -> Settings:
    return Settings()
```

## 中间件示例：请求追踪

```python
import time
import uuid
from fastapi import Request

@app.middleware("http")
async def add_trace_id(request: Request, call_next):
    trace_id = str(uuid.uuid4())
    request.state.trace_id = trace_id
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    response.headers["X-Trace-ID"] = trace_id
    response.headers["X-Process-Time"] = str(duration)
    return response
```
