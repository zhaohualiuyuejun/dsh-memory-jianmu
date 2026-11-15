/**
 * lib/hygiene.mjs —— 熏习「卫生策略」只读适配层（寻枝侧）
 *
 * 只做三件事，**只读** `<dataRoot>/process/<persona>/`，不写任何文件：
 *   1) stale 过滤：superseded / archived / expired 不进候选（默认关闭）
 *   2) 重复组折叠：非代表块映射到代表块并去重（保留代表块最高名次）
 *   3) conflicted 降权：conflictGroup 非空的块降到候选尾部（默认 0.8，不等价删除）
 *
 * 设计约束（2026-11-11 计划 §4）
 *   · 默认关：调用方不传策略 ⇒ rankQuery 完全走旧路径，逐位一致；
 *   · 数据缺失/解析失败 ⇒ 返回 available:false 的空策略，绝不抛；
 *   · 缓存按 state/duplicates 的 mtime+size 失效，热路径不重复读盘；
 *   · 代表块 = 组内时间最晚的一条（与出题/跑分口径一致）；最晚的若 stale，取未 stale 里最晚的。
 */

import fs from 'node:fs'
import path from 'node:path'

export const STALE_STATUS = new Set(['superseded', 'archived', 'expired'])

/** key = `${stateFile}|${dupMode}` → { sig, h } */
const FILE_CACHE = new Map()

