#!/usr/bin/env node
/**
 * tools/conflictcards-selftest.mjs —— P2.5 冲突卡（熏习侧）离线单测
 *
 * 零网络、零 API、零真实数据：只测「读 open 冲突 → 拼 A/B 数据」的纪律：
 *   · 只列 open、按 updatedAt 倒序、limit 生效；
 *   · A/B 各 ≤120 字、截断带「…」；缺块 / 跨人格 / 空文本 → 整卡跳过（不猜）；
 *   · 非法 personaId 拒绝；空库/坏行不抛；只读（文件字节前后一致）。
 *
 * 用法：node tools/conflictcards-selftest.mjs [--keep]
 * 退出码：0 = 全绿；1 = 有失败
 */
import fs from 'node:fs'
import path from 'node:path'

import { listConflictCards, clampText, formatTime, clearConflictChunkCache } from '../lib/conflictcards.mjs'

const keep = process.argv.includes('--keep')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const baseDir = path.join('C:/work/alice/tmp', `conflictcards-selftest-${stamp}`)
fs.mkdirSync(baseDir, { recursive: true })

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}

const T = (y, m, d, h = 2) => Date.UTC(y, m - 1, d, h, 0, 0)
const chunk = (id, text, over = {}) => ({
  id, kind: 'utterance', session: over.session ?? 'sess-1', personaId: over.personaId ?? 'alice',
  messageId: `msg-${id}`, seq: over.seq ?? 1, role: over.role ?? 'user', sourceType: over.role ?? 'user',
  t: over.t ?? T(2026, 6, 10), tz: over.tz ?? 'Asia/Shanghai', text,
  ws: 'C:\\work\\alice', channel: 'dsh', attachments: [], retention: 'active',
})
const conflict = (id, ids, over = {}) => ({
  conflictId: id, chunkIds: ids, kind: over.kind ?? 'unexplained-contradiction', status: over.status ?? 'open',
  resolution: null, createdAt: over.createdAt ?? T(2026, 6, 11), updatedAt: over.updatedAt ?? over.createdAt ?? T(2026, 6, 11),
  note: over.note ?? '用户手动标记', ruleRef: null, rootBuiltAt: null,
})

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

function makeRoot(name, { chunks = [], conflicts = [], rawConflictLines = null, manifest = true } = {}) {
  const dir = path.join(baseDir, name)
  const sdir = path.join(dir, 'scopes', 'alice')
  fs.mkdirSync(sdir, { recursive: true })
  if (manifest) {
    fs.writeFileSync(path.join(sdir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, contractVersion: 1, generation: 1, personaId: 'alice', displayName: 'Alice',
      identitySource: 'manual', provider: 'cloud', model: 'test', dim: 8, normalizerVersion: 'l2-v1',
      chunks: chunks.length, sessions: 1, workspaces: 1, builtAt: '2026-06-01T00:00:00.000Z',
    }, null, 2))
  }
  writeJsonl(path.join(sdir, 'chunks.jsonl'), chunks)
  if (rawConflictLines) {
    fs.mkdirSync(path.join(dir, 'process', 'alice'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'process', 'alice', 'conflicts.jsonl'), rawConflictLines.join('\n') + '\n')
  } else {
    writeJsonl(path.join(dir, 'process', 'alice', 'conflicts.jsonl'), conflicts)
  }
  return dir
}

