/**
 * lib/verify.mjs —— 一致性检查与 repair（repair 不删数据）
 *
 * 检查：孤儿、anchor 可重映射候选、stale（sourceHash 变化）、缺失（未处理）、
 *       跨 scope 串味、计数不一致、重复组成员丢失、pending 引用的块丢失、日志坏行。
 */
import { join } from 'node:path'
import { acquireLock } from './lock.mjs'
import {
  readManifest, writeManifest, readStateMap, readPendingMap, readDuplicatesMap,
  readConflictsMap, readTopics, readLog, computeCounts,
} from './store.mjs'
import { readScope } from './root.mjs'
import { processDir, processFile, assertProcessWrite } from './paths.mjs'
import { clearOrphanTmp, writeJsonAtomic, ensureDir, listOrphanTmp } from './fsatomic.mjs'
import { tsSlug } from './paths.mjs'
import { toErrInfo } from './errors.mjs'
import { STATUSES, EPISTEMIC, ATTRIBUTION, SENSITIVITY } from './version.mjs'

export async function verifyProcess(opts = {}) {
  const { dataRoot, personaId, now = Date.now } = opts
  const problems = []
  const info = []

  const man = await readManifest(dataRoot, personaId)
  if (!man.ok) {
    return { ok: false, personaId, problems: [{ code: man.code, message: man.error?.message ?? 'manifest 不可读' }], info, checkedAt: now() }
  }
  const root = await readScope(dataRoot, personaId)
  if (!root.ok) {
    return { ok: false, personaId, problems: [{ code: root.code, message: root.error?.message ?? '根藏不可读' }], info, checkedAt: now() }
  }

  const [state, pending, duplicates, conflicts, topics] = await Promise.all([
    readStateMap(dataRoot, personaId),
    readPendingMap(dataRoot, personaId),
    readDuplicatesMap(dataRoot, personaId),
    readConflictsMap(dataRoot, personaId),
    readTopics(dataRoot, personaId),
  ])

  for (const [name, log] of [['state', state], ['pending', pending], ['duplicates', duplicates], ['conflicts', conflicts]]) {
    if (log.corrupt?.length) problems.push({ code: 'JSONL_CORRUPT', message: `${name}.jsonl 有 ${log.corrupt.length} 个中间坏行`, detail: log.corrupt.slice(0, 5) })
    if (log.tornTail) info.push(`${name}.jsonl 有撕裂尾行（tornTail，已忽略）`)
  }

  const chunkById = new Map(root.chunks.map((c) => [c.id, c]))
  const byAnchor = new Map()
  for (const c of root.chunks) {
    const key = `${c.session}|${c.messageId}|${c.seq}|${c.part ?? 0}`
    if (!byAnchor.has(key)) byAnchor.set(key, [])
    byAnchor.get(key).push(c.id)
  }

  const orphans = []
  const remapCandidates = []
  const stale = []
  const crossScope = []
  const scopeMissing = []
  const badEnum = []
  let unprocessed = 0

  for (const chunk of root.chunks) {
    if (!state.map.has(chunk.id)) unprocessed++
  }
  for (const [id, s] of state.map) {
    if (!s.scope) scopeMissing.push({ chunkId: id })
    else if (s.scope !== personaId) crossScope.push({ chunkId: id, scope: s.scope })
    if (!STATUSES.includes(s.status)) badEnum.push({ chunkId: id, field: 'status', value: s.status })
    if (!EPISTEMIC.includes(s.epistemic)) badEnum.push({ chunkId: id, field: 'epistemic', value: s.epistemic })
    if (!ATTRIBUTION.includes(s.attribution)) badEnum.push({ chunkId: id, field: 'attribution', value: s.attribution })
    if (!SENSITIVITY.includes(s.sensitivity)) badEnum.push({ chunkId: id, field: 'sensitivity', value: s.sensitivity })
    if (!Number.isInteger(Number(s.version)) || Number(s.version) < 1) badEnum.push({ chunkId: id, field: 'version', value: s.version })
    const chunk = chunkById.get(id)
    if (!chunk) {
      orphans.push({ chunkId: id, anchorKey: s.anchorKey ?? null, status: s.status })
      if (s.anchorKey && byAnchor.has(s.anchorKey)) {
        const candidates = byAnchor.get(s.anchorKey).filter((cid) => cid !== id)
        if (candidates.length) remapCandidates.push({ oldChunkId: id, anchorKey: s.anchorKey, candidates })
      }
      continue
    }
    if (s.sourceHash && chunk.sourceHash && s.sourceHash !== chunk.sourceHash) {
      stale.push({ chunkId: id, stateSourceHash: s.sourceHash, rootSourceHash: chunk.sourceHash })
    }
  }

  if (orphans.length) problems.push({ code: 'ORPHAN_STATE', message: `${orphans.length} 条状态找不到对应根藏块（未删除，可 anchor 重映射）`, detail: orphans.slice(0, 20) })
  if (remapCandidates.length) info.push(`${remapCandidates.length} 条孤儿可用 anchorKey 重映射`)
  if (stale.length) problems.push({ code: 'STALE_STATE', message: `${stale.length} 条状态的 sourceHash 与根藏不一致`, detail: stale.slice(0, 20) })
  if (crossScope.length) problems.push({ code: 'CROSS_SCOPE', message: `${crossScope.length} 条状态 scope 串味`, detail: crossScope.slice(0, 20) })
  if (scopeMissing.length) problems.push({ code: 'STATE_SCOPE_MISSING', message: `${scopeMissing.length} 条状态缺 scope`, detail: scopeMissing.slice(0, 20) })
  if (badEnum.length) problems.push({ code: 'STATE_ENUM_INVALID', message: `${badEnum.length} 条状态字段越界/非法`, detail: badEnum.slice(0, 20) })
  if (root.manifest?.chunks != null && Number(root.manifest.chunks) !== root.chunks.length) {
    problems.push({ code: 'ROOT_COUNT_MISMATCH', message: `根藏 manifest.chunks=${root.manifest.chunks} 与实际 ${root.chunks.length} 不一致` })
  }

  for (const [gid, g] of duplicates.map) {
    const missing = (g.chunkIds ?? []).filter((id) => !chunkById.has(id))
    if (missing.length) problems.push({ code: 'DUPLICATE_MEMBER_MISSING', message: `重复组 ${gid} 有 ${missing.length} 个成员不在根藏`, detail: { groupId: gid, missing } })
    if (Number(g.evidenceCount) !== (g.chunkIds ?? []).length) {
      problems.push({ code: 'DUPLICATE_EVIDENCE_MISMATCH', message: `重复组 ${gid} evidenceCount 与成员数不一致`, detail: { groupId: gid, evidenceCount: g.evidenceCount, members: g.chunkIds?.length } })
    }
    if ((g.mergedFrom ?? []).length !== (g.chunkIds ?? []).length) {
      problems.push({ code: 'DUPLICATE_MERGEDFROM_MISMATCH', message: `重复组 ${gid} mergedFrom 未保留全部成员`, detail: { groupId: gid } })
    }
  }

  const pendingDupGroups = [...duplicates.map.values()].filter((g) => g.status === 'pending')
  const overlaps = []
  for (let i = 0; i < pendingDupGroups.length; i++) {
    for (let j = i + 1; j < pendingDupGroups.length; j++) {
      const a = new Set(pendingDupGroups[i].chunkIds ?? [])
      const shared = (pendingDupGroups[j].chunkIds ?? []).filter((id) => a.has(id))
      if (shared.length) overlaps.push({ a: pendingDupGroups[i].groupId, b: pendingDupGroups[j].groupId, shared })
    }
  }
  if (overlaps.length) problems.push({ code: 'DUPLICATE_GROUP_OVERLAP', message: `${overlaps.length} 对 pending 重复组成员重叠`, detail: overlaps.slice(0, 10) })

  const rootBuiltAt = root.manifest?.builtAt ?? null
  for (const [pid, p] of pending.map) {
    if (p.status !== 'pending') continue
    const missing = (p.chunkIds ?? []).filter((id) => !chunkById.has(id))
    if (missing.length) problems.push({ code: 'PENDING_MEMBER_MISSING', message: `待处理 ${pid} 引用的块不在根藏`, detail: { pendingId: pid, missing } })
    if (rootBuiltAt && p.rootBuiltAt && p.rootBuiltAt !== rootBuiltAt) {
      problems.push({ code: 'PENDING_STALE_ROOT', message: `待处理 ${pid} 基于旧根藏 builtAt，apply 会被拒`, detail: { pendingId: pid, pendingRootBuiltAt: p.rootBuiltAt, currentRootBuiltAt: rootBuiltAt } })
    }
  }

  const conflictIds = new Set(conflicts.map.keys())
  for (const [cid, c] of conflicts.map) {
    const missing = (c.chunkIds ?? []).filter((id) => !chunkById.has(id))
    if (missing.length) problems.push({ code: 'CONFLICT_MEMBER_MISSING', message: `冲突 ${cid} 引用的块不在根藏`, detail: { conflictId: cid, missing } })
    if (c.status === 'open') {
      for (const id of c.chunkIds ?? []) {
        const s = state.map.get(id)
        if (s && s.conflictGroup !== cid) {
          problems.push({ code: 'CONFLICT_STATE_LINK_MISMATCH', message: `冲突 ${cid} 的成员 ${id} 未挂到该 conflictGroup`, detail: { conflictId: cid, chunkId: id, stateConflictGroup: s.conflictGroup ?? null } })
        }
      }
    }
  }
  for (const [id, s] of state.map) {
    if (!s.conflictGroup) continue
    if (!conflictIds.has(s.conflictGroup)) {
      problems.push({ code: 'CONFLICT_GROUP_DANGLING', message: `状态 ${id} 的 conflictGroup 不存在`, detail: { chunkId: id, conflictGroup: s.conflictGroup } })
    }
  }

  const topicIds = new Set(topics.topics.map((t) => t.topicId))
  for (const m of topics.members) {
    if (!topicIds.has(m.topicId)) problems.push({ code: 'TOPIC_MEMBER_ORPHAN', message: `topic_members 引用了不存在的 topicId`, detail: { topicId: m.topicId, chunkId: m.chunkId } })
    if (!chunkById.has(m.chunkId)) problems.push({ code: 'TOPIC_MEMBER_CHUNK_MISSING', message: `topic_members 引用的块不在根藏`, detail: { topicId: m.topicId, chunkId: m.chunkId } })
  }

  // 计数一致性
  const computed = await computeCounts(dataRoot, personaId, root.chunks)
  const manifestCounts = man.manifest.counts ?? {}
  const diff = {}
  for (const k of Object.keys(computed)) {
    if (Number(manifestCounts[k] ?? -1) !== Number(computed[k])) diff[k] = { manifest: manifestCounts[k] ?? null, computed: computed[k] }
  }
  if (Object.keys(diff).length) {
    problems.push({ code: 'COUNT_MISMATCH', message: 'manifest.counts 与实际计数不一致', detail: diff })
  }

  if (unprocessed > 0) info.push(`${unprocessed} 块尚未处理（默认 active 可见，不算错误）`)

  const lock = await import('./lock.mjs').then((m) => m.peekLock(processDir(dataRoot, personaId)))
  if (lock.exists) info.push(`process 锁存在（pid ${lock.info?.pid ?? '?'}，age ${lock.ageMs}ms）`)

  return {
    ok: problems.length === 0,
    personaId,
    dataRoot,
    generation: man.manifest.generation,
    ruleVersion: man.manifest.ruleVersion,
    counts: { computed, manifest: manifestCounts, diff },
    states: { unique: state.map.size, records: state.rows.length, unprocessed, orphans: orphans.length, stale: stale.length, crossScope: crossScope.length, scopeMissing: scopeMissing.length, badEnum: badEnum.length },
    duplicates: { groups: duplicates.map.size },
    pending: { total: pending.map.size, pending: [...pending.map.values()].filter((p) => p.status === 'pending').length },
    conflicts: { total: conflicts.map.size, open: [...conflicts.map.values()].filter((c) => c.status === 'open').length },
    topics: { topics: topics.topics.length, members: topics.members.length },
    problems,
    info,
    checkedAt: now(),
  }
}

