#!/usr/bin/env node
/**
 * tools/httpapi-selftest.mjs —— 根藏 UI 半端自测（0.2.6；不依赖 DSH 宿主）
 *
 * 覆盖：
 *   · 写请求闸门：媒体类型 / 自定义头 / 同源 / sec-fetch-site
 *   · 请求体：对象 / 字符串 / 坏 JSON / 超大 / 空体
 *   · 设置白名单：未知字段拒绝、空 patch 拒绝、类型与长度、URL 口径、尾斜杠归一
 *   · 回显纪律：publicSettings 与 testEmbedding 的任何返回都**不含 Key 明文**
 *   · 测试连接：成功（维度一致）/ 维度不符 / HTTP 错误 / 超时 / 未配置 / 模型未知
 */
import assert from 'node:assert/strict'
import { API_PREFIX, WRITE_HEADER, SETTINGS_WRITABLE, checkWriteRequest, readJsonBody, validateSettingsPatch, publicSettings, testEmbedding } from '../lib/httpapi.mjs'

const results = []
async function t(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e?.stack || String(e) })
    console.log(`  ❌ ${name}`)
    console.log(String(e?.stack || e).split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'))
  }
}

const req = (headers = {}) => ({ method: 'POST', headers: { host: '127.0.0.1:19387', ...headers } })
const GOOD = { 'content-type': 'application/json', [WRITE_HEADER]: '1' }

// ─────────────────────────────────────────────────────────── 1. 闸门
console.log('\n── 写请求闸门 ──')

await t('合法写请求放行（JSON + 自定义头 + 同源）', async () => {
  assert.deepEqual(checkWriteRequest(req({ ...GOOD, origin: 'http://127.0.0.1:19387' })), { ok: true })
})

await t('表单/文本类型 → 415', async () => {
  const r = checkWriteRequest(req({ 'content-type': 'application/x-www-form-urlencoded', [WRITE_HEADER]: '1' }))
  assert.equal(r.ok, false)
  assert.equal(r.status, 415)
  assert.equal(r.body.code, 'UNSUPPORTED_MEDIA_TYPE')
})

await t('缺自定义头 → 403 CSRF_BLOCKED', async () => {
  const r = checkWriteRequest(req({ 'content-type': 'application/json' }))
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'CSRF_BLOCKED')
})

await t('跨源 Origin → 403 CSRF_BLOCKED', async () => {
  const r = checkWriteRequest(req({ ...GOOD, origin: 'http://evil.example' }))
  assert.equal(r.status, 403)
  assert.match(r.body.error.message, /不同源/)
})

await t('sec-fetch-site: cross-site → 403', async () => {
  const r = checkWriteRequest(req({ ...GOOD, 'sec-fetch-site': 'cross-site' }))
  assert.equal(r.status, 403)
})

await t('sec-fetch-site: same-origin / none → 放行', async () => {
  assert.equal(checkWriteRequest(req({ ...GOOD, 'sec-fetch-site': 'same-origin' })).ok, true)
  assert.equal(checkWriteRequest(req({ ...GOOD, 'sec-fetch-site': 'none' })).ok, true)
})

// ─────────────────────────────────────────────────────────── 2. 请求体
console.log('\n── 请求体 ──')

await t('已解析对象请求体直接返回', async () => {
  const r = await readJsonBody({ body: { a: 1 } })
  assert.deepEqual(r, { ok: true, value: { a: 1 } })
})

await t('字符串请求体解析 / 空体 = {}', async () => {
  assert.deepEqual(await readJsonBody({ body: '{"x":true}' }), { ok: true, value: { x: true } })
  assert.deepEqual(await readJsonBody({ body: '   ' }), { ok: true, value: {} })
})

await t('坏 JSON / 数组 / 非对象 → BAD_JSON', async () => {
  assert.equal((await readJsonBody({ body: '{oops' })).code, 'BAD_JSON')
  assert.equal((await readJsonBody({ body: '[1,2]' })).code, 'BAD_JSON')
  assert.equal((await readJsonBody({ body: '42' })).code, 'BAD_JSON')
})

