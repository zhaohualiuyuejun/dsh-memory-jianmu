#!/usr/bin/env node
/**
 * tools/external-store-smoke.mjs —— 验证「不装根藏，只给外部 chunk store」也能跑年轮
 *
 * 零网络、零费用（stub LLM）；临时目录；跑完删除。
 * 用法：node tools/external-store-smoke.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runYear } from '../lib/extract.mjs'

const root = await mkdtemp(join(tmpdir(), 'jianmu-yearring-external-'))
const dataRoot = join(root, 'data')
const pid = 'testpersona'
const dir = join(dataRoot, 'scopes', pid)
const now = Date.now()
const text = '外部数据源测试：年轮可以直接读用户自己切好的原话块，并提炼出带锚点的结论。'
const chunk = {
  id: 'external-chunk-0001', kind: 'utterance', schemaVersion: 1, contractVersion: 1,
  session: 'external-session-1', personaId: pid, identitySource: 'manual',
  messageId: 'm1', seq: 1, turn: null, part: 0, role: 'user', sourceType: 'user',
  t: now - 1000, tz: 'Asia/Shanghai', text,
  ws: 'C:\\work\\alice', wsDir: '--C-work-alice--', channel: 'dsh',
  attachments: [], sourceHash: 'external-hash-1', retention: 'active', ingestVersion: 'external-1',
}
const manifest = {
  schemaVersion: 1, contractVersion: 1, generation: 1, personaId: pid,
  displayName: '外部测试', identitySource: 'manual', provider: 'external', model: 'external',
  dim: 0, normalizerVersion: 'l2-v1', chunks: 1, sessions: 1, workspaces: 1,
  tMin: chunk.t, tMax: chunk.t, retentionDays: 30,
  builtAt: new Date(now).toISOString(), writer: { name: 'external-store', version: '0' },
}

const payload = JSON.stringify([{
  kind: 'conclusion', epistemic: 'fact',
  title: '年轮应支持外部原话块',
  body: '', topicHint: '记忆系统', confidence: 0.9,
  quoteChunkId: chunk.id,
  quote: '年轮可以直接读用户自己切好的原话块',
}])
const stubLlm = {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const piece of [payload.slice(0, 12), payload.slice(12)]) {
      yield { type: 'text-delta', index: 0, text: piece }
    }
    yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 80 } }
    yield { type: 'finish', reason: 'stop' }
  },
}

const checks = []
const ok = (name, cond, detail) => { checks.push({ name, pass: Boolean(cond) }); console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` :: ${JSON.stringify(detail)}`}`) }

try {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(dir, 'chunks.jsonl'), JSON.stringify(chunk) + '\n')

  const r = await runYear({
    dataRoot, personaId: pid, llmHost: stubLlm, scope: 'all', confirm: true,
    budget: { maxInputChars: 24000, maxOutputTokens: 8000, timeoutMs: 90000, maxClaimsPerRun: 80 },
    pricing: { inputPerMTokens: 0.5, outputPerMTokens: 1.5 },
    config: { maxChunksPerRun: 12 },
  })
  ok('不装根藏也能读外部 store', r.ok === true, r.error || r.code)
  ok('年轮写出 1 条 claim', r.wrote?.claims === 1, r.wrote)

  const claims = (await readFile(join(dataRoot, 'year', pid, 'claims.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
  ok('claims.jsonl 有 1 行', claims.length === 1, claims.length)
  const claim = JSON.parse(claims[0])
  ok('claim 的锚点指向外部 chunk', claim?.derivedFrom?.[0]?.chunkId === chunk.id, claim?.derivedFrom)

  const runs = (await readFile(join(dataRoot, 'year', pid, 'runs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
  ok('runs.jsonl 有记录', runs.length >= 1, runs.length)
} catch (e) {
  ok('外部 store 冒烟未抛异常', false, String(e?.stack || e))
} finally {
  await rm(root, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.pass)
console.log(`\n═══ 外部 store → 年轮：${checks.length - failed.length}/${checks.length} 通过 ═══`)
if (failed.length) process.exitCode = 1
