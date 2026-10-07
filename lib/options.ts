/**
 * 期权（v0.4）— 合约代码、到期、盈亏与进度的纯函数。不持有 IO，客户端与服务端共用。
 *
 * 口径（详见 CHANGELOG v0.4）：
 * 1. 一张合约 = 一个 Position，stock 指向标的；shares = 张数，price / avgCost =
 *    每股权利金，金额 = 张数 × 权利金 × multiplier。正股 multiplier = 1，公式不变。
 * 2. 盈亏统一为 sign × (现价 − avgCost) × 数量 × multiplier，卖方 sign = −1。
 *    卖方盈亏 % 以收取的权利金为基数：以 0 买回 = +100%，亏损可超过 −100%。
 * 3. 到期 = 美东到期日 16:00；过点仍 OPEN 的持仓为「待结算」（派生，不存库）。
 *    V1 只支持「平仓」与「到期作废」两种了结；行权 / 被指派按实际结算手工记录。
 */
import type { OptionSnapshot, OptionType, PositionSide } from './types'

export const DEFAULT_OPTION_MULTIPLIER = 100

/** |标的 − 行权价| / 行权价 小于此值视为平值。 */
const ATM_BAND = 0.01

/** 剩余天数 ≤ 此值视为临近到期（UI 标红、prompt 提示时间价值加速衰减）。 */
export const NEAR_EXPIRY_DAYS = 7

// ─── 合约代码（OCC）──────────────────────────────────────────────────────────

/** NVDA + 2026-11-20 + CALL + 240 → NVDA261120C00240000 */
export function buildOccSymbol(
  underlying: string,
  expiry: string,
  optionType: OptionType,
  strike: number
): string {
  const [y, m, d] = expiry.split('-')
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, '0')
  return `${underlying.toUpperCase()}${y.slice(2)}${m}${d}${optionType === 'CALL' ? 'C' : 'P'}${strikeCode}`
}

export function parseOccSymbol(symbol: string): {
  underlying: string
  expiry: string
  optionType: OptionType
  strike: number
} | null {
  const m = symbol.toUpperCase().match(/^([A-Z][A-Z0-9.]*?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
  if (!m) return null
  const [, underlying, yy, mm, dd, cp, strikeCode] = m
  return {
    underlying,
    expiry: `20${yy}-${mm}-${dd}`,
    optionType: cp === 'C' ? 'CALL' : 'PUT',
    strike: parseInt(strikeCode, 10) / 1000,
  }
}

// ─── 日期（美东）──────────────────────────────────────────────────────────────

const ET = 'America/New_York'

/** 某时刻在美东的日期 YYYY-MM-DD。 */
export function etDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}

function etHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', hourCycle: 'h23' }).format(at)
  )
}

/** 两个 YYYY-MM-DD 之间的日历天数（b − a）。 */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** DB 中的到期日（UTC 零点）或 ISO 字符串 → YYYY-MM-DD。 */
export function toExpiryString(expiry: Date | string): string {
  return typeof expiry === 'string' ? expiry.slice(0, 10) : expiry.toISOString().slice(0, 10)
}

/** YYYY-MM-DD → 入库的 Date（UTC 零点，读回时 toISOString 不会跨日）。 */
export function expiryToDate(expiry: string): Date {
  return new Date(`${expiry}T00:00:00.000Z`)
}

/** 剩余日历天数（美东日期口径，到期当天为 0）。 */
export function daysToExpiry(expiry: string, now: Date = new Date()): number {
  return Math.max(0, daysBetween(etDate(now), expiry))
}

/** 是否已过到期时点（美东到期日 16:00 收盘）。 */
export function isExpired(expiry: string, now: Date = new Date()): boolean {
  const today = etDate(now)
  return today > expiry || (today === expiry && etHour(now) >= 16)
}

// ─── 价值与盈亏 ──────────────────────────────────────────────────────────────

export function intrinsicValue(optionType: OptionType, strike: number, underlying: number): number {
  return Math.max(0, optionType === 'CALL' ? underlying - strike : strike - underlying)
}

/** 到期盈亏平衡价：Call = 行权价 + 权利金；Put = 行权价 − 权利金。买卖方相同。 */
export function breakevenPrice(optionType: OptionType, strike: number, premium: number): number {
  return optionType === 'CALL' ? strike + premium : strike - premium
}

export function moneynessOf(
  optionType: OptionType,
  strike: number,
  underlying: number
): 'ITM' | 'ATM' | 'OTM' {
  if (strike > 0 && Math.abs(underlying - strike) / strike < ATM_BAND) return 'ATM'
  return intrinsicValue(optionType, strike, underlying) > 0 ? 'ITM' : 'OTM'
}

export function sideSign(side?: string | null): 1 | -1 {
  return side === 'SHORT' ? -1 : 1
}

/** 统一盈亏：正股与期权、买方与卖方共用一个公式。 */
export function positionPnl(
  p: { side?: string | null; avgCost: number; multiplier?: number | null },
  price: number,
  qty: number
): number {
  return sideSign(p.side) * (price - p.avgCost) * qty * (p.multiplier ?? 1)
}

