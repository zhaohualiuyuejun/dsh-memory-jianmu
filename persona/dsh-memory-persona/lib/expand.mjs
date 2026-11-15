/**
 * lib/expand.mjs —— AI 生成人设（一句种子 → 整卡草稿）
 *
 * 铁律（契约 §3.1）：
 *   · 一次显式调用；不在保存/注入路径里调用。
 *   · 只**返回草稿**，不写盘；用户点保存才落盘。
 *   · 老卡生成时，system 要求保留「身份与外貌 / 红线」原文；生成后校验，改了就标 protectedChanged。
 *   · 扫描红 → 不返回可用草稿（编辑框不动）。
 *   · 失败不写、不返回半成品。
 */
import { parseCard, protectedDiff, zoneHash } from './card.mjs'
import { scanText, summarizeScan } from './scan.mjs'
import { EXPAND_BUDGET } from './version.mjs'

export const SYSTEM_PROMPT = [
  '你是一个人格卡编写助手。用户会给你一句「种子」（可能还有一份现有人格卡）。',
  '请顺着种子的核心设定，生成一张完整、可直接使用的人格卡。',
  '',
  '硬性要求：',
  '1. 用 Markdown；分区固定、按此顺序：',
  '   ## 身份与外貌',
  '   ## 红线',
  '   ## 行为准则',
  '   ## 风格示例',
  '2. 先读种子：种子里的身份、关系、称呼、语气、禁忌一律保留，不得改写成别的人设。',
  '3. 不编造真实个人信息（真实姓名、住址、账号、电话、邮箱、组织内部信息）。',
  '4. 行为准则要具体、可执行；风格示例给 2–4 组简短对话。',
  '5. 红线写「不能做什么」，不写空话。',
  '6. 只输出人格卡 Markdown 正文；不要解释、不要代码块围栏。',
  '7. 如果给了现有人格卡：保持其中的「## 身份与外貌」和「## 红线」两段原文不变。',
].join('\n')

export function buildUserPrompt({ seed, name, existingCard }) {
  const parts = []
  if (name) parts.push(`角色名：${name}`)
  parts.push('种子（用户原话）：', String(seed || '').trim())
  if (existingCard && String(existingCard).trim()) {
    parts.push('', '现有人格卡（保护分区必须原文保留）：', '<<<CARD', String(existingCard).trim(), 'CARD>>>')
  }
  parts.push('', '请输出完整人格卡。')
  return parts.join('\n')
}

function stripFences(text) {
  let out = String(text || '').trim()
  out = out.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim()
  return out
}

/** 从会话/配置/模型目录解析 provider+model */
export async function resolveExpandRoute({ ctx, sessionId, cfg }) {
  const fixedProvider = String(cfg?.expandProvider || '').trim()
  const fixedModel = String(cfg?.expandModel || '').trim()
  if (fixedProvider && fixedModel) return { ok: true, provider: fixedProvider, model: fixedModel, source: 'config' }
  if (Boolean(fixedProvider) !== Boolean(fixedModel)) {
    return {
      ok: false,
      code: 'NO_MODEL_ROUTE',
      error: { code: 'NO_MODEL_ROUTE', message: 'expandProvider / expandModel 必须同时配置，或都不配置（跟随会话）' },
    }
  }

  const sessionController = (() => { try { return ctx?.get?.('sessionController', false) } catch { return undefined } })()
  if (sessionController && sessionId) {
    try {
      if (typeof sessionController.projections === 'function') {
        const read = await sessionController.projections({ sessionId }, AbortSignal.timeout(5000))
        const sel = read?.values?.modelSelection?.next ?? read?.values?.modelSelection?.lastUsed
        if (sel && sel.provider && sel.model) {
          return {
            ok: true,
            provider: String(sel.provider),
            model: String(sel.model),
            reasoningEffort: sel.reasoningEffort ? String(sel.reasoningEffort) : undefined,
            source: 'session',
          }
        }
      }
    } catch { /* 读不到就落到目录默认 */ }
  }

  if (sessionController && typeof sessionController.modelCatalog === 'function') {
    try {
      const catalog = await sessionController.modelCatalog()
      const d = catalog?.default
      if (d && d.provider && d.model) return { ok: true, provider: String(d.provider), model: String(d.model), source: 'catalog-default' }
    } catch { /* ignore */ }
  }

  return {
    ok: false,
    code: 'NO_MODEL_ROUTE',
    error: {
      code: 'NO_MODEL_ROUTE',
      message: '解析不到模型路由：请显式配置 expandProvider/expandModel（如 ollama + qwen3:8b），或从有模型选择的会话调用',
    },
  }
}

