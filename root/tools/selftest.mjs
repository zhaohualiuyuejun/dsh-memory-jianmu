#!/usr/bin/env node
/**
 * tools/selftest.mjs —— 根藏自测（施工验收用；不依赖 DSH 宿主）
 *
 * 覆盖：
 *   · 落盘原语：原子写 / BOM / 损坏 / JSONL 撕裂尾巴 / 孤儿 tmp
 *   · 锁：单写者 / 陈旧锁抢占
 *   · identity：解析顺序 / 缺失降级 / 最长前缀
 *   · chunks/vectors：指纹幂等 / 校验 / 行对齐 / 归一化幂等
 *   · store：写后读回 / 覆盖需显式 / 备份 / 追加幂等 / rebuild / export / verify
 *   · 迁移器：小样迁移 / 三重校验 / 旧库零改动
 *   · 守卫：工具名 / 注入 / 只读源 / 人格隔离
 *   · 插件面：apply 只注册七个工具、provide jianmuStore、不注册注入钩子、初始化失败不抛
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, appendFile, rename, chmod } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import {
  atomicWrite, readJson, readJsonl, appendJsonl, decodeTextBuffer, listOrphanTmp, pathExists,
} from '../lib/fsatomic.mjs'
import { acquireLock } from '../lib/lock.mjs'
import { loadIdentity, resolvePersona, buildIdentity, writeIdentity, matchWorkspace } from '../lib/identity.mjs'
import { identityAddPersona, identityRemoveMappings, identitySummary } from '../lib/identity-admin.mjs'
import { makeUtterance, makeChunkId, validateChunk, legacyToUtterance, foldLegacySourceType } from '../lib/chunks.mjs'
import { expectedBytes, writeVectorFile, readVectorFile, sliceRows, inspectVectors, normalizeRowInPlace, rowsEqual } from '../lib/vectors.mjs'
import {
  openStore, writeScopeBundle, statusOfScope, statusAll, exportChunks,
  rebuildIndexMeta, appendUtterances, verifyScope, readScopeMeta, readScopeChunks, verifyWrittenScope,
  readTombstones,
} from '../lib/store.mjs'
import { forgetChunks, forgetPreview, reviveChunks } from '../lib/forget.mjs'
import { archiveBeforeWrite } from '../lib/backup.mjs'
import { migrateLegacyIndex } from '../lib/migrate.mjs'
import { ingestSessions } from '../lib/ingest.mjs'
import {
  checkToolName, checkToolSurface, scanSourceForInjection, assertWriteAllowed,
  ALLOWED_TOOLS, checkPersonaWrite,
} from '../lib/guards.mjs'
import { PERSONA_UNASSIGNED, sessionsRoot } from '../lib/paths.mjs'
import { CODES } from '../lib/errors.mjs'

// ─────────────────────────────────────────────────────────── 测试骨架
const results = []
let current = null
async function t(name, fn) {
  current = name
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: e?.stack || String(e) })
    console.log(`  ❌ ${name}`)
    console.log(String(e?.stack || e).split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'))
  }
  current = null
}
function group(name) { console.log(`\n── ${name}`) }

const ROOT = await mkdtemp(join(tmpdir(), 'jianmu-selftest-'))
let dirN = 0
const freshDir = async (label) => { const d = join(ROOT, `${label}-${++dirN}`); await mkdir(d, { recursive: true }); return d }

function utt(over = {}) {
  return makeUtterance({
    session: 'session-test', personaId: 'alice', identitySource: 'workspace',
    messageId: 'm1', seq: 1, part: 0, role: 'user', t: 1762000000000,
    text: '这是一条测试原话', ws: 'C:\\work\\alice', ...over,
  })
}

function vec(dim, seed = 1) {
  const v = new Float32Array(dim)
  let s = 0
  for (let i = 0; i < dim; i++) { v[i] = Math.sin(i * 0.13 + seed); s += v[i] * v[i] }
  const n = Math.sqrt(s)
  for (let i = 0; i < dim; i++) v[i] /= n
  return v
}

/** 造一个合成旧寻枝库（meta.json + vectors.f32） */
async function makeLegacy(dir, { rows, dim = 8, provider = 'cloud', model = 'test-model', ws }) {
  await mkdir(dir, { recursive: true })
  const chunks = rows.map((r) => ({
    session: r.session, ws: r.ws, wsPretty: r.wsPretty, t: r.t, role: r.role, part: 0,
    text: r.text, msgId: r.msgId ?? null, seq: r.seq ?? null, sourceType: r.sourceType,
  }))
  const flat = new Float32Array(chunks.length * dim)
  for (let i = 0; i < chunks.length; i++) flat.set(vec(dim, i + 1), i * dim)
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    provider, model, dim, builtAt: new Date().toISOString(),
    keepDays: 30, chunkSize: 1200, sessions: new Set(chunks.map((c) => c.session)).size,
    chunks, wsAllow: null,
  }), 'utf8')
  await writeFile(join(dir, 'vectors.f32'), Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
  return { chunks, flat, dim }
}

// ─────────────────────────────────────────────────────────── 1. 落盘原语
group('落盘原语（F1/F2/F8/F9/D7）')

await t('原子写：成功、可读回、不留孤儿 tmp', async () => {
  const d = await freshDir('atomic')
  const f = join(d, 'a.json')
  await atomicWrite(f, '{"x":1}\n')
  assert.equal(await readFile(f, 'utf8'), '{"x":1}\n')
  assert.deepEqual(await listOrphanTmp(d), [])
})

await t('readJson 容忍 UTF-8 BOM', async () => {
  const d = await freshDir('bom')
  const f = join(d, 'b.json')
  await writeFile(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]))
  const r = await readJson(f)
  assert.equal(r.ok, true)
  assert.equal(r.value.ok, true)
  assert.equal(r.encoding, 'utf8-bom')
})

await t('readJson 容忍 UTF-16LE BOM', async () => {
  const d = await freshDir('bom16')
  const f = join(d, 'b.json')
  const body = Buffer.from('{"ok":2}', 'utf16le')
  await writeFile(f, Buffer.concat([Buffer.from([0xff, 0xfe]), body]))
  const r = await readJson(f)
  assert.equal(r.ok, true)
  assert.equal(r.value.ok, 2)
})

await t('readJson 损坏 → 明确失败，不回落默认值', async () => {
  const d = await freshDir('corrupt')
  const f = join(d, 'c.json')
  await writeFile(f, '{"a":', 'utf8')
  const r = await readJson(f)
  assert.equal(r.ok, false)
  assert.equal(r.code, CODES.JSON_PARSE)
})

await t('JSONL：追加 + 读回 + 撕裂尾巴识别', async () => {
  const d = await freshDir('jsonl')
  const f = join(d, 'x.jsonl')
  await appendJsonl(f, [{ a: 1 }, { a: 2 }], { durable: true })
  await appendFile(f, '{"a":3', 'utf8') // 半行
  const r = await readJsonl(f)
  assert.equal(r.rows.length, 2)
  assert.equal(r.tornTail, true)
  assert.equal(r.corrupt.length, 0)
})

await t('JSONL：中间坏行 → corrupt（不静默）', async () => {
  const d = await freshDir('jsonl2')
  const f = join(d, 'x.jsonl')
  await writeFile(f, '{"a":1}\n{{{\n{"a":2}\n', 'utf8')
  const r = await readJsonl(f)
  assert.equal(r.rows.length, 2)
  assert.equal(r.tornTail, false)
  assert.equal(r.corrupt.length, 1)
})

await t('原子写失败注入：目标被目录占用 → 抛错、不留 tmp、原目录不变', async () => {
  const d = await freshDir('atomic-fail')
  const target = join(d, 'a.json')
  await mkdir(target)
  await assert.rejects(() => atomicWrite(target, 'x'), (e) => e.code === CODES.WRITE_ATOMIC_FAILED)
  assert.deepEqual(await listOrphanTmp(d), [], '失败必须清 tmp')
  assert.equal((await stat(target)).isDirectory(), true, '原目录不得被破坏')
})

await t('原子写失败注入：父路径是文件 → 抛错（不回报 ok）', async () => {
  const d = await freshDir('atomic-fail2')
  const f = join(d, 'file')
  await writeFile(f, 'x')
  await assert.rejects(() => atomicWrite(join(f, 'x.json'), 'y'))
})

// ─────────────────────────────────────────────────────────── 2. 锁
group('锁（F4）')

await t('单写者：第二个拿锁超时返回 LOCK_BUSY', async () => {
  const d = await freshDir('lock')
  const first = await acquireLock(d, { timeoutMs: 500 })
  assert.equal(first.ok, true)
  const second = await acquireLock(d, { timeoutMs: 300, pollMs: 30 })
  assert.equal(second.ok, false)
  assert.equal(second.code, CODES.LOCK_BUSY)
  await first.release()
  const third = await acquireLock(d, { timeoutMs: 500 })
  assert.equal(third.ok, true)
  await third.release()
})

await t('陈旧锁（死 pid）可被抢占并归档', async () => {
  const d = await freshDir('lock-stale')
  await mkdir(d, { recursive: true })
  await writeFile(join(d, '.lock'), JSON.stringify({ pid: 999999, at: new Date().toISOString(), host: hostname() }), 'utf8')
  const l = await acquireLock(d, { timeoutMs: 2000 })
  assert.equal(l.ok, true)
  assert.ok(l.stolen)
  await l.release()
})

