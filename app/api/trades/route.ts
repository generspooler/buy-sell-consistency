import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { MarketDataService } from '@/lib/market-data'
import { extractThesisPoints } from '@/lib/llm-analyzer'
import { AnalysisResult, AssetType, Market, OptionType, PositionSide, StockSnapshot } from '@/lib/types'
import { parseReentryPlan, serializeReentryPlan } from '@/lib/reentry'
import {
  DEFAULT_OPTION_MULTIPLIER,
  buildOccSymbol,
  expiryToDate,
  optionContextOf,
  toExpiryString,
  withPremiumBasis,
} from '@/lib/options'

const marketDataService = new MarketDataService()

const POSITION_SELECT = {
  id: true,
  stockId: true,
  totalShares: true,
  totalCost: true,
  assetType: true,
  side: true,
  multiplier: true,
  contractSymbol: true,
  optionType: true,
  strike: true,
  expiry: true,
  avgCost: true,
  openedAt: true,
} as const

// POST /api/trades — record a new buy (an opening trade).
// Persists the record FIRST (with empty thesis points), then extracts points.
// Pass ?extractPoints=0 to skip extraction entirely.
//
// Options (v0.4): assetType = 'OPTION' plus side / option terms. One contract
// = one position; shares = contracts, price = premium per share. A SHORT
// opening (卖出开仓) is still a "buy record" — the table means 开仓记录.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      symbol,
      name,
      market,
      boughtAt,
      shares,
      price,
      thesis,
      snapshotJson,
      addPositionId,
      assetType = 'STOCK',
      side = 'LONG',
      option,
    } = body as {
      symbol: string
      name: string
      market: Market
      boughtAt: string
      shares: number
      price: number
      thesis: string
      snapshotJson?: string
      addPositionId?: number // add to an existing position (加仓)
      assetType?: AssetType
      side?: PositionSide
      option?: { optionType: OptionType; strike: number; expiry: string; multiplier?: number }
    }

    if (!boughtAt || !shares || !price) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!addPositionId && (!symbol || !name || !market || !thesis)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Option terms for a NEW option position (加仓 inherits them from the position)
    let optionTerms: {
      contractSymbol: string
      optionType: OptionType
      strike: number
      expiry: string
      side: PositionSide
      multiplier: number
    } | null = null
    if (!addPositionId && assetType === 'OPTION') {
      const strike = Number(option?.strike)
      const expiry = String(option?.expiry ?? '')
      if (market !== 'US') {
        return NextResponse.json({ error: '期权仅支持美股' }, { status: 400 })
      }
      if (
        (option?.optionType !== 'CALL' && option?.optionType !== 'PUT') ||
        !(strike > 0) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
        (side !== 'LONG' && side !== 'SHORT')
      ) {
        return NextResponse.json({ error: 'Invalid option terms' }, { status: 400 })
      }
      optionTerms = {
        contractSymbol: buildOccSymbol(symbol!, expiry, option.optionType, strike),
        optionType: option.optionType,
        strike,
        expiry,
        side,
        multiplier:
          Number(option.multiplier) > 0 ? Math.round(Number(option.multiplier)) : DEFAULT_OPTION_MULTIPLIER,
      }
    }

    // Locate the target position: explicit addPositionId (加仓) or by stock.
    // Stock and option positions on the same underlying never merge; an
    // option position is keyed by (contract, side).
    let position: Awaited<ReturnType<typeof findPosition>> = null
    if (addPositionId) {
      position = await findPosition({ id: addPositionId, status: 'OPEN' })
      if (!position) {
        return NextResponse.json({ error: 'Open position not found' }, { status: 404 })
      }
    } else {
      // Upsert stock (the underlying, for options)
      const stock = await prisma.stock.upsert({
        where: { symbol: symbol! },
        create: { symbol: symbol!, name: name!, market: market! },
        update: { name: name! },
      })
      position = await findPosition(
        optionTerms
          ? {
              stockId: stock.id,
              status: 'OPEN',
              assetType: 'OPTION',
              contractSymbol: optionTerms.contractSymbol,
              side: optionTerms.side,
            }
          : { stockId: stock.id, status: 'OPEN', assetType: 'STOCK' }
      )
      if (!position) {
        position = await prisma.position.create({
          data: {
            stockId: stock.id,
            status: 'OPEN',
            openedAt: new Date(boughtAt),
            totalShares: 0,
            avgCost: 0,
            totalCost: 0,
            ...(optionTerms
              ? {
                  assetType: 'OPTION',
                  side: optionTerms.side,
                  multiplier: optionTerms.multiplier,
                  contractSymbol: optionTerms.contractSymbol,
                  optionType: optionTerms.optionType,
                  strike: optionTerms.strike,
                  expiry: expiryToDate(optionTerms.expiry),
                }
              : {}),
          },
          select: POSITION_SELECT,
        })
      }
    }

    const isOption = position.assetType === 'OPTION'
    const multiplier = position.multiplier || 1
    const amount = shares * price * multiplier

    // Update position averages. avgCost stays per-share (premium for options);
    // totalCost is real cash, so divide by the multiplier.
    const newTotalShares = position.totalShares + shares
    const newTotalCost = position.totalCost + amount
    const newAvgCost = newTotalCost / (newTotalShares * multiplier)

    await prisma.position.update({
      where: { id: position.id },
      data: {
        totalShares: newTotalShares,
        totalCost: newTotalCost,
        avgCost: newAvgCost,
      },
    })

    // Build snapshot if not provided. For 加仓 (addPositionId) we reuse the
    // position's first-buy snapshot unless the client supplies a fresh one —
    // thesis-point extraction stays anchored to the original buy.
    let snapshot = snapshotJson
    // A client-collected option snapshot must be for this exact contract, and
    // its breakeven is re-based on the actual fill price.
    if (snapshot && !addPositionId && isOption) {
      try {
        const parsed = JSON.parse(snapshot) as StockSnapshot
        snapshot =
          parsed.option?.contractSymbol === position.contractSymbol
            ? JSON.stringify({ ...parsed, option: withPremiumBasis(parsed.option, price) })
            : undefined
      } catch {
        snapshot = undefined
      }
    }
    if (!snapshot) {
      try {
        if (addPositionId) {
          const firstBuy = await prisma.buyRecord.findFirst({
            where: { positionId: position.id },
            orderBy: { boughtAt: 'asc' },
            select: { snapshotJson: true },
          })
          snapshot = firstBuy?.snapshotJson || '{}'
        } else if (isOption) {
          const snap = await marketDataService.buildOptionSnapshot(
            {
              underlying: symbol!,
              contractSymbol: position.contractSymbol!,
              optionType: position.optionType as OptionType,
              strike: position.strike!,
              expiry: toExpiryString(position.expiry!),
            },
            price
          )
          snapshot = JSON.stringify(snap)
        } else {
          const snap = await marketDataService.buildSnapshot(symbol!, market!)
          snapshot = JSON.stringify(snap)
        }
      } catch {
        snapshot = JSON.stringify({})
      }
    }

    // 加仓沿用刷新结论：把加仓当时最近一次刷新分析定格到本条记录上，历史记录
    // 时间线据此说明「在什么判断下加的仓」。没有刷新记录时留空，UI 显示未分析。
    let addBuyAnalysis: string | null = null
    if (addPositionId) {
      const lastRefresh = await prisma.refreshLog.findFirst({
        where: { positionId: position.id },
        orderBy: { refreshedAt: 'desc' },
        select: { id: true, refreshedAt: true, verdict: true, analysisJson: true },
      })
      if (lastRefresh) {
        let analysis: Partial<AnalysisResult> = {}
        try {
          analysis = JSON.parse(lastRefresh.analysisJson || '{}')
        } catch {}
        addBuyAnalysis = JSON.stringify({
          source: 'REFRESH',
          refreshLogId: lastRefresh.id,
          refreshedAt: lastRefresh.refreshedAt,
          verdict: lastRefresh.verdict,
          actionSuggestion: analysis.actionSuggestion ?? '',
          trendAnalysis: analysis.trendAnalysis ?? '',
          confidence: analysis.confidence ?? null,
        })
      }
    }

    // Persist buy record immediately — points extraction may follow
    const buyRecord = await prisma.buyRecord.create({
      data: {
        positionId: position.id,
        boughtAt: new Date(boughtAt),
        shares,
        price,
        amount,
        thesis: thesis || '',
        thesisPointsJson: '[]',
        snapshotJson: snapshot,
        analysisJson: addBuyAnalysis,
      },
    })

    // 买回执行留痕：同股存在 ARMED/FIRED 买回计划时，这笔买入自动关联
    // 为计划的执行（executedFrom 区分「触发后买回」与「未触发即买回」）。
    // 闭环「声明→触发→执行」，计划执行率从此可复盘。
    // 只有正股买入算执行——买一张该股的期权不是「买回」。
    const executedPlans: Array<{
      sellRecordId: number
      triggerPrice: number
      executedFrom: 'ARMED' | 'FIRED'
    }> = []
    try {
      const sellsOfStock = isOption
        ? []
        : await prisma.sellRecord.findMany({
            where: { position: { stockId: position.stockId, assetType: 'STOCK' } },
            orderBy: { soldAt: 'desc' },
          })
      for (const sr of sellsOfStock) {
        const plan = parseReentryPlan(sr.reentryPlanJson)
        if (!plan || (plan.status !== 'ARMED' && plan.status !== 'FIRED')) continue
        const from = plan.status
        const executed = {
          ...plan,
          status: 'EXECUTED' as const,
          executedAt: new Date().toISOString(),
          executedBuyRecordId: buyRecord.id,
          executedPositionId: position.id,
          executedFrom: from,
        }
        await prisma.sellRecord.update({
          where: { id: sr.id },
          data: { reentryPlanJson: serializeReentryPlan(executed) },
        })
        executedPlans.push({
          sellRecordId: sr.id,
          triggerPrice: plan.trigger.price,
          executedFrom: from,
        })
      }
    } catch (e) {
      console.warn('Reentry execution marking failed (non-fatal):', e)
    }

    // Extract thesis points via LLM only for a NEW position's first buy with a
    // thesis. The buy page then calls /api/thesis-points separately with a
    // progress UI — a slow LLM never blocks or loses the record. 加仓 records
    // never run inline extraction (the original points stay the baseline).
    let thesisPoints: Array<{ id: string; point: string }> = []
    if (
      thesis &&
      req.nextUrl.searchParams.get('extractPoints') !== '0' &&
      !addPositionId
    ) {
      try {
        const snapObj = JSON.parse(snapshot)
        thesisPoints = await extractThesisPoints(
          thesis,
          snapObj,
          name!,
          optionContextOf({ ...position, avgCost: newAvgCost }, symbol!)
        )
        await prisma.buyRecord.update({
          where: { id: buyRecord.id },
          data: { thesisPointsJson: JSON.stringify(thesisPoints) },
        })
      } catch (e) {
        console.error('Thesis extraction failed:', e)
        // Non-fatal: record saved with empty points, user can re-extract later
      }
    }

    return NextResponse.json({
      positionId: position.id,
      buyRecordId: buyRecord.id,
      thesisPoints,
      analysis: addBuyAnalysis ? JSON.parse(addBuyAnalysis) : null,
      executedPlans,
    })
  } catch (e) {
    console.error('/api/trades POST error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

// GET /api/trades?positionId=N — list buy records for a position
export async function GET(req: NextRequest) {
  const positionId = req.nextUrl.searchParams.get('positionId')
  if (!positionId) {
    return NextResponse.json({ error: 'positionId required' }, { status: 400 })
  }
  const records = await prisma.buyRecord.findMany({
    where: { positionId: parseInt(positionId) },
    orderBy: { boughtAt: 'asc' },
  })
  return NextResponse.json(records)
}

function findPosition(where: Prisma.PositionWhereInput) {
  return prisma.position.findFirst({ where, select: POSITION_SELECT })
}