await t('超大请求体 → BODY_TOO_LARGE（413）', async () => {
  const r = await readJsonBody({ body: 'x'.repeat(200) }, 50)
  assert.equal(r.status, 413)
  assert.equal(r.code, 'BODY_TOO_LARGE')
})

await t('流式请求体（IncomingMessage 形状）也能读', async () => {
  const reqStream = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"autoIngest":')
      yield Buffer.from('false}')
    },
  }
  assert.deepEqual(await readJsonBody(reqStream), { ok: true, value: { autoIngest: false } })
})

// ─────────────────────────────────────────────────────────── 3. 设置白名单
console.log('\n── 设置 patch 校验 ──')

await t('白名单常量与导出前缀稳定', async () => {
  assert.equal(API_PREFIX, '/api/memory-store')
  assert.deepEqual([...SETTINGS_WRITABLE], ['autoIngest', 'embeddingApiBase', 'embeddingApiKey'])
})

await t('未知字段 → UNKNOWN_SETTING（不静默忽略）', async () => {
  const r = validateSettingsPatch({ dataRoot: 'C:/x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNKNOWN_SETTING')
  assert.match(r.message, /dataRoot/)
})

await t('空 patch / 非对象 → BAD_ARGS', async () => {
  assert.equal(validateSettingsPatch({}).code, 'BAD_ARGS')
  assert.equal(validateSettingsPatch(null).code, 'BAD_ARGS')
  assert.equal(validateSettingsPatch([1]).code, 'BAD_ARGS')
})

await t('autoIngest 只接受布尔', async () => {
  assert.deepEqual(validateSettingsPatch({ autoIngest: true }), { ok: true, value: { autoIngest: true } })
  assert.equal(validateSettingsPatch({ autoIngest: 'true' }).code, 'BAD_SETTING_VALUE')
})

await t('base 必须 http(s)、尾斜杠归一、留空允许', async () => {
  assert.equal(validateSettingsPatch({ embeddingApiBase: 'ftp://x' }).code, 'BAD_SETTING_VALUE')
  assert.deepEqual(validateSettingsPatch({ embeddingApiBase: 'https://api.example.com/v1///' }).value, { embeddingApiBase: 'https://api.example.com/v1' })
  assert.deepEqual(validateSettingsPatch({ embeddingApiBase: '   ' }).value, { embeddingApiBase: '' })
})

await t('Key：换行/制表符拒绝、超长拒绝、空串=清除', async () => {
  assert.equal(validateSettingsPatch({ embeddingApiKey: 'sk-a\nb' }).code, 'BAD_SETTING_VALUE')
  assert.equal(validateSettingsPatch({ embeddingApiKey: 'k'.repeat(401) }).code, 'BAD_SETTING_VALUE')
  assert.deepEqual(validateSettingsPatch({ embeddingApiKey: '' }), { ok: true, value: { embeddingApiKey: '' } })
  assert.deepEqual(validateSettingsPatch({ embeddingApiKey: '  sk-test-123  ' }).value, { embeddingApiKey: 'sk-test-123' })
})

// ─────────────────────────────────────────────────────────── 4. 回显纪律
console.log('\n── 回显纪律（Key 不出门）──')

const FAKE_KEY = 'sk-super-secret-should-never-leak-0001'
const liveCfg = { autoIngest: true, embeddingApiBase: 'https://api.siliconflow.cn/v1', embeddingApiKey: FAKE_KEY }

await t('publicSettings 不回 Key 明文，只回 configured', async () => {
  const s = publicSettings({
    cfg: liveCfg, revision: 3, writable: true,
    embed: { ok: true, source: 'plugin-config', apiBase: 'https://api.siliconflow.cn/v1' },
    dataRoot: 'C:/Users/alice/.dsh/memory-jianmu', dataRootSource: 'config',
  })
  const text = JSON.stringify(s)
  assert.equal(text.includes(FAKE_KEY), false, 'Key 明文出现在设置视图里')
  assert.equal(s.embeddingApiKey.configured, true)
  assert.equal(s.embeddingApiKey.source, 'plugin-config')
  assert.equal(s.revision, 3)
  assert.equal(s.dataRoot.readOnly, true)
  for (const k of SETTINGS_WRITABLE) assert.ok(s.writableFields.includes(k))
})

await t('测试连接的任何返回都不含 Key', async () => {
  const embed = { ok: true, apiKey: FAKE_KEY, apiBase: 'https://api.example.com/v1', source: 'plugin-config' }
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ embedding: new Array(8).fill(0.1) }] }) })
  const r = await testEmbedding({ embed, model: 'm', dim: 8, fetchImpl })
  assert.equal(JSON.stringify(r).includes(FAKE_KEY), false)
  const failRes = await testEmbedding({ embed, model: 'm', dim: 8, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }) })
  assert.equal(JSON.stringify(failRes).includes(FAKE_KEY), false)
})

