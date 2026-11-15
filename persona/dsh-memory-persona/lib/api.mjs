/**
 * lib/api.mjs —— 镜台只读 API（UI 的数据源）
 *
 * 本模块**不导出任何写函数**；不创建目录、不写文件。
 */
import { join } from 'node:path'
import { pathExists } from './fsatomic.mjs'
import {
  readGlobalManifest, readRegistry, readCard, readVersions, listCards, listCardDirs,
  readIdentity, personaIdByName, peekPersonaLock,
} from './store.mjs'
import { parseCard, zoneOutline } from './card.mjs'
import { cardArchiveDir, globalManifestFile, personaRoot } from './paths.mjs'
import { readdir, readFile } from 'node:fs/promises'
import { resolveSoulMdConfig, settingsView, resolveSoulMdCardName, renderSoulMdMemory, normalizeSoulMdConfig, profileInfo, readSoulMdConfigFromServices } from './soulmd.mjs'
import { diffLines } from './diff.mjs'
import { estimateTokens } from './expand.mjs'
import { readRegistrySettingsSync, mergeInjectSettings, settingsCapabilities } from './settings.mjs'
import { resolvePersonaForInjection, memoryRenderConfig } from './injectsource.mjs'
import { VERSION, EXPAND_BUDGET } from './version.mjs'

const now = () => Date.now()

async function currentGeneration(dataRoot) {
  try {
    const gm = await readGlobalManifest(dataRoot)
    return gm.ok ? Number(gm.manifest?.generation) || 0 : null
  } catch { return null }
}

async function snapshotNames(dataRoot, cardId) {
  const arch = cardArchiveDir(dataRoot, cardId)
  try {
    const ents = await readdir(arch, { withFileTypes: true })
    return ents.filter((e) => e.isDirectory() && /^revision-\d+-/.test(e.name)).map((e) => e.name).sort()
  } catch { return [] }
}

// ── status ───────────────────────────────────────────────────────────────