/**
 * 单次模型调用（带 1 次重试）。
 * @returns {{ok:boolean, text?:string, provider?:string, model?:string, usage?:object, attempts:number, error?:object}}
 */
export async function callModel({ ctx, route, system, user, maxTokens, timeoutMs, retries, purpose = 'jianmu-persona-expand' }) {
  const llm = (() => { try { return ctx?.get?.('llm', false) } catch { return undefined } })()
  if (!llm || (typeof llm.stream !== 'function' && typeof llm.prepareCall !== 'function')) {
    return { ok: false, code: 'LLM_UNAVAILABLE', error: { code: 'LLM_UNAVAILABLE', message: '宿主没有可用的 llm 服务' }, attempts: 0 }
  }
  const maxAttempts = Math.max(1, Math.min(3, Number(retries) + 1))
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const call = {
        provider: route.provider,
        model: route.model,
        maxTokens,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      }
      const request = {
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        system,
        signal,
      }
      let stream
      if (typeof llm.prepareCall === 'function') {
        const prepared = await llm.prepareCall(call, signal)
        stream = prepared.stream({ ...prepared.config, ...request })
      } else {
        stream = llm.stream({ ...call, ...request })
      }
      const texts = []
      let usage = null
      let finish = null
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') texts.push(chunk.text)
        else if (chunk.type === 'usage') usage = chunk.usage ?? null
        else if (chunk.type === 'finish') finish = chunk.reason ?? null
      }
      if (!finish) {
        lastError = { code: 'LLM_FAILED', message: '模型流没有终止 finish' }
      } else if (finish.kind !== 'stop') {
        lastError = { code: finish.kind === 'max-tokens' ? 'BUDGET_EXCEEDED' : 'LLM_FAILED', message: `模型未正常结束：${finish.kind}` }
      } else {
        const text = stripFences(texts.join(''))
        if (!text) {
          lastError = { code: 'LLM_FAILED', message: '模型返回空文本' }
        } else {
          return { ok: true, text, provider: route.provider, model: route.model, usage, attempts: attempt }
        }
      }
    } catch (e) {
      const aborted = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|aborted/i.test(String(e?.message || ''))
      lastError = aborted
        ? { code: 'LLM_TIMEOUT', message: `模型调用超时（${timeoutMs}ms）` }
        : { code: e?.code || 'LLM_FAILED', message: String(e?.message || e) }
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 300))
  }
  return { ok: false, ...lastError, attempts: maxAttempts }
}

/** 估算 token（中英混排粗估；只用于展示与预算，不参与计费） */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * AI 生成人设（只返回草稿，不写盘）。
 */
