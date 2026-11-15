/**
 * lib/store.mjs —— 根藏存储层（scope 读写、status、export、verify）
 *
 * 三条硬纪律：
 *   1. 写入顺序固定：chunks.jsonl（事实源）→ vectors_v<N>.f32 → manifest/index_meta（D6）。
 *   2. 存储层初始化失败 → 降级，**构造永不抛**；降级原因进 status（D9/D10）。
 *   3. 任何写 API 只有「写后读回：found」才算 ok；missing / unknown 不算成功（F9）。
 *
 * 人格隔离：所有 API 都要求显式 personaId；没有「跨 scope 读取/合并」入口（F17）。
 */
import { readdir, statfs, rm, readFile, open, truncate, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import {
  defaultDataRoot, scopeDir, scopesRoot, chunksPath, manifestPath, indexPathMetaPath,
  vectorPath, vectorFileName, deletedPath, costPath, PERSONA_UNASSIGNED, isSafePersonaId, normPath, sessionsRoot, isInsideSessions,
} from './paths.mjs'
import {
  ensureDir, readJson, readJsonl, atomicWrite, appendJsonl, fileSize, pathExists, hashFile, listOrphanTmp,
} from './fsatomic.mjs'
import { acquireLock, peekLock } from './lock.mjs'
import { loadIdentity, resolvePersona } from './identity.mjs'
import { validateChunk, summarizeChunks } from './chunks.mjs'
import { readVectorFile, writeVectorFile, inspectVectors, expectedBytes, VECTOR_UNIT_BYTES, vectorsToBuffer, normalizeRowInPlace } from './vectors.mjs'
import { buildManifest, validateManifest, buildIndexMeta, assertManifestUsable, manifestEmbeddingState } from './manifest.mjs'
import { CODES, toErrInfo, fail } from './errors.mjs'
import { INGEST_VERSION, NORMALIZER_VERSION, WRITER } from './version.mjs'
import { archiveBeforeWrite, commitFingerprint } from './backup.mjs'
import { assertWriteAllowed } from './guards.mjs'

const SCOPE_FILES = ['manifest.json', 'chunks.jsonl', 'index_meta.json', 'vectors_v1.f32', 'deleted.jsonl', 'cost.jsonl']

/** 写一个探测文件验证目录可写；失败不抛 */
async function probeWritable(root) {
  const probe = join(root, `.write-probe-${process.pid}-${Date.now().toString(36)}`)
  try {
    await atomicWrite(probe, 'ok')
    await rm(probe, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: toErrInfo(e) }
  }
}

/**
 * personaId 合法性：未归属 scope 或稳定 slug。**所有 store API 先过这道**
 * （否则 `../..` 之类的 id 会让 join 逃出 dataRoot —— 路径穿越）。
 */
function validScopeId(personaId) {
  return personaId === PERSONA_UNASSIGNED || isSafePersonaId(personaId)
}

function badScopeId(personaId) {
  return fail(CODES.BAD_PERSONA_ID, `personaId 非法：${JSON.stringify(personaId)}（只允许 [a-z0-9_-]，≤64，或 persona_unassigned）`)
}

/**
 * 覆盖写失败时尽力回滚到刚才的备份（多文件「最佳努力」事务）。
 * F2 只承诺单文件原子；这里是补一条「别把旧库弄成半新半旧」。
 */
async function restoreArchivedFiles(backup, dir) {
  const restored = []
  for (const f of backup?.files || []) {
    try {
      const buf = await readFile(join(backup.dir, f.name))
      await atomicWrite(join(dir, f.name), buf)
      restored.push(f.name)
    } catch { /* 尽力而为；失败在结果里报 */ }
  }
  return restored
}

/**
 * 首次写入失败时，把本次新建出来的文件删掉（恢复成「什么都没发生」）。
 * 只删 preexisting 之外、且确实是常规文件的；目录/别人放的东西不碰。
 */
async function cleanupFreshScope(dir, preexisting) {
  const removed = []
  for (const name of SCOPE_FILES) {
    if (preexisting.has(name)) continue
    const p = join(dir, name)
    try {
      const st = await stat(p)
      if (!st.isFile()) continue
      await rm(p, { force: true })
      removed.push(name)
    } catch { /* 不存在/删不掉 */ }
  }
  return removed
}

/**
 * 打开存储层。**永不抛**（D9）。
 * @returns {Promise<{ok:true, dataRoot:string, identity:object|null, identityState:object, degraded:boolean, reasons:string[], errors:object[]}|{ok:false, degraded:true, reason:string, error:object, dataRoot:string}>}
 */
export async function openStore(opts = {}) {
  const root = resolve(opts.dataRoot || defaultDataRoot())
  // 绝对红线：数据根落在只读源 sessions/ 下 → 直接拒绝，连探针都不写（F17 / 契约 §5）
  if (isInsideSessions(root)) {
    return {
      ok: false, degraded: true, reason: 'data_root_is_read_only_source',
      error: { code: CODES.READ_ONLY_SOURCE, message: `dataRoot 落在只读源 sessions/ 下，拒绝使用：${root}` },
      dataRoot: root,
    }
  }
  try {
    await ensureDir(root)
  } catch (e) {
    return { ok: false, degraded: true, reason: 'data_root_not_creatable', error: toErrInfo(e), dataRoot: root }
  }
  const reasons = []
  const errors = []
  const identityState = await loadIdentity(root)
  if (!identityState.ok) {
    reasons.push(identityState.reason)
    if (identityState.error) errors.push(identityState.error)
  }
  const probe = await probeWritable(root)
  if (!probe.ok) {
    reasons.push('data_root_not_writable')
    errors.push(probe.error)
  }
  return {
    ok: true,
    dataRoot: root,
    identity: identityState.ok ? identityState.identity : null,
    identityState,
    degraded: reasons.length > 0,
    reasons,
    errors,
  }
}

/** 用 identity + 来源信息解析某块该进哪个 persona */
export function resolveForStore(store, ctx = {}) {
  return resolvePersona(store?.identity || null, ctx)
}

/** 读 scope 的 manifest + index_meta（不读 chunks 正文） */
export async function readScopeMeta(dataRoot, personaId) {
  if (!isSafePersonaId(personaId) && personaId !== PERSONA_UNASSIGNED) {
    return fail(CODES.BAD_PERSONA_ID, `personaId 非法：${personaId}`)
  }
  const dir = scopeDir(dataRoot, personaId)
  const m = await readJson(manifestPath(dataRoot, personaId))
  if (!m.ok) {
    // ENOENT = 真不存在；其它（EACCES/EIO/ENOTDIR）= 读失败，绝不能当成「空库」
    const readFailure = m.code !== 'ENOENT'
    return { ok: false, exists: readFailure, readFailure, code: m.code, error: m.error, dir }
  }
  const usable = assertManifestUsable(m.value, { expectPersonaId: personaId })
  const im = await readJson(indexPathMetaPath(dataRoot, personaId))
  return {
    ok: usable.ok,
    exists: true,
    personaId,
    dir,
    manifest: m.value,
    manifestEncoding: m.encoding,
    indexMeta: im.ok ? im.value : null,
    indexMetaError: im.ok ? null : im.error,
    error: usable.ok ? null : usable.error,
  }
}

/** 读 scope 的全部 chunk 行（只读，不解释业务） */
export async function readScopeChunks(dataRoot, personaId) {
  if (!validScopeId(personaId)) {
    return { exists: false, rows: [], lines: 0, bytes: 0, corrupt: [], tornTail: false, error: badScopeId(personaId).error }
  }
  return readJsonl(chunksPath(dataRoot, personaId))
}

/** scope 全量读取（可选连向量） */
export async function readScope(dataRoot, personaId, opts = {}) {
  const meta = await readScopeMeta(dataRoot, personaId)
  if (!meta.exists) return { ok: false, exists: false, code: meta.code, error: meta.error, dir: meta.dir }
  const chunks = await readScopeChunks(dataRoot, personaId)
  let vectors = null
  let vectorInfo = null
  if (opts.withVectors && meta.manifest?.dim) {
    const file = join(meta.dir, meta.indexMeta?.vectorFile || vectorFileName(meta.indexMeta?.vectorVersion || 1))
    const vr = await readVectorFile(file, { count: chunks.rows.length, dim: meta.manifest.dim })
    if (vr.ok) {
      vectors = vr.flat
      vectorInfo = inspectVectors(vr.flat, vr.dim)
    } else {
      vectorInfo = { error: vr.error }
    }
  }
  return {
    ok: meta.ok,
    exists: true,
    personaId,
    dir: meta.dir,
    manifest: meta.manifest,
    indexMeta: meta.indexMeta,
    chunks: chunks.rows,
    chunksFile: { exists: chunks.exists, bytes: chunks.bytes, corrupt: chunks.corrupt, tornTail: chunks.tornTail, encoding: chunks.encoding },
    vectors,
    vectorInfo,
    error: meta.error,
  }
}

/**
 * 写一个完整的 scope 快照（迁移/导入用）。
 * 顺序：chunks（事实源）→ 向量 → manifest → index_meta → 侧表 → 读回校验。
 */
export async function writeScopeBundle(p) {
  const {
    dataRoot, personaId, displayName = null, identitySource = 'manual',
    utterances = [], vectors = null, embedding = {},
    retentionDays = 30, overwrite = false, reason = 'write',
    lockTimeoutMs = 15000, durable = true, normalizeVectors = true,
    allowEmbeddingChange = false,
  } = p || {}

  if (personaId !== PERSONA_UNASSIGNED && !isSafePersonaId(personaId)) {
    return fail(CODES.BAD_PERSONA_ID, `personaId 非法：${JSON.stringify(personaId)}`)
  }

  const dir = scopeDir(dataRoot, personaId)
  const out = {
    ok: false, personaId, dir, chunks: 0, duplicates: 0, warnings: [], badVectorRows: [], readback: null,
  }

  // 硬闸门：只许写 dataRoot 之内，绝不写 sessions/（运行时拦截，不只是源码扫描）
  try { assertWriteAllowed(dataRoot, dir) } catch (e) { return { ...out, ...fail(e.code || CODES.PATH_OUTSIDE_ROOT, e.message) } }

  try {
    await ensureDir(dir)
    await ensureDir(join(dir, '_archive'))
  } catch (e) {
    return { ...out, ...fail(CODES.INIT_FAILED, `scope 目录建立失败：${e.message}`, { dir }) }
  }

  const lock = await acquireLock(dir, { timeoutMs: lockTimeoutMs })
  if (!lock.ok) return { ...out, ...fail(lock.code, lock.error.message, lock.error) }

  let backup = null
  let preexisting = new Set()
  try {
    // 本次写入前已经存在的文件（首次写失败时要恢复成「什么都没发生」）
    preexisting = new Set()
    for (const name of SCOPE_FILES) if (await pathExists(join(dir, name))) preexisting.add(name)
    const prevManifestRead = await readJson(manifestPath(dataRoot, personaId))
    const prevManifest = prevManifestRead.ok ? prevManifestRead.value : null
    let generation = 1

    // ── 已有数据：默认拒绝覆盖；显式 overwrite 才先备份再写（F3）
    const chunksFile = join(dir, 'chunks.jsonl')
    if (await pathExists(chunksFile)) {
      if (!overwrite) {
        return { ...out, ...fail('SCOPE_EXISTS', `scope 已有数据，拒绝覆盖（${chunksFile}）；显式 overwrite=true 才允许`) }
      }
      // D1：换 provider/model/dim/normalizerVersion 必须显式允许（等于 reembed 语义）
      if (prevManifest && (embedding.provider || embedding.model || embedding.dim)) {
        const want = {
          provider: embedding.provider || '',
          model: embedding.model || '',
          dim: Number(embedding.dim) || 0,
          normalizerVersion: embedding.normalizerVersion || NORMALIZER_VERSION,
        }
        const st = manifestEmbeddingState(prevManifest, want)
        if (!st.ok && !allowEmbeddingChange) {
          return {
            ...out,
            ...fail(CODES.EMBEDDING_MISMATCH, `覆盖写的嵌入参数与现有 manifest 不一致（${st.diffs?.join(',') || st.reason}）；换模型/维度必须显式 allowEmbeddingChange 并重嵌`, st),
          }
        }
      }
      generation = Math.max(1, Number(prevManifest?.generation) || 0) + 1
      backup = await archiveBeforeWrite(dataRoot, personaId, SCOPE_FILES.map((f) => join(dir, f)), reason)
    }

    // ── 校验 + 去重（同 id = 同内容）
    const seen = new Set()
    const rows = []
    const invalid = []
    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i]
      const errs = validateChunk(u)
      if (errs.length) { invalid.push({ index: i, id: u?.id ?? null, errors: errs }); continue }
      if (seen.has(u.id)) { out.duplicates++; continue }
      seen.add(u.id)
      rows.push(u)
    }
    if (invalid.length) {
      return { ...out, ...fail('CHUNK_INVALID', `${invalid.length} 行不合格，未写入任何文件`, { invalid: invalid.slice(0, 20) }) }
    }

    const summary = summarizeChunks(rows)
    const dim = Number(embedding.dim) || (vectors && vectors.length && rows.length ? vectors.length / rows.length : 0)
    let vectorInspection = null
    let vec = vectors

    if (vec && dim) {
      if (vec.length !== rows.length * dim) {
        return { ...out, ...fail(CODES.VECTOR_SIZE_MISMATCH, `向量长度不符：${vec.length} ≠ ${rows.length} × ${dim}`) }
      }
      // D2：写入路径 L2 归一化（幂等）。迁移必须逐字节保真 → 调用方传 normalizeVectors=false
      if (normalizeVectors) {
        vec = Float32Array.from(vec)
        for (let i = 0; i < rows.length; i++) normalizeRowInPlace(vec.subarray(i * dim, (i + 1) * dim))
        out.normalizedVectors = true
      }
      vectorInspection = inspectVectors(vec, dim)
      const badWithId = vectorInspection.badRows.map((b) => ({ index: b.index, reason: b.reason, id: rows[b.index]?.id ?? null }))
      vectorInspection = { ...vectorInspection, badRows: badWithId }
      out.badVectorRows = badWithId
      if (badWithId.length) {
        out.warnings.push(`向量坏行 ${badWithId.length}（已保留行对齐，需 reembed；不重嵌）`)
      }
    }

    // ── ① 事实源：chunks.jsonl（先）
    const chunksBody = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
    const wChunks = await atomicWrite(chunksFile, chunksBody, { mode: 0o600 })

    // ── ② 派生：vectors_v1.f32
    let vectorBytes = null
    if (vec && dim) {
      vectorBytes = expectedBytes(rows.length, dim)
      await writeVectorFile(join(dir, vectorFileName(1)), vec)
    }

    // ── ③ 元数据：manifest + index_meta（后）
    const manifest = buildManifest({
      personaId,
      displayName,
      identitySource,
      embedding: { provider: embedding.provider || '', model: embedding.model || '', dim, normalizerVersion: embedding.normalizerVersion || NORMALIZER_VERSION, tokenizerVersion: embedding.tokenizerVersion, source: embedding.source || 'migrated' },
      counts: summary,
      retentionDays,
      generation,
    })
    await atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    const indexMeta = buildIndexMeta({
      vectorVersion: 1,
      dim,
      count: rows.length,
      provider: manifest.provider,
      model: manifest.model,
      normalizerVersion: manifest.normalizerVersion,
      tokenizerVersion: manifest.tokenizerVersion,
      badVectorRows: vectorInspection ? vectorInspection.badRows : [],
      missingVectors: vec && dim ? [] : rows.map((r) => r.id),
    })
    await atomicWrite(join(dir, 'index_meta.json'), JSON.stringify(indexMeta, null, 2) + '\n')

    // ── 侧表（空文件即可；append-only，后写不覆盖）
    for (const f of [deletedPath(dataRoot, personaId), costPath(dataRoot, personaId)]) {
      if (!(await pathExists(f))) {
        try { await appendJsonl(f, []) } catch { /* 空表失败不致命 */ }
        if (!(await pathExists(f))) await atomicWrite(f, '')
      }
    }

    // ── ④ 写后读回：found / missing / unknown（F9）
    const readback = await verifyWrittenScope(dataRoot, personaId, {
      chunks: rows.length, lastId: rows[rows.length - 1]?.id || null, vectorBytes, dim,
    })
    out.readback = readback
    if (readback.state !== 'found') {
      // 读回未通过 = 这次写入不可信；覆盖场景回滚备份，首次写入清理新建文件（F1）
      let restored = null
      let removed = null
      if (backup) {
        try { restored = await restoreArchivedFiles(backup, dir) } catch { restored = null }
      } else {
        try { removed = await cleanupFreshScope(dir, preexisting) } catch { removed = null }
      }
      return {
        ...out,
        ok: false,
        error: {
          code: readback.state === 'missing' ? CODES.READBACK_MISMATCH : CODES.READ_FAILED,
          message: `写后读回未通过（${readback.state}）：${readback.reason || ''}`,
          state: readback.state,
        },
        rolledBack: backup ? Array.isArray(restored) : Array.isArray(removed),
        ...(backup ? { restoredFiles: restored } : { removedFiles: removed }),
        hint: '跑 jianmu_store_rebuild 重建索引；先看 status 再决定是否重试',
      }
    }

    if (backup) await commitFingerprint(backup, { personaId, chunks: rows.length })
    out.chunks = rows.length
    return {
      ...out,
      ok: true,
      counts: summary,
      bytes: wChunks.bytes,
      vectorInfo: vectorInspection,
      manifestPath: join(dir, 'manifest.json'),
    }
  } catch (e) {
    // 覆盖写失败：把刚备份的旧文件放回去；首次写失败：删掉本次新建的文件（不留半截）
    let restored = null
    let removed = null
    if (backup) {
      try { restored = await restoreArchivedFiles(backup, dir) } catch { restored = null }
    } else {
      try { removed = await cleanupFreshScope(dir, preexisting) } catch { removed = null }
    }
    return {
      ...out,
      ...fail(CODES.WRITE_ATOMIC_FAILED, `写 scope 失败：${e.message}`, toErrInfo(e)),
      rolledBack: backup ? Array.isArray(restored) : Array.isArray(removed),
      ...(backup ? { restoredFiles: restored } : { removedFiles: removed }),
      hint: backup
        ? '已尽力回滚到备份；先跑 status/verify 确认，再决定是否重试'
        : '首次写入失败：已清理本次新建文件（若清理失败见 removedFiles=null），重试前先看 status',
    }
  } finally {
    await lock.release()
  }
}