export async function apiStatus({ dataRoot, ctx = null, deep = false, profile = 'desktop', config = {} }) {
  const warnings = []
  const initialized = await pathExists(globalManifestFile(dataRoot))
  const gm = initialized ? await readGlobalManifest(dataRoot) : { ok: true, manifest: { generation: 0 } }
  const reg = initialized ? await readRegistry(dataRoot) : { ok: true, registry: { cards: {}, activeCardId: null, workspaces: {}, sessions: {}, workspaceList: [] } }
  const dirs = initialized ? await listCardDirs(dataRoot) : []
  const lock = await peekPersonaLock(dataRoot)
  let versions = 0
  let cardProblems = 0
  if (initialized) {
    for (const id of dirs) {
      const v = await readVersions(dataRoot, id)
      versions += v.ok ? v.rows.length : 0
      if (!v.ok) cardProblems++
    }
  }
  const soulMd = await resolveSoulMdConfig(ctx, { profile })
  if (!soulMd.ok) warnings.push(`回退源不可读：${soulMd.error?.message || 'unknown'}`)
  // 漂移检测（只读）：镜台卡是 soul-md 的副本。v2 接管前 soul-md 仍是注入真源，
  // 所以这里只报告「卡正文 vs soul-md 正文」是否逐字一致，不自动同步、不改任何文件。
  const soulMdDrift = []
  if (soulMd.ok && initialized) {
    const cfgCards = soulMd.config?.cards || {}
    for (const id of dirs) {
      const c = await readCard(dataRoot, id)
      if (!c.ok) continue
      const name = c.frontMatter?.name || c.frontMatter?.id || id
      if (!Object.prototype.hasOwnProperty.call(cfgCards, name)) {
        soulMdDrift.push({ cardId: id, name, status: 'missing-in-soul-md' })
        continue
      }
      const raw = cfgCards[name]
      const soulText = typeof raw === 'string' ? raw : (raw?.content ?? raw?.body ?? '')
      const a = String(c.body ?? '').replace(/\r\n/g, '\n').trim()
      const b = String(soulText ?? '').replace(/\r\n/g, '\n').trim()
      if (a !== b) {
        soulMdDrift.push({ cardId: id, name, status: 'differs', cardChars: a.length, soulMdChars: b.length })
      }
    }
  }
  if (soulMdDrift.length) warnings.push(`镜台卡与回退源有 ${soulMdDrift.length} 张不一致`)
  if (!initialized) warnings.push('镜台目录尚未初始化（persona/manifest.json 不存在）；首次写动作会创建')
  if (cardProblems) warnings.push(`${cardProblems} 张卡的 versions.jsonl 有损坏行`)

  let integrity = null
  if (deep) integrity = await deepCheck({ dataRoot })

  if (!reg.ok) warnings.push(`registry 不可读：${reg.error?.message || 'unknown'}（卡片列表/绑定可能不完整）`)
  return {
    ok: true,
    installed: true,
    enabled: config.enabled !== false,
    initialized,
    version: VERSION,
    dataRoot: String(dataRoot),
    personaRoot: personaRoot(dataRoot),
    generation: gm.ok ? Number(gm.manifest.generation) || 0 : null,
    manifestError: gm.ok ? null : gm.error,
    lastError: gm.ok ? (gm.manifest.lastError ?? null) : null,
    cards: dirs.length,
    registryCards: Object.keys(reg.ok ? reg.registry.cards || {} : {}).length,
    versions,
    activeCardId: reg.ok ? reg.registry.activeCardId ?? null : null,
    workspaces: reg.ok ? Object.keys(reg.registry.workspaces || {}).length : 0,
    sessions: reg.ok ? Object.keys(reg.registry.sessions || {}).length : 0,
    lock,
    soulMd: {
      ok: soulMd.ok,
      resolvedFrom: soulMd.resolvedFrom || null,
      cards: soulMd.ok ? Object.keys(soulMd.config.cards || {}).length : 0,
      active: soulMd.ok ? soulMd.config.active || null : null,
      profile: profileInfo(profile),
      drift: soulMdDrift,
      driftCount: soulMdDrift.length,
      error: soulMd.ok ? null : soulMd.error,
    },
    expand: {
      enabled: config.expandEnabled !== false,
      provider: config.expandProvider || null,
      model: config.expandModel || null,
      budget: {
        maxInputChars: Number(config.expandMaxInputChars) || EXPAND_BUDGET.maxInputChars,
        maxOutputTokens: Number(config.expandMaxOutputTokens) || EXPAND_BUDGET.maxOutputTokens,
        timeoutMs: Number(config.expandTimeoutMs) || EXPAND_BUDGET.timeoutMs,
        retries: Number.isFinite(Number(config.expandRetries)) ? Number(config.expandRetries) : EXPAND_BUDGET.retries,
      },
      note: 'UI 写动作已接 POST（create/save/delete/default/bind/rollback/expand）；AI 生成仍是显式单次动作',
    },
    inject: {
      mode: config.injectEnabled ? 'jianmu' : 'soul-md',
      enabled: Boolean(config.injectEnabled),
      maxChars: Number(config.injectMaxChars) || 12000,
      personaOrder: Number(config.injectPersonaOrder) || 0,
      memoryOrder: Number.isFinite(Number(config.injectMemoryOrder)) ? Number(config.injectMemoryOrder) : 0.5,
      cacheMs: Number(config.injectCacheMs) || 5000,
    },
    capabilities: {
      cardRead: true,
      cardEditTool: true,
      uiActions: true,
      aiExpandTool: true,
      aiExpandUi: true,
      injectionTakeover: Boolean(config.injectEnabled),
      writeOnlyMode: false,
      crossPersona: false,
    },
    integrity,
    warnings,
  }
}

// ── cards ────────────────────────────────────────────────────────────────

export async function apiCards({ dataRoot }) {
  const list = await listCards(dataRoot)
  if (!list.ok) return list
  return { ok: true, ...list }
}

