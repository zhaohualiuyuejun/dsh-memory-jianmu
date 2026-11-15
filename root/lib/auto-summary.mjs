/**
 * lib/auto-summary.mjs —— A2 摘要索引 · 摄取后自动挂载（2026-11-12）
 * ============================================================================
 * 为什么要有这个文件：
 *   根藏的 A2（摘要 + 原文一起嵌入）已能手动跑 tools/summarize-reembed.mjs，
 *   但每小时自动摄取写进来的**新块**不会自动获得摘要 —— 时间一长，新记忆就
 *   落在「只有原文」的口径里，检索质量悄悄掉档。这里把这一步挂到摄取之后。
 *
 * 设计（最小侵入，默认关）：
 *   · 只处理「本轮真有新块写入」的人格（report.byPersona[pid].written > 0）；
 *   · 只处理 manifest.embeddingMeta.summaryMode === 'concat' 的 scope
 *     （没做过 A2 的库不擅自改造，保持原口径）；
 *   · 先查 Ollama 是否可达 —— 不可达就跳过本轮，等下个小时重试，
 *     避免「只重嵌、没摘要」白花钱；
 *   · 用 detached 子进程跑现成的 summarize-reembed.mjs（不阻塞摄取主路径）；
 *   · 单飞锁：<dataRoot>/.locks/auto-summary-<pid>.lock（30 分钟视为陈旧）；
 *   · 任何失败都只记日志，绝不把错误抛回摄取。
 *
 * 子进程退出时通过 JIANMU_AUTO_SUMMARY_LOCK/TOKEN 自行删锁（见 tools/summarize-reembed.mjs）；
 * 宿主先退出也不会留下永久锁（30 分钟后可被抢占）。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  chunksPath, manifestPath, autoSummaryLockPath, autoSummaryLogPath, autoSummaryChildLogPath, locksDir, logsDir,
} from './paths.mjs'
import { readJson } from './fsatomic.mjs'
import { loadEmbeddingConfig } from './auto-ingest.mjs'

export const LOCK_STALE_MS = 30 * 60 * 1000
export const DEFAULT_SUMMARY_MODEL = 'qwen3:8b'
export const DEFAULT_SUMMARY_BASE = 'http://127.0.0.1:11434'
export const DEFAULT_SUMMARY_MIN_CHARS = 80

const WORKER = fileURLToPath(new URL('../tools/summarize-reembed.mjs', import.meta.url))
const nowIso = () => new Date().toISOString()
const textLen = (r) => String(r?.text || '').length

/**
 * 纯函数：本轮该不该给某个人格跑自动摘要。
 * 输入 report（runAutoIngest 的返回）与各 scope 的 summaryMode，
 * 返回逐人格的判定，便于自测与日志。
 *
 * @param {object} p
 * @param {boolean} [p.autoSummaryIndex]
 * @param {object|null} [p.report]
 * @param {Record<string, {exists?:boolean, summaryMode?:string}>} [p.manifests]
 * @returns {Array<{personaId:string, run:boolean, reason:string, written?:number}>}
 */
export function decideAutoSummary({ autoSummaryIndex = false, report = null, manifests = {} } = {}) {
  if (!autoSummaryIndex) return []
  const by = report && typeof report.byPersona === 'object' && report.byPersona ? report.byPersona : {}
  const out = []
  for (const [personaId, entry] of Object.entries(by)) {
    const written = Number(entry && entry.written) || 0
    if (written <= 0) { out.push({ personaId, run: false, reason: 'no-new-chunks' }); continue }
    const m = manifests ? manifests[personaId] : null
    if (!m || m.exists === false) { out.push({ personaId, run: false, reason: 'scope-missing' }); continue }
    if (String(m.summaryMode || '') !== 'concat') { out.push({ personaId, run: false, reason: 'not-concat' }); continue }
    out.push({ personaId, run: true, reason: 'ok', written })
  }
  return out
}

/** 纯函数：一条 chunk 是否还缺摘要（长块才值得摘要） */
export function needsSummary(row, minChars = DEFAULT_SUMMARY_MIN_CHARS) {
  if (!row || typeof row !== 'object') return false
  if (row.summary && String(row.summary).trim()) return false
  return textLen(row) >= Math.max(1, Number(minChars) || DEFAULT_SUMMARY_MIN_CHARS)
}

/** 纯函数：待摘要块数（用于避免「没有可摘要的块还整库重写向量」） */
export function countPendingSummaries(rows, minChars = DEFAULT_SUMMARY_MIN_CHARS) {
  if (!Array.isArray(rows)) return 0
  let n = 0
  for (const r of rows) if (needsSummary(r, minChars)) n++
  return n
}

/** 解析 chunks.jsonl 文本（容忍撕裂尾巴：坏行跳过，不抛） */
export function parseChunkLines(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { rows.push(JSON.parse(s)) } catch { /* 撕裂尾巴：跳过 */ }
  }
  return rows
}

async function readManifestInfo(dataRoot, personaId) {
  const r = await readJson(manifestPath(dataRoot, personaId))
  if (!r.ok || !r.value) return { exists: false, summaryMode: null }
  return { exists: true, summaryMode: r.value?.embeddingMeta?.summaryMode || null, dim: Number(r.value?.dim) || 0, model: r.value?.model || null }
}

