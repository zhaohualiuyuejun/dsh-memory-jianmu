/**
 * lib/auto-ingest.mjs —— 根藏插件内增量摄取（带向量，先嵌后写）
 * ============================================================================
 * 为什么要有这个文件：
 *   以前每小时摄取靠 Windows 计划任务 `JianmuRootIngest` 直接起 `node.exe`，
 *   每次都会在屏幕上闪一个黑色控制台窗口（真实用户不可接受）。
 *   现在把同一条流水线搬进插件：setTimeout 定时 → 本进程内直接跑，不 spawn、不弹窗。
 *
 * 与 tools/ingest-hourly.mjs 的关系：
 *   · 流水线逻辑同源（抽取 → 折叠 sourceType → 校验 → 去重 → 先嵌后写）；
 *   · 差异：不 spawn 子进程、不写插件包目录（日志/状态/锁都在 <dataRoot>/_logs/）；
 *   · tools/ingest-hourly.mjs 保留作手动运维入口（不删）。
 *
 * 失败策略：任何一块拿不到向量 → 本轮该人格不写，下轮重试；绝不写半截向量。
 * 写入范围：只写 <dataRoot>/scopes/<personaId>/ 与 <dataRoot>/_logs/。
 * ============================================================================
 */
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  sessionsRoot, PERSONA_UNASSIGNED, defaultDataRoot, dshHome,
  logsDir, autoIngestStatePath, autoIngestLogPath, autoIngestLockPath,
} from './paths.mjs'
import { extractSessions } from './session-extract.mjs'
import { buildChunks } from './chunker.mjs'
import { makeUtterance, validateChunk, inferChannel, legacyRowHash, foldLegacySourceType } from './chunks.mjs'
import { loadIdentity, resolvePersona } from './identity.mjs'
import { readScopeMeta, readScopeChunks, appendUtterances } from './store.mjs'
import { atomicWrite, readJson } from './fsatomic.mjs'

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'
const LOCK_STALE_MS = 30 * 60 * 1000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sanitizeText(s) {
  return String(s ?? '').replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  )
}

function l2(v) {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s)
  return n ? v.map((x) => x / n) : v
}

async function postJson(url, body, { headers = {}, timeoutMs = 180000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try { detail = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || detail } catch { /* 原样 */ }
    const err = new Error(`HTTP ${res.status}：${detail}`)
    err.status = res.status
    throw err
  }
  try { return JSON.parse(text) } catch { throw new Error('返回不是 JSON：' + text.slice(0, 200)) }
}

/**
 * 嵌入配置：优先插件设置；留空回退读寻枝 config（兼容旧部署）。
 * 产品化口径：用户只装根藏时，在「设置 → 根藏」里填 embeddingApiKey 即可。
 */
export function loadEmbeddingConfig(config = {}) {
  const base = {
    apiKey: '',
    apiBase: '',
    source: null,
    file: null,
  }
  const cfgKey = typeof config.embeddingApiKey === 'string' ? config.embeddingApiKey.trim() : ''
  const cfgBase = typeof config.embeddingApiBase === 'string' ? config.embeddingApiBase.trim() : ''
  if (cfgKey) return { ok: true, ...base, apiKey: cfgKey, apiBase: cfgBase || DEFAULT_BASE, source: 'plugin-config' }

  const file = join(dshHome(), 'session-recall', 'config.json')
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      const key = typeof j?.apiKey === 'string' ? j.apiKey.trim() : ''
      if (key) {
        return {
          ok: true,
          apiKey: key,
          apiBase: (typeof j?.apiBase === 'string' && j.apiBase.trim()) || cfgBase || DEFAULT_BASE,
          source: 'session-recall-config',
          file,
        }
      }
    } catch { /* 配置坏了就按未配置处理 */ }
  }
  return {
    ok: false,
    code: 'EMBEDDING_NOT_CONFIGURED',
    message: '没有可用的嵌入密钥：请在「设置 → 根藏 → 嵌入服务密钥」里填写，或让寻枝配置里存在 apiKey',
    apiKey: '',
    apiBase: cfgBase || DEFAULT_BASE,
    source: null,
    file,
  }
}

