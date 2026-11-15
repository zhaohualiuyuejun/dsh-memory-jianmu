#!/usr/bin/env node
/**
 * tools/lifecycle-selftest.mjs —— P4 #8 配套：人格归属诊断的「软认领」口径（离线）
 *
 * 验证 lifecycle.mjs：
 *   · 未归属桶里、ws 已被 identity 映射的块 → claimedChunks（不再当“不健康”）；
 *   · 没映射的 → pureChunks（继续告警）；
 *   · byWorkspace 带 claimedBy；summary.healthy 只看 pure；
 *   · scopes[] 每人格块数 / 是否有卡 / 是否注册。
 *
 * 用法：node tools/lifecycle-selftest.mjs [--keep]
 * 退出码：0 = 全绿；1 = 有失败
 */
import fs from 'node:fs'
import path from 'node:path'

import { personaLifecycle } from '../lib/lifecycle.mjs'

const keep = process.argv.includes('--keep')
const BASE = path.join('C:/work/alice/tmp', `lifecycle-selftest-${Date.now()}`)
fs.mkdirSync(BASE, { recursive: true })

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}

const DIM = 4
const chunk = (id, text, ws, personaId) => ({
  id, kind: 'utterance', contractVersion: 1, session: `s-${id}`, messageId: `m-${id}`, seq: 1, part: 0,
  role: 'user', sourceType: 'user', t: 1791000000000, text, ws, personaId,
})
function writeScope(pid, chunks) {
  const dir = path.join(BASE, 'scopes', pid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length ? '\n' : ''))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, contractVersion: 1, generation: 1, personaId: pid, displayName: pid,
    dim: DIM, chunks: chunks.length, provider: 'local', model: 'test', normalizerVersion: 'l2-v1',
    builtAt: '2026-11-12T00:00:00.000Z',
  }, null, 2))
}
function writeIdentity(workspaces) {
  fs.writeFileSync(path.join(BASE, 'identity.json'), JSON.stringify({
    version: 1, defaultPersonaId: null,
    personas: { alice: { displayName: 'Alice' } },
    workspaces, sessions: {},
  }, null, 2))
}

writeScope('alice', [chunk('z1', '本 scope 的块', 'C:\\work\\alice', 'alice')])
writeScope('persona_unassigned', [
  chunk('u1', '旧块 1', 'H:\\lab workspace', 'persona_unassigned'),
  chunk('u2', '旧块 2', 'H:\\lab workspace', 'persona_unassigned'),
  chunk('u3', '别处的块', 'H:\\other', 'persona_unassigned'),
])
fs.mkdirSync(path.join(BASE, 'persona', 'cards', 'alice'), { recursive: true })
fs.writeFileSync(path.join(BASE, 'persona', 'cards', 'alice', 'card.md'), '---\nid: "alice"\nname: "Alice"\npersonaId: "alice"\nmemoryScope: "alice"\n---\n\n# Alice\n')
fs.writeFileSync(path.join(BASE, 'persona', 'registry.json'), JSON.stringify({
  schemaVersion: 1, contractVersion: 1, generation: 1, activeCardId: 'alice',
  cards: { alice: { name: 'Alice', status: 'active', source: 'manual', version: 1 } },
  workspaces: { 'H:\\lab workspace': 'alice' }, workspaceList: ['H:\\lab workspace'], sessions: {},
  settings: {}, updatedAt: Date.now(),
}, null, 2))

// ── 1. 已映射的未归属块 → 软认领 ──────────────────────────────────────────
writeIdentity({ 'C:\\work\\alice': 'alice', 'H:\\lab workspace': 'alice' })
console.log('\n── 1. 已映射 → claimed')
let r = await personaLifecycle(BASE)
check('L1 ok', r.ok === true)
check('L2 总数 3 / 已软认领 2 / 纯未归属 1',
  r.unassigned.chunks === 3 && r.unassigned.claimedChunks === 2 && r.unassigned.pureChunks === 1,
  r.unassigned)
const lab = (r.unassigned.byWorkspace || []).find((x) => x.ws === 'H:\\lab workspace')
check('L3 byWorkspace 带 claimedBy', lab?.claimedBy === 'alice' && lab?.chunks === 2, lab)
const other = (r.unassigned.byWorkspace || []).find((x) => x.ws === 'H:\\other')
check('L4 未映射工作区没有 claimedBy', other && !other.claimedBy, other)
check('L5 healthy 只看纯未归属（=false 因为有 1 条纯的）', r.summary.healthy === false && r.summary.unassignedPure === 1 && r.summary.unassignedClaimed === 2, r.summary)
check('L6 告警区分软认领', r.warnings.some((w) => w.includes('已软认领 2 条')) && r.warnings.some((w) => w.includes('未归属块 1 条')), r.warnings)

// ── 2. 撤销映射 → 全部变纯未归属 ──────────────────────────────────────────
console.log('\n── 2. 撤销映射 → pure')
writeIdentity({ 'C:\\work\\alice': 'alice' })
r = await personaLifecycle(BASE)
check('L7 撤销后 3 条全是纯未归属', r.unassigned.pureChunks === 3 && r.unassigned.claimedChunks === 0, r.unassigned)
check('L8 healthy=false 且告警恢复', r.summary.healthy === false && r.warnings.some((w) => w.includes('未归属块 3 条')), r.warnings)

// ── 3. 全被软认领 → healthy ───────────────────────────────────────────────
console.log('\n── 3. 全部软认领 → healthy（前提：卡/注册都正常）')
writeIdentity({ 'C:\\work\\alice': 'alice', 'H:\\lab workspace': 'alice', 'H:\\other': 'alice' })
r = await personaLifecycle(BASE)
check('L9 全部软认领：纯未归属 0', r.unassigned.pureChunks === 0 && r.unassigned.claimedChunks === 3, r.unassigned)
check('L10 healthy=true（软认领不算不健康）', r.summary.healthy === true, { summary: r.summary, cardless: r.cardlessPersonas, unreg: r.unregisteredCards })

// ── 4. scopes[] 只读摘要 ─────────────────────────────────────────────────
console.log('\n── 4. scopes[]')
check('L11 scopes 含 alice 且带块数/卡/注册', (r.scopes || []).some((s) => s.personaId === 'alice' && s.chunks === 1 && s.hasCard === true && s.inIdentity === true), r.scopes)
check('L12 scopes 不含 persona_unassigned', !(r.scopes || []).some((s) => s.personaId === 'persona_unassigned'), r.scopes)

// ── 汇总 ─────────────────────────────────────────────────────────────────
if (keep) console.log(`\n  夹具保留：${BASE}`)
else { try { fs.rmSync(BASE, { recursive: true, force: true }) } catch {} }
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
  process.exit(1)
}
