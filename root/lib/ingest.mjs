/**
 * lib/ingest.mjs —— 会话摄取（骨架）
 *
 * v1 骨架口径：
 *   · 只读 `~/.dsh/sessions/`，写入 `<dataRoot>/scopes/<personaId>/`；
 *   · 按 persona 分库，**不建跨人格合并**；未归属进 persona_unassigned；
 *   · 本骨架**不做嵌入**（向量归 v1.1 / 晚上切换后再接）；
 *     新块会进 `index_meta.missingVectors` 并在 status 里报警 —— 已存下但检索不可见，明确可见（D6）。
 */
import { sessionsRoot, PERSONA_UNASSIGNED, normPath } from './paths.mjs'
import { extractSessions } from './session-extract.mjs'
import { buildChunks } from './chunker.mjs'
import { makeUtterance, summarizeChunks, validateChunk, inferChannel, foldLegacySourceType, legacyRowHash } from './chunks.mjs'
import { resolvePersona } from './identity.mjs'
import { appendUtterances, writeScopeBundle, readScopeMeta } from './store.mjs'
import { toErrInfo } from './errors.mjs'

/**
 * @param {object} p
 * @param {string} p.dataRoot
 * @param {object|null} p.identity
 * @param {number} [p.days]
 * @param {string|null} [p.personaId]    只摄某个人格（隔离：不指定就按解析结果分）
 * @param {string|null} [p.ws]           只摄某个工作区（真实路径，最长前缀匹配同样生效）
 * @param {boolean} [p.dryRun]
 * @param {number|null} [p.limit]
 */
