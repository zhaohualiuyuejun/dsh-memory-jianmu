/**
 * dsh-memory-store —— 根藏（建木 · 存储层）host 半端
 * ============================================================================
 * 只做一件事：把「谁、在什么时候、说了什么」原话摄取、落盘、可重建。
 *
 * 明确不做（契约 v1 §9）：
 *   ❌ 不检索（归寻枝）· ❌ 不注入（归镜台）· ❌ 不判断取代/遗忘（归熏习）
 *   ❌ 不提炼结论（归年轮）· ❌ 不做跨人格共享/合并
 *
 * 工具面只有七件：ingest / status / rebuild / export / forget / revive / identity_add_persona。
 * 数据布局：<dataRoot>/identity.json + scopes/<personaId>/{chunks.jsonl,vectors_v<N>.f32,...}
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { loadIdentity } from './lib/identity.mjs'
import { defaultDataRoot, PERSONA_UNASSIGNED } from './lib/paths.mjs'
import { checkToolName, checkToolSurface, ALLOWED_TOOLS } from './lib/guards.mjs'
import { openStore, statusAll, statusOfScope, exportChunks, rebuildIndexMeta, verifyScope } from './lib/store.mjs'
import { migrateLegacyIndex, readLegacyIndex } from './lib/migrate.mjs'
import { forgetChunks, forgetPreview, reviveChunks } from './lib/forget.mjs'
import { identityAddPersona, identityRemoveMappings, identitySummary } from './lib/identity-admin.mjs'
import { ingestSessions, ingestUtterances } from './lib/ingest.mjs'
import { runAutoIngest, computeNextRunAt, loadEmbeddingConfig } from './lib/auto-ingest.mjs'
import { runAutoSummaryAfterIngest } from './lib/auto-summary.mjs'
import { previewHardClaim, applyHardClaim, rollbackHardClaimRoot } from './lib/hardclaim.mjs'
import { toErrInfo } from './lib/errors.mjs'
import { VERSION } from './lib/version.mjs'
import { API_PREFIX, checkWriteRequest, readJsonBody, validateSettingsPatch, publicSettings, testEmbedding } from './lib/httpapi.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'memory-store'
export const inject = ['tools']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true)
    .description('总开关：关掉后四个工具只回一句「已关闭」'),
  dataRoot: z.string().default('').extra('volatile', true)
    .description('数据根目录；留空 = <DSH_HOME>/memory-jianmu（数据与插件代码分离）'),
  ingestEnabled: z.boolean().default(false).extra('volatile', true)
    .description('会话增量摄取总闸（默认关；按施工计划晚间接通后才开）'),
  ingestDays: z.natural().default(7).extra('volatile', true)
    .description('摄取最近多少天的会话（默认 7）'),
  retentionDays: z.natural().default(30).extra('volatile', true)
    .description('保留窗口（预留：当前只记账、不自动标记过期，避免误伤历史原话；Stage 1 再实现）'),
  maxBatchSize: z.natural().default(64).extra('volatile', true)
    .description('嵌入批大小上限（骨架阶段未接嵌入，仅占位）'),
  autoIngest: z.boolean().default(true).extra('volatile', true)
    .description('自动摄取：插件启动后先补跑一次，之后每小时第 N 分钟增量摄取（插件内定时，不弹控制台窗口）'),
  autoIngestIntervalMinutes: z.natural().default(60).extra('volatile', true)
    .description('自动摄取间隔（分钟）；autoIngestMinute=-1 时按这个间隔跑'),
  autoIngestMinute: z.number().default(7).extra('volatile', true)
    .description('每小时第几分钟跑（0–59，默认 7 = 每小时 :07；填 -1 = 按固定间隔）'),
  embeddingApiKey: z.string().default('').extra('volatile', true)
    .description('嵌入服务密钥（OpenAI 兼容 /v1/embeddings）；留空则回退读寻枝的 ~/.dsh/session-recall/config.json'),
  embeddingApiBase: z.string().default('').extra('volatile', true)
    .description('嵌入接口地址（到 /v1 为止）；留空 = https://api.siliconflow.cn/v1'),
  autoSummaryIndex: z.boolean().default(false).extra('volatile', true)
    .description('A2 自动摘要：自动摄取写入新块后，后台给长块生成摘要并重嵌（默认关；只对已是 concat 口径的库生效）'),
  summaryModel: z.string().default('qwen3:8b').extra('volatile', true)
    .description('摘要用的本地 Ollama 模型（默认 qwen3:8b；不下载模型）'),
  summaryBase: z.string().default('http://127.0.0.1:11434').extra('volatile', true)
    .description('本地 Ollama 地址（默认 http://127.0.0.1:11434）'),
  summaryMinChars: z.natural().default(80).extra('volatile', true)
    .description('只给不少于这么多字的长块生成摘要（默认 80）'),
})

const DEFAULTS = Object.freeze({
  enabled: true,
  dataRoot: '',
  ingestEnabled: false,
  ingestDays: 7,
  retentionDays: 30,
  maxBatchSize: 64,
  autoIngest: true,
  autoIngestIntervalMinutes: 60,
  autoIngestMinute: 7,
  embeddingApiKey: '',
  embeddingApiBase: '',
  autoSummaryIndex: false,
  summaryModel: 'qwen3:8b',
  summaryBase: 'http://127.0.0.1:11434',
  summaryMinChars: 80,
})

/**
 * 展开 volatile 配置引用。
 * 宿主在部分加载路径下把 Config 字段做成「带 get() 的引用对象」：直接读属性会得到 undefined，
 * 于是 dataRoot 静默回退默认值（2026-11-13 元包实验踩到：id != plugin name 时设置层没命中，
 * 启动值又没展开，健康检查的 dataRoot 变成了 DSH_HOME/memory-jianmu）。
 */
