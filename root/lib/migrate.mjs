/**
 * lib/migrate.mjs —— 迁移器（D8 / F17 / E1）
 *
 * 收编现有寻枝库，**不重新抓会话、不重复建向量**：
 *   · 读旧 `meta.json` 的 chunks + `vectors.f32`；
 *   · 按 `ws → personaId` 拆块（源级映射兜底），向量按同一行序拆行，不重嵌；
 *   · 写入 `<outRoot>/scopes/<personaId>/`；
 *   · 三重校验：块数 / 文本 / 锚点（+ persona + 向量逐行）；
 *   · 迁移前后对旧库文件做 sha256 对照，证明「旧库零改动」；
 *   · 只有全部成功才把 `gate.allGreen` 置真（D8：不全量成功不标完成）。
 */
import { join } from 'node:path'
import { hashFile, readJson, atomicWrite, ensureDir, pathExists } from './fsatomic.mjs'
import { legacyToUtterance, validateChunk } from './chunks.mjs'
import { readVectorFile, sliceRows, inspectVectors, rowsEqual } from './vectors.mjs'
import { writeScopeBundle, verifyWrittenScope, readScopeChunks } from './store.mjs'
import { resolvePersona } from './identity.mjs'
import { vectorPath, isInsideSessions } from './paths.mjs'
import { CODES, StoreError, toErrInfo } from './errors.mjs'

const MAX_REPORT_MISMATCHES = 20

/** 读旧库（只读） */
export async function readLegacyIndex(indexDir) {
  const metaFile = join(indexDir, 'meta.json')
  const vectorsFile = join(indexDir, 'vectors.f32')
  const m = await readJson(metaFile)
  if (!m.ok) {
    return {
      ok: false,
      code: m.code === 'ENOENT' ? 'LEGACY_INDEX_MISSING' : m.code,
      error: m.error || { code: 'LEGACY_INDEX_MISSING', message: `旧库 meta.json 读不到：${metaFile}` },
      indexDir,
    }
  }
  const meta = m.value
  if (!Array.isArray(meta.chunks)) {
    return { ok: false, code: CODES.MIGRATE_SOURCE_INVALID, error: { code: CODES.MIGRATE_SOURCE_INVALID, message: 'meta.json 没有 chunks 数组' }, indexDir }
  }
  const hasVectors = Number(meta.dim) > 0 && Array.isArray(meta.chunks) && meta.chunks.length > 0
  return {
    ok: true,
    indexDir,
    metaFile,
    vectorsFile,
    meta,
    chunks: meta.chunks,
    dim: Number(meta.dim) || 0,
    provider: String(meta.provider || ''),
    model: String(meta.model || ''),
    builtAt: meta.builtAt || null,
    scope: meta.scope || null,
    wsAllow: Array.isArray(meta.wsAllow) ? meta.wsAllow : null,
    hasVectors,
  }
}

/**
 * 取样：按时间顺序扫，每个工作区最多 perWsMax 块，总数不超过 limit。
 * 这样能保证「覆盖多个工作区」，而不是全挤在第一个工作区里。
 */
export function selectSample(chunks, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 250)
  const perWsMax = Math.max(1, Number(opts.perWsMax) || 120)
  const out = []
  const perWs = new Map()
  for (let i = 0; i < chunks.length && out.length < limit; i++) {
    const ws = String(chunks[i]?.ws || '')
    const n = perWs.get(ws) || 0
    if (n >= perWsMax) continue
    perWs.set(ws, n + 1)
    out.push(i)
  }
  return out
}

/**
 * 把一个旧库迁移成 persona scope。
 * @returns {Promise<object>} 源级报告
 */
