/**
 * lib/paths.mjs —— 熏习的路径与写边界
 *
 * 布局（契约 v1）：
 *   <dataRoot>/scopes/<personaId>/...       根藏（只读）
 *   <dataRoot>/process/<personaId>/...      熏习（唯一可写区）
 *
 * 硬规则：熏习的任何写动作都只能落在 process/<personaId>/ 之内；
 *         绝不写 scopes/、绝不写 ~/.dsh/sessions/。
 */
import { homedir, hostname } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export const PERSONA_UNASSIGNED = 'persona_unassigned'
export const PROCESS_SUBDIR = 'process'

export const PROCESS_FILES = Object.freeze({
  manifest: 'manifest.json',
  state: 'state.jsonl',
  topics: 'topics.jsonl',
  topicMembers: 'topic_members.jsonl',
  duplicates: 'duplicates.jsonl',
  pending: 'pending.jsonl',
  conflicts: 'conflicts.jsonl',
  cost: 'cost.jsonl',
})

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/**
 * 根藏默认数据目录（与根藏一致；熏习只读它）
 * Stage 0：支持 JIANMU_DATA_ROOT 覆盖；未设置仍回退 <DSH_HOME>/memory-jianmu。
 */
export function defaultDataRoot() {
  const override = process.env.JIANMU_DATA_ROOT
  if (typeof override === 'string' && override.trim()) return resolve(override.trim())
  return join(dshHome(), 'memory-jianmu')
}

export function normPath(p) {
  const abs = resolve(String(p))
  // Windows：盘符与路径不区分大小写；统一小写只用于比较
  return abs.replace(/[\\/]+/g, sep).toLowerCase()
}

export function isInside(parent, child) {
  const p = normPath(parent)
  let c = normPath(child)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export function isSafePersonaId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

export function assertSafePersonaId(id) {
  if (!isSafePersonaId(id)) {
    const e = new Error(`personaId 非法：${String(id)}（应为 [a-z0-9][a-z0-9_-]{0,63}）`)
    e.code = 'BAD_PERSONA_ID'
    throw e
  }
  return id
}

export function scopeDir(dataRoot, personaId) {
  return join(dataRoot, 'scopes', assertSafePersonaId(personaId))
}

export function processRoot(dataRoot) {
  const d = normPath(dataRoot)
  const sessions = normPath(sessionsRoot())
  if (d === sessions || d.startsWith(sessions + sep)) {
    const e = new Error(`dataRoot 落在只读源 sessions/ 下，拒绝使用：${dataRoot}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  return join(dataRoot, PROCESS_SUBDIR)
}

export function processDir(dataRoot, personaId) {
  return join(processRoot(dataRoot), assertSafePersonaId(personaId))
}

export function processFile(dataRoot, personaId, key) {
  const name = PROCESS_FILES[key]
  if (!name) throw new Error(`未知的熏习文件 key：${key}`)
  return join(processDir(dataRoot, personaId), name)
}

/**
 * 写路径硬闸门：只许写 process/<personaId>/ 之内；绝不写 scopes/ 与会话目录。
 * @throws {Error} code = PATH_OUTSIDE_ROOT | READ_ONLY_ROOT
 */
export function assertProcessWrite(dataRoot, personaId, target) {
  const t = normPath(target)
  const pDir = normPath(processDir(dataRoot, personaId))
  const scopes = normPath(join(dataRoot, 'scopes'))
  const sessions = normPath(sessionsRoot())

  if (t === sessions || t.startsWith(sessions + sep)) {
    const e = new Error(`拒绝写入 DSH 会话目录（只读源）：${target}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  if (t === scopes || t.startsWith(scopes + sep)) {
    const e = new Error(`拒绝写入根藏 scopes/（只读）：${target}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  if (t !== pDir && !t.startsWith(pDir + sep)) {
    const e = new Error(`拒绝写入熏习目录之外的路径：${target}（只允许 ${pDir}）`)
    e.code = 'PATH_OUTSIDE_ROOT'
    throw e
  }
  return true
}

export function anchorKeyOf(chunk) {
  const session = chunk?.session ?? ''
  const messageId = chunk?.messageId ?? ''
  const seq = chunk?.seq ?? ''
  const part = chunk?.part ?? 0
  return `${session}|${messageId}|${seq}|${part}`
}

export function hostTag() {
  try { return hostname() } catch { return 'unknown' }
}

export function tsSlug(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 秒级 slug 会撞车（同一秒第二次 apply）；备份目录必须带毫秒+随机段 */
export function tsSlugMs(d = new Date()) {
  return `${tsSlug(d)}-${String(d.getMilliseconds()).padStart(3, '0')}-${randomBytes(3).toString('hex')}`
}

export function relTo(dir, file) {
  return file.startsWith(dir) ? file.slice(dir.length).replace(/^[\\/]+/, '') : file
}

export { join, dirname }
