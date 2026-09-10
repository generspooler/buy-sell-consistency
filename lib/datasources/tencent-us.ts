/**
 * Tencent Finance adapter — US stocks (replaces region-blocked Yahoo Finance).
 *
 * Symbol quirks:
 *   quote (qt.gtimg.cn/q=...)        wants "usAAPL"    — no exchange suffix
 *   kline (web.ifzq.gtimg.cn/...)     wants "usAAPL.OQ" — exchange suffix required
 * The suffix is resolved via smartbox.gtimg.cn search (cached per process).
 *
 * qt.gtimg.cn quote fields (~-separated, GBK):
 *   [3] price [4] prevClose [5] open [6] volume [30] time
 *   [39] PE(TTM) [44] mktcap(亿) [47] EPS(TTM) [48] 52w high [49] 52w low
 */
import { IMarketDataSource } from './types'
import { MarketSnapshot, ValuationSnapshot, Market } from '../types'
import { Candle } from '../indicators'

const TIMEOUT_MS = 8000

export async function fetchGBK(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    return new TextDecoder('gbk').decode(buf)
  } finally {
    clearTimeout(timer)
  }
}

/** AAPL → usAAPL (quote endpoint: no exchange suffix) */
function toQuoteSymbol(symbol: string): string {
  const upper = symbol.toUpperCase()
  return upper.startsWith('US') ? upper : `us${upper}`
}

/** Unescape \uXXXX sequences smartbox uses for non-ASCII names */
export function unescapeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

/** Decode XML entities in RSS/Atom titles */
function decodeXML(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** symbol → suffixed tencent code like "usAAPL.OQ"; via smartbox, cached */const suffixCache = new Map<string, string>()
async function toKlineSymbol(symbol: string): Promise<string> {
  const upper = symbol.toUpperCase()
  const cached = suffixCache.get(upper)
  if (cached) return cached
  const text = await fetchGBK(
    `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(upper)}&t=all`
  )
  const match = text.match(/="([^"]+)"/)
  const segs = match?.[1]?.split('~') ?? []
  const code = segs[0]?.replace('^', '') === 'us' ? segs[1] : undefined
  if (!code) throw new Error(`Cannot resolve tencent suffix for ${upper}`)
  const full = `us${code.toUpperCase()}`
  suffixCache.set(upper, full)
  return full
}

