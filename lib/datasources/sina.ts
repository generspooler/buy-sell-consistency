/**
 * Sina Finance adapter — A股 fallback data source.
 *
 * hq.sinajs.cn requires a Referer header and returns GBK-encoded text.
 */
import { IMarketDataSource } from './types'
import { MarketSnapshot, ValuationSnapshot, Market } from '../types'
import { Candle } from '../indicators'

const TIMEOUT_MS = 8000

async function fetchSina(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        Referer: 'https://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    return new TextDecoder('gbk').decode(buf)
  } finally {
    clearTimeout(timer)
  }
}

/** Convert SH600519 → sh600519 */
function toSinaSymbol(symbol: string): string {
  return symbol.toLowerCase()
}

export class SinaAdapter implements IMarketDataSource {
  async getQuote(symbol: string): Promise<MarketSnapshot> {
    const sym = toSinaSymbol(symbol)
    const url = `https://hq.sinajs.cn/list=${sym}`
    const text = await fetchSina(url)
    // Response: var hq_str_sh600519="贵州茅台,昨收,今开,现价,最高,最低,...,日期,时间";
    const match = text.match(/"([^"]+)"/)
    if (!match) throw new Error('Sina: no data')
    const parts = match[1].split(',')
    const prevClose = parseFloat(parts[2])
    const price = parseFloat(parts[3])
    return {
      price,
      change: price - prevClose,
      changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      volume: parseFloat(parts[8]),
      high52w: parseFloat(parts[33]) || undefined, // ?52w fields vary; leave if NaN
      low52w: parseFloat(parts[34]) || undefined,
      timestamp: `${parts[30]} ${parts[31]}`,
    }
  }

  async getFinancials(_symbol: string): Promise<ValuationSnapshot> {
    // Sina doesn't expose a reliable keyless financials endpoint; return empty
    return {}
  }

  async getCandles(symbol: string, days = 250): Promise<Candle[]> {
    const sym = toSinaSymbol(symbol)
    const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${days}`
    try {
      const text = await fetchSina(url)
      const data = JSON.parse(text) as Array<Record<string, string>>
      return data.map(item => ({
        date: item.day,
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close: parseFloat(item.close),
        volume: parseFloat(item.volume),
      }))
    } catch {
      return []
    }
  }

  async getNews(_symbol: string, _days = 30): Promise<string[]> {
    return []
  }

  async getIndexTrend(market: Market): Promise<string> {
    if (market !== 'CN') return ''
    try {
      const text = await fetchSina('https://hq.sinajs.cn/list=sh000001')
      const match = text.match(/"([^"]+)"/)
      if (!match) return '指数数据不可用'
      const parts = match[1].split(',')
      const prevClose = parseFloat(parts[2])
      const price = parseFloat(parts[3])
      const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0
      return `上证指数当日${changePct >= 0 ? '涨' : '跌'} ${Math.abs(changePct).toFixed(2)}%`
    } catch {
      return '指数数据不可用'
    }
  }

  async searchStocks(_query: string): Promise<Array<{ symbol: string; name: string }>> {
    return []
  }
}
