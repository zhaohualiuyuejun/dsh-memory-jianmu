/**
 * lib/manifest.mjs —— manifest.json / index_meta.json（契约 §3、D1/D4/F12/F14）
 *
 * manifest 自证：provider / model / dim / normalizerVersion 任一变化 → 标「需重嵌」，
 * 绝不静默继续（D1）。读取方发现 contractVersion > 本程序 → 拒绝写（契约 §4-3）。
 */
import { CONTRACT_VERSION, SCHEMA_VERSION, WRITER, NORMALIZER_VERSION } from './version.mjs'
import { isSafePersonaId, PERSONA_UNASSIGNED } from './paths.mjs'
import { CODES } from './errors.mjs'

export const MANIFEST_REQUIRED = Object.freeze([
  'schemaVersion', 'contractVersion', 'generation', 'personaId', 'provider', 'model', 'dim',
  'normalizerVersion', 'chunks', 'builtAt',
])

/**
 * @param {object} p
 * @param {string} p.personaId
 * @param {string|null} [p.displayName]
 * @param {string} p.identitySource
 * @param {{provider?:string, model?:string, dim?:number, normalizerVersion?:string}} [p.embedding]
 * @param {{chunks:number, sessions?:number, workspaces?:number, tMin?:number|null, tMax?:number|null}} p.counts
 * @param {number} [p.retentionDays]
 */
export function buildManifest(p) {
  const emb = p.embedding || {}
  return {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    generation: Number.isInteger(p.generation) && p.generation > 0 ? p.generation : 1,
    personaId: p.personaId,
    displayName: p.displayName ?? null,
    identitySource: p.identitySource || 'unassigned',
    provider: emb.provider || '',
    model: emb.model || '',
    dim: Number(emb.dim) || 0,
    normalizerVersion: emb.normalizerVersion || NORMALIZER_VERSION,
    tokenizerVersion: emb.tokenizerVersion || null,
    embeddingMeta: {
      provider: emb.provider || '',
      model: emb.model || '',
      dim: Number(emb.dim) || 0,
      normalizerVersion: emb.normalizerVersion || NORMALIZER_VERSION,
      unit: 'f32le',
      source: emb.source || 'migrated',
    },
    chunks: Number(p.counts?.chunks) || 0,
    sessions: Number(p.counts?.sessions) || 0,
    workspaces: Number(p.counts?.workspaces) || 0,
    tMin: p.counts?.tMin ?? null,
    tMax: p.counts?.tMax ?? null,
    retentionDays: Number(p.retentionDays) || 30,
    builtAt: new Date().toISOString(),
    writer: { ...WRITER },
  }
}

/** 校验 manifest；返回错误数组。 */
export function validateManifest(m, opts = {}) {
  const errs = []
  if (!m || typeof m !== 'object') return ['manifest 不是对象']
  for (const k of MANIFEST_REQUIRED) if (m[k] === undefined) errs.push(`缺少字段 ${k}`)
  if (m.schemaVersion > SCHEMA_VERSION) errs.push(`schemaVersion ${m.schemaVersion} > 本程序 ${SCHEMA_VERSION}`)
  if (m.contractVersion !== CONTRACT_VERSION) {
    errs.push(`contractVersion 不兼容：库=${m.contractVersion}，本程序=${CONTRACT_VERSION}`)
  }
  if (m.personaId !== PERSONA_UNASSIGNED && !isSafePersonaId(m.personaId)) errs.push(`personaId 非法：${m.personaId}`)
  if (m.dim != null && ![0, 4096, 1024, 768, 1536, 3072].includes(Number(m.dim))) {
    // 不锁死维度（换模型可以有别的维度），只要求是正整数
    if (!(Number.isInteger(Number(m.dim)) && Number(m.dim) > 0)) errs.push(`dim 非法：${m.dim}`)
  }
  if (opts.expectPersonaId && m.personaId !== opts.expectPersonaId) {
    errs.push(`manifest.personaId（${m.personaId}）与目录（${opts.expectPersonaId}）不一致`)
  }
  if (!Number.isFinite(Date.parse(m.builtAt))) errs.push(`builtAt 不是合法时间：${m.builtAt}`)
  return errs
}

/**
 * 读取并校验；不合法 → 明确错误（F8 不回落默认值）。
 * @returns {Promise<{ok:true, manifest:object}|{ok:false, code:string, error:object}>}
 */
export function assertManifestUsable(m, opts = {}) {
  const errs = validateManifest(m, opts)
  if (!errs.length) return { ok: true, manifest: m }
  const code = errs.some((e) => e.startsWith('contractVersion')) ? CODES.CONTRACT_UNSUPPORTED : CODES.MANIFEST_INVALID
  return { ok: false, code, error: { code, message: errs.join('；'), errors: errs } }
}

/** manifest 自检：与期望嵌入参数是否一致（D1） */
export function manifestEmbeddingState(m, want) {
  if (!m) return { ok: false, reason: 'manifest_missing', reembed: false }
  const diffs = []
  if (Number(m.dim) !== Number(want.dim)) diffs.push('dim')
  if (String(m.model || '') !== String(want.model || '')) diffs.push('model')
  if (String(m.provider || '') !== String(want.provider || '')) diffs.push('provider')
  if (String(m.normalizerVersion || '') !== String(want.normalizerVersion || NORMALIZER_VERSION)) diffs.push('normalizerVersion')
  return { ok: diffs.length === 0, reason: diffs.length ? `embedding_changed:${diffs.join(',')}` : null, reembed: diffs.length > 0, diffs }
}

/**
 * index_meta.json：指向当前生效的向量文件（D4/F12）
 */
export function buildIndexMeta(p) {
  return {
    vectorFile: `vectors_v${p.vectorVersion || 1}.f32`,
    vectorVersion: Number(p.vectorVersion) || 1,
    units: 'f32le',
    dim: Number(p.dim) || 0,
    count: Number(p.count) || 0,
    provider: p.provider || '',
    model: p.model || '',
    normalizerVersion: p.normalizerVersion || NORMALIZER_VERSION,
    tokenizerVersion: p.tokenizerVersion || null,
    missingVectors: Array.isArray(p.missingVectors) ? p.missingVectors : [],
    badVectorRows: Array.isArray(p.badVectorRows) ? p.badVectorRows : [],
    builtAt: new Date().toISOString(),
    writer: { ...WRITER },
  }
}