/**
 * repair：只做「不删数据」的修复
 *   · 重算 manifest.counts；
 *   · 清 process 目录里的孤儿 tmp（自己命名规则的）；
 *   · 把 anchor 重映射候选写到 _archive/（不自动改 state，不删孤儿）。
 */
export async function repairProcess(opts = {}) {
  const { dataRoot, personaId, now = Date.now } = opts
  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }
    const root = await readScope(dataRoot, personaId)
    if (!root.ok) return { ok: false, code: root.code, error: root.error }
    const repaired = []

    const orphanTmp = await listOrphanTmp(processDir(dataRoot, personaId))
    const removed = await clearOrphanTmp(processDir(dataRoot, personaId))
    if (removed.length) repaired.push({ action: 'clear-orphan-tmp', count: removed.length, files: removed })

    const verify = await verifyProcess({ dataRoot, personaId, now })
    if (verify.counts?.diff && Object.keys(verify.counts.diff).length) {
      const counts = await computeCounts(dataRoot, personaId, root.chunks)
      await writeManifest(dataRoot, personaId, { ...man.manifest, counts })
      repaired.push({ action: 'recount-manifest', counts })
    }

    const remap = (verify.problems ?? []).length
      ? (await verifyProcess({ dataRoot, personaId, now })).problems
      : []
    // 重映射候选从 verify 的 info 无法直接拿到，重算一次
    const state = await readStateMap(dataRoot, personaId)
    const chunkIds = new Set(root.chunks.map((c) => c.id))
    const byAnchor = new Map()
    for (const c of root.chunks) {
      const key = `${c.session}|${c.messageId}|${c.seq}|${c.part ?? 0}`
      if (!byAnchor.has(key)) byAnchor.set(key, [])
      byAnchor.get(key).push(c.id)
    }
    const candidates = []
    for (const [id, s] of state.map) {
      if (chunkIds.has(id)) continue
      if (s.anchorKey && byAnchor.has(s.anchorKey)) {
        const c = byAnchor.get(s.anchorKey).filter((x) => x !== id)
        if (c.length) candidates.push({ oldChunkId: id, anchorKey: s.anchorKey, candidates: c, status: s.status })
      }
    }
    if (candidates.length) {
      const dir = join(processDir(dataRoot, personaId), '_archive')
      assertProcessWrite(dataRoot, personaId, dir)
      await ensureDir(dir)
      const file = join(dir, `anchor-remap-${tsSlug()}.json`)
      await writeJsonAtomic(file, { at: now, personaId, candidates })
      repaired.push({ action: 'write-anchor-remap-candidates', count: candidates.length, file })
    }

    const after = await verifyProcess({ dataRoot, personaId, now })
    return {
      ok: after.ok,
      personaId,
      repaired,
      orphanTmp: orphanTmp.length,
      stillProblems: after.problems,
      note: 'repair 不删除任何 state/duplicates/pending/conflicts；孤儿只报告不清理',
    }
  } catch (e) {
    return { ok: false, code: e.code || 'REPAIR_FAILED', error: toErrInfo(e) }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}
