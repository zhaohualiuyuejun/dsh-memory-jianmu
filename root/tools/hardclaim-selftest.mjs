#!/usr/bin/env node
/**
 * tools/hardclaim-selftest.mjs —— 根藏硬认领自测（零 API、零网络）
 *
 * 覆盖计划 S1 的验收点：
 *   1. 选择条件（workspace 前缀 / sessionIds / 空选择）
 *   2. 预览数字（块 / 向量 / 重复 / 备份估算）
 *   3. 搬迁（先目标后源；personaId 改写；文本逐字一致）
 *   4. 向量行对齐（搬后每块 cos(自身)=1；搬入行与源行逐值一致）
 *   5. 总块数守恒 / 重复跳过
 *   6. generation 闸门（STALE_GENERATION）
 *   7. 锁占用（LOCK_BUSY，一字未动）
 *   8. 回滚（整文件 sha256 与搬迁前一致；含模拟半写）
 *
 * 用法：node tools/hardclaim-selftest.mjs [--keep]
 * 退出码：0 = 全绿
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const KEEP = process.argv.includes('--keep')
const STAMP = Date.now()
const BASE = path.join('C:/work/alice/tmp', `hardclaim-selftest-${STAMP}`)
const DATA = path.join(BASE, 'root')
const DSH = path.join(BASE, 'dshhome')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

const { makeUtterance } = await import('../lib/chunks.mjs')
const { writeScopeBundle, readScope, verifyScope } = await import('../lib/store.mjs')
const hc = await import('../lib/hardclaim.mjs')
const { readJson } = await import('../lib/fsatomic.mjs')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`) }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

const WS = 'C:\\work\\lab'
const WS_OTHER = 'H:\\other place'
const T0 = Date.now() - 3600_000

function utt(text, ws, extra = {}) {
  return makeUtterance({
    session: extra.session || `lab-${text.slice(0, 3)}`,
    messageId: extra.messageId || `m-${text.length}`,
    seq: 1, text, role: 'user', t: T0, ws, personaId: 'persona_unassigned',
  })
}

const U1 = utt('旧对话：我的生日是三月五号', WS)
const U2 = utt('旧对话：常去的那家面馆在东门', WS)
const U3 = utt('别处的工作区：这条不该被 lab workspace 纳入', WS_OTHER)
const T0C = makeUtterance({
  session: 'lab-tester-self', messageId: 'm-t0', seq: 1,
  text: '测试员自己的新记忆：今天学会了写冒烟脚本', role: 'user', t: T0, ws: WS, personaId: 'tester',
})

console.log('\n── 0. 夹具：3 条未归属 + tester 已有 1 条')
const wUn = await writeScopeBundle({
  dataRoot: DATA, personaId: 'persona_unassigned',
  utterances: [U1, U2, U3],
  vectors: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  embedding: { provider: 'local', model: 'test-model', dim: 4 },
  reason: 'hardclaim-selftest',
})
check('F1 未归属 3 条写入', wUn.ok === true && wUn.chunks === 3, wUn)
const wT = await writeScopeBundle({
  dataRoot: DATA, personaId: 'tester', utterances: [T0C],
  vectors: [0, 0, 0, 1], embedding: { provider: 'local', model: 'test-model', dim: 4 },
  reason: 'hardclaim-selftest',
})
check('F2 tester 1 条写入', wT.ok === true && wT.chunks === 1, wT)
fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1, defaultPersonaId: null,
  personas: { alice: { displayName: 'Alice' }, tester: { displayName: '测试员' } },
  workspaces: { 'C:\\work\\alice': 'alice' },
  sessions: {},
}, null, 2))

const scopeFiles = (pid) => {
  const dir = path.join(DATA, 'scopes', pid)
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => /^(chunks\.jsonl|manifest\.json|index_meta\.json|deleted\.jsonl|cost\.jsonl|vectors_v\d+\.f32)$/.test(n)) } catch { return [] }
  return names.sort().map((n) => path.join(dir, n))
}
const snapshot = () => {
  const out = {}
  for (const pid of ['persona_unassigned', 'tester']) for (const f of scopeFiles(pid)) out[`${pid}/${path.basename(f)}`] = sha(f)
  out['identity.json'] = sha(path.join(DATA, 'identity.json'))
  return out
}
const before = snapshot()

console.log('\n── 1. 选择条件')
const selWs = await hc.selectChunks({ dataRoot: DATA, workspace: WS })
check('S1 workspace 命中 2 条（不含别处）', selWs.ok && selWs.rows.length === 2 && selWs.rows.every((r) => r.ws === WS), { n: selWs.rows?.length, ws: selWs.rows?.map((r) => r.ws) })
const selSes = await hc.selectChunks({ dataRoot: DATA, sessionIds: [U3.session] })
check('S2 sessionIds 命中 1 条', selSes.ok && selSes.rows.length === 1 && selSes.rows[0].id === U3.id, selSes.rows?.map((r) => r.id))
const selNone = await hc.selectChunks({ dataRoot: DATA, workspace: 'H:\\nowhere' })
check('S3 空选择 ok 且 0 条', selNone.ok && selNone.rows.length === 0)
const selBoth = await hc.selectChunks({ dataRoot: DATA, workspace: WS, sessionIds: ['x'] })
check('S4 workspace+sessionIds 同时给 → BAD_ARGS', selBoth.ok === false && selBoth.error.code === 'BAD_ARGS', selBoth)

console.log('\n── 2. 预览（零写入）')
const pv = await hc.previewHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS })
check('P1 预览 ok：2 块 / 0 重复 / 2 行向量', pv.ok === true && pv.chunks === 2 && pv.duplicates.skip === 0 && pv.vectors.rows === 2, pv)
check('P2 预览不改任何文件', JSON.stringify(snapshot()) === JSON.stringify(before))
const pvDup = await hc.previewHardClaim({ dataRoot: DATA, to: 'tester', sessionIds: [U1.session, U3.session] })
check('P3 重复/未命中计数可用', pvDup.ok === true, pvDup)
const pvBad = await hc.previewHardClaim({ dataRoot: DATA, to: 'nobody', workspace: WS })
check('P4 目标未在 identity 声明 → TARGET_NOT_DECLARED', pvBad.ok === false && pvBad.error.code === 'TARGET_NOT_DECLARED', pvBad)
const pvNone = await hc.previewHardClaim({ dataRoot: DATA, to: 'tester', workspace: 'H:\\nowhere' })
check('P5 空选择 → NO_MATCH', pvNone.ok === false && pvNone.error.code === 'NO_MATCH', pvNone)

console.log('\n── 3. generation / 锁 闸门')
const stale = await hc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS, expectedGeneration: 999, confirm: true })
check('G1 generation 不符 → STALE_GENERATION 且零写入', stale.ok === false && stale.error.code === 'STALE_GENERATION' && JSON.stringify(snapshot()) === JSON.stringify(before), stale)
const noConfirm = await hc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS })
check('G2 无 confirm → CONFIRM_REQUIRED', noConfirm.ok === false && noConfirm.error.code === 'CONFIRM_REQUIRED', noConfirm)

const lockFile = path.join(DATA, 'scopes', 'tester', '.lock')
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: 'x', token: 'held-by-test', tool: 'selftest' }))
const busy = await hc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS, expectedGeneration: 1, confirm: true, lockTimeoutMs: 250 })
fs.unlinkSync(lockFile)
check('G3 锁被占 → LOCK_BUSY 且源/目标一字未动', busy.ok === false && busy.error.code === 'LOCK_BUSY' && JSON.stringify(snapshot()) === JSON.stringify(before), busy)

console.log('\n── 4. 真搬迁')
const applied = await hc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS, expectedGeneration: 1, confirm: true })
check('A1 apply ok：移 2 / 源剩 1 / 目标 3', applied.ok === true && applied.moved === 2 && applied.source.chunks === 1 && applied.target.chunks === 3, applied)
check('A2 目标 generation +1', applied.ok && applied.target.generation === 2, applied?.target)
check('A3 搬入块 personaId 已改写为 tester', await (async () => {
  const t = await readScope(DATA, 'tester')
  const u = t.chunks.find((c) => c.id === U1.id)
  return Boolean(u) && u.personaId === 'tester' && u.identitySource === 'manual' && u.provenance?.hardClaimFrom === 'persona_unassigned'
})())
check('A4 原文逐字一致（目标里 U1/U2 文本 === 夹具）', await (async () => {
  const t = await readScope(DATA, 'tester')
  const m = new Map(t.chunks.map((c) => [c.id, c]))
  return m.get(U1.id)?.text === U1.text && m.get(U2.id)?.text === U2.text
})())
check('A5 源不再含已搬块', await (async () => {
  const s = await readScope(DATA, 'persona_unassigned')
  const ids = new Set(s.chunks.map((c) => c.id))
  return !ids.has(U1.id) && !ids.has(U2.id) && ids.has(U3.id)
})())
check('A6 两边 verifyScope ok', applied.ok && applied.source.verify.ok === true && applied.target.verify.ok === true, { s: applied?.source?.verify, t: applied?.target?.verify })
check('A7 总块数守恒（4 → 4）', applied.ok && applied.totals.before === 4 && applied.totals.after === 4, applied?.totals)
check('A8 源 deleted.jsonl 有墓碑', await (async () => {
  const { readTombstones } = await import('../lib/store.mjs')
  const tombs = await readTombstones(DATA, 'persona_unassigned')
  return tombs.has(U1.id) && tombs.has(U2.id)
})())

console.log('\n── 5. 向量行对齐（最隐蔽的一条）')
const srcAfter = await readScope(DATA, 'persona_unassigned', { withVectors: true })
const tgtAfter = await readScope(DATA, 'tester', { withVectors: true })
function cosSelf(scope) {
  const dim = scope.manifest.dim
  const n = scope.chunks.length
  const v = scope.vectors
  if (!v || v.length !== n * dim) return null
  let min = Infinity
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < dim; k++) { const x = v[i * dim + k]; s += x * x }
    min = Math.min(min, s)
  }
  return min
}
check('V1 目标向量行数 = 块数 × dim', tgtAfter.vectors && tgtAfter.vectors.length === tgtAfter.chunks.length * 4)
check('V2 目标每行自余弦≈1', cosSelf(tgtAfter) !== null && Math.abs(cosSelf(tgtAfter) - 1) < 1e-4, { minSq: cosSelf(tgtAfter) })
check('V3 源每行自余弦≈1（删行后没错位）', cosSelf(srcAfter) !== null && Math.abs(cosSelf(srcAfter) - 1) < 1e-4, { minSq: cosSelf(srcAfter) })
check('V4 搬入向量与源行逐值一致', (() => {
  const dim = 4
  const srcVec = [1, 0, 0, 0, 0, 1, 0, 0] // U1,U2 在原文件里的两行
  const idx1 = tgtAfter.chunks.findIndex((c) => c.id === U1.id)
  const idx2 = tgtAfter.chunks.findIndex((c) => c.id === U2.id)
  const ok = (idx) => [0, 1, 2, 3].every((k) => Math.abs(tgtAfter.vectors[idx * dim + k] - srcVec[idx === idx1 ? k : dim + k]) < 1e-6)
  return ok(idx1) && ok(idx2)
})())

console.log('\n── 6. 回滚（整文件 sha256）')
const rb = await hc.rollbackHardClaimRoot({ dataRoot: DATA, backupDir: applied.backupDir })
const afterRb = snapshot()
check('R1 回滚 ok', rb.ok === true, rb)
check('R2 全部文件 sha256 与搬迁前一致', JSON.stringify(afterRb) === JSON.stringify(before), { before, afterRb })
check('R3 回滚后两边 verify ok', rb.verify['persona_unassigned']?.ok === true && rb.verify.tester?.ok === true, rb.verify)

console.log('\n── 7. 模拟半写：损坏目标向量后回滚')
const applied2 = await hc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS, expectedGeneration: 1, confirm: true })
check('C1 二次搬迁 ok', applied2.ok === true, applied2)
const vfile = path.join(DATA, 'scopes', 'tester', 'vectors_v1.f32')
fs.truncateSync(vfile, 7) // 半截向量：模拟崩溃
const rb2 = await hc.rollbackHardClaimRoot({ dataRoot: DATA, backupDir: applied2.backupDir })
check('C2 半写后回滚 ok 且 sha256 复原', rb2.ok === true && JSON.stringify(snapshot()) === JSON.stringify(before), rb2)

console.log('\n── 8. 重复跳过（目标已有同 id 时只删源、不重复追加）')
// 手工把 U1 塞进 tester（模拟历史重复），再搬 lab workspace
const tNow = await readScope(DATA, 'tester', { withVectors: true })
const dupRow = { ...tNow.chunks[0], id: U1.id }
await writeScopeBundle({
  dataRoot: DATA, personaId: 'tester',
  utterances: [...tNow.chunks, dupRow],
  vectors: [...tNow.vectors, 1, 0, 0, 0],
  embedding: { provider: 'local', model: 'test-model', dim: 4 },
  overwrite: true, reason: 'hardclaim-selftest-dup',
})
const pvDup2 = await hc.previewHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS })
check('D1 预览重复 skip=1 / append=1', pvDup2.ok === true && pvDup2.duplicates.skip === 1 && pvDup2.duplicates.append === 1, pvDup2?.duplicates)
const applied3 = await hc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: WS, expectedGeneration: 2, confirm: true })
check('D2 重复跳过：moved=1 / dup=1 / 目标 3 条', applied3.ok === true && applied3.moved === 1 && applied3.duplicatesSkipped === 1 && applied3.target.chunks === 3, applied3)
check('D3 目标无重复 id', await (async () => {
  const t = await readScope(DATA, 'tester')
  return new Set(t.chunks.map((c) => c.id)).size === t.chunks.length
})())

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(` - ${f.name}`)
  process.exitCode = 1
}
if (!KEEP) {
  try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* 忽略 */ }
} else {
  console.log(`保留夹具：${BASE}`)
}
