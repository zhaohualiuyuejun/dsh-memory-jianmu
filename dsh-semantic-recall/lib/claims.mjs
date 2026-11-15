/**
 * lib/claims.mjs —— 年轮 claim 召回（只读 <dataRoot>/year/<persona>/claims.jsonl）
 *
 * 复刻跑分器已验证的 S 家族 claim 路（2026-11-10，79.0%）：
 *   ① claim 向量 top-K → 锚点展开到 chunk → 与现有顺序 RRF(k=60)
 *   ② claim→chunk 语义桥：top-K claim 向量 × 全库 chunk 向量，各取 top-M → 再 RRF
 *
 * 约束：
 *   · 只读根藏 year/；claim 向量缓存写到调用方给的 cacheDir（插件 state 目录），不写根藏；
 *   · 无 claims / 无锚点 / 嵌入失败 ⇒ 原样返回 order，不抛；
 *   · 默认关（config.claims=false）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const RRF_K = 60
const CLAIM_CACHE = new Map()

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')

function readJsonl(file) {
  const out = []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip */ }
  }
  return out
}

/** 读年轮 claim（active 且有锚点），按文件 mtime+size 缓存 */
export function loadClaims(rootDir, personaId) {
  const root = String(rootDir || '').trim()
  const pid = String(personaId || '').trim()
  if (!root || !pid) return { available: false, claims: [], file: '', sig: '' }
  const file = path.join(root, 'year', pid, 'claims.jsonl')
  let sig = 'missing'
  try { const s = fs.statSync(file); sig = `${s.mtimeMs}|${s.size}` } catch { return { available: false, claims: [], file, sig } }
  const key = `${file}|${sig}`
  const hit = CLAIM_CACHE.get(key)
  if (hit) return hit
  // latest-wins：年轮会按 append-only 追加同 claimId 的新行（如 speaker 回填）。
  // 不去重会让同一条 claim 在召回里出现两次、白占 top-K 并把 RRF 权重翻倍。
  // Map 的 set 对已有 key 保留首次插入位置，与年轮 readClaims 的 byId 迭代顺序一致。
  const latest = new Map()
  for (const c of readJsonl(file)) {
    if (!c || !c.claimId) continue
    latest.set(c.claimId, c)
  }
  const claims = [...latest.values()]
    .filter((c) => c.status === 'active' && Array.isArray(c.derivedFrom) && c.derivedFrom.length)
    .map((c) => ({
      claimId: c.claimGroupId || c.claimId,
      title: c.title || '',
      body: c.body || '',
      topicHint: c.topicHint || '',
      anchors: c.derivedFrom.map((a) => a.chunkId).filter(Boolean),
      t: c.memoryT || 0,
    }))
  const out = { available: claims.length > 0, claims, file, sig }
  CLAIM_CACHE.set(key, out)
  return out
}

/** claim 文本表示（与跑分器一致：title + "\n" + body，截 1200） */
export function claimTextOf(c) {
  return `${c.title || ''}\n${c.body || ''}`.slice(0, 1200)
}

/**
 * 确保 claim 向量存在（缓存到 cacheDir；失败返回 null）。
 * 返回 { vecs: Float32Array, dim, count }
 */
