/**
 * lib/claim.mjs —— claim 的构造、校验、归一化、去重与冲突决策
 *
 * 硬规则（契约 v1 §3.1 / §5.2）：
 *   · 非 draft 的 claim 必须至少 1 条 derivedFrom，且 quote 逐字出现在 chunk.text 中
 *   · claimGroupId 稳定；修订 = 同 group revision+1，旧 revision 保留
 *   · epistemic=inference 必须在 title 前标「推测：」
 *   · 跨人格拒绝：quoteChunkId 必须属于该 persona
 *
 * 去重分两级：
 *   · 精确：claimGroupId 相同 + derivedFromHash 相同 ⇒ 完全重复，跳过
 *   · 近似：同 kind + 归一化标题 SimHash 汉明距离 ≤3 ⇒ 视为近重复，跳过（不合并、不猜）
 */
import { createHash } from 'node:crypto'
import { scanText } from './guards.mjs'
import {
  KINDS, EPISTEMIC, SPEAKERS, STATUSES, MAX_TITLE_CHARS, MAX_BODY_CHARS, MAX_QUOTE_CHARS, MIN_QUOTE_CHARS,
  SIMHASH_DISTANCE,
} from './version.mjs'

export const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

// ── 说话人（P1.5） ─────────────────────────────────────────────────────────

/**
 * 从锚点块推导「谁说的」——确定性规则，不调模型、不猜：
 *   role=user/assistant 优先；其次 sourceType（含 *-bridge 桥接消息）。
 * 推导不出 → unknown（工具/system 内容、缺字段）。
 */
export function speakerFromChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return 'unknown'
  const role = String(chunk.role || '').toLowerCase()
  if (role === 'user' || role === 'assistant') return role
  const st = String(chunk.sourceType || '').toLowerCase()
  if (st === 'user' || st === 'user-bridge') return 'user'
  if (st === 'assistant' || st === 'assistant-bridge') return 'assistant'
  return 'unknown'
}

/**
 * 一条 claim 的说话人「按证据应该是谁」（回填与校验共用）：
 *   · inference（推测）一律 unknown —— 推测不是任何人说的
 *   · 其余按第一个锚点所在块的角色
 */
export function speakerFromClaim(claim, chunksById) {
  if (!claim || typeof claim !== 'object') return 'unknown'
  if (claim.epistemic === 'inference') return 'unknown'
  const a = Array.isArray(claim.derivedFrom) ? claim.derivedFrom[0] : null
  if (!a) return 'unknown'
  return speakerFromChunk(chunksById?.get ? chunksById.get(a.chunkId) : null)
}

/** 标题归一化：NFKC → 去零宽/空白 → 小写 → 去标点（保留中英文数字） */
export function normalizeTitle(title) {
  let s = String(title ?? '')
  try { s = s.normalize('NFKC') } catch { /* 老 node 没有就算了 */ }
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '')
  s = s.replace(/\s+/g, '')
  s = s.toLowerCase()
  s = s.replace(/[^\p{L}\p{N}]/gu, '')
  return s
}

export function claimGroupIdOf(personaId, kind, title) {
  return sha256(`${personaId}|${kind}|${normalizeTitle(title)}`)
}

export function derivedFromHashOf(anchors) {
  const parts = [...(anchors || [])]
    .map((a) => `${a.chunkId}|${a.quote}`)
    .sort()
  return sha256(parts.join('\n'))
}

export function claimIdOf({ personaId, kind, claimGroupId, derivedFromHash, revision }) {
  return sha256(`${personaId}|${kind}|${claimGroupId}|${derivedFromHash}|${revision}`)
}

// ── SimHash（64 位，中文 bigram + 英文词） ──────────────────────────────────

