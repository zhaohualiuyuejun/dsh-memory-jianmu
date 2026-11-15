/**
 * lib/llm.mjs —— 通过宿主 ctx.llm 调模型（唯一花钱的地方）
 *
 * 纪律：
 *   · 默认零自动调用：只有 run 工具带 confirm=true 才会走到这里
 *   · 一次流一次调用，不自动重试（重试会烧钱）
 *   · 超时用 AbortController 硬断
 *   · 记账：token 从 usage 分片取；拿不到就按字符估算并标 estimated
 */
import { YearError } from './errors.mjs'

/** 粗略估算：中文约 1 token / 1.6 字符；英文约 1 token / 4 字符 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  const rest = s.length - cjk
  return Math.ceil(cjk / 1.6 + rest / 4)
}

/**
 * 调一次模型，返回完整文本。
 * @param {object} llmCtx ctx.llm （宿主服务）
 * @param {object} opts {provider, model, system, user, maxTokens, timeoutMs}
 */
export async function callLlm(llmCtx, opts) {
  const {
    provider = 'deepseek-account',
    model = 'deepseek-flash',
    system = '',
    user = '',
    maxTokens = 8000,
    timeoutMs = 90000,
  } = opts

  if (!llmCtx || typeof llmCtx.stream !== 'function') {
    throw new YearError('LLM_UNAVAILABLE', '宿主没有 ctx.llm 服务（无法调用模型）；年轮不会退回直连 HTTP')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    try { controller.abort() } catch { /* 忽略 */ }
  }, Math.max(1000, Number(timeoutMs) || 90000))

  let text = ''
  let usage = null
  let finish = null
  let failure = null
  let truncated = false
  const startedAt = Date.now()

  try {
    const stream = llmCtx.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0,
      maxTokens: Math.max(256, Number(maxTokens) || 8000),
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += chunk.text || ''
      else if (chunk.type === 'usage') usage = chunk.usage || usage
      else if (chunk.type === 'finish') {
        // DSH 的 FinishReason 是对象：{ kind: 'stop'|'tool-calls'|'max-tokens'|'aborted'|'error', failure? }
        // 之前比 `chunk.reason === 'error'` 永远为假 → 模型报错会被当成成功（审查抓到的阻断）
        finish = chunk.reason ?? null
        const kind = finish && typeof finish === 'object' ? finish.kind : String(finish ?? '')
        if (kind === 'error' || kind === 'aborted') {
          failure = finish?.failure || { code: kind.toUpperCase(), message: `流以 ${kind} 结束` }
        } else if (kind === 'max-tokens') {
          truncated = true
        }
      }
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))
    throw new YearError(
      aborted ? 'LLM_TIMEOUT' : 'LLM_FAILED',
      aborted ? `模型调用超时（>${timeoutMs}ms）` : `模型调用失败：${e?.message || e}`,
      { cause: e?.code || e?.name || null },
    )
  } finally {
    clearTimeout(timer)
  }

  const elapsedMs = Date.now() - startedAt

  // DSH 的 TokenUsage 是「不重叠」三段：inputTokens 只是未缓存输入，
  // 计费输入 = input + cacheRead + cacheWrite（审查抓到：只取 input 会低估费用）
  // 必须放在 truncated/failure 之前算——那两个分支也要读它（曾经踩过 TDZ）
  const uncachedIn = Number(usage?.inputTokens ?? usage?.promptTokens ?? usage?.input ?? NaN)
  const cacheRead = Number(usage?.cacheReadTokens ?? 0)
  const cacheWrite = Number(usage?.cacheWriteTokens ?? 0)
  const promptTokens = Number.isFinite(uncachedIn)
    ? uncachedIn + (Number.isFinite(cacheRead) ? cacheRead : 0) + (Number.isFinite(cacheWrite) ? cacheWrite : 0)
    : NaN
  const outputTokens = Number(usage?.outputTokens ?? usage?.completionTokens ?? usage?.output ?? NaN)
  const estimated = !Number.isFinite(promptTokens) || !Number.isFinite(outputTokens)
  const usageOut = {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : estimateTokens(`${system}\n${user}`),
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : estimateTokens(text),
    estimated,
  }

  if (truncated) {
    // 截断也是花了钱的：把已产生的 usage 一起带出去，交给调用方记账
    throw new YearError('LLM_TRUNCATED', '模型输出被 max-tokens 截断（JSON 不完整，拒收；调小 maxChunks 或调大 budgetTokens）', {
      provider, model, usage: usageOut, textChars: text.length,
    })
  }

  if (failure) {
    const code = String(failure.code || 'LLM_FAILED')
    const msg = String(failure.message || '')
    if (code === 'MISSING_CREDENTIAL' || code === 'AUTH' || code === 'NO_ADAPTER') {
      throw new YearError('LLM_UNAVAILABLE', `模型不可用（${code}）：${msg || '检查设置里的模型账号'}`, { provider, model, usage: usageOut })
    }
    if (code === 'RATE_LIMIT' || code === 'QUOTA' || code === 'ACCOUNT_QUOTA') {
      throw new YearError('LLM_FAILED', `模型额度/限流（${code}）：${msg}`, { provider, model, usage: usageOut })
    }
    throw new YearError('LLM_FAILED', `模型返回失败（${code}）：${msg}`, { provider, model, usage: usageOut })
  }

  return {
    ok: true,
    text,
    finish,
    provider,
    model,
    elapsedMs,
    usage: usageOut,
  }
}

/** 从模型输出里剥出 JSON 数组（容忍 ```json 包裹、前后废话） */
export function parseClaimsJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new YearError('LLM_JSON_INVALID', '模型输出为空')

  const tryParse = (s) => {
    try { return { ok: true, value: JSON.parse(s) } } catch { return { ok: false } }
  }

  // 1) 直接解析
  let r = tryParse(raw)
  if (r.ok) return normalizeTop(r.value)

  // 2) 去掉 markdown 围栏
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  r = tryParse(fenced)
  if (r.ok) return normalizeTop(r.value)

  // 3) 截取第一个 [ ... 最后一个 ]
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start >= 0 && end > start) {
    r = tryParse(raw.slice(start, end + 1))
    if (r.ok) return normalizeTop(r.value)
  }

  // 4) 单个对象
  const os = raw.indexOf('{')
  const oe = raw.lastIndexOf('}')
  if (os >= 0 && oe > os) {
    r = tryParse(raw.slice(os, oe + 1))
    if (r.ok) return normalizeTop(r.value)
  }

  throw new YearError('LLM_JSON_INVALID', '模型输出不是合法 JSON（已尝试直接解析/去围栏/截取数组）', {
    head: raw.slice(0, 240),
  })
}

function normalizeTop(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.claims)) return value.claims
  if (value && typeof value === 'object' && (value.kind || value.title)) return [value]
  throw new YearError('LLM_JSON_INVALID', '模型输出了 JSON，但不是数组/claims 结构')
}

/** 费用估算（元）。单价单位：元 / 百万 token */
export function costYuan(usage, pricing = {}) {
  const inPrice = Number(pricing.inputPerMTokens)
  const outPrice = Number(pricing.outputPerMTokens)
  if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice)) return null
  const pt = Number(usage?.promptTokens) || 0
  const ot = Number(usage?.outputTokens) || 0
  const yuan = (pt / 1e6) * inPrice + (ot / 1e6) * outPrice
  return Math.round(yuan * 1e6) / 1e6
}
