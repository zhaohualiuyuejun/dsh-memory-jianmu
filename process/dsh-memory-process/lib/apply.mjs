/**
 * lib/apply.mjs —— 显式确认后的写入：apply / restore / 手动候选（archive/expire）/ 冲突标记
 *
 * 纪律：
 *   · 所有不确定动作先 pending，apply 才写 state；
 *   · apply 必须带 expectedGeneration（防旧快照）+ confirm；
 *   · 根藏 generation 变化后旧 apply 被拒（「旧任务未写入」）；
 *   · 写前快照到 _archive/，写后读回三态，unknown 不算成功；
 *   · 同一 applyId 重复调用幂等；不物理删除任何东西。
 */
import { join, dirname } from 'node:path'
import { resolve } from 'node:path'
import { acquireLock } from './lock.mjs'
import {
  readManifest, writeManifest, ensureManifest, backupLogs, readPendingMap, readDuplicatesMap,
  readStateMap, readConflictsMap, appendLog, computeCounts, readTopics,
} from './store.mjs'
import { readScope } from './root.mjs'
import { classify } from './rules.mjs'
import { hashText } from './simhash.mjs'
import { RULE_VERSION } from './version.mjs'
import { ProcessError, toErrInfo } from './errors.mjs'
import { processDir, processFile, assertProcessWrite, anchorKeyOf, isInside } from './paths.mjs'
import { writeJsonAtomic, writeExclusive, readJson, ensureDir } from './fsatomic.mjs'

function round4(n) { return Number(Number(n).toFixed(4)) }

/** applyId 只允许安全文件名；禁止路径分隔符与 `..`，防止穿越覆盖 manifest/state */
function validateApplyId(id) {
  const s = String(id ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) || s.includes('..')) {
    return { ok: false, code: 'BAD_APPLY_ID', error: { code: 'BAD_APPLY_ID', message: `applyId 非法（只允许 [A-Za-z0-9._-]，且不得含 ..）：${s}` } }
  }
  return { ok: true, applyId: s }
}

function resolveAppliedFile(dataRoot, personaId, applyId) {
  const appliedDir = join(processDir(dataRoot, personaId), '_archive', 'applied')
  const file = join(appliedDir, `${applyId}.json`)
  if (dirname(resolve(file)) !== resolve(appliedDir) || !isInside(appliedDir, file)) {
    return { ok: false, code: 'BAD_APPLY_ID', error: { code: 'BAD_APPLY_ID', message: `applyId 解析后越出 _archive/applied：${applyId}` } }
  }
  return { ok: true, file, appliedDir }
}

async function recordLastError(dataRoot, personaId, err, now) {
  try {
    const man = await readManifest(dataRoot, personaId)
    if (man.ok) {
      await writeManifest(dataRoot, personaId, { ...man.manifest, lastError: { ...err, at: now() } })
    }
  } catch { /* 失败留痕失败不掩盖原始错误 */ }
}

function manualPendingId(kind, chunkIds, proposed) {
  return `pending-${kind}-${hashText(JSON.stringify([kind, chunkIds, proposed])).slice(0, 16)}`
}

/** 读取根藏块（只读），找不到就报错；不猜 */
async function requireChunks(dataRoot, personaId, chunkIds) {
  const root = await readScope(dataRoot, personaId)
  if (!root.ok) return { ok: false, code: root.code, error: root.error }
  const map = new Map(root.chunks.map((c) => [c.id, c]))
  const missing = chunkIds.filter((id) => !map.has(id))
  if (missing.length) {
    return { ok: false, code: 'CHUNK_NOT_FOUND', error: { code: 'CHUNK_NOT_FOUND', message: `根藏里找不到 ${missing.length} 个块`, missing } }
  }
  return { ok: true, root, map }
}