export function positionPnlPct(
  p: { side?: string | null; avgCost: number },
  price: number
): number {
  return p.avgCost > 0 ? sideSign(p.side) * ((price - p.avgCost) / p.avgCost) * 100 : 0
}

/** 到期结算判定（纯算术，以到期日标的收盘价为准）。 */
export function expirySettlement(
  optionType: OptionType,
  strike: number,
  underlyingClose: number
): { outcome: 'WORTHLESS' | 'ITM'; intrinsic: number } {
  const intrinsic = intrinsicValue(optionType, strike, underlyingClose)
  return { outcome: intrinsic > 0 ? 'ITM' : 'WORTHLESS', intrinsic }
}

// ─── 快照期权块 ──────────────────────────────────────────────────────────────

export interface OptionQuoteFields {
  bid?: number
  ask?: number
  last?: number
  volume?: number
  openInterest?: number
  iv?: number
  delta?: number
  gamma?: number
  theta?: number
  vega?: number
}

/** 买卖中间价；无有效双边报价时退回最新成交价。 */
export function markPrice(q: OptionQuoteFields | null | undefined): number | undefined {
  if (!q) return undefined
  if (q.ask != null && q.ask > 0 && q.bid != null && q.bid >= 0 && q.ask >= q.bid) {
    return (q.bid + q.ask) / 2
  }
  return q.last != null && q.last > 0 ? q.last : undefined
}

/** 由合约条款 + 报价 + 标的价算出快照期权块（派生值一并固化）。 */
export function computeOptionBlock(params: {
  contractSymbol: string
  underlying: string
  optionType: OptionType
  strike: number
  expiry: string
  quote: OptionQuoteFields | null
  underlyingPrice: number
  underlyingIv30?: number
  premiumBasis?: number
  dataSource: string
  dataTime: string
  degraded?: boolean
  now?: Date
}): OptionSnapshot {
  const { optionType, strike, underlyingPrice, quote } = params
  const mark = markPrice(quote)
  const intrinsic = intrinsicValue(optionType, strike, underlyingPrice)
  const block: OptionSnapshot = {
    contractSymbol: params.contractSymbol,
    underlying: params.underlying,
    optionType,
    strike,
    expiry: params.expiry,
    dte: daysToExpiry(params.expiry, params.now),
    bid: quote?.bid,
    ask: quote?.ask,
    last: quote?.last,
    volume: quote?.volume,
    openInterest: quote?.openInterest,
    iv: quote?.iv,
    delta: quote?.delta,
    gamma: quote?.gamma,
    theta: quote?.theta,
    vega: quote?.vega,
    mark,
    underlyingPrice,
    underlyingIv30: params.underlyingIv30,
    intrinsic,
    extrinsic: mark != null ? mark - intrinsic : undefined,
    moneyness: moneynessOf(optionType, strike, underlyingPrice),
    dataSource: params.dataSource,
    dataTime: params.dataTime,
    degraded: params.degraded,
  }
  const basis = params.premiumBasis ?? mark
  return basis != null ? withPremiumBasis(block, basis) : block
}

/** 以持仓权利金重算盈亏平衡相关字段（开仓前以 mark 暂代，成交后用成交价）。 */
export function withPremiumBasis(block: OptionSnapshot, premium: number): OptionSnapshot {
  const breakeven = breakevenPrice(block.optionType, block.strike, premium)
  return {
    ...block,
    premiumBasis: premium,
    breakeven,
    distToBreakevenPct:
      block.underlyingPrice > 0
        ? ((breakeven - block.underlyingPrice) / block.underlyingPrice) * 100
        : undefined,
  }
}

// ─── 时间 × 价格进度（期权独有、无需 LLM 的信号）─────────────────────────────

export interface OptionProgress {
  dte: number
  /** 开仓 → 到期已过去的时间比例（%）。 */
  timeElapsedPct: number | null
  /** 买方：标的从开仓价走向盈亏平衡价的完成度（%，可为负或超 100）。 */
  priceProgressPct?: number | null
  /** 卖方：标的距行权价的缓冲（%，正 = 仍在价外一侧）。 */
  strikeCushionPct?: number | null
  /** 卖方：已赚取的权利金比例（%）。 */
  premiumCapturedPct?: number | null
  /** 每日 theta 占当前权利金的比例（%）。 */
  thetaPctOfMark?: number | null
}

