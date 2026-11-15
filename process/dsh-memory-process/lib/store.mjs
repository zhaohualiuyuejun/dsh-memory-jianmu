/**
 * lib/store.mjs —— 熏习状态库（process/<personaId>/）
 *
 * 所有文件都是追加日志（latest-wins）；状态可撤销、可压缩；所有写动作只落 process 目录。
 * 根藏只读：本模块不会打开任何 scopes/ 下的写句柄。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendJsonl,
  ensureDir,
  readJson,
  readJsonl,
  writeJsonAtomic,
  copyFileIfExists,
  hashFile,
} from './fsatomic.mjs'
import {
  PROCESS_FILES,
  processDir,
  processFile,
  assertProcessWrite,
  tsSlug,
  tsSlugMs,
  isSafePersonaId,
} from './paths.mjs'
import { assertNoBodyFields } from './guards.mjs'
import { VERSION, SCHEMA_VERSION, CONTRACT_VERSION, ROOT_CONTRACT_VERSION, RULE_VERSION, DEFAULT_THRESHOLDS } from './version.mjs'
import { peekLock } from './lock.mjs'

export const LOG_KEYS = Object.freeze(['state', 'topics', 'topicMembers', 'duplicates', 'pending', 'conflicts', 'cost'])

export function defaultManifest(dataRoot, personaId) {
  const now = Date.now()
  return {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    rootContractVersion: ROOT_CONTRACT_VERSION,
    personaId,
    generation: 1,
    ruleVersion: RULE_VERSION,
    dataRoot,
    rootDataRoot: dataRoot,
    rootBuiltAt: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: 0,
    lastRunRootBuiltAt: null,
    lastRunCheckpoint: null,
    lastError: null,
    counts: { chunks: 0, states: 0, processed: 0, topics: 0, pending: 0, conflicts: 0, duplicates: 0 },
    thresholds: { ...DEFAULT_THRESHOLDS },
    llmEnabled: false,
    autoMirrorRetention: true,
    writer: { name: 'dsh-memory-process', version: VERSION },
  }
}

export async function ensureProcessLayout(dataRoot, personaId) {
  if (!isSafePersonaId(personaId)) {
    const e = new Error(`personaId 非法：${personaId}`)
    e.code = 'BAD_PERSONA_ID'
    throw e
  }
  const dir = processDir(dataRoot, personaId)
  await ensureDir(dir)
  await ensureDir(join(dir, '_archive'))
  return dir
}

export async function readManifest(dataRoot, personaId) {
  const file = processFile(dataRoot, personaId, 'manifest')
  const r = await readJson(file)
  if (!r.ok) {
    return {
      ok: false,
      exists: r.code !== 'ENOENT',
      code: r.code === 'ENOENT' ? 'MANIFEST_MISSING' : 'MANIFEST_INVALID',
      error: r.error ?? { code: r.code, message: `manifest 不可读：${file}` },
      file,
    }
  }
  const m = r.value
  const problems = []
  if (m?.contractVersion > CONTRACT_VERSION) problems.push(`process contractVersion=${m.contractVersion} > ${CONTRACT_VERSION}`)
  if (m?.personaId !== personaId) problems.push(`manifest.personaId（${m?.personaId}）与目录（${personaId}）不一致`)
  if (!Number.isInteger(m?.generation) || m.generation < 1) problems.push('manifest.generation 非法')
  if (problems.length) {
    return { ok: false, exists: true, code: 'MANIFEST_INVALID', error: { code: 'MANIFEST_INVALID', message: problems.join('；') }, file, manifest: m }
  }
  return { ok: true, exists: true, manifest: m, file }
}

export async function writeManifest(dataRoot, personaId, manifest) {
  const file = processFile(dataRoot, personaId, 'manifest')
  assertProcessWrite(dataRoot, personaId, file)
  const next = {
    ...manifest,
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    rootContractVersion: ROOT_CONTRACT_VERSION,
    personaId,
    dataRoot,
    rootDataRoot: dataRoot,
    ruleVersion: RULE_VERSION,
    updatedAt: Date.now(),
  }
  await writeJsonAtomic(file, next)
  // 读回（found/missing/unknown 三态；unknown 不算成功）
  const back = await readJson(file)
  if (!back.ok || back.value?.generation !== next.generation) {
    const e = new Error(`manifest 写后读回失败：${file}`)
    e.code = 'READBACK_MISMATCH'
    e.detail = { expectedGeneration: next.generation, got: back.ok ? back.value?.generation : back.code }
    throw e
  }
  return next
}

/** 首次使用会创建 manifest（generation=1） */
export async function ensureManifest(dataRoot, personaId, opts = {}) {
  const r = await readManifest(dataRoot, personaId)
  if (r.ok) return { ok: true, manifest: r.manifest, created: false }
  if (r.exists) return { ok: false, code: r.code, error: r.error }
  await ensureProcessLayout(dataRoot, personaId)
  const manifest = defaultManifest(dataRoot, personaId)
  if (opts.rootBuiltAt) manifest.rootBuiltAt = opts.rootBuiltAt
  const written = await writeManifest(dataRoot, personaId, manifest)
  return { ok: true, manifest: written, created: true }
}

