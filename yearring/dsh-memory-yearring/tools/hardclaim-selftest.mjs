#!/usr/bin/env node
/**
 * tools/hardclaim-selftest.mjs —— 年轮硬认领自测（零 API、零 LLM、零网络）
 *
 * 覆盖计划 S3：
 *   1. 整组全锚点 → 搬（claimGroupId / claimId 按新 persona 重算）
 *   2. 混合锚点 → 保留 + warning（不改写锚点）
 *   3. 目标已有同组 → revision 续接；同证据 → 跳过
 *   4. topic_docs 两边重建（0 LLM）
 *   5. verify：全锚点场景 orphan=0；混合场景 orphan = 预览的 mixedAnchor
 *   6. 回滚：claims/manifest/topic_docs 整文件恢复
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const KEEP = process.argv.includes('--keep')
const STAMP = Date.now()
const BASE = path.join('C:/work/alice/tmp', `year-hardclaim-${STAMP}`)
const DATA = path.join(BASE, 'root')
const DSH = path.join(BASE, 'dshhome')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

const rootStore = await import('../../../root/lib/store.mjs')
const rootHc = await import('../../../root/lib/hardclaim.mjs')
const { makeUtterance } = await import('../../../root/lib/chunks.mjs')
const hc = await import('../lib/hardclaim.mjs')
const { claimGroupIdOf, claimIdOf, derivedFromHashOf } = await import('../lib/claim.mjs')
const { yearDir, yearFile, topicDocsDir } = await import('../lib/paths.mjs')
const { readClaims, readManifest, writeManifest, emptyManifest } = await import('../lib/store.mjs')
const { verifyYear } = await import('../lib/verify.mjs')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`) }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const T = Date.now() - 3600_000

const mk = (text, pid, i, ws = 'C:\\work\\lab') => makeUtterance({
  session: `lab-${i}`, messageId: `m-${i}`, seq: 1, text, role: 'user', t: T, ws, personaId: pid,
})
const A = mk('旧记忆一：生日是三月五号', 'persona_unassigned', 1)
const B = mk('旧记忆二：面馆在东门', 'persona_unassigned', 2)
const C = mk('旧记忆三：周末去爬山', 'persona_unassigned', 3, 'H:\\other place')
const D = mk('测试员自己的新记忆', 'tester', 4)

function mkClaim(pid, kind, title, chunks, revision = 1) {
  const groupId = claimGroupIdOf(pid, kind, title)
  const anchors = chunks.map((c) => ({
    chunkId: c.id, session: c.session, messageId: c.messageId, seq: c.seq, part: 0, t: c.t, quote: c.text.slice(0, 20),
  }))
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

console.log('\n── 0. 夹具：根藏 3+1；年轮 5 条（搬组 / 混合组 / 留守组 / 草稿）')
const w1 = await rootStore.writeScopeBundle({
  dataRoot: DATA, personaId: 'persona_unassigned', utterances: [A, B, C],
  vectors: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], embedding: { provider: 'local', model: 'test-model', dim: 4 }, reason: 'year-hardclaim-selftest',
})
const w2 = await rootStore.writeScopeBundle({
  dataRoot: DATA, personaId: 'tester', utterances: [D],
  vectors: [0, 0, 0, 1], embedding: { provider: 'local', model: 'test-model', dim: 4 }, reason: 'year-hardclaim-selftest',
})
check('F1 根藏夹具', w1.ok && w2.ok && w1.chunks === 3 && w2.chunks === 1, { w1, w2 })
fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1, defaultPersonaId: null,
  personas: { alice: { displayName: 'Alice' }, tester: { displayName: '测试员' } },
  workspaces: { 'C:\\work\\alice': 'alice' }, sessions: {},
}, null, 2))

const G1a = mkClaim('persona_unassigned', 'fact', '旧记忆：生日与面馆', [A, B], 1)
const G1b = mkClaim('persona_unassigned', 'fact', '旧记忆：生日与面馆', [A, B], 2)
const G2 = mkClaim('persona_unassigned', 'event', '混合：生日与爬山', [A, C], 1)
const G3 = mkClaim('persona_unassigned', 'event', '留守：只有爬山', [C], 1)
const G4 = { ...mkClaim('persona_unassigned', 'fact', '草稿：无锚点', [], 1), status: 'draft', derivedFrom: [], derivedFromHash: derivedFromHashOf([]) }
const GT = mkClaim('tester', 'fact', '旧记忆：生日与面馆', [D], 1) // 目标同标题组 → revision 续接

fs.mkdirSync(yearDir(DATA, 'persona_unassigned'), { recursive: true })
fs.mkdirSync(yearDir(DATA, 'tester'), { recursive: true })
fs.mkdirSync(topicDocsDir(DATA, 'persona_unassigned'), { recursive: true })
fs.mkdirSync(topicDocsDir(DATA, 'tester'), { recursive: true })
fs.writeFileSync(yearFile(DATA, 'persona_unassigned', 'claims'), [G1a, G1b, G2, G3, G4].map((c) => JSON.stringify(c)).join('\n') + '\n')
fs.writeFileSync(yearFile(DATA, 'tester', 'claims'), [GT].map((c) => JSON.stringify(c)).join('\n') + '\n')
for (const pid of ['persona_unassigned', 'tester']) {
  const m = { ...emptyManifest(pid), generation: 1, counts: { ...emptyManifest(pid).counts } }
  fs.writeFileSync(yearFile(DATA, pid, 'manifest'), JSON.stringify(m, null, 2) + '\n')
}

const files = (pid) => {
  const out = []
  const dir = yearDir(DATA, pid)
  for (const n of ['claims.jsonl', 'manifest.json']) if (fs.existsSync(path.join(dir, n))) out.push(path.join(dir, n))
  try { for (const n of fs.readdirSync(path.join(dir, 'topic_docs'))) if (n.endsWith('.md')) out.push(path.join(dir, 'topic_docs', n)) } catch { /* 无 docs */ }
  return out
}
const snap = () => { const o = {}; for (const pid of ['persona_unassigned', 'tester']) for (const f of files(pid)) o[`${pid}/${path.relative(yearDir(DATA, pid), f).replace(/\\/g, '/')}`] = sha(f); return o }
const before = snap()

