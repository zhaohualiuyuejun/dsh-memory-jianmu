#!/usr/bin/env node
/**
 * 摘要索引 · 原地构建/增量刷新（2026-11-11）
 * =====================================================================
 * 把 A2（chunk 摘要 + 原文一起嵌入）做进**根藏本体**，不再需要第二个派生根藏。
 *
 *   ① 给 ≥80 字的长块生成一句摘要（本地 Ollama；可导入已有 summaries.jsonl）
 *   ② 摘要写回 chunk 的 `summary` 字段（原 text 一字不动）
 *   ③ 按「摘要+原文」重嵌向量（增量：已有摘要且 manifest 已标 concat 的块直接复用）
 *   ④ manifest.embeddingMeta.summaryMode = concat（读取端据此自证口径）
 *
 * 安全：写前自动备份 chunks/vectors/manifest 到 <scope>/.backup/a2-<ts>/；
 *      全程临时文件 + rename；失败不留下半成品；源 text 永不改写。
 *
 * 用法：
 *   node tools/summarize-reembed.mjs --root <dataRoot> --api-key-file <key文件> --dry-run
 *   node tools/summarize-reembed.mjs --root <dataRoot> --api-key-file <key文件>
 *   node tools/summarize-reembed.mjs --root <dataRoot> --summaries <已有摘要.jsonl> --scope alice
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const ROOT = path.resolve(argOf('--root', process.env.JIANMU_DATA_ROOT || ''))
const SCOPE = argOf('--scope', 'all')
const MODEL = argOf('--model', 'Qwen/Qwen3-Embedding-8B')
const DIM = Number(argOf('--dim', 4096)) || 4096
const MIN_CHARS = Number(argOf('--min-chars', 80)) || 80
const OLLAMA_BASE = argOf('--ollama-base', 'http://127.0.0.1:11434')
const OLLAMA_MODEL = argOf('--ollama-model', 'qwen3:8b')
const CONC = Math.max(1, Number(argOf('--concurrency', 2)) || 2)
const LIMIT = Number(argOf('--limit', 0)) || 0
const SUMMARIES = argOf('--summaries', '') ? path.resolve(argOf('--summaries', '')) : ''
const APIKEY_FILE = argOf('--api-key-file', process.env.SILICONFLOW_ENV_FILE || '')
const DRY = has('--dry-run')
const ARCHIVE = String(process.env.JIANMU_ARCHIVE_DIR || '').trim()
const BATCH = 16

// 由 lib/auto-summary.mjs 挂载的子进程会带这两个环境变量：
// 退出时把单飞锁删掉（token 校验，避免误删别人刚抢到的新锁）。手动运行时为 no-op。
const AUTO_LOCK = process.env.JIANMU_AUTO_SUMMARY_LOCK || ''
const AUTO_TOKEN = process.env.JIANMU_AUTO_SUMMARY_TOKEN || ''
if (AUTO_LOCK) {
  process.on('exit', () => {
    try {
      const cur = JSON.parse(fs.readFileSync(AUTO_LOCK, 'utf8'))
      if (!AUTO_TOKEN || cur?.token === AUTO_TOKEN) fs.unlinkSync(AUTO_LOCK)
    } catch { /* 锁已不在 / 不是我们的：不删 */ }
  })
}

if (!argOf('--root', '')) { console.error('用法：--root <dataRoot> [--scope all|<pid>] --api-key-file <key>'); process.exit(2) }
if (!fs.existsSync(path.join(ROOT, 'scopes'))) { console.error(`❌ 没有 scopes/：${ROOT}`); process.exit(3) }

const sha16 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
const findKey = () => {
  const env = String(process.env.SILICONFLOW_API_KEY || '').trim()
  if (env) return env
  const raw = APIKEY_FILE && fs.existsSync(APIKEY_FILE) ? fs.readFileSync(APIKEY_FILE, 'utf8') : ''
  for (const line of String(raw).split(/\r?\n/)) {
    const s = line.trim(); if (!s || s.startsWith('#')) continue
    if (s.includes('=')) { const [k, ...r] = s.split('='); if (k.trim() === 'SILICONFLOW_API_KEY') return r.join('=').trim() }
    else if (s.startsWith('sk-')) return s
  }
  throw new Error('缺少 SILICONFLOW_API_KEY（--api-key-file 或环境变量）')
}

