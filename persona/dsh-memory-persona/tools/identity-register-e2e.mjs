#!/usr/bin/env node
/**
 * tools/identity-register-e2e.mjs —— P4 #5/#6/#7 真链路（假宿主，零 API）
 *
 * 真加载根藏 index.js（它 provide jianmuStore）+ 镜台 index.js，
 * 再用镜台真实的写路由 handleWriteRequest 走一遍：
 *
 *   POST /register → 镜台读卡/绑定 → 根藏 identityAddPersona → 写 identity.json + 备份
 *   POST /register（第二次）→ 幂等 noop
 *   POST /delete {mode:'stop'} → 先摘映射（不删记忆）→ 再归档卡
 *   没装根藏 → 503 ROOT_SERVICE_UNAVAILABLE（不代写 identity）
 *
 * 用法：node tools/identity-register-e2e.mjs [--keep]
 * 退出码：0 = 全绿；1 = 有失败
 */
import fs from 'node:fs'
import path from 'node:path'

const keep = process.argv.includes('--keep')
const BASE = path.join('C:/work/alice/tmp', `identity-register-e2e-${Date.now()}`)
const DSH = path.join(BASE, 'dshhome')
const DATA = path.join(BASE, 'data')
const WS = 'H:\\lab workspace'
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

// ── 夹具 ──────────────────────────────────────────────────────────────────
const now = Date.now()
fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1,
  defaultPersonaId: null,
  personas: { alice: { displayName: 'Alice' } },
  workspaces: { 'C:\\work\\alice': 'alice' },
  sessions: {},
}, null, 2))

// 根藏 scope（证明停记不删记忆）
fs.mkdirSync(path.join(DATA, 'scopes', 'tester'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'scopes', 'tester', 'chunks.jsonl'), JSON.stringify({ id: 'keep-me', text: '这条记忆不能被停记删掉' }) + '\n')

const PERSONA = path.join(DATA, 'persona')
fs.mkdirSync(path.join(PERSONA, 'cards', 'alice'), { recursive: true })
fs.mkdirSync(path.join(PERSONA, 'cards', 'tester'), { recursive: true })
fs.mkdirSync(path.join(PERSONA, 'cards', 'claimer'), { recursive: true })
const cardMd = (id, name) => [
  '---',
  `id: "${id}"`,
  `name: "${name}"`,
  `personaId: "${id}"`,
  `memoryScope: "${id}"`,
  'source: "manual"',
  'status: "active"',
  'version: 1',
  '---',
  '',
  `# ${name}`,
  '',
  '## 身份与外貌',
  `${name}（E2E 夹具）。`,
  '',
].join('\n')
fs.writeFileSync(path.join(PERSONA, 'cards', 'alice', 'card.md'), cardMd('alice', 'Alice'))
fs.writeFileSync(path.join(PERSONA, 'cards', 'tester', 'card.md'), cardMd('tester', '测试员'))
fs.writeFileSync(path.join(PERSONA, 'cards', 'claimer', 'card.md'), cardMd('claimer', '认领测试员'))
fs.writeFileSync(path.join(PERSONA, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, contractVersion: 1, generation: 1, dataRoot: DATA, createdAt: now, updatedAt: now, lastError: null,
  writer: { name: 'dsh-memory-persona', version: 'e2e' },
}, null, 2))
fs.writeFileSync(path.join(PERSONA, 'registry.json'), JSON.stringify({
  schemaVersion: 1, contractVersion: 1, generation: 1, activeCardId: 'alice',
  cards: {
    alice: { name: 'Alice', source: 'manual', status: 'active', version: 1 },
    tester: { name: '测试员', source: 'manual', status: 'active', version: 1 },
    claimer: { name: '认领测试员', source: 'manual', status: 'active', version: 1 },
  },
  workspaces: { 'C:\\work\\alice': 'alice', [WS]: 'tester' },
  workspaceList: ['C:\\work\\alice', WS],
  sessions: {},
  settings: {},
  updatedAt: now, settingsRevision: 0, settingsUpdatedAt: now,
}, null, 2))

