/**
 * lib/guards.mjs —— 熏习的守卫（每条都要能红）
 *
 *   1. 工具名必须 jianmu_process_ 开头，且不得含 recall/search/query
 *   2. 工具面必须正好是允许的集合
 *   3. 源码不得注册注入钩子 / pre-step / systemPrompt
 *   4. 任何写动作只许落 process/<personaId>/（assertProcessWrite）
 *   5. 状态/待处理记录不得携带原文（text/body/summary/conclusion），
 *      熏习不改原文、不写 topic 正文
 *
 * 说明：源码扫描是启发式闸门（能抓回归，不是形式化证明）；
 *       运行时 assertProcessWrite 才是硬拦。
 */
import {
  TOOL_PREFIX,
  FORBIDDEN_TOOL_WORDS,
  ALLOWED_TOOLS,
} from './version.mjs'
import { assertProcessWrite, isInside, normPath, processDir, sessionsRoot } from './paths.mjs'

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

export const INJECTION_PATTERNS = Object.freeze([
  /pre-?step/i,
  /before-?step/i,
  /systemPrompt/i,
  /system_prompt/i,
  /appendSystem/i,
  /injectPrompt/i,
  /promptInject/i,
  /ctx\.on\(\s*['"]prompt/i,
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
      if (re.test(line)) hits.push({ line: i + 1, text: trimmed.slice(0, 160), pattern: String(re) })
    }
  }
  return { ok: hits.length === 0, hits }
}

/** 运行时写闸门（包一层，保证 scope 目录名与 personaId 一致） */
export function guardWrite(dataRoot, personaId, target) {
  return assertProcessWrite(dataRoot, personaId, target)
}

/** 只读根藏闸门：任何试图打开根藏写句柄的地方都应先过这里（目前没有写入口，留作守卫） */
export function assertRootReadOnly(dataRoot, target) {
  const scopes = normPath(`${dataRoot}/scopes`)
  const t = normPath(target)
  const sessions = normPath(sessionsRoot())
  if (t === scopes || t.startsWith(scopes + '\\') || t.startsWith(scopes + '/')) {
    return { ok: true, readOnly: true, reason: 'scopes/ 只读' }
  }
  if (t === sessions || t.startsWith(sessions + '\\') || t.startsWith(sessions + '/')) {
    return { ok: true, readOnly: true, reason: 'sessions/ 只读' }
  }
  return { ok: true, readOnly: false }
}

/** 状态/待处理记录不得携带原文（守卫 3：不产生 topic 正文 / 不改原文） */
export const FORBIDDEN_BODY_KEYS = Object.freeze(['text', 'body', 'summary', 'conclusion', 'content', 'quoteText'])

export function assertNoBodyFields(record, where = 'record', depth = 0) {
  if (depth > 8) return true
  if (Array.isArray(record)) {
    for (let i = 0; i < record.length; i++) assertNoBodyFields(record[i], `${where}[${i}]`, depth + 1)
    return true
  }
  if (!record || typeof record !== 'object') return true
  const bad = []
  for (const k of FORBIDDEN_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, k)) bad.push(k)
  }
  if (bad.length) {
    const e = new Error(`${where} 携带原文/正文字段（${bad.join(',')}）；熏习只存状态，不存原文`)
    e.code = 'FORBIDDEN_BODY_FIELD'
    throw e
  }
  for (const [k, v] of Object.entries(record)) {
    if (v && typeof v === 'object') assertNoBodyFields(v, `${where}.${k}`, depth + 1)
  }
  return true
}

export function guardSummary({ tools = [], sourceText = '' } = {}) {
  const surface = checkToolSurface(tools)
  const injection = scanSourceForInjection(sourceText)
  return { ok: surface.ok && injection.ok, surface, injection }
}

export function isInsideProcess(dataRoot, personaId, target) {
  return isInside(processDir(dataRoot, personaId), target)
}