async function ollamaSummary(text, role) {
  const roleCn = { user: '用户', assistant: '助手', 'user-bridge': '用户', injected: '系统', system: '系统' }[role] || '发言者'
  const prompt = `你是记忆检索用的摘要器。下面是一条${roleCn}消息。请用不超过45字的中文概括它，主语保持为“${roleCn}”；必须保留原文出现的路径、数字、专有名词（有就保留）；不要编造，不要解释，只输出摘要。\n消息（${roleCn}）：${String(text || '')}`
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(`${OLLAMA_BASE.replace(/\/+$/, '')}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, think: false, options: { temperature: 0, num_predict: 96 } }),
        signal: AbortSignal.timeout(180000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      return String(j.response || '').trim().replace(/\s+/g, ' ').slice(0, 160)
    } catch (e) { if (a === 3) return ''; await new Promise((r) => setTimeout(r, 1000 * a)) }
  }
}

async function embedBatch(texts, key) {
  for (let a = 1; a <= 4; a++) {
    try {
      const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, input: texts }),
        signal: AbortSignal.timeout(180000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
      const j = await res.json()
      const out = (j.data || []).sort((x, y) => x.index - y.index).map((d) => d.embedding)
      if (out.length !== texts.length) throw new Error(`返回条数不符 ${out.length}/${texts.length}`)
      return out
    } catch (e) { if (a === 4) throw e; await new Promise((r) => setTimeout(r, 1200 * a)) }
  }
}

const importSums = new Map()
if (SUMMARIES) {
  for (const r of readJsonl(SUMMARIES)) if (r.chunkId && r.summary) importSums.set(`${r.chunkId}|${r.sha || ''}`, r.summary)
}

const key = findKey()
const scopes = fs.readdirSync(path.join(ROOT, 'scopes'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const targets = SCOPE === 'all' ? scopes : scopes.filter((s) => s === SCOPE)
if (!targets.length) { console.error(`❌ 找不到 scope：${SCOPE}（有：${scopes.join(',')}）`); process.exit(4) }

// 旧快照保留：A2 可能每小时跑一次，每份都含整个 vectors 文件（百 MB 级）；
// 只保留最近 N 份（默认 2）。更旧的是写前快照，成功写盘后只用于立即回滚。
// 2026-11-15 实测：本机旧快照曾累积到 4.5GB（39 份），是 C 盘被吃满的主因。
const KEEP_BACKUPS = Math.max(1, Number(process.env.JIANMU_A2_BACKUP_KEEP) || 2)
function pruneBackups(bdir) {
  let names = []
  try {
    names = fs.readdirSync(bdir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('a2-'))
      .map((d) => d.name)
      .sort()
  } catch { return 0 }
  const old = names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))
  let n = 0
  for (const name of old) {
    try { fs.rmSync(path.join(bdir, name), { recursive: true, force: true }); n++ } catch { /* 单份失败不阻塞主流程 */ }
  }
  if (n) console.log(`   清理旧快照 ${n} 份（保留最近 ${KEEP_BACKUPS} 份；JIANMU_A2_BACKUP_KEEP 可调）`)
  return n
}

for (const pid of targets) {
  const dir = path.join(ROOT, 'scopes', pid)
  const chunksFile = path.join(dir, 'chunks.jsonl')
  const vecFile = path.join(dir, 'vectors_v1.f32')
  const manFile = path.join(dir, 'manifest.json')
  if (!fs.existsSync(chunksFile)) { console.log(`- ${pid}: 跳过（无 chunks.jsonl）`); continue }
  const rows = readJsonl(chunksFile)
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'))
  const vecBuf = fs.existsSync(vecFile) ? fs.readFileSync(vecFile) : Buffer.alloc(0)
  const aligned = vecBuf.length === rows.length * DIM * 4
  const prevVecs = aligned ? new Float32Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.length / 4) : null
  const alreadyConcat = man?.embeddingMeta?.summaryMode === 'concat'
  const hadSummaryBefore = new Set()
  rows.forEach((r, i) => { if (r.summary) hadSummaryBefore.add(i) })

  let need = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.summary) continue
    if (String(r.text || '').length < MIN_CHARS) continue
    need.push(i)
  }
  const todo = LIMIT ? need.slice(0, LIMIT) : need
  console.log(`\n== ${pid}：${rows.length} 块 / 已有摘要 ${rows.filter((r) => r.summary).length} / 待生成 ${todo.length}${LIMIT ? '（limit）' : ''} / 向量对齐=${aligned} / 已 concat=${alreadyConcat}`)

  // ① 摘要：优先导入，否则本地生成
  let imported = 0
  const missing = []
  for (const i of todo) {
    const r = rows[i]
    const hit = importSums.get(`${r.id}|${sha16(r.text)}`)
    if (hit) { r.summary = hit; imported++ } else missing.push(i)
  }
  console.log(`   摘要：导入 ${imported} / 本地生成 ${missing.length}`)
  if (DRY) { console.log('   （dry-run，未写盘）'); continue }
  let done = 0
  for (let k = 0; k < missing.length; k += CONC) {
    const batch = missing.slice(k, k + CONC)
    const out = await Promise.all(batch.map((i) => ollamaSummary(rows[i].text, rows[i].role)))
    batch.forEach((i, j) => { if (out[j]) rows[i].summary = out[j] })
    done += batch.length
    if (done % 40 === 0 || done === missing.length) console.log(`     摘要 ${done}/${missing.length}`)
  }

  // ③ 备份 + 记录「读取时的行签名」（防止转换期间被自动摄取插队）
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  // 配了归档目录 → 快照直接写别的盘（C 盘只留正在用的 vectors）
  const bak = ARCHIVE
    ? path.join(ARCHIVE, 'a2', pid, `a2-${ts}`)
    : path.join(dir, '.backup', `a2-${ts}`)
  fs.mkdirSync(bak, { recursive: true })
  fs.copyFileSync(chunksFile, path.join(bak, 'chunks.jsonl'))
  if (fs.existsSync(vecFile)) fs.copyFileSync(vecFile, path.join(bak, 'vectors_v1.f32'))
  fs.copyFileSync(manFile, path.join(bak, 'manifest.json'))
  const sigOf = () => { const st = fs.statSync(chunksFile); return `${rows.length}|${st.size}|${st.mtimeMs}` }
  const sig0 = sigOf()
  console.log(`   备份：${bak}`)

  // ④ 重嵌：已 concat 且原本就有摘要的块复用旧向量；其余按新口径重嵌
  const out = new Float32Array(rows.length * DIM)
  const reuse = []
  const embedIdx = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const had = hadSummaryBefore.has(i) && alreadyConcat && prevVecs
    if (had) { reuse.push(i); out.set(prevVecs.subarray(i * DIM, (i + 1) * DIM), i * DIM) }
    else embedIdx.push(i)
  }
  const textOf = (r) => (r.summary ? `${r.summary}\n${r.text}` : String(r.text || ''))
  console.log(`   重嵌：复用 ${reuse.length} / 需嵌 ${embedIdx.length}`)
  let emb = 0
  for (let k = 0; k < embedIdx.length; k += BATCH) {
    const batch = embedIdx.slice(k, k + BATCH)
    const vecs = await embedBatch(batch.map((i) => textOf(rows[i])), key)
    batch.forEach((i, j) => out.set(vecs[j].slice(0, DIM), i * DIM))
    emb += batch.length
    if (emb % 800 === 0 || emb === embedIdx.length) console.log(`     向量 ${emb}/${embedIdx.length}`)
  }
  // 守卫：转换期间根藏被摄取（行数/文件变了）就中止，不写任何半成品
  if (sigOf() !== sig0) {
    console.error(`   ⛔ ${pid} 在转换期间被写入（自动摄取？），已中止、未改动磁盘。请等摄取结束后重跑。`)
    process.exitCode = 5
    continue
  }
  // ⑤ 一次性落盘：chunks → vectors → manifest
  const tmpChunks = `${chunksFile}.tmp`
  fs.writeFileSync(tmpChunks, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.renameSync(tmpChunks, chunksFile)
  const tmpVec = `${vecFile}.tmp`
  fs.writeFileSync(tmpVec, Buffer.from(out.buffer, out.byteOffset, out.byteLength))
  fs.renameSync(tmpVec, vecFile)

  // ⑤ manifest 标记口径（块数也要同步，否则读取端会报 chunks_count_mismatch）
  man.chunks = rows.length
  man.embeddingMeta = { ...(man.embeddingMeta || {}), summaryMode: 'concat', summaryMinChars: MIN_CHARS, summaryModel: OLLAMA_MODEL, summaryBuiltAt: new Date().toISOString() }
  const tmpMan = `${manFile}.tmp`
  fs.writeFileSync(tmpMan, JSON.stringify(man, null, 2))
  fs.renameSync(tmpMan, manFile)
  pruneBackups(ARCHIVE ? path.join(ARCHIVE, 'a2', pid) : path.join(dir, '.backup'))
  console.log(`   ✅ ${pid} 完成：摘要 ${rows.filter((r) => r.summary).length}/${rows.length}`)
}
console.log('\n完成。')
