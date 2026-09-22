/**
 * LLM Analyzer — calls `claude -p` CLI subprocess for structured analysis.
 */
import { spawn } from 'child_process'
import { StockSnapshot, AnalysisResult, ThesisPoint, Market } from './types'
import { parseLLMJSON } from './json-utils'
import {
  MIN_PULLBACK_PCT,
  MAX_PULLBACK_PCT,
  pullbackToPrice,
} from './reentry'

const LLM_COMMAND = process.env.LLM_COMMAND ?? 'claude'
const LLM_MODEL = process.env.LLM_MODEL ?? 'claude-opus-5'

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt]
    if (LLM_MODEL) args.push('--model', LLM_MODEL)

    const child = spawn(LLM_COMMAND, args, { env: process.env })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`LLM timeout after 180s. stderr: ${stderr.slice(0, 200)}`))
    }, 180_000)

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}. stderr: ${stderr.slice(0, 400)}`))
      } else {
        resolve(stdout.trim())
      }
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          `"${LLM_COMMAND}" not found. Install Claude CLI or set LLM_COMMAND env var.`
        ))
      } else {
        reject(err)
      }
    })
  })
}

// ─── Prompt templates ────────────────────────────────────────────────────────

function buildThesisExtractPrompt(
  thesis: string,
  snapshot: StockSnapshot,
  stockName: string
): string {
  return `你是顶级华尔街资深金融分析师。

股票：${stockName}
买入理由（原文）：
${thesis}

当前快照摘要：
- 价格：${snapshot.market.price}，涨跌：${snapshot.market.changePct?.toFixed(2)}%
- PE(TTM)：${snapshot.valuation.peTTM ?? 'N/A'}，PB：${snapshot.valuation.pb ?? 'N/A'}
- ROE：${snapshot.valuation.roe ?? 'N/A'}%
- MA20偏离：${snapshot.technicals.distFromMa20Pct?.toFixed(1) ?? 'N/A'}%
- RSI(14)：${snapshot.technicals.rsi14?.toFixed(1) ?? 'N/A'}

请将买入理由拆解为 3-6 条具体、可验证的投资论点。每条论点应该是一个可以被数据或事件证伪的具体主张（例如："营收同比增速>30%"、"钠电池产能按计划落地"、"行业补贴政策持续执行"等）。

请严格以如下 JSON 数组格式输出，不要输出任何其他内容：
[
  {"id": "1", "point": "具体可验证的论点一"},
  {"id": "2", "point": "具体可验证的论点二"},
  ...
]`
}

function buildRefreshAnalysisPrompt(
  stockName: string,
  market: Market,
  thesis: string,
  thesisPoints: ThesisPoint[],
  buySnapshot: StockSnapshot,
  currentSnapshot: StockSnapshot,
  lastSnapshot?: StockSnapshot
): string {
  const fmt = (n?: number) => n != null ? n.toFixed(3) : 'N/A'
  const fmtPct = (n?: number) => n != null ? `${n.toFixed(2)}%` : 'N/A'

  const pointsList = thesisPoints.map((p, i) => `${i + 1}. ${p.point}`).join('\n')

  const compareTable = `