function sigOf(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}|${s.size}` } catch { return 'missing' }
}

function parseJsonl(file, maxBad = 50) {
  const rows = []
  let bad = 0
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { rows, bad: 0, missing: true } }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { if (++bad > maxBad) break }
  }
  return { rows, bad, missing: false }
}

function emptyStrategy(reason) {
  return {
    available: false, degraded: true, reason,
    state: new Map(), groups: [], members: new Map(), repOf: new Map(),
    dupMode: 'off', sig: '', counts: { state: 0, groups: 0, stale: 0, conflicted: 0 },
    _idxCache: new WeakMap(), _repCache: new WeakMap(),
  }
}

/**
 * 读取熏习策略。
 * @param {string} dataRoot 根藏 dataRoot（与寻枝 config.rootStore 同值）
 * @param {string} personaId 人格 id（alice / bob / …）
 * @param {{dupMode?:'pending'|'accepted'}} opts pending=所有重复组都折叠（默认）；accepted=只折叠已 accepted 的组
 */
export function loadHygiene(dataRoot, personaId, { dupMode = 'pending' } = {}) {
  const root = String(dataRoot || '').trim()
  const pid = String(personaId || '').trim()
  if (!root || !pid) return emptyStrategy('no_root_or_persona')
  const base = path.join(root, 'process', pid)
  const stateFile = path.join(base, 'state.jsonl')
  const dupFile = path.join(base, 'duplicates.jsonl')
  const mode = dupMode === 'accepted' ? 'accepted' : 'pending'
  const key = `${stateFile}|${mode}`
  const sig = `${sigOf(stateFile)}/${sigOf(dupFile)}/${mode}`
  const hit = FILE_CACHE.get(key)
  if (hit && hit.sig === sig) return hit.h

  const st = parseJsonl(stateFile)
  if (st.missing) return emptyStrategy('state_missing')
  const du = parseJsonl(dupFile)

  const state = new Map()
  let stale = 0
  let conflicted = 0
  for (const r of st.rows) {
    if (!r || typeof r.chunkId !== 'string') continue
    state.set(r.chunkId, r)
    if (STALE_STATUS.has(r.status)) stale++
    if (r.conflictGroup) conflicted++
  }
  const groups = []
  for (const g of du.rows) {
    const ids = Array.isArray(g?.chunkIds) ? g.chunkIds.filter((x) => typeof x === 'string') : []
    if (ids.length < 2) continue
    if (mode === 'accepted' && g.status !== 'accepted') continue
    groups.push({ groupId: g.groupId || `anon-${groups.length}`, chunkIds: ids, status: g.status || 'pending' })
  }

  const h = {
    available: true, degraded: false, reason: '',
    state, groups, members: new Map(), repOf: new Map(),
    dupMode: mode, sig,
    counts: { state: state.size, groups: groups.length, stale, conflicted, badLines: st.bad + du.bad },
    _idxCache: new WeakMap(), _repCache: new WeakMap(),
  }
  FILE_CACHE.set(key, { sig, h })
  return h
}

/** 清缓存（测试/热更新用；正常无需调用） */
export function clearHygieneCache() { FILE_CACHE.clear() }

/** chunkId → chunks 数组下标（按 chunks 数组缓存，避免每查询重建） */
function idIndexFor(h, chunks) {
  const cached = h._idxCache.get(chunks)
  if (cached) return cached
  const map = new Map()
  for (let i = 0; i < chunks.length; i++) { const id = chunks[i]?.chunkId; if (id) map.set(id, i) }
  h._idxCache.set(chunks, map)
  return map
}

/**
 * 建「组 → 代表块」映射（按 chunks 数组缓存；代表块按块时间 t 选最晚）。
 * 必须在拿得到 chunks 之后才能算——duplicates.jsonl 本身不含代表块字段。
 */
export function dupIndexFor(h, chunks) {
  const cached = h._repCache.get(chunks)
  if (cached) return cached
  const members = new Map()
  const repOf = new Map()
  const tOf = (id) => {
    const i = idIndexFor(h, chunks).get(id)
    return i === undefined ? 0 : Number(chunks[i]?.t) || 0
  }
  for (const g of h.groups) {
    const ids = g.chunkIds
    const live = ids.filter((id) => !STALE_STATUS.has(h.state.get(id)?.status))
    const pool = live.length ? live : ids
    const rep = pool.slice().sort((a, b) => tOf(b) - tOf(a))[0]
    if (!rep) continue
    repOf.set(g.groupId, rep)
    for (const id of ids) members.set(id, g.groupId)
  }
  const built = { members, repOf }
  h._repCache.set(chunks, built)
  h.members = members
  h.repOf = repOf
  return built
}

/**
 * 对已排序的候选序列应用策略。
 * 时机：chunk 排序完成、会话聚合之前（保守；重复块不会跨会话各留一条）。
 *
 * @param {number[]} order 候选下标序列（chunks 的下标）
 * @param {Array} chunks loaded.meta.chunks
 * @param {object} h loadHygiene(...) 的返回
 * @param {{staleFilter?:boolean, conflictWeight?:number, allowed?:Uint8Array}} opts
 * @returns {{order:number[], stats:object}}
 */
export function applyHygieneOrder(order, chunks, h, opts = {}) {
  const staleFilter = opts.staleFilter === true
  const conflictWeight = Number.isFinite(Number(opts.conflictWeight)) ? Number(opts.conflictWeight) : 0.8
  const allowed = opts.allowed || null
  const stats = { staleDropped: 0, dupRemapped: 0, dupDropped: 0, conflictDemoted: 0, degraded: !h?.available, applied: Boolean(h?.available) }
  if (!h?.available) return { order, stats }

  const { members, repOf } = dupIndexFor(h, chunks)
  const idx = idIndexFor(h, chunks)
  const head = []
  const tail = []
  const seenGroup = new Set()
  for (const i of order) {
    const c = chunks[i]
    if (!c) continue
    if (allowed && !allowed[i]) continue
    if (staleFilter && STALE_STATUS.has(h.state.get(c.chunkId)?.status)) { stats.staleDropped++; continue }
    const gid = members.get(c.chunkId)
    let j = i
    if (gid) {
      const repId = repOf.get(gid)
      const repIdx = repId === undefined ? undefined : idx.get(repId)
      if (repIdx === undefined) { stats.dupDropped++; continue }
      if (seenGroup.has(gid)) { stats.dupDropped++; continue }
      seenGroup.add(gid)
      if (repIdx !== i) stats.dupRemapped++
      j = repIdx
    }
    const conflicted = conflictWeight < 1 && Boolean(h.state.get(chunks[j]?.chunkId)?.conflictGroup)
    if (conflicted) { tail.push(j); stats.conflictDemoted++ } else head.push(j)
  }
  return { order: [...head, ...tail], stats }
}
