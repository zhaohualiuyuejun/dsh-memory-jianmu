/**
 * lib/errors.mjs —— 年轮错误码
 *
 * 原则同根藏/熏习：落盘失败绝不回报 ok；错误必须带 code；降级不抛，但原因可见。
 */

export const CODES = {
  // 路径 / 环境
  BAD_PERSONA_ID: 'BAD_PERSONA_ID',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  REALPATH_ESCAPE: 'REALPATH_ESCAPE',
  SYMLINK_TARGET: 'SYMLINK_TARGET',
  READ_ONLY_ROOT: 'READ_ONLY_ROOT',
  SCOPE_NOT_FOUND: 'SCOPE_NOT_FOUND',

  // 读写
  WRITE_ATOMIC_FAILED: 'WRITE_ATOMIC_FAILED',
  READ_FAILED: 'READ_FAILED',
  JSON_PARSE: 'JSON_PARSE',
  JSONL_CORRUPT: 'JSONL_CORRUPT',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  LOCK_BUSY: 'LOCK_BUSY',

  // 契约 / 版本
  CONTRACT_UNSUPPORTED: 'CONTRACT_UNSUPPORTED',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  STALE_GENERATION: 'STALE_GENERATION',
  STALE_ROOT: 'STALE_ROOT',

  // 年轮
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND',
  CLAIM_INVALID: 'CLAIM_INVALID',
  ANCHOR_INVALID: 'ANCHOR_INVALID',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  CROSS_PERSONA: 'CROSS_PERSONA',
  SCAN_REJECTED: 'SCAN_REJECTED',
  TOPIC_NOT_FOUND: 'TOPIC_NOT_FOUND',

  // 运行
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  LLM_DISABLED: 'LLM_DISABLED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_FAILED: 'LLM_FAILED',
  LLM_JSON_INVALID: 'LLM_JSON_INVALID',
  LLM_TRUNCATED: 'LLM_TRUNCATED',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  RUN_IN_PROGRESS: 'RUN_IN_PROGRESS',
  NOTHING_TO_DO: 'NOTHING_TO_DO',
  WRITE_DISABLED: 'WRITE_DISABLED',
  PERSONA_UNRESOLVED: 'PERSONA_UNRESOLVED',
  RUN_FAILED: 'RUN_FAILED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  DATA_CORRUPT: 'DATA_CORRUPT',
  REBUILD_FAILED: 'REBUILD_FAILED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  BAD_EXPORT_PATH: 'BAD_EXPORT_PATH',
}

export class YearError extends Error {
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'YearError'
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
  if (e instanceof YearError) return { code: e.code, message: e.message, detail: e.detail ?? null }
  return { code: e.code || 'UNKNOWN', message: String(e.message || e) }
}

export function fail(code, message, detail) {
  return { ok: false, error: toErrInfo(new YearError(code, message, detail)) }
}
