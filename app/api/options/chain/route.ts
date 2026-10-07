import { NextRequest, NextResponse } from 'next/server'
import { MarketDataService } from '@/lib/market-data'
import type { OptionQuote } from '@/lib/datasources/types'
import { daysToExpiry, isExpired, markPrice } from '@/lib/options'

const marketDataService = new MarketDataService()

/** 选合约用的精简报价——不把 ~2MB 原始链透传给前端。 */
function compact(q: OptionQuote | undefined) {
  if (!q) return undefined
  return {
    contractSymbol: q.contractSymbol,
    bid: q.bid,
    ask: q.ask,
    mark: markPrice(q),
    last: q.last,
    iv: q.iv,
    delta: q.delta,
    openInterest: q.openInterest,
    volume: q.volume,
  }
}

// GET /api/options/chain?underlying=NVDA[&expiry=2026-11-20]
// → expiries (unexpired, ascending) + the strike table for `expiry` if given.
// The full chain is cached per underlying, so the follow-up request for a
// chosen expiry is served from memory.
export async function GET(req: NextRequest) {
  const underlying = req.nextUrl.searchParams.get('underlying')?.toUpperCase()
  const expiry = req.nextUrl.searchParams.get('expiry') ?? undefined
  if (!underlying) {
    return NextResponse.json({ error: 'underlying required' }, { status: 400 })
  }

  try {
    const chain = await marketDataService.getOptionChain(underlying)
    const expiries = [...new Set(chain.contracts.map(c => c.expiry))]
      .filter(e => !isExpired(e))
      .sort()
      .map(date => ({ date, dte: daysToExpiry(date) }))

    let strikes: Array<{
      strike: number
      call?: ReturnType<typeof compact>
      put?: ReturnType<typeof compact>
    }> = []
    if (expiry) {
      const byStrike = new Map<number, { call?: OptionQuote; put?: OptionQuote }>()
      for (const c of chain.contracts) {
        if (c.expiry !== expiry) continue
        const row = byStrike.get(c.strike) ?? {}
        if (c.optionType === 'CALL') row.call = c
        else row.put = c
        byStrike.set(c.strike, row)
      }
      strikes = [...byStrike.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([strike, row]) => ({ strike, call: compact(row.call), put: compact(row.put) }))
    }

    return NextResponse.json({
      underlying,
      underlyingPrice: chain.underlyingPrice,
      underlyingIv30: chain.underlyingIv30,
      dataTime: chain.dataTime,
      source: chain.source,
      hasGreeks: chain.hasGreeks,
      degraded: chain.degraded ?? false,
      expiries,
      expiry: expiry ?? null,
      strikes,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 })
  }
}