async function readChunks(dataRoot, personaId) {
  try { return parseChunkLines(await readFile(chunksPath(dataRoot, personaId), 'utf8')) } catch { return [] }
}

/** 探活 Ollama：不可达就不跑（避免只重嵌、无摘要） */
export async function probeOllama(base = DEFAULT_SUMMARY_BASE, timeoutMs = 2000) {
  const url = `${String(base || DEFAULT_SUMMARY_BASE).replace(/\/+$/, '')}/api/tags`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return Boolean(res.ok)
  } catch { return false }
}

async function appendEvent(dataRoot, entry) {
  try {
    await mkdir(logsDir(dataRoot), { recursive: true })
    await appendFile(autoSummaryLogPath(dataRoot), JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

async function acquireSummaryLock(dataRoot, personaId) {
  const token = randomBytes(8).toString('hex')
  const file = autoSummaryLockPath(dataRoot, personaId)
  const payload = JSON.stringify({
    pid: process.pid, token, personaId, host: process.env.COMPUTERNAME || '',
    startedAt: nowIso(), tool: 'dsh-memory-store:auto-summary',
  })
  const create = async () => {
    const fh = await open(file, 'wx')
    try { await fh.writeFile(payload, 'utf8') } finally { await fh.close() }
  }
  try {
    await mkdir(locksDir(dataRoot), { recursive: true })
    await create()
    return { ok: true, file, token }
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: `建锁失败：${e.code || e.message}` }
  }
  // 已存在：过期则抢占，否则跳过
  let stale = true
  try {
    const cur = JSON.parse(await readFile(file, 'utf8'))
    const age = Date.now() - Date.parse(cur?.startedAt)
    stale = !(age >= 0 && age < LOCK_STALE_MS)
  } catch { stale = true }
  if (!stale) return { ok: false, reason: '另一个自动摘要还在跑（锁未过期）' }
  try { await unlink(file) } catch { /* 别人可能已清 */ }
  try {
    await create()
    return { ok: true, file, token }
  } catch (e) {
    return { ok: false, reason: `抢锁失败：${e.code || e.message}` }
  }
}

async function releaseSummaryLock(file, token) {
  try {
    const cur = JSON.parse(await readFile(file, 'utf8'))
    if (cur && cur.token === token) await unlink(file)
  } catch { /* 锁已不在 / 不是我们的：不删 */ }
}

/**
 * 起一个 detached 子进程跑 summarize-reembed（不等待）。
 * 返回 { ok, childPid } 或 { ok:false, reason }。
 */
function spawnWorker({ dataRoot, personaId, cfg, manifest, embedding, lockFile, token, logger }) {
  const childLog = autoSummaryChildLogPath(dataRoot, personaId)
  let outFd = null
  try { outFd = openSync(childLog, 'a') } catch { outFd = null }
  const args = [
    WORKER,
    '--root', dataRoot,
    '--scope', personaId,
    '--min-chars', String(Math.max(1, Number(cfg.summaryMinChars) || DEFAULT_SUMMARY_MIN_CHARS)),
    '--ollama-model', String(cfg.summaryModel || DEFAULT_SUMMARY_MODEL),
    '--ollama-base', String(cfg.summaryBase || DEFAULT_SUMMARY_BASE),
  ]
  if (manifest?.dim) args.push('--dim', String(manifest.dim))
  if (manifest?.model) args.push('--model', String(manifest.model))
  const env = {
    ...process.env,
    SILICONFLOW_API_KEY: embedding.apiKey,
    JIANMU_AUTO_SUMMARY_LOCK: lockFile,
    JIANMU_AUTO_SUMMARY_TOKEN: token,
  }
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd === null ? 'ignore' : outFd, outFd === null ? 'ignore' : outFd],
      env,
    })
    if (typeof child.pid !== 'number') {
      if (outFd !== null) { try { closeSync(outFd) } catch { /* 忽略 */ } }
      return { ok: false, reason: '子进程未能启动（无 pid）' }
    }
    // 宿主退出后子进程继续；退出时记录 + 兜底删锁（子进程自己也会删）
    child.on('error', (e) => {
      logger(`自动摘要子进程异常（${personaId}）：${e?.message || e}`)
      releaseSummaryLock(lockFile, token).catch(() => {})
    })
    child.on('exit', (code, signal) => {
      appendEvent(dataRoot, { event: 'exit', at: nowIso(), personaId, childPid: child.pid, code, signal })
      releaseSummaryLock(lockFile, token).catch(() => {})
    })
    child.unref()
    if (outFd !== null) { try { closeSync(outFd) } catch { /* 忽略 */ } }
    return { ok: true, childPid: child.pid }
  } catch (e) {
    if (outFd !== null) { try { closeSync(outFd) } catch { /* 忽略 */ } }
    return { ok: false, reason: `spawn 失败：${e?.message || e}` }
  }
}

