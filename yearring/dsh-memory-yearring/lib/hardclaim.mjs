/**
 * lib/hardclaim.mjs —— 硬认领（年轮侧）：把 claim 按「锚点」从源人格搬到目标人格。
 *
 * 规则（拍板 2026-11-13）：
 *   · 只搬「整组全锚点」的 claimGroup：组内每条 claim 的 derivedFrom 全部落在被搬块集合 S 里；
 *   · 混合锚点（部分在 S）→ **保留在原人格 + warning**，不复制、不改写锚点；
 *   · 搬走后 claimId / claimGroupId 必须按新 personaId 重算（契约：id = f(persona, kind, group, hash, revision)）；
 *   · 目标已有同 group + 同 derivedFromHash → 视为重复、跳过；同 group 不同证据 → revision 续在目标最新之后；
 *   · 写前整文件备份；搬完两边 rebuild topic_docs（0 LLM，可回滚）。
 *
 * 写边界：只写 <dataRoot>/year/<from|to>/；备份放源人格的 _archive/hard-claim-<tag>/。
 */
import { copyFile, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  PERSONA_UNASSIGNED, assertYearWrite, isSafePersonaId, topicDocsDir, yearDir, yearFile,
} from './paths.mjs'
import {
  atomicWrite, ensureDir, fileSize, hashFile, pathExists, readJson, writeJsonAtomic,
} from './fsatomic.mjs'
import { acquireLock } from './lock.mjs'
import { computeCounts, readClaims, readManifest, writeManifest } from './store.mjs'
import { claimGroupIdOf, claimIdOf } from './claim.mjs'
import { rebuildTopicDocs } from './topicdocs.mjs'
import { fail, toErrInfo } from './errors.mjs'

export const HARD_CLAIM_ARCHIVE_PREFIX = 'hard-claim'

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

function anchorsOf(claim) {
  return Array.isArray(claim?.derivedFrom) ? claim.derivedFrom : []
}

/**
 * 按 group 分类：
 *   move  = 组内每条 claim 都有锚点，且所有锚点 ⊆ S
 *   mixed = 组内至少一个锚点在 S，但没全在（保留 + warning）
 *   stay  = 完全无关 / 无锚点草稿
 */
export function classifyGroups(claims, idSet) {
  const groups = { move: [], mixed: [], stay: [] }
  for (const [groupId, list] of claims.byGroup) {
    let anyIn = false
    let allIn = true
    let allHaveAnchors = true
    for (const c of list) {
      const anchors = anchorsOf(c)
      if (!anchors.length) { allHaveAnchors = false; allIn = false; continue }
      for (const a of anchors) {
        if (idSet.has(String(a.chunkId))) anyIn = true
        else allIn = false
      }
    }
    const entry = { groupId, claims: list }
    if (anyIn && allIn && allHaveAnchors) groups.move.push(entry)
    else if (anyIn) groups.mixed.push(entry)
    else groups.stay.push(entry)
  }
  return groups
}

/** 预览（零写入） */
export async function previewMoveClaims({ dataRoot, from = PERSONA_UNASSIGNED, to, chunkIds = [] } = {}) {
  const root = resolve(dataRoot)
  if (!isSafePersonaId(to)) return fail('BAD_PERSONA_ID', `to 非法：${JSON.stringify(to)}`)
  const ids = new Set((chunkIds || []).map(String))
  if (!ids.size) return { ok: true, move: 0, mixedAnchor: 0, orphanAfter: 0, backupEstBytes: 0, note: '没有要搬的块' }

  const claims = await readClaims(root, from)
  if (claims.corrupt?.length) return fail('JSONL_CORRUPT', `源 claims.jsonl 有 ${claims.corrupt.length} 个坏行，拒绝搬迁`)
  if (claims.tornTail) return fail('JSONL_CORRUPT', '源 claims.jsonl 末尾有撕裂行，拒绝搬迁')
  const g = classifyGroups(claims, ids)
  const moveClaims = g.move.reduce((n, x) => n + x.claims.length, 0)
  const mixedClaims = []
  let orphanAfter = 0
  for (const grp of g.mixed) {
    for (const c of grp.claims) {
      const hit = anchorsOf(c).filter((a) => ids.has(String(a.chunkId))).length
      if (!hit) continue
      mixedClaims.push({ claimId: c.claimId, groupId: c.claimGroupId, anchorsInSet: hit, anchors: anchorsOf(c).length })
      orphanAfter += hit
    }
  }
  let backupEstBytes = 0
  for (const pid of [from, to]) {
    const dir = yearDir(root, pid)
    for (const name of ['claims.jsonl', 'manifest.json']) backupEstBytes += Math.max(0, await fileSize(join(dir, name)))
    let ents = []
    try { ents = await readdir(join(dir, 'topic_docs'), { withFileTypes: true }) } catch { /* 没有 docs */ }
    for (const e of ents) if (e.isFile() && e.name.endsWith('.md')) backupEstBytes += Math.max(0, await fileSize(join(dir, 'topic_docs', e.name)))
  }
  return {
    ok: true,
    dryRun: true,
    personaId: from,
    target: to,
    move: moveClaims,
    moveGroups: g.move.length,
    mixedAnchor: mixedClaims.length,
    mixedClaims: mixedClaims.slice(0, 20),
    mixedGroups: g.mixed.length,
    stay: g.stay.reduce((n, x) => n + x.claims.length, 0),
    orphanAfter,
    backupEstBytes,
    warnings: mixedClaims.length
      ? [`${mixedClaims.length} 条 claim 同时锚定搬迁块与非搬迁块：按拍板保留在原人格、不改写锚点；其中 ${orphanAfter} 个锚点在搬后会成为源侧孤儿（已知限制）`]
      : [],
  }
}

