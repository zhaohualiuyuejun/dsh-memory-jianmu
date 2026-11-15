/**
 * lib/version.mjs —— 镜台的版本与工具面常量（契约 v1 冻结）
 *
 * 工具面只允许 jianmu_persona_*，且不得含 recall/search/query（检索归寻枝）。
 */

export const VERSION = '0.3.8'
export const SCHEMA_VERSION = 1
export const CONTRACT_VERSION = 1
export const ROOT_CONTRACT_VERSION = 1
export const PROCESS_CONTRACT_VERSION = 1

export const TOOL_PREFIX = 'jianmu_persona_'
export const FORBIDDEN_TOOL_WORDS = Object.freeze(['recall', 'search', 'query'])

/** v1a 实际注册的工具面：15 件 + v2 记忆读写 3 件（建木自治，不依赖 soul-md）。 */
export const ALLOWED_TOOLS = Object.freeze([
  'jianmu_persona_status',
  'jianmu_persona_list',
  'jianmu_persona_card',
  'jianmu_persona_versions',
  'jianmu_persona_diff',
  'jianmu_persona_create',
  'jianmu_persona_save',
  'jianmu_persona_delete',
  'jianmu_persona_set_default',
  'jianmu_persona_bind',
  'jianmu_persona_rollback',
  'jianmu_persona_import',
  'jianmu_persona_expand',
  'jianmu_persona_preview',
  'jianmu_persona_settings',
  'jianmu_persona_memory_list',
  'jianmu_persona_memory_read',
  'jianmu_persona_memory_append',
  // P4 #10（2026-11-13）：硬认领（unassigned → 指定人格；预览/应用/回滚）
  'jianmu_persona_claim_hard',
])

/** 固定四区（顺序即新建卡模板顺序）。 */
export const ZONES = Object.freeze(['identity', 'redline', 'behavior', 'style'])
export const ZONE_LABELS = Object.freeze({
  identity: '身份',
  redline: '红线',
  behavior: '行为准则',
  style: '风格示例',
})
export const PROTECTED_ZONES = Object.freeze(['identity', 'redline'])
export const EDITABLE_ZONES = Object.freeze(['behavior', 'style'])

export const AUTHORS = Object.freeze(['user', 'ai-expand', 'import', 'rollback', 'system'])

/** AI 生成预算（契约 §3.5） */
export const EXPAND_BUDGET = Object.freeze({
  maxInputChars: 8000,
  maxOutputTokens: 8000,
  timeoutMs: 60000,
  retries: 1,
})