export async function readLog(dataRoot, personaId, key) {
  const file = processFile(dataRoot, personaId, key)
  const r = await readJsonl(file)
  return { ...r, file }
}

/** latest-wins：同一 id 取 updatedAt 最大；并列取后出现者 */
export function latestBy(rows, idKey = 'chunkId', timeKey = 'updatedAt') {
  const m = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = row[idKey]
    if (id == null) continue
    const t = Number(row[timeKey] ?? row.createdAt ?? 0)
    const prev = m.get(id)
    if (!prev || t >= prev.t) m.set(id, { row, t })
  }
  const out = new Map()
  for (const [id, v] of m) out.set(id, v.row)
  return out
}

export async function readStateMap(dataRoot, personaId) {
  const r = await readLog(dataRoot, personaId, 'state')
  return { ...r, map: latestBy(r.rows, 'chunkId', 'updatedAt') }
}

export async function readPendingMap(dataRoot, personaId) {
  const r = await readLog(dataRoot, personaId, 'pending')
  return { ...r, map: latestBy(r.rows, 'pendingId', 'updatedAt') }
}

export async function readDuplicatesMap(dataRoot, personaId) {
  const r = await readLog(dataRoot, personaId, 'duplicates')
  return { ...r, map: latestBy(r.rows, 'groupId', 'updatedAt') }
}

export async function readConflictsMap(dataRoot, personaId) {
  const r = await readLog(dataRoot, personaId, 'conflicts')
  return { ...r, map: latestBy(r.rows, 'conflictId', 'updatedAt') }
}

export async function readTopics(dataRoot, personaId) {
  const [topics, members] = await Promise.all([
    readLog(dataRoot, personaId, 'topics'),
    readLog(dataRoot, personaId, 'topicMembers'),
  ])
  return {
    topics: [...latestBy(topics.rows, 'topicId', 'updatedAt').values()],
    members: members.rows,
  }
}

/** 追加记录（带写闸门 + 不存正文检查） */
export async function appendLog(dataRoot, personaId, key, rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, bytes: 0, lines: 0 }
  const file = processFile(dataRoot, personaId, key)
  assertProcessWrite(dataRoot, personaId, file)
  for (const row of rows) assertNoBodyFields(row, `${key} 记录`)
  await ensureDir(processDir(dataRoot, personaId))
  const r = await appendJsonl(file, rows, { durable: opts.durable !== false })
  return { ...r, file }
}

/** 备份指定日志到 _archive/<reason>-<ts>/（先备份后写；F2/F3） */
export async function backupLogs(dataRoot, personaId, reason, keys = ['state', 'pending', 'duplicates', 'conflicts', 'topics', 'topicMembers']) {
  const dir = join(processDir(dataRoot, personaId), '_archive', `${reason}-${tsSlugMs()}`)
  assertProcessWrite(dataRoot, personaId, dir)
  await ensureDir(dir)
  const copied = []
  for (const key of keys) {
    const src = processFile(dataRoot, personaId, key)
    const r = await copyFileIfExists(src, dir, PROCESS_FILES[key])
    if (r.ok) copied.push({ key, file: PROCESS_FILES[key], bytes: r.bytes })
  }
  const manifest = processFile(dataRoot, personaId, 'manifest')
  const mr = await copyFileIfExists(manifest, join(dir, 'manifest.snapshot.json'), 'manifest.snapshot.json')
  if (mr.ok) copied.push({ key: 'manifest', file: 'manifest.snapshot.json', bytes: mr.bytes })
  return { ok: true, dir, copied }
}

