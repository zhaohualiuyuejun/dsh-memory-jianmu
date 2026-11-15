/**
 * lib/diff.mjs —— 行级 diff（人格卡版本对比）
 *
 * 小文件用 LCS；行数超过阈值时退化为「公共前后缀 + 中间整段替换」，
 * 保证大卡也不会卡死。只读，不写任何文件。
 */

export function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
}

function lcsRows(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', oldLine: i + 1, newLine: j + 1, text: a[i] })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] })
      i++
    } else {
      rows.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) { rows.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] }); i++ }
  while (j < m) { rows.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j] }); j++ }
  return rows
}

function coarseRows(a, b) {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const rows = []
  for (let i = 0; i < pre; i++) rows.push({ type: 'same', oldLine: i + 1, newLine: i + 1, text: a[i] })
  for (let i = pre; i < a.length - suf; i++) rows.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] })
  for (let i = pre; i < b.length - suf; i++) rows.push({ type: 'add', oldLine: null, newLine: i + 1, text: b[i] })
  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k
    const bi = b.length - suf + k
    rows.push({ type: 'same', oldLine: ai + 1, newLine: bi + 1, text: a[ai] })
  }
  return rows
}

/** 结构化 diff + unified 文本 */
export function diffLines(oldText, newText, opts = {}) {
  const { context = 3, maxLines = 1500 } = opts
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const rows = a.length > maxLines || b.length > maxLines ? coarseRows(a, b) : lcsRows(a, b)
  const stats = {
    added: rows.filter((r) => r.type === 'add').length,
    removed: rows.filter((r) => r.type === 'del').length,
    same: rows.filter((r) => r.type === 'same').length,
  }
  // unified 文本：变化行 + context 行，带 @@ -a,b +c,d @@ 头
  const out = []
  let lastEmitted = -1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.type === 'same') continue
    const from = Math.max(lastEmitted + 1, i - context)
    const to = Math.min(rows.length - 1, i + context)
    if (from > lastEmitted + 1) {
      const range = rows.slice(from, to + 1)
      const oldLines = range.map((x) => x.oldLine).filter((n) => n != null)
      const newLines = range.map((x) => x.newLine).filter((n) => n != null)
      const oldStart = oldLines.length ? oldLines[0] : (rows[from - 1]?.oldLine ?? 0) + 1
      const newStart = newLines.length ? newLines[0] : (rows[from - 1]?.newLine ?? 0) + 1
      out.push(`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`)
    }
    for (let k = from; k <= to; k++) {
      const x = rows[k]
      const prefix = x.type === 'add' ? '+' : x.type === 'del' ? '-' : ' '
      out.push(`${prefix}${x.text}`)
    }
    lastEmitted = to
  }
  if (out.length === 0) out.push('（两版正文相同）')
  return { rows, stats, unified: out.join('\n'), truncated: rows.length < a.length + b.length && (a.length > maxLines || b.length > maxLines) }
}
