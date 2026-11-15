#!/usr/bin/env node
/**
 * tools/external-store-smoke.mjs —— 验证「不装根藏，只给外部 chunk store」也能跑熏习
 *
 * 零网络、零费用；临时目录；跑完删除。
 * 用法：node tools/external-store-smoke.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../lib/run.mjs'

const root = await mkdtemp(join(tmpdir(), 'jianmu-process-external-'))
const dataRoot = join(root, 'data')
const pid = 'testpersona'
const dir = join(dataRoot, 'scopes', pid)
const now = Date.now()
const text = '外部数据源测试：熏习可以直接读用户自己切好的原话块。'
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

const checks = []
const ok = (name, cond, detail) => { checks.push({ name, pass: Boolean(cond) }); console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ` :: ${JSON.stringify(detail)}`}`) }

try {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(dir, 'chunks.jsonl'), JSON.stringify(chunk) + '\n')

  const r = await runProcess({ dataRoot, personaId: pid, maxChunks: 100 })
  ok('不装根藏也能读外部 store', r.ok === true, r.error || r.code)
  ok('runProcess 处理了 1 块', r.rootChunks === 1 || r.batch?.count === 1, r)

  const pm = JSON.parse(await readFile(join(dataRoot, 'process', pid, 'manifest.json'), 'utf8'))
  ok('process/manifest.json 已写出', Boolean(pm?.personaId === pid), pm)
  ok('process 计数 = 1', pm?.counts?.chunks === 1, pm?.counts)
} catch (e) {
  ok('外部 store 冒烟未抛异常', false, String(e?.stack || e))
} finally {
  await rm(root, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.pass)
console.log(`\n═══ 外部 store → 熏习：${checks.length - failed.length}/${checks.length} 通过 ═══`)
if (failed.length) process.exitCode = 1
