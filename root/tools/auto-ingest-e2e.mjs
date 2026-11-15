#!/usr/bin/env node
/**
 * tools/auto-ingest-e2e.mjs —— 根藏插件内自动摄取端到端自测（零外网、零费用）
 *
 * 覆盖：合成会话（zstd）→ runAutoIngest：
 *   · 读 identity + 抽取会话
 *   · 调本地假 /v1/embeddings 拿向量（8 维）
 *   · 先嵌后写 → chunks/vectors/manifest 全部前进
 *   · 第二次跑无新块（幂等，不重复嵌入）
 *   · _logs/auto-ingest.jsonl + auto-ingest-state.json 生成
 *
 * 用法：node tools/auto-ingest-e2e.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { zstdCompressSync } from 'node:zlib'

import { buildIdentity, writeIdentity } from '../lib/identity.mjs'
import { writeScopeBundle, readScopeChunks, readScopeMeta, statusOfScope } from '../lib/store.mjs'
import { makeUtterance } from '../lib/chunks.mjs'
import { runAutoIngest } from '../lib/auto-ingest.mjs'

const results = []
const ok = (name, cond, detail) => {
  results.push({ name, pass: Boolean(cond) })
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

const root = await mkdtemp(join(tmpdir(), 'jianmu-auto-ingest-'))
const fakeHome = join(root, 'dshhome')
const dataRoot = join(root, 'store')
const DIM = 8
let server = null
const oldHome = process.env.DSH_HOME

try {
  // 1) 合成会话
  const sessDir = join(fakeHome, 'sessions', '--C-work-alice--', 'session-test-auto')
  await mkdir(sessDir, { recursive: true })
  const now = Date.now()
  const lines = [
    { type: 'user/message', time: now - 2000, seq: 1, data: { id: 'm1', content: [{ type: 'text', text: '自动摄取测试的用户原话' }] } },
    { type: 'assistant/message', time: now - 1000, seq: 2, data: { id: 'm2', content: [{ type: 'text', text: '自动摄取测试的助手原话' }] } },
    { type: 'user/message', time: now - 500, seq: 3, data: { id: 'm3', content: [{ type: 'text', text: 'Current runtime context: must be filtered' }] } },
  ]
  await writeFile(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n')))

  // 2) identity + 已有 scope（1 块 + 8 维向量）
  await writeIdentity(dataRoot, buildIdentity({
    personas: { alice: 'Alice' },
    workspaces: { 'C:\\work\\alice': 'alice' },
  }))
  const base = makeUtterance({
    session: 'session-base', personaId: 'alice', identitySource: 'manual',
    messageId: 'base1', seq: 1, part: 0, role: 'user', t: now - 86400000,
    text: '已有的一条基础原话', ws: 'C:\\work\\alice',
  })
  const baseVec = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) baseVec[i] = i + 1
  const w0 = await writeScopeBundle({
    dataRoot, personaId: 'alice', utterances: [base], vectors: baseVec, dim: DIM,
    embedding: { provider: 'cloud', model: 'test-embed', dim: DIM, normalizerVersion: 'l2-v1' },
  })
  if (!w0.ok) throw new Error('造基础 scope 失败：' + JSON.stringify(w0.error || w0))

  // 3) 本地假嵌入服务
  let embedCalls = 0
  server = createServer((req, res) => {
    if (req.method !== 'POST' || !String(req.url).endsWith('/embeddings')) {
      res.statusCode = 404
      return res.end('not found')
    }
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      try {
        const j = JSON.parse(body)
        embedCalls++
        const inputs = Array.isArray(j.input) ? j.input : [j.input]
        const data = inputs.map((_, idx) => {
          const v = new Array(DIM).fill(0).map((__, k) => Math.sin(idx + k + 1))
          return { index: idx, embedding: v }
        })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data, usage: { prompt_tokens: inputs.length * 7, total_tokens: inputs.length * 7 } }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: { message: String(e.message || e) } }))
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // 4) 跑自动摄取
  process.env.DSH_HOME = fakeHome
  const report = await runAutoIngest({
    dataRoot, days: 7,
    config: { embeddingApiKey: 'test-key', embeddingApiBase: `http://127.0.0.1:${port}/v1` },
    logger: () => {},
  })
  ok('自动摄取 report.ok', report.ok === true, report.errors)
  ok('抽取 2 块（系统注入被滤掉）', report.extracted === 2, report.extracted)
  ok('写入 2 块', report.written === 2, report.written)
  ok('嵌入请求真的发生了', embedCalls >= 1, embedCalls)

  const rows = (await readScopeChunks(dataRoot, 'alice')).rows
  ok('scope 共 3 块（基础 1 + 新增 2）', rows.length === 3, rows.length)
  const meta = await readScopeMeta(dataRoot, 'alice')
  ok('manifest 块数同步到 3', meta.manifest?.chunks === 3, meta.manifest?.chunks)
  const st = await statusOfScope(dataRoot, 'alice', { deep: true })
  ok('向量行数 = 3、无缺失', st.vectors?.rows === 3 && st.vectors?.missing === 0, st.vectors)

  // 5) 幂等：再跑一次无新块、不再嵌
  const callsBefore = embedCalls
  const again = await runAutoIngest({
    dataRoot, days: 7,
    config: { embeddingApiKey: 'test-key', embeddingApiBase: `http://127.0.0.1:${port}/v1` },
    logger: () => {},
  })
  ok('第二次跑 ok 且写入 0', again.ok === true && again.written === 0, again.byPersona)
  ok('第二次没有新的嵌入请求', embedCalls === callsBefore, { before: callsBefore, after: embedCalls })

  // 6) 日志与状态
  const log = await readFile(join(dataRoot, '_logs', 'auto-ingest.jsonl'), 'utf8')
  ok('auto-ingest.jsonl 已写', log.trim().split('\n').length >= 2, log.slice(0, 160))
  const state = JSON.parse(await readFile(join(dataRoot, '_logs', 'auto-ingest-state.json'), 'utf8'))
  ok('auto-ingest-state.json 记了 lastSuccessAt', Boolean(state.lastSuccessAt), state)
} catch (e) {
  ok('端到端未抛异常', false, String(e?.stack || e))
} finally {
  try { if (server) await new Promise((r) => server.close(r)) } catch { /* ignore */ }
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  await rm(root, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n═══ 自动摄取端到端：${results.length - failed.length}/${results.length} 通过 ═══`)
if (failed.length) process.exitCode = 1
