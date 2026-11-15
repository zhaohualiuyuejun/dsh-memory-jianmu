#!/usr/bin/env node
/**
 * tools/autorecall-selftest.mjs —— P2 自动召回（镜台侧）离线单测
 *
 * 零网络、零 API、零真实数据：只测闸门 / 预算 / 状态机 / 日志字段。
 * 退出码：0 = 全绿；1 = 有失败
 */
import {
  passesG0, pickHits, renderBlock, renderHitLine, createAutoRecallState, renderLogRow, parseCues, fingerprint,
} from '../lib/autorecall.mjs'

let failed = 0
const results = []
function ok(name, cond, detail) {
  results.push({ name, pass: Boolean(cond), detail })
  if (!cond) failed += 1
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`)

const hit = (over = {}) => ({
  chunkId: 'c1', session: 's1', seq: 1, t: 1791000000000, dateText: '2026-10-03',
  role: 'user', score: 0.7, lex: 0.4, text: '上次说的那家店在东门，老板姓陈。', ...over,
})

// ── 1. G0 规则闸门 ────────────────────────────────────────────────────────
ok('G0：线索词命中', passesG0('你还记得上次那家店吗', '').ok)
eq('G0：命中词写进 reason', passesG0('之前说的那个方案', '之前|那个').reason, 'cue:之前')
ok('G0：句尾问号也算', passesG0('这个怎么做？', 'xyz').ok)
ok('G0：普通闲聊被挡', !passesG0('今天天气不错，出去走走', '').ok)
ok('G0：空消息被挡', !passesG0('   ', '').ok)
ok('G0：超长被挡', !passesG0('啊'.repeat(2100), '啊').ok)
eq('G0：自定义线索词生效', parseCues('甲|乙'), ['甲', '乙'])

// ── 2. pickHits：分数 / 字面 / 预算 ───────────────────────────────────────
const p1 = pickHits({ hits: [hit()] }, { minScore: 0.62, topN: 2, maxChars: 320 })
eq('pick：正常命中 1 条', p1.hits.length, 1)
ok('pick：带出 line', typeof p1.hits[0]?.line === 'string' && p1.hits[0].line.startsWith('- 2026-10-03 · 用户：'))
eq('pick：char 计数', p1.chars, p1.hits[0].line.length + 1)

const p2 = pickHits({ hits: [hit({ score: 0.5 })] }, { minScore: 0.62 })
eq('pick：低于 minScore 丢弃', p2.hits.length, 0)
eq('pick：丢弃原因 belowScore', p2.dropped.belowScore, 1)

const p3 = pickHits({ hits: [hit({ score: 0.64, lex: 0 })] }, { minScore: 0.62 })
eq('pick：无字面且分不高 → 丢', p3.hits.length, 0)
eq('pick：丢弃原因 noLiteral', p3.dropped.noLiteral, 1)

const p4 = pickHits({ hits: [hit({ score: 0.8, lex: 0 })] }, { minScore: 0.62 })
ok('pick：无字面但分明显高 → 放行', p4.hits.length === 1, p4)

const long = hit({ text: '很长的记忆'.repeat(100), score: 0.9, lex: 0.5 })
const p5 = pickHits({ hits: [long] }, { minScore: 0.62, topN: 2, maxChars: 120 })
eq('pick：放不下整行就跳过（不截半行）', p5.hits.length, 0)
eq('pick：丢弃原因 overBudget', p5.dropped.overBudget, 1)

const p6 = pickHits({ hits: [hit({ chunkId: 'a', text: '甲甲甲甲甲甲甲甲', score: 0.9, lex: 1 }), hit({ chunkId: 'b', text: '乙乙乙乙乙乙乙乙', score: 0.8, lex: 1 }), hit({ chunkId: 'c', text: '丙丙丙丙丙丙丙丙', score: 0.7, lex: 1 })] }, { minScore: 0.62, topN: 2, maxChars: 500 })
eq('pick：topN 封顶', p6.hits.length, 2)

// ── 3. 渲染 ───────────────────────────────────────────────────────────────
eq('render：空 → 空串', renderBlock([]), '')
eq('render：单行压平空白', renderHitLine({ dateText: '2026-01-02', role: 'assistant', text: '  多   空格\n换行 ' }), '- 2026-01-02 · 助手：多 空格 换行')
const block = renderBlock([hit(), { ...hit(), role: 'assistant', dateText: '2026-09-09', text: '根藏备份放 备份盘。' }])
ok('render：有标题与免责句', block.includes('【可能相关的旧记忆') && block.includes('不要主动提起'))
ok('render：两条都在', block.split('\n').filter((l) => l.startsWith('- ')).length === 2)

// ── 4. 状态机 ─────────────────────────────────────────────────────────────
const st = createAutoRecallState({ getCooldownMs: () => 60000, getTtlMs: () => 120000 })
const t0 = 1793000000000
eq('state：begin 成功', st.begin('s1', { query: '上次那家店', turn: 1, now: t0 }).ok, true)
st.attach('s1', 1, Promise.resolve())
eq('state：resolve 错误回合被丢', st.resolve('s1', { turn: 2, block: 'B' }), false)
eq('state：正确回合收下', st.resolve('s1', { turn: 1, block: 'BLOCK-1', now: t0 }), true)
eq('state：render 出块', st.render('s1', t0 + 1000), 'BLOCK-1')
eq('state：同一块 10 分钟内不重复注入', st.render('s1', t0 + 2000), '')

const st2 = createAutoRecallState({ getCooldownMs: () => 60000, getTtlMs: () => 2000 })
st2.begin('s2', { query: '那个方案', turn: 3, now: t0 })
st2.resolve('s2', { turn: 3, block: 'BLOCK-2', now: t0 })
eq('state：过期后不给块', (st2.render('s2', t0 + 5000)), '')
eq('state：过期状态标 expired', st2.peek('s2').status, 'expired')

const st3 = createAutoRecallState({ getCooldownMs: () => 60000 })
st3.begin('s3', { query: '甲', turn: 1, now: t0 })
const again = st3.begin('s3', { query: '乙', turn: 2, now: t0 + 1000 })
eq('state：冷却期内不再触发', again.code, 'COOLDOWN')
ok('state：冷却剩余毫秒合理', again.remainMs > 0 && again.remainMs <= 60000, again)

const st4 = createAutoRecallState({ getCooldownMs: () => 0 })
st4.begin('s4', { query: '丙', turn: 1, now: t0 })
st4.attach('s4', 1, new Promise((r) => setTimeout(() => r('late'), 80)))
const waited = await st4.waitFor('s4', 500)
ok('state：waitFor 会等预取', waited === true)

// ── 5. 日志行 / 指纹 ──────────────────────────────────────────────────────
const row = renderLogRow({ sid: 'session-1234567890abcdef', g0: true, g0Reason: 'cue:上次', ms: 321, embedMs: 200, score: 0.71, lex: 0.4, n: 2, chars: 180, outcome: 'injected' })
ok('log：只有元数据、不含正文', !('text' in row) && !('query' in row), Object.keys(row))
ok('log：sid 只留尾部 12 位', row.sid === '1234567890abcdef'.slice(-12), row.sid)
ok('log：分数保留 3 位', row.score === 0.71 && row.lex === 0.4)
eq('fingerprint：稳定', fingerprint('abc'), fingerprint('abc'))
ok('fingerprint：不同内容不同', fingerprint('abc') !== fingerprint('abd'))

// ── 收尾 ──────────────────────────────────────────────────────────────────
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : `  ← ${JSON.stringify(r.detail)}`}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ''}`)
process.exit(failed ? 1 : 0)
