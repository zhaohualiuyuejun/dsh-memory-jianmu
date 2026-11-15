/**
 * lib/storage.mjs —— 存储面板 + 源会话孤儿标记（Stage 0）
 *
 * 只读为主：
 *   · 各层体积（root scopes / process / year / persona / _backup / identity / other）
 *   · 剩余空间与占用比（statfs）
 *   · 周增速：优先用 storage_history.jsonl 快照（需显式 snapshot），
 *     没有快照时用「会话源近 N 天写入量 × 放大系数」估算，并明确标注 basis。
 *   · 耗尽预测：freeBytes ÷ 每日增长（估不出来就 null，不瞎猜）
 *   · sourceGone：根藏块对应的会话目录已不存在 → 只提示，不删（交接书 §9.7 决策）
 *
 * 写动作只有一个：recordStorageSnapshot（显式调用才写 history）。
 */
import { readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionsRoot, defaultDataRoot } from './paths.mjs'
import { readJsonl, appendJsonl, readJson } from './fsatomic.mjs'

const HISTORY_FILE = 'storage_history.jsonl'
/** 实测口径：记忆（根藏+寻枝）≈ 源会话的 2.2 倍（交接书 §9.8） */
const AMPLIFICATION = 2.2
const MAX_SAMPLE = 5

async function walkDir(dir, depth = 0, maxDepth = 6) {
  const out = { bytes: 0, files: 0, dirs: 0, byExt: {} }
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const d of ents) {
    const p = join(dir, d.name)
    try {
      if (d.isDirectory()) {
        out.dirs++
        if (depth < maxDepth) {
          const sub = await walkDir(p, depth + 1, maxDepth)
          out.bytes += sub.bytes; out.files += sub.files; out.dirs += sub.dirs
        }
      } else if (d.isFile()) {
        const s = await stat(p)
        out.bytes += s.size; out.files++
        const ext = (d.name.match(/\.[a-z0-9]+$/i) || ['(none)'])[0].toLowerCase()
        out.byExt[ext] = (out.byExt[ext] || 0) + s.size
      }
    } catch { /* 忽略单个文件失败 */ }
  }
  return out
}

async function diskOf(dataRoot) {
  try {
    const s = await statfs(dataRoot)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    return {
      path: dataRoot,
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      freeRatio: total > 0 ? Number((free / total).toFixed(4)) : null,
    }
  } catch {
    return null
  }
}

/** 根藏各人格的细分体积（只 stat，不读内容） */
async function scopeBreakdown(dataRoot) {
  const dir = join(dataRoot, 'scopes')
  const out = {}
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    const files = { chunksBytes: 0, vectorsBytes: 0, indexBytes: 0, archiveBytes: 0, otherBytes: 0, files: 0 }
    let children = []
    try { children = await readdir(p, { withFileTypes: true }) } catch { /* 忽略 */ }
    for (const c of children) {
      const cp = join(p, c.name)
      try {
        if (c.isDirectory()) {
          if (c.name === '_archive') {
            const sub = await walkDir(cp)
            files.archiveBytes += sub.bytes; files.files += sub.files
          }
          continue
        }
        const s = await stat(cp)
        files.files++
        if (c.name === 'chunks.jsonl') files.chunksBytes += s.size
        else if (/^vectors_v\d+\.f32$/.test(c.name)) files.vectorsBytes += s.size
        else if (c.name === 'index_meta.json' || c.name === 'manifest.json') files.indexBytes += s.size
        else files.otherBytes += s.size
      } catch { /* 忽略 */ }
    }
    // 轻量读 manifest 里的块数（只读这一份小文件）
    let chunks = null
    try {
      const m = await readJson(join(p, 'manifest.json'))
      if (m.ok) chunks = Number(m.value?.chunks) || 0
    } catch { /* 忽略 */ }
    out[e.name] = { ...files, chunks }
  }
  return out
}

/** 会话源近 N 天的写入量（按 mtime，近似） */
async function sourceGrowth(days) {
  const root = sessionsRoot()
  const now = Date.now()
  const out = { bytes: 0, files: 0, sessions: 0, scanned: 0, sessionIds: new Set() }
  let workspaces = []
  try { workspaces = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let sids = []
    try { sids = await readdir(join(root, ws.name), { withFileTypes: true }) } catch { continue }
    for (const sd of sids) {
      if (!sd.isDirectory()) continue
      out.sessionIds.add(sd.name)
      const f = join(root, ws.name, sd.name, 'session.v4.jsonl.zstd')
      try {
        const s = await stat(f)
        out.scanned++
        if (now - s.mtimeMs <= days * 86400000) { out.bytes += s.size; out.files++ }
      } catch { /* 没有会话文件 */ }
    }
  }
  out.sessions = out.sessionIds.size
  return out
}

/** 读历史快照（只读） */
async function readHistory(dataRoot) {
  const r = await readJsonl(join(dataRoot, HISTORY_FILE))
  return r.rows.filter((x) => x && Number.isFinite(Number(x.totalBytes)))
}

/**
 * 主报告
 * @param {{dataRoot?:string, days?:number, now?:number}} opts
 */
