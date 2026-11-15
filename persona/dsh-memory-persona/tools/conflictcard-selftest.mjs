#!/usr/bin/env node
/**
 * tools/conflictcard-selftest.mjs —— P2.5 冲突卡（镜台侧）离线单测
 *
 * 零网络、零 API：只测渲染纪律与回合状态：
 *   · 开关关 → 空串（注入逐字不变）；开 → 有头有尾、A/B 各一行；
 *   · 预算内放整卡；放不下就跳过，绝不截半卡；≤2 张；边文本 ≤120 字；
 *   · 同一回合只给一次；同内容在去重窗口内不重复；新回合可以再给；
 *   · 日志只写元数据（张数/字数/conflictId），不写正文。
 *
 * 用法：node tools/conflictcard-selftest.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */
import {
  renderConflictCards, renderOneConflictCard, clampText, createConflictCardState,
  renderConflictLogRow, fingerprint, CONFLICT_HEADER, CONFLICT_FOOTER,
} from '../lib/conflictcard.mjs'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}

const card = (id, aText, bText, over = {}) => ({
  conflictId: id,
  kind: 'unexplained-contradiction',
  note: '用户手动标记',
  a: { chunkId: `${id}-a`, dateText: '2026-06-10 10:00:00', role: 'user', text: aText, session: 's1', seq: 1, ...(over.a || {}) },
  b: { chunkId: `${id}-b`, dateText: '2026-06-12 15:30:00', role: 'assistant', text: bText, session: 's1', seq: 2, ...(over.b || {}) },
})

// ── 1. 渲染 ───────────────────────────────────────────────────────────────
console.log('\n── 1. 渲染（头尾 / A-B / 不裁决）')
const c1 = card('cf-1', '生日是三月五号。', '用户的生日是四月八号。')
const r1 = renderConflictCards([c1])
check('R1 开关默认开（显式 enabled=true）才有文本', r1.text.startsWith(CONFLICT_HEADER) && r1.text.endsWith(CONFLICT_FOOTER), r1.text)
check('R2 两张说法各一行', (r1.text.match(/^- ⚠️ /gm) || []).length === 2, r1.text)
check('R3 带两个日期与角色', r1.text.includes('2026-06-10 10:00:00 · 用户：') && r1.text.includes('2026-06-12 15:30:00 · 助手：'), r1.text)
check('R4 A/B 标注在行尾', r1.text.includes('（A）') && r1.text.includes('（B）'), r1.text)
check('R5 明确「不替你做结论 / 勿当定论」', r1.text.includes('不替你做结论') && r1.text.includes('请勿把其中一条当成定论'), r1.text)
check('R6 元数据：1 张 / 百分比字数 / conflictId', r1.cards === 1 && r1.chars === r1.text.length && r1.ids[0] === 'cf-1', { n: r1.cards, chars: r1.chars, ids: r1.ids })

// ── 2. 开关关闭 = 零注入 ───────────────────────────────────────────────────
console.log('\n── 2. 开关关闭（逐字不变）')
const r2 = renderConflictCards([c1], { enabled: false })
check('S1 enabled=false → 空串', r2.text === '' && r2.cards === 0 && r2.chars === 0, r2)

// ── 3. 预算 / 整卡 ────────────────────────────────────────────────────────
console.log('\n── 3. 预算（整卡放不下就跳过）')
const c2 = card('cf-2', '搬家公司说周六来。', '搬家公司改到周日。')
const full = renderConflictCards([c1, c2])
check('B1 两张卡都能放（默认 300 字）', full.cards === 2, { n: full.cards, chars: full.chars })
const oneBlock = renderOneConflictCard(c1)
const base = CONFLICT_HEADER.length + 1 + CONFLICT_FOOTER.length
const tight = renderConflictCards([c1, c2], { maxChars: base + oneBlock.length + 1 })
check('B2 预算只够一张 → 只放第一张', tight.cards === 1 && tight.text.includes('三月五号') && !tight.text.includes('搬家公司'), { n: tight.cards, chars: tight.chars })
check('B3 绝不截半卡：每张出现都是完整 A/B 两行', (tight.text.match(/^- ⚠️ /gm) || []).length === 2 && tight.text.endsWith(CONFLICT_FOOTER), tight.text)
const tooTight = renderConflictCards([c1], { maxChars: 40 })
check('B4 连头尾都放不下 → 空串（不写半段）', tooTight.text === '', tooTight)
const cap2 = renderConflictCards([c1, c2, card('cf-3', '甲', '乙')], { maxCards: 2 })
check('B5 maxCards 封顶 2', cap2.cards === 2 && cap2.ids.length === 2, { n: cap2.cards, ids: cap2.ids })
const missing = renderConflictCards([card('cf-x', '只有 A', '') , card('cf-y', 'A2', 'B2')])
check('B6 缺 B 的卡被跳过，不影响后面的卡', missing.cards === 1 && missing.ids[0] === 'cf-y', { n: missing.cards, ids: missing.ids, dropped: missing.dropped })

