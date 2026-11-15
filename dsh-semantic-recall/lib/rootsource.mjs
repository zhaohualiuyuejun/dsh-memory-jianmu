/**
 * lib/rootsource.mjs —— 根藏（dsh-memory-store）只读适配层 · CONTRACT-v1
 * ============================================================================
 * 只按**文件格式**读 `<dataRoot>/scopes/<personaId>/`：
 *   manifest.json / index_meta.json / chunks.jsonl / vectors_v<N>.f32
 *
 * 铁律（下午施工红线）：
 *   · 只用 readFile / readdir / stat —— **不写任何文件**，不 import 根藏包内部模块
 *   · 只读当前路由到的那个 persona scope，**不跨人格**
 *   · 任何异常都 return（不抛），让调用方回退自带索引并如实报告原因
 *
 * 原因码（reasons）：
 *   root_missing / persona_missing / persona_unmapped / persona_mismatch
 *   contract_unsupported / corrupt_json / corrupt_jsonl / chunks_missing
 *   chunks_count_mismatch / index_meta_missing / vector_missing
 *   vector_size_mismatch / embedding_mismatch / read_error
 *   （vector_bad_rows 只降级、不拒绝：坏行占位是为了保持行对齐）
 * ============================================================================
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { normalizeProvider } from './embed.mjs'

/** 根藏 v1 契约版本；> 1 一律拒绝（回退，不静默读） */
export const CONTRACT_VERSION = 1
/** 根藏 v1 只写小端 f32 */
const VECTOR_UNITS = new Set(['f32le'])
/** 根藏 v1 的归一化版本；与寻枝 embed.mjs 的 L2 归一化等价 */
const NORMALIZERS = new Set(['l2-v1'])
/** personaId 合法 slug；`persona_unassigned` 只能留在根藏未归属区，不作为检索路由目标 */
export const PERSONA_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const PERSONA_UNASSIGNED = 'persona_unassigned'
export function isValidPersonaId(pid) {
  const s = String(pid || '')
  return PERSONA_SLUG.test(s) && s !== PERSONA_UNASSIGNED
}

/** 路径归一化（只用于工作区归属比较；Windows 不区分大小写，/ 与 \ 等价） */
function normWsPath(p) {
  return String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}
/** 块的工作区是否落在某个已映射工作区下（与根藏 matchWorkspace 同口径） */
function wsMatches(ws, targets) {
  const w = normWsPath(ws)
  if (!w) return false
  for (const t of targets) if (w === t || w.startsWith(t + '\\')) return true
  return false
}

/**
 * 源 id → 根藏 personaId 的代码内兜底表。
 * 正式做法是配置里 sources[].personaId（优先）；这张表只保证老配置不改也能跑。
 */
export const SCOPE_PERSONA_CONST = Object.freeze({
  src1: 'alice',
  srcmvwe6u4u: 'bob',
})

/** 当前检索库（scope）该读哪个根藏 persona；找不到/非法返回 null（调用方回退，不猜） */
export function personaForScope(scope, sources) {
  const s = String(scope || '')
  if (!s) return null
  const hit = (Array.isArray(sources) ? sources : []).find((x) => x && x.id === s)
  const pid = hit?.personaId ? String(hit.personaId) : (SCOPE_PERSONA_CONST[s] || null)
  return pid && isValidPersonaId(pid) ? pid : null
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const pushReason = (arr, r) => { if (r && !arr.includes(r)) arr.push(r) }
const errText = (e) => String(e?.message || e || '').slice(0, 200)

/** 读 JSON；ENOENT 归到调用方给的缺件码，其它读失败归 read_error */
async function readJson(file, missingReason = 'read_error') {
  let raw
  try { raw = await readFile(file, 'utf8') } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' ? missingReason : 'read_error', detail: errText(e) }
  }
  try { return { ok: true, value: JSON.parse(raw) } } catch (e) {
    return { ok: false, reason: 'corrupt_json', detail: errText(e) }
  }
}

