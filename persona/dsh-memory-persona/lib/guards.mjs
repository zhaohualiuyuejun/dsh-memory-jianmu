/**
 * lib/guards.mjs —— 镜台的守卫（每条都要能红）
 *
 *   1. 工具名必须 jianmu_persona_ 开头，且不得含 recall/search/query
 *   2. 工具面必须正好是允许的 15 件
 *   3. 源码不得注册注入钩子 / pre-step / systemPrompt / 消息侧注入
 *   4. 任何写动作只许落 <dataRoot>/persona/
 *   5. v1a 不写 soul-md / 不写 settings / 不接管注入
 *
 * 说明：源码扫描是启发式闸门（能抓回归，不是形式化证明）；
 *       运行时 assertPersonaWritable 才是硬拦。
 */
import {
  TOOL_PREFIX,
  FORBIDDEN_TOOL_WORDS,
  ALLOWED_TOOLS,
} from './version.mjs'
import { assertPersonaWritable, isInside, normPath, personaRoot, sessionsRoot, soulMdHome } from './paths.mjs'
import { join } from 'node:path'

export { TOOL_PREFIX, FORBIDDEN_TOOL_WORDS, ALLOWED_TOOLS }

export function checkToolName(name) {
  const problems = []
  if (!String(name).startsWith(TOOL_PREFIX)) problems.push(`工具名必须以 ${TOOL_PREFIX} 开头：${name}`)
  const low = String(name).toLowerCase()
  for (const w of FORBIDDEN_TOOL_WORDS) {
    if (low.includes(w)) problems.push(`工具名含禁用词「${w}」：${name}（检索归寻枝）`)
  }
  return { ok: problems.length === 0, problems }
}

export function checkToolSurface(names) {
  const problems = []
  const set = [...new Set(names)]
  for (const n of set) problems.push(...checkToolName(n).problems)
  for (const n of set) if (!ALLOWED_TOOLS.includes(n)) problems.push(`未登记的工具：${n}`)
  for (const n of ALLOWED_TOOLS) if (!set.includes(n)) problems.push(`缺少工具：${n}`)
  return { ok: problems.length === 0, problems, tools: set }
}

/**
 * 镜台**允许**出现的注入相关字样只有两处：本文件的守卫表、以及「不注入」的注释。
 * 扫描时忽略注释行与守卫定义行，抓真正的调用。
 */
export const INJECTION_PATTERNS = Object.freeze([
  /ctx\.on\(\s*['"]pre-?step/i,
  /ctx\.on\(\s*['"]before-?step/i,
  /ctx\.systemPrompt\.section\s*\(/,
  /ctx\.on\(\s*['"]agent\/inbox/i,
  /appendSystem(Message)?\s*\(/,
  /injectPrompt\s*\(/,
  /promptInject\s*\(/,
])

export function scanSourceForInjection(text) {
  const hits = []
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (/^\/.*\/[dgimsuvy]*,\s*$/.test(trimmed)) continue
    for (const re of INJECTION_PATTERNS) {
      // 守卫自己的定义行不算
      if (trimmed.includes('INJECTION_PATTERNS') || trimmed.includes('ctx.systemPrompt.section(') && trimmed.startsWith('/')) continue
      if (re.test(line)) hits.push({ line: i + 1, text: trimmed.slice(0, 160), pattern: String(re) })
    }
  }
  return { ok: hits.length === 0, hits }
}

/** 运行时写闸门 */
export function guardWrite(dataRoot, target) {
  return assertPersonaWritable(dataRoot, target)
}

/** v1a 只读闸门：注入设置 / 接管注入 / 写 soul-md 一律拒绝 */
export function assertV1aReadOnly(what = '该动作') {
  const e = new Error(`${what}在 v1a 只读：镜台不接管注入、不写 soul-md（v2 才开）`)
  e.code = 'READ_ONLY_V1A'
  throw e
}

/** 只读探测：目标是否在只读源里（给 preview/settings 用） */
export function readOnlyKind(dataRoot, target) {
  const t = normPath(target)
  const checks = [
    ['scopes', normPath(join(String(dataRoot), 'scopes'))],
    ['process', normPath(join(String(dataRoot), 'process'))],
    ['sessions', normPath(sessionsRoot())],
    ['soul-md', normPath(soulMdHome())],
  ]
  for (const [kind, root] of checks) {
    if (t === root || t.startsWith(root + '\\') || t.startsWith(root + '/')) return kind
  }
  return null
}

export function guardSummary({ tools = [], sourceText = '' } = {}) {
  const surface = checkToolSurface(tools)
  const injection = scanSourceForInjection(sourceText)
  return { ok: surface.ok && injection.ok, surface, injection }
}

export function isInsidePersona(dataRoot, target) {
  return isInside(personaRoot(dataRoot), target)
}
