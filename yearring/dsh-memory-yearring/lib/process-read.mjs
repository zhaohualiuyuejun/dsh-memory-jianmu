/**
 * lib/process-read.mjs —— 熏习（处理层）只读读取器
 *
 * 只读 <dataRoot>/process/<personaId>/ 下的：
 *   state.jsonl        每块的状态（active/superseded/expired/archived）
 *   topics.jsonl       主题元数据（当前 topics=0）
 *   topic_members.jsonl 主题归属（当前为空）
 *   duplicates.jsonl   重复组（年轮只用来避开明显重复块）
 *
 * 不存在也能跑：topic-less / 无状态模式。
 */
import { join } from 'node:path'
import { readJson, readJsonl } from './fsatomic.mjs'
import { processDirOf } from './paths.mjs'

/** 读块状态：chunkId → 最新状态记录（latest-wins，按 updatedAt/version） */
export async function readProcessState(dataRoot, personaId) {
  const dir = processDirOf(dataRoot, personaId)
  const file = join(dir, 'state.jsonl')
  const r = await readJsonl(file)

  const statusByChunk = new Map()
  const order = new Map()
  for (const row of r.rows) {
    if (!row || typeof row !== 'object' || !row.chunkId) continue
    const key = row.chunkId
    const prev = statusByChunk.get(key)
    if (!prev) { statusByChunk.set(key, row); order.set(key, 1); continue }
    // latest-wins：version 优先，其次 updatedAt
    const pv = Number(prev.version) || 0
    const nv = Number(row.version) || 0
    if (nv > pv || (nv === pv && (Number(row.updatedAt) || 0) >= (Number(prev.updatedAt) || 0))) {
      statusByChunk.set(key, row)
    }
  }

  const counts = { active: 0, superseded: 0, expired: 0, archived: 0, unknown: 0 }
  for (const row of statusByChunk.values()) {
    const s = row.status
    if (counts[s] !== undefined) counts[s] += 1
    else counts.unknown += 1
  }
  return {
    ok: true,
    exists: r.exists,
    file,
    statusByChunk,
    counts,
    activeCount: counts.active,
    corrupt: r.corrupt || [],
    tornTail: Boolean(r.tornTail),
  }
}

/** 读主题与归属（v1a 通常为空，年轮仍兼容） */
export async function readProcessTopics(dataRoot, personaId) {
  const dir = processDirOf(dataRoot, personaId)
  const topicsRes = await readJsonl(join(dir, 'topics.jsonl'))
  const membersRes = await readJsonl(join(dir, 'topic_members.jsonl'))

  const topics = []
  const topicById = new Map()
  for (const row of topicsRes.rows) {
    if (!row || !row.topicId) continue
    const t = {
      topicId: String(row.topicId),
      title: row.title ? String(row.title) : String(row.name || row.topicId),
      status: row.status || 'active',
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
    }
    topics.push(t)
    topicById.set(t.topicId, t)
  }

  const membersByTopic = new Map()
  const topicByChunk = new Map()
  for (const row of membersRes.rows) {
    if (!row || !row.topicId || !row.chunkId) continue
    const tid = String(row.topicId)
    const cid = String(row.chunkId)
    if (!membersByTopic.has(tid)) membersByTopic.set(tid, [])
    membersByTopic.get(tid).push(cid)
    topicByChunk.set(cid, tid)
  }

  return {
    ok: true,
    topics,
    topicById,
    membersByTopic,
    topicByChunk,
    topicsExists: topicsRes.exists,
    membersExists: membersRes.exists,
    corrupt: [...(topicsRes.corrupt || []), ...(membersRes.corrupt || [])],
  }
}

/** 读重复组：返回 exact 重复的 chunkId 集合（年轮选块时可以避开它们，省 token） */
export async function readDuplicateChunkIds(dataRoot, personaId) {
  const dir = processDirOf(dataRoot, personaId)
  const r = await readJsonl(join(dir, 'duplicates.jsonl'))
  const inGroup = new Set()
  const exact = new Set()
  for (const row of r.rows) {
    if (!row || !Array.isArray(row.chunkIds) || row.chunkIds.length < 2) continue
    for (const id of row.chunkIds) inGroup.add(String(id))
    if (row.method === 'exact') {
      // 只留第一块代表，其余视为重复
      for (const id of row.chunkIds.slice(1)) exact.add(String(id))
    }
  }
  return { ok: true, inGroup, exact, groups: r.rows.length }
}

/** 读熏习 manifest（取 rootBuiltAt / generation 做对齐） */
export async function readProcessManifest(dataRoot, personaId) {
  const dir = processDirOf(dataRoot, personaId)
  const r = await readJson(join(dir, 'manifest.json'))
  if (!r.ok) return { ok: true, exists: false, manifest: null, file: join(dir, 'manifest.json') }
  return { ok: true, exists: true, manifest: r.value, file: join(dir, 'manifest.json') }
}