await t('锁：被抢走后回来 release，绝不删别人的锁', async () => {
  const d = await freshDir('lock-owner')
  const a = await acquireLock(d, { timeoutMs: 500 })
  assert.equal(a.ok, true)
  // 模拟「锁被抢」：文件内容被换成新持有者的 token
  await writeFile(join(d, '.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: hostname(), token: 'other-owner' }), 'utf8')
  const r = await a.release()
  assert.equal(r.released, false)
  assert.equal(r.reason, 'not-owner')
  assert.equal(await pathExists(join(d, '.lock')), true, '别人的锁必须还在')
  const content = JSON.parse(await readFile(join(d, '.lock'), 'utf8'))
  assert.equal(content.token, 'other-owner')
})

// ─────────────────────────────────────────────────────────── 3. identity
group('identity / 人格解析（F17）')

await t('解析顺序：session > manual > workspace 最长前缀 > default > unassigned', async () => {
  const id = buildIdentity({
    personas: { alice: 'Alice', bob: 'Bob', other: '其他' },
    workspaces: { 'C:\\work': 'other', 'C:\\work\\alice': 'alice' },
    sessions: { 'session-x': 'bob' },
    defaultPersonaId: 'other',
  })
  assert.equal(resolvePersona(id, { session: 'session-x', ws: 'C:\\work\\alice' }).personaId, 'bob')
  assert.equal(resolvePersona(id, { ws: 'C:\\work\\alice', explicitPersonaId: 'bob' }).identitySource, 'manual')
  const wsHit = resolvePersona(id, { ws: 'C:\\work\\alice\\sub' })
  assert.equal(wsHit.personaId, 'alice')
  assert.equal(wsHit.identitySource, 'workspace')
  assert.equal(matchWorkspace(id, 'C:\\workX'), null, '前缀必须按路径段边界匹配')
  assert.equal(matchWorkspace(id, 'C:\\work\\aliceX').personaId, 'other', '落在父工作区内应命中父工作区')
  assert.equal(resolvePersona(id, { ws: 'D:\\elsewhere' }).personaId, 'other')
  assert.equal(resolvePersona(id, { ws: 'D:\\elsewhere', explicitPersonaId: '' }).identitySource, 'default')
  assert.equal(resolvePersona(null, { ws: 'C:\\work\\alice' }).personaId, PERSONA_UNASSIGNED)
})

await t('identity 缺失 → 降级且不静默归入具名人格', async () => {
  const d = await freshDir('ident-missing')
  const r = await loadIdentity(d)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'identity_missing')
  const st = await openStore({ dataRoot: d })
  assert.equal(st.ok, true)
  assert.equal(st.degraded, true)
})

await t('identity 损坏 → 降级（不回落默认值）', async () => {
  const d = await freshDir('ident-corrupt')
  await writeFile(join(d, 'identity.json'), '{oops', 'utf8')
  const r = await loadIdentity(d)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'identity_corrupt')
  const st = await openStore({ dataRoot: d })
  assert.equal(st.degraded, true)
})

await t('identity 非法（未声明人格）被拒绝', async () => {
  const d = await freshDir('ident-invalid')
  await writeFile(join(d, 'identity.json'), JSON.stringify({ version: 1, personas: { a: { displayName: 'A' } }, workspaces: { 'C:\\x': 'b' } }), 'utf8')
  const r = await loadIdentity(d)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'identity_invalid')
})

await t('写 identity：roundtrip', async () => {
  const d = await freshDir('ident-write')
  const id = buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } })
  await writeIdentity(d, id)
  const r = await loadIdentity(d)
  assert.equal(r.ok, true)
  assert.equal(r.identity.personas.alice.displayName, 'Alice')
})

// ── identity 受控写（P4 #5，2026-11-12）─────────────────────────────────
group('identity 受控写（P4 #5）')

await t('addPersona：默认只预览，不落盘', async () => {
  const d = await freshDir('ident-add-preview')
  const r = await identityAddPersona({ dataRoot: d, personaId: 'tester', displayName: '测试员', workspaces: ['H:\\lab workspace'] })
  assert.equal(r.ok, true)
  assert.equal(r.preview, true)
  assert.equal(r.written, false)
  assert.deepEqual(r.changes.personasAdded, ['tester'])
  assert.deepEqual(r.changes.workspacesAdded, ['H:\\lab workspace'])
  assert.equal(await pathExists(join(d, 'identity.json')), false)
})

await t('addPersona：confirm 写入 + 备份 + 读回 + 不碰旧映射', async () => {
  const d = await freshDir('ident-add-write')
  await writeIdentity(d, buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } }))
  const before = await readFile(join(d, 'identity.json'), 'utf8')
  const r = await identityAddPersona({ dataRoot: d, personaId: 'tester', displayName: '测试员', workspaces: ['H:\\lab workspace'], dryRun: false, confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.written, true)
  assert.ok(r.backup && await pathExists(r.backup), `备份存在：${r.backup}`)
  const id = await loadIdentity(d)
  assert.equal(id.ok, true)
  assert.equal(id.identity.personas.tester.displayName, '测试员')
  assert.equal(id.identity.workspaces['H:\\lab workspace'], 'tester')
  assert.equal(id.identity.workspaces['C:\\work\\alice'], 'alice', '旧映射必须原样保留')
  assert.equal(await readFile(r.backup, 'utf8'), before, '备份 = 写入前原文')
})

await t('addPersona：幂等（第二次 noop，不新增备份）', async () => {
  const d = await freshDir('ident-add-idem')
  const opts = { dataRoot: d, personaId: 'tester', displayName: '测试员', workspaces: ['H:\\lab workspace'], dryRun: false, confirm: true }
  const first = await identityAddPersona(opts)
  assert.equal(first.written, true)
  const second = await identityAddPersona(opts)
  assert.equal(second.ok, true)
  assert.equal(second.noop, true)
  assert.equal(second.written, false)
  assert.equal(second.backup, undefined)
})

await t('addPersona：工作区已属于别人 → 默认跳过并警告', async () => {
  const d = await freshDir('ident-add-conflict')
  await writeIdentity(d, buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } }))
  const r = await identityAddPersona({ dataRoot: d, personaId: 'tester', displayName: '测试员', workspaces: ['C:\\work\\alice', 'H:\\lab workspace'], dryRun: false, confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.written, true)
  assert.equal(r.changes.workspacesAdded.length, 1)
  assert.equal(r.changes.workspacesReassigned.length, 0)
  assert.ok(r.warnings.some((w) => w.includes('已属于人格 alice')), r.warnings)
  assert.deepEqual(r.skipped, [{ kind: 'workspace', key: 'C:\\work\\alice', owner: 'alice' }], r.skipped)
  const id = await loadIdentity(d)
  assert.equal(id.identity.workspaces['C:\\work\\alice'], 'alice', '默认不允许改归属')
  assert.equal(id.identity.workspaces['H:\\lab workspace'], 'tester')
})

await t('addPersona：allowReassign=true 才改归属', async () => {
  const d = await freshDir('ident-add-reassign')
  await writeIdentity(d, buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } }))
  const r = await identityAddPersona({ dataRoot: d, personaId: 'tester', displayName: '测试员', workspaces: ['C:\\work\\alice'], allowReassign: true, dryRun: false, confirm: true })
  assert.equal(r.written, true)
  assert.deepEqual(r.changes.workspacesReassigned, [{ workspace: 'C:\\work\\alice', from: 'alice', to: 'tester' }])
  const id = await loadIdentity(d)
  assert.equal(id.identity.workspaces['C:\\work\\alice'], 'tester')
})

await t('addPersona：identity 损坏 → 拒绝覆盖（fail-closed）', async () => {
  const d = await freshDir('ident-add-corrupt')
  await writeFile(join(d, 'identity.json'), '{oops', 'utf8')
  const r = await identityAddPersona({ dataRoot: d, personaId: 'tester', displayName: '测试员', workspaces: ['H:\\lab workspace'], dryRun: false, confirm: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'IDENTITY_UNREADABLE')
  assert.equal(await readFile(join(d, 'identity.json'), 'utf8'), '{oops', '损坏文件必须原样保留')
})

await t('addPersona：非法 personaId / persona_unassigned 拒绝', async () => {
  const d = await freshDir('ident-add-bad')
  for (const pid of ['../etc', '', PERSONA_UNASSIGNED]) {
    const r = await identityAddPersona({ dataRoot: d, personaId: pid, workspaces: ['H:\\x'], dryRun: false, confirm: true })
    assert.equal(r.ok, false, String(pid))
    assert.equal(r.code, 'BAD_PERSONA_ID')
  }
})

await t('removeMappings：只摘自己的映射，别人的不动，且不删记忆文件', async () => {
  const d = await freshDir('ident-remove')
  await writeIdentity(d, buildIdentity({
    personas: { alice: 'Alice', tester: '测试员' },
    workspaces: { 'C:\\work\\alice': 'alice', 'H:\\lab workspace': 'tester' },
  }))
  // 放一个假的 scope 文件，确认停记不会碰它
  await mkdir(join(d, 'scopes', 'tester'), { recursive: true })
  await writeFile(join(d, 'scopes', 'tester', 'chunks.jsonl'), '{"id":"x"}\n', 'utf8')
  const r = await identityRemoveMappings({ dataRoot: d, personaId: 'tester', workspaces: ['H:\\lab workspace', 'C:\\work\\alice'], dryRun: false, confirm: true })
  assert.equal(r.ok, true)
  assert.deepEqual(r.removed.workspaces, ['H:\\lab workspace'])
  const id = await loadIdentity(d)
  assert.equal(id.identity.workspaces['H:\\lab workspace'], undefined)
  assert.equal(id.identity.workspaces['C:\\work\\alice'], 'alice', '别人的人格映射不能动')
  assert.equal(await readFile(join(d, 'scopes', 'tester', 'chunks.jsonl'), 'utf8'), '{"id":"x"}\n', '停记不删记忆')
})

await t('identitySummary：只读摘要', async () => {
  const d = await freshDir('ident-summary')
  await writeIdentity(d, buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } }))
  const s = await identitySummary(d)
  assert.equal(s.ok, true)
  assert.deepEqual(s.personas, [{ personaId: 'alice', displayName: 'Alice' }])
  assert.equal(s.workspaces, 1)
  assert.equal(s.defaultPersonaId, null)
})