| 指标 | 买入时 | 当前 |${lastSnapshot ? ' 上次刷新 |' : ''}
|------|--------|------|${lastSnapshot ? '---------|' : ''}
| 价格 | ${fmt(buySnapshot.market.price)} | ${fmt(currentSnapshot.market.price)} |${lastSnapshot ? ` ${fmt(lastSnapshot.market.price)} |` : ''}
| 涨跌幅(近期) | - | ${fmtPct(currentSnapshot.market.changePct)} |${lastSnapshot ? ` ${fmtPct(lastSnapshot.market.changePct)} |` : ''}
| PE(TTM) | ${fmt(buySnapshot.valuation.peTTM)} | ${fmt(currentSnapshot.valuation.peTTM)} |${lastSnapshot ? ` ${fmt(lastSnapshot.valuation.peTTM)} |` : ''}
| PB | ${fmt(buySnapshot.valuation.pb)} | ${fmt(currentSnapshot.valuation.pb)} |${lastSnapshot ? ` ${fmt(lastSnapshot.valuation.pb)} |` : ''}
| ROE% | ${fmt(buySnapshot.valuation.roe)} | ${fmt(currentSnapshot.valuation.roe)} |${lastSnapshot ? ` ${fmt(lastSnapshot.valuation.roe)} |` : ''}
| 营收增速% | ${fmt(buySnapshot.valuation.revenueGrowthYoY)} | ${fmt(currentSnapshot.valuation.revenueGrowthYoY)} |${lastSnapshot ? ` ${fmt(lastSnapshot.valuation.revenueGrowthYoY)} |` : ''}
| RSI(14) | ${fmt(buySnapshot.technicals.rsi14)} | ${fmt(currentSnapshot.technicals.rsi14)} |${lastSnapshot ? ` ${fmt(lastSnapshot.technicals.rsi14)} |` : ''}
| MA20偏离% | ${fmt(buySnapshot.technicals.distFromMa20Pct)} | ${fmt(currentSnapshot.technicals.distFromMa20Pct)} |${lastSnapshot ? ` ${fmt(lastSnapshot.technicals.distFromMa20Pct)} |` : ''}
| MACD柱 | ${fmt(buySnapshot.technicals.macdHistogram)} | ${fmt(currentSnapshot.technicals.macdHistogram)} |${lastSnapshot ? ` ${fmt(lastSnapshot.technicals.macdHistogram)} |` : ''}
`.trim()

  const newsText = currentSnapshot.context.news.length > 0
    ? currentSnapshot.context.news.map(n => `- ${n}`).join('\n')
    : '暂无近期新闻'

  return `你是顶级华尔街资深金融分析师。你的任务是：根据买入时的投资论点，对照最新市场数据，逐条判断每个论点当前是否仍然成立。

## 股票基本信息
- 名称/代码：${stockName}（${market}市场）
- 大盘环境：${currentSnapshot.context.indexTrend}

## 买入理由（原文）
${thesis}

## 原始论点列表
${pointsList}

## 关键指标对比
${compareTable}

## 近30日新闻/公告摘要
${newsText}

## 技术面补充
- BOLL带：上轨${fmt(currentSnapshot.technicals.bollUpper)} / 中轨${fmt(currentSnapshot.technicals.bollMid)} / 下轨${fmt(currentSnapshot.technicals.bollLower)}
- KDJ：K=${fmt(currentSnapshot.technicals.kdjK)} D=${fmt(currentSnapshot.technicals.kdjD)} J=${fmt(currentSnapshot.technicals.kdjJ)}
- 量比：${fmt(currentSnapshot.technicals.volumeRatio)}
- 支撑位：${fmt(currentSnapshot.technicals.support)}，压力位：${fmt(currentSnapshot.technicals.resistance)}

---

请逐条判断每个买入论点当前的状态，并给出总体评估。

严格按照如下 JSON 结构输出，不要输出任何其他内容。JSON 格式要求：
- 所有字符串值内部如需引用文字或数字，禁止使用英文双引号，改用中文引号「」或书名号
- status 只能是 HELD / WEAKENED / BROKEN 三个枚举值之一
- verdict 只能是 SUPPORT / WEAKEN / BROKEN 三个枚举值之一
- trend 只能是 恶化 / 持平 / 改善 三个枚举值之一
- confidence 是 0 到 1 之间的小数
{
  "thesisPoints": [
    {
      "point": "论点原文",
      "status": "HELD | WEAKENED | BROKEN",
      "evidence": "最新证据的简短说明（1-2句话）",
      "trend": "恶化 | 持平 | 改善"
    }
  ],
  "verdict": "SUPPORT | WEAKEN | BROKEN",
  "trendAnalysis": "相比买入时与上次刷新，关键变化的叙述（3-5句话，重点是边际变化）",
  "newsSignals": ["重要新闻信号1（标注利多/利空）", "重要新闻信号2"],
  "actionSuggestion": "持有/加仓观察/减仓/清仓（一行结论，50字以内）",
  "confidence": 0.75
}

verdict 判断标准：
- SUPPORT：多数核心论点仍成立，基本面/技术面无重大变化
- WEAKEN：1-2个关键论点出现动摇，需要密切关注
- BROKEN：核心论点已被证伪，或多个论点已破坏，建议重新评估持仓`
}

function buildSellConsistencyPrompt(
  stockName: string,
  thesis: string,
  thesisPoints: ThesisPoint[],
  lastAnalysis: AnalysisResult | null,
  sellReason: string,
  sellNote: string,
  pnlPct: number,
  priorPlanContext?: string | null
): string {
  const pointsList = thesisPoints.map((p, i) => `${i + 1}. ${p.point}`).join('\n')
  const lastStatus = lastAnalysis
    ? `上次分析 verdict：${lastAnalysis.verdict}\n操作建议：${lastAnalysis.actionSuggestion}`
    : '无历史分析记录'

  return `你是顶级华尔街资深金融分析师，负责评估投资决策的一致性。

