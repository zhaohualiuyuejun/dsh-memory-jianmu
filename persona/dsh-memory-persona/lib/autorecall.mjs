/**
 * lib/autorecall.mjs —— P2 自动召回：闸门、渲染与会话状态（2026-11-12）
 *
 * 这一层负责「该不该提」和「怎么提」；检索本身在寻枝（服务 jianmuRecall）。
 *
 * 三级闸门（设计稿 §4，G1 有调整，见下）：
 *   G0 规则闸门：线索词 / 句尾问号 —— 0 成本，闲聊直接挡掉
 *   G1 字面佐证：命中后看查询与原文的词面重合 —— 有重合，或分数明显高于阈值才放行
 *      · 设计稿原本是「检索前先 BM25 快筛」，但镜台侧没有可用的 BM25 语料；
 *        硬造一份索引会拖慢启动。改为「拿到命中后做字面佐证」，省不了嵌入钱，
 *        但同样能挡住纯语义漂移。
 *   G2 向量召回：寻枝 prefetch（minScore / topN / 死线）
 *
 * 注入纪律：
 *   · 每条一行，≤ autoRecallMaxChars，绝不截半行；
 *   · 必须带 dateText；末尾写「不确定是否该提 / 无关请忽略」；
 *   · 同一会话有冷却；同一内容指纹在冷却窗口内不重复注入；
 *   · 只存正文块在内存里（会话级），不落正文日志。
 */

export const DEFAULT_CUES = '上次|上回|之前|以前|当时|当初|记得|还记得|我说过|提过|那个|那件事|刚才说的|后面说的|早先'

