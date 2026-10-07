import { NextRequest, NextResponse } from 'next/server'
import { MarketDataService } from '@/lib/market-data'
import { Market } from '@/lib/types'
import { parseOccSymbol } from '@/lib/options'

const marketDataService = new MarketDataService()

// GET /api/snapshot?symbol=SH600519&market=CN
// GET /api/snapshot?symbol=NVDA&market=US&contract=NVDA261120C00240000[&premium=10.88]
//   → underlying snapshot + option block (options, v0.4)
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')
  const market = req.nextUrl.searchParams.get('market') as Market
  const contract = req.nextUrl.searchParams.get('contract')
  const premium = parseFloat(req.nextUrl.searchParams.get('premium') ?? '')

  if (!symbol || !market) {
    return NextResponse.json({ error: 'symbol and market required' }, { status: 400 })
  }

  try {
    if (contract) {
      const terms = parseOccSymbol(contract)
      if (!terms || terms.underlying !== symbol.toUpperCase()) {
        return NextResponse.json({ error: 'Invalid contract' }, { status: 400 })
      }
      const snapshot = await marketDataService.buildOptionSnapshot(
        { ...terms, contractSymbol: contract.toUpperCase() },
        premium > 0 ? premium : undefined
      )
      return NextResponse.json(snapshot)
    }
    const snapshot = await marketDataService.buildSnapshot(symbol, market)
    return NextResponse.json(snapshot)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
