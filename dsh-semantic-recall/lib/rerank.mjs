/**
 * lib/rerank.mjs —— bge 重排（SiliconFlow /v1/rerank）与「按重排结果重建会话视图」
 *
 * 目的（2026-11-11）：把昨晚 S0 = 寻枝 + A2 索引 + bge 重排 里的**重排**真正做进产品。
 *   · 只对最终排序的前 topN（默认 50）做重排，尾部保持原序；
 *   · 任何失败（无 Key / 超时 / HTTP 错）都**降级为原顺序**并返回原因，绝不抛；
 *   · 默认关（config.rerank=false），不改变任何现有行为。
 */

const RERANK_URL = 'https://api.siliconflow.cn/v1/rerank'

/**
 * 调重排 API，返回重排后的全局下标顺序。
 * @returns {Promise<{order:number[], scoreOf:Map<number,number>, tokens:number, ms:number, degraded?:string}|null>}
 */
export async function rerankOrder({ query, flat, chunks, model, topN = 50, chars = 600, apiKey, timeoutMs = 20000 }) {
  const key = String(apiKey || '').trim()
  if (!key) return { order: flat, scoreOf: new Map(), tokens: 0, ms: 0, degraded: 'no-key' }
  if (!Array.isArray(flat) || !flat.length) return { order: flat || [], scoreOf: new Map(), tokens: 0, ms: 0, degraded: 'empty' }
  const head = flat.slice(0, topN)
  const tail = flat.slice(topN)
  const documents = head.map((i) => String(chunks[i]?.text || '').slice(0, chars))
  const t0 = Date.now()
  let body = null
  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(RERANK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, query, documents, top_n: documents.length }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`; throw new Error(lastErr) }
      body = await res.json()
      break
    } catch (e) {
      lastErr = String(e?.message || e).slice(0, 200)
      if (attempt === 3) return { order: flat, scoreOf: new Map(), tokens: 0, ms: Date.now() - t0, degraded: lastErr }
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  const results = Array.isArray(body?.results) ? body.results : []
  const order = []
  const scoreOf = new Map()
  const seen = new Set()
  for (const r of results) {
    const idx = head[r.index]
    if (idx === undefined || seen.has(idx)) continue
    seen.add(idx)
    order.push(idx)
    scoreOf.set(idx, Number(r.relevance_score) || 0)
  }
  for (const i of head) if (!seen.has(i)) { order.push(i); scoreOf.set(i, 0) }
  return {
    order: [...order, ...tail],
    scoreOf,
    tokens: Number(body?.meta?.tokens?.input_tokens || 0),
    ms: Date.now() - t0,
  }
}

/**
 * 按重排后的全局顺序重建 `grouped`（会话视图），供 buildRankedSessions 使用。
 * 会话顺序 = 首次出现顺序；组内条目顺序 = 重排顺序；score 取组内最高分。
 * 未参与重排的会话（尾部）沿用旧 score。
 */
export function regroupByFlat(r, chunks, order, scoreOf) {
  const oldBySession = new Map((r.grouped || []).map((g) => [g.session, g]))
  const by = new Map()
  for (const i of order) {
    const c = chunks[i]
    if (!c) continue
    const sid = c.session
    let g = by.get(sid)
    if (!g) {
      const old = oldBySession.get(sid)
      g = {
        session: sid,
        ws: c.ws,
        wsPretty: c.wsPretty,
        items: [],
        score: 0,
        rawScore: old?.rawScore ?? 0,
        lexScore: old?.lexScore ?? 0,
        _old: old?.score ?? 0,
      }
      by.set(sid, g)
    }
    g.items.push(i)
    const s = scoreOf?.get(i)
    if (s !== undefined && s > g.score) g.score = s
  }
  for (const g of by.values()) {
    // 尾部会话没有重排分：沿用旧分（保证 minRatio 过滤不会误杀）
    if (!g.score) g.score = g._old
    delete g._old
  }
  return [...by.values()]
}
