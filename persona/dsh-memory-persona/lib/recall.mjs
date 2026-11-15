/**
 * lib/recall.mjs —— 压缩后补偿（移植自 soul-md 的 compactionRecall，2026-11-08）
 *
 * 只做两件事：
 *   1) 记录「本会话读过哪些 topic」的描述符（key / title / summary，**绝不存正文**）；
 *   2) 检测到会话压缩（compaction/prune 或 compaction/end 无错）后，下一次注入时把
 *      这些描述符重新附一小段，让压缩后仍记得「我去查过什么」。
 *
 * 不注入正文、不做语义检索、不调模型。字符预算由 recallMaxChars 控制，
 * 条数由 recallMaxTopics 控制。
 */

/** 安全整数：非法值回退，超界夹紧 */
export function boundedInteger(value, fallback, max, min = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** 只拼描述行；单行放不下就跳过，绝不截断半行 */
export function renderRecall(groups, cap) {
  const lines = []
  for (const { heading, topics } of groups) {
    const rows = []
    for (const { key, title, summary } of topics) {
      const row = `- ${JSON.stringify(key)} — ${title}：${summary}`
      if ([...lines, heading, ...rows, row].join('\n').length > cap) continue
      rows.push(row)
    }
    if (rows.length) lines.push(heading, ...rows)
  }
  return lines.join('\n')
}

/**
 * 会话级补偿状态。
 * - reportConsulted：memory_read 读到 topic 时登记
 * - markCompacted：收到压缩事件
 * - claimTurn：下一次用户消息到达（把 pending 变成待注入的 recovery）
 * - takeRecovery：注入时取走（只给一次）
 */
export function createRecallStore({ maxConsulted = 128 } = {}) {
  const states = new Map()
  const stateOf = (sid, create = false) => {
    if (!sid) return null
    let s = states.get(sid)
    if (!s && create) {
      s = { consulted: new Map(), pending: false, recovery: [] }
      states.set(sid, s)
    }
    return s || null
  }
  return {
    reportConsulted(sid, entry) {
      if (!sid || !entry || !entry.key) return
      const s = stateOf(sid, true)
      const k = `${entry.source || ''}\0${entry.key}`
      s.consulted.delete(k)
      s.consulted.set(k, {
        source: entry.source || '',
        key: String(entry.key),
        title: String(entry.title || entry.key),
        summary: String(entry.summary || '').replace(/\s+/g, ' ').slice(0, 160),
      })
      if (s.consulted.size > maxConsulted) s.consulted.delete(s.consulted.keys().next().value)
    },
    markCompacted(sid) {
      const s = stateOf(sid, true)
      if (s) s.pending = true
    },
    claimTurn(sid) {
      const s = stateOf(sid)
      if (!s) return
      if (s.pending) {
        s.recovery = [...s.consulted.values()]
        s.pending = false
      }
    },
    takeRecovery(sid) {
      const s = stateOf(sid)
      if (!s || !s.recovery.length) return []
      const out = s.recovery
      s.recovery = []
      return out
    },
    peek(sid) {
      const s = stateOf(sid)
      return s ? { consulted: [...s.consulted.values()], pending: s.pending, recovery: s.recovery } : null
    },
    dispose(sid) { states.delete(sid) },
    size() { return states.size },
  }
}
