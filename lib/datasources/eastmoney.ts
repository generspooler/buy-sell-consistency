/**
 * EastMoney (东方财富) adapter — A股 primary data source.
 * Uses public HTTP APIs; no auth key required.
 *
 * Note: push2.eastmoney.com is unreachable from some networks (server-side
 * connection reset). push2delay.eastmoney.com serves the same fields on a
 * ~15-minute delay and is reliable — fine for thesis re-validation use cases.
 * K-line history (push2his) is real-time and unaffected.
 */
import { IMarketDataSource } from './types'
import { MarketSnapshot, ValuationSnapshot, Market } from '../types'
import { Candle } from '../indicators'

const TIMEOUT_MS = 8000

async function fetchEM(url: string, referer?: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: referer ? { Referer: referer } : undefined,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    // EastMoney wraps some endpoints: cb({...})
    const match = text.match(/^\w+\(([\s\S]+)\)$/)
    return JSON.parse(match ? match[1] : text)
  } finally {
    clearTimeout(timer)
  }
}

/** Convert SH600519 / SZ000001 to EastMoney secid like "1.600519" / "0.000001" */
function toSecid(symbol: string): string {
  const upper = symbol.toUpperCase()
  if (upper.startsWith('SH')) return `1.${upper.slice(2)}`
  if (upper.startsWith('SZ')) return `0.${upper.slice(2)}`
  const code = upper.replace(/^[A-Z]+/, '')
  const market = ['6', '9'].includes(code[0]) ? '1' : '0'
  return `${market}.${code}`
}

async function getQuoteFields(
  secid: string,
  fields: string
): Promise<Record<string, number | string>> {
  const url =
    `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${secid}` +
    `&fields=${fields}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await fetchEM(url)) as any
  return (data?.data ?? {}) as Record<string, number | string>
}

/** Scale a raw EastMoney price field by its precision (f59: 2 → ÷100, 3 → ÷1000) */
function scalePrice(raw: number | string | undefined, precision: number | string | undefined, fallback = 2): number {
  const p = Number(precision ?? fallback) || fallback
  return Number(raw) / 10 ** p
}

export class EastmoneyAdapter implements IMarketDataSource {
  async getQuote(symbol: string): Promise<MarketSnapshot> {
    const secid = toSecid(symbol)
    // f43 price, f59 price precision (2=股票, 3=ETF/基金), f169 change, f170 changePct,
    // f47 volume, f168 turnover rate, f116 total mkt cap, f174/f175 52w high/low
    const d = await getQuoteFields(
      secid,
      'f43,f59,f47,f168,f116,f52,f45,f169,f170,f174,f175'
    )
    const p = Number(d.f59 ?? 2) || 2
    return {
      price: scalePrice(d.f43, p),
      change: scalePrice(d.f169, p),
      changePct: Number(d.f170) / 100,
      volume: Number(d.f47),
      turnoverRate: d.f168 != null ? Number(d.f168) / 100 : undefined,
      high52w: d.f174 != null ? scalePrice(d.f174, p) : undefined,
      low52w: d.f175 != null ? scalePrice(d.f175, p) : undefined,
      marketCap: d.f116 != null ? Number(d.f116) : undefined,
      timestamp: new Date().toISOString(),
    }
  }

  async getFinancials(symbol: string): Promise<ValuationSnapshot> {
    const secid = toSecid(symbol)
    // f162 PE(TTM), f167 PB, f105 ROE(加权, percent×1e9),
    // f183 净利润同比(percent×1e9), f186 毛利率%, f187 净利率%
    const d = await getQuoteFields(secid, 'f116,f162,f167,f105,f183,f186,f187')
    return {
      peTTM: d.f162 != null ? Number(d.f162) / 100 : undefined,
      pb: d.f167 != null ? Number(d.f167) / 100 : undefined,
      roe: d.f105 != null ? Number(d.f105) / 1e9 : undefined,
      netProfitGrowthYoY: d.f183 != null ? Number(d.f183) / 1e9 : undefined,
      grossMargin: d.f186 != null ? Number(d.f186) : undefined,
      netMargin: d.f187 != null ? Number(d.f187) : undefined,
      marketCap: d.f116 != null ? Number(d.f116) : undefined,
    }
  }

  async getCandles(symbol: string, days = 250): Promise<Candle[]> {
    const secid = toSecid(symbol)
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
      `&klt=101&fqt=1&lmt=${days}&end=20500101&fields1=f1,f2,f3,f4,f5,f6` +
      `&fields2=f51,f52,f53,f54,f55,f56`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await fetchEM(url)) as any
    const klines: string[] = data?.data?.klines ?? []
    return klines.map(line => {
      const [date, open, close, high, low, volume] = line.split(',')
      return {
        date,
        open: Number(open),
        close: Number(close),
        high: Number(high),
        low: Number(low),
        volume: Number(volume),
      }
    })
  }

  async getNews(symbol: string, days = 30): Promise<string[]> {
    const code = symbol.toUpperCase().replace(/^(SH|SZ)/, '')
    const param = JSON.stringify({
      uid: '',
      keyword: code,
      type: ['cmsArticleWebOld'],
      client: 'web',
      clientType: 'web',
      clientVersion: 'curr',
      param: {
        cmsArticleWebOld: {
          searchScope: 'default',
          sort: 'time',
          pageIndex: 1,
          pageSize: 20,
          preTag: '',
          postTag: '',
        },
      },
    })
    const url =
      `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=` +
      encodeURIComponent(param)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await fetchEM(url, 'https://so.eastmoney.com/')) as any
      const arts: Array<{ date: string; title: string }> =
        data?.result?.cmsArticleWebOld ?? []
      const cutoff = Date.now() - days * 86400_000
      return arts
        .filter(a => new Date(a.date.replace(/-/g, '/')).getTime() > cutoff)
        .map(a => `${a.date.slice(0, 10)} ${a.title}`)
        .slice(0, 10)
    } catch {
      return []
    }
  }

  async getIndexTrend(market: Market): Promise<string> {
    if (market !== 'CN') return ''
    try {
      // 上证指数 1.000001 + 沪深300 1.000300, via delay host
      const d = await getQuoteFields('1.000001', 'f43,f170')
      const d2 = await getQuoteFields('1.000300', 'f43,f170')
      const shPct = Number(d.f170) / 100
      const hsPct = Number(d2.f170) / 100
      return `上证指数当日${shPct >= 0 ? '涨' : '跌'} ${Math.abs(shPct).toFixed(2)}%，沪深300当日${hsPct >= 0 ? '涨' : '跌'} ${Math.abs(hsPct).toFixed(2)}%（约15分钟延迟快照）`
    } catch {
      return '指数数据不可用'
    }
  }

  async searchStocks(query: string): Promise<Array<{ symbol: string; name: string }>> {
    const url =
      `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query)}` +
      `&type=14&count=10`
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await fetchEM(url)) as any
      const list: Array<Record<string, string>> =
        data?.QuotationCodeTable?.Data ?? []
      return list
        .filter(item => item.MktNum === '1' || item.MktNum === '0')
        .map(item => ({
          symbol: (item.MktNum === '1' ? 'SH' : 'SZ') + item.Code,
          name: item.Name,
        }))
    } catch {
      return []
    }
  }
}
