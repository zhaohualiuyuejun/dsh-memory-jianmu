#!/usr/bin/env node
/**
 * tools/hardclaim-e2e.mjs —— 硬认领跨包 e2e（真模块 + 真文件，零 API、零网络）
 *
 * 覆盖计划 S4/S5：
 *   1. 真加载根藏/熏习/年轮/镜台四个 index.js，用 ctx.provide/ctx.get 串起来
 *   2. 工具 jianmu_persona_claim_hard：预览数字对得上
 *   3. apply：三层一致（根藏 3/1、state 3/1、claims 3/3）+ identity 补登记
 *   4. 终验：根藏两边 ok、熏习两边 ok、年轮目标 ok（源侧混合锚点 1 个预期孤儿）
 *   5. rollback：三层 + identity 复原（逐文件 sha256）
 *   6. 重复 rollback 幂等
 *   7. 缺服务时 apply 拒绝（SERVICE_UNAVAILABLE）
 *
 * 用法：node tools/hardclaim-e2e.mjs [--keep]
 * 退出码：0 = 全绿
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const KEEP = process.argv.includes('--keep')
const STAMP = Date.now()
const BASE = path.join('C:/work/alice/tmp', `hardclaim-e2e-${STAMP}`)
const DATA = path.join(BASE, 'root')
const DSH = path.join(BASE, 'dshhome')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

const WS = 'C:\\work\\lab'
const rootStore = await import('../../../root/lib/store.mjs')
const { makeUtterance } = await import('../../../root/lib/chunks.mjs')
const { claimGroupIdOf, claimIdOf, derivedFromHashOf } = await import('../../../yearring/dsh-memory-yearring/lib/claim.mjs')
const { yearDir, yearFile, topicDocsDir } = await import('../../../yearring/dsh-memory-yearring/lib/paths.mjs')
const { processDir, processFile } = await import('../../../process/dsh-memory-process/lib/paths.mjs')
const { ensureManifest, readStateMap } = await import('../../../process/dsh-memory-process/lib/store.mjs')
const { emptyManifest, readClaims } = await import('../../../yearring/dsh-memory-yearring/lib/store.mjs')
const { atomicWrite } = await import('../../../process/dsh-memory-process/lib/fsatomic.mjs')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`) }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const T = Date.now() - 3600_000

// ── 夹具 ────────────────────────────────────────────────────────────────────
const mk = (text, pid, i, ws = WS) => makeUtterance({
  session: `lab-${i}`, messageId: `m-${i}`, seq: 1, text, role: 'user', t: T, ws, personaId: pid,
})
const A = mk('旧记忆一：生日是三月五号', 'persona_unassigned', 1)
const B = mk('旧记忆二：面馆在东门', 'persona_unassigned', 2)
const C = mk('旧记忆三：周末去爬山', 'persona_unassigned', 3, 'H:\\other place')
const D = mk('测试员自己的新记忆', 'tester', 4)

function mkClaim(pid, kind, title, chunks, revision = 1) {
  const groupId = claimGroupIdOf(pid, kind, title)
  const anchors = chunks.map((c) => ({ chunkId: c.id, session: c.session, messageId: c.messageId, seq: c.seq, part: 0, t: c.t, quote: c.text.slice(0, 20) }))
  const hash = derivedFromHashOf(anchors)
  return {
    claimGroupId: groupId, personaId: pid, kind, epistemic: 'fact', speaker: 'user', speakerSource: 'anchor',
    title, body: '夹具', topicId: null, topicHint: title, status: 'active', confidence: 0.9,
    derivedFrom: anchors, derivedFromHash: hash, supersedes: null, supersededBy: null, conflictsWith: [],
    reportedBy: null, source: 'rule', createdAt: T, updatedAt: T, runId: null, model: null, promptVersion: null,
    costTokens: 0, review: { status: 'unreviewed', by: null, at: null }, revision,
    claimId: claimIdOf({ personaId: pid, kind, claimGroupId: groupId, derivedFromHash: hash, revision }),
  }
}

console.log('\n── 0. 四层夹具')
const w1 = await rootStore.writeScopeBundle({
  dataRoot: DATA, personaId: 'persona_unassigned', utterances: [A, B, C],
  vectors: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], embedding: { provider: 'local', model: 'test-model', dim: 4 }, reason: 'hardclaim-e2e',
})
const w2 = await rootStore.writeScopeBundle({
  dataRoot: DATA, personaId: 'tester', utterances: [D],
  vectors: [0, 0, 0, 1], embedding: { provider: 'local', model: 'test-model', dim: 4 }, reason: 'hardclaim-e2e',
})
check('F1 根藏 3+1 块', w1.ok && w2.ok && w1.chunks === 3 && w2.chunks === 1, { w1, w2 })
fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1, defaultPersonaId: null,
  personas: { alice: { displayName: 'Alice' }, tester: { displayName: '测试员' } },
  workspaces: { 'C:\\work\\alice': 'alice' }, sessions: {},
}, null, 2))

await ensureManifest(DATA, 'persona_unassigned')
await ensureManifest(DATA, 'tester')
const now = Date.now()
const st = (c, scope) => ({
  chunkId: c.id, anchorKey: `${c.session}|${c.messageId}||0`, scope, status: 'active', validFrom: now, validTo: null, supersededBy: null,
  reason: 'rule:classified', source: 'rule', confidence: 0.9, version: 1, epistemic: 'fact', attribution: 'user', sensitivity: 'normal',
  updatedAt: now, generation: '1', rootBuiltAt: new Date().toISOString(),
})
await atomicWrite(processFile(DATA, 'persona_unassigned', 'state'), [st(A, 'persona_unassigned'), st(B, 'persona_unassigned'), st(C, 'persona_unassigned')].map((r) => JSON.stringify(r)).join('\n') + '\n')
await atomicWrite(processFile(DATA, 'tester', 'state'), JSON.stringify(st(D, 'tester')) + '\n')
await atomicWrite(processFile(DATA, 'persona_unassigned', 'duplicates'), JSON.stringify({
  groupId: 'dup-exact-aaa', chunkIds: [A.id, B.id], method: 'exact', similarity: 1, evidenceCount: 2,
  mergedFrom: [A.id, B.id], version: 1, status: 'pending', createdAt: now, updatedAt: now,
}) + '\n')
await atomicWrite(processFile(DATA, 'persona_unassigned', 'pending'), JSON.stringify({
  pendingId: 'pending-supersede-bbb', kind: 'supersede', chunkIds: [A.id, B.id],
  proposed: { status: 'superseded', chunkId: A.id, supersededBy: B.id }, status: 'pending', createdAt: now, updatedAt: now,
}) + '\n')

const G1a = mkClaim('persona_unassigned', 'fact', '旧记忆：生日与面馆', [A, B], 1)
const G1b = mkClaim('persona_unassigned', 'fact', '旧记忆：生日与面馆', [A, B], 2)
const G2 = mkClaim('persona_unassigned', 'event', '混合：生日与爬山', [A, C], 1)
const G3 = mkClaim('persona_unassigned', 'event', '留守：只有爬山', [C], 1)
const GT = mkClaim('tester', 'fact', '旧记忆：生日与面馆', [D], 1)
fs.mkdirSync(yearDir(DATA, 'persona_unassigned'), { recursive: true })
fs.mkdirSync(yearDir(DATA, 'tester'), { recursive: true })
fs.mkdirSync(topicDocsDir(DATA, 'persona_unassigned'), { recursive: true })
fs.mkdirSync(topicDocsDir(DATA, 'tester'), { recursive: true })
fs.writeFileSync(yearFile(DATA, 'persona_unassigned', 'claims'), [G1a, G1b, G2, G3].map((c) => JSON.stringify(c)).join('\n') + '\n')
fs.writeFileSync(yearFile(DATA, 'tester', 'claims'), JSON.stringify(GT) + '\n')
for (const pid of ['persona_unassigned', 'tester']) {
  fs.writeFileSync(yearFile(DATA, pid, 'manifest'), JSON.stringify({ ...emptyManifest(pid), generation: 1 }, null, 2) + '\n')
}

// 镜台：卡 + registry（registry 已把 lab workspace 绑到 tester，identity 尚未映射）
const PERSONA = path.join(DATA, 'persona')
const cardMd = (id, name) => ['---', `id: "${id}"`, `name: "${name}"`, `personaId: "${id}"`, `memoryScope: "${id}"`, 'source: "manual"', 'status: "active"', 'version: 1', '---', '', `# ${name}`, '', '## 身份与外貌', `${name}（hardclaim-e2e 夹具）。`, ''].join('\n')
for (const [id, name] of [['alice', 'Alice'], ['tester', '测试员']]) {
  fs.mkdirSync(path.join(PERSONA, 'cards', id), { recursive: true })
  fs.writeFileSync(path.join(PERSONA, 'cards', id, 'card.md'), cardMd(id, name))
}
fs.writeFileSync(path.join(PERSONA, 'manifest.json'), JSON.stringify({ schemaVersion: 1, contractVersion: 1, generation: 1, dataRoot: DATA, createdAt: now, updatedAt: now, lastError: null, writer: { name: 'dsh-memory-persona', version: 'e2e' } }, null, 2))
fs.writeFileSync(path.join(PERSONA, 'registry.json'), JSON.stringify({
  schemaVersion: 1, contractVersion: 1, generation: 1, activeCardId: 'alice',
  cards: { alice: { name: 'Alice', source: 'manual', status: 'active', version: 1 }, tester: { name: '测试员', source: 'manual', status: 'active', version: 1 } },
  workspaces: { 'C:\\work\\alice': 'alice', [WS]: 'tester' }, workspaceList: ['C:\\work\\alice', WS],
  sessions: {}, settings: {}, updatedAt: now, settingsRevision: 0, settingsUpdatedAt: now,
}, null, 2))

const snapAll = () => {
  const out = {}
  const add = (k, f) => { try { if (fs.statSync(f).isFile()) out[k] = sha(f) } catch { /* 忽略 */ } }
  for (const pid of ['persona_unassigned', 'tester']) {
    for (const n of ['chunks.jsonl', 'manifest.json', 'index_meta.json', 'deleted.jsonl', 'vectors_v1.f32']) add(`scopes/${pid}/${n}`, path.join(DATA, 'scopes', pid, n))
    for (const n of ['state.jsonl', 'manifest.json', 'duplicates.jsonl', 'pending.jsonl', 'conflicts.jsonl']) add(`process/${pid}/${n}`, path.join(DATA, 'process', pid, n))
    for (const n of ['claims.jsonl', 'manifest.json']) add(`year/${pid}/${n}`, path.join(DATA, 'year', pid, n))
    try { for (const n of fs.readdirSync(path.join(DATA, 'year', pid, 'topic_docs'))) if (n.endsWith('.md')) add(`year/${pid}/topic_docs/${n}`, path.join(DATA, 'year', pid, 'topic_docs', n)) } catch { /* 无 docs */ }
  }
  add('identity.json', path.join(DATA, 'identity.json'))
  return out
}
const before = snapAll()

