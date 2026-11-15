/**
 * lib/topicdocs.mjs —— topic 正文拼装（规则拼装，0 LLM）与 rebuild
 *
 * 规则（契约 §5.4）：
 *   · 按 topicId 分组 → active claims 按 t 排序 → 生成 Markdown
 *   · 每条 claim 一行，附 [^cN]；footer 列 anchors（chunkId/session/seq/quote）
 *   · 冲突 claim 单列「存在矛盾」小节，不合并
 *   · 被取代 claim 进「历史版本」小节（可折叠）
 *   · 无 claim → 不生成正文（「正文待生成」，不编）
 *
 * v1a 说明：熏习 topics=0 时没有 topicId，用 topicHint 归一化分组（hint-<hash>）。
 */
import { rename, readdir, copyFile, stat, rm, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { topicDocsDir, archiveDir, assertYearWrite, tsSlugMs, yearDir } from './paths.mjs'
import { ensureDir, atomicWrite } from './fsatomic.mjs'
import { readClaims, readManifest, computeCounts, writeManifest } from './store.mjs'
import { effectiveStatus, normalizeTitle, sha256 } from './claim.mjs'
import { L1_BY_ID, MISC_TITLE, groupOfClaim, loadOverrides } from './topicgroups.mjs'
import { RULE_VERSION } from './version.mjs'
import { acquireLock } from './lock.mjs'

/** 分组键：优先 topicId，其次 topicHint，最后「未归类」；同时带 L1 大主题 */
export function groupKeyOf(claim, overrides = null) {
  const l1 = groupOfClaim(claim, overrides)
  const base = { groupId: l1.groupId, groupTitle: l1.groupTitle }
  if (claim.topicId) return { ...base, key: String(claim.topicId), kind: 'topic', title: claim.topicHint || claim.topicId }
  if (claim.topicHint) {
    const norm = normalizeTitle(claim.topicHint)
    if (norm) return { ...base, key: `hint-${sha256(norm).slice(0, 10)}`, kind: 'hint', title: claim.topicHint }
  }
  return { ...base, key: 'untitled', kind: 'none' }
}

const kindLabel = {
  event: '事件', fact: '事实', preference: '偏好', boundary: '边界',
  relation: '关系', timeline: '时间线', conclusion: '结论', knowledge: '知识',
}

const fmtDate = (t) => {
  if (!Number.isFinite(Number(t))) return ''
  const d = new Date(Number(t))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

/** 生成一个 topic 的 Markdown 文本 */
export function renderTopicDoc({ key, title, claims, groupId = null, groupTitle = null, version = 1, generatedAt = Date.now() }) {
  // claims 已包含 active + 其他状态；这里分流
  const active = claims.filter((c) => c._effStatus === 'active')
  const conflicted = claims.filter((c) => c._effStatus === 'conflicted')
  const history = claims.filter((c) => c._effStatus === 'superseded' || c._effStatus === 'expired' || c._effStatus === 'archived')

  const claimIds = [...active, ...conflicted, ...history].map((c) => c.claimId)
  const anchorsAll = []
  for (const c of [...active, ...conflicted, ...history]) for (const a of c.derivedFrom || []) anchorsAll.push(a)
  const derivedFromHash = sha256(anchorsAll.map((a) => `${a.chunkId}|${a.quote}`).sort().join('\n'))

  const lines = []
  // front-matter 里的字符串一律 YAML 双引号转义（审查实测 topicHint 里塞 `\n---\n` 能截断 front-matter）
  const yamlStr = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\u2028\u2029]+/g, ' ')}"`
  lines.push('---')
  lines.push(`topicId: ${yamlStr(key)}`)
  lines.push(`title: ${yamlStr(title)}`)
  if (groupId) lines.push(`groupId: ${yamlStr(groupId)}`)
  if (groupTitle) lines.push(`groupTitle: ${yamlStr(groupTitle)}`)
  lines.push(`version: ${Number(version) || 1}`)
  lines.push(`status: active`)
  lines.push(`generator: rule-v1`)
  lines.push(`ruleVersion: ${yamlStr(RULE_VERSION)}`)
  lines.push(`claimCount: ${claimIds.length}`)
  lines.push(`activeCount: ${active.length}`)
  lines.push(`conflictedCount: ${conflicted.length}`)
  lines.push(`historyCount: ${history.length}`)
  lines.push(`generatedAt: ${Number(generatedAt) || 0}`)
  lines.push(`derivedFromHash: ${yamlStr(derivedFromHash)}`)
  lines.push(`claimIds: [${claimIds.map(yamlStr).join(', ')}]`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${title}`)
  lines.push('')

  if (!active.length && !conflicted.length && !history.length) {
    lines.push('正文待生成：这个主题下还没有 claim。')
    return { text: lines.join('\n') + '\n', claimIds, derivedFromHash, counts: { active: 0, conflicted: 0, history: 0 } }
  }

  // 按时间排（t 取最小锚点时间；无 t 排最后）
  const tOf = (c) => {
    const ts = (c.derivedFrom || []).map((a) => Number(a.t)).filter((x) => Number.isFinite(x))
    return ts.length ? Math.min(...ts) : Number.MAX_SAFE_INTEGER
  }
  const sortedActive = [...active].sort((a, b) => tOf(a) - tOf(b))

  const prevTalk = (c) => {
    const last = (c.derivedFrom || []).slice(-1)[0]
    if (!last) return ''
    const d = fmtDate(last.t)
    return d ? `**${d}** ` : ''
  }

  lines.push('## 结论')
  lines.push('')
  if (!sortedActive.length) {
    lines.push('_（暂无 active 结论）_')
    lines.push('')
  } else {
    let n = 0
    for (const c of sortedActive) {
      n += 1
      const ref = `[^c${n}]`
      c._ref = ref
      const body = c.body ? ` — ${esc(c.body)}` : ''
      lines.push(`- ${prevTalk(c)}（${kindLabel[c.kind] || c.kind}）**${esc(c.title)}**${body} ${ref}`)
    }
    lines.push('')
  }

  if (conflicted.length) {
    lines.push('## 存在矛盾')
    lines.push('')
    lines.push('> 这些结论与既有结论冲突，未合并；保留双方等人工确认。')
    lines.push('')
    let n = 0
    for (const c of conflicted) {
      n += 1
      const ref = `[^x${n}]`
      c._ref = ref
      const withList = (c.conflictsWith || []).map((g) => `\`${String(g).slice(0, 16)}…\``).join('、')
      lines.push(`- ${prevTalk(c)}（${kindLabel[c.kind] || c.kind}）**${esc(c.title)}** ${ref}${withList ? ` ⇄ 与 ${withList} 矛盾` : ''}`)
    }
    lines.push('')
  }

  if (history.length) {
    lines.push('<details>')
    lines.push('<summary>历史版本（被取代/过期/归档，共 ' + history.length + ' 条）</summary>')
    lines.push('')
    let n = 0
    for (const c of history) {
      n += 1
      lines.push(`- 【${c._effStatus}】${prevTalk(c)}（${kindLabel[c.kind] || c.kind}）${esc(c.title)}（rev ${c.revision ?? 1}）`)
    }
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  // footer：锚点
  const usedClaims = [...sortedActive, ...conflicted]
  if (usedClaims.length) {
    lines.push('---')
    lines.push('')
    lines.push('## 锚点（原文出处）')
    lines.push('')
    for (const c of usedClaims) {
      if (!c._ref) continue
      const a = (c.derivedFrom || [])[0]
      if (!a) continue
      const q = String(a.quote || '').replace(/[\r\n]+/g, ' ')
      lines.push(`${c._ref}: ${a.chunkId} · ${a.session || '?'} · seq ${a.seq ?? '?'} · 「${q}」`)
    }
    lines.push('')
  }

  return {
    text: lines.join('\n') + '\n',
    claimIds,
    derivedFromHash,
    counts: { active: active.length, conflicted: conflicted.length, history: history.length },
  }
}

