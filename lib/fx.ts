/**
 * FX rate service — USD/CNY for cross-market PnL aggregation.
 * Source: Tencent whUSDCNY (quote already a plain decimal, no scaling).
 * Cached for 1 hour; falls back to a sane constant when unreachable.
 */
import { fetchGBK } from './datasources/tencent-us'

const FALLBACK_USDCNY = 7.0
const TTL_MS = 60 * 60 * 1000

let cached: { rate: number; at: number } | null = null

export async function getUsdCny(): Promise<{ rate: number; source: 'live' | 'fallback' }> {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { rate: cached.rate, source: 'live' }
  }
  try {
    const text = await fetchGBK('https://qt.gtimg.cn/q=whUSDCNY')
    const match = text.match(/="([^"]+)"/)
    const fields = match?.[1]?.split('~') ?? []
    const rate = parseFloat(fields[3])
    if (Number.isFinite(rate) && rate > 0 && rate < 20) {
      cached = { rate, at: Date.now() }
      return { rate, source: 'live' }
    }
    throw new Error(`bad rate: ${fields[3]}`)
  } catch {
    return { rate: FALLBACK_USDCNY, source: 'fallback' }
  }
}
