/**
 * lib/root.mjs —— 根藏只读读取器
 *
 * 只做读：identity.json / scopes/<personaId>/manifest.json / chunks.jsonl。
 * 不读向量（v1a 不需要，partial 不影响）；不打开任何写句柄。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, readJsonl, decodeTextBuffer, hashFile } from './fsatomic.mjs'
import { defaultDataRoot, PERSONA_UNASSIGNED, isSafePersonaId, normPath } from './paths.mjs'
export async function rootExists(dataRoot = defaultDataRoot()) {
  try {
    const s = await stat(dataRoot)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** 读 identity.json（只读；缺失/损坏降级为空，不猜人格） */
export async function readIdentity(dataRoot = defaultDataRoot()) {
  const file = join(dataRoot, 'identity.json')
  const r = await readJson(file)
  if (!r.ok) {
    return {
      ok: false,
      code: r.code === 'ENOENT' ? 'IDENTITY_MISSING' : 'IDENTITY_CORRUPT',
      error: r.error ?? { code: r.code, message: `identity.json 不可读：${file}` },
      identity: null,
      file,
    }
  }
  const v = r.value
  const problems = []
  if (!v || typeof v !== 'object') problems.push('identity.json 不是对象')
  if (v?.version !== 1) problems.push(`identity.version=${v?.version}（期望 1）`)
  if (v?.personas && typeof v.personas !== 'object') problems.push('personas 不是对象')
  if (v?.workspaces && typeof v.workspaces !== 'object') problems.push('workspaces 不是对象')
  if (problems.length) {
    return { ok: false, code: 'IDENTITY_CORRUPT', error: { code: 'IDENTITY_CORRUPT', message: problems.join('；') }, identity: null, file, problems }
  }
  return { ok: true, identity: v, file }
}

/** 列出根藏里已有的 scope 目录（不读内容） */
export async function listScopes(dataRoot = defaultDataRoot()) {
  const dir = join(dataRoot, 'scopes')
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  return ents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((n) => n === PERSONA_UNASSIGNED || isSafePersonaId(n))
    .sort()
}

/**
 * 读一个 persona 的根藏 scope（只读）。
 * @returns {{ok:true, personaId, dir, manifest, chunks, stats, problems}|{ok:false, code, error, ...}}
 */
/**
 * 空库（P0-2）：scope 目录/文件还没建立 ≠ 故障。
 * 只有「确实没有数据」才走这里；manifest 损坏、读权限错误、坏行仍是真错误。
 */
function emptyScope({ personaId, dir, manifestFile, chunksFile, manifest = null, problems = [] }) {
  return {
    ok: true,
    empty: true,
    personaId,
    dir,
    manifest,
    chunks: [],
    stats: {
      chunks: 0, rawLines: 0, tornTail: false, sessions: 0, workspaces: 0,
      tMin: null, tMax: null, byRole: {}, bySourceType: {}, byRetention: {}, byChannel: {},
    },
    invalid: [],
    problems,
    files: { manifestFile, chunksFile },
    hint: '根藏里还没有这个人格的原话：先装根藏并摄取；年轮与熏习都从它读取。',
  }
}

/**
 * Stage 0：读墓碑（按行序裁决 forget / revive）。
 * 读边界过滤用：被「显式忘记」的块不再进入熏习。
 * 只读；deleted.jsonl 缺失 = 没有忘记。
 */
async function readForgottenIds(dir) {
  const r = await readJsonl(join(dir, 'deleted.jsonl'))
  const state = new Map()
  for (const row of r.rows) {
    if (!row || typeof row.id !== 'string' || !row.id) continue
    state.set(row.id, row.action === 'revive' ? 'revive' : 'forget')
  }
  const out = new Set()
  for (const [id, action] of state) if (action === 'forget') out.add(id)
  return out
}

