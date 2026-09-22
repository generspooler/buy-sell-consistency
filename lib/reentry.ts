/**
 * 买回计划（Re-entry Plan）— 卖出时声明的「待回调买入」承诺的机器可检查形态。
 *
 * 设计原则（v0.3，详见 CHANGELOG）：
 * 1. 触发条件在卖出时点锁定（LLM 可起草、用户确认后入库），事后不可漂移。
 * 2. 双闸门：价格条件 × 论点健康度。verdict = BROKEN 时不触发买回提醒——
 *    那是逃命信号，不是买点。
 * 3. 判定用「自上次检查以来的区间最低价」而非快照现价，避免 V 型急跌急拉
 *    被漏掉；同时要求「本次刷新时仍不高于触发价」，天然过滤盘中插针。
 * 4. 计划有生命周期：ARMED → FIRED / EXPIRED / CANCELLED / EXECUTED，
 *    永不过期的触发价是地雷。
 *
 * 本模块全部为纯函数，不持有 IO；LLM 起草 prompt 在 llm-analyzer.ts。
 */
import { AnalysisResult, StockSnapshot } from './types'
import type { Candle } from './indicators'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReentryStatus = 'ARMED' | 'FIRED' | 'EXPIRED' | 'CANCELLED' | 'EXECUTED'

/** 价格触发条件的两种形态，用户在卖出表单二选一（均可手改数字）。 */
export interface ReentryTrigger {
  /** 'PULLBACK' — 相对卖出价的回撤百分比（正数，如 12 代表 -12%）。 */
  kind: 'PULLBACK' | 'PRICE'
  /** PULLBACK: 回撤百分点（>0）；PRICE: 绝对触发价（>0）。 */
  value: number
  /** 解析出的绝对触发价——回撤口径换算后的实际价位，锁定时计算并固化。 */
  price: number
}

/**
 * 买回计划主体，JSON 存于 SellRecord.reentryPlanJson。
 * 核心字段（trigger/sellPrice/validDays）一经锁定不再变化；
 * 监控遥测（lastCheckedAt 等）每次检查覆盖式更新，触发叙述固化于 firedNote。
 */
