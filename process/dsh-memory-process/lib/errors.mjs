/**
 * lib/errors.mjs —— 熏习错误码
 *
 * 原则同根藏：落盘失败绝不回报 ok；错误必须带 code；降级不抛，但原因可见。
 */

export const CODES = {
  // 路径 / 环境
  BAD_PERSONA_ID: 'BAD_PERSONA_ID',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  READ_ONLY_ROOT: 'READ_ONLY_ROOT',
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  SCOPE_NOT_FOUND: 'SCOPE_NOT_FOUND',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',

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

  // 处理
  PENDING_NOT_FOUND: 'PENDING_NOT_FOUND',
  PENDING_NOT_PENDING: 'PENDING_NOT_PENDING',
  CHUNK_NOT_FOUND: 'CHUNK_NOT_FOUND',
  BAD_APPLY_ID: 'BAD_APPLY_ID',
  BAD_EXPORT_PATH: 'BAD_EXPORT_PATH',
  REBUILD_USER_STATE_PRESENT: 'REBUILD_USER_STATE_PRESENT',
  PERSONA_UNRESOLVED: 'PERSONA_UNRESOLVED',
  STALE_GENERATION: 'STALE_GENERATION',
  STALE_ROOT: 'STALE_ROOT',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  APPLY_FAILED: 'APPLY_FAILED',
  RUN_FAILED: 'RUN_FAILED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  REBUILD_FAILED: 'REBUILD_FAILED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  LLM_DISABLED: 'LLM_DISABLED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',

  // 初始化
  INIT_FAILED: 'INIT_FAILED',
}

export class ProcessError extends Error {
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'ProcessError'
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
  if (e instanceof ProcessError) return { code: e.code, message: e.message, detail: e.detail ?? null }
  return { code: e.code || 'UNKNOWN', message: String(e.message || e) }
}

export function fail(code, message, detail) {
  return { ok: false, error: toErrInfo(new ProcessError(code, message, detail)) }
}
