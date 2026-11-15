/**
 * lib/conflictcards.mjs —— P2.5 冲突卡：把 open conflicts 渲染成「A/B 两说并存」所需的数据
 *
 * 纪律（计划 §P2.5）：
 *   · 只读 open 冲突；不自动裁决、不改 conflicts 状态、不写任何数据；
 *   · 缺块 / 跨人格 → 直接跳过该卡，绝不猜；
 *   · 只读、绝不抛（调用方在注入热路径上，失败就当没有）；
 *   · A/B 各截 ≤120 字，截断用「…」，不截出半个字。
 *
 * 为什么要缓存 chunk 表：
 *   根藏 chunks.jsonl 可能有几万行；每回合都整文件 parse 会把「只读提示」变成「拖慢对话」。
 *   用 mtime+size 做键（与寻枝 rootsource.mjs 同思路），LRU 2，足够覆盖「工作区 + bob」两库。
 */
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafePersonaId, PERSONA_UNASSIGNED } from './paths.mjs'
import { readConflictsMap, latestBy } from './store.mjs'

const SIDE_MAX_CHARS = 120
const CARD_LIMIT_MAX = 20
const CHUNK_CACHE_MAX = 2
/** dataRoot\0personaId → { chunksMtimeMs, chunksSize, map } */
const chunkCache = new Map()

export function clearConflictChunkCache() {
  chunkCache.clear()
}

function nowMs(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function pad2(n) { return String(n).padStart(2, '0') }

/** 与熏习 api.mjs 的 formatTime 同口径（那边是私有函数，这里不导出它） */
export function formatTime(t, tz = 'Asia/Shanghai') {
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(n)).replace(/\//g, '-')
  } catch {
    const d = new Date(n)
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  }
}

/** 压平空白 + 超长截断（保留 ≤max 字，末尾「…」占一位） */
export function clampText(text, max = SIDE_MAX_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const lim = Math.max(8, Number(max) || SIDE_MAX_CHARS)
  if (!s) return ''
  if (s.length <= lim) return s
  return `${s.slice(0, lim - 1)}…`
}

/**
 * 读取并缓存某个人格的 chunk 表（只读）。
 * 返回 { ok, map } 或 { ok:false, code, error }；不抛。
 */
async function loadChunkMap(dataRoot, personaId) {
  const file = join(dataRoot, 'scopes', personaId, 'chunks.jsonl')
  let st
  try {
    st = await stat(file)
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, map: new Map(), exists: false }
    return { ok: false, code: 'SCOPE_STAT_FAILED', error: { code: 'SCOPE_STAT_FAILED', message: `读不到根藏 chunks：${String(e?.message || e)}` } }
  }
  const key = `${dataRoot}\0${personaId}`
  const hit = chunkCache.get(key)
  if (hit && hit.chunksMtimeMs === st.mtimeMs && hit.chunksSize === st.size) return { ok: true, map: hit.map, exists: true }

  let rows = []
  try {
    const raw = await readFile(file, 'utf8')
    rows = raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null } // 单行坏不拖垮整张表
    }).filter(Boolean)
  } catch (e) {
    return { ok: false, code: 'SCOPE_READ_FAILED', error: { code: 'SCOPE_READ_FAILED', message: `根藏 chunks 读不出来：${String(e?.message || e)}` } }
  }
  // 同一 id 出现多行时 latest-wins（按 t）
  const map = latestBy(rows, 'id', 't')
  chunkCache.set(key, { chunksMtimeMs: st.mtimeMs, chunksSize: st.size, map })
  while (chunkCache.size > CHUNK_CACHE_MAX) chunkCache.delete(chunkCache.keys().next().value)
  return { ok: true, map, exists: true }
}

function sideOf(chunk, personaId, sideMaxChars) {
  if (!chunk) return null
  // 跨人格安全：块自带的 personaId 与当前 scope 不一致就跳过（不猜归属）
  if (chunk.personaId && chunk.personaId !== personaId) return null
  const text = clampText(chunk.text, sideMaxChars)
  if (!text) return null
  return {
    chunkId: chunk.id,
    dateText: formatTime(chunk.t, chunk.tz),
    role: chunk.role ?? null,
    sourceType: chunk.sourceType ?? null,
    text,
    session: chunk.session ?? null,
    seq: chunk.seq ?? null,
  }
}

/**
 * 列出可渲染的冲突卡。
 * @returns {{ok:true, personaId:string, total:number, cards:object[]}|{ok:false, code:string, error:object, cards:object[]}}
 */
export async function listConflictCards({
  dataRoot,
  personaId,
  limit = 5,
  sideMaxChars = SIDE_MAX_CHARS,
} = {}) {
  const pid = String(personaId ?? '')
  if (!isSafePersonaId(pid) || pid === PERSONA_UNASSIGNED) {
    return {
      ok: false, personaId: pid || null, cards: [],
      code: 'BAD_PERSONA_ID',
      error: { code: 'BAD_PERSONA_ID', message: `personaId 非法或不可用：${pid || '(空)'}` },
    }
  }
  try {
    const conflicts = await readConflictsMap(dataRoot, pid)
    const open = [...conflicts.map.values()].filter((c) => c && c.status === 'open')
    open.sort((a, b) => (nowMs(b.updatedAt ?? b.createdAt) - nowMs(a.updatedAt ?? a.createdAt)) || String(a.conflictId).localeCompare(String(b.conflictId)))
    const lim = Math.max(1, Math.min(CARD_LIMIT_MAX, Number(limit) || 5))
    const picked = open.slice(0, lim)
    if (!picked.length) return { ok: true, personaId: pid, total: 0, cards: [] }

    const loaded = await loadChunkMap(dataRoot, pid)
    if (!loaded.ok) return { ok: false, personaId: pid, cards: [], code: loaded.code, error: loaded.error }

    const cards = []
    let skippedMissing = 0
    for (const c of picked) {
      const ids = [...new Set(Array.isArray(c.chunkIds) ? c.chunkIds.filter(Boolean) : [])]
      if (ids.length < 2) { skippedMissing += 1; continue }
      const a = sideOf(loaded.map.get(ids[0]), pid, sideMaxChars)
      const b = sideOf(loaded.map.get(ids[1]), pid, sideMaxChars)
      if (!a || !b) { skippedMissing += 1; continue } // 缺块 / 跨人格 / 空文本 → 整卡跳过
      cards.push({
        conflictId: c.conflictId,
        kind: c.kind ?? null,
        createdAt: nowMs(c.createdAt) || null,
        createdAtText: formatTime(c.createdAt),
        updatedAt: nowMs(c.updatedAt) || nowMs(c.createdAt) || null,
        note: typeof c.note === 'string' ? clampText(c.note, 80) : null,
        a,
        b,
      })
    }
    return { ok: true, personaId: pid, total: open.length, skippedMissing, cards }
  } catch (e) {
    return {
      ok: false, personaId: pid, cards: [],
      code: 'CONFLICT_CARDS_FAILED',
      error: { code: 'CONFLICT_CARDS_FAILED', message: `冲突卡读取失败（已忽略）：${String(e?.message || e)}` },
    }
  }
}
