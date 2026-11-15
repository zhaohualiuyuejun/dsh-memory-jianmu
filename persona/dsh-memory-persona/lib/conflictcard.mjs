/**
 * lib/conflictcard.mjs —— P2.5 冲突卡：渲染 + 回合状态（2026-11-12）
 *
 * 只做「把熏习给的 A/B 两说渲染成一小段提示」：
 *   · 默认关（settings.conflictCard=false）；关着返回空串，注入与现在逐字一致；
 *   · 最多 2 张、总预算 ≤300 字；放不下整卡就跳过，绝不截半卡；
 *   · 只提示「两种说法并存，未裁决」，绝不替用户下结论、绝不裁决；
 *   · 同一回合最多注入一次；同样内容在去重窗口内不重复注入；
 *   · 日志只写元数据（张数/字数/conflictId），不写正文。
 */

export const CONFLICT_MAX_CARDS = 2
export const CONFLICT_MAX_CHARS = 300
export const CONFLICT_SIDE_MAX_CHARS = 120
export const CONFLICT_HEADER = '【未裁决的两种说法（只提示，不替你做结论）】'
export const CONFLICT_FOOTER = '（以上是两种说法并存，请勿把其中一条当成定论。）'

const WHO = { user: '用户', assistant: '助手' }

/** 压平空白 + 超长截断（与熏习侧同口径；这里再防一道，别把整段正文塞进提示词） */
export function clampText(text, max = CONFLICT_SIDE_MAX_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const lim = Math.max(8, Number(max) || CONFLICT_SIDE_MAX_CHARS)
  if (!s) return ''
  if (s.length <= lim) return s
  return `${s.slice(0, lim - 1)}…`
}

function renderSide(side, sideMaxChars, label) {
  if (!side || typeof side !== 'object') return ''
  const text = clampText(side.text, sideMaxChars)
  if (!text) return ''
  const date = side.dateText || '日期不明'
  const who = WHO[side.role] || '记录'
  return `- ⚠️ ${date} · ${who}：${text}（${label}）`
}

/**
 * 单张卡 = 两行（A/B），缺任一边返回空串（整卡跳过）。
 */
export function renderOneConflictCard(card, { sideMaxChars = CONFLICT_SIDE_MAX_CHARS } = {}) {
  if (!card || typeof card !== 'object') return ''
  const a = renderSide(card.a, sideMaxChars, 'A')
  const b = renderSide(card.b, sideMaxChars, 'B')
  if (!a || !b) return ''
  return `${a}\n${b}`
}

/**
 * 渲染注入块；没有可用卡 / 开关关闭 → 空串。
 * @returns {{text:string, cards:number, chars:number, ids:string[], dropped:number}}
 */
export function renderConflictCards(cards, {
  maxChars = CONFLICT_MAX_CHARS,
  maxCards = CONFLICT_MAX_CARDS,
  sideMaxChars = CONFLICT_SIDE_MAX_CHARS,
  enabled = true,
} = {}) {
  const out = { text: '', cards: 0, chars: 0, ids: [], dropped: 0 }
  if (enabled !== true) return out
  const list = Array.isArray(cards) ? cards : []
  const lim = Math.max(1, Number(maxCards) || CONFLICT_MAX_CARDS)
  const cap = Math.max(80, Number(maxChars) || CONFLICT_MAX_CHARS)
  // 头尾必须完整；连头尾都放不下就不注入（绝不写半段）
  const base = CONFLICT_HEADER.length + 1 + CONFLICT_FOOTER.length
  if (base > cap) return out

  const blocks = []
  const ids = []
  let used = base
  for (const card of list) {
    if (blocks.length >= lim) { out.dropped += 1; continue }
    const block = renderOneConflictCard(card, { sideMaxChars })
    if (!block) { out.dropped += 1; continue }
    const cost = block.length + 1 // 换行
    if (used + cost > cap) { out.dropped += 1; continue } // 放不下整卡 → 跳过，不截半卡
    blocks.push(block)
    ids.push(String(card.conflictId || ''))
    used += cost
  }
  if (!blocks.length) return out
  out.text = `${CONFLICT_HEADER}\n${blocks.join('\n')}\n${CONFLICT_FOOTER}`
  out.cards = blocks.length
  out.chars = out.text.length
  out.ids = ids
  return out
}

