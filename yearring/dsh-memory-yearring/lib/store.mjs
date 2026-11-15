/**
 * lib/store.mjs —— 年轮存储层
 *
 * 布局：<dataRoot>/year/<personaId>/
 *   claims.jsonl     唯一事实源（append-only，latest-wins）
 *   manifest.json    计数/代数/预算/最近运行（原子写）
 *   runs.jsonl       每次 run 一行（append-only）
 *   topic_docs/      派生正文（可删可重建，0 LLM）
 *   _archive/        旧版本/快照（不物理删 claim）
 *
 * 纪律：
 *   · claim 只 append，不 update 不删；同一 claimId 重复出现时后者覆盖（latest-wins）
 *   · manifest 用原子写；任何写前先过 assertYearWrite
 *   · 落盘失败绝不回报 ok
 */
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  YEAR_FILES, yearDir, yearFile, archiveDir, assertYearWrite, isSafePersonaId, topicDocsDir,
} from './paths.mjs'
import {
  readJson, readJsonl, writeJsonAtomic, appendJsonl, ensureDir, pathExists, listOrphanTmp,
} from './fsatomic.mjs'
import { SCHEMA_VERSION, CONTRACT_VERSION, DEFAULT_BUDGET, PROMPT_VERSION, MAX_REVISIONS_PER_GROUP } from './version.mjs'
import { effectiveStatus } from './claim.mjs'

export function emptyManifest(personaId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    personaId,
    generation: 0,
    counts: { claims: 0, active: 0, draft: 0, conflicted: 0, topicDocs: 0, runs: 0 },
    lastRunAt: null,
    lastRunId: null,
    lastRunRootBuiltAt: null,
    model: null,
    promptVersion: PROMPT_VERSION,
    ruleVersion: null,
    budget: { ...DEFAULT_BUDGET },
    degraded: false,
    lastError: null,
    createdAt: null,
    updatedAt: null,
    writer: { name: 'dsh-memory-yearring', version: null },
  }
}

/** 确保 year/<personaId>/ 存在（写闸门在这里最先生效） */
export async function ensureYearHome(dataRoot, personaId) {
  if (!isSafePersonaId(personaId)) {
    const e = new Error(`personaId 非法：${personaId}`)
    e.code = 'BAD_PERSONA_ID'
    throw e
  }
  const dir = yearDir(dataRoot, personaId)
  assertYearWrite(dataRoot, personaId, dir)
  await ensureDir(dir)
  await ensureDir(topicDocsDir(dataRoot, personaId))
  await ensureDir(archiveDir(dataRoot, personaId))
  return dir
}

/** 读 manifest；不存在时返回默认（exists=false，不写盘） */
export async function readManifest(dataRoot, personaId) {
  const file = yearFile(dataRoot, personaId, 'manifest')
  const r = await readJson(file)
  if (!r.ok) {
    if (r.code === 'ENOENT') {
      return { ok: true, exists: false, manifest: emptyManifest(personaId), file }
    }
    return { ok: false, code: r.code === 'JSON_PARSE' ? 'MANIFEST_INVALID' : r.code, error: r.error, file }
  }
  const m = r.value
  const problems = []
  if (!m || typeof m !== 'object') problems.push('manifest 不是对象')
  if (m?.personaId && m.personaId !== personaId) problems.push(`manifest.personaId（${m.personaId}）与目录（${personaId}）不一致`)
  if (m?.contractVersion > CONTRACT_VERSION) problems.push(`contractVersion=${m.contractVersion} > ${CONTRACT_VERSION}`)
  if (problems.length) {
    return { ok: false, code: 'MANIFEST_INVALID', error: { code: 'MANIFEST_INVALID', message: problems.join('；') }, file }
  }
  const merged = { ...emptyManifest(personaId), ...m }
  merged.counts = { ...emptyManifest(personaId).counts, ...(m.counts || {}) }
  merged.budget = { ...DEFAULT_BUDGET, ...(m.budget || {}) }
  return { ok: true, exists: true, manifest: merged, file }
}

export async function writeManifest(dataRoot, personaId, manifest) {
  const file = yearFile(dataRoot, personaId, 'manifest')
  assertYearWrite(dataRoot, personaId, file)
  const next = { ...manifest, updatedAt: Date.now() }
  await writeJsonAtomic(file, next)
  return { ok: true, file, manifest: next }
}

/**
 * 读全部 claim 并建索引。
 * latest-wins：同一 claimId 后者覆盖。
 * 注意：同 id 多行是**合法历史**（元数据回填按 append-only 追加新行，见 tools/backfill-claim-speaker.mjs），
 * 不是损坏；但文件只增不减，长期需要 tools/compact-claims.mjs 压缩。
 */
