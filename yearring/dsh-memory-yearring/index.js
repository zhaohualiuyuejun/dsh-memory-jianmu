/**
 * dsh-memory-yearring —— 年轮（建木 · 认知层）host 半端
 * ============================================================================
 * 只做一件事：从根藏原话里提炼「带原话锚点」的 claim，并把它们拼成 topic 正文。
 *
 * 明确不做（契约 v1）：
 *   ❌ 不改原文 / 不注入 / 不检索 / 不做自动演化
 *   ❌ 不写 scopes/ process/ persona/ soul-md
 *   ❌ 默认零自动 LLM 调用（run 必须 dryRun 预览 + confirm=true）
 *
 * 工具面：jianmu_year_{status,topics,claim,run,rebuild,verify,export}
 * 数据布局：<dataRoot>/year/<personaId>/{claims.jsonl,manifest.json,runs.jsonl,topic_docs/,_archive/}
 * ============================================================================
 */
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { defaultDataRoot, isSafePersonaId, PERSONA_UNASSIGNED, yearDir } from './lib/paths.mjs'
import { checkToolName, checkToolSurface } from './lib/guards.mjs'
import { VERSION, ALLOWED_TOOLS, KINDS, STATUSES, EPISTEMIC } from './lib/version.mjs'
import { readIdentity, listScopes } from './lib/root.mjs'
import { runYear } from './lib/extract.mjs'
import { rebuildTopicDocs } from './lib/topicdocs.mjs'
import { verifyYear } from './lib/verify.mjs'
import { exportYear } from './lib/export.mjs'
import {
  apiContext, apiStatus, apiTopics, apiClaims, apiClaim, apiVerify,
} from './lib/api.mjs'
import { toErrInfo } from './lib/errors.mjs'
import { previewMoveClaims, moveClaims, rebuildAfterMove, rollbackMoveClaims } from './lib/hardclaim.mjs'
import { makeStarmapRoute } from './lib/starmap-routes.mjs'

const STARMAP_UI_DIR = fileURLToPath(new URL('./starmap-ui/', import.meta.url))

const WRITE_TOOLS = new Set(['jianmu_year_run', 'jianmu_year_rebuild'])

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'memory-yearring'
export const inject = ['tools']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true)
    .description('总开关：关掉后工具只回一句「已关闭」'),
  dataRoot: z.string().default('').extra('volatile', true)
    .description('根藏数据根；年轮只读 <dataRoot>/scopes 与 process，只写 <dataRoot>/year/<personaId>'),
  archiveDir: z.string().default('').extra('volatile', true)
    .description('归档目录（建议放别的盘）：topic_docs 重建快照移到这里，C 盘只留正在用的；留空 = 只保留最近 2 份并自动清理'),
  writeEnabled: z.boolean().default(true).extra('volatile', true)
    .description('写总闸：关掉后 run/rebuild 拒绝执行（只读查询照常）'),
  llmProvider: z.string().default('deepseek-account').extra('volatile', true)
    .description('run 时用的模型路由（provider）'),
  llmModel: z.string().default('deepseek-flash').extra('volatile', true)
    .description('run 时用的模型名'),
  maxInputChars: z.natural().default(24000).extra('volatile', true)
    .description('单批输入字符预算'),
  maxOutputTokens: z.natural().default(8000).extra('volatile', true)
    .description('单批输出 token 预算'),
  timeoutMs: z.natural().default(90000).extra('volatile', true)
    .description('单次模型调用超时（毫秒）'),
  maxClaimsPerRun: z.natural().default(80).extra('volatile', true)
    .description('单次 run 最多写多少条 claim'),
  maxChunksPerRun: z.natural().default(24).extra('volatile', true)
    .description('单批最多选多少块'),
  pricingInputPerMTokens: z.number().default(0.5).extra('volatile', true)
    .description('估算单价：输入（元/百万 token）；仅用于成本感知，不精确'),
  pricingOutputPerMTokens: z.number().default(1.5).extra('volatile', true)
    .description('估算单价：输出（元/百万 token）；仅用于成本感知，不精确'),
  autoDigest: z.boolean().default(true).extra('volatile', true)
    .description('自动消化：插件启动约 5 分钟后先跑一次，之后每小时第 N 分钟增量消化新原话（插件内定时，不需要任务看板/系统计划任务）'),
  autoDigestIntervalMinutes: z.natural().default(60).extra('volatile', true)
    .description('自动消化间隔（分钟，最小 5）；autoDigestMinute=-1 时按这个间隔跑'),
  autoDigestMinute: z.number().default(27).extra('volatile', true)
    .description('每小时第几分钟跑（0–59，默认 27 = 根藏 :07 摄取、熏习 :17 整理之后；-1 = 按固定间隔）'),
  autoDigestScope: z.string().default('last:90d').extra('volatile', true)
    .description('自动消化的范围（默认只最近 90 天；填 all 才全量历史）'),
  autoDigestBatchChunks: z.natural().default(12).extra('volatile', true)
    .description('每批多少块（过大会触发输出截断；默认 12）'),
  autoDigestMaxRounds: z.natural().default(8).extra('volatile', true)
    .description('每次自动消化最多跑几批（每批 12 块，默认 8 批 ≈ 96 块）'),
  autoDigestBudgetTokens: z.natural().default(8000).extra('volatile', true)
    .description('单批输出 token 上限（默认 8000；别超过模型上限）'),
  autoDigestDailyTokenBudget: z.natural().default(1200000).extra('volatile', true)
    .description('每人每天自动消化最多消耗多少 token（安全阀；用满后当天暂停自动，手动 run 不受影响）'),
})