export async function apiCard({ dataRoot, cardId }) {
  const c = await readCard(dataRoot, cardId)
  if (!c.ok) return c
  const versions = await readVersions(dataRoot, cardId)
  return {
    ok: true,
    cardId,
    name: c.frontMatter.name ?? cardId,
    personaId: c.frontMatter.personaId ?? cardId,
    memoryScope: c.frontMatter.memoryScope ?? cardId,
    source: c.frontMatter.source ?? 'manual',
    status: c.frontMatter.status ?? 'active',
    version: Number(c.frontMatter.version) || Number(c.manifest?.version) || 0,
    updatedAt: Number(c.frontMatter.updatedAt) || Number(c.manifest?.updatedAt) || 0,
    frontMatter: c.frontMatter,
    body: c.body,
    raw: c.raw,
    zones: zoneOutline(c.body, c.zones),
    zoneHashes: c.zoneHashes,
    sourceHash: c.sourceHash,
    manifest: c.manifest,
    versions: versions.ok ? versions.rows.length : null,
    versionsCorrupt: versions.ok ? 0 : versions.corrupt?.length || 1,
    protectedZones: ['identity', 'redline'],
    editableZones: ['behavior', 'style'],
  }
}

// ── versions / diff ──────────────────────────────────────────────────────

export async function apiVersions({ dataRoot, cardId }) {
  const c = await readCard(dataRoot, cardId)
  if (!c.ok) return c
  const v = await readVersions(dataRoot, cardId)
  if (!v.ok && v.corrupt?.length) {
    return { ok: false, code: 'JSONL_CORRUPT', error: { code: 'JSONL_CORRUPT', message: `versions.jsonl 有 ${v.corrupt.length} 行损坏` }, corrupt: v.corrupt }
  }
  const snaps = await snapshotNames(dataRoot, cardId)
  return {
    ok: true,
    cardId,
    current: Number(c.frontMatter.version) || v.rows.length,
    versions: [...v.rows].sort((a, b) => Number(b.revision) - Number(a.revision)).map((r) => ({
      ...r,
      snapshot: snaps.some((n) => n.startsWith(`revision-${r.revision}-`)),
      isCurrent: Number(r.revision) === (Number(c.frontMatter.version) || v.rows.length),
      declaredSnapshot: r.snapshot === true ? true : (r.snapshot === false ? false : null),
    })),
    tornTail: v.tornTail,
  }
}

async function rawAtRevision(dataRoot, cardId, revision) {
  if (revision === 'current' || revision === 'live') {
    const c = await readCard(dataRoot, cardId)
    return c.ok ? { ok: true, raw: c.raw, card: c, label: 'current' } : c
  }
  const rev = Number(revision)
  if (!Number.isFinite(rev) || rev < 1) return { ok: false, code: 'VERSION_NOT_FOUND', error: { code: 'VERSION_NOT_FOUND', message: `revision 非法：${revision}` } }
  const snaps = await snapshotNames(dataRoot, cardId)
  const name = snaps.filter((n) => n.startsWith(`revision-${rev}-`)).pop()
  if (!name) return { ok: false, code: 'VERSION_NOT_FOUND', error: { code: 'VERSION_NOT_FOUND', message: `找不到 revision ${rev} 的快照` } }
  const file = join(cardArchiveDir(dataRoot, cardId), name, 'card.md')
  try {
    const raw = await readFile(file, 'utf8')
    return { ok: true, raw, label: `revision ${rev}`, file }
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', error: { code: 'READ_FAILED', message: String(e.message || e) } }
  }
}

export async function apiDiff({ dataRoot, cardId, from = 1, to = 'current' }) {
  const [a, b] = await Promise.all([rawAtRevision(dataRoot, cardId, from), rawAtRevision(dataRoot, cardId, to)])
  if (!a.ok) return a
  if (!b.ok) return b
  const pa = parseCard(a.raw)
  const pb = parseCard(b.raw)
  const diff = diffLines(pa.body, pb.body)
  return {
    ok: true,
    cardId,
    from: a.label,
    to: b.label,
    fromHash: pa.sourceHash,
    toHash: pb.sourceHash,
    fromVersion: pa.frontMatter.version ?? null,
    toVersion: pb.frontMatter.version ?? null,
    stats: diff.stats,
    unified: diff.unified,
    rows: diff.rows,
    frontMatterChanged: JSON.stringify({
      id: pa.frontMatter.id, name: pa.frontMatter.name, personaId: pa.frontMatter.personaId,
      memoryScope: pa.frontMatter.memoryScope, source: pa.frontMatter.source,
      status: pa.frontMatter.status, version: pa.frontMatter.version,
    }) !== JSON.stringify({
      id: pb.frontMatter.id, name: pb.frontMatter.name, personaId: pb.frontMatter.personaId,
      memoryScope: pb.frontMatter.memoryScope, source: pb.frontMatter.source,
      status: pb.frontMatter.status, version: pb.frontMatter.version,
    }),
  }
}

