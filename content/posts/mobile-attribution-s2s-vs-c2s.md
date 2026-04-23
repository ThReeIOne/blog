---
title: "移动广告归因全解析：S2S vs C2S，以及 Adjust/AppsFlyer 的完整数据链路"
summary: "一次应用安装背后，归因系统如何判定「是哪个广告带来的用户」——C2S 与 S2S 的原理、差异、链路拆解，以及 Adjust、AppsFlyer 等主流 MMP 的工作方式。"
tags: ["广告技术", "归因", "MMP", "移动营销"]
---

# 移动广告归因全解析：S2S vs C2S，以及 Adjust/AppsFlyer 的完整数据链路

用户点击了一条广告，下载并安装了 App，完成了首次付费——这整个过程中，**广告主只有一个核心问题：这个用户是哪条广告带来的？**

这就是移动归因（Mobile Attribution）要解决的问题。

归因听起来简单，做起来却涉及设备指纹、隐私沙盒、服务端对接、防作弊等一系列工程挑战。这篇文章从原理出发，完整拆解 C2S 和 S2S 两种归因模式，以及以 Adjust、AppsFlyer 为代表的 MMP 是如何在其中扮演角色的。

---

## 一、为什么需要归因？

广告主每天在多个渠道投放广告：Facebook Ads、Google UAC、TikTok Ads、各类 DSP。每个渠道都声称自己带来了转化。

如果没有一个独立的第三方来裁定，广告主会面临：

- **重复计算**：同一个用户被多个渠道同时归功
- **数据不可信**：每个渠道的数据都来自自家平台，天然有利益冲突
- **无法优化预算**：不知道哪个渠道 ROI 最高，钱该往哪投

因此，行业催生了 **MMP（Mobile Measurement Partner，移动归因平台）**，作为中立的第三方，统一收集所有渠道的点击、展示数据，与 App 内的安装、事件数据进行匹配，给出最终的归因结论。

主流 MMP 包括：

| 平台 | 简介 |
|------|------|
| **Adjust** | 德国公司，被 AppLovin 收购，市场占有率极高 |
| **AppsFlyer（AF）** | 以色列公司，全球最大 MMP 之一 |
| **Kochava** | 北美为主 |
| **Singular** | 主打 Marketing Analytics |
| **Branch** | 侧重 deep linking + 归因 |

---

## 二、归因的核心逻辑：点击 → 安装匹配

归因的本质是：**用一个唯一标识符，将「点击广告」这个事件和「安装/激活 App」这个事件连接起来。**

### 2.1 归因窗口（Attribution Window）

MMP 不会无限期等待。通常设置：
- **点击归因窗口**：点击后 7 天内发生的安装，归到该点击
- **展示归因窗口**：看到广告（未点击）后 1 天内安装，归到该展示（View-Through Attribution）

超出窗口的安装，归为**自然量（Organic）**。

### 2.2 归因优先级

当一个用户在安装前触碰了多个广告，MMP 遵循**Last Click（最后点击）**原则——归因给安装前最后一次点击的渠道。部分平台支持多触点归因（Multi-Touch Attribution），但 Last Click 仍是行业主流。

### 2.3 设备标识符

归因匹配的关键是设备标识符：

| 标识符 | 平台 | 说明 |
|--------|------|------|
| **IDFA** | iOS | Identifier for Advertisers，iOS 14.5 后需用户授权（ATT） |
| **GAID / AAID** | Android | Google Advertising ID，默认开启但可关闭 |
| **设备指纹** | 全平台 | IP + User-Agent + 屏幕分辨率等组合，作为 IDFA/GAID 不可用时的降级方案 |

---

## 三、C2S（Client-to-Server）归因

### 3.1 什么是 C2S

C2S，即 **Client-to-Server**，指归因数据由**客户端 SDK 直接上报**给 MMP 服务器。

广告主在 App 中集成 MMP 的 SDK（如 Adjust SDK、AppsFlyer SDK），SDK 在 App 启动时自动完成：
1. 收集设备标识符（IDFA / GAID）
2. 向 MMP 服务器发送安装/事件数据
3. MMP 完成匹配，返回归因结果

### 3.2 C2S 完整链路