/** 批量嵌入；任何一块拿不到向量就抛错（宁可本轮不写，也不写半截） */
async function embedTexts(texts, { apiKey, apiBase, model, dim, batch = 16 }) {
  const endpoint = `${(apiBase || DEFAULT_BASE).replace(/\/+$/, '')}/embeddings`
  const flat = new Float32Array(texts.length * dim)
  const usage = { prompt_tokens: 0, total_tokens: 0 }
  let requests = 0
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch).map(sanitizeText)
    let d = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        d = await postJson(endpoint, { model, input: part }, { headers: { Authorization: `Bearer ${apiKey}` } })
        break
      } catch (e) {
        const retryable = !e.status || e.status === 429 || e.status >= 500
        if (!retryable || attempt === 4) throw e
        await sleep(800 * Math.pow(2, attempt - 1))
      }
    }
    requests++
    if (!Array.isArray(d?.data)) throw new Error('返回里没有 data：' + JSON.stringify(d).slice(0, 200))
    const rows = [...d.data].sort((a, b) => a.index - b.index)
    if (rows.length !== part.length) throw new Error(`向量行数不符：返回 ${rows.length}，期望 ${part.length}`)
    for (let k = 0; k < rows.length; k++) {
      const vec = rows[k]?.embedding
      if (!Array.isArray(vec) || vec.length !== dim) throw new Error(`第 ${i + k} 块向量维度异常：${vec?.length}`)
      flat.set(l2(vec), (i + k) * dim)
    }
    if (d.usage) {
      usage.prompt_tokens += Number(d.usage.prompt_tokens || 0)
      usage.total_tokens += Number(d.usage.total_tokens || 0)
    }
  }
  return { vectors: flat, usage, requests }
}

/** 运行锁：同一时间只允许一个摄取（插件定时器 / 手动 CLI 互相协调） */
async function acquireRunLock(dataRoot) {
  const dir = logsDir(dataRoot)
  await mkdir(dir, { recursive: true })
  const file = autoIngestLockPath(dataRoot)
  const payload = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), tool: 'dsh-memory-store:auto-ingest' })

  const release = async () => {
    try {
      const cur = JSON.parse(await readFile(file, 'utf8'))
      if (Number(cur?.pid) === process.pid) await unlink(file)
    } catch { /* 锁已不在就算了 */ }
  }

  const create = async () => {
    const fh = await open(file, 'wx')
    try { await fh.writeFile(payload, 'utf8') } finally { await fh.close() }
  }

  try {
    await create()
    return { ok: true, release }
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: `建锁失败：${e.code || e.message}` }
  }

  let stale = false
  try {
    const cur = JSON.parse(await readFile(file, 'utf8'))
    const age = Date.now() - Date.parse(cur?.startedAt)
    let alive = false
    try { process.kill(Number(cur?.pid), 0); alive = true } catch { alive = false }
    stale = !alive || !(age >= 0) || age > LOCK_STALE_MS
  } catch { stale = true }
  if (!stale) return { ok: false, reason: '另一个摄取还在跑（锁未过期）' }

  try { await unlink(file) } catch { /* 可能已被别人清掉 */ }
  try {
    await create()
    return { ok: true, release }
  } catch (e) {
    return { ok: false, reason: `抢锁失败：${e.code || e.message}` }
  }
}