/** 备份两个 year scope（claims/manifest/topic_docs）；journal 放源人格 _archive */
async function backupYearScopes(root, from, to, tag) {
  const base = join(yearDir(root, from), '_archive', `${HARD_CLAIM_ARCHIVE_PREFIX}-${tag}`)
  const filesDir = join(base, 'files')
  await ensureDir(filesDir)
  const files = []
  const scopeExisted = {}
  const docsByScope = {}
  for (const pid of [from, to]) {
    const dir = yearDir(root, pid)
    try { scopeExisted[pid] = (await stat(dir)).isDirectory() } catch { scopeExisted[pid] = false }
    docsByScope[pid] = []
    for (const name of ['claims.jsonl', 'manifest.json']) {
      const src = join(dir, name)
      if (!(await pathExists(src))) continue
      const rel = join(pid, name)
      const dest = join(filesDir, rel)
      await ensureDir(dirname(dest))
      await copyFile(src, dest)
      const st = await stat(dest)
      files.push({ pid, rel: rel.replace(/\\/g, '/'), bytes: st.size, sha256: await hashFile(dest) })
    }
    let ents = []
    try { ents = await readdir(join(dir, 'topic_docs'), { withFileTypes: true }) } catch { /* 没有 docs */ }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const rel = join(pid, 'topic_docs', e.name)
      const dest = join(filesDir, rel)
      await ensureDir(dirname(dest))
      await copyFile(join(dir, 'topic_docs', e.name), dest)
      const st = await stat(dest)
      files.push({ pid, rel: rel.replace(/\\/g, '/'), bytes: st.size, sha256: await hashFile(dest) })
      docsByScope[pid].push(e.name)
    }
  }
  const journal = {
    version: 1, kind: 'year-hard-claim-backup', createdAt: new Date().toISOString(),
    dataRoot: root, from, to, tag, backupDir: base, filesDir, scopeExisted, docsByScope, files,
  }
  await writeJsonAtomic(join(base, 'year-journal.json'), journal)
  return { ok: true, dir: base, files, journal, sizeBytes: files.reduce((a, f) => a + f.bytes, 0) }
}

function maxRevision(list) {
  return (list || []).reduce((m, c) => Math.max(m, Number(c.revision) || 1), 0)
}

/**
 * 真搬 claims。confirm=true。返回搬了多少、混合多少、跳过多少。
 */
