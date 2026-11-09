'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { fmtPrice } from '@/lib/format'
import { NEAR_EXPIRY_DAYS, SIDE_LABEL } from '@/lib/options'
import type { OptionPositionInfo } from '@/lib/types'

interface Position {
  id: number
  symbol: string
  name: string
  market: string
  status: string
  totalShares: number
  avgCost: number
  currentPrice?: number
  changePct?: number
  unrealizedPnl?: number
  unrealizedPnlPct?: number
  lastVerdict?: string
  lastRefreshedAt?: string
  lastActionSuggestion?: string
  openedAt: string
  degraded?: boolean
  assetType?: string
  option?: OptionPositionInfo
  reentry?: {
    status: 'ARMED' | 'FIRED'
    desc: string
    firedAt?: string
    lastCheckNote?: string
  }
}

interface PnlSummary {
  usdCny: number
  fxSource: 'live' | 'fallback'
  pnlCNY: number
  pnlUSD: number
  pnlTotalCNY: number
}

/** 区间已实现盈亏（来自 /api/pnl/range）。浮动部分由当前持仓在前端合并。 */
interface RangePnl {
  from: string
  to: string
  defaultFrom: string
  defaultTo: string
  /** 区间末端覆盖今天时才把当前浮动盈亏并进总收益 */
  includesNow: boolean
  realized: {
    cny: number
    usd: number
    totalCNY: number
    count: number
  }
  usdCny: number
  fxSource: 'live' | 'fallback'
}

interface ClosedPosition {
  id: number
  symbol: string
  name: string
  market: string
  assetType?: string
  optionLabel?: string
  side?: string
  closedAt?: string
  openedAt: string
  realizedPnl?: number
  lastSoldAt?: string
  lastSellPnlPct?: number
  consistencyScore?: number
  activePlan?: 'ARMED' | 'FIRED'
}

/** 买回监控行（来自 /api/reentry） */
interface ReentryRow {
  sellRecordId: number
  positionId: number
  positionStatus: string
  symbol: string
  name: string
  market: string
  soldAt: string
  soldPrice: number
  soldShares: number
  plan: {
    status: 'ARMED' | 'FIRED' | 'EXPIRED' | 'CANCELLED' | 'EXECUTED'
    trigger: { kind: string; value: number; price: number }
    shares: number
    validDays: number
    soldAt: string
    firedAt?: string
  }
  planDesc: string
  currentPrice?: number
  gapPct?: number
  lastCheckNote?: string | null
}

interface RefreshResult {
  positionId: number
  symbol?: string
  name?: string
  status: string
  verdict?: string
  error?: string
  monitoring?: boolean
  reentry?: { fired: boolean; note: string; triggerPrice?: number }
}

const VERDICT_COLOR: Record<string, string> = {
  SUPPORT: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  WEAKEN: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  BROKEN: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
}

const VERDICT_LABEL: Record<string, string> = {
  SUPPORT: '✓ 支撑',
  WEAKEN: '⚠ 动摇',
  BROKEN: '✗ 破坏',
}

/** 带符号的金额文本；四舍五入到 0 后不再显示「-0」。 */
function fmtSigned(n: number, digits = 0): string {
  const f = 10 ** digits
  const r = Math.round(n * f) / f
  const sign = r > 0 ? '+' : r < 0 ? '-' : ''
  return `${sign}${Math.abs(r).toFixed(digits)}`
}

