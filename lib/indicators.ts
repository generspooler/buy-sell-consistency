/**
 * Technical indicator calculations from raw OHLCV candle data.
 * All inputs are arrays ordered oldest → newest.
 */

export interface Candle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function sma(data: number[], period: number): number[] {
  const result: number[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN)
    } else {
      const slice = data.slice(i - period + 1, i + 1)
      result.push(slice.reduce((a, b) => a + b, 0) / period)
    }
  }
  return result
}

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0])
    } else {
      result.push(data[i] * k + result[i - 1] * (1 - k))
    }
  }
  return result
}

export function calcMAs(candles: Candle[]) {
  const closes = candles.map(c => c.close)
  const last = (arr: number[]) => arr[arr.length - 1]
  return {
    ma5: last(sma(closes, 5)),
    ma10: last(sma(closes, 10)),
    ma20: last(sma(closes, 20)),
    ma60: last(sma(closes, 60)),
    ma120: last(sma(closes, 120)),
    ma250: last(sma(closes, 250)),
  }
}

export function calcMACD(candles: Candle[]) {
  const closes = candles.map(c => c.close)
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const dif = ema12.map((v, i) => v - ema26[i])
  const dea = ema(dif, 9)
  const hist = dif.map((v, i) => (v - dea[i]) * 2)
  const n = closes.length - 1
  return { macdDIF: dif[n], macdDEA: dea[n], macdHistogram: hist[n] }
}

export function calcRSI(candles: Candle[], period = 14): number {
  const closes = candles.map(c => c.close)
  if (closes.length < period + 1) return NaN
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses += Math.abs(diff)
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function calcKDJ(candles: Candle[]) {
  const period = 9
  if (candles.length < period) return { kdjK: NaN, kdjD: NaN, kdjJ: NaN }
  let K = 50, D = 50
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1)
    const high = Math.max(...slice.map(c => c.high))
    const low = Math.min(...slice.map(c => c.low))
    const close = slice[slice.length - 1].close
    const rsv = high === low ? 50 : ((close - low) / (high - low)) * 100
    K = (2 / 3) * K + (1 / 3) * rsv
    D = (2 / 3) * D + (1 / 3) * K
  }
  return { kdjK: K, kdjD: D, kdjJ: 3 * K - 2 * D }
}

export function calcBOLL(candles: Candle[], period = 20, multiplier = 2) {
  const closes = candles.map(c => c.close)
  if (closes.length < period) return { bollUpper: NaN, bollMid: NaN, bollLower: NaN }
  const slice = closes.slice(-period)
  const mid = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((sum, v) => sum + (v - mid) ** 2, 0) / period
  const std = Math.sqrt(variance)
  return {
    bollUpper: mid + multiplier * std,
    bollMid: mid,
    bollLower: mid - multiplier * std,
  }
}

export function calcVolumeRatio(candles: Candle[], period = 5): number {
  if (candles.length < period + 1) return NaN
  const recent = candles[candles.length - 1].volume
  const avgVolume =
    candles.slice(-period - 1, -1).reduce((s, c) => s + c.volume, 0) / period
  return avgVolume === 0 ? NaN : recent / avgVolume
}

export function calcSupportResistance(candles: Candle[]) {
  const slice = candles.slice(-60)
  const highs = slice.map(c => c.high)
  const lows = slice.map(c => c.low)
  return {
    resistance: Math.max(...highs),
    support: Math.min(...lows),
  }
}

export function computeAllIndicators(candles: Candle[]) {
  if (candles.length === 0) return {}
  const mas = calcMAs(candles)
  const macd = calcMACD(candles)
  const rsi14 = calcRSI(candles)
  const kdj = calcKDJ(candles)
  const boll = calcBOLL(candles)
  const volumeRatio = calcVolumeRatio(candles)
  const { support, resistance } = calcSupportResistance(candles)
  const currentClose = candles[candles.length - 1].close
  const distFromMa20Pct =
    mas.ma20 ? ((currentClose - mas.ma20) / mas.ma20) * 100 : undefined
  return {
    ...mas,
    ...macd,
    rsi14,
    ...kdj,
    ...boll,
    volumeRatio,
    support,
    resistance,
    distFromMa20Pct,
  }
}
