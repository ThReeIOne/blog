---
title: "Claude Code 源码泄露事件分析 — Source Map 暴露与 AI CLI 架构解读"
tags: ["安全", "供应链安全", "AI工具", "Claude", "架构分析"]
summary: "2026年3月31日，Anthropic 的 Claude Code CLI 工具通过 npm 包中遗留的 source map 文件意外暴露完整 TypeScript 源码。本文分析泄露原因、代码架构，以及对开发者工具安全性的启示。"
---

> 事件发生时间：2026-03-31
> 涉及产品：Claude Code（Anthropic 官方 AI 编程 CLI 工具）

## 一、事件经过

2026年3月31日，安全研究员 [Chaofan Shou (@Fried_rice)](https://x.com/Fried_rice) 在推特上公开了一个发现：

> "Claude code source code has been leaked via a map file in their npm registry!"

随即社区开始围观。他发现 Claude Code 的 npm 包在发布时意外携带了 `.map` 文件（JavaScript source map）。这个 `.map` 文件本身不含源码，但它指向了 Anthropic R2 存储桶中托管的完整、未混淆 TypeScript 源文件——而这个存储桶是**公开可访问的**。

两个错误叠加，造成了完整源码外泄：

1. **npm 包没有过滤掉 `.map` 文件**（构建产物中不该保留 source map 的 URL 引用）
2. **R2 存储桶没有设置访问控制**（源文件应该是私有的，或者根本不应该上传）

随后，GitHub 用户 instructkr 将源码镜像到了 [instructkr/claude-code](https://github.com/instructkr/claude-code)，以"教育和安全研究"为由存档。

---

## 二、泄露的是什么

泄露内容是 Claude Code 的完整 `src/` 目录快照：

- **文件数量：** ~1,900 个文件
- **代码行数：** 512,000+ 行
- **语言：** TypeScript（strict 模式）
- **运行时：** Bun
- **Terminal UI：** React + Ink

这不是一个小工具的源码，这是一个相当完整的 AI 编程助手 CLI 系统。

---

## 三、从源码看 Claude Code 的架构

作为一个意外公开的「黑盒变白盒」事件，顺便分析一下它的架构。

### 3.1 工具层（~40 个工具）

Claude Code 的每个「能力」都被实现为一个独立的 Tool 模块，定义了输入 Schema、权限模型和执行逻辑：

| 工具 | 描述 |
|------|------|
| `BashTool` | Shell 命令执行 |
| `FileReadTool` | 文件读取（支持图片、PDF、Jupyter Notebook） |
| `FileWriteTool` | 文件创建/覆盖 |
| `FileEditTool` | 局部文件修改（字符串替换） |
| `GrepTool` | 基于 ripgrep 的内容搜索 |
| `AgentTool` | 子 Agent 派生 |
| `MCPTool` | MCP 协议工具调用 |
| `LSPTool` | LSP（语言服务器协议）集成 |
| `CronCreateTool` | 定时触发器创建 |
| `TeamCreateTool` | 多 Agent 团队管理 |
| `EnterPlanModeTool` | 进入 Plan 模式 |
| `EnterWorktreeTool` | Git worktree 隔离 |

工具的权限模型有几种模式：`default`（提示用户）、`plan`（计划模式）、`bypassPermissions`、`auto` 等。每次工具调用都会经过权限检查层。

### 3.2 多智能体协调

Claude Code 有完整的多 Agent 架构：

- `AgentTool` — 派生子 Agent
- `coordinator/` — 多 Agent 编排
- `TeamCreateTool` / `TeamDeleteTool` — 团队级并行工作管理
- `SendMessageTool` — Agent 间消息通信

这意味着一个 Claude Code 会话可以在内部派生多个并行子 Agent 分别处理不同任务，最后汇总结果。

### 3.3 IDE 桥接层

`bridge/` 目录实现了 CLI 与 IDE 扩展（VS Code、JetBrains）的双向通信：

- `bridgeMain.ts` — 桥接主循环
- `bridgeMessaging.ts` — 消息协议
- `jwtUtils.ts` — JWT 鉴权
- `sessionRunner.ts` — 会话执行管理

这解释了为什么 Claude Code 能在 IDE 里「接管」终端操作。

### 3.4 技能与插件系统

- `skills/` — 可复用的工作流，通过 `SkillTool` 执行，用户可以添加自定义 Skill
- `plugins/` — 插件子系统，支持内置和第三方插件
- `/skills` 斜杠命令 — 直接在 CLI 中管理 Skill

### 3.5 Feature Flag 与构建裁剪

这是一个比较有意思的设计。Claude Code 使用 Bun 的 `bun:bundle` 特性在构建时做 dead code elimination：

```typescript
import { feature } from 'bun:bundle'

// 未激活的功能在构建时被完全剥离
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

已知的功能 Flag 包括：`PROACTIVE`、`KAIROS`、`BRIDGE_MODE`、`DAEMON`、`VOICE_MODE`、`AGENT_TRIGGERS`、`MONITOR_TOOL`。

这意味着分发给用户的二进制文件里可能包含这些开关，不同的版本或渠道可以启用不同的功能子集。

### 3.6 启动优化

`main.tsx` 在模块 import 发生之前作为副作用执行了以下预取操作：

```typescript
// 在重型 import 之前提前触发
startMdmRawRead()       // MDM 配置读取
startKeychainPrefetch() // macOS Keychain 预读
// + API 预连接
```

重型模块（OpenTelemetry、gRPC、GrowthBook Analytics）通过动态 `import()` 懒加载，直到真正需要时才初始化，以减少冷启动时间。

### 3.7 持久化记忆

有一个叫 `memdir/` 的模块，实现了 Agent 的持久化记忆目录。配合 `/memory` 斜杠命令，用户可以让 Claude Code 在会话间记住特定信息。（不知道为什么这让我感觉很亲切。）

---

## 四、技术栈总结

| 层次 | 技术选型 |
|------|---------|
| 运行时 | Bun |
| 语言 | TypeScript (strict) |
| Terminal UI | React + Ink |
| CLI 解析 | Commander.js |
| Schema 验证 | Zod v4 |
| 代码搜索 | ripgrep |
| 协议 | MCP SDK、LSP |
| API | Anthropic SDK |
| 遥测 | OpenTelemetry + gRPC |
| 功能开关 | GrowthBook |
| 鉴权 | OAuth 2.0、JWT、macOS Keychain |

---

## 五、这次事件的启示

### 对发布安全的启示

这次泄露的根本原因是两个相互独立的配置失误同时存在：

**Source map 应该如何处理？**

生产发布的 npm 包通常有两种策略：
1. **完全不打 source map**（最彻底，推荐闭源工具使用）
2. **打 hidden source map**（`.map` 文件不引用外部 URL，或不打包进 npm）

Anthropic 似乎采用了第三种错误方式：将 source map 引用打进了包，同时又把源文件放在了公开可访问的存储桶里。

**检查你的发布流程：**

```bash
# 检查 npm 包里是否有 source map 引用
npm pack --dry-run | grep "\.map$"

# 检查构建产物里是否有外部 sourceMappingURL
grep -r "sourceMappingURL=https://" dist/
```

### 对存储桶配置的启示

R2/S3 存储桶的**默认设置在不同服务商之间并不一致**。即使你认为"没有公开"，也要显式确认：

- 新建存储桶时确认 Block Public Access
- 定期审计 bucket policy 和 ACL
- CI/CD 流程中不要把源文件上传到与 CDN 同仓库的路径

---

## 六、法律与伦理维度

这次泄露在技术层面是「公开可访问数据」——任何知道 URL 构造方式的人都可以下载，不需要任何越权操作。

但它并不因此变得合法或道德上无争议：
- Anthropic 显然没有意图公开这些源码
- 代码版权归 Anthropic 所有
- 镜像存档是否构成版权侵权，取决于各司法管辖区的具体规定

从研究角度看，这次意外曝光让我们得以了解一个生产级 AI CLI 工具的真实架构；从安全角度看，这提醒所有在做 SaaS/CLI 工具的团队：**构建产物的安全审计和存储桶权限配置，值得专门做一次检查。**

---

## 七、参考资料

- 镜像仓库（教育存档）：[instructkr/claude-code](https://github.com/instructkr/claude-code)
- 原始爆料：[@Fried_rice, March 31, 2026](https://x.com/Fried_rice/status/2038894956459290963)
- Claude Code 官方文档：[docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code/overview)
