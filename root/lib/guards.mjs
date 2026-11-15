/**
 * lib/guards.mjs —— 守卫骨架（契约 §7 / 施工计划 2.1-5）
 *
 * 每条都要能红：
 *   1. 工具名带 recall/search/query → 红
 *   2. 注册注入钩子 → 红
 *   3. 写 ~/.dsh/sessions/ → 红
 *   4. 跨 persona 读取/合并入口 → 红（store 只暴露单 scope API）
 *   5. 未归属块写进具名人格 → 红
 *   6. manifest.personaId 与目录不一致 → 拒绝写
 *
 * 说明：源码扫描是**启发式**闸门（能抓住回归，不是形式化证明）；
 *      运行时闸门（assertWriteAllowed）才是硬拦。
 */
import { sessionsRoot, isInside, normPath, PERSONA_UNASSIGNED, isSafePersonaId } from './paths.mjs'
import { CODES, StoreError } from './errors.mjs'

export const TOOL_PREFIX = 'jianmu_store_'
export const FORBIDDEN_TOOL_WORDS = Object.freeze(['recall', 'search', 'query'])
export const ALLOWED_TOOLS = Object.freeze([
  'jianmu_store_ingest',
  'jianmu_store_status',
  'jianmu_store_rebuild',
  'jianmu_store_export',
  'jianmu_store_forget',
  'jianmu_store_revive',
  // P4 #5（2026-11-12）：受控登记人格（默认只预览；备份/幂等/只增不删）
  'jianmu_store_identity_add_persona',
])

/** 工具名闸门 */
export function checkToolName(name) {
  const problems = []
  if (!name.startsWith(TOOL_PREFIX)) problems.push(`工具名必须以 ${TOOL_PREFIX} 开头：${name}`)
  const low = String(name).toLowerCase()
  for (const w of FORBIDDEN_TOOL_WORDS) {
    if (low.includes(w)) problems.push(`工具名含禁用词「${w}」：${name}（检索归寻枝）`)
  }
  return { ok: problems.length === 0, problems }
}

/** 工具面闸门：注册的工具集合必须正好是允许的七件，且每个都过命名闸门 */
export function checkToolSurface(names) {
  const problems = []
  const set = [...new Set(names)]
  for (const n of set) problems.push(...checkToolName(n).problems)
  for (const n of set) if (!ALLOWED_TOOLS.includes(n)) problems.push(`未登记的工具：${n}`)
  for (const n of ALLOWED_TOOLS) if (!set.includes(n)) problems.push(`缺少工具：${n}`)
  return { ok: problems.length === 0, problems, tools: set }
}

/** 注入钩子源码闸门（启发式） */
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
    // 跳过注释与「正则字面量定义行」（例如 guards.mjs 自己的模式表），否则扫描器会扫到自己
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (/^\/.*\/[dgimsuvy]*,\s*$/.test(trimmed)) continue
    for (const re of INJECTION_PATTERNS) {
      if (re.test(line)) hits.push({ line: i + 1, text: trimmed.slice(0, 160), pattern: String(re) })
    }
  }
  return { ok: hits.length === 0, hits }
}

/** 写路径硬闸门：只许写 dataRoot 之内；绝不写 sessions/ */
export function assertWriteAllowed(dataRoot, target) {
  const t = normPath(target)
  const s = normPath(sessionsRoot())
  if (t === s || t.startsWith(s + '\\')) {
    throw new StoreError(CODES.READ_ONLY_SOURCE, `拒绝写入 DSH 会话目录（只读源）：${target}`, { target })
  }
  if (!isInside(dataRoot, target)) {
    throw new StoreError(CODES.PATH_OUTSIDE_ROOT, `拒绝写入 dataRoot 之外的路径：${target}`, { dataRoot, target })
  }
  return true
}

/** 人格一致性：manifest.personaId 必须与目录一致；未归属不许写具名人格 */
export function checkPersonaWrite(personaId, dirName, opts = {}) {
  const problems = []
  if (personaId === PERSONA_UNASSIGNED && opts.allowUnassigned === false) {
    problems.push('未归属块不允许写入（allowUnassigned=false）')
  }
  if (personaId !== PERSONA_UNASSIGNED && !isSafePersonaId(personaId)) problems.push(`personaId 非法：${personaId}`)
  if (dirName != null && dirName !== personaId) problems.push(`目录名（${dirName}）与 personaId（${personaId}）不一致`)
  return { ok: problems.length === 0, problems }
}

/** 旧库只读闸门：迁移只读 indexDir，绝不写 */
export function assertLegacyReadOnly(indexDir) {
  const s = normPath(sessionsRoot())
  const t = normPath(indexDir)
  if (t === s || t.startsWith(s + '\\')) {
    throw new StoreError(CODES.READ_ONLY_SOURCE, `旧库路径落在 sessions/ 下，拒绝操作：${indexDir}`)
  }
  return true
}

/** status 用：把闸门结果汇总成「能看见」的告警 */
export function guardSummary({ tools = [], sourceText = '' } = {}) {
  const surface = checkToolSurface(tools)
  const injection = scanSourceForInjection(sourceText)
  return {
    ok: surface.ok && injection.ok,
    surface,
    injection,
  }
}
