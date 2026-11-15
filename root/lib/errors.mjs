/**
 * lib/errors.mjs —— 根藏的错误码
 *
 * 原则（附录 F1/F8/F9）：
 *   · 落盘失败绝不回报 ok；
 *   · 错误必须带 code，调用方/status 能看懂；
 *   · 降级不抛（D9），但降级原因必须可见（D10）。
 */

export const CODES = {
  // 路径 / 环境
  BAD_PERSONA_ID: 'BAD_PERSONA_ID',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  READ_ONLY_SOURCE: 'READ_ONLY_SOURCE',

  // 读写
  WRITE_ATOMIC_FAILED: 'WRITE_ATOMIC_FAILED',
  WRITE_EXCLUSIVE_FAILED: 'WRITE_EXCLUSIVE_FAILED',
  READ_FAILED: 'READ_FAILED',
  JSON_PARSE: 'JSON_PARSE',
  JSONL_CORRUPT: 'JSONL_CORRUPT',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  LOCK_BUSY: 'LOCK_BUSY',

  // 契约 / 版本
  CONTRACT_UNSUPPORTED: 'CONTRACT_UNSUPPORTED',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  PERSONA_DIR_MISMATCH: 'PERSONA_DIR_MISMATCH',
  MANIFEST_INVALID: 'MANIFEST_INVALID',

  // 向量
  VECTOR_SIZE_MISMATCH: 'VECTOR_SIZE_MISMATCH',
  VECTOR_BAD_ROW: 'VECTOR_BAD_ROW',
  VECTOR_MISSING: 'VECTOR_MISSING',
  EMBEDDING_MISMATCH: 'EMBEDDING_MISMATCH',
  EMBED_NOT_CONFIGURED: 'EMBED_NOT_CONFIGURED',

  // 迁移
  MIGRATE_SOURCE_INVALID: 'MIGRATE_SOURCE_INVALID',
  MIGRATE_COUNT_MISMATCH: 'MIGRATE_COUNT_MISMATCH',
  MIGRATE_TEXT_MISMATCH: 'MIGRATE_TEXT_MISMATCH',
  MIGRATE_ANCHOR_MISMATCH: 'MIGRATE_ANCHOR_MISMATCH',
  MIGRATE_PERSONA_MISMATCH: 'MIGRATE_PERSONA_MISMATCH',
  MIGRATE_VECTOR_MISMATCH: 'MIGRATE_VECTOR_MISMATCH',

  // 摄取
  INGEST_DISABLED: 'INGEST_DISABLED',
  INGEST_NOT_IMPLEMENTED: 'INGEST_NOT_IMPLEMENTED',
  INGEST_FAILED: 'INGEST_FAILED',

  // 初始化
  INIT_FAILED: 'INIT_FAILED',
  IDENTITY_MISSING: 'IDENTITY_MISSING',
  IDENTITY_CORRUPT: 'IDENTITY_CORRUPT',
}

export class StoreError extends Error {
  /**
   * @param {keyof CODES} code
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'StoreError'
    this.code = String(code)
    this.detail = detail
  }
  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail ?? null }
  }
}

/** 把任意异常归一成 {code,message}，不丢原始信息 */
export function toErrInfo(e) {
  if (!e) return { code: 'UNKNOWN', message: 'unknown error' }
  if (e instanceof StoreError) return { code: e.code, message: e.message, detail: e.detail ?? null }
  return { code: e.code || 'UNKNOWN', message: String(e.message || e) }
}

/** 错误不抛时用：统一成 {ok:false, error:{...}} */
export function fail(code, message, detail) {
  return { ok: false, error: toErrInfo(new StoreError(code, message, detail)) }
}
