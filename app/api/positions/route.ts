import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MarketDataService } from '@/lib/market-data'
import { getUsdCny } from '@/lib/fx'
import { Market } from '@/lib/types'
import { parseReentryPlan, describeTrigger } from '@/lib/reentry'

const marketDataService = new MarketDataService()

// GET /api/positions — list all open positions with latest price.
// Each row also carries its re-entry plan state (ARMED/FIRED) for the
// home-page badges; terminal states stay in the position's history timeline.
export async function GET() {
  const positions = await prisma.position.findMany({
    where: { status: 'OPEN' },
    include: {
      stock: true,
      buyRecords: { orderBy: { boughtAt: 'asc' } },
      refreshLogs: { orderBy: { refreshedAt: 'desc' }, take: 1 },
      sellRecords: { orderBy: { soldAt: 'desc' } },
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

      // 买回计划状态：FIRED = 触发待执行（醒目提醒）；ARMED = 监控中。
      // 只看本持仓的卖出记录；已平仓持仓的计划在 /api/reentry 单独呈现。
      let reentry: {
        status: 'ARMED' | 'FIRED'
        desc: string
        firedAt?: string
        lastCheckNote?: string
      } | undefined
      for (const sr of pos.sellRecords) {
        const plan = parseReentryPlan(sr.reentryPlanJson)
        if (!plan) continue
        if (plan.status === 'FIRED' || plan.status === 'ARMED') {
          reentry = {
            status: plan.status,
            desc: describeTrigger(plan.trigger, plan.sellPrice),
            firedAt: plan.firedAt,
            lastCheckNote: plan.firedNote ?? plan.lastNote,
          }
          if (plan.status === 'FIRED') break // FIRED 优先展示
        }
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
        reentry,
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

  // 已平仓持仓：复盘入口。不取实时行情——平仓后没有浮盈可言，
  // 需要的是「当时赚了多少、那次卖得一致不一致」，全部来自已落库的值。
  const closedRaw = await prisma.position.findMany({
    where: { status: 'CLOSED' },
    include: {
      stock: true,
      sellRecords: { orderBy: { soldAt: 'desc' } },
    },
    orderBy: { closedAt: 'desc' },
  })

  const closedPositions = closedRaw.map(pos => {
    const lastSell = pos.sellRecords[0]
    // 该持仓上是否还有活着的买回计划（决定列表里要不要标监控中）
    let activePlan: 'ARMED' | 'FIRED' | undefined
    for (const sr of pos.sellRecords) {
      const plan = parseReentryPlan(sr.reentryPlanJson)
      if (plan?.status === 'FIRED') { activePlan = 'FIRED'; break }
      if (plan?.status === 'ARMED') activePlan = 'ARMED'
    }
    return {
      id: pos.id,
      symbol: pos.stock.symbol,
      name: pos.stock.name,
      market: pos.stock.market,
      closedAt: pos.closedAt,
      openedAt: pos.openedAt,
      realizedPnl: pos.realizedPnl,
      lastSoldAt: lastSell?.soldAt,
      lastSellPnlPct: lastSell?.pnlPct,
      consistencyScore: lastSell?.consistencyScore,
      activePlan,
    }
  })

  return NextResponse.json({
    positions: results,
    closedPositions,
    pnlSummary: {
      usdCny,
      fxSource,
      pnlCNY: pnlCN,
      pnlUSD: pnlUS,
      pnlTotalCNY,
    },
  })
}
