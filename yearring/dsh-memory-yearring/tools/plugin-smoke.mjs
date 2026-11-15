#!/usr/bin/env node
/**
 * tools/plugin-smoke.mjs —— 宿主加载冒烟（不重启 DSH）
 *
 * 用一个 mock ctx 真调用 `apply(ctx, config)`，验证：
 *   · 模块能被加载（顶层 await / 依赖解析没问题）
 *   · 7 个工具全部注册且名字正确
 *   · host 只读服务注册
 *   · HTTP 只读路由挂上（path /api/year-ring）
 *   · 守卫自检不抛（工具面不一致会抛）
 *   · dispose 干净
 *
 * 注意：这不等于真实宿主加载（真宿主还要过 peer 依赖、profile bundles），
 *       但能提前抓 90% 的「一装就炸」问题。
 */
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')

const results = []
let failed = 0
const ok = (name, cond, detail) => {
  if (cond) results.push({ name, pass: true })
  else { failed += 1; results.push({ name, pass: false, detail }) }
}

let mod
try {
  mod = await import(pathToFileURL(join(PKG_DIR, 'index.js')).href)
  ok('index.js 可加载（顶层 import/await 无异常）', true)
} catch (e) {
  ok('index.js 可加载（顶层 import/await 无异常）', false, String(e?.stack || e))
  console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }))
  process.exit(1)
}

ok('导出 name = memory-yearring', mod.name === 'memory-yearring', mod.name)
ok('导出 apply 函数', typeof mod.apply === 'function')
ok('导出 Config（可选）', mod.Config === undefined || typeof mod.Config === 'object' || typeof mod.Config === 'function')

// ── mock ctx ──────────────────────────────────────────────────────────────
const tools = new Map()
const provided = new Map()
const routes = []
const disposed = []
const effects = []
const logs = []

const fakeLlm = {
  async *stream() { yield { type: 'finish', reason: 'stop' } },
}

const ctx = {
  logger: { info: (m) => logs.push(String(m)) },
  settings: { describe: () => [] },
  tools: {
    register: (def) => {
      tools.set(def.name, def)
      const d = () => disposed.push(def.name)
      return d
    },
  },
  provide: (name, svc) => { provided.set(name, svc); return () => disposed.push(name) },
  inject: (deps, cb) => {
    const sub = {
      webServer: { register: (route) => { routes.push(route); return () => disposed.push('route') } },
      effect: (fn) => { effects.push(fn); fn() },
    }
    cb(sub)
  },
  get: (name) => {
    if (name === 'llm') return fakeLlm
    if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {} } }
    return undefined
  },
  on: () => {},
}

let dispose = null
try {
  dispose = mod.apply(ctx, {})
  ok('apply(ctx, config) 不抛异常', true)
} catch (e) {
  ok('apply(ctx, config) 不抛异常', false, String(e?.stack || e))
}

if (dispose) {
  ok('apply 返回 dispose 函数', typeof dispose === 'function')
  ok('注册工具数 = 7', tools.size === 7, [...tools.keys()])
  const expected = [
    'jianmu_year_status', 'jianmu_year_topics', 'jianmu_year_claim',
    'jianmu_year_run', 'jianmu_year_rebuild', 'jianmu_year_verify', 'jianmu_year_export',
  ]
  ok('工具名完全匹配', expected.every((n) => tools.has(n)), [...tools.keys()])
  ok('工具都有 description', [...tools.values()].every((t) => typeof t.description === 'string' && t.description.length > 8))
  ok('工具都有 execute', [...tools.values()].every((t) => typeof t.execute === 'function'))
  ok('注册 host 服务 jianmuYear', provided.has('jianmuYear'), [...provided.keys()])
  ok('挂载 HTTP 只读路由', routes.length >= 1 && routes[0].path === '/api/year-ring', routes.map((r) => r.path))
  ok('路由是 prefix 且只读（handler 存在）', routes[0]?.kind === 'prefix' && typeof routes[0]?.handler === 'function')
  // 插件内自动消化已接线：默认开、下一次运行时间是对齐到 :27 的时间戳
  const auto = typeof dispose.autoDigest === 'function' ? dispose.autoDigest() : null
  ok('自动消化已接线（默认开 + 有下次运行时间）',
    Boolean(auto && auto.enabled === true && Number.isFinite(auto.nextRunAt)),
    auto)
  ok('自动消化默认对齐到每小时 :27', Boolean(auto && auto.minute === 27), auto?.minute)
  try {
    dispose()
    ok('dispose 不抛', true)
  } catch (e) {
    ok('dispose 不抛', false, String(e?.message || e))
  }
}

