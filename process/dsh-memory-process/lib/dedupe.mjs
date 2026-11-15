/**
 * lib/dedupe.mjs —— 精确重复 + SimHash 近重复（只生成候选，不自动合并）
 *
 * 精确：NFKC + 合并连续空白 + 去首尾空白后 sha256。
 * 近重复：SimHash 4×16-bit 分桶取候选 → Hamming ≤ N 且 3-gram Jaccard ≥ 0.9。
 * 精确组优先；近重复只在「不属于任何精确组」的块之间计算，避免组重叠。
 */
import { normalizeForDedup } from './rules.mjs'
import { hashText, simhash64, hamming64, bandKeys, jaccard3, hex64 } from './simhash.mjs'
import { DEFAULT_THRESHOLDS } from './version.mjs'

export function detectExactGroups(chunks) {
  const byHash = new Map()
  for (const c of chunks) {
    const h = hashText(normalizeForDedup(c.text))
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(c)
  }
  const groups = []
  for (const [h, rows] of byHash) {
    if (rows.length < 2) continue
    const ids = rows.map((r) => r.id)
    groups.push({
      groupId: `dup-exact-${h.slice(0, 16)}`,
      chunkIds: ids,
      method: 'exact',
      similarity: 1,
      evidenceCount: rows.length,
      mergedFrom: [...ids],
      version: 1,
      status: 'pending',
      createdAt: Math.min(...rows.map((r) => r.t ?? 0)),
      normalizer: DEFAULT_THRESHOLDS.dedupeNormalizer,
    })
  }
  groups.sort((a, b) => (a.createdAt - b.createdAt) || a.groupId.localeCompare(b.groupId))
  return groups
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i) }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x] } return x }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[rb] = ra }
}

