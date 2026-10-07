/**
 * CBOE delayed quotes adapter — US option chains (primary).
 *
 * One request returns the FULL chain of an underlying (every expiry, ~2MB,
 * ~10s from mainland networks) with IV and greeks; quotes are 15 min delayed.
 * cdn.cboe.com 307-redirects to cdn-api.cboe.com — we call the latter directly
 * (the redirect hop alone timed out in testing).
 *
 * Payload: { timestamp: "YYYY-MM-DD HH:mm:ss" (UTC), data: { current_price,
 *   iv30, options: [{ option: OCC, bid, ask, last_trade_price, volume,
 *   open_interest, iv, delta, gamma, theta, vega, ... }] } }
 */
import { IOptionDataSource, OptionChain, OptionQuote } from './types'
import { parseOccSymbol } from '../options'

const TIMEOUT_MS = 25000

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : undefined
}

/** CBOE 对无成交/无报价的字段给 0——IV 为 0 没有意义，视为缺失。 */
function positive(v: unknown): number | undefined {
  const n = num(v)
  return n != null && n > 0 ? n : undefined
}

export class CboeOptionsAdapter implements IOptionDataSource {
  async getChain(underlying: string, expiry?: string): Promise<OptionChain> {
    const sym = underlying.toUpperCase()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any
    try {
      const res = await fetch(
        `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`,
        { signal: ctrl.signal, cache: 'no-store', headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      payload = await res.json()
    } finally {
      clearTimeout(timer)
    }

    const d = payload?.data
    if (!Array.isArray(d?.options) || d.options.length === 0) {
      throw new Error(`CBOE: no option chain for ${sym}`)
    }

    const contracts: OptionQuote[] = []
    for (const o of d.options) {
      const meta = typeof o?.option === 'string' ? parseOccSymbol(o.option) : null
      if (!meta) continue
      if (expiry && meta.expiry !== expiry) continue
      contracts.push({
        contractSymbol: o.option,
        optionType: meta.optionType,
        strike: meta.strike,
        expiry: meta.expiry,
        bid: num(o.bid),
        ask: num(o.ask),
        last: positive(o.last_trade_price),
        volume: num(o.volume),
        openInterest: num(o.open_interest),
        iv: positive(o.iv),
        delta: num(o.delta),
        gamma: num(o.gamma),
        theta: num(o.theta),
        vega: num(o.vega),
      })
    }

    const ts = typeof payload.timestamp === 'string' ? payload.timestamp : ''
    const dataTime = ts ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date()
    return {
      underlying: sym,
      underlyingPrice: positive(d.current_price),
      underlyingIv30: positive(d.iv30),
      dataTime: Number.isNaN(dataTime.getTime()) ? new Date().toISOString() : dataTime.toISOString(),
      source: 'CBOE',
      hasGreeks: true,
      contracts,
    }
  }
}
