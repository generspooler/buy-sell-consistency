import { NextRequest, NextResponse } from 'next/server'
import { MarketDataService } from '@/lib/market-data'
import { Market } from '@/lib/types'

const marketDataService = new MarketDataService()

// GET /api/snapshot?symbol=SH600519&market=CN
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')
  const market = req.nextUrl.searchParams.get('market') as Market

  if (!symbol || !market) {
    return NextResponse.json({ error: 'symbol and market required' }, { status: 400 })
  }

  try {
    const snapshot = await marketDataService.buildSnapshot(symbol, market)
    return NextResponse.json(snapshot)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
