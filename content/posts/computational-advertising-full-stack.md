---
title: "计算广告全链路：从一次 Ad Request 到广告展示"
summary: "一次广告请求如何在 100ms 内完成竞价、定向、出价、曝光追踪——DSP/SSP/ADX 全链路工程拆解。"
tags: ["广告技术", "架构"]
---

# 计算广告全链路：从一次 Ad Request 到广告展示

你打开一个 App，屏幕上出现一条广告。这件事看起来平淡无奇，背后却是一场在 **100ms 内完成**的多方竞价拍卖——涉及十几个系统、数十亿用户画像、实时出价与反作弊。

这篇文章从工程角度拆解这条链路，走通每一个环节。

---

## 一、广告生态的参与方

在动手之前，先搞清楚场景里有哪些角色：

| 角色 | 全称 | 职责 |
|------|------|------|
| **Publisher** | 媒体方 | 拥有流量，比如新闻 App、视频平台 |
| **SSP** | Supply-Side Platform | 代表媒体聚合流量，对外出售广告位 |
| **ADX** | Ad Exchange | 流量交易市场，撮合买卖双方 |
| **DSP** | Demand-Side Platform | 代表广告主购买流量，自动竞价 |
| **DMP** | Data Management Platform | 提供用户画像数据 |
| **广告主** | Advertiser | 花钱投广告的品牌/应用 |

```
用户          Publisher App         SSP           ADX          DSP(s)
 │                  │                │              │              │
 │── 打开页面 ──────>│                │              │              │
 │                  │── Ad Request ─>│── Bid Req ──>│── Bid Req ──>│
 │                  │                │              │<─ Bid Resp ──│
 │                  │                │<─ Auction ───│              │
 │<─── 广告素材 ─────│<── Win Noti ───│              │              │
 │                  │                │              │              │
```

整条链路的核心是 **RTB（Real-Time Bidding，实时竞价）**，ADX 在毫秒级时间窗口内向所有 DSP 广播竞价请求，各 DSP 独立决策出价，价高者得。

---

## 二、完整请求链路（100ms 内）

### 第一步：Ad Request（0–5ms）

用户触发广告位时，Publisher SDK 向 SSP 发出 Ad Request，携带：

```json
{
  "imp": [{
    "id": "imp_001",
    "banner": { "w": 320, "h": 50 },
    "bidfloor": 0.5,
    "bidfloorcur": "USD"
  }],
  "site": {
    "page": "https://example.com/news/12345",
    "cat": ["IAB12"]
  },
  "device": {
    "ua": "Mozilla/5.0...",
    "ip": "1.2.3.4",
    "geo": { "country": "CN", "city": "Beijing" },
    "ifa": "aaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  },
  "user": { "id": "user_xyz" }
}
```

这是 **OpenRTB 2.x** 标准格式，几乎所有主流 ADX/SSP 都遵循这个协议。

`ifa`（Identifier for Advertising）是设备广告 ID，是用户定向的核心标识符。

### 第二步：SSP 流量预处理（5–15ms）

SSP 收到请求后做几件事：

1. **流量过滤**：无效流量（爬虫、作弊设备）直接丢弃
2. **上下文丰富**：补全地理位置、设备型号、操作系统等信息
3. **Floor Price 计算**：根据历史成交价、流量质量动态计算底价
4. **路由决策**：决定向哪些 DSP/ADX 发出竞价请求

SSP 通常同时接入多个 ADX，以最大化填充率和收益。

### 第三步：DSP 竞价决策（15–80ms，这是核心）

这是整条链路技术含量最高的部分。DSP 收到 Bid Request 后，需要在 **50–80ms** 内完成：

#### 3.1 用户定向（Targeting）

```
设备 ID (ifa)
    │
    ├── DMP 查询 ──────> 用户画像（兴趣标签、人群包）
    │                     {"interests": ["gaming", "finance"], "age": "25-34"}
    │
    ├── 历史行为查询 ──> Redis/本地缓存（转化记录、频控数据）
    │
    └── 定向匹配 ──────> 遍历广告主的 Targeting 规则
                         - 地域：北京 ✓
                         - 人群：25-34岁男性 ✓
                         - 兴趣：游戏 ✓
                         - 频控：该用户今日已看3次 < 上限5次 ✓
```

定向筛选的目的是从几十万个活跃广告活动里，快速找出**有资格竞争这次曝光**的候选广告集合。

这一步通常用**倒排索引 + Bitmap** 实现，能在几毫秒内从百万级广告里筛出候选集。

#### 3.2 出价计算（Bidding）

候选广告集合确定后，对每条广告计算出价：

