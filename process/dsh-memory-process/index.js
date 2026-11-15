/**
 * dsh-memory-process —— 熏习（建木 · 处理层）host 半端
 * ============================================================================
 * 只做「状态与归属」：把根藏原话整理成可管理、可追溯的标注。
 *
 * 明确不做（契约 v1）：
 *   ❌ 不改原文 / 不写 topic 正文 / 不注入 / 不检索 / 不自动总结
 *   ❌ 不跨 persona 读写 / 不做跨人格共享
 *   ❌ 默认零 LLM、零网络、零嵌入
 *
 * 工具面：jianmu_process_{run,status,review,apply,topics,conflicts,rebuild,verify,export}
 * 数据布局：<dataRoot>/process/<personaId>/{state,duplicates,pending,conflicts,...}.jsonl
 * ============================================================================
 */
import { resolve } from 'node:path'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { defaultDataRoot, isSafePersonaId, PERSONA_UNASSIGNED, processDir } from './lib/paths.mjs'
import { checkToolName, checkToolSurface } from './lib/guards.mjs'
import { VERSION, ALLOWED_TOOLS } from './lib/version.mjs'
import { readIdentity, listScopes } from './lib/root.mjs'
import { runProcess } from './lib/run.mjs'
import { applyPending, dismissPending, createManualPending } from './lib/apply.mjs'
import { verifyProcess, repairProcess } from './lib/verify.mjs'
import { rebuildProcess } from './lib/rebuild.mjs'
import { exportProcess } from './lib/export.mjs'
import { readScope } from './lib/root.mjs'
import { sourceStatus, sourceWorkspaces, sourceMemories, sourceProbe } from './lib/session-source.mjs'
import { storageReport, recordStorageSnapshot } from './lib/storage.mjs'
import { overview, readPendingMap, readDuplicatesMap, readConflictsMap } from './lib/store.mjs'
import {
  apiContext, apiCapabilities, apiOverview, apiRootStorage, apiMemories, apiMemory,
  apiChunks, apiTopics, apiPending, apiConflicts, apiStatus, apiVerify, apiSessionPersona, apiLifecycle,
} from './lib/api.mjs'
import { toErrInfo } from './lib/errors.mjs'
import { listConflictCards } from './lib/conflictcards.mjs'
import { previewMoveState, moveState, rebuildAfterMove, rollbackMoveState } from './lib/hardclaim.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'memory-process'
export const inject = ['tools']

export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(true).extra('volatile', true)
    .description('总开关：关掉后工具只回一句「已关闭」'),
  dataRoot: z.string().default('').extra('volatile', true)
    .description('根藏数据根；熏习只读 <dataRoot>/scopes，只写 <dataRoot>/process/<personaId>'),
  processEnabled: z.boolean().default(true).extra('volatile', true)
    .description('处理总闸（v1 默认开；关掉只读状态）'),
  autoMirrorRetention: z.boolean().default(true).extra('volatile', true)
    .description('把根藏 retention=expired 镜像成 state.expired（不物理删）'),
  llmEnabled: z.boolean().default(false).extra('volatile', true)
    .description('可选 LLM 建议（v1 默认关；开启也要过预算上限）'),
  maxChunksPerRun: z.natural().default(20000).extra('volatile', true)
    .description('单次 run 处理块数上限；超限写 checkpoint 续跑'),
  autoRun: z.boolean().default(true).extra('volatile', true)
    .description('自动跟随：插件内定时（默认每小时 :17）检查根藏变化，有新块就整理状态；不再依赖 Windows 计划任务/控制台脚本'),
  autoRunIntervalMinutes: z.natural().default(60).extra('volatile', true)
    .description('自动跟随间隔（分钟）；autoRunMinute=-1 时按这个间隔跑'),
  autoRunMinute: z.number().default(17).extra('volatile', true)
    .description('每小时第几分钟跑（0–59，默认 17 = 根藏 :07 摄取之后；-1 = 按固定间隔）'),
})

const DEFAULTS = Object.freeze({
  enabled: true,
  dataRoot: '',
  processEnabled: true,
  autoMirrorRetention: true,
  llmEnabled: false,
  maxChunksPerRun: 20000,
  autoRun: true,
  autoRunIntervalMinutes: 60,
  autoRunMinute: 17,
})

