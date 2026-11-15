#!/usr/bin/env node
/**
 * tools/cli.mjs —— 年轮命令行（不经宿主；只读 + rebuild/export，不调模型）
 *
 * 用法：
 *   node tools/cli.mjs status   [--persona alice] [--deep]
 *   node tools/cli.mjs topics   [--persona alice] [--limit 20]
 *   node tools/cli.mjs claims   [--persona alice] [--kind boundary] [--status active] [--q 关键词]
 *   node tools/cli.mjs claim    --id <claimId>
 *   node tools/cli.mjs verify   [--persona alice]
 *   node tools/cli.mjs dryrun   [--persona alice] [--scope last:7d] [--batches 1]
 *   node tools/cli.mjs rebuild  [--persona alice] --confirm
 *   node tools/cli.mjs export   [--persona alice] [--out <file>]
 *
 * 说明：真跑（run）必须走宿主工具 jianmu_year_run（需要 ctx.llm + 用户确认）。
 */
import { defaultDataRoot, isSafePersonaId } from '../lib/paths.mjs'
import { readIdentity } from '../lib/root.mjs'
import { apiStatus, apiTopics, apiClaims, apiClaim } from '../lib/api.mjs'
import { verifyYear } from '../lib/verify.mjs'
import { rebuildTopicDocs } from '../lib/topicdocs.mjs'
import { exportYear } from '../lib/export.mjs'
import { runYear } from '../lib/extract.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'status'
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)

const dataRoot = flag('dataRoot', defaultDataRoot())
let personaId = flag('persona', null)
if (!personaId) {
  const id = await readIdentity(dataRoot)
  const list = id.ok ? Object.keys(id.identity.personas || {}) : []
  personaId = list.includes('alice') ? 'alice' : list[0] || null
}
if (!personaId || !isSafePersonaId(personaId)) {
  console.error('需要 --persona（合法 slug）')
  process.exit(2)
}

const out = (v) => console.log(JSON.stringify(v, null, 2))

switch (cmd) {
  case 'status': {
    out(await apiStatus({ dataRoot, personaId, deep: has('deep') }))
    break
  }
  case 'topics': {
    out(await apiTopics({
      dataRoot, personaId,
      limit: Number(flag('limit', 20)), offset: Number(flag('offset', 0)),
      kind: flag('kind'), status: flag('status'), epistemic: flag('epistemic'),
    }))
    break
  }
  case 'claims': {
    out(await apiClaims({
      dataRoot, personaId,
      limit: Number(flag('limit', 20)), offset: Number(flag('offset', 0)),
      kind: flag('kind'), status: flag('status'), epistemic: flag('epistemic'),
      topicId: flag('topic'), q: flag('q'), includeText: has('text'),
    }))
    break
  }
  case 'claim': {
    const id = flag('id')
    if (!id) { console.error('需要 --id <claimId>'); process.exit(2) }
    out(await apiClaim({ dataRoot, personaId, claimId: id, includeText: !has('notext') }))
    break
  }
  case 'verify': {
    const v = await verifyYear({ dataRoot, personaId })
    out(v)
    process.exit(v.ok ? 0 : 1)
    break
  }
  case 'dryrun': {
    out(await runYear({
      dataRoot, personaId, llmHost: null, dryRun: true,
      scope: flag('scope', 'all'),
      maxBatches: Number(flag('batches', 1)),
      budget: {
        maxInputChars: Number(flag('maxInputChars', 24000)),
        maxOutputTokens: Number(flag('maxOutputTokens', 8000)),
        timeoutMs: 90000, maxClaimsPerRun: 80,
      },
      pricing: { inputPerMTokens: 0.5, outputPerMTokens: 1.5 },
      config: { maxChunksPerRun: Number(flag('maxChunks', 400)) },
    }))
    break
  }
  case 'rebuild': {
    if (!has('confirm')) { console.error('rebuild 会重写 topic_docs：请加 --confirm'); process.exit(2) }
    out(await rebuildTopicDocs({ dataRoot, personaId, confirm: true }))
    break
  }
  case 'export': {
    out(await exportYear({ dataRoot, personaId, outFile: flag('out') }))
    break
  }
  default:
    console.error(`未知命令：${cmd}`)
    process.exit(2)
}