/** 把 claims 按分组键聚起来 */
export function groupClaims(claimsIndex, personaId = null, overrides = null) {
  const groups = new Map()
  for (const c of claimsIndex.byId.values()) {
    // 防御：外来人格的 claim 绝不进本人的 topic 正文（审查指出的缺口）
    if (personaId && c.personaId && c.personaId !== personaId) continue
    const g = groupKeyOf(c, overrides)
    if (!groups.has(g.key)) {
      groups.set(g.key, {
        key: g.key,
        kind: g.kind,
        title: g.title || (c.topicId ? (c.topicHint || c.topicId) : '未归类'),
        groupId: g.groupId,
        groupTitle: g.groupTitle,
        _gidCount: {},
        claims: [],
      })
    }
    const grp = groups.get(g.key)
    if (g.kind === 'hint' && c.topicHint) grp.title = c.topicHint
    if (g.groupId) grp._gidCount[g.groupId] = (grp._gidCount[g.groupId] || 0) + 1
    const groupList = claimsIndex.byGroup.get(c.claimGroupId) || []
    grp.claims.push({ ...c, _effStatus: effectiveStatus(c, groupList, claimsIndex.supersededIds, claimsIndex.supersededGroups) })
  }
  // L1 取组内众数（防御 topicId 组混类）
  for (const grp of groups.values()) {
    const top = Object.entries(grp._gidCount).sort((a, b) => b[1] - a[1])[0]
    if (top) {
      grp.groupId = top[0]
      grp.groupTitle = L1_BY_ID.get(top[0])?.title || MISC_TITLE
    }
    delete grp._gidCount
  }
  return groups
}