export async function readScope(dataRoot, personaId) {
  if (!isSafePersonaId(personaId) && personaId !== PERSONA_UNASSIGNED) {
    return { ok: false, code: 'BAD_PERSONA_ID', error: { code: 'BAD_PERSONA_ID', message: `personaId 非法：${personaId}` } }
  }
  const dir = join(dataRoot, 'scopes', personaId)
  const manifestFile = join(dir, 'manifest.json')
  const chunksFile = join(dir, 'chunks.jsonl')

  // P0-2：目录根本不存在 → 空库（首次使用），不是故障
  const dirStat = await stat(dir).catch(() => null)
  if (!dirStat || !dirStat.isDirectory()) {
    return emptyScope({ personaId, dir, manifestFile, chunksFile })
  }

  const m = await readJson(manifestFile)
  if (!m.ok) {
    // manifest 不在时再看 chunks：两者都没有 = 空库；chunks 有内容 = 数据不完整，真错误
    if (m.code === 'ENOENT') {
      const cs = await stat(chunksFile).catch(() => null)
      if (!cs || cs.size === 0) return emptyScope({ personaId, dir, manifestFile, chunksFile })
    }
    return {
      ok: false,
      code: m.code === 'ENOENT' ? 'SCOPE_NOT_FOUND' : 'MANIFEST_INVALID',
      error: { code: m.code === 'ENOENT' ? 'SCOPE_NOT_FOUND' : 'MANIFEST_INVALID', message: `根藏 scope 不可读：${manifestFile}（${m.error?.message ?? m.code}）` },
      personaId,
      dir,
    }
  }
  const manifest = m.value
  const problems = []
  if (manifest?.contractVersion > 1) problems.push(`根藏 contractVersion=${manifest.contractVersion} > 1（拒绝写，可读）`)
  if (manifest?.personaId !== personaId) problems.push(`manifest.personaId（${manifest?.personaId}）与目录（${personaId}）不一致`)
  if (!Number.isFinite(manifest?.generation)) problems.push('manifest.generation 缺失/非数字')

  const c = await readJsonl(chunksFile)
  if (c.exists === false && !c.error) {
    // manifest 在、chunks.jsonl 不在：空库（没有原话），给引导而不是红字；
    // 保留 manifest，便于 UI 说明「存储层在，只是还没摄取」。
    return emptyScope({
      personaId, dir, manifestFile, chunksFile, manifest,
      problems: [`chunks.jsonl 还没有内容：${chunksFile}`],
    })
  }
  if (c.exists === false && c.error) {
    return { ok: false, code: 'SCOPE_NOT_FOUND', error: { code: 'SCOPE_NOT_FOUND', message: `chunks.jsonl 不可读：${chunksFile}（${c.error?.message ?? c.error?.code}）` }, personaId, dir, manifest }
  }
  if (c.corrupt?.length) {
    return {
      ok: false,
      code: 'JSONL_CORRUPT',
      error: { code: 'JSONL_CORRUPT', message: `chunks.jsonl 有 ${c.corrupt.length} 个中间坏行`, detail: c.corrupt.slice(0, 10) },
      personaId,
      dir,
      manifest,
    }
  }

  const rows = []
  const invalid = []
  for (const row of c.rows) {
    if (!row || typeof row !== 'object') { invalid.push({ reason: 'not-object', row }); continue }
    if (row.kind !== 'utterance') { invalid.push({ reason: 'kind', id: row.id, kind: row.kind }); continue }
    if (row.personaId !== personaId) { invalid.push({ reason: 'personaId', id: row.id, personaId: row.personaId }); continue }
    if (!row.id || typeof row.id !== 'string') { invalid.push({ reason: 'id', id: row.id }); continue }
    if (typeof row.text !== 'string') { invalid.push({ reason: 'text', id: row.id }); continue }
    if (row.contractVersion > 1) { invalid.push({ reason: 'contractVersion', id: row.id, contractVersion: row.contractVersion }); continue }
    rows.push(row)
  }

  // Stage 0：显式忘记的块从读边界消失（数据仍在 chunks.jsonl，墓碑可撤销）
  const forgotten = await readForgottenIds(dir)
  const visibleRows = forgotten.size ? rows.filter((r) => !forgotten.has(r.id)) : rows

  const stats = {
    chunks: visibleRows.length,
    rawLines: c.lines,
    tornTail: Boolean(c.tornTail),
    sessions: new Set(visibleRows.map((r) => r.session)).size,
    workspaces: new Set(visibleRows.map((r) => r.ws)).size,
    tMin: visibleRows.length ? Math.min(...visibleRows.map((r) => r.t)) : null,
    tMax: visibleRows.length ? Math.max(...visibleRows.map((r) => r.t)) : null,
    byRole: countBy(visibleRows, 'role'),
    bySourceType: countBy(visibleRows, 'sourceType'),
    byRetention: countBy(visibleRows, 'retention'),
    byChannel: countBy(visibleRows, 'channel'),
    forgotten: forgotten.size,
  }

  return {
    ok: true,
    personaId,
    dir,
    manifest,
    chunks: visibleRows,
    stats,
    invalid,
    problems,
    files: { manifestFile, chunksFile },
  }
}

function countBy(rows, key) {
  const m = new Map()
  for (const r of rows) {
    const v = r?.[key] ?? 'null'
    m.set(v, (m.get(v) || 0) + 1)
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]))
}

