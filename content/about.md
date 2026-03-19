---
title: "关于我"
---

## 你好，我是 Shengli

一名后端工程师，对分布式系统和可观测性有浓厚的兴趣——不只是会用工具，而是想真正搞清楚系统在运行时发生了什么，出了问题为什么出、怎么找到根因。这个追求驱动我写了两个开源项目：一个 Webhook 网关，一个完整的分布式链路追踪系统。

这个博客是我思考和沉淀的地方。我不太喜欢写那种"10 分钟入门 XXX"的水文章，更倾向于把一件事真正搞透了、踩过坑了再写下来。文章不多，但每篇都是认真写的。

---

## 开源项目

### HookRelay

自托管的 Webhook 网关，用 Go 编写。

解决的问题很具体：Webhook 消息容易丢、出了问题没法查、一个事件需要通知多个下游服务。HookRelay 在 Webhook 和你的服务之间加了一层可靠的队列，做签名验证、自动重试、扇出路由、死信队列，并暴露完整的管理 API。

→ [github.com/ThReeIOne/hookrelay](https://github.com/ThReeIOne/hookrelay)

### Prism

分布式链路追踪系统，同样用 Go 编写。

从 SDK 到 Collector 到存储到 Web UI，整条链路自己实现了一遍。用 ClickHouse 做存储（列式存储 + TTL + 物化视图），支持自适应采样（错误和慢请求永远采集），内嵌了一个 React 前端直接打进 Go binary 里。

做这个主要是想真正理解分布式追踪的工作原理，而不只是用 Jaeger 或者 Zipkin 的用户。

→ [github.com/ThReeIOne/prism](https://github.com/ThReeIOne/prism)

---

## 技术栈

日常主力是 **Go** 和 **Python（FastAPI）**，数据库用 PostgreSQL 比较多，基础设施这块关注 ClickHouse、Docker、监控可观测性方向。

前端不是主力方向，但需要的时候会写 TypeScript + React，这个博客就是 Next.js 搭的。
