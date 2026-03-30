---
title: "Python Web 框架横向对比：Django、Flask、FastAPI、Starlette、Sanic、Tornado"
tags: ["Python", "后端", "框架", "架构"]
summary: "从设计哲学、性能模型、适用场景六个维度，系统对比 Python 主流 Web 框架：Django、Flask、FastAPI、Starlette、Sanic、Tornado。不是教你用哪个，是帮你搞清楚该用哪个。"
---

Python Web 框架多到让人选择困难。Django 老牌稳健，Flask 轻量灵活，FastAPI 异步性能强，还有 Starlette、Sanic、Tornado 各有拥趸。本文不写"入门教程"，而是从设计哲学、并发模型、性能、生态、适用场景几个维度做横向对比，帮你在选型时有据可依。

## 一、先把框架分个类

Python Web 框架大致可以按两个维度分类：

**按重量级别：**
- **全栈框架（Batteries Included）**：Django。自带 ORM、Admin、Auth、模板引擎、迁移工具，什么都有。
- **微框架（Micro Framework）**：Flask、Starlette。核心极简，扩展靠插件。
- **异步高性能框架**：FastAPI、Sanic、Tornado。专注性能和异步 I/O。

**按并发模型：**
- **同步（WSGI）**：Django、Flask。基于传统 WSGI 协议，一请求一线程/进程。
- **异步（ASGI）**：FastAPI、Starlette、Sanic。基于 asyncio 事件循环，单线程处理大量并发连接。
- **混合**：Tornado（自带事件循环，历史悠久的异步方案）。

---

## 二、框架逐一拆解

### 2.1 Django — 老大哥，全能但笨重

**发布年份：** 2005 年  
**核心设计哲学：** "The web framework for perfectionists with deadlines"，强约定优于配置，开箱即用。

**核心特性：**
- 内置 ORM（Django ORM），支持 PostgreSQL、MySQL、SQLite、Oracle
- 自动生成的 Admin 后台（CMS 类项目神器）
- 完整的用户认证系统（登录/注册/权限/Session）
- 模板引擎（DTL）
- 数据库迁移（`makemigrations` / `migrate`）
- Form 验证、CSRF 保护
- 强大的中间件系统

**并发模型：** WSGI（同步）。每个请求占用一个线程，需配合 Gunicorn + 多 worker 横向扩展。Django 3.1+ 支持 ASGI，但生态配套还在追赶中。

**性能：** 中等。同步模型下，I/O 密集型任务受限于线程数。计算密集型反而不差，因为没有异步切换开销。

**适合什么：**
- 内容管理系统（CMS）、博客、电商
- 需要 Admin 后台快速搭起来的内部系统
- 团队经验偏传统后端，不想踩异步的坑
- 项目规模中等偏大，需要强约定来维持代码一致性

**不适合什么：**
- 高并发实时场景（WebSocket、长轮询）
- 纯 API 服务（Django REST Framework 可以，但有些重）
- 极致轻量的微服务

---

### 2.2 Flask — 微框架之王，自由但需要自律

**发布年份：** 2010 年  
**核心设计哲学：** "One drop at a time"，核心只做路由和请求/响应，其余自己选。

**核心特性：**
- 路由装饰器（简洁直观）
- Werkzeug（WSGI 工具库）+ Jinja2（模板引擎）
- 蓝图（Blueprint）用于模块化
- 上下文变量（`g`、`request`、`session`）
- 插件生态丰富：Flask-SQLAlchemy、Flask-Login、Flask-Migrate、Flask-RESTful...

**并发模型：** WSGI（同步）。和 Django 一样需要多 worker。Flask 2.0 开始支持 `async` 视图函数，但本质上还是 WSGI，异步仅在单个请求处理内有效，无法真正实现事件循环驱动。

**性能：** 比 Django 略好（更轻），但瓶颈同样在同步 I/O。

**适合什么：**
- 原型开发、小型 API 服务
- 需要高度定制化，不想被框架约束
- 学习 Web 框架原理的入门选择
- 内部工具、数据科学 API（搭配 Pandas/NumPy 暴露接口）

**不适合什么：**
- 大型项目（没有强约定，大团队容易写乱）
- 高并发异步场景
- 需要复杂权限/认证的企业系统（要自己堆插件）

---

### 2.3 FastAPI — 异步时代的新宠

**发布年份：** 2018 年  
**核心设计哲学：** 高性能、类型安全、自动文档。基于 Starlette（ASGI 框架）+ Pydantic（数据验证）。

