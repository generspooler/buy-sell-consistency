[中文](#中文) | [English](#english)

# Buy-Sell Consistency Tracker

A local-first investment decision tracker that records why you bought a stock, re-checks those reasons as market data changes, and scores whether your selling decision stayed consistent with the original thesis.

## 中文

一个本地运行的买卖一致性跟踪工具。它用于记录每次买入的完整理由和数据快照，在持仓期间持续对照最新市场数据检查买入论点是否仍然成立，并在卖出时评估这次决策与当初理由的一致性。

### 功能

- **记录买入**：搜索 A 股或美股，记录价格、数量和买入理由；系统会保存数据快照，并使用 LLM 将理由拆解成可跟踪的论点。
- **刷新分析**：获取最新行情、技术指标和新闻，由 LLM 逐条判断论点是“仍然成立 / 减弱 / 已失效”。
- **持仓详情**：查看论点演变时间线、最新数据、新闻信号和历史分析结果。
- **记录卖出**：记录卖出原因，LLM 会给出 0-100 的买卖一致性评分和说明。
- **买回计划**：卖出时若打算之后买回，可当场把“待回调买入”定成一个带数字的触发条件；此后每次刷新自动检查，条件达成时高亮提醒。

### 买回计划

卖出表单勾选“制定买回计划”后，设定触发条件（按回撤 % 或按绝对触发价）、拟买回股数与有效期（默认 90 天），随卖出一并锁定。也可点“AI 起草”，让 LLM 从卖出备注中拟出一组数字，你确认或修改后再锁定。

此后每次刷新会自动检查，**价格与论点两个条件同时成立才提醒**：

- **价格**：自上次检查以来的 K 线区间最低价触及触发价，且当前价仍不高于触发价（避免为已经反弹回去的窗口发出提醒）。
- **论点**：最新 verdict 不为 BROKEN。若论点已破坏，下跌多半是基本面问题而非打折，系统会拦截提醒并提示重新评估。

计划状态为 `监控中 → 已触发 / 已过期 / 已取消`，触发后记录同一只股票的买入会自动标记为“已执行”，并区分是按计划买回还是未触发就提前买回。所有流转都写入该持仓的历史记录时间线。

**在哪里看**：首页顶部「买回监控」区块常驻列出所有监控中与已触发的计划（含已清仓的股票），显示触发条件、现价和“距触发还需下跌 X%”，已触发的置顶高亮。清仓后股票不再出现在持仓列表里，但计划仍然活着，这个区块就是它的常驻可见面——不点刷新也看得到。

触发条件锁定后不可修改，只能取消后重立——这个特性的价值来自事前承诺，事后调价会让阈值被合理化。回撤门槛默认不低于 10%：日波动 2-3% 的标的，5 个交易日累计波动约 5-6%，更小的回调在统计上属于噪音。

### 已平仓与复盘

首页底部「已平仓」折叠区列出全部已平仓持仓（平仓日、持有天数、已实现盈亏、买卖一致性评分），点进去即是完整的历史记录时间线：建仓、加仓、每次刷新分析、卖出与买回计划的全部流转。

已平仓且仍有买回计划的持仓，详情页提供「检查买回计划」按钮，只核对价格与论点闸门，不调用 LLM。

### 快速开始

要求：

- Node.js 18+
- 已安装并登录的 `claude` CLI（默认用于 LLM 分析）

```bash
npm install
npx prisma db push
npm run dev
```

打开 <http://localhost:3000>。

如需自定义配置，可创建 `.env`：

```env
DATABASE_URL="file:./dev.db"
LLM_COMMAND="claude"
LLM_MODEL="claude-opus-5"
```

### 数据说明

- A 股行情来自东方财富，约 15 分钟延迟；备用源为新浪财经。
- 美股行情来自腾讯财经，新闻来自 Google News RSS 和 SEC EDGAR。
- 所有持仓、交易记录和分析结果保存在本地 SQLite 数据库中。

## English

A locally running buy/sell consistency tracker. It records your full buying rationale and market snapshot, continuously re-checks that rationale against fresh market data, and evaluates whether your sell decision remained consistent with your original thesis.

### Features

- **Record buys**: Search Chinese or U.S. stocks, record price, shares, and your reasoning. The app stores a market snapshot and uses an LLM to break the reasoning into trackable thesis points.
- **Refresh analysis**: Fetch updated prices, indicators, and news, then let the LLM mark each point as held, weakened, or broken.
- **Position details**: Review a timeline of thesis changes, current market data, news signals, and historical analyses.
- **Record sells**: Record the sale reason and receive an LLM-generated 0-100 consistency score with an explanation.
- **Re-entry plans**: If you intend to buy back later, turn "wait for a pullback" into a concrete trigger at sell time. Every refresh then checks it automatically and flags the position when the conditions are met.

### Re-entry plans

Tick "制定买回计划" on the sell form to set a trigger (a pullback percentage or an absolute price), the shares you intend to buy back, and a validity window (90 days by default). All of it is locked in together with the sell. "AI 起草" asks the LLM to draft the numbers from your sell note; you review or change them before they are locked.

Each refresh then checks the plan, and **both gates must pass before you are notified**:

- **Price**: the lowest candle low since the previous check reached the trigger, and the current price is still at or below it (so a window that has already bounced back does not raise an alert).
- **Thesis**: the latest verdict is not BROKEN. If the thesis is broken, the drop is more likely a fundamental problem than a discount, so the alert is suppressed and the app tells you to re-evaluate instead.

A plan moves through `ARMED → FIRED / EXPIRED / CANCELLED`. Recording a buy of the same stock after a trigger marks the plan EXECUTED and records whether you bought back per plan or jumped in before the trigger. Every transition lands on the position's history timeline.

**Where you see it**: a "买回监控" block at the top of the home page always lists every armed and fired plan — including stocks you have fully sold — with its trigger, the current price, and how much further the price has to fall. Fired plans sort to the top and are highlighted. A fully-sold stock leaves the position list but its plan is still live, and this block is where it stays visible without clicking refresh.

Triggers cannot be edited once locked — cancel and create a new plan instead. The value of this feature comes from pre-commitment, and editing a threshold after the fact is how it gets rationalized away. Pullback triggers default to a 10% floor: for a stock that moves 2-3% a day, five sessions add up to roughly 5-6%, so anything smaller is statistically noise.

### Closed positions and review

A collapsed "已平仓" section at the bottom of the home page lists every closed position (close date, holding period, realized PnL, consistency score) and links to its full history timeline: the opening buy, add-ons, every refresh analysis, the sell, and all re-entry plan transitions.

Closed positions that still carry a plan get a "检查买回计划" button on the detail page, which evaluates the price and thesis gates without calling the LLM.

### Quick Start

Requirements:

- Node.js 18+
- A signed-in `claude` CLI (used for LLM analysis by default)

```bash
npm install
npx prisma db push
npm run dev
```

Open <http://localhost:3000>.

Optional configuration in `.env`:

```env
DATABASE_URL="file:./dev.db"
LLM_COMMAND="claude"
LLM_MODEL="claude-opus-5"
```

### Data Notes

- Chinese A-share quotes come from Eastmoney and are delayed by about 15 minutes; Sina Finance is the fallback source.
- U.S. stock quotes come from Tencent Finance; news comes from Google News RSS and SEC EDGAR.
- Positions, trades, and analyses are stored in a local SQLite database.
