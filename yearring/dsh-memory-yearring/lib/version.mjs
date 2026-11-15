/**
 * lib/version.mjs —— 年轮的版本与工具面常量（契约 v1 冻结）
 *
 * 工具面只允许 jianmu_year_*，且不得含 recall/search（检索归寻枝）。
 * 「export」是导出，不是检索，允许。
 */

export const VERSION = '0.4.3'
export const SCHEMA_VERSION = 1
export const CONTRACT_VERSION = 1
export const ROOT_CONTRACT_VERSION = 1

/** 规则版本：改动 claim 拼接/排序/去重规则都要递增，rebuild 依此复现 */
export const RULE_VERSION = '2026-11-08.1'

/**
 * 提示词版本：改动抽取提示词必须递增（写进每条 claim 与每次 run）
 * year-v2（2026-11-12）= P1.5：要求模型输出 speaker（谁说的）
 */
export const PROMPT_VERSION = 'year-v2'

export const TOOL_PREFIX = 'jianmu_year_'
export const FORBIDDEN_TOOL_WORDS = Object.freeze(['recall', 'search', 'query'])

/** v1a 实际注册的工具面（7 个；写只有 run / rebuild） */
export const ALLOWED_TOOLS = Object.freeze([
  'jianmu_year_status',
  'jianmu_year_topics',
  'jianmu_year_claim',
  'jianmu_year_run',
  'jianmu_year_rebuild',
  'jianmu_year_verify',
  'jianmu_year_export',
])

/** claim 种类 */
export const KINDS = Object.freeze(['event', 'fact', 'preference', 'boundary', 'relation', 'timeline', 'conclusion', 'knowledge'])

/** 认识论状态：这条 claim 有多「确定」 */
export const EPISTEMIC = Object.freeze(['fact', 'inference', 'hearsay', 'unknown'])

/**
 * 说话人（P1.5，v0.3.0 追加的可选字段）：
 *   user 用户/用户本人说的 · assistant 助手说的 · unknown 分不清
 * 缺失（老 claim）视为 unknown；取值非法不拒写，降为 unknown + warning。
 * 这是**追加字段**，不改动已有字段语义，故 contractVersion 仍为 1。
 */
export const SPEAKERS = Object.freeze(['user', 'assistant', 'unknown'])

/** claim 状态 */
export const STATUSES = Object.freeze(['active', 'superseded', 'expired', 'archived', 'draft', 'conflicted'])

/** 进入 topic 正文的状态（draft / superseded / conflicted 不进） */
export const IN_TOPIC_STATUS = Object.freeze(['active'])

export const SOURCES = Object.freeze(['llm', 'rule', 'manual'])
export const REVIEW_STATUS = Object.freeze(['unreviewed', 'confirmed', 'rejected'])

/** 预算默认值（契约 v1 §3.3） */
export const DEFAULT_BUDGET = Object.freeze({
  maxInputChars: 24000,
  maxOutputTokens: 8000,
  timeoutMs: 90000,
  maxClaimsPerRun: 80,
})

/** 标题长度上限（契约 §3.1） */
export const MAX_TITLE_CHARS = 120
export const MAX_BODY_CHARS = 300
export const MAX_QUOTE_CHARS = 200
export const MIN_QUOTE_CHARS = 8

/** 近似去重：归一化标题的 SimHash 汉明距离阈值 */
export const SIMHASH_DISTANCE = 3
/** 冲突检测：同一 group 内 revision 上限保护（防止无限膨胀） */
export const MAX_REVISIONS_PER_GROUP = 50

/** 单次 run 最多选多少块（防止一次塞爆） */
export const MAX_CHUNKS_PER_RUN = 24