**核心特性：**
- 原生 `async/await` 支持，基于 asyncio 事件循环
- **Pydantic 自动校验**：请求体/查询参数/路径参数全部类型注解，校验失败自动返回 422
- **自动生成 OpenAPI 文档**：`/docs`（Swagger UI）和 `/redoc` 开箱即用
- 依赖注入系统（`Depends`）：数据库连接、认证、权限控制优雅解耦
- 背景任务（`BackgroundTasks`）
- WebSocket 支持
- 支持同步和异步混用（同步函数自动放线程池）

**并发模型：** ASGI + asyncio。事件循环驱动，单线程可处理大量并发 I/O，特别适合 API 网关、微服务、I/O 密集型业务。

**性能：** Python 框架中最快之一，性能接近 NodeJS，远超 Django/Flask。TechEmpower 基准测试中常年位于 Python 框架前列。

**适合什么：**
- 纯 API 服务（REST API、GraphQL 接入层）
- 微服务架构
- 需要强类型约束和自动文档的团队
- I/O 密集型场景（大量数据库查询、外部 HTTP 调用）
- 数据科学/ML 模型部署（fastapi + uvicorn 已成标配）

**不适合什么：**
- 需要内置 Admin、ORM 的全栈项目
- 团队对 async/await 不熟悉（容易踩坑：同步代码混入异步上下文、ORM 不支持异步等）
- 项目极度简单，Pydantic 的引入反而增加复杂度

**和 Flask 的关键区别：**
| 维度 | Flask | FastAPI |
|------|-------|---------|
| 并发模型 | WSGI 同步 | ASGI 异步 |
| 数据校验 | 手动 / marshmallow | Pydantic 自动 |
| API 文档 | 需插件（flasgger） | 内置自动生成 |
| 类型安全 | 弱 | 强 |
| 性能 | 中 | 高 |
| 学习曲线 | 低 | 中（需懂 async） |

---

### 2.4 Starlette — FastAPI 的地基

**发布年份：** 2018 年  
**核心设计哲学：** 轻量级 ASGI 框架/工具包，FastAPI 就是构建在它之上的。

**核心特性：**
- 路由、中间件、WebSocket、后台任务、静态文件
- 测试客户端（基于 httpx）
- 无数据校验层（这是 FastAPI 加的 Pydantic）

**适合什么：**
- 构建自定义框架（FastAPI 就是这么做的）
- 需要 ASGI 能力但不想要 Pydantic 开销的场景
- 极致轻量的微服务

**说句实话：** 大多数业务场景直接用 FastAPI 就好，Starlette 是给"想自己造轮子"的人用的。

---

### 2.5 Sanic — 专注极致性能

**发布年份：** 2016 年  
**核心设计哲学：** "Build fast. Run fast." 专为高并发 API 设计，Go/Node 同台竞争。

**核心特性：**
- 自建事件循环（基于 `uvloop`，比标准 asyncio 快 2-4 倍）
- 原生支持 HTTP/1.1 和 WebSocket
- 蓝图、中间件、信号系统
- 内置 HTTPS、静态文件服务
- 类 Flask 的路由语法，迁移成本低

**并发模型：** 自有异步事件循环（uvloop）。

**性能：** Python 框架中最快的之一，部分场景超过 FastAPI（因为 FastAPI 有 Pydantic 校验开销）。

**适合什么：**
- 对性能有极致要求的 API 服务
- 实时推送、WebSocket 密集型应用
- 从 Flask 迁移到异步框架的团队（语法相似）

**不适合什么：**
- 需要完整生态（ORM、Admin、Auth）的项目
- 社区和插件生态不如 FastAPI 和 Django 丰富

---

### 2.6 Tornado — 老派异步，WebSocket 老手

**发布年份：** 2009 年（FriendFeed 开源）  
**核心设计哲学：** 非阻塞网络 I/O，长连接场景的先驱。

**核心特性：**
- 自带异步 HTTP 服务器（无需 Gunicorn/Uvicorn）
- WebSocket 原生支持（历史最早之一）
- 异步 HTTP 客户端（`AsyncHTTPClient`）
- 协程支持（最早用 `@gen.coroutine`，现在支持 `async/await`）

**并发模型：** 自有事件循环（早于 asyncio），现在已与 asyncio 整合。

**性能：** 异步 I/O 性能强，但相比 Sanic/FastAPI 在纯 API 场景略落后。

**适合什么：**
- 长连接（WebSocket、长轮询）
- 需要同时处理 HTTP 服务和大量出站 HTTP 请求的服务
- 老项目维护（Tornado 生态积累了很多年）

**不适合什么：**
- 新项目首选。FastAPI/Sanic 在生态和性能上已经超越，新项目很少选 Tornado
- 需要 REST API 自动文档的场景

---

## 三、性能横向对比

以下数据基于 TechEmpower Benchmark Round 22（仅供量级参考，实际差异取决于业务逻辑）：