function tokensOf(title) {
  const norm = normalizeTitle(title)
  if (!norm) return []
  const out = []
  for (const w of norm.match(/[a-z0-9]+/g) || []) out.push(w)
  const cjkRuns = norm.match(/[\u3400-\u9fff\u3040-\u30ff]+/g) || []
  for (const run of cjkRuns) {
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  if (!out.length) out.push(norm)
  return out
}

export function simhash64(title) {
  const vec = new Array(64).fill(0)
  for (const tok of tokensOf(title)) {
    const h = createHash('sha256').update(tok, 'utf8').digest()
    for (let bit = 0; bit < 64; bit++) {
      const byte = h[bit >> 3]
      const isOne = (byte >> (7 - (bit & 7))) & 1
      vec[bit] += isOne ? 1 : -1
    }
  }
  let out = 0n
  for (let bit = 0; bit < 64; bit++) if (vec[bit] > 0) out |= (1n << BigInt(63 - bit))
  return out
}

export function hamming64(a, b) {
  let x = a ^ b
  let n = 0
  while (x) { x &= (x - 1n); n++ }
  return n
}

// ── 锚点归一化 ──────────────────────────────────────────────────────────────

/** 把 LLM 给的 { quoteChunkId, quote } 转成契约里的 derivedFrom 条目 */
export function toAnchor(raw, chunksById) {
  const chunkId = String(raw?.quoteChunkId || raw?.chunkId || '')
  const chunk = chunksById.get(chunkId)
  if (!chunk) return { ok: false, code: 'ANCHOR_INVALID', reason: `quoteChunkId 不存在：${chunkId}` }
  const quote = String(raw?.quote ?? '')
  return {
    ok: true,
    anchor: {
      chunkId,
      session: chunk.session ?? null,
      messageId: chunk.messageId ?? null,
      seq: chunk.seq ?? null,
      part: chunk.part ?? 0,
      t: chunk.t ?? null,
      quote,
    },
  }
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/**
 * 校验一条 LLM 输出，返回可落盘的 claim（或拒绝原因）。
 * @param {object} raw LLM 输出项
 * @param {{personaId:string, chunksById:Map<string,object>}} env
 */
export function validateClaim(raw, env) {
  const reasons = []
  const warnings = []
  const { personaId, chunksById } = env

  const kind = String(raw?.kind || '')
  if (!KINDS.includes(kind)) reasons.push(`kind 非法：${kind}`)
  let epistemic = String(raw?.epistemic || '')
  if (!EPISTEMIC.includes(epistemic)) {
    reasons.push(`epistemic 非法：${epistemic}`)
    epistemic = 'unknown'
  }
  const confidence = Number(raw?.confidence)
  // 契约 §5.2：confidence 必须「合法」。越界不再静默夹值——审查实测 999 被夹成 1 也能入库
  let conf = 0.5
  if (!Number.isFinite(confidence)) {
    warnings.push('confidence 缺失/非法，按 0.5 处理')
  } else if (confidence < 0 || confidence > 1) {
    reasons.push(`confidence 越界（${confidence}），必须在 0..1`)
  } else {
    conf = confidence
  }

  let title = String(raw?.title ?? '').trim()
  let body = String(raw?.body ?? '').trim()
  if (!title) reasons.push('title 为空')
  if (title.length > MAX_TITLE_CHARS) { warnings.push(`title 超长（${title.length}）已截断`); title = title.slice(0, MAX_TITLE_CHARS) }
  if (body.length > MAX_BODY_CHARS) { warnings.push(`body 超长（${body.length}）已截断`); body = body.slice(0, MAX_BODY_CHARS) }
  // 指令性内容不进 title：换行压平
  title = title.replace(/[\r\n]+/g, ' ')
  body = body.replace(/\r\n?/g, '\n')

  if (epistemic === 'inference' && !title.startsWith('推测：')) title = `推测：${title}`

  const anchorRes = toAnchor(raw, chunksById)
  if (!anchorRes.ok) reasons.push(anchorRes.reason)
  const anchors = anchorRes.ok ? [anchorRes.anchor] : []

  if (anchors.length) {
    const a = anchors[0]
    const chunk = chunksById.get(a.chunkId)
    if (!chunk) {
      reasons.push(`chunk 不存在：${a.chunkId}`)
    } else {
      if (!chunk.personaId || chunk.personaId !== personaId) {
        reasons.push(`跨人格锚点被拒：chunk.personaId=${chunk.personaId}，目标是 ${personaId}`)
      }
      const q = a.quote
      if (!q.trim()) reasons.push('quote 是纯空白')
      else if (q.length < MIN_QUOTE_CHARS) reasons.push(`quote 太短（${q.length} < ${MIN_QUOTE_CHARS}）`)
      else if (q.length > MAX_QUOTE_CHARS) reasons.push(`quote 太长（${q.length} > ${MAX_QUOTE_CHARS}）`)
      else if (typeof chunk.text !== 'string' || !chunk.text.includes(q)) {
        reasons.push('quote 不是 chunk.text 的逐字子串（拒绝落盘，不做模糊匹配）')
      }
    }
  } else if (reasons.length === 0) {
    reasons.push('缺少 derivedFrom')
  }

  // ── P1.5 speaker：谁说的 ──
  // v1 纪律：取值非法/缺省都不拒写（老提示词还在跑），归一成合法值 + warning。
  let speaker = String(raw?.speaker ?? '').toLowerCase().trim()
  let speakerSource = 'llm'
  if (!SPEAKERS.includes(speaker)) {
    if (String(raw?.speaker ?? '').trim()) warnings.push(`speaker 非法（${raw.speaker}），按 unknown 处理`)
    speaker = 'unknown'
    speakerSource = 'missing'
  }
  const anchorSpeaker = anchors.length ? speakerFromChunk(chunksById.get(anchors[0].chunkId)) : 'unknown'
  if (speaker === 'unknown' && anchorSpeaker !== 'unknown') {
    // 锚点块的角色是确定性证据（与回填工具同一规则），不是猜
    speaker = anchorSpeaker
    speakerSource = 'anchor'
    warnings.push(`speaker 缺省/unknown，按锚点角色补为 ${speaker}`)
  } else if (speaker !== 'unknown' && anchorSpeaker !== 'unknown' && speaker !== anchorSpeaker) {
    warnings.push(`speaker=${speaker} 与锚点角色 ${anchorSpeaker} 不一致（保留模型判断，建议人工复核）`)
  }
  if (epistemic === 'inference' && speaker !== 'unknown') {
    warnings.push(`epistemic=inference 的 speaker 必须是 unknown（原值 ${speaker} 已改写）`)
    speaker = 'unknown'
    speakerSource = 'inference-rule'
  }

  if (reasons.length) {
    return { ok: false, reasons, warnings }
  }

  // topicHint 会进 front-matter：必须去换行 + 过注入扫描（审查实测过 `\n---\n` 注入）
  const topicHintRaw = raw?.topicHint ? String(raw.topicHint) : ''
  let topicHint = topicHintRaw
    ? topicHintRaw.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    : null
  if (topicHint) {
    const sc = scanText(topicHint)
    if (sc.verdict === 'red') {
      reasons.push(`topicHint 命中注入/敏感红项：${sc.hits.filter((h) => h.level === 'red').map((h) => h.what).join('；')}`)
    }
  }

  const reportedBy = raw?.reportedBy ? String(raw.reportedBy).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : null
  // 契约 §3.1 硬规则 4：hearsay 必须带转述来源（derivedFrom 指向转述句）+ reportedBy
  if (epistemic === 'hearsay' && !reportedBy) {
    reasons.push('epistemic=hearsay 必须填 reportedBy（谁转述的）')
  }

  if (reasons.length) {
    return { ok: false, reasons, warnings }
  }

  const claimGroupId = claimGroupIdOf(personaId, kind, title)
  const derivedFromHash = derivedFromHashOf(anchors)
  const claim = {
    claimGroupId,
    personaId,
    kind,
    epistemic,
    speaker,
    speakerSource,
    title,
    body,
    topicId: null,
    topicHint,
    status: 'active',
    confidence: conf,
    derivedFrom: anchors,
    derivedFromHash,
    supersedes: null,
    supersededBy: null,
    conflictsWith: [],
    reportedBy,
    source: 'llm',
    createdAt: 0,
    updatedAt: 0,
    runId: null,
    model: null,
    promptVersion: null,
    costTokens: 0,
    review: { status: 'unreviewed', by: null, at: null },
  }
  return { ok: true, claim, warnings }
}

// ── 去重 / 冲突决策 ─────────────────────────────────────────────────────────

/**
 * 把一批「已校验」的 claim 与已有索引对照，决定写什么。
 * @returns {{
 *   toWrite: object[], writeTargets: object[],
 *   skipped: object[], superseded: object[], conflicts: object[]
 * }}
 */
export function planWrites(incoming, existing, opts = {}) {
  const { maxRevisions } = opts
  const toWrite = []
  const skipped = []
  const superseded = []
  const conflicts = []

  // 本批已接受的新 claim（同批内也去重）
  const acceptedGroups = new Map()

  for (const claim of incoming) {
    const groupId = claim.claimGroupId
    const groupList = existing.byGroup.get(groupId) || []
    const latest = groupList.length ? groupList[groupList.length - 1] : null

    // 1) 精确重复：同 group + 同 derivedFromHash
    const identical = groupList.find((c) => c.derivedFromHash === claim.derivedFromHash)
    if (identical) {
      skipped.push({ claim, reason: 'identical', existingClaimId: identical.claimId })
      continue
    }

    // 1b) 同批内重复
    const acc = acceptedGroups.get(groupId)
    if (acc && acc.derivedFromHash === claim.derivedFromHash) {
      skipped.push({ claim, reason: 'identical-in-batch', existingClaimId: null })
      continue
    }

    // 2) 近似重复：同 kind + SimHash 距离 ≤ 3（不同 group 才算）
    if (!acc) {
      const near = findNearDuplicate(claim, existing, acceptedGroups)
      if (near) {
        skipped.push({ claim, reason: 'near-duplicate', existingClaimId: near.claimId, distance: near.distance })
        continue
      }
    }

    // 3) 定 revision（同批已接受的新版本也要计入，否则同批同组会出现两条 rev=1）
    const prevAccepted = acceptedGroups.get(groupId)
    const prevLatest = prevAccepted || latest
    const revision = prevLatest ? (Number(prevLatest.revision) || 1) + 1 : 1
    if (maxRevisions && revision > maxRevisions) {
      skipped.push({ claim, reason: 'revision-cap', existingClaimId: latest?.claimId ?? null })
      continue
    }

    const next = {
      ...claim,
      revision,
      claimId: claimIdOf({
        personaId: claim.personaId,
        kind: claim.kind,
        claimGroupId: groupId,
        derivedFromHash: claim.derivedFromHash,
        revision,
      }),
    }

    // 4) supersedes 提示：命中已有 group ⇒ 旧版标 superseded（append-only，靠索引推导）
    //    · 命中本组 → 本组 latest 被取代（正常修订）
    //    · 命中别的组 → 跨组取代：新 claim 独立成组，旧组 latest 被标 superseded（靠 supersededIds 推导）
    if (claim._supersedesHitGroup) {
      const hitGroup = claim._supersedesHitGroup
      if (hitGroup === groupId) {
        if (latest) {
          next.supersedes = latest.claimId
          superseded.push({ groupId, from: latest.claimId, to: next.claimId, crossGroup: false })
        }
      } else {
        const targetList = existing.byGroup.get(hitGroup) || []
        const targetLatest = targetList[targetList.length - 1]
        if (targetLatest) {
          next.supersedes = targetLatest.claimId
          superseded.push({ groupId: hitGroup, from: targetLatest.claimId, to: next.claimId, crossGroup: true })
        }
      }
    }

    // 5) conflict 提示：同实体/同 topic 的矛盾 ⇒ status=conflicted，不覆盖
    const conflictHit = claim._conflictHintId ? existing.byGroup.get(claim._conflictHintId) : null
    if (conflictHit) {
      next.status = 'conflicted'
      next.conflictsWith = [claim._conflictHintId]
      conflicts.push({ groupId, withGroupId: claim._conflictHintId })
    }

    toWrite.push(next)
    acceptedGroups.set(groupId, next)
  }

  return { toWrite, skipped, superseded, conflicts }
}


function findNearDuplicate(claim, existing, acceptedGroups) {
  const sig = simhash64(claim.title)
  const candidates = [...existing.latestByGroup.values()]
  for (const acc of acceptedGroups.values()) candidates.push(acc)
  for (const c of candidates) {
    // 同组不算「近重复」：同组要走 revision 路径
    if (c.claimGroupId === claim.claimGroupId) continue
    if (c.kind !== claim.kind) continue
    if (c.personaId !== claim.personaId) continue
    const d = hamming64(sig, simhash64(c.title))
    if (d <= SIMHASH_DISTANCE) return { claimId: c.claimId, distance: d }
  }
  return null
}

/** 把 LLM 给的 supersedesHint / conflictHint 解析成可用的 groupId（解析不到就 null） */
export function resolveHints(raw, existing) {
  const out = { _supersedesHint: null, _supersedesHitGroup: null, _conflictHintId: null }
  const findGroup = (hint) => {
    if (!hint) return null
    if (existing.byGroup.has(hint)) return hint
    const n = normalizeTitle(hint)
    if (!n) return null
    for (const [groupId, list] of existing.byGroup) {
      const latest = list[list.length - 1]
      if (normalizeTitle(latest.title) === n) return groupId
    }
    return null
  }
  const sh = raw?.supersedesHint ? String(raw.supersedesHint).trim() : ''
  if (sh) {
    out._supersedesHint = sh
    out._supersedesHitGroup = findGroup(sh)
  }
  const ch = raw?.conflictHint ? String(raw.conflictHint).trim() : ''
  if (ch) out._conflictHintId = findGroup(ch)
  return out
}

/**
 * 有效状态推导（append-only，不改历史行）：
 *   1. 被别的 claim 的 supersedes 指向 ⇒ superseded（跨组取代）
 *   2. 同组内非最高 revision ⇒ superseded
 *   3. 否则用自身 status
 */
export function effectiveStatus(claim, groupList, supersededIds, supersededGroups) {
  if (!claim) return 'unknown'
  if (supersededIds && supersededIds.has(claim.claimId)) return 'superseded'
  // 组级取代：目标组在「取代者 createdAt」之前产生的版本一律 superseded；
  // 之后产生的新 revision 允许复活（那是新证据推翻旧取代，合理）
  if (supersededGroups && supersededGroups.get(claim.claimGroupId) !== undefined) {
    const replacedAt = supersededGroups.get(claim.claimGroupId)
    if ((Number(claim.createdAt) || 0) <= replacedAt) return 'superseded'
  }
  const declared = claim.status || 'active'
  if (declared !== 'active') return declared
  const list = groupList || []
  const maxRev = list.reduce((m, c) => Math.max(m, Number(c.revision) || 1), 0)
  if ((Number(claim.revision) || 1) < maxRev) return 'superseded'
  return 'active'
}

/** 给 claim 补 id / 时间戳（落盘前最后一步） */
export function finalizeClaim(claim, { runId, model, promptVersion, costTokens = 0, now = Date.now() }) {
  return {
    ...claim,
    createdAt: now,
    updatedAt: now,
    runId: runId ?? null,
    model: model ?? null,
    promptVersion: promptVersion ?? null,
    costTokens: Math.max(0, Math.round(costTokens)),
    review: { status: 'unreviewed', by: null, at: null },
  }
}

/** 校验一条已落盘 claim 的结构（verify 用） */
export function checkClaimShape(c) {
  const problems = []
  if (!c || typeof c !== 'object') return ['claim 不是对象']
  if (!c.claimId) problems.push('缺少 claimId')
  if (!c.claimGroupId) problems.push('缺少 claimGroupId')
  if (!STATUSES.includes(c.status)) problems.push(`status 非法：${c.status}`)
  if (!KINDS.includes(c.kind)) problems.push(`kind 非法：${c.kind}`)
  if (!EPISTEMIC.includes(c.epistemic)) problems.push(`epistemic 非法：${c.epistemic}`)
  if (!c.title) problems.push('title 为空')
  if (!Array.isArray(c.derivedFrom) || c.derivedFrom.length === 0) problems.push('缺少 derivedFrom')
  if (c.epistemic === 'inference' && c.title && !c.title.startsWith('推测：')) problems.push('inference 未标「推测：」')
  return problems
}