// ─────────────────────────────────────────────────────────── 4. chunks / vectors
group('chunks / vectors（D2/D5/F10）')

await t('chunk id 幂等：同内容同 id，part 不同则不同', async () => {
  const a = makeChunkId({ session: 's', messageId: 'm', seq: 1, part: 0, text: '你好' })
  const b = makeChunkId({ session: 's', messageId: 'm', seq: 1, part: 0, text: '你好\r\n' })
  const c = makeChunkId({ session: 's', messageId: 'm', seq: 1, part: 1, text: '你好' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

await t('validateChunk：坏行能被抓住', async () => {
  assert.equal(validateChunk(utt()).length, 0)
  assert.ok(validateChunk({ ...utt(), id: 'x' }).length > 0)
  assert.ok(validateChunk({ ...utt(), personaId: 'Bad Id' }).length > 0)
  assert.ok(validateChunk({ ...utt(), t: '昨天' }).length > 0)
  assert.ok(validateChunk({ ...utt(), schemaVersion: 99 }).length > 0)
  assert.ok(validateChunk({ ...utt(), sourceType: 'weird' }).length > 0)
})

await t('time 只存 UTC epoch ms（数字），没有字符串时间参与排序', async () => {
  const u = utt({ t: 1762000000000 })
  assert.equal(typeof u.t, 'number')
  assert.ok(Number.isInteger(u.t))
  assert.equal(u.tz, 'Asia/Shanghai')
})

await t('旧 sourceType 折叠：bridge → 基础角色，原值留 provenance', async () => {
  assert.equal(foldLegacySourceType('user-bridge', 'user'), 'user')
  assert.equal(foldLegacySourceType('assistant-bridge', 'assistant'), 'assistant')
  assert.equal(foldLegacySourceType(undefined, 'user'), 'user')
  const u = legacyToUtterance({ session: 's', role: 'user', t: 1, part: 0, text: '原话内容', sourceType: 'user-bridge', ws: '--H-a--', wsPretty: 'H:\\a' }, { personaId: 'alice', identitySource: 'manual' })
  assert.equal(u.sourceType, 'user')
  assert.equal(u.provenance.legacySourceType, 'user-bridge')
})

await t('向量：写读 roundtrip + 行切片逐行相等', async () => {
  const d = await freshDir('vec')
  const dim = 8
  const flat = new Float32Array(5 * dim)
  for (let i = 0; i < 5; i++) flat.set(vec(dim, i + 1), i * dim)
  const f = join(d, 'v.f32')
  await writeVectorFile(f, flat)
  const r = await readVectorFile(f, { count: 5, dim })
  assert.equal(r.ok, true)
  assert.equal(r.bytes, expectedBytes(5, dim))
  assert.ok(rowsEqual(sliceRows(flat, [3, 1], dim), (() => {
    const out = new Float32Array(2 * dim)
    out.set(flat.subarray(3 * dim, 4 * dim), 0)
    out.set(flat.subarray(1 * dim, 2 * dim), dim)
    return out
  })(), dim))
})

await t('向量：尺寸不符 → 拒绝使用（不静默）', async () => {
  const d = await freshDir('vec-bad')
  const f = join(d, 'v.f32')
  await writeFile(f, Buffer.alloc(16))
  const r = await readVectorFile(f, { count: 5, dim: 8 })
  assert.equal(r.ok, false)
  assert.equal(r.code, CODES.VECTOR_SIZE_MISMATCH)
})

await t('向量：坏行/零向量被计数，归一化幂等', async () => {
  const dim = 4
  const flat = new Float32Array(3 * dim)
  flat.set([1, 0, 0, 0], 0)
  flat.set([0, 0, 0, 0], dim) // 零
  flat.set([NaN, 1, 0, 0], 2 * dim) // 非有限
  const info = inspectVectors(flat, dim)
  assert.equal(info.badRows.length, 2)
  const v = new Float32Array([3, 4, 0, 0])
  normalizeRowInPlace(v)
  const once = Array.from(v)
  normalizeRowInPlace(v)
  assert.deepEqual(Array.from(v), once)
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6)
})

// ─────────────────────────────────────────────────────────── 5. store
group('store：写 / 读回 / status / export / rebuild / verify')

await t('writeScopeBundle → 读回 found，status 数字一致', async () => {
  const d = await freshDir('store')
  const rows = [utt({ text: '第一句原话' }), utt({ messageId: 'm2', seq: 2, text: '第二句原话', t: 1762000001000 })]
  const flat = new Float32Array(rows.length * 8)
  flat.set(vec(8, 1), 0); flat.set(vec(8, 2), 8)
  const w = await writeScopeBundle({ dataRoot: d, personaId: 'alice', displayName: 'Alice', identitySource: 'workspace', utterances: rows, vectors: flat, embedding: { provider: 'cloud', model: 'm', dim: 8 } })
  assert.equal(w.ok, true, JSON.stringify(w.error))
  assert.equal(w.chunks, 2)
  assert.equal(w.readback.state, 'found')
  const st = await statusOfScope(d, 'alice', { deep: true })
  assert.equal(st.chunks, 2)
  assert.equal(st.vectors.rows, 2)
  assert.equal(st.vectors.missing, 0)
  assert.equal(st.degraded, false)
})

await t('重复写：无 overwrite 被拒绝；有 overwrite 先备份再写', async () => {
  const d = await freshDir('store-overwrite')
  const r1 = [utt()]
  const v1 = vec(8, 1)
  const a = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: r1, vectors: v1, embedding: { dim: 8 } })
  assert.equal(a.ok, true)
  const b = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt({ text: '新内容' })], vectors: vec(8, 2), embedding: { dim: 8 } })
  assert.equal(b.ok, false)
  assert.equal(b.error.code, 'SCOPE_EXISTS')
  const c = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt({ text: '新内容' })], vectors: vec(8, 2), embedding: { dim: 8 }, overwrite: true })
  assert.equal(c.ok, true)
  const archives = (await readdir(join(d, 'scopes', 'alice', '_archive'), { withFileTypes: true })).filter((x) => x.isDirectory())
  assert.ok(archives.length >= 1)
  assert.ok((await readdir(join(d, 'scopes', 'alice', '_archive', archives[0].name))).includes('.fingerprint.json'))
  const st = await statusOfScope(d, 'alice')
  assert.equal(st.chunks, 1)
})

await t('追加幂等：同 id 不重复，added=0', async () => {
  const d = await freshDir('store-append')
  const u = utt()
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [u], vectors: new Float32Array(8).fill(0.35), embedding: { dim: 8 } })
  const a = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [u] })
  assert.equal(a.ok, true)
  assert.equal(a.added, 0)
  assert.equal(a.duplicates, 1)
  const b = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm9', seq: 9, text: '新的一句' })] })
  assert.equal(b.ok, true)
  assert.equal(b.added, 1)
  const st = await statusOfScope(d, 'alice')
  assert.equal(st.chunks, 2)
})

await t('显式忘记：预览不写；confirm 写墓碑+快照；revive 恢复；原话不物理删', async () => {
  const d = await freshDir('store-forget')
  const u = utt({ text: '会被忘记的一句' })
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [u], vectors: vec(8, 1), embedding: { dim: 8 } })
  const before = await readScopeChunks(d, 'alice')

  const p = await forgetPreview({ dataRoot: d, personaId: 'alice', chunkIds: [u.id] })
  assert.equal(p.ok, true)
  assert.equal(p.count, 1)
  assert.equal((await readJsonl(join(d, 'scopes', 'alice', 'deleted.jsonl'))).rows.length, 0, '预览不得写墓碑')

  const f = await forgetChunks({ dataRoot: d, personaId: 'alice', chunkIds: [u.id], confirm: true, graceDays: 3 })
  assert.equal(f.ok, true, JSON.stringify(f.error))
  assert.equal(f.forgotten, 1)
  assert.ok(f.backup?.dir, '必须写前快照')
  assert.equal((await readTombstones(d, 'alice')).has(u.id), true)
  const after = await readScopeChunks(d, 'alice')
  assert.equal(after.rows.length, before.rows.length, '原话不得物理删除')

  const r = await reviveChunks({ dataRoot: d, personaId: 'alice', chunkIds: [u.id], confirm: true })
  assert.equal(r.ok, true)
  assert.equal((await readTombstones(d, 'alice')).has(u.id), false, 'revive 后不再算忘记')

  const n = await forgetChunks({ dataRoot: d, personaId: 'alice', chunkIds: [u.id] })
  assert.equal(n.ok, false)
  assert.equal(n.code, 'CONFIRM_REQUIRED')
})

