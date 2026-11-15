/**
 * 星图路由：/api/jianmu-starmap/*
 * - /status | /personas        扫 <dataRoot>/starmap/stats-*.json
 * - /stats?personaId=          读 stats-<pid>.json
 * - /meta?personaId=           读 starmap-<pid>.meta.json
 * - /bin?personaId=            优先读 starmap-<pid>-blade.bin（V10），否则 starmap-<pid>.bin
 * - /ui/…                      只读发 starmap-ui/ 静态文件（index.html/app.js/vendor/nebula）
 * - POST /build?confirm=1      后台重建星图（本机 + confirm；并发 409）——唯一写端点
 * - /build-status              构建进度 {running, startedAt, elapsedMs, ok, code, tail}
 * 除 /build 外只读、只本机回环；构建只写 <dataRoot>/starmap。
 */
import { join, resolve, sep, dirname } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { readIdentity } from './root.mjs'

export const STARMAP_PREFIX = '/api/jianmu-starmap'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function mimeOf(file) {
  const i = file.lastIndexOf('.')
  return (i >= 0 && MIME[file.slice(i).toLowerCase()]) || 'application/octet-stream'
}

function isLoopback(req) {
  let remote = String(req.socket?.remoteAddress || '')
  if (remote.startsWith('::ffff:')) remote = remote.slice(7)
  return remote === '127.0.0.1' || remote === '::1'
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function sendFile(res, file, cache = 'no-cache') {
  const data = await readFile(file)
  res.statusCode = 200
  res.setHeader('content-type', mimeOf(file))
  res.setHeader('content-length', String(data.length))
  res.setHeader('cache-control', cache)
  res.end(data)
}

// ── 构建执行器：单飞（同一时刻只跑一个）+ 8KB 环形日志尾 ──────────────
const BUILD_TAIL_BYTES = 8 * 1024
const PERSONA_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PERSONAS = 16

// 找一个能 import numpy 的 Python：JIANMU_PYTHON > DSH 运行时 > PATH 里的 python/python3。
// 本机实测 PATH 里的 Python 3.13 没 numpy，不能盲信 'python'。
function pythonCandidates() {
  const list = []
  if (process.env.JIANMU_PYTHON) list.push(process.env.JIANMU_PYTHON)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  list.push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  list.push('python')
  list.push('python3')
  return list
}

function resolvePython() {
  if (process.env.JIANMU_PYTHON) return process.env.JIANMU_PYTHON
  for (const cand of pythonCandidates()) {
    const r = spawnSync(cand, ['-c', 'import numpy'], { windowsHide: true, timeout: 10000 })
    if (!r.error && r.status === 0) return cand
  }
  return 'python'
}

function createBuildRunner({ getDataRoot, pluginRoot }) {
  const state = {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    ok: null,
    code: null,
    personas: [],
    pid: null,
    tail: '',
  }
  let child = null
  const append = (s) => {
    state.tail += s
    if (state.tail.length > BUILD_TAIL_BYTES) state.tail = state.tail.slice(-BUILD_TAIL_BYTES)
  }
  const status = () => {
    const end = state.running ? Date.now() : (state.finishedAt || Date.now())
    return {
      running: state.running,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      elapsedMs: state.startedAt ? Math.max(0, end - state.startedAt) : 0,
      ok: state.ok,
      code: state.code,
      personas: state.personas.slice(),
      pid: state.pid,
      tail: state.tail,
    }
  }
  function start({ personas = [] } = {}) {
    if (state.running) return { ok: false, code: 'BUILD_RUNNING', status: status() }
    const script = join(pluginRoot, 'tools', 'starmap-build.mjs')
    const py = resolvePython()
    const env = {
      ...process.env,
      JIANMU_PYTHON: py,
      JIANMU_DATA_ROOT: getDataRoot(),
      JIANMU_STARMAP_OUT: join(getDataRoot(), 'starmap'),
      // Windows 下 python 默认按 GBK 输出中文 → 日志尾会乱码；强制 UTF-8
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    }
    state.running = true
    state.startedAt = Date.now()
    state.finishedAt = 0
    state.ok = null
    state.code = null
    state.personas = personas.slice()
    state.pid = null
    state.tail = ''
    append(`[starmap] python: ${py}\n`)
    try {
      child = spawn(process.execPath, [script, ...personas], { cwd: pluginRoot, env, windowsHide: true })
    } catch (e) {
      state.running = false
      state.finishedAt = Date.now()
      state.ok = false
      state.code = 'SPAWN_FAILED'
      append(`[starmap] 无法启动构建进程：${e?.message || e}\n`)
      return { ok: false, code: 'SPAWN_FAILED', status: status() }
    }
    state.pid = child.pid || null
    if (child.stdout) child.stdout.setEncoding('utf8')
    if (child.stderr) child.stderr.setEncoding('utf8')
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (e) => append(`[starmap] 进程错误：${e?.message || e}\n`))
    child.on('close', (code, signal) => {
      state.running = false
      state.finishedAt = Date.now()
      state.code = signal ? `SIGNAL:${signal}` : (code === 0 ? 'OK' : `EXIT:${code}`)
      state.ok = !signal && code === 0
      append(`\n[starmap] 构建${state.ok ? '完成' : '失败'}（${state.code}，用时 ${Math.round((state.finishedAt - state.startedAt) / 1000)}s）\n`)
      child = null
    })
    return { ok: true, code: 'STARTED', status: status() }
  }
  return {
    start,
    status,
    kill() { try { child?.kill() } catch { /* 忽略 */ } },
  }
}

