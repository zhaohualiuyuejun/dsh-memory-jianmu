#!/usr/bin/env node
/**
 * tools/autorecall-e2e.mjs —— P2 自动召回「宿主装配」端到端（假宿主，零 API）
 *
 * 用假 ctx 真调用 apply()，模拟：
 *   agent/inbox/claimed（用户问「上次…」）
 *     → 异步预取（假 jianmuRecall 服务，30ms）
 *     → system-prompt/assemble（最多等 autoRecallWaitMs）
 *     → jianmu:memory 段文本里出现自动召回块
 * 并验证：G0 挡闲聊、labOnly 挡非实验工作区、日志只写元数据。
 *
 * 用法：node tools/autorecall-e2e.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = path.join(os.tmpdir(), `persona-autorecall-${Date.now()}`)
const DSH = path.join(BASE, 'dshhome')
const DATA = path.join(BASE, 'data')
const WS = 'C:\\work\\lab'
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1, personas: { alice: { displayName: 'Alice' } }, workspaces: {}, sessions: {},
}, null, 2))

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ''}`) }
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
const handlers = new Map()
const sections = []
const registered = new Map()
const prefetchCalls = []
const log = () => {}
let fakePrefetch = null

const ctx = {
  tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name) } },
  logger: { info: log, warn: log, error: log },
  systemPrompt: {
    section(def) {
      sections.push(def)
      return () => { const i = sections.indexOf(def); if (i >= 0) sections.splice(i, 1) }
    },
  },
  settings: { describe: () => [] },
  on(event, cb) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(cb)
    return () => {}
  },
  provide(n, v) { return () => {} },
  inject() {},
  effect() {},
  get(n) {
    if (n === 'workingDirectory') return { ensure: async () => WS, get: () => WS }
    if (n === 'jianmuRecall') return {
      version: 1,
      async prefetch(req) {
        prefetchCalls.push({ ...req })
        return fakePrefetch ? fakePrefetch(req) : { ok: false, code: 'NO_FAKE' }
      },
    }
    return undefined
  },
}

const mod = await import('../index.js')
const dispose = mod.apply(ctx, {
  dataRoot: DATA,
  profile: 'desktop',
  injectEnabled: true,
  autoRecall: true,
  autoRecallLabOnly: false,
  autoRecallWaitMs: 600,
  autoRecallDeadlineMs: 800,
  autoRecallMinScore: 0.6,
  autoRecallTopN: 2,
  autoRecallMaxChars: 320,
  autoRecallCooldownMs: 0,
})

const emit = async (event, payload) => {
  const cbs = handlers.get(event) || []
  const out = []
  for (const cb of cbs) out.push(await cb(payload))
  return out
}
const assemble = async (sid) => {
  const cbs = handlers.get('system-prompt/assemble') || []
  let nextCalled = false
  for (const cb of cbs) await cb({ agent: { session: { id: sid, header: { cwd: WS } } } }, {}, async () => { nextCalled = true; return { ok: true } })
  return nextCalled
}
const memorySection = () => sections.find((s) => s.name === 'jianmu:memory')
const memoryText = (sid) => {
  const s = memorySection()
  if (!s || typeof s.text !== 'function') return ''
  return String(s.text({ agent: { session: { id: sid, header: { cwd: WS } } }, agentSession: {} }) || '')
}
const userMsg = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

// ── A. 命中：预取 + 注入 ──────────────────────────────────────────────────
const SID = 'session-autorecall-test-1'
fakePrefetch = async () => {
  await new Promise((r) => setTimeout(r, 30)) // 模拟嵌入往返
  return {
    ok: true, code: 'HIT', ms: 30, embedMs: 20,
    hits: [
      { chunkId: 'c1', session: 's-old', seq: 5, t: 1791000000000, dateText: '2026-10-03', role: 'user', score: 0.78, lex: 0.4, text: '那家店在东门，老板姓陈。' },
      { chunkId: 'c2', session: 's-old', seq: 6, t: 1791100000000, dateText: '2026-10-04', role: 'assistant', score: 0.66, lex: 0.0, text: '根藏备份放 备份盘。' },
    ],
  }
}

const t0 = Date.now()
await emit('agent/inbox/claimed', { agent: { session: { id: SID, header: { cwd: WS } } }, message: userMsg('你还记得上次那家店叫什么吗'), turn: 1 })
await assemble(SID)
const waitedMs = Date.now() - t0
const txt = memoryText(SID)

check('A1 预取被调用一次', prefetchCalls.length === 1, prefetchCalls.length)
check('A2 查询文本是用户原话（去掉问句虚词也照传）', prefetchCalls[0]?.query?.includes('上次那家店'), prefetchCalls[0]?.query)
check('A3 assemble 有等待（等到预取完成，但不无限等）', waitedMs >= 20 && waitedMs < 2000, waitedMs)
check('A4 记忆段出现自动召回块', txt.includes('【可能相关的旧记忆'), txt.slice(0, 120))
check('A5 注入行带日期与角色', txt.includes('2026-10-03 · 用户：'), txt)
check('A6 第二条（无字面但分数不够高）被 G1 挡掉', !txt.includes('根藏备份放 备份盘'), txt)
check('A7 末尾有「不要主动提起」', txt.includes('不要主动提起'))
check('A8 预取只带元数据参数', prefetchCalls[0]?.deadlineMs === 800 && prefetchCalls[0]?.minScore === 0.6, { d: prefetchCalls[0]?.deadlineMs, m: prefetchCalls[0]?.minScore })

// ── B. 冷却：同一会话紧接着再问不重复预取 ──────────────────────────────────
await emit('agent/inbox/claimed', { agent: { session: { id: SID, header: { cwd: WS } } }, message: userMsg('之前说的那个方案呢'), turn: 2 })
check('B1 冷却期内不重复预取（默认冷却被本测试设为 0，这里只看能否再触发）', prefetchCalls.length === 2, prefetchCalls.length)

// ── C. G0：闲聊不触发 ─────────────────────────────────────────────────────
const SID2 = 'session-autorecall-test-2'
await emit('agent/inbox/claimed', { agent: { session: { id: SID2, header: { cwd: WS } } }, message: userMsg('今天天气不错，出去走走'), turn: 1 })
const before = prefetchCalls.length
await assemble(SID2)
check('C1 闲聊不预取', prefetchCalls.length === before, prefetchCalls.length)
check('C2 闲聊的记忆段没有召回块', !memoryText(SID2).includes('【可能相关的旧记忆'), memoryText(SID2).slice(0, 80))

// ── C3. 渲染顺序：人格段先取用，不能把自动召回块吞掉 ──────────────────────
// 真实宿主按 order 渲染：jianmu:persona(0) 先于 jianmu:memory(0.5)。
const SID_ORDER = 'session-autorecall-order'
fakePrefetch = async () => ({
  ok: true, code: 'HIT',
  hits: [{ chunkId: 'c-order', session: 's-old', seq: 7, t: 1791000000000, dateText: '2026-10-03', role: 'user', score: 0.82, lex: 0.5, text: '那家店在东门，老板姓陈。' }],
})
await emit('agent/inbox/claimed', { agent: { session: { id: SID_ORDER, header: { cwd: WS } } }, message: userMsg('上次那家店在哪来着？'), turn: 1 })
await assemble(SID_ORDER)
const asmOrder = { agent: { session: { id: SID_ORDER, header: { cwd: WS } } }, agentSession: {} }
const personaSec = sections.find((s) => s.name === 'jianmu:persona')
const pFirst = String(personaSec?.text?.(asmOrder) ?? '')
const mAfter = String(memorySection()?.text?.(asmOrder) ?? '')
check('C3 人格段先渲染后，记忆段仍拿到自动召回块',
  typeof pFirst === 'string' && mAfter.includes('【可能相关的旧记忆') && mAfter.includes('2026-10-03 · 用户：'), { p: pFirst.slice(0, 40), m: mAfter.slice(0, 80) })

// ── D. labOnly：非实验工作区不触发 ────────────────────────────────────────
dispose()
const ctx2 = {
  ...ctx,
  get(n) {
    if (n === 'workingDirectory') return { ensure: async () => 'C:\\work\\alice', get: () => 'C:\\work\\alice' }
    if (n === 'jianmuRecall') return { version: 1, async prefetch(req) { prefetchCalls.push({ ...req }); return { ok: true, hits: [] } } }
    return undefined
  },
  on(event, cb) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(cb)
    return () => {}
  },
}
handlers.clear(); sections.length = 0
const mod2 = await import(`../index.js?lab=${Date.now()}`)
const dispose3 = mod2.apply(ctx2, {
  dataRoot: DATA, profile: 'desktop', injectEnabled: true,
  autoRecall: true, autoRecallLabOnly: true, autoRecallLabWorkspaces: '', autoRecallWaitMs: 200,
})
const before2 = prefetchCalls.length
await emit('agent/inbox/claimed', { agent: { session: { id: 'session-labcheck', header: { cwd: 'C:\\work\\alice' } } }, message: userMsg('你还记得上次那家店吗'), turn: 1 })
check('D1 labOnly=true 时生产工作区不预取', prefetchCalls.length === before2, prefetchCalls.length - before2)
const logFile = path.join(DATA, 'persona', '_logs', 'auto-recall.jsonl')
await new Promise((r) => setTimeout(r, 80))
const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
check('E1 观测日志已写出', logText.includes('lab-skip') || logText.includes('g0-skip'), logText.slice(0, 200))
check('E2 日志不含正文', !logText.includes('那家店') && !logText.includes('天气不错'), logText.slice(0, 200))

dispose3()

// ── 收尾 ──────────────────────────────────────────────────────────────────
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}：${JSON.stringify(f.detail)}`)
}
try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0)
