/**
 * lib/lifecycle.mjs —— 人格生命周期诊断（2026-11-12，P4 第 1 步）
 *
 * 只读、零写入、零 API。把「人格卡（镜台）」「根藏 identity」「根藏 scope」三处对账，
 * 回答用户最容易困惑的三个问题：
 *   ① 这个人格有记忆、却没卡了吗？（无卡人格——记忆还会继续长）
 *   ② 这张卡在根藏里注册了吗？（未注册——建了卡却没记忆）
 *   ③ 有块没归属吗？（未归属桶——存着但检索不到）
 *
 * 边界：只读 `identity.json` / `scopes/<pid>/manifest.json` / `persona/registry.json`；
 * 不写任何文件，不调模型；任何一处缺失都降级为空，不猜。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readIdentity, listScopes, readScope } from './root.mjs'
import { defaultDataRoot, PERSONA_UNASSIGNED } from './paths.mjs'

const NAME = '人格生命周期'

async function readJsonSafe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

/** 只读根藏自己的 `<dataRoot>/scopes/<pid>/manifest.json`（不是熏习 process 的 manifest） */
async function rootChunkCount(dataRoot, personaId) {
  const m = await readJsonSafe(join(dataRoot, 'scopes', personaId, 'manifest.json'))
  const n = Number(m?.chunks)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {string} [dataRoot]
 * @returns {Promise<{ok:boolean, cardlessPersonas:Array, unregisteredCards:Array,
 *   unassigned:{chunks:number, byWorkspace:Array<{ws:string, chunks:number}>},
 *   identity:object, cards:object, warnings:string[]}>}
 */
export async function personaLifecycle(dataRoot = defaultDataRoot()) {
  const identity = await readIdentity(dataRoot)
  const identPersonas = identity.ok ? (identity.identity?.personas || {}) : {}
  const identPids = Object.keys(identPersonas)

  // 镜台的卡（只读；没装镜台时这份文件不存在，按“没有卡”处理）
  const registryFile = join(dataRoot, 'persona', 'registry.json')
  const registry = await readJsonSafe(registryFile)
  const cards = (registry && typeof registry.cards === 'object' && registry.cards) ? registry.cards : {}
  const cardIds = Object.keys(cards).filter((id) => (cards[id]?.status || 'active') !== 'deleted')
  const cardName = (id) => cards[id]?.name || id
  const cardWorkspaces = (id) => Object.entries(registry?.workspaces || {})
    .filter(([, v]) => v === id).map(([k]) => k)

  // 有数据的 scope
  const scopes = await listScopes(dataRoot)
  const chunkCount = new Map()
  for (const pid of scopes) chunkCount.set(pid, await rootChunkCount(dataRoot, pid))

  const warnings = []

  // ① 无卡人格：identity 声明了、或 scope 里有数据，但镜台没有对应卡
  const cardlessPersonas = []
  const allPids = [...new Set([...identPids, ...scopes.filter((s) => s !== PERSONA_UNASSIGNED)])]
  for (const pid of allPids) {
    if (cardIds.includes(pid)) continue
    const chunks = chunkCount.get(pid) ?? 0
    cardlessPersonas.push({
      personaId: pid,
      displayName: identPersonas[pid]?.displayName || pid,
      chunks,
      inIdentity: identPids.includes(pid),
      hasScopes: scopes.includes(pid),
    })
    warnings.push(`无卡人格「${identPersonas[pid]?.displayName || pid}」：根藏有 ${chunks} 块记忆，但镜台没有对应人格卡；注意新对话仍会继续记进这个人格（identity 未变）`)
  }

  // ② 未注册卡：镜台有卡，但 identity 里没有这个 persona
  const unregisteredCards = []
  for (const id of cardIds) {
    if (identPids.includes(id)) continue
    const workspaces = cardWorkspaces(id)
    unregisteredCards.push({ cardId: id, name: cardName(id), workspaces })
    warnings.push(`未注册人格「${cardName(id)}」：镜台有卡，但根藏 identity.json 里没有 ${id}；该卡绑定工作区的对话会被归到 persona_unassigned，等于“建了卡却没记忆”`)
  }

  // ③ 未归属块：按工作区分组；已被 identity 明确映射的块算「软认领」（仍留在未归属桶，但检索可见）
  const wsMap = identity.ok ? (identity.identity?.workspaces || {}) : {}
  const wsTargets = Object.entries(wsMap)
    .map(([ws, pid]) => ({ key: String(ws).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(), pid: String(pid) }))
    .filter((x) => x.key && x.pid)
    .sort((a, b) => b.key.length - a.key.length) // 最长前缀先匹配
  const ownerOfWs = (ws) => {
    const w = String(ws || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    if (!w) return null
    for (const t of wsTargets) if (w === t.key || w.startsWith(t.key + '\\')) return t.pid
    return null
  }

  const unassigned = { chunks: 0, pureChunks: 0, claimedChunks: 0, byWorkspace: [] }
  if (scopes.includes(PERSONA_UNASSIGNED)) {
    const un = await readScope(dataRoot, PERSONA_UNASSIGNED).catch(() => null)
    if (un?.ok) {
      const byWs = new Map()
      for (const c of un.chunks || []) {
        const ws = String(c.ws || c.wsDir || '(未知工作区)')
        const claimedBy = ownerOfWs(ws)
        const row = byWs.get(ws) || { ws, chunks: 0, claimedBy: null }
        row.chunks += 1
        if (claimedBy) row.claimedBy = claimedBy
        byWs.set(ws, row)
      }
      unassigned.chunks = (un.chunks || []).length
      unassigned.byWorkspace = [...byWs.values()].sort((a, b) => b.chunks - a.chunks)
      unassigned.claimedChunks = unassigned.byWorkspace.filter((r) => r.claimedBy).reduce((n, r) => n + r.chunks, 0)
      unassigned.pureChunks = unassigned.chunks - unassigned.claimedChunks
      if (unassigned.pureChunks > 0) {
        warnings.push(`未归属块 ${unassigned.pureChunks} 条（分布在 ${unassigned.byWorkspace.filter((r) => !r.claimedBy).length} 个工作区）：块存着但不会被任何人格检索到；请给对应工作区指定人格`)
      }
      if (unassigned.claimedChunks > 0) {
        warnings.push(`已软认领 ${unassigned.claimedChunks} 条旧原话：仍在未归属桶（不搬数据），但已被对应人格影子纳入检索；identity 映射移除即回退`)
      }
    }
  }

  // 特殊提示：defaultPersonaId 会把所有未映射工作区吸过去
  if (identity.ok && identity.identity?.defaultPersonaId) {
    warnings.push(`注意：identity.defaultPersonaId = ${identity.identity.defaultPersonaId}——所有未映射工作区的对话都会归到这个默认人格（可能的串味来源）`)
  }

  // ④ 每个 scope 的规模 / 卡 / 注册状态（P4 #7 删卡弹窗要显示「记忆 N 条仍保留」）
  const scopeRows = []
  for (const pid of scopes) {
    if (pid === PERSONA_UNASSIGNED) continue
    scopeRows.push({
      personaId: pid,
      displayName: identPersonas[pid]?.displayName || pid,
      chunks: chunkCount.get(pid) ?? 0,
      hasCard: cardIds.includes(pid),
      inIdentity: identPids.includes(pid),
    })
  }
  scopeRows.sort((a, b) => b.chunks - a.chunks)

  return {
    ok: true,
    name: NAME,
    dataRoot,
    identity: {
      ok: Boolean(identity.ok),
      file: identity.file,
      personas: identPids,
      defaultPersonaId: identity.ok ? (identity.identity?.defaultPersonaId ?? null) : null,
      error: identity.ok ? null : (identity.error || null),
    },
    cards: { file: registryFile, found: Boolean(registry), count: cardIds.length, ids: cardIds },
    scopes: scopeRows,
    cardlessPersonas,
    unregisteredCards,
    unassigned,
    warnings,
    summary: {
      cardless: cardlessPersonas.length,
      unregistered: unregisteredCards.length,
      unassignedChunks: unassigned.chunks,
      unassignedPure: unassigned.pureChunks,
      unassignedClaimed: unassigned.claimedChunks,
      // 软认领过的块不算「不健康」：它们已经能被对应人格检索到
      healthy: cardlessPersonas.length === 0 && unregisteredCards.length === 0 && unassigned.pureChunks === 0,
    },
  }
}