// ── registry / settings ─────────────────────────────────────────────────

export async function apiRegistry({ dataRoot }) {
  const r = await readRegistry(dataRoot)
  if (!r.ok) return r
  return { ok: true, registry: r.registry, generation: Number(r.registry.generation) || 0 }
}

export async function apiSettings({ dataRoot, ctx = null, profile = 'desktop', config = {} }) {
  const soul = await resolveSoulMdConfig(ctx, { profile })
  const reg = readRegistrySettingsSync(dataRoot)
  const own = mergeInjectSettings({
    injectEnabled: Boolean(config.injectEnabled),
    injectMaxChars: Number(config.injectMaxChars) || 12000,
    injectPersonaOrder: Number(config.injectPersonaOrder) || 0,
    injectMemoryOrder: Number.isFinite(Number(config.injectMemoryOrder)) ? Number(config.injectMemoryOrder) : 0.5,
    injectCacheMs: Number(config.injectCacheMs) || 5000,
    cardSource: config.cardSource || 'jianmu',
    memoryLayered: config.memoryLayered !== false,
    memoryIndexMode: config.memoryIndexMode || 'all',
    subagentSkip: config.subagentSkip === true,
    recallMaxTopics: Number(config.recallMaxTopics) || 8,
    recallMaxChars: Number(config.recallMaxChars) || 1600,
    compactionRecall: config.compactionRecall === true,
    // P2/P2.5：读当前有效值（以前这些键只在 registry 里出现过才显示，默认值隐身）
    autoRecall: config.autoRecall === true,
    autoRecallMinScore: Number(config.autoRecallMinScore) || 0.62,
    autoRecallTopN: Number(config.autoRecallTopN) || 2,
    autoRecallMaxChars: Number(config.autoRecallMaxChars) || 320,
    autoRecallDeadlineMs: Number(config.autoRecallDeadlineMs) || 800,
    autoRecallWaitMs: Number.isFinite(Number(config.autoRecallWaitMs)) ? Number(config.autoRecallWaitMs) : 800,
    autoRecallCooldownMs: Number(config.autoRecallCooldownMs) || 60000,
    autoRecallCues: String(config.autoRecallCues || ''),
    autoRecallLabOnly: config.autoRecallLabOnly !== false,
    autoRecallLabWorkspaces: String(config.autoRecallLabWorkspaces || ''),
    conflictCard: config.conflictCard === true,
    maxBytes: Number(config.maxBytes) || 262144,
  }, reg.ok ? reg.settings : {})
  const takeover = Boolean(config.injectEnabled)
  const jianmu = {
    enabled: takeover,
    maxChars: Number(config.injectMaxChars) || 12000,
    personaOrder: Number(config.injectPersonaOrder) || 0,
    memoryOrder: Number.isFinite(Number(config.injectMemoryOrder)) ? Number(config.injectMemoryOrder) : 0.5,
    cacheMs: Number(config.injectCacheMs) || 5000,
    note: takeover
      ? '镜台已接管注入（jianmu:persona / jianmu:memory）。'
      : '镜台未接管（injectEnabled=false）；当前仍由回退源注入。',
    // v2：可写口径（写 registry.settings；文件层压过 patch 配置行）
    editable: !(config && config.enabled === false),
    settingsRevision: reg.ok ? reg.revision : null,
    settingsSource: own.source,
    settingsFile: reg.file || null,
    values: own.cfg,
    capabilities: settingsCapabilities(),
    readError: reg.ok ? null : reg.error,
  }
  if (!soul.ok) {
    // 回退源（旧人格插件）被卸载/禁用**不是**致命错误：镜台接管后人格与记忆都不依赖它。
    // 返回 ok:true + 中性空视图 + 告警，避免 UI 整页报错（2026-11-08 实测：旧版返回 ok:false 会让设置页红屏）。
    return {
      ok: true,
      mode: takeover ? 'jianmu' : 'soul-md',
      generation: await currentGeneration(dataRoot),
      view: {
        source: 'unavailable',
        readOnly: true,
        resolvedFrom: null,
        inject: {
          persona: true, memorySegment: false, layered: false, topicIndex: 'off',
          keywordRecall: false, compactionCompensation: false, subagentSkip: false, promptVariables: false,
        },
        limits: { maxRecallTopics: 5, recallMaxChars: 1600, injectMaxChars: 8000, memoryMaxBytes: 1048576 },
        mode: 'normal',
        notes: ['回退源不可读（未安装/已停用）：人格与记忆由镜台接管，不受影响。'],
        raw: normalizeSoulMdConfig({}),
      },
      jianmu,
      warnings: ['回退源不可读（未安装/已停用）：镜台接管下不影响注入。'],
    }
  }
  return {
    ok: true,
    mode: takeover ? 'jianmu' : 'soul-md',
    generation: await currentGeneration(dataRoot),
    view: settingsView(soul.config, soul.resolvedFrom),
    jianmu,
    warnings: soul.warnings || [],
  }
}

