/**
 * lib/hardclaim.mjs —— 硬认领（根藏侧）：把 persona_unassigned 的原话块**真正搬到**
 * 目标人格，连同向量一起搬；全量备份、双 scope 锁、每步 verify、整文件回滚。
 *
 * 纪律（计划 2026-11-13 §2 S1 / 设计稿 §5）：
 *   · 只做 persona_unassigned → 已声明人格；不做人格→人格；
 *   · 先 T0 全量快照，再 T2 写目标（verify），最后 T3 重写源（verify）；任一失败 → 用快照整目录恢复；
 *   · 向量按「保留索引重建」，绝不按字节裁剪；行数 × 维度 × 4 必须对得上，否则拒绝写；
 *   · 目标已有同 id 块 → 不重复追加，但仍从源移除（去重口径，不是「跳过整条」）；
 *   · 目标 generation 不匹配 → STALE_GENERATION；锁占用 → LOCK_BUSY，一字不动；
 *   · 不重嵌、不调用任何网络/嵌入 API。
 *
 * 本模块只碰 <dataRoot>/scopes/<from|to>/、<dataRoot>/identity.json、<dataRoot>/_archive/hard-claim-*。
 * process/ 与 year/ 的搬迁在各自包里做，镜台负责串起来。
 */
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  PERSONA_UNASSIGNED, chunksPath, deletedPath, identityPath, indexPathMetaPath, isSafePersonaId,
  manifestPath, normPath, scopeDir, vectorPath, vectorFileName,
} from './paths.mjs'
import {
  atomicWrite, ensureDir, fileSize, hashFile, pathExists, readJson, readJsonl,
} from './fsatomic.mjs'
import { readVectorFile, writeVectorFile, sliceRows, inspectVectors, expectedBytes } from './vectors.mjs'
import { buildIndexMeta, buildManifest } from './manifest.mjs'
import { readScopeMeta, readScopeChunks, verifyScope, appendTombstone } from './store.mjs'
import { loadIdentity } from './identity.mjs'
import { acquireLock } from './lock.mjs'
import { summarizeChunks } from './chunks.mjs'
import { CODES, fail, toErrInfo } from './errors.mjs'
import { NORMALIZER_VERSION } from './version.mjs'

export const HARD_CLAIM_VERSION = 1
export const HARD_CLAIM_ARCHIVE_PREFIX = 'hard-claim'

const SCOPE_BACKUP_NAMES = ['chunks.jsonl', 'manifest.json', 'index_meta.json', 'deleted.jsonl', 'cost.jsonl']

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 比较用路径（Windows 不区分大小写、统一反斜杠、去尾斜杠） */
export function normWs(p) {
  return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 找 scope 实际使用的向量文件：优先 index_meta，其次目录里的 vectors_v*.f32 */
async function resolveVectorFile(dir, indexMeta) {
  if (indexMeta?.vectorFile) return join(dir, indexMeta.vectorFile)
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return join(dir, vectorFileName(indexMeta?.vectorVersion || 1)) }
  const vs = ents.filter((e) => e.isFile() && /^vectors_v\d+\.f32$/.test(e.name))
    .map((e) => e.name).sort()
  return join(dir, vs.length ? vs[vs.length - 1] : vectorFileName(indexMeta?.vectorVersion || 1))
}

function shaShort(s) {
  return String(s || '').slice(0, 12)
}

/** 一个 scope 目录里要备份/恢复的文件（含向量文件）；不存在则跳过 */
async function listScopeFiles(dir) {
  const out = []
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile()) continue
    if (SCOPE_BACKUP_NAMES.includes(e.name) || /^vectors_v\d+\.f32$/.test(e.name)) out.push(join(dir, e.name))
  }
  return out
}

/**
 * 选择块：只接受「精确工作区前缀」或「会话 id 列表」。
 * @returns {Promise<{ok:true, rows:object[], indices:number[], source:object, vectors:object|null, missingVectorIds:string[], samples:object[]}|{ok:false,code:string,error:object}>}
 */