/**
 * 根藏只读签名：用于 run 幂等与增量判断。
 * builtAt 不变 + 块数不变 ⇒ 视为同一批。
 */
export async function rootSignature(dataRoot, personaId) {
  const dir = join(dataRoot, 'scopes', personaId)
  const m = await readJson(join(dir, 'manifest.json'))
  const chunkStat = await stat(join(dir, 'chunks.jsonl')).catch(() => null)
  return {
    builtAt: m.ok ? (m.value?.builtAt ?? null) : null,
    generation: m.ok ? (m.value?.generation ?? null) : null,
    chunks: m.ok ? (m.value?.chunks ?? null) : null,
    chunksBytes: chunkStat?.size ?? null,
    chunksMtimeMs: chunkStat?.mtimeMs ?? null,
  }
}

/** 哈希根藏关键文件（验收：前后不变）。向量文件较大，单独按需。 */
export async function hashRootKeyFiles(dataRoot, personaId, { includeVectors = false } = {}) {
  const dir = join(dataRoot, 'scopes', personaId)
  const out = {}
  for (const name of ['manifest.json', 'chunks.jsonl', 'index_meta.json', 'deleted.jsonl', 'cost.jsonl']) {
    const file = join(dir, name)
    try {
      out[name] = await hashFile(file)
    } catch (e) {
      out[name] = e.code === 'ENOENT' ? null : `ERR:${e.code || e.message}`
    }
  }
  if (includeVectors) {
    let ents = []
    try { ents = await readdir(dir) } catch { /* 忽略 */ }
    for (const n of ents.filter((x) => /^vectors_v\d+\.f32$/.test(x))) {
      out[n] = await hashFile(join(dir, n)).catch((e) => `ERR:${e.code || e.message}`)
    }
  }
  return out
}

export async function hashIdentity(dataRoot) {
  try {
    return await hashFile(join(dataRoot, 'identity.json'))
  } catch (e) {
    return e.code === 'ENOENT' ? null : `ERR:${e.code || e.message}`
  }
}

/**
 * 根藏存储卡（只 stat + 读 manifest/index_meta，不读 chunks/向量内容）。
 * UI 概览用；不要把 process 体积冒充根藏体积。
 */
export async function rootStorageStats(dataRoot, personaId) {
  const dir = join(dataRoot, 'scopes', personaId)
  // P0-2：空库给「空存储卡」，不报 SCOPE_NOT_FOUND
  const emptyCard = (extra = {}) => ({
    ok: true, empty: true, personaId, dir,
    displayName: personaId, identitySource: null,
    chunks: 0, rawLines: null, invalid: null,
    vectors: { file: null, bytes: null, rows: null, count: 0, missing: 0, badRows: 0, dim: null, provider: null, model: null, normalizerVersion: null, units: 'f32le' },
    volumeBytes: 0, files: [], tMin: null, tMax: null, coverageDays: null,
    builtAt: null, retentionDays: null, generation: null, deletedLines: 0,
    degraded: false, warnings: [], errors: [],
    hint: '根藏里还没有这个人格的数据：先装根藏并摄取',
    ...extra,
  })
  const dirStat = await stat(dir).catch(() => null)
  if (!dirStat || !dirStat.isDirectory()) return emptyCard()
  const m = await readJson(join(dir, 'manifest.json'))
  if (!m.ok) {
    if (m.code === 'ENOENT') {
      const cs = await stat(join(dir, 'chunks.jsonl')).catch(() => null)
      if (!cs || cs.size === 0) return emptyCard()
    }
    return { ok: false, code: m.code === 'ENOENT' ? 'SCOPE_NOT_FOUND' : 'MANIFEST_INVALID', error: m.error, personaId, dir }
  }
  const manifest = m.value
  const meta = await readJson(join(dir, 'index_meta.json'))
  const indexMeta = meta.ok ? meta.value : null

  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { /* 忽略 */ }
  const files = []
  let volumeBytes = 0
  for (const d of ents) {
    if (!d.isFile()) continue
    try {
      const s = await stat(join(dir, d.name))
      files.push({ name: d.name, bytes: s.size })
      volumeBytes += s.size
    } catch { /* 忽略 */ }
  }

  const vectorFile = indexMeta?.vectorFile ?? null
  const vectorBytes = vectorFile ? (files.find((f) => f.name === vectorFile)?.bytes ?? null) : null
  const dim = Number(indexMeta?.dim ?? manifest.dim ?? 0) || null
  const count = Number(indexMeta?.count ?? manifest.chunks ?? 0) || 0
  const rows = (dim && vectorBytes != null) ? Math.floor(vectorBytes / (dim * 4)) : null
  const missing = Array.isArray(indexMeta?.missingVectors) ? indexMeta.missingVectors.length : (rows != null ? Math.max(0, count - rows) : null)
  const badRows = Array.isArray(indexMeta?.badVectorRows) ? indexMeta.badVectorRows.length : 0

  let deletedLines = 0
  try {
    const del = await readJsonl(join(dir, 'deleted.jsonl'))
    deletedLines = del.lines
  } catch { /* 忽略 */ }

  const tMin = manifest.tMin ?? null
  const tMax = manifest.tMax ?? null
  const coverageDays = (tMin != null && tMax != null && tMax >= tMin) ? Number(((tMax - tMin) / 86400000).toFixed(2)) : null
  const warnings = []
  if (missing > 0) warnings.push(`向量缺失 ${missing} 块（partial，需 reembed；熏习不读向量，不受影响）`)
  if (badRows > 0) warnings.push(`坏向量行 ${badRows} 条`)
  if (rows != null && count > 0 && rows + missing !== count) warnings.push(`向量行数 ${rows} + missing ${missing} ≠ 块数 ${count}`)

  return {
    ok: true,
    personaId,
    dir,
    displayName: manifest.displayName ?? personaId,
    identitySource: manifest.identitySource ?? null,
    chunks: Number(manifest.chunks ?? count),
    rawLines: null,
    invalid: null,
    vectors: {
      file: vectorFile,
      bytes: vectorBytes,
      rows,
      count,
      missing,
      badRows,
      dim,
      provider: indexMeta?.provider ?? manifest.provider ?? null,
      model: indexMeta?.model ?? manifest.model ?? null,
      normalizerVersion: indexMeta?.normalizerVersion ?? manifest.normalizerVersion ?? null,
      units: indexMeta?.units ?? 'f32le',
    },
    volumeBytes,
    files,
    tMin,
    tMax,
    coverageDays,
    builtAt: manifest.builtAt ?? null,
    retentionDays: manifest.retentionDays ?? null,
    generation: manifest.generation ?? null,
    deletedLines,
    degraded: warnings.length > 0,
    warnings,
    errors: [],
  }
}