// ── 真加载四层 ──────────────────────────────────────────────────────────────
console.log('\n── 1. 加载四层（ctx.provide/ctx.get）')
function fakeHost() {
  const provided = {}
  const tools = {}
  const { ctx } = {
    ctx: {
      tools: { register(t) { tools[t.name] = t; return () => {} } },
      logger: { info() {}, warn() {}, error() {} },
      systemPrompt: { section() { return () => {} } },
      settings: { describe: () => [] },
      on() { return () => {} },
      provide(n, svc) { provided[n] = svc; return () => {} },
      inject() {}, effect() {},
      get(n) {
        if (provided[n] !== undefined) return provided[n]
        if (n === 'webServer') return { register: () => () => {} }
        return undefined
      },
    },
  }
  return { ctx, provided, tools }
}
const host = fakeHost()
const rootMod = await import('../../../root/index.js')
rootMod.apply(host.ctx, { enabled: true, autoIngest: false, autoSummaryIndex: false, dataRoot: DATA })
check('H1 根藏 provide jianmuStore（含 claimHard*）', Boolean(host.provided.jianmuStore?.claimHardPreview && host.provided.jianmuStore?.claimHardApply), Object.keys(host.provided.jianmuStore || {}))
const procMod = await import('../../../process/dsh-memory-process/index.js')
procMod.apply(host.ctx, { enabled: true, dataRoot: DATA, processEnabled: true, autoRun: false, llmEnabled: false })
check('H2 熏习 provide jianmuProcess（含 claimHard*）', Boolean(host.provided.jianmuProcess?.claimHardMoveState), Object.keys(host.provided.jianmuProcess || {}))
const yearMod = await import('../../../yearring/dsh-memory-yearring/index.js')
yearMod.apply(host.ctx, { enabled: true, dataRoot: DATA, writeEnabled: true })
check('H3 年轮 provide jianmuYear（含 claimHard*）', Boolean(host.provided.jianmuYear?.claimHardMoveClaims), Object.keys(host.provided.jianmuYear || {}))
const personaMod = await import('../index.js')
personaMod.apply(host.ctx, { dataRoot: DATA, profile: 'desktop', injectEnabled: false, autoRecall: false, enabled: true })
const tool = host.tools['jianmu_persona_claim_hard']
check('H4 镜台注册 jianmu_persona_claim_hard', Boolean(tool) && typeof tool.execute === 'function', Object.keys(host.tools).filter((n) => n.includes('claim')))