export async function selectChunks({ dataRoot, workspace = null, sessionIds = null, sampleLimit = 5 } = {}) {
  const ws = workspace == null ? null : String(workspace)
  const sessions = Array.isArray(sessionIds) ? sessionIds.map(String).filter(Boolean) : null
  if ((ws == null || ws === '') && (!sessions || sessions.length === 0)) {
    return fail('BAD_ARGS', '必须提供 workspace 或 sessionIds 之一（至少命中 1 条，否则不搬）')
  }
  if (ws != null && ws !== '' && sessions && sessions.length) {
    return fail('BAD_ARGS', 'workspace 与 sessionIds 只能二选一（避免「看起来搬了 A 其实连 B 也搬」）')
  }

  const meta = await readScopeMeta(dataRoot, PERSONA_UNASSIGNED)
  const chunks = await readScopeChunks(dataRoot, PERSONA_UNASSIGNED)
  if (chunks.error) return fail(CODES.READ_FAILED, `未归属 chunks 读失败（≠空库）：${chunks.error.message}`)
  if (chunks.corrupt?.length) return fail(CODES.JSONL_CORRUPT, `未归属 chunks.jsonl 有 ${chunks.corrupt.length} 行损坏，拒绝搬迁（先 verify/repair）`)
  if (chunks.tornTail) return fail(CODES.JSONL_CORRUPT, '未归属 chunks.jsonl 末尾有半行（撕裂尾巴），拒绝搬迁')

  const wsNorm = ws ? normWs(ws) : null
  const wsLooksLikeDir = ws ? /^--/.test(ws) : false
  const sessionSet = sessions ? new Set(sessions) : null
  const rows = []
  const indices = []
  const samples = []
  for (let i = 0; i < chunks.rows.length; i++) {
    const c = chunks.rows[i]
    let hit = false
    if (sessionSet) {
      if (sessionSet.has(String(c.session || ''))) hit = true
    } else if (wsNorm) {
      const cands = [c.ws, c.wsDir]
      for (const cand of cands) {
        if (cand == null) continue
        if (wsLooksLikeDir && normWs(cand) === wsNorm) { hit = true; break }
        const n = normWs(cand)
        if (n === wsNorm || n.startsWith(wsNorm + '\\')) { hit = true; break }
      }
    }
    if (!hit) continue
    rows.push(c)
    indices.push(i)
    if (samples.length < sampleLimit) {
      samples.push({
        index: i, id: shaShort(c.id), session: c.session ?? null, role: c.role ?? null,
        ws: c.ws ?? null, t: c.t ?? null, text: String(c.text ?? '').slice(0, 80),
      })
    }
  }

  // 源向量：按 chunk 行号取行；文件尺寸必须与块数严格对齐，否则不猜
  const srcManifest = meta.ok ? meta.manifest : null
  const dim = Number(srcManifest?.dim) || 0
  const srcVectorFile = await resolveVectorFile(meta.dir, meta.indexMeta)
  let sourceVectors = null
  let vectorError = null
  if (dim > 0) {
    const vr = await readVectorFile(srcVectorFile, { count: chunks.rows.length, dim })
    if (vr.ok) sourceVectors = vr.flat
    else vectorError = vr.error
  }
  const missingVectorIds = []
  if (dim > 0 && sourceVectors) {
    // 全量向量文件按行对齐；坏行（零/NaN）也算「缺」——不伪造
    const info = inspectVectors(sourceVectors, dim)
    const bad = new Set(info.badRows.map((b) => b.index))
    for (const i of indices) if (bad.has(i)) missingVectorIds.push(chunks.rows[i]?.id ?? null)
  } else if (dim > 0 && !sourceVectors) {
    for (const i of indices) missingVectorIds.push(chunks.rows[i]?.id ?? null)
  }

  return {
    ok: true,
    rows,
    indices,
    samples,
    source: {
      exists: meta.exists,
      chunks: chunks.rows.length,
      generation: srcManifest?.generation ?? null,
      dim,
      model: srcManifest?.model ?? '',
      provider: srcManifest?.provider ?? '',
      normalizerVersion: srcManifest?.normalizerVersion ?? NORMALIZER_VERSION,
      vectorFile: basename(srcVectorFile),
      vectorVersion: meta.indexMeta?.vectorVersion || 1,
      vectorError,
    },
    vectors: dim > 0 && sourceVectors
      ? { rows: indices.length - missingVectorIds.length, bytes: indices.length * dim * 4, missing: missingVectorIds.length, dim }
      : { rows: 0, bytes: 0, missing: missingVectorIds.length, dim },
    missingVectorIds,
    selection: {
      workspace: ws,
      sessionIds: sessions,
      matchedWorkspaces: [...new Set(rows.map((r) => r.ws).filter(Boolean))],
      matchedSessions: [...new Set(rows.map((r) => r.session).filter(Boolean))],
    },
  }
}

/** 目标 scope 现状（只读） */
async function targetState(dataRoot, to) {
  const meta = await readScopeMeta(dataRoot, to)
  const chunks = await readScopeChunks(dataRoot, to)
  const rows = chunks.rows || []
  const ids = new Set(rows.map((r) => r.id))
  return {
    exists: meta.exists,
    ok: meta.ok,
    dir: meta.dir,
    manifest: meta.ok ? meta.manifest : null,
    indexMeta: meta.indexMeta || null,
    rows,
    ids,
    error: meta.ok ? null : meta.error,
  }
}

/**
 * 预览（零写入）。
 */
