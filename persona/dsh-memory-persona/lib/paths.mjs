/**
 * lib/paths.mjs —— 镜台的路径与写边界
 *
 * 布局（契约 v1）：
 *   <dataRoot>/scopes/<personaId>/...        根藏（只读）
 *   <dataRoot>/process/<personaId>/...       熏习（只读）
 *   <dataRoot>/persona/...                   镜台（唯一可写区）
 *   <DSH_HOME>/soul-md/memory/...            soul-md 记忆（只读）
 *   <profile>/cordis.patch.yml               profile 配置（只读）
 *
 * 硬规则：镜台任何写动作只能落在 <dataRoot>/persona/ 之内。
 */
import { homedir, hostname } from 'node:os'
import { join, resolve, sep, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'

export const PERSONA_SUBDIR = 'persona'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

export function soulMdHome() {
  return join(dshHome(), 'soul-md')
}

export function assertSafeProfile(profile = 'desktop') {
  const p = String(profile || 'desktop')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p)) {
    const e = new Error(`profile 名非法：${p}`)
    e.code = 'BAD_PROFILE'
    throw e
  }
  return p
}

export function profileRoot(profile = 'desktop') {
  return join(dshHome(), 'profiles', assertSafeProfile(profile))
}

export function profilePatchFile(profile = 'desktop') {
  return join(profileRoot(profile), 'cordis.patch.yml')
}

/**
 * 根藏默认数据目录（与根藏/熏习一致）
 * Stage 0：支持 JIANMU_DATA_ROOT 覆盖；未设置仍回退 <DSH_HOME>/memory-jianmu。
 */
export function defaultDataRoot() {
  const override = process.env.JIANMU_DATA_ROOT
  if (typeof override === 'string' && override.trim()) return resolve(override.trim())
  return join(dshHome(), 'memory-jianmu')
}

export function normPath(p) {
  const abs = resolve(String(p))
  return abs.replace(/[\\/]+/g, sep).toLowerCase()
}

