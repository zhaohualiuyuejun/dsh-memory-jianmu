/**
 * lib/identity-admin.mjs —— identity.json 的**受控写**（P4 #5，2026-11-12）
 *
 * 背景：建木有三份人格映射，用户只在镜台建卡只写了第 1 份；根藏这份一直只有
 * 一次性 CLI（init-identity）会写，导致「建了卡却没记忆」。这里补上运行时写入，
 * 但纪律比 CLI 更严：
 *   · 默认只预览（dryRun）；confirm=true 才落盘；
 *   · 写前先备份到 <dataRoot>/_archive/identity-<ts>-<rand>.json；
 *   · 只增不删：新增人格 / 新增映射；工作区已属于别人 → 默认拒绝，allowReassign=true 才改；
 *   · 幂等：值没变化就不写、不占备份；
 *   · 写后读回校验；不一致就还原备份（没有备份 = 刚新建的文件，删掉）；
 *   · identity.json 损坏/非法 → 直接拒绝，绝不覆盖（fail-closed）。
 *
 * 明确的边界：**不碰 scopes/、year/、process/、persona/**，不迁移任何记忆。
 * 「停记」只摘映射（不删数据）；「彻底删除」不在本模块（属破坏性动作，另做）。
 */
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireLock } from './lock.mjs'
import { loadIdentity, validateIdentity, writeIdentity } from './identity.mjs'
import { identityPath, isSafePersonaId, PERSONA_UNASSIGNED } from './paths.mjs'

const DISPLAY_NAME_MAX = 80

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function fileExists(file) {
  try { await stat(file); return true } catch { return false }
}

async function backupIdentity(dataRoot, file) {
  if (!(await fileExists(file))) return null
  const dir = join(dataRoot, '_archive')
  await mkdir(dir, { recursive: true })
  const dest = join(dir, `identity-${stamp()}-${randomUUID().slice(0, 6)}.json`)
  await copyFile(file, dest)
  return dest
}

function emptyIdentity() {
  return { version: 1, defaultPersonaId: null, personas: {}, workspaces: {}, sessions: {} }
}