export async function moveClaims({
  dataRoot, from = PERSONA_UNASSIGNED, to, chunkIds = [], confirm = false, tag = stamp(), lockTimeoutMs = 10000,
} = {}) {
  if (confirm !== true) return fail('CONFIRM_REQUIRED', '搬 claims 会重写年轮文件：必须 confirm=true')
  const root = resolve(dataRoot)
  if (!isSafePersonaId(to)) return fail('BAD_PERSONA_ID', `to 非法：${JSON.stringify(to)}`)
  const ids = new Set((chunkIds || []).map(String))
  if (!ids.size) return { ok: true, noop: true, reason: 'NO_CHUNKS', moved: 0 }

  const c0 = await readClaims(root, from)
  if (c0.corrupt?.length) return fail('JSONL_CORRUPT', `源 claims.jsonl 有 ${c0.corrupt.length} 个坏行`)
  if (c0.tornTail) return fail('JSONL_CORRUPT', '源 claims.jsonl 末尾有撕裂行')
  const plan0 = classifyGroups(c0, ids)
  const wouldMove = plan0.move.reduce((n, x) => n + x.claims.length, 0)
  if (!wouldMove) {
    return { ok: true, noop: true, reason: 'NO_CLAIMS', moved: 0, mixedAnchor: plan0.mixed.reduce((n, x) => n + x.claims.length, 0) }
  }

  const backup = await backupYearScopes(root, from, to, tag)
  const locks = []
  try {
    const dirs = [yearDir(root, from), yearDir(root, to)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    for (const dir of dirs) {
      const lock = await acquireLock(dir, { timeoutMs: lockTimeoutMs })
      if (!lock.ok) return fail(lock.code || 'LOCK_BUSY', `年轮取锁失败（${dir}）：${lock.error?.message || ''}；本次未写`, lock.error || null)
      locks.push(lock)
    }

    const claims = await readClaims(root, from)
    const plan = classifyGroups(claims, ids)
    const movingGroupIds = new Set(plan.move.map((x) => x.groupId))
    const targetClaims = await readClaims(root, to)
    const iso = new Date().toISOString()
    const now = Date.now()

    const oldToNew = new Map()
    const appended = []
    const skipped = []
    let movedGroups = 0

    for (const grp of plan.move) {
      const list = [...grp.claims].sort((a, b) => (Number(a.revision) || 1) - (Number(b.revision) || 1))
      const first = list[0]
      const newGroupId = claimGroupIdOf(to, first.kind, first.title)
      const existing = targetClaims.byGroup.get(newGroupId) || []
      let revision = maxRevision(existing)
      let prevNewId = existing.length ? existing[existing.length - 1].claimId : null
      // 目标已有完全相同的证据 → 跳过（不重复追加）
      const byHash = new Map(existing.map((c) => [c.derivedFromHash, c]))
      for (const old of list) {
        if (byHash.has(old.derivedFromHash)) {
          const dup = byHash.get(old.derivedFromHash)
          oldToNew.set(old.claimId, dup.claimId)
          skipped.push({ claimId: old.claimId, reason: 'identical-in-target', existingClaimId: dup.claimId })
          continue
        }
        revision += 1
        const newClaimId = claimIdOf({
          personaId: to, kind: old.kind, claimGroupId: newGroupId,
          derivedFromHash: old.derivedFromHash, revision,
        })
        const next = {
          ...old,
          personaId: to,
          claimGroupId: newGroupId,
          revision,
          claimId: newClaimId,
          supersedes: prevNewId || null,
          supersededBy: null,
          conflictsWith: [],
          hardClaimFrom: from,
          hardClaimAt: iso,
          updatedAt: now,
        }
        oldToNew.set(old.claimId, newClaimId)
        prevNewId = newClaimId
        appended.push(next)
      }
      movedGroups += 1
    }

    // 跨引用映射：指向已搬 claim 的保留新 id；指向未搬（留在源）的引用置空并计数
    let droppedRefs = 0
    for (const c of appended) {
      const remap = (id) => {
        if (!id) return null
        if (oldToNew.has(id)) return oldToNew.get(id)
        droppedRefs += 1
        return null
      }
      // supersedes 已在上面按目标链重写；这里只处理冲突引用
      c.conflictsWith = (c.conflictsWith || []).map(remap).filter(Boolean)
    }

    if (appended.length) {
      // 源：整组移除；其它组原样保留（不碰它们的锚点/引用）
      const kept = claims.rows.filter((r) => !movingGroupIds.has(r.claimGroupId))
      await atomicWrite(yearFile(root, from, 'claims'), kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''))
      // 目标：append-only
      await ensureDir(yearDir(root, to))
      const prev = await readFile(yearFile(root, to, 'claims'), 'utf8').catch(() => '')
      await atomicWrite(
        yearFile(root, to, 'claims'),
        prev + (prev && !prev.endsWith('\n') ? '\n' : '') + appended.map((r) => JSON.stringify(r)).join('\n') + '\n',
      )
    }

    // manifest 计数（rebuild 会再精算；先让账本可用）
    const countsOf = async (pid) => {
      const idx = await readClaims(root, pid)
      const counts = computeCounts(idx, 0)
      const man = await readManifest(root, pid)
      if (man.ok) {
        await writeManifest(root, pid, {
          ...man.manifest,
          counts: { ...(man.manifest.counts || {}), ...counts, topicDocs: man.manifest.counts?.topicDocs ?? 0 },
          generation: (Number(man.manifest.generation) || 0) + 1,
        })
      }
      return counts
    }
    const srcCounts = await countsOf(from)
    const tgtCounts = await countsOf(to)

    const mixed = plan.mixed.reduce((n, x) => n + x.claims.length, 0)
    return {
      ok: true,
      moved: appended.length,
      movedGroups,
      mixedAnchor: mixed,
      mixedGroups: plan.mixed.length,
      skipped: skipped.length,
      skippedDetails: skipped.slice(0, 10),
      droppedRefs,
      source: { claims: srcCounts.claims, groups: srcCounts.groups },
      target: { claims: tgtCounts.claims, groups: tgtCounts.groups },
      movedClaimIds: appended.map((c) => c.claimId),
      backupDir: backup.dir,
      backupBytes: backup.sizeBytes,
    }
  } catch (e) {
    return { ok: false, code: e?.code || 'YEAR_MOVE_FAILED', error: toErrInfo(e), backupDir: backup.dir }
  } finally {
    for (const l of locks.reverse()) { try { await l.release?.() } catch { /* 忽略 */ } }
  }
}