/** 一条根藏 chunk 是否具备寻枝要用的最小字段；给了 expectedPersona 时必须同人格 */
function validChunk(c, expectedPersona = '') {
  return isObj(c)
    && c.kind === 'utterance'
    && typeof c.id === 'string' && c.id.length > 0
    && typeof c.session === 'string' && c.session.length > 0
    && typeof c.text === 'string'
    && typeof c.role === 'string'
    && Number.isFinite(Number(c.t))
    && (c.contractVersion === undefined || Number(c.contractVersion) <= CONTRACT_VERSION)
    && (!expectedPersona || !c.personaId || String(c.personaId) === String(expectedPersona))
}

/**
 * 读 chunks.jsonl。
 * 中间坏行 / 末尾半行 → corrupt_jsonl（带行号），**不跳过坏行硬查**。
 * 末尾缺换行但最后一行能完整解析 → 接受并给 note（不算坏行）。
 */
async function readChunksJsonl(file, expectedPersona = '') {
  let raw
  try { raw = await readFile(file, 'utf8') } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' ? 'chunks_missing' : 'read_error', detail: errText(e) }
  }
  if (!raw) return { ok: true, chunks: [], note: '' }
  const endsWithNL = raw.endsWith('\n')
  const lines = raw.split('\n')
  if (endsWithNL) lines.pop() // 去掉末尾换行留下的空元素
  const chunks = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      if (i === lines.length - 1) break // 容忍末尾空行
      return { ok: false, reason: 'corrupt_jsonl', line: i + 1, detail: 'empty line' }
    }
    let c
    try { c = JSON.parse(line) } catch (e) {
      return { ok: false, reason: 'corrupt_jsonl', line: i + 1, detail: errText(e) }
    }
    if (!validChunk(c, expectedPersona)) return { ok: false, reason: 'corrupt_jsonl', line: i + 1, detail: 'bad fields' }
    chunks.push(c)
  }
  return { ok: true, chunks, note: endsWithNL ? '' : 'missing trailing newline（最后一行可解析，已接受）' }
}

/**
 * Stage 0：读墓碑（按行序裁决 forget / revive）。
 * 读边界过滤用：被「显式忘记」的块不再进入检索。
 */
async function readForgottenIds(file) {
  let raw
  try { raw = await readFile(file, 'utf8') } catch { return new Set() }
  const state = new Map()
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row.id !== 'string' || !row.id) continue
    state.set(row.id, row.action === 'revive' ? 'revive' : 'forget')
  }
  const out = new Set()
  for (const [id, action] of state) if (action === 'forget') out.add(id)
  return out
}

/** 根藏 chunk → 寻枝 chunk（字段映射见交接书 §2.3） */
export function mapRootChunk(c) {
  return {
    // 根藏原生块 id：熏习 process/state.jsonl、duplicates.jsonl 都按这套 id 记账
    // （2026-11-11 补：此前漏映射，导致寻枝块对象无法与熏习数据对齐）
    chunkId: c.id || c.chunkId || null,
    session: c.session,
    ws: c.wsDir || c.ws || '',            // 会话目录名（寻枝展示层原本的 ws）
    wsPretty: c.ws || c.wsDir || '',      // 真实路径（寻枝展示用 wsPretty）
    msgId: c.messageId ?? null,           // 下钻/锚点
    seq: c.seq ?? null,
    part: Number.isInteger(c.part) ? c.part : 0,
    t: Number(c.t),
    role: c.role,
    sourceType: c.sourceType || (c.role === 'user' ? 'user' : 'assistant'),
    text: c.text,
    personaId: c.personaId || null,
  }
}

