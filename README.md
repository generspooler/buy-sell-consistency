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
- **区间收益**：首页按日期区间统计总收益（区间内已实现盈亏 + 当前浮动盈亏，折算 CNY 并分列 A股 / 美股），默认第一笔交易至今，可切近 30 天、近 90 天、今年或自选区间。
- **美股期权**：买入开仓与卖出开仓（Call / Put）都能记录，从期权链里选合约；论点拆解、刷新分析与平仓评分都按期权的时间维度进行，到期后提示结算。

### 买回计划

卖出表单勾选“制定买回计划”后，设定触发条件（按回撤 % 或按绝对触发价）、拟买回股数与有效期（默认 90 天），随卖出一并锁定。也可点“AI 起草”，让 LLM 从卖出备注中拟出一组数字，你确认或修改后再锁定。

此后每次刷新会自动检查，**价格与论点两个条件同时成立才提醒**：

- **价格**：自上次检查以来的 K 线区间最低价触及触发价，且当前价仍不高于触发价（避免为已经反弹回去的窗口发出提醒）。
- **论点**：最新 verdict 不为 BROKEN。若论点已破坏，下跌多半是基本面问题而非打折，系统会拦截提醒并提示重新评估。

计划状态为 `监控中 → 已触发 / 已过期 / 已取消`，触发后记录同一只股票的买入会自动标记为“已执行”，并区分是按计划买回还是未触发就提前买回。所有流转都写入该持仓的历史记录时间线。

**在哪里看**：首页顶部「买回监控」区块常驻列出所有监控中与已触发的计划（含已清仓的股票），显示触发条件、现价和“距触发还需下跌 X%”，已触发的置顶高亮。清仓后股票不再出现在持仓列表里，但计划仍然活着，这个区块就是它的常驻可见面——不点刷新也看得到。

触发条件锁定后不可修改，只能取消后重立——这个特性的价值来自事前承诺，事后调价会让阈值被合理化。回撤门槛默认不低于 10%：日波动 2-3% 的标的，5 个交易日累计波动约 5-6%，更小的回调在统计上属于噪音。

### 美股期权

在“记录买入”里选中美股后切到“期权”：

1. 选方向（买入开仓 / 卖出开仓）、类型（Call / Put）、到期日、行权价。到期日与行权价来自期权链，行权价下拉里带权利金与 Delta，默认选平值。
2. 填张数与每股权利金（默认带入买卖中间价，可改）。表单当场显示合计金额（× 100）与到期盈亏平衡价。
3. 写开仓理由。期权论点要写清楚方向、幅度和期限——系统拆解论点时会要求至少一条“到期日前标的 ≥ / ≤ 某价位”的时间限定论点。

一张合约是一个独立持仓，挂在标的股票下；同一合约、同一方向再开仓就是加仓。正股与期权互不合并，各自有论点、各自刷新。

- **刷新**：标的快照之外再采集期权数据（权利金、IV、Delta、Theta、剩余天数、距盈亏平衡），并算出“时间已过 X%、标的走完到盈亏平衡距离的 Y%”这类进度（卖方是“距行权价缓冲”与“已赚取权利金”）。LLM 按期权规则判断：方向对但时间不够、或押注波动率而 IV 回落，都至少判为“动摇”。
- **盈亏**：金额都乘以 100。卖方的盈亏 % 以收取的权利金为基数（以 0 买回 = +100%），期权浮盈并入首页的美股汇总。
- **平仓**：买方是“卖出平仓”，卖方是“买入平仓”，同样有一致性评分。期权不设买回计划；买一张期权也不会把同一只股票的正股买回计划标成“已执行”。
- **到期**：过了美东到期日 16:00 仍未平仓的合约显示为“已到期 · 待结算”，首页置顶。详情页按到期日收盘价判断价内 / 价外：价外可一键按“到期作废”（按 0）结算；价内多半已行权 / 被指派——当前版本不自动处理，请按券商实际结算价记录平仓（原因选“其他”），对应的正股交易另行记录。

