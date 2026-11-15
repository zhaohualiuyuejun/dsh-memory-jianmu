/**
 * lib/rules.mjs —— 确定性分类规则（默认零 LLM）
 *
 * 铁律（契约 §1）：
 *   · 规则只能「保持或降低」确定性，绝不能把 inference/hypothesis/quote 升级成 fact；
 *   · 助手自述、第三方转述不能当成用户事实；
 *   · 规则命中只给理由码，不把原文片段写进状态（状态不存正文）。
 */
import { RULE_VERSION, EPISTEMIC_RANK } from './version.mjs'

export const RULE_IDS = Object.freeze({
  base: 'rule:role-default',
  thirdParty: 'rule:third-party-quote',
  hypothesis: 'rule:hypothesis-marker',
  inference: 'rule:inference-marker',
  sensitive: 'rule:sensitive-marker',
  boundary: 'rule:boundary-marker',
  correction: 'rule:explicit-correction',
  change: 'rule:explicit-change',
})

const BASE_EPISTEMIC = Object.freeze({
  user: 'fact',
  assistant: 'inference',
  tool: 'unknown',
  system: 'unknown',
})

const BASE_ATTRIBUTION = Object.freeze({
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
  system: 'tool',
})

export const PATTERNS = Object.freeze({
  /** 明确引用/转述外部来源 */
  quote: [
    /听说/,
    /据说/,
    /据[^\n。！？]{1,8}说/,
    /转述/,
    /别人说/,
    /有人说/,
    /朋友说/,
    /同事说/,
    /客户说/,
    /网上说/,
    /群里说/,
    /(?:^|[，。！？；\s])(?:他说|她说|他们说)/,
  ],
  /** 第三方（与 quote 重叠，但更宽：任何「XX 说」的主体不是用户） */
  thirdParty: [
    /听说/,
    /据说/,
    /转述/,
    /别人说/,
    /有人说/,
    /朋友说/,
    /同事说/,
    /客户说/,
    /网上说/,
    /群里说/,
    /(?:^|[，。！？；\s])(?:他说|她说|他们说)/,
    /(?:^|[，。！？；\s])(?:第三方|对方)说/,
  ],
  /** 假设 / 猜测 / 不确定 */
  hypothesis: [
    /假设/,
    /猜想/,
    /猜测/,
    /我猜/,
    /也许/,
    /或许/,
    /可能吧/,
    /说不定/,
    /搞不好/,
    /(?:^|[，。！？；\s])猜测/,
  ],
  /** 推断语气（只对「本该是事实」的条降级） */
  inference: [
    /我(?:觉得|认为|估计|推断|推测)/,
    /应该(?:是|会|能)/,
    /看起来(?:像|是)?/,
    /听起来(?:像|是)?/,
    /(?:好像|似乎)(?:是|要|会)?/,
  ],
  /** 敏感：直接凭据/身份/医疗极端项 */
  sensitive: [
    /密码/,
    /私钥/,
    /api[ _-]?key/i,
    /secret[ _-]?key/i,
    /身份证/,
    /银行卡/,
    /信用卡/,
    /社保号/,
    /病历/,
    /诊断书/,
    /处方/,
    /自杀/,
    /自残/,
    /裸照/,
  ],
  /** 边界：私人财务/健康/家庭/联系方式 */
  boundary: [
    /工资/,
    /薪水/,
    /收入/,
    /存款/,
    /余额/,
    /贷款/,
    /欠款/,
    /债务/,
    /房租/,
    /住址/,
    /家庭住址/,
    /手机号/,
    /电话号码/,
    /离婚/,
    /吵架/,
    /家暴/,
    /医院/,
    /体检/,
    /吃药/,
    /怀孕/,
    /性取向/,
    /政治/,
  ],
  /** 明确改口/纠错 */
  correction: [
    /(?:不是|并非)[^\n。！？]{1,40}?(?:而是|，是|,是|。是)/,
    /(?:改成|改为|更正|纠正|纠错|说错了|说反了|记错了|我错了|搞错了|弄错了)/,
  ],
  /** 明确变化（不一定有对照目标，弱于 correction） */
  change: [
    /(?:现在|已经|后来)(?:改|变)(?:成|为)/,
    /(?:不再|以后不|从今往后|以后都)/,
  ],
})

