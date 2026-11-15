#!/usr/bin/env node
/**
 * tools/write-chain-smoke.mjs —— P1-1 写动作链路冒烟（2026-11-08）
 *
 * 验证：建候选 → 应用 → 驳回 → confirm 闸 → 旧代际闸 → 原文零改动。
 * 全部在临时目录里跑，不碰真实数据；不需要重启 DSH。
 *
 * 用法：node tools/write-chain-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { runProcess } from '../lib/run.mjs'
import { createManualPending, applyPending, dismissPending } from '../lib/apply.mjs'
import { readManifest, readStateMap, readPendingMap } from '../lib/store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jianmu-p11-'))
fs.mkdirSync(path.join(root, 'scopes', 'alice'), { recursive: true })
fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify({ version: 1, defaultPersonaId: 'alice', personas: { alice: { displayName: 'Alice' } }, workspaces: {}, sessions: {} }))
const base = { kind: 'utterance', personaId: 'alice', role: 'user', session: 's1', ws: 'H:/x', channel: 'dsh', sourceType: 'message', retention: 'active', contractVersion: 1 }
const rows = [
  { ...base, id: 'c1', text: '我喜欢喝咖啡', t: 1000, anchorKey: 'a1' },
  { ...base, id: 'c2', text: '明天要下雨', t: 2000, anchorKey: 'a2' },
  { ...base, id: 'c3', text: '项目代号是建木', t: 3000, role: 'assistant', anchorKey: 'a3' },
]
const chunksFile = path.join(root, 'scopes', 'alice', 'chunks.jsonl')
fs.writeFileSync(chunksFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
fs.writeFileSync(path.join(root, 'scopes', 'alice', 'manifest.json'), JSON.stringify({
  contractVersion: 1, personaId: 'alice', displayName: 'Alice', generation: 1, chunks: rows.length,
  builtAt: '2026-11-08T00:00:00.000Z', tMin: 1000, tMax: 3000, identitySource: 'cli', retentionDays: 30,
}, null, 2))
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(chunksFile)).digest('hex')
const before = hash()
const results = []
const ok = (name, cond, detail) => results.push([cond ? '✅' : '❌', name, cond ? '' : JSON.stringify(detail ?? '')])

const run = await runProcess({ dataRoot: root, personaId: 'alice' })
ok('熏习 run 成功', run.ok === true, run)
let man = await readManifest(root, 'alice')

const p1 = await createManualPending({ dataRoot: root, personaId: 'alice', kind: 'expire', chunkIds: ['c1'] })
ok('创建过期候选', p1.ok === true && p1.status === 'pending', p1)
man = await readManifest(root, 'alice')
const ap = await applyPending({ dataRoot: root, personaId: 'alice', pendingIds: [p1.pendingId], expectedGeneration: man.manifest.generation, confirm: true })
ok('应用候选', ap.ok === true && ap.stateRows === 1, ap)
ok('c1 状态=expired', (await readStateMap(root, 'alice')).map.get('c1')?.status === 'expired')
ok('应用有写前快照', Boolean(ap.snapshot), ap.snapshot)

const p2 = await createManualPending({ dataRoot: root, personaId: 'alice', kind: 'archive', chunkIds: ['c2'] })
man = await readManifest(root, 'alice')
const stBefore = (await readStateMap(root, 'alice')).map.get('c2')
const dis = await dismissPending({ dataRoot: root, personaId: 'alice', pendingIds: [p2.pendingId], expectedGeneration: man.manifest.generation, confirm: true })
ok('驳回候选', dis.ok === true && dis.dismissed.length === 1, dis)
ok('候选状态=dismissed', (await readPendingMap(root, 'alice')).map.get(p2.pendingId)?.status === 'dismissed')
const stAfter = (await readStateMap(root, 'alice')).map.get('c2')
ok('驳回不改状态（c2 未变）', (stBefore?.status ?? null) === (stAfter?.status ?? null), { before: stBefore?.status, after: stAfter?.status })

const badConfirm = await applyPending({ dataRoot: root, personaId: 'alice', pendingIds: [p1.pendingId], expectedGeneration: 1, confirm: false })
ok('无 confirm 被拒', badConfirm.ok === false && badConfirm.code === 'CONFIRM_REQUIRED', badConfirm)
const p3 = await createManualPending({ dataRoot: root, personaId: 'alice', kind: 'expire', chunkIds: ['c2'] })
man = await readManifest(root, 'alice')
const stale = await applyPending({ dataRoot: root, personaId: 'alice', pendingIds: [p3.pendingId], expectedGeneration: man.manifest.generation - 1, confirm: true })
ok('旧代际被拒', stale.ok === false && stale.code === 'STALE_GENERATION', stale)
ok('根藏 chunks.jsonl 未被改动', hash() === before)

for (const [mark, name, detail] of results) console.log(mark, name, detail)
const failed = results.filter((r) => r[0] === '❌').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
fs.rmSync(root, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