// ── 假宿主 ────────────────────────────────────────────────────────────────
const log = () => {}
function fakeHost({ getExtra = () => undefined } = {}) {
  const provided = {}
  const handlers = new Map()
  const ctx = {
    tools: { register() { return () => {} } },
    logger: { info: log, warn: log, error: log },
    systemPrompt: { section() { return () => {} } },
    settings: { describe: () => [] },
    on(event, cb) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(cb); return () => {} },
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
  return { ctx, provided, handlers }
}

// ── 1. 真加载根藏 → provide jianmuStore ──────────────────────────────────
console.log('\n── 1. 根藏提供 jianmuStore')
const rootHost = fakeHost()
let rootMod
try {
  rootMod = await import('../../../root/index.js')
} catch (e) {
  // monorepo 跨包测试；独立安装的包里没有 ../../root，跳过而不是报假红。
  console.log(`\nSKIP：跨包注册测试需要 monorepo 里的根藏包（${String(e?.code || e?.message || e)}）`)
  process.exit(0)
}
const disposeRoot = rootMod.apply(rootHost.ctx, { enabled: true, autoIngest: false, dataRoot: DATA })
const storeSvc = rootHost.provided.jianmuStore
check('E1 根藏 provide jianmuStore（add/remove/summary）',
  Boolean(storeSvc) && typeof storeSvc.identityAddPersona === 'function'
    && typeof storeSvc.identityRemoveMappings === 'function' && typeof storeSvc.identitySummary === 'function',
  Object.keys(rootHost.provided))
if (!storeSvc) { process.exit(1) }

