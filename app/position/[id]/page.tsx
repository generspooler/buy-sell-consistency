'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { fmtPrice } from '@/lib/format'

interface Stock { symbol: string; name: string; market: string }
interface BuyRecord {
  id: number; boughtAt: string; shares: number; price: number
  amount: number; thesis: string; thesisPointsJson: string; snapshotJson: string
}
interface RefreshLog {
  id: number; refreshedAt: string; verdict: string
  snapshotJson: string; analysisJson: string
}
interface SellRecord {
  id: number; soldAt: string; shares: number; price: number
  amount: number; reason: string; consistencyScore?: number; consistencyNote?: string
}
interface Position {
  id: number; status: string; totalShares: number; avgCost: number
  totalCost: number; realizedPnl?: number; openedAt: string
  stock: Stock; buyRecords: BuyRecord[]
  refreshLogs: RefreshLog[]; sellRecords: SellRecord[]
}
interface ThesisPoint { id: string; point: string; status?: string; evidence?: string; trend?: string }
interface AnalysisResult {
  thesisPoints: Array<{ point: string; status: string; evidence: string; trend: string }>
  verdict: string; trendAnalysis: string; newsSignals: string[]
  actionSuggestion: string; confidence: number
}

const VERDICT_COLOR: Record<string, string> = {
  SUPPORT: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  WEAKEN: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  BROKEN: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
}
const VERDICT_LABEL: Record<string, string> = { SUPPORT: '✓ 支撑', WEAKEN: '⚠ 动摇', BROKEN: '✗ 破坏' }
const POINT_COLOR: Record<string, string> = {
  HELD: 'text-emerald-400', WEAKENED: 'text-amber-400', BROKEN: 'text-rose-400'
}

type TabId = 'thesis' | 'history' | 'sell'

// ── Add-buy (加仓) form ──────────────────────────────────────────────────────
function AddBuyForm({
  positionId,
  currentShares,
  onDone,
}: {
  positionId: number
  currentShares: number
  onDone: () => void
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [shares, setShares] = useState('')
  const [price, setPrice] = useState('')
  const [thesis, setThesis] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!shares || !price) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/trades?extractPoints=0', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addPositionId: positionId,
          boughtAt: date,
          shares: parseFloat(shares),
          price: parseFloat(price),
          thesis: thesis || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '加仓失败')
      setDone(true)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
        <p className="text-sm font-medium text-emerald-400">加仓已记录 ✓</p>
        <p className="mt-1 text-xs text-neutral-400">
          成本均价与持仓数已更新。本次加仓未附买入理由，论点基准仍以首笔买入为准。
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <div>
        <h3 className="font-semibold text-neutral-100">加仓</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          当前持仓 {currentShares} 股 · 成本均价将按本次加仓自动重算
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">日期</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">股数</label>
          <input type="number" value={shares} onChange={e => setShares(e.target.value)}
            min="1" placeholder="100"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">价格</label>
          <input type="number" value={price} onChange={e => setPrice(e.target.value)}
            step="0.001" min="0" placeholder="0.000"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-neutral-300 mb-1.5">
          加仓理由（可选）
        </label>
        <textarea value={thesis} onChange={e => setThesis(e.target.value)}
          rows={2} placeholder="若本次加仓有新逻辑，可留档（不影响原论点基准）…"
          className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-3 text-sm text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none" />
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button type="submit" disabled={submitting || !shares || !price}
        className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors">
        {submitting ? '保存中…' : '确认加仓'}
      </button>
    </form>
  )
}

