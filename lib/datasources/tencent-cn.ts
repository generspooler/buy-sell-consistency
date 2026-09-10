/**
 * Tencent Finance adapter — A股 (qt.gtimg.cn).
 *
 * Role: Plan-B enrichment source. Primary Eastmoney data is kept as-is;
 * fields Tencent exposes but the primary may miss (PB, 52w high/low,
 * turnover rate) are filled in from here.
 *
 * qt.gtimg.cn quote fields (~-separated, GBK), 0-indexed — verified live
 * 2026-09-10 against 600519/300750/600036 (PB 6.39 matches Eastmoney f167):
 *   [1] name [3] price [4] prevClose [30] time [31] change [32] changePct
 *   [33] high [34] low [36] volume(手) [37] amount(万) [38] turnoverRate%
 *   [39] PE(TTM) [44] circulating cap(亿) [45] total cap(亿) [46] PB
 *   [47] limit-up [48] limit-down [49] volumeRatio [51] avgPrice
 *   [52] PE(动) [53] PE(静) [67] 52w high [68] 52w low
 * NOTE: US symbols use a different layout ([46] is the English name there);
 * this adapter must only be fed CN symbols.
 */
import { fetchGBK, unescapeUnicode } from './tencent-us'
import { IMarketDataSource } from './types'
import { MarketSnapshot, ValuationSnapshot, Market } from '../types'
import { Candle } from '../indicators'

const TIMEOUT_MS = 8000

/** SH600519 / 600519 → sh600519 (SH prefix or 6/9-leading code → Shanghai) */
function toTencentCode(symbol: string): string {
  const upper = symbol.toUpperCase()
  if (upper.startsWith('SH') || upper.startsWith('SZ')) return upper.toLowerCase()
  const code = upper.replace(/^[A-Z]+/, '')
  return (['6', '9'].includes(code[0]) ? 'sh' : 'sz') + code
}

/** Parse one v_xxx="..." chunk from qt.gtimg.cn into ~-separated fields */
function parseQuoteChunk(chunk: string): string[] | null {
  const match = chunk.match(/="([^"]+)"/)
  return match ? match[1].split('~') : null
}

async function fetchQuoteFields(symbol: string): Promise<string[]> {
  const text = await fetchGBK(`https://qt.gtimg.cn/q=${toTencentCode(symbol)}`)
  const f = parseQuoteChunk(text.split(';')[0] ?? '')
  if (!f || f.length < 50) throw new Error(`TencentCN: no data for ${symbol}`)
  return f
}

export class TencentCNAdapter implements IMarketDataSource {
  async getQuote(symbol: string): Promise<MarketSnapshot> {
    const f = await fetchQuoteFields(symbol)
    const price = parseFloat(f[3])
    const prevClose = parseFloat(f[4])
    return {
      price,
      change: parseFloat(f[31]) || price - prevClose,
      changePct: parseFloat(f[32]) || 0,
      // f[36] is in 手 (lots); MarketSnapshot.volume is documented as shares
      volume: (parseFloat(f[36]) || 0) * 100,
      turnoverRate: parseFloat(f[38]) || undefined,
      high52w: parseFloat(f[67]) || undefined,
      low52w: parseFloat(f[68]) || undefined,
      marketCap: f[45] ? parseFloat(f[45]) * 1e8 : undefined,
      timestamp: new Date().toISOString(),
    }
  }

  async getFinancials(symbol: string): Promise<ValuationSnapshot> {
    try {
      const f = await fetchQuoteFields(symbol)
      return {
        peTTM: parseFloat(f[39]) || undefined,
        pb: parseFloat(f[46]) || undefined,
        marketCap: f[45] ? parseFloat(f[45]) * 1e8 : undefined,
      }
    } catch {
      return {}
    }
  }

  async getCandles(symbol: string, days = 250): Promise<Candle[]> {
    const code = toTencentCode(symbol)
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
      `?param=${encodeURIComponent(`${code},day,,,${days},qfq`)}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any
      const node = data?.data?.[code]
      const rows: string[][] = node?.qfqday ?? node?.day ?? []
      return rows.map(row => ({
        date: row[0],
        open: parseFloat(row[1]),
        close: parseFloat(row[2]),
        high: parseFloat(row[3]),
        low: parseFloat(row[4]),
        volume: parseFloat(row[5]),
      }))
    } finally {
      clearTimeout(timer)
    }
  }

  // News stays with the Eastmoney adapter — no verified Tencent news endpoint.
  async getNews(_symbol: string, _days = 30): Promise<string[]> {
    return []
  }

  /** 上证 + 深证成指 + 沪深300 (one quote call; richer than the Eastmoney variant) */
  async getIndexTrend(market: Market): Promise<string> {
    if (market !== 'CN') return ''
    try {
      const text = await fetchGBK('https://qt.gtimg.cn/q=sh000001,sz399001,sh000300')
      const parts = text.split(';').filter(Boolean)
      const trend = parts
        .map(parseQuoteChunk)
        .map(f => {
          if (!f) return null
          const name = f[1]
          const pct = parseFloat(f[32])
          if (!name || Number.isNaN(pct)) return null
          return `${name}当日${pct >= 0 ? '涨' : '跌'} ${Math.abs(pct).toFixed(2)}%`
        })
        .filter(Boolean)
        .join('，')
      return trend || '指数数据不可用'
    } catch {
      return '指数数据不可用'
    }
  }

  /** smartbox search restricted to SH/SZ listings */
  async searchStocks(query: string): Promise<Array<{ symbol: string; name: string }>> {
    const q = query.trim()
    if (!q) return []
    try {
      const text = await fetchGBK(
        `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`
      )
      const match = text.match(/="([^"]+)"/)
      if (!match) return []
      const results: Array<{ symbol: string; name: string }> = []
      const segs = match[1].split('~')
      // groups of 5: [market, code, name, pinyin, type] — market "sh"/"sz"
      for (let i = 0; i + 2 < segs.length; i += 5) {
        const mkt = segs[i]?.toLowerCase()
        const code = segs[i + 1]
        const name = segs[i + 2]
        if (mkt !== 'sh' && mkt !== 'sz') continue
        if (!code || !name || name === '*') continue
        results.push({ symbol: mkt.toUpperCase() + code, name: unescapeUnicode(name) })
        if (results.length >= 8) break
      }
      return results
    } catch {
      return []
    }
  }
}
