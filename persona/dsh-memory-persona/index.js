/**
 * dsh-memory-persona —— 镜台（建木 · 人格层）host 半端
 * ============================================================================
 * 人格卡与「注入设置」的唯一写者；v1a 不接管注入。
 *
 * 明确不做（契约 v1）：
 *   ❌ 不改根藏 / 熏习 / soul-md / profile 配置
 *   ❌ v1a 不接管注入、不写 settings、不注册注入钩子
 *   ❌ AI 生成不自动保存、不自动演化
 *   ❌ 每轮调用模型（expand 只在显式调用时发生）
 *
 * 工具面：jianmu_persona_{status,list,card,versions,diff,create,save,delete,
 *                        set_default,bind,rollback,import,expand,preview,settings}
 * 数据布局：<dataRoot>/persona/{manifest,registry}.json + cards/<cardId>/
 * ============================================================================
 */
import { resolve, join, dirname } from 'node:path'
import { readFile, appendFile } from 'node:fs/promises'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { defaultDataRoot, isSafeCardId, profilePatchFile, personaRoot } from './lib/paths.mjs'
import { checkToolName, checkToolSurface, guardWrite } from './lib/guards.mjs'
import { VERSION, ALLOWED_TOOLS, EXPAND_BUDGET } from './lib/version.mjs'
import { toErrInfo } from './lib/errors.mjs'
import { apiStatus, apiCards, apiCard, apiVersions, apiDiff, apiRegistry, apiSettings, apiPreview, apiImportSources } from './lib/api.mjs'
import {
  createCard, saveCard, deleteCard, setDefaultCard, bindCard, rollbackCard, importFromSoulMd, saveSettings,
} from './lib/write.mjs'
import { resolveCardId, readCard, readRegistry } from './lib/store.mjs'
import { readRegistrySettingsSync, mergeInjectSettings, validateSettingsPatch } from './lib/settings.mjs'
import { resolvePersonaForInjection, memoryRenderConfig, resolvePersonaIdForScope } from './lib/injectsource.mjs'
import { createRecallStore, renderRecall, boundedInteger } from './lib/recall.mjs'
import {
  passesG0, pickHits, renderBlock, createAutoRecallState, renderLogRow,
} from './lib/autorecall.mjs'
import {
  createConflictCardState, renderConflictCards, renderConflictLogRow,
} from './lib/conflictcard.mjs'
import { resolveSoulMdConfig, readSoulMdConfigFromServices, normalizeSoulMdConfig, renderSoulMdMemory, resolveSoulMdCardName, listTopicsInScope, safeMemoryName } from './lib/soulmd.mjs'
import { atomicWrite, ensureDir } from './lib/fsatomic.mjs'
import { scanText } from './lib/scan.mjs'
import { expandPersona } from './lib/expand.mjs'
import { handleWriteRequest } from './lib/httpwrite.mjs'
import { hardClaimPreview, hardClaimApply, hardClaimRollback } from './lib/hardclaim.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'memory-persona'
export const inject = ['tools', 'systemPrompt']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true)
    .description('总开关：关掉后工具只回一句「已关闭」'),
  dataRoot: z.string().default('').extra('volatile', true)
    .description('根藏数据根；镜台只写 <dataRoot>/persona/'),
  profile: z.string().default('desktop').extra('volatile', true)
    .description('读取 soul-md 配置的 profile 名（默认 desktop）'),
  expandEnabled: z.boolean().default(true).extra('volatile', true)
    .description('是否允许 jianmu_persona_expand 调模型（默认开；仍是显式单次动作）'),
  expandProvider: z.string().default('').extra('volatile', true)
    .description('AI 生成的 provider；留空跟随当前会话。填 ollama 可走本地'),
  expandModel: z.string().default('').extra('volatile', true)
    .description('AI 生成的 model；留空跟随当前会话'),
  expandMaxInputChars: z.natural().default(EXPAND_BUDGET.maxInputChars).extra('volatile', true)
    .description('AI 生成单次输入字符上限'),
  expandMaxOutputTokens: z.natural().default(EXPAND_BUDGET.maxOutputTokens).extra('volatile', true)
    .description('AI 生成单次输出 token 上限'),
  expandTimeoutMs: z.natural().default(EXPAND_BUDGET.timeoutMs).extra('volatile', true)
    .description('AI 生成超时（毫秒）'),
  expandRetries: z.natural().default(EXPAND_BUDGET.retries).extra('volatile', true)
    .description('AI 生成失败重试次数（0–2）'),
  injectEnabled: z.boolean().default(false).extra('volatile', true)
    .description('v2 注入接管总开关（默认关：不注册注入段，soul-md 继续注入；要接管时在设置里打开，会当场补注册）'),
  injectMaxChars: z.natural().default(12000).extra('volatile', true)
    .description('注入段字符上限（复刻 soul-md 的 injectMaxChars）'),
  injectPersonaOrder: z.number().default(0).extra('volatile', true)
    .description('jianmu:persona 段排序（对齐 soul-md 的 order）'),
  injectMemoryOrder: z.number().default(0.5).extra('volatile', true)
    .description('jianmu:memory 段排序（对齐 soul-md 的 memory.order）'),
  injectCacheMs: z.natural().default(5000).extra('volatile', true)
    .description('注入渲染缓存毫秒（0=每次重读）'),
  cardSource: z.string().default('jianmu').extra('volatile', true)
    .description('人格段卡源：jianmu（建木卡真源，默认）| soul-md（旧真源，读不到卡时自动回退）；可被 registry.settings 覆盖'),
  memoryLayered: z.boolean().default(true).extra('volatile', true)
    .description('记忆段是否分层（core + 主题索引）；默认 true'),
  memoryIndexMode: z.string().default('all').extra('volatile', true)
    .description('主题索引口径：all（全量）| recall（仅召回，镜台未实现检索时退化为提示句）| off'),
  subagentSkip: z.boolean().default(false).extra('volatile', true)
    .description('子代理会话（origin: "subagent"）跳过人格与记忆注入；子代理工具仍可用'),
  recallMaxTopics: z.natural().default(8).extra('volatile', true)
    .description('压缩后补偿最多列几个已查阅主题（1–20）'),
  recallMaxChars: z.natural().default(1600).extra('volatile', true)
    .description('召回与压缩补偿块的总字符上限（200–8000）'),
  compactionRecall: z.boolean().default(false).extra('volatile', true)
    .description('压缩后补偿：会话被压缩后，下一次注入附上本会话读过主题的 key/摘要'),
  // ── P2 自动召回（2026-11-12；默认关） ──
  autoRecall: z.boolean().default(false).extra('volatile', true)
    .description('P2 自动召回：每用户回合按闸门决定是否去寻枝预取旧记忆（默认关）'),
  autoRecallMinScore: z.number().default(0.62).extra('volatile', true)
    .description('自动召回相关度下限（默认 0.62）'),
  autoRecallTopN: z.natural().default(2).extra('volatile', true)
    .description('自动召回最多注入几条（1–5，默认 2）'),
  autoRecallMaxChars: z.natural().default(320).extra('volatile', true)
    .description('自动召回块字符预算（默认 320，不占 injectMaxChars）'),
  autoRecallDeadlineMs: z.natural().default(800).extra('volatile', true)
    .description('预取死线毫秒（超时当没有记忆）'),
  autoRecallWaitMs: z.natural().default(800).extra('volatile', true)
    .description('组装 prompt 时最多等预取多久；0=完全不等（首步通常拿不到）'),
  autoRecallCooldownMs: z.natural().default(60000).extra('volatile', true)
    .description('同会话两次自动召回的最小间隔毫秒'),
  autoRecallCues: z.string().default('').extra('volatile', true)
    .description('G0 线索词，用 | 分隔；留空用默认词表'),
  autoRecallLabOnly: z.boolean().default(true).extra('volatile', true)
    .description('只对实验工作区生效（路径含 tester 或命中 autoRecallLabWorkspaces）'),
  autoRecallLabWorkspaces: z.string().default('').extra('volatile', true)
    .description('实验白名单工作区（逗号分隔）'),
  // ── P2.5 冲突卡（2026-11-12；默认关、只读） ──
  conflictCard: z.boolean().default(false).extra('volatile', true)
    .description('P2.5 冲突卡：有未裁决冲突时附 A/B 两说（默认关；只提示不裁决，≤2 张/≤300 字）'),
  maxBytes: z.natural().default(262144).extra('volatile', true)
    .description('单个记忆文件大小上限（字节）；memory_append 超过即拒绝'),
})