/**
 * 写后读回三态（F9）。unknown ≠ missing。
 * @returns {{state:'found'|'missing'|'unknown', reason?:string, bytes?:number}}
 */
export async function verifyWrittenScope(dataRoot, personaId, expect = {}) {
  let r
  try {
    r = await readJsonl(chunksPath(dataRoot, personaId))
  } catch (e) {
    return { state: 'unknown', reason: `读回异常：${e.message}` }
  }
  // unknown ≠ missing：读失败（EACCES/EIO/ENOTDIR）不能当成「没有数据」（F9）
  if (r.error) return { state: 'unknown', reason: `读失败(${r.error.code || 'ERR'})：${r.error.message}` }
  if (!r.exists) return { state: 'missing', reason: 'chunks.jsonl 不在' }
  if (r.corrupt?.length) return { state: 'missing', reason: `${r.corrupt.length} 行损坏` }
  if (r.tornTail) return { state: 'missing', reason: '末尾半行（撕裂尾巴）' }
  if (expect.chunks != null && r.rows.length !== expect.chunks) {
    return { state: 'missing', reason: `块数不符：读到 ${r.rows.length}，应写 ${expect.chunks}` }
  }
  if (expect.lastId && r.rows[r.rows.length - 1]?.id !== expect.lastId) {
    return { state: 'missing', reason: '最后一行 id 不符' }
  }
  const m = await readJson(manifestPath(dataRoot, personaId))
  if (!m.ok) return { state: 'unknown', reason: `manifest 读不到：${m.error?.message || m.code}` }
  const merrs = validateManifest(m.value, { expectPersonaId: personaId })
  if (merrs.length) return { state: 'missing', reason: `manifest 自检失败：${merrs.join('；')}` }
  if (expect.vectorBytes != null) {
    const size = await fileSize(vectorPath(dataRoot, personaId, 1))
    if (size !== expect.vectorBytes) {
      return { state: 'missing', reason: `向量字节不符：${size} ≠ ${expect.vectorBytes}` }
    }
  }
  return { state: 'found', bytes: r.bytes }
}

