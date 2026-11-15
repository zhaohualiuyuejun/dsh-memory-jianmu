/**
 * lib/select.mjs —— 输入选择（契约 §5.1）
 *
 * 有 topic：topic_members（按 topic 分组）→ 取 active chunks → 按 t 排序 → 预算内分批
 * 无 topic：按 session 分组 → 取 active chunks → 按 t 排序 → 预算内分批
 *
 * 增量：
 *   · covered = 已处理块（历史 run 的 coveredChunks + 已有 claim 的 anchor）
 *   · 默认跳过 covered；force=true 才重跑
 *
 * 只读：这里不写任何东西。
 */
import { MAX_CHUNKS_PER_RUN } from './version.mjs'

/** 每块的固定开销估算（chunkId + 元数据 + 包裹） */
export const PER_CHUNK_OVERHEAD = 110

export function estimateChars(chunk) {
  const text = typeof chunk?.text === 'string' ? chunk.text : ''
  return text.length + PER_CHUNK_OVERHEAD
}

/**
 * 解析 scope 字符串。
 *   all（默认）/ session:<id> / topic:<id> / since:<ms|ISO> / last:<n>d / ws:<path 子串>
 */
export function parseScope(scope) {
  const raw = String(scope || '').trim()
  if (!raw || raw === 'all') return { kind: 'all' }
  const m = /^(session|topic|since|last|ws):(.*)$/.exec(raw)
  if (!m) return { kind: 'all', warning: `无法识别的 scope（${raw}），按 all 处理` }
  const [, key, val] = m
  if (key === 'session') return { kind: 'session', value: val }
  if (key === 'topic') return { kind: 'topic', value: val }
  if (key === 'ws') return { kind: 'ws', value: val.toLowerCase() }
  if (key === 'last') {
    const dm = /^(\d+)\s*d?$/i.exec(val)
    const days = dm ? Number(dm[1]) : NaN
    if (!Number.isFinite(days) || days <= 0) return { kind: 'all', warning: `last: 参数非法（${val}）` }
    return { kind: 'since', value: Date.now() - days * 86400_000 }
  }
  if (key === 'since') {
    const asNum = Number(val)
    if (Number.isFinite(asNum) && asNum > 0) return { kind: 'since', value: asNum }
    const t = Date.parse(val)
    if (Number.isFinite(t)) return { kind: 'since', value: t }
    return { kind: 'all', warning: `since: 参数非法（${val}）` }
  }
  return { kind: 'all' }
}

/**
 * 选块并分批。
 * @param {object} opts
 * @param {object[]} opts.chunks 根藏块（已按 persona 过滤）
 * @param {Map<string,object>} opts.statusByChunk 熏习状态（可空）
 * @param {Set<string>} opts.covered 已处理块
 * @param {Set<string>} opts.duplicateSkip 建议跳过的重复块（非代表块）
 * @param {object} opts.topics readProcessTopics 的结果
 * @param {string} [opts.topicId]
 * @param {string} [opts.scope]
 * @param {number} [opts.maxInputChars]
 * @param {number} [opts.maxChunks]
 * @param {boolean} [opts.force]
 * @param {number} [opts.maxBatches] 最多返回几批（默认 1，先小口试跑）
 */
