#!/usr/bin/env node
/**
 * tools/repair-vectors.mjs —— 根藏向量修复（新增文件；**不改冻结 lib**）
 *
 * 背景：2026-11-07 下午两次「只写文本、不写向量」的摄取把向量文件落在块后面，
 *       index_meta.alignmentBroken=true，appendUtterances 拒绝再追加向量。
 *       缺的块正好是 chunks 的**连续尾部**（alice 234 / bob 2）。
 *
 * 三个模式：
 *   verify : 抽样自证「前缀旧向量 = 前缀块序」（只读 + 5 块 API；最便宜）
 *   tail   : 复用前缀旧向量，只嵌连续尾部并整份写回（需 --apply）
 *   full   : 整份重嵌全部块（需 --apply；tail 自证失败时的兜底）
 *
 * 费用：只调 /v1/embeddings；verify 约 5 块，tail 约 236 块，full 约 5962 块。
 * 写入：只走 writeScopeBundle（overwrite=true，自动归档旧文件），只写 <dataRoot>/scopes/。
 *
 * 用法：
 *   node tools/repair-vectors.mjs --data-root "C:/Users/alice/.dsh/memory-jianmu" --mode verify
 *   node tools/repair-vectors.mjs --data-root "..." --mode tail --apply
 *   node tools/repair-vectors.mjs --data-root "..." --mode full --apply
 *   可选：--persona alice|bob|all（默认 all） --batch 16 --sample 5 --json
 */
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readScopeMeta, readScopeChunks, writeScopeBundle, statusOfScope } from '../lib/store.mjs'
import { vectorPath, defaultDataRoot } from '../lib/paths.mjs'
import { normalizeRowInPlace } from '../lib/vectors.mjs'

const DEFAULT_DATA_ROOT = defaultDataRoot()
const DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-8B'
const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'
const VERIFY_COS_MIN = 0.999
const PRICE_PER_M_LOW = 0.5   // 元 / 百万 token（10-31 实测口径下限）
const PRICE_PER_M_HIGH = 1.0  // 上限
const PACKAGE_LOGS = join(import.meta.dirname, '..', '_logs')

function parseArgs(argv) {
  const out = { 'data-root': DEFAULT_DATA_ROOT, mode: 'verify', persona: 'all', batch: 16, sample: 5, apply: false, json: false, 'skip-verify': false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (['apply', 'json', 'skip-verify'].includes(k)) { out[k] = true; continue }
    if (next && !next.startsWith('--')) { out[k] = next; i++ } else { out[k] = true }
  }
  return out
}

function sanitizeText(s) {
  // 落单的 UTF-16 代理项会被服务端整批 400；与 lib/embed.mjs 同口径
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
  const file = join(homedir(), '.dsh', 'session-recall', 'config.json')
  if (!existsSync(file)) throw new Error('找不到寻枝配置：' + file)
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (!cfg.apiKey) throw new Error('寻枝 config.json 里没有 apiKey')
  return {
    apiKey: cfg.apiKey,
    apiBase: cfg.apiBase || DEFAULT_BASE,
    model: cfg.model || DEFAULT_MODEL,
    provider: cfg.provider || 'cloud',
  }
}

/**
 * 批量嵌入。返回 { vectors: Float32Array, usage, requests }。
 * 硬失败：任何一块拿不到向量就抛错（宁可本轮不写，也不写半截向量）。
 */
async function embedTexts(texts, cfg, { batch = 16, onProgress = null } = {}) {
  const endpoint = `${(cfg.apiBase || DEFAULT_BASE).replace(/\/+$/, '')}/embeddings`
  const dim = 4096
  const flat = new Float32Array(texts.length * dim)
  const usage = { prompt_tokens: 0, total_tokens: 0 }
  let requests = 0
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch).map(sanitizeText)
    let d = null
    let lastErr = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        d = await postJson(endpoint, { model: cfg.model, input: part }, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        })
        break
      } catch (e) {
        lastErr = e
        const retryable = !e.status || e.status === 429 || e.status >= 500
        if (!retryable || attempt === 4) throw e
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)))
      }
    }
    requests++
    if (!Array.isArray(d?.data)) throw new Error('返回里没有 data：' + JSON.stringify(d).slice(0, 200))
    const rows = [...d.data].sort((a, b) => a.index - b.index)
    if (rows.length !== part.length) {
      throw new Error(`向量行数不符：返回 ${rows.length}，期望 ${part.length}（批次起点 ${i}）`)
    }
    for (let k = 0; k < rows.length; k++) {
      const vec = rows[k]?.embedding
      if (!Array.isArray(vec) || vec.length !== dim) throw new Error(`第 ${i + k} 块向量维度异常：${vec?.length}`)
      const norm = l2(vec)
      flat.set(norm, (i + k) * dim)
    }
    if (d.usage) {
      usage.prompt_tokens += Number(d.usage.prompt_tokens || 0)
      usage.total_tokens += Number(d.usage.total_tokens || 0)
    }
    onProgress?.({ done: Math.min(i + part.length, texts.length), total: texts.length, requests })
  }
  return { vectors: flat, usage, requests, dim }
}

