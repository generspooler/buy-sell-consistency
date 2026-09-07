import { NextRequest, NextResponse } from 'next/server'
import { MarketDataService } from '@/lib/market-data'
import { Market } from '@/lib/types'

const marketDataService = new MarketDataService()

// GET /api/search?q=...&market=CN|US
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  const market = req.nextUrl.searchParams.get('market') as Market | undefined

  if (!q || q.length < 1) {
    return NextResponse.json([])
  }

  try {
    const results = await marketDataService.searchStocks(q, market)
    return NextResponse.json(results)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
