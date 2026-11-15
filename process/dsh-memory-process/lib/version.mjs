/**
 * lib/version.mjs —— 熏习的版本与工具面常量（契约 v1 冻结）
 *
 * 工具面只允许 jianmu_process_*，且不得含 recall/search/query（检索归寻枝）。
 */

export const VERSION = '0.2.7'
export const SCHEMA_VERSION = 1
export const CONTRACT_VERSION = 1
export const ROOT_CONTRACT_VERSION = 1

/** 规则版本：改动任何分类/取代规则都要递增，rebuild 依此复现 */
export const RULE_VERSION = '2026-11-07.1'

export const TOOL_PREFIX = 'jianmu_process_'
export const FORBIDDEN_TOOL_WORDS = Object.freeze(['recall', 'search', 'query'])

/**
 * v1a 实际注册的工具面。
 * topics / conflicts 在 v1a 只提供只读列表（写动作排 v1b/v1.1），
 * 名字先冻结，避免以后改工具名。
 */
export const ALLOWED_TOOLS = Object.freeze([
  'jianmu_process_run',
  'jianmu_process_status',
  'jianmu_process_review',
  'jianmu_process_apply',
  'jianmu_process_topics',
  'jianmu_process_conflicts',
  'jianmu_process_rebuild',
  'jianmu_process_verify',
  'jianmu_process_export',
])

export const STATUSES = Object.freeze(['active', 'superseded', 'expired', 'archived'])
export const EPISTEMIC = Object.freeze(['fact', 'inference', 'hypothesis', 'quote', 'unknown'])
export const ATTRIBUTION = Object.freeze(['user', 'assistant', 'third-party', 'tool', 'unknown'])
export const SENSITIVITY = Object.freeze(['normal', 'boundary', 'sensitive'])

/** 确定性（确定性越高数字越大）；规则只能降不能升 */
export const EPISTEMIC_RANK = Object.freeze({ fact: 4, inference: 3, hypothesis: 2, quote: 1, unknown: 0 })

export const DEFAULT_THRESHOLDS = Object.freeze({
  simhashDistance: 3,
  jaccard: 0.9,
  supersedeMinConfidence: 0.6,
  supersedeMinJaccard: 0.35,
  supersedeMaxChars: 300,
  dedupeNormalizer: 'nfkc-collapse-v1',
})

export const MAX_CHUNKS_PER_RUN = 20000
export const MAX_PENDING_PER_REVIEW = 500
