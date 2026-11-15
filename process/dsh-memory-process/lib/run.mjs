/**
 * lib/run.mjs —— 熏习 run：扫根藏（只读），生成状态与候选，绝不自动 apply
 *
 * 幂等：
 *   · 同一 rootBuiltAt + 同块数 → 直接跳过（除非 --force）；
 *   · 状态/重复组/待处理 id 都是确定性的，重跑不会重复写入；
 *   · checkpoint 按 rootBuiltAt 续跑；失败不推进 checkpoint，不丢尾部。
 *
 * 铁律：
 *   · 未处理块默认 active 可见（不隐藏任何记忆）；
 *   · 规则只降不升；未解释矛盾只开 conflict，不自动裁决；
 *   · 默认零 LLM、零网络、零嵌入。
 */
import { join } from 'node:path'
import { acquireLock } from './lock.mjs'
import { ensureManifest, readManifest, writeManifest, readStateMap, readDuplicatesMap, readPendingMap, readConflictsMap, appendLog, computeCounts } from './store.mjs'
import { readScope, rootSignature } from './root.mjs'
import { classify, normalizeForDedup } from './rules.mjs'
import { detectDuplicates, reconcileDuplicateGroups } from './dedupe.mjs'
import { jaccard3, hashText } from './simhash.mjs'
import { MAX_CHUNKS_PER_RUN, RULE_VERSION, DEFAULT_THRESHOLDS } from './version.mjs'
import { ProcessError, toErrInfo } from './errors.mjs'
import { processDir, processFile, anchorKeyOf, assertProcessWrite } from './paths.mjs'
import { ensureDir } from './fsatomic.mjs'

function round4(n) { return Number(Number(n).toFixed(4)) }

function stateSignature(s) {
  if (!s) return null
  return JSON.stringify([
    s.status, s.epistemic, s.attribution, s.sensitivity,
    s.ruleRef?.ruleVersion ?? null, s.sourceHash ?? null, s.conflictGroup ?? null,
    s.validTo ?? null, s.supersededBy ?? null,
  ])
}

function pendingIdFor(kind, ids, proposed) {
  return `pending-${kind}-${hashText(JSON.stringify([kind, ids, proposed])).slice(0, 16)}`
}

function conflictIdFor(kind, ids) {
  return `conflict-${kind}-${hashText(JSON.stringify([kind, ids])).slice(0, 16)}`
}