/** 文件体量（status / 容量告警） */
export async function processVolume(dataRoot, personaId) {
  const dir = processDir(dataRoot, personaId)
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return { bytes: 0, files: 0 } }
  let bytes = 0, files = 0
  for (const d of ents) {
    if (!d.isFile()) continue
    try { bytes += (await stat(join(dir, d.name))).size; files++ } catch { /* 忽略 */ }
  }
  return { bytes, files }
}

/** 计算 counts（manifest 缓存用） */
export async function computeCounts(dataRoot, personaId, chunks = null) {
  const [state, pending, duplicates, conflicts, topics] = await Promise.all([
    readStateMap(dataRoot, personaId),
    readPendingMap(dataRoot, personaId),
    readDuplicatesMap(dataRoot, personaId),
    readConflictsMap(dataRoot, personaId),
    readTopics(dataRoot, personaId),
  ])
  const states = state.map.size
  const pendingCount = [...pending.map.values()].filter((p) => p.status === 'pending').length
  const openConflicts = [...conflicts.map.values()].filter((c) => c.status === 'open').length
  const dupGroups = [...duplicates.map.values()].filter((d) => d.status === 'pending').length
  return {
    chunks: chunks != null ? chunks.length : (state.map.size + 0),
    states,
    processed: states,
    topics: topics.topics.length,
    pending: pendingCount,
    conflicts: openConflicts,
    duplicates: dupGroups,
  }
}

/** 从根藏块 + state 得到「有效状态」（未处理默认 active 可见，铁律 1） */
export function effectiveStatus(chunk, stateMap) {
  const s = stateMap.get(chunk.id)
  return s?.status ?? 'active'
}

export function stateToPublic(state, chunk) {
  if (!state) {
    return {
      chunkId: chunk.id,
      anchorKey: chunk?.session ? `${chunk.session}|${chunk.messageId}|${chunk.seq}|${chunk.part ?? 0}` : null,
      scope: chunk?.personaId ?? null,
      status: 'active',
      validFrom: chunk?.t ?? null,
      validTo: null,
      supersededBy: null,
      reason: 'unprocessed:default-active',
      source: 'rule',
      confidence: 0,
      version: 0,
      epistemic: 'unknown',
      attribution: 'unknown',
      sensitivity: 'normal',
      conflictGroup: null,
      ruleRef: null,
      updatedAt: chunk?.t ?? null,
      generation: null,
      rootBuiltAt: null,
      sourceHash: chunk?.sourceHash ?? null,
      synthetic: true,
    }
  }
  return { ...state, synthetic: false }
}

/**
 * 状态概览（status / UI overview 共用）。
 * 只做统计，不返回原文正文（memories API 才返回锚点/摘要）。
 */
