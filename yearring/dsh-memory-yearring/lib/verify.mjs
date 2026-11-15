/**
 * lib/verify.mjs —— 年轮校验（只读；v1a 只报不修）
 *
 * 检查项（契约 §8.1）：
 *   1. 锚点有效：非 draft 的每条 quote 是对应 chunk.text 的逐字子串（orphan = 0）
 *   2. 锚点存在：derivedFrom.chunkId 在根藏里存在且属于该 persona
 *   3. 跨人格：claim.personaId 与目录一致；锚点 chunk.personaId 一致
 *   4. 结构：claimId/claimGroupId/kind/epistemic/status 合法；inference 标「推测：」
 *   5. 计数：manifest.counts 与实际一致
 *   6. topic_docs：front-matter 里的 claimIds 都存在
 *   7. 文件健康：claims.jsonl 坏行 / 撕裂尾巴
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readScope } from './root.mjs'
import { readClaims, readManifest, listTopicDocs } from './store.mjs'
import { checkClaimShape, effectiveStatus, claimIdOf, derivedFromHashOf } from './claim.mjs'
import { topicDocsDir } from './paths.mjs'
import { MIN_QUOTE_CHARS, MAX_QUOTE_CHARS, SPEAKERS } from './version.mjs'

function parseFrontMatter(text) {
  const fences = (text.match(/^---\s*$/gm) || []).length
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return { ok: false, reason: '无 front-matter', data: {}, fences }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const k = line.slice(0, i).trim()
    let v = line.slice(i + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v) } catch { v = v.slice(1, -1) }
    }
    if (typeof v === 'string' && v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => {
          if (s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s) } catch { return s.slice(1, -1) } }
          return s
        })
    }
    data[k] = v
  }
  return { ok: true, data, fences }
}

export async function verifyYear({ dataRoot, personaId, repair = false }) {
  const problems = []
  const warnings = []
  const checks = []
  const add = (level, code, message, detail) => {
    const row = { level, code, message, detail: detail ?? null }
    if (level === 'error') problems.push(row)
    else warnings.push(row)
  }

  // 根藏
  const root = await readScope(dataRoot, personaId)
  if (!root.ok) {
    return {
      ok: false,
      code: root.code,
      error: root.error,
      note: '根藏不可读：无法校验锚点（年轮本身不写根藏）',
    }
  }
  const chunksById = new Map()
  for (const c of root.chunks) chunksById.set(c.id, c)
  checks.push({ name: 'root', ok: true, chunks: root.chunks.length, personaId })

  // claims
  const claims = await readClaims(dataRoot, personaId)
  if (claims.corrupt.length) add('error', 'JSONL_CORRUPT', `claims.jsonl 有 ${claims.corrupt.length} 个坏行`, claims.corrupt.slice(0, 5))
  if (claims.tornTail) add('warning', 'TORN_TAIL', 'claims.jsonl 末尾有撕裂行（下次 append 前会先补换行，半行仍属坏数据，建议手工修）')
  // 重复行：元数据回填（backfill）会按 latest-wins 追加同 claimId 新行，本身合法；
  // 但文件只增不减，读侧按行读的消费者（如寻枝 claim 召回）会重复计数 → 必须暴露并建议压缩。
  const dupRows = claims.rows.length - claims.unique
  if (dupRows > 0) {
    add('warning', 'DUPLICATE_CLAIM_ROWS', `claims.jsonl 有 ${dupRows} 行同 claimId 重复（latest-wins 读侧正确；文件 ${claims.rows.length} 行 / 唯一 ${claims.unique}）。建议跑 tools/compact-claims.mjs 压缩`, { rows: claims.rows.length, unique: claims.unique, duplicated: dupRows })
  }
  checks.push({ name: 'claims', ok: true, rows: claims.rows.length, unique: claims.unique, duplicated: dupRows, groups: claims.byGroup.size })

  let orphan = 0
  let crossPersona = 0
  let shapeBad = 0
  let quoteBad = 0

  for (const c of claims.byId.values()) {
    // 结构
    const shape = checkClaimShape(c)
    if (shape.length) {
      shapeBad += 1
      if (shapeBad <= 20) add('error', 'CLAIM_SHAPE', `claim ${c.claimId?.slice(0, 12)} 结构问题`, shape)
    }
    // 跨人格
    if (c.personaId && c.personaId !== personaId) {
      crossPersona += 1
      add('error', 'CROSS_PERSONA', `claim ${c.claimId?.slice(0, 12)} 的 personaId=${c.personaId}，不属于 ${personaId}`)
    }
    // 哈希自洽：锚点被改过 / claimId 不是按契约算出来的，都要报
    if (Array.isArray(c.derivedFrom) && c.derivedFrom.length) {
      const expectHash = derivedFromHashOf(c.derivedFrom)
      if (expectHash !== c.derivedFromHash) {
        add('error', 'ANCHOR_HASH_MISMATCH', `claim ${c.claimId?.slice(0, 12)} 的 derivedFromHash 与锚点不符（锚点被动过）`)
      }
    }
    if (c.claimId && c.personaId && c.kind && c.claimGroupId && c.derivedFromHash) {
      const expectId = claimIdOf({
        personaId: c.personaId, kind: c.kind, claimGroupId: c.claimGroupId,
        derivedFromHash: c.derivedFromHash, revision: c.revision,
      })
      if (expectId !== c.claimId) {
        add('warning', 'CLAIM_ID_MISMATCH', `claim ${c.claimId?.slice(0, 12)} 的 claimId 与字段重算结果不一致（可能被手改）`)
      }
    }
    if (c.status === 'draft') continue
    for (const a of c.derivedFrom || []) {
      const chunk = chunksById.get(a.chunkId)
      if (!chunk) {
        orphan += 1
        if (orphan <= 20) add('error', 'ANCHOR_ORPHAN', `claim ${c.claimId?.slice(0, 12)} 的 chunkId 在根藏不存在`, { chunkId: a.chunkId })
        continue
      }
      if (chunk.personaId && chunk.personaId !== personaId) {
        crossPersona += 1
        add('error', 'CROSS_PERSONA', `claim ${c.claimId?.slice(0, 12)} 锚点块属于 ${chunk.personaId}`)
      }
      if (typeof a.quote !== 'string' || !a.quote) {
        quoteBad += 1
        add('error', 'QUOTE_MISSING', `claim ${c.claimId?.slice(0, 12)} 锚点缺少 quote`)
      } else if (a.quote.length < MIN_QUOTE_CHARS || a.quote.length > MAX_QUOTE_CHARS) {
        quoteBad += 1
        add('error', 'QUOTE_LENGTH', `claim ${c.claimId?.slice(0, 12)} 的 quote 长度 ${a.quote.length} 越界（${MIN_QUOTE_CHARS}-${MAX_QUOTE_CHARS}）`)
      } else if (typeof chunk.text !== 'string' || !chunk.text.includes(a.quote)) {
        quoteBad += 1
        if (quoteBad <= 20) {
          add('error', 'QUOTE_NOT_FOUND', `claim ${c.claimId?.slice(0, 12)} 的 quote 不是原文逐字子串（锚点失效）`, {
            chunkId: a.chunkId, quoteHead: a.quote.slice(0, 60),
          })
        }
      }
    }
  }

  checks.push({
    name: 'anchors',
    ok: orphan === 0 && quoteBad === 0,
    orphan,
    quoteBad,
    crossPersona,
    claimsWithAnchors: [...claims.byId.values()].filter((c) => (c.derivedFrom || []).length).length,
  })

  // ── speakers（P1.5）：缺失只告警（老数据），非法/inference 不归 unknown 才算错 ──
  let speakerMissing = 0
  let speakerInvalid = 0
  let speakerInference = 0
  const speakerByValue = { user: 0, assistant: 0, unknown: 0 }
  for (const c of claims.byId.values()) {
    if (typeof c.speaker !== 'string' || !c.speaker) { speakerMissing += 1; continue }
    if (!SPEAKERS.includes(c.speaker)) {
      speakerInvalid += 1
      if (speakerInvalid <= 20) add('error', 'CLAIM_SPEAKER_INVALID', `claim ${c.claimId?.slice(0, 12)} 的 speaker 非法：${c.speaker}`)
      continue
    }
    speakerByValue[c.speaker] += 1
    if (c.epistemic === 'inference' && c.speaker !== 'unknown') {
      speakerInference += 1
      if (speakerInference <= 20) add('error', 'CLAIM_SPEAKER_INFERENCE', `claim ${c.claimId?.slice(0, 12)} 是 inference，但 speaker=${c.speaker}（必须是 unknown）`)
    }
  }
  if (speakerMissing) {
    add('warning', 'SPEAKER_MISSING', `${speakerMissing} 条 claim 还没有 speaker（老数据；可跑 tools/backfill-claim-speaker.mjs --apply 回填）`)
  }
  checks.push({
    name: 'speakers',
    ok: speakerInvalid === 0 && speakerInference === 0,
    missing: speakerMissing,
    invalid: speakerInvalid,
    inferenceBad: speakerInference,
    byValue: speakerByValue,
  })

  // 计数一致性
  const manifestRes = await readManifest(dataRoot, personaId)
  const actual = { claims: claims.byId.size, groups: claims.byGroup.size }
  if (manifestRes.ok && manifestRes.exists) {
    const mc = manifestRes.manifest.counts || {}
    if (Number(mc.claims) !== actual.claims) {
      add('warning', 'COUNT_MISMATCH', `manifest.counts.claims=${mc.claims} 与实际 ${actual.claims} 不一致（rebuild/run 会重算）`)
    }
  } else {
    add('warning', 'MANIFEST_MISSING', 'manifest.json 不存在（还没跑过 run/rebuild）')
  }

  // topic_docs
  const docs = await listTopicDocs(dataRoot, personaId)
  let docBad = 0
  for (const file of docs) {
    let text = ''
    try { text = await readFile(file, 'utf8') } catch (e) {
      add('warning', 'DOC_UNREADABLE', `topic doc 读不出：${file}（${e.code || e.message}）`)
      continue
    }
    const fm = parseFrontMatter(text)
    if (!fm.ok) {
      docBad += 1
      add('warning', 'DOC_NO_FRONTMATTER', `topic doc 缺 front-matter：${file}`)
      continue
    }
    // front-matter 完整性：必需字段齐全 + topicId 与文件名对得上
    // （正文里的 `---` 是合法分隔线，不能拿分隔符数量当判据）
    for (const key of ['topicId', 'title', 'claimIds', 'derivedFromHash']) {
      if (fm.data[key] === undefined || fm.data[key] === '' || (Array.isArray(fm.data[key]) && fm.data[key].length === 0)) {
        docBad += 1
        add('error', 'DOC_FRONTMATTER_MISSING', `topic doc 缺少必需字段 ${key}`, { file })
      }
    }
    const fileBase = file.split(/[\\/]/).pop().replace(/\.md$/, '')
    const expectId = String(fm.data.topicId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
    if (expectId && expectId !== fileBase) {
      docBad += 1
      add('error', 'DOC_TOPIC_MISMATCH', `topic doc 的 topicId（${fm.data.topicId}）与文件名（${fileBase}）不一致`, { file })
    }
    if (String(fm.data.derivedFromHash || '').length !== 64) {
      docBad += 1
      add('warning', 'DOC_HASH_INVALID', `topic doc 的 derivedFromHash 不是 64 位 sha256`, { file })
    }
    const ids = Array.isArray(fm.data.claimIds) ? fm.data.claimIds : []
    for (const id of ids) {
      if (!claims.byId.has(id)) {
        docBad += 1
        add('error', 'DOC_DANGLING_CLAIM', `topic doc 引用了不存在的 claim：${id}`, { file })
      }
    }
  }
  checks.push({ name: 'topicDocs', ok: docBad === 0, docs: docs.length, dangling: docBad })

  // 有效状态统计
  const eff = { active: 0, superseded: 0, conflicted: 0, expired: 0, archived: 0, draft: 0 }
  for (const c of claims.byId.values()) {
    const s = effectiveStatus(c, claims.byGroup.get(c.claimGroupId) || [], claims.supersededIds, claims.supersededGroups)
    if (eff[s] !== undefined) eff[s] += 1
  }

  const result = {
    ok: problems.length === 0,
    personaId,
    checks,
    problems,
    warnings,
    summary: {
      claims: claims.byId.size,
      groups: claims.byGroup.size,
      anchors: checks.find((c) => c.name === 'anchors'),
      speakers: checks.find((c) => c.name === 'speakers'),
      manifestCounts: manifestRes.ok ? manifestRes.manifest.counts : null,
      actual,
      effective: eff,
      topicDocs: docs.length,
      repairRequested: Boolean(repair),
    },
  }

  if (repair) {
    result.repair = {
      ok: false,
      note: 'v1a 只报不修（计划 §6.1）；不带数据的修复（重算计数/清孤儿 tmp）在 tools 里单独跑',
    }
  }
  return result
}
