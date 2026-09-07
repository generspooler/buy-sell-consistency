import { MarketSnapshot, ValuationSnapshot, ContextSnapshot } from '../types'
import { Candle } from '../indicators'

export interface IMarketDataSource {
  getQuote(symbol: string): Promise<MarketSnapshot>
  getFinancials(symbol: string): Promise<ValuationSnapshot>
  getCandles(symbol: string, days?: number): Promise<Candle[]>
  getNews(symbol: string, days?: number): Promise<string[]>
  getIndexTrend(market: 'CN' | 'US'): Promise<string>
  searchStocks(query: string): Promise<Array<{ symbol: string; name: string }>>
}
