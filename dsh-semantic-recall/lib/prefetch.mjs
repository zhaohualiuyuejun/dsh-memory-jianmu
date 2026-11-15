/**
 * lib/prefetch.mjs —— 自动召回预取（P2，2026-11-12）
 *
 * 与 session_recall 工具的区别（这是「每回合一次、必须快」的路径）：
 *   · 不读年轮 claim、不做 bge 重排、不做熏习卫生、不写任何文件、不建索引；
 *   · 只做：根藏索引（调用方已加载/缓存）→ 查询向量 → 余弦打分 → topN 命中；
 *   · 嵌入可超时放弃（Promise.race），失败一律返回 {ok:false}，绝不抛。
 *
 * 镜台侧再把命中拼成 ≤320 字的注入段（lib/autorecall.mjs），三级闸门在那里。
 */

import { dateFields, excerptText } from './present.mjs'

const CJK_RUN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g

/** 字面 token：中文 bigram（单字 run 用单字）+ 英文数字词（≥2） */
export function tokensOf(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w)
  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

/** 查询与命中的字面重合度（0..1）：给镜台做「字面佐证」闸门 */
export function literalOverlap(query, text) {
  const q = tokensOf(query)
  if (!q.length) return 0
  const t = new Set(tokensOf(text))
  let hit = 0
  for (const w of q) if (t.has(w)) hit++
  return hit / q.length
}

const dotAt = (vecs, off, dim, q) => {
  let s = 0
  for (let d = 0; d < dim; d++) s += vecs[off + d] * q[d]
  return s
}

const normAt = (vecs, off, dim) => {
  let s = 0
  for (let d = 0; d < dim; d++) { const v = vecs[off + d]; s += v * v }
  return Math.sqrt(s)
}

/**
 * 余弦 top-N（假定根藏向量已归一；前 N 名再用真实模长校正）。
 * @returns {Array<{i:number, score:number}>}
 */
export function scoreTop({ loaded, queryVec, topN = 3 }) {
  const dim = Number(loaded?.dim) || 0
  const vecs = loaded?.vecs
  const count = Number(loaded?.count) || 0
  if (!dim || !vecs || !count || !queryVec || queryVec.length !== dim) return []
  const qNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0)) || 1
  const scored = []
  for (let i = 0; i < count; i++) {
    const s = dotAt(vecs, i * dim, dim, queryVec) / qNorm
    if (s > 0) scored.push({ i, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, Math.max(1, topN + 7))
  for (const t of top) {
    const cn = normAt(vecs, t.i * dim, dim) || 1
    t.score = Math.max(0, Math.min(1, t.score / cn))
  }
  top.sort((a, b) => b.score - a.score)
  return top.slice(0, Math.max(1, topN))
}

const TIMEOUT = Symbol('timeout')

/**
 * 预取一次。绝不抛。
 * @param {object} o
 * @param {object} o.loaded       根藏索引（rootsource.loadRootIndex().loaded）
 * @param {string} o.query        用户这一回合的原话
 * @param {Function} o.embedQueryFn async (query) => number[] | number[][]（必须由调用方注入）
 * @param {number} [o.deadlineMs] 嵌入超时（默认 800ms）
 * @param {number} [o.minScore]   预筛下限（真正的注入闸门在镜台）
 * @param {number} [o.topN]       返回几条
 * @param {number} [o.excerptChars] 每条正文截多少字
 * @param {number} [o.nowMs]
 */
export async function prefetchRecall({
  loaded, query, embedQueryFn, deadlineMs = 800, minScore = 0.55, topN = 3,
  excerptChars = 200, nowMs = Date.now(),
}) {
  const started = Date.now()
  const text = String(query ?? '').trim()
  if (!text) return { ok: false, code: 'BAD_QUERY', ms: 0 }
  if (!loaded?.vecs || !Number(loaded?.dim) || !Number(loaded?.count)) {
    return { ok: false, code: 'NO_INDEX', ms: Date.now() - started }
  }
  if (typeof embedQueryFn !== 'function') return { ok: false, code: 'NO_EMBED', ms: 0 }

  let timer = null
  let vecOut
  const tEmbed = Date.now()
  try {
    const raced = await Promise.race([
      Promise.resolve().then(() => embedQueryFn(text)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), Math.max(50, Number(deadlineMs) || 800))
        if (timer?.unref) timer.unref()
      }),
    ])
    if (raced === TIMEOUT) return { ok: false, code: 'TIMEOUT', ms: Date.now() - started, embedMs: Date.now() - tEmbed }
    vecOut = raced
  } catch (e) {
    return { ok: false, code: 'EMBED_FAILED', ms: Date.now() - started, embedMs: Date.now() - tEmbed, reason: String(e?.message || e).slice(0, 200) }
  } finally {
    if (timer) clearTimeout(timer)
  }

  // embedQuery 可能返回 vec、[vec]、Float32Array 或 [Float32Array]
  const queryVec = ArrayBuffer.isView(vecOut)
    ? vecOut
    : (Array.isArray(vecOut) && vecOut.length && (ArrayBuffer.isView(vecOut[0]) || Array.isArray(vecOut[0])) ? vecOut[0] : vecOut)
  if (!queryVec || typeof queryVec.length !== 'number' || !queryVec.length) {
    return { ok: false, code: 'EMBED_EMPTY', ms: Date.now() - started, embedMs: Date.now() - tEmbed }
  }
  if (queryVec.length !== Number(loaded.dim)) {
    return { ok: false, code: 'DIM_MISMATCH', ms: Date.now() - started, embedMs: Date.now() - tEmbed, dim: { query: queryVec.length, index: Number(loaded.dim) } }
  }

  const chunks = loaded.meta?.chunks || []
  const scored = scoreTop({ loaded, queryVec, topN: Math.max(topN * 4, topN) })
  const hits = []
  for (const { i, score } of scored) {
    if (score < Number(minScore)) continue
    const c = chunks[i]
    if (!c || typeof c.text !== 'string' || !c.text) continue
    const df = dateFields(c.t, nowMs)
    const overlap = literalOverlap(text, c.text)
    // P0 起 excerptText 返回 {text, truncated, fullChars}（老版本返回字符串）：两种都兼容
    const ex = excerptText(c.text, Math.max(40, excerptChars), 40)
    hits.push({
      chunkId: c.chunkId,
      session: c.session ?? null,
      seq: c.seq ?? null,
      t: Number.isFinite(Number(c.t)) ? Number(c.t) : null,
      dateText: df.dateText,
      ageDays: df.ageDays,
      role: c.role === 'assistant' ? 'assistant' : 'user',
      score: Number(score.toFixed(4)),
      lex: Number(overlap.toFixed(3)),
      text: typeof ex === 'string' ? ex : String(ex?.text ?? ''),
      truncated: typeof ex === 'object' ? Boolean(ex?.truncated) : false,
    })
    if (hits.length >= Math.max(1, topN)) break
  }
  return {
    ok: true,
    code: hits.length ? 'HIT' : 'NO_HIT',
    ms: Date.now() - started,
    embedMs: Date.now() - tEmbed,
    scanned: Number(loaded.count) || 0,
    hits,
  }
}
