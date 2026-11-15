#!/usr/bin/env node
/**
 * tools/ingest-hourly.mjs —— 根藏每小时增量摄取（带向量；新增文件，**不改冻结 lib**）
 *
 * 为什么不用 lib/ingest.mjs 的 ingestSessions：
 *   1) 它不嵌向量（vectors=null），每次文本追加都会把 alignmentBroken 拉成 true；
 *   2) 它把 sourceType 原样写入，`assistant-bridge` / `user-bridge` 会被 validateChunk 拒绝
 *      （2026-11-07 实测：最近 24h 977 块里有 363 块因此被静默丢弃）。
 *   本脚本在**新文件里**修这两点：折叠 sourceType + 先嵌后写（文本与向量一次落盘）。
 *
 * 失败策略：任何一块拿不到向量 → 本轮该人格不写，下轮重试；绝不写半截向量。
 * 写入范围：只写 <dataRoot>/scopes/<personaId>/；日志/状态写本包 _logs/。
 *
 * 用法：
 *   node tools/ingest-hourly.mjs --data-root "C:/Users/alice/.dsh/memory-jianmu" --dry-run
 *   node tools/ingest-hourly.mjs --data-root "..."            # 真跑
 *   可选：--days 3 --batch 16 --json
 */
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { sessionsRoot, PERSONA_UNASSIGNED, defaultDataRoot, dshHome } from '../lib/paths.mjs'
import { extractSessions } from '../lib/session-extract.mjs'
import { buildChunks } from '../lib/chunker.mjs'
import { makeUtterance, validateChunk, inferChannel, legacyRowHash, foldLegacySourceType } from '../lib/chunks.mjs'
import { loadIdentity, resolvePersona } from '../lib/identity.mjs'
import { readScopeMeta, readScopeChunks, appendUtterances, statusOfScope } from '../lib/store.mjs'

const DEFAULT_DATA_ROOT = defaultDataRoot()
const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'
const PACKAGE_ROOT = join(import.meta.dirname, '..')
const LOG_DIR = join(PACKAGE_ROOT, '_logs')
const STATE_FILE = join(LOG_DIR, 'ingest-state.json')
const LOCK_FILE = join(LOG_DIR, 'ingest-hourly.lock')
const RUN_LOG = join(LOG_DIR, 'ingest-hourly.jsonl')
const LOCK_STALE_MS = 30 * 60 * 1000
// 熏习 CLI：优先 JIANMU_PROCESS_CLI；否则取与根藏同级的 dsh-memory-process（profile 里就是兄弟目录）
const PROCESS_CLI = process.env.JIANMU_PROCESS_CLI
  || join(PACKAGE_ROOT, '..', 'dsh-memory-process', 'tools', 'cli.mjs')

function parseArgs(argv) {
  const out = { 'data-root': DEFAULT_DATA_ROOT, batch: 16, days: null, 'max-days': 30, overlap: 2, 'dry-run': false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (['dry-run', 'json'].includes(k)) { out[k] = true; continue }
    if (next && !next.startsWith('--')) { out[k] = next; i++ } else { out[k] = true }
  }
  return out
}

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

function loadEmbedCfg() {
  // 尊重 DSH_HOME：便携版 / 多环境 / 非默认 home 时不再写死 ~/.dsh（否则一定读不到配置）
  const file = join(dshHome(), 'session-recall', 'config.json')
  if (!existsSync(file)) {
    throw new Error('找不到寻枝配置：' + file
      + '（在「设置 → 会话语义检索」里填一次 API Key 即可；或先在根藏设置里填 embeddingApiKey 并等自动摄取）')
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (!cfg.apiKey) throw new Error('寻枝 config.json 里没有 apiKey：' + file)
  return { apiKey: cfg.apiKey, apiBase: cfg.apiBase || DEFAULT_BASE }
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
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)))
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

