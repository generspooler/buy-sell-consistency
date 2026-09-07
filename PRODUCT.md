# 买卖一致性跟踪系统（Buy-Sell Consistency Tracker）

| | |
|---|---|
| **产品名称** | Buy-Sell Consistency Tracker |
| **文档版本** | v1.0 |
| **日期** | 2026-09-07 |
| **状态** | 设计定稿，待实现 |
| **目标用户** | 个人投资者（单机单用户，本人使用） |
| **覆盖市场** | A股（沪深）+ 美股 |

---

## 1. 产品定位

一个本地 Web 应用，解决一个核心问题：**买入时的理由，今天还成立吗？**

系统在买入时完整记录"买入理由 + 当时关键数据快照"，之后一键刷新时采集最新综合信息，交给顶尖大模型（资深金融分析师角色）逐条对照买入论点，判断理由是**依旧支撑 / 开始动摇 / 已经破坏**，给出简短操作建议与充分的趋势变化信息，并在卖出时对"当初理由 vs 卖出行为"做一致性评分，形成完整的投资决策闭环。

### 核心价值

1. **对抗遗忘与自我欺骗**：买入理由白纸黑字入库，无法事后美化。
2. **逐论点检验而非泛泛而谈**：LLM 只判断"当初的论点今天还成立吗"，聚焦且可信。
3. **理由生命周期可视化**：每次刷新留痕，能看到论点从 HELD → WEAKENED → BROKEN 的演变时间线，知道理由是哪天开始动摇的。
4. **闭环验证**：卖出时的一致性评分让"知行合一"变成可量化、可复盘的能力。

---

## 2. 总体架构

```
┌─────────────── Next.js 单应用 (localhost:3000) ───────────────┐
│  页面层    持仓总览 / 买入录入 / 持仓详情 / 卖出平仓 / 复盘统计  │
│  API 层    /api/trades  /api/positions  /api/refresh  /api/sell│
│  服务层    MarketDataService（多源行情+财务+新闻采集）           │
│           IndicatorService（K线本地技术指标计算）                │
│           LLMAnalyzer（claude CLI 子进程，结构化输出）           │
│  数据层    SQLite (Prisma) — 股票/持仓/交易/快照/分析记录        │
│  数据源    A股：东方财富(主) + 新浪(备，自动降级)                │
│           美股：Yahoo Finance                                  │
└────────────────────────────────────────────────────────────────┘
```

### 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 技术栈 | Next.js 全栈（App Router）+ TypeScript | 单运行时，`npm run dev` 即用 |
| 存储 | SQLite + Prisma | 本地单文件，零运维，JSON 字段灵活存快照 |
| LLM 接入 | `claude -p` headless CLI 子进程（默认 Opus） | 本机已具备；换模型只改配置，未来可切任意 OpenAI 兼容 API |
| A股数据源 | 东方财富公开 HTTP 接口（主）+ 新浪（备） | 无需 key、字段全（行情/财务/资金流/新闻公告）；Adapter 抽象隔离接口变动风险 |
| 美股数据源 | Yahoo Finance 公开接口 | 行情/估值/新闻覆盖完整 |
| 技术指标 | 拉取 K 线历史后**本地计算**（MA/MACD/RSI/KDJ/BOLL） | 比第三方现成指标更及时、更全、零额外依赖 |
| 数据及时性策略 | 行情实时拉取（缓存 ≤5 分钟）；财务/新闻当日缓存 | 保证刷新时数据尽可能新，同时避免接口压力 |

### 多源冗余机制

数据访问统一走 `DataSourceAdapter` 接口：

```
IMarketDataSource {
  getQuote(symbol)          // 实时行情
  getFinancials(symbol)     // 估值/财务指标
  getCandles(symbol, days)  // K线历史
  getNews(symbol, days)     // 新闻/公告
}
实现：EastmoneyAdapter（A股主）→ SinaAdapter（A股备，自动降级）
     YahooAdapter（美股）
```

主源请求失败/超时（5s）自动切换备源，UI 标注"数据降级"。

---

## 3. 数据模型（SQLite / Prisma）

```
Stock（股票字典）
  id / symbol（A股: SH600519/SZ000001 格式；美股: AAPL）
  / market（CN | US）/ name

Position（持仓）
  id / stockId / status（OPEN | CLOSED）
  / openedAt / closedAt
  / totalShares / avgCost / totalCost / realizedPnl
  ※ 同一股票多笔买入挂在同一 Position 下，支持加仓

BuyRecord（买入记录）
  id / positionId / boughtAt / shares / price / amount
  thesis（买入理由，自由文本，核心字段）
  thesisPointsJson（LLM 拆解的 3-6 条可检验论点）
  snapshotJson（买入时四块数据快照，含 schemaVersion）

RefreshLog（刷新留痕）
  id / positionId / refreshedAt
  snapshotJson（本次采集的最新快照）
  analysisJson（LLM 结构化分析结果）
  verdict（SUPPORT | WEAKEN | BROKEN 三档总评）

SellRecord（卖出记录）
  id / positionId / soldAt / shares / price / amount
  reason（归因：止盈/止损/逻辑破坏/换仓/其他 + 自由文本）
  consistencyScore（卖出时系统对比"当初理由 vs 卖出原因"的评分）

Review（复盘统计，V1.2）
  汇总：理由存活周期、verdict 演变、盈亏归因、胜率
```

### 快照四块结构（买入时 & 刷新时同构）

```json
{
  "schemaVersion": 1,
  "market": "行情快照：价格/涨跌幅/成交量/换手率/52周位置",
  "valuation": "估值财务：PE(TTM)/PB/市值/营收增速/利润增速/ROE",
  "technicals": "技术面：MA5-250多空排列/距均线%/MACD/RSI/KDJ/BOLL/支撑压力位/量能变化",
  "context": "市场环境：个股近30天新闻公告摘要 + 大盘（沪深300/标普纳指）趋势状态"
}
```