console.log('\n── 2. 预览（dryRun）')
const pv = await tool.execute({ to: 'tester', workspace: WS }, {})
check('P1 预览 ok：chunks=2 / stateRows=2 / claims.move=2 / mixed=1', pv.ok === true && pv.chunks === 2 && pv.process?.stateRows === 2 && pv.claims?.move === 2 && pv.claims?.mixedAnchor === 1, pv)
check('P2 目标 generation=1，提示带 expectedGeneration', pv.ok && pv.target?.generation === 1 && String(pv.next).includes('expectedGeneration=1'), { t: pv.target, next: pv.next })
check('P3 identity 计划补登记 lab workspace', pv.ok && (pv.identity?.workspacesToAdd || []).includes(WS), pv.identity)
check('P4 预览零写入', JSON.stringify(snapAll()) === JSON.stringify(before))

console.log('\n── 3. 真写（干跑缺 confirm 应拒绝）')
const noC = await tool.execute({ to: 'tester', workspace: WS, dryRun: false }, {})
check('A0 缺 confirm → CONFIRM_REQUIRED', noC.ok === false && noC.code === 'CONFIRM_REQUIRED', noC)
const applied = await tool.execute({ to: 'tester', workspace: WS, dryRun: false, confirm: true, expectedGeneration: 1 }, {})
check('A1 apply ok', applied.ok === true, applied)
check('A2 根藏 3/1（目标/源）', applied.ok && applied.moved === 2, { moved: applied.moved })
check('A3 熏习 state 搬了 2 行', applied.ok && applied.process?.moved === 2, applied.process)
check('A4 claims 搬了 2 条、混合 1 条', applied.ok && applied.claims?.moved === 2 && applied.claims?.mixedAnchor === 1, applied.claims)
check('A5 identity 已把 lab workspace 登记给 tester', JSON.parse(fs.readFileSync(path.join(DATA, 'identity.json'), 'utf8')).workspaces?.[WS] === 'tester')
check('A6 终验 ok（含源侧 1 个预期孤儿）', applied.ok && applied.verify?.ok === true && applied.verify?.yearOrphan === 1, applied.verify)

