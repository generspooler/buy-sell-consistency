'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { fmtPrice } from '@/lib/format'
import { describeTrigger, pullbackToPrice, MIN_PULLBACK_PCT } from '@/lib/reentry'
import type {
  AddBuyAnalysis,
  HistoryEvent,
  HistoryEventType,
  OptionSnapshot,
  ReentryPlan,
  StockSnapshot,
} from '@/lib/types'
import {
  NEAR_EXPIRY_DAYS,
  SIDE_LABEL,
  OptionContext,
  breakevenPrice,
  closeActionLabel,
  daysToExpiry,
  describeProgress,
  fmtStrike,
  isExpired,
  openActionLabel,
  optionContextOf,
  optionLongLabel,
  optionProgress,
} from '@/lib/options'

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
  reentryPlanJson?: string | null
}
interface Position {
  id: number; status: string; totalShares: number; avgCost: number
  totalCost: number; realizedPnl?: number; openedAt: string
  stock: Stock; buyRecords: BuyRecord[]
  refreshLogs: RefreshLog[]; sellRecords: SellRecord[]
  history: HistoryEvent[]
  // 期权（v0.4）
  assetType?: string; side?: string; multiplier?: number
  contractSymbol?: string | null; optionType?: string | null
  strike?: number | null; expiry?: string | null
  settlement?: Settlement | null
}
/** 到期待结算建议（/api/positions/[id]，仅已过到期时点的 OPEN 期权） */
interface Settlement {
  expiry: string
  underlyingClose: number | null
  basis: 'EXPIRY_CANDLE' | 'LAST_CANDLE' | 'NONE'
  outcome: 'WORTHLESS' | 'ITM' | null
  intrinsic: number | null
}
interface ThesisPoint { id: string; point: string; status?: string; evidence?: string; trend?: string }
interface AnalysisResult {
  thesisPoints: Array<{ point: string; status: string; evidence: string; trend: string }>
  verdict: string; trendAnalysis: string; newsSignals: string[]
  actionSuggestion: string; confidence: number
}
interface ReentryDraft {
  kind: 'PULLBACK' | 'PRICE'
  value: number
  pullbackPct: number
  triggerPrice: number
  shares: number
  rationale: string
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
  REENTRY: { label: '买回计划', dot: 'bg-amber-400', chip: 'text-amber-300 bg-amber-400/10 border-amber-400/20' },
}

