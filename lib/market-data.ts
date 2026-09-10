/**
 * MarketDataService — orchestrates data sources with fallback.
 * Primary: EastmoneyAdapter (A股), TencentUSAdapter (US — Yahoo is region-blocked)
 * Fallback: SinaAdapter (A股)
 * Enrichment: TencentCNAdapter fills fields the primary misses (PB, 52w
 * high/low, turnover rate) and serves CN index trend + smartbox search.
 */
import { EastmoneyAdapter } from './datasources/eastmoney'
import { SinaAdapter } from './datasources/sina'
import { TencentUSAdapter } from './datasources/tencent-us'
import { TencentCNAdapter } from './datasources/tencent-cn'
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

function isFiniteNum(v: number | undefined | null): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Keep the primary value if finite; otherwise take the enrichment value */
function fillNum(primary: number | undefined, enriched: number | undefined): number | undefined {
  return isFiniteNum(primary) ? primary : isFiniteNum(enriched) ? enriched : undefined
}

export class MarketDataService {
  private cnPrimary: IMarketDataSource = new EastmoneyAdapter()
  private cnFallback: IMarketDataSource = new SinaAdapter()
  private us: IMarketDataSource = new TencentUSAdapter()
  private cnEnricher: IMarketDataSource = new TencentCNAdapter()

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
          cached(
            `index:${market}`,
            NEWS_TTL,
            () => market === 'CN' ? this.cnEnricher.getIndexTrend(market) : src.getIndexTrend(market)
          )
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

    // Plan-B enrichment: fill fields the primary/fallback missed from Tencent
    // (only fills absent/non-finite values; never overwrites the primary).
    let enriched = false
    if (market === 'CN') {
      const needQuoteFields =
        !isFiniteNum(quote.turnoverRate) ||
        !isFiniteNum(quote.high52w) ||
        !isFiniteNum(quote.low52w) ||
        !isFiniteNum(quote.marketCap)
      const needValuationFields =
        !isFiniteNum(financials.peTTM) || !isFiniteNum(financials.pb)
      if (needQuoteFields || needValuationFields) {
        try {
          const [tq, tf] = await Promise.all([
            needQuoteFields
              ? cached(`tq:quote:${symbol}`, QUOTE_TTL, () => this.cnEnricher.getQuote(symbol))
              : Promise.resolve(null),
            needValuationFields
              ? cached(`tq:fin:${symbol}`, FINANCIAL_TTL, () => this.cnEnricher.getFinancials(symbol))
              : Promise.resolve(null),
          ])
          if (tq) {
            quote.turnoverRate = fillNum(quote.turnoverRate, tq.turnoverRate)
            quote.high52w = fillNum(quote.high52w, tq.high52w)
            quote.low52w = fillNum(quote.low52w, tq.low52w)
            quote.marketCap = fillNum(quote.marketCap, tq.marketCap)
          }
          if (tf) {
            financials.peTTM = fillNum(financials.peTTM, tf.peTTM)
            financials.pb = fillNum(financials.pb, tf.pb)
            financials.marketCap = fillNum(financials.marketCap, tf.marketCap)
          }
          enriched = true
        } catch (e) {
          console.warn('[MarketDataService] Tencent enrichment failed:', e)
        }
      }
    }

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
        dataSource:
          (degraded ? 'Sina (降级)' : market === 'CN' ? 'Eastmoney' : 'Tencent') +
          (market === 'CN' && enriched ? '+Tencent' : ''),
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
      // Tencent smartbox supplement — catches queries Eastmoney suggest misses
      try {
        const tx = await this.cnEnricher.searchStocks(query)
        for (const r of tx) {
          if (!results.some(x => x.symbol === r.symbol)) {
            results.push({ ...r, market: 'CN' as Market })
          }
        }
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