export async function previewHardClaim({ dataRoot, from = PERSONA_UNASSIGNED, to, workspace = null, sessionIds = null, includeIds = false } = {}) {
  const root = resolve(dataRoot)
  const gate = await validateGate({ dataRoot: root, from, to })
  if (!gate.ok) return gate

  const sel = await selectChunks({ dataRoot: root, workspace, sessionIds })
  if (!sel.ok) return sel
  if (!sel.rows.length) {
    return fail('NO_MATCH', `没有命中任何未归属块（workspace=${JSON.stringify(workspace)} sessions=${JSON.stringify(sessionIds)}）：不搬家、不写任何文件`)
  }

  const tgt = await targetState(root, to)
  if (tgt.exists && !tgt.ok) {
    return fail(tgt.error?.code || CODES.MANIFEST_INVALID, `目标 scope 存在但不可用：${tgt.error?.message || ''}（先修好它，不覆盖）`)
  }
  let dup = 0
  for (const r of sel.rows) if (tgt.ids.has(r.id)) dup++

  // 维度兼容性预检（真写时会再查一遍）
  const warnings = []
  const srcDim = sel.source.dim
  const tgtDim = Number(tgt.manifest?.dim) || 0
  if (tgt.rows.length > 0) {
    if (srcDim !== tgtDim) {
      return fail(CODES.EMBEDDING_MISMATCH, `源维度 ${srcDim} 与目标维度 ${tgtDim} 不一致：向量不能混放（目标已有 ${tgt.rows.length} 块）。需先 reembed 到同一嵌入口径`)
    }
    for (const k of ['model', 'provider', 'normalizerVersion']) {
      const a = sel.source[k]
      const b = tgt.manifest?.[k]
      if ((a || '') !== (b || '')) {
        return fail(CODES.EMBEDDING_MISMATCH, `源/目标嵌入参数 ${k} 不一致（${a || '(空)'} vs ${b || '(空)'}）：拒绝把不同模型的向量写进同一文件`)
      }
    }
  }
  if (sel.missingVectorIds.length) {
    warnings.push(`${sel.missingVectorIds.length} 条选中块缺向量（零向量/缺失）：真写会拒绝，除非源本身 dim=0（纯文本库）`)
  }

  const matchedConflicts = checkMatchedWorkspaceOwners(gate.identity, sel.selection.matchedWorkspaces, to)
  if (matchedConflicts.length) {
    return fail('WORKSPACE_CONFLICT', `选中块里有工作区已属于别人：拒绝（前缀匹配会顺手牵羊，先显式改归属）`, { conflicts: matchedConflicts })
  }
  const view = workspaceView(gate.identity, workspace, sessionIds, to)
  if (view.identityPlan.conflicts.length) {
    return fail('WORKSPACE_CONFLICT', `工作区/会话已属于别人：拒绝硬认领（先显式改归属）`, { conflicts: view.identityPlan.conflicts })
  }
  warnings.push(...view.warnings)

  const backupEst = await estimateBackup(root, from, to)
  return {
    ok: true,
    dryRun: true,
    version: HARD_CLAIM_VERSION,
    from,
    to,
    selection: {
      workspace: sel.selection.workspace,
      sessionIds: sel.selection.sessionIds,
      matchedWorkspaces: sel.selection.matchedWorkspaces,
      matchedSessions: sel.selection.matchedSessions,
      samples: sel.samples,
    },
    chunks: sel.rows.length,
    ...(includeIds ? { chunkIds: sel.rows.map((r) => r.id) } : {}),
    vectors: sel.vectors,
    duplicates: { skip: dup, append: sel.rows.length - dup },
    target: {
      exists: tgt.exists,
      declaredInIdentity: gate.identity.personas?.[to] != null,
      generation: tgt.manifest?.generation ?? null,
      chunks: tgt.rows.length,
      dim: tgtDim,
      model: tgt.manifest?.model ?? '',
    },
    source: {
      exists: sel.source.exists,
      chunks: sel.source.chunks,
      generation: sel.source.generation,
      dim: srcDim,
    },
    size: {
      sourceVectorsBytes: srcDim > 0 ? expectedBytes(sel.source.chunks, srcDim) : 0,
      targetVectorsBytes: tgtDim > 0 ? expectedBytes(tgt.rows.length, tgtDim) : 0,
      backupEstBytes: backupEst,
    },
    identity: view.identityPlan,
    warnings,
  }
}

/** from/to/identity 硬闸门 */
async function validateGate({ dataRoot, from, to }) {
  if (from !== PERSONA_UNASSIGNED) {
    return fail('FROM_UNASSIGNED_ONLY', `from 只能是 ${PERSONA_UNASSIGNED}（不做人格→人格搬迁）：收到 ${JSON.stringify(from)}`)
  }
  if (!isSafePersonaId(to) || to === PERSONA_UNASSIGNED) {
    return fail(CODES.BAD_PERSONA_ID, `to 必须是合法人格 slug（不能是 persona_unassigned）：${JSON.stringify(to)}`)
  }
  const id = await loadIdentity(dataRoot)
  if (!id.ok) {
    return fail(id.reason === 'identity_missing' ? 'IDENTITY_MISSING' : 'IDENTITY_UNREADABLE',
      `identity.json 不可用（${id.reason}）：拒绝硬认领（先修身份层，不猜归属）`, id.error || null)
  }
  if (!id.identity.personas || !id.identity.personas[to]) {
    return fail('TARGET_NOT_DECLARED', `目标人格 ${to} 未在 identity.personas 里声明：先跑 jianmu_store_identity_add_persona 登记人格（本工具不静默造人格）`, {
      hint: `jianmu_store_identity_add_persona { personaId: "${to}", dryRun: false, confirm: true }`,
    })
  }
  return { ok: true, identity: id.identity, file: id.file }
}

