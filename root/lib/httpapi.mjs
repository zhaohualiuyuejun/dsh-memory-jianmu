/**
 * lib/httpapi.mjs —— 根藏 UI 的 HTTP 半端（0.2.6 新增）
 *
 * 只做三件事，全部可单测、不碰记忆数据：
 *   1) 写请求闸门（CSRF / 媒体类型 / JSON 体）—— 与熏习、镜台同一口径
 *   2) 设置 patch 的**白名单 + 校验**（不认识的字段直接拒绝，不静默忽略）
 *   3) 「测试连接」：一次最小 embeddings 调用，不落盘、不写日志明文、不返回 Key
 *
 * 写设置的落地路径（30 分钟 spike 结论，2026-11-13）：
 *   ctx.settings.update(ns, patch, expectedRevision) → configEditor.edit()
 *   → yaml.parseDocument 就地改 profile patch 的 config 节点 → writeFileAtomic。
 *   证据：dsh-settings/lib/index.js#update、dsh-config-editor/lib/index.js#edit；
 *   本机产物：profile patch 里 `ui-chat.transcriptView`（ui-chat 的 volatile 字段）。
 *   因此**不再做 ui-settings.json 第二层配置**。
 */

export const API_PREFIX = '/api/memory-store'
/** 写动作必须带的自定义头（跨站表单带不了；浏览器会预检） */
export const WRITE_HEADER = 'x-dsh-jianmu'

/** 允许从 UI 改的字段（其余一律拒绝：拼错就报错，别让它静默不生效） */
export const SETTINGS_WRITABLE = Object.freeze(['autoIngest', 'embeddingApiBase', 'embeddingApiKey', 'archiveDir'])

const MAX_BODY_BYTES = 64 * 1024
const MAX_STRING = 400

function fail(status, code, message, extra) {
  return { ok: false, status, body: { ok: false, code, error: { code, message }, ...(extra || {}) } }
}

/**
 * 写请求闸门（只读，不消费请求体）。
 * @returns {{ok:true}|{ok:false,status:number,body:object}}
 */
export function checkWriteRequest(req) {
  const headers = (req && req.headers) || {}
  const ct = String(headers['content-type'] || '').trim()
  if (!/^application\/json(?:\s*;|$)/i.test(ct)) {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '写动作只接受 content-type: application/json')
  }
  if (String(headers[WRITE_HEADER] || '') !== '1') {
    return fail(403, 'CSRF_BLOCKED', `缺少自定义头 ${WRITE_HEADER}: 1（跨站表单无法携带，这是 CSRF 防护）`)
  }
  const origin = headers.origin
  if (origin) {
    let originHost = null
    try { originHost = new URL(String(origin)).host } catch { originHost = null }
    const host = String(headers.host || '')
    if (!originHost || !host || originHost.toLowerCase() !== host.toLowerCase()) {
      return fail(403, 'CSRF_BLOCKED', `Origin 与 Host 不同源（origin=${origin} host=${host}）`)
    }
  }
  const site = headers['sec-fetch-site']
  if (site && !['same-origin', 'same-site', 'none'].includes(String(site).toLowerCase())) {
    return fail(403, 'CSRF_BLOCKED', `sec-fetch-site=${site} 不是同源请求`)
  }
  return { ok: true }
}

/**
 * 读 JSON 请求体（有上限）。兼容 Node IncomingMessage / 已解析 req.body / 测试夹具字符串。
 */
export async function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  const finish = (text) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return { ok: true, value: {} }
    let value
    try { value = JSON.parse(trimmed) } catch { return { ok: false, status: 400, code: 'BAD_JSON', message: '请求体不是合法 JSON' } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 400, code: 'BAD_JSON', message: '请求体必须是 JSON 对象' }
    }
    return { ok: true, value }
  }
  if (req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return { ok: true, value: req.body }
  if (req && typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > limitBytes) {
      return { ok: false, status: 413, code: 'BODY_TOO_LARGE', message: `请求体超过上限 ${limitBytes} 字节` }
    }
    return finish(req.body)
  }
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > limitBytes) return { ok: false, status: 413, code: 'BODY_TOO_LARGE', message: `请求体超过上限 ${limitBytes} 字节` }
      chunks.push(buf)
    }
    return finish(Buffer.concat(chunks).toString('utf8'))
  }
  return { ok: true, value: {} }
}