export async function storageReport({ dataRoot = defaultDataRoot(), days = 7, now = Date.now() } = {}) {
  const dRoot = String(dataRoot)
  const windowDays = Math.max(1, Math.min(90, Number(days) || 7))
  const layerNames = ['scopes', 'process', 'year', 'persona', '_backup', '_dryrun']
  const layers = {}
  for (const n of layerNames) {
    layers[n] = await walkDir(join(dRoot, n))
  }
  // dataRoot 根下的散文件（identity.json 等）
  const other = { bytes: 0, files: 0, dirs: 0 }
  let rootEnts = []
  try { rootEnts = await readdir(dRoot, { withFileTypes: true }) } catch { /* 忽略 */ }
  for (const e of rootEnts) {
    if (e.isDirectory()) {
      if (layerNames.includes(e.name)) continue
      const sub = await walkDir(join(dRoot, e.name))
      other.bytes += sub.bytes; other.files += sub.files; other.dirs += sub.dirs + 1
    } else if (e.isFile()) {
      try { const s = await stat(join(dRoot, e.name)); other.bytes += s.size; other.files++ } catch { /* 忽略 */ }
    }
  }

  const total = Object.values(layers).reduce((a, l) => ({ bytes: a.bytes + l.bytes, files: a.files + l.files }), { bytes: other.bytes, files: other.files })
  const disk = await diskOf(dRoot)
  const scopes = await scopeBreakdown(dRoot)
  const src = await sourceGrowth(windowDays)
  const hist = await readHistory(dRoot)

  // 增长：优先历史快照（同一窗口内首尾两点），否则用源写入量 × 放大系数
  let growth
  const inWindow = hist.filter((h) => now - new Date(h.at).getTime() <= windowDays * 86400000)
  if (inWindow.length >= 2) {
    const first = inWindow[0]
    const last = inWindow[inWindow.length - 1]
    const spanDays = Math.max((new Date(last.at).getTime() - new Date(first.at).getTime()) / 86400000, 1 / 24)
    const delta = Number(last.totalBytes) - Number(first.totalBytes)
    growth = {
      basis: 'snapshot',
      windowDays, points: inWindow.length,
      firstAt: first.at, lastAt: last.at,
      bytesDelta: delta,
      dailyBytes: Math.max(0, Math.round(delta / spanDays)),
      note: '按 storage_history.jsonl 快照首尾差计算（含覆盖写，可能低估）',
    }
  } else {
    const dailySource = src.bytes / windowDays
    growth = {
      basis: 'session-mtime',
      windowDays,
      points: 0,
      sourceBytesInWindow: src.bytes,
      sourceDailyBytes: Math.round(dailySource),
      amplification: AMPLIFICATION,
      dailyBytes: Math.round(dailySource * AMPLIFICATION),
      note: `没有足够的 storage_history 快照：按会话源近 ${windowDays} 天写入量 × ${AMPLIFICATION} 估算（近似值）`,
    }
  }
  const daily = Number(growth.dailyBytes) || 0
  growth.daysToExhaust = disk && daily > 0 ? Number((disk.freeBytes / daily).toFixed(1)) : null
  growth.exhaustAt = disk && daily > 0 ? new Date(now + (disk.freeBytes / daily) * 86400000).toISOString() : null
  growth.historyPoints = hist.length
  growth.historyFile = join(dRoot, HISTORY_FILE)

  // sourceGone：会话目录不存在的块（只提示，不删）
  const gone = { sessionsKnown: src.sessionIds.size, checkedChunks: 0, goneChunks: 0, byPersona: {}, sample: [], hint: '只提示不删：这些原话的源会话已被删除/移走；需要清理时用 jianmu_store_forget（墓碑可撤销）' }
  for (const pid of Object.keys(scopes)) {
    const r = await readJsonl(join(dRoot, 'scopes', pid, 'chunks.jsonl'))
    let n = 0
    const samples = []
    for (const row of r.rows) {
      if (!row || typeof row !== 'object') continue
      gone.checkedChunks++
      const sid = row.session
      if (!sid || src.sessionIds.has(sid)) continue
      n++
      if (samples.length < MAX_SAMPLE) samples.push({ personaId: pid, chunkId: row.id, session: sid, t: row.t ?? null, text: String(row.text || '').slice(0, 60) })
    }
    if (n > 0) gone.byPersona[pid] = n
    gone.goneChunks += n
    gone.sample.push(...samples)
  }

  return {
    ok: true,
    dataRoot: dRoot,
    checkedAt: new Date(now).toISOString(),
    disk,
    layers,
    other,
    total,
    scopes,
    growth,
    sourceGone: gone,
  }
}

/** 显式写一份快照（唯一的写动作） */
export async function recordStorageSnapshot({ dataRoot = defaultDataRoot(), now = Date.now() } = {}) {
  const rep = await storageReport({ dataRoot, now })
  const row = {
    at: new Date(now).toISOString(),
    totalBytes: rep.total.bytes,
    totalFiles: rep.total.files,
    freeBytes: rep.disk?.freeBytes ?? null,
    layers: Object.fromEntries(Object.entries(rep.layers).map(([k, v]) => [k, v.bytes])),
    scopes: Object.fromEntries(Object.entries(rep.scopes).map(([k, v]) => [k, v.chunksBytes + v.vectorsBytes + v.indexBytes + v.archiveBytes + v.otherBytes])),
  }
  await appendJsonl(join(String(dataRoot), HISTORY_FILE), [row], { durable: false })
  return { ok: true, snapshot: row, historyFile: join(String(dataRoot), HISTORY_FILE) }
}
