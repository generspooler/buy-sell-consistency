'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { fmtPrice } from '@/lib/format'
import type { AddBuyAnalysis, HistoryEvent, HistoryEventType } from '@/lib/types'

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
  history: HistoryEvent[]
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

// 历史记录时间线：四类事件共用一套徽章/节点配色
const EVENT_META: Record<HistoryEventType, { label: string; dot: string; chip: string }> = {
  BUY: { label: '建仓', dot: 'bg-indigo-400', chip: 'text-indigo-300 bg-indigo-400/10 border-indigo-400/20' },
  ADD_BUY: { label: '加仓', dot: 'bg-emerald-400', chip: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20' },
  REFRESH: { label: '刷新分析', dot: 'bg-neutral-500', chip: 'text-neutral-300 bg-neutral-800 border-neutral-700' },
  SELL: { label: '卖出', dot: 'bg-rose-400', chip: 'text-rose-300 bg-rose-400/10 border-rose-400/20' },
}

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('zh-CN')
const fmtSigned = (n: number, digits = 0) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
const pnlClass = (n: number) => (n >= 0 ? 'text-emerald-400' : 'text-rose-400')

// 加仓沿用的刷新结论（加仓本身不再单独调用 LLM）
function AddBuyAnalysisBlock({ analysis }: { analysis: AddBuyAnalysis | null }) {
  if (!analysis) {
    return (
      <p className="text-xs text-neutral-600">
        加仓时尚无刷新分析可沿用
      </p>
    )
  }
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${VERDICT_COLOR[analysis.verdict]}`}>
          {VERDICT_LABEL[analysis.verdict]}
        </span>
        <span className="text-xs text-neutral-500">
          沿用 {fmtDateTime(analysis.refreshedAt)} 的刷新结论
        </span>
        {analysis.confidence != null && (
          <span className="ml-auto text-xs text-neutral-500">
            置信度 {Math.round(analysis.confidence * 100)}%
          </span>
        )}
      </div>
      {analysis.actionSuggestion && (
        <p className="mt-2 text-sm text-neutral-200">{analysis.actionSuggestion}</p>
      )}
      {analysis.trendAnalysis && (
        <p className="mt-1 text-xs text-neutral-400 leading-relaxed">{analysis.trendAnalysis}</p>
      )}
    </div>
  )
}

function TradeFacts({ price, shares, amount }: { price: number; shares: number; amount: number }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-400">
      <span>价格 <span className="text-neutral-200">{fmtPrice(price)}</span></span>
      <span>股数 <span className="text-neutral-200">{shares}</span></span>
      <span>金额 <span className="text-neutral-200">{amount.toFixed(0)}</span></span>
    </div>
  )
}

function HistoryEventCard({ event }: { event: HistoryEvent }) {
  const meta = EVENT_META[event.type]
  return (
    <div className="relative pl-8">
      <span className={`absolute left-[7px] top-5 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-4 ring-neutral-950 ${meta.dot}`} />
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="mb-3 flex items-center gap-3">
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${meta.chip}`}>
            {meta.label}
          </span>
          <span className="text-xs text-neutral-500">{fmtDateTime(event.at)}</span>
          {event.type === 'REFRESH' && (
            <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${VERDICT_COLOR[event.verdict]}`}>
              {VERDICT_LABEL[event.verdict]}
            </span>
          )}
          {event.type === 'REFRESH' && event.analysis && (
            <span className="ml-auto text-xs text-neutral-500">
              置信度 {Math.round(event.analysis.confidence * 100)}%
            </span>
          )}
          {event.type === 'SELL' && event.realizedPnl != null && (
            <span className={`ml-auto text-sm font-medium ${pnlClass(event.realizedPnl)}`}>
              已实现 {fmtSigned(event.realizedPnl)}
              {event.pnlPct != null && ` (${fmtSigned(event.pnlPct, 2)}%)`}
            </span>
          )}
        </div>

        {(event.type === 'BUY' || event.type === 'ADD_BUY') && (
          <div className="space-y-3">
            <TradeFacts price={event.price} shares={event.shares} amount={event.amount} />
            {event.thesis && (
              <div>
                <p className="mb-1 text-xs text-neutral-500">
                  {event.type === 'BUY' ? '买入理由' : '加仓理由'}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{event.thesis}</p>
              </div>
            )}
            {event.type === 'BUY' && event.thesisPoints.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs text-neutral-500">可验证论点 ({event.thesisPoints.length} 条)</p>
                <ul className="space-y-1">
                  {event.thesisPoints.map((p, i) => (
                    <li key={p.id ?? i} className="text-sm text-neutral-300">{i + 1}. {p.point}</li>
                  ))}
                </ul>
              </div>
            )}
            {event.type === 'ADD_BUY' && (
              <div>
                <p className="mb-1.5 text-xs text-neutral-500">分析结论</p>
                <AddBuyAnalysisBlock analysis={event.analysis} />
              </div>
            )}
          </div>
        )}

        {event.type === 'REFRESH' && event.analysis && (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs text-neutral-500">论点状态</p>
              <div className="space-y-2">
                {event.analysis.thesisPoints.map((p, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <span className={`mt-0.5 shrink-0 text-xs font-medium ${POINT_COLOR[p.status]}`}>
                      {p.status === 'HELD' ? '✓' : p.status === 'WEAKENED' ? '⚠' : '✗'}
                    </span>
                    <div>
                      <p className="text-neutral-300">{p.point}</p>
                      {p.evidence && <p className="mt-0.5 text-xs text-neutral-500">{p.evidence}</p>}
                    </div>
                    <span className={`ml-auto shrink-0 text-xs ${
                      p.trend === '恶化' ? 'text-rose-400' :
                      p.trend === '改善' ? 'text-emerald-400' : 'text-neutral-500'
                    }`}>{p.trend}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-neutral-500">趋势分析</p>
              <p className="text-sm leading-relaxed text-neutral-300">{event.analysis.trendAnalysis}</p>
            </div>
            {event.analysis.newsSignals?.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-neutral-500">新闻信号</p>
                <ul className="space-y-1">
                  {event.analysis.newsSignals.map((s, i) => (
                    <li key={i} className="text-xs text-neutral-400">· {s}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="border-t border-neutral-800 pt-3">
              <p className="text-sm font-medium text-neutral-200">{event.analysis.actionSuggestion}</p>
            </div>
          </div>
        )}

        {event.type === 'SELL' && (
          <div className="space-y-3">
            <TradeFacts price={event.price} shares={event.shares} amount={event.amount} />
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-400">
              <span>原因 <span className="text-neutral-200">{event.reason}</span></span>
              {event.realizedPnl == null && <span className="text-neutral-600">已实现盈亏未记录</span>}
            </div>
            {event.note && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">{event.note}</p>
            )}
            {event.consistencyScore != null && (
              <div className="border-t border-neutral-800 pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500">买卖一致性评分</span>
                  <span className={`text-sm font-semibold ${event.consistencyScore >= 70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {event.consistencyScore} / 100
                  </span>
                </div>
                {event.consistencyNote && (
                  <p className="mt-2 text-sm leading-relaxed text-neutral-300">{event.consistencyNote}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
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
  const [analysis, setAnalysis] = useState<AddBuyAnalysis | null>(null)

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
      setAnalysis(data.analysis ?? null)
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
      <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
        <div>
          <p className="text-sm font-medium text-emerald-400">加仓已记录 ✓</p>
          <p className="mt-1 text-xs text-neutral-400">
            成本均价与持仓数已更新。本次加仓未附买入理由，论点基准仍以首笔买入为准。
            本次加仓与下方分析结论已一并写入「历史记录」。
          </p>
        </div>
        <AddBuyAnalysisBlock analysis={analysis} />
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
  const history = position.history ?? []

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
          const labels = { thesis: '买入理由', history: `历史记录 (${history.length})`, sell: '加仓/卖出' }
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

      {/* ── Tab: History (历史记录) ── */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {/* 基本信息 */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-500">基本信息</h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
              <div className="flex justify-between">
                <span className="text-neutral-500">建仓日期</span>
                <span className="text-neutral-200">{new Date(position.openedAt).toLocaleDateString('zh-CN')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">状态</span>
                <span className="text-neutral-200">{position.status === 'OPEN' ? '持仓中' : '已平仓'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">成本均价</span>
                <span className="text-neutral-200">{fmtPrice(position.avgCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">持仓股数</span>
                <span className="text-neutral-200">{position.totalShares}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">总成本</span>
                <span className="text-neutral-200">{position.totalCost.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">累计已实现</span>
                <span className={position.realizedPnl != null ? pnlColor : 'text-neutral-200'}>
                  {position.realizedPnl != null ? fmtSigned(position.realizedPnl) : '—'}
                </span>
              </div>
            </div>
            <p className="mt-3 border-t border-neutral-800 pt-3 text-xs text-neutral-500">
              共 {history.length} 条记录 · 买入 {history.filter(e => e.type === 'BUY' || e.type === 'ADD_BUY').length}
              {' · '}刷新 {history.filter(e => e.type === 'REFRESH').length}
              {' · '}卖出 {history.filter(e => e.type === 'SELL').length}
            </p>
          </div>

          {history.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-12 text-center">
              <p className="text-sm text-neutral-500">尚无历史记录</p>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {refreshing ? '分析中…' : '立即刷新'}
              </button>
            </div>
          ) : (
            <div className="relative space-y-4 before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-neutral-800">
              {history.map(event => (
                <HistoryEventCard key={event.id} event={event} />
              ))}
            </div>
          )}
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
              <p className="mt-3 text-xs text-neutral-400">本次卖出、盈亏与该评分已写入「历史记录」。</p>
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
