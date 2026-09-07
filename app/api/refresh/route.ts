import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MarketDataService } from '@/lib/market-data'
import { analyzePosition } from '@/lib/llm-analyzer'
import { Market, StockSnapshot, ThesisPoint } from '@/lib/types'

const marketDataService = new MarketDataService()

// POST /api/refresh — refresh one or all positions
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { positionId } = body as { positionId?: number }

  const where = positionId
    ? { id: positionId, status: 'OPEN' }
    : { status: 'OPEN' }

  const positions = await prisma.position.findMany({
    where,
    include: {
      stock: true,
      buyRecords: { orderBy: { boughtAt: 'asc' }, take: 1 },
      refreshLogs: { orderBy: { refreshedAt: 'desc' }, take: 1 },
    },
  })

  if (positions.length === 0) {
    return NextResponse.json({ results: [] })
  }

  const results = await Promise.all(
    positions.map(async (pos) => {
      try {
        if (pos.buyRecords.length === 0) {
          return { positionId: pos.id, status: 'skipped', reason: 'No buy records' }
        }

        const firstBuy = pos.buyRecords[0]
        const buySnapshot: StockSnapshot = JSON.parse(firstBuy.snapshotJson || '{}')
        const thesisPoints: ThesisPoint[] = JSON.parse(firstBuy.thesisPointsJson || '[]')

        // Fetch latest snapshot
        const currentSnapshot = await marketDataService.buildSnapshot(
          pos.stock.symbol,
          pos.stock.market as Market
        )

        // Previous refresh snapshot for comparison
        let lastSnapshot: StockSnapshot | undefined
        if (pos.refreshLogs[0]?.snapshotJson) {
          try {
            lastSnapshot = JSON.parse(pos.refreshLogs[0].snapshotJson)
          } catch {}
        }

        // Run LLM analysis
        const analysis = await analyzePosition(
          pos.stock.name,
          pos.stock.market as Market,
          firstBuy.thesis,
          thesisPoints,
          buySnapshot,
          currentSnapshot,
          lastSnapshot
        )

        // Persist refresh log
        await prisma.refreshLog.create({
          data: {
            positionId: pos.id,
            snapshotJson: JSON.stringify(currentSnapshot),
            analysisJson: JSON.stringify(analysis),
            verdict: analysis.verdict,
          },
        })

        return {
          positionId: pos.id,
          symbol: pos.stock.symbol,
          name: pos.stock.name,
          status: 'ok',
          verdict: analysis.verdict,
          actionSuggestion: analysis.actionSuggestion,
        }
      } catch (e) {
        console.error(`Refresh failed for position ${pos.id}:`, e)
        return {
          positionId: pos.id,
          symbol: pos.stock.symbol,
          name: pos.stock.name,
          status: 'error',
          error: (e as Error).message,
        }
      }
    })
  )

  return NextResponse.json({ results })
}