await t('归档保留：只留最近 2 份，旧的移到 _backup（不物理删）', async () => {
  const d = await freshDir('retention')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const target = join(d, 'scopes', 'alice', 'chunks.jsonl')
  for (let i = 0; i < 4; i++) {
    await archiveBeforeWrite(d, 'alice', [target], `keep-${i}`)
    await new Promise((r) => setTimeout(r, 15))
  }
  const listDirs = async (p) => { try { return (await readdir(p, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => x.name) } catch { return [] } }
  const kept = await listDirs(join(d, 'scopes', 'alice', '_archive'))
  const moved = await listDirs(join(d, '_backup', 'archive', 'alice'))
  assert.equal(kept.length, 2, `_archive 应留 2 份，实际 ${kept.length}`)
  assert.equal(moved.length, 2, `_backup 应收到 2 份，实际 ${moved.length}`)
  assert.ok((await readdir(join(d, 'scopes', 'alice', '_archive', kept[0]))).includes('chunks.jsonl'))
})

await t('rebuild：0 次嵌入，重建 index_meta', async () => {
  const d = await freshDir('store-rebuild')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const r = await rebuildIndexMeta({ dataRoot: d, personaId: 'alice' })
  assert.equal(r.ok, true)
  assert.equal(r.embeddings, 0)
  assert.equal(r.vectorState, 'ok')
})

await t('rebuild：向量缺失时只恢复文本索引并提示 reembed', async () => {
  const d = await freshDir('store-rebuild-missing')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  await rm(join(d, 'scopes', 'alice', 'vectors_v1.f32'))
  const r = await rebuildIndexMeta({ dataRoot: d, personaId: 'alice' })
  assert.equal(r.ok, true)
  assert.equal(r.vectorState, 'missing')
  assert.equal(r.embeddings, 0)
  assert.ok(r.note.includes('reembed'))
  const st = await statusOfScope(d, 'alice')
  assert.equal(st.vectors.missing, 1)
  assert.ok(st.warnings.length > 0)
})

await t('export：导出文件 hash 与源一致', async () => {
  const d = await freshDir('store-export')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const out = join(d, 'out-chunks.jsonl')
  const r = await exportChunks({ dataRoot: d, personaId: 'alice', outFile: out })
  assert.equal(r.ok, true)
  assert.equal(r.chunks, 1)
  const src = await readFile(join(d, 'scopes', 'alice', 'chunks.jsonl'))
  const dst = await readFile(out)
  assert.equal(createHash('sha256').update(src).digest('hex'), createHash('sha256').update(dst).digest('hex'))
})

await t('verify：重复 id 被抓住', async () => {
  const d = await freshDir('store-verify')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const f = join(d, 'scopes', 'alice', 'chunks.jsonl')
  const line = (await readFile(f, 'utf8')).trim()
  await writeFile(f, `${line}\n${line}\n`, 'utf8')
  const r = await verifyScope(d, 'alice')
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.code === 'DUPLICATE_ID'))
})

await t('statusAll：未归属单独成 scope 并告警', async () => {
  const d = await freshDir('store-unassigned')
  await writeScopeBundle({ dataRoot: d, personaId: PERSONA_UNASSIGNED, identitySource: 'unassigned', utterances: [utt({ personaId: PERSONA_UNASSIGNED, identitySource: 'unassigned' })], vectors: new Float32Array(8).fill(0.35), embedding: { dim: 8 } })
  const all = await statusAll(d)
  assert.equal(all.totals.unassignedChunks, 1)
  assert.ok(all.warnings.some((w) => w.includes('未归属')))
  assert.equal(all.scopes.alice, undefined, '未归属不能被归进具名人格')
})

await t('覆盖失败不推进备份指纹（F3）', async () => {
  const d = await freshDir('backup-fail')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const bad = await writeScopeBundle({
    dataRoot: d, personaId: 'alice',
    utterances: [{ ...utt(), id: 'not-a-valid-id' }], vectors: vec(8, 2), embedding: { dim: 8 }, overwrite: true,
  })
  assert.equal(bad.ok, false)
  const arch = (await readdir(join(d, 'scopes', 'alice', '_archive'), { withFileTypes: true })).filter((x) => x.isDirectory())
  assert.ok(arch.length >= 1, '变更前备份必须已落盘')
  const files = await readdir(join(d, 'scopes', 'alice', '_archive', arch[0].name))
  assert.equal(files.includes('.fingerprint.json'), false, '失败写不得提交指纹（否则重试会跳过备份）')
  const st = await statusOfScope(d, 'alice')
  assert.equal(st.chunks, 1, '失败不得覆盖原数据')
})

await t('F5/F17：两个 scope 交错写，互不串味、不跨人格读', async () => {
  const d = await freshDir('isolation')
  const a = utt({ personaId: 'alice', text: 'Alice说的一句原话', session: 'session-a', messageId: 'ma' })
  const b = utt({ personaId: 'bob', text: 'Bob说的一句原话', session: 'session-b', messageId: 'mb', ws: 'C:\\work\\bob' })
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [a], vectors: vec(8, 1), embedding: { dim: 8 } })
  await writeScopeBundle({ dataRoot: d, personaId: 'bob', utterances: [b], vectors: vec(8, 2), embedding: { dim: 8 } })
  const ra = await readScopeChunks(d, 'alice')
  const rb = await readScopeChunks(d, 'bob')
  assert.deepEqual(ra.rows.map((x) => x.personaId), ['alice'])
  assert.deepEqual(rb.rows.map((x) => x.personaId), ['bob'])
  assert.ok(!ra.rows.some((x) => x.text.includes('Bob')))
  assert.ok(!rb.rows.some((x) => x.text.includes('Alice')))
  const all = await statusAll(d)
  assert.equal(all.totals.chunks, 2)
  assert.equal(all.totals.unassignedChunks, 0)
})

await t('D1：追加维度与 manifest 不一致 → 写前拒绝（不写 chunks、不改 index_meta）', async () => {
  const d = await freshDir('dim-mismatch')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(4, 1), embedding: { dim: 4 } })
  const r = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm2', seq: 2, text: '第二句原话' })], vectors: vec(8, 2), dim: 8 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, CODES.EMBEDDING_MISMATCH)
  const ch = await readScopeChunks(d, 'alice')
  assert.equal(ch.rows.length, 1, '拒绝时必须发生在写 chunks 之前')
  const im = JSON.parse(await readFile(join(d, 'scopes', 'alice', 'index_meta.json'), 'utf8'))
  assert.equal(im.dim, 4, 'index_meta.dim 必须跟 manifest 一致')
})

await t('D1：同维不同模型 → 拒绝追加（不静默接受）', async () => {
  const d = await freshDir('model-mismatch')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(4, 1), embedding: { provider: 'cloud', model: 'model-a', dim: 4 } })
  const r = await appendUtterances({
    dataRoot: d, personaId: 'alice',
    utterances: [utt({ messageId: 'm2', seq: 2, text: '第二句原话' })],
    vectors: vec(4, 2), dim: 4,
    embedding: { provider: 'cloud', model: 'model-b', dim: 4 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, CODES.EMBEDDING_MISMATCH)
  assert.ok(String(r.error.message).includes('model'))
})

await t('chunks 读失败 ≠ 空库：status 报错、verify 不绿、读回 unknown', async () => {
  const d = await freshDir('read-fail')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const cf = join(d, 'scopes', 'alice', 'chunks.jsonl')
  await rename(cf, cf + '.bak')
  await mkdir(cf)
  const st = await statusOfScope(d, 'alice')
  assert.equal(st.degraded, true)
  assert.ok(st.errors.some((e) => e.code && e.code !== 'SCOPE_MISSING'), '必须是读错误而不是「scope 不存在」')
  const rb = await verifyWrittenScope(d, 'alice')
  assert.equal(rb.state, 'unknown', 'unknown ≠ missing')
  const v = await verifyScope(d, 'alice')
  assert.equal(v.ok, false)
})

await t('首次写失败：清理本次新建文件，不留已发布 chunks', async () => {
  const d = await freshDir('fresh-fail')
  const dir = join(d, 'scopes', 'alice')
  await mkdir(dir, { recursive: true })
  await mkdir(join(dir, 'vectors_v1.f32')) // 占位目录，让向量落盘失败；它不是本次创建的
  const w = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  assert.equal(w.ok, false)
  assert.equal(w.rolledBack, true)
  assert.equal(await pathExists(join(dir, 'chunks.jsonl')), false, '首次失败不得留下已发布 chunks')
  assert.equal(await pathExists(join(dir, 'manifest.json')), false)
  assert.equal(await pathExists(join(dir, 'vectors_v1.f32')), true, '原有占位目录不得被删')
})

await t('verify：缺向量 → VECTOR_MISSING，不再绿', async () => {
  const d = await freshDir('verify-missing')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  await rm(join(d, 'scopes', 'alice', 'vectors_v1.f32'))
  const v = await verifyScope(d, 'alice')
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.code === CODES.VECTOR_MISSING))
})

await t('generation：覆盖写递增；rebuild 成功后递增', async () => {
  const d = await freshDir('generation')
  const w1 = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  assert.equal(w1.ok, true)
  let m = JSON.parse(await readFile(join(d, 'scopes', 'alice', 'manifest.json'), 'utf8'))
  assert.equal(m.generation, 1)
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt({ text: '第二版原话' })], vectors: vec(8, 2), embedding: { dim: 8 }, overwrite: true })
  m = JSON.parse(await readFile(join(d, 'scopes', 'alice', 'manifest.json'), 'utf8'))
  assert.equal(m.generation, 2)
  const rb = await rebuildIndexMeta({ dataRoot: d, personaId: 'alice' })
  assert.equal(rb.generation, 3)
})

