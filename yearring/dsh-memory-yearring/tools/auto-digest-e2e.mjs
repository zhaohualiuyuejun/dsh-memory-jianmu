#!/usr/bin/env node
/**
 * tools/auto-digest-e2e.mjs —— 插件内自动消化端到端自测（零网络、零费用）
 *
 * 覆盖：apply 后真实调用 tickAuto →
 *   · 从 identity + 根藏 scope 找到人格
 *   · 选块 → 假 LLM 抽 claim → 落 claims.jsonl（锚点校验）
 *   · runs.jsonl 记 trigger=auto
 *   · 结束后跑 rebuildTopicDocs
 *
 * 用法：node tools/auto-digest-e2e.mjs
 */
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { buildIdentity, writeIdentity } from '../../../root/lib/identity.mjs'
import { writeScopeBundle, readScopeChunks } from '../../../root/lib/store.mjs'
import { makeUtterance } from '../../../root/lib/chunks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const results = []
const ok = (name, cond, detail) => {
  results.push({ name, pass: Boolean(cond) })
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

const root = await mkdtemp(join(tmpdir(), 'jianmu-auto-digest-'))
const PID = 'testpersona'
let dispose = null

try {
  // 1) 造 identity + 根藏 scope（1 块，时间=现在，落在 last:90d 内）
  await writeIdentity(root, buildIdentity({
    personas: { [PID]: { displayName: '测试人格' } },
    defaultPersonaId: null,
    workspaces: {},
    sessions: {},
  }))
  const text = '用户要求年轮自动消化，不要任务看板。'
  const u = makeUtterance({
    session: 'session-auto-test', personaId: PID, identitySource: 'manual',
    messageId: 'm1', seq: 1, part: 0, role: 'user', t: Date.now(),
    text, ws: 'C:\\work\\alice',
  })
  const w = await writeScopeBundle({ dataRoot: root, personaId: PID, utterances: [u], embedding: {} })
  if (!w.ok) throw new Error('造根藏 scope 失败：' + JSON.stringify(w.error || w))
  const scope = await readScopeChunks(root, PID)
  const chunk = scope.rows[0]
  if (!chunk) throw new Error('根藏 scope 里没有块')

  // 2) 假 LLM：输出 1 条合格 claim（quote 是原话逐字子串）
  const payload = JSON.stringify([{
    kind: 'preference', epistemic: 'fact',
    title: '年轮要自动消化，不要任务看板',
    body: '', topicHint: '年轮', confidence: 0.9,
    quoteChunkId: chunk.id,
    quote: '年轮自动消化，不要任务看板',
  }])
  const fakeLlm = {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const piece of [payload.slice(0, 10), payload.slice(10)]) {
        yield { type: 'text-delta', index: 0, text: piece }
      }
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 120 } }
      yield { type: 'finish', reason: 'stop' }
    },
  }

  // 3) mock ctx 并 apply
  const registered = []
  const ctx = {
    logger: { info() {} },
    settings: { describe: () => [] },
    tools: { register: (def) => { registered.push(def.name); return () => {} } },
    provide: () => () => {},
    inject: (deps, cb) => cb({ webServer: { register: () => () => {} }, effect: (fn) => fn() }),
    get: (n) => (n === 'llm' ? fakeLlm : (n === 'webServer' ? { register: () => () => {} } : undefined)),
    on: () => {},
  }
  const mod = await import(pathToFileURL(join(PKG_DIR, 'index.js')).href)
  dispose = mod.apply(ctx, {
    dataRoot: root,
    autoDigest: true,
    autoDigestMinute: -1,
    autoDigestIntervalMinutes: 60,
    autoDigestMaxRounds: 3,
    autoDigestBatchChunks: 2,
    autoDigestBudgetTokens: 8000,
  })
  ok('apply 后自动消化已接线', dispose.autoDigest().enabled === true, dispose.autoDigest())

  // 4) 立即跑一轮
  await dispose.runAutoDigest('e2e')
  const auto = dispose.autoDigest()
  ok('自动消化跑完且无错误', auto.last && auto.last.personaId === PID && !auto.last.error, auto.last)
  ok('自动消化有轮次记录', Number(auto.last?.rounds) >= 1, auto.last)

  // 5) 核验产物
  const claims = await readFile(join(root, 'year', PID, 'claims.jsonl'), 'utf8')
  ok('claims.jsonl 已写入 1 条 claim', claims.trim().split('\n').length >= 1, claims.slice(0, 200))
  const runs = await readFile(join(root, 'year', PID, 'runs.jsonl'), 'utf8')
  const runRows = runs.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  ok('runs.jsonl 记 trigger=auto', runRows.some((r) => r.trigger === 'auto'), runRows.map((r) => r.trigger))
  ok('runs.jsonl 有 token 记账', runRows.some((r) => Number(r.promptTokens) > 0 && Number(r.outputTokens) > 0), runRows[0])

  // 6) topic_docs 已 rebuild
  const docDir = join(root, 'year', PID, 'topic_docs')
  let docs = ''
  try {
    const names = await readdir(docDir)
    for (const n of names.filter((x) => x.endsWith('.md'))) docs += await readFile(join(docDir, n), 'utf8')
  } catch { /* 目录不存在按失败处理 */ }
  ok('rebuild 生成了 topic 正文', docs.includes('年轮要自动消化'), docs.slice(0, 200))
} catch (e) {
  ok('端到端未抛异常', false, String(e?.stack || e))
} finally {
  try { if (dispose) dispose() } catch { /* ignore */ }
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n═══ 自动消化端到端：${results.length - failed.length}/${results.length} 通过 ═══`)
if (failed.length) process.exitCode = 1
