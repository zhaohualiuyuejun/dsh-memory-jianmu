#!/usr/bin/env node
/**
 * tools/plugin-smoke.mjs —— 宿主装配冒烟（不启动 DSH）
 *
 * 用假 ctx 真实调用 index.js 的 apply()，验证：
 *   · 15 个工具真的注册、工具面守卫通过
 *   · jianmuPersona 只读服务注册
 *   · /api/persona GET 路由注册并可用
 *   · status / settings / expand / create 的端到端行为
 *
 * 用法：node tools/plugin-smoke.mjs [--keep]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = path.join(os.tmpdir(), `persona-plugin-smoke-${Date.now()}`)
const DSH = path.join(BASE, 'dshhome')
const DATA = path.join(BASE, 'data')
fs.mkdirSync(DSH, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.DSH_HOME = DSH

fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify({
  version: 1,
  personas: { alice: { displayName: 'Alice' }, bob: { displayName: 'Bob' } },
  workspaces: { 'C:\\work\\alice': 'alice' },
  sessions: {},
}, null, 2))
fs.mkdirSync(path.join(DSH, 'soul-md', 'memory', 'Alice', 'topics'), { recursive: true })
fs.writeFileSync(path.join(DSH, 'soul-md', 'memory', 'Alice', 'core.md'), '# core\n\n测试记忆。\n')

const soulConfig = {
  cards: {
    'Alice': '# Alice\n\n## 身份与外貌\n示例助手。\n\n## 红线\n不冒充官方。\n\n## 核心工作准则\n- 先量化。\n\n## 经典对话示例\n用户：「你好。」\nAlice：「遵命。」\n',
  },
  active: 'Alice', sessions: {}, workspaces: { 'C:\\work\\alice': 'Alice' }, workspaceList: [],
  memory: { inject: true, layered: true, injectMaxChars: 12000, recall: 'off', indexMode: 'all', recallMaxTopics: 8, recallMaxChars: 1600, compactionRecall: true, maxBytes: 262144 },
  allowTemplates: false, skipSubagents: false,
}

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`) }
}

const registered = new Map()
const provided = {}
const sections = []
const handlers = new Map()
let conflictCalls = 0
let fakeConflictCards = null
// P4 #5/#6：根藏身份服务（身份写只有根藏能做的那个）
const rootIdentityCalls = { add: [], remove: [] }
let hideRootStore = false
const fakeRootStore = {
  version: 1,
  async identityAddPersona(opts) {
    rootIdentityCalls.add.push(opts)
    return { ok: true, written: true, displayName: opts.displayName, workspaces: opts.workspaces, sessions: opts.sessions, backup: 'fake-backup.json' }
  },
  async identityRemoveMappings(opts) {
    rootIdentityCalls.remove.push(opts)
    return { ok: true, written: true, removed: { workspaces: opts.workspaces || [], sessions: opts.sessions || [] } }
  },
  async identitySummary() {
    return { ok: true, personas: [], workspaces: 0, sessions: 0, defaultPersonaId: null }
  },
}
let route = null
const logger = { info: () => {}, warn: () => {}, error: () => {} }
const fakeLlmText = '## 身份与外貌\n你是一只会写代码的示例助手。\n\n## 红线\n不冒充官方。\n\n## 行为准则\n- 先量化。\n\n## 风格示例\n用户：「你好。」\nAlice：「*摆尾* 遵命。」'

const ctx = {
  tools: {
    register(def) { registered.set(def.name, def); return () => registered.delete(def.name) },
  },
  logger,
  systemPrompt: {
    section(def) {
      // 宿主契约：section 返回 disposer；text 可以是函数（每轮现算）
      sections.push(def)
      return () => { const i = sections.indexOf(def); if (i >= 0) sections.splice(i, 1) }
    },
  },
  settings: { describe: () => [{ ns: 'soul-md', value: soulConfig }] },
  on(event, cb) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(cb)
    return () => {}
  },
  provide(n, svc) { provided[n] = svc; return () => {} },
  inject(names, cb) {
    const sub = {
      webServer: { register(r) { route = r; return () => { route = null } } },
      effect(fn) { return fn() },
    }
    cb(sub)
  },
  get(n) {
    if (n === 'jianmuStore') return hideRootStore ? undefined : fakeRootStore
    if (n === 'jianmuConflicts') {
      return {
        version: 1,
        async list(req) {
          conflictCalls += 1
          return fakeConflictCards ? fakeConflictCards(req) : { ok: true, cards: [] }
        },
      }
    }
    if (n === 'settings') return ctx.settings
    if (n === 'llm') {
      return {
        prepareCall: async (call) => ({
          config: call,
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: fakeLlmText }
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      }
    }
    if (n === 'sessionController') {
      return {
        projections: async () => ({ values: { modelSelection: { next: { provider: 'fake', providerName: 'Fake', model: 'fake-1' } } } }),
        modelCatalog: async () => ({ default: { provider: 'fake', model: 'fake-1' }, groups: [] }),
      }
    }
    if (n === 'webServer') return { register(r) { route = r; return () => {} } }
    return undefined
  },
}

const mod = await import('../index.js')
const cfg = { dataRoot: DATA, profile: 'desktop' }
const dispose = mod.apply(ctx, cfg)
const toolNames = dispose.toolNames || [...registered.keys()]

console.log('── A. 装配')
check('A1 apply 返回 dispose', typeof dispose === 'function')
check('A2 注册 18 个工具', toolNames.length === 18, toolNames)
check('A3 工具面 = 契约 18 件', toolNames.slice().sort().join(',') === [
  'jianmu_persona_status', 'jianmu_persona_list', 'jianmu_persona_card', 'jianmu_persona_versions',
  'jianmu_persona_diff', 'jianmu_persona_create', 'jianmu_persona_save', 'jianmu_persona_delete',
  'jianmu_persona_set_default', 'jianmu_persona_bind', 'jianmu_persona_rollback', 'jianmu_persona_import',
  'jianmu_persona_expand', 'jianmu_persona_preview', 'jianmu_persona_settings',
  'jianmu_persona_memory_list', 'jianmu_persona_memory_read', 'jianmu_persona_memory_append',
].sort().join(','))
check('A4 注册 jianmuPersona 只读服务', Boolean(provided.jianmuPersona) && typeof provided.jianmuPersona.status === 'function')
check('A5 注册 /api/persona 路由', Boolean(route) && route.path === '/api/persona')

console.log('\n── B. 工具端到端')
const exec = { agent: { session: { id: 's1', header: { cwd: 'C:\\work\\alice' } } } }
const call = async (name, args = {}) => {
  const def = registered.get(name)
  if (!def) throw new Error(`未注册：${name}`)
  return def.execute(args, exec)
}

const st = await call('jianmu_persona_status')
check('B1 status ok / 未初始化', st.ok === true && st.initialized === false, st.error)
const needGen = await call('jianmu_persona_create', { cardId: 'alice', name: 'Alice', expectedGeneration: 0, confirm: true })
check('B2 create 成功（gen 0 → 1）', needGen.ok === true && needGen.version === 1, needGen.error)
check('B3 create 写后读回 found', needGen.readback?.status === 'found')

// 夹具：把 alice 卡从「空模板」改写成真实正文（含唯一标记）。
// 默认卡源已切到 jianmu（建木真源）：模板卡会被注入侧判定为「未初始化」而回退 soul-md，
// 所以 G 组要验「读卡文件」就必须先造一张非模板的真卡。
{
  const { parseCard, serializeCard } = await import('../lib/card.mjs')
  const aliceCardFile = path.join(st.dataRoot, 'persona', 'cards', 'alice', 'card.md')
  const fm = parseCard(fs.readFileSync(aliceCardFile, 'utf8')).frontMatter
  const body = [
    '# Alice',
    '',
    '## 身份与外貌',
    '建木真卡正文。MARK-JIANMU-CARD-777',
    '',
    '## 红线',
    '不冒充官方。',
    '',
    '## 行为准则',
    '- 先量化。',
    '',
    '## 风格示例',
    '用户：「你好。」',
    'Alice：「遵命。」',
    '',
  ].join('\n')
  fs.writeFileSync(aliceCardFile, serializeCard(fm, body))
}
const list = await call('jianmu_persona_list')
check('B4 list 看到 1 张卡', list.ok && list.cards.length === 1 && list.cards[0].cardId === 'alice')
const g1 = (await call('jianmu_persona_status')).generation
const bind = await call('jianmu_persona_bind', { scope: 'workspace', key: 'C:\\work\\alice', cardId: 'alice', expectedGeneration: g1, confirm: true })
check('B4b 工作区绑定成功', bind.ok === true, bind.error)

// 写工具省略 cardId：必须按会话工作区解析，不能写默认卡
const gA = (await call('jianmu_persona_status')).generation
const ca = await call('jianmu_persona_create', { cardId: 'carda', name: '卡A', expectedGeneration: gA, confirm: true })
check('B4c 建 carda 成功', ca.ok === true, ca.error)
const gB = (await call('jianmu_persona_status')).generation
const cb = await call('jianmu_persona_create', { cardId: 'cardb', name: '卡B', expectedGeneration: gB, confirm: true })
check('B4d 建 cardb 成功', cb.ok === true, cb.error)
const gC = (await call('jianmu_persona_status')).generation
check('B4e 设默认 cardb', (await call('jianmu_persona_set_default', { cardId: 'cardb', expectedGeneration: gC, confirm: true })).ok === true)
const gD = (await call('jianmu_persona_status')).generation
check('B4f 绑定 ws-a → carda', (await call('jianmu_persona_bind', { scope: 'workspace', key: 'H:\\ws-a', cardId: 'carda', expectedGeneration: gD, confirm: true })).ok === true)
const gE = (await call('jianmu_persona_status')).generation
const execA = { agent: { session: { id: 'sa', header: { cwd: 'H:\\ws-a' } } } }
const defSave = await registered.get('jianmu_persona_save').execute({ behavior: '## 行为准则\n按工作区写入。\n', expectedGeneration: gE, confirm: true }, execA)
check('B4g 省略 cardId 的 save 成功', defSave.ok === true, defSave.error)
check('B4h 写进 carda 而不是默认 cardb', defSave.cardId === 'carda', defSave.cardId)
check('B4i carda 版本=2', (await call('jianmu_persona_card', { cardId: 'carda' })).version === 2)
check('B4j cardb 版本仍=1', (await call('jianmu_persona_card', { cardId: 'cardb' })).version === 1)
const gG = (await call('jianmu_persona_status')).generation
const aiSave = await call('jianmu_persona_save', { cardId: 'carda', behavior: '## 行为准则\nAI 草稿。\n', author: 'ai-expand', note: 'fake/fake-1', expectedGeneration: gG, confirm: true })
const cardaVers = await call('jianmu_persona_versions', { cardId: 'carda' })
check('B4k save author=ai-expand 落到版本链', aiSave.ok === true && cardaVers.versions[0].author === 'ai-expand', { ok: aiSave.ok, author: cardaVers.versions?.[0]?.author })
// 恢复默认卡，避免影响后续断言
const gF = (await call('jianmu_persona_status')).generation
await call('jianmu_persona_set_default', { cardId: 'alice', expectedGeneration: gF, confirm: true })
const setBad = await call('jianmu_persona_settings', { patch: { inject: { layered: true } } })
check('B5 写设置：未知字段 → UNKNOWN_SETTING', setBad.ok === false && setBad.code === 'UNKNOWN_SETTING', setBad.error)
const setPreview = await call('jianmu_persona_settings', { patch: { injectMaxChars: 9000 } })
check('B5b 不传 confirm → 只预览、不落盘', setPreview.ok === true && setPreview.preview === true && Array.isArray(setPreview.willChange), setPreview)
const gS = (await call('jianmu_persona_status')).generation
const setWrite = await call('jianmu_persona_settings', { patch: { injectMaxChars: 9000 }, expectedGeneration: gS, confirm: true })
check('B5c 带 confirm + generation → 真写 registry.settings', setWrite.ok === true && setWrite.changed.includes('injectMaxChars') && setWrite.effective.injectMaxChars === 9000, setWrite.error)
const settings = await call('jianmu_persona_settings')
check('B6 读设置 ok', settings.ok && settings.view.inject.layered === true)
const beforeCount = (await call('jianmu_persona_list')).cards.length
const exp = await call('jianmu_persona_expand', { seed: '你是一只会写代码的示例助手', name: 'Alice', confirmOverwrite: true })
check('B7 expand 返回草稿且未落盘', exp.ok === true && exp.draft.includes('## 身份与外貌') && exp.provider === 'fake')
check('B8 expand 后卡片数量不变', (await call('jianmu_persona_list')).cards.length === beforeCount)
const prev = await call('jianmu_persona_preview', { cardId: 'alice' })
check('B9 preview ok 且有人格段', prev.ok && prev.persona.chars > 0, prev.error)

console.log('\n── C. HTTP 只读路由')
function fakeRes() {
  const out = { statusCode: 0, headers: {}, body: '' }
  return {
    get statusCode() { return out.statusCode },
    set statusCode(v) { out.statusCode = v },
    setHeader(k, v) { out.headers[k] = v },
    end(b) { out.body = b },
    _out: out,
  }
}
async function http(method, url, opts = {}) {
  const res = fakeRes()
  const req = { method, url, headers: opts.headers || {}, body: opts.body }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res._out.body) } catch { /* ignore */ }
  return { status: res._out.statusCode, json, headers: res._out.headers }
}
const h1 = await http('GET', '/api/persona/status')
check('C1 GET /status 200 + ok', h1.status === 200 && h1.json?.ok === true, h1.json?.error)
const h2 = await http('GET', '/api/persona/cards')
check('C2 GET /cards 200 + 至少 1 张', h2.status === 200 && (h2.json?.cards?.length || 0) >= 1)
const h3 = await http('GET', '/api/persona/card?cardId=alice')
check('C3 GET /card 200 + 分区', h3.status === 200 && h3.json?.zones?.length > 0)
const h4 = await http('GET', '/api/persona/preview?cardId=alice')
check('C4 GET /preview 200 + 段落', h4.status === 200 && h4.json?.segments?.length >= 2)
const h5 = await http('PUT', '/api/persona/status')
check('C5 非 GET/POST → 405', h5.status === 405 && h5.json?.code === 'METHOD_NOT_ALLOWED')
check('C5b 405 带 Allow 头', String(h5.headers.allow || '').includes('GET') && String(h5.headers.allow || '').includes('POST'))
const h6 = await http('GET', '/api/persona/nope')
check('C6 未知端点 → 404', h6.status === 404)
check('C7 JSON content-type', (h1.headers['content-type'] || '').includes('application/json'))
check('C8 不带任何 CORS 头', !Object.keys(h1.headers).some((k) => /^access-control-/i.test(k)))