// ── 只读 API 冒烟（用真实 dataRoot 的只读端点）────────────────────────────
if (provided.has('jianmuYear')) {
  const svc = provided.get('jianmuYear')
  try {
    const st = await svc.status('alice')
    ok('host 服务 status 可调用', st && st.ok === true, st?.error)
    const tp = await svc.topics('alice')
    ok('host 服务 topics 可调用', tp && tp.ok === true)
  } catch (e) {
    ok('host 服务可调用', false, String(e?.message || e))
  }
}

// ── HTTP 路由冒烟：真喂 req/res ─────────────────────────────────────────────
if (routes.length) {
  const mkRes = () => {
    const res = {
      statusCode: 0, headers: {}, body: '',
      setHeader(k, v) { this.headers[k] = v },
      end(b) { this.body = b },
    }
    return res
  }
  const call = async (url) => {
    const res = mkRes()
    await routes[0].handler({ method: 'GET', url }, res)
    let json = null
    try { json = JSON.parse(res.body) } catch { /* 忽略 */ }
    return { code: res.statusCode, json, ct: res.headers['content-type'] }
  }
  const st = await call('/api/year-ring/status?personaId=alice')
  ok('HTTP status 200 且 ok=true', st.code === 200 && st.json?.ok === true, st)
  ok('HTTP 返回 JSON content-type', String(st.ct || '').includes('application/json'), st.ct)
  ok('status 带 coverage（根藏块数/已覆盖/剩余/估算）', Boolean(st.json?.coverage) && Number(st.json.coverage.rootChunks) >= 0 && 'remaining' in st.json.coverage, st.json?.coverage)
  const tp = await call('/api/year-ring/topics?personaId=alice')
  ok('HTTP topics 200', tp.code === 200 && tp.json?.ok === true, tp.code)
  const vr = await call('/api/year-ring/verify?personaId=alice')
  ok('HTTP verify 200', vr.code === 200 && typeof vr.json?.ok === 'boolean', vr.code)
  const nf = await call('/api/year-ring/nope?personaId=alice')
  ok('未知端点 404', nf.code === 404, nf.code)
  const probe = await call('/api/year-ring/status')
  ok('探针：无 persona 也 200 且 resolved=false（UI tab 靠它出现）', probe.code === 200 && probe.json?.ok === true && probe.json?.resolved === false, { code: probe.code, resolved: probe.json?.resolved })
  const topicNoWho = await call('/api/year-ring/topics')
  ok('非探针端点无 persona → 409', topicNoWho.code === 409, topicNoWho.code)

  // 产品层兜底：POST /run 的三道闸门（不真跑模型）
  const mkReq = (method, url, body = null, headers = {}) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = headers
    process.nextTick(() => {
      if (body != null) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    return req
  }
  const postRes = async (url, body, headers) => {
    const res = mkRes()
    await routes[0].handler(mkReq('POST', url, body, headers), res)
    let json = null
    try { json = JSON.parse(res.body) } catch { /* 忽略 */ }
    return { code: res.statusCode, json }
  }
  const noHead = await postRes('/api/year-ring/run', { personaId: 'alice', confirm: true })
  ok('POST /run 无安全头 → 403 CSRF_GUARD', noHead.code === 403 && noHead.json?.code === 'CSRF_GUARD', noHead)
  const noConfirm = await postRes('/api/year-ring/run', { personaId: 'alice' }, { 'x-dsh-jianmu': '1' })
  ok('POST /run 缺 confirm → 400 CONFIRM_REQUIRED', noConfirm.code === 400 && noConfirm.json?.code === 'CONFIRM_REQUIRED', noConfirm)
  const unknownPost = await postRes('/api/year-ring/status', {}, { 'x-dsh-jianmu': '1' })
  ok('未知写端点 → 404', unknownPost.code === 404, unknownPost)
}

for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  ← ' + JSON.stringify(r.detail)}`)
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ''}`)
if (logs.length) console.log('日志：' + logs.join(' | '))
process.exit(failed ? 1 : 0)
