import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getUsdCny } from '@/lib/fx'

// GET /api/pnl/range?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// 区间已实现盈亏（复盘视角）：按**卖出日期**归属，区间内每笔平仓的 realizedPnl
// 直接相加——期权已含张数 × multiplier 与卖方方向，写入时就算好了，这里不再区分。
//
// 浮动盈亏不在这里算：系统没有逐日行情，历史某天的浮盈无法回溯，只有「现在」
// 这个时点能算。所以本接口只返回已实现部分与默认区间，前端把当前持仓的浮动
// 盈亏按「区间末端是否覆盖今天」并入。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** DB 里的交易日期是用户录入的 YYYY-MM-DD 按 UTC 零点存的，边界也用 UTC 对齐。 */
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`)
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999Z`)
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const todayStr = () => isoDay(new Date())

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams
    const today = todayStr()

    // 默认区间「第一笔交易 → 今天」：买入和卖出都看，取更早的一条。
    const [firstBuy, firstSell] = await Promise.all([
      prisma.buyRecord.findFirst({ orderBy: { boughtAt: 'asc' }, select: { boughtAt: true } }),
      prisma.sellRecord.findFirst({ orderBy: { soldAt: 'asc' }, select: { soldAt: true } }),
    ])
    const firstTrade = [firstBuy?.boughtAt, firstSell?.soldAt]
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())[0]
    const defaultFrom = firstTrade ? isoDay(firstTrade) : today

    const rawFrom = params.get('from')
    const rawTo = params.get('to')
    let from = rawFrom && DATE_RE.test(rawFrom) ? rawFrom : defaultFrom
    let to = rawTo && DATE_RE.test(rawTo) ? rawTo : today
    if (from > to) [from, to] = [to, from]

    const sells = await prisma.sellRecord.findMany({
      where: { soldAt: { gte: dayStart(from), lte: dayEnd(to) } },
      select: {
        realizedPnl: true,
        position: { select: { stock: { select: { market: true } } } },
      },
    })

    // 按市场分列，再折成 CNY 合计（与首页浮动盈亏汇总同一套汇率口径）。
    let cny = 0
    let usd = 0
    let counted = 0
    for (const sr of sells) {
      const pnl = sr.realizedPnl
      if (pnl == null || !Number.isFinite(pnl)) continue
      counted++
      if (sr.position.stock.market === 'US') usd += pnl
      else cny += pnl
    }

    const { rate: usdCny, source: fxSource } = await getUsdCny()

    return NextResponse.json({
      from,
      to,
      defaultFrom,
      defaultTo: today,
      // 区间是否覆盖今天：覆盖才把「当前浮动盈亏」并进总收益。
      includesNow: to >= today,
      realized: {
        cny,
        usd,
        totalCNY: cny + usd * usdCny,
        count: counted,
      },
      usdCny,
      fxSource,
    })
  } catch (e) {
    console.error('/api/pnl/range GET error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