/** 找 identity 里某个路径的最长前缀归属 */
function longestOwner(identity, path) {
  const target = normWs(path)
  let best = null
  for (const [key, pid] of Object.entries(identity.workspaces || {})) {
    const nk = normWs(key)
    if (!nk) continue
    if (target === nk || target.startsWith(nk + '\\')) {
      if (!best || nk.length > best.len) best = { pid, key, len: nk.length }
    }
  }
  return best
}

/**
 * 工作区/会话映射计划（只读）：
 *   · 尚未映射 → workspacesToAdd（apply 时由镜台登记）；
 *   · 已映射到 to → 无需动作；
 *   · 已映射到别人 → conflicts（拒绝，不静默抢）。
 */
function workspaceView(identity, workspace, sessionIds, to) {
  const warnings = []
  const plan = { workspacesToAdd: [], sessionsToAdd: [], conflicts: [] }
  if (workspace) {
    const owner = longestOwner(identity, workspace)
    if (!owner) plan.workspacesToAdd.push(workspace)
    else if (owner.pid === to) plan.workspaceAlreadyOwned = owner.key
    else plan.conflicts.push({ kind: 'workspace', key: owner.key, owner: owner.pid })
  }
  for (const sid of sessionIds || []) {
    const prev = identity.sessions?.[sid]
    if (!prev) plan.sessionsToAdd.push(sid)
    else if (prev === to) plan.sessionAlreadyOwned = true
    else plan.conflicts.push({ kind: 'session', key: sid, owner: prev })
  }
  if (plan.conflicts.length) {
    warnings.push(`${plan.conflicts.length} 个工作区/会话已属于别人：硬认领会拒绝（先显式改归属，不静默抢）`)
  }
  return { ok: true, identityPlan: plan, warnings }
}

/** 选中块实际落在哪些工作区；任何一个归别人 → 拒绝（防止前缀匹配顺手牵羊） */
function checkMatchedWorkspaceOwners(identity, matchedWorkspaces, to) {
  const conflicts = []
  for (const ws of matchedWorkspaces || []) {
    const owner = longestOwner(identity, ws)
    if (owner && owner.pid !== to) conflicts.push({ workspace: ws, owner: owner.pid, ownerKey: owner.key })
  }
  return conflicts
}

/** 备份估算（根藏侧：from/to scope + identity） */
async function estimateBackup(dataRoot, from, to) {
  let total = 0
  for (const pid of [from, to]) {
    for (const f of await listScopeFiles(scopeDir(dataRoot, pid))) total += Math.max(0, await fileSize(f))
  }
  total += Math.max(0, await fileSize(identityPath(dataRoot)))
  return total
}

/**
 * 全量备份：from/to scope + identity。返回 {ok, dir, files:[{rel,bytes,sha256}], scopeExisted}
 */
export async function backupHardClaimRoot({ dataRoot, from, to, stampTag = stamp() } = {}) {
  const root = resolve(dataRoot)
  const base = join(root, '_archive', `${HARD_CLAIM_ARCHIVE_PREFIX}-${stampTag}`)
  const filesDir = join(base, 'files')
  await ensureDir(filesDir)
  const files = []
  const scopeExisted = {}
  for (const pid of [from, to]) {
    const dir = scopeDir(root, pid)
    // 注意：apply 会先拿锁（ensureDir 会建空目录），所以「目录存在」不等于「scope 存在」。
    // 只有真的数据文件才算 existedBefore；否则回滚删不掉本次新建的目标文件。
    const scopeFiles = await listScopeFiles(dir)
    const existed = scopeFiles.length > 0
    scopeExisted[pid] = existed
    for (const src of scopeFiles) {
      const rel = join('scopes', pid, basename(src))
      const dest = join(filesDir, rel)
      await ensureDir(dirname(dest))
      await copyFile(src, dest)
      const st = await stat(dest)
      files.push({ rel: rel.replace(/\\/g, '/'), bytes: st.size, sha256: await hashFile(dest) })
    }
  }
  const idFile = identityPath(root)
  if (await pathExists(idFile)) {
    const importFs = await import('node:fs/promises')
    const dest = join(filesDir, 'identity.json')
    await importFs.copyFile(idFile, dest)
    const st = await stat(dest)
    files.push({ rel: 'identity.json', bytes: st.size, sha256: await hashFile(dest), existed: true })
  }
  const journal = {
    version: HARD_CLAIM_VERSION,
    kind: 'root-hard-claim-backup',
    createdAt: new Date().toISOString(),
    dataRoot: root,
    from,
    to,
    stamp: stampTag,
    backupDir: base,
    filesDir,
    scopeExisted,
    files,
  }
  await atomicWrite(join(base, 'root-journal.json'), JSON.stringify(journal, null, 2) + '\n')
  return { ok: true, dir: base, files, journal, scopeExisted, sizeBytes: files.reduce((a, f) => a + f.bytes, 0) }
}