// ── 注入预览 ─────────────────────────────────────────────────────────────

export async function apiPreview({ dataRoot, cardId = null, workspace = null, sessionId = null, ctx = null, profile = 'desktop', jianmuConfig = {} }) {
  const soul = await resolveSoulMdConfig(ctx, { profile })
  const soulAvailable = Boolean(soul.ok)
  // 镜台已接管时，soul-md 读不到**不是**预览失败：人格可能来自镜台卡、记忆来自建木根。
  // 只有「镜台没接管」时才必须依赖 soul-md（那时预览就是 soul-md 的口径）。
  if (!soulAvailable && !jianmuConfig?.injectEnabled) {
    return { ok: false, code: soul.code || 'SOULMD_UNAVAILABLE', error: soul.error, soulAvailable: false }
  }
  let config = soulAvailable ? normalizeSoulMdConfig(soul.config) : normalizeSoulMdConfig({} )
  // soul-md 被禁用/async 读取不到 cards 时，回退到同步服务读取（与 buildInjection 同源）
  if (jianmuConfig?.injectEnabled && (!config.cards || !Object.keys(config.cards).length)) {
    try {
      const sync = readSoulMdConfigFromServices(ctx)
      if (sync.ok) config = normalizeSoulMdConfig(sync.config)
    } catch { /* ignore */ }
  }

  // v2 接管后：预览按镜台口径渲染（workspaces 映射、忽略 soul-md 的 active:none / memory.inject）
  if (jianmuConfig?.injectEnabled) {
    // 与 buildInjection 同源：优先用同步 loader 读取（soul-md 禁用后 async 可能读不到 workspaces）
    let cfg2 = config
    try {
      const sync = readSoulMdConfigFromServices(ctx)
      if (sync.ok) cfg2 = normalizeSoulMdConfig(sync.config)
    } catch { /* ignore */ }
    const resolvedFrom = soulAvailable ? soul.resolvedFrom : 'unavailable'
    const ws = workspace || ''
    const sid = sessionId || ''
    // 与 buildInjection 共用同一个解析函数（lib/injectsource.mjs）：
    // 否则「预览说 A、实际注入 B」，出了事根本查不出来（2026-11-08 已踩过一次）。
    // cardId：显式预览某张卡（以前 v2 分支忽略它 → 选了Bob卡却预览当前卡）
    let forced = null
    if (cardId) {
      const c = await readCard(String(dataRoot), String(cardId))
      if (c.ok) {
        forced = {
          ok: true, personaSource: 'jianmu', cardId: String(cardId),
          name: c.frontMatter?.name || String(cardId), persona: String(c.body ?? ''),
          file: join(personaRoot(String(dataRoot)), 'cards', String(cardId), 'card.md'),
          matchedBy: 'cardId', reason: null, fallbackReason: null,
        }
      }
    }
    const src = forced || resolvePersonaForInjection({
      dataRoot, config: soulAvailable ? cfg2 : null, workspace: ws, sessionId: sid,
      cardSource: jianmuConfig.cardSource, soulAvailable,
    })
    const name = src.name
    const personaText = src.persona
    // 记忆参数来自镜台 settings（与 buildInjection 同一个函数），不再依赖 soul-md config。
    // name 为空（绑定 none / 没命中卡）时**不渲染记忆**——否则预览会显示 global 记忆、实际却不注入。
    const memory = name
      ? renderSoulMdMemory(memoryRenderConfig(jianmuConfig), name, join(String(dataRoot), 'persona', 'memory'))
      : { text: '', core: '', index: '', scope: null, file: null, topics: [], truncated: false, reasons: [], cap: Number(jianmuConfig.injectMaxChars) || 12000, rawChars: 0 }
    const personaChars = personaText.length
    const memoryChars = memory.text.length
    const segments = [
      {
        name: 'jianmu:persona',
        included: Boolean(personaText),
        chars: personaChars,
        tokensEstimate: estimateTokens(personaText),
        source: src.personaSource,
        cardId: src.cardId || null,
        file: src.file || null,
        fallbackReason: src.fallbackReason || null,
        reason: !name
          ? (src.reason || '没有命中任何卡（会话/工作区/默认都没有）→ 人格段不注入')
          : (!personaText ? '这张卡没有正文' : ''),
        text: personaText,
      },
      {
        name: 'jianmu:memory',
        included: Boolean(memory.text),
        chars: memoryChars,
        tokensEstimate: estimateTokens(memory.text),
        truncated: memory.truncated,
        reasons: memory.reasons,
        scope: memory.scope,
        file: memory.file,
        topics: memory.topics.length,
        text: memory.text,
      },
    ]
    return {
      ok: true,
      previewOnly: true,
      note: '预览不触发注入、不写任何文件；这是镜台接管后（jianmu:*）在当前配置下会注入的内容。',
      mode: 'jianmu',
      cardName: name,
      cardSource: src.personaSource,
      cardId: src.cardId || null,
      cardFile: src.file || null,
      fallbackReason: src.fallbackReason || null,
      resolution: {
        name,
        cardSource: src.personaSource,
        reason: src.personaSource === 'jianmu'
          ? (src.matchedBy === 'cardId'
            ? '按 cardId 指定卡（预览用；实际注入仍按会话/工作区解析）'
            : `镜台卡解析（${src.matchedBy || 'registry'}）`)
          : '旧版卡解析（jianmu 读卡失败时也会回退到这里）',
        key: name,
      },
      soulAvailable,
      source: { resolvedFrom, config: soulAvailable ? cfg2 : null },
      settings: settingsView(cfg2, resolvedFrom),
      persona: {
        name, text: personaText, chars: personaChars, tokensEstimate: estimateTokens(personaText),
        source: src.personaSource, file: src.file || null, cardId: src.cardId || null,
      },
      memory: {
        text: memory.text, chars: memoryChars, tokensEstimate: estimateTokens(memory.text),
        scope: memory.scope, file: memory.file, topics: memory.topics,
        truncated: memory.truncated, reasons: memory.reasons, cap: memory.cap,
      },
      segments,
      totals: {
        chars: personaChars + (memoryChars ? 2 + memoryChars : 0),
        tokensEstimate: estimateTokens(personaText + '\n\n' + memory.text),
        injectMaxChars: Number(jianmuConfig.injectMaxChars) || 12000,
      },
      warnings: soulAvailable ? [] : ['回退源不可读（未安装/已停用）：卡源=jianmu 时不受影响。'],
    }
  }

  let ourCard = null
  if (cardId) {
    const c = await readCard(dataRoot, cardId)
    if (!c.ok) return c
    ourCard = c
  }
  let resolution
  if (ourCard) {
    resolution = { name: ourCard.frontMatter.name || cardId, reason: 'cardId（按镜台卡片名指定）', key: cardId }
  } else {
    resolution = resolveSoulMdCardName(config, { workspace, sessionId })
  }

  const cardName = resolution.name
  const personaText = cardName ? String(config.cards?.[cardName] ?? '') : ''
  const memory = renderSoulMdMemory(config, cardName)
  const personaChars = personaText.length
  const memoryChars = memory.text.length
  const totalChars = personaChars + (memoryChars ? 2 + memoryChars : 0)
  const segments = [
    {
      name: 'soul:persona',
      included: Boolean(personaText),
      chars: personaChars,
      tokensEstimate: estimateTokens(personaText),
      reason: !cardName ? '没有命中任何卡（会话/工作区/默认都没有）→ 人格段不注入' : (!personaText ? '回退源里没有这张卡的正文' : ''),
      text: personaText,
    },
    {
      name: 'soul:memory',
      included: Boolean(memory.text),
      chars: memoryChars,
      tokensEstimate: estimateTokens(memory.text),
      truncated: memory.truncated,
      reasons: memory.reasons,
      scope: memory.scope,
      file: memory.file,
      topics: memory.topics.length,
      text: memory.text,
    },
  ]
  const recallOn = config.memory?.recall === 'keyword' || config.memory?.compactionRecall
  if (recallOn) {
    segments.push({
      name: 'soul:recall',
      included: null,
      chars: null,
      tokensEstimate: null,
      reason: '召回依赖当前会话的实时状态（本会话查过哪些主题）；静态预览不模拟，避免误导',
      text: null,
    })
  }

  const warnings = []
  if (!cardName) warnings.push('当前解析不到卡：人格与记忆都不会注入')
  if (ourCard && config.cards?.[cardName] === undefined) {
    warnings.push(`镜台有卡「${cardName}」，但回退源没有同名卡：当前注入不受影响`)
  }
  if (ourCard && config.cards?.[cardName] !== undefined && ourCard.body && String(config.cards[cardName]).replace(/\n+$/, '') !== String(ourCard.body).replace(/\n+$/, '')) {
    warnings.push('镜台副本与回退源现役卡正文不同：预览显示的是回退源实际注入的内容')
  }

  return {
    ok: true,
    previewOnly: true,
    note: '预览不触发注入、不写任何文件；这是当前配置下会注入的内容。',
    cardName,
    resolution,
    source: { resolvedFrom: soul.resolvedFrom, config },
    settings: settingsView(config, soul.resolvedFrom),
    persona: { name: cardName, text: personaText, chars: personaChars, tokensEstimate: estimateTokens(personaText) },
    memory: {
      text: memory.text, chars: memoryChars, tokensEstimate: estimateTokens(memory.text),
      scope: memory.scope, file: memory.file, topics: memory.topics,
      truncated: memory.truncated, reasons: memory.reasons, cap: memory.cap,
    },
    segments,
    totals: { chars: totalChars, tokensEstimate: estimateTokens(personaText + '\n\n' + memory.text), injectMaxChars: config.memory?.injectMaxChars ?? 8000 },
    warnings,
  }
}

