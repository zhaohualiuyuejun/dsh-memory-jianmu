/**
 * lib/api.mjs —— 只读 API（给 UI / CLI 用；绝不写文件）
 *
 * 返回当前 persona scope 的数据；不提供跨 persona 读取/合并。
 * UI 只能调这里，不能直接读写 chunks.jsonl / state.jsonl。
 *
 * UI v1 契约（2026-11-07 审查后）：
 *   · apiContext 默认不传 personaId，按工作区解析；
 *   · 候选（pending/duplicates/conflicts）内嵌涉及记忆的锚点 + 摘要；
 *   · 概览的根藏存储卡来自 rootStorageStats（只 stat，不读向量内容）；
 *   · 列表默认只给 textPreview，详情/显式 includeText 才给全文。
 */
import { readScope, listScopes, identityContext, rootStorageStats } from './root.mjs'
import { overview, stateToPublic } from './store.mjs'
import {
  readStateMap, readPendingMap, readDuplicatesMap,
  readConflictsMap, readTopics, readManifest,
} from './store.mjs'
import { verifyProcess } from './verify.mjs'
import { personaLifecycle } from './lifecycle.mjs'
import { anchorKeyOf, defaultDataRoot } from './paths.mjs'

export const CAPABILITIES = Object.freeze({
  process: true,
  readOnly: true,
  rootStorage: true,
  topics: false,        // v1b 写 topic；v1a 主题 tab 隐藏
  topicActions: false,
  search: false,        // 检索归寻枝
  personaCard: false,   // 人格卡归镜台
  actions: false,       // v1a UI 只读；apply 走 CLI/工具
})

function preview(text, n = 200) {
  const s = String(text ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function formatTime(t, tz = 'Asia/Shanghai') {
  if (!Number.isFinite(Number(t))) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(Number(t))).replace(/\//g, '-')
  } catch {
    return new Date(Number(t)).toISOString()
  }
}

function topicIndex(topics, members) {
  const nameById = new Map(topics.map((t) => [t.topicId, t.name]))
  const byChunk = new Map()
  for (const m of members) {
    if (!byChunk.has(m.chunkId)) byChunk.set(m.chunkId, [])
    const arr = byChunk.get(m.chunkId)
    if (!arr.some((x) => x.topicId === m.topicId)) {
      arr.push({ topicId: m.topicId, name: nameById.get(m.topicId) ?? null, confidence: m.confidence ?? 0, assignedBy: m.assignedBy ?? 'rule' })
    }
  }
  return byChunk
}

function chunkRow(c, s, topicsArr = [], includeText = false) {
  const st = stateToPublic(s, c)
  return {
    chunkId: c.id,
    anchorKey: anchorKeyOf(c),
    scope: c.personaId,
    session: c.session,
    messageId: c.messageId ?? null,
    seq: c.seq ?? null,
    part: c.part ?? 0,
    turn: c.turn ?? null,
    role: c.role,
    sourceType: c.sourceType,
    channel: c.channel,
    ws: c.ws ?? null,
    tz: c.tz ?? 'Asia/Shanghai',
    t: c.t ?? null,
    dateText: formatTime(c.t, c.tz),
    textPreview: preview(c.text),
    ...(includeText ? { text: c.text } : {}),
    attachments: c.attachments ?? [],
    sourceHash: c.sourceHash ?? null,
    ingestVersion: c.ingestVersion ?? null,
    retention: c.retention ?? 'active',
    state: { ...st, classified: Boolean(s), synthetic: !s },
    topics: topicsArr,
  }
}

async function loadIndex(dataRoot, personaId, opts = {}) {
  const root = await readScope(dataRoot, personaId)
  if (!root.ok) return { ok: false, code: root.code, error: root.error }
  const [state, topics] = await Promise.all([readStateMap(dataRoot, personaId), readTopics(dataRoot, personaId)])
  const byChunk = topicIndex(topics.topics, topics.members)
  const chunkMap = new Map(root.chunks.map((c) => [c.id, c]))
  return { ok: true, root, state, topics, byChunk, chunkMap }
}

function enrichWithChunks(rows, chunkMap, byChunk, includeText = false, stateMap = null) {
  return rows.map((row) => {
    const ids = Array.isArray(row.chunkIds) ? row.chunkIds : []
    return {
      ...row,
      chunks: ids.map((id) => {
        const c = chunkMap.get(id)
        if (!c) return { chunkId: id, missing: true }
        return chunkRow(c, stateMap?.get(id) ?? null, byChunk.get(id) ?? [], includeText)
      }),
    }
  })
}

export function apiCapabilities() {
  return { ok: true, capabilities: { ...CAPABILITIES } }
}

/** 当前 persona/身份：UI 默认不传 personaId，按工作区解析 */
export async function apiContext({ dataRoot, workspace = null, personaId = null }) {
  const ctx = await identityContext(dataRoot, workspace)
  if (!ctx.ok) return ctx
  const resolved = personaId && (personaId === 'persona_unassigned' || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(personaId))
    ? { personaId, identitySource: 'explicit', resolved: true, warning: null }
    : ctx
  return {
    ...ctx,
    personaId: resolved.personaId ?? null,
    resolved: Boolean(resolved.personaId),
    identitySource: resolved.identitySource ?? null,
    warning: resolved.warning ?? ctx.warning ?? null,
    capabilities: { ...CAPABILITIES },
  }
}

/**
 * 按会话 id 反查 persona（只读兜底）：
 *   有会话工作区时优先按工作区解析（调用方先做，这里只做兜底）；
 *   兜底方式：扫各 scope 的 chunks，找同一 session 的块 → 该 scope 的 personaId。
 * 不猜、不默认：一个都没命中就返回 ok:false。
 */
export async function apiSessionPersona({ dataRoot, session }) {
  const sid = String(session || '').trim()
  if (!sid) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'session 必填' } }
  }
  for (const pid of await listScopes(dataRoot)) {
    const root = await readScope(dataRoot, pid)
    if (!root.ok) continue
    const hit = root.chunks.find((c) => c && c.session === sid)
    if (hit) {
      return {
        ok: true,
        personaId: pid,
        source: 'session-chunk',
        chunkId: hit.id,
        chunkAt: hit.t ?? null,
      }
    }
  }
  return { ok: false, code: 'SESSION_UNRESOLVED', error: { code: 'SESSION_UNRESOLVED', message: `根藏里还没有会话 ${sid} 的块` } }
}