/**
 * 校验一次设置 patch。**不认识的键 → 拒绝**（不是忽略）。
 * @returns {{ok:true,value:object}|{ok:false,code:string,message:string}}
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'BAD_ARGS', message: 'patch 必须是对象，例如 {"autoIngest":true}' }
  }
  const keys = Object.keys(patch)
  if (!keys.length) return { ok: false, code: 'BAD_ARGS', message: 'patch 是空的：至少要给一个字段' }
  const unknown = keys.filter((k) => !SETTINGS_WRITABLE.includes(k))
  if (unknown.length) {
    return {
      ok: false, code: 'UNKNOWN_SETTING',
      message: `不认识的字段：${unknown.join('、')}（可用：${SETTINGS_WRITABLE.join('、')}）`,
    }
  }
  const out = {}
  for (const key of keys) {
    const v = patch[key]
    if (key === 'autoIngest') {
      if (typeof v !== 'boolean') return { ok: false, code: 'BAD_SETTING_VALUE', message: 'autoIngest 只接受 true / false' }
      out[key] = v
      continue
    }
    if (typeof v !== 'string') {
      return { ok: false, code: 'BAD_SETTING_VALUE', message: `${key} 只接受字符串` }
    }
    const s = v.trim()
    if (s.length > MAX_STRING) {
      return { ok: false, code: 'BAD_SETTING_VALUE', message: `${key} 太长（上限 ${MAX_STRING} 字符）` }
    }
    if (/[\r\n\t]/.test(s)) {
      return { ok: false, code: 'BAD_SETTING_VALUE', message: `${key} 不能包含换行或制表符` }
    }
    if (key === 'embeddingApiBase') {
      if (s && !/^https?:\/\//i.test(s)) {
        return { ok: false, code: 'BAD_SETTING_VALUE', message: 'embeddingApiBase 必须以 http:// 或 https:// 开头（留空 = 用默认地址）' }
      }
      out[key] = s.replace(/\/+$/, '')
      continue
    }
    if (key === 'archiveDir') {
      // 归档目录必须是绝对路径（Windows 盘符或 POSIX 根）；留空 = 不归档、只保留最近 N 份
      if (s && !/^[A-Za-z]:[\\/]/.test(s) && !/^\//.test(s)) {
        return { ok: false, code: 'BAD_SETTING_VALUE', message: 'archiveDir 必须是绝对路径（如 H:\\deepseek\\jianmu-archive；留空 = 只保留最近 2 份）' }
      }
      out[key] = s
      continue
    }
    out[key] = s
  }
  return { ok: true, value: out }
}

/**
 * 给 UI 的设置视图：**永不回显 Key**，只回 configured 布尔 + 来源。
 * @param {{cfg:object, revision:number|null, writable:boolean, embed:object, dataRoot:string, dataRootSource:string}} p
 */
export function publicSettings({ cfg, revision, writable, embed, dataRoot, dataRootSource }) {
  return {
    ok: true,
    revision: revision === undefined ? null : revision,
    writable: Boolean(writable),
    dataRoot: { value: dataRoot, source: dataRootSource, readOnly: true },
    autoIngest: {
      value: Boolean(cfg?.autoIngest),
      note: '插件内定时摄取；关掉后不再追加新块（已有数据不受影响）',
    },
    embeddingApiBase: {
      value: typeof cfg?.embeddingApiBase === 'string' ? cfg.embeddingApiBase : '',
      effective: embed?.apiBase || null,
    },
    embeddingApiKey: {
      // 只报「配没配」，绝不回 Key 明文
      configured: Boolean(embed?.ok),
      source: embed?.source || null,
      note: embed?.ok ? null : '未配置：留空则回退读寻枝的 ~/.dsh/session-recall/config.json',
    },
    archiveDir: {
      value: typeof cfg?.archiveDir === 'string' ? cfg.archiveDir : '',
      note: '建议放别的盘：备份/回退快照移到这里，C 盘只留正在用的数据；留空 = 只保留最近 2 份并自动清理更旧的',
    },
    writableFields: [...SETTINGS_WRITABLE],
  }
}

