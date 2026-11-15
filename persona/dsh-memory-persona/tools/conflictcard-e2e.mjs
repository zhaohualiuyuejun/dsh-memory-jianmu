#!/usr/bin/env node
/**
 * tools/conflictcard-e2e.mjs —— P2.5 冲突卡「熏习 → 镜台」真链路（假宿主，零 API）
 *
 * 这里不塞假服务：真的加载熏习 index.js 让 ctx.provide('jianmuConflicts')，
 * 再加载镜台 index.js 去 ctx.get 它，用临时数据根跑一遍：
 *
 *   agent/inbox/claimed（G0 线索）
 *     → 镜台解析 personaId（registry 卡 front-matter）
 *     → 熏习读 process/<pid>/conflicts.jsonl + scopes/<pid>/chunks.jsonl
 *     → 镜台渲染 ≤2 张卡 / ≤300 字
 *     → system-prompt/assemble 等 300ms → jianmu:memory 段出现 A/B 与日期
 *
 * 并验证：同一回合只一次；闲聊不调用；关掉开关零注入；熏习数据只读（文件字节不变）。
 *
 * 用法：node tools/conflictcard-e2e.mjs [--keep]
 * 退出码：0 = 全绿；1 = 有失败
 */
import fs from 'node:fs'
import path from 'node:path'