```
出价 = eCPM / 1000

eCPM = CPM_base × pCTR × pCVR × 质量因子

其中：
- CPM_base：广告主设置的目标 CPM
- pCTR：预估点击率（模型预测）
- pCVR：预估转化率（模型预测）
- 质量因子：广告素材质量、历史表现
```

pCTR/pCVR 预测模型通常是 **LR + GBDT 特征 + 深度学习**，工业界常见架构是 Wide & Deep 或 DeepFM。

#### 3.3 频控（Frequency Capping）

防止同一用户被同一广告轰炸：

```python
# 伪代码
def check_freq_cap(user_id: str, ad_id: str, cap: FreqCap) -> bool:
    key = f"fc:{user_id}:{ad_id}:{cap.window}"
    count = redis.get(key) or 0
    return int(count) < cap.max_count

def increment_freq(user_id: str, ad_id: str, window: int):
    key = f"fc:{user_id}:{ad_id}:{window}"
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, window)
    pipe.execute()
```

频控用 Redis 实现，key 设计为 `用户ID:广告ID:时间窗口`，读写都在 1ms 以内。

#### 3.4 构造 Bid Response

```json
{
  "id": "bid_resp_001",
  "seatbid": [{
    "bid": [{
      "id": "bid_001",
      "impid": "imp_001",
      "price": 2.35,
      "adid": "ad_campaign_789",
      "nurl": "https://dsp.example.com/win?price=${AUCTION_PRICE}",
      "adm": "<div>...广告素材 HTML...</div>",
      "crid": "creative_456",
      "w": 320,
      "h": 50
    }]
  }],
  "cur": "USD"
}
```

`nurl` 是 Win Notice URL，ADX 在该广告胜出后会回调这个地址，DSP 据此记录曝光并扣费。

`${AUCTION_PRICE}` 是 ADX 宏替换，会填入实际成交价（二价拍卖结算价）。

### 第四步：ADX 竞价（80–90ms）

ADX 收集所有 DSP 的出价，进行**二价拍卖（Vickrey Auction）**：

```
DSP_A 出价: $2.35
DSP_B 出价: $1.80
DSP_C 出价: $2.10

胜者: DSP_A（出价最高）
成交价: $2.10 + $0.01 = $2.11（第二高价 + 1分钱）
```

二价拍卖的好处是激励各方**真实出价**——你出的是你认为这次曝光值多少钱，而不是猜对手出多少。

ADX 选出胜者后：
1. 向胜出 DSP 发送 Win Notice（回调 nurl）
2. 向其他 DSP 发送 Loss Notice（可选）
3. 将广告素材返回给 SSP

### 第五步：广告渲染与曝光追踪（90–100ms）

SSP 将广告素材返回给 Publisher，用户看到广告。

但链路没结束，后续还有：

```
广告展示
    │
    ├── Impression Tracking（曝光追踪）
    │   └── 1x1 像素图片请求，记录曝光事件
    │
    ├── Click Tracking（点击追踪）
    │   └── 点击跳转经过 DSP/SSP 的追踪链接
    │
    └── Conversion Tracking（转化追踪）
        └── 用户在广告主 App/网站完成目标行为后回传
```

曝光追踪通常是在广告 HTML 里埋一个 1x1 的 img 标签，加载时触发追踪请求：

```html
<img src="https://track.dsp.example.com/imp?bid=xxx&price=2.11" 
     width="1" height="1" style="display:none">
```

---

## 三、DSP 系统架构

上面讲的是一次请求的流程，下面看 DSP 内部的系统架构：

```
                         ┌─────────────────────────────────────────┐
                         │              DSP 系统                    │
                         │                                         │
ADX Bid Request ─────────┤  Bid Engine（出价引擎）                  │
                         │  ┌─────────┐  ┌──────────┐             │
                         │  │ Targeting│  │  Bidding  │            │
                         │  │  Engine  │  │  Engine   │            │
                         │  └────┬─────┘  └─────┬────┘            │
                         │       │               │                 │
                         │  ┌────▼───────────────▼────┐           │
                         │  │        Data Layer        │           │
                         │  │  Redis  │  DMP  │  Model │           │
                         │  └─────────────────────────┘           │
                         │                                         │
                         │  Campaign Management（投放管理）         │
                         │  ┌──────────┐  ┌───────────┐           │
                         │  │ 预算控制  │  │  创意管理  │           │
                         │  └──────────┘  └───────────┘           │
                         │                                         │
                         │  Reporting（报表系统）                   │
                         │  ┌─────────────────────────┐           │
                         │  │ 曝光/点击/转化数据聚合     │           │
                         │  └─────────────────────────┘           │
                         └─────────────────────────────────────────┘
```