// ── 可导入源 ─────────────────────────────────────────────────────────────

export async function apiImportSources({ dataRoot, ctx = null, profile = 'desktop' }) {
  const soul = await resolveSoulMdConfig(ctx, { profile })
  if (!soul.ok) return { ok: false, code: soul.code || 'SOULMD_UNAVAILABLE', error: soul.error }
  const identity = await readIdentity(dataRoot)
  if (!identity.ok) return identity
  const dirs = await listCardDirs(dataRoot)
  const cards = Object.keys(soul.config.cards || {}).map((cardName) => {
    const pid = personaIdByName(identity.personas, cardName)
    return {
      cardName,
      personaId: pid,
      mapped: Boolean(pid),
      exists: pid ? dirs.includes(pid) : false,
      chars: String(soul.config.cards[cardName] || '').length,
      reason: pid ? null : 'identity.json 没有同名 displayName；导入时需在 mapping 里显式指定',
    }
  })
  return {
    ok: true,
    source: 'soul-md',
    resolvedFrom: soul.resolvedFrom,
    profile: profileInfo(profile),
    cards,
    active: soul.config.active || null,
    counts: {
      total: cards.length,
      mapped: cards.filter((c) => c.mapped).length,
      importable: cards.filter((c) => c.mapped && !c.exists).length,
      existing: cards.filter((c) => c.exists).length,
      unmapped: cards.filter((c) => !c.mapped).length,
    },
  }
}