期权行情来自 CBOE 延迟报价（约 15 分钟延迟，含 IV 与希腊值），失败时降级到 Nasdaq（无 IV / 希腊值，界面标“降级”）。首次拉取一只标的的期权链约需 3-10 秒，之后 5 分钟内走缓存。

### 已平仓与复盘

首页底部「已平仓」折叠区列出全部已平仓持仓（平仓日、持有天数、已实现盈亏、买卖一致性评分），点进去即是完整的历史记录时间线：建仓、加仓、每次刷新分析、卖出与买回计划的全部流转。

已平仓且仍有买回计划的持仓，详情页提供「检查买回计划」按钮，只核对价格与论点闸门，不调用 LLM。

### 区间收益

首页顶部的「区间收益」按日期区间汇总总收益。日期只筛选**卖出记录**：区间内每笔平仓的已实现盈亏直接相加；当区间末端覆盖今天时，再并入当前持仓的浮动盈亏。A 股为 CNY、美股为 USD，用实时汇率折算成一个 CNY 合计，同时分列两个市场。

默认区间是「第一笔交易 → 今天」，也可以切换近 30 天 / 近 90 天 / 今年，或手动选择起止日期。**选过去的区间时只统计已实现盈亏**——系统只存交易日与刷新时刻的快照，没有逐日行情，历史某一天的浮盈无法回溯。