function acquireRunLock() {
  mkdirSync(LOG_DIR, { recursive: true })
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  try {
    const fd = openSync(LOCK_FILE, 'wx')
    writeFileSync(fd, payload, 'utf8')
    closeSync(fd)
    return { ok: true, release: () => { try { unlinkSync(LOCK_FILE) } catch { /* ignore */ } } }
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    let stale = false
    try {
      const old = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
      const age = Date.now() - Date.parse(old.startedAt)
      let alive = false
      try { process.kill(Number(old.pid), 0); alive = true } catch { alive = false }
      stale = !alive || !(age >= 0) || age > LOCK_STALE_MS
    } catch { stale = true }
    if (!stale) return { ok: false, reason: '另一个每小时摄取还在跑（锁未过期）' }
    try { unlinkSync(LOCK_FILE) } catch { /* ignore */ }
    const fd = openSync(LOCK_FILE, 'wx')
    writeFileSync(fd, payload, 'utf8')
    closeSync(fd)
    return { ok: true, release: () => { try { unlinkSync(LOCK_FILE) } catch { /* ignore */ } } }
  }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function writeState(patch) {
  mkdirSync(LOG_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2) + '\n', 'utf8')
}

function appendRunLog(entry) {
  mkdirSync(LOG_DIR, { recursive: true })
  try { writeFileSync(RUN_LOG, JSON.stringify(entry) + '\n', { flag: 'a' }) } catch { /* 日志失败不阻塞 */ }
}