async function appendRunLog(dataRoot, entry) {
  try {
    await mkdir(logsDir(dataRoot), { recursive: true })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(autoIngestLogPath(dataRoot), JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 日志失败不阻塞摄取 */ }
}

async function patchState(dataRoot, patch) {
  try {
    const cur = await readJson(autoIngestStatePath(dataRoot))
    const prev = cur.ok && cur.value && typeof cur.value === 'object' ? cur.value : {}
    await atomicWrite(autoIngestStatePath(dataRoot), JSON.stringify({ ...prev, ...patch }, null, 2) + '\n')
  } catch { /* 状态写失败不阻塞摄取 */ }
}

/**
 * 跑一次增量摄取（插件定时器与手动调用共用）。
 *
 * @param {object} p
 * @param {string} [p.dataRoot]
 * @param {number} [p.days] 只抽取最近多少天的会话（默认 2，重叠一天防漏）
 * @param {number} [p.batch] 嵌入批大小
 * @param {boolean} [p.dryRun] 只统计、不落盘、不调嵌入
 * @param {object} [p.config] 插件配置（embeddingApiKey / embeddingApiBase）
 * @param {(msg:string)=>void} [p.logger]
 * @returns {Promise<object>} 报告（不抛；失败在 report.ok/errors 里）
 */
export async function runAutoIngest(p = {}) {
  const dataRoot = resolve(String(p.dataRoot || defaultDataRoot()))
  const dryRun = Boolean(p.dryRun)
  const batch = Math.max(1, Number(p.batch) || 16)
  const days = Math.max(1, Math.min(365, Number(p.days) || 2))
  const log = typeof p.logger === 'function' ? p.logger : () => {}

  const lock = await acquireRunLock(dataRoot)
  if (!lock.ok) return { ok: true, skipped: true, reason: lock.reason, at: new Date().toISOString(), dataRoot }

  const startedAt = new Date().toISOString()
  const report = {
    ok: true, skipped: false, at: startedAt, finishedAt: null, dryRun, dataRoot, days,
    files: 0, extracted: 0, invalid: 0, unassigned: 0, byPersona: {}, written: 0,
    usage: { prompt_tokens: 0, total_tokens: 0 }, requests: 0, errors: [], warnings: [],
  }

  try {
    const idr = await loadIdentity(dataRoot)
    if (!idr.ok) throw new Error(`identity 不可用：${idr.reason || 'unknown'}`)
    const identity = idr.identity
    const embed = loadEmbeddingConfig(p.config || {})
    if (!embed.ok) {
      report.ok = false
      report.errors.push({ code: embed.code, message: embed.message })
      report.finishedAt = new Date().toISOString()
      if (!dryRun) await patchState(dataRoot, { lastFailureAt: report.finishedAt, lastErrors: report.errors.slice(0, 5) })
      await appendRunLog(dataRoot, report)
      return report
    }

    const { recs, fileCount } = await extractSessions({ root: sessionsRoot(), days })
    const raw = buildChunks(recs)
    report.files = fileCount
    report.extracted = raw.length

    // 1) 抽取 → 折叠 sourceType → 校验 → 按人格分组
    const byPersona = new Map()
    for (const c of raw) {
      const r = resolvePersona(identity, { session: c.session, ws: c.wsPretty })
      if (r.personaId === PERSONA_UNASSIGNED) { report.unassigned++; continue }
      const u = makeUtterance({
        session: c.session,
        personaId: r.personaId,
        identitySource: r.identitySource,
        messageId: c.msgId,
        seq: c.seq,
        part: c.part,
        role: c.role,
        // 桥梁后缀先折叠，否则 assistant-bridge / user-bridge 会被判非法
        sourceType: foldLegacySourceType(c.sourceType, c.role),
        t: c.t,
        text: c.text,
        ws: c.wsPretty,
        wsDir: c.ws,
        channel: inferChannel(c.wsPretty, c.session),
        attachments: [],
        sourceHash: legacyRowHash({ session: c.session, role: c.role, t: c.t, part: c.part, msgId: c.msgId, seq: c.seq, text: c.text }),
      })
      const errs = validateChunk(u)
      if (errs.length) {
        report.invalid++
        if (report.errors.length < 5) report.errors.push({ id: u.id, errors: errs })
        continue
      }
      if (!byPersona.has(r.personaId)) byPersona.set(r.personaId, [])
      byPersona.get(r.personaId).push(u)
    }

    // 2) 逐人格：去重 → 对齐闸门 → 先嵌 → 后写
    for (const [pid, rows] of byPersona) {
      const meta = await readScopeMeta(dataRoot, pid)
      if (!meta.ok || !meta.exists) {
        report.ok = false
        report.errors.push({ personaId: pid, code: 'SCOPE_MISSING', message: 'scope 不存在，跳过（先跑一次完整快照）' })
        continue
      }
      const existing = await readScopeChunks(dataRoot, pid)
      const known = new Set(existing.rows.map((x) => x.id))
      const fresh = rows.filter((x) => !known.has(x.id))
      const chars = fresh.reduce((a, x) => a + String(x.text || '').length, 0)
      const entry = { chunks: rows.length, fresh: fresh.length, chars, written: 0, embedded: false }
      report.byPersona[pid] = entry
      if (!fresh.length) continue
      if (meta.indexMeta?.alignmentBroken) {
        report.ok = false
        report.errors.push({ personaId: pid, code: 'VECTOR_ALIGNMENT_BROKEN', message: '向量行对齐已坏；本轮不写（避免错位扩大），先跑 repair-vectors' })
        continue
      }
      const dim = Number(meta.manifest?.dim) || 0
      if (!dim) {
        report.ok = false
        report.errors.push({ personaId: pid, code: 'NO_DIM', message: 'manifest.dim=0，无法嵌入；跳过' })
        continue
      }
      if (String(meta.manifest?.provider) !== 'cloud') {
        report.ok = false
        report.errors.push({ personaId: pid, code: 'PROVIDER_NOT_CLOUD', message: `manifest.provider=${meta.manifest?.provider}，自动摄取只支持 cloud` })
        continue
      }
      const embedding = {
        provider: meta.manifest.provider,
        model: meta.manifest.model,
        dim,
        normalizerVersion: meta.manifest.normalizerVersion || 'l2-v1',
      }
      if (dryRun) { entry.wouldEmbed = true; continue }
      const { vectors, usage, requests } = await embedTexts(fresh.map((x) => String(x.text || '')), {
        apiKey: embed.apiKey, apiBase: embed.apiBase, model: embedding.model, dim, batch,
      })
      report.usage.prompt_tokens += usage.prompt_tokens
      report.usage.total_tokens += usage.total_tokens
      report.requests += requests
      const w = await appendUtterances({ dataRoot, personaId: pid, utterances: fresh, vectors, dim, embedding })
      if (!w.ok) {
        report.ok = false
        report.errors.push({ personaId: pid, code: w.error?.code || 'WRITE_FAILED', message: w.error?.message || '写入失败' })
        continue
      }
      entry.written = w.added || 0
      entry.embedded = true
      entry.degraded = Boolean(w.degraded)
      entry.total = w.total
      report.written += entry.written
    }

    report.finishedAt = new Date().toISOString()
    if (!dryRun) {
      if (report.ok) await patchState(dataRoot, { lastSuccessAt: report.finishedAt, lastDays: days, lastWritten: report.written, lastErrors: [] })
      else await patchState(dataRoot, { lastFailureAt: report.finishedAt, lastDays: days, lastErrors: report.errors.slice(0, 5) })
    }
    await appendRunLog(dataRoot, report)
    log(`自动摄取完成：days=${days} 抽取=${report.extracted} 写入=${report.written} tokens=${report.usage.total_tokens}`)
    if (!report.ok) log(`自动摄取有错误：${JSON.stringify(report.errors.slice(0, 3))}`)
    return report
  } catch (e) {
    report.ok = false
    report.error = { code: e?.code || 'AUTO_INGEST_FAILED', message: String(e?.message || e) }
    report.errors.push(report.error)
    report.finishedAt = new Date().toISOString()
    if (!dryRun) await patchState(dataRoot, { lastFailureAt: report.finishedAt, lastErrors: report.errors.slice(0, 5) })
    await appendRunLog(dataRoot, { ...report, fatal: true })
    log(`自动摄取失败：${report.error.message}`)
    return report
  } finally {
    await lock.release()
  }
}

/** 纯函数：下一次该跑的时刻（供定时器与自测使用） */
export function computeNextRunAt(cfg = {}, from = Date.now()) {
  const minute = Number(cfg.autoIngestMinute)
  if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
    const d = new Date(from)
    d.setSeconds(0, 0)
    d.setMinutes(minute)
    if (d.getTime() <= from) d.setHours(d.getHours() + 1)
    return d.getTime()
  }
  const interval = Math.max(5, Number(cfg.autoIngestIntervalMinutes) || 60) * 60000
  return from + interval
}
