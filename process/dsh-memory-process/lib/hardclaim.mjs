/**
 * lib/hardclaim.mjs —— 硬认领（熏习侧）：把 state 行从源人格搬到目标人格。
 *
 * 只搬「当前有效状态」（latest-wins 的每组最新一行），不改原文、不重嵌、不调 LLM。
 * duplicates / pending 里引用被搬块的行**不逐行改**，而是追加一条 status=stale 的最新行
 * （latest-wins 自然隐藏旧候选），随后尽力对两边 rebuild（用户态存在时 rebuild 会拒绝，
 * 如实返回 REBUILD_USER_STATE_PRESENT，不静默丢用户决定）。
 *
 * 写边界：只写 <dataRoot>/process/<from|to>/；备份放源人格的 _archive/hard-claim-<tag>/。
 */
import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  PERSONA_UNASSIGNED, PROCESS_FILES, assertProcessWrite, isSafePersonaId, processDir, processFile,
} from './paths.mjs'
import {
  ensureDir, fileSize, hashFile, pathExists, readJson, readJsonl, writeJsonAtomic, atomicWrite,
} from './fsatomic.mjs'
import { acquireLock } from './lock.mjs'
import { ensureManifest, readManifest, readStateMap, writeManifest, computeCounts } from './store.mjs'
import { readScope } from './root.mjs'
import { rebuildProcess } from './rebuild.mjs'
import { fail, toErrInfo } from './errors.mjs'

export const HARD_CLAIM_ARCHIVE_PREFIX = 'hard-claim'
const BACKUP_KEYS = ['state', 'duplicates', 'pending', 'conflicts', 'topics', 'topicMembers']
const FILE_NAMES = [...new Set(BACKUP_KEYS.map((k) => PROCESS_FILES[k]).concat([PROCESS_FILES.manifest]))]

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 读某个 process scope 的当前状态（latest-wins） */
async function currentStates(dataRoot, pid) {
  const r = await readStateMap(dataRoot, pid)
  return { rows: r.rows, map: r.map, exists: r.exists, corrupt: r.corrupt || [], tornTail: Boolean(r.tornTail) }
}

/** 引用被搬块的候选行数（只读，预览用） */
function countTouched(rows, idSet) {
  let touched = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const ids = []
    if (Array.isArray(row.chunkIds)) ids.push(...row.chunkIds)
    if (row.chunkId) ids.push(row.chunkId)
    if (row.proposed?.chunkId) ids.push(row.proposed.chunkId)
    if (row.proposed?.supersededBy) ids.push(row.proposed.supersededBy)
    if (ids.some((id) => idSet.has(id))) touched++
  }
  return touched
}

/** 预览（零写入） */
export async function previewMoveState({ dataRoot, from = PERSONA_UNASSIGNED, to, chunkIds = [] } = {}) {
  const root = resolve(dataRoot)
  if (!isSafePersonaId(to)) return fail('BAD_PERSONA_ID', `to 非法：${JSON.stringify(to)}`)
  const ids = new Set((chunkIds || []).map(String))
  if (!ids.size) return { ok: true, stateRows: 0, duplicatesTouched: 0, pendingTouched: 0, backupEstBytes: 0, note: '没有要搬的块' }
  const src = await currentStates(root, from)
  if (src.corrupt.length) return fail('JSONL_CORRUPT', `源 state.jsonl 有 ${src.corrupt.length} 个坏行，拒绝搬迁`)
  const stateRows = [...src.map.values()].filter((s) => ids.has(String(s.chunkId))).length
  const [dup, pend] = await Promise.all([
    readJsonl(processFile(root, from, 'duplicates')),
    readJsonl(processFile(root, from, 'pending')),
  ])
  const duplicatesTouched = countTouched(dup.rows, ids)
  const pendingTouched = countTouched(pend.rows, ids)
  let backupEstBytes = 0
  for (const pid of [from, to]) {
    for (const name of FILE_NAMES) backupEstBytes += Math.max(0, await fileSize(join(processDir(root, pid), name)))
  }
  return {
    ok: true,
    dryRun: true,
    personaId: from,
    target: to,
    stateRows,
    duplicatesTouched,
    pendingTouched,
    backupEstBytes,
  }
}