console.log('\n── E. HTTP 写动作（v1a.1）')
const post = (sub, body, extra = {}) => http('POST', `/api/persona${sub}`, {
  headers: { 'content-type': 'application/json', 'x-dsh-persona': '1', ...(extra.headers || {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
})
const gen = async () => (await call('jianmu_persona_status')).generation
const saveBody = (behavior) => `## 身份与外貌\n示例助手。\n\n## 红线\n不冒充官方。\n\n## 行为准则\n${behavior}\n\n## 风格示例\n用户：「你好。」\nAlice：「遵命。」\n`

// E1–E6 安全闸
const e1 = await post('/save', { cardId: 'alice', content: 'x', expectedGeneration: await gen(), confirm: true }, { headers: { 'x-dsh-persona': '' } })
check('E1 缺 x-dsh-persona → 403 CSRF_BLOCKED', e1.status === 403 && e1.json?.code === 'CSRF_BLOCKED', { s: e1.status, c: e1.json?.code })
const e2 = await post('/save', { cardId: 'alice', content: 'x', expectedGeneration: await gen(), confirm: true }, { headers: { 'content-type': 'text/plain' } })
check('E2 非 JSON content-type → 415', e2.status === 415 && e2.json?.code === 'UNSUPPORTED_MEDIA_TYPE', { s: e2.status, c: e2.json?.code })
const e3 = await http('POST', '/api/persona/save', {
  headers: { 'content-type': 'application/json', 'x-dsh-persona': '1', origin: 'https://evil.example', host: '127.0.0.1:19387' },
  body: JSON.stringify({ cardId: 'alice', content: 'x', expectedGeneration: await gen(), confirm: true }),
})
check('E3 跨站 Origin → 403', e3.status === 403 && e3.json?.code === 'CSRF_BLOCKED', { s: e3.status, c: e3.json?.code })
const e4 = await post('/save', { cardId: 'alice', content: 'x', expectedGeneration: await gen() })
check('E4 缺 confirm → 400 CONFIRM_REQUIRED', e4.status === 400 && e4.json?.code === 'CONFIRM_REQUIRED', { s: e4.status, c: e4.json?.code })
const e5 = await post('/save', '这不是 JSON')
check('E5 非法 JSON → 400 BAD_JSON', e5.status === 400 && e5.json?.code === 'BAD_JSON', { s: e5.status, c: e5.json?.code })
const e6 = await post('/nope', { confirm: true })
check('E6 未知写端点 → 404', e6.status === 404 && e6.json?.code === 'NOT_FOUND', { s: e6.status, c: e6.json?.code })

// E7–E9 正常保存：版本 +1、快照、generation
const gSave = await gen()
const e7 = await post('/save', { cardId: 'carda', behavior: '## 行为准则\n- HTTP 保存成功。\n', expectedGeneration: gSave, confirm: true, note: 'http save' })
check('E7 POST /save 成功 + generation+1', e7.status === 200 && e7.json?.ok === true && e7.json.generation === gSave + 1, { s: e7.status, ok: e7.json?.ok, g: e7.json?.generation })
const e8 = await call('jianmu_persona_card', { cardId: 'carda' })
check('E8 保存后版本 = ' + (e7.json?.version || '?') + '，正文含新行为', e8.version === e7.json?.version && String(e8.body).includes('HTTP 保存成功'))
const snapDir = path.join(DATA, 'persona', 'cards', 'carda', '_archive')
check('E9 _archive 有该版本快照', fs.existsSync(snapDir) && fs.readdirSync(snapDir).some((n) => n.startsWith(`revision-${e7.json?.version}-`)))

// E10 旧 generation → 409
const e10 = await post('/save', { cardId: 'carda', behavior: '## 行为准则\n- 旧 generation\n', expectedGeneration: gSave, confirm: true })
check('E10 旧 generation → 409 STALE_GENERATION', e10.status === 409 && e10.json?.code === 'STALE_GENERATION', { s: e10.status, c: e10.json?.code })

// E11 改身份区 → 拒绝；E12 显式二次确认才放行
const curA = await call('jianmu_persona_card', { cardId: 'carda' })
const idZone = (curA.zones || []).find((z) => z.zone === 'identity' && z.title)
const tampered = idZone
  ? curA.body.slice(0, idZone.start) + '## 身份与外貌\n被改掉的身份。\n\n' + curA.body.slice(idZone.end)
  : curA.body
const e11 = await post('/save', { cardId: 'carda', content: tampered, expectedGeneration: await gen(), confirm: true })
check('E11 改身份区 → 409 IMMUTABLE_SECTION_CHANGED', e11.status === 409 && e11.json?.code === 'IMMUTABLE_SECTION_CHANGED', { s: e11.status, c: e11.json?.code })
const e12 = await post('/save', { cardId: 'carda', content: tampered, expectedGeneration: await gen(), confirm: true, allowProtectedSectionsChange: true })
check('E12 allowProtectedSectionsChange 才放行（AI 草稿二次确认路径）', e12.status === 200 && e12.json?.ok === true, { s: e12.status, c: e12.json?.code })

// E13 默认卡不能删
const e13 = await post('/delete', { cardId: 'alice', expectedGeneration: await gen(), confirm: true })
check('E13 删默认卡 → 409 DEFAULT_CARD_PROTECTED', e13.status === 409 && e13.json?.code === 'DEFAULT_CARD_PROTECTED', { s: e13.status, c: e13.json?.code })

// E14 默认卡切换
const e14 = await post('/default', { cardId: 'carda', expectedGeneration: await gen(), confirm: true })
const regAfter = await call('jianmu_persona_list')
check('E14 POST /default 改默认卡', e14.status === 200 && e14.json?.activeCardId === 'carda', { s: e14.status, a: e14.json?.activeCardId })
check('E14b 卡片列表默认标记跟着变', regAfter.cards.some((c) => c.cardId === 'carda' && c.isDefault))
await post('/default', { cardId: 'alice', expectedGeneration: await gen(), confirm: true })

// E15 绑定 / 删除绑定
const e15 = await post('/bind', { scope: 'workspace', key: 'H:\\http-ws', cardId: 'carda', expectedGeneration: await gen(), confirm: true })
check('E15 POST /bind 写工作区', e15.status === 200 && e15.json?.cardId === 'carda', { s: e15.status, c: e15.json?.code })
const e16 = await post('/bind', { scope: 'workspace', key: 'H:\\http-ws', cardId: '', expectedGeneration: await gen(), confirm: true })
check('E16 cardId="" 删除绑定', e16.status === 200 && e16.json?.cardId === null, { s: e16.status, c: e16.json?.cardId })

// ── P4 #6/#7：一键登记 / 删卡三选项（走根藏服务，镜台不直接写 identity）──
const e16b = await post('/register', { cardId: 'carda', confirm: true })
const addCall = rootIdentityCalls.add[0] || null
check('E16b POST /register 调根藏 identityAddPersona', e16b.status === 200 && e16b.json?.ok === true && rootIdentityCalls.add.length === 1, { s: e16b.status, n: rootIdentityCalls.add.length, c: e16b.json?.code })
check('E16c 登记参数：personaId=cardId、卡名、绑定工作区',
  addCall?.personaId === 'carda' && addCall?.displayName === '卡A'
    && Array.isArray(addCall?.workspaces) && addCall.workspaces.includes('H:\\ws-a'),
  { personaId: addCall?.personaId, name: addCall?.displayName, ws: addCall?.workspaces })

const beforeRemove = rootIdentityCalls.remove.length
const e16d = await post('/delete', { cardId: 'cardb', expectedGeneration: await gen(), confirm: true, mode: 'archive' })
check('E16d mode=archive（默认）：只归档卡，不碰 identity',
  e16d.status === 200 && e16d.json?.ok === true && rootIdentityCalls.remove.length === beforeRemove,
  { s: e16d.status, remove: rootIdentityCalls.remove.length - beforeRemove, c: e16d.json?.code })

const gStop = await call('jianmu_persona_status')
const mkStop = await call('jianmu_persona_create', { cardId: 'stopcard', name: '停记卡', expectedGeneration: gStop.generation, confirm: true })
await call('jianmu_persona_bind', { scope: 'workspace', key: 'H:\\stop-ws', cardId: 'stopcard', expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
const e16e = await post('/delete', { cardId: 'stopcard', expectedGeneration: await gen(), confirm: true, mode: 'stop' })
const rmCall = rootIdentityCalls.remove[rootIdentityCalls.remove.length - 1] || null
check('E16e mode=stop：先摘映射再归档卡',
  mkStop.ok === true && e16e.status === 200 && e16e.json?.ok === true
    && rmCall?.personaId === 'stopcard' && (rmCall?.workspaces || []).includes('H:\\stop-ws'),
  { created: mkStop.ok, s: e16e.status, rm: rmCall, c: e16e.json?.code })
check('E16f stop 后卡确实已归档（列表里没有）', !(await call('jianmu_persona_list')).cards.some((c) => c.cardId === 'stopcard'))

hideRootStore = true
const e16g = await post('/register', { cardId: 'carda', confirm: true })
check('E16g 没装根藏 → 503 ROOT_SERVICE_UNAVAILABLE（不代写文件）',
  e16g.status === 503 && e16g.json?.code === 'ROOT_SERVICE_UNAVAILABLE', { s: e16g.status, c: e16g.json?.code })
hideRootStore = false

// E16h：默认卡「停记」必须在摘映射之前拦下（否则会映射没了、卡还在）
const beforeStopDefault = rootIdentityCalls.remove.length
const e16h = await post('/delete', { cardId: 'alice', expectedGeneration: await gen(), confirm: true, mode: 'stop' })
check('E16h 默认卡停记 → 409 DEFAULT_CARD_PROTECTED 且未摘映射',
  e16h.status === 409 && e16h.json?.code === 'DEFAULT_CARD_PROTECTED' && rootIdentityCalls.remove.length === beforeStopDefault,
  { s: e16h.status, c: e16h.json?.code, remove: rootIdentityCalls.remove.length - beforeStopDefault })

// E17 回滚 = 新版本
const vs = await call('jianmu_persona_versions', { cardId: 'carda' })
const target = vs.versions.find((v) => v.snapshot && !v.isCurrent)
const e17 = target ? await post('/rollback', { cardId: 'carda', revision: target.revision, expectedGeneration: await gen(), confirm: true }) : null
check('E17 POST /rollback 成功 → 新版本', Boolean(e17) && e17.status === 200 && e17.json?.ok === true, { s: e17?.status, c: e17?.json?.code })

// E18 AI 生成（POST /expand 只回草稿）
const beforeCards = (await call('jianmu_persona_list')).cards.length
const e18 = await post('/expand', { seed: '你是一只会写代码的示例助手', name: 'Alice', cardId: 'carda', existingContent: saveBody('- seed'), confirmOverwrite: true })
check('E18 POST /expand 返回草稿且未落盘', e18.status === 200 && e18.json?.ok === true && String(e18.json?.draft).includes('## 身份与外貌'), { s: e18.status, c: e18.json?.code })
check('E18b expand 后卡片数不变', (await call('jianmu_persona_list')).cards.length === beforeCards)

// E19 写完 GET 仍可用
const e19 = await http('GET', '/api/persona/status')
check('E19 POST 之后 GET /status 仍 200', e19.status === 200 && e19.json?.ok === true)

// E20–E23 注入设置写路由（v2）
const e20 = await post('/settings', { patch: { injectMaxChars: 7000 } })
check('E20 POST /settings 缺 confirm → 400 CONFIRM_REQUIRED', e20.status === 400 && e20.json?.code === 'CONFIRM_REQUIRED', { s: e20.status, c: e20.json?.code })
const e21 = await post('/settings', { patch: { nope: 1 }, expectedGeneration: await gen(), confirm: true })
check('E21 POST /settings 未知字段 → 400 UNKNOWN_SETTING', e21.status === 400 && e21.json?.code === 'UNKNOWN_SETTING', { s: e21.status, c: e21.json?.code })
const gSet = await gen()
const e22 = await post('/settings', { patch: { injectMaxChars: 7000 }, expectedGeneration: gSet, confirm: true })
check('E22 POST /settings 成功 + generation+1', e22.status === 200 && e22.json?.ok === true && e22.json?.changed?.includes('injectMaxChars') && e22.json?.generation === gSet + 1, { s: e22.status, c: e22.json?.code, g: e22.json?.generation })
const e23 = await http('GET', '/api/persona/settings')
check('E23 GET /settings 读到新值（写后立即生效）',
  e23.json?.jianmu?.values?.injectMaxChars === 7000 && e23.json?.jianmu?.settingsSource === 'registry' && e23.json?.jianmu?.settingsRevision >= 1,
  { v: e23.json?.jianmu?.values, src: e23.json?.jianmu?.settingsSource })
const e24 = await post('/settings', { patch: { injectMaxChars: 7000 }, expectedGeneration: gSet, confirm: true })
check('E24 旧 generation → 409 STALE_GENERATION', e24.status === 409 && e24.json?.code === 'STALE_GENERATION', { s: e24.status, c: e24.json?.code })

console.log('\n── F. 配置归一化回归（宿主把字符串字段当对象传进来）')
{
  // 2026-11-07 实机：desktop 宿主传给 apply 的 config 里 dataRoot/profile 是对象，
  // 旧 normalizeConfig 会 String() 成 "[object Object]"，dataRoot 落进 profile 目录 →
  // 路径闸门拒绝 → 整个插件在 apply 阶段挂掉（工具与路由全无）。
  const reg2 = new Map()
  let route2 = null
  const ctx2 = {
    tools: { register(d) { reg2.set(d.name, d); return () => reg2.delete(d.name) } },
    logger,
    settings: { describe: () => [] },
    provide() { return () => {} },
    inject(names, cb) { cb({ webServer: { register(r) { route2 = r; return () => { route2 = null } } }, effect(f) { return f() } }) },
    get() { return undefined },
  }
  let threw = null
  try {
    mod.apply(ctx2, {
      enabled: true,
      dataRoot: { type: 'string', default: '' },
      profile: { type: 'string', default: 'desktop' },
      expandProvider: { type: 'string' },
      expandModel: { type: 'string' },
      expandMaxInputChars: 8000,
      expandMaxOutputTokens: 8000,
      expandTimeoutMs: 60000,
      expandRetries: 1,
    })
  } catch (e) { threw = e }
  check('F1 对象型配置不再让 apply 抛错', threw === null, threw && String(threw.message || threw))
  check('F2 仍注册 18 个工具', reg2.size === 18, reg2.size)
  check('F3 路由仍注册', Boolean(route2))
  const st2 = reg2.has('jianmu_persona_status') ? await reg2.get('jianmu_persona_status').execute({}, exec) : null
  check('F4 dataRoot 回退默认，不是 [object Object]', Boolean(st2) && st2.ok === true && !String(st2.dataRoot).includes('[object Object]'), st2?.dataRoot)
  check('F5 profile 回退 desktop', Boolean(st2) && st2.soulMd?.profile?.profile === 'desktop', st2?.soulMd?.profile)
}

console.log('\n── D. 读服务')
const svc = provided.jianmuPersona
const s1 = await svc.status()
check('D1 service.status ok', s1.ok === true)
const s2 = await svc.cards()
check('D2 service.cards 至少 1 张', s2.ok && s2.cards.length >= 1)
const s3 = await svc.resolveCard({ workspace: 'C:\\work\\alice' })
check('D3 service.resolveCard 按工作区', s3.ok && s3.cardId === 'alice', s3)

console.log('\n── G. 注入段（v2 接管：人格 + 记忆都要读建木自己的根）')
{
  const sec = (n) => sections.find((s) => s.name === n)
  check('G1 注册 jianmu:persona / jianmu:memory 两段', Boolean(sec('jianmu:persona')) && Boolean(sec('jianmu:memory')), sections.map((s) => s.name))
  const asm = (sid) => ({ agent: { workspace: 'C:\\work\\alice', session: { id: sid, header: { cwd: 'C:\\work\\alice' } } } })
  // DSH 给委派子会话打 origin: "subagent"
  const asmSub = (sid) => ({ agent: { workspace: 'C:\\work\\alice', session: { id: sid, header: { cwd: 'C:\\work\\alice', origin: 'subagent' } } } })
  // 每个断言用不同 sid：注入缓存 key = ws+sid，避免 5s 缓存把旧值喂回来
  const segText = async (n, sid) => String(await Promise.resolve(sec(n)?.text?.(asm(sid)) ?? ''))
  const segTextSub = async (n, sid) => String(await Promise.resolve(sec(n)?.text?.(asmSub(sid)) ?? ''))

  const personaTxt = await segText('jianmu:persona', 'g1')
  check('G2 人格段含卡片正文（默认卡源=jianmu，读建木卡文件）', personaTxt.includes('MARK-JIANMU-CARD-777'), personaTxt.slice(0, 80))

  // 关键回归：夹具在 soul-md 旧根（DSH/soul-md/memory）放了「测试记忆。」，
  // 建木根（DATA/persona/memory）这时还没有任何记忆。
  // 若注入仍读旧根，这段文字就会漏进来 —— 这个断言就是用来「能红」的。
  const mem0 = await segText('jianmu:memory', 'g2')
  check('G3 注入不读 soul-md 旧记忆根（建木根还空 → 段应为空）', mem0 === '', mem0.slice(0, 160))

  const a1 = await call('jianmu_persona_memory_append', { scope: 'Alice', topic: 'smoke-topic', text: '2026-11-08 — smoke：注入必须读建木根\n\n- 标记：SMOKE-MARK-9F3。', confirm: true })
  check('G4 写入建木记忆 topic 成功', a1.ok === true && a1.written === true, a1.error)
  const mem1 = await segText('jianmu:memory', 'g3')
  check('G5 新 topic 立刻进注入索引（工具写、注入读同一个根）', mem1.includes('smoke-topic') && mem1.includes('注入必须读建木根'), mem1.slice(0, 240))

  const gOff = await call('jianmu_persona_settings', { patch: { injectEnabled: false }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const offTxt = await segText('jianmu:persona', 'g4')
  check('G6 关接管 → 注入段当场变空（不必重启）', gOff.ok === true && offTxt === '', { ok: gOff.ok, txt: offTxt.slice(0, 60) })

  const gOn = await call('jianmu_persona_settings', { patch: { injectEnabled: true }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const onTxt = await segText('jianmu:persona', 'g5')
  check('G7 再打开 → 注入恢复', gOn.ok === true && onTxt.includes('MARK-JIANMU-CARD-777'), { ok: gOn.ok, txt: onTxt.slice(0, 60) })

  // ── 卡源切换（cardSource）：jianmu = 镜台卡真源；读不到自动回退 soul-md ──
  const gSW = await call('jianmu_persona_settings', { patch: { cardSource: 'jianmu' }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const jTxt = await segText('jianmu:persona', 'g6')
  check('G8 cardSource 可写且生效', gSW.ok === true && gSW.effective?.cardSource === 'jianmu', { ok: gSW.ok, eff: gSW.effective })
  check('G9 切到镜台卡后注入换源（读卡文件正文，不是 soul-md 正文）',
    jTxt.includes('MARK-JIANMU-CARD-777') && !jTxt.includes('示例助手'), jTxt.slice(0, 80))
  const pv = await call('jianmu_persona_preview')
  check('G10 预览与实际注入同源（persona.source=jianmu + cardFile 指向 cards）',
    pv.persona?.source === 'jianmu' && String(pv.persona?.file || '').includes('cards'), { src: pv.persona?.source, file: pv.persona?.file })
  const gBack = await call('jianmu_persona_settings', { patch: { cardSource: 'soul-md' }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const bTxt = await segText('jianmu:persona', 'g7')
  check('G11 切回 soul-md 卡源 → 注入还原', gBack.ok === true && bTxt.includes('示例助手') && !bTxt.includes('MARK-JIANMU-CARD-777'), bTxt.slice(0, 60))

  // ── G12/G13：模拟「卸载 soul-md」——这是 soul-md 能不能卸载的判据 ──
  // 把 settings 里的 soul-md 行整个拿掉（等价于插件被卸载：settings/loader/configEditor 全读不到）
  await call('jianmu_persona_settings', { patch: { cardSource: 'jianmu' }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const originalDescribe = ctx.settings.describe
  ctx.settings.describe = () => []
  const pTxt2 = await segText('jianmu:persona', 'g8')
  const mTxt2 = await segText('jianmu:memory', 'g9')
  ctx.settings.describe = originalDescribe
  check('G12 卸载 soul-md 后：人格段仍注入（来自镜台卡文件）', pTxt2.length > 0 && pTxt2.includes('MARK-JIANMU-CARD-777'), pTxt2.slice(0, 80))
  check('G13 卸载 soul-md 后：记忆段仍注入（来自建木记忆根）', mTxt2.length > 0 && mTxt2.includes('smoke-topic'), mTxt2.slice(0, 120))
  const pTxt3 = await segText('jianmu:persona', 'g10')
  check('G14 恢复 soul-md 配置后仍正常（无残留状态）', pTxt3.length > 0, pTxt3.slice(0, 60))

  // G15：绑定 none → 预览的人格与记忆都必须为空（以前预览会显示 global 记忆）
  await call('jianmu_persona_bind', { scope: 'workspace', key: 'H:\\none-ws', cardId: 'none', expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const pvNone = await call('jianmu_persona_preview', { workspace: 'H:\\none-ws' })
  check('G15 绑定 none 的预览：人格空 + 记忆空（与注入一致）',
    pvNone.ok === true && pvNone.persona?.chars === 0 && pvNone.memory?.chars === 0,
    { p: pvNone.persona?.chars, m: pvNone.memory?.chars, src: pvNone.cardSource })

  // G16：预览传 cardId 应生效（以前 v2 分支忽略它）
  const pvCard = await call('jianmu_persona_preview', { cardId: 'carda' })
  check('G16 预览传 cardId 生效并说明来源',
    pvCard.ok === true && pvCard.cardId === 'carda' && /cardId/.test(String(pvCard.resolution?.reason || '')),
    { id: pvCard.cardId, why: pvCard.resolution?.reason })

  // G17/G18：默认卡源切到 jianmu 之后的「空模板卡」护栏。
  // 新建的卡是占位模板（身份/红线写「（待填写：…）」）；若直接注入，人格段会变成占位文字。
  // 期望：模板卡视为「未初始化」→ 回退 soul-md 真卡；soul-md 也没有 → 空人格，绝不注入「待填写」。
  const gTpl = (await call('jianmu_persona_status')).generation
  await call('jianmu_persona_create', { cardId: 'cardtpl', name: '模板卡', expectedGeneration: gTpl, confirm: true })
  await call('jianmu_persona_bind', { scope: 'workspace', key: 'H:\\tpl-ws', cardId: 'cardtpl', expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  await call('jianmu_persona_settings', { patch: { cardSource: 'jianmu' }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const pvTpl = await call('jianmu_persona_preview', { workspace: 'H:\\tpl-ws' })
  check('G17 模板卡回退 soul-md（不注入「待填写」占位）',
    pvTpl.ok === true && pvTpl.persona?.source === 'soul-md'
      && String(pvTpl.persona?.text || '').includes('示例助手')
      && !String(pvTpl.persona?.text || '').includes('待填写'),
    { src: pvTpl.persona?.source, chars: pvTpl.persona?.chars, reason: pvTpl.fallbackReason })
  if (originalDescribe) ctx.settings.describe = () => []
  const pvTpl2 = await call('jianmu_persona_preview', { workspace: 'H:\\tpl-ws' })
  if (originalDescribe) ctx.settings.describe = originalDescribe
  check('G18 模板卡 + soul-md 不可用 → 空人格（不注入占位文字）',
    pvTpl2.ok === true && pvTpl2.persona?.chars === 0 && !String(pvTpl2.persona?.text || '').includes('待填写'),
    { chars: pvTpl2.persona?.chars, warnings: pvTpl2.warnings })

  // G19/G20：子代理会话跳过注入（2026-11-08 新增设置项）
  await call('jianmu_persona_settings', { patch: { subagentSkip: false }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const subOff = await segTextSub('jianmu:persona', 'sub-off')
  check('G19 subagentSkip=关 → 子代理会话仍注入', subOff.length > 0, subOff.slice(0, 40))
  await call('jianmu_persona_settings', { patch: { subagentSkip: true }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const subOn = await segTextSub('jianmu:persona', 'sub-on')
  const normalOn = await segText('jianmu:persona', 'g-after-sub')
  check('G20 subagentSkip=开 → 子代理空、普通会话仍注入',
    subOn === '' && normalOn.length > 0,
    { sub: subOn.slice(0, 30), normal: normalOn.slice(0, 30) })
  // 复原，别把夹具状态留给后面的组
  await call('jianmu_persona_settings', { patch: { subagentSkip: false }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })

  // G21/G22：压缩补偿参数 + 记忆文件大小上限（2026-11-08）
  const gComp = await call('jianmu_persona_settings', {
    patch: { compactionRecall: true, recallMaxTopics: 6, recallMaxChars: 800 },
    expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true,
  })
  check('G21 压缩补偿参数可写（compactionRecall / recallMaxTopics / recallMaxChars）',
    gComp.ok === true && gComp.effective?.compactionRecall === true
      && gComp.effective?.recallMaxTopics === 6 && gComp.effective?.recallMaxChars === 800,
    { ok: gComp.ok, eff: gComp.effective })

  await call('jianmu_persona_settings', { patch: { maxBytes: 1024 }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true })
  const tooBig = await call('jianmu_persona_memory_append', {
    scope: 'Alice', topic: 'big-probe', text: '2026-11-08 — probe\n\n' + 'x'.repeat(2000), confirm: true,
  })
  check('G22 单文件超过 maxBytes → 拒绝写入（MEMORY_TOO_LARGE）',
    tooBig.ok === false && tooBig.code === 'MEMORY_TOO_LARGE', { code: tooBig.code })
  // 复原
  await call('jianmu_persona_settings', {
    patch: { maxBytes: 262144, compactionRecall: false, recallMaxTopics: 8, recallMaxChars: 1600 },
    expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true,
  })
}

console.log('\n── P2.5. 冲突卡（默认关 / 开了才注入 / 日志无正文）')
{
  const memSec = () => sections.find((s) => s.name === 'jianmu:memory')
  const asmFor = (sid) => ({ agent: { workspace: 'C:\\work\\alice', session: { id: sid, header: { cwd: 'C:\\work\\alice' } } } })
  const memOf = async (sid) => String(await Promise.resolve(memSec()?.text?.(asmFor(sid)) ?? ''))
  const emit = async (event, payload) => { for (const cb of handlers.get(event) || []) await cb(payload) }
  const userMsg = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const claimed = (sid, text, turn) => emit('agent/inbox/claimed', { agent: { session: { id: sid, header: { cwd: 'C:\\work\\alice' } } }, message: userMsg(text), turn })
  const assemble = async (sid) => { for (const cb of handlers.get('system-prompt/assemble') || []) await cb(asmFor(sid), {}, async () => ({})) }

  const st0 = await call('jianmu_persona_settings')
  check('P1 conflictCard 默认 false（设置读出来的有效值）', st0.ok === true && st0.jianmu?.values?.conflictCard === false, st0.jianmu?.values?.conflictCard)
  check('P2 能力表含 conflictCard 且默认 false',
    (st0.jianmu?.capabilities?.keys || []).includes('conflictCard')
      && st0.jianmu?.capabilities?.defaults?.conflictCard === false,
    { keys: st0.jianmu?.capabilities?.keys, defaults: st0.jianmu?.capabilities?.defaults?.conflictCard })
  // T2.5（2026-11-13）：两个开关从「只有 agent 工具能改」变成设置页可读写
  check('P2b autoRecall 默认 false（设置读出来的有效值）', st0.jianmu?.values?.autoRecall === false, st0.jianmu?.values?.autoRecall)
  const gAR = await call('jianmu_persona_settings', {
    patch: { autoRecall: true }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true,
  })
  check('P2c autoRecall 可写（effective=true）', gAR.ok === true && gAR.effective?.autoRecall === true, { ok: gAR.ok, eff: gAR.effective?.autoRecall })
  const gARoff = await call('jianmu_persona_settings', {
    patch: { autoRecall: false }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true,
  })
  check('P2d autoRecall 可关回 false（不残留）', gARoff.ok === true && gARoff.effective?.autoRecall === false, { ok: gARoff.ok, eff: gARoff.effective?.autoRecall })

  fakeConflictCards = async (req) => ({
    ok: true,
    personaId: req?.personaId || null,
    total: 1,
    cards: [{
      conflictId: 'cf-p25-smoke', kind: 'unexplained-contradiction', note: '用户手动标记',
      a: { chunkId: 'ch-a', dateText: '2026-06-10 10:00:00', role: 'user', text: '生日是三月五号。', session: 's-old', seq: 1 },
      b: { chunkId: 'ch-b', dateText: '2026-06-12 15:30:00', role: 'assistant', text: '用户的生日是四月八号。', session: 's-old', seq: 2 },
    }],
  })

  const gCC = await call('jianmu_persona_settings', {
    patch: { conflictCard: true }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true,
  })
  check('P3 开关可写进 registry.settings（effective=true）', gCC.ok === true && gCC.effective?.conflictCard === true, { ok: gCC.ok, eff: gCC.effective?.conflictCard })

  conflictCalls = 0
  await claimed('p25-a', '你还记得上次说的生日是哪天吗', 1)
  await assemble('p25-a')
  const t1 = await memOf('p25-a')
  const start = t1.indexOf('【未裁决的两种说法')
  const end = t1.indexOf('（以上是两种说法并存', start)
  const cardPart = start >= 0 && end > start ? t1.slice(start, t1.indexOf('）', end) + 1) : ''
  check('P4 记忆段出现冲突卡（头）', t1.includes('【未裁决的两种说法'), t1.slice(0, 120))
  check('P5 两条说法 + 两个日期都在', t1.includes('2026-06-10 10:00:00 · 用户：') && t1.includes('2026-06-12 15:30:00 · 助手：'), t1.slice(start, start + 200))
  check('P6 单卡预算 ≤300 字', cardPart.length > 0 && cardPart.length <= 300, cardPart.length)
  check('P7 明确不替用户裁决', t1.includes('请勿把其中一条当成定论'), t1.slice(start, start + 200))
  const t1b = await memOf('p25-a')
  check('P8 同一回合第二次取用不再注入', !t1b.includes('【未裁决的两种说法'), t1b.slice(0, 80))

  const beforeChat = conflictCalls
  await claimed('p25-chat', '今天天气不错，出去走走', 1)
  await assemble('p25-chat')
  check('P9 闲聊（无 G0 线索）不询问熏习', conflictCalls === beforeChat, conflictCalls)

  const gCCoff = await call('jianmu_persona_settings', {
    patch: { conflictCard: false }, expectedGeneration: (await call('jianmu_persona_status')).generation, confirm: true,
  })
  const beforeOff = conflictCalls
  await claimed('p25-b', '上次说的生日是哪天？', 1)
  await assemble('p25-b')
  const t2 = await memOf('p25-b')
  check('P10 关闭后零注入（不出现卡、也不询问熏习）',
    gCCoff.ok === true && !t2.includes('【未裁决的两种说法') && conflictCalls === beforeOff,
    { off: gCCoff.ok, calls: conflictCalls - beforeOff, txt: t2.slice(0, 80) })

  const logFile = path.join(DATA, 'persona', '_logs', 'conflict-card.jsonl')
  await new Promise((r) => setTimeout(r, 60)) // 观测日志是异步写，等落盘
  let rows = []
  try { rows = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { rows = [] }
  check('P11 注入时写了观测日志', rows.length >= 1, rows.length)
  check('P12 日志只有元数据（无正文/无备注）',
    rows.length >= 1 && Object.keys(rows[0]).sort().join(',') === 'chars,conflictIds,n,outcome,sid,t'
      && !JSON.stringify(rows).includes('生日是三月五号') && !JSON.stringify(rows).includes('用户手动标记'),
    rows[0])
}

console.log('\n── H. 记忆作用域解析（默认卡 → 中文卡名，不是英文 cardId）')
{
  // 2026-11-09：待审隔离区（* -待审）必须不进 memory_list / 注入索引
  const pendingFile = path.join(DATA, 'persona', 'memory', 'Alice', 'topics', '社交观察-待审.md')
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
  fs.writeFileSync(pendingFile, '# 待审\n\n## 2026-11-09 22:00 — 测试\n\n2026-11-09 — 测试条目\n', 'utf8')
  const lst = await call('jianmu_persona_memory_list')
  check('H1 不传 scope → 解析成卡名', lst.ok === true && lst.scope === 'Alice', { scope: lst.scope, count: lst.count })
  check('H1b 待审区不出现在 memory_list', Array.isArray(lst.topics) && !lst.topics.some((t) => /待审/.test(t.key || '')), (lst.topics || []).map((t) => t.key).filter((k) => /待审/.test(k)))
  const lst2 = await call('jianmu_persona_memory_list', { cardId: 'alice' })
  check('H2 传 cardId → 仍解析成卡名', lst2.ok === true && lst2.scope === 'Alice', lst2.scope)
  const lst3 = await call('jianmu_persona_memory_list', { scope: 'Bob' })
  check('H3 显式 scope 原样返回', lst3.ok === true && lst3.scope === 'Bob', lst3.scope)
  const rd = await call('jianmu_persona_memory_read', {})
  const where = String(rd.file || rd.error?.message || '')
  check('H4 读 core 时路径落在卡名目录下', where.includes('Alice'), where.slice(0, 160))
  // H1/H2 就是「readCard 返回扁平结构」那个坑的回归：写成 c.card.frontMatter 时会红。
  // DSH 工具层会先按 required 校验拒绝（INVALID_ARGS）；运行时 CORE_READONLY 是双保险，
  // 防止不校验 required 的宿主把 core 写穿。两种都算通过。
  let noTopic
  try {
    noTopic = await call('jianmu_persona_memory_append', { text: '2026-11-09 — 无 topic 探测' })
  } catch (e) {
    noTopic = { ok: false, code: e.code || 'THROWN' }
  }
  check('H5 不传 topic → 拒绝写 core（INVALID_ARGS/CORE_READONLY）',
    noTopic.ok === false && (noTopic.code === 'CORE_READONLY' || noTopic.code === 'INVALID_ARGS'), { code: noTopic.code })
  const coreTopic = await call('jianmu_persona_memory_append', { topic: 'core', text: '2026-11-09 — core 探测' })
  check('H6 topic=core → 拒绝写 core（CORE_READONLY）', coreTopic.ok === false && coreTopic.code === 'CORE_READONLY', { code: coreTopic.code })
  const coreMdTopic = await call('jianmu_persona_memory_append', { topic: 'core.md', text: '2026-11-09 — core.md 探测' })
  check('H7 topic=core.md → 拒绝写 core（CORE_READONLY）', coreMdTopic.ok === false && coreMdTopic.code === 'CORE_READONLY', { code: coreMdTopic.code })
}

console.log(`\n══════════════════════════════════`)
console.log(`通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
} else {
  console.log('全部通过 ✅')
}
console.log(`夹具：${BASE}`)
try { dispose() } catch { /* ignore */ }
if (!process.argv.includes('--keep') && fail === 0) {
  try { fs.rmSync(BASE, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0)