const DEFAULTS = Object.freeze({
  enabled: true,
  dataRoot: '',
  archiveDir: '',
  writeEnabled: true,
  llmProvider: 'deepseek-account',
  llmModel: 'deepseek-flash',
  maxInputChars: 24000,
  maxOutputTokens: 8000,
  timeoutMs: 90000,
  maxClaimsPerRun: 80,
  maxChunksPerRun: 24,
  pricingInputPerMTokens: 0.5,
  pricingOutputPerMTokens: 1.5,
  autoDigest: true,
  autoDigestIntervalMinutes: 60,
  autoDigestMinute: 27,
  autoDigestScope: 'last:90d',
  autoDigestBatchChunks: 12,
  autoDigestMaxRounds: 8,
  autoDigestBudgetTokens: 8000,
  autoDigestDailyTokenBudget: 1200000,
})

function normalizeConfig(cfg) {
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = cfg ? cfg[k] : undefined
    if (v === undefined || v === null || v === '') continue
    if (k === 'dataRoot') {
      if (typeof v === 'string') out[k] = v
    } else if (k === 'autoDigestScope') {
      const str = pickSettingString(v)
      if (str && str !== '[object Object]') out[k] = str
    } else if (typeof DEFAULTS[k] === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
    } else if (k.startsWith('pricing') || k === 'autoDigestMinute') {
      const n = Number(v)
      // autoDigestMinute 允许 -1（= 不用整点对齐，按固定间隔跑）
      if (Number.isFinite(n) && (n >= 0 || (k === 'autoDigestMinute' && n === -1))) out[k] = n
    } else if (k === 'llmProvider' || k === 'llmModel' || k === 'archiveDir') {
      const str = pickSettingString(v)
      if (str && str !== '[object Object]') out[k] = str
    } else {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n)
    }
  }
  return out
}

/**
 * 设置层可能把值包成 { value } / { default } / Config 实例（实测 llmProvider 变成 "[object Object]"）。
 * 这里统一解包成字符串；拿不到就返回空串，让调用方回退默认值。
 */
function pickSettingString(v) {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v && typeof v === 'object') {
    for (const k of ['value', 'default', 'name', 'id']) {
      const s = v[k]
      if (typeof s === 'string' && s.trim()) return s.trim()
    }
  }
  return ''
}