/** 嵌入口径自证：任何一项与寻枝当前配置不一致都不读（返回原因字符串） */
function embeddingMismatch(man, im, expect) {
  const e = expect || {}

  // 1) 根藏自身两本账必须自洽（manifest 是写入口径，index_meta 是当前生效口径）
  const manProvider = normalizeProvider(man.provider)
  const imProvider = normalizeProvider(im.provider)
  if (man.provider && im.provider && manProvider !== imProvider) {
    return `manifest.provider=${man.provider} ≠ index_meta.provider=${im.provider}`
  }
  const manModel = String(man.model || '').trim()
  const imModel = String(im.model || '').trim()
  if (manModel && imModel && manModel !== imModel) {
    return `manifest.model=${manModel} ≠ index_meta.model=${imModel}`
  }
  const manDim = Number(man.dim)
  const imDim = Number(im.dim)
  if (Number.isFinite(manDim) && Number.isFinite(imDim) && manDim !== imDim) {
    return `manifest.dim=${manDim} ≠ index_meta.dim=${imDim}`
  }
  const manNv = String(man.normalizerVersion || '')
  const imNv = String(im.normalizerVersion || '')
  if (manNv && imNv && manNv !== imNv) {
    return `manifest.normalizerVersion=${manNv} ≠ index_meta.normalizerVersion=${imNv}`
  }

  // 2) 与寻枝当前嵌入配置比对（调用方没给口径 = 不校验，保持默认 API 语义）
  const wantProvider = normalizeProvider(e.provider)
  if (!wantProvider) return null
  if (wantProvider === 'none') return 'plugin provider=none（字面模式）：根藏是语义库，不混用'
  const rootProvider = manProvider || imProvider
  if (rootProvider !== wantProvider) return `provider: root=${rootProvider || '(空)'} want=${wantProvider}`

  const wantModel = String(e.model || '').trim()
  const rootModel = manModel || imModel
  if (wantModel && !rootModel) return `model: 根藏缺 model（want=${wantModel}）`
  if (wantModel && rootModel !== wantModel) return `model: root=${rootModel} want=${wantModel}`

  const nv = manNv || imNv
  if (!nv) return 'normalizerVersion: 根藏缺 normalizerVersion'
  if (!NORMALIZERS.has(nv)) return `normalizerVersion: ${nv}`

  const unit = String(im.units || man.embeddingMeta?.unit || 'f32le').toLowerCase()
  if (!VECTOR_UNITS.has(unit)) return `units: ${unit}`

  const dim = imDim || manDim
  if (!Number.isInteger(dim) || dim <= 0) return `dim: 非法（manifest=${man.dim} index_meta=${im.dim}）`
  if (e.dim && Number(e.dim) !== dim) return `dim: root=${dim} want=${e.dim}`
  return null
}

/**
 * 探测根藏目录（不读 chunks / 向量，很快）。
 * @returns {{ok:boolean, rootDir:string, contractVersion:number|null, scopes:string[],
 *            personas:Array, degraded:boolean, reasons:string[]}}
 */
export async function probeRoot(rootDir) {
  const dir = String(rootDir || '').trim()
  const out = {
    ok: false, rootDir: dir, contractVersion: null, scopes: [], personas: [],
    degraded: true, reasons: [],
  }
  if (!dir) { out.reasons.push('root_missing'); return out }
  if (!isAbsolute(dir)) { out.reasons.push('root_missing'); out.detail = 'rootStore 必须是绝对路径'; return out }
  let ents
  try { ents = await readdir(join(dir, 'scopes'), { withFileTypes: true }) }
  catch (e) {
    out.reasons.push(e?.code === 'ENOENT' ? 'root_missing' : 'read_error')
    return out
  }
  out.scopes = ents.filter((d) => d.isDirectory()).map((d) => d.name).sort()
  for (const pid of out.scopes) {
    const manR = await readJson(join(dir, 'scopes', pid, 'manifest.json'), 'root_missing')
    if (!manR.ok) { out.personas.push({ personaId: pid, ok: false, reasons: [manR.reason] }); continue }
    const man = manR.value
    const reasons = []
    if (!isObj(man)) pushReason(reasons, 'corrupt_json')
    if (Number(man?.contractVersion) !== CONTRACT_VERSION) pushReason(reasons, 'contract_unsupported')
    if (String(man?.personaId || '') !== pid) pushReason(reasons, 'persona_mismatch')
    if (Number(man?.contractVersion) === CONTRACT_VERSION) out.contractVersion = CONTRACT_VERSION
    out.personas.push({ personaId: pid, ok: reasons.length === 0, contractVersion: man?.contractVersion ?? null, reasons })
  }
  out.ok = out.personas.some((p) => p.ok)
  for (const p of out.personas) for (const r of p.reasons) pushReason(out.reasons, r)
  out.degraded = !out.ok || out.reasons.length > 0
  return out
}

