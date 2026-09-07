// Shared display formatters — prices use 3 decimals (ETFs like 513050 tick at
// 0.001 CNY; stocks simply show trailing zeros trimmed is NOT desired here —
// keep a fixed 3 for consistency).

export function fmtPrice(n: number | undefined | null): string {
  return n != null && Number.isFinite(n) ? n.toFixed(3) : 'N/A'
}

export function fmtPct(n: number | undefined | null, digits = 2): string {
  return n != null && Number.isFinite(n) ? `${n.toFixed(digits)}%` : 'N/A'
}