/**
 * 收尾快照：rebuild 每次都会整份镜像 topic_docs 到 _archive/<ts>/；
 * 不限制的话每小时一份、每份上千个 md → 本机曾累积 165 份 / 1018MB / 17 万文件。
 *
 * 规则：只认「时间戳命名」的快照（hard-claim-* / lock-stale-* 等不动）。
 *   · 配了归档目录（archiveRoot）→ 全部搬到 <archiveRoot>/year/<pid>/_archive/，归档盘上保留最近 keep 份；
 *   · 没配 → C 盘只保留最近 keep 份，更旧的清理。
 */
const SNAP_DIR_RE = /^\d{8}-\d{6}-\d{1,3}-[a-z0-9]{4,}$/

async function moveDir(src, dest) {
  try { await rename(src, dest) } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    await cp(src, dest, { recursive: true, force: false, errorOnExist: true })
    await rm(src, { recursive: true, force: true })
  }
}

async function listSnapshots(baseDir) {
  let ents = []
  try { ents = await readdir(baseDir, { withFileTypes: true }) } catch { return [] }
  const rows = []
  for (const d of ents) {
    if (!d.isDirectory() || !SNAP_DIR_RE.test(d.name)) continue
    const p = join(baseDir, d.name)
    const s = await stat(p).catch(() => null)
    rows.push({ name: d.name, dir: p, mtimeMs: s?.mtimeMs ?? 0 })
  }
  rows.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
  return rows
}

export async function settleTopicSnapshots({ dataRoot, personaId, archiveRoot = '', keep = 2 }) {
  const keepN = Math.max(1, Math.min(20, Number(keep) || 2))
  const rows = await listSnapshots(archiveDir(dataRoot, personaId))
  const out = { ok: true, keep: keepN, total: rows.length, archived: 0, deleted: 0, errors: [] }
  if (!rows.length) return out
  if (archiveRoot) {
    const dstBase = join(archiveRoot, 'year', personaId, '_archive')
    await ensureDir(dstBase)
    for (const r of rows) {
      try { await moveDir(r.dir, join(dstBase, r.name)); out.archived++ } catch (e) {
        out.errors.push(`${r.name}: ${e?.code || e?.message || e}`)
      }
    }
    // 归档盘上同样只留最近 keep 份（每小时一份，全留会无限涨）
    const arows = await listSnapshots(dstBase)
    for (const r of arows.slice(keepN)) {
      try { await rm(r.dir, { recursive: true, force: true }); out.deleted++ } catch { /* 单份失败不阻塞 */ }
    }
  } else {
    for (const r of rows.slice(keepN)) {
      try { await rm(r.dir, { recursive: true, force: true }); out.deleted++ } catch { /* 单份失败不阻塞 */ }
    }
  }
  return out
}

/**
 * rebuild：从 claims 全量重建 topic_docs（0 LLM）。
 * 旧 topic_docs 先整体快照进 _archive/<ts>/topic_docs-mirror/，再重写。
 */