// REENTRY 事件按流转类型细分（同一套节点，不同徽章）
const REENTRY_KIND_META: Record<string, { label: string; dot: string; chip: string }> = {
  FIRED: { label: '买回触发', dot: 'bg-amber-400', chip: 'text-amber-200 bg-amber-400/15 border-amber-400/40 font-medium' },
  EXECUTED: { label: '买回执行', dot: 'bg-emerald-400', chip: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/30' },
  EXPIRED: { label: '计划过期', dot: 'bg-neutral-500', chip: 'text-neutral-300 bg-neutral-800 border-neutral-700' },
  CANCELLED: { label: '计划取消', dot: 'bg-neutral-600', chip: 'text-neutral-400 bg-neutral-800/60 border-neutral-700' },
}

// 买回计划当前状态徽章（卖出卡与顶栏共用）
const PLAN_STATUS_META: Record<string, { label: string; chip: string }> = {
  ARMED: { label: '监控中', chip: 'text-amber-300 bg-amber-400/10 border-amber-400/30' },
  FIRED: { label: '已触发·待执行', chip: 'text-amber-200 bg-amber-400/15 border-amber-400/40 font-medium' },
  EXECUTED: { label: '已买回执行', chip: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/30' },
  EXPIRED: { label: '已过期', chip: 'text-neutral-400 bg-neutral-800/60 border-neutral-700' },
  CANCELLED: { label: '已取消', chip: 'text-neutral-400 bg-neutral-800/60 border-neutral-700' },
}

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('zh-CN')
const fmtIv = (iv?: number) => (iv != null ? `${(iv * 100).toFixed(1)}%` : 'N/A')

const SELL_REASONS = ['止盈', '止损', '逻辑破坏', '换仓', '其他']

const parseSnapshot = (raw?: string | null): StockSnapshot | null => {
  if (!raw || raw === '{}') return null
  try {
    return JSON.parse(raw) as StockSnapshot
  } catch {
    return null
  }
}
const fmtSigned = (n: number, digits = 0) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`
const pnlClass = (n: number) => (n >= 0 ? 'text-emerald-400' : 'text-rose-400')

/** 客户端侧安全解析（服务端已在 history 中解析过，这里只为 sellRecords 原始行）。 */
const parseReentryPlanJson = (raw?: string | null): ReentryPlan | null => {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as ReentryPlan
    return p?.trigger ? p : null
  } catch {
    return null
  }
}

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

function TradeFacts({ price, shares, amount, isOption }: {
  price: number; shares: number; amount: number; isOption?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-400">
      <span>{isOption ? '权利金' : '价格'} <span className="text-neutral-200">{fmtPrice(price)}</span></span>
      <span>{isOption ? '张数' : '股数'} <span className="text-neutral-200">{shares}</span></span>
      <span>金额 <span className="text-neutral-200">{amount.toFixed(0)}</span></span>
    </div>
  )
}

// 期权开平仓的标签按方向换：买方「买入开仓 / 卖出平仓」，卖方反之。
function eventLabel(event: HistoryEvent, option: OptionContext | null, fallback: string): string {
  if (!option) return fallback
  if (event.type === 'BUY') return openActionLabel(option.side)
  if (event.type === 'SELL') return closeActionLabel(option.side)
  return fallback
}

function HistoryEventCard({ event, option }: { event: HistoryEvent; option: OptionContext | null }) {
  const meta = event.type === 'REENTRY' ? REENTRY_KIND_META[event.kind] : EVENT_META[event.type]
  const isOption = option != null
  return (
    <div className={`relative pl-8 ${event.type === 'REENTRY' && event.kind === 'FIRED' ? 'ring-2 ring-amber-400/40 rounded-xl' : ''}`}>
      <span className={`absolute left-[7px] top-5 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-4 ring-neutral-950 ${meta.dot}`} />
      <div className={`rounded-xl border bg-neutral-900 p-5 ${
        event.type === 'REENTRY' && event.kind === 'FIRED' ? 'border-amber-400/40' : 'border-neutral-800'
      }`}>
        <div className="mb-3 flex items-center gap-3">
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${meta.chip}`}>
            {eventLabel(event, option, meta.label)}
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
            <TradeFacts price={event.price} shares={event.shares} amount={event.amount} isOption={isOption} />
            {event.thesis && (
              <div>
                <p className="mb-1 text-xs text-neutral-500">
                  {event.type === 'BUY' ? (isOption ? '开仓理由' : '买入理由') : '加仓理由'}
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
            <TradeFacts price={event.price} shares={event.shares} amount={event.amount} isOption={isOption} />
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
            {event.reentryPlan && (
              <div className="border-t border-neutral-800 pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500">买回计划（卖出时声明）</span>
                  {(() => {
                    const m = PLAN_STATUS_META[event.reentryPlan.status]
                    return m ? (
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${m.chip}`}>{m.label}</span>
                    ) : null
                  })()}
                </div>
                <p className="mt-1.5 text-sm text-neutral-300">
                  {describeTrigger(event.reentryPlan.trigger, event.reentryPlan.sellPrice)}
                  <span className="text-neutral-500"> · 有效 {event.reentryPlan.validDays} 天</span>
                  {event.reentryPlan.shares > 0 && (
                    <span className="text-neutral-500"> · 拟买回 {event.reentryPlan.shares} 股</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {event.reentryPlan.source === 'LLM' ? 'AI 起草' : '手动设定'} ·
                  {' '}此后每次刷新自动检查价格与论点双条件
                </p>
              </div>
            )}
          </div>
        )}

        {event.type === 'REENTRY' && (
          <div className="space-y-3">
            <p className="text-sm text-neutral-200">
              {describeTrigger(event.plan.trigger, event.plan.sellPrice)}
              <span className="text-neutral-500"> · 有效 {event.plan.validDays} 天</span>
              {event.plan.shares > 0 && (
                <span className="text-neutral-500"> · 拟买回 {event.plan.shares} 股</span>
              )}
            </p>
            {(() => {
              const text =
                event.kind === 'FIRED'
                  ? event.plan.firedNote ?? '买回条件已达成。'
                  : event.kind === 'EXECUTED'
                    ? `买回已执行：${new Date(event.plan.executedAt ?? event.at).toLocaleDateString('zh-CN')} 记录买入${
                        event.plan.executedFrom === 'FIRED'
                          ? '（触发后按计划买回）'
                          : '（未触发即提前买回，偏离声明条件）'
                      }`
                    : event.kind === 'EXPIRED'
                      ? event.plan.lastNote ?? `计划满 ${event.plan.validDays} 天有效期，自动失效。`
                      : '计划已取消。'
              return <p className="text-sm leading-relaxed text-neutral-300">{text}</p>
            })()}
            {event.kind === 'FIRED' && (
              <p className="text-xs text-amber-400/90">
                条件达成 ≠ 买回理由成立：请先在「买入理由」页核对论点状态，再决定执行或放弃。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 期权快照对比：开仓时 vs 最近刷新。开仓时的 IV / delta 是判断「IV 回落」
// 「方向对了却没赚钱」的唯一基准。
function OptionSnapshotTable({ open, latest }: { open?: OptionSnapshot; latest?: OptionSnapshot }) {
  const rows: Array<[string, (o?: OptionSnapshot) => string]> = [
    ['权利金(mark)', o => fmtPrice(o?.mark)],
    ['隐含波动率 IV', o => fmtIv(o?.iv)],
    ['Delta', o => o?.delta?.toFixed(3) ?? 'N/A'],
    ['Theta(每股每日)', o => o?.theta?.toFixed(3) ?? 'N/A'],
    ['标的价格', o => fmtPrice(o?.underlyingPrice)],
    ['距盈亏平衡', o => (o?.distToBreakevenPct != null ? `${o.distToBreakevenPct >= 0 ? '+' : ''}${o.distToBreakevenPct.toFixed(1)}%` : 'N/A')],
    ['价内/价外', o => o?.moneyness ?? 'N/A'],
    ['剩余天数', o => (o ? `${o.dte} 天` : 'N/A')],
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-neutral-500">
            <th className="py-1 text-left font-normal">期权指标</th>
            <th className="py-1 text-right font-normal">开仓时</th>
            {latest && <th className="py-1 text-right font-normal">最近刷新</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label} className="border-t border-neutral-800/70">
              <td className="py-1.5 text-neutral-500">{label}</td>
              <td className="py-1.5 text-right text-neutral-200">{f(open)}</td>
              {latest && <td className="py-1.5 text-right text-neutral-200">{f(latest)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-neutral-600">
        数据源：{open?.dataSource ?? 'N/A'}
        {latest && ` → ${latest.dataSource}`}
      </p>
    </div>
  )
}

type TabId = 'thesis' | 'history' | 'sell'

// ── 买回计划输入（卖出表单内）────────────────────────────────────────────
// 这是整个特性的入口：把「待回调买入」从一句话变成一个有数字的承诺。
// LLM 只起草，数字由用户确认后随卖出一并锁定——与论点拆解同一套人机分工。
function ReentryPlanFields({
  enabled,
  onToggle,
  positionId,
  sellPrice,
  sellShares,
  sellReason,
  sellNote,
  kind,
  setKind,
  value,
  setValue,
  shares,
  setShares,
  validDays,
  setValidDays,
  source,
  setSource,
  rationale,
  setRationale,
}: {
  enabled: boolean
  onToggle: (v: boolean) => void
  positionId: number
  sellPrice: string
  sellShares: string
  sellReason: string
  sellNote: string
  kind: 'PULLBACK' | 'PRICE'
  setKind: (v: 'PULLBACK' | 'PRICE') => void
  value: string
  setValue: (v: string) => void
  shares: string
  setShares: (v: string) => void
  validDays: string
  setValidDays: (v: string) => void
  source: 'LLM' | 'MANUAL'
  setSource: (v: 'LLM' | 'MANUAL') => void
  rationale: string
  setRationale: (v: string) => void
}) {
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState('')

  const price = parseFloat(sellPrice)
  const num = parseFloat(value)
  const triggerPrice =
    Number.isFinite(price) && Number.isFinite(num) && num > 0
      ? kind === 'PULLBACK'
        ? pullbackToPrice(price, num)
        : num
      : null
  const pullbackPct =
    triggerPrice != null && Number.isFinite(price) && price > 0
      ? ((price - triggerPrice) / price) * 100
      : null
  const belowNoiseFloor = pullbackPct != null && pullbackPct < MIN_PULLBACK_PCT

  const handleDraft = async () => {
    if (!Number.isFinite(price) || !sellShares) {
      setDraftError('请先填写卖出价与股数')
      return
    }
    setDrafting(true)
    setDraftError('')
    try {
      const res = await fetch('/api/reentry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positionId,
          price,
          shares: parseFloat(sellShares),
          reason: sellReason,
          note: sellNote,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '起草失败')
      const d: ReentryDraft = data.draft
      setKind(d.kind)
      setValue(String(d.kind === 'PULLBACK' ? d.pullbackPct || d.value : d.triggerPrice))
      if (d.shares > 0) setShares(String(d.shares))
      setRationale(d.rationale ?? '')
      setSource('LLM')
    } catch (e) {
      setDraftError((e as Error).message)
    } finally {
      setDrafting(false)
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => {
            const on = e.target.checked
            // 默认拟买回 = 本次卖出股数（最常见意图：原样买回）。
            if (on && !shares && sellShares) setShares(sellShares)
            onToggle(on)
          }}
          className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
        />
        <span>
          <span className="text-sm font-medium text-neutral-200">制定买回计划</span>
          <span className="mt-0.5 block text-xs text-neutral-500">
            打算之后买回？现在就把触发价定下来。没有触发价的买回计划等于没有计划——
            此后每次刷新会自动检查价格与论点，条件达成时提醒你。
          </span>
        </span>
      </label>

      {enabled && (
        <div className="mt-4 space-y-4 border-t border-neutral-800 pt-4">
          {/* 触发方式 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium text-neutral-300">触发条件</label>
              <button
                type="button"
                onClick={handleDraft}
                disabled={drafting}
                className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-50 transition-colors"
              >
                {drafting ? 'AI 起草中…' : '✨ AI 起草'}
              </button>
            </div>
            <div className="flex gap-2">
              {([
                ['PULLBACK', '按回撤 %'],
                ['PRICE', '按触发价'],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setKind(k); setSource('MANUAL') }}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    kind === k
                      ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                      : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1.5 block text-xs text-neutral-500">
                {kind === 'PULLBACK' ? '回撤 %' : '触发价'}
              </label>
              <input
                type="number"
                value={value}
                onChange={e => { setValue(e.target.value); setSource('MANUAL') }}
                step={kind === 'PULLBACK' ? '0.5' : '0.001'}
                min="0"
                placeholder={kind === 'PULLBACK' ? '12' : '0.000'}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-neutral-500">拟买回股数</label>
              <input
                type="number"
                value={shares}
                onChange={e => setShares(e.target.value)}
                min="0"
                placeholder={sellShares || '0'}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-neutral-500">有效期（天）</label>
              <input
                type="number"
                value={validDays}
                onChange={e => setValidDays(e.target.value)}
                min="1"
                placeholder="90"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>

          {/* 换算回显 —— 让数字的含义当场可见 */}
          {triggerPrice != null && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3 text-sm">
              <p className="text-neutral-200">
                触发价 <span className="font-semibold text-amber-300">{fmtPrice(triggerPrice)}</span>
                {pullbackPct != null && (
                  <span className="text-neutral-400">
                    {' '}（自卖出价回撤 {pullbackPct.toFixed(1)}%）
                  </span>
                )}
              </p>
              {belowNoiseFloor && (
                <p className="mt-1.5 text-xs text-amber-400/90">
                  ⚠ 低于 {MIN_PULLBACK_PCT}% 的回调多半是噪音（日波动 2-3% 的标的，
                  5 日累计波动约 5-6%）。你说过只做大笔买入——确认这个门槛值得出手？
                </p>
              )}
            </div>
          )}

          {source === 'LLM' && rationale && (
            <p className="text-xs text-neutral-500">AI 起草理由：{rationale}</p>
          )}
          {draftError && <p className="text-xs text-rose-400">{draftError}</p>}
        </div>
      )}
    </div>
  )
}

// ── Add-buy (加仓) form ──────────────────────────────────────────────────────
function AddBuyForm({
  positionId,
  currentShares,
  isOption,
  onDone,
}: {
  positionId: number
  currentShares: number
  isOption: boolean
  onDone: () => void
}) {
  const unit = isOption ? '张' : '股'
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [shares, setShares] = useState('')
  const [price, setPrice] = useState('')
  const [thesis, setThesis] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [analysis, setAnalysis] = useState<AddBuyAnalysis | null>(null)
  const [executedPlans, setExecutedPlans] = useState<Array<{
    sellRecordId: number; triggerPrice: number; executedFrom: 'ARMED' | 'FIRED'
  }>>([])

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
      setExecutedPlans(data.executedPlans ?? [])
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
            成本均价与持仓数已更新。论点基准仍以首笔{isOption ? '开仓' : '买入'}为准。
            本次加仓与下方分析结论已一并写入「历史记录」。
          </p>
        </div>
        {executedPlans.length > 0 && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">
            本笔买入已关联为买回计划执行
            {executedPlans.map(p => (
              <p key={p.sellRecordId} className="mt-1">
                {p.executedFrom === 'FIRED' ? '（触发后按计划买回）' : '（未触发即提前买回，偏离声明条件）'} ·
                触发价 {fmtPrice(p.triggerPrice)}
              </p>
            ))}
          </div>
        )}
        <AddBuyAnalysisBlock analysis={analysis} />
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <div>
        <h3 className="font-semibold text-neutral-100">加仓</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          当前持仓 {currentShares} {unit} · 成本均价将按本次加仓自动重算
          {isOption && '（同一合约、同一方向）'}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">日期</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">{isOption ? '张数' : '股数'}</label>
          <input type="number" value={shares} onChange={e => setShares(e.target.value)}
            min="1" placeholder={isOption ? '1' : '100'}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">{isOption ? '权利金 / 股' : '价格'}</label>
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
  const [sellResult, setSellResult] = useState<{
    score: number
    comment: string
    plan: ReentryPlan | null
  } | null>(null)
  const [sellError, setSellError] = useState('')

  // 买回计划（卖出表单内）
  const [planEnabled, setPlanEnabled] = useState(false)
  const [planKind, setPlanKind] = useState<'PULLBACK' | 'PRICE'>('PULLBACK')
  const [planValue, setPlanValue] = useState('')
  const [planShares, setPlanShares] = useState('')
  const [planValidDays, setPlanValidDays] = useState('90')
  const [planSource, setPlanSource] = useState<'LLM' | 'MANUAL'>('MANUAL')
  const [planRationale, setPlanRationale] = useState('')

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
      // 买回计划：只有勾选且填了有效数字才随卖出锁定。
      const planNum = parseFloat(planValue)
      const reentry =
        planEnabled && Number.isFinite(planNum) && planNum > 0
          ? {
              trigger: { kind: planKind, value: planNum, price: 0 }, // price 由服务端换算锁定
              shares: parseFloat(planShares) || 0,
              validDays: parseInt(planValidDays) || undefined,
              source: planSource,
            }
          : undefined

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
          reentry,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sell failed')
      setSellResult({
        score: data.consistencyScore,
        comment: data.consistencyNote,
        plan: data.reentryPlan ?? null,
      })
      await fetchPosition()
      // 立了买回计划就别急着跳走——确认信息（触发价、有效期）需要被读到。
      // 没有计划才沿用原来的自动返回。
      if (data.closed && !data.reentryPlan) setTimeout(() => router.push('/'), 2500)
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

  // 期权（v0.4）：合约上下文 + 最近一次期权快照（刷新优先，否则开仓快照）
  const optionCtx = optionContextOf(position, position.stock.symbol)
  const isOption = optionCtx != null
  const unit = isOption ? '张' : '股'
  const expiredPending = position.status === 'OPEN' && optionCtx != null && isExpired(optionCtx.expiry)
  const buySnapshot = parseSnapshot(firstBuy?.snapshotJson)
  const latestSnapshot = parseSnapshot(latestRefresh?.snapshotJson)
  const openOpt = buySnapshot?.option
  const latestOpt = latestSnapshot?.option
  const currentOpt = latestOpt ?? openOpt
  const progress =
    optionCtx && currentOpt
      ? optionProgress({
          side: optionCtx.side,
          optionType: optionCtx.optionType,
          strike: optionCtx.strike,
          premium: optionCtx.premium,
          openedAt: optionCtx.openedAt,
          expiry: optionCtx.expiry,
          underlyingAtOpen: openOpt?.underlyingPrice,
          underlyingNow: currentOpt.underlyingPrice,
          mark: currentOpt.mark,
          theta: currentOpt.theta,
        })
      : null
  const sellReasons = expiredPending ? ['到期作废', ...SELL_REASONS] : SELL_REASONS

  /** 到期结算：预填平仓表单并切到该页，仍由用户点确认（评分照常进行）。 */
  const prefillClose = (reason: string, price: string, note: string) => {
    setSellReason(reason)
    setSellPrice(price)
    setSellShares(String(position.totalShares))
    if (optionCtx) setSellDate(optionCtx.expiry)
    setSellNote(note)
    setActiveTab('sell')
  }

  // 已触发待执行的买回计划：整页最高优先级提示。
  const plansOnPosition = position.sellRecords.map(sr => ({
    sr,
    plan: parseReentryPlanJson(sr.reentryPlanJson),
  }))
  const firedPlan = plansOnPosition.find(x => x.plan?.status === 'FIRED')
  const hasActivePlan = plansOnPosition.some(
    x => x.plan?.status === 'FIRED' || x.plan?.status === 'ARMED'
  )

  const handleCancelPlan = async (sellRecordId: number) => {
    try {
      const res = await fetch('/api/reentry', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellRecordId }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? '取消失败')
      }
      await fetchPosition()
    } catch (e) {
      setRefreshError((e as Error).message)
    }
  }

  return (
    <div>
      {/* ── Breadcrumb ── */}
      <div className="mb-6 flex items-center gap-2 text-sm text-neutral-500">
        <Link href="/" className="hover:text-neutral-300">持仓总览</Link>
        <span>/</span>
        <span className="text-neutral-200">{position.stock.name}</span>
      </div>

      {/* ── 买回触发横幅（最高优先级）── */}
      {firedPlan?.plan && (
        <div className="mb-6 rounded-xl border border-amber-400/50 bg-amber-400/10 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-300">
                买回条件已达成 · 待执行
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-200">
                {firedPlan.plan.firedNote}
              </p>
              <p className="mt-2 text-xs text-neutral-400">
                声明于 {new Date(firedPlan.plan.soldAt).toLocaleDateString('zh-CN')}：
                {describeTrigger(firedPlan.plan.trigger, firedPlan.plan.sellPrice)}
                {firedPlan.plan.shares > 0 && ` · 拟买回 ${firedPlan.plan.shares} 股`}
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <button
                onClick={() => setActiveTab('sell')}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400 transition-colors"
              >
                去记录买回
              </button>
              <button
                onClick={() => handleCancelPlan(firedPlan.sr.id)}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
              >
                放弃该计划
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 期权到期待结算横幅（V1：价外一键作废；价内按实际结算手工记录）── */}
      {expiredPending && optionCtx && (
        <div className="mb-6 rounded-xl border border-amber-400/50 bg-amber-400/10 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-300">期权已到期 · 待结算</p>
              {(() => {
                const st = position.settlement
                if (!st || st.outcome == null || st.underlyingClose == null) {
                  return (
                    <p className="mt-1.5 text-sm leading-relaxed text-neutral-200">
                      未取到到期日标的收盘价，请按券商实际结算记录平仓。
                    </p>
                  )
                }
                const basis =
                  st.basis === 'EXPIRY_CANDLE'
                    ? `到期日 ${st.expiry} 标的收盘 ${fmtPrice(st.underlyingClose)}`
                    : `到期日 K 线暂缺，按到期前最后收盘 ${fmtPrice(st.underlyingClose)} 估算`
                return (
                  <p className="mt-1.5 text-sm leading-relaxed text-neutral-200">
                    {basis}，行权价 {fmtStrike(optionCtx.strike)}：
                    {st.outcome === 'WORTHLESS'
                      ? `价外到期，合约作废——${optionCtx.side === 'LONG' ? '买方损失全部权利金' : '卖方保留全部权利金'}。`
                      : `价内 ${fmtPrice(st.intrinsic)} / 股，合约多半已${optionCtx.side === 'LONG' ? '自动行权' : '被指派'}。当前版本不自动处理行权 / 指派：请按券商实际结算价记录平仓（原因选「其他」），对应的正股交易另行记录。`}
                  </p>
                )
              })()}
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              {position.settlement?.outcome === 'WORTHLESS' ? (
                <button
                  onClick={() => prefillClose('到期作废', '0', '')}
                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400 transition-colors"
                >
                  按到期作废结算
                </button>
              ) : (
                <button
                  onClick={() =>
                    prefillClose(
                      '其他',
                      position.settlement?.intrinsic != null ? position.settlement.intrinsic.toFixed(2) : '',
                      position.settlement?.intrinsic != null
                        ? `价内到期${optionCtx.side === 'LONG' ? '行权' : '被指派'}，按内在价值 ${position.settlement.intrinsic.toFixed(2)} 结算`
                        : ''
                    )
                  }
                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400 transition-colors"
                >
                  去记录结算
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="mb-6 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-neutral-100">
                {optionCtx ? optionLongLabel(optionCtx) : position.stock.name}
              </h1>
              <span className="text-sm text-neutral-500">
                {optionCtx ? position.stock.name : position.stock.symbol}
              </span>
              <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-500">
                {optionCtx ? `${position.stock.market} · 期权` : position.stock.market}
              </span>
              {optionCtx && (
                <span className={`rounded border px-1.5 py-0.5 text-xs ${
                  optionCtx.side === 'SHORT'
                    ? 'border-violet-400/30 bg-violet-400/10 text-violet-300'
                    : 'border-sky-400/30 bg-sky-400/10 text-sky-300'
                }`}>
                  {SIDE_LABEL[optionCtx.side]}
                </span>
              )}
              {optionCtx && position.status === 'OPEN' && !expiredPending && (() => {
                const dte = daysToExpiry(optionCtx.expiry)
                return (
                  <span className={`rounded border px-1.5 py-0.5 text-xs ${
                    dte <= NEAR_EXPIRY_DAYS
                      ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
                      : 'border-neutral-700 text-neutral-400'
                  }`}>
                    剩 {dte} 天
                  </span>
                )
              })()}
              {position.status === 'CLOSED' && (
                <span className="rounded border border-neutral-600 px-1.5 py-0.5 text-xs text-neutral-400">
                  已平仓
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-4 text-sm text-neutral-400">
              <span>{isOption ? '开仓均价（权利金）' : '成本均价'} <span className="text-neutral-200">{fmtPrice(position.avgCost)}</span></span>
              <span>持仓 <span className="text-neutral-200">{position.totalShares}</span> {unit}</span>
              <span>
                {optionCtx?.side === 'SHORT' ? '收取权利金' : '总成本'}{' '}
                <span className="text-neutral-200">{position.totalCost.toFixed(0)}</span>
              </span>
              {position.realizedPnl != null && (
                <span>已实现盈亏 <span className={pnlColor}>{position.realizedPnl >= 0 ? '+' : ''}{position.realizedPnl.toFixed(0)}</span></span>
              )}
            </div>
            {optionCtx && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-400">
                <span>
                  到期盈亏平衡{' '}
                  <span className="text-neutral-200">
                    {fmtPrice(breakevenPrice(optionCtx.optionType, optionCtx.strike, optionCtx.premium))}
                  </span>
                </span>
                {currentOpt && (
                  <span>
                    权利金 <span className="text-neutral-200">{fmtPrice(currentOpt.mark)}</span>
                    {' · '}IV {fmtIv(currentOpt.iv)} · Δ {currentOpt.delta?.toFixed(2) ?? 'N/A'}
                    {' · '}标的 {fmtPrice(currentOpt.underlyingPrice)}
                    <span className="text-neutral-600">（{latestOpt ? '最近刷新' : '开仓快照'} {fmtDateTime(currentOpt.dataTime)}）</span>
                  </span>
                )}
                {progress && position.status === 'OPEN' && !expiredPending && (
                  <span className="basis-full text-neutral-300">{describeProgress(progress, optionCtx.side)}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {latestRefresh?.verdict && (
              <span className={`rounded-full border px-3 py-1 text-sm font-medium ${VERDICT_COLOR[latestRefresh.verdict]}`}>
                {VERDICT_LABEL[latestRefresh.verdict]}
              </span>
            )}
            {expiredPending ? null : position.status === 'OPEN' ? (
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {refreshing ? '分析中…' : '刷新分析'}
              </button>
            ) : hasActivePlan ? (
              // 已平仓但仍有买回计划：走轻量检查（不跑 LLM，只核价格与论点闸门）
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/20 disabled:opacity-50 transition-colors"
              >
                {refreshing ? '检查中…' : '检查买回计划'}
              </button>
            ) : null}
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
          const labels = {
            thesis: isOption ? '开仓理由' : '买入理由',
            history: `历史记录 (${history.length})`,
            sell: isOption ? '加仓/平仓' : '加仓/卖出',
          }
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
              {isOption ? '开仓' : '买入'}理由原文 · {new Date(firstBuy.boughtAt).toLocaleDateString('zh-CN')} ·
              {fmtPrice(firstBuy.price)} × {firstBuy.shares} {unit}
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
                    {isOption ? '开仓时快照（标的）' : '买入时快照'}
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
                  {isOption && (openOpt || latestOpt) && (
                    <div className="mt-4 border-t border-neutral-800 pt-4">
                      <OptionSnapshotTable open={openOpt} latest={latestOpt} />
                    </div>
                  )}
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
                <span className="text-neutral-500">{isOption ? '开仓均价' : '成本均价'}</span>
                <span className="text-neutral-200">{fmtPrice(position.avgCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">{isOption ? '持仓张数' : '持仓股数'}</span>
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
              共 {history.length} 条记录 · {isOption ? '开仓' : '买入'} {history.filter(e => e.type === 'BUY' || e.type === 'ADD_BUY').length}
              {' · '}刷新 {history.filter(e => e.type === 'REFRESH').length}
              {' · '}{isOption ? '平仓' : '卖出'} {history.filter(e => e.type === 'SELL').length}
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
                <HistoryEventCard key={event.id} event={event} option={optionCtx} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Buy-more / Sell ── */}
      {activeTab === 'sell' && (
        <div className="max-w-lg space-y-6">
          {position.status === 'OPEN' && !expiredPending && (
            <AddBuyForm
              positionId={position.id}
              currentShares={position.totalShares}
              isOption={isOption}
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
                      <span className="text-neutral-500">{isOption ? '权利金/张数' : '价格/股数'}</span>
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
              <h3 className="font-semibold text-emerald-400 mb-2">{isOption ? '平仓' : '卖出'}已记录</h3>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-neutral-400 text-sm">一致性评分</span>
                <span className={`text-lg font-semibold ${sellResult.score >= 70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {sellResult.score} / 100
                </span>
              </div>
              <p className="text-sm text-neutral-300 leading-relaxed">{sellResult.comment}</p>
              {sellResult.plan && (
                <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
                  <p className="text-sm font-medium text-amber-300">买回计划已锁定 ✓</p>
                  <p className="mt-1 text-sm text-neutral-200">
                    {describeTrigger(sellResult.plan.trigger, sellResult.plan.sellPrice)}
                  </p>
                  <p className="mt-1 text-xs text-neutral-400">
                    有效 {sellResult.plan.validDays} 天
                    {sellResult.plan.shares > 0 && ` · 拟买回 ${sellResult.plan.shares} 股`}
                    {' '}· 此后每次刷新自动检查（价格 × 论点双条件），触发时在总览页高亮提醒
                  </p>
                </div>
              )}
              <p className="mt-3 text-xs text-neutral-400">本次{isOption ? '平仓' : '卖出'}、盈亏与该评分已写入「历史记录」。</p>
            </div>
          ) : (
            <form onSubmit={handleSell} className="space-y-5">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1.5">{isOption ? '平仓日期' : '卖出日期'}</label>
                  <input type="date" value={sellDate} onChange={e => setSellDate(e.target.value)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1.5">{isOption ? '张数' : '股数'}</label>
                  <input type="number" value={sellShares} onChange={e => setSellShares(e.target.value)}
                    placeholder={String(position.totalShares)} min="1" max={String(position.totalShares)}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                    {isOption ? '平仓权利金' : '卖出价'}
                  </label>
                  <input type="number" value={sellPrice} onChange={e => setSellPrice(e.target.value)}
                    disabled={sellReason === '到期作废'}
                    step="0.001" min="0"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">
                  {isOption ? '平仓原因' : '卖出原因'}
                </label>
                <div className="flex flex-wrap gap-2">
                  {sellReasons.map(r => (
                    <button key={r} type="button" onClick={() => {
                      setSellReason(r)
                      if (r === '到期作废') setSellPrice('0')
                    }}
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

              {!isOption && <ReentryPlanFields
                enabled={planEnabled}
                onToggle={setPlanEnabled}
                positionId={position.id}
                sellPrice={sellPrice}
                sellShares={sellShares}
                sellReason={sellReason}
                sellNote={sellNote}
                kind={planKind}
                setKind={setPlanKind}
                value={planValue}
                setValue={setPlanValue}
                shares={planShares}
                setShares={setPlanShares}
                validDays={planValidDays}
                setValidDays={setPlanValidDays}
                source={planSource}
                setSource={setPlanSource}
                rationale={planRationale}
                setRationale={setPlanRationale}
              />}
              {isOption && sellReason === '到期作废' && (
                <p className="text-xs text-neutral-500">
                  到期作废按 0 结算：{optionCtx?.side === 'SHORT' ? '卖方保留全部权利金' : '买方损失全部权利金'}。
                </p>
              )}

              {sellError && (
                <p className="text-sm text-rose-400">{sellError}</p>
              )}

              <button type="submit" disabled={selling || !sellShares || !sellPrice}
                className="rounded-lg bg-rose-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50 transition-colors">
                {selling ? '提交中，LLM评估一致性…' : isOption ? `确认${closeActionLabel(optionCtx?.side)}` : '确认卖出'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