/** 供自测/守卫使用：apply 会注册哪些工具名 */
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
    try { ctx.logger?.info?.(`[memory-yearring] ${msg}`) } catch { /* 没有 logger 就算了 */ }
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
      const row = rows.find((r) => r?.ns === name)
      if (row?.user && typeof row.user === 'object') out = { ...out, ...normalizeConfig(row.user) }
    } catch { /* 设置服务不可用就用启动时的值 */ }
    return out
  }

  /** 宿主的 llm 服务；可能晚于 apply 才就绪，所以每次现取 */
  const getLlm = () => {
    try {
      const llm = ctx.get?.('llm')
      if (llm && typeof llm.stream === 'function') return llm
    } catch { /* 没有就算了 */ }
    try {
      const llm = ctx.llm
      if (llm && typeof llm.stream === 'function') return llm
    } catch { /* 忽略 */ }
    return null
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
    if (!checked.ok) throw new Error(`[memory-yearring] 工具名违反守卫：${checked.problems.join('；')}`)
    registeredNames.push(spec.name)
    const dispose = ctx.tools.register(defineTool({
      ...spec,
      output: textOutput,
      async execute(args, exec) {
        const cfg = liveCfg()
        if (!cfg.enabled) return { ok: false, code: 'DISABLED', note: '年轮在设置里已关闭（dsh-memory-yearring → 总开关）' }
        try {
          return safe(await spec.execute(args || {}, exec, cfg))
        } catch (e) {
          return safe({ ok: false, ...toErrInfo(e), hint: '先跑 status/verify 看状态；不要重试覆盖已有数据' })
        }
      },
      // 写类工具（run/rebuild）不能并发：内部虽有锁，但让宿主串行更稳
      isConcurrencySafe: () => !WRITE_TOOLS.has(spec.name),
    }))
    disposers.push(dispose)
    return dispose
  }

  /** 取调用方工作区（用于人格解析；不猜、不静默归入具名人格） */
  const callerWorkspace = async (exec) => {
    try {
      const wd = ctx.get?.('workingDirectory')
      const agent = exec?.agent
      if (wd && agent) {
        if (typeof wd.ensure === 'function') return await wd.ensure(agent)
        if (typeof wd.get === 'function' && agent.session) return wd.get(agent.session)
      }
    } catch { /* 拿不到就算 */ }
    return null
  }

  const resolvePersona = async (args, exec) => {
    const explicit = args.personaId ? String(args.personaId) : ''
    if (explicit) {
      if (explicit !== PERSONA_UNASSIGNED && !isSafePersonaId(explicit)) {
        return { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法：${explicit}` } }
      }
      return { ok: true, personaId: explicit }
    }
    const id = await readIdentity(dataRoot())
    if (!id.ok) return { ok: false, code: id.code, error: id.error }
    const ws = await callerWorkspace(exec)
    if (ws) {
      const normp = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
      const target = normp(ws)
      let best = null
      for (const [w, pid] of Object.entries(id.identity.workspaces ?? {})) {
        const nw = normp(w)
        if (target === nw || target.startsWith(nw + '\\')) {
          if (!best || nw.length > best.len) best = { pid, len: nw.length }
        }
      }
      if (best) return { ok: true, personaId: best.pid, identitySource: 'workspace' }
    }
    return {
      ok: false,
      code: 'PERSONA_UNRESOLVED',
      error: { code: 'PERSONA_UNRESOLVED', message: '无法从工作区解析 personaId；请显式传 personaId（不静默归入具名人格）' },
    }
  }

  const requireWrite = (cfg) => {
    if (!cfg.writeEnabled) return { ok: false, code: 'WRITE_DISABLED', note: '写总闸已关闭（writeEnabled=false）：run/rebuild 拒绝执行，只读查询照常' }
    return null
  }

  const budgetOf = (cfg) => ({
    maxInputChars: cfg.maxInputChars,
    maxOutputTokens: cfg.maxOutputTokens,
    timeoutMs: cfg.timeoutMs,
    maxClaimsPerRun: cfg.maxClaimsPerRun,
  })

  const pricingOf = (cfg) => ({
    inputPerMTokens: cfg.pricingInputPerMTokens,
    outputPerMTokens: cfg.pricingOutputPerMTokens,
  })

  // ── 工具 1：status（只读）
  tool({
    name: 'jianmu_year_status',
    description: '年轮·状态：claim/topic/运行/容量/最近错误/锁。deep=true 顺带看根藏与熏习对齐 + verify。degraded 与 errors 必须原样告知用户。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      deep: { type: 'boolean', description: '顺带读根藏统计 + 跑一次 verify（只读）' },
    },
    async execute(args, exec, cfg) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return apiStatus({
        dataRoot: dataRoot(), personaId: p.personaId, deep: Boolean(args.deep),
        config: { ...cfg, budget: budgetOf(cfg) },
      })
    },
  })

  // ── 工具 2：topics（只读）
  tool({
    name: 'jianmu_year_topics',
    description: '年轮·主题：列出 topic 分组 + claim 计数（不返回正文；正文在 year/<personaId>/topic_docs/）。v1a 无 topic 时按 topicHint 分组。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      limit: { type: 'number', description: '最多返回几条（默认 100）' },
      offset: { type: 'number', description: '跳过前几条（分页）' },
      kind: { type: 'string', description: '只看某个 kind', enum: [...KINDS] },
      status: { type: 'string', description: '只看某个有效状态', enum: [...STATUSES] },
      epistemic: { type: 'string', description: '只看某个 epistemic', enum: [...EPISTEMIC] },
      groupId: { type: 'string', description: '只看某个 L1 大主题（如 memory / training / novel）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return apiTopics({
        dataRoot: dataRoot(), personaId: p.personaId,
        limit: Number(args.limit) || 100, offset: Number(args.offset) || 0,
        kind: args.kind || null, status: args.status || null, epistemic: args.epistemic || null,
        groupId: args.groupId || null,
      })
    },
  })

  // ── 工具 3：claim（只读，单条 + 锚点）
  tool({
    name: 'jianmu_year_claim',
    description: '年轮·单条：读一条 claim 的完整字段 + 锚点（含原话 quote 与所在块原文）。includeText=false 可只看摘要。',
    parameters: {
      claimId: { type: 'string', description: 'claimId（必填）', required: true },
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      includeText: { type: 'boolean', description: '是否返回锚点所在块的原文（默认 true）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return apiClaim({
        dataRoot: dataRoot(), personaId: p.personaId,
        claimId: args.claimId, includeText: args.includeText !== false,
      })
    },
  })

  // ── 工具 4：run（写；必须 dryRun 预览 + confirm）
  tool({
    name: 'jianmu_year_run',
    description: [
      '年轮·run：从根藏原话里抽 claim（唯一花 token 的动作）。',
      '两步走：先 dryRun=true 看预估块数/字符/token/费用；确认后再传 confirm=true 真跑。',
      '默认增量（跳过已处理块）；force=true 重跑。scope: all / session:<id> / last:<n>d / since:<ms> / ws:<子串>。',
      '失败不写半成品、不自动重试；每条 claim 的 quote 必须是原话逐字子串，否则拒收。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      topicId: { type: 'string', description: '只处理某个 topic（v1a 通常为空）' },
      scope: { type: 'string', description: '范围：all（默认）/ session:<id> / last:<n>d / since:<ms|ISO> / ws:<子串>' },
      maxChunks: { type: 'number', description: '单批最多选多少块（默认用设置值 400）' },
      budgetTokens: { type: 'number', description: '本次 run 的总输出 token 上限（所有批次合计；默认用设置值 8000）' },
      model: { type: 'string', description: '覆盖模型名（默认设置里的 llmModel）' },
      provider: { type: 'string', description: '覆盖 provider（默认设置里的 llmProvider）' },
      maxBatches: { type: 'number', description: '本次最多跑几批（默认 1，先小口试跑）' },
      force: { type: 'boolean', description: '忽略增量，重跑已处理过的块' },
      dryRun: { type: 'boolean', description: '只预览成本，不调模型（强烈建议先跑这个）' },
      confirm: { type: 'boolean', description: '真跑确认（会真实调用模型并产生费用）' },
    },
    async execute(args, exec, cfg) {
      const off = requireWrite(cfg)
      if (off) return off
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return runYear({
        dataRoot: dataRoot(),
        personaId: p.personaId,
        llmHost: getLlm(),
        topicId: args.topicId ? String(args.topicId) : null,
        scope: args.scope ? String(args.scope) : 'all',
        maxChunks: args.maxChunks,
        budgetTokens: args.budgetTokens,
        model: args.model,
        provider: args.provider,
        dryRun: Boolean(args.dryRun),
        confirm: Boolean(args.confirm),
        force: Boolean(args.force),
        maxBatches: args.maxBatches,
        budget: budgetOf(cfg),
        pricing: pricingOf(cfg),
        config: cfg,
      })
    },
  })

  // ── 工具 5：rebuild（写；0 LLM）
  tool({
    name: 'jianmu_year_rebuild',
    description: '年轮·重建：从 claims 全量重建 topic_docs（0 LLM、不重抽、不重嵌）。旧 docs 先快照进 _archive/；可重复执行。必须 confirm=true。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      confirm: { type: 'boolean', description: '重写 topic_docs 的确认' },
    },
    async execute(args, exec, cfg) {
      const off = requireWrite(cfg)
      if (off) return off
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return rebuildTopicDocs({ dataRoot: dataRoot(), personaId: p.personaId, confirm: Boolean(args.confirm), archiveDir: String(cfg?.archiveDir || '') })
    },
  })

  // ── 工具 6：verify（只读）
  tool({
    name: 'jianmu_year_verify',
    description: '年轮·校验：锚点有效性（quote 是否仍是原文逐字子串）/孤儿锚点/跨人格/结构/计数/topic_docs 悬挂引用。v1a 只报不修。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      repair: { type: 'boolean', description: 'v1a 只报不修（传了也只在结果里说明）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return verifyYear({ dataRoot: dataRoot(), personaId: p.personaId, repair: Boolean(args.repair) })
    },
  })

  // ── 工具 7：export（只读）
  tool({
    name: 'jianmu_year_export',
    description: '年轮·导出：把 claims + topic docs 导出成一个 JSON 包（备份/迁移用）。目标路径必须在 year/<personaId>/ 内；不填则写到 exports/。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      outFile: { type: 'string', description: '导出文件路径（必须在 year/<personaId>/ 内）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return exportYear({ dataRoot: dataRoot(), personaId: p.personaId, outFile: args.outFile ? String(args.outFile) : null })
    },
  })

  // ── 守卫自检：用「实际注册名」校验，不能再拿常量比常量
  const surface = checkToolSurface(registeredNames)
  if (!surface.ok) {
    for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
    throw new Error(`[memory-yearring] 工具面守卫未通过：${surface.problems.join('；')}`)
  }

  // ── host 只读服务（UI 数据源；不提供任何写动作）
  const service = {
    context: (workspace = null) => apiContext({ dataRoot: dataRoot(), workspace }),
    status: (personaId, deep = false) => apiStatus({
      dataRoot: dataRoot(), personaId, deep, config: { ...liveCfg(), budget: budgetOf(liveCfg()) },
    }),
    topics: (personaId, opts = {}) => apiTopics({ dataRoot: dataRoot(), personaId, ...opts }),
    claims: (personaId, opts = {}) => apiClaims({ dataRoot: dataRoot(), personaId, ...opts }),
    claim: (personaId, claimId, includeText = true) => apiClaim({ dataRoot: dataRoot(), personaId, claimId, includeText }),
    verify: (personaId) => apiVerify({ dataRoot: dataRoot(), personaId }),
    // ── P4 #10 硬认领（2026-11-13）：claims 按锚点搬迁 ──
    claimHardPreviewClaims: (opts = {}) => previewMoveClaims({ ...opts, dataRoot: dataRoot() }),
    claimHardMoveClaims: (opts = {}) => {
      if (!liveCfg().writeEnabled) return { ok: false, code: 'WRITE_DISABLED', note: '写总闸已关闭（writeEnabled=false）：拒绝搬 claims' }
      return moveClaims({ ...opts, dataRoot: dataRoot() })
    },
    claimHardRebuild: (opts = {}) => {
      if (!liveCfg().writeEnabled) return { ok: false, code: 'WRITE_DISABLED', note: '写总闸已关闭：拒绝 rebuild' }
      return rebuildAfterMove({ ...opts, dataRoot: dataRoot() })
    },
    claimHardRollbackClaims: (opts = {}) => rollbackMoveClaims({ ...opts, dataRoot: dataRoot() }),
  }
  if (typeof ctx.provide === 'function') {
    disposers.push(ctx.provide('jianmuYear', service))
  } else {
    log('宿主没有 ctx.provide —— host 只读服务未注册（HTTP 路由不受影响）')
  }

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }

  // 探针专用：无 persona / workspace 也返回 200（resolved:false）。
  // 计划 §4.1 #7 的 UI 探针就是「无参 /status 可用才出现」——返回 409 会让「年轮」tab 永不出现。
  const statusProbe = async (query) => {
    const c = await apiContext({
      dataRoot: dataRoot(),
      workspace: query.workspace || null,
      personaId: query.personaId || null,
    })
    if (!c.ok) return { ok: false, status: 500, body: c }
    if (!c.personaId) {
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          resolved: false,
          personaId: null,
          service: { name: 'dsh-memory-yearring', version: VERSION },
          context: c,
          note: c.note || '未解析到 persona：带上 personaId 或 workspace 再看具体数据',
        },
      }
    }
    return {
      ok: true,
      status: 200,
      body: { resolved: true, ...(await apiStatus({
        dataRoot: dataRoot(), personaId: c.personaId,
        deep: query.deep === '1' || query.deep === 'true',
        config: { ...liveCfg(), budget: budgetOf(liveCfg()) },
        // 只在「当前正在消化的就是这个人格」时展示进度，避免Bob的进度串到Alice面板
        uiRun: uiRun && uiRun.personaId === c.personaId ? uiRun : null,
        auto: autoInfo(),
      })) },
    }
  }

  const resolveRoutePersona = async (query) => {
    const c = await apiContext({
      dataRoot: dataRoot(),
      workspace: query.workspace || null,
      personaId: query.personaId || null,
    })
    if (!c.ok) return { ok: false, status: 500, body: c }
    if (!c.personaId) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, code: 'PERSONA_UNRESOLVED', error: { code: 'PERSONA_UNRESOLVED', message: '无法解析当前 persona；请显式传 personaId' }, context: c },
      }
    }
    return { ok: true, personaId: c.personaId, context: c }
  }

  // ── UI 向导：POST /run（产品层兜底，后台跑，不阻塞页面）──────────────────
  let uiRun = null
  const readJsonBody = (req, limit = 256 * 1024) => new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (d) => {
      size += d.length
      if (size > limit) {
        finish({ ok: false, code: 'BODY_TOO_LARGE' })
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(d)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const body = text ? JSON.parse(text) : {}
        if (!body || typeof body !== 'object' || Array.isArray(body)) return finish({ ok: false, code: 'BAD_JSON' })
        finish({ ok: true, body })
      } catch { finish({ ok: false, code: 'BAD_JSON' }) }
    })
    req.on('error', () => finish({ ok: false, code: 'BAD_JSON' }))
  })
  const sameOrigin = (req) => {
    const o = req.headers?.origin
    if (!o) return true
    try { return new URL(o).host === req.headers?.host } catch { return false }
  }
  const writeGuard = (req) => {
    if (String(req.headers?.['x-dsh-jianmu'] || '') !== '1') {
      return { ok: false, status: 403, body: { ok: false, code: 'CSRF_GUARD', error: { code: 'CSRF_GUARD', message: '写动作需要 x-dsh-jianmu: 1 头' } } }
    }
    if (!sameOrigin(req)) {
      return { ok: false, status: 403, body: { ok: false, code: 'CROSS_ORIGIN', error: { code: 'CROSS_ORIGIN', message: '拒绝跨源写动作' } } }
    }
    return { ok: true }
  }
  /**
   * 后台消化：手动向导（POST /run）与插件内自动消化共用同一条流水线。
   * 进度写内存（uiRun），页面轮询 /status 看；中途重启不丢已写 claim（增量续跑）。
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const autoState = {
    timer: null,
    bootTimer: null,
    watcher: null,
    running: false,
    lastTickAt: null,
    nextRunAt: null,
    last: null,
    lastError: null,
    day: null,
    tokensByPersona: {},
  }

  const today = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const addTokens = (pid, n) => {
    const day = today()
    if (autoState.day !== day) { autoState.day = day; autoState.tokensByPersona = {} }
    if (!Number.isFinite(n) || n <= 0) return
    autoState.tokensByPersona[pid] = (autoState.tokensByPersona[pid] || 0) + n
  }
  const overDailyBudget = (pid, cfg) => {
    const day = today()
    if (autoState.day !== day) { autoState.day = day; autoState.tokensByPersona = {} }
    const cap = Number(cfg.autoDigestDailyTokenBudget) || 0
    if (!(cap > 0)) return false
    return (autoState.tokensByPersona[pid] || 0) >= cap
  }

  const RETRYABLE_RUN = new Set(['LOCK_BUSY', 'LLM_TRUNCATED', 'LLM_JSON_INVALID', 'BUDGET_EXCEEDED'])

  /**
   * 跑一轮后台消化（异步、可等待）。返回最终 state（含 rounds/last/error/rebuild）。
   * 注意：会同步设置 uiRun，方便调用方立刻拿到进度对象。
   */
  const runDigest = async ({ personaId, scope, trigger = 'manual', maxRounds = 30, batchChunks = 12, batchLimit = 10, budgetTokens = 40000, dailyCap = 0 }) => {
    const cfg = liveCfg()
    const state = {
      running: true, trigger, personaId, scope, startedAt: Date.now(),
      rounds: 0, last: null, error: null, tokens: 0,
    }
    uiRun = state
    try {
      for (let i = 0; i < Math.max(1, maxRounds); i++) {
        const r = await runYear({
          dataRoot: dataRoot(), personaId, llmHost: getLlm(),
          scope, confirm: true, maxChunks: batchChunks, maxBatches: batchLimit, budgetTokens,
          budget: budgetOf(cfg), pricing: pricingOf(cfg), config: cfg,
          trigger,
        })
        state.rounds = i + 1
        state.last = { ok: r.ok, code: r.code || null, wrote: r.wrote || null, remaining: r.selection?.remaining ?? null }
        const used = Number(r.wrote?.tokens?.prompt || 0) + Number(r.wrote?.tokens?.output || 0)
        state.tokens += used
        if (trigger === 'auto') addTokens(personaId, used)
        if (r.code === 'NOTHING_TO_DO') break
        if (!r.ok) {
          if (RETRYABLE_RUN.has(r.code)) {
            // 预算耗尽不原地重试（重试还是同一个上限），交给下一轮/下一小时
            if (r.code === 'BUDGET_EXCEEDED') break
            await sleep(4000)
            continue
          }
          state.error = r.code || 'RUN_FAILED'
          break
        }
        if ((r.selection?.remaining ?? 0) <= 0) break
        if (dailyCap > 0 && state.tokens >= dailyCap) { state.stoppedBy = 'DAILY_TOKEN_BUDGET'; break }
      }
      state.rebuild = await rebuildTopicDocs({ dataRoot: dataRoot(), personaId, confirm: true, archiveDir: String(cfg?.archiveDir || '') })
    } catch (e) {
      state.error = e?.code || e?.message || String(e)
    } finally {
      state.running = false
      state.endedAt = Date.now()
    }
    return state
  }

  /** 手动向导：后台跑，不阻塞页面（参数保持产品既定值） */
  const startUiRun = ({ personaId, scope }) => {
    if (autoState.running || uiRun?.running) return { ok: false, code: 'ALREADY_RUNNING', uiRun }
    const p = runDigest({ personaId, scope, trigger: 'manual', maxRounds: 30, batchChunks: 12, batchLimit: 10, budgetTokens: 40000 })
    p.catch(() => { /* runDigest 内部已兜住错误 */ })
    return { ok: true, started: true, uiRun }
  }

  /** 下一次自动消化的时刻：默认对齐到每小时第 autoDigestMinute 分，-1 则按固定间隔 */
  const computeNextAutoAt = (cfg, from = Date.now()) => {
    const minute = Number(cfg.autoDigestMinute)
    if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
      const d = new Date(from)
      d.setSeconds(0, 0)
      d.setMinutes(minute)
      if (d.getTime() <= from) d.setHours(d.getHours() + 1)
      return d.getTime()
    }
    return from + Math.max(5, Number(cfg.autoDigestIntervalMinutes) || 60) * 60000
  }

  /** 插件内自动消化：定时检查所有真实人格，有新原话就增量消化 */
  const scheduleAuto = () => {
    if (autoState.timer) { clearTimeout(autoState.timer); autoState.timer = null }
    const cfg = liveCfg()
    if (!cfg.enabled || !cfg.autoDigest || !cfg.writeEnabled) { autoState.nextRunAt = null; return }
    const at = computeNextAutoAt(cfg, Date.now())
    autoState.nextRunAt = at
    const t = setTimeout(() => { tickAuto('定时').catch(() => {}) }, Math.max(1000, at - Date.now()))
    t.unref?.()
    autoState.timer = t
  }

  const tickAuto = async (reason) => {
    const cfg = liveCfg()
    if (!cfg.enabled || !cfg.autoDigest || !cfg.writeEnabled) { scheduleAuto(); return }
    if (autoState.running || uiRun?.running) { scheduleAuto(); return }
    const llm = getLlm()
    if (!llm) {
      autoState.lastError = { code: 'LLM_UNAVAILABLE', message: '宿主没有 ctx.llm 服务，自动消化无法调用模型' }
      autoState.lastTickAt = Date.now()
      scheduleAuto()
      return
    }
    autoState.running = true
    autoState.lastTickAt = Date.now()
    log(`自动消化开始（${reason}；scope=${cfg.autoDigestScope}）`)
    try {
      const id = await readIdentity(dataRoot())
      const declared = id.ok ? Object.keys(id.identity?.personas || {}) : []
      const scopes = await listScopes(dataRoot())
      const pids = scopes.filter((pid) => pid !== PERSONA_UNASSIGNED
        && (declared.includes(pid) || existsSync(join(yearDir(dataRoot(), pid), 'manifest.json'))))
      if (!pids.length) { autoState.last = { skipped: 'NO_PERSONA' }; return }
      for (const pid of pids) {
        if (overDailyBudget(pid, cfg)) {
          autoState.last = { personaId: pid, skipped: 'DAILY_TOKEN_BUDGET' }
          continue
        }
        const st = await apiStatus({ dataRoot: dataRoot(), personaId: pid, config: { ...cfg, budget: budgetOf(cfg) } })
        if (!st.ok) continue
        const coverage = st.coverage || {}
        const remaining = cfg.autoDigestScope === 'all'
          ? coverage.remaining
          : (coverage.last90?.remaining ?? coverage.remaining)
        if (!(remaining > 0)) continue
        const state = await runDigest({
          personaId: pid,
          scope: cfg.autoDigestScope,
          trigger: 'auto',
          maxRounds: Math.max(1, Number(cfg.autoDigestMaxRounds) || 8),
          batchChunks: Math.max(1, Number(cfg.autoDigestBatchChunks) || 12),
          batchLimit: 1,
          budgetTokens: Math.max(256, Number(cfg.autoDigestBudgetTokens) || 8000),
          dailyCap: Number(cfg.autoDigestDailyTokenBudget) || 0,
        })
        autoState.last = {
          personaId: pid, rounds: state.rounds, tokens: state.tokens,
          claims: state.last?.wrote?.claims ?? null,
          remaining: state.last?.remaining ?? null,
          stoppedBy: state.stoppedBy || null,
          error: state.error || null,
          endedAt: state.endedAt,
        }
        autoState.lastError = state.error ? { personaId: pid, code: state.error } : null
      }
    } catch (e) {
      autoState.lastError = { code: e?.code || 'AUTO_DIGEST_FAILED', message: String(e?.message || e) }
      log(`自动消化异常（已捕获，不影响宿主）：${e?.message || e}`)
    } finally {
      autoState.running = false
      autoState.lastTickAt = Date.now()
      scheduleAuto()
    }
  }

  const autoInfo = () => {
    const cfg = liveCfg()
    return {
      enabled: Boolean(cfg.enabled && cfg.autoDigest && cfg.writeEnabled),
      intervalMinutes: cfg.autoDigestIntervalMinutes,
      minute: cfg.autoDigestMinute,
      scope: cfg.autoDigestScope,
      batchChunks: cfg.autoDigestBatchChunks,
      maxRounds: cfg.autoDigestMaxRounds,
      dailyTokenBudget: cfg.autoDigestDailyTokenBudget,
      tokensToday: autoState.tokensByPersona,
      running: autoState.running,
      nextRunAt: autoState.nextRunAt,
      lastTickAt: autoState.lastTickAt,
      last: autoState.last,
      lastError: autoState.lastError,
    }
  }

  // 启动约 5 分钟先补跑一次（等根藏启动摄取、熏习整理都落地后再消化）
  autoState.bootTimer = setTimeout(() => {
    autoState.bootTimer = null
    // 如果启动后已经按整点跑过一轮，就别在 5 分钟内重复烧 token
    if (autoState.lastTickAt && Date.now() - autoState.lastTickAt < 10 * 60000) return
    tickAuto('启动').catch(() => {})
  }, 300000)
  autoState.bootTimer.unref?.()

  // 设置页把自动消化从关改成开时，5 分钟内接上（不必重启）
  autoState.watcher = setInterval(() => {
    const cfg = liveCfg()
    if (cfg.enabled && cfg.autoDigest && cfg.writeEnabled && !autoState.timer && !autoState.bootTimer) scheduleAuto()
    if ((!cfg.enabled || !cfg.autoDigest || !cfg.writeEnabled) && autoState.timer) {
      clearTimeout(autoState.timer)
      autoState.timer = null
      autoState.nextRunAt = null
    }
  }, 5 * 60000)
  autoState.watcher.unref?.()

  scheduleAuto()


  const route = {
    kind: 'prefix',
    path: '/api/year-ring',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const query = Object.fromEntries(url.searchParams.entries())
        const sub = url.pathname.slice('/api/year-ring'.length) || '/'

        // ── POST /run：首次消化向导（产品层兜底）───────────────────────────
        if (req.method === 'POST') {
          const guard = writeGuard(req)
          if (!guard.ok) return sendJson(res, guard.status, guard.body)
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            return sendJson(res, 400, { ok: false, code: parsed.code, error: { code: parsed.code, message: parsed.code === 'BAD_JSON' ? '请求体不是合法 JSON 对象' : '请求体不可用' } })
          }
          const body = parsed.body
          if (sub !== '/run') {
            return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知写端点：${sub}` } })
          }
          const pid = String(body.personaId || '').trim()
          if (!pid) return sendJson(res, 400, { ok: false, code: 'PERSONA_REQUIRED', error: { code: 'PERSONA_REQUIRED', message: '写动作必须显式传 personaId' } })
          if (pid !== PERSONA_UNASSIGNED && !isSafePersonaId(pid)) {
            return sendJson(res, 400, { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法：${pid}` } })
          }
          if (body.confirm !== true) {
            return sendJson(res, 400, { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '会调用模型并产生费用：需要 confirm=true' } })
          }
          if (liveCfg().writeEnabled === false) {
            return sendJson(res, 403, { ok: false, code: 'WRITE_DISABLED', error: { code: 'WRITE_DISABLED', message: '年轮写动作在设置里已关闭' } })
          }
          // 产品默认：只消化最近 90 天；明确传 all 才全量
          const scope = body.scope === 'all' ? 'all' : 'last:90d'
          const r = startUiRun({ personaId: pid, scope })
          return sendJson(res, r.ok ? 200 : 409, r)
        }
        if (req.method !== 'GET') {
          return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 GET（读）与 POST /run（向导）' } })
        }

        if (sub === '/' || sub === '/context') {
          const context = await apiContext({ dataRoot: dataRoot(), workspace: query.workspace || null, personaId: query.personaId || null })
          // P0-1：年轮独立页面需要人格下拉。只读 identity.json 里的声明，
          // 不猜「哪个目录 = 哪个人格」；identity 不可读时不阻塞 context。
          let personas = {}
          try {
            const id = await readIdentity(dataRoot())
            if (id.ok) {
              for (const [pid, meta] of Object.entries(id.identity?.personas || {})) {
                personas[pid] = { displayName: meta?.displayName || pid }
              }
            }
          } catch { /* ignore */ }
          return sendJson(res, 200, { ...context, personas })
        }
        if (sub === '/capabilities') {
          return sendJson(res, 200, {
            ok: true,
            service: { name: 'dsh-memory-yearring', version: VERSION },
            kinds: KINDS, statuses: STATUSES, epistemic: EPISTEMIC,
            writable: false,
            note: 'v1a 只读；run/rebuild 走 agent 工具',
          })
        }

        // 探针端点：无 persona 也 200（UI 靠它决定是否显示「年轮」tab）
        if (sub === '/status') {
          const probe = await statusProbe(query)
          return sendJson(res, probe.status, probe.body)
        }

        const who = await resolveRoutePersona(query)
        if (!who.ok) return sendJson(res, who.status, who.body)
        const pid = who.personaId

        if (sub === '/topics') {
          return sendJson(res, 200, await apiTopics({
            dataRoot: dataRoot(), personaId: pid,
            limit: Number(query.limit) || 100, offset: Number(query.offset) || 0,
            kind: query.kind || null, status: query.status || null, epistemic: query.epistemic || null,
            groupId: query.groupId || null,
          }))
        }
        if (sub === '/claims') {
          return sendJson(res, 200, await apiClaims({
            dataRoot: dataRoot(), personaId: pid,
            limit: Number(query.limit) || 50, offset: Number(query.offset) || 0,
            kind: query.kind || null, status: query.status || null, topicId: query.topicId || null,
            groupId: query.groupId || null,
            epistemic: query.epistemic || null, q: query.q || null,
            includeText: query.includeText === '1' || query.includeText === 'true',
          }))
        }
        if (sub === '/claim') {
          if (!query.claimId) return sendJson(res, 400, { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'claimId 必填' } })
          return sendJson(res, 200, await apiClaim({
            dataRoot: dataRoot(), personaId: pid, claimId: query.claimId,
            includeText: query.includeText !== '0' && query.includeText !== 'false',
          }))
        }
        if (sub === '/verify') return sendJson(res, 200, await apiVerify({ dataRoot: dataRoot(), personaId: pid }))
        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知只读端点：${sub}` } })
      } catch (e) {
        return sendJson(res, 500, { ok: false, code: e.code || 'API_FAILED', error: toErrInfo(e) })
      }
    },
  }

  // webServer 是可选服务，且可能在插件 apply 之后才就绪：用 ctx.inject 等它就位再挂路由。
  const starmapRoute = makeStarmapRoute({ getDataRoot: dataRoot, uiDir: STARMAP_UI_DIR, pluginRoot: fileURLToPath(new URL('.', import.meta.url)) })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      const ws = sub?.webServer
      if (!ws || typeof ws.register !== 'function') return
      sub.effect(() => ws.register(route), 'memory-yearring:read-route')
      sub.effect(() => ws.register(starmapRoute), 'memory-yearring:starmap-route')
      // 插件卸载时别把构建子进程留成孤儿
      sub.effect(() => () => { try { starmapRoute.dispose?.() } catch { /* 忽略 */ } }, 'memory-yearring:starmap-build-dispose')
    })
  } else {
    const webServer = (() => { try { return ctx.get?.('webServer') } catch { return undefined } })()
    if (webServer && typeof webServer.register === 'function') {
      disposers.push(webServer.register(route))
      disposers.push(webServer.register(starmapRoute))
      disposers.push(() => { try { starmapRoute.dispose?.() } catch { /* 忽略 */ } })
    } else {
      log('宿主没有 webServer —— 只读 HTTP 路由未注册（host 服务仍可用）')
    }
  }

  log(`已注册 ${disposers.length} 个资源（工具 ${registeredNames.length}；版本 ${VERSION}；根藏/熏习只读，year/${'{personaId}'} 唯一可写）`)
  const dispose = () => {
    if (autoState.timer) { try { clearTimeout(autoState.timer) } catch { /* 忽略 */ } autoState.timer = null }
    if (autoState.bootTimer) { try { clearTimeout(autoState.bootTimer) } catch { /* 忽略 */ } autoState.bootTimer = null }
    if (autoState.watcher) { try { clearInterval(autoState.watcher) } catch { /* 忽略 */ } autoState.watcher = null }
    for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
  }
  dispose.toolNames = [...registeredNames]
  dispose.autoDigest = () => autoInfo()
  // 诊断/测试钩子：立即跑一轮自动消化（不对外暴露成工具；仅供宿主内调试或自测）
  dispose.runAutoDigest = (reason = 'manual') => tickAuto(reason)
  return dispose
}

export { PERSONA_UNASSIGNED, defaultDataRoot, yearDir }