/**
 * 当前 persona / 身份（UI 默认不传 personaId；按工作区最长前缀解析）。
 * 不返回任何记忆正文；只给身份映射与各 scope 计数。
 */
export async function identityContext(dataRoot, workspace = null) {
  const id = await readIdentity(dataRoot)
  if (!id.ok) return { ok: false, code: id.code, error: id.error, dataRoot }
  const identity = id.identity
  const scopes = []
  for (const pid of await listScopes(dataRoot)) {
    const m = await readJson(join(dataRoot, 'scopes', pid, 'manifest.json'))
    if (!m.ok) {
      scopes.push({ personaId: pid, displayName: pid, chunks: null, builtAt: null, degraded: true, error: m.code })
      continue
    }
    const meta = await readJson(join(dataRoot, 'scopes', pid, 'index_meta.json'))
    const missing = Array.isArray(meta.ok ? meta.value?.missingVectors : null) ? meta.value.missingVectors.length : 0
    scopes.push({
      personaId: pid,
      displayName: m.value?.displayName ?? pid,
      chunks: Number(m.value?.chunks ?? 0),
      builtAt: m.value?.builtAt ?? null,
      degraded: missing > 0,
      missingVectors: missing,
    })
  }

  let personaId = null
  let identitySource = null
  if (workspace) {
    const target = normPath(workspace)
    let best = null
    for (const [ws, pid] of Object.entries(identity.workspaces ?? {})) {
      const nw = normPath(ws)
      if (target === nw || target.startsWith(nw + '\\') || target.startsWith(nw + '/')) {
        if (!best || nw.length > best.len) best = { pid, len: nw.length }
      }
    }
    if (best) { personaId = best.pid; identitySource = 'workspace' }
  }
  if (!personaId && identity.defaultPersonaId) {
    personaId = identity.defaultPersonaId
    identitySource = 'default'
  }

  const unassignedScope = scopes.find((s) => s.personaId === PERSONA_UNASSIGNED) ?? null
  return {
    ok: true,
    dataRoot,
    personaId,
    resolved: Boolean(personaId),
    identitySource,
    defaultPersonaId: identity.defaultPersonaId ?? null,
    personas: identity.personas ?? {},
    workspaces: identity.workspaces ?? {},
    scopes,
    unassigned: unassignedScope ? { chunks: unassignedScope.chunks, builtAt: unassignedScope.builtAt } : { chunks: 0, builtAt: null },
    warning: personaId ? null : '无法从工作区解析 personaId；请显式指定，不静默归入具名人格',
  }
}