/** 搬迁后重建两边 topic_docs（0 LLM；各自取锁） */
export async function rebuildAfterMove({ dataRoot, from = PERSONA_UNASSIGNED, to } = {}) {
  const root = resolve(dataRoot)
  const out = {}
  for (const pid of [from, to]) {
    try {
      const man = await readManifest(root, pid)
      if (!man.exists) { out[pid] = { ok: true, skipped: true, reason: 'MANIFEST_MISSING' }; continue }
      out[pid] = await rebuildTopicDocs({ dataRoot: root, personaId: pid, confirm: true })
    } catch (e) {
      out[pid] = { ok: false, code: e?.code || 'REBUILD_FAILED', error: toErrInfo(e) }
    }
  }
  return out
}

/** 回滚：整文件恢复 claims/manifest/topic_docs */
export async function rollbackMoveClaims({ dataRoot, backupDir } = {}) {
  const root = resolve(dataRoot)
  const jr = await readJson(join(backupDir, 'year-journal.json'))
  if (!jr.ok) return fail('BACKUP_NOT_FOUND', `读不到年轮备份 journal：${join(backupDir, 'year-journal.json')}`)
  const j = jr.value
  const filesDir = j.filesDir || join(backupDir, 'files')
  const restored = []
  const problems = []
  for (const f of j.files || []) {
    try {
      const buf = await readFile(join(filesDir, f.rel))
      const relParts = f.rel.replace(/\\/g, '/').split('/')
      // rel = <pid>/<rest>
      const pid = relParts[0]
      const rest = relParts.slice(1).join('/')
      const dest = rest === 'claims.jsonl' ? yearFile(root, pid, 'claims')
        : rest === 'manifest.json' ? yearFile(root, pid, 'manifest')
          : join(topicDocsDir(root, pid), rest.replace(/^topic_docs\//, ''))
      assertYearWrite(root, pid, dest)
      await ensureDir(dirname(dest))
      await atomicWrite(dest, buf)
      const h = await hashFile(dest)
      if (h !== f.sha256) problems.push({ pid, rel: f.rel, expected: f.sha256, got: h })
      else restored.push(f.rel)
    } catch (e) {
      problems.push({ rel: f.rel, error: toErrInfo(e) })
    }
  }
  // 重建后新生成的 topic doc 不在备份里 → 移出（派生文件，可重建；不物理删 claims）
  const removedDocs = []
  const created = []
  for (const pid of [j.from, j.to]) {
    const keep = new Set((j.docsByScope?.[pid] || []).map((n) => n))
    const dir = topicDocsDir(root, pid)
    let ents = []
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { ents = [] }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.md') || keep.has(e.name)) continue
      try { await rm(join(dir, e.name), { force: true }); removedDocs.push(`${pid}/${e.name}`) } catch { /* 忽略 */ }
    }
    // 该 scope 在搬迁前不存在 → 删掉本次新建的 claims/manifest（只删已知名字，不动 _archive）
    if (!j.scopeExisted?.[pid]) {
      for (const name of ['claims.jsonl', 'manifest.json']) {
        const f = join(yearDir(root, pid), name)
        try { await rm(f, { force: true }); created.push(`${pid}/${name}`) } catch { /* 不存在就算了 */ }
      }
      try {
        for (const n of await readdir(dir)) {
          if (!n.endsWith('.md')) continue
          try { await rm(join(dir, n), { force: true }); created.push(`${pid}/topic_docs/${n}`) } catch { /* 忽略 */ }
        }
      } catch { /* 没有 docs 目录 */ }
    }
  }
  return { ok: problems.length === 0, backupDir, restored, removedDocs, createdRemoved: created, problems }
}