export async function readClaims(dataRoot, personaId) {
  const file = yearFile(dataRoot, personaId, 'claims')
  const r = await readJsonl(file)
  const rows = []
  const byId = new Map()
  const corruptRows = []
  for (const row of r.rows) {
    if (!row || typeof row !== 'object' || !row.claimId) { corruptRows.push(row); continue }
    rows.push(row)
    byId.set(row.claimId, row)
  }
  const byGroup = new Map()
  for (const c of byId.values()) {
    const g = c.claimGroupId || c.claimId
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(c)
  }
  for (const list of byGroup.values()) list.sort((a, b) => (a.revision || 1) - (b.revision || 1))
  const supersededIds = new Set()
  const supersededGroups = new Map()
  for (const c of byId.values()) {
    if (!c.supersedes) continue
    const targetId = String(c.supersedes)
    supersededIds.add(targetId)
    const target = byId.get(targetId)
    if (!target) continue
    const at = Number(c.createdAt) || 0
    const prev = supersededGroups.get(target.claimGroupId)
    if (prev === undefined || at > prev) supersededGroups.set(target.claimGroupId, at)
  }
  const latestByGroup = new Map()
  for (const [g, list] of byGroup) latestByGroup.set(g, list[list.length - 1])
  return {
    ok: true,
    exists: r.exists,
    file,
    rows,
    unique: byId.size,
    byId,
    byGroup,
    latestByGroup,
    supersededIds,
    supersededGroups,
    corrupt: [...(r.corrupt || []), ...corruptRows.map((row) => ({ row }))],
    tornTail: Boolean(r.tornTail),
    bytes: r.bytes,
  }
}

export async function appendClaims(dataRoot, personaId, claims) {
  const file = yearFile(dataRoot, personaId, 'claims')
  assertYearWrite(dataRoot, personaId, file)
  return appendJsonl(file, claims, { durable: true })
}

export async function readRuns(dataRoot, personaId, limit = 50) {
  const file = yearFile(dataRoot, personaId, 'runs')
  const r = await readJsonl(file)
  const rows = r.rows.slice(-Math.max(1, limit))
  return { ok: true, file, exists: r.exists, total: r.rows.length, rows, corrupt: r.corrupt, tornTail: r.tornTail }
}

export async function appendRun(dataRoot, personaId, run) {
  const file = yearFile(dataRoot, personaId, 'runs')
  assertYearWrite(dataRoot, personaId, file)
  return appendJsonl(file, [run], { durable: true })
}

/** 统计（不读正文以外的语义，只数） */
export function computeCounts(claimsIndex, topicDocs = 0) {
  const counts = { claims: 0, active: 0, draft: 0, conflicted: 0, superseded: 0, expired: 0, archived: 0, groups: 0, topicDocs }
  for (const c of claimsIndex.byId.values()) {
    counts.claims += 1
    // 计数用「有效状态」：与 topic 正文/apiClaims 看到的一致
    const groupList = claimsIndex.byGroup?.get(c.claimGroupId) || []
    const eff = effectiveStatus(c, groupList, claimsIndex.supersededIds, claimsIndex.supersededGroups)
    switch (eff) {
      case 'active': counts.active += 1; break
      case 'draft': counts.draft += 1; break
      case 'conflicted': counts.conflicted += 1; break
      case 'superseded': counts.superseded += 1; break
      case 'expired': counts.expired += 1; break
      case 'archived': counts.archived += 1; break
      default: break
    }
  }
  counts.groups = claimsIndex.byGroup.size
  return counts
}

export async function listTopicDocs(dataRoot, personaId) {
  const dir = topicDocsDir(dataRoot, personaId)
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  return ents.filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => join(dir, d.name)).sort()
}

export async function topicDocCount(dataRoot, personaId) {
  return (await listTopicDocs(dataRoot, personaId)).length
}

/** 清理自己留下的孤儿 tmp（不删别的东西） */
export async function cleanOwnTmp(dataRoot, personaId) {
  const dirs = [yearDir(dataRoot, personaId), topicDocsDir(dataRoot, personaId)]
  const removed = []
  for (const dir of dirs) {
    for (const f of await listOrphanTmp(dir)) {
      try { await unlink(f); removed.push(f) } catch { /* 忽略 */ }
    }
  }
  return removed
}

export async function yearDirExists(dataRoot, personaId) {
  return pathExists(yearDir(dataRoot, personaId))
}

/** 单 group 的 revision 上限保护（防止一条标题被无限改写） */
export function nextRevisionFor(groupList) {
  const maxRev = groupList.reduce((m, c) => Math.max(m, Number(c.revision) || 0), 0)
  if (maxRev >= MAX_REVISIONS_PER_GROUP) return null
  return maxRev + 1
}