function fileSnapshot(dir) {
  const out = []
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else { const st = fs.statSync(p); out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`) }
    }
  }
  walk(dir)
  return out.sort()
}

// ── 1. 纯函数 ─────────────────────────────────────────────────────────────
console.log('\n── 1. 纯函数（截断 / 日期）')
check('clamp：短文本不动', clampText(' 甲  乙 ', 120) === '甲 乙')
check('clamp：超长截断带省略号', clampText('甲'.repeat(200), 120).length === 120 && clampText('甲'.repeat(200), 120).endsWith('…'))
check('clamp：空文本 → 空串', clampText('   ') === '')
check('formatTime：按上海时区格式化', formatTime(T(2026, 6, 10, 2)) === '2026-06-10 10:00:00', formatTime(T(2026, 6, 10, 2)))
check('formatTime：非法时间 → null', formatTime('not-a-number') === null)

// ── 2. 正常两说 ───────────────────────────────────────────────────────────
console.log('\n── 2. 正常两说（open + 截断 + 字段）')
const root1 = makeRoot('normal', {
  chunks: [
    chunk('c1', '生日是三月五号，我记得很清楚。', { role: 'user', t: T(2026, 6, 10, 2) }),
    chunk('c2', '用户的生日是四月八号。'.repeat(30), { role: 'assistant', t: T(2026, 6, 12, 3) }),
  ],
  conflicts: [
    conflict('conflict-newer', ['c1', 'c2'], { updatedAt: T(2026, 6, 13) }),
    conflict('conflict-older', ['c2', 'c1'], { updatedAt: T(2026, 6, 11) }),
  ],
})
clearConflictChunkCache()
const r1 = await listConflictCards({ dataRoot: root1, personaId: 'alice', limit: 5 })
check('R1 读取 ok', r1.ok === true, r1.error)
check('R2 只列 open 卡', Array.isArray(r1.cards) && r1.cards.length === 2, r1.cards?.length)
check('R3 按 updatedAt 倒序', r1.cards[0]?.conflictId === 'conflict-newer', r1.cards?.map((c) => c.conflictId))
const card1 = r1.cards[0]
check('R4 A 边带日期/角色/正文', card1.a.chunkId === 'c1' && card1.a.role === 'user' && card1.a.dateText === '2026-06-10 10:00:00' && card1.a.text.includes('三月五号'), card1.a)
check('R5 B 边正文 ≤120 字且带省略号', card1.b.text.length === 120 && card1.b.text.endsWith('…'), { len: card1.b.text.length })
check('R6 带 session/seq（可回读原文）', card1.a.session === 'sess-1' && card1.a.seq === 1, card1.a)
check('R7 带 kind/note', card1.kind === 'unexplained-contradiction' && typeof card1.note === 'string', { k: card1.kind, n: card1.note })

const rLimit = await listConflictCards({ dataRoot: root1, personaId: 'alice', limit: 1 })
check('R8 limit 生效', rLimit.cards.length === 1, rLimit.cards?.length)

// ── 3. 跳过纪律 ───────────────────────────────────────────────────────────
console.log('\n── 3. 跳过纪律（缺块 / 跨人格 / resolved / 坏行）')
const root2 = makeRoot('skip', {
  chunks: [
    chunk('ok1', '说法一'),
    chunk('ok2', '说法二'),
    chunk('foreign', '这是 bob 的块，不属于本 scope', { personaId: 'bob' }),
  ],
  rawConflictLines: [
    JSON.stringify(conflict('c-ok', ['ok1', 'ok2'])),
    JSON.stringify(conflict('c-missing', ['ok1', 'nope'])),
    JSON.stringify(conflict('c-cross', ['ok1', 'foreign'])),
    JSON.stringify(conflict('c-resolved', ['ok1', 'ok2'], { status: 'resolved' })),
    '{ 这不是合法 JSON',
    JSON.stringify({ conflictId: 'c-empty-ids', chunkIds: [], status: 'open' }),
    '',
  ],
})
clearConflictChunkCache()
const r2 = await listConflictCards({ dataRoot: root2, personaId: 'alice' })
check('S1 坏行不拖垮读取', r2.ok === true, r2.error)
check('S2 只留可渲染的卡', r2.cards.length === 1 && r2.cards[0].conflictId === 'c-ok', r2.cards?.map((c) => c.conflictId))
check('S3 缺块/跨人格/空 ids 被计数跳过', r2.skippedMissing >= 3, r2.skippedMissing)
check('S4 resolved 不出现', !r2.cards.some((c) => c.conflictId === 'c-resolved'))

// ── 4. 空库 / 非法 personaId ──────────────────────────────────────────────
console.log('\n── 4. 边界：空库 / 非法 personaId')
const root3 = path.join(baseDir, 'empty')
fs.mkdirSync(root3, { recursive: true })
const r3 = await listConflictCards({ dataRoot: root3, personaId: 'alice' })
check('E1 空库 → ok + 0 卡（不报错）', r3.ok === true && r3.cards.length === 0 && r3.total === 0, r3)
const r4 = await listConflictCards({ dataRoot: root1, personaId: '../etc' })
check('E2 非法 personaId → BAD_PERSONA_ID', r4.ok === false && r4.code === 'BAD_PERSONA_ID', r4)
const r5 = await listConflictCards({ dataRoot: root1, personaId: 'persona_unassigned' })
check('E3 未归属桶不渲染冲突卡', r5.ok === false && r5.code === 'BAD_PERSONA_ID', r5)

// ── 5. 只读 & 缓存失效 ────────────────────────────────────────────────────
console.log('\n── 5. 只读 + 缓存（追加后能看见新卡）')
const before = fileSnapshot(root1)
await listConflictCards({ dataRoot: root1, personaId: 'alice' })
const after = fileSnapshot(root1)
check('C1 读取前后文件不变（纯只读）', JSON.stringify(before) === JSON.stringify(after), { before, after })
await new Promise((r) => setTimeout(r, 12)) // 让 mtime 有分辨率差异
fs.appendFileSync(path.join(root1, 'process', 'alice', 'conflicts.jsonl'), JSON.stringify(conflict('conflict-added', ['c1', 'c2'], { updatedAt: T(2026, 6, 20) })) + '\n')
const r6 = await listConflictCards({ dataRoot: root1, personaId: 'alice' })
check('C2 追加冲突后立刻能读到（缓存按 mtime/size 失效）', r6.cards.some((c) => c.conflictId === 'conflict-added'), r6.cards?.map((c) => c.conflictId))

// ── 收尾 ──────────────────────────────────────────────────────────────────
console.log('\n── 汇总')
if (keep) console.log(`  夹具保留：${baseDir}`)
else { try { fs.rmSync(baseDir, { recursive: true, force: true }) } catch {} }
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
  process.exit(1)
}