/** YYYY-MM-DD 加减天数（UTC 口径，与入库日期一致）。 */
function shiftDay(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const QUICK_RANGES: Array<{ key: string; label: string }> = [
  { key: '30d', label: '近30天' },
  { key: '90d', label: '近90天' },
  { key: 'ytd', label: '今年' },
  { key: 'all', label: '全部' },
]

export default function HomePage() {
  const [positions, setPositions] = useState<Position[]>([])
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([])
  const [reentryRows, setReentryRows] = useState<ReentryRow[]>([])
  const [showClosed, setShowClosed] = useState(false)
  const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null)
  const [rangePnl, setRangePnl] = useState<RangePnl | null>(null)
  const [rangeLoading, setRangeLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<RefreshResult[]>([])
  const [error, setError] = useState<string | null>(null)

  const fetchPositions = useCallback(async () => {
    try {
      // 买回计划与持仓并列拉取：计划挂在卖出上，已平仓的股票不在持仓列表里，
      // 但它仍是「在跟踪的决策」——必须常驻可见，不能只在刷新后闪现。
      const [posRes, reentryRes] = await Promise.all([
        fetch('/api/positions'),
        fetch('/api/reentry'),
      ])
      if (!posRes.ok) throw new Error(`HTTP ${posRes.status}`)
      const data = await posRes.json()
      setError(null)
      setPositions(data.positions ?? [])
      setClosedPositions(data.closedPositions ?? [])
      setPnlSummary(data.pnlSummary ?? null)
      if (reentryRes.ok) {
        const rd = await reentryRes.json()
        setReentryRows(rd.plans ?? [])
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchRangePnl = useCallback(async (from?: string, to?: string) => {
    setRangeLoading(true)
    try {
      const qs = new URLSearchParams()
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      const q = qs.toString()
      const res = await fetch(`/api/pnl/range${q ? `?${q}` : ''}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRangePnl(await res.json())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRangeLoading(false)
    }
  }, [])

  useEffect(() => {
    // 区间收益独立于持仓行情：只读已落库的卖出记录，首次加载默认「开始 → 今天」。
    const load = async () => { await Promise.all([fetchPositions(), fetchRangePnl()]) }
    void load()
  }, [fetchPositions, fetchRangePnl])

  const handleRefreshAll = async () => {
    setRefreshing(true)
    setRefreshProgress([])
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      setRefreshProgress(data.results ?? [])
      await fetchPositions()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  const handleRefreshOne = async (positionId: number) => {
    setRefreshing(true)
    try {
      await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId }),
      })
      await fetchPositions()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  const openCount = positions.length
  const brokenCount = positions.filter(p => p.lastVerdict === 'BROKEN').length
  const totalPnl = positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)
  // 仍在跟踪的买回计划（含已平仓股票）——这是常驻数据，不依赖刷新
  const activePlans = reentryRows.filter(
    r => r.plan.status === 'ARMED' || r.plan.status === 'FIRED'
  )
  const firedCount = activePlans.filter(r => r.plan.status === 'FIRED').length

  // ── 区间收益 ─────────────────────────────────────────────────────────────
  // 总收益 = 区间内已实现盈亏 + 当前浮动盈亏（仅当区间末端覆盖今天）。
  // 历史区间只算已实现：系统没有逐日行情，过去某天的浮盈无法回溯。
  const realizedCNY = rangePnl?.realized.cny ?? 0
  const realizedUSD = rangePnl?.realized.usd ?? 0
  const realizedTotalCNY = rangePnl?.realized.totalCNY ?? 0
  const includeFloating = !!rangePnl?.includesNow && !!pnlSummary
  const floatingCNY = includeFloating ? (pnlSummary?.pnlTotalCNY ?? 0) : 0
  const floatingCN = includeFloating ? (pnlSummary?.pnlCNY ?? 0) : 0
  const floatingUS = includeFloating ? (pnlSummary?.pnlUSD ?? 0) : 0
  const rangeTotalCNY = realizedTotalCNY + floatingCNY
  const rangeFx = rangePnl?.usdCny ?? pnlSummary?.usdCny ?? 0

  const applyQuick = (key: string) => {
    if (!rangePnl) return
    const today = rangePnl.defaultTo
    const from =
      key === '30d' ? shiftDay(today, -29)
      : key === '90d' ? shiftDay(today, -89)
      : key === 'ytd' ? `${today.slice(0, 4)}-01-01`
      : rangePnl.defaultFrom
    void fetchRangePnl(from, today)
  }

  const activeQuick = (() => {
    if (!rangePnl) return null
    const today = rangePnl.defaultTo
    const candidates: Array<[string, string]> = [
      ['30d', shiftDay(today, -29)],
      ['90d', shiftDay(today, -89)],
      ['ytd', `${today.slice(0, 4)}-01-01`],
      ['all', rangePnl.defaultFrom],
    ]
    return candidates.find(([, f]) => rangePnl.from === f && rangePnl.to === today)?.[0] ?? null
  })()

  return (
    <div>
      {/* ── Header ── */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">持仓总览</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {openCount} 只持仓
            {brokenCount > 0 && (
              <span className="ml-2 text-rose-400">{brokenCount} 只逻辑已破坏</span>
            )}
            {activePlans.length > 0 && (
              <span className="ml-2 text-amber-400">
                {activePlans.length} 个买回计划
                {firedCount > 0 && `（${firedCount} 个已触发）`}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/buy"
            className="rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-700 transition-colors"
          >
            + 记录买入
          </Link>
          <button
            onClick={handleRefreshAll}
            disabled={refreshing || openCount === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {refreshing ? '分析中…' : '一键刷新全部'}
          </button>
        </div>
      </div>

      {/* ── Stats bar ── */}
      {openCount > 0 && (
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <p className="text-xs text-neutral-500">持仓数</p>
            <p className="mt-1 text-2xl font-semibold text-neutral-100">{openCount}</p>
          </div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-neutral-500">
                浮动盈亏
                {pnlSummary && (
                  <span className="ml-1 text-neutral-600">
                    @{pnlSummary.usdCny.toFixed(4)}
                    {pnlSummary.fxSource === 'live' ? '' : '(备用汇率)'}
                  </span>
                )}
              </p>
            </div>
            {pnlSummary ? (
              <div className="mt-1 space-y-0.5">
                <p className={`text-2xl font-semibold leading-tight ${pnlSummary.pnlTotalCNY >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pnlSummary.pnlTotalCNY >= 0 ? '+' : ''}{pnlSummary.pnlTotalCNY.toFixed(0)}
                  <span className="ml-1 text-xs font-normal text-neutral-500">综合 (CNY)</span>
                </p>
                <p className="text-xs text-neutral-500">
                  A股 <span className={pnlSummary.pnlCNY >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                    {pnlSummary.pnlCNY >= 0 ? '+' : ''}{pnlSummary.pnlCNY.toFixed(0)} CNY
                  </span>
                  {' · '}美股 <span className={pnlSummary.pnlUSD >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                    {pnlSummary.pnlUSD >= 0 ? '+' : ''}{pnlSummary.pnlUSD.toFixed(0)} USD
                  </span>
                  {' '}({(pnlSummary.pnlUSD * pnlSummary.usdCny >= 0 ? '+' : '') + (pnlSummary.pnlUSD * pnlSummary.usdCny).toFixed(0)} CNY)
                </p>
              </div>
            ) : (
              <p className={`mt-1 text-2xl font-semibold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}
              </p>
            )}
          </div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <p className="text-xs text-neutral-500">逻辑破坏</p>
            <p className={`mt-1 text-2xl font-semibold ${brokenCount > 0 ? 'text-rose-400' : 'text-neutral-400'}`}>
              {brokenCount}
            </p>
          </div>
        </div>
      )}

      {/* ── 区间收益（复盘视角）────────────────────────────────────────
          总收益 = 区间内卖出已实现 + 当前浮动；历史区间只算已实现。
          日期只筛卖出记录，已实现盈亏在平仓时即落库，无需再拉行情。 */}
      {!loading && rangePnl && (
        <div className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-medium text-neutral-300">区间收益</h2>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={rangePnl.from}
                  onChange={e => {
                    if (e.target.value) void fetchRangePnl(e.target.value, rangePnl.to)
                  }}
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300"
                />
                <span className="text-xs text-neutral-600">→</span>
                <input
                  type="date"
                  value={rangePnl.to}
                  onChange={e => {
                    if (e.target.value) void fetchRangePnl(rangePnl.from, e.target.value)
                  }}
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300"
                />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {QUICK_RANGES.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => applyQuick(key)}
                  className={`rounded border px-2 py-1 text-xs transition-colors ${
                    activeQuick === key
                      ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
                      : 'border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-xs text-neutral-500">
                总收益
                {rangeLoading && <span className="ml-1 text-neutral-600">更新中…</span>}
              </p>
              <p className={`mt-1 text-2xl font-semibold ${rangeTotalCNY >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmtSigned(rangeTotalCNY)}
                <span className="ml-1 text-xs font-normal text-neutral-500">CNY</span>
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                已实现{' '}
                <span className={realizedTotalCNY >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                  {fmtSigned(realizedTotalCNY)}
                </span>
                {includeFloating && (
                  <>
                    {' · '}浮动{' '}
                    <span className={floatingCNY >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                      {fmtSigned(floatingCNY)}
                    </span>
                  </>
                )}
                {rangePnl.realized.count > 0 && (
                  <span className="ml-1 text-neutral-600">（{rangePnl.realized.count} 笔已平仓）</span>
                )}
              </p>
            </div>

            <div className="text-xs text-neutral-500">
              <p>
                A股{' '}
                <span className={realizedCNY + floatingCN >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                  {fmtSigned(realizedCNY + floatingCN)}
                </span>{' '}
                CNY
              </p>
              <p className="mt-0.5">
                美股{' '}
                <span className={realizedUSD + floatingUS >= 0 ? 'text-emerald-500' : 'text-rose-500'}>
                  {fmtSigned(realizedUSD + floatingUS)}
                </span>{' '}
                USD
                <span className="ml-1 text-neutral-600">
                  （{fmtSigned((realizedUSD + floatingUS) * rangeFx)} CNY @{rangeFx.toFixed(4)}）
                </span>
              </p>
            </div>
          </div>

          {!rangePnl.includesNow && (
            <p className="mt-2 text-xs text-neutral-600">
              区间末端早于今天：只统计已实现盈亏——系统没有逐日行情，历史某天的浮盈无法回溯。
            </p>
          )}
        </div>
      )}

      {/* ── 买回监控（常驻）──────────────────────────────────────────
          计划挂在卖出上，清仓后的股票不在持仓列表里，但承诺仍然活着。
          这里是它唯一的常驻可见面——FIRED 置顶高亮，不点刷新也看得到。 */}
      {activePlans.length > 0 && (
        <div className="mb-6">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-medium text-neutral-300">买回监控</h2>
            <span className="text-xs text-neutral-500">{activePlans.length} 个计划</span>
            {firedCount > 0 && (
              <span className="text-xs text-amber-400">{firedCount} 个已触发待执行</span>
            )}
          </div>
          <div className="space-y-2">
            {activePlans.map(r => {
              const fired = r.plan.status === 'FIRED'
              return (
                <div
                  key={r.sellRecordId}
                  className={`rounded-xl border p-4 transition-colors ${
                    fired
                      ? 'border-amber-400/50 bg-amber-400/10'
                      : 'border-neutral-800 bg-neutral-900 hover:border-neutral-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/position/${r.positionId}`}
                          className="font-medium text-neutral-100 hover:text-white"
                        >
                          {r.name}
                        </Link>
                        <span className="text-xs text-neutral-500">{r.symbol}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                            fired
                              ? 'border-amber-400/40 bg-amber-400/15 text-amber-200'
                              : 'border-amber-400/20 bg-amber-400/5 text-amber-400/80'
                          }`}
                        >
                          {fired ? '⚑ 已触发 · 待执行' : '◷ 监控中'}
                        </span>
                        {r.positionStatus === 'CLOSED' && (
                          <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-500">
                            已清仓
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-sm text-neutral-300">{r.planDesc}</p>
                      {fired ? (
                        <p className="mt-1.5 text-sm leading-relaxed text-neutral-200">
                          {r.lastCheckNote}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-neutral-500">
                          {r.currentPrice != null ? (
                            <>
                              现价 {fmtPrice(r.currentPrice)}
                              {r.gapPct != null && (
                                <span className="text-neutral-400">
                                  {r.gapPct > 0
                                    ? ` · 距触发还需下跌 ${r.gapPct.toFixed(1)}%`
                                    : ` · 已低于触发价 ${Math.abs(r.gapPct).toFixed(1)}%（论点闸门未放行）`}
                                </span>
                              )}
                            </>
                          ) : (
                            '价格获取中…'
                          )}
                          {' · '}声明于 {new Date(r.plan.soldAt).toLocaleDateString('zh-CN')}
                          {' · 有效 '}{r.plan.validDays} 天
                        </p>
                      )}
                    </div>
                    <Link
                      href={`/position/${r.positionId}`}
                      className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                        fired
                          ? 'bg-amber-500 text-neutral-950 hover:bg-amber-400'
                          : 'border border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                      }`}
                    >
                      {fired ? '去处理' : '详情'}
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Refresh progress ── */}
      {refreshProgress.length > 0 && (
        <div className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <p className="mb-3 text-xs font-medium text-neutral-400 uppercase tracking-wide">刷新结果</p>
          <div className="space-y-2">
            {refreshProgress.map(r => (
              <div key={r.positionId} className="flex items-center justify-between text-sm">
                <span className="text-neutral-300">
                  {r.name ?? `#${r.positionId}`}
                  {r.monitoring && (
                    <span className="ml-1.5 text-xs text-neutral-600">仅买回监控</span>
                  )}
                  {r.reentry?.fired && (
                    <span className="ml-1.5 text-xs text-amber-400">⚑ 买回触发</span>
                  )}
                </span>
                {r.status === 'ok' ? (
                  r.monitoring ? (
                    <span className="text-xs text-neutral-500">已检查</span>
                  ) : (
                    <span className={`rounded-full border px-2 py-0.5 text-xs ${VERDICT_COLOR[r.verdict ?? 'SUPPORT']}`}>
                      {VERDICT_LABEL[r.verdict ?? 'SUPPORT']}
                    </span>
                  )
                ) : r.status === 'error' ? (
                  <span className="text-xs text-rose-400">失败: {r.error?.slice(0, 60)}</span>
                ) : (
                  <span className="text-xs text-neutral-500">跳过</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="mb-6 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-400">
          {error}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-28 rounded-xl border border-neutral-800 bg-neutral-900 animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && openCount === 0 && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-12 text-center">
          <p className="text-neutral-400">还没有持仓记录</p>
          <Link
            href="/buy"
            className="mt-4 inline-block rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
          >
            记录第一笔买入
          </Link>
        </div>
      )}

      {/* ── Position cards ── */}
      {!loading && (
        <div className="space-y-3">
          {positions.map(pos => {
            const pnlPct = pos.unrealizedPnlPct
            const pnlPos = (pnlPct ?? 0) >= 0
            const opt = pos.option
            return (
              <div
                key={pos.id}
                className={`group rounded-xl border bg-neutral-900 p-5 transition-colors ${
                  opt?.expired
                    ? 'border-amber-400/50 hover:border-amber-400/70'
                    : 'border-neutral-800 hover:border-neutral-700'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/position/${pos.id}`}
                          className="font-semibold text-neutral-100 hover:text-white"
                        >
                          {opt ? opt.label : pos.name}
                        </Link>
                        <span className="text-xs text-neutral-500">{opt ? pos.name : pos.symbol}</span>
                        <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-500">
                          {opt ? `${pos.market} · 期权` : pos.market}
                        </span>
                        {opt && (
                          <span className={`rounded border px-1.5 py-0.5 text-xs ${
                            opt.side === 'SHORT'
                              ? 'border-violet-400/30 bg-violet-400/10 text-violet-300'
                              : 'border-sky-400/30 bg-sky-400/10 text-sky-300'
                          }`}>
                            {SIDE_LABEL[opt.side]}
                          </span>
                        )}
                        {opt && (opt.expired ? (
                          <span className="rounded border border-amber-400/40 bg-amber-400/15 px-1.5 py-0.5 text-xs font-medium text-amber-200">
                            已到期 · 待结算
                          </span>
                        ) : (
                          <span className={`rounded border px-1.5 py-0.5 text-xs ${
                            opt.dte <= NEAR_EXPIRY_DAYS
                              ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
                              : 'border-neutral-700 text-neutral-400'
                          }`}>
                            剩 {opt.dte} 天
                          </span>
                        ))}
                        {pos.degraded && (
                          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-400">
                            数据降级
                          </span>
                        )}
                      </div>
                      {opt ? (
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                          <span className="text-neutral-200 font-medium">
                            {pos.currentPrice != null ? (
                              <>权利金 {fmtPrice(pos.currentPrice)}</>
                            ) : (
                              <span className="text-neutral-500 text-xs font-normal">
                                {opt.expired ? '合约已到期，无报价' : '权利金获取中…'}
                              </span>
                            )}
                          </span>
                          {opt.underlyingPrice != null && (
                            <span className="text-xs text-neutral-400">
                              标的 {fmtPrice(opt.underlyingPrice)}
                              {opt.underlyingChangePct != null && (
                                <span className={`ml-1 ${opt.underlyingChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {opt.underlyingChangePct >= 0 ? '+' : ''}{opt.underlyingChangePct.toFixed(2)}%
                                </span>
                              )}
                            </span>
                          )}
                          <span className="text-neutral-500 text-xs">
                            成本 {fmtPrice(pos.avgCost)} · {pos.totalShares} 张
                            {opt.breakeven != null && ` · 盈亏平衡 ${fmtPrice(opt.breakeven)}`}
                            {opt.distToBreakevenPct != null &&
                              `（标的需 ${opt.distToBreakevenPct >= 0 ? '+' : ''}${opt.distToBreakevenPct.toFixed(1)}%）`}
                          </span>
                        </div>
                      ) : (
                        <div className="mt-1 flex items-center gap-4 text-sm">
                          {pos.currentPrice != null ? (
                            <span className="text-neutral-200 font-medium">
                              {fmtPrice(pos.currentPrice)}
                              {pos.changePct != null && (
                                <span className={`ml-1 text-xs ${pos.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {pos.changePct >= 0 ? '+' : ''}{pos.changePct.toFixed(2)}%
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-neutral-500 text-xs">价格获取中…</span>
                          )}
                          <span className="text-neutral-500 text-xs">
                            成本 {fmtPrice(pos.avgCost)} · {pos.totalShares} 股
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* PnL */}
                    {pnlPct != null && (
                      <div className="text-right">
                        <p className={`text-sm font-semibold ${pnlPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {pnlPos ? '+' : ''}{pnlPct.toFixed(2)}%
                        </p>
                        <p className={`text-xs ${pnlPos ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {pnlPos ? '+' : ''}{(pos.unrealizedPnl ?? 0).toFixed(0)} {pos.market === 'US' ? 'USD' : 'CNY'}
                        </p>
                      </div>
                    )}

                    {/* Verdict badge */}
                    {pos.lastVerdict && (
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${VERDICT_COLOR[pos.lastVerdict]}`}>
                        {VERDICT_LABEL[pos.lastVerdict]}
                      </span>
                    )}

                    {/* 买回计划徽章 */}
                    {pos.reentry && (
                      <span
                        title={pos.reentry.lastCheckNote ?? pos.reentry.desc}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                          pos.reentry.status === 'FIRED'
                            ? 'border-amber-400/40 bg-amber-400/15 text-amber-200'
                            : 'border-amber-400/20 bg-amber-400/5 text-amber-400/80'
                        }`}
                      >
                        {pos.reentry.status === 'FIRED' ? '⚑ 买回已触发' : '◷ 买回监控中'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Bottom row */}
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    {opt?.expired ? (
                      <p className="text-xs text-amber-300/90 leading-relaxed">
                        已过到期日 {opt.expiry}，请在详情页结算（价外到期可一键作废；行权 / 被指派按实际结算记录）
                      </p>
                    ) : pos.lastActionSuggestion ? (
                      <p className="text-xs text-neutral-400 leading-relaxed">
                        {pos.lastActionSuggestion}
                      </p>
                    ) : (
                      <p className="text-xs text-neutral-600">尚未分析 — 点击刷新查看最新判断</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pos.lastRefreshedAt && (
                      <span className="text-xs text-neutral-600">
                        {new Date(pos.lastRefreshedAt).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                    {!opt?.expired && (
                      <button
                        onClick={() => handleRefreshOne(pos.id)}
                        disabled={refreshing}
                        className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-40 transition-colors"
                      >
                        刷新
                      </button>
                    )}
                    <Link
                      href={`/position/${pos.id}`}
                      className={opt?.expired
                        ? 'rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-neutral-950 hover:bg-amber-400 transition-colors'
                        : 'rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors'}
                    >
                      {opt?.expired ? '去结算' : '详情'}
                    </Link>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 已平仓（复盘入口）──────────────────────────────────────────
          全量卖出的持仓此前在前端完全不可达，历史记录与一致性评分等于
          写进去就看不见。这里是它的入口，默认折叠——是复盘用的，不是每天看的。 */}
      {!loading && closedPositions.length > 0 && (
        <div className="mt-8">
          <button
            onClick={() => setShowClosed(v => !v)}
            className="flex w-full items-center gap-2 border-t border-neutral-800 pt-4 text-left text-sm text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            <span className={`text-xs transition-transform ${showClosed ? 'rotate-90' : ''}`}>▶</span>
            已平仓 ({closedPositions.length})
            {closedPositions.some(c => c.activePlan) && (
              <span className="text-xs text-amber-400/80">· 含买回监控</span>
            )}
          </button>

          {showClosed && (
            <div className="mt-3 space-y-2">
              {closedPositions.map(c => {
                const pnl = c.realizedPnl ?? 0
                const pnlPos = pnl >= 0
                // 持有天数只在两端日期都有时计算——不用 Date.now() 兜底（渲染期纯函数）
                const endDate = c.lastSoldAt ?? c.closedAt
                const heldDays =
                  endDate && c.openedAt
                    ? Math.max(
                        1,
                        Math.round(
                          (new Date(endDate).getTime() - new Date(c.openedAt).getTime()) / 86400000
                        )
                      )
                    : null
                return (
                  <div
                    key={c.id}
                    className="rounded-xl border border-neutral-800/70 bg-neutral-900/50 p-4"
                  >                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/position/${c.id}`}
                            className="font-medium text-neutral-300 hover:text-neutral-100"
                          >
                            {c.optionLabel ?? c.name}
                          </Link>
                          <span className="text-xs text-neutral-600">
                            {c.optionLabel ? `${c.name} · 期权${c.side === 'SHORT' ? '卖方' : '买方'}` : c.symbol}
                          </span>
                          {c.activePlan && (
                            <span
                              className={`rounded-full border px-2 py-0.5 text-xs ${
                                c.activePlan === 'FIRED'
                                  ? 'border-amber-400/40 bg-amber-400/15 text-amber-200'
                                  : 'border-amber-400/20 bg-amber-400/5 text-amber-400/80'
                              }`}
                            >
                              {c.activePlan === 'FIRED' ? '⚑ 买回已触发' : '◷ 买回监控中'}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-neutral-500">
                          {c.lastSoldAt && `${new Date(c.lastSoldAt).toLocaleDateString('zh-CN')} 平仓`}
                          {heldDays != null && ` · 持有 ${heldDays} 天`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-4">
                        <div className="text-right">
                          <p className={`text-sm font-semibold ${pnlPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {pnlPos ? '+' : ''}{pnl.toFixed(0)} {c.market === 'US' ? 'USD' : 'CNY'}
                          </p>
                          {c.lastSellPnlPct != null && (
                            <p className={`text-xs ${pnlPos ? 'text-emerald-500' : 'text-rose-500'}`}>
                              {c.lastSellPnlPct >= 0 ? '+' : ''}{c.lastSellPnlPct.toFixed(2)}%
                            </p>
                          )}
                        </div>
                        {c.consistencyScore != null && (
                          <div className="text-right">
                            <p className="text-xs text-neutral-600">一致性</p>
                            <p className={`text-sm font-semibold ${
                              c.consistencyScore >= 70 ? 'text-emerald-400' : 'text-amber-400'
                            }`}>
                              {c.consistencyScore}
                            </p>
                          </div>
                        )}
                        <Link
                          href={`/position/${c.id}`}
                          className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
                        >
                          历史
                        </Link>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