/** 备份两个 process scope 的相关日志；journal 放源人格的 _archive/hard-claim-<tag>/ */
async function backupProcessScopes(root, from, to, tag) {
  const base = join(processDir(root, from), '_archive', `${HARD_CLAIM_ARCHIVE_PREFIX}-${tag}`)
  const filesDir = join(base, 'files')
  await ensureDir(filesDir)
  const files = []
  const scopeExisted = {}
  for (const pid of [from, to]) {
    const dir = processDir(root, pid)
    try { scopeExisted[pid] = (await stat(dir)).isDirectory() } catch { scopeExisted[pid] = false }
    for (const name of FILE_NAMES) {
      const src = join(dir, name)
      if (!(await pathExists(src))) continue
      const rel = join(pid, name)
      const dest = join(filesDir, rel)
      await ensureDir(dirname(dest))
      await copyFile(src, dest)
      const st = await stat(dest)
      files.push({ pid, name, rel: rel.replace(/\\/g, '/'), bytes: st.size, sha256: await hashFile(dest) })
    }
  }
  const journal = {
    version: 1, kind: 'process-hard-claim-backup', createdAt: new Date().toISOString(),
    dataRoot: root, from, to, tag, backupDir: base, filesDir, scopeExisted, files,
  }
  await writeJsonAtomic(join(base, 'process-journal.json'), journal)
  return { ok: true, dir: base, files, journal, sizeBytes: files.reduce((a, f) => a + f.bytes, 0) }
}

/** 追加 stale 标记（latest-wins 隐藏旧候选；不重写旧行） */
async function markStale(root, pid, key, idKey, idSet, reason, now) {
  const file = processFile(root, pid, key)
  const r = await readJsonl(file)
  const latest = new Map()
  for (const row of r.rows) {
    const id = row?.[idKey]
    if (id == null) continue
    latest.set(id, row)
  }
  const staleRows = []
  for (const row of latest.values()) {
    const ids = []
    if (Array.isArray(row.chunkIds)) ids.push(...row.chunkIds)
    if (row.chunkId) ids.push(row.chunkId)
    if (row.proposed?.chunkId) ids.push(row.proposed.chunkId)
    if (row.proposed?.supersededBy) ids.push(row.proposed.supersededBy)
    if (!ids.some((id) => idSet.has(id))) continue
    if (row.status === 'stale') continue
    staleRows.push({ ...row, status: 'stale', staleReason: reason, updatedAt: now })
  }
  if (!staleRows.length) return { ok: true, marked: 0 }
  const body = staleRows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  const prev = r.exists ? await readFileText(file) : ''
  await atomicWrite(file, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + body)
  return { ok: true, marked: staleRows.length }
}

async function readFileText(file) {
  try { return await readFile(file, 'utf8') } catch { return '' }
}

/**
 * 真搬 state。confirm=true。
 * @returns {Promise<object>}
 */