const tgtChunks = (await rootStore.readScope(DATA, 'tester')).chunks
const srcChunks = (await rootStore.readScope(DATA, 'persona_unassigned')).chunks
check('A7 根藏实际：目标 3 / 源 1', tgtChunks.length === 3 && srcChunks.length === 1, { t: tgtChunks.length, s: srcChunks.length })
check('A8 熏习实际：目标 3 / 源 1', (await readStateMap(DATA, 'tester')).map.size === 3 && (await readStateMap(DATA, 'persona_unassigned')).map.size === 1)
check('A9 年轮实际：目标 3 / 源 2', (await readClaims(DATA, 'tester')).unique === 3 && (await readClaims(DATA, 'persona_unassigned')).unique === 2)
check('A10 journal 已落盘且 status=done', await (async () => {
  const j = JSON.parse(fs.readFileSync(applied.backup.journal, 'utf8'))
  return j.status === 'done' && j.layers?.root?.backupDir && j.layers?.process?.backupDir && j.layers?.year?.backupDir
})())

console.log('\n── 4. 回滚')
const rb = await tool.execute({ rollbackBackup: applied.backup.journal, confirm: true }, {})
check('R1 回滚 ok', rb.ok === true, rb)
check('R2 三层逐文件 sha256 与搬迁前一致', (() => {
  const after = snapAll()
  const diffs = Object.keys(before).filter((k) => after[k] !== before[k])
  return diffs.length === 0
})(), { beforeKeys: Object.keys(before).length })
check('R3 identity 映射已撤销', JSON.parse(fs.readFileSync(path.join(DATA, 'identity.json'), 'utf8')).workspaces?.[WS] === undefined)
check('R4 根藏恢复 3 / 1', (await rootStore.readScope(DATA, 'persona_unassigned')).chunks.length === 3 && (await rootStore.readScope(DATA, 'tester')).chunks.length === 1)
check('R5 年轮恢复 4 / 1（源 4 条）', (await readClaims(DATA, 'persona_unassigned')).unique === 4 && (await readClaims(DATA, 'tester')).unique === 1)
const rb2 = await tool.execute({ rollbackBackup: applied.backup.journal, confirm: true }, {})
check('R6 重复回滚幂等', rb2.ok === true && rb2.alreadyRolledBack === true, rb2)