await t('并发：两个 scope 同时写，互不串味', async () => {
  const d = await freshDir('concurrent')
  const mk = (pid, text, ws) => ({
    dataRoot: d, personaId: pid, identitySource: 'workspace',
    utterances: [utt({ personaId: pid, text, ws, session: `s-${pid}`, messageId: `m-${pid}` })],
    vectors: vec(8, pid === 'alice' ? 1 : 2), embedding: { dim: 8 },
  })
  const [a, b] = await Promise.all([
    writeScopeBundle(mk('alice', 'Alice并发原话', 'C:\\work\\alice')),
    writeScopeBundle(mk('bob', 'Bob并发原话', 'C:\\work\\bob')),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  const ra = await readScopeChunks(d, 'alice')
  const rb2 = await readScopeChunks(d, 'bob')
  assert.deepEqual(ra.rows.map((x) => x.personaId), ['alice'])
  assert.deepEqual(rb2.rows.map((x) => x.personaId), ['bob'])
})

await t('contractVersion 不兼容 → 拒绝写（可读不可写）', async () => {
  const d = await freshDir('contract-version')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const mf = join(d, 'scopes', 'alice', 'manifest.json')
  const m = JSON.parse(await readFile(mf, 'utf8'))
  m.contractVersion = 2
  await writeFile(mf, JSON.stringify(m), 'utf8')
  const r = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm2', seq: 2, text: '新的一句原话' })] })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, CODES.CONTRACT_UNSUPPORTED)
  // 读仍然可以（只读不锁死）
  const meta = await readScopeMeta(d, 'alice')
  assert.equal(meta.manifest?.contractVersion, 2)
})

await t('路径穿越：personaId 含 ../ 被所有读写 API 拒绝，且不建目录', async () => {
  const d = await freshDir('traversal')
  const bad = '../../evil'
  assert.equal((await writeScopeBundle({ dataRoot: d, personaId: bad, utterances: [utt()] })).error.code, CODES.BAD_PERSONA_ID)
  assert.equal((await appendUtterances({ dataRoot: d, personaId: bad, utterances: [utt()] })).error.code, CODES.BAD_PERSONA_ID)
  assert.equal((await rebuildIndexMeta({ dataRoot: d, personaId: bad })).error.code, CODES.BAD_PERSONA_ID)
  assert.equal((await exportChunks({ dataRoot: d, personaId: bad })).error.code, CODES.BAD_PERSONA_ID)
  assert.equal((await statusOfScope(d, bad)).degraded, true)
  assert.equal((await verifyScope(d, bad)).ok, false)
  assert.equal(await pathExists(join(d, 'scopes')), false, '非法 id 不得创建 scopes 目录')
})

await t('追加向量失败：chunks 存下但不报 ok；对齐破坏后拒绝继续追加向量', async () => {
  const d = await freshDir('align')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const vf = join(d, 'scopes', 'alice', 'vectors_v1.f32')
  // 让向量文件只读：追加前的对齐自检能过，但写入必定失败（Windows 上 EPERM）
  await chmod(vf, 0o444)
  let r
  try {
    r = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm2', seq: 2, text: '第二句原话' })], vectors: vec(8, 2), dim: 8 })
  } finally {
    await chmod(vf, 0o666)
  }
  assert.equal(r.ok, false, '向量失败不能报 ok')
  assert.equal(r.stored, true, '事实源必须已存下')
  assert.equal(r.vectorState, 'error')
  assert.equal(r.alignment.ok, false)
  assert.equal(r.error.code, 'VECTOR_WRITE_FAILED')
  // index_meta 必须带上对齐破坏与缺失清单（否则 status/rebuild 基于旧账）
  const im = JSON.parse(await readFile(join(d, 'scopes', 'alice', 'index_meta.json'), 'utf8'))
  assert.equal(im.alignmentBroken, true)
  assert.ok(im.lastVectorError)
  assert.ok(Array.isArray(im.missingVectors) && im.missingVectors.length >= 1)
  // 再追加向量必须被拒（本次不写任何数据）
  const r2 = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm3', seq: 3, text: '第三句原话' })], vectors: vec(8, 3), dim: 8 })
  assert.equal(r2.ok, false)
  assert.ok(String(r2.error.message).includes('对齐'))
  const ch = await readScopeChunks(d, 'alice')
  assert.equal(ch.rows.length, 2, '被拒的那次不得追加文本')
})

await t('追加向量前对齐自检：向量缺失的 scope 拒绝追加向量（本次不写文本）', async () => {
  const d = await freshDir('align-pre')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: null, embedding: { dim: 0 } })
  const r = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm2', seq: 2, text: '第二句原话' })], vectors: vec(8, 2), dim: 8 })
  assert.equal(r.ok, false)
  // D1 先拦：manifest.dim=0 与传入 8 不一致，比对齐自检更早拒绝
  assert.equal(r.error.code, CODES.EMBEDDING_MISMATCH)
  const ch = await readScopeChunks(d, 'alice')
  assert.equal(ch.rows.length, 1, '拒绝时不得写入文本')
})

await t('只追加文本（不嵌向量）：ok=true 但 degraded，index_meta 记缺失+对齐未完成', async () => {
  const d = await freshDir('text-only')
  await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt()], vectors: vec(8, 1), embedding: { dim: 8 } })
  const r = await appendUtterances({ dataRoot: d, personaId: 'alice', utterances: [utt({ messageId: 'm2', seq: 2, text: '第二句原话' })] })
  assert.equal(r.stored, true)
  assert.equal(r.ok, true)
  assert.equal(r.degraded, true)
  assert.equal(r.alignment.ok, false)
  const im = JSON.parse(await readFile(join(d, 'scopes', 'alice', 'index_meta.json'), 'utf8'))
  assert.equal(im.alignmentBroken, true)
  assert.ok(im.missingVectors.length >= 1)
  // status 必须能看见
  const st = await statusOfScope(d, 'alice')
  assert.equal(st.degraded, true)
  assert.ok(st.warnings.some((w) => w.includes('行对齐')))
})

await t('写路径归一化：默认 L2（幂等）；迁移模式 false 保持原字节', async () => {
  const dim = 4
  const rows = [utt({ messageId: 'n1', seq: 1, text: '甲原话' }), utt({ messageId: 'n2', seq: 2, text: '乙原话' })]
  const raw = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0])
  const d = await freshDir('normalize')
  const w = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: rows, vectors: raw, embedding: { dim } })
  assert.equal(w.ok, true)
  assert.equal(w.normalizedVectors, true)
  const vr = await readVectorFile(join(d, 'scopes', 'alice', 'vectors_v1.f32'), { count: 2, dim })
  assert.ok(Math.abs(vr.flat[0] - 1) < 1e-6)
  assert.ok(Math.abs(vr.flat[5] - 1) < 1e-6)
  // 迁移模式：不做二次归一化，字节必须原样（否则逐行对证会失败）
  const d2 = await freshDir('normalize-off')
  await writeScopeBundle({ dataRoot: d2, personaId: 'alice', utterances: rows, vectors: raw, embedding: { dim }, normalizeVectors: false })
  const vr2 = await readVectorFile(join(d2, 'scopes', 'alice', 'vectors_v1.f32'), { count: 2, dim })
  assert.equal(vr2.flat[0], 2)
  assert.equal(vr2.flat[5], 3)
})

await t('覆盖写中途失败：尽力回滚到备份，不留半截状态', async () => {
  const d = await freshDir('rollback')
  const w1 = await writeScopeBundle({ dataRoot: d, personaId: 'alice', utterances: [utt({ text: '旧原话一' })], vectors: vec(8, 1), embedding: { dim: 8 } })
  assert.equal(w1.ok, true)
  const vf = join(d, 'scopes', 'alice', 'vectors_v1.f32')
  // 把向量文件设只读：备份能读，但覆盖写 rename 到它上面会失败 → 触发中途失败
  await chmod(vf, 0o444)
  const newVecs = new Float32Array(2 * 8)
  newVecs.set(vec(8, 1), 0)
  newVecs.set(vec(8, 2), 8)
  let w2
  try {
    w2 = await writeScopeBundle({
      dataRoot: d, personaId: 'alice', overwrite: true,
      utterances: [utt({ messageId: 'n1', seq: 1, text: '新原话一' }), utt({ messageId: 'n2', seq: 2, text: '新原话二' })],
      vectors: newVecs, embedding: { dim: 8 },
    })
  } finally {
    await chmod(vf, 0o666)
  }
  assert.equal(w2.ok, false)
  assert.equal(w2.rolledBack, true)
  const after = await readScopeChunks(d, 'alice')
  assert.equal(after.rows.length, 1, 'chunks 必须回滚')
  assert.equal(after.rows[0].text, '旧原话一')
  const m = JSON.parse(await readFile(join(d, 'scopes', 'alice', 'manifest.json'), 'utf8'))
  assert.equal(m.chunks, 1, 'manifest 也必须回滚')
})

// ─────────────────────────────────────────────────────────── 6. 迁移器
group('迁移器（D8/F17）')

