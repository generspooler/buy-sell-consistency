/**
 * MarketDataService — orchestrates data sources with fallback.
 * Primary: EastmoneyAdapter (A股), TencentUSAdapter (US — Yahoo is region-blocked)
 * Fallback: SinaAdapter (A股)
 */
import { EastmoneyAdapter } from './datasources/eastmoney'
import { SinaAdapter } from './datasources/sina'
import { TencentUSAdapter } from './datasources/tencent-us'
import { IMarketDataSource } from './datasources/types'
import { computeAllIndicators, Candle } from './indicators'
import { StockSnapshot, Market } from './types'

// Simple in-memory cache
interface CacheEntry<T> { value: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>()

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.value)
  return fn().then(value => {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs })
    return value
  })
}

const QUOTE_TTL = 5 * 60 * 1000      // 5 min
const FINANCIAL_TTL = 24 * 60 * 60 * 1000 // 24 hours
const NEWS_TTL = 60 * 60 * 1000      // 1 hour

export class MarketDataService {
  private cnPrimary: IMarketDataSource = new EastmoneyAdapter()
  private cnFallback: IMarketDataSource = new SinaAdapter()
  private us: IMarketDataSource = new TencentUSAdapter()

  private source(market: Market): IMarketDataSource {
    return market === 'US' ? this.us : this.cnPrimary
  }

  private async withFallback<T>(
    market: Market,
    fn: (src: IMarketDataSource) => Promise<T>
  ): Promise<{ value: T; degraded: boolean }> {
    if (market === 'US') {
      return { value: await fn(this.us), degraded: false }
    }
    try {
      const value = await fn(this.cnPrimary)
      return { value, degraded: false }
    } catch (e) {
      console.warn('[MarketDataService] Primary failed, falling back to Sina:', e)
      const value = await fn(this.cnFallback)
      return { value, degraded: true }
    }
  }

  async buildSnapshot(symbol: string, market: Market): Promise<StockSnapshot> {
    const [quoteResult, financialsResult, candlesResult, newsResult, indexResult] =
      await Promise.allSettled([
        this.withFallback(market, src =>
          cached(`quote:${symbol}`, QUOTE_TTL, () => src.getQuote(symbol))
        ),
        this.withFallback(market, src =>
          cached(`fin:${symbol}`, FINANCIAL_TTL, () => src.getFinancials(symbol))
        ),
        this.withFallback(market, src =>
          cached(`candles:${symbol}`, FINANCIAL_TTL, () => src.getCandles(symbol, 250))
        ),
        this.withFallback(market, src =>
          cached(`news:${symbol}`, NEWS_TTL, () => src.getNews(symbol, 30))
        ),
        this.withFallback(market, src =>
          cached(`index:${market}`, NEWS_TTL, () => src.getIndexTrend(market))
        ),
      ])

    const degraded =
      quoteResult.status === 'fulfilled' ? quoteResult.value.degraded : false

    const quote =
      quoteResult.status === 'fulfilled'
        ? quoteResult.value.value
        : { price: 0, change: 0, changePct: 0, volume: 0, timestamp: new Date().toISOString() }

    const financials =
      financialsResult.status === 'fulfilled' ? financialsResult.value.value : {}

    const candles: Candle[] =
      candlesResult.status === 'fulfilled' ? candlesResult.value.value : []

    const news: string[] =
      newsResult.status === 'fulfilled' ? newsResult.value.value : []

    const indexTrend =
      indexResult.status === 'fulfilled' ? indexResult.value.value : '指数数据不可用'

    const technicals = computeAllIndicators(candles)

    return {
      schemaVersion: 1,
      market: quote,
      valuation: financials,
      technicals,
      context: {
        news,
        indexTrend,
        dataTime: new Date().toISOString(),
        dataSource: degraded ? 'Sina (降级)' : market === 'CN' ? 'Eastmoney' : 'Tencent',
        degraded,
      },
    }
  }

  async searchStocks(
    query: string,
    market?: Market
  ): Promise<Array<{ symbol: string; name: string; market: Market }>> {
    const results: Array<{ symbol: string; name: string; market: Market }> = []

    if (!market || market === 'CN') {
      try {
        const cn = await this.cnPrimary.searchStocks(query)
        results.push(...cn.map(r => ({ ...r, market: 'CN' as Market })))
      } catch {}
    }
    if (!market || market === 'US') {
      try {
        const us = await this.us.searchStocks(query)
        results.push(...us.map(r => ({ ...r, market: 'US' as Market })))
      } catch {}
    }
    return results.slice(0, 10)
  }
}
