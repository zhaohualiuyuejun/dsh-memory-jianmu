/**
 * lib/identitysources.mjs —— sources 从根藏 identity 派生（P4 #11，2026-11-13）
 *
 * 只读 `identity.json`（不写）。规则见 plans/2026-11-13-T2-sources派生-设计.md：
 *   · 手填源优先；同 personaId 手填源直接「补工作区」，id 不变（自带索引/根藏路由都不变）；
 *   · 只有全新人格才新建 `persona:<pid>`；
 *   · 手填与 identity 冲突 → 保留手填 + warning，不静默改；
 *   · identity 不可读/为空 → 原样返回手填源（调用方行为与开关关逐字一致）。
 *
 * 纯读、零网络。工作区绝对路径用 workspace.mjs 的编码器转成 DSH 会话目录名。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeVariants, normPath } from './workspace.mjs'

const PID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const UNSAFE = 'persona_unassigned'

const clone = (s) => ({
  id: String(s.id || ''),
  name: String(s.name || ''),
  workspaces: Array.isArray(s.workspaces) ? s.workspaces.slice() : [],
  personaId: s.personaId ? String(s.personaId) : null,
})

/** 绝对路径 → 会话目录名变体（去重、过滤空） */
function variantsOf(absPath) {
  const p = String(absPath || '').trim()
  if (!/^[A-Za-z]:[\\/]/.test(p)) return []
  try { return encodeVariants(p) } catch { return [] }
}

/**
 * @param {object} o
 * @param {object} o.identity identity.json 内容（可能为空对象）
 * @param {Array}  o.manual   parseSources() 结果
 * @returns {{sources:Array, derived:Array, warnings:Array, reasoning:object}}
 */
