---
title: "Apifox 供应链投毒攻击 — 排查与修复指南"
date: "2026-03-26"
tags: ["安全", "供应链攻击", "应急响应"]
summary: "2026年3月4日至22日，Apifox CDN 上的 JS 文件遭恶意篡改，可窃取 SSH 密钥、Git 凭证、K8s 配置等敏感数据并远程执行代码。本文提供完整的排查方法与修复步骤。"
---

> 编写日期：2026-03-26
> 适用范围：2026年3月4日至3月22日期间使用过 Apifox 桌面端的所有用户（Windows / macOS / Linux）

## 一、事件概述

2026年3月4日至3月22日期间，Apifox CDN 上的 `apifox-app-event-tracking.min.js` 文件被攻击者篡改（从正常的 34KB 变为 77KB），注入了恶意代码。任何在此期间启动过 Apifox 桌面端的用户均可能受到影响。

**恶意代码的行为：**

1. 采集机器指纹（MAC地址 + CPU型号 + 主机名 → SHA-256）
2. 窃取 Apifox 账户信息（邮箱、姓名）
3. 窃取 SSH 密钥（`~/.ssh/` 整个目录）
4. 窃取 Git 凭证（`~/.git-credentials`）
5. 窃取命令行历史（`~/.zsh_history`、`~/.bash_history`）
6. 窃取 K8s 配置（`~/.kube/*`）、npm token（`~/.npmrc`）、环境变量（`~/.zshrc`）等
7. 将数据加密后上传至攻击者服务器 `apifox.it.com`
8. 攻击者可远程执行任意代码（通过 `eval()` 执行 C2 下发的 JS 脚本）

**风险等级：严重（Critical）**

---

## 二、排查方法

### 2.1 macOS 排查

#### 方法一：检查 Apifox 本地存储（推荐）

恶意代码会在 Apifox 的 localStorage 中写入 `_rl_mc` 和 `_rl_headers` 键。即使已更新 Apifox，这些数据可能仍然存在。

```bash
# 搜索 Apifox 本地存储中的投毒标记
find ~/Library/Application\ Support/apifox -path "*/Local Storage/leveldb/*" \
  \( -name "*.ldb" -o -name "*.log" \) \
  -exec strings {} \; 2>/dev/null | grep -E "(_rl_mc|_rl_headers|af_uuid)"
```

**判断结果：**
- 如果有输出（特别是包含 `af_uuid`、`_rl_headers`、`_rl_mc` 等字段），**说明已中招**
- 如果无输出，说明本地存储中没有投毒痕迹

#### 方法二：通过开发者工具检查（需 Apifox 仍可打开）

1. 打开 Apifox
2. 按 `Cmd + Option + I` 打开开发者工具
3. 切换到 Console 标签，输入：

```javascript
console.log('_rl_mc:', localStorage.getItem('_rl_mc'));
console.log('_rl_headers:', localStorage.getItem('_rl_headers'));
```

- 如果 `_rl_mc` 返回 64 位十六进制哈希字符串，**说明已中招**
- 如果返回 `null`，说明未受影响

---

### 2.2 Windows 排查

#### 方法一：PowerShell 检查本地存储

```powershell
Select-String -Path "$env:APPDATA\apifox\Local Storage\leveldb\*" `
  -Pattern "rl_mc","rl_headers" -List | Select-Object Path
```

如果有匹配结果，**说明已中招**。

#### 方法二：手动检查

Apifox 数据目录位于：
```
%APPDATA%\apifox\Local Storage\leveldb\
```

使用文本编辑器或 `strings` 工具检查 `.ldb` 文件中是否包含 `_rl_mc`、`_rl_headers` 字符串。

---

### 2.3 Linux 排查

```bash
find ~/.config/apifox -path "*/Local Storage/leveldb/*" \
  \( -name "*.ldb" -o -name "*.log" \) \
  -exec strings {} \; 2>/dev/null | grep -E "(_rl_mc|_rl_headers|af_uuid)"
```

如果有输出，**说明已中招**。

---

### 2.4 网络层面排查

检查防火墙/代理日志中是否有以下域名的访问记录（3月4日至3月22日期间）：

| 类型 | 指标 |
|------|------|
| C2 域名 | `apifox.it.com` |
| Stage-1 URL | `apifox.it.com/public/apifox-event.js` |
| Stage-2 URL | `apifox.it.com/<随机8位hex>.js` |
| 数据外泄端点 | `apifox.it.com/event/0/log` |
| 数据外泄端点 | `apifox.it.com/event/2/log` |

---

## 三、确认中招后的修复步骤

### 3.1 立即停止 Apifox

```bash
# macOS / Linux
pkill -f Apifox

# Windows (PowerShell)
Stop-Process -Name "Apifox" -Force
```

### 3.2 轮换 SSH 密钥（最紧急）

攻击者会递归读取整个 `~/.ssh/` 目录，所有密钥必须视为已泄露。

```bash
# 1. 删除旧密钥
rm -f ~/.ssh/id_rsa ~/.ssh/id_rsa.pub
rm -f ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub
# 删除其他你使用的密钥文件...

# 2. 生成新密钥（推荐使用 ed25519）
ssh-keygen -t ed25519 -f ~/.ssh/id_rsa -C "your_email@example.com" -N ""