export async function ensureClaimVectors({ claims, cacheDir, cfg, embedDocuments, model, dim, onProgress }) {
  if (!claims?.length) return null
  const texts = claims.map(claimTextOf)
  const hash = sha1(`${model}|${dim}|${texts.join('\u0001')}`).slice(0, 20)
  const slug = String(model || 'model').replace(/[^A-Za-z0-9._-]+/g, '_')
  const pidTag = sha1(claims.map((c) => c.claimId).join(',')).slice(0, 8)
  const binFile = path.join(cacheDir, `claim-vec-${slug}-d${dim}-${pidTag}.f32`)
  const metaFile = `${binFile}.json`
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (m.hash === hash && m.count === claims.length && fs.existsSync(binFile)) {
      const buf = fs.readFileSync(binFile)
      if (buf.length === claims.length * dim * 4) {
        const ab = new ArrayBuffer(buf.byteLength); new Uint8Array(ab).set(buf)
        return { vecs: new Float32Array(ab), dim, count: claims.length, cached: true }
      }
    }
  } catch { /* 无缓存 */ }

  // 增量复用：旧缓存里的 meta.keys 记录每条 claim 文本指纹，只嵌新增/变化的
  let reuse = null
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (Array.isArray(m.keys) && m.dim === dim) {
      const buf = fs.readFileSync(binFile)
      if (buf.length === m.keys.length * dim * 4) {
        const ab = new ArrayBuffer(buf.byteLength); new Uint8Array(ab).set(buf)
        const prev = new Float32Array(ab)
        reuse = new Map()
        m.keys.forEach((k, i) => { if (!reuse.has(k)) reuse.set(k, prev.subarray(i * dim, (i + 1) * dim)) })
      }
    }
  } catch { /* 旧缓存不可复用 */ }

  fs.mkdirSync(cacheDir, { recursive: true })
  const keys = texts.map((t) => sha1(t).slice(0, 20))
  const vec = new Float32Array(claims.length * dim)
  const miss = []
  for (let i = 0; i < claims.length; i++) {
    const hit = reuse?.get(keys[i])
    if (hit) vec.set(hit, i * dim)
    else miss.push(i)
  }
  const B = 16
  for (let i = 0; i < miss.length; i += B) {
    const batch = miss.slice(i, i + B).map((j) => texts[j])
    let out = null
    for (let a = 1; a <= 3; a++) {
      try { out = await embedDocuments(batch, cfg); break } catch (e) {
        if (a === 3) { console.warn(`[claims] 嵌入失败：${e?.message || e}`); return null }
        await new Promise((r) => setTimeout(r, 800 * a))
      }
    }
    out.forEach((v, k) => vec.set(v.slice(0, dim), miss[i + k] * dim))
    if (onProgress && (i / B) % 10 === 0) onProgress(Math.min(i + B, miss.length), miss.length)
  }
  try {
    fs.writeFileSync(binFile, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength))
    fs.writeFileSync(metaFile, JSON.stringify({ hash, count: claims.length, dim, model, keys, reused: claims.length - miss.length, builtAt: new Date().toISOString() }))
  } catch (e) { console.warn(`[claims] 缓存写入失败（不影响本次）：${e?.message || e}`) }
  return { vecs: vec, dim, count: claims.length, cached: false, reused: claims.length - miss.length }
}

function rrf(lists, k = RRF_K) {
  const fused = new Map()
  for (const { list, weight = 1 } of lists) {
    for (let r = 0; r < list.length; r++) fused.set(list[r], (fused.get(list[r]) || 0) + weight / (k + r + 1))
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i)
}

/**
 * 对 order 应用 claim 召回。返回 { order, stats }。
 * stats: { claims, expanded, bridge, top1 } — 供 note 回显
 */
export function applyClaimRecall({ order, queryVec, loaded, claims, claimVecs, idIndex, expand = 10, weight = 1, bridgeK = 3, bridgeM = 10, bridgeWeight = 1, useAnchors = true }) {
  const stats = { claims: claims?.length || 0, expanded: 0, bridge: 0 }
  if (!claims?.length || !claimVecs || !queryVec || !Array.isArray(order)) return { order, stats }
  const dim = claimVecs.dim
  const nC = claims.length
  const scored = new Array(nC)
  for (let i = 0; i < nC; i++) {
    const off = i * dim
    let s = 0
    for (let d = 0; d < dim; d++) s += queryVec[d] * claimVecs.vecs[off + d]
    scored[i] = { i, s }
  }
  scored.sort((a, b) => b.s - a.s)

  const expanded = []
  if (useAnchors) {
    const seen = new Set()
    for (const { i } of scored.slice(0, Math.max(1, expand))) {
      for (const anchor of claims[i].anchors) {
        const idx = idIndex.get(anchor)
        if (idx === undefined || seen.has(idx)) continue
        seen.add(idx); expanded.push(idx)
      }
    }
  }
  const bridge = []
  if (bridgeK > 0 && loaded?.vecs && loaded?.dim && loaded?.count) {
    const cdim = loaded.dim
    const seenB = new Set()
    for (const { i } of scored.slice(0, Math.max(1, bridgeK))) {
      const coff = i * dim
      const best = []
      for (let ci = 0; ci < loaded.count; ci++) {
        const off = ci * cdim
        let s = 0
        for (let d = 0; d < cdim; d++) s += claimVecs.vecs[coff + d] * loaded.vecs[off + d]
        if (best.length < bridgeM) {
          best.push({ i: ci, s })
          if (best.length === bridgeM) best.sort((x, y) => x.s - y.s)
        } else if (s > best[0].s) {
          best[0] = { i: ci, s }
          best.sort((x, y) => x.s - y.s)
        }
      }
      best.sort((x, y) => y.s - x.s)
      for (const { i: ci } of best) {
        if (seenB.has(ci)) continue
        seenB.add(ci); bridge.push(ci)
      }
    }
  }
  stats.expanded = expanded.length
  stats.bridge = bridge.length
  if (!expanded.length && !bridge.length) return { order, stats }
  const lists = [{ list: order, weight: 1 }]
  if (expanded.length) lists.push({ list: expanded, weight })
  if (bridge.length) lists.push({ list: bridge, weight: bridgeWeight })
  return { order: rrf(lists), stats }
}