export function buildSourcesFromIdentity({ identity, manual = [] } = {}) {
  const manualSources = (Array.isArray(manual) ? manual : []).map(clone)
  const warnings = []
  const ident = identity && typeof identity === 'object' ? identity : {}
  const personas = (ident.personas && typeof ident.personas === 'object') ? ident.personas : {}
  const wsMap = (ident.workspaces && typeof ident.workspaces === 'object') ? ident.workspaces : {}

  const noIdentity = {
    ok: false,
    sources: manualSources, derived: [], warnings,
    reasoning: { ok: false, reason: 'identity_empty' },
  }
  if (!Object.keys(wsMap).length) return noIdentity

  // ── 1. identity 工作区 → { pid, absPath, variants } ──────────────────────
  const rows = []
  for (const [absPath, pidRaw] of Object.entries(wsMap)) {
    const pid = String(pidRaw || '').trim()
    if (!pid || pid === UNSAFE || !PID_RE.test(pid)) {
      warnings.push({ code: 'IDENTITY_PERSONA_INVALID', workspace: absPath, personaId: pid || null })
      continue
    }
    const variants = variantsOf(absPath)
    if (!variants.length) {
      warnings.push({ code: 'WORKSPACE_UNENCODABLE', workspace: absPath, personaId: pid })
      continue
    }
    rows.push({ absPath, pid, variants, key: normPath(absPath) })
  }
  if (!rows.length) return noIdentity

  // ── 2. 手填源归属表（目录名精确匹配；先到先得）───────────────────────────
  const manualOwner = new Map() // dirName → source
  for (const s of manualSources) for (const w of s.workspaces) if (!manualOwner.has(w)) manualOwner.set(w, s)

  // ── 3. 手填源缺 personaId 时，用 identity 反推（唯一才补）────────────────
  const dirToPids = new Map()
  for (const r of rows) for (const v of r.variants) {
    if (!dirToPids.has(v)) dirToPids.set(v, new Set())
    dirToPids.get(v).add(r.pid)
  }
  for (const s of manualSources) {
    if (s.personaId) continue
    const pids = new Set()
    for (const w of s.workspaces) for (const pid of (dirToPids.get(w) || [])) pids.add(pid)
    if (pids.size === 1) {
      s.personaId = [...pids][0]
      warnings.push({ code: 'PERSONA_ID_INFERRED', sourceId: s.id, personaId: s.personaId })
    }
  }

  // ── 4. 冲突检查（手填说 A、identity 说 B）→ 保留手填 + warning ───────────
  const seenWarn = new Set()
  for (const r of rows) {
    for (const v of r.variants) {
      const owner = manualOwner.get(v)
      if (!owner) continue
      if (owner.personaId && owner.personaId !== r.pid) {
        const k = `${r.absPath}|${owner.id}|${r.pid}`
        if (seenWarn.has(k)) continue
        seenWarn.add(k)
        warnings.push({
          code: 'WORKSPACE_CONFLICT', workspace: r.absPath, dir: v,
          sourceId: owner.id, manualPersonaId: owner.personaId, identityPersonaId: r.pid,
          kept: 'manual',
        })
      }
    }
  }
  const manualPersona = new Map() // pid → manual source（同人格合并用）
  for (const s of manualSources) if (s.personaId && !manualPersona.has(s.personaId)) manualPersona.set(s.personaId, s)

  // ── 5. 派生：未归属的 identity 工作区，按 pid 归组 ───────────────────────
  const byPid = new Map()
  for (const r of rows) {
    const taken = r.variants.some((v) => manualOwner.has(v))
    if (taken) continue
    const cur = byPid.get(r.pid) || { pid: r.pid, rows: [], dirs: [] }
    cur.rows.push(r)
    for (const v of r.variants) if (!cur.dirs.includes(v)) cur.dirs.push(v)
    byPid.set(r.pid, cur)
  }

  const order = []
  for (const pid of Object.keys(personas)) if (byPid.has(pid)) order.push(pid)
  for (const pid of byPid.keys()) if (!order.includes(pid)) order.push(pid)

  const derived = []
  for (const pid of order) {
    const g = byPid.get(pid)
    if (!g?.dirs.length) continue
    const displayName = String(personas[pid]?.displayName || personas[pid]?.name || pid)
    const existing = manualPersona.get(pid)
    if (existing) {
      // 同人格：补进手填源，id 不变
      for (const d of g.dirs) if (!existing.workspaces.includes(d)) existing.workspaces.push(d)
      derived.push({ id: existing.id, name: existing.name || displayName, personaId: pid, workspaces: g.dirs.slice(), attachedTo: existing.id })
      continue
    }
    const id = `persona:${pid}`
    const src = { id, name: displayName, workspaces: g.dirs.slice(), personaId: pid }
    manualSources.push(src)
    derived.push({ ...src, attachedTo: null })
    manualPersona.set(pid, src)
  }

  return {
    ok: true,
    sources: manualSources,
    derived,
    warnings,
    reasoning: {
      ok: true,
      identities: rows.length,
      personaCount: new Set(rows.map((r) => r.pid)).size,
      derivedSources: derived.length,
    },
  }
}

/**
 * 读根藏 identity 并派生。任何失败都回退手填源（不抛）。
 * @param {object} o
 * @param {string} o.rootDir
 * @param {Array}  o.manual
 */
export function loadIdentitySources({ rootDir, manual = [] } = {}) {
  const dir = String(rootDir || '').trim()
  if (!dir) return { ok: false, sources: manual, derived: [], warnings: [], reason: 'root_disabled', file: null }
  const file = join(dir, 'identity.json')
  let identity
  try { identity = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    const reason = e?.code === 'ENOENT' ? 'identity_missing' : 'identity_unreadable'
    return { ok: false, sources: manual, derived: [], warnings: [], reason, file }
  }
  const r = buildSourcesFromIdentity({ identity, manual })
  if (!r.reasoning.ok) return { ok: false, sources: manual, derived: [], warnings: r.warnings, reason: r.reasoning.reason, file }
  return { ...r, file }
}