/** 归一化 + 校验入参；返回 {ok, ...} 或 {ok:false, code, error} */
function normalizeArgs({ personaId, displayName, workspaces, sessions }) {
  const pid = String(personaId ?? '').trim()
  if (!isSafePersonaId(pid) || pid === PERSONA_UNASSIGNED) {
    return { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法或不可用：${pid || '(空)'}（只允许小写字母/数字/_/-，且不能是 persona_unassigned）` } }
  }
  const name = String(displayName ?? '').trim() || pid
  if (name.length > DISPLAY_NAME_MAX) {
    return { ok: false, code: 'BAD_DISPLAY_NAME', error: { code: 'BAD_DISPLAY_NAME', message: `显示名太长（${name.length} > ${DISPLAY_NAME_MAX}）` } }
  }
  const wsList = Array.isArray(workspaces) ? workspaces.map((s) => String(s ?? '').trim()).filter(Boolean) : []
  const sesList = Array.isArray(sessions) ? sessions.map((s) => String(s ?? '').trim()).filter(Boolean) : []
  if (wsList.length > 200 || sesList.length > 200) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: '一次最多登记 200 个工作区 / 200 个会话' } }
  }
  return { ok: true, personaId: pid, displayName: name, workspaces: [...new Set(wsList)], sessions: [...new Set(sesList)] }
}

/**
 * 新增人格 + 工作区/会话映射。
 * @returns 预览（dryRun/未 confirm）或写入结果
 */
export async function identityAddPersona({
  dataRoot,
  personaId,
  displayName = '',
  workspaces = [],
  sessions = [],
  updateDisplayName = true,
  allowReassign = false,
  dryRun = true,
  confirm = false,
} = {}) {
  const a = normalizeArgs({ personaId, displayName, workspaces, sessions })
  if (!a.ok) return a
  const file = identityPath(dataRoot)
  const cur = await loadIdentity(dataRoot)
  let base = null
  let created = false
  if (cur.ok) base = JSON.parse(JSON.stringify(cur.identity))
  else if (cur.reason === 'identity_missing') { base = emptyIdentity(); created = true }
  else {
    return {
      ok: false, code: 'IDENTITY_UNREADABLE',
      error: { code: 'IDENTITY_UNREADABLE', message: `identity.json 读不出来/结构非法（${cur.reason || cur.error?.code || 'unknown'}）：拒绝覆盖，请先修好它`, detail: cur.error || null },
      file,
    }
  }

  const changes = {
    personasAdded: [], personasUpdated: [], workspacesAdded: [], workspacesReassigned: [],
    sessionsAdded: [], sessionsReassigned: [],
  }
  const warnings = []
  /** 因「已属于别人」被跳过的项（调用方据此报 WORKSPACE_TAKEN，而不是当成 noop） */
  const skipped = []

  const existing = base.personas?.[a.personaId]
  if (!existing) {
    base.personas[a.personaId] = { displayName: a.displayName }
    changes.personasAdded.push(a.personaId)
  } else if (updateDisplayName && existing.displayName !== a.displayName) {
    changes.personasUpdated.push({ personaId: a.personaId, from: existing.displayName ?? null, to: a.displayName })
    base.personas[a.personaId] = { ...existing, displayName: a.displayName }
  }

  for (const ws of a.workspaces) {
    const prev = base.workspaces?.[ws]
    if (prev === a.personaId) continue
    if (prev && prev !== a.personaId && !allowReassign) {
      warnings.push(`工作区「${ws}」已属于人格 ${prev}，本次跳过（要改归属请显式 allowReassign=true）`)
      skipped.push({ kind: 'workspace', key: ws, owner: prev })
      continue
    }
    base.workspaces[ws] = a.personaId
    if (prev) changes.workspacesReassigned.push({ workspace: ws, from: prev, to: a.personaId })
    else changes.workspacesAdded.push(ws)
  }
  for (const sid of a.sessions) {
    const prev = base.sessions?.[sid]
    if (prev === a.personaId) continue
    if (prev && prev !== a.personaId && !allowReassign) {
      warnings.push(`会话「${sid}」已属于人格 ${prev}，本次跳过（要改归属请显式 allowReassign=true）`)
      skipped.push({ kind: 'session', key: sid, owner: prev })
      continue
    }
    base.sessions[sid] = a.personaId
    if (prev) changes.sessionsReassigned.push({ session: sid, from: prev, to: a.personaId })
    else changes.sessionsAdded.push(sid)
  }

  const changed = changes.personasAdded.length || changes.personasUpdated.length
    || changes.workspacesAdded.length || changes.workspacesReassigned.length
    || changes.sessionsAdded.length || changes.sessionsReassigned.length

  const errs = validateIdentity(base)
  if (errs.length) {
    return { ok: false, code: 'IDENTITY_INVALID', error: { code: 'IDENTITY_INVALID', message: `写入后 identity 会非法：${errs.join('；')}` }, changes, warnings, file }
  }

  const previewBase = {
    ok: true, file, created, changes, warnings, skipped,
    before: { personas: Object.keys(cur.ok ? cur.identity.personas || {} : {}), workspaces: Object.keys(cur.ok ? cur.identity.workspaces || {} : {}).length },
    after: { personas: Object.keys(base.personas || {}), workspaces: Object.keys(base.workspaces || {}).length, sessions: Object.keys(base.sessions || {}).length },
  }
  if (!changed) return { ...previewBase, ok: true, noop: true, written: false, note: '已经是这个状态，无需写入' }
  if (dryRun !== false || confirm !== true) {
    return { ...previewBase, ok: true, preview: true, written: false, note: '预览：传 confirm=true（并 dryRun=false）才会真正写 identity.json' }
  }

  // ── 真写：锁 → 备份 → 原子写 → 读回 ──────────────────────────────────────
  const lock = await acquireLock(dataRoot, { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error, file }
  let backup = null
  try {
    // 锁内重读一次，避免预览与写入之间的并发改动被静默覆盖
    const again = await loadIdentity(dataRoot)
    if (!again.ok && again.reason !== 'identity_missing') {
      return { ok: false, code: 'IDENTITY_UNREADABLE', error: again.error || { code: 'IDENTITY_UNREADABLE', message: again.reason }, file }
    }
    const drift = JSON.stringify(again.ok ? again.identity : emptyIdentity()) !== JSON.stringify(cur.ok ? cur.identity : emptyIdentity())
    if (drift) {
      return {
        ok: false, code: 'IDENTITY_CHANGED',
        error: { code: 'IDENTITY_CHANGED', message: '预览之后 identity.json 被别人改过；请重新预览再写（不覆盖并发改动）' },
        file,
      }
    }
    backup = await backupIdentity(dataRoot, file)
    await writeIdentity(dataRoot, base)
    const check = await loadIdentity(dataRoot)
    const expectOk = check.ok
      && Boolean(check.identity.personas?.[a.personaId])
      && a.workspaces.every((ws) => !base.workspaces?.[ws] || check.identity.workspaces?.[ws] === base.workspaces[ws])
      && a.sessions.every((sid) => !base.sessions?.[sid] || check.identity.sessions?.[sid] === base.sessions[sid])
    if (!expectOk) {
      // 读回不一致：还原备份；没有备份说明是刚新建的文件，删掉
      if (backup) await copyFile(backup, file).catch(() => {})
      else await unlink(file).catch(() => {})
      return { ok: false, code: 'READBACK_MISMATCH', error: { code: 'READBACK_MISMATCH', message: '写入后读回不一致，已还原备份', readback: check } , file, backup }
    }
    return { ...previewBase, ok: true, written: true, preview: false, backup, readback: { ok: true } }
  } catch (e) {
    return { ok: false, code: e?.code || 'WRITE_FAILED', error: { code: e?.code || 'WRITE_FAILED', message: String(e?.message || e) }, file, backup }
  } finally {
    try { await lock.release?.() } catch { /* 忽略 */ }
  }
}

/**
 * 摘掉指向某人格的映射（「停记」用；只摘映射，**不删任何记忆**）。
 * 只删 value === personaId 的条目；属于别人的人格条目一律不动。
 */
export async function identityRemoveMappings({
  dataRoot,
  personaId,
  workspaces = [],
  sessions = [],
  dryRun = true,
  confirm = false,
} = {}) {
  const pid = String(personaId ?? '').trim()
  if (!isSafePersonaId(pid) || pid === PERSONA_UNASSIGNED) {
    return { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法：${pid || '(空)'}` } }
  }
  const wsList = Array.isArray(workspaces) ? workspaces.map((s) => String(s ?? '').trim()).filter(Boolean) : []
  const sesList = Array.isArray(sessions) ? sessions.map((s) => String(s ?? '').trim()).filter(Boolean) : []
  if (!wsList.length && !sesList.length) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: '至少给一个 workspaces 或 sessions（不提供“一键摘掉该人格所有映射”）' } }
  }
  const cur = await loadIdentity(dataRoot)
  if (!cur.ok) {
    return { ok: false, code: 'IDENTITY_UNREADABLE', error: { code: 'IDENTITY_UNREADABLE', message: `identity.json 不可读（${cur.reason || 'unknown'}）：不写` }, file: identityPath(dataRoot) }
  }
  const base = JSON.parse(JSON.stringify(cur.identity))
  const removed = { workspaces: [], sessions: [], skipped: [] }
  for (const ws of wsList) {
    if (base.workspaces?.[ws] === pid) { delete base.workspaces[ws]; removed.workspaces.push(ws) }
    else removed.skipped.push({ workspace: ws, reason: base.workspaces?.[ws] ? `属于 ${base.workspaces[ws]}` : '本来就没映射' })
  }
  for (const sid of sesList) {
    if (base.sessions?.[sid] === pid) { delete base.sessions[sid]; removed.sessions.push(sid) }
    else removed.skipped.push({ session: sid, reason: base.sessions?.[sid] ? `属于 ${base.sessions[sid]}` : '本来就没映射' })
  }
  const changed = removed.workspaces.length + removed.sessions.length
  const previewBase = { ok: true, file: cur.file, removed, before: { workspaces: Object.keys(cur.identity.workspaces || {}).length }, after: { workspaces: Object.keys(base.workspaces || {}).length } }
  if (!changed) return { ...previewBase, noop: true, written: false }
  if (dryRun !== false || confirm !== true) return { ...previewBase, preview: true, written: false }

  const lock = await acquireLock(dataRoot, { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  let backup = null
  try {
    backup = await backupIdentity(dataRoot, cur.file)
    await writeIdentity(dataRoot, base)
    const check = await loadIdentity(dataRoot)
    const ok = check.ok
      && removed.workspaces.every((ws) => check.identity.workspaces?.[ws] === undefined)
      && removed.sessions.every((sid) => check.identity.sessions?.[sid] === undefined)
    if (!ok) {
      if (backup) await copyFile(backup, cur.file).catch(() => {})
      return { ok: false, code: 'READBACK_MISMATCH', error: { code: 'READBACK_MISMATCH', message: '读回不一致，已还原备份' }, backup }
    }
    return { ...previewBase, written: true, preview: false, backup }
  } catch (e) {
    if (backup) await copyFile(backup, cur.file).catch(() => {})
    return { ok: false, code: e?.code || 'WRITE_FAILED', error: { code: e?.code || 'WRITE_FAILED', message: String(e?.message || e) }, backup }
  } finally {
    try { await lock.release?.() } catch { /* 忽略 */ }
  }
}

/** 只读：identity 摘要（服务用） */
export async function identitySummary(dataRoot) {
  const cur = await loadIdentity(dataRoot)
  if (!cur.ok) return { ok: false, reason: cur.reason || 'unreadable', file: cur.file, error: cur.error || null }
  return {
    ok: true,
    file: cur.file,
    personas: Object.entries(cur.identity.personas || {}).map(([id, v]) => ({ personaId: id, displayName: v.displayName ?? id })),
    workspaces: Object.keys(cur.identity.workspaces || {}).length,
    sessions: Object.keys(cur.identity.sessions || {}).length,
    defaultPersonaId: cur.identity.defaultPersonaId ?? null,
  }
}