async function migrateOneSource(src, opts) {
  const { outRoot, identity = null, retentionDays = 30, limit, perWsMax, write = true, reason = 'migrate' } = opts
  const report = {
    sourceId: src.id,
    personaId: src.personaId,
    displayName: src.displayName || null,
    legacyIndex: src.indexDir,
    ok: false,
    legacyChunks: 0,
    selected: 0,
    imported: 0,
    skippedInvalid: 0,
    duplicates: 0,
    vectors: null,
    sourceHashes: null,
    checks: null,
    mismatches: [],
    warnings: [],
  }

  const legacy = await readLegacyIndex(src.indexDir)
  if (!legacy.ok) {
    return { ...report, error: legacy.error }
  }
  report.legacyChunks = legacy.chunks.length
  report.warnings.push(...(legacy.meta.wsAllow ? [`旧库有 wsAllow 白名单（${legacy.meta.wsAllow.length} 项），迁移不重新裁剪`] : []))

  // ── 旧库指纹（迁移前后对照，证明只读）
  let before
  try {
    before = {
      meta: await hashFile(legacy.metaFile),
      vectors: legacy.hasVectors && (await pathExists(legacy.vectorsFile)) ? await hashFile(legacy.vectorsFile) : null,
    }
  } catch (e) {
    return { ...report, error: toErrInfo(e) }
  }

  // ── 取样 + 换算
  const indices = selectSample(legacy.chunks, { limit, perWsMax })
  report.selected = indices.length

  const validIndices = []
  const utterances = []
  for (const idx of indices) {
    const row = legacy.chunks[idx]
    const u = legacyToUtterance(row, {
      personaId: src.personaId,
      identitySource: src.identitySource || 'manual',
      displayName: src.displayName || null,
      sourceId: src.id,
      rowIndex: idx,
      legacyBuiltAt: legacy.builtAt,
      ws: row?.wsPretty || null,
    })
    const errs = validateChunk(u)
    if (errs.length) {
      report.skippedInvalid++
      if (report.mismatches.length < MAX_REPORT_MISMATCHES) report.mismatches.push({ kind: 'invalid_legacy_row', index: idx, errors: errs })
      continue
    }
    validIndices.push(idx)
    utterances.push(u)
  }

  // ── 工作区 ↔ 人格一致性检查（identity.json 命中但与源归属冲突 → 报警，不阻断）
  const wsConflicts = []
  for (const u of utterances) {
    if (!identity) break
    const r = resolvePersona(identity, { ws: u.ws, session: u.session })
    if (r.identitySource === 'workspace' || r.identitySource === 'session') {
      if (r.personaId !== src.personaId) {
        wsConflicts.push({ ws: u.ws, session: u.session, identity: r.personaId, source: src.personaId, matched: r.matched })
      }
    }
  }
  if (wsConflicts.length) {
    report.warnings.push(`工作区/会话映射与源归属冲突 ${wsConflicts.length} 块（以源归属为准；identity.json 需人工核对）`)
    report.wsConflicts = wsConflicts.slice(0, 10)
  }

  // ── 向量拆分（不重嵌）
  let vectors = null
  let vectorInspection = null
  if (legacy.hasVectors) {
    const vr = await readVectorFile(legacy.vectorsFile, { count: legacy.chunks.length, dim: legacy.dim })
    if (!vr.ok) {
      report.error = vr.error
      return report
    }
    vectors = sliceRows(vr.flat, validIndices, legacy.dim)
    vectorInspection = inspectVectors(vectors, legacy.dim)
    report.vectors = {
      provider: legacy.provider,
      model: legacy.model,
      dim: legacy.dim,
      rows: validIndices.length,
      bytes: vectors.length * 4,
      norms: vectorInspection.norms,
      normalized: vectorInspection.normalized,
      badRows: vectorInspection.badRows.slice(0, 10),
      badRowCount: vectorInspection.badRows.length,
    }
    if (vectorInspection.badRows.length) report.warnings.push(`向量坏行 ${vectorInspection.badRows.length}（保留行对齐，需 reembed）`)
    if (!vectorInspection.normalized) report.warnings.push('抽样向量未全部 L2 归一化（与余弦度量不配套，需确认旧库口径）')
  } else {
    report.warnings.push('旧库无向量（provider=none 或 dim=0）——只迁移文本')
  }

  if (!write) {
    report.ok = true
    report.dryRun = true
    return report
  }

  // ── 写入 scope
  const w = await writeScopeBundle({
    dataRoot: outRoot,
    personaId: src.personaId,
    displayName: src.displayName || null,
    identitySource: src.identitySource || 'manual',
    utterances,
    vectors,
    embedding: {
      provider: legacy.provider,
      model: legacy.model,
      dim: legacy.dim,
      normalizerVersion: undefined,
      source: 'migrated:session-recall',
    },
    retentionDays,
    overwrite: opts.overwrite === true,
    reason,
    durable: true,
    // 迁移必须逐字节保真：旧库向量已核验 L2=1，不再二次归一化（否则字节会变、无法逐行对证）
    normalizeVectors: false,
  })
  if (!w.ok) {
    report.error = w.error || { code: CODES.MIGRATE_SOURCE_INVALID, message: '写入失败' }
    report.write = { duplicates: w.duplicates ?? 0, readback: w.readback || null, warnings: w.warnings || [] }
    return report
  }
  report.imported = w.chunks
  report.duplicates = w.duplicates || 0
  if (w.warnings?.length) report.warnings.push(...w.warnings)

  // ── 三重校验：块数 / 文本 / 锚点（+ persona + 向量）
  const back = await verifyWrittenScope(outRoot, src.personaId, { chunks: utterances.length, lastId: utterances[utterances.length - 1]?.id || null })
  const r2 = await readScopeChunks(outRoot, src.personaId)
  const written = r2.rows || []
  const sourceRows = validIndices.map((i) => legacy.chunks[i])
  const checks = {
    counts: written.length === utterances.length && w.chunks === utterances.length,
    text: true,
    anchors: true,
    persona: true,
    vectors: true,
    // 与**旧库源行**逐条对照（不是拿自己转换后的副本自证）
    textVsLegacy: true,
    anchorsVsLegacy: true,
    readback: back.state,
  }
  const mism = []
  for (let k = 0; k < utterances.length; k++) {
    const a = utterances[k]
    const b = written[k]
    const s = sourceRows[k]
    if (!b || a.id !== b.id) {
      checks.text = false
      if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'row', index: k, expectId: a.id, gotId: b?.id ?? null })
      continue
    }
    if (a.text !== b.text) { checks.text = false; if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'text', index: k, id: a.id }) }
    if (a.session !== b.session || a.messageId !== b.messageId || a.seq !== b.seq || a.part !== b.part || a.t !== b.t) {
      checks.anchors = false
      if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'anchor', index: k, id: a.id })
    }
    if (a.personaId !== b.personaId) { checks.persona = false; if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'persona', index: k, id: a.id }) }

    // ── 对照旧库源行：text 必须逐字节一致（原话原样，不 trim 不改写）
    if (!s) {
      checks.textVsLegacy = false
      if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'missing_source_row', index: k })
      continue
    }
    if (b.text !== String(s.text ?? '')) {
      checks.textVsLegacy = false
      if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'text_vs_legacy', index: k, id: b.id, expectLen: String(s.text ?? '').length, gotLen: b.text.length })
    }
    const sMsg = s.msgId ?? null
    const sSeq = s.seq ?? null
    const sPart = s.part ?? 0
    if (b.session !== s.session || (b.messageId ?? null) !== sMsg || (b.seq ?? null) !== sSeq || b.part !== sPart || b.t !== Number(s.t)) {
      checks.anchorsVsLegacy = false
      if (mism.length < MAX_REPORT_MISMATCHES) mism.push({ kind: 'anchor_vs_legacy', index: k, id: b.id })
    }
  }

  // 向量逐行对照（写出文件 vs 旧库同分区行）
  if (legacy.hasVectors && vectors) {
    const vr2 = await readVectorFile(vectorPath(outRoot, src.personaId, 1), { count: utterances.length, dim: legacy.dim })
    if (!vr2.ok) {
      checks.vectors = false
      mism.push({ kind: 'vectors_read', error: vr2.error })
    } else {
      const vr0 = await readVectorFile(legacy.vectorsFile, { count: legacy.chunks.length, dim: legacy.dim })
      for (let k = 0; k < utterances.length && checks.vectors; k++) {
        const expected = vr0.ok ? vr0.flat.subarray(validIndices[k] * legacy.dim, (validIndices[k] + 1) * legacy.dim) : null
        const got = vr2.flat.subarray(k * legacy.dim, (k + 1) * legacy.dim)
        if (!expected || !rowsEqual(expected, got, legacy.dim)) {
          checks.vectors = false
          mism.push({ kind: 'vector_row', index: k, id: utterances[k].id })
        }
      }
    }
  }

  // ── 迁移后旧库指纹（必须与之前一致）
  let after
  try {
    after = {
      meta: await hashFile(legacy.metaFile),
      vectors: legacy.hasVectors && (await pathExists(legacy.vectorsFile)) ? await hashFile(legacy.vectorsFile) : null,
    }
  } catch (e) {
    return { ...report, error: toErrInfo(e) }
  }
  const unchanged = after.meta === before.meta && after.vectors === before.vectors
  report.sourceHashes = { before, after, unchanged }
  if (!unchanged) report.warnings.push('⚠️ 旧库文件在迁移期间发生变化（本程序只读；检查是否有别的进程在重建索引）')

  report.checks = checks
  report.mismatches.push(...mism)
  report.ok = checks.counts && checks.text && checks.anchors && checks.persona && checks.vectors
    && checks.textVsLegacy && checks.anchorsVsLegacy && back.state === 'found'
  return report
}