/** 目标 generation 闸门 */
function checkGeneration(tgt, expectedGeneration, confirm) {
  if (!tgt.exists) return { ok: true }
  const cur = tgt.manifest?.generation
  if (expectedGeneration == null) {
    return fail('STALE_GENERATION', `真写必须带 expectedGeneration（当前目标 generation=${cur}）；先预览再带同一个数字重试`, { generation: cur })
  }
  if (Number(expectedGeneration) !== Number(cur)) {
    return fail('STALE_GENERATION', `目标 generation 已变化（调用方 ${expectedGeneration}，当前 ${cur}）：重新预览，不覆盖并发写`, { generation: cur })
  }
  return { ok: true }
}

/**
 * 真写根藏层。调用方必须在 confirm=true 且带 expectedGeneration（目标已存在时）。
 * @returns {Promise<object>}
 */
export async function applyHardClaim({
  dataRoot, from = PERSONA_UNASSIGNED, to, workspace = null, sessionIds = null,
  expectedGeneration = null, confirm = false, stampTag = stamp(), lockTimeoutMs = 10000,
} = {}) {
  if (confirm !== true) {
    return fail('CONFIRM_REQUIRED', '硬认领会重写源与目标的 chunks/vectors：必须 confirm=true（先跑 dryRun 预览）')
  }
  const root = resolve(dataRoot)
  const gate = await validateGate({ dataRoot: root, from, to })
  if (!gate.ok) return gate

  const locks = []
  let backup = null
  let phase = 'T0'
  const started = Date.now()
  try {
    // ── 双 scope 锁：按目录字典序，避免死锁；拿不到就整体失败（不排队、不写）
    const dirs = [scopeDir(root, from), scopeDir(root, to)]
      .slice()
      .sort((a, b) => normPath(a).localeCompare(normPath(b)))
    for (const dir of dirs) {
      const lock = await acquireLock(dir, { timeoutMs: lockTimeoutMs })
      if (!lock.ok) return fail(lock.code || 'LOCK_BUSY', `取锁失败（${dir}）：${lock.error?.message || ''}；本次未写任何文件`, lock.error || null)
      locks.push(lock)
    }

    // ── T1 读源（锁内重读；预览后源被别人改过 → 重新选，不沿用旧选择）
    phase = 'T1'
    const sel = await selectChunks({ dataRoot: root, workspace, sessionIds })
    if (!sel.ok) return sel
    if (!sel.rows.length) return fail('NO_MATCH', '锁内重读后没有命中任何未归属块：不写任何文件')

    const tgt0 = await targetState(root, to)
    if (tgt0.exists && !tgt0.ok) return fail(tgt0.error?.code || CODES.MANIFEST_INVALID, `目标 scope 不可用：${tgt0.error?.message || ''}`)
    const genCheck = checkGeneration(tgt0, expectedGeneration, confirm)
    if (!genCheck.ok) return genCheck

    const matchedConflicts = checkMatchedWorkspaceOwners(gate.identity, sel.selection.matchedWorkspaces, to)
    if (matchedConflicts.length) {
      return fail('WORKSPACE_CONFLICT', '选中块里有工作区已属于别人：拒绝（前缀匹配会顺手牵羊）', { conflicts: matchedConflicts })
    }
    const view = workspaceView(gate.identity, workspace, sessionIds, to)
    if (view.identityPlan.conflicts.length) {
      return fail('WORKSPACE_CONFLICT', '工作区/会话已属于别人：拒绝硬认领', { conflicts: view.identityPlan.conflicts })
    }

    const srcDim = sel.source.dim
    const tgtDim = Number(tgt0.manifest?.dim) || 0
    if (tgt0.rows.length > 0) {
      if (srcDim !== tgtDim) return fail(CODES.EMBEDDING_MISMATCH, `源维度 ${srcDim} ≠ 目标维度 ${tgtDim}：拒绝把不同口径的向量混放`)
      for (const k of ['model', 'provider', 'normalizerVersion']) {
        if ((sel.source[k] || '') !== (tgt0.manifest?.[k] || '')) {
          return fail(CODES.EMBEDDING_MISMATCH, `源/目标嵌入参数 ${k} 不一致：拒绝混放向量`)
        }
      }
    }
    // 目标有块但无向量（dim=0）而源有向量：会把目标旧块留成 missing，拒绝（不伪造零向量）
    if (tgt0.rows.length > 0 && tgtDim === 0 && srcDim > 0) {
      return fail(CODES.EMBEDDING_MISMATCH, `目标已有 ${tgt0.rows.length} 块但 dim=0，源 dim=${srcDim}：先对目标 reembed，再搬`)
    }
    if (srcDim > 0 && sel.missingVectorIds.length) {
      return fail(CODES.VECTOR_MISSING, `选中块里有 ${sel.missingVectorIds.length} 条缺向量（零向量/缺失）：拒绝搬迁（会静默错行）。先 reembed 源 scope`, {
        chunkIds: sel.missingVectorIds.slice(0, 20),
      })
    }

    // ── T0 快照（必须成功才继续）
    backup = await backupHardClaimRoot({ dataRoot: root, from, to, stampTag })
    if (!backup.ok) return fail('BACKUP_FAILED', '备份失败：拒绝继续写', backup.error || null)

    // 选中集合
    const selectedIds = new Set(sel.rows.map((r) => r.id))
    const movedRowsRaw = sel.rows
    const appendRows = []
    let dup = 0
    for (const r of movedRowsRaw) {
      if (tgt0.ids.has(r.id)) { dup++; continue }
      appendRows.push(r)
    }
    const nowIso = new Date().toISOString()

    // ── T2 写目标（追加语义）
    phase = 'T2'
    let targetAfterRows = tgt0.rows
    let targetTotal = tgt0.rows.length
    let targetGeneration = tgt0.manifest?.generation ?? null
    let targetWrite = null
    if (appendRows.length > 0) {
      const moved = appendRows.map((r) => ({
        ...r,
        personaId: to,
        identitySource: 'manual',
        provenance: { ...(r.provenance || {}), hardClaimFrom: from, hardClaimAt: nowIso },
      }))
      targetAfterRows = [...tgt0.rows, ...moved]
      targetTotal = targetAfterRows.length

      // 向量：目标原有行 + 搬入行（顺序必须与 chunks 一致）
      const dim = srcDim
      let targetVectors = null
      if (dim > 0) {
        let existingVec = null
        if (tgt0.rows.length > 0) {
          const vf = await resolveVectorFile(tgt0.dir, tgt0.indexMeta)
          const vr = await readVectorFile(vf, { count: tgt0.rows.length, dim })
          if (!vr.ok) return fail(vr.code || CODES.VECTOR_SIZE_MISMATCH, `目标向量文件不可用：${vr.error?.message || ''}，拒绝写（不覆盖可疑文件）`)
          existingVec = vr.flat
        }
        const idxOf = new Map()
        for (let k = 0; k < sel.indices.length; k++) idxOf.set(sel.rows[k].id, sel.indices[k])
        const srcVecFile = join(scopeDir(root, from), sel.source.vectorFile)
        const srcRead = await readVectorFile(srcVecFile, { count: sel.source.chunks, dim })
        if (!srcRead.ok) return fail(srcRead.code || CODES.VECTOR_MISSING, `源向量文件不可用：${srcRead.error?.message || ''}`)
        const appendIdx = appendRows.map((r) => idxOf.get(r.id))
        const movedVec = sliceRows(srcRead.flat, appendIdx, dim)
        targetVectors = existingVec ? new Float32Array(existingVec.length + movedVec.length) : new Float32Array(movedVec.length)
        if (existingVec) targetVectors.set(existingVec, 0)
        targetVectors.set(movedVec, existingVec ? existingVec.length : 0)
        if (targetVectors.length !== targetTotal * dim) {
          return fail(CODES.VECTOR_SIZE_MISMATCH, `目标向量行数不对齐：${targetVectors.length} ≠ ${targetTotal} × ${dim}`)
        }
      }

      const summary = summarizeChunks(targetAfterRows)
      const prevManifest = tgt0.manifest
      const embedding = dim > 0
        ? {
            provider: prevManifest?.provider || sel.source.provider || '',
            model: prevManifest?.model || sel.source.model || '',
            dim,
            normalizerVersion: prevManifest?.normalizerVersion || sel.source.normalizerVersion || NORMALIZER_VERSION,
            source: 'migrated',
          }
        : { provider: '', model: '', dim: 0, normalizerVersion: NORMALIZER_VERSION, source: 'migrated' }
      const nextManifest = buildManifest({
        personaId: to,
        displayName: prevManifest?.displayName ?? gate.identity.personas?.[to]?.displayName ?? null,
        identitySource: 'manual',
        embedding,
        counts: summary,
        retentionDays: prevManifest?.retentionDays || 30,
        generation: (Number(prevManifest?.generation) || 0) + 1,
      })
      const vectorVersion = tgt0.indexMeta?.vectorVersion || sel.source.vectorVersion || 1
      const nextIndexMeta = buildIndexMeta({
        vectorVersion,
        dim,
        count: targetTotal,
        provider: nextManifest.provider,
        model: nextManifest.model,
        normalizerVersion: nextManifest.normalizerVersion,
        tokenizerVersion: nextManifest.tokenizerVersion,
        missingVectors: [],
        badVectorRows: [],
      })

      // 写顺序：chunks（事实源）→ vectors → manifest/index_meta
      const chunksBody = targetAfterRows.map((r) => JSON.stringify(r)).join('\n') + '\n'
      await atomicWrite(chunksPath(root, to), chunksBody, { mode: 0o600 })
      if (dim > 0) await writeVectorFile(vectorPath(root, to, vectorVersion), targetVectors)
      await atomicWrite(manifestPath(root, to), JSON.stringify(nextManifest, null, 2) + '\n')
      await atomicWrite(indexPathMetaPath(root, to), JSON.stringify(nextIndexMeta, null, 2) + '\n')
      for (const f of [deletedPath(root, to)]) if (!(await pathExists(f))) await atomicWrite(f, '')

      const verify = await verifyScope(root, to)
      if (!verify.ok) {
        const restored = await rollbackHardClaimRoot({ dataRoot: root, backupDir: backup.dir, expectHashes: true })
        return fail('TARGET_VERIFY_FAILED', `目标写后 verify 未通过，已用快照回滚：${verify.problems.map((p) => p.code).join(',')}`, { verify, rollback: restored })
      }
      targetGeneration = nextManifest.generation
      targetWrite = { appended: appendRows.length, generation: nextManifest.generation, verify }
    }

    // ── T3 重写源（删除已搬块；按保留索引重建向量）
    phase = 'T3'
    const remaining = []
    const remainingIdx = []
    // 重新读源 chunks（锁内、T1 之后没有别的写者，但保持单一真源）
    const srcChunksNow = await readScopeChunks(root, from)
    if (!srcChunksNow.exists) return fail('SCOPE_MISSING', '源 scope 的 chunks 在搬迁途中消失：已回滚目标备份')
    for (let i = 0; i < srcChunksNow.rows.length; i++) {
      const c = srcChunksNow.rows[i]
      if (selectedIds.has(c.id)) continue
      remaining.push(c)
      remainingIdx.push(i)
    }
    const srcMeta = await readScopeMeta(root, from)
    if (!srcMeta.ok) return fail(srcMeta.error?.code || CODES.MANIFEST_INVALID, `源 manifest 不可用：${srcMeta.error?.message || ''}`)
    const nextSrcGen = (Number(srcMeta.manifest.generation) || 0) + 1
    const srcSummary = summarizeChunks(remaining)
    const nextSrcManifest = buildManifest({
      personaId: from,
      displayName: srcMeta.manifest.displayName ?? null,
      identitySource: srcMeta.manifest.identitySource || 'unassigned',
      embedding: {
        provider: srcMeta.manifest.provider || '',
        model: srcMeta.manifest.model || '',
        dim: srcDim,
        normalizerVersion: srcMeta.manifest.normalizerVersion || NORMALIZER_VERSION,
        source: 'migrated',
      },
      counts: srcSummary,
      retentionDays: srcMeta.manifest.retentionDays || 30,
      generation: nextSrcGen,
    })
    const prevMissing = new Set(Array.isArray(srcMeta.indexMeta?.missingVectors) ? srcMeta.indexMeta.missingVectors : [])
    const keptMissing = remaining.map((r) => r.id).filter((id) => prevMissing.has(id))
    const nextSrcIndex = buildIndexMeta({
      vectorVersion: srcMeta.indexMeta?.vectorVersion || sel.source.vectorVersion || 1,
      dim: srcDim,
      count: remaining.length,
      provider: nextSrcManifest.provider,
      model: nextSrcManifest.model,
      normalizerVersion: nextSrcManifest.normalizerVersion,
      tokenizerVersion: nextSrcManifest.tokenizerVersion,
      missingVectors: keptMissing,
      badVectorRows: [],
    })

    const srcBody = remaining.map((r) => JSON.stringify(r)).join('\n') + (remaining.length ? '\n' : '')
    await atomicWrite(chunksPath(root, from), srcBody, { mode: 0o600 })
    if (srcDim > 0) {
      const vf = await resolveVectorFile(srcMeta.dir, srcMeta.indexMeta)
      const vr = await readVectorFile(vf, { count: srcChunksNow.rows.length, dim: srcDim })
      if (!vr.ok) return fail(vr.code || CODES.VECTOR_MISSING, `源向量文件不可用：${vr.error?.message || ''}`)
      const keptVec = sliceRows(vr.flat, remainingIdx, srcDim)
      await writeVectorFile(vf, keptVec)
    }
    await atomicWrite(manifestPath(root, from), JSON.stringify(nextSrcManifest, null, 2) + '\n')
    await atomicWrite(indexPathMetaPath(root, from), JSON.stringify(nextSrcIndex, null, 2) + '\n')
    // 墓碑：块已离开源（读边界不再复活；目标侧才是它的家）
    await appendTombstone(root, from, { ids: [...selectedIds], reason: `hard-claim-to:${to}` })

    const verifySrc = await verifyScope(root, from)
    if (!verifySrc.ok) {
      const restored = await rollbackHardClaimRoot({ dataRoot: root, backupDir: backup.dir, expectHashes: true })
      return fail('SOURCE_VERIFY_FAILED', `源写后 verify 未通过，已用快照回滚：${verifySrc.problems.map((p) => p.code).join(',')}`, { verify: verifySrc, rollback: restored })
    }

    // ── 终验：总块数守恒（源前后 + 目标前后；目标重复项扣除）
    const beforeTotal = sel.source.chunks + tgt0.rows.length
    const afterTotal = remaining.length + targetTotal
    if (beforeTotal - dup !== afterTotal) {
      const restored = await rollbackHardClaimRoot({ dataRoot: root, backupDir: backup.dir, expectHashes: true })
      return fail('COUNT_MISMATCH', `总块数不守恒：搬前 ${beforeTotal}，搬后 ${afterTotal}，目标重复 ${dup}，已回滚`, { beforeTotal, afterTotal, dup, rollback: restored })
    }

    const srcVerify = await verifyScope(root, from)
    const tgtVerify = await verifyScope(root, to)
    return {
      ok: true,
      version: HARD_CLAIM_VERSION,
      from,
      to,
      workspace: workspace ?? null,
      sessionIds: sessionIds ?? null,
      moved: appendRows.length,
      duplicatesSkipped: dup,
      movedIds: [...selectedIds],
      source: { chunks: remaining.length, generation: nextSrcGen, verify: srcVerify },
      target: { chunks: targetTotal, generation: targetGeneration, verify: tgtVerify, written: Boolean(targetWrite) },
      totals: { before: beforeTotal, after: afterTotal, dup },
      backupDir: backup.dir,
      backupFiles: backup.files.length,
      backupBytes: backup.sizeBytes,
      targetExistedBefore: Boolean(backup.scopeExisted?.[to]),
      sourceExistedBefore: Boolean(backup.scopeExisted?.[from]),
      elapsedMs: Date.now() - started,
    }
  } catch (e) {
    // 兜底：走到这里说明有未预期异常；有快照就整文件恢复（没快照说明还没写）
    let rollback = null
    if (backup) {
      try { rollback = await rollbackHardClaimRoot({ dataRoot: root, backupDir: backup.dir, expectHashes: true }) } catch { /* 失败在下面报 */ }
    }
    return {
      ok: false,
      code: e?.code || 'HARD_CLAIM_FAILED',
      error: toErrInfo(e),
      phase,
      rollback,
      backupDir: backup?.dir ?? null,
      hint: backup ? '已尝试用快照整文件回滚；看 rollback.ok / verify' : '失败发生在备份之前：没有写任何文件',
    }
  } finally {
    for (const l of locks.reverse()) { try { await l.release?.() } catch { /* 忽略 */ } }
  }
}