```
广告渠道（Facebook/TikTok/DSP）
    │
    │  ① 用户点击广告
    │     渠道记录 Click，生成 click_id
    │     将 click_id 拼入落地页/跳转链接
    ▼
点击链接（包含 click_id + 设备信息）
    │
    │  ② 跳转到应用商店
    ▼
App Store / Google Play
    │
    │  ③ 用户下载安装 App
    ▼
App 首次启动
    │
    │  ④ MMP SDK 初始化
    │     收集 IDFA/GAID、IP、User-Agent 等
    │     发送 Install 请求到 MMP 服务器
    ▼
MMP 服务器（Adjust / AppsFlyer）
    │
    │  ⑤ 匹配：将 Install 数据与 Click 数据对比
    │     优先匹配设备 ID（IDFA/GAID）
    │     次选设备指纹
    │
    │  ⑥ 归因结论 → 通知广告渠道（Postback）
    │     告知：「这个安装归属于你的广告活动 X」
    ▼
广告渠道接收 Postback，更新转化数据
```

### 3.3 C2S 的优势与局限

**优势：**
- 接入简单，集成 SDK 即可，不需要后端改造
- 实时性好，安装发生后即上报
- MMP SDK 自带防作弊、设备指纹能力

**局限：**
- **依赖客户端环境**：SDK 崩溃、用户关闭权限、网络异常都会丢数据
- **iOS ATT 限制**：iOS 14.5 后 IDFA 获取率大幅下降，设备指纹匹配准确率下降
- **内购/付费事件延迟**：付费行为需要在 App 内触发 SDK 事件，时序难以保证
- **服务端事件无法上报**：订阅续费、退款等纯服务端行为，C2S 无法覆盖

---

## 四、S2S（Server-to-Server）归因

### 4.1 什么是 S2S

S2S，即 **Server-to-Server**，指归因数据由**广告主自己的服务器直接调用 MMP 的 API** 上报，绕过客户端 SDK。

广告主的后端系统在检测到安装、付费等关键事件时，主动向 MMP 发送 HTTP 请求，告知事件详情。

### 4.2 S2S 完整链路

```
广告渠道（Facebook/TikTok/DSP）
    │
    │  ① 用户点击广告
    │     渠道在点击链接中注入 click_id（宏变量）
    │     如：&af_sub1={clickid} 或 &adjust_tracker={tracker_token}
    ▼
落地页 / App 跳转链接
    │
    │  ② click_id 通过 URL 参数传递给 App
    │     iOS：通过 SKAdNetwork / Universal Links
    │     Android：通过 Install Referrer
    ▼
App 安装 & 首次启动
    │
    │  ③ App 读取 click_id，传给广告主后端
    │     方式：API 请求、本地存储后上传
    ▼
广告主后端服务器
    │
    │  ④ 服务器持久化 click_id + device_id + user_id 的映射关系
    │
    │  ⑤ 当关键事件发生时（安装激活、注册、付费）：
    │     服务器调用 MMP 的 S2S API
    │     携带：device_id / click_id / event_name / revenue 等
    ▼
MMP 服务器（Adjust / AppsFlyer）
    │
    │  ⑥ MMP 完成归因匹配
    │     返回归因结果给广告主服务器
    │
    │  ⑦ MMP 向广告渠道发送 Postback（Callback）
    ▼
广告渠道接收转化数据，更新 ROAS/CPA 报表
```

### 4.3 Adjust S2S 接口示例

```http
POST https://s2s.adjust.com/event
Content-Type: application/json

{
  "s2s": "1",
  "app_token": "abc123xyz",
  "event_token": "def456",
  "idfa": "D2CADB96-XXXX-XXXX-XXXX-0A49C8B18CE6",
  "ip_address": "203.0.113.45",
  "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)",
  "revenue": "9.99",
  "currency": "USD",
  "environment": "production",
  "created_at_unix": 1714000000
}
```

### 4.4 AppsFlyer S2S 接口示例

AppsFlyer S2S 使用 `inappevent` 接口：

```http
POST https://api2.appsflyer.com/inappevent/{app_id}
Authentication: {devkey}
Content-Type: application/json

{
  "appsflyer_id": "1234567890123-456789",
  "customer_user_id": "user_001",
  "eventName": "af_purchase",
  "eventValue": {
    "af_revenue": "9.99",
    "af_currency": "USD",
    "af_content_id": "item_xyz"
  },
  "ip": "203.0.113.45",
  "eventTime": "2026-04-23 10:00:00.000"
}
```

### 4.5 S2S 的优势与局限