export async function rebuildTopicDocs({ dataRoot, personaId, confirm = false, archiveDir: archiveRoot = '', snapshotKeep = 2 }) {
  if (confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRM_REQUIRED',
      error: { code: 'CONFIRM_REQUIRED', message: 'rebuild 会重写 topic_docs/：请带 confirm=true（0 LLM、不动 claims、可回滚）' },
    }
  }

  const claims = await readClaims(dataRoot, personaId)
  if (claims.corrupt.length) {
    return {
      ok: false,
      code: 'JSONL_CORRUPT',
      error: { code: 'JSONL_CORRUPT', message: `claims.jsonl 有 ${claims.corrupt.length} 个坏行，先 verify 处理`, detail: claims.corrupt.slice(0, 5) },
    }
  }

  // 单写者锁：和 run 共用同一把，避免并发写坏 manifest
  const lock = await acquireLock(yearDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
  const manifestRes = await readManifest(dataRoot, personaId)
  const dir = topicDocsDir(dataRoot, personaId)
  assertYearWrite(dataRoot, personaId, dir)
  await ensureDir(dir)

  // 快照旧 docs —— 失败必须如实报告（不能一边说可回滚一边吞错）
  const snapTag = tsSlugMs()
  const snapDir = join(archiveDir(dataRoot, personaId, snapTag), 'topic_docs-mirror')
  let mirrored = 0
  let snapshotError = null
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      assertYearWrite(dataRoot, personaId, join(snapDir, e.name))
      await ensureDir(snapDir)
      await copyFile(join(dir, e.name), join(snapDir, e.name))
      mirrored += 1
    }
  } catch (e) {
    snapshotError = { code: e.code || 'SNAPSHOT_FAILED', message: String(e.message || e) }
  }

  const groups = groupClaims(claims, personaId, await loadOverrides(dataRoot, personaId, join, yearDir))
  const written = []
  const now = Date.now()
  const docVersion = Math.max(1, Number(manifestRes.ok ? manifestRes.manifest.generation : 0) || 0)
  for (const [key, grp] of groups) {
    const version = docVersion
    const rendered = renderTopicDoc({
      key,
      title: grp.title || key,
      claims: grp.claims,
      groupId: grp.groupId,
      groupTitle: grp.groupTitle,
      version,
      generatedAt: now,
    })
    const file = join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`)
    assertYearWrite(dataRoot, personaId, file)
    await atomicWrite(file, rendered.text)
    written.push({ file, key, title: grp.title, groupId: grp.groupId, groupTitle: grp.groupTitle, claims: rendered.claimIds.length, ...rendered.counts })
  }

  // 清掉「已经没有 claim」的旧 md：移入快照目录，不物理删
  const existing = await readdir(dir).catch(() => [])
  const keep = new Set(written.map((w) => w.file.split(/[\\/]/).pop()))
  const moved = []
  for (const name of existing) {
    if (!name.endsWith('.md') || keep.has(name)) continue
    const from = join(dir, name)
    const to = join(snapDir, name)
    try {
      await ensureDir(snapDir)
      await rename(from, to)
      moved.push(name)
    } catch { /* 挪不动就留着，下次再说 */ }
  }

  const counts = computeCounts(claims, written.length)
  // 只在该 persona 已经有过 run（manifest 存在）时更新；空数据不落 manifest
  if (manifestRes.ok && manifestRes.exists) {
    const m = {
      ...manifestRes.manifest,
      generation: (Number(manifestRes.manifest.generation) || 0) + 1,
      counts: { ...counts, runs: manifestRes.manifest.counts?.runs ?? 0 },
      lastRebuildAt: Date.now(),
    }
    await writeManifest(dataRoot, personaId, m)
  }

  // 快照收尾：归档或清理旧快照，保证 _archive 不会每小时涨一份
  const snapshotCleanup = await settleTopicSnapshots({ dataRoot, personaId, archiveRoot, keep: snapshotKeep })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }))

  return {
    ok: true,
    personaId,
    topicDocs: written.length,
    groups: groups.size,
    written,
    movedOut: moved,
    mirroredOld: mirrored,
    snapshot: mirrored || moved.length ? snapDir : null,
    snapshotCleanup,
    snapshotError,
    claims: { total: counts.claims, active: counts.active, conflicted: counts.conflicted },
    note: written.length === 0 ? '没有 claim，topic_docs 保持空（不生成空正文）' : '0 LLM 重建完成；可重复执行',
  }
  } finally {
    await lock.release().catch(() => {})
  }
}