console.log('\n── 1. 预览')
const pv = await hc.previewMoveClaims({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [A.id, B.id] })
check('P1 预览：move=2（整组）/ mixed=1 / stay=2', pv.ok && pv.move === 2 && pv.mixedAnchor === 1 && pv.stay === 2, pv)
check('P2 预览 orphanAfter=1（混合组里被搬走的锚点）', pv.ok && pv.orphanAfter === 1, pv.orphanAfter)
check('P3 预览零写入', JSON.stringify(snap()) === JSON.stringify(before))

console.log('\n── 2. 根藏先搬（A/B）')
const rootMv = await rootHc.applyHardClaim({ dataRoot: DATA, to: 'tester', workspace: 'C:\\work\\lab', expectedGeneration: 1, confirm: true })
check('X1 根藏搬 2 块', rootMv.ok && rootMv.moved === 2 && rootMv.source.chunks === 1 && rootMv.target.chunks === 3, rootMv)

console.log('\n── 3. 搬 claims')
const mv = await hc.moveClaims({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [A.id, B.id], confirm: true })
check('M1 搬 2 条（G1 rev1/rev2）/ 混合 1 条', mv.ok && mv.moved === 2 && mv.mixedAnchor === 1, mv)
const srcC = await readClaims(DATA, 'persona_unassigned')
const tgtC = await readClaims(DATA, 'tester')
check('M2 源只剩 G2/G3/G4（3 条）', srcC.unique === 3, [...srcC.byId.values()].map((c) => c.title))
check('M3 目标 3 条（原 GT + 搬入 2）', tgtC.unique === 3, [...tgtC.byId.values()].map((c) => `${c.title}#${c.revision}`))
const movedOnes = [...tgtC.byId.values()].filter((c) => c.hardClaimFrom === 'persona_unassigned').sort((a, b) => a.revision - b.revision)
check('M4 搬入 claim 的 personaId / groupId / claimId 已按 tester 重算', movedOnes.length === 2 && movedOnes.every((c) =>
  c.personaId === 'tester'
  && c.claimGroupId === claimGroupIdOf('tester', c.kind, c.title)
  && c.claimId === claimIdOf({ personaId: 'tester', kind: c.kind, claimGroupId: c.claimGroupId, derivedFromHash: c.derivedFromHash, revision: c.revision })), movedOnes)
