import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MarketDataService } from '@/lib/market-data'
import { analyzePosition } from '@/lib/llm-analyzer'
import { Market, StockSnapshot, ThesisPoint } from '@/lib/types'
import { isExpired, optionContextOf } from '@/lib/options'
import {
  parseReentryPlan,
  runReentryCheck,
  serializeReentryPlan,
  ReentryPlan,
} from '@/lib/reentry'

const marketDataService = new MarketDataService()

interface ReentryOutcome {
  fired: boolean
  note: string
  triggerPrice: number
}

/** 单只持仓的刷新结果行（分析结果 + 可选的买回触发）。 */
interface RefreshResultRow {
  positionId: number
  symbol?: string
  name?: string
  status: 'ok' | 'skipped' | 'error'
  reason?: string
  verdict?: string
  actionSuggestion?: string
  error?: string
  /** 仅做买回计划监控（已平仓），未跑 LLM 分析。 */
  monitoring?: boolean
  /** 期权已过到期时点、待结算——跳过分析。 */
  expired?: boolean
  reentry?: ReentryOutcome
}

// POST /api/refresh — refresh one or all positions, then mechanically check
// every ARMED re-entry plan (price gate × thesis gate, pure arithmetic — no
// LLM involved in the trigger decision).
//
// Plan checks run AFTER all analyses, keyed by stock (a plan hangs on a sell,
// not on a position's OPEN status):
//   - stocks with an OPEN position: checked with the fresh verdict from this
//     refresh (plans on closed positions of the same stock ride along);
//   - stocks with no open position: lightweight check only — live price +
//     cached candles + the stock's last known verdict. No LLM, no RefreshLog.
//
// Option positions (v0.4) analyse the contract against its own thesis
// (underlying snapshot + option block), are skipped once expired (待结算),
// and never feed the re-entry gate — that gate reads the STOCK thesis only.
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { positionId } = body as { positionId?: number }

  // ── 目标选择 ────────────────────────────────────────────────────────────
  const explicitPosition = positionId
    ? await prisma.position.findUnique({ where: { id: positionId }, include: { stock: true } })
    : null

  if (explicitPosition && explicitPosition.status !== 'OPEN') {
    // 刷新已平仓持仓 = 只做买回计划监控，不跑分析。
    const { checked, fired } = await lightCheckStock(explicitPosition.stockId)
    const row: RefreshResultRow = {
      positionId: explicitPosition.id,
      symbol: explicitPosition.stock.symbol,
      name: explicitPosition.stock.name,
      status: checked > 0 ? 'ok' : 'skipped',
      reason: checked > 0 ? undefined : '已平仓且无监控中的买回计划',
      monitoring: true,
      reentry: fired ?? undefined,
    }
    return NextResponse.json({ results: [row] })
  }

  const openTargets = await loadOpenPositions(positionId)

  // ── Phase 1: 分析（LLM），与原流水线一致 ────────────────────────────────
  const analyses = new Map<
    number /* stockId */,
    { snapshot: StockSnapshot; verdict: string; symbol: string; market: Market }
  >()

  const results: RefreshResultRow[] = await Promise.all(
    openTargets.map(async (pos): Promise<RefreshResultRow> => {
      try {
        if (pos.buyRecords.length === 0) {
          return { positionId: pos.id, status: 'skipped', reason: 'No buy records' }
        }

        const optionCtx = optionContextOf(pos, pos.stock.symbol)
        if (optionCtx && isExpired(optionCtx.expiry)) {
          return {
            positionId: pos.id,
            symbol: pos.stock.symbol,
            name: pos.stock.name,
            status: 'skipped',
            reason: '期权已到期，待结算',
            expired: true,
          }
        }

        const firstBuy = pos.buyRecords[0]
        const buySnapshot: StockSnapshot = JSON.parse(firstBuy.snapshotJson || '{}')
        const thesisPoints: ThesisPoint[] = JSON.parse(firstBuy.thesisPointsJson || '[]')

        const currentSnapshot = optionCtx
          ? await marketDataService.buildOptionSnapshot(optionCtx, optionCtx.premium)
          : await marketDataService.buildSnapshot(pos.stock.symbol, pos.stock.market as Market)

        let lastSnapshot: StockSnapshot | undefined
        if (pos.refreshLogs[0]?.snapshotJson) {
          try {
            lastSnapshot = JSON.parse(pos.refreshLogs[0].snapshotJson)
          } catch {}
        }

        const analysis = await analyzePosition(
          pos.stock.name,
          pos.stock.market as Market,
          firstBuy.thesis,
          thesisPoints,
          buySnapshot,
          currentSnapshot,
          lastSnapshot,
          optionCtx
        )

        await prisma.refreshLog.create({
          data: {
            positionId: pos.id,
            snapshotJson: JSON.stringify(currentSnapshot),
            analysisJson: JSON.stringify(analysis),
            verdict: analysis.verdict,
          },
        })

        // 买回闸门只认正股论点：期权的 verdict 评的是合约，不是这只股票。
        if (!optionCtx) {
          analyses.set(pos.stockId, {
            snapshot: currentSnapshot,
            verdict: analysis.verdict,
            symbol: pos.stock.symbol,
            market: pos.stock.market as Market,
          })
        }

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

  // ── Phase 2: 买回计划检查（纯算术，串行免竞态）─────────────────────────
  const firedByStock = new Map<number, ReentryOutcome>()

  for (const [stockId, ctx] of analyses) {
    const { fired } = await checkPlansForStock(
      stockId,
      ctx.symbol,
      ctx.market,
      ctx.snapshot,
      ctx.verdict
    )
    if (fired) firedByStock.set(stockId, fired)
  }

  // 轻量监控：仍有 ARMED 计划、但本轮没有被任何 OPEN 持仓覆盖的股票
  // （典型场景：清仓后等回调）。
  if (!positionId) {
    const covered = new Set(analyses.keys())
    const closedWithPlans = await prisma.position.findMany({
      where: {
        status: 'CLOSED',
        assetType: 'STOCK',
        sellRecords: { some: { reentryPlanJson: { contains: '"status":"ARMED"' } } },
      },
      include: { stock: true },
    })
    const seen = new Set<number>()
    for (const pos of closedWithPlans) {
      if (covered.has(pos.stockId) || seen.has(pos.stockId)) continue
      seen.add(pos.stockId)
      const { checked, fired } = await lightCheckStock(pos.stockId)
      if (checked > 0) {
        results.push({
          positionId: pos.id,
          symbol: pos.stock.symbol,
          name: pos.stock.name,
          status: 'ok',
          monitoring: true,
          reentry: fired ?? undefined,
        })
      }
    }
  }

  // 把触发结果挂到对应持仓的结果行上（按股票对应）。轻量监控行已自带
  // reentry 且不在 openTargets 中，不会被覆盖。
  const stockIdByPosition = new Map(openTargets.map(p => [p.id, p.stockId]))
  for (const r of results) {
    const stockId = stockIdByPosition.get(r.positionId)
    const outcome = stockId != null ? firedByStock.get(stockId) : undefined
    if (outcome?.fired) r.reentry = outcome
  }

  return NextResponse.json({ results })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadOpenPositions(positionId?: number) {
  return prisma.position.findMany({
    where: positionId ? { id: positionId, status: 'OPEN' } : { status: 'OPEN' },
    include: {
      stock: true,
      buyRecords: { orderBy: { boughtAt: 'asc' }, take: 1 },
      refreshLogs: { orderBy: { refreshedAt: 'desc' }, take: 1 },
    },
  })
}

/**
 * 检查某股票全部 ARMED 计划（含挂在已平仓持仓上的），逐个落库。
 * 纯算术判定，snapshot / verdict 由调用方提供——这是「检查」唯一的入口。
 */
async function checkPlansForStock(
  stockId: number,
  symbol: string,
  market: Market,
  snapshot: StockSnapshot,
  verdict: string | undefined
): Promise<{ checked: number; fired: ReentryOutcome | null }> {
  const sells = await prisma.sellRecord.findMany({
    where: { position: { stockId, assetType: 'STOCK' } },
    orderBy: { soldAt: 'desc' },
  })
  const armed = sells
    .map(sr => ({ sr, plan: parseReentryPlan(sr.reentryPlanJson) }))
    .filter(x => x.plan?.status === 'ARMED')
  if (armed.length === 0) return { checked: 0, fired: null }

  const candles = await marketDataService.getCandles(symbol, market)
  let firstFired: ReentryOutcome | null = null
  for (const { sr, plan } of armed) {
    const { plan: next, fired, note } = runReentryCheck(
      plan as ReentryPlan,
      snapshot,
      candles,
      null, // 论点闸门用下面的 verdict（本轮最新，或该股最近已知）
      verdict
    )
    await prisma.sellRecord.update({
      where: { id: sr.id },
      data: { reentryPlanJson: serializeReentryPlan(next) },
    })
    if (fired && !firstFired) {
      firstFired = { fired, note, triggerPrice: next.trigger.price }
    }
  }
  return { checked: armed.length, fired: firstFired }
}

/**
 * 无持仓股票的轻量监控：自行取快照与该股最近一次已知 verdict，然后走同一
 * 检查函数。不跑 LLM，不写 RefreshLog——「清仓等回调」的监控成本接近零。
 */
async function lightCheckStock(
  stockId: number
): Promise<{ checked: number; fired: ReentryOutcome | null }> {
  const stock = await prisma.stock.findUnique({ where: { id: stockId } })
  if (!stock) return { checked: 0, fired: null }

  const lastLog = await prisma.refreshLog.findFirst({
    where: { position: { stockId, assetType: 'STOCK' } },
    orderBy: { refreshedAt: 'desc' },
    select: { verdict: true },
  })
  const snapshot = await marketDataService.buildSnapshot(
    stock.symbol,
    stock.market as Market
  )
  return checkPlansForStock(
    stockId,
    stock.symbol,
    stock.market as Market,
    snapshot,
    lastLog?.verdict
  )
}
