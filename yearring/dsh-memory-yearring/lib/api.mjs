/**
 * lib/api.mjs —— 年轮只读数据接口（HTTP 只读路由 + 工具共用）
 *
 * 全部只读：不写 claims/manifest，不改任何东西。
 */
import { join } from 'node:path'
import { readIdentity, readScope } from './root.mjs'
import { readManifest, readClaims, readRuns, listTopicDocs, computeCounts } from './store.mjs'
import { readProcessState } from './process-read.mjs'
import { groupClaims, groupKeyOf } from './topicdocs.mjs'
import { L1_BY_ID, MISC_ID, MISC_TITLE, loadOverrides } from './topicgroups.mjs'
import { collectCoveredFromRuns } from './select.mjs'
import { effectiveStatus } from './claim.mjs'
import { yearDir, isSafePersonaId, PERSONA_UNASSIGNED, defaultDataRoot } from './paths.mjs'
import { VERSION, PROMPT_VERSION, RULE_VERSION, KINDS, STATUSES, EPISTEMIC } from './version.mjs'
import { verifyYear } from './verify.mjs'

const norm = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * 解析上下文：显式 personaId 优先；否则按 workspace 最长前缀匹配 identity。
 * 都不中 → personaId=null（不猜、不静默归入具名人格）。
 */