// ── 4. 单边截断 ───────────────────────────────────────────────────────────
console.log('\n── 4. 单边截断（≤120 字 + 省略号）')
const long = card('cf-long', '甲'.repeat(300), '乙'.repeat(300))
const longOut = renderOneConflictCard(long)
check('T1 两边都截到 120 字', clampText('甲'.repeat(300)).length === 120)
check('T2 截断带省略号', longOut.includes('…'), longOut.slice(0, 60))
check('T3 单卡上限可调（sideMaxChars=20）', renderOneConflictCard(long, { sideMaxChars: 20 }).includes('甲'.repeat(19) + '…'))

// ── 5. 回合状态机 ─────────────────────────────────────────────────────────
console.log('\n── 5. 回合状态（一回合一次 / 指纹去重）')
const st = createConflictCardState({ dedupeMs: 10 * 60 * 1000 })
check('M1 未 begin → take 空', st.take('s1') === '')
st.begin('s1', { turn: 1, query: '上次说的事' })
st.resolve('s1', { turn: 1, block: 'BLOCK-A', meta: { conflictIds: ['cf-1'], n: 1 } })
check('M2 resolve 前不是 ready（这里直接 resolve 成功）', st.peek('s1').status === 'ready', st.peek('s1'))
check('M3 同回合第一次 take 给文本', st.take('s1') === 'BLOCK-A')
check('M4 同回合第二次 take → 空（不重复注入）', st.take('s1') === '')
st.begin('s1', { turn: 2, query: '还记得那个吗' })
st.resolve('s1', { turn: 2, block: 'BLOCK-A', meta: { conflictIds: ['cf-1'], n: 1 } })
check('M5 新回合但内容相同 → 去重窗口内不再给', st.take('s1') === '')
st.begin('s1', { turn: 3, query: '之前那个冲突' })
st.resolve('s1', { turn: 3, block: 'BLOCK-B', meta: { conflictIds: ['cf-2'], n: 1 } })
check('M6 新内容 → 新回合给', st.take('s1') === 'BLOCK-B')
st.begin('s1', { turn: 4 })
st.resolve('s1', { turn: 3, block: 'STALE' })
check('M7 过期回合的 resolve 被丢弃', st.peek('s1').status === 'idle' && st.take('s1') === '', st.peek('s1'))
st.begin('s1', { turn: 5 })
st.resolve('s1', { turn: 5, block: '' })
check('M8 空块 → miss，take 空', st.peek('s1').status === 'miss' && st.take('s1') === '')
st.begin('s1', { turn: 6 })
const p = new Promise((r) => setTimeout(() => r('x'), 30))
st.attach('s1', 6, p)
check('M9 waitFor 等到 pending 完成', await st.waitFor('s1', 500) === true)
check('M10 waitFor 同回合只等一次', await st.waitFor('s1', 500) === false)

// ── 6. 日志只写元数据 ─────────────────────────────────────────────────────
console.log('\n── 6. 日志（无正文）')
const row = renderConflictLogRow({ sid: 'session-abcdefghijkl', n: 2, chars: 210, conflictIds: ['cf-1', 'cf-2'], outcome: 'injected' })
check('L1 只含 t/sid/n/chars/conflictIds/outcome', Object.keys(row).sort().join(',') === 'chars,conflictIds,n,outcome,sid,t', Object.keys(row))
check('L2 sid 只留末尾 12 位', row.sid === 'abcdefghijkl' && row.sid.length === 12, row.sid)
check('L3 没有正文/备注字段', !('text' in row) && !('note' in row) && !JSON.stringify(row).includes('三月五号'), row)
check('L4 conflictIds 最多 5 个', renderConflictLogRow({ conflictIds: ['1', '2', '3', '4', '5', '6'] }).conflictIds.length === 5)
check('L5 指纹稳定且不同内容不同', fingerprint('abc') === fingerprint('abc') && fingerprint('abc') !== fingerprint('abd'))

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
  process.exit(1)
}
