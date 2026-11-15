#!/usr/bin/env node
/**
 * verify-0.4.0 —— 今天新增的三块能力（熏习去重 / bge 重排 / 年轮 claim）的随包自检。
 * 全部离线/无网络（重排用「无 Key」路径验证降级；claims 用空数据验证回退）。
 *
 * 用法：node tools/verify-0.4.0.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadHygiene, applyHygieneOrder, dupIndexFor } from '../lib/hygiene.mjs'
import { rerankOrder, regroupByFlat } from '../lib/rerank.mjs'
import { loadClaims, applyClaimRecall } from '../lib/claims.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-verify-040-'))
const writeJsonl = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }

// ── ① 熏习：空策略 + stale/dup/conflict ─────────────────────────
console.log('① 熏习（hygiene）')
{
  const chunks = [
    { chunkId: 'c1', t: 100 }, { chunkId: 'c2', t: 200 }, { chunkId: 'c3', t: 300 },
    { chunkId: 'c4', t: 400 }, { chunkId: 'c5', t: 500 },
  ]
  const mk = () => ({
    available: true, state: new Map([
      ['c1', { status: 'active', conflictGroup: null }],
      ['c2', { status: 'active', conflictGroup: 'gX' }],
      ['c3', { status: 'superseded', conflictGroup: null }],
      ['c4', { status: 'active', conflictGroup: null }],
      ['c5', { status: 'active', conflictGroup: null }],
    ]),
    groups: [{ groupId: 'g1', chunkIds: ['c1', 'c4'], status: 'pending' }],
    counts: { state: 5, groups: 1, stale: 1, conflicted: 1 },
    _idxCache: new WeakMap(), _repCache: new WeakMap(),
  })
  const h = mk()
  const d = dupIndexFor(h, chunks)
  ok('代表块=组内最晚（c4）', d.repOf.get('g1') === 'c4')
  const a = applyHygieneOrder([0, 3], chunks, h, {})
  ok('同组只留一条', a.order.length === 1 && a.stats.dupDropped === 1)
  const b = applyHygieneOrder([2, 0, 1], chunks, h, { staleFilter: true })
  ok('stale 过滤', !b.order.includes(2) && b.stats.staleDropped === 1)
  const c = applyHygieneOrder([1, 0], chunks, h, { conflictWeight: 0.8 })
  ok('conflict 降尾', c.order[c.order.length - 1] === 1)
  const empty = loadHygiene(path.join(TMP, 'nope'), 'nobody')
  ok('缺数据回退空策略', empty.available === false)
  const e2 = applyHygieneOrder([0, 1], chunks, empty, {})
  ok('空策略不改顺序', JSON.stringify(e2.order) === '[0,1]')
}

// ── ② 重排：无 Key 必须降级且顺序不变 ──────────────────────────
console.log('② 重排（rerank）')
{
  const chunks = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
  const rr = await rerankOrder({ query: 'q', flat: [2, 0, 1], chunks, model: 'x', topN: 50, chars: 600, apiKey: '' })
  ok('无 Key → degraded=no-key', rr.degraded === 'no-key')
  ok('无 Key → 顺序原样', JSON.stringify(rr.order) === '[2,0,1]')
  const rr2 = await rerankOrder({ query: 'q', flat: [], chunks, model: 'x', apiKey: 'sk-x' })
  ok('空候选不报错', Array.isArray(rr2.order) && rr2.order.length === 0)
  const grouped = regroupByFlat({ grouped: [{ session: 's1', ws: 'w', wsPretty: 'W', items: [0, 1], score: 0.5, rawScore: 0.5, lexScore: 0 }] }, chunks, [1, 0], new Map([[1, 0.9], [0, 0.1]]))
  ok('按重排重建会话视图', grouped.length === 1 && grouped[0].items[0] === 1 && grouped[0].score === 0.9)
}

// ── ③ 年轮：缺数据回退；RRF 生效 ───────────────────────────────
console.log('③ 年轮（claims）')
{
  const missing = loadClaims(path.join(TMP, 'nope'), 'nobody')
  ok('缺 year/ 回退', missing.available === false)
  const claims = [
    { claimId: 'k1', title: 't1', body: 'b1', anchors: ['c1'] },
    { claimId: 'k2', title: 't2', body: 'b2', anchors: ['c2'] },
  ]
  const dim = 4
  const vecs = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0])
  const chunks = [{ chunkId: 'c1' }, { chunkId: 'c2' }, { chunkId: 'c3' }]
  const idIndex = new Map([['c1', 0], ['c2', 1], ['c3', 2]])
  const loaded = { vecs: new Float32Array([0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0]), dim, count: 3 }
  const ap = applyClaimRecall({ order: [2, 1, 0], queryVec: new Float32Array([1, 0, 0, 0]), loaded, claims, claimVecs: { vecs, dim }, idIndex, expand: 2, bridgeK: 0 })
  ok('锚点展开进入候选', ap.stats.expanded >= 1 && ap.order[0] === 0, JSON.stringify(ap.order))
  const none = applyClaimRecall({ order: [2], queryVec: new Float32Array([1, 0, 0, 0]), loaded, claims: [], claimVecs: null, idIndex })
  ok('无 claim 时原样返回', JSON.stringify(none.order) === '[2]')
}

// ── ④ 包完整性：新 lib 在 files 里、默认全关 ────────────────────
console.log('④ 包完整性')
{
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const files = pkg.files || []
  for (const f of ['lib', 'index.js', 'client.js']) ok(`files 含 ${f}`, files.includes(f))
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  for (const k of ['hygiene', 'hybrid', 'rerank', 'claims']) {
    ok(`配置键 ${k} 存在`, new RegExp(`${k}: z\\.`).test(src))
  }
  ok('默认 hygiene=off', /hygiene: z\.string\(\)\.default\('off'\)/.test(src))
  ok('默认 hybrid=false', /hybrid: z\.boolean\(\)\.default\(false\)/.test(src))
  ok('默认 rerank=false', /rerank: z\.boolean\(\)\.default\(false\)/.test(src))
  ok('默认 claims=false', /claims: z\.boolean\(\)\.default\(false\)/.test(src))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