function cosine(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

function costEstimate(tokens) {
  return {
    tokens,
    lowYuan: Number(((tokens / 1e6) * PRICE_PER_M_LOW).toFixed(4)),
    highYuan: Number(((tokens / 1e6) * PRICE_PER_M_HIGH).toFixed(4)),
    basis: `${PRICE_PER_M_LOW}~${PRICE_PER_M_HIGH} 元/百万 token（10-31 实测口径）`,
  }
}

async function tailPrefixGuard(meta, chunks, vectorFile) {
  const rows = chunks.rows
  const dim = Number(meta.manifest?.dim) || 0
  const vectorRows = dim > 0 ? Math.floor((await stat(vectorFile)).size / (dim * 4)) : 0
  const missingIds = new Set(meta.indexMeta?.missingVectors || [])
  const tailIds = rows.slice(vectorRows).map((r) => r.id)
  const tailSet = new Set(tailIds)
  const sameSet = missingIds.size === tailSet.size && [...missingIds].every((id) => tailSet.has(id))
  return {
    ok: sameSet && vectorRows > 0 && vectorRows < rows.length,
    vectorRows,
    chunkRows: rows.length,
    tailRows: rows.length - vectorRows,
    missingIds: missingIds.size,
    contiguousTail: sameSet,
    reason: sameSet ? null : '缺向量集合 ≠ 连续尾部（不能安全复用旧向量，需 full 重嵌）',
  }
}

function pickSampleIndices(n, k) {
  if (n <= 0) return []
  const want = Math.min(k, n)
  const set = new Set()
  set.add(0)
  set.add(n - 1)
  for (let i = 1; i < want - 1; i++) set.add(Math.floor((n - 1) * i / (want - 1)))
  return [...set].sort((a, b) => a - b)
}

async function readRawFlat(file) {
  const buf = await readFile(file)
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

async function verifyOne(dataRoot, personaId, cfg, sampleN) {  const meta = await readScopeMeta(dataRoot, personaId)
  if (!meta.ok || !meta.exists) return { personaId, ok: false, error: meta.error || 'scope 不存在' }
  const chunks = await readScopeChunks(dataRoot, personaId)
  const dim = Number(meta.manifest?.dim) || 0
  const vf = vectorPath(dataRoot, personaId, meta.indexMeta?.vectorVersion || 1)
  if (!existsSync(vf)) return { personaId, ok: false, error: '向量文件不存在：' + vf }
  const prefixRows = Math.floor((await stat(vf)).size / (dim * 4))
  const guard = await tailPrefixGuard(meta, chunks, vf)
  const idxs = pickSampleIndices(prefixRows, sampleN)
  const texts = idxs.map((i) => String(chunks.rows[i]?.text || ''))
  const { vectors, usage, requests } = await embedTexts(texts, cfg, { batch: 16 })
  const stored = await readRawFlat(vf)
  const samples = idxs.map((idx, k) => {
    const a = vectors.subarray(k * dim, (k + 1) * dim)
    const b = stored.subarray(idx * dim, (idx + 1) * dim)
    return { idx, chunkId: chunks.rows[idx]?.id, cos: Number(cosine(a, b).toFixed(6)) }
  })
  const minCos = samples.length ? Math.min(...samples.map((s) => s.cos)) : null
  return {
    personaId,
    ok: minCos != null && minCos >= VERIFY_COS_MIN,
    cosMin: minCos,
    threshold: VERIFY_COS_MIN,
    samples,
    prefix: guard,
    usage,
    requests,
    cost: costEstimate(usage.total_tokens || usage.prompt_tokens || 0),
  }
}

async function writeFixedScope(dataRoot, personaId, cfg, { mode, batch }) {
  const meta = await readScopeMeta(dataRoot, personaId)
  if (!meta.ok || !meta.exists) throw new Error(`scope 不可用：${personaId}`)
  const chunks = await readScopeChunks(dataRoot, personaId)
  const rows = chunks.rows
  const dim = Number(meta.manifest?.dim) || 0
  const vf = vectorPath(dataRoot, personaId, meta.indexMeta?.vectorVersion || 1)
  let reusePrefixRows = 0
  let tailRows = rows.length
  if (mode === 'tail') {
    const guard = await tailPrefixGuard(meta, chunks, vf)
    if (!guard.ok) throw new Error(`${personaId}：${guard.reason}`)
    reusePrefixRows = guard.vectorRows
    tailRows = guard.tailRows
  }
  const textsToEmbed = rows.slice(reusePrefixRows).map((r) => String(r.text || ''))
  const charCount = textsToEmbed.reduce((a, t) => a + t.length, 0)
  process.stderr.write(`[${personaId}] mode=${mode} 复用旧向量 ${reusePrefixRows} 行，待嵌 ${tailRows} 块 / ${charCount} 字符\n`)
  const { vectors: newVecs, usage, requests } = await embedTexts(textsToEmbed, cfg, { batch })
  let full = newVecs
  if (reusePrefixRows > 0) {
    const old = await readRawFlat(vf)
    const prefix = old.subarray(0, reusePrefixRows * dim)
    full = new Float32Array(rows.length * dim)
    full.set(prefix, 0)
    full.set(newVecs, prefix.length)
  }
  if (full.length !== rows.length * dim) throw new Error(`向量总长不符：${full.length} ≠ ${rows.length}×${dim}`)
  for (let i = reusePrefixRows; i < rows.length; i++) normalizeRowInPlace(full.subarray(i * dim, (i + 1) * dim))
  const manifest = meta.manifest
  const embedding = {
    provider: manifest.provider || 'cloud',
    model: manifest.model || DEFAULT_MODEL,
    dim,
    normalizerVersion: manifest.normalizerVersion || 'l2-v1',
    tokenizerVersion: manifest.tokenizerVersion ?? null,
    source: `reembed:${mode}`,
  }
  const w = await writeScopeBundle({
    dataRoot,
    personaId,
    displayName: manifest.displayName || null,
    identitySource: manifest.identitySource || 'manual',
    utterances: rows,
    vectors: full,
    embedding,
    retentionDays: Number(manifest.retentionDays) || 30,
    overwrite: true,
    reason: `reembed-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    allowEmbeddingChange: false,
  })
  const after = await statusOfScope(dataRoot, personaId, { deep: true })
  return {
    personaId,
    ok: Boolean(w.ok),
    mode,
    embedded: tailRows,
    chars: charCount,
    reusedRows: reusePrefixRows,
    totalRows: rows.length,
    write: {
      ok: w.ok,
      chunks: w.chunks,
      generation: w.generation,
      badVectorRows: w.badVectorRows?.length || 0,
      readback: w.readback?.state || null,
    },
    usage,
    requests,
    cost: costEstimate(usage.total_tokens || usage.prompt_tokens || 0),
    after: {
      ok: after.ok,
      chunks: after.chunks,
      vectors: after.vectors,
      alignmentBroken: Boolean(after.indexMeta?.alignmentBroken),
      degraded: Boolean(after.degraded),
      warnings: after.warnings,
      errors: after.errors,
    },
    error: w.ok ? null : (w.error || null),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataRoot = resolve(String(args['data-root']))
  const mode = String(args.mode || 'verify')
  if (!['verify', 'tail', 'full'].includes(mode)) throw new Error('mode 只能是 verify / tail / full')
  if (mode !== 'verify' && !args.apply) throw new Error(`${mode} 模式会写入，必须显式加 --apply`)
  const batch = Math.max(1, Number(args.batch) || 16)
  const sampleN = Math.max(2, Number(args.sample) || 5)
  const cfg = loadEmbedCfg()
  const personas = String(args.persona || 'all') === 'all' ? ['alice', 'bob'] : [String(args.persona)]
  const report = { ok: true, mode, dataRoot, model: cfg.model, startedAt: new Date().toISOString(), personas, results: [], totals: { tokens: 0, requests: 0, embedded: 0, chars: 0 } }

  for (const pid of personas) {
    try {
      const r = mode === 'verify'
        ? await verifyOne(dataRoot, pid, cfg, sampleN)
        : await writeFixedScope(dataRoot, pid, cfg, { mode, batch })
      report.results.push(r)
      report.totals.tokens += r.usage?.total_tokens || r.usage?.prompt_tokens || 0
      report.totals.requests += r.requests || 0
      report.totals.embedded += r.embedded || 0
      report.totals.chars += r.chars || 0
      if (!r.ok) report.ok = false
    } catch (e) {
      report.ok = false
      report.results.push({ personaId: pid, ok: false, mode, error: { message: String(e.message || e) } })
    }
  }
  report.totals.cost = costEstimate(report.totals.tokens)
  report.finishedAt = new Date().toISOString()

  await mkdir(PACKAGE_LOGS, { recursive: true }).catch(() => {})
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = join(PACKAGE_LOGS, `repair-vectors-${stamp}.json`)
  await writeFile(logFile, JSON.stringify(report, null, 2) + '\n', 'utf8').catch(() => {})
  report.logFile = logFile

  if (args.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`\n=== ${mode} ===`)
    for (const r of report.results) {
      if (r.ok) console.log(`✅ ${r.personaId}: ${mode === 'verify' ? `cosMin=${r.cosMin}（阈值 ${r.threshold}），前缀 ${r.prefix.vectorRows}/${r.prefix.chunkRows}` : `嵌 ${r.embedded} 块，写回 ${r.write.chunks} 块，missing=${r.after.vectors?.missing ?? '?'}，degraded=${r.after.degraded}`}，tokens=${r.usage?.total_tokens ?? '?'}`)
      else console.log(`❌ ${r.personaId}: ${JSON.stringify(r.error || r.reason || '未通过')}`)
    }
    console.log(`合计：tokens=${report.totals.tokens} 请求=${report.totals.requests} 估算=${report.totals.cost.lowYuan}~${report.totals.cost.highYuan} 元`)
    console.log(`日志：${logFile}`)
  }
  if (!report.ok) process.exitCode = 1
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) }))
  process.exitCode = 1
})