/** 根藏存储卡（只 stat + manifest/index_meta，不读向量内容） */
export async function apiRootStorage({ dataRoot, personaId }) {
  return rootStorageStats(dataRoot, personaId)
}

export async function apiOverview({ dataRoot, personaId }) {
  const root = await readScope(dataRoot, personaId)
  if (!root.ok) return { ok: false, code: root.code, error: root.error }
  const ov = await overview(dataRoot, personaId, { chunks: root.chunks, rootBuiltAt: root.manifest?.builtAt ?? null })
  const storage = await rootStorageStats(dataRoot, personaId)
  const warnings = [...(ov.warnings ?? []), ...(storage.ok ? storage.warnings : [`根藏存储卡不可读：${storage.error?.message ?? storage.code}`])]
  return {
    ...ov,
    empty: Boolean(root.empty),
    emptyHint: root.empty ? '根藏里还没有原话：先装根藏并摄取；记忆、熏习、年轮都以它为前提。' : null,
    zeroRoot: Boolean(root.empty),
    initialized: Boolean(ov.initialized) && !root.empty,
    rootStorage: storage.ok ? storage : { ok: false, code: storage.code, error: storage.error },
    degraded: Boolean(ov.degraded || (storage.ok ? storage.degraded : true)),
    warnings,
    errors: [...(ov.errors ?? []), ...(storage.ok ? storage.errors : [storage.error])].filter(Boolean),
  }
}

