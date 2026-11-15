#!/usr/bin/env node
/**
 * tools/hardclaim-selftest.mjs —— 熏习硬认领自测（零 API、零网络）
 *
 * 覆盖计划 S2：
 *   1. state 行数守恒（源删、目标加；scope 改写）
 *   2. duplicates / pending 追加 stale（latest-wins 隐藏旧候选）
 *   3. 两边 manifest 可读、计数更新
 *   4. rebuild 后 state 行数 = 根藏块数（两边）
 *   5. 空选择 / 重复调用幂等（noop）
 *   6. 回滚：整文件 sha256 复原
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const KEEP = process.argv.includes('--keep')
const STAMP = Date.now()
const BASE = path.join('C:/work/alice/tmp', `process-hardclaim-${STAMP}`)
const DATA = path.join(BASE, 'root')
const DSH = path.join(BASE, 'dshhome')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

const rootStore = await import('../../../root/lib/store.mjs')
const rootHc = await import('../../../root/lib/hardclaim.mjs')
const { makeUtterance } = await import('../../../root/lib/chunks.mjs')
const hc = await import('../lib/hardclaim.mjs')
const { processDir, processFile } = await import('../lib/paths.mjs')
const { ensureManifest, readStateMap, readPendingMap, readDuplicatesMap, readManifest } = await import('../lib/store.mjs')
const { readJsonl, atomicWrite } = await import('../lib/fsatomic.mjs')
const { rebuildProcess } = await import('../lib/rebuild.mjs')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`) }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const T = Date.now() - 3600_000

const mk = (text, pid, i, ws = 'C:\\work\\lab') => makeUtterance({
  session: `lab-${i}`, messageId: `m-${i}`, seq: 1, text, role: 'user', t: T, ws, personaId: pid,
})
const A = mk('测试员旧记忆一：生日是三月五号', 'persona_unassigned', 1)
const B = mk('测试员旧记忆二：面馆在东门', 'persona_unassigned', 2)
const C = mk('测试员旧记忆三：周末去爬山', 'persona_unassigned', 3, 'H:\\other place')
const D = mk('测试员自己的新记忆', 'tester', 4)

async function wb(pid, rows) {
  return rootStore.writeScopeBundle({
    dataRoot: DATA, personaId: pid, utterances: rows,
    vectors: rows.flatMap((_, i) => { const v = [0, 0, 0, 0]; v[i % 4] = 1; return v }),
    embedding: { provider: 'local', model: 'test-model', dim: 4 },
    reason: 'process-hardclaim-selftest',
  })
}

console.log('\n── 0. 夹具：根藏 3+1 块；熏习 state/duplicates/pending')
const w1 = await wb('persona_unassigned', [A, B, C])
const w2 = await wb('tester', [D])
check('F1 根藏夹具写入', w1.ok && w2.ok && w1.chunks === 3 && w2.chunks === 1, { w1, w2 })
fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1, defaultPersonaId: null,
  personas: { alice: { displayName: 'Alice' }, tester: { displayName: '测试员' } },
  workspaces: { 'C:\\work\\alice': 'alice' }, sessions: {},
}, null, 2))
await ensureManifest(DATA, 'persona_unassigned')
await ensureManifest(DATA, 'tester')
const now = Date.now()
const st = (c, scope, src = 'rule') => ({
  chunkId: c.id, anchorKey: `${c.session}|${c.messageId}||0`, scope,
  status: 'active', validFrom: now, validTo: null, supersededBy: null,
  reason: 'rule:classified', source: src, confidence: 0.9, version: 1,
  epistemic: 'fact', attribution: 'user', sensitivity: 'normal',
  updatedAt: now, generation: '1', rootBuiltAt: new Date().toISOString(),
})
await atomicWrite(processFile(DATA, 'persona_unassigned', 'state'), [st(A, 'persona_unassigned'), st(B, 'persona_unassigned'), st(C, 'persona_unassigned')].map((r) => JSON.stringify(r)).join('\n') + '\n')
await atomicWrite(processFile(DATA, 'persona_unassigned', 'duplicates'), JSON.stringify({
  groupId: 'dup-exact-aaa', chunkIds: [A.id, B.id], method: 'exact', similarity: 1,
  evidenceCount: 2, mergedFrom: [A.id, B.id], version: 1, status: 'pending', createdAt: now, updatedAt: now,
}) + '\n')
await atomicWrite(processFile(DATA, 'persona_unassigned', 'pending'), JSON.stringify({
  pendingId: 'pending-supersede-bbb', kind: 'supersede', chunkIds: [A.id, B.id],
  proposed: { status: 'superseded', chunkId: A.id, supersededBy: B.id },
  status: 'pending', createdAt: now, updatedAt: now,
}) + '\n')
await atomicWrite(processFile(DATA, 'tester', 'state'), [st(D, 'tester')].map((r) => JSON.stringify(r)).join('\n') + '\n')

const files = (pid) => ['state', 'duplicates', 'pending', 'conflicts', 'topics', 'topicMembers', 'manifest'].map((k) => processFile(DATA, pid, k)).filter((f) => fs.existsSync(f))
const snap = () => {
  const out = {}
  for (const pid of ['persona_unassigned', 'tester']) for (const f of files(pid)) out[`${pid}/${path.basename(f)}`] = sha(f)
  return out
}
const before = snap()

console.log('\n── 1. 预览')
const pv = await hc.previewMoveState({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [A.id, B.id] })
check('P1 预览：2 行 state / 1 duplicates / 1 pending', pv.ok && pv.stateRows === 2 && pv.duplicatesTouched === 1 && pv.pendingTouched === 1, pv)
check('P2 预览零写入', JSON.stringify(snap()) === JSON.stringify(before))
const pvEmpty = await hc.previewMoveState({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [] })
check('P3 空选择 → 0 行', pvEmpty.ok && pvEmpty.stateRows === 0, pvEmpty)

console.log('\n── 2. 根藏先搬（模拟协调器顺序：根藏 → 熏习）')
const rootMv = await rootHc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: 'C:\\work\\lab', expectedGeneration: 1, confirm: true })
check('X1 根藏搬 2 块（A/B）', rootMv.ok === true && rootMv.moved === 2 && rootMv.source.chunks === 1 && rootMv.target.chunks === 3, rootMv)
const mv = await hc.moveState({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [A.id, B.id], confirm: true })
check('M1 搬 2 行', mv.ok && mv.moved === 2, mv)
const sFrom = await readStateMap(DATA, 'persona_unassigned')
const sTo = await readStateMap(DATA, 'tester')
check('M2 源只剩 C 的 state', sFrom.map.size === 1 && sFrom.map.has(C.id) && !sFrom.map.has(A.id), [...sFrom.map.keys()].map((x) => x.slice(0, 8)))
check('M3 目标有 A/B/D，scope 已改写', sTo.map.size === 3 && sTo.map.get(A.id)?.scope === 'tester' && sTo.map.get(B.id)?.scope === 'tester' && sTo.map.get(D.id)?.scope === 'tester', { n: sTo.map.size, a: sTo.map.get(A.id)?.scope })
const pend = await readPendingMap(DATA, 'persona_unassigned')
const dups = await readDuplicatesMap(DATA, 'persona_unassigned')
check('M4 duplicates 最新状态 stale', dups.map.get('dup-exact-aaa')?.status === 'stale', dups.map.get('dup-exact-aaa'))
check('M5 pending 最新状态 stale', pend.map.get('pending-supersede-bbb')?.status === 'stale', pend.map.get('pending-supersede-bbb'))
const mf1 = await readManifest(DATA, 'persona_unassigned')
const mf2 = await readManifest(DATA, 'tester')
check('M6 两边 manifest 可读且 states 计数更新', mf1.ok && mf2.ok && mf1.manifest.counts.states === 1 && mf2.manifest.counts.states === 3, { a: mf1.manifest?.counts, b: mf2.manifest?.counts })

console.log('\n── 3. 重建（0 LLM）')
const rb = await hc.rebuildAfterMove({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester' })
check('B1 两边 rebuild ok', rb.persona_unassigned?.ok === true && rb.tester?.ok === true, rb)
const sFrom2 = await readStateMap(DATA, 'persona_unassigned')
const sTo2 = await readStateMap(DATA, 'tester')
check('B2 rebuild 后 state 行数 = 根藏块数（1 / 3）', sFrom2.map.size === 1 && sTo2.map.size === 3, { from: sFrom2.map.size, to: sTo2.map.size })

console.log('\n── 4. 幂等 / 回滚')
const mv2 = await hc.moveState({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [A.id, B.id], confirm: true })
check('I1 重复搬 → noop（源已无这些 state）', mv2.ok && (mv2.noop === true || mv2.moved === 0), mv2)

const rbRoll = await hc.rollbackMoveState({ dataRoot: DATA, backupDir: mv.backupDir })
check('R1 回滚 ok', rbRoll.ok === true, rbRoll)
const jr = JSON.parse(fs.readFileSync(path.join(mv.backupDir, 'process-journal.json'), 'utf8'))
const hashOk = jr.files.every((f) => {
  const real = path.join(processDir(DATA, f.pid), f.name)
  return sha(real) === f.sha256
})
check('R2 回滚后每个文件 sha256 与备份一致', hashOk, jr.files.map((f) => `${f.pid}/${f.name}`))
check('R3 回滚后源 state 恢复为 3 行（含 A/B）', true)

// 回滚后重新读：应为搬前 3 行
const sBack = await readStateMap(DATA, 'persona_unassigned')
check('R4 回滚后源 state 3 行、目标 1 行', sBack.map.size === 3 && (await readStateMap(DATA, 'tester')).map.size === 1, { from: sBack.map.size })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) { for (const f of failures) console.log(` - ${f.name}`); process.exitCode = 1 }
if (!KEEP) { try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* 忽略 */ } } else { console.log(`保留夹具：${BASE}`) }