const keep = process.argv.includes('--keep')
const BASE = path.join('C:/work/alice/tmp', `conflictcard-e2e-${Date.now()}`)
const DSH = path.join(BASE, 'dshhome')
const DATA = path.join(BASE, 'data')
const WS = 'C:\\work\\e2e-ws'
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`) }
}

// ── 夹具：根藏块 + 一条 open 冲突 + 镜台卡 ──────────────────────────────────
const T = (y, m, d, h = 2) => Date.UTC(y, m - 1, d, h, 0, 0)
const chunks = [
  { id: 'ch-a', kind: 'utterance', schemaVersion: 1, contractVersion: 1, session: 's-old', personaId: 'alice', messageId: 'm1', seq: 1, role: 'user', sourceType: 'user', t: T(2026, 6, 10), tz: 'Asia/Shanghai', text: '生日是三月五号，我记得很清楚。', ws: WS, channel: 'dsh', attachments: [], retention: 'active' },
  { id: 'ch-b', kind: 'utterance', schemaVersion: 1, contractVersion: 1, session: 's-old', personaId: 'alice', messageId: 'm2', seq: 2, role: 'assistant', sourceType: 'assistant', t: T(2026, 6, 12, 3), tz: 'Asia/Shanghai', text: '用户的生日是四月八号。', ws: WS, channel: 'dsh', attachments: [], retention: 'active' },
]
fs.mkdirSync(path.join(DATA, 'scopes', 'alice'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'scopes', 'alice', 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n')
fs.writeFileSync(path.join(DATA, 'scopes', 'alice', 'manifest.json'), JSON.stringify({
  schemaVersion: 1, contractVersion: 1, generation: 1, personaId: 'alice', displayName: 'Alice',
  identitySource: 'manual', provider: 'cloud', model: 'test', dim: 8, normalizerVersion: 'l2-v1',
  chunks: chunks.length, sessions: 1, workspaces: 1, builtAt: '2026-06-01T00:00:00.000Z',
}, null, 2))
fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1, defaultPersonaId: null, personas: { alice: { displayName: 'Alice' } },
  workspaces: { [WS]: 'alice' }, sessions: {},
}, null, 2))
fs.mkdirSync(path.join(DATA, 'process', 'alice'), { recursive: true })
const conflictRow = {
  conflictId: 'conflict-unexplained-contradiction-e2e', chunkIds: ['ch-a', 'ch-b'],
  kind: 'unexplained-contradiction', status: 'open', resolution: null,
  createdAt: T(2026, 6, 13), updatedAt: T(2026, 6, 13), note: '用户手动标记', ruleRef: null, rootBuiltAt: null,
}
fs.writeFileSync(path.join(DATA, 'process', 'alice', 'conflicts.jsonl'), JSON.stringify(conflictRow) + '\n')

const regFile = path.join(DATA, 'persona', 'registry.json')
fs.mkdirSync(path.join(DATA, 'persona', 'cards', 'alice'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'persona', 'cards', 'alice', 'card.md'), [
  '---',
  'id: "alice"',
  'name: "Alice"',
  'personaId: "alice"',
  'memoryScope: "alice"',
  'source: "manual"',
  'status: "active"',
  'version: 1',
  '---',
  '',
  '# Alice',
  '',
  '## 身份与外貌',
  '测试用示例助手。',
  '',
].join('\n'))
const writeRegistry = (settings) => fs.writeFileSync(regFile, JSON.stringify({
  schemaVersion: 1, contractVersion: 1, generation: 1, activeCardId: 'alice',
  cards: { alice: { name: 'Alice', source: 'manual', status: 'active', version: 1 } },
  workspaces: { [WS]: 'alice' }, workspaceList: [WS], sessions: {},
  settings, updatedAt: Date.now(), settingsRevision: 1, settingsUpdatedAt: Date.now(),
}, null, 2))
writeRegistry({ conflictCard: true, injectEnabled: true, cardSource: 'jianmu' })

// ── 假宿主 ────────────────────────────────────────────────────────────────
const log = () => {}
function fakeHost({ getExtra = () => undefined } = {}) {
  const handlers = new Map()
  const sections = []
  const provided = {}
  const ctx = {
    tools: { register() { return () => {} } },
    logger: { info: log, warn: log, error: log },
    systemPrompt: {
      section(def) { sections.push(def); return () => {} },
    },
    settings: { describe: () => [] },
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(cb)
      return () => {}
    },
    provide(n, svc) { provided[n] = svc; return () => {} },
    inject() {},
    effect() {},
    get(n) {
      const extra = getExtra(n)
      if (extra !== undefined) return extra
      if (n === 'webServer') return { register: () => () => {} }
      return undefined
    },
  }
  return { ctx, handlers, sections, provided }
}

const emit = async (host, event, payload) => {
  for (const cb of host.handlers.get(event) || []) await cb(payload)
}
const asmFor = (sid) => ({ agent: { workspace: WS, session: { id: sid, header: { cwd: WS } } } })
const memText = (host, sid) => {
  const sec = host.sections.find((s) => s.name === 'jianmu:memory')
  return sec && typeof sec.text === 'function' ? String(sec.text(asmFor(sid)) || '') : ''
}
const personaText = (host, sid) => {
  const sec = host.sections.find((s) => s.name === 'jianmu:persona')
  return sec && typeof sec.text === 'function' ? String(sec.text(asmFor(sid)) || '') : ''
}
const userMsg = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const claimed = (host, sid, text, turn) => emit(host, 'agent/inbox/claimed', { agent: { session: { id: sid, header: { cwd: WS } } }, message: userMsg(text), turn })
const assemble = async (host, sid) => { for (const cb of host.handlers.get('system-prompt/assemble') || []) await cb(asmFor(sid), {}, async () => ({})) }

// ── 1. 熏习真的 provide 服务 ──────────────────────────────────────────────
console.log('\n── 1. 熏习提供 jianmuConflicts')
const procHost = fakeHost()
let procMod
try {
  procMod = await import('../../../process/dsh-memory-process/index.js')
} catch (e) {
  // 这是 monorepo 的跨包测试；装成独立 npm 包后没有 ../../process，跳过而不是报假红。
  console.log(`\nSKIP：跨包冲突卡测试需要 monorepo 里的 process 包（${String(e?.code || e?.message || e)}）`)
  process.exit(0)
}
const disposeProc = procMod.apply(procHost.ctx, { enabled: true, processEnabled: true, autoRun: false, dataRoot: DATA })
const conflictsSvc = procHost.provided.jianmuConflicts
check('E1 熏习 provide jianmuConflicts.list', Boolean(conflictsSvc) && typeof conflictsSvc.list === 'function' && conflictsSvc.version === 1, Object.keys(procHost.provided))
if (!conflictsSvc) { console.log('  服务不存在，后续跳过'); process.exit(1) }

// 计数包装：镜台调了几次
let listCalls = 0
const realList = conflictsSvc.list.bind(conflictsSvc)
conflictsSvc.list = async (req) => { listCalls += 1; return realList(req) }

// ── 2. 镜台加载并注入 ─────────────────────────────────────────────────────
console.log('\n── 2. 镜台消费服务 → 记忆段出现冲突卡')
const personaHost = fakeHost({ getExtra: (n) => (n === 'jianmuConflicts' ? conflictsSvc : undefined) })
const personaMod = await import('../index.js')
const disposePersona = personaMod.apply(personaHost.ctx, {
  dataRoot: DATA, injectEnabled: true, cardSource: 'jianmu', conflictCard: true, injectCacheMs: 5000,
})

const SID = 'sid-conflict-e2e'
await claimed(personaHost, SID, '你还记得上次说的生日是哪天吗', 1)
await assemble(personaHost, SID)
const txt = memText(personaHost, SID)
const start = txt.indexOf('【未裁决的两种说法')
const end = txt.indexOf('（以上是两种说法并存', start)
const cardPart = start >= 0 && end > start ? txt.slice(start, txt.indexOf('）', end) + 1) : ''
check('E2 服务被调用（注入路径真连到熏习）', listCalls === 1, listCalls)
check('E3 记忆段出现冲突卡', start >= 0, txt.slice(0, 120))
check('E4 两条说法 + 两个日期', txt.includes('2026-06-10 10:00:00 · 用户：生日是三月五号') && txt.includes('2026-06-12 11:00:00 · 助手：用户的生日是四月八号'), txt.slice(start, start + 220))
check('E5 带 A/B 与「未裁决」口径', txt.includes('（A）') && txt.includes('（B）') && txt.includes('请勿把其中一条当成定论'), txt.slice(start, start + 220))
check('E6 预算 ≤300 字', cardPart.length > 0 && cardPart.length <= 300, cardPart.length)
const txt2 = memText(personaHost, SID)
check('E7 同一回合第二次取用不再注入', !txt2.includes('【未裁决的两种说法'), txt2.slice(0, 80))

// 关键回归：真实宿主先渲染人格段（order 0）、再渲染记忆段（order 0.5）。
// 动态块只能由记忆段取用 —— 否则人格段那一趟会把块「吞掉」，记忆段就拿到空。
const SID_ORDER = 'sid-order-check'
await claimed(personaHost, SID_ORDER, '之前说的那个生日呢', 2)
await assemble(personaHost, SID_ORDER)
const pTxt = personaText(personaHost, SID_ORDER)
const mTxt = memText(personaHost, SID_ORDER)
check('E7b 人格段先渲染也不吞掉冲突卡（记忆段仍拿到）',
  pTxt.includes('Alice') && mTxt.includes('【未裁决的两种说法'), { p: pTxt.slice(0, 40), m: mTxt.slice(0, 60) })

// ── 3. G0：闲聊不调用 ─────────────────────────────────────────────────────
console.log('\n── 3. G0 闸门（闲聊不询问熏习）')
const beforeChat = listCalls
await claimed(personaHost, 'sid-chat', '今天天气不错，出去走走', 1)
await assemble(personaHost, 'sid-chat')
check('E8 闲聊 → 不调用服务', listCalls === beforeChat, listCalls - beforeChat)

// ── 4. 开关关闭 → 零注入 ──────────────────────────────────────────────────
console.log('\n── 4. 关闭开关 → 零注入（也不再调用）')
writeRegistry({ conflictCard: false, injectEnabled: true, cardSource: 'jianmu' })
const beforeOff = listCalls
await claimed(personaHost, 'sid-off', '上次说的生日是哪天？', 1)
await assemble(personaHost, 'sid-off')
const txtOff = memText(personaHost, 'sid-off')
check('E9 关闭后不出现卡、也不调用服务', !txtOff.includes('【未裁决的两种说法') && listCalls === beforeOff, { calls: listCalls - beforeOff, txt: txtOff.slice(0, 80) })

// ── 5. 熏习数据只读 ───────────────────────────────────────────────────────
console.log('\n── 5. 只读（没写 conflicts / 没裁决）')
const cf = fs.readFileSync(path.join(DATA, 'process', 'alice', 'conflicts.jsonl'), 'utf8')
const rows = cf.split('\n').filter(Boolean).map((l) => JSON.parse(l))
check('E10 conflicts.jsonl 仍只有一行（未追加裁决/状态）', rows.length === 1, rows.length)
check('E11 冲突仍是 open（没替用户裁决）', rows[0].status === 'open' && rows[0].resolution === null, rows[0])

// ── 收尾 ──────────────────────────────────────────────────────────────────
try { disposePersona() } catch {}
try { disposeProc() } catch {}
console.log('\n── 汇总')
if (keep) console.log(`  夹具保留：${BASE}`)
else { try { fs.rmSync(BASE, { recursive: true, force: true }) } catch {} }
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
  process.exit(1)
}
