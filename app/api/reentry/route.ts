import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { draftReentryTrigger } from '@/lib/llm-analyzer'
import { MarketDataService } from '@/lib/market-data'
import { Market, ThesisPoint } from '@/lib/types'
import {
  parseReentryPlan,
  serializeReentryPlan,
  describeTrigger,
  ReentryPlan,
} from '@/lib/reentry'

const marketDataService = new MarketDataService()

// POST /api/reentry — LLM drafts a re-entry trigger from the sell note BEFORE
// the sell is recorded, so the user can review/adjust the numbers in the form.
// Mirrors the thesis-points flow: LLM proposes, the user confirms and locks.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { positionId, price, shares, reason, note } = body as {
      positionId: number
      price: number
      shares: number
      reason: string
      note?: string
    }

    if (!positionId || !price || !shares) {
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

    const thesisPoints: ThesisPoint[] = position.buyRecords[0]?.thesisPointsJson
      ? JSON.parse(position.buyRecords[0].thesisPointsJson)
      : []

    // Technical anchors for the draft: the freshest snapshot available.
    // Prefer the client-provided sell form context, else the position's
    // latest refresh snapshot, else build a live one.
    let tech: { support?: number; ma60?: number; bollLower?: number; low52w?: number } = {}
    const lastSnapshot = position.refreshLogs[0]?.snapshotJson
    if (lastSnapshot) {
      try {
        const snap = JSON.parse(lastSnapshot)
        tech = {
          support: snap.technicals?.support,
          ma60: snap.technicals?.ma60,
          bollLower: snap.technicals?.bollLower,
          low52w: snap.market?.low52w,
        }
      } catch {}
    }
    if (tech.support == null || tech.ma60 == null || tech.bollLower == null) {
      try {
        const live = await marketDataService.buildSnapshot(
          position.stock.symbol,
          position.stock.market as Market
        )
        tech = {
          support: tech.support ?? live.technicals.support,
          ma60: tech.ma60 ?? live.technicals.ma60,
          bollLower: tech.bollLower ?? live.technicals.bollLower,
          low52w: tech.low52w ?? live.market.low52w,
        }
      } catch {}
    }

    const draft = await draftReentryTrigger(
      position.stock.name,
      price,
      shares,
      thesisPoints,
      reason,
      note ?? '',
      tech
    )

    return NextResponse.json({ draft })
  } catch (e) {
    console.error('/api/reentry POST error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

// PATCH /api/reentry — explicitly cancel a plan (放弃/执行后关闭).
// Cancelling a FIRED plan is the honest record of "看到了触发，决定不买".
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { sellRecordId } = body as { sellRecordId: number }

    if (!sellRecordId) {
      return NextResponse.json({ error: 'sellRecordId required' }, { status: 400 })
    }

    const record = await prisma.sellRecord.findUnique({ where: { id: sellRecordId } })
    if (!record) {
      return NextResponse.json({ error: 'Sell record not found' }, { status: 404 })
    }

    const plan = parseReentryPlan(record.reentryPlanJson)
    if (!plan) {
      return NextResponse.json({ error: 'No re-entry plan on this sell' }, { status: 400 })
    }
    if (plan.status === 'EXPIRED' || plan.status === 'EXECUTED' || plan.status === 'CANCELLED') {
      return NextResponse.json({ error: `计划已终结（${plan.status}），无需取消` }, { status: 400 })
    }

    const cancelled: ReentryPlan = {
      ...plan,
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
    }
    await prisma.sellRecord.update({
      where: { id: sellRecordId },
      data: { reentryPlanJson: serializeReentryPlan(cancelled) },
    })

    return NextResponse.json({ plan: cancelled })
  } catch (e) {
    console.error('/api/reentry PATCH error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

// GET /api/reentry — monitoring list: every plan with live progress
// (distance to trigger), newest first. FIRED-unexecuted floats to the top.
export async function GET() {
  const sells = await prisma.sellRecord.findMany({
    where: { reentryPlanJson: { not: null } },
    include: { position: { include: { stock: true } } },
    orderBy: { soldAt: 'desc' },
  })

  const rows = await Promise.all(
    sells.map(async (sr) => {
      const plan = parseReentryPlan(sr.reentryPlanJson)
      if (!plan) return null

      // 只为仍在监控的计划取实时价——终结态计划的「距触发差距」没有意义。
      const active = plan.status === 'ARMED' || plan.status === 'FIRED'
      let currentPrice: number | undefined
      if (active) {
        try {
          const snap = await marketDataService.buildSnapshot(
            sr.position.stock.symbol,
            sr.position.stock.market as Market
          )
          currentPrice = snap.market.price
        } catch {}
      }

      // 距触发还需下跌的百分比（负数 = 现价已低于触发价）
      let gapPct: number | undefined
      if (currentPrice != null && plan.trigger.price > 0) {
        gapPct = ((currentPrice - plan.trigger.price) / plan.trigger.price) * 100
      }

      return {
        sellRecordId: sr.id,
        positionId: sr.positionId,
        positionStatus: sr.position.status,
        symbol: sr.position.stock.symbol,
        name: sr.position.stock.name,
        market: sr.position.stock.market,
        soldAt: sr.soldAt.toISOString(),
        soldPrice: sr.price,
        soldShares: sr.shares,
        plan,
        planDesc: describeTrigger(plan.trigger, plan.sellPrice),
        currentPrice,
        gapPct,
        lastCheckNote: plan.firedNote ?? plan.lastNote ?? null,
      }
    })
  )

  const plans = rows
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => {
      // FIRED 最前（要行动），其次 ARMED，其余按卖出时间倒序
      const order = (p: ReentryPlan) =>
        p.status === 'FIRED' ? 0 : p.status === 'ARMED' ? 1 : 2
      return order(a.plan) - order(b.plan) || b.soldAt.localeCompare(a.soldAt)
    })

  return NextResponse.json({ plans })
}