// ─────────────────────────────────────────────────────────── 5. 测试连接
console.log('\n── 测试连接 ──')

const embedOk = (over = {}) => ({ ok: true, apiKey: FAKE_KEY, apiBase: 'https://api.example.com/v1', source: 'plugin-config', ...over })

await t('成功：返回 ok / 延迟 / 模型 / 维度', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ embedding: new Array(4096).fill(0.01), index: 0 }] }) }
  }
  const r = await testEmbedding({ embed: embedOk(), model: 'Qwen/Qwen3-Embedding-8B', dim: 4096, fetchImpl })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.dim, 4096)
  assert.equal(r.dimMatch, true)
  assert.equal(r.model, 'Qwen/Qwen3-Embedding-8B')
  assert.equal(typeof r.latencyMs, 'number')
  assert.equal(seen.url, 'https://api.example.com/v1/embeddings')
  assert.equal(seen.auth, `Bearer ${FAKE_KEY}`)
  assert.equal(seen.body.model, 'Qwen/Qwen3-Embedding-8B')
  assert.equal(Array.isArray(seen.body.input), true)
})

await t('维度不符 → DIM_MISMATCH（不静默接受）', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }) })
  const r = await testEmbedding({ embed: embedOk(), model: 'm', dim: 4096, fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DIM_MISMATCH')
  assert.equal(r.dim, 1024)
  assert.equal(r.wantDim, 4096)
})

await t('HTTP 错误 → HTTP_ERROR（带状态码，不回 Key）', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'busy' })
  const r = await testEmbedding({ embed: embedOk(), model: 'm', dim: 0, fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'HTTP_ERROR')
  assert.equal(r.status, 503)
})

await t('超时 → TIMEOUT（AbortError 归类）', async () => {
  const fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
  const r = await testEmbedding({ embed: embedOk(), model: 'm', dim: 0, fetchImpl, timeoutMs: 50 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TIMEOUT')
})

await t('未配置 / 模型未知 → 明确错误码', async () => {
  const a = await testEmbedding({ embed: { ok: false }, model: 'm', dim: 0, fetchImpl: async () => { throw new Error('不该被调用') } })
  assert.equal(a.code, 'EMBEDDING_NOT_CONFIGURED')
  const b = await testEmbedding({ embed: embedOk(), model: '', dim: 0, fetchImpl: async () => { throw new Error('不该被调用') } })
  assert.equal(b.code, 'MODEL_UNKNOWN')
})

await t('返回里没有 data[0].embedding → BAD_RESPONSE', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) })
  const r = await testEmbedding({ embed: embedOk(), model: 'm', dim: 0, fetchImpl })
  assert.equal(r.code, 'BAD_RESPONSE')
})

// ─────────────────────────────────────────────────────────── 收尾
const failed = results.filter((r) => !r.ok)
console.log(`\n═══ 根藏 UI 半端自测：${results.length - failed.length}/${results.length} 通过 ═══`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}`)
  process.exitCode = 1
}