/**
 * 迁移入口。
 * @param {object} p
 * @param {string} p.outRoot         目标 dataRoot（演练用 _dryrun）
 * @param {Array<{id,personaId,displayName?,indexDir}>} p.sources
 * @param {number} [p.limitPerSource]
 * @param {number} [p.perWsMax]
 * @param {boolean} [p.write]
 * @param {object|null} [p.identity]
 */
export async function migrateLegacyIndex(p) {
  const startedAt = new Date().toISOString()
  const outRoot = p.outRoot
  const sources = Array.isArray(p.sources) ? p.sources : []
  if (!outRoot) throw new Error('outRoot 必填')
  if (!sources.length) throw new Error('sources 不能为空')
  // 绝对红线：绝不写只读源 sessions/（迁移报告/scope 都不许落进去）
  if (isInsideSessions(outRoot)) {
    throw new StoreError(CODES.READ_ONLY_SOURCE, `迁移目标落在只读源 sessions/ 下，拒绝迁移：${outRoot}`)
  }

  await ensureDir(outRoot)
  const srcReports = []
  for (const s of sources) {
    let r
    try {
      r = await migrateOneSource(s, {
        outRoot,
        identity: p.identity || null,
        retentionDays: p.retentionDays || 30,
        limit: p.limitPerSource || 250,
        perWsMax: p.perWsMax || 120,
        write: p.write !== false,
        overwrite: p.overwrite === true,
        reason: p.reason || 'migrate',
      })
    } catch (e) {
      // 单源异常不带走整批：记成失败报告，其余源继续（D8 错误路径）
      r = {
        sourceId: s?.id ?? null,
        personaId: s?.personaId ?? null,
        legacyIndex: s?.indexDir ?? null,
        ok: false,
        legacyChunks: 0,
        selected: 0,
        imported: 0,
        skippedInvalid: 0,
        duplicates: 0,
        vectors: null,
        sourceHashes: null,
        checks: null,
        mismatches: [],
        warnings: [],
        error: toErrInfo(e),
      }
    }
    srcReports.push(r)
  }

  const imported = srcReports.reduce((a, r) => a + (r.imported || 0), 0)
  const total = srcReports.reduce((a, r) => a + (r.selected || 0) - (r.skippedInvalid || 0), 0)
  const allSourcesOk = srcReports.every((r) => r.ok)
  const sourceUnchanged = srcReports.every((r) => r.sourceHashes?.unchanged !== false)
  const gate = {
    importedEqualsTotal: imported === total && total > 0,
    textOk: srcReports.every((r) => r.checks?.text !== false && r.checks?.textVsLegacy !== false),
    anchorsOk: srcReports.every((r) => r.checks?.anchors !== false && r.checks?.anchorsVsLegacy !== false),
    personaOk: srcReports.every((r) => r.checks?.persona !== false),
    vectorsOk: srcReports.every((r) => r.checks?.vectors !== false),
    sourceUnchanged,
    allSourcesOk,
  }
  gate.allGreen = Object.values(gate).every(Boolean)

  const report = {
    tool: 'dsh-memory-store/migrate',
    startedAt,
    finishedAt: new Date().toISOString(),
    outRoot,
    write: p.write !== false,
    limitPerSource: p.limitPerSource || 250,
    perWsMax: p.perWsMax || 120,
    sources: srcReports,
    totals: {
      selected: srcReports.reduce((a, r) => a + (r.selected || 0), 0),
      imported,
      total,
      skippedInvalid: srcReports.reduce((a, r) => a + (r.skippedInvalid || 0), 0),
      duplicates: srcReports.reduce((a, r) => a + (r.duplicates || 0), 0),
      personas: [...new Set(srcReports.map((r) => r.personaId))],
    },
    gate,
  }

  if (p.write !== false) {
    await atomicWrite(join(outRoot, '_migration-report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  return report
}