// ── 完整性检查（供 status deep；不写） ──────────────────────────────────

export async function deepCheck({ dataRoot }) {
  const problems = []
  const warnings = []
  const gm = await readGlobalManifest(dataRoot)
  if (!gm.ok) problems.push({ code: 'GLOBAL_MANIFEST', severity: 'error', detail: gm.error })
  const reg = await readRegistry(dataRoot)
  if (!reg.ok) problems.push({ code: 'REGISTRY', severity: 'error', detail: reg.error })
  const dirs = await listCardDirs(dataRoot)
  const registryCards = reg.ok ? reg.registry.cards || {} : {}
  for (const id of dirs) {
    const c = await readCard(dataRoot, id)
    if (!c.ok) { problems.push({ code: 'CARD_UNREADABLE', severity: 'error', cardId: id, detail: c.error }); continue }
    if (c.frontMatter.id !== id) problems.push({ code: 'CARD_ID_MISMATCH', severity: 'error', cardId: id, detail: { frontMatter: c.frontMatter.id } })
    if (c.frontMatter.personaId && c.frontMatter.personaId !== id) problems.push({ code: 'PERSONA_MISMATCH', severity: 'error', cardId: id })
    if (c.frontMatter.memoryScope && c.frontMatter.memoryScope !== id) problems.push({ code: 'SCOPE_MISMATCH', severity: 'error', cardId: id })
    if (!c.manifest) problems.push({ code: 'CARD_MANIFEST_MISSING', severity: 'error', cardId: id })
    else {
      if (c.manifest.sourceHash !== c.sourceHash) problems.push({ code: 'SOURCE_HASH_MISMATCH', severity: 'error', cardId: id, detail: { manifest: c.manifest.sourceHash, actual: c.sourceHash } })
      const manifestZones = c.manifest.zoneHashes || {}
      for (const zone of ['identity', 'redline', 'behavior', 'style']) {
        if (manifestZones[zone] && manifestZones[zone] !== c.zoneHashes[zone]) {
          problems.push({ code: 'ZONE_HASH_MISMATCH', severity: 'error', cardId: id, detail: { zone } })
        }
      }
    }
    const v = await readVersions(dataRoot, id)
    if (!v.ok) problems.push({ code: 'VERSIONS_CORRUPT', severity: 'error', cardId: id, detail: v.corrupt })
    if (v.rows.length) {
      const last = v.rows[v.rows.length - 1]
      if (last.hash && last.hash !== c.sourceHash) warnings.push({ code: 'LAST_VERSION_HASH_STALE', cardId: id, detail: { revision: last.revision } })
      for (let i = 1; i < v.rows.length; i++) {
        if (v.rows[i].prevHash && v.rows[i].prevHash !== v.rows[i - 1].hash) {
          problems.push({ code: 'VERSION_CHAIN_BROKEN', severity: 'error', cardId: id, detail: { revision: v.rows[i].revision } })
        }
      }
    }
  }
  for (const id of Object.keys(registryCards)) {
    if (!dirs.includes(id)) problems.push({ code: 'CARD_DIR_MISSING', severity: 'error', cardId: id })
  }
  if (gm.ok && reg.ok && Number(gm.manifest.generation) !== Number(reg.registry.generation)) {
    warnings.push({ code: 'GENERATION_MISMATCH', detail: { manifest: gm.manifest.generation, registry: reg.registry.generation } })
  }
  const active = reg.ok ? reg.registry.activeCardId : null
  if (active && !dirs.includes(active)) problems.push({ code: 'DEFAULT_CARD_MISSING', severity: 'error', cardId: active })
  return { ok: problems.length === 0, problems, warnings, checkedAt: now(), cards: dirs.length }
}