function normalizeBase(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  return b || 'https://api.siliconflow.cn/v1'
}

/**
 * 一次最小 embeddings 调用。不写任何记忆、不落日志明文、不返回 Key。
 * @param {{embed:object, model:string, dim:number, fetchImpl?:Function, timeoutMs?:number, text?:string}} p
 * @returns {Promise<object>} {ok, latencyMs, model, dim, dimMatch, apiBase, code?, message?}
 */
export async function testEmbedding({ embed, model, dim, fetchImpl, timeoutMs = 15000, text = '根藏连接测试' }) {
  const started = Date.now()
  if (!embed || !embed.ok) {
    return {
      ok: false, code: 'EMBEDDING_NOT_CONFIGURED', latencyMs: 0,
      message: '没有可用的嵌入密钥：先在设置里填写，或让寻枝配置里存在 apiKey',
    }
  }
  const m = String(model || '').trim()
  if (!m) {
    return { ok: false, code: 'MODEL_UNKNOWN', latencyMs: 0, message: '还不知道该用哪个嵌入模型（库里没有 manifest）：先跑一次摄取再测' }
  }
  const apiBase = normalizeBase(embed.apiBase)
  const fetchFn = fetchImpl || globalThis.fetch
  if (typeof fetchFn !== 'function') {
    return { ok: false, code: 'FETCH_UNAVAILABLE', latencyMs: 0, message: '宿主没有 fetch，无法测试连接' }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, Math.max(1000, Number(timeoutMs) || 15000))
  try {
    const res = await fetchFn(`${apiBase}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${embed.apiKey}` },
      body: JSON.stringify({ model: m, input: [String(text).slice(0, 40)] }),
      signal: ac.signal,
    })
    const latencyMs = Date.now() - started
    const bodyText = await res.text().catch(() => '')
    if (!res.ok) {
      return {
        ok: false, code: 'HTTP_ERROR', status: res.status, latencyMs, apiBase, model: m,
        message: `嵌入服务返回 HTTP ${res.status}：${String(bodyText || '').slice(0, 200)}`,
      }
    }
    let json = null
    try { json = JSON.parse(bodyText) } catch { json = null }
    const vec = json?.data?.[0]?.embedding
    if (!Array.isArray(vec)) {
      return { ok: false, code: 'BAD_RESPONSE', latencyMs, apiBase, model: m, message: '返回里没有 data[0].embedding' }
    }
    const gotDim = vec.length
    const wantDim = Number(dim) || 0
    if (wantDim && gotDim !== wantDim) {
      return {
        ok: false, code: 'DIM_MISMATCH', latencyMs, apiBase, model: m, dim: gotDim, wantDim,
        message: `维度不符：服务返回 ${gotDim}，库里 manifest 是 ${wantDim}——写进去会导致向量错位，先统一模型/维度`,
      }
    }
    return { ok: true, latencyMs, apiBase, model: m, dim: gotDim, dimMatch: wantDim ? gotDim === wantDim : null }
  } catch (e) {
    const latencyMs = Date.now() - started
    const aborted = e?.name === 'AbortError'
    return {
      ok: false, code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', latencyMs, apiBase, model: m,
      message: aborted ? `超时（${timeoutMs}ms）：服务没在时限内返回` : `请求失败：${String(e?.message || e).slice(0, 200)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