/** FNV-1a 32 位：只用于内容指纹去重（与 autorecall 同算法，互不依赖） */
export function fingerprint(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * 会话级状态：begin → attach(promise) → resolve(block) → take()
 * take() 只在「本回合还没给过 + 内容指纹未在去重窗口内出现过」时返回文本。
 */
export function createConflictCardState({ dedupeMs = 10 * 60 * 1000, maxSessions = 128 } = {}) {
  const states = new Map()
  const get = (sid, create = false) => {
    if (!sid) return null
    let s = states.get(sid)
    if (!s && create) {
      s = {
        turn: null, query: '', status: 'idle', block: '', pending: null, waited: false,
        injectedTurn: null, lastFp: '', lastFpAt: 0, meta: null,
      }
      states.set(sid, s)
      if (states.size > maxSessions) states.delete(states.keys().next().value)
    }
    return s || null
  }

  return {
    /** 新回合开始：清空上一回合的块；同一回合由 injectedTurn 挡住重复注入 */
    begin(sid, { query = '', turn = null } = {}) {
      const s = get(sid, true)
      if (!s) return { ok: false, code: 'NO_SESSION' }
      s.block = ''
      s.status = 'idle'
      s.pending = null
      s.waited = false
      s.meta = null
      s.turn = turn
      s.query = String(query || '')
      s.injectedTurn = null
      return { ok: true }
    },

    attach(sid, turn, promise) {
      const s = get(sid)
      if (!s || s.turn !== turn) return false
      s.pending = promise
      s.waited = false
      return true
    },

    resolve(sid, { turn, block = '', meta = null } = {}) {
      const s = get(sid)
      if (!s || s.turn !== turn || s.status !== 'idle') return false
      s.pending = null
      s.block = String(block || '')
      s.meta = meta
      s.status = s.block ? 'ready' : 'miss'
      return true
    },

    /** assemble 前等一小会儿（本地读盘，硬上限；同一回合只等一次） */
    async waitFor(sid, maxWaitMs = 0) {
      const s = get(sid)
      if (!s || !s.pending) return false
      const ms = Math.max(0, Number(maxWaitMs) || 0)
      if (!ms || s.waited) return false
      s.waited = true
      const p = s.pending
      await Promise.race([p.catch(() => {}), new Promise((r) => {
        const t = setTimeout(r, ms)
        if (t?.unref) t.unref()
      })])
      return true
    },

    /** 取本回合要注入的块；取过一次就标记，后续 step 不再给 */
    take(sid, now = Date.now()) {
      const s = get(sid)
      if (!s || s.status !== 'ready' || !s.block) return ''
      if (s.injectedTurn === s.turn && s.turn !== null) return ''
      const fp = fingerprint(s.block)
      if (fp && fp === s.lastFp && now - s.lastFpAt < Math.max(1000, Number(dedupeMs) || 600000)) return ''
      s.injectedTurn = s.turn
      s.lastFp = fp
      s.lastFpAt = now
      return s.block
    },

    cancel(sid) {
      const s = get(sid)
      if (s) { s.status = 'idle'; s.block = ''; s.pending = null }
    },
    peek(sid) {
      const s = get(sid)
      if (!s) return null
      return {
        turn: s.turn, query: s.query, status: s.status,
        blockChars: s.block.length, injectedTurn: s.injectedTurn, meta: s.meta,
      }
    },
    dispose(sid) { states.delete(sid) },
    size() { return states.size },
  }
}

/** 观测行：只有元数据，绝不带正文 */
export function renderConflictLogRow(meta) {
  return {
    t: Date.now(),
    sid: meta?.sid ? String(meta.sid).slice(-12) : null,
    n: Number(meta?.n) || 0,
    chars: Number(meta?.chars) || 0,
    conflictIds: Array.isArray(meta?.conflictIds) ? meta.conflictIds.slice(0, 5).map(String) : [],
    outcome: String(meta?.outcome || 'unknown'),
  }
}
