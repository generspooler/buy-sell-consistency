import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { scoreSellConsistency } from '@/lib/llm-analyzer'
import { AnalysisResult, ThesisPoint } from '@/lib/types'
import {
  buildReentryPlan,
  parseReentryPlan,
  serializeReentryPlan,
  buildPriorPlanContext,
  ReentryPlan,
  ReentryTrigger,
} from '@/lib/reentry'

// POST /api/sell — record a sell, compute consistency score, optionally create
// a re-entry plan (买回计划) that future refreshes will check mechanically.
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
      reentry,
    } = body as {
      positionId: number
      soldAt: string
      shares: number
      price: number
      reason: string
      note?: string
      reentry?: {
        trigger: ReentryTrigger
        shares: number
        validDays?: number
        source?: 'LLM' | 'MANUAL'
      }
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

    // Prior re-entry plans for the SAME stock (any position, any status):
    // they feed the consistency prompt as 承诺兑现 background.
    const priorSells = await prisma.sellRecord.findMany({
      where: { position: { stockId: position.stockId } },
      include: { position: { select: { stock: { select: { name: true } } } } },
      orderBy: { soldAt: 'asc' },
    })
    const priorPlanContext = buildPriorPlanContext(
      priorSells
        .filter(sr => sr.id !== undefined && sr.reentryPlanJson)
        .map(sr => ({
          plan: parseReentryPlan(sr.reentryPlanJson)!,
          stockName: sr.position.stock.name,
          soldAt: sr.soldAt,
        }))
    )

    // Compute consistency score via LLM
    const { score, comment } = await scoreSellConsistency(
      position.stock.name,
      thesis,
      thesisPoints,
      lastAnalysis,
      reason,
      note ?? '',
      pnlPct,
      priorPlanContext
    )

    // Build re-entry plan if the user supplied trigger conditions
    let reentryPlan: ReentryPlan | null = null
    if (reentry && reentry.trigger && reentry.trigger.kind) {
      reentryPlan = buildReentryPlan({
        trigger: reentry.trigger,
        sellPrice: price,
        shares: reentry.shares ?? 0,
        validDays: reentry.validDays,
        source: reentry.source ?? 'MANUAL',
        soldAt,
      })
    }

    // Record sell
    const sellRecord = await prisma.sellRecord.create({
      data: {
        positionId,
        soldAt: new Date(soldAt),
        shares,
        price,
        amount,
        reason: note ? `${reason}|${note}` : reason,
        realizedPnl,
        pnlPct,
        consistencyScore: score,
        consistencyNote: comment,
        reentryPlanJson: reentryPlan ? serializeReentryPlan(reentryPlan) : null,
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
      reentryPlan,
    })
  } catch (e) {
    console.error('/api/sell POST error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
