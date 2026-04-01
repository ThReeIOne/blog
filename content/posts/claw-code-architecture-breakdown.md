---
title: "claw-code 架构拆解：从 Claude Code 泄露事件看 AI Agent Harness 的设计模式"
tags: ["AI Agent", "架构设计", "agent-loop", "tool-calling", "context-management", "llm-query-engine", "plugin-system", "ai-orchestration"]
summary: "2026年3月31日凌晨，Claude Code 源码意外曝光。韩国开发者 Sigrid Jin 连夜用 Python 复写了其核心架构，产物即 claw-code。本文从工程视角拆解这个项目的模块设计，提炼出 AI Agent Harness 的核心技术点，作为后续系列文章的索引。"
---

> 编写日期：2026-04-01  
> 项目地址：[https://github.com/instructkr/claw-code](https://github.com/instructkr/claw-code)

## 一、事件背景

2026年3月31日凌晨4点，Anthropic 旗下 Claude Code 的源代码意外曝光，整个开发者社区沸腾。  
韩国开发者 **Sigrid Jin**——《华尔街日报》报道的顶级 Claude Code 用户，去年单人消耗了 **250亿个 Claude Code token**——连夜行动，用 Python 从头复写了其核心架构，天亮前推送上线，这就是 **claw-code**。

整个复写过程由 [oh-my-codex (OmX)](https://github.com/Yeachan-Heo/oh-my-codex) 全程 AI 编排完成：
- `$team` 模式：并行代码 review 和架构反馈
- `$ralph` 模式：持续执行、验证和完成闭环

这不是一次简单的代码抄写，而是一次**架构模式的 clean-room 复现**——在不直接拷贝原始代码的前提下，还原其设计思想。

---

## 二、项目本质：AI Agent Harness

要理解 claw-code，先要理解 **Harness（线束/脚手架）** 这个概念。

Claude Code 本质上不是一个简单的 chatbot，而是一个 **AI Agent 的运行时框架**：它负责把 LLM 的能力（文本生成）和真实世界的操作（读写文件、执行命令、调用 API）连接起来，并管理整个任务的执行生命周期。

```
用户输入 → [Harness] → LLM → Tool Calls → 真实操作 → 结果反馈 → [循环]
```

claw-code 复现的正是这个 Harness 框架，而不是 LLM 本身。

---

## 三、源码目录结构

```
src/
├── assistant/          # LLM 对话封装
├── bootstrap/          # 工程初始化、CLAUDE.md 扫描
├── bridge/             # 内外部通信桥接
├── buddy/              # 辅助 Agent 模块
├── cli/                # 命令行入口
├── components/         # TUI 组件
├── constants/          # 全局常量
├── coordinator/        # 任务协调器
├── entrypoints/        # 多入口点
├── hooks/              # 生命周期钩子
├── keybindings/        # 快捷键绑定
├── memdir/             # Agent 记忆目录
├── migrations/         # 数据迁移
├── moreright/          # 扩展功能
├── native_ts/          # 原始 TypeScript 参考
├── outputStyles/       # 输出样式
├── plugins/            # 插件系统
├── remote/             # 远程运行时
├── schemas/            # 数据模型定义
├── screens/            # TUI 页面
├── server/             # 本地服务
├── services/           # 核心服务层
├── skills/             # 技能扩展
├── state/              # 全局状态
├── types/              # 类型定义
├── upstreamproxy/      # 上游代理
├── utils/              # 工具函数
├── vim/                # Vim 模式支持
├── voice/              # 语音接口
│
├── main.py             # CLI 入口
├── runtime.py          # Agent 主循环 ⭐
├── task.py / tasks.py  # 任务定义与调度
├── context.py          # 上下文管理 ⭐
├── Tool.py / tools.py  # 工具系统 ⭐
├── commands.py         # 命令路由
├── query_engine.py     # LLM 查询引擎 ⭐
├── permissions.py      # 权限控制
├── session_store.py    # 会话持久化
├── history.py          # 对话历史
├── cost_tracker.py     # Token 费用追踪
└── ...
```

---

## 四、核心模块拆解

### 4.1 Agent 主循环 `#agent-loop`

**文件：** `runtime.py`, `main.py`

Agent 的心脏。整个系统围绕一个"感知-决策-行动-反馈"的循环运转：

```
while True:
    观察当前状态（上下文 + 历史）
    调用 LLM 生成下一步动作
    if 动作是 tool_call:
        执行工具
        把结果追加到上下文
    elif 动作是最终回答:
        输出并等待新输入
    else:
        处理中间步骤
```

这是整个 Harness 框架的核心设计模式。后续文章会深入分析这个循环的状态机实现，以及如何处理中断、错误恢复和并发任务。

> 📌 技术点：`#agent-loop`

---

### 4.2 工具系统 `#tool-calling`

**文件：** `Tool.py`, `tools.py`, `tool_pool.py`

工具（Tool）是 Agent 和真实世界交互的接口。claw-code 的工具系统包含三个关键设计：

1. **工具注册**：每个工具有明确的 schema（名称、描述、参数定义），LLM 根据 schema 决定调用哪个工具
2. **工具调度**：`tool_pool.py` 管理工具实例，支持并发调用
3. **沙箱执行**：工具执行在受控环境中，与权限系统联动

原始 Claude Code 内置了大量工具：文件读写、终端执行、浏览器控制、代码搜索等。这套工具注册-调度机制是 AI Coding Agent 能力边界的核心。

> 📌 技术点：`#tool-calling`

---

### 4.3 上下文管理 `#context-management`

**文件：** `context.py`, `session_store.py`, `history.py`

上下文是 Agent 的短期记忆，也是最昂贵的资源（直接决定 token 消耗）。

claw-code 的上下文管理涉及：
- **对话历史压缩**：随着对话增长，需要智能截断历史，保留关键信息
- **会话持久化**：`session_store.py` 将会话存储到磁盘，支持中断后恢复
- **多轮上下文注入**：系统 prompt、工具结果、用户消息的组合策略

> 📌 技术点：`#context-management`

---

### 4.4 命令路由 `#command-routing`

**文件：** `commands.py`, `command_graph.py`, `cli/`

用户在终端输入 `/help`、`/compact`、`/clear` 这类 slash command，背后是一套完整的命令解析和路由系统：

- `command_graph.py`：命令依赖图，某些命令需要先执行其他操作
- `commands.py`：命令元数据注册（名称、描述、参数、处理函数）
- 命令与 Agent 主循环的交互协议

> 📌 技术点：`#command-routing`

---

### 4.5 权限与沙箱控制 `#permission-model`

**文件：** `permissions.py`

Claude Code 最有争议的设计之一：AI 在执行危险操作（删除文件、运行脚本、联网）前需要用户授权。

权限模型的核心问题：
- 如何分级（读/写/执行/网络）？
- 如何表达"永久授权"和"本次授权"？
- 如何防止工具逃逸沙箱？

> 📌 技术点：`#permission-model`

---

### 4.6 LLM 查询引擎 `#llm-query-engine`

**文件：** `QueryEngine.py`, `query_engine.py`, `query.py`

对 LLM API 调用的完整封装层：
- 流式响应处理（streaming）
- 重试和错误恢复
- 多 provider 适配（Anthropic API / Bedrock / Vertex）
- 请求构建（system prompt 组装、工具 schema 注入）

> 📌 技术点：`#llm-query-engine`

---

### 4.7 工程 Bootstrap `#agent-bootstrap`

**文件：** `bootstrap/`, `bootstrap_graph.py`

当你在一个新项目目录中运行 Claude Code，它会：
1. 扫描目录结构
2. 读取 `CLAUDE.md`（如果存在）获取项目上下文
3. 建立初始系统 prompt
4. 决定默认工具集

这个"工程感知"能力是 AI Coding Agent 区别于普通 chatbot 的关键——它能理解自己在什么样的代码库里工作。

> 📌 技术点：`#agent-bootstrap`

---

### 4.8 Agent 记忆目录 `#agent-memory`

**文件：** `memdir/`

长期记忆管理，对应 `~/.claude/` 目录里的持久化数据：
- 项目级记忆（`CLAUDE.md`）
- 用户偏好
- 跨会话的上下文积累

> 📌 技术点：`#agent-memory`

---

### 4.9 插件与技能扩展 `#plugin-system`

**文件：** `plugins/`, `skills/`

能力扩展机制。通过插件系统，可以动态添加新工具、新命令、新行为，而不需要修改核心代码。这是 Agent 框架可扩展性的基础。

> 📌 技术点：`#plugin-system`

---

### 4.10 TUI 界面 `#tui-with-ink`

**文件：** `ink.py`, `components/`, `screens/`

Claude Code 的终端 UI 基于 [Ink](https://github.com/vadimdemedes/ink)——一个用 React 组件模型构建 CLI 界面的框架。`ink.py` 是其 Python 移植层。

这个选择很有意思：用声明式 UI 框架（React 模型）来处理终端渲染，而不是传统的字符串拼接。

> 📌 技术点：`#tui-with-ink`

---

### 4.11 费用追踪 `#cost-tracking`

**文件：** `cost_tracker.py`, `costHook.py`

实时统计 token 用量和费用，并通过 hook 机制在 Agent 循环的关键节点触发统计。Sigrid Jin 能精确知道自己用了 250亿 token，靠的就是这套机制。

> 📌 技术点：`#cost-tracking`

---

### 4.12 AI 编排工作流 `#ai-orchestration`

**工具：** [oh-my-codex (OmX)](https://github.com/Yeachan-Heo/oh-my-codex)

claw-code 的复写过程本身就是一个值得研究的案例——用 AI 工具来写 AI 工具的代码。

OmX 的两种模式：
- **`$team` 模式**：多个 Agent 并行 review 同一份代码，模拟团队 code review
- **`$ralph` 模式**：单个 Agent 持续执行，带有架构师级别的验证，不达标不停止

这种"AI 编排 AI"的工作流，是 2026 年软件工程效率提升的一个缩影。

> 📌 技术点：`#ai-orchestration`

---

## 五、核心技术点索引

以下是本文涉及的所有技术点，后续文章将逐一展开：

| 标签 | 主题 | 难度 |
|------|------|------|
| `#agent-loop` | Agent 主循环与任务驱动执行模式 | ⭐⭐⭐ |
| `#tool-calling` | 工具注册、调度与沙箱执行 | ⭐⭐⭐ |
| `#context-management` | 会话上下文与历史压缩策略 | ⭐⭐⭐ |
| `#llm-query-engine` | LLM 调用封装与流式响应处理 | ⭐⭐ |
| `#permission-model` | Agent 权限分级与沙箱控制 | ⭐⭐⭐ |
| `#command-routing` | Slash command 解析与路由 | ⭐⭐ |
| `#agent-bootstrap` | 工程感知与初始化机制 | ⭐⭐ |
| `#agent-memory` | Agent 长期记忆管理 | ⭐⭐ |
| `#plugin-system` | 插件与技能扩展机制 | ⭐⭐ |
| `#tui-with-ink` | 用 React 模型构建终端 UI | ⭐⭐ |
| `#cost-tracking` | Token 用量与费用追踪 | ⭐ |
| `#ai-orchestration` | AI 编排 AI 的工作流设计 | ⭐⭐⭐ |
| `#clean-room-rewrite` | Clean-room 复现的工程方法论 | ⭐⭐ |

---

## 六、值得关注的工程细节

**为什么是 Python 而不是直接 TypeScript？**

原始 Claude Code 是 TypeScript 写的，直接 port TS 最省力。作者选择 Python，一方面是 clean-room 考量（降低法律风险），另一方面 Python 生态在 AI 工具链上更成熟。目前 Rust 分支也在推进，目标是更快的启动速度和内存安全。

**`parity_audit.py` 是什么？**

一个对标检查脚本，用来验证 Python 复写版和原始 TypeScript 版在功能上的对等性。这是工程上保证"复现质量"的关键工具——自动化的覆盖率检查，而不是靠人工比对。

**Rust 移植的意义**

Harness 本身是计算密集型的（并发工具调用、流式响应处理），Rust 在延迟和内存占用上有明显优势。更重要的是，Rust 的所有权模型天然契合"沙箱隔离"的安全需求。

---

## 七、总结

claw-code 最大的价值不在于它复现了多少 Claude Code 的功能，而在于它**把一个黑盒产品的架构模式做了透明化**。

AI Agent Harness 的本质，是一套**连接 LLM 能力与真实世界的执行框架**。它需要解决：
- 如何让 LLM 可靠地调用工具（`#tool-calling`）
- 如何在有限的 context window 里管理长对话（`#context-management`）
- 如何在自动化和安全之间找平衡（`#permission-model`）
- 如何让框架可扩展（`#plugin-system`）

这些问题，是未来一段时间内 AI 基础设施工程的核心命题。本系列文章将以上述技术标签为线索，逐一深入。