export async function ingestSessions(p) {
  const {
    dataRoot, identity = null, days = 7, personaId = null,
    ws = null, dryRun = false, limit = null, signal = null, onProgress = null,
  } = p || {}

  const { recs, fileCount } = await extractSessions({
    root: sessionsRoot(),
    days,
    wsFilter: null,
    signal,
    onProgress,
  })
  const raw = buildChunks(recs)
  // ws 过滤：按真实路径的前缀（路径段边界）过滤；不传就不过滤（不默认缩到调用方工作区）
  const wsWant = ws ? normPath(ws) : null
  const afterWs = wsWant
    ? raw.filter((c) => {
      const t = normPath(c.wsPretty)
      return t === wsWant || t.startsWith(wsWant + '\\')
    })
    : raw
  const selected = limit ? afterWs.slice(0, Math.max(0, Number(limit))) : afterWs

  const byPersona = new Map()
  const invalid = []
  const skippedByPersonaFilter = []
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]
    const r = resolvePersona(identity, { session: c.session, ws: c.wsPretty })
    if (personaId && r.personaId !== personaId) { skippedByPersonaFilter.push(r.personaId); continue }
    if (r.personaId === PERSONA_UNASSIGNED && personaId && personaId !== PERSONA_UNASSIGNED) {
      skippedByPersonaFilter.push(PERSONA_UNASSIGNED)
      continue
    }
    const u = makeUtterance({
      session: c.session,
      personaId: r.personaId,
      identitySource: r.identitySource,
      messageId: c.msgId,
      seq: c.seq,
      part: c.part,
      role: c.role,
      sourceType: foldLegacySourceType(c.sourceType, c.role),
      t: c.t,
      text: c.text,
      ws: c.wsPretty,
      wsDir: c.ws,
      channel: inferChannel(c.wsPretty, c.session),
      attachments: [],
      // 源行指纹：源变了（同锚点不同文本）能被发现（F14），不做静默覆盖
      sourceHash: legacyRowHash({ session: c.session, role: c.role, t: c.t, part: c.part, msgId: c.msgId, seq: c.seq, text: c.text }),
    })
    const errs = validateChunk(u)
    if (errs.length) { invalid.push({ index: i, errors: errs }); continue }
    if (!byPersona.has(r.personaId)) byPersona.set(r.personaId, [])
    byPersona.get(r.personaId).push(u)
  }

  const report = {
    ok: true,
    mode: 'sessions',
    dryRun: Boolean(dryRun),
    days,
    ws: ws || null,
    files: fileCount,
    extracted: raw.length,
    afterWsFilter: afterWs.length,
    selected: selected.length,
    invalid: invalid.length,
    skippedByPersonaFilter: skippedByPersonaFilter.length,
    byPersona: {},
    written: 0,
    embedding: 'skipped:not-configured',
    warnings: ['骨架不做嵌入：新块进 missingVectors，检索不可见会由 status 报出（D6）'],
    errors: [],
  }

  for (const [pid, rows] of byPersona) {
    const summary = summarizeChunks(rows)
    report.byPersona[pid] = { chunks: rows.length, sessions: summary.sessions, workspaces: summary.workspaces }
    if (dryRun) continue
    const meta = await readScopeMeta(dataRoot, pid)
    // 硬闸门：已有向量的 scope 拒绝文本-only 摄取。
    // 理由：ingestSessions 不嵌向量（vectors=null），追加文本会让向量行与块数错位，
    // 触发 alignmentBroken，之后连正常追加向量都会被 store 拒绝（2026-11-07 实机踩过）。
    // 需要摄取请走 tools/ingest-hourly.mjs（先嵌后写），或显式用 ingestUtterances 带 vectors。
    if (meta.exists && (Number(meta.manifest?.dim) || 0) > 0) {
      report.ok = false
      report.errors.push({
        personaId: pid,
        code: 'EMBEDDING_REQUIRED',
        message: `scope 已有向量（dim=${meta.manifest.dim}）：ingestSessions 是文本-only 骨架，拒绝写入以免破坏向量对齐；请用 tools/ingest-hourly.mjs（先嵌后写）或 ingestUtterances(vectors=...)`,
        chunks: rows.length,
      })
      continue
    }
    let w
    if (!meta.exists) {
      w = await writeScopeBundle({
        dataRoot, personaId: pid, displayName: null, identitySource: rows[0]?.identitySource || 'unassigned',
        utterances: rows, vectors: null, embedding: { provider: '', model: '', dim: 0 },
        retentionDays: 30, overwrite: false, reason: 'ingest-initial',
      })
    } else {
      w = await appendUtterances({ dataRoot, personaId: pid, utterances: rows, vectors: null, dim: 0 })
    }
    if (!w.ok) {
      report.ok = false
      report.errors.push({ personaId: pid, ...toErrInfo(w.error || w) })
    } else {
      report.written += w.added || w.chunks || rows.length
    }
  }

  if (!report.ok) report.warnings.push('有 persona 写入失败：先看 status，再决定重试（旧数据未动）')
  return report
}

/** 直接摄取显式 utterance（测试/导入用；不做会话抽取） */
export async function ingestUtterances({ dataRoot, utterances = [], vectors = null, dim = 0, embedding = null, dryRun = false }) {
  const byPersona = new Map()
  const invalid = []
  for (const u of utterances) {
    const errs = validateChunk(u)
    if (errs.length) { invalid.push({ id: u?.id ?? null, errors: errs }); continue }
    if (!byPersona.has(u.personaId)) byPersona.set(u.personaId, [])
    byPersona.get(u.personaId).push(u)
  }
  const report = { ok: invalid.length === 0, mode: 'utterances', dryRun: Boolean(dryRun), invalid: invalid.length, byPersona: {}, written: 0, errors: [] }
  for (const [pid, rows] of byPersona) {
    report.byPersona[pid] = { chunks: rows.length }
    if (dryRun) continue
    const meta = await readScopeMeta(dataRoot, pid)
    const w = meta.exists
      ? await appendUtterances({ dataRoot, personaId: pid, utterances: rows, vectors, dim, embedding })
      : await writeScopeBundle({ dataRoot, personaId: pid, utterances: rows, vectors, embedding: embedding || { dim }, identitySource: rows[0]?.identitySource || 'manual', reason: 'ingest-initial' })
    if (!w.ok) { report.ok = false; report.errors.push({ personaId: pid, ...toErrInfo(w.error || w) }) }
    else report.written += w.added || w.chunks || rows.length
  }
  return report
}
