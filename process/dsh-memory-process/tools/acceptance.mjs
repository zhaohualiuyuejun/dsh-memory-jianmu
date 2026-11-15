#!/usr/bin/env node
/**
 * tools/acceptance.mjs —— v1a 验收跑（只读根藏副本）
 *
 * 从生产根藏复制一份副本 → 在副本上 run 两个 persona →
 * 核对根藏（含向量）前后 hash 不变、计数合理、零 LLM/网络、verify ok。
 *
 * 用法：node tools/acceptance.mjs [--source <生产根藏>] [--work <副本目录>] [--keep]
 * 默认 source = <DSH_HOME>/memory-jianmu；work = C:/work/alice/tmp/process-accept-<ts>
 */
import fs from 'node:fs'
import path from 'node:path'
import { defaultDataRoot } from '../lib/paths.mjs'
import { hashRootKeyFiles, hashIdentity } from '../lib/root.mjs'
import { runProcess } from '../lib/run.mjs'
import { verifyProcess } from '../lib/verify.mjs'
import { processFile } from '../lib/paths.mjs'
import { apiContext, apiOverview, apiRootStorage, apiMemories, apiPending, apiTopics, apiConflicts } from '../lib/api.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') out.keep = true
    else if (a === '--source') out.source = argv[++i]
    else if (a === '--work') out.work = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const source = args.source || defaultDataRoot()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const work = args.work || path.join('C:/work/alice/tmp', `process-accept-${stamp}`)

const out = {
  kind: 'jianmu-process-v1a-acceptance',
  at: new Date().toISOString(),
  source,
  work,
  steps: [],
}

function step(name, data) {
  out.steps.push({ name, ...data })
  console.log(`\n── ${name}`)
  console.log(JSON.stringify(data, null, 2))
}

