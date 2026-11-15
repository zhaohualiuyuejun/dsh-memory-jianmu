#!/usr/bin/env node
/**
 * tools/selftest.mjs —— 熏习 v1a 自测（17 条守卫 + 15 条验收项）
 *
 * 全部在临时夹具上跑；不碰生产根藏。
 * 用法：node tools/selftest.mjs [--keep] [--real-root <根藏副本>]
 *   --keep      保留临时目录（排查用）
 *   --real-root 额外在真实根藏副本上跑 5k 规模验收
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { runProcess } from '../lib/run.mjs'
import { applyPending, restoreChunks, createManualPending, addConflict } from '../lib/apply.mjs'
import { verifyProcess, repairProcess } from '../lib/verify.mjs'
import { rebuildProcess } from '../lib/rebuild.mjs'
import { exportProcess } from '../lib/export.mjs'
import { overview, readStateMap, readPendingMap, readDuplicatesMap, readConflictsMap, readManifest } from '../lib/store.mjs'
import { readScope, listScopes, hashRootKeyFiles, hashIdentity } from '../lib/root.mjs'
import {
  apiContext, apiCapabilities, apiOverview, apiRootStorage, apiMemories, apiMemory,
  apiChunks, apiTopics, apiPending, apiConflicts, apiVerify, apiStatus,
} from '../lib/api.mjs'
import { checkToolSurface, scanSourceForInjection } from '../lib/guards.mjs'
import { EPISTEMIC_RANK, ALLOWED_TOOLS, RULE_VERSION } from '../lib/version.mjs'
import { acquireLock } from '../lib/lock.mjs'
import { processDir } from '../lib/paths.mjs'

const args = parseArgs(process.argv.slice(2))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const baseDir = path.join('C:/work/alice/tmp', `process-selftest-${stamp}`)
fs.mkdirSync(baseDir, { recursive: true })

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}
function section(title) { console.log(`\n── ${title}`) }
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') out.keep = true
    else if (a === '--real-root') { out.realRoot = argv[++i] }
  }
  return out
}

const hex = (s) => createHash('sha256').update(String(s)).digest('hex')
let seqCounter = 0
function mkChunk(opts) {
  const seq = opts.seq ?? ++seqCounter
  const session = opts.session ?? 'session-test-001'
  const text = String(opts.text)
  const id = opts.id ?? hex(`${session}|${seq}|${text}`)
  return {
    id,
    kind: 'utterance',
    schemaVersion: 1,
    contractVersion: 1,
    session,
    personaId: opts.personaId ?? 'alice',
    identitySource: 'manual',
    messageId: opts.messageId ?? `msg-${seq}`,
    seq,
    turn: null,
    part: 0,
    role: opts.role ?? 'user',
    sourceType: opts.role ?? 'user',
    t: opts.t ?? (Date.UTC(2026, 10, 1) + seq * 1000),
    tz: 'Asia/Shanghai',
    text,
    ws: opts.ws ?? 'C:\\work\\alice',
    wsDir: '--C-work-alice--',
    channel: opts.channel ?? 'dsh',
    attachments: [],
    sourceHash: opts.sourceHash ?? hex(`src|${session}|${seq}|${text}`),
    retention: opts.retention ?? 'active',
    ingestVersion: '0.1.0',
  }
}

function makeFixture(name, { chunks = [], unassigned = [], persona = 'alice', builtAt = '2026-11-07T05:00:00.000Z', generation = 1 } = {}) {
  const dir = path.join(baseDir, name)
  fs.mkdirSync(path.join(dir, 'scopes', persona), { recursive: true })
  const identity = {
    version: 1,
    defaultPersonaId: null,
    personas: { alice: { displayName: 'Alice' }, bob: { displayName: 'Bob' } },
    workspaces: { 'C:\\work\\alice': 'alice', 'C:\\work\\bob': 'bob' },
    sessions: {},
  }
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identity, null, 2))
  writeScope(dir, persona, chunks, { builtAt, generation })
  if (unassigned.length) {
    writeScope(dir, 'persona_unassigned', unassigned, { builtAt, generation })
  }
  return dir
}

function writeScope(dir, persona, chunks, { builtAt, generation = 1 } = {}) {
  const sdir = path.join(dir, 'scopes', persona)
  fs.mkdirSync(sdir, { recursive: true })
  fs.writeFileSync(path.join(sdir, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length ? '\n' : ''))
  const manifest = {
    schemaVersion: 1,
    contractVersion: 1,
    generation,
    personaId: persona,
    displayName: persona,
    identitySource: 'manual',
    provider: 'cloud',
    model: 'test-embedding',
    dim: 8,
    normalizerVersion: 'l2-v1',
    tokenizerVersion: null,
    embeddingMeta: {},
    chunks: chunks.length,
    sessions: new Set(chunks.map((c) => c.session)).size,
    workspaces: new Set(chunks.map((c) => c.ws)).size,
    tMin: chunks.length ? Math.min(...chunks.map((c) => c.t)) : null,
    tMax: chunks.length ? Math.max(...chunks.map((c) => c.t)) : null,
    retentionDays: 30,
    builtAt,
    writer: { name: 'dsh-memory-store', version: '0.1.0' },
  }
  fs.writeFileSync(path.join(sdir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function bumpRoot(dir, persona, { builtAt = new Date().toISOString(), generation = null } = {}) {
  const mf = path.join(dir, 'scopes', persona, 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  const chunks = readChunks(dir, persona)
  m.builtAt = builtAt
  m.chunks = chunks.length
  m.generation = generation ?? (m.generation + 1)
  m.tMin = chunks.length ? Math.min(...chunks.map((c) => c.t)) : null
  m.tMax = chunks.length ? Math.max(...chunks.map((c) => c.t)) : null
  fs.writeFileSync(mf, JSON.stringify(m, null, 2))
}

function appendChunk(dir, persona, chunk) {
  fs.appendFileSync(path.join(dir, 'scopes', persona, 'chunks.jsonl'), JSON.stringify(chunk) + '\n')
}

function readChunks(dir, persona) {
  const f = path.join(dir, 'scopes', persona, 'chunks.jsonl')
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function stateMap(dir, persona) {
  return (await readStateMap(dir, persona)).map
}
async function pendingList(dir, persona) {
  return [...(await readPendingMap(dir, persona)).map.values()]
}
async function dupList(dir, persona) {
  return [...(await readDuplicatesMap(dir, persona)).map.values()]
}
async function conflictList(dir, persona) {
  return [...(await readConflictsMap(dir, persona)).map.values()]
}
function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}
function dirFiles(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...dirFiles(p))
    else out.push(p)
  }
  return out
}

const rootHash = async (dir, persona) => hashRootKeyFiles(dir, persona, { includeVectors: true })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ============================================================================
async function testDedupeAndRules() {
  section('A. 重复检测 + 分类 + 根藏零写入')
  const exactText = '重复的同一句话：测试精确去重。'
  const thirdText = '朋友说这个 LoRA 效果很好。'
  const assistantText = '我觉得这个方案可行，应该是没问题的。'
  const hypoText = '也许明天会下雨吧。'
  const sensText = '我的银行卡密码是 123456。'
  const boundText = '这个月工资到账了。'
  const expiredText = '这条记忆的保留期已经结束了。'
  const longText = '这是一段很长的审查报告。'.repeat(30) + '建议改成 append。'
  const unpairedText = '把模型改成 V5 吧。'
  const archiveText = '这条旧记忆可以归档。'
  const nearBase = '这是一段用于近重复测试的长文本，内容覆盖画风、训练、记忆库、检索与界面设计的讨论。'.repeat(4) + '结论稳定。'
  // 首字替换：3-gram Jaccard ≈0.979 且 SimHash Hamming=1（满足合同 ≤3）
  const nearText2 = '，' + nearBase.slice(1)
  const chunks = [
    mkChunk({ text: exactText, session: 's-exact', seq: 1 }),
    mkChunk({ text: exactText, session: 's-exact', seq: 2 }),
    mkChunk({ text: nearBase, session: 's-near', seq: 3 }),
    mkChunk({ text: nearText2, session: 's-near', seq: 4 }),
    mkChunk({ text: thirdText, session: 's-third', seq: 5 }),
    mkChunk({ text: assistantText, role: 'assistant', session: 's-assist', seq: 6 }),
    mkChunk({ text: hypoText, session: 's-hypo', seq: 7 }),
    mkChunk({ text: sensText, session: 's-sens', seq: 8 }),
    mkChunk({ text: boundText, session: 's-bound', seq: 9 }),
    mkChunk({ text: expiredText, retention: 'expired', session: 's-exp', seq: 10 }),
    mkChunk({ text: longText, role: 'assistant', session: 's-long', seq: 11 }),
    mkChunk({ text: unpairedText, session: 's-unpaired', seq: 12 }),
    mkChunk({ text: archiveText, session: 's-archive', seq: 13 }),
  ]
  const dir = makeFixture('A', { chunks })
  const before = { root: await rootHash(dir, 'alice'), identity: await hashIdentity(dir) }

  const run = await runProcess({ dataRoot: dir, personaId: 'alice' })
  check('A1 run ok', run.ok === true, run)
  check('A2 精确重复进 duplicates（不自动合并）', run.duplicates.newExact === 1 && run.duplicates.newNear >= 1, run.duplicates)
  const dups = await dupList(dir, 'alice')
  const exact = dups.find((d) => d.method === 'exact')
  check('A3 精确组保留全部成员 evidenceCount/mergedFrom', exact && exact.evidenceCount === 2 && exact.mergedFrom.length === 2 && exact.status === 'pending', exact)
  const near = dups.find((d) => d.method === 'simhash+3gram')
  check('A4 SimHash 近重复成组', Boolean(near) && near.chunkIds.length >= 2, near)
  const st = await stateMap(dir, 'alice')
  const dupMemberIds = new Set(dups.flatMap((d) => d.chunkIds))
  check('A5 重复只出候选，成员都仍 active', dupMemberIds.size === 4 && [...dupMemberIds].every((id) => st.get(id)?.status === 'active'), { members: dupMemberIds.size })

  const byText = (t) => [...st.values()].find((s) => chunks.find((c) => c.id === s.chunkId)?.text === t)
  check('A6 第三方转述 epistemic=quote + attribution=third-party', byText(thirdText)?.epistemic === 'quote' && byText(thirdText)?.attribution === 'third-party', byText(thirdText))
  check('A7 助手自述不升级为 fact', byText(assistantText)?.epistemic === 'inference' && byText(assistantText)?.attribution === 'assistant', byText(assistantText))
  check('A8 假设标 hypothesis', byText(hypoText)?.epistemic === 'hypothesis', byText(hypoText))
  check('A9 敏感/边界标注', byText(sensText)?.sensitivity === 'sensitive' && byText(boundText)?.sensitivity === 'boundary', { sens: byText(sensText)?.sensitivity, bound: byText(boundText)?.sensitivity })
  check('A10 根藏 retention=expired 镜像成 expired（不删原文）', byText(expiredText)?.status === 'expired' && byText(expiredText)?.validTo != null, byText(expiredText))
  check('A11 长文里的「建议改成」不产生取代候选', (await pendingList(dir, 'alice')).length === 0, await pendingList(dir, 'alice'))
  check('A12 无对照目标的改口只计数、不刷 conflict', (await conflictList(dir, 'alice')).length === 0 && run.pending.unpairedCorrections >= 1, { conflicts: (await conflictList(dir, 'alice')).length, unpaired: run.pending.unpairedCorrections })

  const after = { root: await rootHash(dir, 'alice'), identity: await hashIdentity(dir) }
  check('A13 run 后根藏零写入（hash 前后不变）', same(before, after), { before, after })
  check('A14 默认零 LLM（cost.jsonl 为空/不存在）', countLines(path.join(dir, 'process', 'alice', 'cost.jsonl')) === 0)
  check('A15 未处理/已处理默认 active 可见', [...st.values()].filter((s) => s.status === 'expired').length === 1 && [...st.values()].filter((s) => s.status === 'active').length === chunks.length - 1, { expired: [...st.values()].filter((s) => s.status === 'expired').length })

  // verify 与只读 API
  const v = await verifyProcess({ dataRoot: dir, personaId: 'alice' })
  check('A16 verify ok / 计数一致', v.ok === true && Object.keys(v.counts.diff).length === 0, v.problems)
  const api = await apiOverview({ dataRoot: dir, personaId: 'alice' })
  check('A17 只读 API overview 计数与状态一致', api.ok && api.states.effective.active + api.states.effective.expired === chunks.length, api.states)
  const mem = await apiMemories({ dataRoot: dir, personaId: 'alice', limit: 5 })
  check('A18 只读 API memories 返回当前 scope', mem.ok && mem.total === chunks.length && mem.rows.every((r) => r.chunkId), { total: mem.total })
  const hashBeforeApi = await rootHash(dir, 'alice')
  const processFiles = dirFiles(path.join(dir, 'process', 'alice')).map((f) => [f, fs.statSync(f).mtimeMs])
  await apiMemories({ dataRoot: dir, personaId: 'alice', limit: 50 })
  const hashAfterApi = await rootHash(dir, 'alice')
  const processFiles2 = dirFiles(path.join(dir, 'process', 'alice')).map((f) => [f, fs.statSync(f).mtimeMs])
  check('A19 只读 API 不写文件', same(hashBeforeApi, hashAfterApi) && same(processFiles, processFiles2))
  return dir
}

async function testApplyRestore(dir) {
  section('B. 改口/取代 + apply + restore + 幂等')
  const oldText = '用户现在用的模型是 DeepSeek V3。'
  const newText = '用户现在用的模型改成 DeepSeek V4 了。'
  const oldC = mkChunk({ text: oldText, session: 's-corr', seq: 1, t: Date.UTC(2026, 10, 1) })
  const newC = mkChunk({ text: newText, session: 's-corr', seq: 2, t: Date.UTC(2026, 10, 1) + 1000 })
  const dir2 = makeFixture('B', { chunks: [oldC, newC, mkChunk({ text: '一条无关的日志。', session: 's-other', seq: 3 })] })
  const before = await rootHash(dir2, 'alice')
  const run = await runProcess({ dataRoot: dir2, personaId: 'alice' })
  check('B1 改口线索生成 supersede 候选（不自动应用）', run.pending.new === 1, run.pending)
  const pend = await pendingList(dir2, 'alice')
  const p = pend.find((x) => x.kind === 'supersede')
  check('B2 候选指向正确旧条 + confidence ≥ 0.6', p && p.proposed.chunkId === oldC.id && p.proposed.supersededBy === newC.id && p.confidence >= 0.6, p)
  const stBefore = await stateMap(dir2, 'alice')
  check('B3 应用前旧条仍 active', stBefore.get(oldC.id)?.status === 'active')
  const man = (await readManifest(dir2, 'alice')).manifest
  const ap = await applyPending({ dataRoot: dir2, personaId: 'alice', pendingIds: [p.pendingId], expectedGeneration: man.generation, confirm: true })
  check('B4 apply 成功', ap.ok === true, ap)
  const stAfter = await stateMap(dir2, 'alice')
  const oldState = stAfter.get(oldC.id)
  check('B5 旧条 superseded + validTo + supersededBy', oldState?.status === 'superseded' && oldState?.validTo === newC.t && oldState?.supersededBy === newC.id, oldState)
  check('B6 旧条原文仍在根藏', readChunks(dir2, 'alice').some((c) => c.id === oldC.id))
  const stateRecordsAfter1 = countLines(path.join(dir2, 'process', 'alice', 'state.jsonl'))
  const ap2 = await applyPending({ dataRoot: dir2, personaId: 'alice', pendingIds: [p.pendingId], expectedGeneration: man.generation, confirm: true, applyId: ap.applyId })
  const stateRecordsAfter2 = countLines(path.join(dir2, 'process', 'alice', 'state.jsonl'))
  check('B7 同一 applyId 幂等（不重复写 state）', ap2.ok === true && ap2.alreadyApplied === true && stateRecordsAfter1 === stateRecordsAfter2, { ap2, stateRecordsAfter1, stateRecordsAfter2 })
  check('B8 apply 后根藏零写入', same(before, await rootHash(dir2, 'alice')))
  const r = await restoreChunks({ dataRoot: dir2, personaId: 'alice', chunkIds: [oldC.id] })
  check('B9 restore 能回 active（旧记录保留）', r.ok === true && (await stateMap(dir2, 'alice')).get(oldC.id)?.status === 'active', r)
  check('B10 state 是追加日志，旧记录未删', countLines(path.join(dir2, 'process', 'alice', 'state.jsonl')) > stateRecordsAfter2)

  // 归档 + 过期
  const other = readChunks(dir2, 'alice').find((c) => c.session === 's-other')
  const arch = await createManualPending({ dataRoot: dir2, personaId: 'alice', kind: 'archive', chunkIds: [other.id] })
  check('B11 归档只进 pending', arch.ok === true && (await stateMap(dir2, 'alice')).get(other.id)?.status === 'active', arch)
  const man2 = (await readManifest(dir2, 'alice')).manifest
  const apArch = await applyPending({ dataRoot: dir2, personaId: 'alice', pendingIds: [arch.pendingId], expectedGeneration: man2.generation, confirm: true })
  check('B12 归档 apply 后 archived', apArch.ok === true && (await stateMap(dir2, 'alice')).get(other.id)?.status === 'archived', apArch)
  const rArch = await restoreChunks({ dataRoot: dir2, personaId: 'alice', chunkIds: [other.id] })
  check('B13 归档可 restore', rArch.ok === true && (await stateMap(dir2, 'alice')).get(other.id)?.status === 'active')
  const exp = await createManualPending({ dataRoot: dir2, personaId: 'alice', kind: 'expire', chunkIds: [other.id] })
  const man3 = (await readManifest(dir2, 'alice')).manifest
  const apExp = await applyPending({ dataRoot: dir2, personaId: 'alice', pendingIds: [exp.pendingId], expectedGeneration: man3.generation, confirm: true })
  check('B14 过期 apply 后 expired + 原文仍在', apExp.ok === true && (await stateMap(dir2, 'alice')).get(other.id)?.status === 'expired' && readChunks(dir2, 'alice').some((c) => c.id === other.id), apExp)
  const rExp = await restoreChunks({ dataRoot: dir2, personaId: 'alice', chunkIds: [other.id] })
  check('B15 过期可 restore', rExp.ok === true && (await stateMap(dir2, 'alice')).get(other.id)?.status === 'active')
  return dir2
}

async function testConflict() {
  section('C. 未解释矛盾：两条都 active，不自动裁决')
  const d1 = mkChunk({ text: '训练只在工作日周一到周五上午开。', session: 's-conf', seq: 1 })
  const d2 = mkChunk({ text: '训练其实每天都可以开，包括周末。', session: 's-conf', seq: 2 })
  const d3 = mkChunk({ text: '另一条无关记录。', session: 's-conf', seq: 3 })
  const dir = makeFixture('C', { chunks: [d1, d2, d3] })
  await runProcess({ dataRoot: dir, personaId: 'alice' })
  const c = await addConflict({ dataRoot: dir, personaId: 'alice', chunkIds: [d1.id, d2.id], kind: 'unexplained-contradiction' })
  check('C1 conflict 创建 open', c.ok === true && c.status === 'open', c)
  const st = await stateMap(dir, 'alice')
  check('C2 两条都保持 active', st.get(d1.id)?.status === 'active' && st.get(d2.id)?.status === 'active', { d1: st.get(d1.id)?.status, d2: st.get(d2.id)?.status })
  check('C3 两条都挂 conflictGroup', st.get(d1.id)?.conflictGroup === c.conflictId && st.get(d2.id)?.conflictGroup === c.conflictId)
  check('C4 不自动选新、不自动 apply', (await pendingList(dir, 'alice')).length === 0, await pendingList(dir, 'alice'))
  const c2 = await addConflict({ dataRoot: dir, personaId: 'alice', chunkIds: [d1.id, d2.id], kind: 'unexplained-contradiction' })
  check('C5 同一冲突幂等', c2.ok === true && c2.alreadyExists === true && c2.conflictId === c.conflictId, c2)
  return dir
}

async function testResumeAndFailure() {
  section('D. 断点续跑 / 失败不隐藏 / 增量')
  const chunks = Array.from({ length: 6 }, (_, i) => mkChunk({ text: `续跑测试第 ${i + 1} 条。`, session: 's-resume', seq: i + 1 }))
  const dir = makeFixture('D1', { chunks })
  const r1 = await runProcess({ dataRoot: dir, personaId: 'alice', maxChunks: 2 })
  check('D1 第一次只处理 2 条', r1.ok && r1.batch.start === 0 && r1.batch.count === 2 && r1.batch.complete === false, r1.batch)
  const man1 = (await readManifest(dir, 'alice')).manifest
  check('D2 checkpoint nextIndex=2', man1.lastRunCheckpoint?.nextIndex === 2 && man1.lastRunCheckpoint?.complete === false, man1.lastRunCheckpoint)
  const r2 = await runProcess({ dataRoot: dir, personaId: 'alice', maxChunks: 2 })
  check('D3 第二次从 2 续跑', r2.ok && r2.batch.start === 2 && r2.batch.count === 2, r2.batch)
  const r3 = await runProcess({ dataRoot: dir, personaId: 'alice', maxChunks: 2 })
  check('D4 第三次处理完尾部', r3.ok && r3.batch.complete === true && (await stateMap(dir, 'alice')).size === 6, r3.batch)
  const r4 = await runProcess({ dataRoot: dir, personaId: 'alice' })
  check('D5 同 rootBuiltAt 完成后不重复跑', r4.ok && r4.skipped === true, r4)
  const newChunk = mkChunk({ text: '增量新增的第 7 条。', session: 's-resume', seq: 7 })
  appendChunk(dir, 'alice', newChunk)
  bumpRoot(dir, 'alice', { builtAt: '2026-11-07T06:00:00.000Z' })
  const r5 = await runProcess({ dataRoot: dir, personaId: 'alice' })
  const st5 = await stateMap(dir, 'alice')
  check('D6 根藏新增后增量：旧 state 不丢、新块被处理', r5.ok && st5.size === 7 && st5.has(newChunk.id) && st5.has(chunks[0].id), { size: st5.size, newHas: st5.has(newChunk.id) })

  // 失败钩子
  const chunks2 = Array.from({ length: 5 }, (_, i) => mkChunk({ text: `失败测试第 ${i + 1} 条。`, session: 's-fail', seq: i + 1 }))
  const dir2 = makeFixture('D2', { chunks: chunks2 })
  const rf = await runProcess({ dataRoot: dir2, personaId: 'alice', failAfter: 2 })
  check('D7 模拟失败返回 ok=false + code', rf.ok === false && rf.code === 'RUN_FAILED', rf)
  const ov = await overview(dir2, 'alice', { chunks: readChunks(dir2, 'alice') })
  check('D8 失败后未处理块仍 active 可见', ov.states.effective.active === 5 && ov.states.unprocessed === 3, ov.states)
  const man2 = (await readManifest(dir2, 'alice')).manifest
  check('D9 失败写 lastError，checkpoint 不推进', man2.lastError?.code === 'RUN_FAILED' && (man2.lastRunCheckpoint == null || man2.lastRunCheckpoint.complete !== true), man2.lastError)
  const rOk = await runProcess({ dataRoot: dir2, personaId: 'alice' })
  check('D10 失败后可重跑至成功', rOk.ok === true && (await stateMap(dir2, 'alice')).size === 5, rOk)
  return dir
}

async function testStaleApply() {
  section('E. 根藏代际变化后旧 apply 被拒')
  const oldC = mkChunk({ text: '用户现在用的模型是 DeepSeek V3。', session: 's-stale', seq: 1, t: Date.UTC(2026, 10, 1) })
  const newC = mkChunk({ text: '用户现在用的模型改成 DeepSeek V4 了。', session: 's-stale', seq: 2, t: Date.UTC(2026, 10, 1) + 1000 })
  const dir = makeFixture('E', { chunks: [oldC, newC] })
  await runProcess({ dataRoot: dir, personaId: 'alice' })
  const p = (await pendingList(dir, 'alice')).find((x) => x.kind === 'supersede')
  const man = (await readManifest(dir, 'alice')).manifest
  bumpRoot(dir, 'alice', { builtAt: '2026-11-07T07:00:00.000Z', generation: 2 })
  const ap = await applyPending({ dataRoot: dir, personaId: 'alice', pendingIds: [p.pendingId], expectedGeneration: man.generation, confirm: true })
  check('E1 根藏 generation 变化后 apply 被拒（STALE_ROOT）', ap.ok === false && ap.code === 'STALE_ROOT', ap)
  check('E2 被拒后旧条仍 active（旧任务未写入）', (await stateMap(dir, 'alice')).get(oldC.id)?.status === 'active')
  return dir
}

async function testVerifyRepair() {
  section('F. verify 报孤儿/stale/计数不一致；repair 不删数据')
  const chunks = [mkChunk({ text: '校验测试第一条。', session: 's-verify', seq: 1 }), mkChunk({ text: '校验测试第二条。', session: 's-verify', seq: 2 }), mkChunk({ text: '校验测试第三条。', session: 's-verify', seq: 3 })]
  const dir = makeFixture('F', { chunks })
  await runProcess({ dataRoot: dir, personaId: 'alice' })
  const stateRecordsBefore = countLines(path.join(dir, 'process', 'alice', 'state.jsonl'))

  // 删掉第三条（只改副本）→ 孤儿
  const remaining = readChunks(dir, 'alice').filter((c) => c.id !== chunks[2].id)
  fs.writeFileSync(path.join(dir, 'scopes', 'alice', 'chunks.jsonl'), remaining.map((c) => JSON.stringify(c)).join('\n') + '\n')
  // 改第一条 sourceHash → stale
  const withNewHash = remaining.map((c) => c.id === chunks[0].id ? { ...c, sourceHash: 'changed-source-hash' } : c)
  fs.writeFileSync(path.join(dir, 'scopes', 'alice', 'chunks.jsonl'), withNewHash.map((c) => JSON.stringify(c)).join('\n') + '\n')
  // 篡改 manifest counts
  const mf = path.join(dir, 'scopes', 'alice', 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.counts = { states: 999 }; m.chunks = 2; fs.writeFileSync(mf, JSON.stringify(m, null, 2))
  bumpRoot(dir, 'alice', { builtAt: '2026-11-07T08:00:00.000Z' })

  const v = await verifyProcess({ dataRoot: dir, personaId: 'alice' })
  const codes = new Set(v.problems.map((p) => p.code))
  check('F1 verify 报孤儿', codes.has('ORPHAN_STATE'), v.problems)
  check('F2 verify 报 stale', codes.has('STALE_STATE'), v.problems)
  check('F3 verify 报计数不一致', codes.has('COUNT_MISMATCH'), v.problems)
  const rep = await repairProcess({ dataRoot: dir, personaId: 'alice' })
  check('F4 repair 重算计数后不再报 COUNT_MISMATCH', !rep.stillProblems.some((p) => p.code === 'COUNT_MISMATCH'), rep)
  check('F5 repair 不删数据（state 行数不变）', countLines(path.join(dir, 'process', 'alice', 'state.jsonl')) === stateRecordsBefore, { before: stateRecordsBefore })
  check('F6 repair 后孤儿仍被报告（不静默清）', rep.stillProblems.some((p) => p.code === 'ORPHAN_STATE'), rep.stillProblems)
  return dir
}

async function testRebuild() {
  section('G. rebuild 同 ruleVersion 可复现，不调 LLM/不重嵌')
  const chunks = [
    mkChunk({ text: '重建测试：用户喜欢厚涂画风。', session: 's-rebuild', seq: 1 }),
    mkChunk({ text: '重建测试：训练只在工作日上午。', session: 's-rebuild', seq: 2 }),
    mkChunk({ text: '重建测试重复句。', session: 's-rebuild', seq: 3 }),
    mkChunk({ text: '重建测试重复句。', session: 's-rebuild', seq: 4 }),
    mkChunk({ text: '重建测试：朋友说 V5 不错。', session: 's-rebuild', seq: 5 }),
  ]
  const dir = makeFixture('G', { chunks })
  await runProcess({ dataRoot: dir, personaId: 'alice' })
  const proj = (st) => [...st.values()].map((s) => [s.chunkId, s.status, s.epistemic, s.attribution, s.sensitivity, s.ruleRef?.ruleVersion].join('|')).sort()
  const before = proj(await stateMap(dir, 'alice'))
  const rb = await rebuildProcess({ dataRoot: dir, personaId: 'alice', confirm: true })
  const after = proj(await stateMap(dir, 'alice'))
  check('G1 rebuild 成功', rb.ok === true, rb)
  check('G2 同 ruleVersion 状态可复现', same(before, after), { before: before.slice(0, 3), after: after.slice(0, 3) })
  check('G3 rebuild 不调 LLM、不重嵌', rb.llmCalls === 0 && rb.reembedCalls === 0, { llm: rb.llmCalls, reembed: rb.reembedCalls })
  check('G4 rebuild 前有快照', Boolean(rb.snapshot) && fs.existsSync(rb.snapshot), rb.snapshot)
  return dir
}

async function testPersonaIsolation() {
  section('H. 两 persona 交错 + persona_unassigned 不并入')
  const z1 = mkChunk({ text: 'Alice的第一条。', session: 's-z', seq: 1, personaId: 'alice' })
  const z2 = mkChunk({ text: 'Alice的第二条。', session: 's-z', seq: 2, personaId: 'alice' })
  const f1 = mkChunk({ text: 'Bob的第一条。', session: 's-f', seq: 3, personaId: 'bob', ws: 'C:\\work\\bob' })
  const f2 = mkChunk({ text: 'Bob的第二条。', session: 's-f', seq: 4, personaId: 'bob', ws: 'C:\\work\\bob' })
  const u1 = mkChunk({ text: '未归属的一条。', session: 's-u', seq: 5, personaId: 'persona_unassigned' })
  const dir = makeFixture('H', { chunks: [z1, z2] })
  writeScope(dir, 'bob', [f1, f2], { builtAt: '2026-11-07T05:00:00.000Z' })
  writeScope(dir, 'persona_unassigned', [u1], { builtAt: '2026-11-07T05:00:00.000Z' })
  const unassignedBefore = await rootHash(dir, 'persona_unassigned')

  await runProcess({ dataRoot: dir, personaId: 'alice' })
  await runProcess({ dataRoot: dir, personaId: 'bob' })
  await runProcess({ dataRoot: dir, personaId: 'alice' })
  const sz = await stateMap(dir, 'alice')
  const sf = await stateMap(dir, 'bob')
  check('H1 alice state 只含自己的块', [...sz.keys()].every((id) => id === z1.id || id === z2.id) && [...sz.values()].every((s) => s.scope === 'alice'), { z: sz.size })
  check('H2 bob state 只含自己的块', [...sf.keys()].every((id) => id === f1.id || id === f2.id) && [...sf.values()].every((s) => s.scope === 'bob'), { f: sf.size })
  check('H3 交错跑不串味（两 scope 无交集）', [...sz.keys()].every((id) => !sf.has(id)))
  check('H4 persona_unassigned 不被自动处理/并入', !fs.existsSync(path.join(dir, 'process', 'persona_unassigned')) && same(unassignedBefore, await rootHash(dir, 'persona_unassigned')))
  const scopes = await listScopes(dir)
  check('H5 根藏 scopes 列出 persona_unassigned（可见不合并）', scopes.includes('persona_unassigned'), scopes)
  return dir
}

async function testGuards(dir) {
  section('I. 守卫（工具面 / 注入 / 正文 / 锁 / 生成 / 5k 性能）')
  const idx = await import(pathToFileURL(path.resolve('index.js')).href)
  // 用 mock ctx 真正调用 apply()，收集「实际注册」的工具名；不再拿常量比常量
  const registered = []
  const mockCtx = {
    tools: { register: (def) => { registered.push(def.name); return () => {} } },
    logger: { info: () => {} },
    settings: { describe: () => [] },
    get: () => undefined,
    provide: () => () => {},
  }
  const dispose = idx.apply(mockCtx, { enabled: true, processEnabled: true, dataRoot: dir })
  const surface = checkToolSurface(registered)
  check('I1 实际注册工具面恰好 9 件且不含 recall/search/query', surface.ok, surface.problems)
  check('I2 实际注册名与 ALLOWED_TOOLS 一致', same([...registered].sort(), [...ALLOWED_TOOLS].sort()), { registered })
  const extraSurface = checkToolSurface([...registered, 'jianmu_process_extra'])
  const forbiddenSurface = checkToolSurface([...registered.slice(1), 'jianmu_process_search'])
  check('I2b 多注册一个工具 / 注册检索词工具都会红', !extraSurface.ok && !forbiddenSurface.ok, { extra: extraSurface.problems, forbidden: forbiddenSurface.problems })
  try { dispose() } catch { /* 忽略 */ }

  // host 暴露：只读 service + GET 路由（用 mock webServer 捕获注册）
  let capturedRoute = null
  const capturedServices = []
  const mockCtx2 = {
    tools: { register: () => () => {} },
    logger: { info: () => {} },
    settings: { describe: () => [] },
    get: (n) => (n === 'webServer' ? { register: (route) => { capturedRoute = route; return () => {} } } : undefined),
    provide: (n, svc) => { capturedServices.push({ name: n, svc }); return () => {} },
  }
  const dispose2 = idx.apply(mockCtx2, { enabled: true, processEnabled: true, dataRoot: dir })
  check('I15 host 注册 prefix 只读路由 /api/memory-process', capturedRoute?.kind === 'prefix' && capturedRoute?.path === '/api/memory-process' && typeof capturedRoute?.handler === 'function', { kind: capturedRoute?.kind, path: capturedRoute?.path })
  const svcMain = capturedServices.find((s) => s.name === 'jianmuProcess')
  check('I16 host 提供只读 service（context/overview/pending）', svcMain && typeof svcMain.svc?.context === 'function' && typeof svcMain.svc?.overview === 'function' && typeof svcMain.svc?.pending === 'function', capturedServices.map((s) => s.name))
  // P2.5：冲突卡只读服务（镜台 conflictCard=true 时消费）
  const svcConf = capturedServices.find((s) => s.name === 'jianmuConflicts')
  check('I16b host 提供 jianmuConflicts.list（只读服务）', svcConf && typeof svcConf.svc?.list === 'function' && svcConf.svc?.version === 1, capturedServices.map((s) => s.name))
  try { dispose2() } catch { /* 忽略 */ }

  const srcFiles = dirFiles(path.resolve('lib')).concat([path.resolve('index.js'), path.resolve('tools/cli.mjs')])
  let injectionHits = []
  let claimsHits = []
  let decayHits = []
  let netHits = []
  for (const f of srcFiles) {
    const text = fs.readFileSync(f, 'utf8')
    injectionHits.push(...scanSourceForInjection(text).hits.map((h) => ({ file: path.basename(f), ...h })))
    if (/claims\.jsonl/.test(text)) claimsHits.push(f)
    if (/\bdecay\b|halfLife|时间衰减/i.test(text)) decayHits.push(f)
    if (/\bfetch\s*\(|https?:\/\//.test(text.replace(/\/\/.*$/gm, ''))) netHits.push(f)
  }
  check('I3 源码无注入钩子', injectionHits.length === 0, injectionHits)
  check('I4 源码不写 claims.jsonl / topic 正文', claimsHits.length === 0, claimsHits)
  check('I5 源码无时间衰减', decayHits.length === 0, decayHits)
  check('I6 源码无网络/模型调用', netHits.length === 0, netHits)

  const st = await stateMap(dir, 'alice')
  const chunkById = new Map(readChunks(dir, 'alice').map((c) => [c.id, c]))
  let upgraded = []
  for (const s of st.values()) {
    const c = chunkById.get(s.chunkId)
    if (!c) continue
    const base = c.role === 'user' ? 'fact' : c.role === 'assistant' ? 'inference' : 'unknown'
    if ((EPISTEMIC_RANK[s.epistemic] ?? 0) > (EPISTEMIC_RANK[base] ?? 0)) upgraded.push({ id: s.chunkId, base, got: s.epistemic })
  }
  check('I7 epistemic 只降不升', upgraded.length === 0, upgraded)

  const noBody = [...st.values()].every((s) => !['text', 'body', 'summary', 'conclusion', 'content'].some((k) => k in s))
  check('I8 state 记录不含原文/正文字段', noBody)

  // 锁：先占住，再 run → LOCK_BUSY
  const lock = await acquireLock(processDir(dir, 'alice'), { timeoutMs: 100 })
  const lockRun = await runProcess({ dataRoot: dir, personaId: 'alice', force: true, lockTimeoutMs: 300 })
  check('I9 单写者锁生效（LOCK_BUSY）', lockRun.ok === false && lockRun.code === 'LOCK_BUSY', lockRun)
  await lock.release()

  // 生成递增 + 备份存在
  const man = (await readManifest(dir, 'alice')).manifest
  const genBefore = man.generation
  const exp = await createManualPending({ dataRoot: dir, personaId: 'alice', kind: 'expire', chunkIds: [readChunks(dir, 'alice')[0].id] })
  const man2 = (await readManifest(dir, 'alice')).manifest
  check('I10 写动作递增 generation', man2.generation === genBefore + 1, { genBefore, after: man2.generation })
  check('I11 手动候选创建成功', exp.ok === true, exp)
  const archives = fs.existsSync(path.join(dir, 'process', 'alice', '_archive'))
  check('I12 _archive 快照目录存在', archives)

  // 5k 性能夹具（每句带唯一哈希后缀，避免人为制造全量近重复）
  const bigChunks = []
  for (let i = 0; i < 5000; i++) {
    const sig = hex(`big-${i}`).slice(0, 24)
    bigChunks.push(mkChunk({ text: `第 ${i} 条规模测试记忆：${sig} 画风、训练与日常记录。`, session: 's-big', seq: i + 1 }))
  }
  const bigDir = makeFixture('I-big', { chunks: bigChunks })
  const t0 = Date.now()
  const bigRun = await runProcess({ dataRoot: bigDir, personaId: 'alice' })
  const elapsed = Date.now() - t0
  check('I13 5k 块 run < 30 秒', bigRun.ok === true && elapsed < 30000, { elapsedMs: elapsed, run: bigRun.elapsedMs })
  check('I14 5k run 无 LLM/网络', bigRun.llmCalls === 0 && bigRun.networkCalls === 0)
  return dir
}

// ============================================================================
async function testUiAndSafety() {
  section('K. UI 数据源 / 路径安全 / 增量对账 / 用户态保护')
  const oldC = mkChunk({ text: '用户现在用的模型是 DeepSeek V3。', session: 's-k-corr', seq: 1, t: Date.UTC(2026, 10, 1) })
  const newC = mkChunk({ text: '用户现在用的模型改成 DeepSeek V4 了。', session: 's-k-corr', seq: 2, t: Date.UTC(2026, 10, 1) + 1000 })
  const dupA = mkChunk({ text: 'UI 测试重复句。', session: 's-k-dup', seq: 3 })
  const dupB = mkChunk({ text: 'UI 测试重复句。', session: 's-k-dup', seq: 4 })
  const d1 = mkChunk({ text: '训练只在工作日。', session: 's-k-conf', seq: 5 })
  const d2 = mkChunk({ text: '训练每天都可以。', session: 's-k-conf', seq: 6 })
  const exp = mkChunk({ text: '这条已过期。', session: 's-k-exp', seq: 7, retention: 'expired' })
  const dir = makeFixture('K', { chunks: [oldC, newC, dupA, dupB, d1, d2, exp] })

  const ctx = await apiContext({ dataRoot: dir, workspace: 'C:\\work\\alice' })
  check('K1 apiContext 按工作区解析当前 persona', ctx.ok && ctx.personaId === 'alice' && ctx.resolved === true, { personaId: ctx.personaId, resolved: ctx.resolved, scopes: ctx.scopes })
  const caps = apiCapabilities()
  check('K2 capabilities 明确 v1a 只读/主题关闭', caps.ok && caps.capabilities.readOnly === true && caps.capabilities.topics === false && caps.capabilities.search === false)
  const storage = await apiRootStorage({ dataRoot: dir, personaId: 'alice' })
  check('K3 apiRootStorage 只 stat 就能给块数/体积/覆盖', storage.ok && storage.chunks === 7 && storage.volumeBytes > 0 && storage.coverageDays >= 0, storage)
  const runK = await runProcess({ dataRoot: dir, personaId: 'alice' })
  check('K4 K 段 run ok', runK.ok === true, runK)

  const pend = await apiPending({ dataRoot: dir, personaId: 'alice' })
  const pRow = pend.rows.find((r) => r.kind === 'supersede')
  check('K5 apiPending 内嵌涉及记忆的锚点+摘要', Boolean(pRow) && pRow.chunks.length === 2 && pRow.chunks.every((c) => c.anchorKey && c.textPreview), pRow?.chunks)
  check('K6 apiPending 的 duplicates 也内嵌 chunks', pend.duplicates.rows.length >= 1 && pend.duplicates.rows[0].chunks.length >= 2, pend.duplicates.rows[0]?.chunks)

  const mem = await apiMemories({ dataRoot: dir, personaId: 'alice', limit: 3, includeText: false })
  check('K7 memories 列表默认只给 preview', mem.ok && mem.rows.length === 3 && mem.rows.every((r) => r.textPreview && !('text' in r)))
  const memText = await apiMemories({ dataRoot: dir, personaId: 'alice', chunkIds: [oldC.id], includeText: true })
  check('K8 memories chunkIds 过滤 + includeText', memText.ok && memText.total === 1 && memText.rows[0].chunkId === oldC.id && typeof memText.rows[0].text === 'string')
  const memStatus = await apiMemories({ dataRoot: dir, personaId: 'alice', status: 'expired' })
  check('K9 memories status 过滤（expired）', memStatus.ok && memStatus.rows.length === 1 && memStatus.rows[0].chunkId === exp.id, memStatus.rows.map((r) => r.chunkId))
  const detail = await apiMemory({ dataRoot: dir, personaId: 'alice', chunkId: newC.id })
  check('K10 apiMemory 详情给全文+锚点+状态', detail.ok && detail.row.chunkId === newC.id && detail.row.anchorKey && typeof detail.row.text === 'string')
  const batch = await apiChunks({ dataRoot: dir, personaId: 'alice', chunkIds: [oldC.id, 'missing-id'] })
  check('K11 apiChunks 批量 + missing 列表', batch.ok && batch.rows.length === 1 && batch.missing.includes('missing-id'), { rows: batch.rows.length, missing: batch.missing })

  const c = await addConflict({ dataRoot: dir, personaId: 'alice', chunkIds: [d1.id, d2.id], kind: 'unexplained-contradiction' })
  const conf = await apiConflicts({ dataRoot: dir, personaId: 'alice', status: 'open' })
  check('K12 apiConflicts 内嵌双方锚点/摘要', c.ok && conf.ok && conf.rows.length === 1 && conf.rows[0].chunks.length === 2 && conf.rows[0].chunks.every((x) => x.anchorKey && x.textPreview), conf.rows[0]?.chunks)
  const topics = await apiTopics({ dataRoot: dir, personaId: 'alice' })
  check('K13 apiTopics 空态 + uniqueMemberCount 字段', topics.ok && topics.topics.length === 0)
  const status = await apiStatus({ dataRoot: dir, personaId: 'alice', config: { processEnabled: true } })
  check('K14 apiStatus 返回 generation/阈值/config', status.ok && status.initialized && status.generation >= 1 && status.config?.processEnabled === true)

  // 路径穿越：applyId 不得覆盖 manifest
  const manBefore = (await readManifest(dir, 'alice')).manifest.generation
  const evil = await applyPending({ dataRoot: dir, personaId: 'alice', pendingIds: [pRow.pendingId], expectedGeneration: manBefore, confirm: true, applyId: '../../manifest' })
  check('K15 applyId 路径穿越被拒', evil.ok === false && evil.code === 'BAD_APPLY_ID', evil)
  check('K16 被拒后 manifest 未被覆盖', (await readManifest(dir, 'alice')).manifest.generation === manBefore)
  // 路径穿越：export 不得覆盖 state.jsonl
  const stateFile = path.join(dir, 'process', 'alice', 'state.jsonl')
  const stateHashBefore = hex(fs.readFileSync(stateFile))
  const evilExport = await exportProcess({ dataRoot: dir, personaId: 'alice', out: stateFile })
  check('K17 export out 覆盖状态文件被拒', evilExport.ok === false && evilExport.code === 'BAD_EXPORT_PATH', evilExport)
  check('K18 被拒后 state.jsonl 未被覆盖', hex(fs.readFileSync(stateFile)) === stateHashBefore)
  const goodExport = await exportProcess({ dataRoot: dir, personaId: 'alice' })
  check('K19 export 默认落 _archive 且成功', goodExport.ok === true && fs.existsSync(goodExport.file), goodExport)

  // 根藏只改 builtAt 不改 generation → apply 必须被拒
  const p2 = (await pendingList(dir, 'alice')).find((x) => x.kind === 'supersede')
  const man2 = (await readManifest(dir, 'alice')).manifest
  bumpRoot(dir, 'alice', { builtAt: '2026-11-07T09:00:00.000Z', generation: man2.rootGeneration ?? 1 })
  const stale = await applyPending({ dataRoot: dir, personaId: 'alice', pendingIds: [p2.pendingId], expectedGeneration: man2.generation, confirm: true })
  check('K20 根藏 builtAt 变化后旧 apply 被拒（STALE_ROOT）', stale.ok === false && stale.code === 'STALE_ROOT', stale)
  check('K21 被拒后旧条仍 active', (await stateMap(dir, 'alice')).get(oldC.id)?.status === 'active')

  // rebuild 用户态保护
  const beforeRebuild = await stateMap(dir, 'alice')
  const rb = await rebuildProcess({ dataRoot: dir, personaId: 'alice', confirm: true })
  const afterRebuild = await stateMap(dir, 'alice')
  check('K22 rebuild 检测到用户态时拒绝', rb.ok === false && rb.code === 'REBUILD_USER_STATE_PRESENT', rb)
  check('K23 被拒后 state 不变（不丢用户态）', same([...beforeRebuild.keys()].sort(), [...afterRebuild.keys()].sort()))

  // 增量重复对账：K2 独立夹具（无 pending/冲突干扰）
  const u1 = mkChunk({ text: '增量重复对账句。', session: 's-k2', seq: 1 })
  const u2 = mkChunk({ text: '增量重复对账句。', session: 's-k2', seq: 2 })
  const dir2 = makeFixture('K2', { chunks: [u1, u2] })
  await runProcess({ dataRoot: dir2, personaId: 'alice' })
  const g1 = (await dupList(dir2, 'alice')).find((g) => g.method === 'exact')
  check('K24 初始精确组 2 人', g1 && g1.evidenceCount === 2, g1)
  const u3 = mkChunk({ text: '增量重复对账句。', session: 's-k2', seq: 3 })
  appendChunk(dir2, 'alice', u3)
  bumpRoot(dir2, 'alice', { builtAt: '2026-11-07T10:00:00.000Z' })
  await runProcess({ dataRoot: dir2, personaId: 'alice' })
  const g2 = (await dupList(dir2, 'alice')).find((g) => g.method === 'exact')
  check('K25 追加重复成员后同组更新到 3 人', g2 && g2.evidenceCount === 3 && g2.chunkIds.includes(u3.id) && g2.version >= 2, g2)
  const v2 = await verifyProcess({ dataRoot: dir2, personaId: 'alice' })
  check('K26 增量后 verify 无重复组重叠', v2.ok === true && !v2.problems.some((p) => p.code === 'DUPLICATE_GROUP_OVERLAP'), v2.problems)
}

// ============================================================================

async function testRealRoot(realRoot) {
  section('J. 真实根藏副本（只读零写入 + 规模）')
  if (!realRoot) { console.log('  ⏭️  未传 --real-root，跳过'); return }
  const dir = path.join(baseDir, 'J-real')
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(path.join(realRoot, 'scopes'), path.join(dir, 'scopes'), { recursive: true })
  fs.copyFileSync(path.join(realRoot, 'identity.json'), path.join(dir, 'identity.json'))
  const before = { z: await rootHash(dir, 'alice'), f: await rootHash(dir, 'bob'), id: await hashIdentity(dir) }
  const t0 = Date.now()
  const rz = await runProcess({ dataRoot: dir, personaId: 'alice' })
  const rf = await runProcess({ dataRoot: dir, personaId: 'bob' })
  const elapsed = Date.now() - t0
  const after = { z: await rootHash(dir, 'alice'), f: await rootHash(dir, 'bob'), id: await hashIdentity(dir) }
  check('J1 真实根藏 alice run ok', rz.ok === true, rz)
  check('J2 真实根藏 bob run ok', rf.ok === true, rf)
  check('J3 真实根藏零写入（两 scope + identity）', same(before, after), { before, after })
  check('J4 真实规模（4043+1740）run < 30 秒', elapsed < 30000, { elapsedMs: elapsed, z: rz.elapsedMs, f: rf.elapsedMs })
  check('J5 真实规模无 LLM/网络', rz.llmCalls === 0 && rf.llmCalls === 0)
  const v = await verifyProcess({ dataRoot: dir, personaId: 'alice' })
  check('J6 真实 alice verify ok', v.ok === true, v.problems)
}

// ============================================================================
async function testDataRootOverride() {
  section('Stage 0：JIANMU_DATA_ROOT')
  const oldOv = process.env.JIANMU_DATA_ROOT
  const oldHome = process.env.DSH_HOME
  try {
    const { defaultDataRoot } = await import('../lib/paths.mjs')
    process.env.DSH_HOME = path.join(os.tmpdir(), 'process-fake-home')
    delete process.env.JIANMU_DATA_ROOT
    check('JIANMU_DATA_ROOT：默认回退 DSH_HOME', defaultDataRoot().endsWith(path.join('process-fake-home', 'memory-jianmu')), defaultDataRoot())
    process.env.JIANMU_DATA_ROOT = 'C:/jianmu-data'
    check('JIANMU_DATA_ROOT：覆盖生效', defaultDataRoot().toLowerCase().endsWith('jianmu-data'), defaultDataRoot())
  } finally {
    if (oldOv === undefined) delete process.env.JIANMU_DATA_ROOT
    else process.env.JIANMU_DATA_ROOT = oldOv
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
}

async function main() {
  console.log(`熏习 v1a 自测 · ${new Date().toISOString()}`)
  console.log(`临时目录：${baseDir}`)
  await testDataRootOverride()
  const dirA = await testDedupeAndRules()
  await testApplyRestore(dirA)
  await testConflict()
  await testResumeAndFailure()
  await testStaleApply()
  await testVerifyRepair()
  await testRebuild()
  await testPersonaIsolation()
  await testUiAndSafety()
  await testGuards(dirA)
  await testRealRoot(args.realRoot)

  console.log(`\n═══ 自测：${pass}/${pass + fail} 通过 ═══`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` — ${JSON.stringify(f.detail).slice(0, 500)}` : ''}`)
    console.log(`临时目录保留：${baseDir}`)
    process.exitCode = 1
  } else if (!args.keep) {
    fs.rmSync(baseDir, { recursive: true, force: true })
    console.log('临时目录已清理')
  } else {
    console.log(`临时目录保留（--keep）：${baseDir}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