export async function expandPersona({
  ctx,
  sessionId,
  seed,
  existingContent,
  existingCard,
  name,
  confirmOverwrite = false,
  cfg = {},
  now = Date.now,
}) {
  const budget = {
    maxInputChars: Number(cfg.expandMaxInputChars) > 0 ? Number(cfg.expandMaxInputChars) : EXPAND_BUDGET.maxInputChars,
    maxOutputTokens: Number(cfg.expandMaxOutputTokens) > 0 ? Number(cfg.expandMaxOutputTokens) : EXPAND_BUDGET.maxOutputTokens,
    timeoutMs: Number(cfg.expandTimeoutMs) > 0 ? Number(cfg.expandTimeoutMs) : EXPAND_BUDGET.timeoutMs,
    retries: Number.isFinite(Number(cfg.expandRetries)) ? Math.max(0, Math.min(1, Number(cfg.expandRetries))) : EXPAND_BUDGET.retries,
  }
  const seedText = String(seed ?? '').trim()
  if (!seedText) {
    return { ok: false, code: 'EMPTY_SEED', error: { code: 'EMPTY_SEED', message: '种子为空：先写一句人设种子，例如「你是一个示例助手」' } }
  }
  const hasEditorContent = String(existingContent ?? '').trim().length > 0
  const baseText = String(existingContent ?? '').trim() || String(existingCard ?? '').trim()
  const hasBase = baseText.length > 0
  if (hasEditorContent && !confirmOverwrite) {
    return {
      ok: false,
      code: 'CONFIRM_REQUIRED',
      error: { code: 'CONFIRM_REQUIRED', message: '编辑框已有内容：确认「将基于当前内容生成整卡、编辑框会被替换（可撤销）、不会自动保存」后再调用（confirmOverwrite=true）' },
    }
  }
  if (seedText.length > budget.maxInputChars) {
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      error: { code: 'BUDGET_EXCEEDED', message: `种子 ${seedText.length} 字符，超过上限 ${budget.maxInputChars}` },
    }
  }
  // 真正发给模型的是 seed + 现有卡；两者合计都必须过预算
  const user = buildUserPrompt({ seed: seedText, name, existingCard: baseText })
  if (user.length > budget.maxInputChars) {
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      error: {
        code: 'BUDGET_EXCEEDED',
        message: `最终输入 ${user.length} 字符（种子 ${seedText.length} + 现有卡 ${baseText.length}），超过上限 ${budget.maxInputChars}`,
        detail: { seedChars: seedText.length, existingChars: baseText.length, totalChars: user.length, maxInputChars: budget.maxInputChars },
      },
    }
  }

  // 扫描种子：种子是用户自己的内容，红项并不阻止生成，但要在结果里如实报告
  const seedScan = scanText(seedText, 'seed')

  const route = await resolveExpandRoute({ ctx, sessionId, cfg })
  if (!route.ok) return route
  const called = await callModel({
    ctx,
    route,
    system: SYSTEM_PROMPT,
    user,
    maxTokens: budget.maxOutputTokens,
    timeoutMs: budget.timeoutMs,
    retries: budget.retries,
  })
  if (!called.ok) return { ok: false, ...called }

  const scan = scanText(called.text, 'expand-draft')
  if (scan.verdict === 'red') {
    return {
      ok: false,
      code: 'SCAN_RED',
      error: { code: 'SCAN_RED', message: 'AI 输出含红项（注入/凭据/后门/不可见字符），已拒绝返回草稿；编辑框保持不动' },
      scan: summarizeScan(scan),
      provider: called.provider,
      model: called.model,
      usage: called.usage,
      attempts: called.attempts,
      editorUntouched: true,
    }
  }

  // 保护分区校验：老卡生成后，身份/红线必须与基线一致
  let protectedChanged = []
  let draftCard = null
  let baseCard = null
  try {
    draftCard = parseCard(called.text)
    if (hasBase) {
      baseCard = parseCard(baseText)
      protectedChanged = protectedDiff(baseCard, draftCard)
    }
  } catch { /* 草稿不是标准卡也能返回，用户自己检查 */ }

  const identityHash = draftCard ? draftCard.zoneHashes.identity : null
  const redlineHash = draftCard ? draftCard.zoneHashes.redline : null

  return {
    ok: true,
    mode: hasBase ? 'expand-existing' : 'seed-to-card',
    draft: called.text,
    note: 'AI 生成，请检查后保存；未点保存不会落盘。',
    provider: called.provider,
    model: called.model,
    usage: called.usage,
    attempts: called.attempts,
    budget,
    chars: called.text.length,
    tokensEstimate: estimateTokens(called.text),
    scan: summarizeScan(scan),
    seedScan: summarizeScan(seedScan),
    protectedChanged,
    requiresProtectedConfirm: protectedChanged.length > 0,
    parsed: draftCard ? {
      zones: draftCard.zones.map((z) => ({ title: z.title, zone: z.zone, chars: z.end - z.start })),
      zoneHashes: draftCard.zoneHashes,
      identityHash,
      redlineHash,
    } : null,
    baseIdentityHash: baseCard?.zoneHashes?.identity ?? null,
    baseRedlineHash: baseCard?.zoneHashes?.redline ?? null,
    generatedAt: now(),
  }
}

export { zoneHash }