function unwrapVolatiles(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') {
    if (typeof value.get === 'function' && typeof value.then !== 'function') return unwrapVolatiles(value.get())
    if (Array.isArray(value)) return value.map(unwrapVolatiles)
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = unwrapVolatiles(v)
    return out
  }
  return value
}

/** 只取「明确存在且类型合法」的字段（不补默认值）——设置层叠加用，避免把启动值整体覆盖成默认 */
function pickConfigFields(raw) {
  const src = unwrapVolatiles(raw)
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const k of Object.keys(DEFAULTS)) {
    const v = src[k]
    if (v === undefined || v === null || v === '') continue
    if (typeof DEFAULTS[k] === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
      continue
    }
    if (typeof DEFAULTS[k] === 'number') {
      if (typeof v !== 'number' && typeof v !== 'string') continue
      const n = Number(v)
      if (Number.isFinite(n) && (n >= 0 || (k === 'autoIngestMinute' && n === -1))) out[k] = Math.floor(n)
      continue
    }
    if (typeof v !== 'string') continue
    out[k] = v
  }
  return out
}

function normalizeConfig(cfg) {
  return { ...DEFAULTS, ...pickConfigFields(cfg) }
}

/**
 * 指定 personaId 时只回该人格的身份切片，避免把其他人格的名字/工作区路径带出去。
 * 例：QQ 端Bob查 `personaId=bob` 时，identity.personas 只含 bob，
 * identity.workspaces/sessions 只保留值 = bob 的条目，defaultPersonaId 置 null。
 */
export function identityForPersona(identityState, pid) {
  if (!identityState || identityState.ok !== true || !identityState.identity) return identityState
  const id = identityState.identity
  const pick = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v === pid))
  return {
    ...identityState,
    identity: {
      ...id,
      personas: id.personas && Object.prototype.hasOwnProperty.call(id.personas, pid) ? { [pid]: id.personas[pid] } : {},
      workspaces: pick(id.workspaces),
      sessions: pick(id.sessions),
      defaultPersonaId: id.defaultPersonaId === pid ? pid : null,
    },
  }
}

/** 供自测/守卫使用的纯函数：apply 会注册哪些工具名 */
export function declaredToolNames() {
  return [...ALLOWED_TOOLS]
}