export async function apiContext({ dataRoot = defaultDataRoot(), workspace = null, personaId = null }) {
  if (personaId) {
    if (personaId !== PERSONA_UNASSIGNED && !isSafePersonaId(personaId)) {
      return { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法：${personaId}` } }
    }
    return {
      ok: true, personaId, personaSource: 'explicit', workspace: workspace || null,
      dataRoot, identityOk: true,
    }
  }
  const id = await readIdentity(dataRoot)
  if (!id.ok) {
    return {
      ok: true, personaId: null, personaSource: null, workspace: workspace || null,
      dataRoot, identityOk: false, identityError: id.error,
      note: 'identity.json 不可读：请显式传 personaId',
    }
  }
  if (workspace) {
    const target = norm(workspace)
    let best = null
    for (const [w, pid] of Object.entries(id.identity.workspaces || {})) {
      const nw = norm(w)
      if (target === nw || target.startsWith(nw + '\\')) {
        if (!best || nw.length > best.len) best = { pid, len: nw.length }
      }
    }
    if (best) {
      return { ok: true, personaId: best.pid, personaSource: 'workspace', workspace, dataRoot, identityOk: true }
    }
    return {
      ok: true, personaId: null, personaSource: null, workspace, dataRoot, identityOk: true,
      note: `工作区（${workspace}）未映射到任何 persona；请显式传 personaId`,
    }
  }
  return {
    ok: true, personaId: null, personaSource: null, workspace: null, dataRoot, identityOk: true,
    note: '没有 workspace 也没有 personaId：请显式指定',
  }
}

/** 状态：manifest + 计数 + 最近运行 + 根藏/熏习对齐 */
export async function apiStatus({ dataRoot, personaId, config = {}, deep = false, uiRun = null, auto = null }) {
  const manifestRes = await readManifest(dataRoot, personaId)
  const claims = await readClaims(dataRoot, personaId)
  const runs = await readRuns(dataRoot, personaId, 100000)
  const docs = await listTopicDocs(dataRoot, personaId)
  const counts = computeCounts(claims, docs.length)
  const root = await readScope(dataRoot, personaId)
  const covered = collectCoveredFromRuns(runs.rows)
  const chunks = root.ok ? (root.chunks || []) : []
  const now = Date.now()
  const within90 = chunks.filter((c) => Number(c.t) >= now - 90 * 86400000)
  const coveredInRoot = chunks.filter((c) => covered.has(c.id)).length
  const remaining = Math.max(0, chunks.length - coveredInRoot)
  const remaining90 = within90.filter((c) => !covered.has(c.id)).length
  const est = (r) => ({ remaining: r, minutes: r > 0 ? Math.ceil(r / 27) : 0, costYuan: Number((r * 0.001).toFixed(3)) })
  const coverage = {
    rootChunks: chunks.length,
    covered: coveredInRoot,
    remaining,
    percent: chunks.length ? Number(((coveredInRoot / chunks.length) * 100).toFixed(1)) : 0,
    rootEmpty: Boolean(root.empty),
    last90: { chunks: within90.length, remaining: remaining90 },
    estimate: { all: est(remaining), last90: est(remaining90) },
    basis: '按本机实测估算：约 27 块/分钟、约 ¥0.001/块；实际受模型与限流影响',
  }

  const eff = { active: 0, superseded: 0, conflicted: 0, expired: 0, archived: 0, draft: 0 }
  for (const c of claims.byId.values()) {
    const s = effectiveStatus(c, claims.byGroup.get(c.claimGroupId) || [], claims.supersededIds, claims.supersededGroups)
    if (eff[s] !== undefined) eff[s] += 1
  }

  const out = {
    ok: true,
    service: { name: 'dsh-memory-yearring', version: VERSION, promptVersion: PROMPT_VERSION, ruleVersion: RULE_VERSION },
    personaId,
    dir: yearDir(dataRoot, personaId),
    manifest: manifestRes.ok ? manifestRes.manifest : { error: manifestRes.error },
    counts,
    effective: eff,
    claimsFile: { exists: claims.exists, rows: claims.rows.length, unique: claims.unique, bytes: claims.bytes, tornTail: claims.tornTail, corrupt: claims.corrupt.length },
    topicDocs: docs.length,
    runs: { total: runs.total, recent: runs.rows.slice(-3) },
    coverage,
    uiRun: uiRun || null,
    auto: auto || null,
    config: {
      llmProvider: config.llmProvider ?? null,
      llmModel: config.llmModel ?? null,
      budget: config.budget ?? null,
      writeEnabled: config.writeEnabled !== false,
    },
    degraded: (manifestRes.ok ? Boolean(manifestRes.manifest.degraded) : true) || claims.corrupt.length > 0 || claims.tornTail,
    warnings: manifestRes.ok ? (manifestRes.manifest.lastError ? [manifestRes.manifest.lastError] : []) : [manifestRes.error],
  }
  out.errors = []
  if (!manifestRes.ok) out.errors.push(manifestRes.error)
  if (claims.corrupt.length) out.errors.push({ code: 'JSONL_CORRUPT', message: `claims.jsonl 有 ${claims.corrupt.length} 个坏行` })

  if (deep) {
    const scope = await readScope(dataRoot, personaId)
    const state = await readProcessState(dataRoot, personaId)
    out.deep = {
      root: scope.ok
        ? { ok: true, empty: Boolean(scope.empty), chunks: scope.chunks.length, builtAt: scope.manifest?.builtAt ?? null, generation: scope.manifest?.generation ?? null }
        : { ok: false, error: scope.error },
      process: { exists: state.exists, counts: state.counts, activeCount: state.activeCount },
      verify: await verifyYear({ dataRoot, personaId }),
    }
    if (!scope.ok) out.degraded = true
  }
  return out
}

/** topic 列表：两级分组（L1 大主题 + L2 子主题）+ claim 计数 + 最近更新（不返回正文） */
export async function apiTopics({ dataRoot, personaId, limit = 100, offset = 0, kind = null, status = null, epistemic = null, groupId = null }) {
  const claims = await readClaims(dataRoot, personaId)
  const overrides = await loadOverrides(dataRoot, personaId, join, yearDir)
  const groups = groupClaims(claims, personaId, overrides)

  const rows = []
  for (const [key, grp] of groups) {
    let list = grp.claims
    if (kind) list = list.filter((c) => c.kind === kind)
    if (status) list = list.filter((c) => c._effStatus === status)
    if (epistemic) list = list.filter((c) => c.epistemic === epistemic)
    if (groupId && (grp.groupId || 'misc') !== groupId) continue
    if (!list.length) continue
    const times = list.flatMap((c) => (c.derivedFrom || []).map((a) => Number(a.t))).filter((x) => Number.isFinite(x))
    rows.push({
      topicId: key,
      title: grp.title || key,
      kind: grp.kind,
      groupId: grp.groupId || MISC_ID,
      groupTitle: grp.groupTitle || MISC_TITLE,
      claims: list.length,
      byStatus: list.reduce((m, c) => { m[c._effStatus] = (m[c._effStatus] || 0) + 1; return m }, {}),
      byKind: list.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m }, {}),
      latestAt: times.length ? Math.max(...times) : null,
      earliestAt: times.length ? Math.min(...times) : null,
      docStatus: 'rule-v1',
    })
  }
  rows.sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0))

  // L1 聚合：UI 默认只看这 19 个抽屉
  const l1 = new Map()
  for (const row of rows) {
    const id = row.groupId || MISC_ID
    if (!l1.has(id)) {
      l1.set(id, {
        groupId: id,
        title: row.groupTitle || MISC_TITLE,
        order: L1_BY_ID.get(id)?.order ?? 999,
        claims: 0,
        topics: 0,
        latestAt: null,
        children: [],
      })
    }
    const g = l1.get(id)
    g.claims += row.claims
    g.topics += 1
    if (row.latestAt && (!g.latestAt || row.latestAt > g.latestAt)) g.latestAt = row.latestAt
    g.children.push(row)
  }
  const groupRows = [...l1.values()].sort((a, b) => a.order - b.order || b.claims - a.claims)

  const total = rows.length
  const page = rows.slice(offset, offset + limit)
  return {
    ok: true, personaId, total, offset, limit, rows: page,
    groups: groupRows, groupTotal: groupRows.length,
    filters: { kind, status, epistemic, groupId },
    note: total === 0 ? '还没有 claim（先跑 jianmu_year_run）' : null,
  }
}

/** claim 列表（过滤 kind/status/topic/epistemic；默认不含原话正文） */
export async function apiClaims({ dataRoot, personaId, limit = 50, offset = 0, kind = null, status = null, topicId = null, groupId = null, epistemic = null, q = null, includeText = false }) {
  const claims = await readClaims(dataRoot, personaId)
  const overrides = await loadOverrides(dataRoot, personaId, join, yearDir)
  let list = []
  for (const c of claims.byId.values()) {
    const eff = effectiveStatus(c, claims.byGroup.get(c.claimGroupId) || [], claims.supersededIds, claims.supersededGroups)
    list.push({ ...c, _effStatus: eff })
  }
  if (kind) list = list.filter((c) => c.kind === kind)
  if (epistemic) list = list.filter((c) => c.epistemic === epistemic)
  if (status) list = list.filter((c) => c._effStatus === status)
  if (topicId) list = list.filter((c) => groupKeyOf(c, overrides).key === topicId)
  if (groupId) list = list.filter((c) => (groupKeyOf(c, overrides).groupId || MISC_ID) === groupId)
  if (q) {
    const n = String(q).toLowerCase()
    list = list.filter((c) => String(c.title).toLowerCase().includes(n) || String(c.body || '').toLowerCase().includes(n))
  }
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const total = list.length
  const page = list.slice(offset, offset + limit).map((c) => {
    const out = {
      claimId: c.claimId,
      claimGroupId: c.claimGroupId,
      revision: c.revision,
      kind: c.kind,
      epistemic: c.epistemic,
      speaker: c.speaker ?? null,
      status: c._effStatus,
      declaredStatus: c.status,
      title: c.title,
      body: includeText ? c.body : (c.body ? String(c.body).slice(0, 120) : ''),
      topicId: c.topicId,
      topicHint: c.topicHint,
      topicKey: groupKeyOf(c, overrides).key,
      groupId: groupKeyOf(c, overrides).groupId,
      groupTitle: groupKeyOf(c, overrides).groupTitle,
      confidence: c.confidence,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      model: c.model,
      runId: c.runId,
      anchors: (c.derivedFrom || []).map((a) => ({
        chunkId: a.chunkId, session: a.session, seq: a.seq, t: a.t,
        quote: includeText ? a.quote : (a.quote ? `${String(a.quote).slice(0, 40)}…` : ''),
      })),
      conflictsWith: c.conflictsWith || [],
      supersedes: c.supersedes ?? null,
    }
    return out
  })
  return { ok: true, personaId, total, offset, limit, rows: page, filters: { kind, status, topicId, groupId, epistemic, q }, includeText }
}

/** 单条 claim + 锚点原文（点开看原话） */
export async function apiClaim({ dataRoot, personaId, claimId, includeText = true }) {
  if (!claimId) return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'claimId 必填' } }
  const claims = await readClaims(dataRoot, personaId)
  const c = claims.byId.get(String(claimId))
  if (!c) return { ok: false, code: 'CLAIM_NOT_FOUND', error: { code: 'CLAIM_NOT_FOUND', message: `claim 不存在：${claimId}` } }
  const groupList = claims.byGroup.get(c.claimGroupId) || []
  const eff = effectiveStatus(c, groupList, claims.supersededIds, claims.supersededGroups)

  let root = null
  const withText = includeText
  if (withText) {
    root = await readScope(dataRoot, personaId)
  }
  const chunksById = new Map()
  if (root?.ok) for (const ch of root.chunks) chunksById.set(ch.id, ch)

  const anchors = (c.derivedFrom || []).map((a) => {
    const chunk = chunksById.get(a.chunkId)
    return {
      chunkId: a.chunkId,
      session: a.session,
      messageId: a.messageId,
      seq: a.seq,
      part: a.part,
      t: a.t,
      quote: a.quote,
      quoteInChunk: chunk?.text ? chunk.text.includes(a.quote) : null,
      chunkText: includeText && chunk ? String(chunk.text) : null,
      chunkRole: chunk?.role ?? null,
      chunkWs: chunk?.ws ?? null,
    }
  })

  return {
    ok: true,
    personaId,
    effectiveStatus: eff,
    claim: {
      claimId: c.claimId,
      claimGroupId: c.claimGroupId,
      revision: c.revision,
      kind: c.kind,
      epistemic: c.epistemic,
      speaker: c.speaker ?? null,
      speakerSource: c.speakerSource ?? null,
      status: c.status,
      title: c.title,
      body: c.body,
      topicId: c.topicId,
      topicHint: c.topicHint,
      confidence: c.confidence,
      derivedFromHash: c.derivedFromHash,
      supersedes: c.supersedes ?? null,
      supersededBy: c.supersededBy ?? null,
      conflictsWith: c.conflictsWith || [],
      reportedBy: c.reportedBy ?? null,
      source: c.source,
      model: c.model,
      promptVersion: c.promptVersion,
      runId: c.runId,
      costTokens: c.costTokens,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      review: c.review ?? null,
    },
    anchors,
    siblings: groupList.map((x) => ({ claimId: x.claimId, revision: x.revision, status: effectiveStatus(x, groupList, claims.supersededIds, claims.supersededGroups), createdAt: x.createdAt })),
    note: anchors.some((a) => a.quoteInChunk === false) ? '有锚点已对不上原文（跑 verify 看详情）' : null,
  }
}

/** 校验（HTTP 只读） */
export async function apiVerify({ dataRoot, personaId }) {
  const v = await verifyYear({ dataRoot, personaId, repair: false })
  return v
}

export { KINDS, STATUSES, EPISTEMIC }
