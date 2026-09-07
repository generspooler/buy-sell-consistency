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