// ── 2. 加载镜台 + 真写路由 ────────────────────────────────────────────────
console.log('\n── 2. 镜台 /register → 根藏写 identity')
const personaHost = fakeHost({ getExtra: (n) => (n === 'jianmuStore' ? storeSvc : undefined) })
const personaMod = await import('../index.js')
const disposePersona = personaMod.apply(personaHost.ctx, {
  dataRoot: DATA, profile: 'desktop', injectEnabled: false,
})
const { handleWriteRequest } = await import('../lib/httpwrite.mjs')
const postJson = (sub, body, host = personaHost) => handleWriteRequest({
  req: { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-persona': '1' }, body },
  sub, dataRoot: DATA, ctx: host.ctx, cfg: { enabled: true },
})

const readIdentity = () => JSON.parse(fs.readFileSync(path.join(DATA, 'identity.json'), 'utf8'))
const identityBefore = fs.readFileSync(path.join(DATA, 'identity.json'), 'utf8')

const r1 = await postJson('/register', { cardId: 'tester', confirm: true })
check('E2 /register 成功（200 + written）', r1.status === 200 && r1.body?.ok === true && r1.body?.written === true, r1.body)
check('E3 返回里带绑定工作区', Array.isArray(r1.body?.workspaces) && r1.body.workspaces.includes(WS), r1.body?.workspaces)
const id1 = readIdentity()
check('E4 identity 新增 tester + 工作区映射', id1.personas?.tester?.displayName === '测试员' && id1.workspaces?.[WS] === 'tester', { personas: Object.keys(id1.personas || {}), ws: id1.workspaces })
check('E5 旧的人格/映射原样保留', id1.personas?.alice?.displayName === 'Alice' && id1.workspaces?.['C:\\work\\alice'] === 'alice')
check('E6 写前备份存在且 = 原文', Boolean(r1.body?.backup) && fs.existsSync(r1.body.backup) && fs.readFileSync(r1.body.backup, 'utf8') === identityBefore, { backup: r1.body?.backup })

const r2 = await postJson('/register', { cardId: 'tester', confirm: true })
check('E7 第二次 /register 幂等（noop，不重复写）', r2.status === 200 && r2.body?.noop === true && r2.body?.written === false, r2.body)

// ── 3. 停记并删卡（先摘映射、再归档；记忆不动）────────────────────────────
console.log('\n── 3. /delete mode=stop：摘映射 + 归档卡，不删记忆')
const r3 = await postJson('/delete', { cardId: 'tester', expectedGeneration: 1, confirm: true, mode: 'stop' })
check('E8 /delete mode=stop 成功', r3.status === 200 && r3.body?.ok === true && r3.body?.mode === 'stop', r3.body)
check('E9 返回 unregister.removed.workspaces 含 lab workspace',
  Array.isArray(r3.body?.unregister?.removed?.workspaces) && r3.body.unregister.removed.workspaces.includes(WS),
  r3.body?.unregister)
const id2 = readIdentity()
check('E10 identity 映射已摘、persona 声明保留（可重新登记）',
  id2.workspaces?.[WS] === undefined && Boolean(id2.personas?.tester), { ws: id2.workspaces, personas: Object.keys(id2.personas || {}) })
check('E11 别人的人格映射没被动', id2.workspaces?.['C:\\work\\alice'] === 'alice')
check('E12 人格卡已移入 _deleted（软删）',
  !fs.existsSync(path.join(PERSONA, 'cards', 'tester', 'card.md'))
    && fs.readdirSync(path.join(PERSONA, '_deleted')).some((d) => d.endsWith('-tester')),
  fs.existsSync(path.join(PERSONA, '_deleted')) ? fs.readdirSync(path.join(PERSONA, '_deleted')) : null)
check('E13 记忆 scope 原封不动（停记不删记忆）',
  fs.existsSync(path.join(DATA, 'scopes', 'tester', 'chunks.jsonl'))
    && fs.readFileSync(path.join(DATA, 'scopes', 'tester', 'chunks.jsonl'), 'utf8').includes('这条记忆不能被停记删掉'))

// ── 3.5 软认领一个未归属工作区（只补映射 + 绑卡，不搬数据）────────────────
console.log('\n── 3.5 /claim-workspace：软认领（不搬数据）')
const regFile = path.join(PERSONA, 'registry.json')
const genNow = () => JSON.parse(fs.readFileSync(regFile, 'utf8')).generation
const rClaim = await postJson('/claim-workspace', {
  workspace: 'H:\\lab old', cardId: 'claimer', expectedGeneration: genNow(), confirm: true,
})
check('E14 /claim-workspace 成功 + 带软认领说明',
  rClaim.status === 200 && rClaim.body?.ok === true && rClaim.body?.softClaim?.applied === true,
  rClaim.body)
const id3 = readIdentity()
check('E15 identity 新增「lab old → claimer」，旧映射不变',
  id3.workspaces?.['H:\\lab old'] === 'claimer' && id3.workspaces?.['C:\\work\\alice'] === 'alice',
  id3.workspaces)
const reg3 = JSON.parse(fs.readFileSync(regFile, 'utf8'))
check('E16 镜台 registry 也绑定该工作区到 claimer',
  reg3.workspaces?.['H:\\lab old'] === 'claimer', reg3.workspaces)
const rTaken = await postJson('/claim-workspace', {
  workspace: 'C:\\work\\alice', cardId: 'claimer', expectedGeneration: genNow(), confirm: true,
})
const id4 = readIdentity()
check('E17 抢别人工作区 → 409 WORKSPACE_TAKEN，且不改归属',
  rTaken.status === 409 && rTaken.body?.code === 'WORKSPACE_TAKEN'
    && id4.workspaces?.['C:\\work\\alice'] === 'alice',
  { s: rTaken.status, c: rTaken.body?.code, ws: id4.workspaces?.['C:\\work\\alice'] })

// ── 4. 没装根藏 → 拒绝，不代写 ────────────────────────────────────────────
console.log('\n── 4. 没装根藏 → 503，不代写 identity')
const noRootHost = fakeHost()
const beforeNoRoot = fs.readFileSync(path.join(DATA, 'identity.json'), 'utf8')
const r4 = await postJson('/register', { cardId: 'alice', confirm: true }, noRootHost)
check('E18 无根藏 → 503 ROOT_SERVICE_UNAVAILABLE', r4.status === 503 && r4.body?.code === 'ROOT_SERVICE_UNAVAILABLE', { s: r4.status, c: r4.body?.code })
check('E19 拒绝时 identity 一字未动', fs.readFileSync(path.join(DATA, 'identity.json'), 'utf8') === beforeNoRoot)

// ── 收尾 ──────────────────────────────────────────────────────────────────
try { disposePersona() } catch {}
try { disposeRoot() } catch {}
console.log('\n── 汇总')
if (keep) console.log(`  夹具保留：${BASE}`)
else { try { fs.rmSync(BASE, { recursive: true, force: true }) } catch {} }
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
  process.exit(1)
}