export function isInside(parent, child) {
  const p = normPath(parent)
  const c = normPath(child)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

const RESERVED_CARD_IDS = new Set([
  'none', 'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function isSafeCardId(id) {
  if (typeof id !== 'string') return false
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return false
  return !RESERVED_CARD_IDS.has(id)
}

export function assertSafeCardId(id) {
  if (!isSafeCardId(id)) {
    const e = new Error(`cardId 非法：${String(id)}（应为 [a-z0-9][a-z0-9_-]{0,63}）`)
    e.code = 'BAD_CARD_ID'
    throw e
  }
  return id
}

export function personaRoot(dataRoot) {
  const d = normPath(dataRoot)
  const sessions = normPath(sessionsRoot())
  const soulmd = normPath(soulMdHome())
  const profiles = normPath(join(dshHome(), 'profiles'))
  if (d === sessions || d.startsWith(sessions + sep)) {
    const e = new Error(`dataRoot 落在只读源 sessions/ 下，拒绝使用：${dataRoot}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  if (d === soulmd || d.startsWith(soulmd + sep)) {
    const e = new Error(`dataRoot 落在 soul-md 目录下，拒绝使用：${dataRoot}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  if (d === profiles || d.startsWith(profiles + sep)) {
    const e = new Error(`dataRoot 落在 profile 配置目录下，拒绝使用：${dataRoot}`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  return join(dataRoot, PERSONA_SUBDIR)
}

export function registryFile(dataRoot) {
  return join(personaRoot(dataRoot), 'registry.json')
}

export function globalManifestFile(dataRoot) {
  return join(personaRoot(dataRoot), 'manifest.json')
}

export function personaLockFile(dataRoot) {
  return join(personaRoot(dataRoot), '.lock')
}

export function importsDir(dataRoot) {
  return join(personaRoot(dataRoot), '_imports')
}

export function cardsDir(dataRoot) {
  return join(personaRoot(dataRoot), 'cards')
}

export function cardDir(dataRoot, cardId) {
  return join(cardsDir(dataRoot), assertSafeCardId(cardId))
}

export function cardFile(dataRoot, cardId) {
  return join(cardDir(dataRoot, cardId), 'card.md')
}

export function cardManifestFile(dataRoot, cardId) {
  return join(cardDir(dataRoot, cardId), 'manifest.json')
}

export function versionsFile(dataRoot, cardId) {
  return join(cardDir(dataRoot, cardId), 'versions.jsonl')
}

export function cardArchiveDir(dataRoot, cardId) {
  return join(cardDir(dataRoot, cardId), '_archive')
}

/**
 * 写路径硬闸门：只许写 <dataRoot>/persona/ 之内。
 * @throws {Error} code = PATH_OUTSIDE_ROOT | READ_ONLY_ROOT
 */
export function assertPersonaWritable(dataRoot, target) {
  const t = normPath(target)
  const pRoot = normPath(personaRoot(dataRoot))
  const scopes = normPath(join(dataRoot, 'scopes'))
  const processDir = normPath(join(dataRoot, 'process'))
  const sessions = normPath(sessionsRoot())
  const soulmd = normPath(soulMdHome())

  const deny = (why) => {
    const e = new Error(`拒绝写入 ${why}：${target}（镜台只允许写 ${pRoot}）`)
    e.code = 'READ_ONLY_ROOT'
    throw e
  }
  if (t === sessions || t.startsWith(sessions + sep)) deny('DSH 会话目录（只读源）')
  if (t === soulmd || t.startsWith(soulmd + sep)) deny('soul-md 目录（只读源）')
  if (t === scopes || t.startsWith(scopes + sep)) deny('根藏 scopes/（只读）')
  if (t === processDir || t.startsWith(processDir + sep)) deny('熏习 process/（只读）')
  if (t !== pRoot && !t.startsWith(pRoot + sep)) {
    const e = new Error(`拒绝写入镜台目录之外的路径：${target}（只允许 ${pRoot}）`)
    e.code = 'PATH_OUTSIDE_ROOT'
    throw e
  }
  return true
}

/**
 * 解析最近的存在祖先的真实路径（处理 symlink/junction）。
 * 目标本身不存在时，返回「祖先真实路径 + 余下相对段」。
 */
async function realpathNearest(target) {
  let cur = resolve(String(target))
  const rest = []
  for (;;) {
    try {
      const rp = await realpath(cur)
      return rest.length ? join(rp, ...rest.slice().reverse()) : rp
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const parent = dirname(cur)
      if (parent === cur) return resolve(String(target))
      rest.push(basename(cur))
      cur = parent
    }
  }
}

/**
 * 真实路径闸门：在词法闸门之上再解析 symlink/junction。
 * 拒绝：personaRoot 本身指向 scopes/process/sessions/soul-md；目标真实路径逃出 personaRoot。
 */
export async function assertPersonaWritableReal(dataRoot, target) {
  assertPersonaWritable(dataRoot, target)
  const rootReal = await realpathNearest(personaRoot(dataRoot))
  const targetReal = await realpathNearest(target)
  const forbidden = [
    ['scopes', join(String(dataRoot), 'scopes')],
    ['process', join(String(dataRoot), 'process')],
    ['sessions', sessionsRoot()],
    ['soul-md', soulMdHome()],
  ]
  for (const [name, dir] of forbidden) {
    const real = await realpathNearest(dir)
    if (isInside(real, rootReal) || isInside(rootReal, real)) {
      const e = new Error(`拒绝写入：persona 根的真实路径与只读区 ${name} 重叠（${rootReal}）`)
      e.code = 'READ_ONLY_ROOT'
      throw e
    }
  }
  if (!isInside(rootReal, targetReal)) {
    const e = new Error(`拒绝写入：目标真实路径逃出 persona 根（目标 ${targetReal}；根 ${rootReal}）`)
    e.code = 'PATH_OUTSIDE_ROOT'
    throw e
  }
  return true
}

export function hostTag() {
  try { return hostname() } catch { return 'unknown' }
}

export function tsSlug(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 秒级 slug 会撞车；备份目录必须带毫秒 + 随机段 */
export function tsSlugMs(d = new Date()) {
  return `${tsSlug(d)}-${String(d.getMilliseconds()).padStart(3, '0')}-${randomBytes(3).toString('hex')}`
}

export function relTo(dir, file) {
  return file.startsWith(dir) ? file.slice(dir.length).replace(/^[\\/]+/, '') : file
}

export { join, dirname }
