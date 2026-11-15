/**
 * lib/vectors.mjs —— 向量文件（小端 Float32，行 = chunk，紧密排列）
 *
 * 纪律（D2/D4/F10/F11）：
 *   · 行序与 chunks.jsonl 严格一致；行数 × 维度 × 4 = 文件字节数，否则拒绝使用；
 *   · 非有限值（NaN/Inf）置 0 并计入 badRows（告警，不静默）；
 *   · 模长 < 1e-10 记零向量，计入 badRows（占位保留行对齐，状态里报「需 reembed」）；
 *   · 归一化幂等：已归一化的向量再 normalize 不变；
 *   · 换模型/维度 → 新建 vectors_v<N+1>，旧的进 _archive（D4），不硬删。
 */
import { readFile } from 'node:fs/promises'
import { atomicWrite, fileSize } from './fsatomic.mjs'
import { StoreError, CODES } from './errors.mjs'
import { NORMALIZER_VERSION } from './version.mjs'

export const VECTOR_UNIT_BYTES = 4
export const EPS_ZERO = 1e-10

/** 行数 × 维度 × 4 */
export function expectedBytes(count, dim) {
  return count * dim * VECTOR_UNIT_BYTES
}

/**
 * 读向量文件并校验尺寸。
 * @returns {Promise<{ok:true, flat:Float32Array, count:number, dim:number, bytes:number}|{ok:false, code:string, error:object}>}
 */
export async function readVectorFile(file, { count, dim }) {
  const bytes = await fileSize(file)
  if (bytes < 0) return { ok: false, code: CODES.VECTOR_MISSING, error: { code: CODES.VECTOR_MISSING, message: `向量文件不存在：${file}` } }
  const want = expectedBytes(count, dim)
  if (bytes !== want) {
    return {
      ok: false,
      code: CODES.VECTOR_SIZE_MISMATCH,
      error: {
        code: CODES.VECTOR_SIZE_MISMATCH,
        message: `向量文件尺寸不符：${bytes} 字节，期望 ${want}（count=${count} × dim=${dim} × 4）`,
      },
    }
  }
  const buf = await readFile(file)
  // Buffer 可能是池化的：必须按 byteOffset/byteLength 切片，否则会读到别人的内存
  const flat = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  return { ok: true, flat, count, dim, bytes }
}

/** 取第 i 行（视图，不复制） */
export function rowAt(flat, i, dim) {
  return flat.subarray(i * dim, (i + 1) * dim)
}

/** 复制若干行成一个新的紧密 Float32Array（迁移拆分向量用） */
export function sliceRows(flat, indices, dim) {
  const out = new Float32Array(indices.length * dim)
  for (let k = 0; k < indices.length; k++) {
    const src = indices[k] * dim
    out.set(flat.subarray(src, src + dim), k * dim)
  }
  return out
}

/** Float32Array → Buffer（小端） */
export function vectorsToBuffer(flat) {
  const out = Buffer.allocUnsafe(flat.length * VECTOR_UNIT_BYTES)
  for (let i = 0; i < flat.length; i++) out.writeFloatLE(flat[i] || 0, i * VECTOR_UNIT_BYTES)
  return out
}

/** 写向量文件（原子写） */
export async function writeVectorFile(file, flat) {
  return atomicWrite(file, vectorsToBuffer(flat))
}

/** L2 模长 */
export function l2norm(vec) {
  let s = 0
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i]
  return Math.sqrt(s)
}

/** 归一化行内就地（幂等）；返回 {changed, bad} */
export function normalizeRowInPlace(vec) {
  let bad = null
  let s = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]
    if (!Number.isFinite(v)) { vec[i] = 0; bad = bad || 'non-finite' }
    else s += v * v
  }
  const n = Math.sqrt(s)
  if (n < EPS_ZERO) return { changed: bad !== null, norm: n, bad: bad || 'zero' }
  if (Math.abs(n - 1) > 1e-6) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / n
    return { changed: true, norm: n, bad: null }
  }
  return { changed: bad !== null, norm: n, bad: null }
}

/**
 * 体检整个向量文件（迁移/verify 用；**不修改**，只报告）。
 * @returns {{count:number, dim:number, badRows:Array<{index:number, reason:string}>, norms:{min:number,max:number,mean:number}, normalized:boolean}}
 */
export function inspectVectors(flat, dim) {
  const count = dim > 0 ? Math.floor(flat.length / dim) : 0
  const badRows = []
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let allNormalized = true
  for (let i = 0; i < count; i++) {
    const vec = flat.subarray(i * dim, (i + 1) * dim)
    let s = 0
    let nonFinite = false
    for (let k = 0; k < dim; k++) {
      const v = vec[k]
      if (!Number.isFinite(v)) { nonFinite = true; break }
      s += v * v
    }
    if (nonFinite) { badRows.push({ index: i, reason: 'non-finite' }); continue }
    const n = Math.sqrt(s)
    if (n < EPS_ZERO) { badRows.push({ index: i, reason: 'zero' }); continue }
    if (n < min) min = n
    if (n > max) max = n
    sum += n
    if (Math.abs(n - 1) > 1e-3) allNormalized = false
  }
  const good = count - badRows.length
  return {
    count,
    dim,
    badRows,
    norms: {
      min: Number.isFinite(min) ? Number(min.toFixed(6)) : null,
      max: Number.isFinite(max) ? Number(max.toFixed(6)) : null,
      mean: good > 0 ? Number((sum / good).toFixed(6)) : null,
    },
    // 0 行是空集，不存在「未归一化」的行（否则空 scope 会被误报 VECTOR_NOT_NORMALIZED）
    normalized: count === 0 ? true : (good > 0 && allNormalized),
  }
}

/** 逐行字节相等（迁移校验用；直接比对 Float32 值，避免 -0/NaN 的字节歧义） */
export function rowsEqual(a, b, dim) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (Number.isNaN(x) && Number.isNaN(y)) continue
    if (x !== y) return false
  }
  return true
}

/** 维度/模型/归一化口径不一致 → 「需重嵌」（D1 不静默继续） */
export function embeddingCompatible(manifest, want) {
  if (!manifest) return { ok: false, reason: 'manifest_missing' }
  if (Number(manifest.dim) !== Number(want.dim)) return { ok: false, reason: 'dim_changed' }
  if (String(manifest.model || '') !== String(want.model || '')) return { ok: false, reason: 'model_changed' }
  if (String(manifest.provider || '') !== String(want.provider || '')) return { ok: false, reason: 'provider_changed' }
  if (String(manifest.normalizerVersion || '') !== String(want.normalizerVersion || NORMALIZER_VERSION)) {
    return { ok: false, reason: 'normalizer_changed' }
  }
  return { ok: true }
}

/** 建 manifest 用的 embedding 块 */
export function embeddingBlock({ provider = '', model = '', dim = 0, normalizerVersion = NORMALIZER_VERSION }) {
  return { provider, model, dim: Number(dim) || 0, normalizerVersion }
}

export function assertVectorCount(count, rows, dim) {
  const want = expectedBytes(count, dim)
  const got = rows * dim * VECTOR_UNIT_BYTES
  if (want !== got) {
    throw new StoreError(CODES.VECTOR_SIZE_MISMATCH, `向量行数不符：期望 ${count} 行，实得 ${rows}`, { count, rows, dim })
  }
}