function readBody(req, limit = 4096) {
  return new Promise((done) => {
    // 冒烟测试可以直接塞 req.body（字符串/对象）；真实 http 走流
    if (typeof req.body === 'string') return done(req.body)
    if (Buffer.isBuffer(req.body)) return done(req.body.toString('utf8'))
    if (req.body && typeof req.body === 'object') return done(JSON.stringify(req.body))
    if (typeof req.on !== 'function') return done('')
    let data = ''
    let settled = false
    const finish = () => { if (!settled) { settled = true; done(data) } }
    req.setEncoding?.('utf8')
    req.on('data', (c) => { if (data.length < limit) data += String(c) })
    req.on('end', finish)
    req.on('error', finish)
  })
}

function hasConfirm(q, bodyText) {
  if (String(q.confirm || '') === '1') return true
  const t = String(bodyText || '').trim()
  if (!t) return false
  try {
    const j = JSON.parse(t)
    if (j && typeof j === 'object') return j.confirm === 1 || j.confirm === '1' || j.confirm === true
  } catch { /* 不是 JSON，继续当表单解析 */ }
  try {
    const p = new URLSearchParams(t)
    const v = p.get('confirm')
    return v === '1' || v === 'true'
  } catch { return false }
}

function parsePersonas(q, bodyText) {
  let raw = q.personas
  if (!raw) {
    try {
      const j = JSON.parse(bodyText || '{}')
      raw = Array.isArray(j?.personas) ? j.personas.join(',') : j?.personas
    } catch {
      try { raw = new URLSearchParams(bodyText || '').get('personas') } catch { raw = null }
    }
  }
  if (!raw) return { ok: true, personas: [] }
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean)
  if (list.length > MAX_PERSONAS) return { ok: false, reason: `personas 最多 ${MAX_PERSONAS} 个` }
  for (const p of list) if (!PERSONA_RE.test(p)) return { ok: false, reason: `personaId 非法：${p}` }
  return { ok: true, personas: list }
}

async function personaNames(getDataRoot) {
  const names = {}
  try {
    const id = await readIdentity(getDataRoot())
    if (id?.ok) {
      for (const [pid, meta] of Object.entries(id.identity?.personas || {})) {
        names[pid] = meta?.displayName || pid
      }
    }
  } catch { /* identity 不可读就只回 id */ }
  return names
}