function makeState(manifest, rootManifest, personaId, chunk, cls, existing, opts = {}) {
  const retentionDays = Number(rootManifest?.retentionDays ?? 0)
  const expiredByRoot = chunk.retention === 'expired'
  let status = 'active'
  let validTo = null
  let reason = 'rule:classified'
  let source = 'rule'

  if (existing && (existing.status === 'superseded' || existing.status === 'archived')) {
    status = existing.status
    validTo = existing.validTo ?? null
    reason = existing.reason ?? reason
    source = existing.source ?? source
  } else if (existing && existing.status === 'active' && existing.reason === 'user:restore') {
    // 用户显式 restore 的优先级高于根藏 retention 镜像（避免 restore 后一跑 run 又被过期）
    status = 'active'
    validTo = null
    reason = 'user:restore'
    source = 'user'
  } else if ((opts.autoMirrorRetention !== false && expiredByRoot) || (existing && existing.status === 'expired')) {
    status = 'expired'
    validTo = existing?.validTo ?? (expiredByRoot && retentionDays > 0 ? chunk.t + retentionDays * 86400000 : chunk.t)
    reason = 'root:retention'
    source = 'rule'
  }

  return {
    chunkId: chunk.id,
    anchorKey: anchorKeyOf(chunk),
    scope: personaId,
    status,
    validFrom: chunk.t ?? null,
    validTo,
    supersededBy: existing?.supersededBy ?? null,
    reason,
    source,
    confidence: status === 'active' ? 0.9 : 1,
    version: existing ? Number(existing.version ?? 1) + 1 : 1,
    epistemic: cls.epistemic,
    attribution: cls.attribution,
    sensitivity: cls.sensitivity,
    conflictGroup: existing?.conflictGroup ?? null,
    ruleRef: cls.ruleRef,
    updatedAt: chunk.t ?? opts.now ?? Date.now(),
    generation: String(manifest.generation),
    rootBuiltAt: rootManifest?.builtAt ?? null,
    sourceHash: chunk.sourceHash ?? null,
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dataRoot 根藏数据根（只读）
 * @param {string} opts.personaId
 * @param {boolean} [opts.force]
 * @param {number} [opts.maxChunks]
 * @param {number} [opts.failAfter] 测试钩子：处理 N 条后抛错（生产不传）
 * @param {function} [opts.now]
 */
export async function runProcess(opts) {
  const {
    dataRoot,
    personaId,
    force = false,
    maxChunks = MAX_CHUNKS_PER_RUN,
    autoMirrorRetention = true,
    now = Date.now,
  } = opts
  const started = now()
  const failAfter = opts.failAfter ?? (process.env.JIANMU_PROCESS_FAIL_AFTER ? Number(process.env.JIANMU_PROCESS_FAIL_AFTER) : 0)

  const lock = opts.skipLock
    ? { ok: true, release: async () => ({ released: true, reason: 'outer-lock' }) }
    : await acquireLock(processDir(dataRoot, personaId), { timeoutMs: opts.lockTimeoutMs ?? 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }

  let partialStateRows = []

  try {
    const root = await readScope(dataRoot, personaId)
    if (!root.ok) {
      return { ok: false, personaId, code: root.code, error: root.error }
    }
    // P0-2：空库明确报 EMPTY_ROOT，不静默生成 0 块状态
    if (root.empty) {
      return {
        ok: false, personaId, code: 'EMPTY_ROOT',
        error: { code: 'EMPTY_ROOT', message: '根藏为空（没有可处理的原话）：先装根藏并摄取，再来跑熏习' },
      }
    }
    const rootManifest = root.manifest
    const chunks = root.chunks
    const sig = await rootSignature(dataRoot, personaId)

    const ensured = await ensureManifest(dataRoot, personaId, { rootBuiltAt: rootManifest?.builtAt ?? null })
    if (!ensured.ok) return { ok: false, personaId, code: ensured.code, error: ensured.error }
    let manifest = ensured.manifest

    // 幂等：同 rootBuiltAt + 同块数 + checkpoint 完成 → 跳过
    const sameRoot = manifest.lastRunRootBuiltAt && manifest.lastRunRootBuiltAt === rootManifest?.builtAt
    const sameCount = (manifest.lastRunRootChunks ?? null) === chunks.length
    const checkpointComplete = !manifest.lastRunCheckpoint || manifest.lastRunCheckpoint.complete !== false
    if (!force && sameRoot && sameCount && checkpointComplete) {
      return {
        ok: true,
        skipped: true,
        reason: 'same-root-builtAt',
        personaId,
        rootBuiltAt: rootManifest?.builtAt ?? null,
        chunks: chunks.length,
        generation: manifest.generation,
        elapsedMs: now() - started,
      }
    }

    // batch 起点：只有「同 rootBuiltAt 且未完成」才续跑
    let start = 0
    const cp = manifest.lastRunCheckpoint
    if (!force && cp && cp.rootBuiltAt === (rootManifest?.builtAt ?? null) && cp.complete === false) {
      start = Math.max(0, Math.min(Number(cp.nextIndex) || 0, chunks.length))
    }
    const batch = chunks.slice(start, start + Math.max(1, maxChunks))
    const complete = start + batch.length >= chunks.length

    const stateRead = await readStateMap(dataRoot, personaId)
    const stateMap = stateRead.map
    const dupRead = await readDuplicatesMap(dataRoot, personaId)
    const pendingRead = await readPendingMap(dataRoot, personaId)
    const conflictRead = await readConflictsMap(dataRoot, personaId)

    const stateRows = []
    let processed = 0
    let changedStates = 0
    let expiredMirrored = 0

    for (let i = 0; i < batch.length; i++) {
      const chunk = batch[i]
      if (failAfter > 0 && processed >= failAfter) {
        partialStateRows = stateRows.slice()
        throw new ProcessError('RUN_FAILED', `测试钩子：处理 ${failAfter} 条后模拟失败`, { processed })
      }
      const cls = classify(chunk)
      const existing = stateMap.get(chunk.id)
      const next = makeState(manifest, rootManifest, personaId, chunk, cls, existing, { now: now(), autoMirrorRetention })
      processed++
      if (next.status === 'expired' && existing?.status !== 'expired') expiredMirrored++
      if (!existing || stateSignature(existing) !== stateSignature(next)) {
        stateRows.push(next)
        changedStates++
        stateMap.set(chunk.id, next)
      }
    }

    // 重复检测：全 scope（精确 + SimHash），按已有 pending 组做增量对账
    const dedupe = detectDuplicates(chunks, {
      simhashDistance: manifest.thresholds?.simhashDistance ?? DEFAULT_THRESHOLDS.simhashDistance,
      jaccardThreshold: manifest.thresholds?.jaccard ?? DEFAULT_THRESHOLDS.jaccard,
    })
    const dupRowsToWrite = reconcileDuplicateGroups(dupRead.map, dedupe.groups, now())
    const newDupRows = dupRowsToWrite.filter((g) => !dupRead.map.has(g.groupId) && g.status === 'pending')
    const updatedDupRows = dupRowsToWrite.filter((g) => dupRead.map.has(g.groupId) || g.status !== 'pending')

    // 取代候选：只对 batch 里带明确改口线索的块（同 session + 3-gram 复核）
    const pendingRows = []
    const conflictRows = []
    const existingPendingIds = new Set(pendingRead.map.keys())
    const existingConflictIds = new Set(conflictRead.map.keys())
    const batchIds = new Set(batch.map((c) => c.id))
    const bySession = new Map()
    for (const c of chunks) {
      if (!bySession.has(c.session)) bySession.set(c.session, [])
      bySession.get(c.session).push(c)
    }

    let unpairedCorrections = 0
    const minJaccard = manifest.thresholds?.supersedeMinJaccard ?? DEFAULT_THRESHOLDS.supersedeMinJaccard
    const minConfidence = manifest.thresholds?.supersedeMinConfidence ?? DEFAULT_THRESHOLDS.supersedeMinConfidence
    const maxSupersedeChars = manifest.thresholds?.supersedeMaxChars ?? DEFAULT_THRESHOLDS.supersedeMaxChars

    for (const chunk of batch) {
      const cls = classify(chunk)
      if (!cls.clues.correction && !cls.clues.change) continue
      // 长文里的「改成/不是…是…」多为叙述或建议，不能当改口；只处理短句
      if (String(chunk.text ?? '').length > maxSupersedeChars) continue
      if (cls.clues.correction && normalizeForDedup(chunk.text).length < 4) continue
      const pool = (bySession.get(chunk.session) ?? []).filter((c) => c.id !== chunk.id && (c.t ?? 0) <= (chunk.t ?? 0) && String(c.text ?? '').length <= maxSupersedeChars)
      let best = null
      for (const cand of pool) {
        const existing = stateMap.get(cand.id)
        if (existing && (existing.status === 'superseded' || existing.status === 'archived')) continue
        const jac = jaccard3(normalizeForDedup(chunk.text), normalizeForDedup(cand.text))
        if (jac < minJaccard) continue
        if (!best || jac > best.jac || (jac === best.jac && (cand.t ?? 0) > (best.cand.t ?? 0))) best = { cand, jac }
      }
      if (best) {
        const confidence = round4(0.6 + 0.3 * best.jac)
        if (confidence < minConfidence) continue
        const proposed = {
          status: 'superseded',
          chunkId: best.cand.id,
          supersededBy: chunk.id,
          validTo: chunk.t ?? null,
        }
        const pendingId = pendingIdFor('supersede', [best.cand.id, chunk.id], proposed)
        if (existingPendingIds.has(pendingId)) continue
        pendingRows.push({
          pendingId,
          kind: 'supersede',
          chunkIds: [best.cand.id, chunk.id],
          proposed,
          reason: cls.clues.correction ? 'rule:explicit-correction' : 'rule:explicit-change',
          confidence,
          status: 'pending',
          createdAt: chunk.t ?? now(),
          memoryT: chunk.t ?? null,
          generatedAt: now(),
          updatedAt: now(),
          generation: String(manifest.generation),
          rootGeneration: rootManifest?.generation ?? null,
          rootBuiltAt: rootManifest?.builtAt ?? null,
          ruleRef: { ruleId: cls.clues.correction ? 'rule:explicit-correction' : 'rule:explicit-change', ruleVersion: RULE_VERSION },
          evidence: { jaccard: round4(best.jac), session: chunk.session },
        })
        existingPendingIds.add(pendingId)
      } else if (cls.clues.correction) {
        // 明确改口但没有对照目标：v1a 不自动配对、不刷 conflict（自动配对接 v1b）；
        // 只计数，用户可在 review 里看 unpairedCorrections，或手动 conflict-add。
        unpairedCorrections++
      }
    }

    // 写：state → duplicates → pending → conflicts → manifest
    let generation = manifest.generation
    let wrote = false

    if (stateRows.length) {
      await appendLog(dataRoot, personaId, 'state', stateRows)
      wrote = true
    }
    if (dupRowsToWrite.length) {
      await appendLog(dataRoot, personaId, 'duplicates', dupRowsToWrite)
      wrote = true
    }
    if (pendingRows.length) {
      await appendLog(dataRoot, personaId, 'pending', pendingRows)
      wrote = true
    }
    if (conflictRows.length) {
      await appendLog(dataRoot, personaId, 'conflicts', conflictRows)
      wrote = true
    }

    if (wrote) generation = manifest.generation + 1
    const counts = await computeCounts(dataRoot, personaId, chunks)
    const nextManifest = {
      ...manifest,
      generation,
      rootBuiltAt: rootManifest?.builtAt ?? null,
      lastRunAt: now(),
      lastRunRootBuiltAt: rootManifest?.builtAt ?? null,
      lastRunRootChunks: chunks.length,
      lastRunSignature: sig,
      lastRunCheckpoint: {
        rootBuiltAt: rootManifest?.builtAt ?? null,
        nextIndex: start + batch.length,
        total: chunks.length,
        complete,
        lastChunkId: batch.at(-1)?.id ?? null,
      },
      lastError: null,
      lastRunStats: {
        unpairedCorrections,
        duplicateCapped: Boolean(dedupe.stats?.capped),
        candidatePairs: dedupe.stats?.candidatePairs ?? null,
        newDuplicateGroups: newDupRows.length,
        updatedDuplicateGroups: updatedDupRows.length,
        newPending: pendingRows.length,
        newConflicts: conflictRows.length,
        llmCalls: 0,
        networkCalls: 0,
      },
      counts,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(manifest.thresholds ?? {}) },
      llmEnabled: false,
    }
    manifest = await writeManifest(dataRoot, personaId, nextManifest)

    // 写后读回：新写状态必须 found（unknown ≠ 成功）
    const after = await readStateMap(dataRoot, personaId)
    const missing = []
    for (const row of stateRows) {
      if (!after.map.has(row.chunkId)) missing.push(row.chunkId)
    }
    if (missing.length) {
      const err = { code: 'READBACK_MISMATCH', message: `写后读回缺 ${missing.length} 条状态`, missing: missing.slice(0, 5) }
      await writeManifest(dataRoot, personaId, { ...manifest, lastError: { ...err, at: now() } }).catch(() => {})
      return { ok: false, personaId, code: 'READBACK_MISMATCH', error: err }
    }

    return {
      ok: true,
      skipped: false,
      personaId,
      rootBuiltAt: rootManifest?.builtAt ?? null,
      rootChunks: chunks.length,
      batch: { start, count: batch.length, total: chunks.length, complete },
      state: { appended: stateRows.length, changed: changedStates, expiredMirrored, unprocessed: chunks.length - stateMap.size },
      duplicates: { newExact: newDupRows.filter((g) => g.method === 'exact').length, newNear: newDupRows.filter((g) => g.method === 'simhash+3gram').length, updated: updatedDupRows.length, totalGroups: new Set([...dupRead.map.keys(), ...dupRowsToWrite.map((g) => g.groupId)]).size, stats: dedupe.stats },
      pending: { new: pendingRows.length, total: pendingRead.map.size + pendingRows.length, unpairedCorrections },
      conflicts: { new: conflictRows.length, total: conflictRead.map.size + conflictRows.length },
      generation,
      elapsedMs: now() - started,
      llmCalls: 0,
      networkCalls: 0,
    }
  } catch (e) {
    const err = toErrInfo(e)
    // 失败留痕：已算出的部分状态先落盘（未处理块仍 active 可见），checkpoint 不推进
    try {
      if (partialStateRows.length) await appendLog(dataRoot, personaId, 'state', partialStateRows)
    } catch { /* 部分落盘失败不掩盖原始错误 */ }
    try {
      const man = await readManifest(dataRoot, personaId)
      if (man.ok) {
        await writeManifest(dataRoot, personaId, {
          ...man.manifest,
          lastError: { ...err, at: now() },
        })
      }
    } catch { /* 失败留痕失败不掩盖原始错误 */ }
    return { ok: false, personaId, code: err.code, error: err, elapsedMs: now() - started }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

export { stateSignature, pendingIdFor, conflictIdFor }