const DEFAULTS = Object.freeze({
  enabled: true,
  dataRoot: '',
  profile: 'desktop',
  expandEnabled: true,
  expandProvider: '',
  expandModel: '',
  expandMaxInputChars: EXPAND_BUDGET.maxInputChars,
  expandMaxOutputTokens: EXPAND_BUDGET.maxOutputTokens,
  expandTimeoutMs: EXPAND_BUDGET.timeoutMs,
  expandRetries: EXPAND_BUDGET.retries,
  injectEnabled: false,
  injectMaxChars: 12000,
  injectPersonaOrder: 0,
  injectMemoryOrder: 0.5,
  injectCacheMs: 5000,
  cardSource: 'jianmu',
  memoryLayered: true,
  memoryIndexMode: 'all',
  subagentSkip: false,
  recallMaxTopics: 8,
  recallMaxChars: 1600,
  compactionRecall: false,
  autoRecall: false,
  autoRecallMinScore: 0.62,
  autoRecallTopN: 2,
  autoRecallMaxChars: 320,
  autoRecallDeadlineMs: 800,
  autoRecallWaitMs: 800,
  autoRecallCooldownMs: 60000,
  autoRecallCues: '',
  autoRecallLabOnly: true,
  autoRecallLabWorkspaces: '',
  conflictCard: false,
  maxBytes: 262144,
})

function normalizeConfig(cfg) {
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = cfg ? cfg[k] : undefined
    if (v === undefined || v === null || v === '') continue
    if (typeof DEFAULTS[k] === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
      continue
    }
    if (typeof DEFAULTS[k] === 'number') {
      // 只接受数字/数字字符串；schema 描述符等对象一律当“未配置”
      if (typeof v !== 'number' && typeof v !== 'string') continue
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) {
        if (k === 'injectPersonaOrder' || k === 'injectMemoryOrder') out[k] = n
        else if (k === 'autoRecallMinScore') out[k] = Math.min(0.95, Math.max(0.3, n))
        else if (k === 'expandRetries') out[k] = Math.min(1, Math.floor(n))
        else out[k] = Math.floor(n)
      }
      continue
    }
    // 字符串字段：只接受真正的字符串。
    // 宿主在某些加载路径下会把 Config 里的字符串字段作为**对象**传进来；
    // 以前无条件 String(v) 会得到 "[object Object]"，dataRoot 因此落在 profile 目录下被闸门拒绝，
    // 整个插件在 apply 阶段挂掉（2026-11-07 实机踩到）。非字符串 = 未配置，回退默认值。
    if (typeof v !== 'string') continue
    out[k] = v
  }
  return out
}

export function declaredToolNames() {
  return [...ALLOWED_TOOLS]
}