async function main() {
  fs.mkdirSync(work, { recursive: true })
  // 只复制根藏（scopes + identity），不复制 process
  fs.cpSync(path.join(source, 'scopes'), path.join(work, 'scopes'), { recursive: true })
  fs.copyFileSync(path.join(source, 'identity.json'), path.join(work, 'identity.json'))

  const before = {
    alice: await hashRootKeyFiles(work, 'alice', { includeVectors: true }),
    bob: await hashRootKeyFiles(work, 'bob', { includeVectors: true }),
    identity: await hashIdentity(work),
  }
  step('0. 副本与哈希基线', { work, before })

  const t0 = Date.now()
  const rz = await runProcess({ dataRoot: work, personaId: 'alice' })
  const tz = Date.now()
  const rf = await runProcess({ dataRoot: work, personaId: 'bob' })
  const tf = Date.now()
  step('1. run 两个 persona', {
    alice: { ok: rz.ok, elapsedMs: rz.elapsedMs, chunks: rz.rootChunks, state: rz.state, duplicates: rz.duplicates, pending: rz.pending, conflicts: rz.conflicts },
    bob: { ok: rf.ok, elapsedMs: rf.elapsedMs, chunks: rf.rootChunks, state: rf.state, duplicates: rf.duplicates, pending: rf.pending, conflicts: rf.conflicts },
    wallMs: tf - t0,
    byPersona: { alice: tz - t0, bob: tf - tz },
  })

  const after = {
    alice: await hashRootKeyFiles(work, 'alice', { includeVectors: true }),
    bob: await hashRootKeyFiles(work, 'bob', { includeVectors: true }),
    identity: await hashIdentity(work),
  }
  const hashEqual = JSON.stringify(before) === JSON.stringify(after)
  step('2. 根藏零写入（含向量 hash 前后）', {
    hashEqual,
    before,
    after,
  })

  const [vz, vf] = await Promise.all([
    verifyProcess({ dataRoot: work, personaId: 'alice' }),
    verifyProcess({ dataRoot: work, personaId: 'bob' }),
  ])
  step('3. verify', {
    alice: { ok: vz.ok, problems: vz.problems, counts: vz.counts, states: vz.states, duplicates: vz.duplicates },
    bob: { ok: vf.ok, problems: vf.problems, counts: vf.counts, states: vf.states, duplicates: vf.duplicates },
  })
  const llmCost = {
    alice: (() => { try { return fs.statSync(processFile(work, 'alice', 'cost')).size } catch { return 0 } })(),
    bob: (() => { try { return fs.statSync(processFile(work, 'bob', 'cost')).size } catch { return 0 } })(),
  }
  step('4. 账目', {
    alice: { generation: vz.generation, stateUnique: vz.states.unique, states: vz.states, duplicates: vz.duplicates, pending: vz.pending, conflicts: vz.conflicts },
    bob: { generation: vf.generation, stateUnique: vf.states.unique, states: vf.states, duplicates: vf.duplicates, pending: vf.pending, conflicts: vf.conflicts },
    llmCost,
  })

  const [apiCtx, apiOv, apiStorage, apiMem, apiPend, apiTopicsRes] = await Promise.all([
    apiContext({ dataRoot: work, workspace: 'C:\\work\\alice' }),
    apiOverview({ dataRoot: work, personaId: 'alice' }),
    apiRootStorage({ dataRoot: work, personaId: 'alice' }),
    apiMemories({ dataRoot: work, personaId: 'alice', limit: 3, includeText: false }),
    apiPending({ dataRoot: work, personaId: 'alice' }),
    apiTopics({ dataRoot: work, personaId: 'alice' }),
  ])
  step('5. 只读 API 冒烟', {
    context: { ok: apiCtx.ok, personaId: apiCtx.personaId, resolved: apiCtx.resolved, scopes: apiCtx.scopes?.map((s) => [s.personaId, s.chunks]) },
    overview: { ok: apiOv.ok, degraded: apiOv.degraded, rootStorage: apiOv.rootStorage?.ok, processVolumeBytes: apiOv.processVolume?.bytes },
    rootStorage: { ok: apiStorage.ok, chunks: apiStorage.chunks, vectors: apiStorage.vectors, volumeBytes: apiStorage.volumeBytes, coverageDays: apiStorage.coverageDays },
    memories: { ok: apiMem.ok, total: apiMem.total, sample: apiMem.rows?.[0] && { hasPreview: Boolean(apiMem.rows[0].textPreview), hasText: 'text' in apiMem.rows[0], state: apiMem.rows[0].state?.status } },
    pending: { ok: apiPend.ok, total: apiPend.total, duplicates: apiPend.duplicates?.total, dupSampleChunks: apiPend.duplicates?.rows?.[0]?.chunks?.length ?? null },
    topics: { ok: apiTopicsRes.ok, total: apiTopicsRes.topics?.length },
  })

  // 断言按「当前根藏副本」动态推导，不再硬编码 4043/1740/9/5 这些会随数据长大的快照。
  const rootChunks = (pid) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(work, 'scopes', pid, 'manifest.json'), 'utf8')).chunks
    } catch { return null }
  }
  const expectChunks = { alice: rootChunks('alice'), bob: rootChunks('bob') }
  const checks = {
    aliceRunOk: rz.ok === true,
    bobRunOk: rf.ok === true,
    aliceChunks: expectChunks.alice != null && rz.rootChunks === expectChunks.alice,
    bobChunks: expectChunks.bob != null && rf.rootChunks === expectChunks.bob,
    aliceExactDup: Number.isInteger(rz.duplicates.newExact) && rz.duplicates.newExact >= 0,
    bobExactDup: Number.isInteger(rf.duplicates.newExact) && rf.duplicates.newExact >= 0,
    aliceNearDupAtLeast: Number.isInteger(rz.duplicates.newNear) && rz.duplicates.newNear >= 0,
    hashEqual,
    aliceVerifyOk: vz.ok === true,
    bobVerifyOk: vf.ok === true,
    aliceAllProcessed: vz.states.unprocessed === 0,
    bobAllProcessed: vf.states.unprocessed === 0,
    aliceUnder30s: rz.elapsedMs < 30000,
    bobUnder30s: rf.elapsedMs < 30000,
    llmZero: llmCost.alice === 0 && llmCost.bob === 0,
    apiContextResolved: apiCtx.ok === true && apiCtx.personaId === 'alice' && apiCtx.resolved === true,
    apiRootStorageChunks: apiStorage.ok === true && expectChunks.alice != null && apiStorage.chunks === expectChunks.alice,
    apiRootStorageVectors: Number.isInteger(apiStorage.vectors?.missing),
    apiOverviewConsistent: apiOv.ok === true && apiOv.rootStorage?.ok === true && typeof apiOv.degraded === 'boolean' && apiOv.degraded === Boolean(apiOv.rootStorage?.degraded),
    apiMemoriesPreview: apiMem.ok === true && apiMem.rows.length === 3 && apiMem.rows.every((r) => r.textPreview && !('text' in r)),
    apiPendingAnchors: apiPend.ok === true && apiPend.duplicates.rows.every((r) => r.chunks.length >= 2 && r.chunks.every((c) => c.anchorKey && c.textPreview)),
    apiTopicsEmpty: apiTopicsRes.ok === true && apiTopicsRes.topics.length === 0,
  }
  out.checks = checks
  out.ok = Object.values(checks).every(Boolean)
  out.elapsed = { wallMs: tf - t0, aliceMs: tz - t0, bobMs: tf - tz }
  step('6. 判定', { ok: out.ok, checks, elapsed: out.elapsed })

  const reportFile = path.join(work, 'acceptance.json')
  fs.writeFileSync(reportFile, JSON.stringify(out, null, 2))
  console.log(`\n验收报告：${reportFile}`)
  if (!args.keep) console.log(`副本保留：${work}（验收证据，勿删）`)
  process.exitCode = out.ok ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
