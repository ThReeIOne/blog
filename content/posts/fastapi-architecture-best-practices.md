---
title: "FastAPI 大型项目架构最佳实践"
date: "2026-03-14"
tags: ["Python", "FastAPI", "架构", "后端"]
---

# FastAPI 大型项目架构最佳实践

FastAPI 上手容易，但随着项目规模增大，如何保持代码整洁、可维护是个挑战。

## 目录结构

```
app/
├── api/
│   ├── deps.py          # 依赖注入
│   └── v1/
│       ├── router.py
│       └── endpoints/
│           ├── users.py
│           └── orders.py
├── core/
│   ├── config.py        # 配置管理
│   └── security.py
├── db/
│   └── session.py
├── models/              # ORM 模型
├── schemas/             # Pydantic 模型
├── crud/                # 数据库操作
└── services/            # 业务逻辑
```

## 配置管理

```python
from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379"
    secret_key: str
    access_token_expire_minutes: int = 30

    model_config = {"env_file": ".env"}

@lru_cache
def get_settings() -> Settings:
    return Settings()
```

## 依赖注入

```python
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> User:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        user_id: int = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await crud.user.get(db, id=user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user
```

## Repository 模式

```python
class CRUDBase(Generic[ModelType]):
    def __init__(self, model: Type[ModelType]):
        self.model = model

    async def get(self, db: AsyncSession, id: int) -> ModelType | None:
        result = await db.execute(select(self.model).where(self.model.id == id))
        return result.scalar_one_or_none()

    async def create(self, db: AsyncSession, obj_in: dict) -> ModelType:
        db_obj = self.model(**obj_in)
        db.add(db_obj)
        await db.flush()
        await db.refresh(db_obj)
        return db_obj
```

## 统一错误处理

```python
class AppException(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail

async def app_exception_handler(request: Request, exc: AppException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.status_code, "message": exc.detail}
    )

app.add_exception_handler(AppException, app_exception_handler)
```

## 后台任务

```python
@router.post("/orders")
async def create_order(
    order_in: OrderCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    order = await crud.order.create(db, obj_in=order_in.model_dump())
    background_tasks.add_task(send_order_confirmation, order.id, current_user.email)
    return order
```

生产环境中复杂的异步任务建议使用 **Celery + Redis** 或 **ARQ**。
