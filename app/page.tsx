'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { fmtPrice } from '@/lib/format'

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
}

interface PnlSummary {
  usdCny: number
  fxSource: 'live' | 'fallback'
  pnlCNY: number
  pnlUSD: number
  pnlTotalCNY: number
}

interface RefreshResult {
  positionId: number
  symbol?: string
  name?: string
  status: string
  verdict?: string
  error?: string
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

export default function HomePage() {
  const [positions, setPositions] = useState<Position[]>([])
  const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<RefreshResult[]>([])
  const [error, setError] = useState<string | null>(null)

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch('/api/positions')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setError(null)
      setPositions(data.positions ?? [])
      setPnlSummary(data.pnlSummary ?? null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const load = async () => { await fetchPositions() }
    void load()
  }, [fetchPositions])

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

      {/* ── Refresh progress ── */}
      {refreshProgress.length > 0 && (
        <div className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <p className="mb-3 text-xs font-medium text-neutral-400 uppercase tracking-wide">刷新结果</p>
          <div className="space-y-2">
            {refreshProgress.map(r => (
              <div key={r.positionId} className="flex items-center justify-between text-sm">
                <span className="text-neutral-300">{r.name ?? `#${r.positionId}`}</span>
                {r.status === 'ok' ? (
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${VERDICT_COLOR[r.verdict ?? 'SUPPORT']}`}>
                    {VERDICT_LABEL[r.verdict ?? 'SUPPORT']}
                  </span>
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
            return (
              <div
                key={pos.id}
                className="group rounded-xl border border-neutral-800 bg-neutral-900 p-5 hover:border-neutral-700 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/position/${pos.id}`}
                          className="font-semibold text-neutral-100 hover:text-white"
                        >
                          {pos.name}
                        </Link>
                        <span className="text-xs text-neutral-500">{pos.symbol}</span>
                        <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-500">
                          {pos.market}
                        </span>
                        {pos.degraded && (
                          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-400">
                            数据降级
                          </span>
                        )}
                      </div>
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
                  </div>
                </div>

                {/* Bottom row */}
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    {pos.lastActionSuggestion ? (
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
                    <button
                      onClick={() => handleRefreshOne(pos.id)}
                      disabled={refreshing}
                      className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-40 transition-colors"
                    >
                      刷新
                    </button>
                    <Link
                      href={`/position/${pos.id}`}
                      className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
                    >
                      详情
                    </Link>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