console.log('\n── 5. 再次 apply 应可重复（回滚后 generation 复原）')
const applied2 = await tool.execute({ to: 'tester', workspace: WS, dryRun: false, confirm: true, expectedGeneration: 1 }, {})
check('A11 回滚后重跑 apply 成功', applied2.ok === true && applied2.moved === 2, applied2)
const rb3 = await tool.execute({ rollbackBackup: applied2.backup.journal, confirm: true }, {})
check('R7 清理：再次回滚 ok', rb3.ok === true, rb3)
check('R8 清理后 sha256 仍与最初一致', (() => {
  const after = snapAll()
  return Object.keys(before).every((k) => after[k] === before[k])
})())

console.log('\n── 6. 缺服务闸门')
const bare = fakeHost()
const personaMod2 = await import(`../index.js?bare=${STAMP}`)
personaMod2.apply(bare.ctx, { dataRoot: DATA, profile: 'desktop', injectEnabled: false, autoRecall: false, enabled: true })
const bareTool = bare.tools['jianmu_persona_claim_hard']
const bareOut = await bareTool.execute({ to: 'tester', workspace: WS, dryRun: false, confirm: true, expectedGeneration: 1 }, {})
check('G1 缺熏习/年轮服务 → SERVICE_UNAVAILABLE', bareOut.ok === false && bareOut.code === 'SERVICE_UNAVAILABLE', bareOut)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) { for (const f of failures) console.log(` - ${f.name}`); process.exitCode = 1 }
if (!KEEP) { try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* 忽略 */ } } else { console.log(`保留夹具：${BASE}`) }