## 股票：${stockName}
## 买入理由（原文）
${thesis}

## 买入论点
${pointsList}

## 卖出信息
- 卖出原因：${sellReason}
- 备注：${sellNote || '无'}
- 盈亏：${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%

## 最新分析状态
${lastStatus}
${priorPlanContext ? `\n${priorPlanContext}\n` : ''}
请评估此次卖出行为与买入逻辑的一致性。满分100分。特别地：如果本次卖出备注中再次出现「待回调买回」之类的计划性表述，请评估该计划是否给出了明确、可检验的触发条件；一个没有触发价的买回计划等于没有计划，属于知行不一的表现，应当扣分并在 comment 中点明。

严格按如下 JSON 输出：
{
  "score": 85,
  "comment": "简短评价（2-3句话）：此次卖出是否遵循了当初的买入逻辑？是否知行合一？"
}`
}

// ─── Re-entry plan drafting (v0.3) ─────────────────────────────────────────────

/**
 * 起草买回触发条件：把卖出备注里的「待回调买入」翻译成一个带数字的
 * 可检验承诺。LLM 只起草，数字由用户确认/修改后才锁定入库。
 */
function buildReentryDraftPrompt(
  stockName: string,
  sellPrice: number,
  soldShares: number,
  thesisPoints: ThesisPoint[],
  sellReason: string,
  sellNote: string,
  technicals: { support?: number; ma60?: number; bollLower?: number; low52w?: number }
): string {
  const pointsList = thesisPoints.map((p, i) => `${i + 1}. ${p.point}`).join('\n')
  const structure = [
    `支撑位(60日)：${technicals.support ?? 'N/A'}`,
    `MA60：${technicals.ma60 ?? 'N/A'}`,
    `BOLL下轨：${technicals.bollLower ?? 'N/A'}`,
    `52周低点：${technicals.low52w ?? 'N/A'}`,
  ].join('\n')

  return `你是顶级华尔街资深金融分析师。用户在卖出 ${stockName}（卖出价 ${sellPrice.toFixed(2)}，${soldShares} 股）时，备注中表达了买回意图。你的任务：把这个模糊意图起草成一个明确、可检验的买回触发条件。注意：用户做大笔买入，小回调不在考虑范围——日波动 2-3% 的股票 5 日累计波动约 5-6%，因此回撤门槛应显著越过噪音区（不低于 10%，建议 12-20%），或锚定显著的结构位（MA60 / BOLL 下轨 / 60 日支撑）。

## 卖出原因
${sellReason}

## 卖出备注（买回意图的原文）
${sellNote || '（无备注，但用户勾选了制定买回计划）'}

## 原买入论点（判断回调是否可能是基本面破坏时参考）
${pointsList || '无'}

## 当前技术结构位
${structure}

严格按如下 JSON 输出，不要输出任何其他内容：
{
  "kind": "PULLBACK 或 PRICE",
  "value": 数字,
  "pullbackPct": 回撤百分点（PULLBACK 时填，如 12 代表 -12%；PRICE 时留 0）,
  "triggerPrice": 换算出的绝对触发价（PULLBACK = 卖出价×(1-回撤)，PRICE = value 本身）,
  "shares": 拟买回股数（从备注推断，无法推断则 0）,
  "rationale": "起草理由（1-2句：为什么是这个门槛/结构位）"
}`
}

export interface ReentryDraft {
  kind: 'PULLBACK' | 'PRICE'
  value: number
  pullbackPct: number
  triggerPrice: number
  shares: number
  rationale: string
}

export async function draftReentryTrigger(
  stockName: string,
  sellPrice: number,
  soldShares: number,
  thesisPoints: ThesisPoint[],
  sellReason: string,
  sellNote: string,
  technicals: { support?: number; ma60?: number; bollLower?: number; low52w?: number }
): Promise<ReentryDraft> {
  const prompt = buildReentryDraftPrompt(
    stockName, sellPrice, soldShares, thesisPoints, sellReason, sellNote, technicals
  )
  let raw: string
  try {
    raw = await runClaude(prompt)
  } catch (e) {
    throw new Error(`LLM call failed: ${(e as Error).message}`)
  }
  let draft: ReentryDraft
  try {
    draft = parseLLMJSON(raw) as ReentryDraft
  } catch {
    throw new Error(`Failed to parse reentry draft. Raw: ${raw.slice(0, 300)}`)
  }
  // Normalize + clamp to the noise-floor policy (LLM 起草被钳制在 ≥10%)
  const kind = draft.kind === 'PRICE' ? 'PRICE' : 'PULLBACK'
  let value = Number(draft.value)
  if (!Number.isFinite(value) || value <= 0) value = 12
  if (kind === 'PULLBACK') {
    if (value < MIN_PULLBACK_PCT) value = MIN_PULLBACK_PCT
    if (value > MAX_PULLBACK_PCT) value = MAX_PULLBACK_PCT
  } else {
    if (value >= sellPrice) value = sellPrice * (1 - MIN_PULLBACK_PCT / 100)
  }
  const triggerPrice =
    kind === 'PULLBACK'
      ? pullbackToPrice(sellPrice, value)
      : value
  const shares = Number.isFinite(draft.shares) && draft.shares > 0 ? draft.shares : 0
  return {
    kind,
    value,
    pullbackPct: kind === 'PULLBACK' ? value : 0,
    triggerPrice,
    shares,
    rationale: typeof draft.rationale === 'string' ? draft.rationale : '',
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractThesisPoints(
  thesis: string,
  snapshot: StockSnapshot,
  stockName: string
): Promise<ThesisPoint[]> {
  const prompt = buildThesisExtractPrompt(thesis, snapshot, stockName)
  let raw: string
  try {
    raw = await runClaude(prompt)
  } catch (e) {
    throw new Error(`LLM call failed: ${(e as Error).message}`)
  }
  try {
    const arr = parseLLMJSON(raw) as Array<{ id: string; point: string }>
    return arr.map(item => ({ id: item.id, point: item.point }))
  } catch {
    throw new Error(`Failed to parse thesis points. Raw LLM output: ${raw.slice(0, 300)}`)
  }
}

export async function analyzePosition(
  stockName: string,
  market: Market,
  thesis: string,
  thesisPoints: ThesisPoint[],
  buySnapshot: StockSnapshot,
  currentSnapshot: StockSnapshot,
  lastSnapshot?: StockSnapshot
): Promise<AnalysisResult> {
  const prompt = buildRefreshAnalysisPrompt(
    stockName, market, thesis, thesisPoints, buySnapshot, currentSnapshot, lastSnapshot
  )
  let raw = ''
  let attempt = 0
  let llmError: Error | null = null
  while (attempt < 2) {
    try {
      raw = await runClaude(prompt)
      llmError = null
      break
    } catch (e) {
      llmError = e as Error
      attempt++
      if (attempt >= 2) break
    }
  }
  if (llmError) {
    throw new Error(`LLM call failed after retry: ${llmError.message}`)
  }
  try {
    return parseLLMJSON(raw) as AnalysisResult
  } catch (e) {
    if (process.env.LLM_DEBUG_DUMP) {
      const { writeFileSync } = await import('fs')
      writeFileSync('/tmp/llm_failed_raw.txt', raw || '(empty)')
    }
    throw new Error(
      `Failed to parse analysis JSON (${(e as Error).message}). Raw: ${raw.slice(0, 300)}`
    )
  }
}

export async function scoreSellConsistency(
  stockName: string,
  thesis: string,
  thesisPoints: ThesisPoint[],
  lastAnalysis: AnalysisResult | null,
  sellReason: string,
  sellNote: string,
  pnlPct: number,
  priorPlanContext?: string | null
): Promise<{ score: number; comment: string }> {
  const prompt = buildSellConsistencyPrompt(
    stockName, thesis, thesisPoints, lastAnalysis, sellReason, sellNote, pnlPct, priorPlanContext
  )
  let raw: string
  try {
    raw = await runClaude(prompt)
  } catch (e) {
    return { score: 0, comment: `LLM call failed: ${(e as Error).message}` }
  }
  try {
    return parseLLMJSON(raw) as { score: number; comment: string }
  } catch {
    return { score: 0, comment: `Parse failed. Raw: ${raw.slice(0, 200)}` }
  }
}
