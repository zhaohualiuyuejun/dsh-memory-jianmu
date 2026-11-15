/**
 * lib/session-source.mjs —— 熏习「只读会话源」（2026-11-08）
 *
 * 用途：用户**没装根藏**时，让熏习单独也能当「原话汇总看板」：
 *   直接只读扫描 `<DSH_HOME>/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`，
 *   抽 user/assistant 的人话 → 按 1200/80 切块 → 按工作区聚合。
 *
 * 明确不做：
 *   ❌ 不写 sessions/、不写 scopes/、不写 process/（缓存只在内存里）
 *   ❌ 不调 LLM、不做嵌入、不跑熏习规则
 *   ❌ 不提供任何写动作（路由只有 GET）
 *
 * 缓存：按文件 mtimeMs 增量；TTL 30s，避免每次翻页都重解 zstd。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { defaultDataRoot, sessionsRoot } from './paths.mjs'
import {
  listSessionFiles, extractSessions, buildChunks, prettyWorkspace,
} from 'dsh-jianmu-utterance-core'

const CACHE_TTL_MS = 30_000
const MAX_DAYS = 365

let cache = new Map() // filePath -> { mtimeMs, recs }
let lastScanAt = 0
let lastFileCount = 0
let lastError = null
let inflight = null

const clampDays = (n) => Math.max(1, Math.min(MAX_DAYS, Number(n) || 7))

function chunkIdOf(c) {
  return 'u' + createHash('sha256')
    .update([c.session, c.msgId ?? '', c.seq ?? '', c.part ?? 0, c.text].join('|'))
    .digest('hex').slice(0, 16)
}

async function fileHasBytes(p) {
  try { const s = await stat(p); return s.isFile() && s.size > 0 } catch { return false }
}

/** 根藏里是否已有任何原话块（决定 UI 走「记忆库」还是「原话看板」） */
export async function rootDataPresent(dataRoot = defaultDataRoot()) {
  const dir = join(dataRoot, 'scopes')
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return false }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (await fileHasBytes(join(dir, e.name, 'chunks.jsonl'))) return true
  }
  return false
}

async function scan(days) {
  const root = sessionsRoot()
  let files = []
  try {
    ({ files } = await listSessionFiles({ root, days }))
  } catch (e) {
    lastError = String(e?.message || e)
    files = []
  }
  const next = new Map()
  for (const f of files) {
    const hit = cache.get(f.path)
    if (hit && hit.mtimeMs === f.mtimeMs) { next.set(f.path, hit); continue }
    try {
      const { recs } = await extractSessions({ files: [f] })
      next.set(f.path, { mtimeMs: f.mtimeMs, recs })
    } catch (e) {
      lastError = String(e?.message || e)
      next.set(f.path, { mtimeMs: f.mtimeMs, recs: [] })
    }
  }
  cache = next
  lastFileCount = files.length
  lastScanAt = Date.now()
}

async function ensure(days, { refresh = false } = {}) {
  if (inflight) { await inflight; if (!refresh) return }
  const stale = refresh || Date.now() - lastScanAt > CACHE_TTL_MS
  if (!stale) return
  inflight = scan(days).finally(() => { inflight = null })
  await inflight
}

function allChunks() {
  const recs = []
  for (const v of cache.values()) for (const r of v.recs) recs.push(r)
  return buildChunks(recs)
}

function toRow(c) {
  return {
    chunkId: chunkIdOf(c),
    session: c.session,
    ws: c.wsPretty || prettyWorkspace(c.ws),
    wsDir: c.ws,
    role: c.role,
    sourceType: c.sourceType || null,
    t: c.t,
    msgId: c.msgId ?? null,
    seq: c.seq ?? null,
    part: c.part ?? 0,
    text: c.text,
  }
}

function filterRows(rows, { ws, session, role, q, from, to }) {
  let out = rows
  if (ws) out = out.filter((r) => r.ws === ws)
  if (session) out = out.filter((r) => r.session === session)
  if (role) out = out.filter((r) => r.role === role)
  if (from != null && Number.isFinite(Number(from))) out = out.filter((r) => Number(r.t) >= Number(from))
  if (to != null && Number.isFinite(Number(to))) out = out.filter((r) => Number(r.t) <= Number(to))
  if (q) {
    const needle = String(q).toLowerCase()
    out = out.filter((r) => String(r.text || '').toLowerCase().includes(needle))
  }
  return out
}

/** 轻量探针：只判断「根藏里有没有数据」，不扫会话（UI 首屏用来选模式，要求秒回） */
export async function sourceProbe() {
  return {
    ok: true,
    rootData: await rootDataPresent(),
    sessionsRoot: sessionsRoot(),
    note: 'rootData=true → 走记忆库；false → 走只读原话看板',
  }
}

/** 看板状态：UI 用它决定「记忆库」还是「原话看板」 */
export async function sourceStatus({ days = 7, refresh = false } = {}) {
  const d = clampDays(days)
  await ensure(d, { refresh })
  const chunks = allChunks()
  return {
    ok: true,
    mode: 'session-source',
    rootData: await rootDataPresent(),
    sessionsRoot: sessionsRoot(),
    days: d,
    files: lastFileCount,
    cachedFiles: cache.size,
    utterances: chunks.length,
    sessions: new Set(chunks.map((c) => c.session)).size,
    workspaces: new Set(chunks.map((c) => c.wsPretty)).size,
    lastScanAt,
    error: lastError,
    note: '只读：直接解析 DSH 会话，不写任何文件、不调 LLM、不做嵌入',
  }
}

/** 工作区聚合（工作区 → 会话数 / 原话块 / 时间范围） */
export async function sourceWorkspaces({ days = 7, refresh = false } = {}) {
  const d = clampDays(days)
  await ensure(d, { refresh })
  const map = new Map()
  for (const c of allChunks()) {
    const key = c.wsPretty || '(未知工作区)'
    let w = map.get(key)
    if (!w) {
      w = { ws: key, wsDir: c.ws, sessions: new Set(), utterances: 0, tMin: null, tMax: null }
      map.set(key, w)
    }
    w.sessions.add(c.session)
    w.utterances += 1
    if (c.t) {
      if (w.tMin == null || c.t < w.tMin) w.tMin = c.t
      if (w.tMax == null || c.t > w.tMax) w.tMax = c.t
    }
  }
  const rows = [...map.values()]
    .map((w) => ({ ws: w.ws, wsDir: w.wsDir, sessions: w.sessions.size, utterances: w.utterances, tMin: w.tMin, tMax: w.tMax }))
    .sort((a, b) => (b.utterances - a.utterances) || a.ws.localeCompare(b.ws, 'zh-CN'))
  return { ok: true, days: d, total: rows.length, rows }
}

/** 原话列表：按时间倒序；支持工作区/会话/角色/关键词/时间范围过滤 */
export async function sourceMemories({
  days = 7, ws = null, session = null, role = null, q = null,
  from = null, to = null, limit = 100, offset = 0, refresh = false,
} = {}) {
  const d = clampDays(days)
  await ensure(d, { refresh })
  let rows = allChunks().map(toRow)
  rows = filterRows(rows, { ws, session, role, q, from, to })
  rows.sort((a, b) => (Number(b.t) - Number(a.t)) || String(b.session).localeCompare(String(a.session)))
  const total = rows.length
  const lim = Math.max(1, Math.min(500, Number(limit) || 100))
  const off = Math.max(0, Number(offset) || 0)
  return { ok: true, days: d, total, limit: lim, offset: off, rows: rows.slice(off, off + lim) }
}