export function detectNearGroups(chunks, opts = {}) {
  const {
    simhashDistance = DEFAULT_THRESHOLDS.simhashDistance,
    jaccardThreshold = DEFAULT_THRESHOLDS.jaccard,
    maxCandidatePairs = 300000,
  } = opts

  const exactGroups = opts.exactGroups ?? detectExactGroups(chunks)
  const inExact = new Set()
  for (const g of exactGroups) for (const id of g.chunkIds) inExact.add(id)

  const pool = chunks.filter((c) => !inExact.has(c.id))
  const n = pool.length
  const sims = new Array(n)
  const bands = new Array(n)
  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const sim = simhash64(normalizeForDedup(pool[i].text))
    sims[i] = sim
    const keys = bandKeys(sim)
    bands[i] = keys
    for (let k = 0; k < keys.length; k++) {
      const key = `${k}:${keys[k]}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(i)
    }
  }

  const seenPair = new Set()
  const uf = new UnionFind(n)
  let candidatePairs = 0
  let acceptedPairs = 0
  let capped = false
  const jaccardCache = new Map()

  outer:
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = arr[a], j = arr[b]
        const key = i < j ? `${i}|${j}` : `${j}|${i}`
        if (seenPair.has(key)) continue
        seenPair.add(key)
        candidatePairs++
        if (candidatePairs > maxCandidatePairs) { capped = true; break outer }
        if (hamming64(sims[i], sims[j]) > simhashDistance) continue
        const jac = jaccard3(normalizeForDedup(pool[i].text), normalizeForDedup(pool[j].text), jaccardCache)
        if (jac < jaccardThreshold) continue
        uf.union(i, j)
        acceptedPairs++
      }
    }
  }

  const groupsByRoot = new Map()
  for (let i = 0; i < n; i++) {
    const r = uf.find(i)
    if (!groupsByRoot.has(r)) groupsByRoot.set(r, [])
    groupsByRoot.get(r).push(i)
  }

  const groups = []
  for (const members of groupsByRoot.values()) {
    if (members.length < 2) continue
    const rows = members.map((i) => pool[i])
    const ids = rows.map((r) => r.id)
    let similarity = 1
    if (rows.length <= 20) {
      let min = 1
      for (let a = 0; a < rows.length; a++) {
        for (let b = a + 1; b < rows.length; b++) {
          const jac = jaccard3(
            normalizeForDedup(rows[a].text),
            normalizeForDedup(rows[b].text),
            jaccardCache,
          )
          if (jac < min) min = jac
        }
      }
      similarity = min
    } else {
      const a = normalizeForDedup(rows[0].text)
      let sum = 0
      for (let b = 1; b < rows.length; b++) sum += jaccard3(a, normalizeForDedup(rows[b].text), jaccardCache)
      similarity = sum / (rows.length - 1)
    }
    groups.push({
      groupId: `dup-near-${hashText(`simhash+3gram|${[...ids].sort().join('|')}`).slice(0, 16)}`,
      chunkIds: ids,
      method: 'simhash+3gram',
      similarity: Number(similarity.toFixed(4)),
      evidenceCount: rows.length,
      mergedFrom: [...ids],
      version: 1,
      status: 'pending',
      createdAt: Math.min(...rows.map((r) => r.t ?? 0)),
      simhashDistance,
      jaccard: Number(similarity.toFixed(4)),
      normalizer: DEFAULT_THRESHOLDS.dedupeNormalizer,
    })
  }
  groups.sort((a, b) => (a.createdAt - b.createdAt) || a.groupId.localeCompare(b.groupId))

  return {
    groups,
    stats: {
      pool: n,
      exactExcluded: inExact.size,
      candidatePairs,
      acceptedPairs,
      capped,
      simhashSample: n ? hex64(sims[0]) : null,
    },
  }
}

export function detectDuplicates(chunks, opts = {}) {
  const exactGroups = detectExactGroups(chunks)
  const near = detectNearGroups(chunks, { ...opts, exactGroups })
  return {
    exactGroups,
    nearGroups: near.groups,
    groups: [...exactGroups, ...near.groups],
    stats: near.stats,
  }
}

/**
 * 增量对账：根藏追加后，已有 pending 重复组必须更新成员，不能只按 groupId 跳过。
 * - exact：groupId 由文本哈希决定，同 id 新成员 → 写同组新版本；
 * - near：groupId 由成员集决定，新成员会生成重叠组 → 合并到现有组并 dismissed 其余组；
 * - 已 merged/dismissed 的组不复活。
 */
export function reconcileDuplicateGroups(existingMap, detectedGroups, now = Date.now) {
  const rows = []
  const seen = new Set()
  const exactMemberSet = new Set()
  for (const g of detectedGroups) if (g.method === 'exact') for (const id of g.chunkIds) exactMemberSet.add(id)

  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
  const pendingNear = [...existingMap.values()].filter((g) => g.status === 'pending' && g.method === 'simhash+3gram')

  // 先把现有 near 组里已进入 exact 组的成员剔掉（避免 exact/near 重叠）
  for (const g of pendingNear) {
    const kept = g.chunkIds.filter((id) => !exactMemberSet.has(id))
    if (kept.length === g.chunkIds.length) continue
    seen.add(g.groupId)
    if (kept.length < 2) {
      rows.push({ ...g, status: 'dismissed', version: Number(g.version ?? 1) + 1, updatedAt: now, generatedAt: now, note: '成员已全部进入精确重复组' })
    } else {
      rows.push({ ...g, chunkIds: kept, mergedFrom: [...kept], evidenceCount: kept.length, version: Number(g.version ?? 1) + 1, updatedAt: now, generatedAt: now, note: '移出已进入精确重复组的成员' })
    }
  }

  for (const det of detectedGroups) {
    const existing = existingMap.get(det.groupId)
    if (existing) {
      if (existing.status !== 'pending') { seen.add(existing.groupId); continue }
      if (!sameSet(existing.chunkIds, det.chunkIds)) {
        rows.push({
          ...det,
          version: Number(existing.version ?? 1) + 1,
          status: 'pending',
          createdAt: existing.createdAt ?? det.createdAt,
          updatedAt: now,
          generatedAt: now,
          mergedFrom: [...det.chunkIds],
          evidenceCount: det.chunkIds.length,
          note: '成员已更新（增量对账）',
        })
      }
      seen.add(existing.groupId)
      continue
    }

    if (det.method === 'simhash+3gram') {
      const overlaps = pendingNear
        .filter((g) => !seen.has(g.groupId) && g.chunkIds.some((id) => det.chunkIds.includes(id)))
        .sort((a, b) => String(a.groupId).localeCompare(String(b.groupId)))
      if (overlaps.length) {
        const primary = overlaps[0]
        const union = [...new Set([...primary.chunkIds, ...det.chunkIds])]
        rows.push({
          ...primary,
          chunkIds: union,
          mergedFrom: [...union],
          evidenceCount: union.length,
          similarity: det.similarity,
          version: Number(primary.version ?? 1) + 1,
          status: 'pending',
          updatedAt: now,
          generatedAt: now,
          note: '合并重叠近重复组（增量对账）',
        })
        for (const other of overlaps.slice(1)) {
          rows.push({ ...other, status: 'dismissed', version: Number(other.version ?? 1) + 1, updatedAt: now, generatedAt: now, note: `merged into ${primary.groupId}` })
        }
        seen.add(primary.groupId)
        continue
      }
    }

    rows.push({
      ...det,
      version: 1,
      status: 'pending',
      updatedAt: now,
      generatedAt: now,
      mergedFrom: [...det.chunkIds],
      evidenceCount: det.chunkIds.length,
    })
    seen.add(det.groupId)
  }
  return rows
}