export function selectBatches(opts) {
  const {
    chunks = [], statusByChunk = new Map(), covered = new Set(), duplicateSkip = new Set(),
    topics = null, topicId = null, scope = 'all', force = false,
    maxInputChars = 24000, maxChunks = MAX_CHUNKS_PER_RUN, maxBatches = 1,
  } = opts

  const sc = parseScope(scope)
  const warnings = []
  if (sc.warning) warnings.push(sc.warning)

  const isActive = (id) => {
    const st = statusByChunk.get(id)
    if (!st) return true
    return st.status === 'active'
  }

  // 1) scope + topic 过滤
  let targetTopic = topicId ? String(topicId) : (sc.kind === 'topic' ? sc.value : null)
  let pool = []
  for (const c of chunks) {
    if (!c || typeof c.text !== 'string') continue
    const id = c.id
    if (!id) continue
    if (sc.kind === 'session' && c.session !== sc.value) continue
    if (sc.kind === 'ws') {
      const ws = String(c.ws || '').toLowerCase()
      if (!ws.includes(sc.value)) continue
    }
    if (sc.kind === 'since' && !(Number(c.t) >= sc.value)) continue
    if (targetTopic) {
      if (!topics?.topicByChunk) continue
      if (topics.topicByChunk.get(id) !== targetTopic) continue
    }
    pool.push(c)
  }

  // 2) 只取 active
  const beforeActive = pool.length
  pool = pool.filter((c) => isActive(c.id))
  const inactiveSkipped = beforeActive - pool.length

  // 3) 增量：跳过已处理 / 已 claim 的块
  let coveredSkipped = 0
  if (!force) {
    const before = pool.length
    pool = pool.filter((c) => !covered.has(c.id))
    coveredSkipped = before - pool.length
  }

  // 4) 跳过明显重复块（非代表块）
  let duplicateSkipped = 0
  if (duplicateSkip.size) {
    const before = pool.length
    pool = pool.filter((c) => !duplicateSkip.has(c.id))
    duplicateSkipped = before - pool.length
  }

  // 5) 按 t 排序
  pool.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))

  // 6) 分组成窗口：topic 模式一个窗口；无 topic 按 session 分组
  const groups = new Map()
  for (const c of pool) {
    const key = targetTopic ? `topic:${targetTopic}` : `session:${c.session || 'unknown'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    const ta = Number(groups.get(a)[0]?.t) || 0
    const tb = Number(groups.get(b)[0]?.t) || 0
    return ta - tb
  })

  // 7) 预算内切批
  const batches = []
  let totalSelected = 0
  for (const key of groupKeys) {
    const list = groups.get(key)
    let cur = []
    let chars = 0
    const flush = () => {
      if (!cur.length) return
      batches.push({ group: key, chunks: cur, chars })
      totalSelected += cur.length
      cur = []
      chars = 0
    }
    for (const c of list) {
      const size = estimateChars(c)
      // 单块本身就超预算：让它单独成批（否则永远选不中，其它会话也轮不到）
      const oversized = size > maxInputChars
      if (oversized) {
        flush()
        batches.push({ group: key, chunks: [c], chars: size, oversized: true })
        totalSelected += 1
        if (batches.length >= maxBatches) break
        continue
      }
      if (cur.length && (chars + size > maxInputChars || cur.length >= maxChunks)) flush()
      cur.push(c)
      chars += size
      if (batches.length >= maxBatches) break
    }
    if (batches.length >= maxBatches) break
    flush()
    if (batches.length >= maxBatches) break
  }

  const remaining = pool.length - totalSelected
  return {
    ok: true,
    batches,
    stats: {
      pool: pool.length,
      selected: totalSelected,
      remaining: Math.max(0, remaining),
      inactiveSkipped,
      coveredSkipped,
      duplicateSkipped,
      groups: groupKeys.length,
      scope: sc.kind,
      topicId: targetTopic,
    },
    warnings,
  }
}

/** 从历史 run 记录里收集覆盖过的块（前 16 位 hex 足够区分） */
export function collectCoveredFromRuns(runs = []) {
  const set = new Set()
  for (const r of runs) {
    if (!Array.isArray(r?.coveredChunks)) continue
    for (const id of r.coveredChunks) set.add(String(id))
  }
  return set
}

/** 从已有 claims 的 anchors 收集覆盖块 */
export function collectCoveredFromClaims(claimsIndex) {
  const set = new Set()
  for (const c of claimsIndex.byId.values()) {
    for (const a of c.derivedFrom || []) if (a?.chunkId) set.add(String(a.chunkId))
  }
  return set
}

/** 落盘用的短 id（省空间；64bit 前缀，碰撞概率可忽略） */
export function shortId(id) {
  return String(id || '').slice(0, 16)
}
