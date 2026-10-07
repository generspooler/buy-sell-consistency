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
import { CboeOptionsAdapter } from './datasources/cboe-options'
import { NasdaqOptionsAdapter } from './datasources/nasdaq-options'
import { IMarketDataSource, IOptionDataSource, OptionChain } from './datasources/types'
import { computeAllIndicators, Candle } from './indicators'
import { StockSnapshot, Market, OptionType } from './types'
import { computeOptionBlock } from './options'

// Simple in-memory cache. Concurrent misses on the same key share one request
// (an option chain is ~2MB / ~10s; a stock + an option on the same underlying
// refreshing in parallel must not fetch it twice).
interface CacheEntry<T> { value: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.value)
  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending
  const p = fn()
    .then(value => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs })
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

const QUOTE_TTL = 5 * 60 * 1000      // 5 min
const FINANCIAL_TTL = 24 * 60 * 60 * 1000 // 24 hours
const NEWS_TTL = 60 * 60 * 1000      // 1 hour
const OPTION_TTL = 5 * 60 * 1000     // 5 min — CBOE itself is 15 min delayed
/** After a CBOE failure, go straight to Nasdaq for a while instead of
 *  waiting out the 25s timeout on every call. */
const OPTION_PRIMARY_COOLDOWN = 5 * 60 * 1000
let optionPrimaryDownUntil = 0

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
  private optPrimary: IOptionDataSource = new CboeOptionsAdapter()
  private optFallback: IOptionDataSource = new NasdaqOptionsAdapter()

  private source(market: Market): IMarketDataSource {
    return market === 'US' ? this.us : this.cnPrimary
  }

  /**
   * 美股期权链。CBOE（主，含 IV/希腊值）一次返回全部到期日，按标的整链缓存
   * 后在内存里过滤；失败降级 Nasdaq（无希腊值），结果标 degraded。
   */
  async getOptionChain(underlying: string, expiry?: string): Promise<OptionChain> {
    const sym = underlying.toUpperCase()
    if (Date.now() >= optionPrimaryDownUntil) {
      try {
        const full = await cached(`optchain:cboe:${sym}`, OPTION_TTL, () =>
          this.optPrimary.getChain(sym)
        )
        return expiry
          ? { ...full, contracts: full.contracts.filter(c => c.expiry === expiry) }
          : full
      } catch (e) {
        console.warn('[MarketDataService] CBOE option chain failed, falling back to Nasdaq:', e)
        optionPrimaryDownUntil = Date.now() + OPTION_PRIMARY_COOLDOWN
      }
    }
    const chain = await cached(`optchain:nasdaq:${sym}:${expiry ?? '*'}`, OPTION_TTL, () =>
      this.optFallback.getChain(sym, expiry)
    )
    return { ...chain, degraded: true }
  }

  /**
   * 期权持仓快照 = 标的四块快照 + 期权块。期权报价取不到（链降级失败、合约
   * 已到期下架）时仍返回期权块：条款与内在价值照算，报价字段留空并标 degraded。
   * premiumBasis = 持仓权利金，用于盈亏平衡价；省略时以 mark 暂代。
   */
  async buildOptionSnapshot(
    contract: {
      underlying: string
      contractSymbol: string
      optionType: OptionType
      strike: number
      expiry: string
    },
    premiumBasis?: number
  ): Promise<StockSnapshot> {
    const [snapResult, chainResult] = await Promise.allSettled([
      this.buildSnapshot(contract.underlying, 'US'),
      this.getOptionChain(contract.underlying, contract.expiry),
    ])
    if (snapResult.status === 'rejected') throw snapResult.reason
    const snap = snapResult.value
    const chain = chainResult.status === 'fulfilled' ? chainResult.value : null
    const quote = chain?.contracts.find(c => c.contractSymbol === contract.contractSymbol) ?? null
    const underlyingPrice = snap.market.price > 0 ? snap.market.price : chain?.underlyingPrice ?? 0

    let dataSource: string
    if (!chain) dataSource = '期权行情不可用'
    else if (!quote) dataSource = `${chain.source}（未找到该合约报价）`
    else dataSource = chain.hasGreeks ? chain.source : `${chain.source}（降级·无希腊值）`

    return {
      ...snap,
      option: computeOptionBlock({
        ...contract,
        quote,
        underlyingPrice,
        underlyingIv30: chain?.underlyingIv30,
        premiumBasis,
        dataSource,
        dataTime: chain?.dataTime ?? new Date().toISOString(),
        degraded: !quote || !chain?.hasGreeks || chain?.degraded,
      }),
    }
  }

  /**
   * 获取 250 日 K 线（与 buildSnapshot 共用同一缓存键：刷新管道内先
   * buildSnapshot 再 getCandles 不会产生第二次网络请求）。买回计划的
   * 区间最低价判定用它。
   */
  async getCandles(symbol: string, market: Market): Promise<Candle[]> {
    try {
      const { value } = await this.withFallback(market, src =>
        cached(`candles:${symbol}`, FINANCIAL_TTL, () => src.getCandles(symbol, 250))
      )
      return value
    } catch {
      return []
    }
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
