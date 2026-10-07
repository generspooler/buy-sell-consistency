import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { scoreSellConsistency } from '@/lib/llm-analyzer'
import { AnalysisResult, StockSnapshot, ThesisPoint } from '@/lib/types'
import { optionContextOf, positionPnl, positionPnlPct } from '@/lib/options'
import {
  buildReentryPlan,
  parseReentryPlan,
  serializeReentryPlan,
  buildPriorPlanContext,
  ReentryPlan,
  ReentryTrigger,
} from '@/lib/reentry'

// POST /api/sell — record a sell (a closing trade), compute consistency score,
// optionally create a re-entry plan (买回计划) that future refreshes will check
// mechanically.
//
// Options (v0.4): shares = contracts, price = premium per share; a SHORT
// position closes by buying back (买入平仓). reason「到期作废」settles at 0.
// V1 has no exercise/assignment flow — record those as「其他」at the actual
// settlement price. Option positions never carry a re-entry plan.
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

    // 期权到期作废的平仓价为 0，其余情况价格必须为正。
    const expiredWorthless = reason === '到期作废'
    if (!positionId || !soldAt || !shares || !reason || (!expiredWorthless && !price)) {
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

    const isOption = position.assetType === 'OPTION'
    if (expiredWorthless && !isOption) {
      return NextResponse.json({ error: '「到期作废」仅适用于期权' }, { status: 400 })
    }
    const closePrice = expiredWorthless ? 0 : price
    const multiplier = position.multiplier || 1

    const amount = shares * closePrice * multiplier
    const pnlPct = positionPnlPct(position, closePrice)
    const realizedPnl = positionPnl(position, closePrice, shares)

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

    // Prior re-entry plans for the SAME stock (any stock position, any
    // status): they feed the consistency prompt as 承诺兑现 background.
    // Plans only exist on stock sells, so an option close skips this.
    const priorSells = isOption
      ? []
      : await prisma.sellRecord.findMany({
          where: { position: { stockId: position.stockId, assetType: 'STOCK' } },
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

    // 期权评分上下文：开仓时 IV（首笔快照）与最近一次刷新时 IV
    const optionCtx = optionContextOf(position, position.stock.symbol)
    const ivOf = (raw: string | undefined) => {
      try {
        return raw ? (JSON.parse(raw) as StockSnapshot).option?.iv : undefined
      } catch {
        return undefined
      }
    }

    // Compute consistency score via LLM
    const { score, comment } = await scoreSellConsistency(
      position.stock.name,
      thesis,
      thesisPoints,
      lastAnalysis,
      reason,
      note ?? '',
      pnlPct,
      priorPlanContext,
      optionCtx
        ? {
            ctx: optionCtx,
            closePrice,
            soldAt,
            openIv: ivOf(firstBuy?.snapshotJson),
            lastIv: ivOf(position.refreshLogs[0]?.snapshotJson),
          }
        : null
    )

    // Build re-entry plan if the user supplied trigger conditions (stocks only)
    let reentryPlan: ReentryPlan | null = null
    if (!isOption && reentry && reentry.trigger && reentry.trigger.kind) {
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
        price: closePrice,
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
          totalCost: newTotalShares * position.avgCost * multiplier,
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
