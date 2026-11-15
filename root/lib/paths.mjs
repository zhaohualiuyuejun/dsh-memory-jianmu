/**
 * lib/paths.mjs —— 根藏所有落盘位置（单点真源）
 *
 * 布局（CONTRACT-v1.md §3）：
 *   <dataRoot>/identity.json                人格解析层维护，根藏只读
 *   <dataRoot>/scopes/<personaId>/           scopeId = personaId（物理隔离）
 *     manifest.json  chunks.jsonl  vectors_v<N>.f32  index_meta.json
 *     deleted.jsonl  cost.jsonl  .lock  _archive/
 *
 * 绝不写回 ~/.dsh/sessions/（只读源）。
 */
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** DSH 的家：优先宿主给的环境变量，退到 ~/.dsh */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 会话历史根（只读源） */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/**
 * 根藏默认数据根（F15：数据与代码分离，不能放插件目录）
 * Stage 0：支持 JIANMU_DATA_ROOT 覆盖（把数据库单独指到别的盘），
 * 未设置时仍回退 <DSH_HOME>/memory-jianmu（向后兼容）。
 */
export function defaultDataRoot() {
  const override = process.env.JIANMU_DATA_ROOT
  if (typeof override === 'string' && override.trim()) return resolve(override.trim())
  return join(dshHome(), 'memory-jianmu')
}

/** 演练/小样目录：不写生产 scopes/ */
export function dryRunRoot(dataRoot = defaultDataRoot()) {
  return join(dataRoot, '_dryrun')
}

/**
 * 插件运行时日志/状态目录：<dataRoot>/_logs/
 * 放这里而不是插件包目录 —— 发布后插件包可能只读，且日志属于数据不属于代码。
 */
export function logsDir(dataRoot = defaultDataRoot()) {
  return join(dataRoot, '_logs')
}
export const autoIngestStatePath = (root) => join(logsDir(root), 'auto-ingest-state.json')
export const autoIngestLogPath = (root) => join(logsDir(root), 'auto-ingest.jsonl')
export const autoIngestLockPath = (root) => join(logsDir(root), 'auto-ingest.lock')

/**
 * A2 自动摘要（摄取后挂载，2026-11-12）：
 *   锁放 <dataRoot>/.locks/（每人格一把，单飞）；事件日志与子进程输出都在 _logs/。
 */
export const locksDir = (root = defaultDataRoot()) => join(root, '.locks')
export const autoSummaryLockPath = (root, personaId) => join(locksDir(root), `auto-summary-${personaId}.lock`)
export const autoSummaryLogPath = (root) => join(logsDir(root), 'auto-summary.jsonl')
export const autoSummaryChildLogPath = (root, personaId) => join(logsDir(root), `auto-summary-${personaId}.out.log`)

/** 未归属人格：fail-closed，绝不静默归入具名人格 */
export const PERSONA_UNASSIGNED = 'persona_unassigned'

/** personaId 只允许稳定 slug（契约 2.4） */
export const PERSONA_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isSafePersonaId(id) {
  return typeof id === 'string' && PERSONA_ID_RE.test(id)
}

/** 旧库 scope 名（src1 / srcmvwe6u4u）不是合法 personaId，允许映射时当键 */
export function assertPersonaId(id, where = 'personaId') {
  if (!isSafePersonaId(id)) {
    const e = new Error(`${where} 不是合法 slug：${JSON.stringify(id)}（只允许 [a-z0-9_-]，小写，≤64）`)
    e.code = 'BAD_PERSONA_ID'
    throw e
  }
  return id
}

export const identityPath = (root) => join(root, 'identity.json')
export const scopesRoot = (root) => join(root, 'scopes')
export const scopeDir = (root, personaId) => join(scopesRoot(root), personaId)
export const manifestPath = (root, personaId) => join(scopeDir(root, personaId), 'manifest.json')
export const chunksPath = (root, personaId) => join(scopeDir(root, personaId), 'chunks.jsonl')
export const indexPathMetaPath = (root, personaId) => join(scopeDir(root, personaId), 'index_meta.json')
export const vectorFileName = (version = 1) => `vectors_v${version}.f32`
export const vectorPath = (root, personaId, version = 1) => join(scopeDir(root, personaId), vectorFileName(version))
export const deletedPath = (root, personaId) => join(scopeDir(root, personaId), 'deleted.jsonl')
export const costPath = (root, personaId) => join(scopeDir(root, personaId), 'cost.jsonl')
export const lockPath = (root, personaId) => join(scopeDir(root, personaId), '.lock')
export const diagPath = (root, personaId) => join(scopeDir(root, personaId), 'diag.log')
export const archiveDir = (root, personaId) => join(scopeDir(root, personaId), '_archive')

/** 规范化后比较路径（Windows 不区分大小写；统一反斜杠） */
export function normPath(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/** target 是否在 root 之内（含 root 本身）；用于守卫「只写自己的库」 */
export function isInside(root, target) {
  const r = normPath(resolve(root))
  const t = normPath(resolve(target))
  if (t === r) return true
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** 是否落在只读源 sessions/ 之内（绝对红线） */
export function isInsideSessions(target) {
  const s = normPath(sessionsRoot())
  const t = normPath(resolve(target))
  return t === s || t.startsWith(s + sep)
}

/** 工作区目录名 → 给人看的路径（与寻枝 0.3.1 行为一致；迁移期必须逐字一致） */
export function prettyWorkspace(dirName) {
  let s = String(dirName || '')
  s = s.replace(/^--+/, '').replace(/-+$/, '')
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  const m = /^([A-Za-z])-(.*)$/.exec(s)
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/-/g, '\\')}`
  return s.replace(/-/g, '\\')
}

/** 旧库安全 scope 名（src id → 目录名），与寻枝一致 */
export function safeScopeKey(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  return s || 'default'
}

/** 旧寻枝库的候选位置（只读） */
export function legacyRecallRoot() {
  return join(dshHome(), 'session-recall')
}

/** 旧库某个 scope 的 index 目录：scope 为空 = 老的单库布局 */
export function legacyIndexDir(scope) {
  const base = legacyRecallRoot()
  return scope ? join(base, 'scopes', safeScopeKey(scope), 'index') : join(base, 'index')
}
