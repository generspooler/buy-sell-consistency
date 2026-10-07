import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { BuyRecord, RefreshLog, SellRecord } from '@prisma/client'
import {
  AddBuyAnalysis,
  AnalysisResult,
  HistoryEvent,
  ReentryEvent,
  StockSnapshot,
  ThesisPoint,
  Verdict,
} from '@/lib/types'
import { parseReentryPlan } from '@/lib/reentry'
import { MarketDataService } from '@/lib/market-data'
import { expirySettlement, isExpired, optionContextOf } from '@/lib/options'

const marketDataService = new MarketDataService()

/** 到期待结算的建议（纯算术）：以到期日 K 线收盘价判定价内 / 价外。 */
interface SettlementSuggestion {
  expiry: string
  underlyingClose: number | null
  /** EXPIRY_CANDLE = 到期日收盘价；LAST_CANDLE = 到期日 K 线缺失，取到期前最后一根 */
  basis: 'EXPIRY_CANDLE' | 'LAST_CANDLE' | 'NONE'
  outcome: 'WORTHLESS' | 'ITM' | null
  intrinsic: number | null
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// Merge buys / refreshes / sells into one reverse-chronological timeline.
// The first buy (earliest) is the position's opening event; every later buy is
// a 加仓. Nothing is recomputed here — each event only surfaces what was stored
// when it happened, so past entries never drift with today's market price.
function buildHistory(position: {
  buyRecords: BuyRecord[]
  refreshLogs: RefreshLog[]
  sellRecords: SellRecord[]
}): HistoryEvent[] {
  const buysAsc = [...position.buyRecords].sort(
    (a, b) => a.boughtAt.getTime() - b.boughtAt.getTime() || a.id - b.id
  )

  const events: HistoryEvent[] = [
    ...buysAsc.map((b, i) => ({
      id: `buy-${b.id}`,
      type: i === 0 ? ('BUY' as const) : ('ADD_BUY' as const),
      at: b.boughtAt.toISOString(),
      shares: b.shares,
      price: b.price,
      amount: b.amount,
      thesis: b.thesis,
      thesisPoints: parseJson<ThesisPoint[]>(b.thesisPointsJson, []),
      snapshot: parseJson<StockSnapshot | null>(b.snapshotJson, null),
      analysis: parseJson<AddBuyAnalysis | null>(b.analysisJson, null),
    })),
    ...position.refreshLogs.map(log => ({
      id: `refresh-${log.id}`,
      type: 'REFRESH' as const,
      at: log.refreshedAt.toISOString(),
      verdict: log.verdict as Verdict,
      analysis: parseJson<AnalysisResult | null>(log.analysisJson, null),
    })),
    ...position.sellRecords.map(sr => {
      const [reason, ...rest] = sr.reason.split('|')
      return {
        id: `sell-${sr.id}`,
        type: 'SELL' as const,
        at: sr.soldAt.toISOString(),
        shares: sr.shares,
        price: sr.price,
        amount: sr.amount,
        reason,
        note: rest.join('|'),
        realizedPnl: sr.realizedPnl,
        pnlPct: sr.pnlPct,
        consistencyScore: sr.consistencyScore,
        consistencyNote: sr.consistencyNote,
        reentryPlan: parseReentryPlan(sr.reentryPlanJson),
      }
    }),
    // 买回计划的状态流转作为独立事件（触发/执行/过期/取消），
    // 与交易行为同轴展示：声明（卖出卡内）→ 触发 → 执行/放弃。
    ...reentryEvents(position.sellRecords),
  ]

  // Newest first; same-day trades fall back to the event id for a stable order.
  return events.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || b.id.localeCompare(a.id)
  )
}

// REENTRY timeline events — one per plan transition that has a timestamp.
// A fired-then-executed plan yields two events; the declaration itself stays
// embedded in the SELL event card.
function reentryEvents(sellRecords: SellRecord[]): ReentryEvent[] {
  const events: ReentryEvent[] = []
  for (const sr of sellRecords) {
    const plan = parseReentryPlan(sr.reentryPlanJson)
    if (!plan) continue
    const push = (kind: string, at?: string) => {
      if (!at) return
      events.push({
        id: `reentry-${sr.id}-${kind.toLowerCase()}`,
        type: 'REENTRY' as const,
        kind: kind as ReentryEvent['kind'],
        at,
        plan,
        sellRecordId: sr.id,
      })
    }
    push('FIRED', plan.firedAt)
    push('EXECUTED', plan.executedAt)
    push('EXPIRED', plan.expiredAt)
    push('CANCELLED', plan.cancelledAt)
  }
  return events
}

// GET /api/positions/[id] — full position detail
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const positionId = parseInt(id)

  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: {
      stock: true,
      buyRecords: { orderBy: { boughtAt: 'asc' } },
      sellRecords: { orderBy: { soldAt: 'desc' } },
      refreshLogs: { orderBy: { refreshedAt: 'desc' } },
    },
  })

  if (!position) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // 已过到期时点仍 OPEN 的期权：给出结算建议，用户确认后走平仓流程。
  // V1 只把「价外 → 到期作废」做成一键；价内需按券商实际结算手工记录。
  let settlement: SettlementSuggestion | null = null
  const optionCtx = optionContextOf(position, position.stock.symbol)
  if (position.status === 'OPEN' && optionCtx && isExpired(optionCtx.expiry)) {
    const candles = await marketDataService.getCandles(position.stock.symbol, 'US')
    const onOrBefore = candles.filter(c => (c.date ?? '').slice(0, 10) <= optionCtx.expiry)
    const last = onOrBefore[onOrBefore.length - 1]
    const basis = !last
      ? 'NONE'
      : last.date.slice(0, 10) === optionCtx.expiry ? 'EXPIRY_CANDLE' : 'LAST_CANDLE'
    const verdict = last ? expirySettlement(optionCtx.optionType, optionCtx.strike, last.close) : null
    settlement = {
      expiry: optionCtx.expiry,
      underlyingClose: last?.close ?? null,
      basis,
      outcome: verdict?.outcome ?? null,
      intrinsic: verdict?.intrinsic ?? null,
    }
  }

  return NextResponse.json({ ...position, history: buildHistory(position), settlement })
}