# 3. 查看新公钥
cat ~/.ssh/id_rsa.pub
```

**然后更新所有使用该密钥的地方：**
- GitHub / GitLab：Settings → SSH Keys，删除旧公钥，添加新公钥
- 远程服务器：用密码登录后更新 `~/.ssh/authorized_keys`
- 其他使用 SSH 认证的服务

### 3.3 轮换 Git 凭证

```bash
# 检查是否有明文 Git 凭证
cat ~/.git-credentials 2>/dev/null
```

如果文件存在：
- **GitHub**：Settings → Developer settings → Personal access tokens → 吊销所有旧 token，重新生成
- **GitLab**：Preferences → Access Tokens → 吊销所有旧 token，重新生成
- 删除旧凭证文件：`rm -f ~/.git-credentials`

### 3.4 检查并清理 Shell 历史中的敏感信息

```bash
# 搜索历史命令中可能包含的敏感信息
grep -iE '(password|passwd|token|secret|key|mysql|postgres|redis|export.*KEY|export.*TOKEN|export.*SECRET)' \
  ~/.zsh_history ~/.bash_history 2>/dev/null
```

如果发现密码、token、API key 等，**必须逐一轮换**。

### 3.5 轮换其他可能泄露的凭证

根据你电脑上实际存在的文件，按需处理：

| 文件 | 检查命令 | 处置 |
|------|---------|------|
| `~/.npmrc` | `cat ~/.npmrc 2>/dev/null` | 如存在 authToken，到 npm 官网重新生成 |
| `~/.kube/config` | `ls ~/.kube/ 2>/dev/null` | 轮换 K8s OIDC Token / kubeconfig |
| `~/.subversion/` | `ls ~/.subversion/ 2>/dev/null` | 修改 SVN 密码 |
| `~/.zshrc` | `grep -i 'export.*KEY\|TOKEN\|SECRET' ~/.zshrc` | 轮换其中暴露的 API Key |
| `~/.gitconfig` | `cat ~/.gitconfig 2>/dev/null` | 检查是否有 credential helper 缓存 |

### 3.6 审查服务器登录日志

检查 3月4日至3月22日期间是否有异常 SSH 登录：

```bash
# 在你的服务器上执行
# 查看 SSH 登录记录
last -20
# 查看认证日志
grep "Accepted" /var/log/auth.log 2>/dev/null | tail -50
# 或 CentOS/RHEL
grep "Accepted" /var/log/secure 2>/dev/null | tail -50
```

重点关注：
- 来自陌生 IP 的登录
- 非工作时间的登录
- 登录后执行的异常命令

### 3.7 清除 Apifox 投毒数据

```bash
# macOS — 删除 Apifox 数据目录
rm -rf ~/Library/Application\ Support/apifox
rm -rf ~/Library/Caches/apifox-updater

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:APPDATA\apifox"

# Linux
rm -rf ~/.config/apifox
```

### 3.8 Apifox 应用处理

建议卸载 Apifox 桌面端。如必须继续使用：
- 确保更新到最新版本（投毒入口文件已于 3月25日被还原）
- 使用 Apifox Web 版替代桌面端
- 考虑迁移到其他 API 工具（如 Postman、Insomnia、Bruno 等开源替代方案）

---

## 四、排查结果速查表

| 检查项 | 未中招 | 已中招 |
|--------|--------|--------|
| localStorage `_rl_mc` | 不存在 / null | 64位十六进制哈希 |
| localStorage `_rl_headers` | 不存在 / null | 包含 af_uuid、af_os 等字段 |
| 网络日志 `apifox.it.com` | 无记录 | 有访问记录 |

---

## 五、IoC（攻陷指标）汇总

### 网络指标

| 类型 | 值 |
|------|-----|
| C2 域名 | `apifox.it.com` |
| C2 IP (Cloudflare) | `104.21.2.104`, `172.67.129.21` |
| 投毒文件 | `cdn.apifox.com/www/assets/js/apifox-app-event-tracking.min.js` (77KB版本) |
| 数据外泄 | `apifox.it.com/event/0/log`, `apifox.it.com/event/2/log` |

### 主机指标

| 类型 | 值 |
|------|-----|
| localStorage 键 | `_rl_mc`, `_rl_headers` |
| 异常 HTTP Header | `af_uuid`, `af_os`, `af_user`, `af_name`, `af_apifox_user`, `af_apifox_name` |

### 加密指标

| 类型 | 值 |
|------|-----|
| 数据外泄加密 | AES-256-GCM, 密码: `apifox`, 盐值: `foxapi` |
| C2 通信加密 | RSA-2048 OAEP + SHA-256 |

---

## 六、参考资料

- 原始分析文章：[Apifox 供应链投毒攻击 — 完整技术分析](https://rce.moe/2026/03/25/apifox-supply-chain-attack-analysis/)
- 部分反混淆后的恶意代码：[GitHub Gist](https://gist.github.com/phith0n/7020c55bf241b2f3ccf5254192bd48a5)
- Wayback Machine 存档：`web.archive.org/web/20260305051418/https://cdn.apifox.com/www/assets/js/apifox-app-event-tracking.min.js`