/**
 * 用根藏快照整文件恢复（源/目标 scope + identity）。行级补丁在 JSONL 上容易错位，故整文件。
 */
export async function rollbackHardClaimRoot({ dataRoot, backupDir, expectHashes = true } = {}) {
  const root = resolve(dataRoot)
  const jr = await readJson(join(backupDir, 'root-journal.json'))
  if (!jr.ok) return fail('BACKUP_NOT_FOUND', `读不到根藏备份 journal：${join(backupDir, 'root-journal.json')}`)
  const j = jr.value
  const filesDir = j.filesDir || join(backupDir, 'files')
  const restored = []
  const problems = []
  for (const f of j.files || []) {
    const src = join(filesDir, f.rel)
    const dest = join(root, f.rel)
    try {
      const buf = await readFile(src)
      await atomicWrite(dest, buf)
      const h = await hashFile(dest)
      if (expectHashes && h !== f.sha256) problems.push({ rel: f.rel, expected: f.sha256, got: h })
      else restored.push(f.rel)
    } catch (e) {
      problems.push({ rel: f.rel, error: toErrInfo(e) })
    }
  }
  // 目标 scope 之前不存在 → 删掉本次硬认领新建出来的文件（只删已知名字的常规文件）
  const created = []
  for (const pid of [j.from, j.to]) {
    if (j.scopeExisted?.[pid]) continue
    const dir = scopeDir(root, pid)
    let ents = []
    try { ents = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (!e.isFile()) continue
      if (!(SCOPE_BACKUP_NAMES.includes(e.name) || /^vectors_v\d+\.f32$/.test(e.name))) continue
      try { await rm(join(dir, e.name), { force: true }); created.push(`${pid}/${e.name}`) } catch { /* 忽略 */ }
    }
  }
  const verify = {}
  for (const pid of [j.from, j.to]) {
    try { verify[pid] = await verifyScope(root, pid) } catch (e) { verify[pid] = { ok: false, error: toErrInfo(e) } }
  }
  return {
    ok: problems.length === 0,
    backupDir,
    restored,
    createdRemoved: created,
    problems,
    verify,
  }
}

/** 备份目录体积（供预览/报告用） */
export async function backupDirSize(dir) {
  let total = 0
  const walk = async (d) => {
    let ents = []
    try { ents = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else { try { total += (await stat(p)).size } catch { /* 忽略 */ } }
    }
  }
  await walk(dir)
  return total
}