/** 把「a|b|c」「a,b,c」或数组统一成线索词数组 */
export function parseCues(cues) {
  if (Array.isArray(cues)) return cues.map((s) => String(s).trim()).filter(Boolean)
  const raw = String(cues ?? '').trim() || DEFAULT_CUES
  return raw.split(/[|,，、\s]+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * G0：这一回合值不值得去查？
 * @returns {{ok:boolean, reason:string}}
 */
export function passesG0(text, cues) {
  const s = String(text ?? '').trim()
  if (!s) return { ok: false, reason: 'empty' }
  if (s.length < 2) return { ok: false, reason: 'too-short' }
  if (s.length > 2000) return { ok: false, reason: 'too-long' }
  for (const cue of parseCues(cues)) {
    if (cue && s.includes(cue)) return { ok: true, reason: `cue:${cue}` }
  }
  if (/[?？]\s*$/.test(s)) return { ok: true, reason: 'question' }
  return { ok: false, reason: 'no-cue' }
}

const WHO = { user: '用户', assistant: '助手' }

/** 单条命中 → 一行（压平空白；日期/角色必带） */
export function renderHitLine(hit) {
  if (!hit || typeof hit.text !== 'string') return ''
  const body = hit.text.replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const date = hit.dateText || '日期不明'
  const who = WHO[hit.role] || '记录'
  return `- ${date} · ${who}：${body}`
}

/**
 * 从寻枝 prefetch 结果里挑要注入的条目（G1 + 预算）。
 * @returns {{hits:object[], chars:number, dropped:{belowScore:number, noLiteral:number, overBudget:number}}}
 */
export function pickHits(recall, { minScore = 0.62, topN = 2, maxChars = 320, literalBoost = 0.08 } = {}) {
  const list = Array.isArray(recall?.hits) ? recall.hits : []
  const dropped = { belowScore: 0, noLiteral: 0, overBudget: 0 }
  const hits = []
  let chars = 0
  const cap = Math.max(40, Number(maxChars) || 320)
  for (const h of list) {
    if (!h || typeof h.text !== 'string' || !h.text.trim()) continue
    const score = Number(h.score) || 0
    if (score < Number(minScore)) { dropped.belowScore += 1; continue }
    const lex = Number(h.lex) || 0
    // G1：没有任何词面重合时，要求分数明显高于阈值（防纯语义漂移）
    if (lex <= 0 && score < Number(minScore) + Number(literalBoost)) { dropped.noLiteral += 1; continue }
    const line = renderHitLine(h)
    if (!line) continue
    if (chars + line.length + 1 > cap) { dropped.overBudget += 1; continue } // 放不下整行就跳过，不截半行
    hits.push({ ...h, line })
    chars += line.length + 1
    if (hits.length >= Math.max(1, Number(topN) || 2)) break
  }
  return { hits, chars, dropped }
}

/** 拼注入段；hits 为空返回空串（绝不注入只有标题的空块） */
export function renderBlock(hits) {
  const rows = (hits || []).map((h) => h.line || renderHitLine(h)).filter(Boolean)
  if (!rows.length) return ''
  return [
    '【可能相关的旧记忆（自动召回，不确定是否该提）】',
    ...rows,
    '（若与当前问题无关，请忽略，不要主动提起；引用时带上日期。）',
  ].join('\n')
}

/** FNV-1a 32 位：只用于内容指纹去重 */
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
 * 会话级状态机：
 *   begin → pending（带一个 promise）→ resolve(block|'') → ready/miss
 *   render 只在 ready 且未过期时给文本；被注入后记指纹。
 */
export function createAutoRecallState({ getCooldownMs = () => 60000, getTtlMs = () => 120000, dedupeMs = 10 * 60 * 1000, maxSessions = 128 } = {}) {
  const states = new Map()
  const get = (sid, create = false) => {
    if (!sid) return null
    let s = states.get(sid)
    if (!s && create) {
      s = {
        turn: null, query: '', status: 'idle', block: '', blockAt: 0, pending: null, waited: false,
        lastStartAt: 0, lastQuery: '', lastBlockAt: 0, lastFp: '', lastFpAt: 0, meta: null,
      }
      states.set(sid, s)
      if (states.size > maxSessions) states.delete(states.keys().next().value)
    }
    return s || null
  }

  return {
    /** 新回合开始：清掉上一回合的块，判冷却 */
    begin(sid, { query, turn = null, now = Date.now() } = {}) {
      const s = get(sid, true)
      if (!s) return { ok: false, code: 'NO_SESSION' }
      s.block = ''
      s.status = 'idle'
      s.pending = null
      s.waited = false
      s.meta = null
      s.turn = turn
      s.query = String(query || '')
      if (!s.query) return { ok: false, code: 'EMPTY' }
      const cd = Math.max(0, Number(getCooldownMs()) || 0)
      if (s.lastStartAt && now - s.lastStartAt < cd) {
        return { ok: false, code: 'COOLDOWN', remainMs: cd - (now - s.lastStartAt) }
      }
      if (s.lastQuery && s.lastQuery === s.query && s.lastBlockAt && now - s.lastBlockAt < cd) {
        return { ok: false, code: 'DUP_QUERY', remainMs: cd - (now - s.lastBlockAt) }
      }
      s.lastStartAt = now
      s.status = 'pending'
      return { ok: true }
    },

    /** 挂上异步预取的 promise（不 await 它） */
    attach(sid, turn, promise) {
      const s = get(sid)
      if (!s || s.turn !== turn) return false
      s.pending = promise
      s.waited = false
      return true
    },

    /** 预取完成：只有回合还对得上才收（过期结果直接丢） */
    resolve(sid, { turn, block = '', meta = null, code = null, now = Date.now() } = {}) {
      const s = get(sid)
      if (!s || s.turn !== turn || s.status !== 'pending') return false
      s.pending = null
      s.block = String(block || '')
      s.blockAt = now
      s.meta = { ...(meta || {}), code }
      s.status = s.block ? 'ready' : 'miss'
      if (s.block) { s.lastQuery = s.query; s.lastBlockAt = s.blockAt }
      return true
    },

    /** 组装 prompt 前等一小会儿（硬上限）；同一个 pending 只等一次，避免每个 step 都等 800ms */
    async waitFor(sid, maxWaitMs = 0) {
      const s = get(sid)
      if (!s || !s.pending) return false
      const ms = Math.max(0, Number(maxWaitMs) || 0)
      if (!ms) return false
      if (s.waited) return false
      s.waited = true
      const p = s.pending
      await Promise.race([p.catch(() => {}), new Promise((r) => {
        const t = setTimeout(r, ms)
        if (t?.unref) t.unref()
      })])
      return true
    },

    /** 取本回合要注入的块（同一块在去重窗口内不重复注入） */
    render(sid, now = Date.now()) {
      const s = get(sid)
      if (!s || s.status !== 'ready' || !s.block) return ''
      if (now - s.blockAt > Math.max(1000, Number(getTtlMs()) || 120000)) {
        s.status = 'expired'
        s.block = ''
        return ''
      }
      const fp = fingerprint(s.block)
      if (fp && fp === s.lastFp && now - s.lastFpAt < dedupeMs) return '' // 内容没变，别反复提
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
        blockChars: s.block.length, meta: s.meta,
        sinceStartMs: s.lastStartAt ? Date.now() - s.lastStartAt : null,
      }
    },
    dispose(sid) { states.delete(sid) },
    size() { return states.size },
  }
}

/** 观测行：只有元数据，绝不带正文 */
export function renderLogRow(meta) {
  const row = {
    t: Date.now(),
    sid: meta?.sid ? String(meta.sid).slice(-12) : null,
    g0: meta?.g0 === true,
    g0r: meta?.g0Reason || null,
    ms: Number.isFinite(meta?.ms) ? meta.ms : null,
    embedMs: Number.isFinite(meta?.embedMs) ? meta.embedMs : null,
    score: Number.isFinite(meta?.score) ? Number(meta.score.toFixed(3)) : null,
    lex: Number.isFinite(meta?.lex) ? Number(meta.lex.toFixed(3)) : null,
    n: Number(meta?.n) || 0,
    chars: Number(meta?.chars) || 0,
    outcome: String(meta?.outcome || 'unknown'),
  }
  return row
}