| 框架 | 并发模型 | 相对吞吐量（JSON序列化） | 备注 |
|------|---------|-----------------|------|
| Sanic | ASGI/uvloop | ⭐⭐⭐⭐⭐ | 接近裸 uvloop 性能 |
| FastAPI | ASGI/asyncio | ⭐⭐⭐⭐ | Pydantic 有校验开销 |
| Starlette | ASGI/asyncio | ⭐⭐⭐⭐ | FastAPI 去掉 Pydantic |
| Tornado | 自有事件循环 | ⭐⭐⭐ | 老牌异步，略落后 |
| Flask | WSGI/同步 | ⭐⭐ | 多 worker 横向扩展 |
| Django | WSGI/同步 | ⭐ | 最重，但瓶颈很少在框架本身 |

**重要提示：** 大多数业务系统的性能瓶颈在数据库和外部调用，而不在框架本身。Django 慢不是 Django 的问题，是你的 SQL 查询没优化。别为了性能盲目选框架。

---

## 四、生态与社区

| 框架 | GitHub Stars | PyPI 月下载量 | 成熟度 | 插件生态 |
|------|------------|-------------|-------|--------|
| Django | ~80k | 极高 | 非常成熟（20年） | 最丰富 |
| Flask | ~67k | 极高 | 非常成熟（15年） | 丰富 |
| FastAPI | ~75k | 高，增长最快 | 成熟（6年） | 快速增长 |
| Starlette | ~10k | 中（被 FastAPI 带动） | 成熟 | 少（作为底层） |
| Sanic | ~18k | 中 | 成熟 | 一般 |
| Tornado | ~21k | 中（趋于平稳） | 成熟但增长停滞 | 一般 |

---

## 五、选型决策树

```
你的项目是什么类型？
│
├─ 需要后台管理、ORM、完整认证系统
│   └─→ Django
│
├─ 纯 API 服务 / 微服务
│   ├─ 团队熟悉 async/await，注重类型安全和文档
│   │   └─→ FastAPI（首选）
│   ├─ 极致性能优先，愿意少一些"脚手架"
│   │   └─→ Sanic
│   └─ 快速原型，团队熟悉 Flask 风格
│       └─→ Flask
│
├─ 大量 WebSocket / 长连接
│   ├─ 新项目
│   │   └─→ FastAPI 或 Sanic（WebSocket 支持都不错）
│   └─ 老项目维护
│       └─→ Tornado（已有的就不动了）
│
├─ 自己造框架 / 需要 ASGI 底层能力
│   └─→ Starlette
│
└─ 学习/教学/小脚本
    └─→ Flask（最简单直观）
```

---

## 六、现实场景中的选择

**如果你在做数据科学 API / ML 模型部署：**  
FastAPI 是标配。类型注解清晰、Pydantic 校验省去大量参数处理代码、自动文档方便前端/调用方对接，加上 uvicorn 部署简单。

**如果你在做企业内部系统（ERP/CRM/MIS）：**  
Django 是首选。Admin 后台能省掉大量开发时间，ORM 稳定成熟，迁移工具完善，新人上手快。

**如果你在做高并发 API 网关 / 代理层：**  
Sanic 或 FastAPI。需要基准测试验证，但两者都明显优于 Django/Flask。

**如果你在维护老项目：**  
别乱动。Flask 老项目继续用 Flask，Django 老项目继续用 Django。迁移框架的收益很少覆盖成本。

---

## 七、总结

| 维度 | Django | Flask | FastAPI | Sanic | Tornado | Starlette |
|------|--------|-------|---------|-------|---------|-----------|
| 设计哲学 | 全栈、强约定 | 微框架、自由 | 异步、类型安全 | 极致性能 | 长连接异步 | 轻量 ASGI |
| 并发模型 | WSGI 同步 | WSGI 同步 | ASGI 异步 | ASGI/uvloop | 自有事件循环 | ASGI 异步 |
| 学习曲线 | 中高 | 低 | 中 | 中 | 中 | 中低 |
| 性能 | 低 | 低-中 | 高 | 最高 | 中高 | 高 |
| 生态成熟度 | 最高 | 高 | 高且增长快 | 中 | 中（增长停滞） | 中 |
| 适合场景 | 全栈/CMS/后台 | 小服务/原型 | API/微服务/ML | 高性能API | 长连接/老项目 | 框架底层 |

选框架本质上是在**约束**和**自由**、**性能**和**生态**之间做权衡。没有最好的框架，只有最合适当前团队和业务的框架。

如果你今天从零开始做一个新的 Python 后端项目，纯 API 场景无脑选 FastAPI，需要后台管理就 Django，想要极致性能就 Sanic——就这三条原则，覆盖了 90% 的场景。