export async function apiMemories(opts) {
  const {
    dataRoot, personaId,
    status = null, role = null, channel = null, q = null,
    from = null, to = null,
    chunkIds = null, session = null, topicId = null, conflictGroup = null,
    includeText = false, sort = 'time',
    limit = 50, offset = 0,
  } = opts
  const idx = await loadIndex(dataRoot, personaId)
  if (!idx.ok) return idx
  const lim = Math.max(1, Math.min(500, Number(limit) || 50))
  const off = Math.max(0, Number(offset) || 0)
  const wantIds = Array.isArray(chunkIds)
    ? new Set(chunkIds.map(String))
    : (typeof chunkIds === 'string' && chunkIds ? new Set(chunkIds.split(',').map((s) => s.trim()).filter(Boolean)) : null)

  let rows = idx.root.chunks.map((c) => chunkRow(c, idx.state.map.get(c.id), idx.byChunk.get(c.id) ?? [], includeText))
  if (wantIds) rows = rows.filter((r) => wantIds.has(r.chunkId))
  if (status) rows = rows.filter((r) => r.state.status === status)
  if (role) rows = rows.filter((r) => r.role === role)
  if (channel) rows = rows.filter((r) => r.channel === channel)
  if (session) rows = rows.filter((r) => r.session === session)
  if (conflictGroup) rows = rows.filter((r) => r.state.conflictGroup === conflictGroup)
  if (topicId) rows = rows.filter((r) => r.topics.some((t) => t.topicId === topicId))
  if (from != null) rows = rows.filter((r) => Number(r.t) >= Number(from))
  if (to != null) rows = rows.filter((r) => Number(r.t) <= Number(to))
  if (q) {
    const needle = String(q).toLowerCase()
    rows = rows.filter((r) => String(idx.chunkMap.get(r.chunkId)?.text ?? r.textPreview).toLowerCase().includes(needle))
  }
  if (sort === 'status') {
    rows.sort((a, b) => String(a.state.status).localeCompare(String(b.state.status)) || (Number(b.t) - Number(a.t)))
  } else {
    rows.sort((a, b) => (Number(b.t) - Number(a.t)) || String(a.chunkId).localeCompare(String(b.chunkId)))
  }
  return {
    ok: true,
    personaId,
    empty: Boolean(idx.root.empty),
    hint: idx.root.empty ? '根藏还没有原话：先装根藏并摄取，记忆页才有内容' : null,
    total: rows.length,
    offset: off,
    limit: lim,
    rows: rows.slice(off, off + lim),
  }
}

/** 单条详情：默认给全文 + 附件/锚点/状态/topics */
export async function apiMemory({ dataRoot, personaId, chunkId, includeText = true }) {
  const idx = await loadIndex(dataRoot, personaId)
  if (!idx.ok) return idx
  const c = idx.chunkMap.get(String(chunkId))
  if (!c) return { ok: false, code: 'CHUNK_NOT_FOUND', error: { code: 'CHUNK_NOT_FOUND', message: `根藏找不到块：${chunkId}` } }
  return { ok: true, personaId, row: chunkRow(c, idx.state.map.get(c.id), idx.byChunk.get(c.id) ?? [], includeText) }
}

/** 批量取块（待处理/冲突/重复解析用） */
export async function apiChunks({ dataRoot, personaId, chunkIds = [], includeText = false }) {
  const idx = await loadIndex(dataRoot, personaId)
  if (!idx.ok) return idx
  const out = []
  const missing = []
  for (const id of chunkIds.map(String)) {
    const c = idx.chunkMap.get(id)
    if (!c) { missing.push(id); continue }
    out.push(chunkRow(c, idx.state.map.get(id), idx.byChunk.get(id) ?? [], includeText))
  }
  return { ok: true, personaId, rows: out, missing }
}

export async function apiTopics({ dataRoot, personaId }) {
  const topics = await readTopics(dataRoot, personaId)
  const counts = new Map()
  const seen = new Set()
  let lastUpdated = 0
  for (const m of topics.members) {
    const key = `${m.topicId}|${m.chunkId}`
    if (seen.has(key)) continue
    seen.add(key)
    counts.set(m.topicId, (counts.get(m.topicId) || 0) + 1)
    lastUpdated = Math.max(lastUpdated, Number(m.assignedAt) || 0)
  }
  const rows = topics.topics.map((t) => {
    lastUpdated = Math.max(lastUpdated, Number(t.updatedAt) || 0)
    return {
      ...t,
      memberCount: counts.get(t.topicId) || 0,
      uniqueMemberCount: counts.get(t.topicId) || 0,
      recallCount: null,
      lastRecalledAt: null,
      body: null,
      bodySource: 'year-ring-pending',
    }
  })
  return { ok: true, personaId, topics: rows, lastUpdated, note: 'recallCount 由寻枝提供；未装寻枝显示 null' }
}