await t('小样迁移：2 人格 / 多工作区 / 三重校验 / 旧库零改动', async () => {
  const d = await freshDir('migrate')
  const legacyA = join(d, 'legacy-a')
  const legacyB = join(d, 'legacy-b')
  const rowsA = []
  for (let i = 0; i < 12; i++) {
    const second = i % 2 === 1
    rowsA.push({
      session: `s-a-${i % 2}`, ws: second ? '--C-Users-alice-.dsh-dsh_wechat--' : '--C-work-alice--',
      wsPretty: second ? 'C:\\Users\\alice\\.dsh\\dsh_wechat' : 'C:\\work\\alice',
      t: 1762000000000 + i, role: i % 2 ? 'assistant' : 'user', text: `Alice原话 ${i}`, msgId: `a${i}`, seq: i,
    })
  }
  const rowsB = []
  for (let i = 0; i < 10; i++) {
    const second = i % 2 === 1
    rowsB.push({
      session: `s-b-${i % 2}`, ws: second ? '--C-work-bob-qq-state--' : '--C-work-bob--',
      wsPretty: second ? 'C:\\work\\bob\\dsh\\qq\\state\\agents' : 'C:\\work\\bob',
      t: 1762100000000 + i, role: 'user', text: `Bob原话 ${i}`, msgId: `b${i}`, seq: i,
    })
  }
  await makeLegacy(legacyA, { rows: rowsA })
  await makeLegacy(legacyB, { rows: rowsB })

  const hA = createHash('sha256').update(await readFile(join(legacyA, 'meta.json'))).digest('hex')
  const vA = createHash('sha256').update(await readFile(join(legacyA, 'vectors.f32'))).digest('hex')
  const identity = buildIdentity({
    personas: { alice: 'Alice', bob: 'Bob' },
    workspaces: {
      'C:\\work\\alice': 'alice',
      'C:\\Users\\alice\\.dsh\\dsh_wechat': 'alice',
      'C:\\work\\bob': 'bob',
      'C:\\work\\bob\\dsh\\qq\\state\\agents': 'bob',
    },
  })
  const out = join(d, 'out')
  const report = await migrateLegacyIndex({
    outRoot: out,
    sources: [
      { id: 'src1', personaId: 'alice', displayName: 'Alice', indexDir: legacyA },
      { id: 'src2', personaId: 'bob', displayName: 'Bob', indexDir: legacyB },
    ],
    identity,
    limitPerSource: 20,
    perWsMax: 20,
    write: true,
  })
  assert.equal(report.gate.allGreen, true, JSON.stringify(report.gate))
  assert.equal(report.totals.imported, 22)
  assert.equal(report.gate.sourceUnchanged, true)
  const hA2 = createHash('sha256').update(await readFile(join(legacyA, 'meta.json'))).digest('hex')
  const vA2 = createHash('sha256').update(await readFile(join(legacyA, 'vectors.f32'))).digest('hex')
  assert.equal(hA, hA2)
  assert.equal(vA, vA2, '旧库 vectors.f32 也必须零改动')
  const st = await statusAll(out)
  assert.equal(st.scopes.alice.chunks, 12)
  assert.equal(st.scopes.bob.chunks, 10)
  assert.equal(st.scopes.alice.workspaces, 2, '每源必须覆盖 2 个工作区')
  assert.equal(st.scopes.bob.workspaces, 2, '每源必须覆盖 2 个工作区')
  assert.equal(st.totals.unassignedChunks, 0)
})

await t('迁移器：向量行与旧库逐行一致（不重嵌）', async () => {
  const d = await freshDir('migrate-vec')
  const legacy = join(d, 'legacy')
  const rows = [
    { session: 's1', ws: '--H-a--', wsPretty: 'H:\\a', t: 1762000000000, role: 'user', text: '一', msgId: 'm1', seq: 1 },
    { session: 's1', ws: '--H-a--', wsPretty: 'H:\\a', t: 1762000000001, role: 'assistant', text: '二', msgId: 'm2', seq: 2 },
  ]
  const built = await makeLegacy(legacy, { rows, dim: 8 })
  const out = join(d, 'out')
  const report = await migrateLegacyIndex({ outRoot: out, sources: [{ id: 'x', personaId: 'alice', indexDir: legacy }], limitPerSource: 10, perWsMax: 10 })
  assert.equal(report.gate.vectorsOk, true)
  const vr = await readVectorFile(join(out, 'scopes', 'alice', 'vectors_v1.f32'), { count: 2, dim: 8 })
  assert.equal(vr.ok, true)
  assert.ok(rowsEqual(vr.flat.subarray(0, 8), built.flat.subarray(0, 8), 8))
  assert.ok(rowsEqual(vr.flat.subarray(8, 16), built.flat.subarray(8, 16), 8))
})

await t('迁移保真：原话前后空白逐字节保留（不 trim、不改写）', async () => {
  const d = await freshDir('migrate-raw')
  const legacy = join(d, 'legacy')
  const rows = [{
    session: 's1', ws: '--H-a--', wsPretty: 'H:\\a', t: 1762000000000, role: 'user',
    text: '  前后有空格的   原话  \n', msgId: 'm1', seq: 1,
  }]
  await makeLegacy(legacy, { rows })
  const out = join(d, 'out')
  const report = await migrateLegacyIndex({ outRoot: out, sources: [{ id: 'x', personaId: 'alice', indexDir: legacy }] })
  assert.equal(report.gate.allGreen, true, JSON.stringify(report.sources[0].checks))
  assert.equal(report.sources[0].checks.textVsLegacy, true)
  const written = await readScopeChunks(out, 'alice')
  assert.equal(written.rows[0].text, rows[0].text, '存储值必须与原话逐字节一致')
  // id 仍按归一化文本计算（同一句话不同首尾空白 ⇒ 同 id ⇒ 幂等）
  assert.equal(written.rows[0].id, makeChunkId({ session: 's1', messageId: 'm1', seq: 1, part: 0, text: rows[0].text }))
})

await t('迁移器：旧库尺寸不符 → 明确报错，不写半成品', async () => {
  const d = await freshDir('migrate-bad')
  const legacy = join(d, 'legacy')
  await makeLegacy(legacy, { rows: [{ session: 's', ws: '--H-a--', wsPretty: 'H:\\a', t: 1, role: 'user', text: 'x', msgId: 'm', seq: 1 }], dim: 8 })
  await writeFile(join(legacy, 'vectors.f32'), Buffer.alloc(4))
  const out = join(d, 'out')
  const report = await migrateLegacyIndex({ outRoot: out, sources: [{ id: 'x', personaId: 'alice', indexDir: legacy }] })
  assert.equal(report.gate.allGreen, false)
  assert.equal(report.sources[0].error.code, CODES.VECTOR_SIZE_MISMATCH)
  const exists = await stat(join(out, 'scopes', 'alice', 'chunks.jsonl')).then(() => true).catch(() => false)
  assert.equal(exists, false, '失败时不应写出 chunks.jsonl')
})

// ─────────────────────────────────────────────────────────── 7. 会话摄取
group('会话摄取（只读源 / 系统注入过滤 / ws 收窄）')

await t('ingestSessions：读合成会话 → 按 persona 落库，系统注入被滤掉', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const d = await freshDir('ingest')
  const fakeHome = join(d, 'dshhome')
  const wsDir = '--C-work-alice--'
  const sessDir = join(fakeHome, 'sessions', wsDir, 'session-test-0001')
  await mkdir(sessDir, { recursive: true })
  const lines = [
    { type: 'user/message', time: 1762000000000, seq: 1, data: { id: 'm1', content: [{ type: 'text', text: '这是用户说的原话，前后有空格 ' }] } },
    { type: 'assistant/message', time: 1762000001000, seq: 2, data: { id: 'm2', content: [{ type: 'text', text: '这是助手回的原话' }] } },
    { type: 'user/message', time: 1762000002000, seq: 3, data: { id: 'm3', content: [{ type: 'text', text: 'Current runtime context: this must be filtered' }] } },
  ]
  await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n')))

  const dataRoot = join(d, 'store')
  const identity = buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  try {
    const report = await ingestSessions({ dataRoot, identity, days: 7 })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.extracted, 2, '系统注入必须被滤掉')
    assert.equal(report.written, 2)
    const rows = (await readScopeChunks(dataRoot, 'alice')).rows
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.personaId === 'alice'))
    assert.ok(rows.every((r) => r.channel === 'dsh'))
    // 抽取口径：sessions 来源在「抽取」这一步裁剪首尾空白（与寻枝 0.3.1 一致）；
    // 迁移旧库时则逐字节保留（见迁移保真用例）。内容本身不改写。
    assert.equal(rows.find((r) => r.role === 'user').text, '这是用户说的原话，前后有空格')
    assert.equal(rows.find((r) => r.role === 'assistant').messageId, 'm2')

    // ws 收窄：不匹配的工作区 → 0 块，且不落库
    const none = await ingestSessions({ dataRoot, identity, days: 7, ws: 'D:\\nowhere', dryRun: true })
    assert.equal(none.selected, 0)

    // 骨架不嵌向量 → index_meta 把新块列为缺失，status 要能报出来
    const st = await statusOfScope(dataRoot, 'alice')
    assert.equal(st.chunks, 2)
    assert.ok(st.warnings.some((w) => w.includes('向量')))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