export default function PositionDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [position, setPosition] = useState<Position | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabId>('thesis')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  // Sell form
  const [sellShares, setSellShares] = useState('')
  const [sellPrice, setSellPrice] = useState('')
  const [sellDate, setSellDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [sellReason, setSellReason] = useState('止盈')
  const [sellNote, setSellNote] = useState('')
  const [selling, setSelling] = useState(false)
  const [sellResult, setSellResult] = useState<{ score: number; comment: string } | null>(null)
  const [sellError, setSellError] = useState('')

  const fetchPosition = useCallback(async () => {
    try {
      const res = await fetch(`/api/positions/${params.id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPosition(await res.json())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => {
    const load = async () => { await fetchPosition() }
    void load()
  }, [fetchPosition])

  const handleRefresh = async () => {
    setRefreshing(true); setRefreshError('')
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: parseInt(params.id) }),
      })
      const data = await res.json()
      const result = data.results?.[0]
      if (result?.status === 'error') setRefreshError(result.error ?? '分析失败')
      await fetchPosition()
    } catch (e) {
      setRefreshError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  const handleSell = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!position || !sellShares || !sellPrice) return
    setSelling(true); setSellError('')
    try {
      const res = await fetch('/api/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positionId: position.id,
          soldAt: sellDate,
          shares: parseFloat(sellShares),
          price: parseFloat(sellPrice),
          reason: sellReason,
          note: sellNote,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sell failed')
      setSellResult({ score: data.consistencyScore, comment: data.consistencyNote })
      await fetchPosition()
      if (data.closed) setTimeout(() => router.push('/'), 2500)
    } catch (e) {
      setSellError((e as Error).message)
    } finally {
      setSelling(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 rounded-xl border border-neutral-800 bg-neutral-900 animate-pulse" />
        ))}
      </div>
    )
  }

  if (!position) {
    return (
      <div className="text-center py-16">
        <p className="text-neutral-400">持仓不存在</p>
        <Link href="/" className="mt-4 inline-block text-sm text-indigo-400 hover:text-indigo-300">
          返回总览
        </Link>
      </div>
    )
  }

  const firstBuy = position.buyRecords[0]
  const thesisPoints: ThesisPoint[] = firstBuy?.thesisPointsJson
    ? (() => { try { return JSON.parse(firstBuy.thesisPointsJson) } catch { return [] } })()
    : []
  const latestRefresh = position.refreshLogs[0]
  const latestAnalysis: AnalysisResult | null = latestRefresh?.analysisJson
    ? (() => { try { return JSON.parse(latestRefresh.analysisJson) } catch { return null } })()
    : null

  const pnlColor = (position.realizedPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'

  return (
    <div>
      {/* ── Breadcrumb ── */}
      <div className="mb-6 flex items-center gap-2 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-300">持仓总览</Link>
        <span>/</span>
        <span className="text-neutral-200">{position.stock.name}</span>
      </div>

      {/* ── Header ── */}
      <div className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-neutral-100">{position.stock.name}</h1>
              <span className="text-sm text-neutral-500">{position.stock.symbol}</span>
              <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-500">
                {position.stock.market}
              </span>
              {position.status === 'CLOSED' && (
                <span className="rounded border border-neutral-600 px-1.5 py-0.5 text-xs text-neutral-400">
                  已平仓
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-4 text-sm text-neutral-400">
              <span>成本均价 <span className="text-neutral-200">{fmtPrice(position.avgCost)}</span></span>
              <span>持仓 <span className="text-neutral-200">{position.totalShares}</span> 股</span>
              <span>总成本 <span className="text-neutral-200">{position.totalCost.toFixed(0)}</span></span>
              {position.realizedPnl != null && (
                <span>已实现盈亏 <span className={pnlColor}>{position.realizedPnl >= 0 ? '+' : ''}{position.realizedPnl.toFixed(0)}</span></span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {latestRefresh?.verdict && (
              <span className={`rounded-full border px-3 py-1 text-sm font-medium ${VERDICT_COLOR[latestRefresh.verdict]}`}>
                {VERDICT_LABEL[latestRefresh.verdict]}
              </span>
            )}
            {position.status === 'OPEN' && (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {refreshing ? '分析中…' : '刷新分析'}
              </button>
            )}
          </div>
        </div>
        {refreshError && (
          <p className="mt-3 text-xs text-rose-400">{refreshError}</p>
        )}
        {latestAnalysis && (
          <div className="mt-4 text-sm text-neutral-300 border-t border-neutral-800 pt-4">
            <span className="text-neutral-500 text-xs">最新建议：</span> {latestAnalysis.actionSuggestion}
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="mb-6 flex gap-1 border-b border-neutral-800">
        {(['thesis', 'history', 'sell'] as TabId[]).map(tab => {
          const labels = { thesis: '买入理由', history: `刷新历史 (${position.refreshLogs.length})`, sell: '加仓/卖出' }
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {labels[tab]}
            </button>
          )
        })}
      </div>

      {/* ── Tab: Buy Thesis ── */}
      {activeTab === 'thesis' && firstBuy && (
        <div className="space-y-6">
          {/* Thesis text */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">
              买入理由原文 · {new Date(firstBuy.boughtAt).toLocaleDateString('zh-CN')} ·
              {fmtPrice(firstBuy.price)} × {firstBuy.shares} 股
            </h3>
            <p className="text-sm text-neutral-200 leading-relaxed whitespace-pre-wrap">{firstBuy.thesis}</p>
          </div>

          {/* Thesis points */}
          {thesisPoints.length > 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
              <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-4">
                可验证论点 ({thesisPoints.length} 条)
              </h3>
              <div className="space-y-3">
                {thesisPoints.map((point, i) => {
                  // Check latest analysis for this point's current status
                  const latestPoint = latestAnalysis?.thesisPoints?.[i]
                  return (
                    <div key={point.id} className="flex gap-3">
                      <span className="text-neutral-600 text-sm shrink-0 mt-0.5">{i + 1}.</span>
                      <div className="flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-neutral-200">{point.point}</p>
                          {latestPoint && (
                            <span className={`text-xs font-medium shrink-0 ${POINT_COLOR[latestPoint.status]}`}>
                              {latestPoint.status === 'HELD' ? '✓ 成立' :
                               latestPoint.status === 'WEAKENED' ? '⚠ 动摇' : '✗ 破坏'}
                            </span>
                          )}
                        </div>
                        {latestPoint?.evidence && (
                          <p className="mt-1 text-xs text-neutral-500">{latestPoint.evidence}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Buy snapshot summary */}
          {firstBuy.snapshotJson && firstBuy.snapshotJson !== '{}' && (() => {
            try {
              const snap = JSON.parse(firstBuy.snapshotJson)
              return (
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
                  <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">
                    买入时快照
                  </h3>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">价格</span>
                      <span className="text-neutral-200">{fmtPrice(snap.market?.price)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">PE(TTM)</span>
                      <span className="text-neutral-200">{snap.valuation?.peTTM?.toFixed(1) ?? 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">PB</span>
                      <span className="text-neutral-200">{snap.valuation?.pb?.toFixed(2) ?? 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">RSI(14)</span>
                      <span className="text-neutral-200">{snap.technicals?.rsi14?.toFixed(1) ?? 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">MA20偏离</span>
                      <span className="text-neutral-200">{snap.technicals?.distFromMa20Pct?.toFixed(1) ?? 'N/A'}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">数据源</span>
                      <span className="text-neutral-400 text-xs">{snap.context?.dataSource ?? 'N/A'}</span>
                    </div>
                  </div>
                </div>
              )
            } catch { return null }
          })()}
        </div>
      )}

      {/* ── Tab: Refresh History ── */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {position.refreshLogs.length === 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-12 text-center">
              <p className="text-neutral-500 text-sm">尚无刷新记录</p>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {refreshing ? '分析中…' : '立即刷新'}
              </button>
            </div>
          )}
          {position.refreshLogs.map(log => {
            const analysis: AnalysisResult | null = (() => {
              try { return JSON.parse(log.analysisJson) } catch { return null }
            })()
            return (
              <div key={log.id} className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${VERDICT_COLOR[log.verdict]}`}>
                      {VERDICT_LABEL[log.verdict]}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {new Date(log.refreshedAt).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  {analysis && (
                    <span className="text-xs text-neutral-500">
                      置信度 {Math.round(analysis.confidence * 100)}%
                    </span>
                  )}
                </div>

                {analysis && (
                  <div className="space-y-4">
                    {/* Thesis points status */}
                    <div>
                      <p className="text-xs text-neutral-500 mb-2">论点状态</p>
                      <div className="space-y-2">
                        {analysis.thesisPoints.map((p, i) => (
                          <div key={i} className="flex items-start gap-3 text-sm">
                            <span className={`text-xs font-medium shrink-0 mt-0.5 ${POINT_COLOR[p.status]}`}>
                              {p.status === 'HELD' ? '✓' : p.status === 'WEAKENED' ? '⚠' : '✗'}
                            </span>
                            <div>
                              <p className="text-neutral-300">{p.point}</p>
                              {p.evidence && <p className="text-xs text-neutral-500 mt-0.5">{p.evidence}</p>}
                            </div>
                            <span className={`ml-auto text-xs shrink-0 ${
                              p.trend === '恶化' ? 'text-rose-400' :
                              p.trend === '改善' ? 'text-emerald-400' : 'text-neutral-500'
                            }`}>{p.trend}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Trend analysis */}
                    <div>
                      <p className="text-xs text-neutral-500 mb-1">趋势分析</p>
                      <p className="text-sm text-neutral-300 leading-relaxed">{analysis.trendAnalysis}</p>
                    </div>

                    {/* News signals */}
                    {analysis.newsSignals?.length > 0 && (
                      <div>
                        <p className="text-xs text-neutral-500 mb-2">新闻信号</p>
                        <ul className="space-y-1">
                          {analysis.newsSignals.map((s, i) => (
                            <li key={i} className="text-xs text-neutral-400">· {s}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Action suggestion */}
                    <div className="border-t border-neutral-800 pt-3">
                      <p className="text-sm font-medium text-neutral-200">{analysis.actionSuggestion}</p>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Tab: Buy-more / Sell ── */}
      {activeTab === 'sell' && (
        <div className="max-w-lg space-y-6">
          {position.status === 'OPEN' && (
            <AddBuyForm
              positionId={position.id}
              currentShares={position.totalShares}
              onDone={fetchPosition}
            />
          )}
          {position.status === 'CLOSED' ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
              <p className="text-neutral-400 text-sm">该持仓已平仓</p>
              {position.sellRecords.map(sr => (
                <div key={sr.id} className="mt-4 border-t border-neutral-800 pt-4">
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">卖出时间</span>
                      <span>{new Date(sr.soldAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">价格/股数</span>
                      <span>{fmtPrice(sr.price)} × {sr.shares}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">原因</span>
                      <span>{sr.reason.split('|')[0]}</span>
                    </div>
                    {sr.consistencyScore != null && (
                      <div className="flex justify-between">
                        <span className="text-neutral-500">一致性评分</span>
                        <span className={sr.consistencyScore >= 70 ? 'text-emerald-400' : 'text-amber-400'}>
                          {sr.consistencyScore} / 100
                        </span>
                      </div>
                    )}
                  </div>
                  {sr.consistencyNote && (
                    <p className="mt-3 text-xs text-neutral-400 leading-relaxed">{sr.consistencyNote}</p>
                  )}
                </div>
              ))}
            </div>
          ) : sellResult ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6">
              <h3 className="font-semibold text-emerald-400 mb-2">卖出已记录</h3>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-neutral-400 text-sm">一致性评分</span>
                <span className={`text-lg font-semibold ${sellResult.score >= 70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {sellResult.score} / 100
                </span>
              </div>
              <p className="text-sm text-neutral-300 leading-relaxed">{sellResult.comment}</p>
            </div>
          ) : (
            <form onSubmit={handleSell} className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1.5">卖出日期</label>
                  <input type="date" value={sellDate} onChange={e => setSellDate(e.target.value)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1.5">股数</label>
                  <input type="number" value={sellShares} onChange={e => setSellShares(e.target.value)}
                    placeholder={String(position.totalShares)} min="1" max={String(position.totalShares)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1.5">卖出价</label>
                  <input type="number" value={sellPrice} onChange={e => setSellPrice(e.target.value)}
                    step="0.001" min="0"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">卖出原因</label>
                <div className="flex flex-wrap gap-2">
                  {['止盈', '止损', '逻辑破坏', '换仓', '其他'].map(r => (
                    <button key={r} type="button" onClick={() => setSellReason(r)}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        sellReason === r
                          ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300'
                          : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'
                      }`}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">补充说明（可选）</label>
                <textarea value={sellNote} onChange={e => setSellNote(e.target.value)}
                  rows={3} placeholder="详细说明卖出原因，有助于一致性评估…"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-3 text-sm text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none" />
              </div>

              {sellError && (
                <p className="text-sm text-rose-400">{sellError}</p>
              )}

              <button type="submit" disabled={selling || !sellShares || !sellPrice}
                className="rounded-lg bg-rose-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50 transition-colors">
                {selling ? '提交中，LLM评估一致性…' : '确认卖出'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