### 出价引擎的性能要求

这是 DSP 最核心的组件，性能要求极苛刻：

| 指标 | 要求 |
|------|------|
| 响应时间 | P99 < 80ms（留给 ADX 超时阈值） |
| QPS | 单机 5000–50000 req/s |
| 可用性 | 99.99%（掉线意味着流量损失） |

工程实践上：
- **无阻塞 IO**：用 Go/Rust/C++ 实现，避免 GC 抖动
- **本地缓存**：用户画像、广告活动信息缓存在进程内，不走网络
- **超时熔断**：任何下游（DMP、Redis）超过 10ms 直接降级，返回默认出价或不出价

### 预算控制

广告主设置了日预算，DSP 要保证不超支，但也不能"省着花"（没花完等于白白浪费曝光机会）：

```python
# 节奏控制（Pacing）伪代码
class BudgetPacer:
    def __init__(self, daily_budget: float, total_seconds: int = 86400):
        self.daily_budget = daily_budget
        self.total_seconds = total_seconds
        self.spent = 0.0
        self.start_time = time.time()

    def should_bid(self) -> bool:
        elapsed = time.time() - self.start_time
        ideal_spent = self.daily_budget * (elapsed / self.total_seconds)
        # 实际花费低于理想进度，加速出价
        # 实际花费高于理想进度，降低出价概率
        return self.spent < ideal_spent * 1.1
```

实际系统里预算控制通常放在分布式计数器（Redis + 本地近似计数），避免每次竞价都去 Redis 原子读写。

---

## 四、数据链路：从曝光到报表

广告打完之后，数据要回流到报表系统，广告主才知道钱花在哪、效果如何。

```
曝光/点击事件
    │
    ▼
Kafka（事件流）
    │
    ├── 实时消费 ──> ClickHouse（OLAP）──> 实时报表
    │
    └── 批处理 ────> Spark/Flink ────────> 离线归因分析
```

典型的数据字段：

```sql
-- ClickHouse 曝光表
CREATE TABLE impressions (
    event_time  DateTime,
    campaign_id UInt64,
    ad_id       UInt64,
    user_id     String,
    device_id   String,
    country     LowCardinality(String),
    price       Float32,
    win_price   Float32
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (campaign_id, event_time);
```

用 ClickHouse 的原因：列式存储，聚合查询性能比 MySQL 快 100 倍以上，千亿级数据下跑 `GROUP BY campaign_id` 只需要几秒。

---

## 五、反作弊

广告生态里作弊是个严重问题，全球每年有数十亿美元被虚假流量（Invalid Traffic, IVT）吞噬。

常见作弊手段：
- **设备农场**：大量真实设备刷点击
- **SDK 劫持**：恶意 SDK 模拟广告点击
- **IP 代理池**：用代理伪造地理位置

DSP 侧的防御：

```python
def is_suspicious(request: BidRequest) -> bool:
    signals = [
        # IP 异常：数据中心 IP、已知代理
        is_datacenter_ip(request.device.ip),
        # 设备 ID 异常：全零、已知黑名单
        is_blacklisted_device(request.device.ifa),
        # 行为异常：同一设备 1 分钟内出现超过 N 次
        exceeds_device_frequency(request.device.ifa, window=60, max=10),
        # User-Agent 异常：与设备信息不一致
        ua_device_mismatch(request.device.ua, request.device.os),
    ]
    return sum(signals) >= 2  # 多个信号叠加判定
```

---

## 六、端到端时序总结

```
T=0ms    用户触发广告位
T=5ms    Publisher SDK 发出 Ad Request
T=15ms   SSP 完成流量预处理，向 ADX 转发
T=20ms   ADX 向各 DSP 广播 Bid Request
T=70ms   DSP 完成定向、出价，返回 Bid Response
T=85ms   ADX 完成竞价，选出胜者
T=90ms   Win Notice 发送给胜出 DSP
T=95ms   广告素材返回 Publisher
T=100ms  用户看到广告
```

这 100ms 窗口是行业的约定俗成——超过这个时间，用户的页面可能已经加载完了，广告位置也没了。

---

## 小结

计算广告的工程复杂度远超大多数业务系统：

- **延迟要求极苛刻**：100ms 窗口内完成跨系统协作
- **数据规模庞大**：全球 DAU 十亿级，每天数十亿次竞价
- **多方博弈**：媒体、广告主、用户利益都要兼顾
- **反作弊持续对抗**：攻防永远在进行

如果你在做 DSP 系统，出价引擎的延迟优化和预算控制的精准度，是最值得投入的两个方向。其余的都是围绕这两点展开的工程建设。