export async function apiPending({ dataRoot, personaId, kind = null, status = 'pending', limit = 100, offset = 0, duplicateLimit = 50, conflictLimit = 50 }) {
  const idx = await loadIndex(dataRoot, personaId)
  if (!idx.ok) return idx
  const [dup, pending, conflicts] = await Promise.all([
    readDuplicatesMap(dataRoot, personaId),
    readPendingMap(dataRoot, personaId),
    readConflictsMap(dataRoot, personaId),
  ])
  let rows = [...pending.map.values()]
  if (status) rows = rows.filter((p) => p.status === status)
  if (kind) rows = rows.filter((p) => p.kind === kind)
  rows.sort((a, b) => (Number(b.generatedAt ?? b.updatedAt ?? b.createdAt) - Number(a.generatedAt ?? a.updatedAt ?? a.createdAt)) || String(a.pendingId).localeCompare(String(b.pendingId)))
  const lim = Math.max(1, Math.min(500, Number(limit) || 100))
  const off = Math.max(0, Number(offset) || 0)
  const dupRows = [...dup.map.values()].filter((d) => d.status === 'pending')
  const conflictRows = [...conflicts.map.values()].filter((c) => c.status === 'open')
  const man = await readManifest(dataRoot, personaId)
  return {
    ok: true,
    personaId,
    empty: Boolean(idx.root.empty),
    hint: idx.root.empty ? '根藏还没有原话：先装根藏并摄取' : null,
    generation: man.ok ? man.manifest.generation : null,
    total: rows.length,
    rows: enrichWithChunks(rows.slice(off, off + lim), idx.chunkMap, idx.byChunk, false, idx.state.map),
    duplicates: { total: dupRows.length, rows: enrichWithChunks(dupRows.slice(0, Math.max(1, Number(duplicateLimit) || 50)), idx.chunkMap, idx.byChunk, false, idx.state.map) },
    conflicts: { total: conflictRows.length, rows: enrichWithChunks(conflictRows.slice(0, Math.max(1, Number(conflictLimit) || 50)), idx.chunkMap, idx.byChunk, false, idx.state.map) },
  }
}

export async function apiConflicts({ dataRoot, personaId, status = 'open', includeText = false }) {
  const idx = await loadIndex(dataRoot, personaId)
  if (!idx.ok) return idx
  const conflicts = await readConflictsMap(dataRoot, personaId)
  const rows = [...conflicts.map.values()].filter((c) => !status || c.status === status)
  return {
    ok: true,
    personaId,
    total: rows.length,
    rows: enrichWithChunks(rows, idx.chunkMap, idx.byChunk, includeText, idx.state.map),
  }
}

export async function apiVerify({ dataRoot, personaId }) {
  return verifyProcess({ dataRoot, personaId })
}

export async function apiStatus({ dataRoot, personaId, config = null }) {
  const man = await readManifest(dataRoot, personaId)
  return {
    ok: man.ok,
    initialized: man.ok,
    personaId,
    manifest: man.ok ? man.manifest : null,
    error: man.ok ? null : man.error,
    thresholds: man.ok ? man.manifest.thresholds : null,
    ruleVersion: man.ok ? man.manifest.ruleVersion : null,
    generation: man.ok ? man.manifest.generation : null,
    dataRoot,
    rootDataRoot: man.ok ? man.manifest.rootDataRoot : dataRoot,
    config: config ?? null,
  }
}


/**
 * 人格生命周期诊断（P4 第 1 步，2026-11-12）
 * 只读：把「镜台人格卡 / 根藏 identity / 根藏 scope」三处对账。
 * 不依赖当前 persona，所以不带 personaId。
 */
export async function apiLifecycle({ dataRoot = defaultDataRoot() } = {}) {
  return personaLifecycle(dataRoot)
}