function normalizeConfig(cfg) {
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = cfg ? cfg[k] : undefined
    if (v === undefined || v === null || v === '') continue
    if (k === 'dataRoot') {
      if (typeof v === 'string') out[k] = v
    } else if (typeof DEFAULTS[k] === 'boolean') {
      // 设置层可能把布尔值序列化成字符串/对象：只认真正的布尔
      if (typeof v === 'boolean') out[k] = v
    } else if (k === 'maxChunksPerRun' || k === 'autoRunIntervalMinutes' || k === 'autoRunMinute') {
      const n = Number(v)
      if (Number.isFinite(n) && (n >= 0 || (k === 'autoRunMinute' && n === -1))) out[k] = Math.floor(n)
    } else {
      out[k] = v
    }
  }
  return out
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
    try { ctx.logger?.info?.(`[memory-process] ${msg}`) } catch { /* 没有 logger 就算了 */ }
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

  // ── 插件内自动跟随（取代旧脚本里的 spawnSync；不弹控制台黑框）────────────
  const autoState = {
    timer: null,
    bootTimer: null,
    watcher: null,
    running: false,
    lastRunAt: null,
    nextRunAt: null,
    last: null,
    lastError: null,
  }

  const computeNextRunAt = (cfg, from = Date.now()) => {
    const minute = Number(cfg.autoRunMinute)
    if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
      const d = new Date(from)
      d.setSeconds(0, 0)
      d.setMinutes(minute)
      if (d.getTime() <= from) d.setHours(d.getHours() + 1)
      return d.getTime()
    }
    return from + Math.max(5, Number(cfg.autoRunIntervalMinutes) || 60) * 60000
  }

  const clearAutoTimer = () => {
    if (autoState.timer) { clearTimeout(autoState.timer); autoState.timer = null }
  }

  const scheduleAuto = () => {
    clearAutoTimer()
    const cfg = liveCfg()
    if (!cfg.enabled || !cfg.processEnabled || !cfg.autoRun) { autoState.nextRunAt = null; return }
    const at = computeNextRunAt(cfg, Date.now())
    autoState.nextRunAt = at
    const t = setTimeout(() => { tickAuto('定时').catch(() => {}) }, Math.max(1000, at - Date.now()))
    t.unref?.()
    autoState.timer = t
  }

  const tickAuto = async (reason) => {
    const cfg = liveCfg()
    if (!cfg.enabled || !cfg.processEnabled || !cfg.autoRun) { scheduleAuto(); return }
    if (autoState.running) { scheduleAuto(); return }
    autoState.running = true
    autoState.lastRunAt = Date.now()
    log(`自动跟随开始（${reason}）`)
    try {
      const pids = await listScopes(dataRoot())
      const out = {}
      for (const pid of pids) {
        try {
          const r = await runProcess({
            dataRoot: dataRoot(),
            personaId: pid,
            maxChunks: Math.max(1, Number(cfg.maxChunksPerRun) || 20000),
            autoMirrorRetention: cfg.autoMirrorRetention !== false,
          })
          const code = r?.code || null
          if (code === 'EMPTY_ROOT' || code === 'SCOPE_MISSING') {
            // 空 scope 不是故障：跳过即可，别每小时报一次假错误
            out[pid] = { ok: true, skipped: true, reason: code }
          } else if (r?.ok === false) {
            out[pid] = { ok: false, code: code || 'RUN_FAILED', skipped: false }
          } else {
            out[pid] = { ok: true, skipped: Boolean(r?.skipped), chunks: r?.chunks ?? null }
          }
        } catch (e) {
          out[pid] = { ok: false, code: e?.code || 'RUN_FAILED', message: String(e?.message || e) }
        }
      }
      autoState.last = out
      autoState.lastError = Object.entries(out).find(([, v]) => v && v.ok === false)
        ? { personaId: Object.entries(out).find(([, v]) => v && v.ok === false)[0] }
        : null
      log(`自动跟随完成：${JSON.stringify(out)}`)
    } catch (e) {
      autoState.lastError = { code: e?.code || 'AUTO_RUN_FAILED', message: String(e?.message || e) }
      log(`自动跟随异常（已捕获，不影响宿主）：${e?.message || e}`)
    } finally {
      autoState.running = false
      autoState.lastRunAt = Date.now()
      scheduleAuto()
    }
  }

  const autoInfo = () => {
    const cfg = liveCfg()
    return {
      enabled: Boolean(cfg.enabled && cfg.processEnabled && cfg.autoRun),
      intervalMinutes: cfg.autoRunIntervalMinutes,
      minute: cfg.autoRunMinute,
      running: autoState.running,
      nextRunAt: autoState.nextRunAt,
      lastRunAt: autoState.lastRunAt,
      last: autoState.last,
      lastError: autoState.lastError,
    }
  }

  // 启动 180 秒后补跑一次（等根藏的启动摄取先落地）
  autoState.bootTimer = setTimeout(() => {
    autoState.bootTimer = null
    if (autoState.lastRunAt && Date.now() - autoState.lastRunAt < 10 * 60000) return
    tickAuto('启动').catch(() => {})
  }, 180000)
  autoState.bootTimer.unref?.()

  autoState.watcher = setInterval(() => {
    const cfg = liveCfg()
    if (cfg.enabled && cfg.processEnabled && cfg.autoRun && !autoState.timer && !autoState.bootTimer) scheduleAuto()
    if ((!cfg.enabled || !cfg.processEnabled || !cfg.autoRun) && autoState.timer) {
      clearAutoTimer()
      autoState.nextRunAt = null
    }
  }, 5 * 60000)
  autoState.watcher.unref?.()

  scheduleAuto()

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
    if (!checked.ok) throw new Error(`[memory-process] 工具名违反守卫：${checked.problems.join('；')}`)
    registeredNames.push(spec.name)
    const dispose = ctx.tools.register(defineTool({
      ...spec,
      output: textOutput,
      async execute(args, exec) {
        const cfg = liveCfg()
        if (!cfg.enabled) return { ok: false, code: 'DISABLED', note: '熏习在设置里已关闭（dsh-memory-process → 总开关）' }
        try {
          return safe(await spec.execute(args || {}, exec, cfg))
        } catch (e) {
          return safe({ ok: false, ...toErrInfo(e), hint: '先跑 status/verify 看状态；不要重试覆盖已有数据' })
        }
      },
      isConcurrencySafe: () => true,
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

  /**
   * 解析 personaId：
   *   显式 personaId → 采用；否则按工作区最长前缀匹配 identity；
   *   都拿不到就报错（不提供跨人格默认、不静默归入具名人格）。
   */
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
      const norm = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
      const target = norm(ws)
      let best = null
      for (const [w, pid] of Object.entries(id.identity.workspaces ?? {})) {
        const nw = norm(w)
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

  const requireConfig = (cfg) => {
    if (!cfg.processEnabled) return { ok: false, code: 'PROCESS_DISABLED', note: '处理总闸已关闭（processEnabled=false）' }
    return null
  }

  // ── 工具 1：run
  tool({
    name: 'jianmu_process_run',
    description: [
      '熏习·run：只读根藏 chunks，生成状态/重复/取代/过期/归档候选。',
      '默认不应用任何候选；默认零 LLM、零网络、零嵌入。',
      '同一 rootBuiltAt 不重复跑；超限写 checkpoint，下次续跑；失败不隐藏任何记忆。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '要处理的人格 scope（不填按工作区解析）' },
      force: { type: 'boolean', description: '忽略幂等，强制重跑' },
      maxChunks: { type: 'number', description: '本次最多处理多少块（默认用设置值）' },
    },
    async execute(args, exec, cfg) {
      const off = requireConfig(cfg)
      if (off) return off
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return runProcess({
        dataRoot: dataRoot(),
        personaId: p.personaId,
        force: Boolean(args.force),
        maxChunks: Number(args.maxChunks) || cfg.maxChunksPerRun,
        autoMirrorRetention: cfg.autoMirrorRetention !== false,
      })
    },
  })

  // ── 工具 2：status
  tool({
    name: 'jianmu_process_status',
    description: '熏习·状态：块数/状态计数/topic/pending/conflicts/容量/最近运行/错误/锁。auto 字段是插件内自动跟随状态（取代旧计划任务）。degraded 与 warnings 必须原样告知用户。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      deep: { type: 'boolean', description: '顺带读根藏统计（只读）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      const root = await readScope(dataRoot(), p.personaId)
      if (!root.ok) return { ok: false, code: root.code, error: root.error }
      const ov = await overview(dataRoot(), p.personaId, { chunks: root.chunks, rootBuiltAt: root.manifest?.builtAt ?? null })
      if (!args.deep) return { ...ov, auto: autoInfo() }
      return {
        ...ov,
        auto: autoInfo(),
        root: {
          ...ov.root,
          manifest: {
            generation: root.manifest?.generation,
            builtAt: root.manifest?.builtAt,
            contractVersion: root.manifest?.contractVersion,
            retentionDays: root.manifest?.retentionDays,
          },
          stats: root.stats,
          invalid: root.invalid.length,
          problems: root.problems,
        },
      }
    },
  })

  // ── 工具 3：review
  tool({
    name: 'jianmu_process_review',
    description: '熏习·复查：列出 pending / duplicates / conflicts 候选（不应用）。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      kind: { type: 'string', description: 'pending / duplicates / conflicts；不填全列', enum: ['pending', 'duplicates', 'conflicts'] },
      limit: { type: 'number', description: '每类最多返回几条（默认 200）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      const root = dataRoot()
      const [pending, duplicates, conflicts] = await Promise.all([
        readPendingMap(root, p.personaId),
        readDuplicatesMap(root, p.personaId),
        readConflictsMap(root, p.personaId),
      ])
      const limit = Number(args.limit) || 200
      const kind = args.kind ? String(args.kind) : null
      const out = {
        ok: true,
        personaId: p.personaId,
        summary: {
          pending: [...pending.map.values()].filter((x) => x.status === 'pending').length,
          duplicates: [...duplicates.map.values()].filter((x) => x.status === 'pending').length,
          conflicts: [...conflicts.map.values()].filter((x) => x.status === 'open').length,
        },
      }
      if (!kind || kind === 'pending') out.pending = [...pending.map.values()].filter((x) => x.status === 'pending').slice(0, limit)
      if (!kind || kind === 'duplicates') out.duplicates = [...duplicates.map.values()].filter((x) => x.status === 'pending').slice(0, limit)
      if (!kind || kind === 'conflicts') out.conflicts = [...conflicts.map.values()].filter((x) => x.status === 'open').slice(0, limit)
      return out
    },
  })

  // ── 工具 4：apply
  tool({
    name: 'jianmu_process_apply',
    description: [
      '熏习·应用：确认应用 pending（supersede/archive/expire/dedupe）。',
      '必须带 expectedGeneration + confirm=true；根藏 generation 变化后旧候选会被拒（「旧任务未写入」）。',
      '写前自动快照到 _archive/；同一 applyId 重复调用幂等。',
    ].join('\n'),
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      pendingIds: { type: 'array', items: { type: 'string' }, description: '要应用的 pendingId 列表' },
      expectedGeneration: { type: 'number', description: '调用方看到的 process generation' },
      confirm: { type: 'boolean', description: '破坏性动作确认' },
      applyId: { type: 'string', description: '幂等键（不填按 pendingIds+generation 生成）' },
    },
    async execute(args, exec, cfg) {
      const off = requireConfig(cfg)
      if (off) return off
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return applyPending({
        dataRoot: dataRoot(),
        personaId: p.personaId,
        pendingIds: Array.isArray(args.pendingIds) ? args.pendingIds.map(String) : [],
        expectedGeneration: args.expectedGeneration,
        confirm: Boolean(args.confirm),
        applyId: args.applyId ? String(args.applyId) : undefined,
      })
    },
  })

  // ── 工具 5：topics（v1a 只读列表；写动作 v1b）
  tool({
    name: 'jianmu_process_topics',
    description: '熏习·主题：列出 topic 元数据 + memberCount（不返回正文；正文归年轮）。v1a 只读，创建/归属排 v1b。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      action: { type: 'string', description: 'list（v1a 只支持 list）', enum: ['list'] },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return apiTopics({ dataRoot: dataRoot(), personaId: p.personaId })
    },
  })

  // ── 工具 6：conflicts（v1a 只读列表；解决 v1.1）
  tool({
    name: 'jianmu_process_conflicts',
    description: '熏习·冲突：列出未解释矛盾（open）。v1a 只读；自动裁决不做，解决动作 v1.1。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      status: { type: 'string', description: 'open / resolved / dismissed；默认 open', enum: ['open', 'resolved', 'dismissed'] },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      const r = await readConflictsMap(dataRoot(), p.personaId)
      const status = args.status ? String(args.status) : 'open'
      const rows = [...r.map.values()].filter((c) => c.status === status)
      return {
        ok: true,
        personaId: p.personaId,
        status,
        total: rows.length,
        rows,
        note: status === 'open' ? '未解释矛盾不自动裁决；保留双方，等用户确认' : null,
      }
    },
  })

  // ── 工具 7：rebuild
  tool({
    name: 'jianmu_process_rebuild',
    description: '熏习·重建：从根藏 + ruleVersion 重建 state/duplicates/conflicts；不调 LLM、不重嵌，先快照。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      confirm: { type: 'boolean', description: '重写状态日志的确认' },
    },
    async execute(args, exec, cfg) {
      const off = requireConfig(cfg)
      if (off) return off
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return rebuildProcess({ dataRoot: dataRoot(), personaId: p.personaId, confirm: Boolean(args.confirm) })
    },
  })

  // ── 工具 8：verify
  tool({
    name: 'jianmu_process_verify',
    description: '熏习·校验：孤儿/stale/缺失/跨 scope/计数一致性。repair=true 只做不删数据的修复。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      repair: { type: 'boolean', description: '顺带跑不删数据的 repair（重算计数/清孤儿 tmp/写 anchor 重映射候选）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      const root = dataRoot()
      if (args.repair) return repairProcess({ dataRoot: root, personaId: p.personaId })
      return verifyProcess({ dataRoot: root, personaId: p.personaId })
    },
  })

  // ── 工具 9：export
  tool({
    name: 'jianmu_process_export',
    description: '熏习·导出：导出 state/topic/pending/conflicts 元数据（备份用；不导出原文）。目标必须在 process 目录内。',
    parameters: {
      personaId: { type: 'string', description: '人格 scope（不填按工作区解析）' },
      out: { type: 'string', description: '导出文件路径（必须在 <dataRoot>/process/<personaId>/ 内）' },
    },
    async execute(args, exec) {
      const p = await resolvePersona(args, exec)
      if (!p.ok) return p
      return exportProcess({ dataRoot: dataRoot(), personaId: p.personaId, out: args.out ? String(args.out) : null })
    },
  })

  // ── 守卫自检：用「实际注册名」校验，不能再拿常量比常量
  const surface = checkToolSurface(registeredNames)
  if (!surface.ok) {
    for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
    throw new Error(`[memory-process] 工具面守卫未通过：${surface.problems.join('；')}`)
  }

  // ── host 只读服务 + HTTP 只读路由（UI v1 数据源；不提供任何写动作）
  const service = {
    context: (workspace = null) => apiContext({ dataRoot: dataRoot(), workspace }),
    sessionContext: (sessionId) => resolveSessionContext(sessionId),
    capabilities: apiCapabilities,
    overview: (personaId) => apiOverview({ dataRoot: dataRoot(), personaId }),
    rootStorage: (personaId) => apiRootStorage({ dataRoot: dataRoot(), personaId }),
    memories: (personaId, opts = {}) => apiMemories({ dataRoot: dataRoot(), personaId, ...opts }),
    memory: (personaId, chunkId, includeText = true) => apiMemory({ dataRoot: dataRoot(), personaId, chunkId, includeText }),
    chunks: (personaId, chunkIds, includeText = false) => apiChunks({ dataRoot: dataRoot(), personaId, chunkIds, includeText }),
    topics: (personaId) => apiTopics({ dataRoot: dataRoot(), personaId }),
    pending: (personaId, opts = {}) => apiPending({ dataRoot: dataRoot(), personaId, ...opts }),
    conflicts: (personaId, opts = {}) => apiConflicts({ dataRoot: dataRoot(), personaId, ...opts }),
    verify: (personaId) => apiVerify({ dataRoot: dataRoot(), personaId }),
    status: (personaId) => apiStatus({ dataRoot: dataRoot(), personaId, config: liveCfg() }),
    lifecycle: () => apiLifecycle({ dataRoot: dataRoot() }),
    // ── P4 #10 硬认领（2026-11-13）：state 行搬迁 ──
    claimHardPreviewState: (opts = {}) => previewMoveState({ ...opts, dataRoot: dataRoot() }),
    claimHardMoveState: (opts = {}) => {
      if (!liveCfg().processEnabled) return { ok: false, code: 'PROCESS_DISABLED', note: '处理总闸已关闭（processEnabled=false）：拒绝搬 state' }
      return moveState({ ...opts, dataRoot: dataRoot() })
    },
    claimHardRebuild: (opts = {}) => {
      if (!liveCfg().processEnabled) return { ok: false, code: 'PROCESS_DISABLED', note: '处理总闸已关闭：拒绝 rebuild' }
      return rebuildAfterMove({ ...opts, dataRoot: dataRoot() })
    },
    claimHardRollbackState: (opts = {}) => rollbackMoveState({ ...opts, dataRoot: dataRoot() }),
  }
  if (typeof ctx.provide === 'function') {
    disposers.push(ctx.provide('jianmuProcess', service))
    // P2.5：冲突卡只读服务（默认无人调用；镜台 conflictCard=true 时每回合读一次）
    // 只读 open 冲突 + 根藏块文本；不写、不裁决、不抛。
    disposers.push(ctx.provide('jianmuConflicts', {
      version: 1,
      list: async ({ personaId = null, workspace = null, limit = 5 } = {}) => {
        let pid = personaId
        if (!pid) {
          const c = await apiContext({ dataRoot: dataRoot(), workspace })
          if (!c.ok || !c.personaId) {
            return {
              ok: false, cards: [], code: c.code || 'PERSONA_UNRESOLVED',
              error: c.error || { code: 'PERSONA_UNRESOLVED', message: '无法解析 persona；冲突卡不注入（不静默归入具名人格）' },
            }
          }
          pid = c.personaId
        }
        return listConflictCards({ dataRoot: dataRoot(), personaId: pid, limit })
      },
    }))
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

  const resolveRoutePersona = async (query) => {
    const ctx = await apiContext({
      dataRoot: dataRoot(),
      workspace: query.workspace || null,
      personaId: query.personaId || null,
    })
    if (!ctx.ok) return { ok: false, status: 500, body: ctx }
    if (!ctx.personaId) {
      return {
        ok: false,
        status: 409,
        body: { ok: false, code: 'PERSONA_UNRESOLVED', error: { code: 'PERSONA_UNRESOLVED', message: '无法解析当前 persona；请显式传 personaId（不静默归入具名人格）' }, context: ctx },
      }
    }
    return { ok: true, personaId: ctx.personaId, context: ctx }
  }

  // ── 会话 → 工作区 → persona（对话「记忆」视图自动解析，2026-11-07）
  // 1) 活会话 header.cwd（host sessions 服务）；2) 根藏里同一 session 的块；3) 都不中 → resolved:false（不猜）
  const sessionCtxCache = new Map()
  const resolveSessionContext = async (sessionId) => {
    const sid = String(sessionId || '').trim()
    const base = await apiContext({ dataRoot: dataRoot(), workspace: null })
    if (!base.ok) return base
    if (!sid) {
      return { ...base, sessionId: null, resolved: false, personaId: null, sessionSource: null, sessionCwd: null, warning: '缺少 session 参数' }
    }
    const cached = sessionCtxCache.get(sid)
    if (cached && Date.now() - cached.at < 60_000) return cached.body

    let cwd = null
    try {
      const sessions = ctx.get?.('sessions')
      const live = sessions?.get?.(sid)
      if (live && typeof live.header?.cwd === 'string' && live.header.cwd) cwd = live.header.cwd
    } catch { /* 没有 sessions 服务就不走这条路 */ }

    let body = null
    if (cwd) {
      const byWs = await apiContext({ dataRoot: dataRoot(), workspace: cwd })
      if (byWs.ok && byWs.personaId) {
        body = { ...byWs, sessionId: sid, sessionCwd: cwd, sessionSource: 'session-cwd', resolved: true }
      }
    }
    if (!body) {
      const byChunk = await apiSessionPersona({ dataRoot: dataRoot(), session: sid })
      if (byChunk.ok && byChunk.personaId) {
        const scoped = await apiContext({ dataRoot: dataRoot(), personaId: byChunk.personaId })
        body = {
          ...scoped, sessionId: sid, sessionCwd: cwd, sessionSource: 'session-chunk',
          resolved: true, chunkId: byChunk.chunkId ?? null,
        }
      }
    }
    if (!body) {
      body = {
        ...base,
        sessionId: sid,
        sessionCwd: cwd,
        sessionSource: null,
        resolved: false,
        personaId: null,
        warning: cwd
          ? `会话工作区（${cwd}）未映射到任何 persona；可手动选择`
          : '未能从会话解析工作区（会话不在当前进程或没有 cwd）；可手动选择',
      }
    }
    sessionCtxCache.set(sid, { at: Date.now(), body })
    return body
  }

  // ── 写动作（P1-1，2026-11-08）：POST + 同源 + x-dsh-jianmu + confirm ─────
  // 原则：UI 可改「状态」，不可删「原话」。所有写动作都走 lib/ 里已有的
  // confirm + expectedGeneration + 写前快照 + 写后读回，不在这里绕开纪律。
  const MAX_BODY = 512 * 1024
  const readJsonBody = (req) => new Promise((resolveBody) => {
    const parts = []
    let size = 0
    let done = false
    const finish = (v) => { if (!done) { done = true; resolveBody(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { finish({ ok: false, code: 'BODY_TOO_LARGE' }); try { req.destroy() } catch { /* ignore */ } return }
      parts.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8').trim()
      if (!raw) return finish({ ok: true, body: {} })
      try {
        const v = JSON.parse(raw)
        if (!v || typeof v !== 'object' || Array.isArray(v)) return finish({ ok: false, code: 'BAD_JSON' })
        finish({ ok: true, body: v })
      } catch { finish({ ok: false, code: 'BAD_JSON' }) }
    })
    req.on('error', () => finish({ ok: false, code: 'BODY_READ_FAILED' }))
  })

  const sameOrigin = (req) => {
    const origin = req.headers?.origin
    if (!origin) return true // 无 Origin 的本地/命令行调用：仍要求 x-dsh-jianmu
    try { return new URL(origin).host === req.headers?.host } catch { return false }
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
  const statusForCode = (code) => {
    if (['BAD_ARGS', 'BAD_KIND', 'BAD_APPLY_ID', 'CONFIRM_REQUIRED', 'PERSONA_REQUIRED', 'BAD_JSON', 'BODY_TOO_LARGE', 'BAD_PERSONA_ID'].includes(code)) return 400
    if (['PENDING_NOT_FOUND', 'CHUNK_NOT_FOUND', 'NOT_FOUND'].includes(code)) return 404
    if (['STALE_GENERATION', 'STALE_ROOT', 'PENDING_NOT_PENDING', 'LOCK_BUSY'].includes(code)) return 409
    return 500
  }
  const writePersona = (body) => {
    const pid = String(body?.personaId || '').trim()
    if (!pid) {
      return { ok: false, status: 400, body: { ok: false, code: 'PERSONA_REQUIRED', error: { code: 'PERSONA_REQUIRED', message: '写动作必须显式传 personaId（不猜、不跨人格）' } } }
    }
    if (pid !== PERSONA_UNASSIGNED && !isSafePersonaId(pid)) {
      return { ok: false, status: 400, body: { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法：${pid}` } } }
    }
    return { ok: true, personaId: pid }
  }

  const route = {
      kind: 'prefix',
      path: '/api/memory-process',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const query = Object.fromEntries(url.searchParams.entries())
          const sub = url.pathname.slice('/api/memory-process'.length) || '/'

          // ── POST：写动作（P1-1）────────────────────────────────────────
          if (req.method === 'POST') {
            const guard = writeGuard(req)
            if (!guard.ok) return sendJson(res, guard.status, guard.body)
            const parsed = await readJsonBody(req)
            if (!parsed.ok) {
              return sendJson(res, 400, { ok: false, code: parsed.code, error: { code: parsed.code, message: parsed.code === 'BAD_JSON' ? '请求体不是合法 JSON 对象' : '请求体不可用' } })
            }
            const body = parsed.body
            // Stage 0：存储快照是 dataRoot 级（不属于某个人格），先于 writePersona 处理
            if (sub === '/storage/snapshot') {
              if (body.confirm !== true) {
                return sendJson(res, 400, { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '记录快照需要 confirm=true' } })
              }
              return sendJson(res, 200, await recordStorageSnapshot({ dataRoot: dataRoot() }))
            }
            const who = writePersona(body)
            if (!who.ok) return sendJson(res, who.status, who.body)
            const pid = who.personaId
            let result
            if (sub === '/apply') {
              result = await applyPending({
                dataRoot: dataRoot(), personaId: pid,
                pendingIds: body.pendingIds, expectedGeneration: body.expectedGeneration,
                confirm: body.confirm === true, applyId: body.applyId,
              })
            } else if (sub === '/dismiss') {
              result = await dismissPending({
                dataRoot: dataRoot(), personaId: pid,
                pendingIds: body.pendingIds, expectedGeneration: body.expectedGeneration,
                confirm: body.confirm === true, dismissId: body.dismissId,
              })
            } else if (sub === '/manual') {
              result = await createManualPending({
                dataRoot: dataRoot(), personaId: pid,
                kind: body.kind, chunkIds: body.chunkIds,
                proposed: body.proposed && typeof body.proposed === 'object' ? body.proposed : {},
                reason: body.reason || 'user:manual', confidence: 1,
              })
            } else if (sub === '/rebuild') {
              result = await rebuildProcess({
                dataRoot: dataRoot(), personaId: pid,
                confirm: body.confirm === true, includeUserState: body.includeUserState === true,
              })
            } else {
              return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知写端点：${sub}` } })
            }
            return sendJson(res, result.ok ? 200 : statusForCode(result.code), result)
          }

          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 GET（读）与 POST（写：/apply /dismiss /manual /rebuild）' } })

          if (sub === '/' || sub === '/context') {
            // 显式 personaId 优先；其次 session（对话视图自动解析）；最后 workspace
            if (query.personaId) return sendJson(res, 200, await apiContext({ dataRoot: dataRoot(), personaId: query.personaId }))
            if (query.session) return sendJson(res, 200, await resolveSessionContext(query.session))
            return sendJson(res, 200, await apiContext({ dataRoot: dataRoot(), workspace: query.workspace || null }))
          }
          if (sub === '/capabilities') return sendJson(res, 200, apiCapabilities())

          // ── 人格生命周期诊断（P4 第 1 步，2026-11-12）──────────────────
          // 不需要 persona：它本身就是「三处人格名册对账」，没解析出 persona 时更要能给结论。
          if (sub === '/lifecycle') return sendJson(res, 200, await apiLifecycle({ dataRoot: dataRoot() }))

          // ── 只读会话源（P1-4，2026-11-08）────────────────────────────
          // 不依赖根藏、不需要 persona：直接读 <DSH_HOME>/sessions。
          // 只有 GET；不写任何文件、不调 LLM、不做嵌入。
          if (sub.startsWith('/source/')) {
            const days = query.days || 7
            const refresh = query.refresh === '1' || query.refresh === 'true'
            if (sub === '/source/probe') return sendJson(res, 200, await sourceProbe())
            if (sub === '/source/status') return sendJson(res, 200, await sourceStatus({ days, refresh }))
            if (sub === '/source/workspaces') return sendJson(res, 200, await sourceWorkspaces({ days, refresh }))
            if (sub === '/source/memories') {
              return sendJson(res, 200, await sourceMemories({
                days, refresh,
                ws: query.ws || null,
                session: query.session || null,
                role: query.role || null,
                q: query.q || null,
                from: query.from || null,
                to: query.to || null,
                limit: query.limit, offset: query.offset,
              }))
            }
            return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知只读端点：${sub}` } })
          }

          // ── 存储面板（Stage 0）：dataRoot 级，只读；快照走 POST ──────────
          if (sub === '/storage') {
            return sendJson(res, 200, await storageReport({ dataRoot: dataRoot(), days: query.days }))
          }

          const who = await resolveRoutePersona(query)
          if (!who.ok) return sendJson(res, who.status, who.body)
          const pid = who.personaId

          if (sub === '/overview') return sendJson(res, 200, await apiOverview({ dataRoot: dataRoot(), personaId: pid }))
          if (sub === '/root-storage') return sendJson(res, 200, await apiRootStorage({ dataRoot: dataRoot(), personaId: pid }))
          if (sub === '/memories') {
            return sendJson(res, 200, await apiMemories({
              dataRoot: dataRoot(), personaId: pid,
              status: query.status || null, role: query.role || null, channel: query.channel || null,
              q: query.q || null, from: query.from || null, to: query.to || null,
              chunkIds: query.chunkIds || null, session: query.session || null,
              topicId: query.topicId || null, conflictGroup: query.conflictGroup || null,
              includeText: query.includeText === '1' || query.includeText === 'true',
              sort: query.sort || 'time',
              limit: Number(query.limit) || 50, offset: Number(query.offset) || 0,
            }))
          }
          if (sub === '/memory') {
            if (!query.chunkId) return sendJson(res, 400, { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'chunkId 必填' } })
            return sendJson(res, 200, await apiMemory({ dataRoot: dataRoot(), personaId: pid, chunkId: query.chunkId, includeText: query.includeText !== '0' }))
          }
          if (sub === '/chunks') {
            return sendJson(res, 200, await apiChunks({ dataRoot: dataRoot(), personaId: pid, chunkIds: String(query.chunkIds || '').split(',').filter(Boolean), includeText: query.includeText === '1' || query.includeText === 'true' }))
          }
          if (sub === '/topics') return sendJson(res, 200, await apiTopics({ dataRoot: dataRoot(), personaId: pid }))
          if (sub === '/pending') {
            return sendJson(res, 200, await apiPending({
              dataRoot: dataRoot(), personaId: pid,
              kind: query.kind || null, status: query.status || 'pending',
              limit: Number(query.limit) || 100, offset: Number(query.offset) || 0,
            }))
          }
          if (sub === '/conflicts') {
            return sendJson(res, 200, await apiConflicts({ dataRoot: dataRoot(), personaId: pid, status: query.status || 'open', includeText: query.includeText === '1' || query.includeText === 'true' }))
          }
          if (sub === '/verify') return sendJson(res, 200, await apiVerify({ dataRoot: dataRoot(), personaId: pid }))
          if (sub === '/status') return sendJson(res, 200, await apiStatus({ dataRoot: dataRoot(), personaId: pid, config: liveCfg() }))
          return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知只读端点：${sub}` } })
        } catch (e) {
          return sendJson(res, 500, { ok: false, code: e.code || 'API_FAILED', error: toErrInfo(e) })
        }
      },
  }

  // webServer 是可选服务，且可能在插件 apply 之后才就绪：用 ctx.inject 等它就位再挂路由。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      const ws = sub?.webServer
      if (!ws || typeof ws.register !== 'function') return
      sub.effect(() => ws.register(route), 'memory-process:read-route')
    })
  } else {
    const webServer = (() => { try { return ctx.get?.('webServer') } catch { return undefined } })()
    if (webServer && typeof webServer.register === 'function') {
      disposers.push(webServer.register(route))
    } else {
      log('宿主没有 webServer —— 只读 HTTP 路由未注册（host 服务仍可用）')
    }
  }

  log(`已注册 ${disposers.length} 个资源（工具 ${registeredNames.length}；版本 ${VERSION}；根藏只读，process/${'{personaId}'} 唯一可写）`)
  const dispose = () => {
    if (autoState.timer) { try { clearTimeout(autoState.timer) } catch { /* 忽略 */ } autoState.timer = null }
    if (autoState.bootTimer) { try { clearTimeout(autoState.bootTimer) } catch { /* 忽略 */ } autoState.bootTimer = null }
    if (autoState.watcher) { try { clearInterval(autoState.watcher) } catch { /* 忽略 */ } autoState.watcher = null }
    for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
  }
  dispose.toolNames = [...registeredNames]
  dispose.autoRun = () => autoInfo()
  return dispose
}

export { PERSONA_UNASSIGNED, defaultDataRoot, processDir }