export class TencentUSAdapter implements IMarketDataSource {
  async getQuote(symbol: string): Promise<MarketSnapshot> {
    const sym = toQuoteSymbol(symbol)
    const text = await fetchGBK(`https://qt.gtimg.cn/q=${sym}`)
    const match = text.match(/="([^"]+)"/)
    if (!match) throw new Error(`Tencent: no data for ${sym}`)
    const f = match[1].split('~')
    const price = parseFloat(f[3])
    const prevClose = parseFloat(f[4])
    return {
      price,
      change: price - prevClose,
      changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      volume: parseFloat(f[6]),
      high52w: parseFloat(f[48]) || undefined,
      low52w: parseFloat(f[49]) || undefined,
      marketCap: f[44] ? parseFloat(f[44]) * 1e8 : undefined,
      timestamp: new Date().toISOString(),
    }
  }

  async getFinancials(symbol: string): Promise<ValuationSnapshot> {
    try {
      const sym = toQuoteSymbol(symbol)
      const text = await fetchGBK(`https://qt.gtimg.cn/q=${sym}`)
      const match = text.match(/="([^"]+)"/)
      if (!match) return {}
      const f = match[1].split('~')
      return {
        peTTM: parseFloat(f[39]) || undefined,
        eps: parseFloat(f[47]) || undefined,
        marketCap: f[44] ? parseFloat(f[44]) * 1e8 : undefined,
      }
    } catch {
      return {}
    }
  }

  async getCandles(symbol: string, days = 250): Promise<Candle[]> {
    const sym = await toKlineSymbol(symbol)
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
      `?param=${encodeURIComponent(`${sym},day,,,${days},qfq`)}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any
      const node = data?.data?.[sym]
      const rows: string[][] = node?.day ?? node?.qfqday ?? []
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

  async getNews(symbol: string, days = 30): Promise<string[]> {
    // English sources, both reachable from mainland networks:
    //  1. Google News RSS  — market/analyst coverage
    //  2. SEC EDGAR atom   — company filings (8-K/10-Q/insider Form 4)
    const [marketNews, filings] = await Promise.all([
      this.fetchGoogleNews(symbol, days),
      this.fetchSECFilings(symbol, days),
    ])
    return [...marketNews, ...filings].slice(0, 15)
  }

  private async fetchGoogleNews(symbol: string, days: number): Promise<string[]> {
    try {
      const url =
        `https://news.google.com/rss/search?q=${encodeURIComponent(symbol)}+stock+when:${days}d` +
        `&hl=en-US&gl=US&ceid=US:en`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      let xml: string
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          cache: 'no-store',
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        xml = await res.text()
      } finally {
        clearTimeout(timer)
      }
      const cutoff = Date.now() - days * 86400_000
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
        .map(m => {
          const title = decodeXML(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
          const pubDate = m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ''
          return { title, ts: new Date(pubDate).getTime() }
        })
        .filter(it => it.title && it.ts > cutoff)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 10)
        .map(it => `${new Date(it.ts).toISOString().slice(0, 10)} ${it.title}`)
    } catch {
      return []
    }
  }

  private async fetchSECFilings(symbol: string, days: number): Promise<string[]> {
    try {
      const url =
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}` +
        `&type=&dateb=&owner=include&count=10&output=atom`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      let xml: string
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          cache: 'no-store',
          // SEC requires a declared User-Agent
          headers: { 'User-Agent': 'BuySellConsistencyTracker/1.0 (personal research tool)' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        xml = await res.text()
      } finally {
        clearTimeout(timer)
      }
      const cutoff = Date.now() - days * 86400_000
      return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
        .map(m => {
          const title = decodeXML(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim()
          const updated = m[1].match(/<updated>([\s\S]*?)<\/updated>/)?.[1] ?? ''
          return { title, ts: new Date(updated).getTime() }
        })
        .filter(it => it.title && it.ts > cutoff)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5)
        .map(it => `${new Date(it.ts).toISOString().slice(0, 10)} SEC filing: ${it.title}`)
    } catch {
      return []
    }
  }

  async getIndexTrend(market: Market): Promise<string> {
    if (market !== 'US') return ''
    try {
      const text = await fetchGBK('https://qt.gtimg.cn/q=usDJI,usIXIC')
      const parts = text.split(';').filter(Boolean)
      const parse = (chunk: string) => {
        const m = chunk.match(/="([^"]+)"/)
        if (!m) return null
        const f = m[1].split('~')
        const name = f[1]
        const pct = parseFloat(f[32])
        if (!name || Number.isNaN(pct)) return null
        return `${name}当日${pct >= 0 ? '涨' : '跌'} ${Math.abs(pct).toFixed(2)}%`
      }
      const dji = parse(parts[0] ?? '')
      const ixic = parse(parts[1] ?? '')
      return [dji, ixic].filter(Boolean).join('，') + '（快照数据）'
    } catch {
      return '指数数据不可用'
    }
  }

  async searchStocks(query: string): Promise<Array<{ symbol: string; name: string }>> {
    const q = query.trim()
    if (!q) return []
    const isCN = /^(sh|sz)?\d{6}$/i.test(q) || /[一-鿿]/.test(q)
    if (isCN) return [] // CN search handled by Eastmoney adapter
    try {
      const text = await fetchGBK(
        `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`
      )
      const match = text.match(/="([^"]+)"/)
      if (!match) return []
      const results: Array<{ symbol: string; name: string }> = []
      const seen = new Set<string>()
      // groups of 5: [market, code, name, pinyin, type] — market "us" or "^us"
      const segs = match[1].split('~')
      for (let i = 0; i + 2 < segs.length; i += 5) {
        const mkt = segs[i]
        const code = segs[i + 1]
        const name = segs[i + 2]
        if (!mkt?.replace('^', '').startsWith('us')) continue
        if (!code || !name || name === '*') continue
        // code like aapl.oq → bare symbol AAPL
        const bare = code.split('.')[0].toUpperCase()
        if (seen.has(bare)) continue
        seen.add(bare)
        // remember suffix mapping for later kline calls
        suffixCache.set(bare, `us${code.toUpperCase()}`)
        results.push({ symbol: bare, name: unescapeUnicode(name) })
        if (results.length >= 8) break
      }
      return results
    } catch {
      return []
    }
  }
}