check('M5 revision 续接（目标原 rev1 → 搬入 rev2/rev3）', movedOnes.length === 2 && movedOnes[0].revision === 2 && movedOnes[1].revision === 3, movedOnes.map((c) => c.revision))
check('M6 混合组 G2 仍在源、锚点原样', [...srcC.byId.values()].some((c) => c.title === '混合：生日与爬山' && c.derivedFrom.length === 2), [...srcC.byId.values()].map((c) => c.title))

console.log('\n── 4. topic_docs 重建 + verify')
const rb = await hc.rebuildAfterMove({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester' })
check('B1 两边 rebuild ok', rb.persona_unassigned?.ok === true && rb.tester?.ok === true, rb)
const vSrc = await verifyYear({ dataRoot: DATA, personaId: 'persona_unassigned' })
const vTgt = await verifyYear({ dataRoot: DATA, personaId: 'tester' })
check('V1 目标 verify ok（无 orphan / 无 id 不一致）', vTgt.ok === true, { problems: vTgt.problems?.map((p) => p.code), warnings: vTgt.warnings?.map((w) => w.code) })
check('V2 源 orphan = 预览的 1（混合锚点已知限制）', vSrc.summary?.anchors?.orphan === 1, vSrc.summary?.anchors)
check('V3 目标 topic_docs 已生成', (vTgt.summary?.topicDocs ?? 0) > 0, vTgt.summary?.topicDocs)
check('V4 doc 引用的 claim 都存在（无 dangling）', vTgt.ok === true)

console.log('\n── 5. 幂等 / 回滚')
const mv2 = await hc.moveClaims({ dataRoot: DATA, from: 'persona_unassigned', to: 'tester', chunkIds: [A.id, B.id], confirm: true })
check('I1 重复搬 → noop', mv2.ok && (mv2.noop === true || mv2.moved === 0), mv2)
const rbRoll = await hc.rollbackMoveClaims({ dataRoot: DATA, backupDir: mv.backupDir })
check('R1 回滚 ok', rbRoll.ok === true, rbRoll)
const after = snap()
check('R2 回滚后 claims/manifest/topic_docs 与搬前一致（派生 docs 允许差异）', (() => {
  // claims + manifest 必须逐字节复原；topic_docs 在 rebuild 时被重写，回滚会把备份内容放回
  const keys = Object.keys(before)
  return keys.filter((k) => !k.includes('topic_docs')).every((k) => {
    const pid = k.split('/')[0]
    const rel = k.slice(pid.length + 1)
    return sha(path.join(yearDir(DATA, pid), rel)) === before[k]
  })
})(), { before: Object.keys(before), after: Object.keys(after) })
const srcBack = await readClaims(DATA, 'persona_unassigned')
check('R3 回滚后源 claims 恢复 5 条（含 G1）', srcBack.unique === 5, srcBack.unique)
check('R4 回滚后目标 claims 恢复 1 条', (await readClaims(DATA, 'tester')).unique === 1)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) { for (const f of failures) console.log(` - ${f.name}`); process.exitCode = 1 }
if (!KEEP) { try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* 忽略 */ } } else { console.log(`保留夹具：${BASE}`) }