export function apply(ctx, config) {
  const baseCfg = normalizeConfig(config)
  const disposers = []
  const registeredNames = []
  const logs = []
  const log = (msg) => {
    logs.push(String(msg))
    try { ctx.logger?.info?.(`[memory-persona] ${msg}`) } catch { /* ignore */ }
  }

  const loggedOnce = new Set()
  const logOnce = (msg) => {
    const k = String(msg)
    if (loggedOnce.has(k)) return
    loggedOnce.add(k)
    log(k)
  }
  const dataRoot = () => {
    const raw = baseCfg.dataRoot
    const root = typeof raw === 'string' && raw.trim() ? raw.trim() : defaultDataRoot()
    return resolve(root)
  }
  const liveCfg = () => {
    let out = { ...baseCfg }
    try {
      const rows = ctx.settings?.describe?.() || []
      const row = rows.find((r) => r?.ns === name || r?.ns === 'memory-persona' || r?.ns === 'dsh-memory-persona')
      // 只合并 settings 里明确存在的字段；不能把整个 normalizeConfig(row.user) 覆盖上来，
      // 否则未在 settings 里配置的字段（如 injectEnabled）会被默认值冲掉。
      if (row?.user && typeof row.user === 'object') out = normalizeConfig({ ...out, ...row.user })
    } catch { /* ignore */ }
    // v2：registry.settings（用户在镜台 UI / 工具里当场改的）是权威层，压过代码默认与 patch 配置行。
    // 这里必须同步读（注入热路径），lib/settings.mjs 自带 mtime+size 缓存。
    try {
      const reg = readRegistrySettingsSync(dataRoot())
      if (!reg.ok) logOnce(`registry.settings 读不出来（${reg.code}）→ 本轮按启动配置生效（可能与你在 UI 里改的不一致）`)
      else if (reg.settings && Object.keys(reg.settings).length) {
        out = mergeInjectSettings(out, reg.settings).cfg
      }
    } catch { /* 读不到就按配置行走，不影响注入 */ }
    return out
  }

  // ── 注入段（v2）────────────────────────────────────────────────────────
  // 为什么「懒注册」：injectEnabled 是设置里可写的。若只在挂载时判断，
  // 关闭→再打开就得重启一次。改成：关闭时段函数返回空串；打开时按需补注册。
  const injectCache = new Map()
  // 压缩后补偿（2026-11-08 移植自 soul-md）：会话级状态；compaction/* 是宿主的持久会话事件。
  const recallStore = createRecallStore()
  const autoState = createAutoRecallState({
    getCooldownMs: () => Number(liveCfg().autoRecallCooldownMs) || 0,
    getTtlMs: () => 120000,
  })
  // P2.5 冲突卡状态（默认关）：预取在 inbox/claimed，注入在记忆段读取
  const conflictState = createConflictCardState({ dedupeMs: 10 * 60 * 1000 })
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        if (!liveCfg().compactionRecall) return
        const sid = String(session?.id ?? session ?? '')
        if (!sid) return
        if (event?.type === 'compaction/prune'
          || (event?.type === 'compaction/end' && event?.data?.error === undefined)) {
          recallStore.markCompacted(sid)
        }
      })
      ctx.on('agent/inbox/claimed', (payload) => {
        const sid = String(payload?.agent?.session?.id ?? '')
        if (sid) recallStore.claimTurn(sid)
      })
      ctx.on('session/disposed', (session) => {
        const sid = String(session?.id ?? session ?? '')
        if (sid) { recallStore.dispose(sid); autoState.dispose(sid); conflictState.dispose(sid) }
      })
    } else {
      log('宿主没有 ctx.on —— 压缩后补偿不可用（其余注入不受影响）')
    }
  } catch (e) {
    log(`压缩补偿事件监听注册失败（不影响注入）：${String(e?.message || e)}`)
  }

  // ── P2 自动召回（2026-11-12，默认关）─────────────────────────────────────
  // 分工：寻枝服务 jianmuRecall 负责检索；这里负责 G0 闸门、会话状态、注入与观测。
  // 时序：inbox/claimed 起异步预取 → system-prompt/assemble 前最多等 autoRecallWaitMs
  //       → 记忆段同步读结果。宁可少提，也不让对话无限期等。
  const SYS_TEXT_PREFIXES = [
    'Current runtime context', '<system-reminder>', 'Current time:', 'Time sampled',
    '<available_skills>', 'A browser bridge may be connected', 'This snapshot supersedes',
    'You are the Team Lead named', 'You are repeating', 'background job',
    '你是这个账号的', '【当前时间】', '【当前角色】', '【首回复节奏】', '【本轮记忆】',
    '【使用说明】', '【最近的消息】', '【渠道：', '本次执行由任务看板', '===== 使用者',
    'This is an automated run', 'The user chose',
  ]
  /** 从 UserMessage 里取真正的用户文本（滤掉运行时上下文/技能目录等系统注入块） */
  function extractUserText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    const parts = []
    for (const b of message.content) {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') continue
      const t = b.text.trim()
      if (!t) continue
      if (SYS_TEXT_PREFIXES.some((p) => t.startsWith(p))) continue
      parts.push(t)
    }
    return parts.join('\n').trim().slice(0, 2000)
  }
  /** 实验白名单：autoRecallLabOnly=true 时只认 tester / lab 工作区或显式列表 */
  function autoRecallLabAllowed(cfg, ws) {
    if (cfg.autoRecallLabOnly !== true) return true
    const w = String(ws || '').toLowerCase()
    const list = String(cfg.autoRecallLabWorkspaces || '').split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (list.some((a) => w.includes(a))) return true
    return /(^|[\\/])tester([\\/]|$)/i.test(w) || /[\\/]lab(\.|$|[\\/]|\s)/i.test(w) || /^[a-z]:\\lab$/i.test(w)
  }
  function appendAutoRecallLog(row) {
    try {
      const dir = join(dataRoot(), 'persona', '_logs')
      ensureDir(dir)
        .then(() => appendFile(join(dir, 'auto-recall.jsonl'), `${JSON.stringify(row)}\n`, 'utf8'))
        .catch(() => {})
    } catch { /* 观测失败不能影响对话 */ }
  }
  function autoRecallService() {
    try { return ctx.get?.('jianmuRecall') || null } catch { return null }
  }

  /** 回合开始：判闸门 → 起预取（不 await） */
  function startAutoRecall(payload) {
    const sid = String(payload?.agent?.session?.id ?? '')
    if (!sid) return
    const cfg = liveCfg()
    if (!cfg.autoRecall || !cfg.injectEnabled) { autoState.cancel(sid); return }
    if (cfg.subagentSkip && payload?.agent?.session?.header?.origin === 'subagent') return

    const query = extractUserText(payload?.message)
    const ws = pickWorkspace({ agent: payload?.agent })
    if (!autoRecallLabAllowed(cfg, ws)) {
      autoState.cancel(sid)
      appendAutoRecallLog(renderLogRow({ sid, outcome: 'lab-skip' }))
      return
    }
    const turn = Number(payload?.turn) || Number(payload?.agent?.session?.seq) || null
    const g0 = passesG0(query, cfg.autoRecallCues)
    const begun = autoState.begin(sid, { query, turn })
    if (!begun.ok) {
      appendAutoRecallLog(renderLogRow({ sid, g0: g0.ok, g0Reason: g0.reason, outcome: String(begun.code).toLowerCase() }))
      return
    }
    if (!g0.ok) {
      autoState.resolve(sid, { turn, block: '', code: 'g0' })
      appendAutoRecallLog(renderLogRow({ sid, g0: false, g0Reason: g0.reason, outcome: 'g0-skip' }))
      return
    }
    const svc = autoRecallService()
    if (!svc || typeof svc.prefetch !== 'function') {
      autoState.resolve(sid, { turn, block: '', code: 'no-service' })
      appendAutoRecallLog(renderLogRow({ sid, g0: true, g0Reason: g0.reason, outcome: 'no-service' }))
      return
    }
    const t0 = Date.now()
    const p = (async () => {
      const res = await svc.prefetch({
        query,
        agent: payload.agent,
        deadlineMs: cfg.autoRecallDeadlineMs,
        minScore: cfg.autoRecallMinScore,
        topN: Math.max(1, Number(cfg.autoRecallTopN) || 2) + 3,
      })
      const picked = pickHits(res, {
        minScore: cfg.autoRecallMinScore,
        topN: cfg.autoRecallTopN,
        maxChars: cfg.autoRecallMaxChars,
      })
      const block = renderBlock(picked.hits)
      const top = picked.hits[0] || (res?.hits || [])[0] || null
      autoState.resolve(sid, {
        turn, block, code: res?.code || null,
        meta: { ms: Date.now() - t0, embedMs: res?.embedMs, n: picked.hits.length },
      })
      appendAutoRecallLog(renderLogRow({
        sid, g0: true, g0Reason: g0.reason, ms: Date.now() - t0, embedMs: res?.embedMs,
        score: top?.score, lex: top?.lex, n: picked.hits.length, chars: block.length,
        outcome: block ? 'injected' : `miss:${res?.code || 'no-hit'}`,
      }))
    })().catch(() => {
      autoState.resolve(sid, { turn, block: '', code: 'error' })
      appendAutoRecallLog(renderLogRow({ sid, g0: true, g0Reason: g0.reason, ms: Date.now() - t0, outcome: 'error' }))
    })
    autoState.attach(sid, turn, p)
    // 结果到了立刻失效注入缓存：后续 step 马上能看见（首步靠 assemble 前的 waitFor）
    p.then(() => { try { invalidateInjectCache() } catch { /* 忽略 */ } }).catch(() => {})
  }

  // ── P2.5 冲突卡（2026-11-12，默认关、只读）────────────────────────────────
  // 分工：熏习服务 jianmuConflicts 给 A/B 两说；这里只负责「这一回合要不要提」与渲染。
  // 与自动召回共用 G0 线索词，但开关独立（conflictCard 可以单开）。
  function appendConflictLog(row) {
    try {
      const dir = join(dataRoot(), 'persona', '_logs')
      ensureDir(dir)
        .then(() => appendFile(join(dir, 'conflict-card.jsonl'), `${JSON.stringify(row)}\n`, 'utf8'))
        .catch(() => {})
    } catch { /* 观测失败不能影响对话 */ }
  }
  function conflictService() {
    try { return ctx.get?.('jianmuConflicts') || null } catch { return null }
  }

  /** 回合开始：G0 通过才去问熏习要冲突卡（不 await，注入前最多等 300ms） */
  function startConflictCards(payload) {
    const sid = String(payload?.agent?.session?.id ?? '')
    if (!sid) return
    const cfg = liveCfg()
    if (!cfg.conflictCard || !cfg.injectEnabled) { conflictState.cancel(sid); return }
    if (cfg.subagentSkip && payload?.agent?.session?.header?.origin === 'subagent') return

    const query = extractUserText(payload?.message)
    const turn = Number(payload?.turn) || Number(payload?.agent?.session?.seq) || null
    conflictState.begin(sid, { query, turn })
    if (!passesG0(query, cfg.autoRecallCues).ok) return

    const ws = pickWorkspace({ agent: payload?.agent })
    const scope = resolvePersonaIdForScope({ dataRoot: dataRoot(), workspace: ws, sessionId: sid })
    if (!scope.ok) return // 没有卡/无法解析人格 → 宁可不提
    const svc = conflictService()
    if (!svc || typeof svc.list !== 'function') return // 没装熏习 → 静默跳过

    const p = (async () => {
      const res = await svc.list({ personaId: scope.personaId, limit: 5 })
      const rendered = renderConflictCards(res?.cards, { enabled: true })
      conflictState.resolve(sid, {
        turn,
        block: rendered.text,
        meta: { conflictIds: rendered.ids, n: rendered.cards, chars: rendered.chars },
      })
    })().catch(() => {
      conflictState.resolve(sid, { turn, block: '' })
    })
    conflictState.attach(sid, turn, p)
    p.then(() => { try { invalidateInjectCache() } catch { /* 忽略 */ } }).catch(() => {})
  }

  try {
    if (typeof ctx.on === 'function') {
      // 预取起点：回合开始（消息离开 inbox）
      ctx.on('agent/inbox/claimed', (payload) => {
        try { startAutoRecall(payload) } catch (e) {
          logOnce(`自动召回启动失败（不影响对话）：${String(e?.message || e)}`)
        }
        try { startConflictCards(payload) } catch (e) {
          logOnce(`冲突卡启动失败（不影响对话）：${String(e?.message || e)}`)
        }
      })
      // 注入点之前：最多等 waitMs，让首步也能拿到刚预取的结果
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        try {
          const cfg = liveCfg()
          // 宿主把 agent 放在 context 里（liangshen / 官方示例都从 context.agent 取）
          const sid = String(context?.agent?.session?.id || assembly?.agent?.session?.id || '')
          if (cfg.autoRecall && cfg.injectEnabled) {
            const waitMs = Math.max(0, Number(cfg.autoRecallWaitMs) || 0)
            if (sid && waitMs) await autoState.waitFor(sid, waitMs)
          }
          if (cfg.conflictCard && cfg.injectEnabled && sid) {
            await conflictState.waitFor(sid, 300) // 本地读盘，硬上限；等不到就当没有
          }
        } catch { /* 等不到就按没有记忆处理 */ }
        return next()
      })
    }
  } catch (e) {
    log(`自动召回事件监听注册失败（不影响注入）：${String(e?.message || e)}`)
  }
  let sectionsRegistered = false
  function ensureInjectSections() {
    if (sectionsRegistered) return { ok: true, already: true }
    if (typeof ctx.systemPrompt?.section !== 'function') {
      log('宿主没有 systemPrompt —— 注入接管不可用')
      return { ok: false, code: 'NO_SYSTEM_PROMPT' }
    }
    const c0 = liveCfg()
    try {
      disposers.push(ctx.systemPrompt.section({
        name: 'jianmu:persona',
        order: Number(c0.injectPersonaOrder) || 0,
        // 动态块（自动召回/冲突卡）只由记忆段「取用」一次；人格段不消费，避免把块吞掉
        text: (assembly) => buildInjection(assembly, { consumeDynamic: false }).persona,
      }))
      disposers.push(ctx.systemPrompt.section({
        name: 'jianmu:memory',
        order: Number.isFinite(Number(c0.injectMemoryOrder)) ? Number(c0.injectMemoryOrder) : 0.5,
        text: (assembly) => buildInjection(assembly, { consumeDynamic: true }).memory,
      }))
      sectionsRegistered = true
      log('注入段已注册：jianmu:persona / jianmu:memory（soul-md 应已关闭注入）')
      return { ok: true, registered: true }
    } catch (e) {
      log(`注入段注册失败：${String(e?.message || e)}`)
      return { ok: false, code: 'SECTION_REGISTER_FAILED', message: String(e?.message || e) }
    }
  }
  const invalidateInjectCache = () => injectCache.clear()
  /** 建木自己的记忆根（工具写、预览读、注入读，三处必须是同一个） */
  const jianmuMemoryRoot = () => join(dataRoot(), 'persona', 'memory')
  /** 记忆 scope 也要过安全名：防 `../` 之类别名把读写带出 persona/memory（topic 早就过了） */
  const safeScope = (scope) => safeMemoryName(String(scope ?? ''), 'global')
  /** 宿主给的 workspace 可能是字符串，也可能是对象（{path|root|cwd}）；String(对象) 会得到 [object Object] 并静默退默认卡 */
  const pickWorkspace = (assembly) => {
    const raw = assembly?.agent?.workspace
    if (raw && typeof raw === 'object') return String(raw.path || raw.root || raw.cwd || raw.dir || '')
    if (typeof raw === 'string' && raw) return raw
    const h = assembly?.agent?.session?.header || {}
    return String(h.cwd || h.workspace || '')
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => {
    const checked = checkToolName(spec.name)
    if (!checked.ok) throw new Error(`[memory-persona] 工具名违反守卫：${checked.problems.join('；')}`)
    registeredNames.push(spec.name)
    const dispose = ctx.tools.register(defineTool({
      ...spec,
      output: textOutput,
      async execute(args, exec) {
        const cfg = liveCfg()
        if (!cfg.enabled) return { ok: false, code: 'DISABLED', note: '镜台在设置里已关闭（dsh-memory-persona → 总开关）' }
        try {
          return safe(await spec.execute(args || {}, exec, cfg))
        } catch (e) {
          return safe({ ok: false, ...toErrInfo(e), hint: '先跑 status 看状态；不要重试覆盖已有数据' })
        }
      },
      isConcurrencySafe: () => !/_(create|save|delete|set_default|bind|rollback|import)$/.test(spec.name),
    }))
    disposers.push(dispose)
    return dispose
  }

  const caller = (exec) => {
    try {
      return {
        sessionId: exec?.agent?.session?.id ?? null,
        workspace: exec?.agent?.session?.header?.cwd ?? null,
      }
    } catch { return { sessionId: null, workspace: null } }
  }

  /** 读/写工具共用：显式 cardId 优先；否则按会话 → 工作区 → 默认卡解析 */
  const resolveCallerCard = async (args, exec) => {
    if (args.cardId) return { ok: true, cardId: String(args.cardId), source: 'explicit' }
    const info = caller(exec)
    return resolveCardId(dataRoot(), { workspace: args.workspace || info.workspace, sessionId: info.sessionId })
  }

  const requireExpand = (cfg) => {
    if (!cfg.expandEnabled) return { ok: false, code: 'DISABLED', note: 'AI 生成已在设置里关闭（expandEnabled=false）' }
    return null
  }

  // ── 1. status ──────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_status',
    description: '镜台·状态：卡数/版本/来源/锁/generation/错误；deep=true 跑完整性检查。只读。',
    parameters: {
      deep: { type: 'boolean', description: '顺带跑完整性检查（hash/版本链/孤儿）' },
    },
    async execute(args, exec, cfg) {
      return apiStatus({ dataRoot: dataRoot(), ctx, deep: Boolean(args.deep), profile: cfg.profile, config: cfg })
    },
  })

  // ── 2. list ────────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_list',
    description: '镜台·卡片列表：id/name/personaId/source/version/isDefault。只读。',
    parameters: {},
    async execute() {
      return apiCards({ dataRoot: dataRoot() })
    },
  })

  // ── 3. card ────────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_card',
    description: '镜台·读卡：front-matter + 正文 + 分区 + 分区 hash。只读。',
    parameters: {
      cardId: { type: 'string', description: '卡片 id（不填按工作区/默认卡解析）' },
      workspace: { type: 'string', description: '用于解析默认卡的工作区路径（可选）' },
    },
    async execute(args, exec) {
      const c = await resolveCallerCard(args, exec)
      if (!c.ok) return c
      return apiCard({ dataRoot: dataRoot(), cardId: c.cardId })
    },
  })

  // ── 4. versions ────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_versions',
    description: '镜台·版本列表（新→旧；标出快照是否在位）。只读。',
    parameters: {
      cardId: { type: 'string', description: '卡片 id（不填按工作区/默认卡解析）' },
    },
    async execute(args, exec) {
      const c = await resolveCallerCard(args, exec)
      if (!c.ok) return c
      return apiVersions({ dataRoot: dataRoot(), cardId: c.cardId })
    },
  })

  // ── 5. diff ────────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_diff',
    description: '镜台·两版 diff（行级；from/to 可为 revision 或 current）。只读。',
    parameters: {
      cardId: { type: 'string', description: '卡片 id（不填按工作区/默认卡解析）' },
      from: { type: 'number', description: '旧版本 revision（默认 1）' },
      to: { type: 'string', description: '新版本 revision 或 current（默认 current）' },
    },
    async execute(args, exec) {
      const c = await resolveCallerCard(args, exec)
      if (!c.ok) return c
      return apiDiff({ dataRoot: dataRoot(), cardId: c.cardId, from: args.from ?? 1, to: args.to ?? 'current' })
    },
  })

  // ── 6. create ──────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_create',
    description: [
      '镜台·新建卡：v1a 一卡一人格（cardId = personaId = memoryScope）。',
      '必须带 confirm=true；persona 不在 identity.json 也能建，但会返回警告（无记忆 scope）。',
      '不自动设为默认卡。',
    ].join('\n'),
    parameters: {
      cardId: { type: 'string', description: '卡片 id（白名单 [a-z0-9][a-z0-9_-]{0,63}）', required: true },
      name: { type: 'string', description: '显示名（默认取 identity.displayName）' },
      content: { type: 'string', description: '可选：直接给正文；不给则用固定四段模板' },
      expectedGeneration: { type: 'number', description: '当前 generation（先 status 读）', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
    },
    async execute(args) {
      return createCard({
        dataRoot: dataRoot(), cardId: args.cardId, name: args.name,
        personaId: args.personaId || args.cardId, memoryScope: args.memoryScope || args.cardId,
        content: args.content, expectedGeneration: args.expectedGeneration, confirm: Boolean(args.confirm),
      })
    },
  })

  // ── 7. save ────────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_save',
    description: [
      '镜台·保存：备份 + version+1 + diff 可查 + 写后读回。',
      '给 content（完整正文）或 behavior/style（只替换对应分区）。',
      '身份/红线 hash 变化 → IMMUTABLE_SECTION_CHANGED；AI 草稿需二次确认时传 allowProtectedSectionsChange=true。',
      '必须带 expectedGeneration + confirm=true。',
    ].join('\n'),
    parameters: {
      cardId: { type: 'string', description: '卡片 id（不填按工作区/默认卡解析）' },
      content: { type: 'string', description: '完整卡正文（Markdown，可带 front-matter）' },
      behavior: { type: 'string', description: '只替换「行为准则」分区的正文（含标题）' },
      style: { type: 'string', description: '只替换「风格示例」分区的正文（含标题）' },
      note: { type: 'string', description: '版本备注（AI 草稿建议写 provider/model/token）' },
      author: { type: 'string', description: '版本作者：user（默认）/ ai-expand（保存 AI 草稿时）', enum: ['user', 'ai-expand'] },
      expectedGeneration: { type: 'number', description: '当前 generation', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
      allowProtectedSectionsChange: { type: 'boolean', description: '仅 AI 草稿二次确认：允许改身份/红线（仍写新版本、可回滚）' },
    },
    async execute(args, exec) {
      const c = await resolveCallerCard(args, exec)
      if (!c.ok) return c
      return saveCard({
        dataRoot: dataRoot(),
        cardId: c.cardId,
        content: args.content,
        behavior: args.behavior,
        style: args.style,
        note: args.note,
        author: args.author === 'ai-expand' ? 'ai-expand' : 'user',
        expectedGeneration: args.expectedGeneration,
        confirm: Boolean(args.confirm),
        allowProtectedSectionsChange: Boolean(args.allowProtectedSectionsChange),
      })
    },
  })

  // ── 8. delete ──────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_delete',
    description: '镜台·删除卡：移入 persona/_deleted/（不物理删）；默认卡不能删。必须带 expectedGeneration + confirm=true。',
    parameters: {
      cardId: { type: 'string', description: '卡片 id', required: true },
      expectedGeneration: { type: 'number', description: '当前 generation', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
    },
    async execute(args) {
      return deleteCard({ dataRoot: dataRoot(), cardId: args.cardId, expectedGeneration: args.expectedGeneration, confirm: Boolean(args.confirm) })
    },
  })

  // ── 9. set_default ─────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_set_default',
    description: '镜台·设默认卡；cardId=none = 全局不注入。必须带 confirm=true。',
    parameters: {
      cardId: { type: 'string', description: '卡片 id 或 none', required: true },
      expectedGeneration: { type: 'number', description: '当前 generation', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
    },
    async execute(args) {
      return setDefaultCard({ dataRoot: dataRoot(), cardId: args.cardId, expectedGeneration: args.expectedGeneration, confirm: Boolean(args.confirm) })
    },
  })

  // ── 10. bind ───────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_bind',
    description: '镜台·绑定：工作区/会话 → 卡（或 none；cardId 传空字符串=删除绑定）。必须带 confirm=true。',
    parameters: {
      scope: { type: 'string', description: 'workspace / session', enum: ['workspace', 'session'], required: true },
      key: { type: 'string', description: '工作区路径或会话 id', required: true },
      cardId: { type: 'string', description: '卡片 id / none / 空字符串（删除绑定）', required: true },
      expectedGeneration: { type: 'number', description: '当前 generation', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
    },
    async execute(args) {
      return bindCard({
        dataRoot: dataRoot(), scope: args.scope, key: args.key, cardId: args.cardId,
        expectedGeneration: args.expectedGeneration, confirm: Boolean(args.confirm),
      })
    },
  })

  // ── 11. rollback ───────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_rollback',
    description: '镜台·回滚到某 revision：历史快照写成新版本（不删当前）。必须带 expectedGeneration + confirm=true。',
    parameters: {
      cardId: { type: 'string', description: '卡片 id（不填按工作区/默认卡解析）' },
      revision: { type: 'number', description: '要回滚到的 revision', required: true },
      expectedGeneration: { type: 'number', description: '当前 generation', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
    },
    async execute(args, exec) {
      const c = await resolveCallerCard(args, exec)
      if (!c.ok) return c
      return rollbackCard({
        dataRoot: dataRoot(), cardId: c.cardId, revision: args.revision,
        expectedGeneration: args.expectedGeneration, confirm: Boolean(args.confirm),
      })
    },
  })

  // ── 12. import ─────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_import',
    description: [
      '镜台·从 soul-md 导入（只读源；v1a 不覆盖已有卡）。',
      '卡名按 identity.displayName 映射到 personaId；映射不到会跳过并报告。',
      '必须带 expectedGeneration + confirm=true。',
    ].join('\n'),
    parameters: {
      mapping: { type: 'object', description: '卡名 → personaId 的显式映射（可选）', additionalProperties: true },
      importBindings: { type: 'boolean', description: '是否导入默认卡/工作区/会话绑定（默认 true）' },
      preserveLocalBindings: { type: 'boolean', description: '已存在的本地绑定不覆盖（默认 true）' },
      expectedGeneration: { type: 'number', description: '当前 generation', required: true },
      confirm: { type: 'boolean', description: '写动作确认', required: true },
    },
    async execute(args, exec, cfg) {
      const soul = await resolveSoulMdConfig(ctx, { profile: cfg.profile })
      if (!soul.ok) return { ok: false, code: soul.code || 'SOULMD_UNAVAILABLE', error: soul.error }
      return importFromSoulMd({
        dataRoot: dataRoot(),
        config: soul.config,
        rawConfig: soul.raw ?? null,
        profileFile: profilePatchFile(cfg.profile),
        sourceLabel: soul.resolvedFrom,
        mapping: args.mapping && typeof args.mapping === 'object' ? args.mapping : {},
        importBindings: args.importBindings !== false,
        preserveLocalBindings: args.preserveLocalBindings !== false,
        expectedGeneration: args.expectedGeneration,
        confirm: Boolean(args.confirm),
      })
    },
  })

  // ── 13. expand（AI 生成；不保存） ──────────────────────────────────────
  tool({
    name: 'jianmu_persona_expand',
    description: [
      '镜台·AI 生成人设：一句种子 → 整卡草稿；**只返回草稿，不写盘**。',
      '一个按钮、一次调用；不自动保存、不自动演化。',
      '老卡也能用：把现有正文放 existingContent，结果只改草稿。',
      '编辑框已有内容时必须先确认（confirmOverwrite=true）。',
      '扫描红 → 拒绝返回草稿；失败不返回半成品。',
    ].join('\n'),
    parameters: {
      seed: { type: 'string', description: '编辑框全文（种子）', required: true },
      cardId: { type: 'string', description: '可选：老卡 id（用于标记保护分区基线）' },
      existingContent: { type: 'string', description: '可选：现有人格卡正文（老卡生成时传）' },
      name: { type: 'string', description: '角色名（可选）' },
      confirmOverwrite: { type: 'boolean', description: '编辑框已有内容时确认替换草稿（不落盘）' },
    },
    async execute(args, exec, cfg) {
      const off = requireExpand(cfg)
      if (off) return off
      const info = caller(exec)
      let existingCard = null
      if (args.cardId) {
        const c = await apiCard({ dataRoot: dataRoot(), cardId: args.cardId })
        if (c.ok) existingCard = c.body
      }
      return expandPersona({
        ctx,
        sessionId: info.sessionId,
        seed: args.seed,
        existingContent: args.existingContent,
        existingCard,
        name: args.name,
        confirmOverwrite: Boolean(args.confirmOverwrite),
        cfg,
      })
    },
  })

  // ── 14. preview ────────────────────────────────────────────────────────
  tool({
    name: 'jianmu_persona_preview',
    description: '镜台·注入预览：soul-md 当前会注入的人格 + 记忆段（字符/token/截断原因）。只读，不触发注入。',
    parameters: {
      cardId: { type: 'string', description: '可选：按镜台卡片名预览（不填则按工作区/会话解析 soul-md 卡）' },
      workspace: { type: 'string', description: '工作区路径（可选）' },
    },
    async execute(args, exec, cfg) {
      const info = caller(exec)
      return apiPreview({
        dataRoot: dataRoot(), cardId: args.cardId || null,
        workspace: args.workspace || info.workspace, sessionId: info.sessionId,
        ctx, profile: cfg.profile, jianmuConfig: cfg,
      })
    },
  })

  // ── 15. settings（v2 可写：写 registry.settings） ──────────────────────
  tool({
    name: 'jianmu_persona_settings',
    description: '镜台·注入设置：不传 patch = 读当前有效值（含可写字段与合法区间）；传 patch = 写镜台 registry.settings（需 expectedGeneration + confirm=true）。只写 <dataRoot>/persona/，不碰 soul-md 与 profile 配置。',
    parameters: {
      patch: {
        type: 'object',
        description: '要改的字段（可省）：injectEnabled / injectMaxChars / 段顺序 / 压缩补偿 / P2 自动召回（autoRecall、autoRecallMinScore、autoRecallTopN、autoRecallMaxChars、autoRecallDeadlineMs、autoRecallWaitMs、autoRecallCooldownMs、autoRecallCues、autoRecallLabOnly、autoRecallLabWorkspaces）/ P2.5 冲突卡（conflictCard）',
        additionalProperties: true,
      },
      expectedGeneration: { type: 'number', description: '写动作必填：先读 status.generation' },
      confirm: { type: 'boolean', description: '写动作必填 true（不传=只预览将要改什么）' },
    },
    async execute(args, exec, cfg) {
      if (args.patch === undefined) {
        return apiSettings({ dataRoot: dataRoot(), ctx, profile: cfg.profile, config: liveCfg() })
      }
      // 先校验字段/取值（预览也要拦：别让人以为「能改」，结果 confirm 时才被拒）
      const checked = validateSettingsPatch(args.patch)
      if (!checked.ok) return checked
      // 未确认：只回「将要改什么」，不落盘
      if (args.confirm !== true) {
        const cur = await apiSettings({ dataRoot: dataRoot(), ctx, profile: cfg.profile, config: liveCfg() })
        const values = cur?.jianmu?.values || {}
        const willChange = Object.entries(checked.value)
          .filter(([k, v]) => values[k] !== v)
          .map(([k, v]) => ({ key: k, from: values[k] ?? null, to: v }))
        return {
          ok: true, preview: true, willChange,
          current: { generation: cur?.generation ?? null, settingsRevision: cur?.jianmu?.settingsRevision ?? null, values },
          note: '预览：传 confirm=true（并带 expectedGeneration）才会真正写进 registry.settings',
        }
      }
      const before = liveCfg()
      const r = await saveSettings({
        dataRoot: dataRoot(), patch: args.patch, expectedGeneration: args.expectedGeneration, confirm: true,
      })
      if (!r.ok) return r
      // 设置变了：清渲染缓存（否则最多 injectCacheMs 内还是旧内容）；打开接管时补注册注入段
      invalidateInjectCache()
      let sections = { ok: true, already: true }
      if (r.settings?.injectEnabled) sections = ensureInjectSections()
      const after = liveCfg()
      return {
        ...r,
        effective: {
          injectEnabled: Boolean(after.injectEnabled),
          injectMaxChars: Number(after.injectMaxChars),
          injectPersonaOrder: Number(after.injectPersonaOrder),
          injectMemoryOrder: Number(after.injectMemoryOrder),
          injectCacheMs: Number(after.injectCacheMs),
          cardSource: String(after.cardSource || 'jianmu'),
          memoryLayered: after.memoryLayered !== false,
          memoryIndexMode: String(after.memoryIndexMode || 'all'),
          subagentSkip: after.subagentSkip === true,
          recallMaxTopics: Number(after.recallMaxTopics) || 8,
          recallMaxChars: Number(after.recallMaxChars) || 1600,
          compactionRecall: after.compactionRecall === true,
          autoRecall: after.autoRecall === true,
          autoRecallMinScore: Number(after.autoRecallMinScore) || 0.62,
          autoRecallTopN: Number(after.autoRecallTopN) || 2,
          autoRecallMaxChars: Number(after.autoRecallMaxChars) || 320,
          autoRecallDeadlineMs: Number(after.autoRecallDeadlineMs) || 800,
          autoRecallWaitMs: Number.isFinite(Number(after.autoRecallWaitMs)) ? Number(after.autoRecallWaitMs) : 800,
          autoRecallCooldownMs: Number(after.autoRecallCooldownMs) || 60000,
          autoRecallLabOnly: after.autoRecallLabOnly !== false,
          conflictCard: after.conflictCard === true,
          maxBytes: Number(after.maxBytes) || 262144,
        },
        previousEffective: {
          injectEnabled: Boolean(before.injectEnabled),
          injectMaxChars: Number(before.injectMaxChars),
        },
        sections,
        note: r.noop ? '值没有变化，未占用 generation' : '已写入 registry.settings；injectMaxChars / injectCacheMs 当场生效，段顺序需重启生效',
      }
    },
  })

  // ── 16-18. 记忆读写（建木自治：只写 <dataRoot>/persona/memory/） ──────
  const memoryRootDir = jianmuMemoryRoot
  const readTextSafe = async (file) => {
    try { return await readFile(file, 'utf8') } catch { return null }
  }
  async function resolveMemoryScope(args, exec) {
    if (args.scope) return String(args.scope)
    // 2026-11-09：记忆工具与卡工具统一解析链（显式 cardId → 会话 → 工作区 → 默认卡）。
    // 旧写法只读 registry.activeCardId，工作区绑定（registry.workspaces）完全没被用上：
    // activeCardId 为空时静默落到 'global'（空目录），有值时又会让 QQ 侧的Bob串到Alice。
    // 症状与 2026-11-08 那条 c.card.frontMatter 不同，但同样是「不报错、落错库」。
    const rid = await resolveCallerCard(args, exec)
    const cardId = rid?.ok ? rid.cardId : null
    if (cardId) {
      const c = await readCard(dataRoot(), cardId)
      // ⚠️ readCard 返回的是**扁平**结构 { ok, frontMatter, body, ... }，没有 .card 这一层。
      //    2026-11-08 写成 c.card.frontMatter → 永远回退到英文 cardId，表现为
      //    「scope=alice、0 个 topic」，且不报错（两次重启都没暴露）。
      const fm = c?.frontMatter || c?.card?.frontMatter || null
      return c.ok ? (fm?.name || fm?.memoryScope || cardId) : cardId
    }
    // 解析不到卡时才退 global；这是显式兜底，不再当成正常路径。
    return 'global'
  }

  tool({
    name: 'jianmu_persona_memory_list',
    description: '镜台·记忆列表：列建木记忆目录（<dataRoot>/persona/memory/<scope>/topics）下的主题，返回 key/标题/摘要，不读正文。只读。scope 默认按「会话→工作区→默认卡」解析出人格卡，取其**显示名**（front-matter.name，记忆目录用的就是它）。',
    parameters: {
      scope: { type: 'string', description: '记忆作用域（默认按会话→工作区→默认卡解析；记忆目录名=卡显示名）' },
      cardId: { type: 'string', description: '按镜台卡片 id 解析作用域（可选）' },
    },
    async execute(args, exec) {
      const scope = await resolveMemoryScope(args, exec)
      const topics = listTopicsInScope(safeScope(scope), memoryRootDir())
      return {
        ok: true,
        root: memoryRootDir(),
        scope,
        count: topics.length,
        topics: topics.map((t) => ({ key: t.key, title: t.title, summary: t.summary })),
        note: topics.length ? null : '该作用域还没有 topic（先 memory_append 写一个）',
      }
    },
  })

  tool({
    name: 'jianmu_persona_memory_read',
    description: '镜台·记忆读取：读建木记忆目录里的某个 topic 正文（或 core.md）。只读。',
    parameters: {
      topic: { type: 'string', description: '主题 key（文件名，不含 .md）；不填 = 读 core.md' },
      scope: { type: 'string', description: '记忆作用域（默认按会话→工作区→默认卡解析；记忆目录名=卡显示名）' },
      cardId: { type: 'string', description: '按镜台卡片 id 解析作用域（可选）' },
    },
    async execute(args, exec) {
      const scope = await resolveMemoryScope(args, exec)
      const root = join(memoryRootDir(), safeScope(scope))
      const file = args.topic ? join(root, 'topics', `${safeMemoryName(String(args.topic), 'topic')}.md`) : join(root, 'core.md')
      const text = await readTextSafe(file)
      if (text === null) return { ok: false, code: 'MEMORY_NOT_FOUND', error: { code: 'MEMORY_NOT_FOUND', message: `读不到：${file}` } }
      // 记下「本会话读过哪个 topic」（只存描述，不存正文），供压缩后补偿使用。
      if (args.topic) {
        const sid = String(exec?.agent?.session?.id ?? '')
        if (sid) {
          const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || ''
          recallStore.reportConsulted(sid, {
            source: scope,
            key: String(args.topic),
            title: String(args.topic),
            summary: firstLine.slice(0, 120),
          })
        }
      }
      return { ok: true, scope, file, chars: text.length, text }
    },
  })

  tool({
    name: 'jianmu_persona_memory_append',
    description: '镜台·记忆写入：向建木记忆目录追加一段（topic 不存在则新建）。**core.md 只能手工维护，本工具不写 core**；topic 必填。写前扫描注入红项；confirm=false 只预览。只写 <dataRoot>/persona/memory/。',
    parameters: {
      topic: { type: 'string', description: '主题 key（文件名），必填；不能用 core（core.md 只能手工维护）', required: true },
      text: { type: 'string', description: '要追加的 Markdown 文本（建议首行「日期 — 结论」）', required: true },
      scope: { type: 'string', description: '记忆作用域（默认按会话→工作区→默认卡解析；记忆目录名=卡显示名）' },
      cardId: { type: 'string', description: '按镜台卡片 id 解析作用域（可选）' },
      confirm: { type: 'boolean', description: '确认写入（false/不传 = 只预览）' },
    },
    async execute(args, exec) {
      const text = String(args.text || '').trim()
      if (!text) return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'text 必填' } }
      // 2026-11-09：core.md 只归用户/姐姐手工维护。
      // 旧行为「不带 topic = 追加 core」让任何通道都能把 core 撑爆、也绕开 core 的合并纪律
      // （core 有硬上限，写前要走 core_guard）；与 QQ 侧 mcp-bob-memory 的「禁 core」对齐。
      const topicArg = args.topic == null ? '' : String(args.topic).trim()
      if (!topicArg) {
        return {
          ok: false, code: 'CORE_READONLY',
          error: { code: 'CORE_READONLY', message: 'core.md 只能手工维护：memory_append 必须指定 topic（想记什么就写进对应主题）' },
        }
      }
      if (/^core(\.md)?$/i.test(topicArg)) {
        return {
          ok: false, code: 'CORE_READONLY',
          error: { code: 'CORE_READONLY', message: 'core.md 只能手工维护：请改用具体主题名（topic），不要写 core' },
        }
      }
      const scope = await resolveMemoryScope(args, exec)
      const root = join(memoryRootDir(), safeScope(scope))
      const file = join(root, 'topics', `${safeMemoryName(topicArg, 'topic')}.md`)
      guardWrite(dataRoot(), file)
      const scan = scanText(text, 'jianmu_persona_memory_append')
      if (scan.hits?.some((h) => h.level === 'red')) {
        return { ok: false, code: 'SCAN_RED', error: { code: 'SCAN_RED', message: '文本命中注入/敏感红项，拒绝写入', hints: scan.hits.filter((h) => h.level === 'red') } }
      }
      const existing = (await readTextSafe(file)) ?? ''
      const before = existing.length
      // maxBytes 守卫（2026-11-08）：写入后文件超过上限就拒绝，提示先合并/精简。
      const maxBytes = Number(liveCfg().maxBytes) || 262144
      const nextText = existing ? existing.replace(/\s*$/, '') + '\n\n' + text + '\n' : text + '\n'
      const nextBytes = Buffer.byteLength(nextText, 'utf8')
      if (nextBytes > maxBytes) {
        return {
          ok: false, code: 'MEMORY_TOO_LARGE',
          error: {
            code: 'MEMORY_TOO_LARGE',
            message: `写入后 ${nextBytes} 字节，超过单文件上限 ${maxBytes} 字节：请先精简/合并该文件，或在设置里调大「记忆文件大小上限」`,
          },
        }
      }
      if (args.confirm !== true) {
        return { ok: true, preview: true, scope, file, beforeChars: before, wouldBecome: before + 2 + text.length, nextBytes, maxBytes, note: '预览：传 confirm=true 才写' }
      }
      await ensureDir(dirname(file))
      await atomicWrite(file, nextText)
      const back = (await readTextSafe(file)) ?? ''
      return {
        ok: true, written: true, scope, file,
        beforeChars: before, afterChars: back.length,
        verified: back.includes(text),
      }
    },
  })

  // ── P4 #10：硬认领（2026-11-13）───────────────────────────────────────
  tool({
    name: 'jianmu_persona_claim_hard',
    description: [
      '镜台·硬认领：把 persona_unassigned 里指定「工作区 / 会话」的原话块**真搬到**目标人格，',
      '连向量、熏习 state、年轮 claim 一起搬；可预览、可备份、可回滚。',
      '默认只预览（dryRun）；真写必须 confirm=true + expectedGeneration（目标已存在时）。',
      '只做 persona_unassigned → 已声明人格；不做人格→人格；不重嵌；不自动触发。',
      '回滚：传 rollbackBackup（上次返回的 journal.json 路径）+ confirm=true。',
    ].join('\n'),
    parameters: {
      from: { type: 'string', description: `源人格（只能是 persona_unassigned，默认）` },
      to: { type: 'string', description: '目标人格（必须在 identity.personas 里已声明；建议先有镜台卡）' },
      workspace: { type: 'string', description: '按工作区精确前缀选块（与 sessionIds 二选一）' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: '按会话 id 列表选块（与 workspace 二选一）' },
      dryRun: { type: 'boolean', description: 'true = 只预览（默认）；false + confirm=true 才真写' },
      confirm: { type: 'boolean', description: '真写/回滚确认' },
      expectedGeneration: { type: 'number', description: '目标 scope manifest.generation（并发闸门；目标已存在时必填）' },
      rollbackBackup: { type: 'string', description: '回滚模式：上次返回的 journal.json 或其目录（传了就只回滚）' },
    },
    async execute(args) {
      const root = dataRoot()
      const rollbackBackup = args.rollbackBackup ? String(args.rollbackBackup) : ''
      if (rollbackBackup) {
        return hardClaimRollback({ dataRoot: root, ctx, rollbackBackup, confirm: args.confirm === true })
      }
      const from = args.from ? String(args.from) : 'persona_unassigned'
      const to = args.to ? String(args.to) : ''
      if (!to) return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'to 必填（目标人格）' } }
      const workspace = args.workspace == null || args.workspace === '' ? null : String(args.workspace)
      const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds.map(String) : null
      if (args.dryRun !== false) {
        return hardClaimPreview({ dataRoot: root, ctx, from, to, workspace, sessionIds })
      }
      if (args.confirm !== true) {
        return { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '真写必须 confirm=true（想先看数字就把 dryRun 留空/设 true）' } }
      }
      return hardClaimApply({
        dataRoot: root, ctx, from, to, workspace, sessionIds,
        expectedGeneration: args.expectedGeneration == null ? null : Number(args.expectedGeneration),
        confirm: true,
      })
    },
  })

  // ── 工具面守卫（按实际注册名校验） ─────────────────────────────────────
  const surface = checkToolSurface(registeredNames)
  if (!surface.ok) {
    for (const d of disposers) { try { d?.() } catch { /* ignore */ } }
    throw new Error(`[memory-persona] 工具面守卫未通过：${surface.problems.join('；')}`)
  }

  // ── host 只读服务 ──────────────────────────────────────────────────────
  const service = {
    status: (opts = {}) => apiStatus({ dataRoot: dataRoot(), ctx, deep: Boolean(opts.deep), profile: liveCfg().profile, config: liveCfg() }),
    cards: () => apiCards({ dataRoot: dataRoot() }),
    card: (cardId) => apiCard({ dataRoot: dataRoot(), cardId }),
    versions: (cardId) => apiVersions({ dataRoot: dataRoot(), cardId }),
    diff: (cardId, from, to) => apiDiff({ dataRoot: dataRoot(), cardId, from, to }),
    registry: () => apiRegistry({ dataRoot: dataRoot() }),
    settings: () => apiSettings({ dataRoot: dataRoot(), ctx, profile: liveCfg().profile, config: liveCfg() }),
    preview: (opts = {}) => apiPreview({ dataRoot: dataRoot(), ctx, profile: liveCfg().profile, jianmuConfig: liveCfg(), ...opts }),
    importSources: () => apiImportSources({ dataRoot: dataRoot(), ctx, profile: liveCfg().profile }),
    resolveCard: (opts = {}) => resolveCardId(dataRoot(), opts),
  }
  if (typeof ctx.provide === 'function') {
    disposers.push(ctx.provide('jianmuPersona', service))
  } else {
    log('宿主没有 ctx.provide —— host 只读服务未注册（HTTP 路由不受影响）')
  }

  // ── HTTP 路由（GET 只读 + POST 写动作；v1a.1） ─────────────────────────
  const sendJson = (res, status, value) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(JSON.stringify(value))
  }

  const route = {
    kind: 'prefix',
    path: '/api/persona',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sub = url.pathname.slice('/api/persona'.length) || '/'

        // 写动作：CSRF/JSON 校验 + 白名单分发（守卫全在 lib/write.mjs）
        if (req.method === 'POST') {
          const out = await handleWriteRequest({
            req, sub, dataRoot: dataRoot(), ctx, cfg: liveCfg(), sessionId: null,
            hooks: {
              onSettingsSaved: (r) => {
                invalidateInjectCache()
                if (r?.settings?.injectEnabled) ensureInjectSections()
              },
            },
          })
          return sendJson(res, out.status, out.body)
        }
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET, POST')
          return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 GET（只读）与 POST（写动作）' } })
        }

        const query = Object.fromEntries(url.searchParams.entries())
        const cfg = liveCfg()

        if (sub === '/' || sub === '/status') {
          return sendJson(res, 200, await apiStatus({ dataRoot: dataRoot(), ctx, deep: query.deep === '1' || query.deep === 'true', profile: cfg.profile, config: cfg }))
        }
        if (sub === '/cards') return sendJson(res, 200, await apiCards({ dataRoot: dataRoot() }))
        if (sub === '/registry') return sendJson(res, 200, await apiRegistry({ dataRoot: dataRoot() }))
        if (sub === '/settings') return sendJson(res, 200, await apiSettings({ dataRoot: dataRoot(), ctx, profile: cfg.profile, config: cfg }))
        if (sub === '/import-sources') return sendJson(res, 200, await apiImportSources({ dataRoot: dataRoot(), ctx, profile: cfg.profile }))
        if (sub === '/card') {
          if (!query.cardId) return sendJson(res, 400, { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'cardId 必填' } })
          if (!isSafeCardId(query.cardId)) return sendJson(res, 400, { ok: false, code: 'BAD_CARD_ID', error: { code: 'BAD_CARD_ID', message: `cardId 非法：${query.cardId}` } })
          return sendJson(res, 200, await apiCard({ dataRoot: dataRoot(), cardId: query.cardId }))
        }
        if (sub === '/versions') {
          if (!query.cardId) return sendJson(res, 400, { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'cardId 必填' } })
          if (!isSafeCardId(query.cardId)) return sendJson(res, 400, { ok: false, code: 'BAD_CARD_ID', error: { code: 'BAD_CARD_ID', message: `cardId 非法：${query.cardId}` } })
          return sendJson(res, 200, await apiVersions({ dataRoot: dataRoot(), cardId: query.cardId }))
        }
        if (sub === '/diff') {
          if (!query.cardId) return sendJson(res, 400, { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'cardId 必填' } })
          if (!isSafeCardId(query.cardId)) return sendJson(res, 400, { ok: false, code: 'BAD_CARD_ID', error: { code: 'BAD_CARD_ID', message: `cardId 非法：${query.cardId}` } })
          return sendJson(res, 200, await apiDiff({ dataRoot: dataRoot(), cardId: query.cardId, from: query.from || 1, to: query.to || 'current' }))
        }
        if (sub === '/preview') {
          return sendJson(res, 200, await apiPreview({
            dataRoot: dataRoot(), cardId: query.cardId || null,
            workspace: query.workspace || null, sessionId: query.session || null,
            ctx, profile: cfg.profile, jianmuConfig: cfg,
          }))
        }
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知只读端点：${sub}` } })
      } catch (e) {
        return sendJson(res, 500, { ok: false, ...toErrInfo(e) })
      }
    },
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      const ws = sub?.webServer
      if (!ws || typeof ws.register !== 'function') return
      sub.effect(() => ws.register(route), 'memory-persona:read-route')
    })
  } else {
    const webServer = (() => { try { return ctx.get?.('webServer') } catch { return undefined } })()
    if (webServer && typeof webServer.register === 'function') {
      disposers.push(webServer.register(route))
    } else {
      log('宿主没有 webServer —— 只读 HTTP 路由未注册（host 服务仍可用）')
    }
  }

  // ── v2 注入接管 ────────────────────────────────────────────────────────
  // 2026-11-08 晚间：**摘除对 soul-md 的硬依赖**。
  // 以前一句 `if (!soul.ok) return 空` 意味着「卸载 soul-md = 注入归零」（静默变成无设定 AI）。
  // 现在：人格走 cardSource（jianmu 时只读镜台卡文件）；记忆走镜台自己的渲染参数；
  // soul-md 配置只作为「cardSource=soul-md」时的卡源，读不到就退化成空人格并写明原因。
  function buildInjection(assembly, { consumeDynamic = true } = {}) {
    const c = liveCfg()
    if (!c.injectEnabled) return { persona: '', memory: '' }
    // 子代理会话（DSH 用 origin: "subagent" 标记委派子会话）可跳过注入：
    // 子代理的工具仍按原工作区解析人设卡与记忆作用域，只是不再自动注入两段提示词。
    if (c.subagentSkip && assembly?.agent?.session?.header?.origin === 'subagent') {
      return { persona: '', memory: '' }
    }
    const ws = pickWorkspace(assembly)
    const sid = String(assembly?.agent?.session?.id || '')
    const key = `${ws}\0${sid}`
    const now = Date.now()
    const hit = injectCache.get(key)
    // 动态块（自动召回/冲突卡）开着时不走渲染缓存：结果异步到达，缓存会把「还没到」的空记忆钉住
    const dynamic = c.autoRecall || c.conflictCard
    if (!dynamic && hit && hit.at + Math.max(0, c.injectCacheMs) > now) return hit
    let soul = null
    try { soul = readSoulMdConfigFromServices(ctx) } catch { soul = null }
    const soulAvailable = Boolean(soul && soul.ok)
    const config = soulAvailable ? normalizeSoulMdConfig(soul.config) : null
    if (!soulAvailable) logOnce('soul-md 配置不可读（已禁用/卸载？）—— 人格指向镜台卡时不受影响')
    // 卡源：cardSource=soul-md（回退）或 jianmu（镜台卡真源）。
    // 与 apiPreview 共用 lib/injectsource.mjs —— 预览和实际注入必须是同一套解析。
    const src = resolvePersonaForInjection({
      dataRoot: dataRoot(), config, workspace: ws, sessionId: sid, cardSource: c.cardSource, soulAvailable,
    })
    if (src.fallbackReason) logOnce(src.fallbackReason)
    const name = src.name
    const persona = src.persona
    // 记忆：渲染参数由镜台 settings 决定（memoryRenderConfig），不再从 soul-md config 取；
    // 记忆根固定是建木自己的 <dataRoot>/persona/memory（工具写 / 预览读 / 注入读三处同源）。
    let memory = name
      ? renderSoulMdMemory(memoryRenderConfig(c), name, jianmuMemoryRoot()).text
      : ''
    // 压缩后补偿：只补「本会话读过哪些 topic」的描述行，不注入正文。
    if (memory && c.compactionRecall) {
      const rec = recallStore.takeRecovery(sid)
      if (rec.length) {
        const limit = boundedInteger(c.recallMaxTopics, 8, 20, 1)
        const remaining = Math.max(0, (Number(c.injectMaxChars) || 12000) - memory.length - 2)
        const cap = Math.min(remaining, boundedInteger(c.recallMaxChars, 1600, 8000, 200))
        const block = renderRecall([{
          heading: '压缩后曾查阅的主题 / Topics consulted before compaction（用 jianmu_persona_memory_read 取全文）:',
          topics: rec.slice(-limit),
        }], cap)
        if (block) memory += '\n\n' + block
      }
    }
    // P2 自动召回：命中才附一小段（预算独立，不占 injectMaxChars）；未就绪/未命中 = 空
    if (consumeDynamic && c.autoRecall) {
      const block = autoState.render(sid)
      if (block) memory = memory ? `${memory}\n\n${block}` : block
    }
    // P2.5 冲突卡：只提示「两种说法并存」，不裁决；整卡放不下就不注入
    if (consumeDynamic && c.conflictCard) {
      const block = conflictState.take(sid)
      if (block) {
        const meta = conflictState.peek(sid)?.meta || {}
        memory = memory ? `${memory}\n\n${block}` : block
        appendConflictLog(renderConflictLogRow({
          sid, n: meta.n, chars: block.length, conflictIds: meta.conflictIds, outcome: 'injected',
        }))
      }
    }
    const val = {
      at: now, persona, memory,
      cardSource: src.personaSource, cardId: src.cardId, scope: name, soulAvailable,
    }
    if (dynamic) return val // 异步场景不缓存（见上）
    if (injectCache.size > 32) injectCache.clear()
    injectCache.set(key, val)
    return val
  }
  if (typeof ctx.systemPrompt?.section === 'function') {
    // 挂载时只有「已开启接管」才注册；关着的话要等设置里打开再懒注册（或重启）
    if (liveCfg().injectEnabled) ensureInjectSections()
    else log('injectEnabled=false —— 注入段未注册（soul-md 继续注入；设置里打开接管会当场补注册）')
  } else {
    log('宿主没有 systemPrompt —— 注入接管不可用')
  }

  // 挂载期的路径自检只用于日志：dataRoot 不合法时**不能**让整个插件挂掉
  // （真写入仍由 assertPersonaWritable / personaRoot 在调用时硬拦）。
  let writableWhere = '(未知)'
  try { writableWhere = personaRoot(dataRoot()) }
  catch (e) { writableWhere = `dataRoot 不可用：${String(e?.message || e)}` }
  log(`已注册 ${disposers.length} 个资源（工具 ${registeredNames.length}；版本 ${VERSION}；唯一可写区 ${writableWhere}）`)
  const dispose = () => {
    for (const d of disposers) { try { d?.() } catch { /* ignore */ } }
  }
  dispose.toolNames = [...registeredNames]
  return dispose
}

export { defaultDataRoot, personaRoot, isSafeCardId }
