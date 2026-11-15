#!/usr/bin/env node
/** 星图只读路由冒烟：不启动 DSH，直接喂 req/res 给 handler */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { makeStarmapRoute } from '../lib/starmap-routes.mjs'
import { defaultDataRoot } from '../lib/paths.mjs'

const uiDir = fileURLToPath(new URL('../starmap-ui/', import.meta.url))
const route = makeStarmapRoute({ getDataRoot: () => defaultDataRoot(), uiDir })
let activeRoute = route

function call(url, { method = 'GET', remote = '127.0.0.1', body } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}) },
      end(b) {
        chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? '')))
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) })
      },
    }
    Promise.resolve(activeRoute.handler({ method, url, body, socket: { remoteAddress: remote } }, res)).catch((e) => {
      resolve({ status: 500, headers: {}, body: Buffer.from(String(e)) })
    })
  })
}

let n = 0
const ok = (cond, label) => { assert.ok(cond, label); n++; console.log(`  ok ${label}`) }

const st = await call('/api/jianmu-starmap/status')
const status = JSON.parse(st.body.toString('utf8'))
ok(st.status === 200, 'status 200')
ok(status.ok === true && status.ready === true, '有数据 ready')
const personas = status.personas || []
ok(personas.length >= 1, `personas ${personas.map((p) => p.id).join(',')}`)
const pid = personas[0].id

const stats = await call(`/api/jianmu-starmap/stats?personaId=${pid}`)
ok(stats.status === 200 && JSON.parse(stats.body.toString('utf8')).points > 0, 'stats 可读且有点数')

const meta = await call(`/api/jianmu-starmap/meta?personaId=${pid}`)
ok(meta.status === 200 && Array.isArray(JSON.parse(meta.body.toString('utf8'))), 'meta 是数组')

const bin = await call(`/api/jianmu-starmap/bin?personaId=${pid}`)
ok(bin.status === 200 && bin.body.length > 1000, `bin ${bin.body.length} bytes`)

const html = await call('/api/jianmu-starmap/ui/index.html')
ok(html.status === 200 && String(html.headers['content-type']).includes('text/html'), 'ui index.html')

const app = await call('/api/jianmu-starmap/ui/app.js')
ok(app.status === 200 && String(app.headers['content-type']).includes('javascript'), 'ui app.js')

const trav = await call('/api/jianmu-starmap/ui/..%2f..%2fpackage.json')
ok(trav.status === 403 || trav.status === 404, `路径穿越被挡（${trav.status}）`)

const forbid = await call('/api/jianmu-starmap/status', { remote: '10.0.0.8' })
ok(forbid.status === 403, '非本机 403')

const missing = await call('/api/jianmu-starmap/stats?personaId=__nope__')
ok(missing.status === 404, '无数据 404')

// ── 构建端点（用假 runner，不真跑 python）────────────────────────
const fake = { started: 0, lastPersonas: null }
const fakeRunning = {
  start({ personas }) {
    fake.started++
    fake.lastPersonas = personas
    return { ok: true, code: 'STARTED', status: { running: true, startedAt: new Date().toISOString(), elapsedMs: 0, ok: null, code: null, personas, pid: 4242, tail: '' } }
  },
  status() {
    return { running: false, startedAt: null, elapsedMs: 1234, ok: true, code: 'OK', personas: [], pid: null, tail: '[starmap] 已写入 …' }
  },
  kill() {},
}
const busy = { start: () => ({ ok: false, code: 'BUILD_RUNNING', status: { running: true, elapsedMs: 800 } }), status: () => ({ running: true }), kill() {} }

// 让 call 走指定的路由实例
function callWith(r, url, opts) {
  const prev = activeRoute
  activeRoute = r
  return call(url, opts).finally(() => { activeRoute = prev })
}

const buildRoute = makeStarmapRoute({ getDataRoot: () => defaultDataRoot(), uiDir, buildRunner: fakeRunning })
const busyRoute = makeStarmapRoute({ getDataRoot: () => defaultDataRoot(), uiDir, buildRunner: busy })

const noConfirm = await callWith(buildRoute, '/api/jianmu-starmap/build', { method: 'POST' })
ok(noConfirm.status === 400 && JSON.parse(noConfirm.body.toString('utf8')).code === 'CONFIRM_REQUIRED', '构建缺 confirm → 400')

const badPid = await callWith(buildRoute, '/api/jianmu-starmap/build?confirm=1&personas=a%2Fb', { method: 'POST' })
ok(badPid.status === 400 && JSON.parse(badPid.body.toString('utf8')).code === 'BAD_PERSONA', '构建 personaId 非法 → 400')

const getBuild = await callWith(buildRoute, '/api/jianmu-starmap/build?confirm=1')
ok(getBuild.status === 405, `GET /build → 405（${getBuild.status}）`)

const remoteBuild = await callWith(buildRoute, '/api/jianmu-starmap/build?confirm=1', { method: 'POST', remote: '10.0.0.8' })
ok(remoteBuild.status === 403, '非本机构建 → 403')

const started2 = await callWith(buildRoute, '/api/jianmu-starmap/build?confirm=1&personas=alice,bob', { method: 'POST' })
ok(started2.status === 202 && JSON.parse(started2.body.toString('utf8')).accepted === true, '构建启动 → 202')
ok(fake.started === 1 && String(fake.lastPersonas) === 'alice,bob', '构建收到 personas')

const bodyConfirm = await callWith(buildRoute, '/api/jianmu-starmap/build', { method: 'POST', body: '{"confirm":1,"personas":["alice"]}' })
ok(bodyConfirm.status === 202, 'JSON body confirm 也可启动')

const statusRes = await callWith(buildRoute, '/api/jianmu-starmap/build-status')
const stJson = JSON.parse(statusRes.body.toString('utf8'))
ok(statusRes.status === 200 && 'running' in stJson && 'tail' in stJson && stJson.ok === true, 'build-status 字段齐全')

const conflict = await callWith(busyRoute, '/api/jianmu-starmap/build?confirm=1', { method: 'POST' })
ok(conflict.status === 409 && JSON.parse(conflict.body.toString('utf8')).code === 'BUILD_RUNNING', '并发构建 → 409')

const travBuild = await callWith(buildRoute, '/api/jianmu-starmap/build', { method: 'POST', body: '{"confirm":1,"personas":["../x"]}' })
ok(travBuild.status === 400, '构建路径穿造型 persona → 400')

console.log(`\n星图路由冒烟通过：${n} 项`)
