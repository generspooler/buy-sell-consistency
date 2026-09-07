import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MarketDataService } from '@/lib/market-data'
import { getUsdCny } from '@/lib/fx'
import { Market } from '@/lib/types'

const marketDataService = new MarketDataService()

// GET /api/positions — list all open positions with latest price
export async function GET() {
  const positions = await prisma.position.findMany({
    where: { status: 'OPEN' },
    include: {
      stock: true,
      buyRecords: { orderBy: { boughtAt: 'asc' } },
      refreshLogs: { orderBy: { refreshedAt: 'desc' }, take: 1 },
    },
    orderBy: { openedAt: 'desc' },
  })

  const results = await Promise.all(
    positions.map(async (pos) => {
      let currentPrice: number | undefined
      let changePct: number | undefined
      let degraded = false
      try {
        const snap = await marketDataService.buildSnapshot(
          pos.stock.symbol,
          pos.stock.market as Market
        )
        currentPrice = snap.market.price
        changePct = snap.market.changePct
        degraded = snap.context.degraded ?? false
      } catch {
        // Non-fatal: show position without live price
      }

      const lastRefresh = pos.refreshLogs[0]
      let lastVerdict: string | undefined
      let lastActionSuggestion: string | undefined
      if (lastRefresh?.analysisJson) {
        try {
          const analysis = JSON.parse(lastRefresh.analysisJson)
          lastVerdict = lastRefresh.verdict
          lastActionSuggestion = analysis.actionSuggestion
        } catch {}
      }

      const unrealizedPnl =
        currentPrice != null
          ? (currentPrice - pos.avgCost) * pos.totalShares
          : undefined
      const unrealizedPnlPct =
        currentPrice != null && pos.avgCost > 0
          ? ((currentPrice - pos.avgCost) / pos.avgCost) * 100
          : undefined

      return {
        id: pos.id,
        symbol: pos.stock.symbol,
        name: pos.stock.name,
        market: pos.stock.market,
        status: pos.status,
        totalShares: pos.totalShares,
        avgCost: pos.avgCost,
        totalCost: pos.totalCost,
        currentPrice,
        changePct,
        unrealizedPnl,
        unrealizedPnlPct,
        lastVerdict,
        lastRefreshedAt: lastRefresh?.refreshedAt,
        lastActionSuggestion,
        openedAt: pos.openedAt,
        degraded,
      }
    })
  )

  // Sort: BROKEN → WEAKEN → SUPPORT → (no verdict)
  const verdictOrder = { BROKEN: 0, WEAKEN: 1, SUPPORT: 2 }
  results.sort((a, b) => {
    const va = verdictOrder[a.lastVerdict as keyof typeof verdictOrder] ?? 3
    const vb = verdictOrder[b.lastVerdict as keyof typeof verdictOrder] ?? 3
    return va - vb
  })

  // Cross-market PnL aggregation (CNY): A股 positions are native CNY,
  // US positions convert at the live USD/CNY rate.
  const { rate: usdCny, source: fxSource } = await getUsdCny()
  const byMarket = (market: string) =>
    results.filter(r => r.market === market && r.unrealizedPnl != null)
  const sum = (market: string) =>
    byMarket(market).reduce((s, r) => s + (r.unrealizedPnl ?? 0), 0)
  const pnlCN = sum('CN')
  const pnlUS = sum('US')
  const pnlTotalCNY = pnlCN + pnlUS * usdCny

  return NextResponse.json({
    positions: results,
    pnlSummary: {
      usdCny,
      fxSource,
      pnlCNY: pnlCN,
      pnlUSD: pnlUS,
      pnlTotalCNY,
    },
  })
}