export function normalizeForDedup(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstMatch(patterns, text) {
  for (let i = 0; i < patterns.length; i++) {
    const m = patterns[i].exec(text)
    if (m) return { index: i, start: m.index, length: m[0].length, match: m[0] }
  }
  return null
}

/** 「建议/应该/可以…改成」是提议，不是改口；不能当取代线索 */
const SUGGESTION_CONTEXT = /(?:建议|应该|需要|可以|最好|不如|要不要|考虑|推荐)[^。！？\n]{0,12}$/

function isSuggestionContext(text, start) {
  const pre = String(text).slice(Math.max(0, start - 20), start)
  return SUGGESTION_CONTEXT.test(pre)
}

/** 只降不升：返回 rank 更低的那个 */
export function enforceNoUpgrade(base, proposed) {
  const b = EPISTEMIC_RANK[base] ?? 0
  const p = EPISTEMIC_RANK[proposed] ?? 0
  return p < b ? proposed : base
}

/**
 * 对一条根藏块做确定性分类。
 * @returns {{epistemic, attribution, sensitivity, clues, ruleRef, downgraded, reasons}}
 */
export function classify(chunk) {
  const role = ['user', 'assistant', 'tool', 'system'].includes(chunk?.role) ? chunk.role : 'unknown'
  const text = String(chunk?.text ?? '')
  const reasons = []

  // 系统注入/预注入内容不是用户原话：不得判成 fact，也不能算用户 attribution
  const injected = role === 'system' || chunk?.sourceType === 'injected' || chunk?.sourceType === 'system'
  const baseEpistemic = injected ? 'unknown' : (BASE_EPISTEMIC[role] ?? 'unknown')
  const baseAttribution = injected ? 'tool' : (BASE_ATTRIBUTION[role] ?? 'unknown')
  let epistemic = baseEpistemic
  let attribution = baseAttribution

  const quote = firstMatch(PATTERNS.quote, text)
  const third = firstMatch(PATTERNS.thirdParty, text)
  const hypo = firstMatch(PATTERNS.hypothesis, text)
  const infer = firstMatch(PATTERNS.inference, text)

  if (third) {
    attribution = 'third-party'
    reasons.push(RULE_IDS.thirdParty)
  }
  if (quote) {
    const next = enforceNoUpgrade(epistemic, 'quote')
    if (next !== epistemic) reasons.push(RULE_IDS.thirdParty)
    epistemic = next
  }
  if (hypo) {
    const next = enforceNoUpgrade(epistemic, 'hypothesis')
    if (next !== epistemic) reasons.push(RULE_IDS.hypothesis)
    epistemic = next
  }
  if (infer) {
    const next = enforceNoUpgrade(epistemic, 'inference')
    if (next !== epistemic) reasons.push(RULE_IDS.inference)
    epistemic = next
  }

  let sensitivity = 'normal'
  if (firstMatch(PATTERNS.sensitive, text)) {
    sensitivity = 'sensitive'
    reasons.push(RULE_IDS.sensitive)
  } else if (firstMatch(PATTERNS.boundary, text)) {
    sensitivity = 'boundary'
    reasons.push(RULE_IDS.boundary)
  }

  const correction = firstMatch(PATTERNS.correction, text)
  const change = firstMatch(PATTERNS.change, text)
  const correctionIsSuggestion = correction ? isSuggestionContext(text, correction.start) : false
  const changeIsSuggestion = change ? isSuggestionContext(text, change.start) : false
  const clues = {
    correction: Boolean(correction) && !correctionIsSuggestion,
    correctionIndex: correction && !correctionIsSuggestion ? correction.index : null,
    correctionStart: correction && !correctionIsSuggestion ? correction.start : null,
    correctionSuggestion: Boolean(correction) && correctionIsSuggestion,
    change: Boolean(change) && !changeIsSuggestion,
    changeIndex: change && !changeIsSuggestion ? change.index : null,
    changeSuggestion: Boolean(change) && changeIsSuggestion,
    quote: Boolean(quote),
    thirdParty: Boolean(third),
    hypothesis: Boolean(hypo),
    inference: Boolean(infer),
  }

  const ruleId = clues.correction
    ? RULE_IDS.correction
    : (reasons.includes(RULE_IDS.hypothesis) ? RULE_IDS.hypothesis : RULE_IDS.base)

  return {
    epistemic,
    attribution,
    sensitivity,
    clues,
    downgraded: epistemic !== baseEpistemic,
    baseEpistemic,
    ruleRef: { ruleId, ruleVersion: RULE_VERSION },
    reasons: [...new Set(reasons)],
  }
}

/** 只读辅助：给 selftest 用 */
export function matchedKinds(text) {
  const out = {}
  for (const [k, list] of Object.entries(PATTERNS)) out[k] = Boolean(firstMatch(list, String(text ?? '')))
  return out
}
