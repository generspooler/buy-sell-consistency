import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MarketDataService } from '@/lib/market-data'
import { extractThesisPoints } from '@/lib/llm-analyzer'
import { Market } from '@/lib/types'

const marketDataService = new MarketDataService()

// POST /api/trades — record a new buy.
// Persists the record FIRST (with empty thesis points), then extracts points.
// Pass ?extractPoints=0 to skip extraction entirely.
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
    }

    if (!boughtAt || !shares || !price) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!addPositionId && (!symbol || !name || !market || !thesis)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const amount = shares * price

    // Locate the target position: explicit addPositionId (加仓) or by stock
    let position: { id: number; totalShares: number; totalCost: number } | null = null
    if (addPositionId) {
      position = await prisma.position.findFirst({
        where: { id: addPositionId, status: 'OPEN' },
        select: { id: true, totalShares: true, totalCost: true },
      })
      if (!position) {
        return NextResponse.json({ error: 'Open position not found' }, { status: 404 })
      }
    } else {
      // Upsert stock
      const stock = await prisma.stock.upsert({
        where: { symbol: symbol! },
        create: { symbol: symbol!, name: name!, market: market! },
        update: { name: name! },
      })
      position = await prisma.position.findFirst({
        where: { stockId: stock.id, status: 'OPEN' },
        select: { id: true, totalShares: true, totalCost: true },
      })
      if (!position) {
        position = await prisma.position.create({
          data: {
            stockId: stock.id,
            status: 'OPEN',
            openedAt: new Date(boughtAt),
            totalShares: 0,
            avgCost: 0,
            totalCost: 0,
          },
          select: { id: true, totalShares: true, totalCost: true },
        })
      }
    }

    // Update position averages
    const newTotalShares = position.totalShares + shares
    const newTotalCost = position.totalCost + amount
    const newAvgCost = newTotalCost / newTotalShares

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
    if (!snapshot) {
      try {
        if (addPositionId) {
          const firstBuy = await prisma.buyRecord.findFirst({
            where: { positionId: position.id },
            orderBy: { boughtAt: 'asc' },
            select: { snapshotJson: true },
          })
          snapshot = firstBuy?.snapshotJson || '{}'
        } else {
          const snap = await marketDataService.buildSnapshot(symbol!, market!)
          snapshot = JSON.stringify(snap)
        }
      } catch {
        snapshot = JSON.stringify({})
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
      },
    })

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
        thesisPoints = await extractThesisPoints(thesis, snapObj, name!)
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
