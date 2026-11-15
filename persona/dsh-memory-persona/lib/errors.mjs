/**
 * lib/errors.mjs —— 镜台错误码
 *
 * 原则同根藏/熏习：落盘失败绝不回报 ok；错误必须带 code；降级不抛，但原因可见。
 */

export const CODES = {
  // 路径 / 环境
  BAD_CARD_ID: 'BAD_CARD_ID',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  READ_ONLY_ROOT: 'READ_ONLY_ROOT',
  READ_ONLY_V1A: 'READ_ONLY_V1A',
  DATA_ROOT_INVALID: 'DATA_ROOT_INVALID',

  // 读写
  WRITE_ATOMIC_FAILED: 'WRITE_ATOMIC_FAILED',
  WRITE_EXCLUSIVE_FAILED: 'WRITE_EXCLUSIVE_FAILED',
  READ_FAILED: 'READ_FAILED',
  JSON_PARSE: 'JSON_PARSE',
  JSONL_CORRUPT: 'JSONL_CORRUPT',
  READBACK_MISMATCH: 'READBACK_MISMATCH',
  PARTIAL_WRITE: 'PARTIAL_WRITE',
  LOCK_BUSY: 'LOCK_BUSY',

  // 契约 / 版本
  CONTRACT_UNSUPPORTED: 'CONTRACT_UNSUPPORTED',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  CARD_EXISTS: 'CARD_EXISTS',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  STALE_GENERATION: 'STALE_GENERATION',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',

  // 卡片
  CARD_PARSE_FAILED: 'CARD_PARSE_FAILED',
  CARD_ID_MISMATCH: 'CARD_ID_MISMATCH',
  IMMUTABLE_SECTION_CHANGED: 'IMMUTABLE_SECTION_CHANGED',
  ZONE_FRAGMENTED: 'ZONE_FRAGMENTED',
  ZONE_UNKNOWN: 'ZONE_UNKNOWN',
  UNKNOWN_PERSONA: 'UNKNOWN_PERSONA',
  DEFAULT_CARD_PROTECTED: 'DEFAULT_CARD_PROTECTED',
  BAD_BINDING: 'BAD_BINDING',

  // 导入
  SOULMD_UNAVAILABLE: 'SOULMD_UNAVAILABLE',
  IMPORT_NOTHING: 'IMPORT_NOTHING',
  IMPORT_CARD_UNMAPPED: 'IMPORT_CARD_UNMAPPED',

  // AI 生成
  EMPTY_SEED: 'EMPTY_SEED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  NO_MODEL_ROUTE: 'NO_MODEL_ROUTE',
  LLM_FAILED: 'LLM_FAILED',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  SCAN_RED: 'SCAN_RED',
  EXPAND_FAILED: 'EXPAND_FAILED',
  EDITOR_UNTOUCHED: 'EDITOR_UNTOUCHED',
  PROTECTED_SECTION_CHANGED: 'PROTECTED_SECTION_CHANGED',

  // 通用
  DISABLED: 'DISABLED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  ANON_UNRESOLVED: 'ANON_UNRESOLVED',
  INIT_FAILED: 'INIT_FAILED',
}

export class PersonaError extends Error {
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'PersonaError'
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
  if (e instanceof PersonaError) return { code: e.code, message: e.message, detail: e.detail ?? null }
  return { code: e.code || 'UNKNOWN', message: String(e.message || e) }
}

export function fail(code, message, detail) {
  return { ok: false, code, error: toErrInfo(new PersonaError(code, message, detail)) }
}