export function optionProgress(params: {
  side: PositionSide
  optionType: OptionType
  strike: number
  premium: number
  openedAt: string           // ISO；日期部分即开仓日
  expiry: string
  underlyingAtOpen?: number
  underlyingNow: number
  mark?: number
  theta?: number
  now?: Date
}): OptionProgress {
  const now = params.now ?? new Date()
  // 开仓日是用户录入的日历日（以 UTC 零点入库），直接取日期部分——
  // 转美东会退回前一天。
  const openDay = params.openedAt.slice(0, 10)
  const total = daysBetween(openDay, params.expiry)
  const elapsed = daysBetween(openDay, etDate(now))
  const timeElapsedPct =
    total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 100

  const progress: OptionProgress = {
    dte: daysToExpiry(params.expiry, now),
    timeElapsedPct,
    thetaPctOfMark:
      params.theta != null && params.mark != null && params.mark > 0
        ? (Math.abs(params.theta) / params.mark) * 100
        : null,
  }

  if (params.side === 'LONG') {
    const be = breakevenPrice(params.optionType, params.strike, params.premium)
    const open = params.underlyingAtOpen
    const denom = open != null ? be - open : 0
    progress.priceProgressPct =
      open != null && Math.abs(denom) > 1e-9 ? ((params.underlyingNow - open) / denom) * 100 : null
  } else {
    const s = params.underlyingNow
    progress.strikeCushionPct =
      s > 0
        ? ((params.optionType === 'CALL' ? params.strike - s : s - params.strike) / s) * 100
        : null
    progress.premiumCapturedPct =
      params.mark != null && params.premium > 0
        ? ((params.premium - params.mark) / params.premium) * 100
        : null
  }
  return progress
}

/** 取整到个位，且不输出「-0」。 */
const int = (n: number) => String(Math.round(n) || 0)

/** 进度的一句话描述（prompt 与 UI 共用）。 */
export function describeProgress(p: OptionProgress, side: PositionSide): string {
  const parts: string[] = [`剩余 ${p.dte} 天`]
  if (p.timeElapsedPct != null) parts.push(`时间已过 ${int(p.timeElapsedPct)}%`)
  if (side === 'LONG' && p.priceProgressPct != null) {
    parts.push(`标的已走完到盈亏平衡价距离的 ${int(p.priceProgressPct)}%`)
  }
  if (side === 'SHORT') {
    if (p.strikeCushionPct != null) {
      parts.push(
        p.strikeCushionPct >= 0
          ? `标的距行权价尚有 ${p.strikeCushionPct.toFixed(1)}% 缓冲`
          : `标的已越过行权价 ${Math.abs(p.strikeCushionPct).toFixed(1)}%（价内）`
      )
    }
    if (p.premiumCapturedPct != null) parts.push(`已赚取权利金 ${int(p.premiumCapturedPct)}%`)
  }
  if (p.thetaPctOfMark != null) {
    parts.push(`每日时间价值损耗约占权利金 ${p.thetaPctOfMark.toFixed(1)}%`)
  }
  return parts.join('，')
}

// ─── 持仓上下文与展示 ────────────────────────────────────────────────────────

/** LLM prompt 与派生计算所需的期权持仓上下文。 */
export interface OptionContext {
  underlying: string
  contractSymbol: string
  optionType: OptionType
  strike: number
  expiry: string
  side: PositionSide
  multiplier: number
  premium: number
  openedAt: string
}

/** 从 Position 行取期权上下文；正股返回 null。 */
export function optionContextOf(
  p: {
    assetType?: string | null
    side?: string | null
    multiplier?: number | null
    contractSymbol?: string | null
    optionType?: string | null
    strike?: number | null
    expiry?: Date | string | null
    avgCost: number
    openedAt: Date | string
  },
  underlying: string
): OptionContext | null {
  if (p.assetType !== 'OPTION' || !p.contractSymbol || !p.optionType || p.strike == null || !p.expiry) {
    return null
  }
  return {
    underlying,
    contractSymbol: p.contractSymbol,
    optionType: p.optionType as OptionType,
    strike: p.strike,
    expiry: toExpiryString(p.expiry),
    side: (p.side === 'SHORT' ? 'SHORT' : 'LONG'),
    multiplier: p.multiplier ?? DEFAULT_OPTION_MULTIPLIER,
    premium: p.avgCost,
    openedAt: typeof p.openedAt === 'string' ? p.openedAt : p.openedAt.toISOString(),
  }
}

export function fmtStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(Number(strike.toFixed(2)))
}

/** NVDA 240C 11/20 */
export function optionShortLabel(o: {
  underlying: string; optionType: string; strike: number; expiry: string
}): string {
  const [, m, d] = o.expiry.split('-')
  return `${o.underlying} ${fmtStrike(o.strike)}${o.optionType === 'CALL' ? 'C' : 'P'} ${m}/${d}`
}

/** NVDA 2026-11-20 240 Call */
export function optionLongLabel(o: {
  underlying: string; optionType: string; strike: number; expiry: string
}): string {
  return `${o.underlying} ${o.expiry} ${fmtStrike(o.strike)} ${o.optionType === 'CALL' ? 'Call' : 'Put'}`
}

export const SIDE_LABEL: Record<PositionSide, string> = { LONG: '买方', SHORT: '卖方' }

export function openActionLabel(side?: string | null): string {
  return side === 'SHORT' ? '卖出开仓' : '买入开仓'
}

export function closeActionLabel(side?: string | null): string {
  return side === 'SHORT' ? '买入平仓' : '卖出平仓'
}