/**
 * scope 状态（status 的核心）。
 * @returns {Promise<object>}
 */
export async function statusOfScope(dataRoot, personaId, opts = {}) {
  if (!validScopeId(personaId)) {
    return {
      personaId, dir: null, exists: false, chunks: 0, degraded: true,
      warnings: [], errors: [badScopeId(personaId).error], lock: { held: false },
      vectors: { file: null, bytes: -1, rows: 0, expectedRows: 0, missing: 0, badRows: 0, dim: 0 },
      files: { chunksBytes: -1, manifestBytes: -1 },
    }
  }
  const dir = scopeDir(dataRoot, personaId)
  const meta = await readScopeMeta(dataRoot, personaId)
  const chunks = await readJsonl(chunksPath(dataRoot, personaId))
  const lockInfo = await peekLock(dir)
  const warnings = []
  const errors = []

  const result = {
    personaId,
    dir,
    exists: meta.exists,
    contractVersion: meta.manifest?.contractVersion ?? null,
    schemaVersion: meta.manifest?.schemaVersion ?? null,
    generation: meta.manifest?.generation ?? null,
    builtAt: meta.manifest?.builtAt ?? null,
    chunks: chunks.rows.length,
    sessions: 0,
    workspaces: 0,
    tMin: null,
    tMax: null,
    identitySource: meta.manifest?.identitySource ?? null,
    displayName: meta.manifest?.displayName ?? null,
    embedding: meta.manifest ? {
      provider: meta.manifest.provider, model: meta.manifest.model, dim: meta.manifest.dim,
      normalizerVersion: meta.manifest.normalizerVersion,
    } : null,
    vectors: { file: null, bytes: -1, rows: 0, expectedRows: chunks.rows.length, missing: 0, badRows: 0, dim: meta.manifest?.dim || 0 },
    files: { chunksBytes: chunks.bytes, manifestBytes: await fileSize(manifestPath(dataRoot, personaId)) },
    lock: lockInfo.exists ? { held: true, ageMs: lockInfo.ageMs, alive: lockInfo.alive, pid: lockInfo.info?.pid } : { held: false },
    degraded: false,
    warnings,
    errors,
  }

  if (chunks.error) {
    // 读失败（EACCES/EIO/ENOTDIR…）≠ 文件不存在：必须报错，且不能把 0 块当成真值（F8/F9）
    errors.push({
      code: chunks.error.code || CODES.READ_FAILED,
      message: `chunks.jsonl 读取失败（≠空库）：${chunks.error.message}`,
    })
  }
  if (chunks.corrupt?.length) errors.push({ code: CODES.JSONL_CORRUPT, message: `${chunks.corrupt.length} 行 JSON 损坏`, lines: chunks.corrupt.slice(0, 5) })
  if (chunks.tornTail) warnings.push('chunks.jsonl 末尾有半行（可能正在写 / 断电丢尾）')
  if (!meta.exists) {
    errors.push({ code: 'SCOPE_MISSING', message: `scope 不存在或 manifest 缺失：${manifestPath(dataRoot, personaId)}` })
  } else if (!meta.ok && meta.error) {
    errors.push(meta.error)
  }

  const summary = summarizeChunks(chunks.rows)
  result.sessions = summary.sessions
  result.workspaces = summary.workspaces
  result.tMin = summary.tMin
  result.tMax = summary.tMax

  if (meta.manifest) {
    const vf = join(dir, meta.indexMeta?.vectorFile || vectorFileName(meta.indexMeta?.vectorVersion || 1))
    const bytes = await fileSize(vf)
    result.vectors.file = vf
    result.vectors.bytes = bytes
    if (meta.manifest.dim > 0) {
      const rows = bytes > 0 ? Math.floor(bytes / (meta.manifest.dim * VECTOR_UNIT_BYTES)) : 0
      result.vectors.rows = rows
      if (bytes !== expectedBytes(chunks.rows.length, meta.manifest.dim)) {
        result.vectors.missing = Math.max(0, chunks.rows.length - rows)
        warnings.push(`向量文件与块数不符：${bytes} 字节 / ${rows} 行，块数 ${chunks.rows.length}（需 rebuild 或 reembed）`)
      }
    } else if (chunks.rows.length > 0) {
      // dim=0：块已存下但没有任何向量 —— 只能字面使用，必须可见（D6/D10）
      result.vectors.missing = Array.isArray(meta.indexMeta?.missingVectors)
        ? meta.indexMeta.missingVectors.length
        : chunks.rows.length
      if (result.vectors.missing) warnings.push(`无向量（dim=0）：${result.vectors.missing} 块不可语义检索，需 reembed`)
    }
    result.vectors.badRows = Array.isArray(meta.indexMeta?.badVectorRows) ? meta.indexMeta.badVectorRows.length : 0
    if (result.vectors.badRows) warnings.push(`向量坏行 ${result.vectors.badRows}（需 reembed）`)
    if (meta.manifest.contractVersion !== undefined && meta.indexMeta == null) {
      warnings.push('index_meta.json 缺失（跑 rebuild 可重建，不重嵌）')
    }
    if (meta.indexMeta?.alignmentBroken) {
      warnings.push('向量行对齐已破坏（此前追加失败且未能截断）：需 reembed 重建向量文件，禁止继续追加向量')
    }
    if (opts.deep && meta.manifest.dim > 0 && bytes === expectedBytes(chunks.rows.length, meta.manifest.dim)) {
      try {
        const vr = await readVectorFile(vf, { count: chunks.rows.length, dim: meta.manifest.dim })
        if (vr.ok) {
          const info = inspectVectors(vr.flat, vr.dim)
          result.vectors.norms = info.norms
          result.vectors.normalized = info.normalized
          if (!info.normalized) warnings.push('向量未全部 L2 归一化（与余弦度量不配套）')
          if (info.badRows.length > result.vectors.badRows) warnings.push(`深检发现坏行 ${info.badRows.length}`)
        }
      } catch (e) {
        warnings.push(`深检向量失败：${e.message}`)
      }
    }
  }

  result.degraded = errors.length > 0 || !meta.exists || result.vectors.missing > 0 || result.vectors.badRows > 0
    || Boolean(meta.indexMeta?.alignmentBroken)
    || (opts.deep && result.vectors.normalized === false)
  return result
}