async function listPersonas(getDataRoot) {
  const dir = join(getDataRoot(), 'starmap')
  if (!existsSync(dir)) return []
  const names = await personaNames(getDataRoot)
  const files = await readdir(dir)
  const out = []
  for (const f of files) {
    const m = /^stats-(.+)\.json$/.exec(f)
    if (!m) continue
    const pid = m[1]
    let stats = null
    try { stats = JSON.parse(await readFile(join(dir, f), 'utf8')) } catch { continue }
    const blade = join(dir, `starmap-${pid}-blade.bin`)
    const base = join(dir, `starmap-${pid}.bin`)
    out.push({
      id: pid,
      displayName: names[pid] || pid,
      points: Number(stats?.points) || 0,
      k: Number(stats?.k) || 0,
      builtAt: stats?.builtAt || null,
      layout: existsSync(blade) ? 'blade' : (existsSync(base) ? 'bands' : 'missing'),
    })
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return out
}

function pickBin(dir, pid) {
  const blade = join(dir, `starmap-${pid}-blade.bin`)
  if (existsSync(blade) && statSync(blade).isFile()) return blade
  const base = join(dir, `starmap-${pid}.bin`)
  if (existsSync(base) && statSync(base).isFile()) return base
  return null
}

export function makeStarmapRoute({ getDataRoot, uiDir, pluginRoot, buildRunner } = {}) {
  const root = resolve(uiDir)
  const pRoot = resolve(pluginRoot || dirname(root))
  const runner = buildRunner || createBuildRunner({ getDataRoot, pluginRoot: pRoot })
  const route = {
    kind: 'prefix',
    path: STARMAP_PREFIX,
    dispose: () => runner.kill?.(),
    handler: async (req, res) => {
      try {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: { code: 'FORBIDDEN', message: '仅限本机访问' } })

        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sub = url.pathname.slice(STARMAP_PREFIX.length) || '/'
        const q = Object.fromEntries(url.searchParams.entries())
        const dir = join(getDataRoot(), 'starmap')
        const method = String(req.method || 'GET').toUpperCase()

        // ── 唯一的写端点：POST /build（本机 + confirm=1；并发 409）──
        if (sub === '/build') {
          if (method !== 'POST') {
            res.setHeader('allow', 'POST')
            return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '构建端点只接受 POST' } })
          }
          const bodyText = await readBody(req)
          if (!hasConfirm(q, bodyText)) {
            return sendJson(res, 400, { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '缺少 confirm=1' } })
          }
          const pv = parsePersonas(q, bodyText)
          if (!pv.ok) {
            return sendJson(res, 400, { ok: false, code: 'BAD_PERSONA', error: { code: 'BAD_PERSONA', message: pv.reason } })
          }
          const r = runner.start({ personas: pv.personas })
          if (r.code === 'BUILD_RUNNING') {
            return sendJson(res, 409, { ok: false, code: 'BUILD_RUNNING', error: { code: 'BUILD_RUNNING', message: '已有一个构建在跑' }, status: r.status })
          }
          if (!r.ok) {
            return sendJson(res, 500, { ok: false, code: r.code || 'BUILD_FAILED', error: { code: r.code || 'BUILD_FAILED', message: '构建进程启动失败' }, status: r.status })
          }
          return sendJson(res, 202, { ok: true, accepted: true, status: r.status })
        }

        if (sub === '/build-status') {
          if (method !== 'GET') return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 GET' } })
          return sendJson(res, 200, { ok: true, ...runner.status() })
        }

        if (method !== 'GET') {
          return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: { code: 'METHOD_NOT_ALLOWED', message: '只读端点只接受 GET（写操作只有 POST /build）' } })
        }

        if (sub === '/' || sub === '/status' || sub === '/personas') {
          const personas = await listPersonas(getDataRoot)
          return sendJson(res, 200, { ok: true, ready: personas.length > 0, dataDir: dir, personas })
        }

        if (sub === '/stats' || sub === '/meta' || sub === '/bin') {
          const pid = String(q.personaId || '').trim()
          if (!pid || !/^[A-Za-z0-9_-]{1,64}$/.test(pid)) {
            return sendJson(res, 400, { ok: false, code: 'BAD_PERSONA', error: { code: 'BAD_PERSONA', message: 'personaId 非法或缺失' } })
          }
          if (sub === '/stats') {
            const fp = join(dir, `stats-${pid}.json`)
            if (!existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NO_DATA', error: { code: 'NO_DATA', message: '还没有星图数据' } })
            return sendFile(res, fp, 'no-store')
          }
          if (sub === '/meta') {
            const fp = join(dir, `starmap-${pid}.meta.json`)
            if (!existsSync(fp)) return sendJson(res, 404, { ok: false, code: 'NO_DATA', error: { code: 'NO_DATA', message: '还没有星图数据' } })
            return sendFile(res, fp, 'no-store')
          }
          const fp = pickBin(dir, pid)
          if (!fp) return sendJson(res, 404, { ok: false, code: 'NO_DATA', error: { code: 'NO_DATA', message: '还没有星图数据' } })
          return sendFile(res, fp, 'no-store')
        }

        if (sub === '/ui' || sub.startsWith('/ui/')) {
          let rel = sub === '/ui' ? 'index.html' : decodeURIComponent(sub.slice('/ui/'.length))
          // /ui/ 尾斜杠会被解析成目录 → 404；目录一律回落到 index.html
          if (!rel || rel.endsWith('/')) rel += 'index.html'
          const fp = resolve(root, rel.replace(/^\/+/, ''))
          if (fp !== root && !fp.startsWith(root + sep)) {
            return sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: { code: 'FORBIDDEN', message: '路径越界' } })
          }
          if (!existsSync(fp) || !statSync(fp).isFile()) {
            return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: '文件不存在' } })
          }
          const cache = /[\\/]vendor[\\/]/.test(fp) || /\.(jpg|jpeg|png|webp|svg|woff2)$/i.test(fp)
            ? 'public, max-age=3600'
            : 'no-cache'
          return sendFile(res, fp, cache)
        }

        return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `未知星图端点：${sub}` } })
      } catch (e) {
        return sendJson(res, 500, {
          ok: false, code: e?.code || 'STARMAP_FAILED',
          error: { code: e?.code || 'STARMAP_FAILED', message: String(e?.message || e) },
        })
      }
    },
  }
  return route
}
