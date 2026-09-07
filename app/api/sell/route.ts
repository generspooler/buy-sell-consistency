import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { scoreSellConsistency } from '@/lib/llm-analyzer'
import { AnalysisResult, ThesisPoint } from '@/lib/types'

// POST /api/sell — record a sell and compute consistency score
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      positionId,
      soldAt,
      shares,
      price,
      reason,
      note,
    } = body as {
      positionId: number
      soldAt: string
      shares: number
      price: number
      reason: string
      note?: string
    }

    if (!positionId || !soldAt || !shares || !price || !reason) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const position = await prisma.position.findUnique({
      where: { id: positionId },
      include: {
        stock: true,
        buyRecords: { orderBy: { boughtAt: 'asc' }, take: 1 },
        refreshLogs: { orderBy: { refreshedAt: 'desc' }, take: 1 },
      },
    })

    if (!position) {
      return NextResponse.json({ error: 'Position not found' }, { status: 404 })
    }

    const amount = shares * price
    const avgCost = position.avgCost
    const pnlPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0
    const realizedPnl = (price - avgCost) * shares

    const firstBuy = position.buyRecords[0]
    const thesis = firstBuy?.thesis ?? ''
    const thesisPoints: ThesisPoint[] = firstBuy?.thesisPointsJson
      ? JSON.parse(firstBuy.thesisPointsJson)
      : []

    let lastAnalysis: AnalysisResult | null = null
    if (position.refreshLogs[0]?.analysisJson) {
      try {
        lastAnalysis = JSON.parse(position.refreshLogs[0].analysisJson)
      } catch {}
    }

    // Compute consistency score via LLM
    const { score, comment } = await scoreSellConsistency(
      position.stock.name,
      thesis,
      thesisPoints,
      lastAnalysis,
      reason,
      note ?? '',
      pnlPct
    )

    // Record sell
    const sellRecord = await prisma.sellRecord.create({
      data: {
        positionId,
        soldAt: new Date(soldAt),
        shares,
        price,
        amount,
        reason: note ? `${reason}|${note}` : reason,
        consistencyScore: score,
        consistencyNote: comment,
      },
    })

    // Update position
    const newTotalShares = position.totalShares - shares
    const updatedRealizedPnl = (position.realizedPnl ?? 0) + realizedPnl

    if (newTotalShares <= 0) {
      // Full close
      await prisma.position.update({
        where: { id: positionId },
        data: {
          status: 'CLOSED',
          closedAt: new Date(soldAt),
          totalShares: 0,
          realizedPnl: updatedRealizedPnl,
        },
      })
    } else {
      // Partial sell
      await prisma.position.update({
        where: { id: positionId },
        data: {
          totalShares: newTotalShares,
          totalCost: newTotalShares * position.avgCost,
          realizedPnl: updatedRealizedPnl,
        },
      })
    }

    return NextResponse.json({
      sellRecordId: sellRecord.id,
      consistencyScore: score,
      consistencyNote: comment,
      closed: newTotalShares <= 0,
    })
  } catch (e) {
    console.error('/api/sell POST error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