/**
 * 共享巡检：读 manifest/index_meta/chunks(+向量)，一路收集原因，不抛。
 * @param {boolean} loadVectors true=连向量一起读（查询）；false=只 stat（status）
 */
async function inspectRoot(rootDir, personaId, expect, { loadVectors, allowUnassigned = false }) {
  const dir = String(rootDir || '').trim()
  const pid = String(personaId || '').trim()
  const st = {
    ok: false, rootDir: dir, personaId: pid, contractVersion: null,
    provider: null, model: null, dim: 0, chunks: 0,
    vectorFile: null, vectorRows: null, vectorBytes: null,
    missing: null, badRows: null, alignmentBroken: false,
    builtAt: null, degraded: true, reasons: [], detail: null,
  }
  const fail = (reason, extra = {}) => {
    pushReason(st.reasons, reason)
    Object.assign(st, extra)
    return { ok: false, reasons: st.reasons, status: st, loaded: null }
  }

  if (!dir) return fail('root_missing')
  if (!isAbsolute(dir)) return fail('root_missing', { detail: 'rootStore 必须是绝对路径（不吃相对路径/`~`）' })
  if (!pid) return fail('persona_unmapped')
  // 契约：personaId 必须是稳定 slug；不合法/未归属一律不读（防 `../` 穿越）
  // 例外：软认领内部加载 persona_unassigned（allowUnassigned=true），它永远不能成为路由目标。
  if (pid === PERSONA_UNASSIGNED) {
    if (!allowUnassigned) return fail('persona_invalid', { detail: 'persona_unassigned 不能作为检索路由目标' })
  } else if (!isValidPersonaId(pid)) {
    return fail('persona_invalid', { detail: `personaId=${pid}` })
  }

  const scopesDir = join(dir, 'scopes')
  const scopeDir = join(scopesDir, pid)
  // 双保险：join 后仍在 <root>/scopes/ 下
  const rel = relative(scopesDir, scopeDir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return fail('persona_invalid', { detail: `scopeDir=${scopeDir}` })
  try {
    const s = await stat(scopeDir)
    if (!s.isDirectory()) return fail('persona_missing')
  } catch (e) {
    return fail(e?.code === 'ENOENT' ? 'persona_missing' : 'read_error', { detail: errText(e) })
  }

  const manR = await readJson(join(scopeDir, 'manifest.json'), 'root_missing')
  if (!manR.ok) return fail(manR.reason, { detail: manR.detail })
  const man = manR.value
  if (!isObj(man)) return fail('corrupt_json')
  st.contractVersion = Number(man.contractVersion) || null
  st.provider = man.provider || null
  st.model = man.model || null
  st.dim = Number(man.dim) || 0
  st.builtAt = man.builtAt || null
  if (Number(man.contractVersion) !== CONTRACT_VERSION) return fail('contract_unsupported')
  if (String(man.personaId || '') !== pid) return fail('persona_mismatch')

  const imR = await readJson(join(scopeDir, 'index_meta.json'), 'index_meta_missing')
  if (!imR.ok) return fail(imR.reason, { detail: imR.detail })
  const im = imR.value
  if (!isObj(im)) return fail('corrupt_json')
  st.dim = Number(im.dim || man.dim) || 0
  st.vectorFile = String(im.vectorFile || 'vectors_v1.f32')
  st.builtAt = man.builtAt || im.builtAt || null
  st.missing = Array.isArray(im.missingVectors) ? im.missingVectors.length : 0
  st.badRows = Array.isArray(im.badVectorRows) ? im.badVectorRows.length : 0

  const mism = embeddingMismatch(man, im, expect)
  if (mism) return fail('embedding_mismatch', { detail: mism })
  if (!Number.isInteger(st.dim) || st.dim <= 0) return fail('manifest_invalid')

  // 向量文件名只允许同级普通文件名（防路径穿越）
  if (/[\\/]/.test(st.vectorFile) || st.vectorFile.includes('..') || !st.vectorFile) {
    return fail('manifest_invalid', { detail: `vectorFile=${st.vectorFile}` })
  }

  const chR = await readChunksJsonl(join(scopeDir, 'chunks.jsonl'), pid)
  if (!chR.ok) return fail(chR.reason, { detail: chR.line ? `line ${chR.line}: ${chR.detail || ''}` : chR.detail })
  st.chunks = chR.chunks.length
  if (Number(im.count) !== st.chunks) {
    return fail('chunks_count_mismatch', { detail: `index_meta.count=${im.count} chunks=${st.chunks}` })
  }
  if (man.chunks !== undefined && Number(man.chunks) !== st.chunks) {
    return fail('chunks_count_mismatch', { detail: `manifest.chunks=${man.chunks} chunks=${st.chunks}` })
  }

  const vpath = join(scopeDir, st.vectorFile)
  let vst
  try { vst = await stat(vpath) } catch (e) {
    return fail(e?.code === 'ENOENT' ? 'vector_missing' : 'read_error', { detail: errText(e) })
  }
  st.vectorBytes = vst.size
  const rowBytes = st.dim * 4
  // 只允许「整行」；半行 = 文件被截断，拒绝（不静默截断）
  if (!Number.isFinite(rowBytes) || rowBytes <= 0 || vst.size % rowBytes !== 0) {
    return fail('vector_size_mismatch', { detail: `bytes=${vst.size} dim=${st.dim}（不是整行）` })
  }
  const rows = vst.size / rowBytes
  if (rows > st.chunks) {
    return fail('vector_size_mismatch', { detail: `rows=${rows} > chunks=${st.chunks}` })
  }
  st.vectorRows = rows
  // 根藏 v1 增量摄取只追加文本 → 向量只覆盖前缀；尾部新块走字面，不整库回退
  st.missing = Math.max(Number(st.missing) || 0, st.chunks - rows)
  if (rows === 0 && st.chunks > 0) {
    return fail('vector_missing', { detail: '向量文件为空，无法做语义检索' })
  }
  if (rows < st.chunks) pushReason(st.reasons, 'vector_partial')
  else if (st.missing > 0) pushReason(st.reasons, 'vector_missing')
  if (st.badRows > 0) pushReason(st.reasons, 'vector_bad_rows')
  if (im.alignmentBroken === true || (im.alignment && im.alignment.ok === false)) {
    pushReason(st.reasons, 'vector_alignment_broken')
  }
  st.alignmentBroken = Boolean(im.alignmentBroken === true || (im.alignment && im.alignment.ok === false))

  if (!loadVectors) {
    st.ok = true
    st.degraded = st.reasons.length > 0
    return { ok: true, reasons: st.reasons, status: st, loaded: null }
  }

  let buf
  try { buf = await readFile(vpath) } catch (e) { return fail('read_error', { detail: errText(e) }) }
  // 整行时直接视图（避免大库多复制 60MB+）；不对齐才复制到独立 ArrayBuffer
  const asF32 = (b) => {
    if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
    const ab = new ArrayBuffer(b.byteLength)
    new Uint8Array(ab).set(b)
    return new Float32Array(ab)
  }
  let vecs
  if (rows === st.chunks) {
    vecs = asF32(buf)
  } else {
    // 前缀：分配满长度，尾部补零（新块没有向量 → 余弦 0，只能走字面）
    vecs = new Float32Array(st.chunks * st.dim)
    vecs.set(asF32(buf), 0)
  }

  let mapped = chR.chunks.map(mapRootChunk)
  // Stage 0：显式忘记的块不进入检索；按行号同时过滤向量，保持行对齐
  const forgotten = await readForgottenIds(join(scopeDir, 'deleted.jsonl'))
  if (forgotten.size && st.dim > 0) {
    const keep = []
    for (let i = 0; i < chR.chunks.length; i++) if (!forgotten.has(chR.chunks[i].id)) keep.push(i)
    if (keep.length !== chR.chunks.length) {
      const filtered = new Float32Array(keep.length * st.dim)
      for (let k = 0; k < keep.length; k++) {
        const src = keep[k] * st.dim
        filtered.set(vecs.subarray(src, src + st.dim), k * st.dim)
      }
      mapped = keep.map((i) => mapped[i])
      vecs = filtered
      st.chunks = keep.length
    }
  }
  st.forgotten = forgotten.size

  const meta = {
    ...man,
    provider: man.provider || im.provider || null,
    model: man.model || im.model || null,
    dim: st.dim,
    chunks: mapped,
    builtAt: man.builtAt || im.builtAt || null,
    source: 'root',
    personaId: pid,
    rootDir: dir,
    rootDegraded: st.reasons.length > 0,
    rootReasons: st.reasons.slice(),
    forgotten: forgotten.size,
  }
  st.ok = true
  st.degraded = st.reasons.length > 0
  return {
    ok: true,
    reasons: st.reasons,
    status: st,
    loaded: { meta, vecs, dim: st.dim, count: st.chunks },
  }
}

/**
 * 根藏索引只读缓存（P2，2026-11-12）。
 * 自动召回每回合都要 loadRootIndex；不缓存就是每回合重读 100MB+ 向量。
 * 只缓存成功结果；键包含元数据与向量文件的 mtime/size，任何写入都会换键。
 */
const LOAD_CACHE = new Map()
const LOAD_CACHE_MAX = 2

async function rootLoadSig(dir, pid, expect) {
  const scopeDir = join(dir, 'scopes', pid)
  const parts = [dir, pid, expect?.provider || '', expect?.model || '', String(expect?.dim || '')]
  for (const n of ['manifest.json', 'index_meta.json', 'chunks.jsonl', 'deleted.jsonl']) {
    try { const s = await stat(join(scopeDir, n)); parts.push(`${n}:${s.mtimeMs}:${s.size}`) }
    catch { parts.push(`${n}:-`) }
  }
  let vfiles = []
  try { vfiles = (await readdir(scopeDir)).filter((n) => /^vectors_v\d+\.f32$/.test(n)).sort() } catch { /* 读不到就只用元数据签名 */ }
  for (const n of vfiles) {
    try { const s = await stat(join(scopeDir, n)); parts.push(`${n}:${s.mtimeMs}:${s.size}`) }
    catch { parts.push(`${n}:-`) }
  }
  return parts.join('|')
}

/** 清空根藏索引缓存（测试 / 手动排障用） */
export function clearRootLoadCache() { LOAD_CACHE.clear() }

// ── 软认领（P4 #9，2026-11-12）─────────────────────────────────────────────
// 读 identity.json 的 workspaces：把「identity 已明确归给该人格、但历史块还留在
// persona_unassigned」的原话影子纳入检索。只读、零迁移、删除映射即回退。
const SOFT_CACHE = new Map()
const SOFT_CACHE_MAX = 2

/** 清空软认领合并缓存（测试 / 手动排障用） */
export function clearSoftClaimCache() { SOFT_CACHE.clear() }

function softTargetsFor(workspaces, pid) {
  const out = []
  for (const [ws, who] of Object.entries(workspaces || {})) {
    if (String(who) === pid) {
      const n = normWsPath(ws)
      if (n) out.push(n)
    }
  }
  return [...new Set(out)]
}

/**
 * 将 persona_unassigned 中属于该人格工作区的块并入 loaded（不写任何文件）。
 * 无映射 / 无未归属块 / 读取失败 → 原样返回 base。
 */
async function applySoftClaim(rootDir, pid, base, baseKey, expect) {
  let ident
  try { ident = await readJson(join(rootDir, 'identity.json'), 'identity_missing') } catch { ident = { ok: false } }
  if (!ident.ok) return base
  const targets = softTargetsFor(ident.value?.workspaces, pid)
  if (!targets.length) return base

  let sig = `${pid}|${String(baseKey || '')}`
  try {
    const st = await stat(join(rootDir, 'identity.json'))
    sig += `|identity:${st.mtimeMs}:${st.size}`
    sig += `|unassigned:${await rootLoadSig(rootDir, PERSONA_UNASSIGNED, expect)}`
  } catch { return base }
  const hit = SOFT_CACHE.get(sig)
  if (hit) {
    SOFT_CACHE.delete(sig)
    SOFT_CACHE.set(sig, hit)
    return hit
  }

  const u = await loadRootIndex(rootDir, PERSONA_UNASSIGNED, expect, { allowUnassigned: true, softClaim: false })
  if (!u.ok || !u.loaded) return base
  const baseChunks = base.loaded.meta.chunks
  const baseN = baseChunks.length
  // 新人格可能还没有自己的 scope（base 为空壳，dim=0）；此时用未归属桶的维度。
  const dim = base.loaded.dim || u.loaded.dim
  if (!dim) return base
  const extraChunks = []
  const extraRows = []
  const uChunks = u.loaded.meta.chunks
  for (let i = 0; i < uChunks.length; i++) {
    const c = uChunks[i]
    if (c.personaId && String(c.personaId) !== PERSONA_UNASSIGNED) continue
    if (!wsMatches(c.wsPretty || c.ws, targets)) continue
    extraChunks.push({ ...c, softClaimed: true })
    extraRows.push(i)
  }
  if (!extraChunks.length) {
    SOFT_CACHE.set(sig, base)
    while (SOFT_CACHE.size > SOFT_CACHE_MAX) SOFT_CACHE.delete(SOFT_CACHE.keys().next().value)
    return base
  }

  const total = baseN + extraChunks.length
  const vecs = new Float32Array(total * dim)
  vecs.set(base.loaded.vecs.subarray(0, baseN * dim), 0)
  for (let k = 0; k < extraRows.length; k++) {
    const src = extraRows[k] * dim
    vecs.set(u.loaded.vecs.subarray(src, src + dim), (baseN + k) * dim)
  }
  const loaded = {
    ...base.loaded,
    vecs,
    count: total,
    meta: {
      ...base.loaded.meta,
      chunks: baseChunks.concat(extraChunks),
      softClaimed: extraChunks.length,
      softClaimWorkspaces: targets.slice(),
      rootReasons: [...(base.loaded.meta.rootReasons || []), 'soft_claim'],
    },
  }
  const out = { ...base, loaded, softClaim: { applied: true, chunks: extraChunks.length, workspaces: targets.slice() } }
  SOFT_CACHE.set(sig, out)
  while (SOFT_CACHE.size > SOFT_CACHE_MAX) SOFT_CACHE.delete(SOFT_CACHE.keys().next().value)
  return out
}

/**
 * 读根藏某个 persona 的完整索引（→ rankQuery 需要的 loaded 形状）。
 * 永不抛；失败返回 { ok:false, reasons:[...], status }。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.softClaim=true] 是否把 persona_unassigned 里属于该人格工作区的块影子纳入
 * @param {boolean} [opts.allowUnassigned=false] 仅供软认领内部读 persona_unassigned
 */
export async function loadRootIndex(rootDir, personaId, expect = {}, opts = {}) {
  const dir = String(rootDir || '').trim()
  const pid = String(personaId || '').trim()
  const allowUnassigned = opts.allowUnassigned === true
  const wantSoft = opts.softClaim !== false && !allowUnassigned && pid !== PERSONA_UNASSIGNED
  let key = null
  if (dir && pid) {
    try { key = await rootLoadSig(dir, pid, expect) } catch { key = null }
    if (key) {
      const hit = LOAD_CACHE.get(key)
      if (hit) {
        // LRU：命中后挪到队尾
        LOAD_CACHE.delete(key)
        LOAD_CACHE.set(key, hit)
        return wantSoft ? applySoftClaim(dir, pid, hit, key, expect) : hit
      }
    }
  }
  const r = await inspectRoot(rootDir, personaId, expect, { loadVectors: true, allowUnassigned })
  if (!r.ok) {
    // 2026-11-13：新人格还没有自己的 scope（目录/manifest 缺失）时，软认领仍应生效——
    // 「建卡没记忆」最典型的现场就是：identity 已映射，但该人格一条新对话都还没落库。
    // 用一个空壳 base 走同一套 applySoftClaim；拿不到旧块就原样返回失败，不改变旧行为。
    const reasons = r.reasons || []
    if (wantSoft && (reasons.includes('persona_missing') || reasons.includes('root_missing'))) {
      const empty = {
        ok: true,
        loaded: {
          meta: {
            personaId: pid, source: 'root', rootDir: dir,
            rootDegraded: true, rootReasons: reasons.slice(), softClaimed: 0,
            chunks: [],
          },
          vecs: new Float32Array(0), dim: 0, count: 0,
        },
        reasons: [],
        degraded: true,
        status: { ...r.status, ok: true, degraded: true, reasons: [] },
      }
      const merged = await applySoftClaim(dir, pid, empty, key, expect)
      if (merged?.softClaim?.applied && Number(merged.loaded?.count) > 0) return merged
    }
    return { ok: false, reasons: r.reasons, status: r.status, loaded: null }
  }
  const out = {
    ok: true, loaded: r.loaded, reasons: r.reasons,
    degraded: r.status.degraded, status: r.status,
  }
  if (key && out.ok) {
    LOAD_CACHE.set(key, out)
    while (LOAD_CACHE.size > LOAD_CACHE_MAX) LOAD_CACHE.delete(LOAD_CACHE.keys().next().value)
  }
  return wantSoft ? applySoftClaim(dir, pid, out, key, expect) : out
}

/** 根藏某 persona 的状态（不读向量正文，快；status 用） */
export async function rootStatus(rootDir, personaId, expect = {}) {
  const r = await inspectRoot(rootDir, personaId, expect, { loadVectors: false })
  return { ...r.status, ok: r.ok, reasons: r.reasons }
}

/**
 * 数据源决议：根藏优先，失败回退自带索引。
 * 这是 index.js 唯一需要调用的入口 —— 验收脚本也直接测它。
 *
 * @param {object} o
 * @param {string} o.rootDir      根藏 dataRoot（空 = 不用根藏）
 * @param {'auto'|'off'} o.rootMode
 * @param {string|null} o.scope   当前库（源 id）
 * @param {Array} o.sources       parseSources() 结果（带 personaId 时优先）
 * @param {object} o.expect       { provider, model, dim? }
 * @param {boolean} [o.softClaim=true] 软认领：影子纳入 persona_unassigned 中属于该人格工作区的旧块
 * @param {Function} o.loadSelf   () => 自带索引（loadIndex(scope)）
 * @returns {{loaded:object|null, dataSource:'root'|'fallback'|'self',
 *            fallbackReason:string|null, root:object|null}}
 */
export async function resolveLoadedSource({ rootDir, rootMode = 'auto', scope = null, sources = [], expect = {}, softClaim = true, loadSelf }) {
  const dir = String(rootDir || '').trim()
  const self = async () => ({ loaded: await loadSelf(), dataSource: 'self', fallbackReason: null, root: null })
  if (!dir || String(rootMode || 'auto').toLowerCase() === 'off') return self()

  const personaId = personaForScope(scope, sources)
  if (!personaId) {
    return {
      loaded: await loadSelf(), dataSource: 'fallback',
      fallbackReason: 'persona_unmapped',
      root: { ok: false, personaId: null, reasons: ['persona_unmapped'], degraded: true },
    }
  }
  const r = await loadRootIndex(dir, personaId, expect, { softClaim: softClaim !== false })
  if (r.ok) {
    return {
      loaded: r.loaded, dataSource: 'root', fallbackReason: null,
      root: { ok: true, personaId, reasons: r.reasons, degraded: r.degraded, softClaim: r.softClaim || null },
    }
  }
  return {
    loaded: await loadSelf(), dataSource: 'fallback',
    fallbackReason: r.reasons[0] || 'root_missing',
    root: { ok: false, personaId, reasons: r.reasons, degraded: true, detail: r.status?.detail || null },
  }
}