**优势：**
- **数据完整性高**：服务端事件（订阅续费、退款、服务端发货）都能上报
- **不依赖 SDK**：避免 SDK 崩溃、版本兼容等客户端问题
- **隐私合规友好**：数据在服务端流转，减少客户端数据采集的合规压力
- **防作弊更强**：服务端可以做二次验证（如 Apple Receipt Validation、Google Play Billing 验证）

**局限：**
- **接入复杂**：需要后端开发，维护 S2S 数据管道
- **click_id 传递链路长**：需要从点击链接 → App → 后端全程透传，任何一环断链都会丢失归因信息
- **时效性要求**：MMP 通常要求事件在发生后 24-72 小时内上报，超时可能无法归因

---

## 五、C2S vs S2S 对比总结

| 维度 | C2S（SDK） | S2S（服务端） |
|------|-----------|--------------|
| **接入成本** | 低，集成 SDK 即可 | 高，需后端开发 |
| **数据来源** | 客户端 | 服务器 |
| **iOS ATT 影响** | 较大（IDFA 获取率低） | 较小（可用其他 ID） |
| **服务端事件** | ❌ 无法覆盖 | ✅ 完整覆盖 |
| **防作弊能力** | MMP SDK 内置 | 需自行实现或配合 MMP |
| **数据实时性** | 好 | 取决于服务端延迟 |
| **适用场景** | 中小应用、快速接入 | 电商、订阅制、游戏（重付费） |

**实际场景中，C2S + S2S 混合使用是主流：**
- App 内行为（打开、注册）用 SDK 上报
- 付费、订阅、退款等关键商业事件走 S2S

---

## 六、Adjust 完整数据链路

### 6.1 Adjust 的核心架构

```
广告渠道
  └─ 点击链接（含 Adjust Tracker Token）
        │
        ▼
  Adjust Click API（记录点击，生成 click_id）
        │
        ▼
  App 安装 + SDK 初始化
  └─ SDK 发送 Install 到 Adjust
        │
        ▼
  Adjust 归因引擎
  ├─ 匹配 IDFA/GAID → Deterministic Attribution（确定性）
  └─ 匹配设备指纹  → Probabilistic Attribution（概率性）
        │
        ▼
  归因结论写入 Adjust Dashboard
        │
  ├─ Postback 回传给广告渠道（激活通知）
  ├─ 推送到广告主的 S2S Callback URL
  └─ 数据导出到 BI（BigQuery / S3 / 数据湖）
```

### 6.2 Adjust Tracker URL 结构

```
https://app.adjust.com/{tracker_token}?
  campaign={campaign_name}
  &adgroup={adgroup_name}
  &creative={creative_name}
  &idfa={idfa}           ← 渠道注入设备 ID（宏）
  &click_id={click_id}   ← 渠道注入自己的点击 ID
  &redirect={store_url}  ← 实际跳转的应用商店链接
```

### 6.3 Adjust SKAdNetwork（iOS 隐私模式）

iOS 14.5 后，Adjust 通过 Apple 的 SKAdNetwork 框架完成归因：

```
App Store 展示广告
    │ ① 展示/点击（附带 SKAdNetwork 签名）
    ▼
用户安装 App
    │ ② iOS 系统发送 SKAdNetwork Postback 给 Apple
    ▼
Apple 验证后转发给 Adjust
    │ ③ Adjust 解析 campaign_id（0-99）
    │    对应广告主预先设置的活动映射表
    ▼
归因结论（注意：延迟 24-48h，无设备级数据）
```

SKAdNetwork 的核心限制：**没有 IDFA，没有用户级数据，只有聚合的活动维度数据。**

---

## 七、AppsFlyer 完整数据链路

### 7.1 AF 核心架构

AppsFlyer 的整体流程与 Adjust 类似，但有自己的特色机制：

```
广告渠道
  └─ OneLink（AF 统一跳转链接）
        │ 点击时 AF 服务器记录点击
        ▼
  App 安装 + AF SDK 初始化
  └─ SDK 发送 Install（含 GAID/IDFA + IP + UA）
        │
        ▼
  AF 归因引擎（People-Based Attribution）
  ├─ Deterministic：IDFA/GAID 精确匹配
  ├─ Probabilistic：设备指纹（IP + UA + 时间窗口）
  └─ View-Through：曝光后安装（1 天窗口）
        │
        ▼
  归因写入 AF Dashboard
  ├─ Push API → 广告主服务器（实时事件流）
  ├─ Pull API → 广告主主动拉取报表
  ├─ Postback → 广告渠道
  └─ Data Locker → 原始数据导出（S3 / BigQuery）
```