不提供收益率：区间跨越建仓与部分平仓时，「投入成本」没有唯一口径，强行给一个数字比不给更容易误导。

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
LLM_MODEL="glm-5.3-mb"
LLM_EFFORT="max"
LLM_THINKING="1"
```

### 数据说明

- A 股行情来自东方财富，约 15 分钟延迟；备用源为新浪财经。
- 美股行情来自腾讯财经，新闻来自 Google News RSS 和 SEC EDGAR。
- 美股期权链来自 CBOE 延迟报价（约 15 分钟延迟），备用源为 Nasdaq。
- 所有持仓、交易记录和分析结果保存在本地 SQLite 数据库中。

## English

A locally running buy/sell consistency tracker. It records your full buying rationale and market snapshot, continuously re-checks that rationale against fresh market data, and evaluates whether your sell decision remained consistent with your original thesis.

### Features

- **Record buys**: Search Chinese or U.S. stocks, record price, shares, and your reasoning. The app stores a market snapshot and uses an LLM to break the reasoning into trackable thesis points.
- **Refresh analysis**: Fetch updated prices, indicators, and news, then let the LLM mark each point as held, weakened, or broken.
- **Position details**: Review a timeline of thesis changes, current market data, news signals, and historical analyses.
- **Record sells**: Record the sale reason and receive an LLM-generated 0-100 consistency score with an explanation.
- **Re-entry plans**: If you intend to buy back later, turn "wait for a pullback" into a concrete trigger at sell time. Every refresh then checks it automatically and flags the position when the conditions are met.
- **Range P&L**: the home page totals performance over a date range (realized P&L within the range plus current unrealized P&L, converted to CNY and split by market), defaulting to the first trade through today, with 30-day / 90-day / year-to-date / custom ranges.
- **U.S. options**: Record long and short (sell-to-open) calls and puts, picked from the option chain. Thesis extraction, refresh analysis and close scoring all account for the option's time window, and expired contracts are flagged for settlement.

### Re-entry plans

Tick "制定买回计划" on the sell form to set a trigger (a pullback percentage or an absolute price), the shares you intend to buy back, and a validity window (90 days by default). All of it is locked in together with the sell. "AI 起草" asks the LLM to draft the numbers from your sell note; you review or change them before they are locked.

Each refresh then checks the plan, and **both gates must pass before you are notified**:

- **Price**: the lowest candle low since the previous check reached the trigger, and the current price is still at or below it (so a window that has already bounced back does not raise an alert).
- **Thesis**: the latest verdict is not BROKEN. If the thesis is broken, the drop is more likely a fundamental problem than a discount, so the alert is suppressed and the app tells you to re-evaluate instead.

A plan moves through `ARMED → FIRED / EXPIRED / CANCELLED`. Recording a buy of the same stock after a trigger marks the plan EXECUTED and records whether you bought back per plan or jumped in before the trigger. Every transition lands on the position's history timeline.

**Where you see it**: a "买回监控" block at the top of the home page always lists every armed and fired plan — including stocks you have fully sold — with its trigger, the current price, and how much further the price has to fall. Fired plans sort to the top and are highlighted. A fully-sold stock leaves the position list but its plan is still live, and this block is where it stays visible without clicking refresh.

Triggers cannot be edited once locked — cancel and create a new plan instead. The value of this feature comes from pre-commitment, and editing a threshold after the fact is how it gets rationalized away. Pullback triggers default to a 10% floor: for a stock that moves 2-3% a day, five sessions add up to roughly 5-6%, so anything smaller is statistically noise.

### U.S. options

Pick a U.S. stock on the buy page and switch to "期权". Choose the side (buy to open / sell to open), call or put, expiry and strike from the option chain (the strike list shows premium and delta and defaults to at-the-money), then enter contracts and premium per share (prefilled with the bid/ask midpoint). The form shows the total (× 100) and the breakeven at expiry. Write the thesis with direction, size and a deadline — extraction requires at least one time-bound price point such as "underlying ≥ X before expiry".

Each contract is its own position under the underlying stock; opening the same contract on the same side again adds to it. Stock and option positions never merge, and each has its own thesis and refresh.

- **Refresh** adds option data (premium, IV, delta, theta, days left, distance to breakeven) and progress metrics such as "60% of the time used, 20% of the way to breakeven" (for short positions: cushion to strike and premium captured). Being right on direction but short on time, or betting on volatility while IV falls, counts as at least WEAKEN.
- **PnL** applies the 100× multiplier. Short PnL % is measured against the premium received (buying back at 0 = +100%). Option PnL is included in the U.S. total on the home page.
- **Closing** is sell-to-close for long and buy-to-close for short, with the same consistency score. Options have no re-entry plans, and buying an option never marks a stock re-entry plan as executed.
- **Expiry**: a contract still open after 16:00 ET on its expiry date shows as "已到期 · 待结算" at the top of the home page. The detail page checks the expiry-day close: out-of-the-money contracts settle at 0 with one click ("到期作废"); in-the-money contracts were likely exercised or assigned — this version does not automate that, so record the close at the broker's settlement price with reason "其他" and record the resulting stock trade separately.

Option quotes come from CBOE delayed quotes (about 15 minutes delayed, with IV and greeks), falling back to Nasdaq (no IV or greeks, flagged as degraded). The first chain load for an underlying takes about 3–10 seconds; it is cached for 5 minutes.

### Closed positions and review

A collapsed "已平仓" section at the bottom of the home page lists every closed position (close date, holding period, realized PnL, consistency score) and links to its full history timeline: the opening buy, add-ons, every refresh analysis, the sell, and all re-entry plan transitions.

Closed positions that still carry a plan get a "检查买回计划" button on the detail page, which evaluates the price and thesis gates without calling the LLM.

### Range P&L

The "区间收益" block at the top of the home page totals performance over a date range. Only **sell records** are filtered by date: every close inside the range contributes its realized P&L, and when the range ends today the current unrealized P&L is added. A-share amounts are CNY and U.S. amounts are USD; they are converted to a CNY total at the live rate while also being shown per market.

The default range is "first trade → today"; you can switch to 30 days, 90 days, year-to-date, or pick custom dates. **For a past range only realized P&L is counted** — the app stores snapshots at trade and refresh time, not daily price history, so the unrealized P&L of an arbitrary past day cannot be reconstructed.

There is no percentage return: across partial opens and closes in a range, "invested cost" has no single denominator, and a made-up figure misleads more than it informs.

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
LLM_MODEL="glm-5.3-mb"
LLM_EFFORT="max"
LLM_THINKING="1"
```

### Data Notes

- Chinese A-share quotes come from Eastmoney and are delayed by about 15 minutes; Sina Finance is the fallback source.
- U.S. stock quotes come from Tencent Finance; news comes from Google News RSS and SEC EDGAR.
- U.S. option chains come from CBOE delayed quotes (about 15 minutes delayed), with Nasdaq as the fallback.
- Positions, trades, and analyses are stored in a local SQLite database.