/**
 * 摄取结束后调用：给「有新块 + 已是 concat 口径」的人格排一次增量摘要重嵌。
 * **不抛异常**；返回结构化结果供 status/log 使用。
 *
 * @param {object} p
 * @param {string} p.dataRoot
 * @param {object} [p.config] 插件配置（autoSummaryIndex / summaryModel / summaryBase / summaryMinChars / embeddingApiKey / embeddingApiBase）
 * @param {object|null} [p.report] runAutoIngest() 的返回
 * @param {(msg:string)=>void} [p.logger]
 * @param {(p:any)=>Promise<any>} [p.spawnFn] 测试注入（默认 spawnWorker）
 * @param {(base:string)=>Promise<boolean>} [p.probeFn] 测试注入（默认 probeOllama）
 */
export async function runAutoSummaryAfterIngest(p = {}) {
  const dataRoot = String(p.dataRoot || '')
  const cfg = p.config || {}
  const log = typeof p.logger === 'function' ? p.logger : () => {}
  const spawnFn = typeof p.spawnFn === 'function' ? p.spawnFn : spawnWorker
  const probeFn = typeof p.probeFn === 'function' ? p.probeFn : probeOllama
  const out = { ok: true, skipped: false, reason: null, at: nowIso(), decisions: [], started: [], errors: [] }

  try {
    if (!cfg.autoSummaryIndex) { out.skipped = true; out.reason = 'off'; return out }
    if (!dataRoot) { out.skipped = true; out.reason = 'no-data-root'; return out }

    const pids = Object.keys((p.report && p.report.byPersona) || {})
      .filter((pid) => Number(p.report.byPersona[pid] && p.report.byPersona[pid].written) > 0)
    if (!pids.length) { out.skipped = true; out.reason = 'no-new-chunks'; return out }

    // 逐人格：读 manifest → 判定 → 检查待摘要块 → 锁 → 子进程
    const manifests = {}
    for (const pid of pids) manifests[pid] = await readManifestInfo(dataRoot, pid)
    out.decisions = decideAutoSummary({ autoSummaryIndex: true, report: p.report, manifests })

    let ollamaOk = null
    const minChars = Math.max(1, Number(cfg.summaryMinChars) || DEFAULT_SUMMARY_MIN_CHARS)
    const embed = loadEmbeddingConfig(cfg)

    for (const d of out.decisions) {
      if (!d.run) {
        await appendEvent(dataRoot, { event: 'skip', at: nowIso(), personaId: d.personaId, reason: d.reason })
        continue
      }
      const pid = d.personaId
      if (!embed.ok) {
        out.errors.push({ personaId: pid, code: embed.code, message: embed.message })
        await appendEvent(dataRoot, { event: 'skip', at: nowIso(), personaId: pid, reason: 'no-embedding-key' })
        continue
      }
      const rows = await readChunks(dataRoot, pid)
      const pending = countPendingSummaries(rows, minChars)
      if (!pending) {
        await appendEvent(dataRoot, { event: 'skip', at: nowIso(), personaId: pid, reason: 'nothing-pending' })
        continue
      }
      if (ollamaOk === null) ollamaOk = await probeFn(String(cfg.summaryBase || DEFAULT_SUMMARY_BASE))
      if (!ollamaOk) {
        await appendEvent(dataRoot, { event: 'skip', at: nowIso(), personaId: pid, reason: 'ollama-unreachable', pending })
        log(`自动摘要跳过（${pid}）：Ollama 不可达，等下次`)
        continue
      }
      const lock = await acquireSummaryLock(dataRoot, pid)
      if (!lock.ok) {
        await appendEvent(dataRoot, { event: 'skip', at: nowIso(), personaId: pid, reason: 'locked', message: lock.reason, pending })
        continue
      }
      const r = await spawnFn({
        dataRoot, personaId: pid, cfg, manifest: manifests[pid], embedding: embed,
        lockFile: lock.file, token: lock.token, logger: log,
      })
      if (!r.ok) {
        out.errors.push({ personaId: pid, code: 'SPAWN_FAILED', message: r.reason })
        await releaseSummaryLock(lock.file, lock.token)
        await appendEvent(dataRoot, { event: 'error', at: nowIso(), personaId: pid, reason: 'spawn-failed', message: r.reason })
        continue
      }
      out.started.push({ personaId: pid, childPid: r.childPid, pending })
      await appendEvent(dataRoot, {
        event: 'spawn', at: nowIso(), personaId: pid, childPid: r.childPid, pending,
        model: cfg.summaryModel || DEFAULT_SUMMARY_MODEL, minChars,
      })
      log(`自动摘要已启动（${pid}：待摘要 ${pending} 块，子进程 ${r.childPid}）`)
    }

    if (!out.started.length) out.skipped = true
  } catch (e) {
    out.ok = false
    out.errors.push({ code: e?.code || 'AUTO_SUMMARY_FAILED', message: String(e?.message || e) })
    try { await appendEvent(dataRoot, { event: 'fatal', at: nowIso(), message: String(e?.message || e) }) } catch { /* 忽略 */ }
  }
  return out
}

/** 供自测：摘要事件日志文件指纹（确认有写入） */
export function autoSummaryLogFingerprint(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}