/** 手动创建待处理（archive / expire）：只写 pending，不写 state */
export async function createManualPending(opts) {
  const { dataRoot, personaId, kind, chunkIds, proposed = {}, reason = 'user:manual', confidence = 1, now = Date.now } = opts
  if (!['archive', 'expire', 'dedupe', 'topic'].includes(kind)) {
    return { ok: false, code: 'BAD_KIND', error: { code: 'BAD_KIND', message: `不支持的手动候选类型：${kind}` } }
  }
  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const req = await requireChunks(dataRoot, personaId, chunkIds)
    if (!req.ok) return { ok: false, code: req.code, error: req.error }
    const ensured = await ensureManifest(dataRoot, personaId, { rootBuiltAt: req.root.manifest?.builtAt ?? null })
    if (!ensured.ok) return { ok: false, code: ensured.code, error: ensured.error }
    const pendingRead = await readPendingMap(dataRoot, personaId)
    const proposedFull = { status: kind === 'archive' ? 'archived' : kind === 'expire' ? 'expired' : proposed.status ?? null, ...proposed }
    const pendingId = manualPendingId(kind, chunkIds, proposedFull)
    if (pendingRead.map.has(pendingId)) {
      return { ok: true, alreadyExists: true, pendingId, status: pendingRead.map.get(pendingId).status }
    }
    const row = {
      pendingId,
      kind,
      chunkIds,
      proposed: proposedFull,
      reason,
      confidence,
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
      generation: String(ensured.manifest.generation),
      rootGeneration: req.root.manifest?.generation ?? null,
      rootBuiltAt: req.root.manifest?.builtAt ?? null,
      ruleRef: null,
    }
    await appendLog(dataRoot, personaId, 'pending', [row])
    const counts = await computeCounts(dataRoot, personaId, req.root.chunks)
    await writeManifest(dataRoot, personaId, { ...ensured.manifest, generation: ensured.manifest.generation + 1, counts })
    return { ok: true, pendingId, status: 'pending', kind, generation: ensured.manifest.generation + 1 }
  } catch (e) {
    return { ok: false, code: e.code || 'PENDING_FAILED', error: toErrInfo(e) }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

function applyOneState(manifest, pending, current) {
  const now = Date.now()
  const base = current ?? null
  const proposed = pending.proposed ?? {}
  if (pending.kind === 'supersede') {
    const oldId = proposed.chunkId ?? pending.chunkIds[0]
    const newId = proposed.supersededBy ?? pending.chunkIds[1]
    return {
      ...(base ?? {}),
      chunkId: oldId,
      status: 'superseded',
      validTo: proposed.validTo ?? now,
      supersededBy: newId,
      reason: pending.reason ?? 'rule:explicit-correction',
      source: 'rule',
      confidence: pending.confidence ?? base?.confidence ?? 0.6,
      version: Number(base?.version ?? 1) + 1,
      updatedAt: now,
      generation: String(manifest.generation),
    }
  }
  if (pending.kind === 'archive') {
    const id = pending.chunkIds[0]
    return {
      ...(base ?? {}),
      chunkId: id,
      status: 'archived',
      validTo: proposed.validTo ?? now,
      supersededBy: null,
      reason: pending.reason ?? 'user:manual',
      source: 'user',
      confidence: pending.confidence ?? 1,
      version: Number(base?.version ?? 1) + 1,
      updatedAt: now,
      generation: String(manifest.generation),
    }
  }
  if (pending.kind === 'expire') {
    const id = pending.chunkIds[0]
    return {
      ...(base ?? {}),
      chunkId: id,
      status: 'expired',
      validTo: proposed.validTo ?? now,
      supersededBy: null,
      reason: pending.reason ?? 'user:manual',
      source: 'user',
      confidence: pending.confidence ?? 1,
      version: Number(base?.version ?? 1) + 1,
      updatedAt: now,
      generation: String(manifest.generation),
    }
  }
  return null
}

function synthActiveState(manifest, rootManifest, personaId, chunk, cls) {
  return {
    chunkId: chunk.id,
    anchorKey: anchorKeyOf(chunk),
    scope: personaId,
    status: 'active',
    validFrom: chunk.t ?? null,
    validTo: null,
    supersededBy: null,
    reason: 'unprocessed:default-active',
    source: 'rule',
    confidence: 0,
    version: 1,
    epistemic: cls.epistemic,
    attribution: cls.attribution,
    sensitivity: cls.sensitivity,
    conflictGroup: null,
    ruleRef: cls.ruleRef,
    updatedAt: chunk.t ?? Date.now(),
    generation: String(manifest.generation),
    rootBuiltAt: rootManifest?.builtAt ?? null,
    sourceHash: chunk.sourceHash ?? null,
  }
}

/**
 * 应用待处理项。
 * @param {object} opts {dataRoot, personaId, pendingIds, expectedGeneration, confirm, applyId, now}
 */
export async function applyPending(opts) {
  const { dataRoot, personaId, pendingIds = [], expectedGeneration, confirm = false, now = Date.now } = opts
  if (!confirm) return { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '破坏性动作需要 confirm=true' } }
  if (!Array.isArray(pendingIds) || pendingIds.length === 0) {
    return { ok: false, code: 'PENDING_NOT_FOUND', error: { code: 'PENDING_NOT_FOUND', message: 'pendingIds 为空' } }
  }
  const applyId = opts.applyId ?? `apply-${hashText(JSON.stringify([personaId, [...pendingIds].sort(), expectedGeneration ?? null])).slice(0, 16)}`
  const idCheck = validateApplyId(applyId)
  if (!idCheck.ok) return idCheck
  const resolved = resolveAppliedFile(dataRoot, personaId, applyId)
  if (!resolved.ok) return resolved
  const { appliedDir, file: appliedFile } = resolved
  assertProcessWrite(dataRoot, personaId, appliedFile)

  // 幂等缓存：同一 applyId 直接返回上次结果
  const cached = await readJson(appliedFile)
  if (cached.ok) return { ...cached.value, alreadyApplied: true, applyId }

  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }
    const manifest = man.manifest
    if (expectedGeneration == null || !Number.isFinite(Number(expectedGeneration))) {
      return {
        ok: false,
        code: 'STALE_GENERATION',
        error: { code: 'STALE_GENERATION', message: '旧任务未写入：缺少 expectedGeneration（契约要求必填）' },
      }
    }
    if (Number(expectedGeneration) !== Number(manifest.generation)) {
      return {
        ok: false,
        code: 'STALE_GENERATION',
        error: {
          code: 'STALE_GENERATION',
          message: '旧任务未写入：expectedGeneration 与当前 generation 不一致',
          expectedGeneration,
          currentGeneration: manifest.generation,
        },
      }
    }

    const root = await readScope(dataRoot, personaId)
    if (!root.ok) return { ok: false, code: root.code, error: root.error }
    const rootChunkMap = new Map(root.chunks.map((c) => [c.id, c]))

    const pendingRead = await readPendingMap(dataRoot, personaId)
    const stateRead = await readStateMap(dataRoot, personaId)
    const dupRead = await readDuplicatesMap(dataRoot, personaId)

    const selected = []
    for (const pid of pendingIds) {
      const p = pendingRead.map.get(pid)
      if (!p) return { ok: false, code: 'PENDING_NOT_FOUND', error: { code: 'PENDING_NOT_FOUND', message: `pending 不存在：${pid}` } }
      if (p.status === 'applied' && p.applyId === applyId) continue
      if (p.status !== 'pending') {
        return { ok: false, code: 'PENDING_NOT_PENDING', error: { code: 'PENDING_NOT_PENDING', message: `pending 已不是待处理状态（${p.status}）：${pid}` } }
      }
      // 根藏代际：根藏刷新后，旧候选不得落盘。
      // 根藏 append 只改 builtAt 不递增 generation，所以 builtAt 也必须比。
      if (p.rootBuiltAt && root.manifest?.builtAt && p.rootBuiltAt !== root.manifest.builtAt) {
        return {
          ok: false,
          code: 'STALE_ROOT',
          error: {
            code: 'STALE_ROOT',
            message: '旧任务未写入：根藏 builtAt 已变化（可能发生了增量），请重新 run 生成候选',
            pendingRootBuiltAt: p.rootBuiltAt,
            currentRootBuiltAt: root.manifest.builtAt,
          },
        }
      }
      if (p.rootGeneration != null && root.manifest?.generation != null && p.rootGeneration !== root.manifest.generation) {
        return {
          ok: false,
          code: 'STALE_ROOT',
          error: {
            code: 'STALE_ROOT',
            message: '旧任务未写入：根藏 generation 已变化，请重新 run 生成候选',
            pendingRootGeneration: p.rootGeneration,
            currentRootGeneration: root.manifest.generation,
          },
        }
      }
      for (const id of p.chunkIds) {
        if (!rootChunkMap.has(id)) {
          return { ok: false, code: 'CHUNK_NOT_FOUND', error: { code: 'CHUNK_NOT_FOUND', message: `根藏已找不到候选涉及的块：${id}` } }
        }
      }
      selected.push(p)
    }

    if (selected.length === 0) {
      return { ok: true, alreadyApplied: true, applyId, applied: [], generation: manifest.generation }
    }

    // 写前快照
    const snap = await backupLogs(dataRoot, personaId, 'apply', ['state', 'pending', 'duplicates'])

    const stateRows = []
    const pendingRows = []
    const dupRows = []

    for (const p of selected) {
      if (p.kind === 'dedupe') {
        const gid = p.proposed?.groupId ?? p.chunkIds[0]
        const g = dupRead.map.get(gid)
        if (g) {
          dupRows.push({ ...g, status: p.proposed?.status ?? 'merged', version: Number(g.version ?? 1) + 1, updatedAt: now(), appliedBy: applyId })
        }
        pendingRows.push({ ...p, status: 'applied', appliedAt: now(), applyId, updatedAt: now() })
        continue
      }
      if (p.kind === 'topic') {
        // v1b 才实现；这里只登记 applied，避免误写 topic_members
        pendingRows.push({ ...p, status: 'applied', appliedAt: now(), applyId, updatedAt: now(), note: 'topic apply 于 v1b 实现' })
        continue
      }
      const targetId = p.proposed?.chunkId ?? p.chunkIds[0]
      let current = stateRead.map.get(targetId) ?? null
      if (!current) {
        const chunk = rootChunkMap.get(targetId)
        if (!chunk) {
          return { ok: false, code: 'CHUNK_NOT_FOUND', error: { code: 'CHUNK_NOT_FOUND', message: `候选目标块不存在：${targetId}` } }
        }
        current = synthActiveState(manifest, root.manifest, personaId, chunk, classify(chunk))
      }
      const row = applyOneState(manifest, p, current)
      if (!row) {
        return { ok: false, code: 'APPLY_FAILED', error: { code: 'APPLY_FAILED', message: `未知 pending kind：${p.kind}` } }
      }
      stateRows.push(row)
      pendingRows.push({ ...p, status: 'applied', appliedAt: now(), applyId, updatedAt: now() })
    }

    if (stateRows.length) await appendLog(dataRoot, personaId, 'state', stateRows)
    if (pendingRows.length) await appendLog(dataRoot, personaId, 'pending', pendingRows)
    if (dupRows.length) await appendLog(dataRoot, personaId, 'duplicates', dupRows)

    const generation = manifest.generation + 1
    const counts = await computeCounts(dataRoot, personaId, root.chunks)
    const nextManifest = await writeManifest(dataRoot, personaId, { ...manifest, generation, counts, lastError: null })

    // 写后读回
    const afterState = await readStateMap(dataRoot, personaId)
    const afterPending = await readPendingMap(dataRoot, personaId)
    const missingState = []
    for (const row of stateRows) {
      const got = afterState.map.get(row.chunkId)
      if (!got || got.status !== row.status) missingState.push(row.chunkId)
    }
    const missingPending = pendingRows.filter((p) => afterPending.map.get(p.pendingId)?.status !== 'applied').map((p) => p.pendingId)
    if (missingState.length || missingPending.length) {
      const err = { code: 'APPLY_FAILED', message: '写后读回不一致', missingState, missingPending }
      await writeManifest(dataRoot, personaId, { ...nextManifest, lastError: { ...err, at: now() } }).catch(() => {})
      return { ok: false, code: 'APPLY_FAILED', error: err, applyId }
    }

    const result = {
      ok: true,
      applyId,
      applied: selected.map((p) => ({ pendingId: p.pendingId, kind: p.kind, chunkIds: p.chunkIds, proposed: p.proposed })),
      stateRows: stateRows.length,
      generation,
      snapshot: snap.dir,
      alreadyApplied: false,
    }
    await ensureDir(appliedDir)
    await writeExclusive(appliedFile, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (e) {
    const error = toErrInfo(e)
    await recordLastError(dataRoot, personaId, error, now)
    return { ok: false, code: e.code || 'APPLY_FAILED', error, applyId }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

/**
 * 驳回待处理项：只把 pending.status 置为 dismissed，不删任何行、不动 state。
 * 与 apply 同纪律：confirm + expectedGeneration + 写前快照 + 写后读回 + 幂等（dismissId）。
 */
export async function dismissPending(opts) {
  const { dataRoot, personaId, pendingIds = [], expectedGeneration, confirm = false, now = Date.now } = opts
  if (!confirm) return { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '驳回动作为写操作，需要 confirm=true' } }
  if (!Array.isArray(pendingIds) || pendingIds.length === 0) {
    return { ok: false, code: 'PENDING_NOT_FOUND', error: { code: 'PENDING_NOT_FOUND', message: 'pendingIds 为空' } }
  }
  const dismissId = opts.dismissId ?? `dismiss-${hashText(JSON.stringify([personaId, [...pendingIds].sort(), expectedGeneration ?? null])).slice(0, 16)}`
  const idCheck = validateApplyId(dismissId)
  if (!idCheck.ok) return idCheck

  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }
    const manifest = man.manifest
    if (expectedGeneration == null || !Number.isFinite(Number(expectedGeneration))) {
      return { ok: false, code: 'STALE_GENERATION', error: { code: 'STALE_GENERATION', message: '旧任务未写入：缺少 expectedGeneration（契约要求必填）' } }
    }
    if (Number(expectedGeneration) !== Number(manifest.generation)) {
      return {
        ok: false, code: 'STALE_GENERATION',
        error: { code: 'STALE_GENERATION', message: '旧任务未写入：expectedGeneration 与当前 generation 不一致', expectedGeneration, currentGeneration: manifest.generation },
      }
    }

    const root = await readScope(dataRoot, personaId)
    if (!root.ok) return { ok: false, code: root.code, error: root.error }

    const pendingRead = await readPendingMap(dataRoot, personaId)
    const selected = []
    for (const pid of pendingIds) {
      const p = pendingRead.map.get(pid)
      if (!p) return { ok: false, code: 'PENDING_NOT_FOUND', error: { code: 'PENDING_NOT_FOUND', message: `pending 不存在：${pid}` } }
      if (p.status === 'dismissed' && p.dismissId === dismissId) continue
      if (p.status !== 'pending') {
        return { ok: false, code: 'PENDING_NOT_PENDING', error: { code: 'PENDING_NOT_PENDING', message: `pending 已不是待处理状态（${p.status}）：${pid}` } }
      }
      selected.push(p)
    }
    if (selected.length === 0) {
      return { ok: true, dismissId, dismissed: [], generation: manifest.generation, alreadyDismissed: true }
    }

    // 写前快照：只快照 pending（本次只改它）
    const snap = await backupLogs(dataRoot, personaId, 'dismiss', ['pending'])
    const rows = selected.map((p) => ({
      ...p, status: 'dismissed', dismissedAt: now(), dismissId, reason: 'user:dismiss', updatedAt: now(),
    }))
    await appendLog(dataRoot, personaId, 'pending', rows)

    const generation = manifest.generation + 1
    const counts = await computeCounts(dataRoot, personaId, root.chunks)
    const nextManifest = await writeManifest(dataRoot, personaId, { ...manifest, generation, counts, lastError: null })

    // 写后读回
    const afterPending = await readPendingMap(dataRoot, personaId)
    const missing = rows.filter((r) => afterPending.map.get(r.pendingId)?.status !== 'dismissed').map((r) => r.pendingId)
    if (missing.length) {
      const err = { code: 'DISMISS_FAILED', message: '写后读回不一致', missing }
      await writeManifest(dataRoot, personaId, { ...nextManifest, lastError: { ...err, at: now() } }).catch(() => {})
      return { ok: false, code: 'DISMISS_FAILED', error: err, dismissId }
    }
    return {
      ok: true, dismissId, dismissed: rows.map((r) => r.pendingId), generation, snapshot: snap.dir, alreadyDismissed: false,
    }
  } catch (e) {
    const error = toErrInfo(e)
    await recordLastError(dataRoot, personaId, error, now)
    return { ok: false, code: e.code || 'DISMISS_FAILED', error, dismissId }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

/** restore：superseded / expired / archived → active；旧记录保留，不物理删 */
export async function restoreChunks(opts) {
  const { dataRoot, personaId, chunkIds = [], now = Date.now } = opts
  if (!Array.isArray(chunkIds) || chunkIds.length === 0) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'chunkIds 为空' } }
  }
  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }
    const root = await readScope(dataRoot, personaId)
    if (!root.ok) return { ok: false, code: root.code, error: root.error }
    const chunkMap = new Map(root.chunks.map((c) => [c.id, c]))
    const stateRead = await readStateMap(dataRoot, personaId)
    const snap = await backupLogs(dataRoot, personaId, 'restore', ['state'])

    const rows = []
    const missing = []
    const skipped = []
    for (const id of chunkIds) {
      const chunk = chunkMap.get(id)
      if (!chunk) { missing.push(id); continue }
      const cur = stateRead.map.get(id)
      if (cur && cur.status === 'active') { skipped.push(id); continue }
      const cls = classify(chunk)
      const base = cur ?? synthActiveState(man.manifest, root.manifest, personaId, chunk, cls)
      rows.push({
        ...base,
        chunkId: id,
        status: 'active',
        validTo: null,
        supersededBy: null,
        reason: 'user:restore',
        source: 'user',
        confidence: 1,
        version: Number(base.version ?? 1) + 1,
        updatedAt: now(),
        generation: String(man.manifest.generation),
        rootBuiltAt: root.manifest?.builtAt ?? null,
        sourceHash: chunk.sourceHash ?? null,
      })
    }
    if (missing.length) {
      return { ok: false, code: 'CHUNK_NOT_FOUND', error: { code: 'CHUNK_NOT_FOUND', message: `根藏里找不到 ${missing.length} 个块`, missing } }
    }
    if (rows.length) {
      await appendLog(dataRoot, personaId, 'state', rows)
      const counts = await computeCounts(dataRoot, personaId, root.chunks)
      await writeManifest(dataRoot, personaId, { ...man.manifest, generation: man.manifest.generation + 1, counts, lastError: null })
      const after = await readStateMap(dataRoot, personaId)
      const bad = rows.filter((r) => after.map.get(r.chunkId)?.status !== 'active').map((r) => r.chunkId)
      if (bad.length) {
        return { ok: false, code: 'READBACK_MISMATCH', error: { code: 'READBACK_MISMATCH', message: 'restore 写后读回不一致', bad } }
      }
    }
    return { ok: true, restored: rows.length, skipped, snapshot: snap.dir, generation: man.manifest.generation + (rows.length ? 1 : 0) }
  } catch (e) {
    return { ok: false, code: e.code || 'RESTORE_FAILED', error: toErrInfo(e) }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

/** 手动标记未解释矛盾：两条都保持 active，只开 conflict；不自动选新 */
export async function addConflict(opts) {
  const { dataRoot, personaId, chunkIds = [], kind = 'unexplained-contradiction', note = '用户手动标记', now = Date.now } = opts
  if (!Array.isArray(chunkIds) || chunkIds.length < 2) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: '未解释矛盾至少需要两个块' } }
  }
  if (!['unexplained-contradiction', 'change', 'correction'].includes(kind)) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: `不支持的冲突类型：${kind}` } }
  }
  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const req = await requireChunks(dataRoot, personaId, chunkIds)
    if (!req.ok) return { ok: false, code: req.code, error: req.error }
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }
    const conflictId = `conflict-${kind}-${hashText(JSON.stringify([kind, [...chunkIds].sort()])).slice(0, 16)}`
    const conflicts = await readConflictsMap(dataRoot, personaId)
    if (conflicts.map.has(conflictId)) {
      return { ok: true, alreadyExists: true, conflictId, status: conflicts.map.get(conflictId).status }
    }
    const snap = await backupLogs(dataRoot, personaId, 'conflict', ['state', 'conflicts'])
    const stateRead = await readStateMap(dataRoot, personaId)
    const stateRows = []
    for (const id of chunkIds) {
      const chunk = req.map.get(id)
      const cur = stateRead.map.get(id)
      const cls = classify(chunk)
      const base = cur ?? synthActiveState(man.manifest, req.root.manifest, personaId, chunk, cls)
      stateRows.push({
        ...base,
        status: base.status, // 不改状态；两条都保持原状态（验收要求都 active）
        conflictGroup: conflictId,
        version: Number(base.version ?? 1) + 1,
        updatedAt: now(),
        generation: String(man.manifest.generation),
        rootBuiltAt: req.root.manifest?.builtAt ?? null,
        sourceHash: chunk.sourceHash ?? base.sourceHash ?? null,
      })
    }
    const conflictRow = {
      conflictId,
      chunkIds,
      kind,
      status: 'open',
      resolution: null,
      createdAt: now(),
      updatedAt: now(),
      note,
      ruleRef: null,
      rootBuiltAt: req.root.manifest?.builtAt ?? null,
    }
    await appendLog(dataRoot, personaId, 'state', stateRows)
    await appendLog(dataRoot, personaId, 'conflicts', [conflictRow])
    const counts = await computeCounts(dataRoot, personaId, req.root.chunks)
    await writeManifest(dataRoot, personaId, { ...man.manifest, generation: man.manifest.generation + 1, counts, lastError: null })
    const after = await readStateMap(dataRoot, personaId)
    const bad = chunkIds.filter((id) => after.map.get(id)?.conflictGroup !== conflictId)
    if (bad.length) {
      return { ok: false, code: 'READBACK_MISMATCH', error: { code: 'READBACK_MISMATCH', message: '冲突标记写后读回不一致', bad } }
    }
    return { ok: true, conflictId, status: 'open', chunkIds, snapshot: snap.dir }
  } catch (e) {
    return { ok: false, code: e.code || 'CONFLICT_FAILED', error: toErrInfo(e) }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

export { applyOneState, synthActiveState }