function computeDays(args) {
  if (args.days != null) return Math.max(1, Math.min(365, Number(args.days) || 2))
  const last = readState().lastSuccessAt
  if (!last) return Math.max(1, Number(args.overlap) || 2)
  const delta = (Date.now() - Date.parse(last)) / 86400000
  if (!Number.isFinite(delta)) return Math.max(1, Number(args.overlap) || 2)
  return Math.max(Number(args.overlap) || 2, Math.min(Number(args['max-days']) || 30, Math.ceil(delta) + 1))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataRoot = resolve(String(args['data-root']))
  const dryRun = Boolean(args['dry-run'])
  const batch = Math.max(1, Number(args.batch) || 16)
  const lock = acquireRunLock()
  if (!lock.ok) {
    const out = { ok: true, skipped: true, reason: lock.reason, at: new Date().toISOString() }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else console.log('跳过：' + lock.reason)
    return
  }
  try {
    const startedAt = new Date().toISOString()
    const days = computeDays(args)
    const idr = await loadIdentity(dataRoot)
    if (!idr.ok) throw new Error(`identity 不可用：${idr.reason || 'unknown'}`)
    const identity = idr.identity
    const cfg = loadEmbedCfg()

    const { recs, fileCount } = await extractSessions({ root: sessionsRoot(), days })
    const raw = buildChunks(recs)
    const report = {
      ok: true, at: startedAt, finishedAt: null, dryRun, dataRoot, days, files: fileCount,
      extracted: raw.length, invalid: 0, unassigned: 0, byPersona: {}, written: 0,
      usage: { prompt_tokens: 0, total_tokens: 0 }, requests: 0, errors: [], warnings: [],
    }

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
        // ← 关键修复：桥梁后缀先折叠，否则 assistant-bridge/user-bridge 会被判非法
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
      if (errs.length) { report.invalid++; if (report.errors.length < 5) report.errors.push({ id: u.id, errors: errs }); continue }
      if (!byPersona.has(r.personaId)) byPersona.set(r.personaId, [])
      byPersona.get(r.personaId).push(u)
    }

    // 2) 逐人格：去重 → 对齐闸门 → 先嵌 → 后写
    for (const [pid, rows] of byPersona) {
      const meta = await readScopeMeta(dataRoot, pid)
      if (!meta.ok || !meta.exists) { report.ok = false; report.errors.push({ personaId: pid, code: 'SCOPE_MISSING', message: 'scope 不存在，跳过（先跑一次完整快照）' }); continue }
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
      if (!dim) { report.ok = false; report.errors.push({ personaId: pid, code: 'NO_DIM', message: 'manifest.dim=0，无法嵌入；跳过' }); continue }
      if (String(meta.manifest?.provider) !== 'cloud') {
        report.ok = false
        report.errors.push({ personaId: pid, code: 'PROVIDER_NOT_CLOUD', message: `manifest.provider=${meta.manifest?.provider}，本脚本只支持 cloud` })
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
        apiKey: cfg.apiKey, apiBase: cfg.apiBase, model: embedding.model, dim, batch,
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

    // 3) 熏习跟随：根藏写入后跑一次本地 process run（0 LLM / 0 网络 / 亚秒级）。
    //    以前熏习没有定时器，根藏涨多少它就落后多少；现在跟在同一小时里。
    if (!dryRun) {
      const pids = Object.keys(identity.personas || {})
      if (!existsSync(PROCESS_CLI)) {
        // 单独装根藏（没装熏习）是合法组合：跳过跟随，不让整轮摄取失败
        report.process = { skipped: '未安装 dsh-memory-process（或 JIANMU_PROCESS_CLI 指向的路径不存在）' }
      } else {
        report.process = {}
        for (const pid of pids) {
          const pr = spawnSync(process.execPath, [PROCESS_CLI, 'run', '--data-root', dataRoot, '--persona', pid], {
            encoding: 'utf8', timeout: 120000,
            // 防止被 GUI 进程调起时闪控制台窗口（插件内定时器已不 spawn，这里是手动运维兜底）
            windowsHide: true,
          })
          let parsed = null
          try { parsed = JSON.parse(String(pr.stdout || '').trim() || 'null') } catch { /* 非 JSON 输出 */ }
          const ok = pr.status === 0 && parsed?.ok !== false
          report.process[pid] = {
            ok,
            exitCode: pr.status,
            appended: parsed?.state?.appended ?? null,
            unprocessed: parsed?.state?.unprocessed ?? null,
            error: ok ? null : String(pr.stderr || parsed?.error?.message || '').slice(0, 200) || null,
          }
          if (!ok) report.warnings.push(`熏习 run 失败（${pid}）：${report.process[pid].error || 'unknown'}`)
        }
      }
    }

    report.finishedAt = new Date().toISOString()
    if (!dryRun && report.ok) writeState({ lastSuccessAt: report.finishedAt, lastDays: days, lastWritten: report.written })
    else if (!dryRun) writeState({ lastFailureAt: report.finishedAt, lastDays: days, lastErrors: report.errors.slice(0, 5) })

    appendRunLog(report)
    if (args.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`摄取完成${dryRun ? '（dry-run）' : ''}：days=${days} 抽取=${report.extracted} 无效=${report.invalid} 未归属=${report.unassigned} 写入=${report.written}`)
      for (const [pid, e] of Object.entries(report.byPersona)) console.log(`  ${pid}: 共${e.chunks} 新${e.fresh} 写${e.written}${e.chars ? ` (${e.chars}字)` : ''}`)
      console.log(`tokens=${report.usage.total_tokens} 请求=${report.requests}`)
      for (const [pid, pr] of Object.entries(report.process || {})) console.log(`  熏习 ${pid}: ${pr.ok ? 'OK' : 'FAIL'} appended=${pr.appended} unprocessed=${pr.unprocessed}`)
      for (const e of report.errors) console.log('  ❌ ' + JSON.stringify(e))
      for (const w of report.warnings) console.log('  ⚠️ ' + w)
    }
    if (!report.ok) process.exitCode = 1
    return report
  } finally {
    lock.release()
  }
}

main().catch((e) => {
  try { appendRunLog({ ok: false, at: new Date().toISOString(), fatal: String(e.message || e) }) } catch { /* ignore */ }
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) }))
  process.exitCode = 1
})