export function apply(ctx, config) {
  const baseCfg = normalizeConfig(config)
  const disposers = []
  const logs = []
  const log = (msg) => {
    logs.push(String(msg))
    try { ctx.logger?.info?.(`[memory-store] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  const dataRoot = () => {
    const raw = liveCfg().dataRoot
    const root = typeof raw === 'string' && raw.trim() ? raw.trim() : defaultDataRoot()
    return resolve(root)
  }
  /**
   * 设置服务（0.2.6）。
   * 为什么用 ctx.get('settings', false) 而不是 ctx.settings：
   *   本插件没有 inject: ['settings']，直接属性访问不一定拿得到服务（拿不到就静默变 undefined）；
   *   而 UI 的读写都必须真的有这个服务。拿不到就如实报 writable:false，不退化成假成功。
   */
  const getSettingsService = () => {
    try { return (typeof ctx.get === 'function' ? ctx.get('settings', false) : null) || null } catch { return null }
  }
  /**
   * 本插件在当前 profile 里的条目标 id。
   * 为什么不是常量 name：profile 条目的 id 由**装它的那层 patch** 决定，可以是
   * `memory-store`（bundle 自带 patch）、`jianmu-store`（元包 patch）或 `include:xxx` 之类。
   * 所以按「插件名」去 configEditor 反查条目 id；查不到才退回 name。
   */
  const findEntryId = () => {
    let ce = null
    try { ce = typeof ctx.get === 'function' ? ctx.get('configEditor', false) : null } catch { ce = null }
    if (ce && typeof ce.entries === 'function') {
      try {
        const rows = ce.entries() || []
        const hit = rows.find((e) => e?.options?.name === 'dsh-memory-store')
        if (hit?.options?.id) return hit.options.id
      } catch { /* 读不到条目就退回 name */ }
    }
    return name
  }
  /** 当前 profile 里这个插件条目的设置视图 */
  const settingsRow = () => {
    const service = getSettingsService()
    if (!service || typeof service.describe !== 'function') return null
    let rows
    try { rows = service.describe() } catch { return null }
    if (!Array.isArray(rows)) return null
    const ids = [findEntryId(), name]
    const row = rows.find((r) => r?.ns && ids.includes(r.ns))
    if (!row) return null
    return { service, row, revision: Number(row.revision) || 0 }
  }
  const liveCfg = () => {
    // 启动值 + 设置层「明确写过的字段」（不补默认值，否则会把启动配置整体覆盖成默认）
    const out = { ...baseCfg }
    try {
      const sr = settingsRow()
      if (sr?.row?.user && typeof sr.row.user === 'object') Object.assign(out, pickConfigFields(sr.row.user))
    } catch { /* 设置服务不可用就用启动时的值 */ }
    return out
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /** 宿主只吃无损 JSON */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => {
    const checked = checkToolName(spec.name)
    if (!checked.ok) throw new Error(`[memory-store] 工具名违反守卫：${checked.problems.join('；')}`)
    const dispose = ctx.tools.register(defineTool({
      ...spec,
      output: textOutput,
      async execute(args, exec) {
        const cfg = liveCfg()
        if (!cfg.enabled) return { ok: false, code: 'DISABLED', note: '根藏在设置里已关闭（dsh-memory-store → 总开关）' }
        try {
          return safe(await spec.execute(args || {}, exec, cfg))
        } catch (e) {
          return safe({ ok: false, ...toErrInfo(e), hint: '看 status 确认数据目录与文件状态；不要重试覆盖已有数据' })
        }
      },
      isConcurrencySafe: () => true,
    }))
    disposers.push(dispose)
    return dispose
  }

  /** 取「发起这次工具调用的会话」的工作目录与 session（人格解析用） */
  const callerContext = async (exec) => {
    const out = { ws: null, session: null }
    try {
      const wd = ctx.get?.('workingDirectory')
      const agent = exec?.agent
      if (wd && agent) {
        if (typeof wd.ensure === 'function') out.ws = await wd.ensure(agent)
        else if (typeof wd.get === 'function' && agent.session) out.ws = wd.get(agent.session)
      }
      out.session = exec?.agent?.session?.id || agent?.session || null
    } catch { /* 拿不到就算了 */ }
    return out
  }

  // ── 启动时就开一次库，拿身份层健康状态（失败只降级，不抛 —— D9）
  let bootState = { ok: false, degraded: true, reason: 'not-opened' }
  const ready = (async () => {
    try {
      bootState = await openStore({ dataRoot: dataRoot() })
      if (bootState.degraded) log(`存储层降级：${(bootState.reasons || []).join(',')}`)
      else log(`存储层就绪：${bootState.dataRoot}`)
    } catch (e) {
      bootState = { ok: false, degraded: true, reason: 'init_failed', error: toErrInfo(e) }
      log(`存储层初始化失败（已降级，不影响宿主）：${e?.message || e}`)
    }
    return bootState
  })()

  const ensureStore = async () => {
    // 设置里改了 dataRoot（或启动时降级）→ 重开库；路径没变就复用，不做无谓 IO
    const want = dataRoot()
    if (bootState?.ok && bootState.dataRoot === want) return bootState
    bootState = await openStore({ dataRoot: want })
    return bootState
  }

  // ── host 服务（P4 #5）：identity 的受控写只有根藏能做；镜台/其它插件经 ctx.get 调用 ──
  // dataRoot 强制用本插件的，不接受调用方传入（防跨库写）。
  if (typeof ctx.provide === 'function') {
    disposers.push(ctx.provide('jianmuStore', {
      version: 1,
      identityAddPersona: (opts = {}) => identityAddPersona({ ...opts, dataRoot: dataRoot() }),
      identityRemoveMappings: (opts = {}) => identityRemoveMappings({ ...opts, dataRoot: dataRoot() }),
      identitySummary: () => identitySummary(dataRoot()),
      // ── P4 #10 硬认领（2026-11-13）：根藏数据 + identity 的唯一写者 ──
      claimHardPreview: (opts = {}) => previewHardClaim({ ...opts, dataRoot: dataRoot() }),
      claimHardApply: (opts = {}) => applyHardClaim({ ...opts, dataRoot: dataRoot() }),
      claimHardRollback: (opts = {}) => rollbackHardClaimRoot({ ...opts, dataRoot: dataRoot() }),
      claimHardVerify: async ({ from = PERSONA_UNASSIGNED, to, allowMissingTarget = false } = {}) => {
        const source = await verifyScope(dataRoot(), from)
        let target = to ? await verifyScope(dataRoot(), to) : null
        if (target && !target.ok && allowMissingTarget) {
          const onlyMissing = (target.problems || []).every((p) => p.code === 'SCOPE_MISSING')
          if (onlyMissing) target = { ...target, ok: true, skipped: true, reason: 'target-scope-not-existed-before' }
        }
        return { ok: source.ok && (!target || target.ok), from: source, target }
      },
    }))
  } else {
    log('宿主没有 ctx.provide —— 根藏 identity 服务未注册（工具面不受影响）')
  }

  // ── 插件内定时摄取（取代 Windows 计划任务；不 spawn，不弹控制台黑框）──────
  const autoState = {
    timer: null,
    bootTimer: null,
    watcher: null,
    running: false,
    startedAt: null,
    lastRunAt: null,
    lastOk: null,
    lastError: null,
    lastReport: null,
    nextRunAt: null,
    lastSummary: null,
  }

  const summarizeReport = (r) => (r ? {
    ok: r.ok, skipped: Boolean(r.skipped), at: r.at, finishedAt: r.finishedAt,
    days: r.days, files: r.files, extracted: r.extracted, written: r.written,
    byPersona: r.byPersona, tokens: r.usage?.total_tokens ?? null,
    errors: (r.errors || []).slice(0, 3),
  } : null)

  const clearAutoTimer = () => {
    if (autoState.timer) { clearTimeout(autoState.timer); autoState.timer = null }
  }

  const scheduleAuto = () => {
    clearAutoTimer()
    const cfg = liveCfg()
    if (!cfg.enabled || !cfg.autoIngest) { autoState.nextRunAt = null; return }
    const at = computeNextRunAt(cfg, Date.now())
    autoState.nextRunAt = at
    const timer = setTimeout(() => { tickAuto('定时').catch(() => {}) }, Math.max(1000, at - Date.now()))
    timer.unref?.()
    autoState.timer = timer
  }

  const tickAuto = async (reason) => {
    const cfg = liveCfg()
    if (!cfg.enabled || !cfg.autoIngest) { scheduleAuto(); return }
    if (autoState.running) { scheduleAuto(); return }
    autoState.running = true
    autoState.startedAt = Date.now()
    log(`自动摄取开始（${reason}；days=${cfg.ingestDays}）`)
    try {
      const report = await runAutoIngest({
        dataRoot: dataRoot(),
        days: cfg.ingestDays,
        config: cfg,
        logger: (m) => log(m),
      })
      autoState.lastOk = Boolean(report?.ok !== false)
      autoState.lastReport = summarizeReport(report)
      autoState.lastError = report?.skipped
        ? null
        : (report?.ok === false ? (report.errors?.[0] || report.error || null) : null)
      // A2 自动摘要：摄取之后挂一步（默认关）。独立 try —— 它出任何问题都不能影响摄取结果。
      if (!report?.skipped) {
        try {
          autoState.lastSummary = await runAutoSummaryAfterIngest({
            dataRoot: dataRoot(), config: cfg, report, logger: (m) => log(m),
          })
        } catch (e) {
          autoState.lastSummary = { ok: false, at: new Date().toISOString(), errors: [{ code: 'AUTO_SUMMARY_FAILED', message: String(e?.message || e) }] }
          log(`自动摘要异常（已捕获，不影响摄取）：${e?.message || e}`)
        }
      }
    } catch (e) {
      autoState.lastOk = false
      autoState.lastError = { code: e?.code || 'AUTO_INGEST_FAILED', message: String(e?.message || e) }
      log(`自动摄取异常（已捕获，不影响宿主）：${e?.message || e}`)
    } finally {
      autoState.running = false
      autoState.lastRunAt = Date.now()
      scheduleAuto()
    }
  }

  // 启动 60 秒后补跑一次（DSH 不是 24 小时常开：错过整点也要补）
  autoState.bootTimer = setTimeout(() => {
    autoState.bootTimer = null
    if (autoState.lastRunAt && Date.now() - autoState.lastRunAt < 5 * 60000) return
    tickAuto('启动').catch(() => {})
  }, 60000)
  autoState.bootTimer.unref?.()

  // 设置页把自动摄取从关改成开时，不用重启也能在 5 分钟内接上
  autoState.watcher = setInterval(() => {
    const cfg = liveCfg()
    if (cfg.enabled && cfg.autoIngest && !autoState.timer && !autoState.bootTimer) scheduleAuto()
    if ((!cfg.enabled || !cfg.autoIngest) && autoState.timer) clearAutoTimer()
  }, 5 * 60000)
  autoState.watcher.unref?.()

  scheduleAuto()

  const autoInfo = () => {
    const cfg = liveCfg()
    let embedding
    try {
      const e = loadEmbeddingConfig(cfg)
      embedding = { configured: Boolean(e.ok), source: e.source || null, apiBase: e.apiBase || null }
    } catch { embedding = { configured: false, source: null, apiBase: null } }
    return {
      enabled: Boolean(cfg.enabled && cfg.autoIngest),
      intervalMinutes: cfg.autoIngestIntervalMinutes,
      minute: cfg.autoIngestMinute,
      running: autoState.running,
      nextRunAt: autoState.nextRunAt,
      lastRunAt: autoState.lastRunAt,
      lastOk: autoState.lastOk,
      lastError: autoState.lastError,
      lastReport: autoState.lastReport,
      embedding,
      autoSummary: {
        enabled: Boolean(cfg.autoSummaryIndex),
        model: cfg.summaryModel,
        minChars: cfg.summaryMinChars,
        lastRunAt: autoState.lastSummary?.at || null,
        lastResult: autoState.lastSummary,
      },
    }
  }

  // ── 工具 1：摄取
  tool({
    name: 'jianmu_store_ingest',
    description: [
      '根藏·摄取：把 DSH 会话里的**原话**写进对应人格的存储库（按 personaId 分库，不跨人格）。',
      '有三种来源：from=sessions（读 ~/.dsh/sessions，只读）、from=utterances（显式行，测试/导入）、from=legacy（从旧寻枝库迁移，只读旧库）。',
      '会话摄取默认在设置里关闭（ingestEnabled=false）；需要时显式传 force=true。',
      '注意：**带向量的自动摄取已经内置在插件里**（设置 → 根藏 → 自动摄取；默认每小时 :07，插件内定时、不弹控制台）。',
      '本骨架**不做嵌入**：新块会进 missingVectors，status 会报警（已存下但检索不可见）。',
      '首次导入用本工具（from=sessions，会写一次完整快照）；之后自动摄取按小时增量。',
      '已有向量的 scope 会被**拒绝**（EMBEDDING_REQUIRED），以免文本-only 追加破坏向量对齐；要带向量请等自动摄取，或用 tools/ingest-hourly.mjs（先嵌后写，且要求 scope 已存在）。',
    ].join('\n'),
    parameters: {
      from: { type: 'string', description: '来源：sessions / utterances / legacy', enum: ['sessions', 'utterances', 'legacy'] },
      personaId: { type: 'string', description: '只摄某个人格（隔离用；不填按解析结果分库）' },
      days: { type: 'number', description: 'from=sessions 时只摄最近 N 天（默认用设置值）' },
      ws: { type: 'string', description: 'from=sessions 时只摄某个工作区（真实路径）' },
      limit: { type: 'number', description: '最多摄取多少块（试跑用）' },
      dryRun: { type: 'boolean', description: '只统计不落盘' },
      force: { type: 'boolean', description: '会话摄取总闸关着时，显式放行本次' },
      utterances: { type: 'array', description: 'from=utterances 时的行数组（原话块）', items: { type: 'object', additionalProperties: true } },
      vectors: { type: 'array', description: 'from=utterances 时的向量行（与 utterances 一一对应；可省略）', items: { type: 'number' } },
      dim: { type: 'number', description: 'from=utterances 时的向量维度（必须与 manifest.dim 一致）' },
      embedding: { type: 'object', description: 'from=utterances 时的嵌入元数据 {provider,model,dim,normalizerVersion}；与 manifest 不一致会被拒绝', additionalProperties: true },
      legacyIndex: { type: 'string', description: 'from=legacy 时旧库 index 目录（绝对路径）' },
      legacyPersonaId: { type: 'string', description: 'from=legacy 时代入的 personaId' },
    },
    async execute(args) {
      const cfg = liveCfg()
      const store = await ensureStore()
      if (!store.ok) return { ok: false, ...store, hint: '数据根不可用：检查 dataRoot 权限与磁盘' }
      const from = String(args.from || 'sessions')
      if (from === 'utterances') {
        return ingestUtterances({
          dataRoot: store.dataRoot,
          utterances: Array.isArray(args.utterances) ? args.utterances : [],
          vectors: args.vectors || null,
          dim: Number(args.dim) || 0,
          embedding: args.embedding || null,
          dryRun: Boolean(args.dryRun),
        })
      }
      if (from === 'legacy') {
        if (!args.legacyIndex) return { ok: false, code: 'BAD_ARGS', message: 'from=legacy 需要 legacyIndex（旧库 index 目录）' }
        const pid = String(args.legacyPersonaId || args.personaId || '').trim()
        if (!pid) return { ok: false, code: 'BAD_ARGS', message: 'from=legacy 需要 legacyPersonaId' }
        const legacy = await readLegacyIndex(args.legacyIndex)
        if (!legacy.ok) return { ok: false, ...legacy }
        const report = await migrateLegacyIndex({
          outRoot: store.dataRoot,
          sources: [{ id: 'legacy', personaId: pid, indexDir: args.legacyIndex }],
          limitPerSource: Number(args.limit) || legacy.chunks.length,
          perWsMax: 100000,
          write: !args.dryRun,
          // 把 identity 交给迁移器：工作区命中与源级归属冲突会报警（不静默写错人格）
          identity: store.identity,
        })
        return report
      }
      // from === 'sessions'
      if (!cfg.ingestEnabled && !args.force) {
        return {
          ok: false,
          code: 'INGEST_DISABLED',
          message: '会话增量摄取默认关闭（ ingestEnabled=false ）。确认要跑就传 force=true；施工计划里晚上切换后才默认启用。',
        }
      }
      const identity = store.identity
      return ingestSessions({
        dataRoot: store.dataRoot,
        identity,
        days: Number(args.days) || cfg.ingestDays,
        personaId: args.personaId || null,
        // 只在显式传 ws 时收窄；不默认缩到调用方工作区（否则「摄取某人格」会静默漏块）
        ws: args.ws || null,
        dryRun: Boolean(args.dryRun),
        limit: args.limit ? Number(args.limit) : null,
      })
    },
  })

  // ── 工具 2：状态
  tool({
    name: 'jianmu_store_status',
    description: [
      '根藏·状态：报块数 / 会话数 / 人格 / 未归属 / 向量缺失 / 错误 / 数据目录 / 磁盘余量。',
      '不传 personaId 就报整个 dataRoot（含 identity.json 健康状态）。',
      'autoIngest 字段是插件内定时摄取状态（上次跑完没、下次什么时候、嵌入了多少）；它取代了旧的 Windows 计划任务。',
      'degraded 字段为真时必须把 warnings/errors 原样告诉用户，不要只说「正常」。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '只看某个人格；不填看全部' },
      deep: { type: 'boolean', description: '深检向量（读整个向量文件核模长；大库会慢）' },
      verify: { type: 'boolean', description: '顺带跑 verify（块数/重复 id/孤儿 tmp/墓碑/归档）' },
    },
    async execute(args) {
      const cfg = liveCfg()
      const store = await ensureStore()
      const root = store.dataRoot || dataRoot()
      const pid = args.personaId ? String(args.personaId) : null
      if (pid) {
        const st = await statusOfScope(root, pid, { deep: Boolean(args.deep) })
        if (args.verify) st.verify = await verifyScope(root, pid)
        return { ok: true, dataRoot: root, version: VERSION, contractVersion: 1, identity: identityForPersona(store.identityState, pid), scope: st, autoIngest: autoInfo() }
      }
      const all = await statusAll(root, { deep: Boolean(args.deep) })
      all.version = VERSION
      all.ingestEnabled = Boolean(cfg.ingestEnabled)
      all.autoIngest = autoInfo()
      if (args.verify) {
        all.verify = {}
        for (const p of Object.keys(all.scopes)) all.verify[p] = await verifyScope(root, p)
      }
      return all
    },
  })

  // ── 工具 3：重建（不重嵌）
  tool({
    name: 'jianmu_store_rebuild',
    description: [
      '根藏·重建：从 chunks.jsonl（唯一真源）重建 index_meta。**0 次嵌入**，不扣费。',
      '向量缺失时只恢复文本索引，并在结果里提示需要显式 reembed（本骨架没有 reembed 入口）。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '要重建的人格 scope' },
    },
    async execute(args) {
      const store = await ensureStore()
      if (!store.ok) return { ok: false, ...store }
      const pid = String(args.personaId || '').trim()
      if (!pid) return { ok: false, code: 'BAD_ARGS', message: 'personaId 必填（不提供跨人格重建）' }
      return rebuildIndexMeta({ dataRoot: store.dataRoot, personaId: pid })
    },
  })

  // ── 工具 4：导出
  tool({
    name: 'jianmu_store_export',
    description: '根藏·导出：把某个人格的 chunks.jsonl 导出成一份（备份/迁移用）；可顺带导出 manifest。',
    parameters: {
      personaId: { type: 'string', description: '要导出的人格 scope' },
      outFile: { type: 'string', description: '导出到哪个文件（绝对路径）；不填只返回块数/字节/hash' },
      includeManifest: { type: 'boolean', description: '顺带导出 manifest.json' },
    },
    async execute(args) {
      const store = await ensureStore()
      if (!store.ok) return { ok: false, ...store }
      const pid = String(args.personaId || '').trim()
      if (!pid) return { ok: false, code: 'BAD_ARGS', message: 'personaId 必填（不提供跨人格导出）' }
      return exportChunks({ dataRoot: store.dataRoot, personaId: pid, outFile: args.outFile || null, includeManifest: Boolean(args.includeManifest) })
    },
  })

  // ── 工具 5：显式忘记（Stage 0；只写墓碑，永不物理删原话）
  tool({
    name: 'jianmu_store_forget',
    description: [
      '根藏·显式忘记：往 deleted.jsonl 追加墓碑，让这些原话从检索/年轮/熏习的**读边界**消失。',
      '**永不物理删除 chunks.jsonl**；写前自动快照（chunks + deleted），宽限期内可 revive。',
      'confirm=false（或不传）只返回预览，不落盘；确认后传 confirm=true 才写。',
      '目标二选一：chunkIds（数组，≤500）或 sessionId（整会话，≤500 块）。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '人格 scope（必填，不跨人格）' },
      chunkIds: { type: 'array', description: '要忘记的块 id 数组（≤500）', items: { type: 'string' } },
      sessionId: { type: 'string', description: '按会话整体忘记（与 chunkIds 二选一）' },
      reason: { type: 'string', description: '原因（记进墓碑，默认 user:forget）' },
      graceDays: { type: 'number', description: '宽限期天数（0–90，默认 7）' },
      confirm: { type: 'boolean', description: '二次确认；true 才真正写墓碑' },
    },
    async execute(args) {
      const store = await ensureStore()
      if (!store.ok) return { ok: false, ...store }
      const pid = String(args.personaId || '').trim()
      if (!pid) return { ok: false, code: 'BAD_ARGS', message: 'personaId 必填（不提供跨人格忘记）' }
      if (args.confirm !== true) {
        return forgetPreview({ dataRoot: store.dataRoot, personaId: pid, chunkIds: args.chunkIds || null, sessionId: args.sessionId || null, graceDays: args.graceDays })
      }
      return forgetChunks({
        dataRoot: store.dataRoot, personaId: pid,
        chunkIds: args.chunkIds || null, sessionId: args.sessionId || null,
        reason: args.reason || 'user:forget', graceDays: args.graceDays, confirm: true,
      })
    },
  })

  // ── 工具 6：撤销忘记（只追加 revive 行）
  tool({
    name: 'jianmu_store_revive',
    description: '根藏·撤销忘记：追加 revive 行（不改旧行）；各层读墓碑时按最新状态裁决。需 confirm=true。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（必填）' },
      chunkIds: { type: 'array', description: '要恢复的块 id 数组', items: { type: 'string' } },
      reason: { type: 'string', description: '原因（默认 user:revive）' },
      confirm: { type: 'boolean', description: '确认写入' },
    },
    async execute(args) {
      const store = await ensureStore()
      if (!store.ok) return { ok: false, ...store }
      const pid = String(args.personaId || '').trim()
      if (!pid) return { ok: false, code: 'BAD_ARGS', message: 'personaId 必填（不提供跨人格恢复）' }
      return reviveChunks({ dataRoot: store.dataRoot, personaId: pid, chunkIds: args.chunkIds || [], reason: args.reason || 'user:revive', confirm: args.confirm === true })
    },
  })

  // ── 工具 7：登记人格（P4 #5；默认只预览，备份 + 幂等 + 只增不删）──────────
  tool({
    name: 'jianmu_store_identity_add_persona',
    description: [
      '根藏·登记人格：往 identity.json 新增人格 + 工作区/会话映射，让「建了卡却没记忆」不再发生。',
      '默认只预览（dryRun=true）；传 dryRun=false + confirm=true 才真写。',
      '写前自动备份到 <dataRoot>/_archive/identity-<ts>.json；幂等；**只增不删**，不迁移/不删除任何记忆。',
      '工作区/会话已属于别的人格 → 默认跳过并在 warnings 里说明；要改归属需显式 allowReassign=true。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '人格 id（小写字母/数字/_/-，不能是 persona_unassigned）' },
      displayName: { type: 'string', description: '显示名（默认同 personaId）' },
      workspaces: { type: 'array', description: '要归到这个人的工作区绝对路径（最多 200 个）', items: { type: 'string' } },
      sessions: { type: 'array', description: '可选：要归到这个人的会话 id（最多 200 个）', items: { type: 'string' } },
      updateDisplayName: { type: 'boolean', description: '人格已存在时是否更新显示名（默认 true）' },
      allowReassign: { type: 'boolean', description: '允许把已属于别人的人格映射改到这个人（默认 false）' },
      dryRun: { type: 'boolean', description: '只预览（默认 true）' },
      confirm: { type: 'boolean', description: '真写确认（配合 dryRun=false）' },
    },
    async execute(args) {
      return identityAddPersona({
        dataRoot: dataRoot(),
        personaId: args.personaId,
        displayName: args.displayName,
        workspaces: args.workspaces || [],
        sessions: args.sessions || [],
        updateDisplayName: args.updateDisplayName !== false,
        allowReassign: args.allowReassign === true,
        dryRun: args.dryRun !== false,
        confirm: args.confirm === true,
      })
    },
  })

  // ── UI HTTP 路由（0.2.6）：状态卡 + 设置 + 测试连接 ────────────────────────
  // 只读状态复用 statusAll（与 jianmu_store_status 同一口径，UI 数字不会和工具打架）。
  // 写动作只有「插件设置」，**不写任何记忆数据**；三条闸门：JSON + 自定义头 + 同源。
  const sendJson = (res, status, value) => {
    let body
    try { body = JSON.stringify(value) } catch { body = '{"ok":false,"code":"SERIALIZE_FAILED"}' }
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }

  const settingsInfo = () => {
    const cfg = liveCfg()
    const sr = settingsRow()
    let embed = { ok: false, source: null, apiBase: null }
    try {
      const e = loadEmbeddingConfig(cfg)
      embed = { ok: Boolean(e.ok), source: e.source || null, apiBase: e.apiBase || null }
    } catch { /* 读不到就按未配置 */ }
    const rawRoot = cfg.dataRoot
    const dataRootSource = typeof rawRoot === 'string' && rawRoot.trim() ? 'config' : 'default'
    return publicSettings({
      cfg,
      revision: sr ? sr.revision : null,
      writable: Boolean(sr && typeof sr.service.update === 'function'),
      embed,
      dataRoot: dataRoot(),
      dataRootSource,
    })
  }

  /** 测试连接用哪个模型/维度：从库里的 manifest 读（不猜），并列出所有人格，发现不一致要说 */
  const embeddingTargets = async (root) => {
    let all
    try { all = await statusAll(root, {}) } catch (e) { return { ok: false, code: 'STATUS_FAILED', message: String(e?.message || e) } }
    const rows = Object.entries(all.scopes || {})
      .map(([personaId, st]) => ({ personaId, model: st?.embedding?.model || null, dim: Number(st?.embedding?.dim) || 0 }))
      .filter((x) => x.model)
    if (!rows.length) return { ok: false, code: 'MODEL_UNKNOWN', message: '库里还没有 manifest（先跑一次摄取），无法确定嵌入模型' }
    const models = [...new Set(rows.map((x) => `${x.model}@${x.dim}`))]
    return { ok: true, model: rows[0].model, dim: rows[0].dim, scopes: rows, mixed: models.length > 1, models }
  }

  const handleStoreApi = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const sub = url.pathname.slice(API_PREFIX.length) || '/'

      if (req.method === 'POST') {
        const guard = checkWriteRequest(req)
        if (!guard.ok) return sendJson(res, guard.status, guard.body)
        const parsed = await readJsonBody(req)
        if (!parsed.ok) {
          return sendJson(res, parsed.status || 400, { ok: false, code: parsed.code, error: { code: parsed.code, message: parsed.message } })
        }
        const body = parsed.value
        if (body.confirm !== true) {
          return sendJson(res, 400, { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '写设置需要 confirm: true（服务端不信 UI）' } })
        }

        if (sub === '/settings' || sub === '/') {
          const checked = validateSettingsPatch(body.patch)
          if (!checked.ok) return sendJson(res, 400, { ok: false, code: checked.code, error: { code: checked.code, message: checked.message } })
          const sr = settingsRow()
          if (!sr) {
            return sendJson(res, 503, { ok: false, code: 'SETTINGS_UNAVAILABLE', error: { code: 'SETTINGS_UNAVAILABLE', message: '宿主没有可写的设置服务：请在 profile 的 cordis.patch.yml 里改 dsh-memory-store 的 config' } })
          }
          if (typeof sr.service.update !== 'function') {
            return sendJson(res, 503, { ok: false, code: 'SETTINGS_UNAVAILABLE', error: { code: 'SETTINGS_UNAVAILABLE', message: '设置服务不支持写入（版本过旧）：请手工改 cordis.patch.yml' } })
          }
          try {
            await sr.service.update(sr.row.ns || name, checked.value, body.expectedRevision)
          } catch (e) {
            const code = String(e?.code || e?.name || 'SETTINGS_WRITE_FAILED')
            if (code === 'SETTINGS_CONFLICT' || /changed since it was read/.test(String(e?.message || ''))) {
              return sendJson(res, 409, {
                ok: false, code: 'STALE_SETTINGS',
                error: { code: 'STALE_SETTINGS', message: '设置被人改过了（revision 变了）：已刷新，请重新保存' },
                actualRevision: e?.actual ?? null,
              })
            }
            return sendJson(res, 500, { ok: false, code, error: { code, message: String(e?.message || e).slice(0, 300) } })
          }
          // 设置是当场生效的：自动摄取开关立刻重排定时器（不用等 5 分钟的巡检）
          try { scheduleAuto() } catch { /* 重排失败不影响写入结果 */ }
          return sendJson(res, 200, settingsInfo())
        }

        if (sub === '/test-embedding') {
          const cfg = liveCfg()
          let embed
          try { embed = loadEmbeddingConfig(cfg) } catch { embed = { ok: false } }
          const root = dataRoot()
          const target = await embeddingTargets(root)
          if (!target.ok) {
            return sendJson(res, 200, { ok: false, code: target.code, latencyMs: 0, message: target.message })
          }
          const r = await testEmbedding({ embed, model: target.model, dim: target.dim, timeoutMs: 15000 })
          return sendJson(res, 200, { ...r, scopes: target.scopes, mixedModels: target.mixed, models: target.models })
        }

        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知写端点：${sub}` } })
      }

      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 GET（读）与 POST（设置/测试连接）' } })
      }

      if (sub === '/status' || sub === '/') {
        const store = await ensureStore()
        const root = store.dataRoot || dataRoot()
        const all = await statusAll(root, {})
        all.version = VERSION
        all.ingestEnabled = Boolean(liveCfg().ingestEnabled)
        all.autoIngest = autoInfo()
        all.settings = settingsInfo()
        return sendJson(res, 200, all)
      }
      if (sub === '/settings') return sendJson(res, 200, settingsInfo())
      if (sub === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION, dataRoot: dataRoot() })
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知只读端点：${sub}` } })
    } catch (e) {
      return sendJson(res, 500, { ok: false, code: e?.code || 'API_FAILED', error: toErrInfo(e) })
    }
  }

  const storeRoute = { kind: 'prefix', path: API_PREFIX, handler: handleStoreApi }
  // webServer 是可选服务、且可能晚于本插件就绪：用 ctx.inject 等它就位再挂（与熏习同法）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      const ws = sub?.webServer
      if (!ws || typeof ws.register !== 'function') {
        log('宿主没有 webServer —— 根藏 UI 路由未注册（工具面不受影响）')
        return
      }
      sub.effect(() => ws.register(storeRoute), 'memory-store:ui-route')
    })
  } else {
    const webServer = (() => { try { return ctx.get?.('webServer', false) } catch { return undefined } })()
    if (webServer && typeof webServer.register === 'function') disposers.push(webServer.register(storeRoute))
    else log('宿主没有 webServer —— 根藏 UI 路由未注册（工具面不受影响）')
  }

  // ── 守卫自检（启动时把工具面跑一遍；违反就写日志，不炸宿主）
  const surface = checkToolSurface(declaredToolNames())
  if (!surface.ok) log(`⚠️ 工具面守卫未通过：${surface.problems.join('；')}`)

  log(`已注册 ${disposers.length} 个工具（版本 ${VERSION}；persona_unassigned 与具名人格物理隔离）`)
  const dispose = () => {
    try { clearAutoTimer() } catch { /* 忽略 */ }
    try { if (autoState.bootTimer) clearTimeout(autoState.bootTimer) } catch { /* 忽略 */ }
    try { if (autoState.watcher) clearInterval(autoState.watcher) } catch { /* 忽略 */ }
    autoState.bootTimer = null
    autoState.watcher = null
    for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
  }
  // 测试/诊断用：`dispose.ready` 是启动时 openStore 的 Promise（等它才能断言降级状态）
  dispose.ready = ready
  dispose.autoIngest = () => autoInfo()
  return dispose
}

export { PERSONA_UNASSIGNED, loadIdentity, defaultDataRoot }