// 回归：桥接 sourceType（assistant-bridge / user-bridge）必须先折叠再校验，
// 否则 validateChunk 会判非法、整块被静默丢弃（2026-11-07 实测 24h 丢 37%）。
await t('ingestSessions：桥接 sourceType 折叠后落库，不丢块', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const d = await freshDir('ingest-bridge')
  const fakeHome = join(d, 'dshhome')
  const wsDir = '--C-work-bob--'
  const sessDir = join(fakeHome, 'sessions', wsDir, 'session-bridge-0001')
  await mkdir(sessDir, { recursive: true })
  const lines = [
    {
      type: 'tool/call', time: 1762000010000, seq: 1,
      data: { name: 'qq_send_message', callId: 'call-1', arguments: JSON.stringify({ messages: ['这是桥接发送出去的助手原话，必须能落库'] }) },
    },
    {
      type: 'tool/call', time: 1762000011000, seq: 2,
      data: { name: 'qq_get_unread_messages', callId: 'call-2', arguments: '{}' },
    },
    {
      type: 'tool/result', time: 1762000012000, seq: 3,
      data: { message: { source: { callId: 'call-2' }, content: [{ type: 'text', text: JSON.stringify({ messages: [{ text: '这是桥接收到的用户原话，也必须能落库', seq: 3, messageId: 'bm1' }] }) }] } },
    },
  ]
  await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n')))

  const dataRoot = join(d, 'store')
  const identity = buildIdentity({ personas: { bob: 'Bob' }, workspaces: { 'C:\\work\\bob': 'bob' } })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  try {
    const report = await ingestSessions({ dataRoot, identity, days: 7 })
    assert.equal(report.ok, true, JSON.stringify(report.errors))
    assert.equal(report.invalid, 0, '桥接块不得被判非法')
    assert.equal(report.written, 2, '两桥接块都要落库')
    const rows = (await readScopeChunks(dataRoot, 'bob')).rows
    assert.equal(rows.length, 2)
    assert.equal(rows.find((r) => r.role === 'assistant')?.sourceType, 'assistant')
    assert.equal(rows.find((r) => r.role === 'user')?.sourceType, 'user')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

// 回归：已有向量的 scope 必须拒绝文本-only 摄取（否则会再次 alignmentBroken）。
await t('ingestSessions：已有向量的 scope 拒绝文本-only 摄取', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const d = await freshDir('ingest-guard')
  const dataRoot = d
  const u = makeUtterance({
    session: 's-guard', personaId: 'alice', identitySource: 'manual',
    messageId: 'm0', seq: 0, part: 0, role: 'user', sourceType: 'user', t: 1762000000000,
    text: '已有向量库的一行原话，不能被文本-only 追加',
  })
  const w = await writeScopeBundle({
    dataRoot, personaId: 'alice', displayName: 'Alice', identitySource: 'manual',
    utterances: [u], vectors: null, embedding: { provider: 'cloud', model: 'm', dim: 8 },
    retentionDays: 30, reason: 'test-guard',
  })
  assert.equal(w.ok, true, JSON.stringify(w.error))
  const fakeHome = join(d, 'dshhome')
  const sessDir = join(fakeHome, 'sessions', '--C-work-alice--', 'session-guard-0001')
  await mkdir(sessDir, { recursive: true })
  const lines = [
    { type: 'user/message', time: 1762000001000, seq: 1, data: { id: 'm1', content: [{ type: 'text', text: '这会尝试文本-only 追加，必须被拒绝' }] } },
  ]
  await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n')))
  const identity = buildIdentity({ personas: { alice: 'Alice' }, workspaces: { 'C:\\work\\alice': 'alice' } })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  try {
    const report = await ingestSessions({ dataRoot, identity, days: 7 })
    assert.equal(report.ok, false, '有向量的 scope 不应返回 ok')
    assert.ok(report.errors.some((e) => e.code === 'EMBEDDING_REQUIRED'), JSON.stringify(report.errors))
    const rows = (await readScopeChunks(dataRoot, 'alice')).rows
    assert.equal(rows.length, 1, '被拒绝时不得追加任何块')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

// ─────────────────────────────────────────────────────────── 8. 守卫
group('守卫（契约 §7）')

await t('工具名：只允许七件，且不得含 recall/search/query', async () => {
  const ids = [
    'jianmu_store_ingest', 'jianmu_store_status', 'jianmu_store_rebuild', 'jianmu_store_export',
    'jianmu_store_forget', 'jianmu_store_revive', 'jianmu_store_identity_add_persona',
  ]
  assert.equal(checkToolSurface(ids).ok, true)
  for (const bad of ['jianmu_store_recall', 'jianmu_store_search', 'session_query']) {
    assert.equal(checkToolName(bad).ok, false, bad)
  }
  assert.ok(checkToolSurface([...ids, 'jianmu_store_ingest_extra']).problems.length > 0, '未登记的第八个工具必须被拒')
  assert.ok(checkToolSurface([...ids, 'jianmu_store_recall']).problems.length > 0)
  assert.ok(checkToolSurface(ids.slice(0, 3)).problems.length > 0)
  assert.deepEqual([...ALLOWED_TOOLS], ids)
})

await t('注入钩子源码闸门：能抓住 pre-step / systemPrompt', async () => {
  assert.equal(scanSourceForInjection('const x = 1\n// 正常代码').ok, true)
  assert.equal(scanSourceForInjection("ctx.on('pre-step', () => {})").ok, false)
  assert.equal(scanSourceForInjection('appendSystemPrompt("hi")').ok, false)
})

await t('写路径闸门：拒绝 sessions/ 与 dataRoot 之外', async () => {
  const d = await freshDir('guard-write')
  assert.equal(assertWriteAllowed(d, join(d, 'ok.json')), true, 'dataRoot 之内应允许')
  assert.throws(() => assertWriteAllowed(d, join(sessionsRoot(), 'x')), (e) => e.code === CODES.READ_ONLY_SOURCE)
  assert.throws(() => assertWriteAllowed(d, 'D:\\elsewhere\\x'), (e) => e.code === CODES.PATH_OUTSIDE_ROOT)
})

await t('人格一致性：目录与 personaId 不一致 → 拒绝', async () => {
  assert.equal(checkPersonaWrite('alice', 'alice').ok, true)
  assert.equal(checkPersonaWrite('alice', 'bob').ok, false)
  assert.equal(checkPersonaWrite(PERSONA_UNASSIGNED, PERSONA_UNASSIGNED).ok, true)
})

// ─────────────────────────────────────────────────────────── 8. 插件面
group('插件面：apply 只注册七工具、provide jianmuStore、不注入、初始化失败不抛')

await t('apply 注册恰好七个工具且名字合规', async () => {
  const d = await freshDir('plugin')
  const registered = []
  const provided = {}
  const ctx = {
    tools: { register(spec) { registered.push(spec); return () => {} } },
    get: () => null,
    provide(n, svc) { provided[n] = svc; return () => {} },
    logger: { info() {} },
    settings: { describe: () => [] },
  }
  const mod = await import('../index.js')
  const dispose = mod.apply(ctx, { dataRoot: d, autoIngest: false })
  assert.equal(registered.length, 7, `实际注册 ${registered.length}`)
  assert.deepEqual(registered.map((r) => r.name).sort(), [...ALLOWED_TOOLS].sort())
  const surface = checkToolSurface(registered.map((r) => r.name))
  assert.equal(surface.ok, true, surface.problems.join('；'))
  assert.equal(typeof provided.jianmuStore?.identityAddPersona, 'function', 'host 服务 jianmuStore 必须注册')
  assert.equal(typeof provided.jianmuStore?.identityRemoveMappings, 'function')
  assert.equal(typeof dispose, 'function')
  dispose()
})

await t('apply：dataRoot 不可写也不抛，且 ready 后断言降级', async () => {
  const d = await freshDir('plugin-bad')
  // 用一个「父路径是文件」的非法目录
  const filePath = join(d, 'a-file')
  await writeFile(filePath, 'x')
  const ctx = { tools: { register: () => () => {} }, get: () => null, logger: { info() {} } }
  const mod = await import('../index.js')
  let dispose
  assert.doesNotThrow(() => { dispose = mod.apply(ctx, { dataRoot: join(filePath, 'nested'), autoIngest: false }) })
  const boot = await dispose.ready
  assert.equal(boot.ok, false)
  assert.equal(boot.degraded, true)
  assert.ok(boot.reason)
  dispose()
})

await t('apply：宿主把 dataRoot 当对象传入也不崩（回退默认根）', async () => {
  // 2026-11-07 实机：宿主某些加载路径把 Config 字符串字段作为对象传入，
  // 旧 normalizeConfig 原样收下 → resolve(object) 抛 ERR_INVALID_ARG_TYPE，
  // 表现为 jianmu_store_status 一调就报 "paths[0] must be of type string"。
  const d = await freshDir('plugin-objcfg')
  const fakeHome = join(d, 'dshhome')
  await mkdir(fakeHome, { recursive: true })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  try {
    const registered = []
    const ctx = { tools: { register(s) { registered.push(s); return () => {} } }, get: () => null, logger: { info() {} }, settings: { describe: () => [] } }
    const mod = await import('../index.js')
    const dispose = mod.apply(ctx, { dataRoot: { bogus: true }, autoIngest: false })
    const boot = await dispose.ready
    assert.equal(boot.ok, true, JSON.stringify(boot))
    assert.equal(boot.dataRoot, join(fakeHome, 'memory-jianmu'))
    assert.equal(registered.length, 7)
    dispose()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

await t('JIANMU_DATA_ROOT 覆盖默认数据根（未设置则回退 DSH_HOME）', async () => {
  const { defaultDataRoot } = await import('../lib/paths.mjs')
  const oldHome = process.env.DSH_HOME
  const oldOv = process.env.JIANMU_DATA_ROOT
  try {
    process.env.DSH_HOME = join(ROOT, 'fake-home')
    delete process.env.JIANMU_DATA_ROOT
    assert.equal(defaultDataRoot(), join(ROOT, 'fake-home', 'memory-jianmu'))
    process.env.JIANMU_DATA_ROOT = 'C:/jianmu-data'
    assert.equal(defaultDataRoot(), resolve('C:/jianmu-data'))
    process.env.JIANMU_DATA_ROOT = '   '
    assert.equal(defaultDataRoot(), join(ROOT, 'fake-home', 'memory-jianmu'), '空白覆盖必须忽略')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    if (oldOv === undefined) delete process.env.JIANMU_DATA_ROOT
    else process.env.JIANMU_DATA_ROOT = oldOv
  }
})

await t('自动摄取：computeNextRunAt 对齐到每小时第 N 分 / 支持固定间隔', async () => {
  const { runAutoIngest, computeNextRunAt, loadEmbeddingConfig } = await import('../lib/auto-ingest.mjs')
  const at = Date.parse('2026-11-09T08:17:00+08:00')
  assert.equal(new Date(computeNextRunAt({ autoIngestMinute: 7 }, at)).getHours(), 9, '08:17 之后的下一个 :07 应该是 09:07')
  const at2 = Date.parse('2026-11-09T08:07:30+08:00')
  assert.equal(new Date(computeNextRunAt({ autoIngestMinute: 7 }, at2)).getHours(), 9, '过了 :07 就排下一小时')
  const at3 = Date.parse('2026-11-09T08:17:00+08:00')
  assert.equal(computeNextRunAt({ autoIngestMinute: -1, autoIngestIntervalMinutes: 30 }, at3) - at3, 30 * 60000)
  const e = loadEmbeddingConfig({ embeddingApiKey: 'k', embeddingApiBase: 'http://127.0.0.1:9999/v1' })
  assert.equal(e.ok, true)
  assert.equal(e.source, 'plugin-config')
  assert.equal(e.apiBase, 'http://127.0.0.1:9999/v1')
  // identity 不可用时必须返回报告，而不是抛异常（定时器里抛会带崩宿主）
  const d = await freshDir('auto-ingest')
  const r = await runAutoIngest({ dataRoot: d, days: 1, config: { embeddingApiKey: 'k' }, dryRun: true })
  assert.equal(r.ok, false)
  assert.ok(r.errors.length >= 1, '应记录 identity 不可用')
})

await t('A2 自动摘要：判定 / 待摘要计数 / 撕裂尾巴容错', async () => {
  const m = await import('../lib/auto-summary.mjs')
  assert.deepEqual(m.decideAutoSummary({ autoSummaryIndex: false, report: { byPersona: { a: { written: 1 } } } }), [])
  const manifests = {
    a: { exists: true, summaryMode: 'concat' },
    b: { exists: true, summaryMode: '' },
    c: { exists: false },
  }
  const d = m.decideAutoSummary({
    autoSummaryIndex: true,
    report: { byPersona: { a: { written: 2 }, b: { written: 1 }, c: { written: 1 }, d: { written: 0 } } },
    manifests,
  })
  const by = Object.fromEntries(d.map((x) => [x.personaId, x]))
  assert.equal(by.a.run, true)
  assert.equal(by.a.reason, 'ok')
  assert.equal(by.b.run, false)
  assert.equal(by.b.reason, 'not-concat', '没做过 A2 的库不擅自改造')
  assert.equal(by.c.run, false)
  assert.equal(by.c.reason, 'scope-missing')
  assert.equal(by.d.run, false)
  assert.equal(by.d.reason, 'no-new-chunks', '本轮没写新块就不跑')

  assert.equal(m.needsSummary({ text: 'x'.repeat(80) }, 80), true)
  assert.equal(m.needsSummary({ text: 'x'.repeat(79) }, 80), false)
  assert.equal(m.needsSummary({ text: 'x'.repeat(200), summary: '有摘要' }, 80), false)
  assert.equal(m.countPendingSummaries([
    { text: 'x'.repeat(200) }, { text: 'short' }, { text: 'y'.repeat(300), summary: 's' },
  ], 80), 1)

  const rows = m.parseChunkLines('{"id":"a"}\n{"id":"b"}\n{"id":')
  assert.equal(rows.length, 2, '撕裂尾巴的行跳过，不抛')
})

await t('A2 自动摘要：摄取后调度（默认关 / 起进程 / 单飞锁 / 陈旧锁 / Ollama 不可达）', async () => {
  const m = await import('../lib/auto-summary.mjs')
  const { autoSummaryLockPath, autoSummaryLogPath } = await import('../lib/paths.mjs')
  const makeRoot = async (label) => {
    const d = await freshDir(label)
    const dir = join(d, 'scopes', 'alice')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({
      chunks: 2, dim: 4096, model: 'Qwen/Qwen3-Embedding-8B', embeddingMeta: { summaryMode: 'concat' },
    }))
    await writeFile(join(dir, 'chunks.jsonl'), [
      JSON.stringify({ id: 'u1', role: 'user', text: '新块' }),
      JSON.stringify({ id: 'u2', role: 'user', text: '长'.repeat(100) }),
    ].join('\n') + '\n')
    return d
  }
  const report = { ok: true, byPersona: { alice: { written: 1 } } }
  const cfg = {
    autoSummaryIndex: true, summaryModel: 'qwen3:8b', summaryBase: 'http://127.0.0.1:11434',
    summaryMinChars: 80, embeddingApiKey: 'k',
  }

  // ① 默认关：不起进程
  const d1 = await makeRoot('auto-summary-off')
  const calls = []
  const spawnFn = async (x) => { calls.push(x); return { ok: true, childPid: 4242 } }
  const probeFn = async () => true
  const off = await m.runAutoSummaryAfterIngest({ dataRoot: d1, config: { ...cfg, autoSummaryIndex: false }, report, spawnFn, probeFn })
  assert.equal(off.skipped, true)
  assert.equal(off.reason, 'off')
  assert.equal(calls.length, 0)

  // ② 开：起一次；密钥通过 env 传递；锁落地；事件日志有 spawn
  const on = await m.runAutoSummaryAfterIngest({ dataRoot: d1, config: cfg, report, spawnFn, probeFn })
  assert.equal(on.started.length, 1)
  assert.equal(on.started[0].personaId, 'alice')
  assert.equal(on.started[0].pending, 1)
  assert.equal(on.started[0].childPid, 4242)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].embedding.apiKey, 'k')
  assert.equal(await pathExists(autoSummaryLockPath(d1, 'alice')), true)
  const evt = await readFile(autoSummaryLogPath(d1), 'utf8')
  assert.ok(evt.includes('"event":"spawn"'), evt)

  // ③ 单飞：锁还在 → 跳过，不再起进程
  const again = await m.runAutoSummaryAfterIngest({ dataRoot: d1, config: cfg, report, spawnFn, probeFn })
  assert.equal(again.started.length, 0)
  assert.equal(again.skipped, true)
  assert.equal(calls.length, 1)

  // ④ 陈旧锁（>30 分钟）→ 可抢占
  await writeFile(autoSummaryLockPath(d1, 'alice'), JSON.stringify({
    pid: 1, token: 'old', personaId: 'alice', startedAt: new Date(Date.now() - 31 * 60000).toISOString(),
  }))
  const stale = await m.runAutoSummaryAfterIngest({ dataRoot: d1, config: cfg, report, spawnFn, probeFn })
  assert.equal(stale.started.length, 1, '陈旧锁应被抢占')
  assert.equal(calls.length, 2)

  // ⑤ Ollama 不可达：跳过（不白花嵌入钱）
  const d2 = await makeRoot('auto-summary-no-ollama')
  const call2 = []
  const down = await m.runAutoSummaryAfterIngest({
    dataRoot: d2, config: cfg, report,
    spawnFn: async (x) => { call2.push(x); return { ok: true, childPid: 1 } },
    probeFn: async () => false,
  })
  assert.equal(down.started.length, 0)
  assert.equal(down.skipped, true)
  assert.equal(call2.length, 0)
  const evt2 = await readFile(autoSummaryLogPath(d2), 'utf8')
  assert.ok(evt2.includes('ollama-unreachable'), evt2)

  // ⑥ 没有待摘要的长块：不跑（避免没有意义地重写整个向量文件）
  const d3 = await makeRoot('auto-summary-nothing')
  await writeFile(join(d3, 'scopes', 'alice', 'chunks.jsonl'), JSON.stringify({ id: 'u1', role: 'user', text: '短' }) + '\n')
  const call3 = []
  const nothing = await m.runAutoSummaryAfterIngest({
    dataRoot: d3, config: cfg, report,
    spawnFn: async (x) => { call3.push(x); return { ok: true, childPid: 1 } },
    probeFn: async () => true,
  })
  assert.equal(nothing.started.length, 0)
  assert.equal(call3.length, 0)
})

await t('插件源码（index + 全部 lib）不含注入钩子', async () => {
  const dir = fileURLToPath(new URL('../', import.meta.url))
  const files = ['index.js', ...(await readdir(join(dir, 'lib'))).filter((f) => f.endsWith('.mjs')).map((f) => join('lib', f))]
  const hits = []
  for (const f of files) {
    const scan = scanSourceForInjection(await readFile(join(dir, f), 'utf8'))
    for (const h of scan.hits) hits.push({ file: f, ...h })
  }
  assert.equal(hits.length, 0, JSON.stringify(hits))
})

// ─────────────────────────────────────────────────────────── 收尾
const failed = results.filter((r) => !r.ok)
console.log(`\n═══ 自测：${results.length - failed.length}/${results.length} 通过 ═══`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}`)
  console.log(`\n临时目录保留：${ROOT}`)
  process.exitCode = 1
} else {
  await rm(ROOT, { recursive: true, force: true })
  console.log(`临时目录已清理：${ROOT}`)
}
