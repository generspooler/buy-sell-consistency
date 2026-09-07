/**
 * Robust JSON extraction/repair for LLM output.
 * Handles: fenced blocks (multiple — last valid wins), prose around JSON,
 * trailing commas, unquoted keys, single-quoted strings, and unescaped
 * double quotes inside string values (the most common LLM JSON defect).
 */
export function parseLLMJSON(text: string): unknown {
  const extracted = extractJSON(text)
  const attempts = [
    extracted,
    repairJSON(extracted),
    tolerantParse(extracted),
    tolerantParse(repairJSON(extracted)),
  ]
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {}
  }
  throw new Error(`unparseable LLM JSON: ${extracted.slice(0, 200)}`)
}

function extractJSON(text: string): string {
  // 1. fenced blocks (last valid one wins — models sometimes emit multiple)
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  if (fences.length > 0) {
    const candidates = fences
      .map(f => f[1].trim())
      .filter(s => s.startsWith('{') || s.startsWith('['))
    if (candidates.length > 0) {
      for (const c of [...candidates].reverse()) {
        try {
          return JSON.stringify(JSON.parse(c))
        } catch {}
      }
      return candidates[0]
    }
  }
  // 2. brace-balance scan: outermost {...} or [...]
  const start = text.search(/[{[]/)
  if (start >= 0) {
    const open = text[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = !inStr
        continue
      }
      if (inStr) continue
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
  }
  return text.trim()
}

function repairJSON(s: string): string {
  return s
    .replace(/,\s*([}\]])/g, '$1') // trailing commas
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":') // unquoted keys
    .replace(/:\s*'([^']*)'/g, ': "$1"') // single-quoted strings
}

/**
 * Tolerant re-serializer: a `"` inside a string only terminates it when a
 * structural character (`, : } ]` or end-of-input) follows. Otherwise it is
 * escaped — fixing LLM text like "他说是"没问题"就走了".
 */
function tolerantParse(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch !== '"') {
      out += ch
      i++
      continue
    }
    // scan a string literal
    let j = i + 1
    let buf = '"'
    while (j < n) {
      const c = text[j]
      if (c === '\\') {
        buf += c + (text[j + 1] ?? '')
        j += 2
        continue
      }
      if (c === '"') {
        const rest = text.slice(j + 1)
        if (/^\s*([,}\]:]|$)/.test(rest)) {
          buf += '"'
          j++
          break
        }
        // embedded unescaped quote — escape it
        buf += '\\"'
        j++
        continue
      }
      buf += c
      j++
    }
    out += buf
    i = j
  }
  return out
}
