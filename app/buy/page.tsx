'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { fmtPrice } from '@/lib/format'

interface SearchResult {
  symbol: string
  name: string
  market: string
}

interface ThesisPoint {
  id: string
  point: string
}

export default function BuyPage() {
  const router = useRouter()

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [boughtAt, setBoughtAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [shares, setShares] = useState('')
  const [price, setPrice] = useState('')
  const [thesis, setThesis] = useState('')

  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotJson, setSnapshotJson] = useState('')
  const [snapshotInfo, setSnapshotInfo] = useState<{ price: number; time: string } | null>(null)
  const [snapshotError, setSnapshotError] = useState('')

  // Phase: form → saving → extracting → confirm
  const [phase, setPhase] = useState<'form' | 'extracting' | 'confirm'>('form')
  const [savedIds, setSavedIds] = useState<{ positionId: number; buyRecordId: number } | null>(null)
  const [extractError, setExtractError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [thesisPoints, setThesisPoints] = useState<ThesisPoint[]>([])
  const [submitError, setSubmitError] = useState('')

  // Debounced search
  useEffect(() => {
    if (query.length < 1) return
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        setSearchResults(Array.isArray(data) ? data : [])
      } catch {}
      setSearching(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Elapsed-seconds timer while extracting
  useEffect(() => {
    if (phase !== 'extracting') return
    const t = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  const handleSelect = (r: SearchResult) => {
    setSelected(r)
    setQuery(r.name)
    setSearchResults([])
    setSnapshotJson('')
    setSnapshotInfo(null)
    setSnapshotError('')
  }

  const handleFetchSnapshot = async () => {
    if (!selected) return
    setSnapshotLoading(true)
    setSnapshotError('')
    try {
      const res = await fetch(
        `/api/snapshot?symbol=${encodeURIComponent(selected.symbol)}&market=${selected.market}`
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Snapshot failed')
      setSnapshotJson(JSON.stringify(data))
      setSnapshotInfo({
        price: data.market?.price ?? 0,
        time: data.context?.dataTime ?? '',
      })
    } catch (e) {
      setSnapshotError((e as Error).message)
    } finally {
      setSnapshotLoading(false)
    }
  }

  // Step 1: save the buy record (fast — no LLM), then kick off extraction
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected || !shares || !price || !thesis) return
    setSubmitError('')
    try {
      const res = await fetch('/api/trades?extractPoints=0', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selected.symbol,
          name: selected.name,
          market: selected.market,
          boughtAt,
          shares: parseFloat(shares),
          price: parseFloat(price),
          thesis,
          snapshotJson: snapshotJson || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')
      setSavedIds({ positionId: data.positionId, buyRecordId: data.buyRecordId })

      // Step 2: LLM extraction in background
      setElapsed(0)
      setPhase('extracting')
      try {
        const res2 = await fetch('/api/thesis-points', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ buyRecordId: data.buyRecordId }),
        })
        const data2 = await res2.json()
        if (!res2.ok) throw new Error(data2.error ?? 'Extraction failed')
        setThesisPoints(data2.thesisPoints ?? [])
      } catch (err) {
        setExtractError((err as Error).message)
        setThesisPoints([])
      }
      setPhase('confirm')
    } catch (e) {
      setSubmitError((e as Error).message)
    }
  }

  // Step 3: save user-edited points
  const handleConfirmPoints = async () => {
    if (!savedIds) return
    try {
      await fetch('/api/thesis-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyRecordId: savedIds.buyRecordId, points: thesisPoints }),
      })
    } catch {}
    router.push(`/position/${savedIds.positionId}`)
  }

  const amount =
    shares && price ? (parseFloat(shares) * parseFloat(price)).toFixed(2) : null

  // ── Phase: extracting (record saved, LLM working) ──
  if (phase === 'extracting') {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-500" />
          <h2 className="text-lg font-semibold">买入记录已保存 ✓</h2>
          <p className="mt-2 text-sm text-neutral-400">
            正在让 LLM 拆解买入理由为可验证论点…
          </p>
          <p className="mt-1 text-xs text-neutral-600">
            通常需要 30~90 秒，期间可以离开此页面（可稍后在持仓详情中补充拆解）
          </p>
          <p className="mt-4 font-mono text-2xl text-indigo-400">{elapsed}s</p>
        </div>
      </div>
    )
  }

  // ── Phase: confirm points (extraction done or failed) ──
  if (phase === 'confirm' && savedIds) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-semibold text-neutral-100 mb-1">
            买入记录已保存
          </h2>
          {extractError ? (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">
              论点拆解失败：{extractError.slice(0, 120)}
              <br />
              可以手动添加论点，或稍后在持仓详情页重新拆解。
            </div>
          ) : (
            <p className="text-sm text-neutral-400">
              请确认/修正以下论点（它们将成为后续每次刷新的检验基准）：
            </p>
          )}
          <div className="mt-4 space-y-2">
            {thesisPoints.map((p, i) => (
              <div key={p.id} className="flex gap-2 items-start">
                <span className="text-neutral-500 text-sm shrink-0 mt-1.5">{i + 1}.</span>
                <textarea
                  value={p.point}
                  onChange={e => {
                    const next = [...thesisPoints]
                    next[i] = { ...p, point: e.target.value }
                    setThesisPoints(next)
                  }}
                  rows={2}
                  className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none leading-relaxed"
                />
                <button
                  onClick={() => setThesisPoints(pts => pts.filter((_, j) => j !== i))}
                  className="mt-1 text-neutral-600 hover:text-rose-400 text-sm"
                  title="删除"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setThesisPoints(pts => [
                  ...pts,
                  { id: String(Date.now()), point: '' },
                ])
              }
              className="text-sm text-indigo-400 hover:text-indigo-300"
            >
              + 添加论点
            </button>
          </div>
          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={handleConfirmPoints}
              className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              确认并进入持仓
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Phase: form ──
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">记录买入</h1>
        <p className="mt-1 text-sm text-neutral-500">
          完整记录买入理由，系统将自动拆解为可验证论点
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Stock search */}
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">
            股票搜索
          </label>
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setSearchResults([]) }}
              placeholder="输入代码或名称，如 贵州茅台 / AAPL"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            {searching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500">
                搜索中…
              </span>
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="mt-1 rounded-lg border border-neutral-700 bg-neutral-900 overflow-hidden">
              {searchResults.map(r => (
                <button
                  key={r.symbol}
                  type="button"
                  onClick={() => handleSelect(r)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-neutral-800 transition-colors"
                >
                  <span className="text-neutral-200">{r.name}</span>
                  <div className="flex items-center gap-2 text-neutral-500">
                    <span>{r.symbol}</span>
                    <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs">
                      {r.market}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
          {selected && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-emerald-400">
                ✓ {selected.name} ({selected.symbol})
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelected(null)
                  setQuery('')
                }}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                重新选择
              </button>
            </div>
          )}
        </div>

        {/* Date / shares / price */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              买入日期
            </label>
            <input
              type="date"
              value={boughtAt}
              onChange={e => setBoughtAt(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              股数
            </label>
            <input
              type="number"
              value={shares}
              onChange={e => setShares(e.target.value)}
              placeholder="100"
              min="1"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              买入价格
            </label>
            <input
              type="number"
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="1800.000"
              step="0.001"
              min="0"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>
        {amount && (
          <p className="text-xs text-neutral-500 -mt-4">
            合计金额：
            {parseFloat(amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
          </p>
        )}

        {/* Snapshot */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-neutral-300">
              数据快照（买入时刻）
            </label>
            <button
              type="button"
              disabled={!selected || snapshotLoading}
              onClick={handleFetchSnapshot}
              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 transition-colors"
            >
              {snapshotLoading ? '采集中…' : '自动采集当前快照'}
            </button>
          </div>
          {snapshotInfo && (
            <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 px-4 py-2 text-xs text-neutral-400">
              快照采集成功 · 现价{' '}
              <span className="text-neutral-200">{fmtPrice(snapshotInfo.price)}</span> ·{' '}
              {new Date(snapshotInfo.time).toLocaleString('zh-CN')}
            </div>
          )}
          {snapshotError && (
            <p className="text-xs text-amber-400">
              {snapshotError}（买入理由仍可提交，快照留空）
            </p>
          )}
        </div>

        {/* Thesis */}
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-1.5">
            买入理由 <span className="text-rose-400">*</span>
          </label>
          <textarea
            value={thesis}
            onChange={e => setThesis(e.target.value)}
            rows={6}
            placeholder={`详细描述你的买入逻辑。例如：
- 公司钠电池产能预计2024Q4落地，打开第二增长曲线
- 当前PE 25x 处于历史低位25%分位，估值安全边际充分
- 行业补贴政策2025年持续，竞争格局向头部集中
- 三季度营收增速30%+，盈利质量持续改善`}
            required
            className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-3 text-sm text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed"
          />
          <p className="mt-1 text-xs text-neutral-600">
            提交后记录立即保存；LLM 拆解论点约需 30~90 秒，独立进行
          </p>
        </div>

        {/* Submit */}
        {submitError && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
            {submitError}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={!selected || !shares || !price || !thesis}
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            保存买入记录
          </button>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="text-sm text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  )
}
