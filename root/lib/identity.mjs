/**
 * lib/identity.mjs —— identity.json 读取 + 人格解析（契约 2.4 / F17）
 *
 * 解析顺序（本实现冻结）：
 *   1. 会话显式覆盖（identity.sessions[session]）      → identitySource: 'session'
 *   2. 调用方人工指定（args.personaId）                 → identitySource: 'manual'
 *   3. 工作区最长前缀（identity.workspaces）            → identitySource: 'workspace'
 *   4. 显式默认（identity.defaultPersonaId ≠ null）     → identitySource: 'default'
 *   5. 其余                                            → persona_unassigned / 'unassigned'
 *
 * fail-closed：未归属绝不静默归入具名人格；identity.json 缺失/损坏 → degraded + 报警原因。
 * 根藏**不写** identity.json（只有 CLI 的 bootstrap 命令会写，属于人格解析层职责的临时替代）。
 */
import { isSafePersonaId, PERSONA_UNASSIGNED, identityPath, normPath, isInsideSessions } from './paths.mjs'
import { readJson, atomicWrite } from './fsatomic.mjs'
import { CODES } from './errors.mjs'

export const IDENTITY_SOURCES = Object.freeze(['session', 'workspace', 'default', 'manual', 'unassigned'])

/** 校验 identity 结构；返回错误数组（空 = ok） */
export function validateIdentity(identity) {
  const errs = []
  if (!identity || typeof identity !== 'object') return ['identity 不是对象']
  if (identity.version !== 1) errs.push(`version 必须是 1（读到 ${JSON.stringify(identity.version)}）`)
  const personas = identity.personas
  if (!personas || typeof personas !== 'object') errs.push('缺少 personas')
  else {
    for (const [id, v] of Object.entries(personas)) {
      if (!isSafePersonaId(id)) errs.push(`personas 键不是合法 slug：${id}`)
      if (!v || typeof v.displayName !== 'string') errs.push(`personas.${id}.displayName 必须是字符串`)
    }
  }
  if (identity.defaultPersonaId !== null && identity.defaultPersonaId !== undefined) {
    if (!isSafePersonaId(identity.defaultPersonaId)) errs.push('defaultPersonaId 不是合法 slug')
    else if (!personas?.[identity.defaultPersonaId]) errs.push('defaultPersonaId 不在 personas 里')
  }
  for (const [ws, pid] of Object.entries(identity.workspaces || {})) {
    if (!isSafePersonaId(pid)) errs.push(`workspaces["${ws}"] 不是合法 personaId：${pid}`)
    else if (!personas?.[pid]) errs.push(`workspaces["${ws}"] 指向未声明的人格：${pid}`)
  }
  for (const [sid, pid] of Object.entries(identity.sessions || {})) {
    if (!isSafePersonaId(pid)) errs.push(`sessions["${sid}"] 不是合法 personaId：${pid}`)
    else if (!personas?.[pid]) errs.push(`sessions["${sid}"] 指向未声明的人格：${pid}`)
  }
  return errs
}

/**
 * 读 identity.json（只读）。
 * @returns {{ok:true, identity:object, file:string}|{ok:false, degraded:true, reason:string, file:string, error?:object}}
 */
export async function loadIdentity(dataRoot) {
  const file = identityPath(dataRoot)
  const r = await readJson(file)
  if (!r.ok) {
    if (r.code === 'ENOENT') return { ok: false, degraded: true, reason: 'identity_missing', file }
    // 区分「读不到」（EACCES/EIO）与「解析损坏」（F7/F8）：前者不当作损坏，也不回落默认值
    if (r.code === CODES.JSON_PARSE) return { ok: false, degraded: true, reason: 'identity_corrupt', file, error: r.error }
    return { ok: false, degraded: true, reason: 'identity_unreadable', file, error: r.error }
  }
  const errs = validateIdentity(r.value)
  if (errs.length) {
    return { ok: false, degraded: true, reason: 'identity_invalid', file, error: { code: 'IDENTITY_INVALID', message: errs.join('；'), errors: errs } }
  }
  return { ok: true, identity: r.value, file }
}

/** 工作区最长前缀匹配（Windows 不区分大小写；按路径段边界） */
export function matchWorkspace(identity, ws) {
  const target = normPath(ws)
  if (!target) return null
  let best = null
  for (const [key, pid] of Object.entries(identity?.workspaces || {})) {
    const prefix = normPath(key)
    if (!prefix) continue
    if (target === prefix || target.startsWith(prefix + '\\')) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, personaId: pid, key }
    }
  }
  return best
}

/**
 * 解析人格。
 * @param {object|null} identity
 * @param {{session?:string, ws?:string, explicitPersonaId?:string}} ctx
 * @returns {{personaId:string, identitySource:'session'|'workspace'|'default'|'manual'|'unassigned', matched?:string, degraded:boolean}}
 */
export function resolvePersona(identity, ctx = {}) {
  const session = ctx.session ? String(ctx.session) : ''
  const ws = ctx.ws ? String(ctx.ws) : ''
  const explicit = ctx.explicitPersonaId ? String(ctx.explicitPersonaId) : ''

  if (identity && session && identity.sessions && Object.prototype.hasOwnProperty.call(identity.sessions, session)) {
    return { personaId: identity.sessions[session], identitySource: 'session', matched: session, degraded: false }
  }
  if (explicit) {
    return { personaId: explicit, identitySource: 'manual', matched: 'explicit', degraded: false }
  }
  if (identity) {
    const hit = matchWorkspace(identity, ws)
    if (hit) return { personaId: hit.personaId, identitySource: 'workspace', matched: hit.key, degraded: false }
    if (identity.defaultPersonaId) {
      return { personaId: identity.defaultPersonaId, identitySource: 'default', matched: 'defaultPersonaId', degraded: false }
    }
  }
  // 身份层不可用 → 降级命名空间，绝不落具名人格
  return { personaId: PERSONA_UNASSIGNED, identitySource: 'unassigned', matched: null, degraded: !identity }
}

/**
 * 生成 v1 初始 identity（CLI bootstrap 用，不是插件运行时行为）。
 * @param {{personas:object, workspaces:object, sessions?:object, defaultPersonaId?:string|null}} spec
 */
export function buildIdentity(spec) {
  const personas = {}
  for (const [id, v] of Object.entries(spec.personas || {})) {
    personas[id] = { displayName: typeof v === 'string' ? v : v?.displayName || id }
  }
  const identity = {
    version: 1,
    defaultPersonaId: spec.defaultPersonaId ?? null,
    personas,
    workspaces: { ...(spec.workspaces || {}) },
    sessions: { ...(spec.sessions || {}) },
  }
  const errs = validateIdentity(identity)
  if (errs.length) {
    const e = new Error(`identity 非法：${errs.join('；')}`)
    e.code = 'IDENTITY_INVALID'
    throw e
  }
  return identity
}

/** 写 identity.json（只给 CLI/bootstrap 用；根藏运行时永不调用） */
export async function writeIdentity(dataRoot, identity) {
  const file = identityPath(dataRoot)
  // 绝对红线：绝不写只读源 sessions/
  if (isInsideSessions(file)) {
    const e = new Error(`拒绝把 identity.json 写进只读源 sessions/：${file}`)
    e.code = CODES.READ_ONLY_SOURCE
    throw e
  }
  const errs = validateIdentity(identity)
  if (errs.length) {
    const e = new Error(`identity 非法：${errs.join('；')}`)
    e.code = 'IDENTITY_INVALID'
    throw e
  }
  return atomicWrite(file, JSON.stringify(identity, null, 2) + '\n')
}