export async function overview(dataRoot, personaId, opts = {}) {
  const man = await readManifest(dataRoot, personaId)
  const state = await readStateMap(dataRoot, personaId)
  const pending = await readPendingMap(dataRoot, personaId)
  const duplicates = await readDuplicatesMap(dataRoot, personaId)
  const conflicts = await readConflictsMap(dataRoot, personaId)
  const topics = await readTopics(dataRoot, personaId)
  const volume = await processVolume(dataRoot, personaId)
  const lock = await peekLock(processDir(dataRoot, personaId))

  const effective = { active: 0, superseded: 0, expired: 0, archived: 0, unknown: 0 }
  let processed = 0
  let unprocessed = 0
  let orphans = 0
  let stale = 0
  let crossScope = 0
  const chunkIds = new Set()

  const chunks = opts.chunks ?? []
  for (const c of chunks) {
    chunkIds.add(c.id)
    const s = state.map.get(c.id)
    if (!s) {
      effective.active++
      unprocessed++
      continue
    }
    processed++
    const st = s.status ?? 'unknown'
    if (effective[st] === undefined) effective.unknown++
    else effective[st]++
    if (s.scope && s.scope !== personaId) crossScope++
    if (s.sourceHash && c.sourceHash && s.sourceHash !== c.sourceHash) stale++
  }
  for (const id of state.map.keys()) if (!chunkIds.has(id)) orphans++

  const pendingRows = [...pending.map.values()]
  const dupRows = [...duplicates.map.values()]
  const conflictRows = [...conflicts.map.values()]

  return {
    ok: true,
    personaId,
    dataRoot,
    processDir: processDir(dataRoot, personaId),
    manifest: man.ok ? man.manifest : null,
    manifestError: man.ok ? null : man.error,
    generation: man.ok ? man.manifest.generation : null,
    ruleVersion: man.ok ? man.manifest.ruleVersion : RULE_VERSION,
    llmEnabled: false,
    root: {
      chunks: chunks.length,
      builtAt: opts.rootBuiltAt ?? (man.ok ? man.manifest.rootBuiltAt : null),
    },
    states: {
      effective,
      processed,
      unprocessed,
      orphans,
      stale,
      crossScope,
      records: state.rows.length,
      unique: state.map.size,
      corrupt: state.corrupt.length,
      tornTail: state.tornTail,
    },
    pending: {
      total: pending.map.size,
      pending: pendingRows.filter((p) => p.status === 'pending').length,
      applied: pendingRows.filter((p) => p.status === 'applied').length,
      dismissed: pendingRows.filter((p) => p.status === 'dismissed').length,
      byKind: countBy(pendingRows.filter((p) => p.status === 'pending'), 'kind'),
    },
    duplicates: {
      groups: duplicates.map.size,
      pending: dupRows.filter((d) => d.status === 'pending').length,
      merged: dupRows.filter((d) => d.status === 'merged').length,
      dismissed: dupRows.filter((d) => d.status === 'dismissed').length,
      exact: dupRows.filter((d) => d.method === 'exact').length,
      near: dupRows.filter((d) => d.method === 'simhash+3gram').length,
    },
    conflicts: {
      total: conflicts.map.size,
      open: conflictRows.filter((c) => c.status === 'open').length,
      resolved: conflictRows.filter((c) => c.status === 'resolved').length,
      dismissed: conflictRows.filter((c) => c.status === 'dismissed').length,
    },
    topics: { topics: topics.topics.length, members: topics.members.length },
    processVolume: { bytes: volume.bytes, files: volume.files },
    volume: { bytes: volume.bytes, files: volume.files }, // 兼容旧调用；UI 请用 processVolume
    degraded: Boolean(!man.ok || state.corrupt.length || state.tornTail || orphans || crossScope),
    warnings: [
      ...(!man.ok ? [`manifest 不可读：${man.error?.message ?? man.code}`] : []),
      ...(state.corrupt.length ? [`state.jsonl 有 ${state.corrupt.length} 个中间坏行`] : []),
      ...(state.tornTail ? ['state.jsonl 有撕裂尾行（tornTail）'] : []),
      ...(orphans ? [`${orphans} 条状态找不到根藏块`] : []),
      ...(crossScope ? [`${crossScope} 条状态 scope 串味`] : []),
    ],
    errors: [],
    initialized: man.ok,
    lock: lock.exists ? { held: true, ageMs: lock.ageMs, alive: lock.alive, tool: lock.info?.tool ?? null } : { held: false },
    lastRunAt: man.ok ? man.manifest.lastRunAt : 0,
    lastRunRootBuiltAt: man.ok ? man.manifest.lastRunRootBuiltAt : null,
    lastRunCheckpoint: man.ok ? man.manifest.lastRunCheckpoint : null,
    lastError: man.ok ? man.manifest.lastError : null,
    counts: man.ok ? man.manifest.counts : null,
  }
}

function countBy(rows, key) {
  const m = new Map()
  for (const r of rows) m.set(r[key] ?? 'null', (m.get(r[key] ?? 'null') || 0) + 1)
  return Object.fromEntries(m)
}

export async function fileHashes(dataRoot, personaId, keys = LOG_KEYS) {
  const out = {}
  for (const key of keys) {
    const file = processFile(dataRoot, personaId, key)
    try { out[key] = await hashFile(file) } catch (e) { out[key] = e.code === 'ENOENT' ? null : `ERR:${e.code || e.message}` }
  }
  return out
}
