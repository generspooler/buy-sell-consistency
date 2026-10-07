import { MarketSnapshot, ValuationSnapshot, ContextSnapshot } from '../types'
import { Candle } from '../indicators'

// ─── 期权链（v0.4）——形状与股票行情不同，单独一套接口 ─────────────────────

export interface OptionQuote {
  contractSymbol: string   // OCC，如 NVDA261120C00240000
  optionType: 'CALL' | 'PUT'
  strike: number
  expiry: string           // YYYY-MM-DD
  bid?: number
  ask?: number
  last?: number
  volume?: number
  openInterest?: number
  iv?: number              // 小数
  delta?: number
  gamma?: number
  theta?: number
  vega?: number
}

export interface OptionChain {
  underlying: string
  underlyingPrice?: number
  underlyingIv30?: number  // 百分数
  dataTime: string
  source: string
  hasGreeks: boolean
  degraded?: boolean
  contracts: OptionQuote[]
}

export interface IOptionDataSource {
  /** expiry 省略 = 全部到期日。 */
  getChain(underlying: string, expiry?: string): Promise<OptionChain>
}

export interface IMarketDataSource {
  getQuote(symbol: string): Promise<MarketSnapshot>
  getFinancials(symbol: string): Promise<ValuationSnapshot>
  getCandles(symbol: string, days?: number): Promise<Candle[]>
  getNews(symbol: string, days?: number): Promise<string[]>
  getIndexTrend(market: 'CN' | 'US'): Promise<string>
  searchStocks(query: string): Promise<Array<{ symbol: string; name: string }>>
}