/** 整个 dataRoot 的状态（含身份层健康、未归属、磁盘余量） */
export async function statusAll(dataRoot, opts = {}) {
  const root = resolve(dataRoot || defaultDataRoot())
  const identityState = await loadIdentity(root)
  let dirs = []
  try {
    dirs = (await readdir(scopesRoot(root), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { /* 还没有 scopes/ */ }

  const scopes = {}
  let totalChunks = 0
  const warnings = []
  const errors = []
  for (const pid of dirs.sort()) {
    const st = await statusOfScope(root, pid, opts)
    scopes[pid] = st
    totalChunks += st.chunks
    if (st.degraded) warnings.push(`scope ${pid} 口径不完整：errors=${st.errors.map((e) => e.code).join(',') || 'none'}；warnings=${st.warnings.length}`)
    if (pid === PERSONA_UNASSIGNED) warnings.push(`存在未归属块 ${st.chunks} 条（persona_unassigned）—— 需人工指派，不静默归入具名人格`)
  }

  let disk = null
  try {
    const fs = await statfs(root)
    disk = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize, freeGB: Number(((fs.bavail * fs.bsize) / 1e9).toFixed(2)) }
    if (disk.freeGB < 1) warnings.push(`磁盘余量偏低：${disk.freeGB} GB（只告警，不自动删）`)
  } catch { /* 某些平台不支持 */ }

  // #13 强提示：defaultPersonaId 非空 = 所有未映射工作区/会话都会被吸到它（串味源）。
  // 这条以前只存在于文档里；现在进 status.warnings，UI 会原样展示。
  if (identityState.ok && identityState.identity.defaultPersonaId) {
    warnings.push(`默认人格已启用：defaultPersonaId=${identityState.identity.defaultPersonaId} —— 所有未映射的工作区/会话都会被归到它（串味源）。建议置空，改用工作区/会话绑定。`)
  }

  return {
    ok: true,
    dataRoot: root,
    schemaVersion: 1,
    contractVersion: 1,
    writer: { ...WRITER },
    ingestVersion: INGEST_VERSION,
    identity: identityState.ok
      ? { ok: true, file: identityState.file, personas: Object.keys(identityState.identity.personas || {}), defaultPersonaId: identityState.identity.defaultPersonaId ?? null }
      : { ok: false, degraded: true, reason: identityState.reason, file: identityState.file, error: identityState.error || null },
    scopes,
    totals: {
      scopes: dirs.length,
      chunks: totalChunks,
      unassignedChunks: scopes[PERSONA_UNASSIGNED]?.chunks || 0,
    },
    disk,
    degraded: !identityState.ok || warnings.length > 0,
    warnings,
    errors,
    checkedAt: new Date().toISOString(),
  }
}

/** 导出 chunks.jsonl（备份/迁移）；不传 outFile 就返回内容长度与行数 */
export async function exportChunks(p) {
  const { dataRoot, personaId, outFile = null, includeManifest = false } = p || {}
  if (!validScopeId(personaId)) return badScopeId(personaId)
  if (outFile) {
    const s = normPath(sessionsRoot())
    const t = normPath(outFile)
    if (t === s || t.startsWith(s + '\\')) {
      return fail(CODES.READ_ONLY_SOURCE, `拒绝导出到 DSH 会话目录（只读源）：${outFile}`)
    }
  }
  const meta = await readScopeMeta(dataRoot, personaId)
  if (!meta.exists) return fail('SCOPE_MISSING', `scope 不存在：${personaId}`)
  const file = chunksPath(dataRoot, personaId)
  const bytes = await fileSize(file)
  if (bytes < 0) return fail('SCOPE_MISSING', `chunks.jsonl 不存在：${file}`)
  const chunks = await readJsonl(file)
  if (chunks.corrupt?.length) {
    return fail(CODES.JSONL_CORRUPT, `chunks.jsonl 有 ${chunks.corrupt.length} 行损坏，拒绝导出（先 verify/repair）`, { corrupt: chunks.corrupt.slice(0, 5) })
  }
  const result = { ok: true, personaId, file, chunks: chunks.rows.length, bytes, sha256: await hashFile(file) }
  if (outFile) {
    const buf = await readFile(file)
    await atomicWrite(outFile, buf)
    result.outFile = outFile
    result.outBytes = buf.length
    if (includeManifest) {
      const mf = manifestPath(dataRoot, personaId)
      const dst = join(dirname(outFile), 'manifest.json')
      await atomicWrite(dst, await readFile(mf))
      result.manifestOut = dst
    }
  }
  return result
}

/**
 * 从 chunks.jsonl 重建 index_meta（F13：rebuild = 0 次嵌入；缺向量只恢复文本索引并提示 reembed）
 */
export async function rebuildIndexMeta(p) {
  const { dataRoot, personaId, lockTimeoutMs = 10000 } = p || {}
  if (!validScopeId(personaId)) return badScopeId(personaId)
  const dir = scopeDir(dataRoot, personaId)
  try { assertWriteAllowed(dataRoot, dir) } catch (e) { return fail(e.code || CODES.PATH_OUTSIDE_ROOT, e.message) }
  const lock = await acquireLock(dir, { timeoutMs: lockTimeoutMs })
  if (!lock.ok) return fail(lock.code, lock.error.message, lock.error)
  try {
    const meta = await readScopeMeta(dataRoot, personaId)
    if (!meta.exists) return fail('SCOPE_MISSING', `scope 不存在：${personaId}`)
    // manifest 不可用（契约版本不兼容 / 字段非法）→ 拒绝重建，别拿半个 manifest 写索引（F14）
    if (!meta.ok) return fail(meta.error?.code || CODES.MANIFEST_INVALID, `manifest 不可用，拒绝重建：${meta.error?.message || ''}`)
    const chunks = await readJsonl(chunksPath(dataRoot, personaId))
    if (chunks.corrupt?.length) return fail(CODES.JSONL_CORRUPT, `chunks.jsonl 损坏 ${chunks.corrupt.length} 行，拒绝重建`)
    const dim = Number(meta.manifest?.dim) || 0
    const oldMeta = meta.indexMeta || {}
    // rebuild 是破坏性维护：成功后 generation 必须递增（F4）
    const bumpGeneration = async () => {
      const nextGen = Math.max(1, Number(meta.manifest.generation) || 1) + 1
      const nextManifest = { ...meta.manifest, generation: nextGen, builtAt: new Date().toISOString() }
      await atomicWrite(manifestPath(dataRoot, personaId), JSON.stringify(nextManifest, null, 2) + '\n')
      return nextGen
    }
    let indexMeta
    if (dim > 0) {
      const vr = await readVectorFile(vectorPath(dataRoot, personaId, oldMeta.vectorVersion || 1), { count: chunks.rows.length, dim })
      if (!vr.ok) {
        indexMeta = buildIndexMeta({
          vectorVersion: oldMeta.vectorVersion || 1, dim, count: chunks.rows.length,
          provider: meta.manifest.provider, model: meta.manifest.model, normalizerVersion: meta.manifest.normalizerVersion,
          missingVectors: chunks.rows.map((r) => r.id),
        })
        indexMeta.rebuildNote = '向量缺失/尺寸不符：只重建了文本索引，需显式跑 reembed（不自动扣费重嵌）'
        await atomicWrite(indexPathMetaPath(dataRoot, personaId), JSON.stringify(indexMeta, null, 2) + '\n')
        const gen = await bumpGeneration()
        return { ok: true, personaId, chunks: chunks.rows.length, embeddings: 0, vectorState: 'missing', generation: gen, note: indexMeta.rebuildNote }
      }
      const info = inspectVectors(vr.flat, dim)
      indexMeta = buildIndexMeta({
        vectorVersion: oldMeta.vectorVersion || 1, dim, count: chunks.rows.length,
        provider: meta.manifest.provider, model: meta.manifest.model, normalizerVersion: meta.manifest.normalizerVersion,
        badVectorRows: info.badRows.map((b) => ({ index: b.index, reason: b.reason, id: chunks.rows[b.index]?.id ?? null })),
        missingVectors: [],
      })
    } else {
      indexMeta = buildIndexMeta({ vectorVersion: 1, dim: 0, count: chunks.rows.length, provider: '', model: '', missingVectors: chunks.rows.map((r) => r.id) })
    }
    await atomicWrite(indexPathMetaPath(dataRoot, personaId), JSON.stringify(indexMeta, null, 2) + '\n')
    const gen = await bumpGeneration()
    return { ok: true, personaId, chunks: chunks.rows.length, embeddings: 0, vectorState: dim > 0 ? 'ok' : 'none', generation: gen }
  } finally {
    await lock.release()
  }
}

/**
 * 增量追加（摄取用）。事实源先写；向量写失败 → 已存下但检索不可见（D6 明确报错）。
 */
export async function appendUtterances(p) {
  const { dataRoot, personaId, utterances = [], vectors = null, dim = 0, embedding = null, lockTimeoutMs = 15000, durable = true, normalizeVectors = true } = p || {}
  if (!validScopeId(personaId)) return badScopeId(personaId)
  const dir = scopeDir(dataRoot, personaId)
  try { assertWriteAllowed(dataRoot, dir) } catch (e) { return fail(e.code || CODES.PATH_OUTSIDE_ROOT, e.message) }
  await ensureDir(dir)
  const lock = await acquireLock(dir, { timeoutMs: lockTimeoutMs })
  if (!lock.ok) return fail(lock.code, lock.error.message, lock.error)
  try {
    const meta = await readScopeMeta(dataRoot, personaId)
    if (!meta.exists) return fail('SCOPE_MISSING', `scope 不存在，先写一次完整快照：${personaId}`)
    if (!meta.ok) return fail(meta.error?.code || CODES.MANIFEST_INVALID, `manifest 不可用，拒绝写：${meta.error?.message || ''}`)
    // D1：向量自证。维度/模型/归一化口径任一与 manifest 不一致 → 写前拒绝（不允许写坏向量文件）
    const manifestDim = Number(meta.manifest?.dim) || 0
    const wantVectors = Boolean(vectors && dim)
    if (wantVectors) {
      if (manifestDim !== Number(dim)) {
        return fail(CODES.EMBEDDING_MISMATCH, `维度与 manifest 不一致（manifest=${manifestDim}，传入=${dim}）：拒绝写入。换维度必须新建 vectors_v<N+1> / 走 reembed`)
      }
      if (embedding) {
        const want = {
          provider: embedding.provider || '',
          model: embedding.model || '',
          dim: Number(embedding.dim) || Number(dim),
          normalizerVersion: embedding.normalizerVersion || NORMALIZER_VERSION,
        }
        const st = manifestEmbeddingState(meta.manifest, want)
        if (!st.ok) {
          return fail(CODES.EMBEDDING_MISMATCH, `嵌入参数与 manifest 不一致（${st.diffs?.join(',') || st.reason}）：拒绝写入，需显式 reembed 后新建向量文件`)
        }
      }
    }
    // 行对齐已破坏时禁止再追加向量（否则错位会越滚越大）；文本仍可追加（会进 missingVectors）
    if (wantVectors && meta.indexMeta?.alignmentBroken) {
      return fail(CODES.VECTOR_SIZE_MISMATCH, '向量行对齐已破坏，拒绝继续追加向量；先 reembed 重建向量文件（本次未写入任何数据）')
    }

    const existing = await readJsonl(chunksPath(dataRoot, personaId))
    const known = new Set(existing.rows.map((r) => r.id))
    const fresh = []
    let dups = 0
    for (const u of utterances) {
      const errs = validateChunk(u)
      if (errs.length) return fail('CHUNK_INVALID', `不合格行：${errs.join('；')}`, { id: u?.id })
      if (known.has(u.id)) { dups++; continue }
      known.add(u.id)
      fresh.push(u)
    }
    if (!fresh.length) return { ok: true, personaId, added: 0, duplicates: dups, total: existing.rows.length, readback: { state: 'found' } }

    if (vectors && dim && vectors.length !== fresh.length * dim) {
      return fail(CODES.VECTOR_SIZE_MISMATCH, `向量长度不符：${vectors.length} ≠ ${fresh.length} × ${dim}`)
    }

    // D2：写入前 L2 归一化（幂等）；坏行保留占位并计数，不丢行
    let vec = vectors
    let vectorInspection = null
    if (vec && dim) {
      if (normalizeVectors) {
        vec = Float32Array.from(vec)
        for (let i = 0; i < fresh.length; i++) normalizeRowInPlace(vec.subarray(i * dim, (i + 1) * dim))
      }
      vectorInspection = inspectVectors(vec, dim)
      vectorInspection = {
        ...vectorInspection,
        badRows: vectorInspection.badRows.map((b) => ({ index: b.index, reason: b.reason, id: fresh[b.index]?.id ?? null })),
      }
    }

    // 追加前对齐自检：向量文件必须与「现有块数」对齐，否则新向量会接在错位处
    const vf0 = vectorPath(dataRoot, personaId, meta.indexMeta?.vectorVersion || 1)
    if (wantVectors) {
      const actual0 = await fileSize(vf0)
      const expect0 = expectedBytes(existing.rows.length, Number(meta.manifest?.dim) || dim)
      if (actual0 !== expect0) {
        return fail(CODES.VECTOR_SIZE_MISMATCH, `追加前向量文件与现有块数不对齐（${actual0} ≠ ${expect0}）；先 reembed/rebuild。本次未写入（可只追加文本 vectors=null）`)
      }
    }

    const total = existing.rows.length + fresh.length
    const effDim = Number(dim) || Number(meta.manifest?.dim) || 0
    const w = await appendJsonl(chunksPath(dataRoot, personaId), fresh, { durable })
    const vf = vf0
    const beforeVectorBytes = effDim > 0 ? await fileSize(vf) : -1
    let vectorState = 'none'
    let alignment = null
    if (vec && dim) {
      try {
        const fh = await open(vf, 'a')
        try { await fh.writeFile(vectorsToBuffer(vec)); if (durable) await fh.datasync() } finally { await fh.close() }
        vectorState = 'ok'
      } catch (e) {
        vectorState = 'error'
        // 关键：把向量文件截回追加前尺寸，否则下次成功追加会从错位处接上，永久错行
        let truncated = false
        try {
          if (beforeVectorBytes >= 0) { await truncate(vf, beforeVectorBytes); truncated = true }
        } catch { /* 截断失败 → alignment 会报 broken */ }
        await appendCostSafe(dataRoot, personaId, { kind: 'vector_append_failed', error: toErrInfo(e), chunks: fresh.length, truncated })
      }
    }

    // 行对齐自检：向量行数必须等于块数（只追加文本时也会在这里报出来）
    if (effDim > 0) {
      const actual = await fileSize(vf)
      const expected = expectedBytes(total, effDim)
      alignment = { ok: actual === expected, expectedBytes: expected, actualBytes: actual }
      if (!alignment.ok) vectorState = vectorState === 'ok' ? 'error' : vectorState
    }

    // index_meta 必须跟着走：计数 / 缺失 / 坏行 / 对齐（否则 status 与 rebuild 会基于旧账）
    const prevIndexMeta = meta.indexMeta || {}
    const missing = new Set(Array.isArray(prevIndexMeta.missingVectors) ? prevIndexMeta.missingVectors : [])
    if (effDim > 0) {
      if (vectorState !== 'ok') for (const u of fresh) missing.add(u.id)
    } else {
      for (const u of fresh) missing.add(u.id)
    }
    // 已经补上向量的旧块：只有「本次追加且成功」才可能是它们，无法精确判断，故保守保留旧缺失清单
    const indexMeta = {
      ...buildIndexMeta({
        vectorVersion: prevIndexMeta.vectorVersion || 1,
        dim: manifestDim,
        count: total,
        provider: meta.manifest.provider,
        model: meta.manifest.model,
        normalizerVersion: meta.manifest.normalizerVersion,
        tokenizerVersion: meta.manifest.tokenizerVersion,
        badVectorRows: vectorInspection ? vectorInspection.badRows : (prevIndexMeta.badVectorRows || []),
        missingVectors: [...missing],
      }),
      ...(alignment ? { alignment } : {}),
    }
    if (alignment && !alignment.ok) indexMeta.alignmentBroken = true
    if (vectorState === 'error') indexMeta.lastVectorError = { at: new Date().toISOString(), chunks: fresh.length }

    // 写后读回
    const rb = await verifyWrittenScope(dataRoot, personaId, { chunks: total })
    const stored = rb.state === 'found'
    const vectorsRequested = Boolean(vectors && dim)
    const vectorsOk = !vectorsRequested || (vectorState === 'ok' && alignment?.ok !== false)
    const complete = stored && vectorsOk && (effDim === 0 || alignment?.ok !== false)
    // 请求了向量却没写成 → 不报 ok（F1：失败 ≠ ok）；只追加文本时 ok=stored，但 degraded 可见
    const ok = stored && (!vectorsRequested || vectorsOk)

    // manifest 计数 + index_meta（原子写）：只要事实源确认存下就更新账本，让 status 反映真实状态
    const summary = summarizeChunks([...existing.rows, ...fresh])
    const nextManifest = { ...meta.manifest, chunks: summary.chunks, sessions: summary.sessions, workspaces: summary.workspaces, tMin: summary.tMin, tMax: summary.tMax, builtAt: new Date().toISOString() }
    if (stored) {
      await atomicWrite(manifestPath(dataRoot, personaId), JSON.stringify(nextManifest, null, 2) + '\n')
      await atomicWrite(indexPathMetaPath(dataRoot, personaId), JSON.stringify(indexMeta, null, 2) + '\n')
    }
    const error = !stored
      ? { code: CODES.READBACK_MISMATCH, message: `写后读回未通过：${rb.reason}` }
      : (!vectorsOk
        ? { code: 'VECTOR_WRITE_FAILED', message: `向量未写入/行对齐异常（${vectorState}）：${fresh.length} 块已存下但不可语义检索，需 reembed` }
        : null)
    return {
      ok,
      stored,
      degraded: !complete,
      personaId,
      added: fresh.length,
      duplicates: dups,
      total: summary.chunks,
      bytes: w.bytes,
      vectorState,
      alignment,
      readback: rb,
      ...(error ? { error, hint: '事实源已确认存下；先看 status，跑 reembed/rebuild 前不要重复追加向量' } : {}),
    }
  } finally {
    await lock.release()
  }
}

/** 记成本（记账失败只告警，不阻塞主流程 —— F13） */
export async function appendCost(dataRoot, personaId, entry) {
  try {
    await appendJsonl(costPath(dataRoot, personaId), [{ at: new Date().toISOString(), ...entry }], { durable: false })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: toErrInfo(e) }
  }
}

async function appendCostSafe(dataRoot, personaId, entry) {
  try { await appendJsonl(costPath(dataRoot, personaId), [{ at: new Date().toISOString(), ...entry }], { durable: false }) } catch { /* 只告警 */ }
}

/** 墓碑（F6）：删除 = 写 deleted.jsonl，不物理改 chunks */
export async function appendTombstone(dataRoot, personaId, { ids = [], reason = 'manual' }) {
  if (!ids.length) return { ok: true, added: 0 }
  const rows = ids.map((id) => ({ id, deletedAt: new Date().toISOString(), reason }))
  await appendJsonl(deletedPath(dataRoot, personaId), rows, { durable: true })
  return { ok: true, added: rows.length }
}

/** 读墓碑 id 集合：按行序裁决最新状态（forget / revive），缺省 action 视为 forget */
export async function readTombstones(dataRoot, personaId) {
  const r = await readJsonl(deletedPath(dataRoot, personaId))
  const state = new Map()
  for (const row of r.rows) {
    if (!row || typeof row.id !== 'string' || !row.id) continue
    state.set(row.id, row.action === 'revive' ? 'revive' : 'forget')
  }
  const out = new Set()
  for (const [id, action] of state) if (action === 'forget') out.add(id)
  return out
}

/** verify：块数/向量/孤儿 tmp/墓碑引用/归档引用/源 hash 漂移（F16） */
export async function verifyScope(dataRoot, personaId, opts = {}) {
  if (!validScopeId(personaId)) {
    return { ok: false, personaId, chunks: 0, problems: [badScopeId(personaId).error], info: [], checkedAt: new Date().toISOString() }
  }
  const st = await statusOfScope(dataRoot, personaId, { deep: true })
  const problems = []
  const info = []
  if (!st.exists) problems.push({ code: 'SCOPE_MISSING', message: st.dir })
  for (const e of st.errors) problems.push(e)
  for (const w of st.warnings) info.push(w)
  if (st.vectors?.missing > 0) {
    problems.push({ code: CODES.VECTOR_MISSING, message: `缺向量 ${st.vectors.missing} 块（检索不可见；需 reembed）` })
  }
  if (st.vectors?.badRows > 0) {
    problems.push({ code: CODES.VECTOR_BAD_ROW, message: `向量坏行 ${st.vectors.badRows}（零向量/非有限值；需 reembed）` })
  }
  if (st.vectors?.normalized === false) {
    problems.push({ code: 'VECTOR_NOT_NORMALIZED', message: '向量未全部 L2 归一化（与余弦度量不配套）' })
  }
  if (st.warnings.some((w) => w.includes('行对齐已破坏'))) {
    problems.push({ code: 'VECTOR_ALIGNMENT_BROKEN', message: '向量行对齐已破坏：需 reembed，禁止继续追加向量' })
  }

  const dir = scopeDir(dataRoot, personaId)
  const orphans = await listOrphanTmp(dir)
  if (orphans.length) problems.push({ code: 'ORPHAN_TMP', message: `${orphans.length} 个孤儿 tmp`, files: orphans })

  const chunks = await readJsonl(chunksPath(dataRoot, personaId))
  const ids = new Set(chunks.rows.map((r) => r.id))
  if (ids.size !== chunks.rows.length) problems.push({ code: 'DUPLICATE_ID', message: `重复 id ${chunks.rows.length - ids.size} 个` })

  const tombs = await readTombstones(dataRoot, personaId)
  const dangling = [...tombs].filter((id) => !ids.has(id))
  if (dangling.length) info.push(`墓碑指向不存在的块 ${dangling.length} 个（只提示，不阻塞）`)

  let archive = []
  try {
    archive = (await readdir(join(dir, '_archive'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { /* 没有归档 */ }

  return {
    ok: problems.length === 0,
    personaId,
    dir,
    chunks: chunks.rows.length,
    vectors: st.vectors,
    problems,
    info,
    orphans: orphans.length,
    archiveDirs: archive.length,
    checkedAt: new Date().toISOString(),
  }
}

export { scopeDir }
