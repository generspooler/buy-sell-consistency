// ─── Core Domain Types ───────────────────────────────────────────────────────

export type Market = 'CN' | 'US'
export type PositionStatus = 'OPEN' | 'CLOSED'
export type Verdict = 'SUPPORT' | 'WEAKEN' | 'BROKEN'
export type ThesisPointStatus = 'HELD' | 'WEAKENED' | 'BROKEN'
export type SellReason = '止盈' | '止损' | '逻辑破坏' | '换仓' | '其他'

// ─── Snapshot (buy-time + refresh-time, same shape) ──────────────────────────

export interface MarketSnapshot {
  price: number
  change: number      // absolute
  changePct: number   // percent
  volume: number      // shares
  turnoverRate?: number // A股换手率
  high52w?: number
  low52w?: number
  marketCap?: number
  timestamp: string
}

export interface ValuationSnapshot {
  peTTM?: number
  pb?: number
  marketCap?: number
  revenueGrowthYoY?: number
  netProfitGrowthYoY?: number
  roe?: number
  grossMargin?: number
  netMargin?: number
  eps?: number
  dividendYield?: number
}

export interface TechnicalSnapshot {
  ma5?: number
  ma10?: number
  ma20?: number
  ma60?: number
  ma120?: number
  ma250?: number
  macdDIF?: number
  macdDEA?: number
  macdHistogram?: number
  rsi14?: number
  kdjK?: number
  kdjD?: number
  kdjJ?: number
  bollUpper?: number
  bollMid?: number
  bollLower?: number
  support?: number
  resistance?: number
  volumeRatio?: number    // 量比
  distFromMa20Pct?: number
}

export interface ContextSnapshot {
  news: string[]          // top 10 headlines last 30 days
  indexTrend: string      // e.g. "上证指数近30日上涨8.2%，处于年线上方"
  dataTime: string
  dataSource: string
  degraded?: boolean
}

export interface StockSnapshot {
  schemaVersion: number
  market: MarketSnapshot
  valuation: ValuationSnapshot
  technicals: TechnicalSnapshot
  context: ContextSnapshot
}

// ─── Thesis Points ────────────────────────────────────────────────────────────

export interface ThesisPoint {
  id: string
  point: string       // e.g. "Q3营收增速>30%"
  status?: ThesisPointStatus
  evidence?: string
  trend?: '恶化' | '持平' | '改善'
}

// ─── LLM Analysis Output ─────────────────────────────────────────────────────

export interface AnalysisResult {
  thesisPoints: Array<{
    point: string
    status: ThesisPointStatus
    evidence: string
    trend: '恶化' | '持平' | '改善'
  }>
  verdict: Verdict
  trendAnalysis: string
  newsSignals: string[]
  actionSuggestion: string
  confidence: number
}

// ─── History Timeline (历史记录) ──────────────────────────────────────────────

export type HistoryEventType = 'BUY' | 'ADD_BUY' | 'REFRESH' | 'SELL'

/** 加仓时定格的刷新结论——加仓不另跑 LLM，沿用当时最近一次刷新分析。 */
export interface AddBuyAnalysis {
  source: 'REFRESH'
  refreshLogId: number
  refreshedAt: string
  verdict: Verdict
  actionSuggestion: string
  trendAnalysis: string
  confidence: number | null
}

export interface HistoryEventBase {
  id: string          // e.g. "buy-3" — unique across types
  type: HistoryEventType
  at: string          // ISO timestamp used for ordering
}

export interface BuyEvent extends HistoryEventBase {
  type: 'BUY' | 'ADD_BUY'
  shares: number
  price: number
  amount: number
  thesis: string
  thesisPoints: ThesisPoint[]
  snapshot: StockSnapshot | null
  analysis: AddBuyAnalysis | null   // ADD_BUY 才有
}

export interface RefreshEvent extends HistoryEventBase {
  type: 'REFRESH'
  verdict: Verdict
  analysis: AnalysisResult | null
}

export interface SellEvent extends HistoryEventBase {
  type: 'SELL'
  shares: number
  price: number
  amount: number
  reason: string
  note: string
  realizedPnl: number | null   // 已实现盈亏，旧记录为 null
  pnlPct: number | null
  consistencyScore: number | null
  consistencyNote: string | null
}

export type HistoryEvent = BuyEvent | RefreshEvent | SellEvent

// ─── API Response Types ───────────────────────────────────────────────────────

export interface PositionSummary {
  id: number
  symbol: string
  name: string
  market: Market
  status: PositionStatus
  totalShares: number
  avgCost: number
  totalCost: number
  currentPrice?: number
  unrealizedPnl?: number
  unrealizedPnlPct?: number
  lastVerdict?: Verdict
  lastRefreshedAt?: string
  lastActionSuggestion?: string
  openedAt: string
}

export interface SearchResult {
  symbol: string
  name: string
  market: Market
  currentPrice?: number
  change?: number
  changePct?: number
}
