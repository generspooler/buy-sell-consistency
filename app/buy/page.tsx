'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { fmtPrice } from '@/lib/format'
import {
  DEFAULT_OPTION_MULTIPLIER,
  breakevenPrice,
  buildOccSymbol,
  fmtStrike,
  optionLongLabel,
} from '@/lib/options'

interface SearchResult {
  symbol: string
  name: string
  market: string
}

interface ThesisPoint {
  id: string
  point: string
}

/** /api/options/chain 的精简报价 */
interface ChainQuote {
  contractSymbol: string
  bid?: number
  ask?: number
  mark?: number
  last?: number
  iv?: number
  delta?: number
  openInterest?: number
  volume?: number
}
interface StrikeRow { strike: number; call?: ChainQuote; put?: ChainQuote }
interface ChainMeta {
  underlyingPrice?: number
  underlyingIv30?: number
  source: string
  hasGreeks: boolean
  degraded: boolean
  expiries: Array<{ date: string; dte: number }>
}

const toggleClass = (active: boolean) =>
  `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    active
      ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300'
      : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'
  }`

const fmtIvPct = (iv?: number) => (iv != null ? `${(iv * 100).toFixed(1)}%` : '—')

/** 期权链首拉约 10 秒：默认选「平值」行权价，让表单一打开就有可用的值。 */
function nearestStrike(rows: StrikeRow[], price?: number): number | null {
  if (rows.length === 0) return null
  if (price == null) return rows[Math.floor(rows.length / 2)].strike
  return rows.reduce((best, r) =>
    Math.abs(r.strike - price) < Math.abs(best.strike - price) ? r : best
  ).strike
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

  // 期权（v0.4）：仅美股。一张合约 = 一个持仓。
  const [instrument, setInstrument] = useState<'STOCK' | 'OPTION'>('STOCK')
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG')
  const [optionType, setOptionType] = useState<'CALL' | 'PUT'>('CALL')
  const [chain, setChain] = useState<ChainMeta | null>(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [chainError, setChainError] = useState('')
  const [expiry, setExpiry] = useState('')
  const [strikes, setStrikes] = useState<StrikeRow[]>([])
  const [strikesLoading, setStrikesLoading] = useState(false)
  const [strike, setStrike] = useState('')
  const [priceTouched, setPriceTouched] = useState(false)

  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotJson, setSnapshotJson] = useState('')
  const [snapshotInfo, setSnapshotInfo] = useState<{
    price: number
    time: string
    option?: { mark?: number; iv?: number; delta?: number; source: string }
  } | null>(null)
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

  const isOption = instrument === 'OPTION'
  const strikeRow = strikes.find(r => r.strike === parseFloat(strike))
  const quote = optionType === 'CALL' ? strikeRow?.call : strikeRow?.put
  const contractSymbol =
    isOption && selected && expiry && parseFloat(strike) > 0
      ? buildOccSymbol(selected.symbol, expiry, optionType, parseFloat(strike))
      : null

  // 快照只对应一张合约——合约一变，旧快照作废（服务端也会再核一次）。
  const clearSnapshot = () => {
    setSnapshotJson('')
    setSnapshotInfo(null)
    setSnapshotError('')
  }

  /** 选中合约后带入中间价作为默认权利金；用户手改过就不再覆盖。 */
  const prefillPremium = (q?: ChainQuote) => {
    if (!priceTouched && q?.mark != null) setPrice(q.mark.toFixed(2))
  }

  const loadStrikes = async (symbol: string, exp: string, underlyingPrice?: number) => {
    setStrikesLoading(true)
    try {
      const res = await fetch(
        `/api/options/chain?underlying=${encodeURIComponent(symbol)}&expiry=${exp}`
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '期权链获取失败')
      const rows: StrikeRow[] = data.strikes ?? []
      setStrikes(rows)
      const atm = nearestStrike(rows, underlyingPrice ?? data.underlyingPrice)
      setStrike(atm != null ? String(atm) : '')
      const row = rows.find(r => r.strike === atm)
      prefillPremium(optionType === 'CALL' ? row?.call : row?.put)
    } catch (e) {
      setChainError((e as Error).message)
    } finally {
      setStrikesLoading(false)
    }
  }

  // 期权链：选中美股并切到「期权」时拉取（CBOE 首拉约 10 秒，之后 5 分钟内走缓存）。
  // 默认到期日取第一个 ≥ 7 天的，避开当周即将到期的合约。
  const loadChain = async (symbol: string) => {
    setChain(null)
    setChainError('')
    setStrikes([])
    setExpiry('')
    setStrike('')
    setChainLoading(true)
    try {
      const res = await fetch(`/api/options/chain?underlying=${encodeURIComponent(symbol)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '期权链获取失败')
      if (!data.expiries?.length) throw new Error('该标的没有可交易的期权')
      setChain(data)
      const first = data.expiries.find((e: { dte: number }) => e.dte >= 7) ?? data.expiries[0]
      setExpiry(first.date)
      await loadStrikes(symbol, first.date, data.underlyingPrice)
    } catch (e) {
      setChainError((e as Error).message)
    } finally {
      setChainLoading(false)
    }
  }

  const handleInstrument = (next: 'STOCK' | 'OPTION') => {
    if (next === instrument) return
    setInstrument(next)
    clearSnapshot()
    setPrice('')
    setPriceTouched(false)
    if (next === 'OPTION' && selected?.market === 'US') void loadChain(selected.symbol)
  }

  const handleSelect = (r: SearchResult) => {
    setSelected(r)
    setQuery(r.name)
    setSearchResults([])
    clearSnapshot()
    if (r.market !== 'US') setInstrument('STOCK')
    else if (isOption) void loadChain(r.symbol)
  }

  const handleExpiry = (exp: string) => {
    setExpiry(exp)
    clearSnapshot()
    if (selected && chain) void loadStrikes(selected.symbol, exp, chain.underlyingPrice)
  }

  const handleStrike = (value: string) => {
    setStrike(value)
    clearSnapshot()
    const row = strikes.find(r => r.strike === parseFloat(value))
    prefillPremium(optionType === 'CALL' ? row?.call : row?.put)
  }

  const handleOptionType = (t: 'CALL' | 'PUT') => {
    setOptionType(t)
    clearSnapshot()
    prefillPremium(t === 'CALL' ? strikeRow?.call : strikeRow?.put)
  }

  const handleFetchSnapshot = async () => {
    if (!selected) return
    if (isOption && !contractSymbol) return
    setSnapshotLoading(true)
    setSnapshotError('')
    try {
      const optionQuery =
        isOption && contractSymbol
          ? `&contract=${contractSymbol}${parseFloat(price) > 0 ? `&premium=${parseFloat(price)}` : ''}`
          : ''
      const res = await fetch(
        `/api/snapshot?symbol=${encodeURIComponent(selected.symbol)}&market=${selected.market}${optionQuery}`
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Snapshot failed')
      setSnapshotJson(JSON.stringify(data))
      setSnapshotInfo({
        price: data.market?.price ?? 0,
        time: data.context?.dataTime ?? '',
        option: data.option
          ? { mark: data.option.mark, iv: data.option.iv, delta: data.option.delta, source: data.option.dataSource }
          : undefined,
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
    if (isOption && !contractSymbol) return
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
          ...(isOption
            ? {
                assetType: 'OPTION',
                side,
                option: {
                  optionType,
                  strike: parseFloat(strike),
                  expiry,
                  multiplier: DEFAULT_OPTION_MULTIPLIER,
                },
              }
            : {}),
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

  const multiplier = isOption ? DEFAULT_OPTION_MULTIPLIER : 1
  const amount =
    shares && price ? (parseFloat(shares) * parseFloat(price) * multiplier).toFixed(2) : null
  const premiumNum = parseFloat(price)
  const strikeNum = parseFloat(strike)
  const breakeven =
    isOption && premiumNum > 0 && strikeNum > 0
      ? breakevenPrice(optionType, strikeNum, premiumNum)
      : null
  const underlyingPrice = chain?.underlyingPrice

  // ── Phase: extracting (record saved, LLM working) ──
  if (phase === 'extracting') {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-500" />
          <h2 className="text-lg font-semibold">{isOption ? '开仓' : '买入'}记录已保存 ✓</h2>
          <p className="mt-2 text-sm text-neutral-400">
            正在让 LLM 拆解{isOption ? '开仓' : '买入'}理由为可验证论点…
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
            {isOption ? '开仓' : '买入'}记录已保存
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
        <h1 className="text-2xl font-semibold tracking-tight">
          {isOption ? '记录期权开仓' : '记录买入'}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          完整记录{isOption ? '开仓' : '买入'}理由，系统将自动拆解为可验证论点
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
                  setChain(null)
                  setStrikes([])
                  clearSnapshot()
                }}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                重新选择
              </button>
            </div>
          )}
        </div>

        {/* 交易品种：正股 | 期权（仅美股） */}
        {selected?.market === 'US' && (
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">交易品种</label>
            <div className="flex gap-2">
              {([['STOCK', '正股'], ['OPTION', '期权']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => handleInstrument(k)} className={toggleClass(instrument === k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 期权合约 */}
        {isOption && selected && (
          <div className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-neutral-500">
              <span>
                标的 <span className="text-neutral-200">{selected.symbol}</span>
                {underlyingPrice != null && (
                  <> · 现价 <span className="text-neutral-200">{fmtPrice(underlyingPrice)}</span></>
                )}
                {chain?.underlyingIv30 != null && <> · IV30 {chain.underlyingIv30.toFixed(1)}%</>}
              </span>
              {chain && (
                <span>
                  {chain.source}{chain.degraded ? '（降级·无希腊值）' : ''} · 延迟约 15 分钟
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">方向</label>
                <div className="flex gap-2">
                  {([['LONG', '买入开仓'], ['SHORT', '卖出开仓']] as const).map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setSide(k)} className={toggleClass(side === k)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">类型</label>
                <div className="flex gap-2">
                  {([['CALL', 'Call'], ['PUT', 'Put']] as const).map(([k, label]) => (
                    <button key={k} type="button" onClick={() => handleOptionType(k)} className={toggleClass(optionType === k)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {chainLoading && (
              <p className="text-xs text-neutral-500">正在加载期权链…（首次约 10 秒，之后 5 分钟内走缓存）</p>
            )}
            {chainError && (
              <p className="text-xs text-amber-400">{chainError}——可手动填写到期日与行权价</p>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">到期日</label>
                {chain && !chainError ? (
                  <select value={expiry} onChange={e => handleExpiry(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    {chain.expiries.map(e => (
                      <option key={e.date} value={e.date}>
                        {e.date}（{e.dte} 天）
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="date"
                    value={expiry}
                    onChange={e => { setExpiry(e.target.value); clearSnapshot() }}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1.5">行权价</label>
                {strikes.length > 0 ? (
                  <select value={strike} onChange={e => handleStrike(e.target.value)} className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    {strikes.map(r => {
                      const q = optionType === 'CALL' ? r.call : r.put
                      return (
                        <option key={r.strike} value={r.strike}>
                          {fmtStrike(r.strike)}
                          {q?.mark != null ? ` · ${q.mark.toFixed(2)}` : ''}
                          {q?.delta != null ? ` · Δ${q.delta.toFixed(2)}` : ''}
                        </option>
                      )
                    })}
                  </select>
                ) : (
                  <input
                    type="number"
                    value={strike}
                    onChange={e => { setStrike(e.target.value); clearSnapshot() }}
                    disabled={strikesLoading}
                    placeholder={strikesLoading ? '加载中…' : '240'}
                    step="0.5"
                    min="0"
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                )}
              </div>
            </div>

            {quote && (
              <p className="text-xs text-neutral-400">
                bid {fmtPrice(quote.bid)} / ask {fmtPrice(quote.ask)} · IV {fmtIvPct(quote.iv)}
                {' · '}Δ {quote.delta?.toFixed(2) ?? '—'} · 持仓量 {quote.openInterest?.toLocaleString() ?? '—'}
              </p>
            )}
            {contractSymbol && (
              <p className="text-xs text-neutral-500">
                合约 <span className="text-neutral-300">{optionLongLabel({ underlying: selected.symbol, optionType, strike: strikeNum, expiry })}</span>
                {' · '}{contractSymbol} · 每张 {DEFAULT_OPTION_MULTIPLIER} 股
              </p>
            )}
          </div>
        )}

        {/* Date / shares / price */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {isOption ? '开仓日期' : '买入日期'}
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
              {isOption ? '张数' : '股数'}
            </label>
            <input
              type="number"
              value={shares}
              onChange={e => setShares(e.target.value)}
              placeholder={isOption ? '1' : '100'}
              min="1"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1.5">
              {isOption ? '权利金 / 股' : '买入价格'}
            </label>
            <input
              type="number"
              value={price}
              onChange={e => { setPrice(e.target.value); setPriceTouched(true) }}
              placeholder={isOption ? '0.00' : '1800.000'}
              step="0.001"
              min="0"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>
        {amount && (
          <p className="text-xs text-neutral-500 -mt-4">
            {isOption
              ? `${side === 'SHORT' ? '收取' : '支付'}权利金：${shares} 张 × ${price} × ${DEFAULT_OPTION_MULTIPLIER} = $`
              : '合计金额：'}
            {parseFloat(amount).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
            {breakeven != null && (
              <span className="ml-2 text-neutral-400">
                · 到期盈亏平衡 {fmtPrice(breakeven)}
                {underlyingPrice != null && underlyingPrice > 0 &&
                  `（标的需 ${breakeven >= underlyingPrice ? '+' : ''}${(((breakeven - underlyingPrice) / underlyingPrice) * 100).toFixed(1)}%）`}
              </span>
            )}
          </p>
        )}

        {/* Snapshot */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-neutral-300">
              数据快照（{isOption ? '开仓' : '买入'}时刻）
            </label>
            <button
              type="button"
              disabled={!selected || snapshotLoading || (isOption && !contractSymbol)}
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
              {snapshotInfo.option && (
                <span className="block mt-0.5">
                  期权 mark <span className="text-neutral-200">{fmtPrice(snapshotInfo.option.mark)}</span>
                  {' · '}IV {fmtIvPct(snapshotInfo.option.iv)} · Δ {snapshotInfo.option.delta?.toFixed(2) ?? '—'}
                  {' · '}{snapshotInfo.option.source}
                </span>
              )}
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
            {isOption ? '开仓理由' : '买入理由'} <span className="text-rose-400">*</span>
          </label>
          <textarea
            value={thesis}
            onChange={e => setThesis(e.target.value)}
            rows={6}
            placeholder={
              !isOption
                ? `详细描述你的买入逻辑。例如：
- 公司钠电池产能预计2024Q4落地，打开第二增长曲线
- 当前PE 25x 处于历史低位25%分位，估值安全边际充分
- 行业补贴政策2025年持续，竞争格局向头部集中
- 三季度营收增速30%+，盈利质量持续改善`
                : side === 'LONG'
                  ? `期权论点要写清楚方向、幅度和期限。例如：
- 11/19 财报前市场预期偏低，预计财报后股价突破盈亏平衡价
- 数据中心收入增速仍在 50%+，AI 资本开支周期未见顶
- 当前 IV 低于过去一年财报前均值，权利金相对便宜
- 若 11/10 前标的仍未站上 250，按时间止损平仓`
                  : `卖方论点要写清楚你愿意承担什么。例如：
- 愿意在行权价接货（现金担保），到期前跌破行权价的概率低
- 财报后 IV 处于高位，卖出权利金性价比高
- 标的跌破 MA60 或逼近行权价 3% 以内时买入平仓止损`
            }
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
            disabled={!selected || !shares || !price || !thesis || (isOption && !contractSymbol)}
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isOption ? '保存开仓记录' : '保存买入记录'}
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
