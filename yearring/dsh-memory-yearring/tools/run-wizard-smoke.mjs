#!/usr/bin/env node
/**
 * tools/run-wizard-smoke.mjs —— 年轮「首次消化向导」端到端冒烟（不调模型）
 *
 * 用空临时 dataRoot：
 *   · POST /run 带安全头 + confirm → 200 started
 *   · 后台循环遇 EMPTY_ROOT 立即停（不调 LLM）
 *   · GET /status 能看到 uiRun 与 coverage（rootChunks=0）
 *   · POST /run 无安全头 → 403；缺 confirm → 400
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const HERE = dirname(fileURLToPath(import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), 'year-wizard-'))
const dataRoot = join(tmp, 'data')
await mkdir(join(dataRoot, 'scopes', 'alice'), { recursive: true })

const results = []
let failed = 0
const ok = (name, cond, detail) => {
  if (cond) results.push({ name, pass: true })
  else { failed += 1; results.push({ name, pass: false, detail }) }
}

const routes = []
const ctx = {
  logger: { info: () => {} },
  settings: { describe: () => [] },
  tools: { register: () => () => {} },
  provide: () => () => {},
  inject: (deps, cb) => cb({
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    effect: (fn) => fn(),
  }),
  get: () => undefined,
  on: () => {},
}

const mod = await import(pathToFileURL(join(HERE, '..', 'index.js')).href)
const dispose = mod.apply(ctx, { dataRoot, enabled: true })

const mkRes = () => ({
  statusCode: 0, headers: {}, body: '',
  setHeader(k, v) { this.headers[k] = v },
  end(b) { this.body = b },
})
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
const call = async (method, url, body, headers) => {
  const res = mkRes()
  await routes[0].handler(mkReq(method, url, body, headers), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* ignore */ }
  return { code: res.statusCode, json }
}

const noHead = await call('POST', '/api/year-ring/run', { personaId: 'alice', confirm: true })
ok('POST /run 无安全头 → 403', noHead.code === 403 && noHead.json?.code === 'CSRF_GUARD', noHead)

const noConfirm = await call('POST', '/api/year-ring/run', { personaId: 'alice' }, { 'x-dsh-jianmu': '1' })
ok('POST /run 缺 confirm → 400', noConfirm.code === 400 && noConfirm.json?.code === 'CONFIRM_REQUIRED', noConfirm)

const started = await call('POST', '/api/year-ring/run', { personaId: 'alice', confirm: true, scope: 'last:90d' }, { 'x-dsh-jianmu': '1' })
ok('POST /run 合法 → 200 started', started.code === 200 && started.json?.ok === true && started.json?.started === true, started)

// 等后台循环把 EMPTY_ROOT 走完（不调模型）
await new Promise((r) => setTimeout(r, 800))

const st = await call('GET', '/api/year-ring/status?personaId=alice')
ok('GET /status 200', st.code === 200 && st.json?.ok === true, st.code)
ok('status 有 coverage（空库 rootChunks=0）', st.json?.coverage?.rootChunks === 0, st.json?.coverage)
ok('status 有 uiRun（后台循环已停）', st.json?.uiRun && st.json.uiRun.running === false, st.json?.uiRun)
ok('空库时 launch 不产生 claim', Number(st.json?.counts?.claims || 0) === 0, st.json?.counts)

dispose()
await rm(tmp, { recursive: true, force: true }).catch(() => {})

for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  ← ' + JSON.stringify(r.detail).slice(0, 400)}`)
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