### 7.2 AF OneLink

OneLink 是 AF 的统一深度链接方案，一条链接同时处理：

```
https://yourbrand.onelink.me/abc/{campaign}?
  pid={media_source}     ← 渠道标识（facebook_int / tiktok_int）
  &c={campaign_name}
  &af_adset={adset}
  &af_ad={ad_name}
  &af_sub1={click_id}    ← 渠道自己的 click_id
  &is_retargeting=true   ← 再营销标记
```

访问 OneLink 时：
- **已安装 App**：直接唤起 App 并跳转到对应页面（Deep Link）
- **未安装 App**：跳转到 App Store / Google Play（Deferred Deep Link）

### 7.3 AF Protect360（防作弊）

AppsFlyer 内置防作弊模块，识别以下欺诈类型：

| 欺诈类型 | 说明 |
|---------|------|
| **Click Flooding** | 大量虚假点击，抢占归因窗口 |
| **Click Injection** | Android 广播监听安装事件，实时注入虚假点击 |
| **Install Hijacking** | 拦截真实用户安装，伪造归因 |
| **Device Farms** | 批量真实设备模拟安装 |
| **SDK Spoofing** | 伪造 SDK 请求（无真实设备） |

---

## 八、Postback（回传）机制

归因完成后，MMP 需要告知广告渠道「这个转化归你了」——这就是 **Postback（也叫 Callback）**。

### 8.1 Postback 触发时机

```
用户完成安装/付费
    │
    ▼
MMP 归因引擎完成匹配
    │
    ├─ 向归因渠道发送 Install Postback
    │    GET https://ad.partner.com/postback?
    │        click_id={click_id}
    │        &install_time={ts}
    │        &device_id={idfa}
    │
    └─ 向广告主服务器发送 Raw Data Callback
         POST https://your-server.com/attribution
             {event: "install", media_source: "facebook_int", ...}
```

### 8.2 Postback 参数示例（AppsFlyer → Facebook）

```
https://www.facebook.com/mobilecenter/attribution/postback?
  advertiser_id={gaid}
  &action=install
  &fb_click_id={click_id}
  &timestamp={install_time}
  &app_id={app_id}
```

---

## 九、iOS 隐私新形势下的归因挑战

### 9.1 ATT（App Tracking Transparency）

iOS 14.5 起，所有 App 必须弹窗请求用户授权才能读取 IDFA。行业平均授权率约 **25-40%**，大量用户进入「隐私模式」。

结果：
- 基于 IDFA 的确定性归因覆盖率大幅下降
- 设备指纹（Probabilistic）使用增加，但 Apple 明确表示将限制
- **SKAdNetwork** 成为 iOS 上唯一官方支持的归因方案，但数据极度聚合

### 9.2 应对策略

| 策略 | 说明 |
|------|------|
| **提升 ATT 授权率** | 在合适时机弹窗，配合价值说明 |
| **SKAN + MMP 转化模型** | 用 MMP 建模弥补 SKAdNetwork 的数据缺失 |
| **S2S 强化** | 服务端数据不受 ATT 影响，加大 S2S 事件覆盖 |
| **Aggregated Event Measurement** | Facebook 的聚合事件方案，配合 SKAN |
| **Privacy Sandbox（Android）** | Google 推出的隐私沙盒方案，未来将替代 GAID |

---

## 十、总结

移动广告归因的核心链路：

```
点击 → click_id 生成 → 安装 → 设备 ID 匹配 → 归因结论 → Postback 回传
```

C2S 和 S2S 各有侧重：
- **C2S（SDK）**：快速接入，覆盖客户端行为，受隐私政策影响大
- **S2S（服务端）**：覆盖服务端事件，数据可靠，接入成本高

Adjust 和 AppsFlyer 作为头部 MMP，本质上是在做同一件事：**充当中立裁判，用最可信的方式告诉广告主，每一分钱花在了哪里，带来了多少真实回报。**

隐私计算时代下，归因正在从「用户级精确匹配」向「聚合建模」演进。SKAdNetwork、Privacy Sandbox、Conversion Lift——这些都是行业应对隐私限制的探索。归因的终点不是消失，而是在更小的数据暴露面下，给出更可信的结论。

---

*作者：刘胜利 | 更新日期：2026-04-23*
