/**
 * Nasdaq adapter — US option chains (fallback when CBOE fails).
 *
 * api.nasdaq.com/api/quote/{SYM}/option-chain returns one row per strike with
 * call (c_*) and put (p_*) side by side; values are display strings ("--" for
 * none, "34,491" with thousands separators). No IV and no greeks — snapshots
 * built from this source are flagged degraded.
 *
 * The OCC code is parsed from drillDownURL (".../nvda--261120c00240000",
 * call side); the put shares the row with C→P.
 */
import { IOptionDataSource, OptionChain, OptionQuote } from './types'
import { etDate, parseOccSymbol } from '../options'

const TIMEOUT_MS = 15000

function num(v: unknown): number | undefined {
  if (v == null) return undefined
  const s = String(v).replace(/[,$]/g, '').trim()
  if (!s || s === '--') return undefined
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : undefined
}

export class NasdaqOptionsAdapter implements IOptionDataSource {
  async getChain(underlying: string, expiry?: string): Promise<OptionChain> {
    const sym = underlying.toUpperCase()
    const from = expiry ?? etDate()
    const to = expiry ?? '2099-12-31'
    const url =
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/option-chain` +
      `?assetclass=stocks&fromdate=${from}&todate=${to}&money=all&limit=10000`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      payload = await res.json()
    } finally {
      clearTimeout(timer)
    }

    const rows = payload?.data?.table?.rows
    if (!Array.isArray(rows)) throw new Error(`Nasdaq: no option chain for ${sym}`)

    const contracts: OptionQuote[] = []
    for (const r of rows) {
      const code = String(r?.drillDownURL ?? '').match(/--(\d{6})c(\d{8})$/i)
      if (!code) continue
      for (const [cp, prefix] of [['C', 'c_'], ['P', 'p_']] as const) {
        const meta = parseOccSymbol(`${sym}${code[1]}${cp}${code[2]}`)
        if (!meta) continue
        const bid = num(r[`${prefix}Bid`])
        const ask = num(r[`${prefix}Ask`])
        const last = num(r[`${prefix}Last`])
        if (bid == null && ask == null && last == null) continue
        contracts.push({
          contractSymbol: `${sym}${code[1]}${cp}${code[2]}`,
          optionType: meta.optionType,
          strike: meta.strike,
          expiry: meta.expiry,
          bid,
          ask,
          last,
          volume: num(r[`${prefix}Volume`]),
          openInterest: num(r[`${prefix}Openinterest`]),
        })
      }
    }

    // "LAST TRADE: $237.82 (AS OF OCT 7, 2026 10:26 AM ET)"
    const lastTrade = String(payload?.data?.lastTrade ?? '')
    const price = num(lastTrade.match(/\$([\d.,]+)/)?.[1])
    return {
      underlying: sym,
      underlyingPrice: price,
      dataTime: new Date().toISOString(),
      source: 'Nasdaq',
      hasGreeks: false,
      contracts,
    }
  }
}
