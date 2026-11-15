/**
 * lib/paths.mjs —— 年轮的路径与写边界
 *
 * 布局（契约 v1）：
 *   <dataRoot>/scopes/<personaId>/...        根藏（只读）
 *   <dataRoot>/process/<personaId>/...       熏习（只读）
 *   <dataRoot>/persona/...                   镜台（只读）
 *   <dataRoot>/year/<personaId>/...          年轮（唯一可写区）
 *
 * 硬规则：年轮的任何写动作都只能落在 year/<personaId>/ 之内；
 *         绝不写 scopes/、process/、persona/、~/.dsh/sessions/、soul-md。
 */
import { homedir, hostname } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { realpathSync, lstatSync } from 'node:fs'

export const PERSONA_UNASSIGNED = 'persona_unassigned'
export const YEAR_SUBDIR = 'year'

export const YEAR_FILES = Object.freeze({
  manifest: 'manifest.json',
  claims: 'claims.jsonl',
  runs: 'runs.jsonl',
  cost: 'cost.jsonl',
})

/** 只读源子目录（任何写都被拒） */
export const READ_ONLY_SUBDIRS = Object.freeze(['scopes', 'process', 'persona', 'soul-md'])

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

export function soulMdRoot() {
  return join(dshHome(), 'soul-md')
}

/**
 * 年轮默认数据目录（与根藏一致；年轮只读 scopes/process，只写 year/）
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
  const c = normPath(child)
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

export function processDirOf(dataRoot, personaId) {
  return join(dataRoot, 'process', assertSafePersonaId(personaId))
}

export function yearRoot(dataRoot) {
  const d = normPath(dataRoot)
  const sessions = normPath(sessionsRoot())
  if (d === sessions || d.startsWith(sessions + sep)) {
    const e = new Error(`dataRoot 落在只读源 sessions/ 下，拒绝使用：${dataRoot}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  return join(dataRoot, YEAR_SUBDIR)
}

export function yearDir(dataRoot, personaId) {
  return join(yearRoot(dataRoot), assertSafePersonaId(personaId))
}

export function yearFile(dataRoot, personaId, key) {
  const name = YEAR_FILES[key]
  if (!name) throw new Error(`未知的年轮文件 key：${key}`)
  return join(yearDir(dataRoot, personaId), name)
}

export function topicDocsDir(dataRoot, personaId) {
  return join(yearDir(dataRoot, personaId), 'topic_docs')
}

export function archiveDir(dataRoot, personaId, tag) {
  const base = join(yearDir(dataRoot, personaId), '_archive')
  if (!tag) return base
  // tag 只允许 tsSlugMs 风格（字母数字与连字符），禁止路径分隔与上跳
  const t = String(tag)
  if (!/^[A-Za-z0-9-]{1,80}$/.test(t)) {
    const e = new Error(`archive tag 非法：${t}（只允许 [A-Za-z0-9-]{1,80}）`)
    e.code = 'PATH_OUTSIDE_ROOT'
    throw e
  }
  return join(base, t)
}

/** 真实路径（不存在的路径返回 resolve 后的自身） */
function realOrSelf(p) {
  try { return realpathSync(String(p)) } catch { return resolve(String(p)) }
}

function isSymlink(p) {
  try { return lstatSync(String(p)).isSymbolicLink() } catch { return false }
}

/**
 * 写路径硬闸门：只许写 year/<personaId>/ 之内；绝不写只读源。
 * @throws {Error} code = PATH_OUTSIDE_ROOT | READ_ONLY_ROOT
 */
export function assertYearWrite(dataRoot, personaId, target) {
  const t = normPath(target)
  const yDir = normPath(yearDir(dataRoot, personaId))
  const sessions = normPath(sessionsRoot())
  const soulmd = normPath(soulMdRoot())

  const deny = (label, reason) => {
    const e = new Error(`拒绝写入${label}（只读源）：${target}`)
    e.code = 'READ_ONLY_ROOT'
    e.detail = { target, reason }
    throw e
  }

  if (t === sessions || t.startsWith(sessions + sep)) deny(' DSH 会话目录', 'sessions')
  if (t === soulmd || t.startsWith(soulmd + sep)) deny(' soul-md 人格目录', 'soul-md')
  for (const sub of READ_ONLY_SUBDIRS) {
    if (sub === 'soul-md') continue
    const dir = normPath(join(dataRoot, sub))
    if (t === dir || t.startsWith(dir + sep)) deny(` ${sub}/ 只读源`, sub)
  }
  if (t !== yDir && !t.startsWith(yDir + sep)) {
    const e = new Error(`拒绝写入年轮目录之外的路径：${target}（只允许 ${yDir}）`)
    e.code = 'PATH_OUTSIDE_ROOT'
    e.detail = { target, allowed: yDir }
    throw e
  }

  // 真实路径检查：词法比较挡不住 junction / 符号链接——
  // 若 year/<personaId>/（或其子目录）被换成链接，写入会落到别处。
  // 目标就是 year/<personaId>/ 本身时（创建目录），只查它自身是不是链接。
  if (t !== yDir) {
    const realYear = normPath(realOrSelf(yDir))
    const realParent = normPath(realOrSelf(dirname(target)))
    if (realParent !== realYear && !realParent.startsWith(realYear + sep)) {
      const e = new Error(`拒绝写入：真实路径逃出年轮目录（${realParent}）`)
      e.code = 'REALPATH_ESCAPE'
      e.detail = { target, realParent, realYear }
      throw e
    }
  }
  if (isSymlink(target)) {
    const e = new Error(`拒绝写入：目标是符号链接（${target}）`)
    e.code = 'SYMLINK_TARGET'
    e.detail = { target }
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

/** 秒级 slug 会撞车（同一秒第二次写）；备份目录必须带毫秒+随机段 */
export function tsSlugMs(d = new Date()) {
  return `${tsSlug(d)}-${String(d.getMilliseconds()).padStart(3, '0')}-${randomBytes(3).toString('hex')}`
}

export function relTo(dir, file) {
  return file.startsWith(dir) ? file.slice(dir.length).replace(/^[\\/]+/, '') : file
}

export { join, dirname }