export async function moveState({
  dataRoot, from = PERSONA_UNASSIGNED, to, chunkIds = [], confirm = false, tag = stamp(), lockTimeoutMs = 10000,
} = {}) {
  if (confirm !== true) return fail('CONFIRM_REQUIRED', '搬 state 会重写状态日志：必须 confirm=true')
  const root = resolve(dataRoot)
  if (!isSafePersonaId(to)) return fail('BAD_PERSONA_ID', `to 非法：${JSON.stringify(to)}`)
  const ids = new Set((chunkIds || []).map(String))
  if (!ids.size) return { ok: true, noop: true, reason: 'NO_CHUNKS', moved: 0 }

  const src0 = await currentStates(root, from)
  const moved0 = [...src0.map.values()].filter((s) => ids.has(String(s.chunkId)))
  if (!moved0.length) {
    return { ok: true, noop: true, reason: 'NO_STATE_ROWS', moved: 0, note: '源人格没有这些块的 state（可能还没跑过熏习）' }
  }

  const backup = await backupProcessScopes(root, from, to, tag)
  const locks = []
  try {
    const dirs = [processDir(root, from), processDir(root, to)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    for (const dir of dirs) {
      const lock = await acquireLock(dir, { timeoutMs: lockTimeoutMs })
      if (!lock.ok) return fail(lock.code || 'LOCK_BUSY', `熏习取锁失败（${dir}）：${lock.error?.message || ''}；本次未写`, lock.error || null)
      locks.push(lock)
    }

    // 锁内重读
    const src = await currentStates(root, from)
    const moved = [...src.map.values()].filter((s) => ids.has(String(s.chunkId)))
    if (!moved.length) return { ok: true, noop: true, reason: 'NO_STATE_ROWS_AFTER_LOCK', moved: 0 }

    const now = Date.now()
    // 源：去掉这些 chunkId 的全部 state 行
    const keptRows = src.rows.filter((r) => !ids.has(String(r.chunkId)))
    await atomicWrite(processFile(root, from, 'state'), keptRows.map((r) => JSON.stringify(r)).join('\n') + (keptRows.length ? '\n' : ''))

    // 目标：确保 layout/manifest，再追加（scope 改写）
    const ensured = await ensureManifest(root, to)
    if (!ensured.ok) return fail(ensured.code || 'MANIFEST_INVALID', `目标熏习 manifest 不可用：${ensured.error?.message || ''}`)
    const tgt = await currentStates(root, to)
    const tgtIds = new Set([...tgt.map.keys()].map(String))
    const append = []
    let skipped = 0
    for (const row of moved) {
      if (tgtIds.has(String(row.chunkId))) { skipped++; continue }
      append.push({ ...row, scope: to, hardClaimFrom: from, updatedAt: Math.max(Number(row.updatedAt) || 0, now) })
      tgtIds.add(String(row.chunkId))
    }
    if (append.length) {
      const body = (await readFileText(processFile(root, to, 'state'))) || ''
      await atomicWrite(processFile(root, to, 'state'), body + (body && !body.endsWith('\n') ? '\n' : '') + append.map((r) => JSON.stringify(r)).join('\n') + '\n')
    }

    // duplicates / pending：追加 stale（不逐行改）
    const reason = `hard-claim-to:${to}`
    const staleDup = await markStale(root, from, 'duplicates', 'groupId', ids, reason, now)
    const stalePend = await markStale(root, from, 'pending', 'pendingId', ids, reason, now)

    // manifest 计数：从根藏当前块数 + 日志重算（rebuild 会再精算）
    const countsOf = async (pid) => {
      const sc = await readScope(root, pid)
      const counts = await computeCounts(root, pid, sc.ok ? sc.chunks : null)
      const man = await readManifest(root, pid)
      if (man.ok) {
        await writeManifest(root, pid, {
          ...man.manifest,
          counts: { ...(man.manifest.counts || {}), ...counts },
          generation: (Number(man.manifest.generation) || 0) + 1,
        })
      }
      return counts
    }
    const srcCounts = await countsOf(from)
    const tgtCounts = await countsOf(to)

    return {
      ok: true,
      moved: append.length,
      skipped,
      stale: { duplicates: staleDup.marked, pending: stalePend.marked },
      source: { states: srcCounts.states, chunks: srcCounts.chunks, generation: (await readManifest(root, from)).manifest?.generation ?? null },
      target: { states: tgtCounts.states, chunks: tgtCounts.chunks, generation: (await readManifest(root, to)).manifest?.generation ?? null },
      backupDir: backup.dir,
      backupBytes: backup.sizeBytes,
      movedIds: moved.map((r) => r.chunkId),
    }
  } catch (e) {
    return { ok: false, code: e?.code || 'PROCESS_MOVE_FAILED', error: toErrInfo(e), backupDir: backup.dir }
  } finally {
    for (const l of locks.reverse()) { try { await l.release?.() } catch { /* 忽略 */ } }
  }
}

/**
 * 搬迁后重建两边状态（尽力；用户态存在 → 如实拒绝，不丢用户决定）。
 * 在 moveState 释放锁之后调用（rebuild 自己会取锁）。
 */
export async function rebuildAfterMove({ dataRoot, from = PERSONA_UNASSIGNED, to } = {}) {
  const root = resolve(dataRoot)
  const out = {}
  for (const pid of [from, to]) {
    try {
      const man = await readManifest(root, pid)
      if (!man.ok) { out[pid] = { ok: false, skipped: true, code: man.code || 'MANIFEST_MISSING' }; continue }
      out[pid] = await rebuildProcess({ dataRoot: root, personaId: pid, confirm: true })
    } catch (e) {
      out[pid] = { ok: false, code: e?.code || 'REBUILD_FAILED', error: toErrInfo(e) }
    }
  }
  return out
}

/** 回滚：整文件恢复（journal 在 backupDir/process-journal.json） */
export async function rollbackMoveState({ dataRoot, backupDir } = {}) {
  const root = resolve(dataRoot)
  const jr = await readJson(join(backupDir, 'process-journal.json'))
  if (!jr.ok) return fail('BACKUP_NOT_FOUND', `读不到熏习备份 journal：${join(backupDir, 'process-journal.json')}`)
  const j = jr.value
  const filesDir = j.filesDir || join(backupDir, 'files')
  const restored = []
  const problems = []
  for (const f of j.files || []) {
    try {
      const buf = await readFile(join(filesDir, f.rel))
      const dest = processFile(root, f.pid, Object.keys(PROCESS_FILES).find((k) => PROCESS_FILES[k] === f.name))
      assertProcessWrite(root, f.pid, dest)
      await atomicWrite(dest, buf)
      const h = await hashFile(dest)
      if (h !== f.sha256) problems.push({ pid: f.pid, name: f.name, expected: f.sha256, got: h })
      else restored.push(`${f.pid}/${f.name}`)
    } catch (e) {
      problems.push({ pid: f.pid, name: f.name, error: toErrInfo(e) })
    }
  }
  const created = []
  for (const pid of [j.from, j.to]) {
    if (j.scopeExisted?.[pid]) continue
    const dir = processDir(root, pid)
    let ents = []
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isFile() || !FILE_NAMES.includes(e.name)) continue
      try { await rm(join(dir, e.name), { force: true }); created.push(`${pid}/${e.name}`) } catch { /* 忽略 */ }
    }
  }
  return { ok: problems.length === 0, backupDir, restored, createdRemoved: created, problems }
}