export interface ReentryPlan {
  status: ReentryStatus
  /** 触发条件（含锁定的绝对价位）。 */
  trigger: ReentryTrigger
  /** 卖出价——trigger 的换算基准。 */
  sellPrice: number
  /** 拟买回股数（>0；用户声明，仅供提醒展示，不做强校验）。 */
  shares: number
  /** 计划有效期（天），自卖出日起算；过期即 EXPIRED。 */
  validDays: number
  /** 起草来源：LLM 从卖出备注起草，或用户手填。 */
  source: 'LLM' | 'MANUAL'
  createdAt: string
  /** 卖出成交日（有效期与首个检查窗口的锚点，可能与 createdAt 不同——回补历史卖出时）。 */
  soldAt: string
  /** 最近一次检查的遥测（每次刷新覆盖）。 */
  lastCheckedAt?: string
  lastLow?: number | null
  lastPrice?: number | null
  lastNote?: string
  /** 状态流转。 */
  firedAt?: string
  firedNote?: string
  firedLow?: number
  expiredAt?: string
  cancelledAt?: string
  /** 买回执行留痕（由 /api/trades 在同股新买入时自动关联）。 */
  executedAt?: string
  executedBuyRecordId?: number
  executedPositionId?: number
  /** 执行时计划状态：FIRED = 触发后按计划买回；ARMED = 未触发即买回（偏离计划）。 */
  executedFrom?: 'ARMED' | 'FIRED'
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * 「大笔回调才算」的最低门槛。日波动 ~2-3% 的股票，5 日累计 σ ≈ 5-6%，
 * -5% 级别的回调只有 ~1σ，统计上就是噪音。LLM 起草被钳制到该值以上；
 * 用户手填不受限（承诺是自己的），但 UI 会提示门槛含义。
 */
export const MIN_PULLBACK_PCT = 10

/** LLM 起草的回撤上限——超过此值通常是基本面事件而非「回调」。 */
export const MAX_PULLBACK_PCT = 30

/** 默认有效期（天）。 */
export const DEFAULT_VALID_DAYS = 90

// ─── 纯函数：计划构造与判定 ──────────────────────────────────────────────────

/** 回撤百分比 → 绝对触发价。 */
export function pullbackToPrice(sellPrice: number, pullbackPct: number): number {
  return sellPrice * (1 - pullbackPct / 100)
}

/** 构造初始 ARMED 计划（卖出时点锁定）。 */
export function buildReentryPlan(params: {
  trigger: ReentryTrigger
  sellPrice: number
  shares: number
  validDays?: number
  source?: 'LLM' | 'MANUAL'
  soldAt?: string
}): ReentryPlan {
  const { trigger, sellPrice, shares } = params
  return {
    status: 'ARMED',
    trigger: {
      ...trigger,
      price:
        trigger.kind === 'PULLBACK'
          ? pullbackToPrice(sellPrice, trigger.value)
          : trigger.value,
    },
    sellPrice,
    shares,
    validDays: params.validDays ?? DEFAULT_VALID_DAYS,
    source: params.source ?? 'MANUAL',
    createdAt: new Date().toISOString(),
    soldAt: params.soldAt ?? new Date().toISOString(),
  }
}

/** 计划是否已终结（终结后不再检查）。 */
export function isTerminal(status: ReentryStatus): boolean {
  return status !== 'ARMED'
}

/**
 * 提取「自某时点以来的区间最低价」。
 * Candle.date 的格式各数据源不统一（YYYY-MM-DD 为主，新浪为 YYYY-MM-DD HH:mm:ss），
 * 统一取日期前缀比较。
 */
export function lowSinceDate(candles: Candle[], since: Date): number | null {
  const sinceKey = since.toISOString().slice(0, 10)
  let low: number | null = null
  for (const c of candles) {
    const day = (c.date ?? '').slice(0, 10)
    if (day && day >= sinceKey) {
      if (low == null || c.low < low) low = c.low
    }
  }
  return low
}

/** 论点闸门：最新刷新 verdict = BROKEN → 拦截买回提醒。 */
export function thesisGate(
  latestAnalysis: AnalysisResult | null,
  latestVerdict: string | undefined
): 'PASS' | 'BLOCKED' | 'NO_DATA' {
  const verdict = latestAnalysis?.verdict ?? latestVerdict
  if (!verdict) return 'NO_DATA'
  return verdict === 'BROKEN' ? 'BLOCKED' : 'PASS'
}

/**
 * 对一个 ARMED 计划跑一次刷新检查（纯函数，返回新计划 + 本次判定）。
 * 调用方负责落库；本函数不做任何 IO。
 */
export function runReentryCheck(
  plan: ReentryPlan,
  snapshot: StockSnapshot,
  candles: Candle[],
  analysis: AnalysisResult | null,
  verdict: string | undefined
): { plan: ReentryPlan; fired: boolean; note: string } {
  const now = new Date()
  const nowIso = now.toISOString()
  const trigPrice = plan.trigger.price

  // ── 到期检查（先于价格：到期即终结，不再产生新提醒）──
  // 有效期自卖出日（而非记录创建日）起算：承诺的对象是交易，不是表单。
  const clockAnchor = new Date(plan.soldAt ?? plan.createdAt)
  const expiresAt = new Date(clockAnchor)
  expiresAt.setDate(expiresAt.getDate() + plan.validDays)
  if (now >= expiresAt) {
    const expired: ReentryPlan = {
      ...plan,
      status: 'EXPIRED',
      expiredAt: nowIso,
      lastCheckedAt: nowIso,
      lastNote: `计划已满 ${plan.validDays} 天有效期，自动失效。触发价 ${trigPrice.toFixed(2)} 在有效期内未达成。`,
    }
    return { plan: expired, fired: false, note: expired.lastNote! }
  }

  // ── 价格判定：区间最低价 × 本次现价 ──
  const since = plan.lastCheckedAt ? new Date(plan.lastCheckedAt) : clockAnchor
  const low = lowSinceDate(candles, since)
  const price = snapshot.market.price

  // ── 论点闸门 ──
  const gate = thesisGate(analysis, verdict)

  const priceHit = trigPrice > 0 && price != null && price <= trigPrice
  const lowHit = trigPrice > 0 && low != null && low <= trigPrice

  let fired = false
  let note: string

  if (lowHit && priceHit) {
    // 区间内触及且当前仍不高于触发价 —— 真实买回窗口（非盘中插针）
    if (gate === 'BLOCKED') {
      note = `价格已达买回触发价 ${trigPrice.toFixed(2)}（区间低点 ${low?.toFixed(2)}，现价 ${price.toFixed(2)}），但论点闸门拦截：最新 verdict = BROKEN，回调可能是基本面破坏。此时不建议机械买回，请重估论点。`
    } else {
      fired = true
      note = `买回条件已达成：区间低点 ${low?.toFixed(2)} / 现价 ${price.toFixed(2)} ≤ 触发价 ${trigPrice.toFixed(2)}${
        gate === 'NO_DATA' ? '（论点无数据，按价格条件提醒）' : ''
      }。你在 ${clockAnchor.toLocaleDateString('zh-CN')} 卖出时声明「待回调买入」，现在条件达成——按计划执行，或明确取消并写明理由。`
    }
  } else if (lowHit && !priceHit) {
    note = `区间内曾触及触发价 ${trigPrice.toFixed(2)}（低点 ${low?.toFixed(2)}），但现价已回升至 ${price.toFixed(2)}——V 型反弹，本次刷新时窗口已关闭，不提醒。`
  } else {
    const gapPct =
      price != null && trigPrice > 0 ? ((price - trigPrice) / trigPrice) * 100 : null
    note =
      gapPct != null
        ? `未触发：现价 ${price.toFixed(2)} 高于触发价 ${trigPrice.toFixed(2)}，还差 ${gapPct.toFixed(1)}%。`
        : `未触发：无法获取现价。`
    if (gate === 'BLOCKED') {
      note += '（论点闸门当前为 BROKEN，即使价格达标也不提醒买回。）'
    }
  }

  const next: ReentryPlan = {
    ...plan,
    lastCheckedAt: nowIso,
    lastLow: low,
    lastPrice: price ?? null,
    lastNote: note,
  }
  if (fired) {
    next.status = 'FIRED'
    next.firedAt = nowIso
    next.firedNote = note
    next.firedLow = low ?? price ?? undefined
  }
  return { plan: next, fired, note }
}

// ─── 序列化辅助 ──────────────────────────────────────────────────────────────

export function parseReentryPlan(raw: string | null | undefined): ReentryPlan | null {
  if (!raw) return null
  try {
    const plan = JSON.parse(raw) as ReentryPlan
    if (!plan || typeof plan.status !== 'string' || !plan.trigger) return null
    return plan
  } catch {
    return null
  }
}

export function serializeReentryPlan(plan: ReentryPlan): string {
  return JSON.stringify(plan)
}

/** 供展示的触发条件描述。 */
export function describeTrigger(trigger: ReentryTrigger, sellPrice: number): string {
  if (trigger.kind === 'PULLBACK') {
    return `自卖出价 ${sellPrice.toFixed(2)} 回撤 ${trigger.value}% 至 ${trigger.price.toFixed(2)}`
  }
  return `价格不高于 ${trigger.price.toFixed(2)}（卖出价 ${sellPrice.toFixed(2)} 的 ${(
    ((sellPrice - trigger.price) / sellPrice) * 100
  ).toFixed(1)}% 回撤）`
}

// ─── 卖出评分 prompt 的计划执行背景 ─────────────────────────────────────────

/**
 * 给卖出一致性评分 prompt 的补充段：此前声明的买回计划执行情况。
 * 返回 null 表示无历史计划（prompt 不变）。
 */
export function buildPriorPlanContext(
  priorPlans: Array<{ plan: ReentryPlan; stockName: string; soldAt: Date }>
): string | null {
  const relevant = priorPlans.filter(
    ({ plan }) =>
      plan.status === 'FIRED' ||
      plan.status === 'EXPIRED' ||
      plan.status === 'ARMED' ||
      plan.status === 'EXECUTED'
  )
  if (relevant.length === 0) return null
  const lines = relevant.map(({ plan, stockName, soldAt }) => {
    const trig = describeTrigger(plan.trigger, plan.sellPrice)
    const stateText =
      plan.status === 'EXECUTED'
        ? `已于 ${new Date(plan.executedAt ?? plan.createdAt).toLocaleDateString('zh-CN')} 买回执行${
            plan.executedFrom === 'FIRED' ? '（触发后按计划买回）' : '（未触发即提前买回，偏离声明条件）'
          }`
        : plan.status === 'FIRED'
          ? `已于 ${new Date(plan.firedAt ?? plan.createdAt).toLocaleDateString('zh-CN')} 触发，至今未买回`
          : plan.status === 'EXPIRED'
            ? `已过期未执行（有效期 ${plan.validDays} 天）`
            : `仍在等待中（未触发）`
    const shares = plan.shares > 0 ? `${plan.shares} 股` : '未声明股数'
    return `- ${stockName}：${soldAt.toLocaleDateString('zh-CN')} 卖出时声明「待回调买入」——${trig}，${stateText}，${shares}`
  })
  return `## 此前声明的买回计划执行情况\n${lines.join('\n')}\n\n评分时请考量：此前声明的买回承诺是否被兑现（触发后执行 = 知行合一加分；已触发却长期不执行、或过期作废 = 减分项）。`
}