> 不同市场字段差异大（A股有资金流，美股没有），因此快照用 JSON 存储；`schemaVersion` 字段保证未来演进兼容。

### 一致性灵魂：thesisPoints

录入买入理由后，系统自动让 LLM 将 thesis 拆解为 **3-6 条可验证论点**（如"Q3 营收增速 >30%"、"钠电池产能落地"、"行业补贴政策延续"），用户确认/修正后入库。此后每次刷新，LLM **逐条对照现状**判断 `HELD / WEAKENED / BROKEN`——这是全系统"一致性"判断的核心机制。

---

## 4. 刷新分析流水线

```
1. 数据采集（单股并行，~2-4s）
   ├─ 实时行情快照
   ├─ 估值与财务指标
   ├─ K线（250日）→ 本地计算全套技术指标
   ├─ 近 30 天新闻/公告
   └─ 大盘环境（A股：上证/沪深300；美股：标普/纳指）

2. Prompt 构造
   [买入档案] thesis + 论点列表 + 买入时快照
   [现状]     最新快照 + 关键指标对比表（买入时 vs 现在 vs 上次刷新）
   [指令]     资深金融分析师角色 prompt，逐论点判断，严格 JSON 输出

3. LLM 分析
   子进程调用 claude CLI（默认 opus，配置可切换）

4. 结构化结果入库（RefreshLog）
```

### 分析输出 schema（analysisJson）

```json
{
  "thesisPoints": [
    {
      "point": "Q3营收增速>30%",
      "status": "HELD | WEAKENED | BROKEN",
      "evidence": "最新财报显示营收增速降至18%…",
      "trend": "恶化 | 持平 | 改善"
    }
  ],
  "verdict": "SUPPORT | WEAKEN | BROKEN",
  "trendAnalysis": "较上期分析的边际变化叙述（重点展开：本次 vs 买入时 vs 上次刷新双维度对比）",
  "newsSignals": ["大股东减持公告（利空）", "…"],
  "actionSuggestion": "持有 / 加仓观察 / 减仓 / 清仓（一行，刻意简短）",
  "confidence": 0.85
}
```

### 设计原则（用户明确要求）

- **操作建议简短**：`actionSuggestion` 一行结论。
- **趋势变化信息充分**：`trendAnalysis` 做双维度对比叙述（vs 买入时、vs 上次刷新），重点呈现相对原 buy reason 的变化。
- **逐论点对照**：不泛泛重评，只检验"当初论点今天是否成立"，聚焦且省 token。

### 多持仓刷新

逐股独立分析（保持判断独立性）；UI 显示进度条；完成后按 verdict 排序展示（BROKEN 最前 → WEAKEN → SUPPORT）。

---

## 5. 页面与交互

### 5.1 持仓总览（首页）

- 持仓卡片流：股票名 / 现价 / 盈亏% / verdict 徽章（绿 SUPPORT / 黄 WEAKEN / 红 BROKEN）/ 上次刷新时间 / 最新一句话建议。
- 顶部「一键刷新全部」按钮（带逐股进度显示）。
- 卡片点击进入持仓详情。

### 5.2 买入录入

1. 股票搜索：输入代码/名称自动补全，自动识别 A股/美股。
2. 价格 / 股数 / 日期录入。
3. thesis 输入（核心，多行文本）。
4. 「自动采集快照」：一键抓取当时四块数据，可手动微调补充。
5. 提交时 LLM 自动拆解 thesisPoints 并回显，用户确认/修正后入库。

### 5.3 持仓详情

- 头部：现价 / 成本 / 盈亏 / 持仓时长。
- **Tab1 买入理由**：thesis 原文 + 论点列表 + 买入时快照。
- **Tab2 刷新历史**：时间线视图，每次刷新的论点状态变化（HELD→WEAKENED 高亮）+ verdict 演变 + 趋势分析叙述。
- **Tab3 加仓 / 卖出操作**。

### 5.4 卖出平仓

- 卖出价 / 股数 / 日期 + 归因选择（止盈 / 止损 / 逻辑破坏 / 换仓 / 其他）+ 补充说明。
- 系统调用 LLM 对比"当初 thesis vs 卖出原因"，输出一致性评分与点评。
- Position 转 CLOSED，进入复盘池。

### 5.5 复盘统计（V1.2）

- consistencyScore 分布、理由平均存活周期、盈亏按"逻辑正确与否"归因、胜率。

---

## 6. 错误处理

| 场景 | 处理 |
|------|------|
| 主数据源失败/超时（5s） | 自动降级备源，UI 标注"数据降级" |
| LLM 输出 JSON 解析失败 | 重试 1 次，仍失败标记该股"分析失败"，不阻塞其他持仓 |
| claude CLI 不存在 | 明确报错并给出安装指引 |
| 非交易时段刷新 | 正常执行，行情为最近快照，UI 标注数据时间 |

---

## 7. 版本规划

| 版本 | 范围 | 状态 |
|------|------|------|
| **V1.0** | 买入录入（快照 + 论点拆解）、持仓总览、完整刷新分析流水线、卖出平仓（一致性评分） | 待实现 |
| **V1.1** | 刷新历史时间线强化、verdict 演变图表、多笔加仓管理 | 规划中 |
| **V1.2** | 复盘统计页、盈亏归因分析 | 规划中 |

---

## 8. 非目标（明确不做）

- 实时行情推送/盯盘（按需刷新模式）
- 自动交易/下单
- 多用户与权限系统
- 回测引擎
- 移动端适配（桌面浏览器优先）
