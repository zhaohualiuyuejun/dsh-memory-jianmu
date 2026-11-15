/**
 * tools/storage-smoke.mjs —— 存储面板 / 源会话孤儿 / 快照 冒烟（Stage 0）
 * 在临时目录里造数据根 + 假会话，验证：
 *   1) 各层体积统计
 *   2) sourceGone 只统计、不写任何东西
 *   3) 快照写入后，增长口径从「估算」切换为「快照」
 *   4) GET 报告不写盘（调用前后 dataRoot mtime 不变 —— 用文件清单代替）
 */
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'

const tmp = await mkdtemp(join(tmpdir(), 'jianmu-storage-'))
const home = join(tmp, 'dshhome')
process.env.DSH_HOME = home
const dataRoot = join(home, 'memory-jianmu')

// 造根藏
const scope = join(dataRoot, 'scopes', 'alice')
await mkdir(scope, { recursive: true })
await writeFile(join(scope, 'manifest.json'), JSON.stringify({ personaId: 'alice', chunks: 2, dim: 8 }))
await writeFile(join(scope, 'chunks.jsonl'), [
  JSON.stringify({ id: 'c1', session: 's-alive', text: '还在的会话' }),
  JSON.stringify({ id: 'c2', session: 's-gone', text: '源会话已被删' }),
].join('\n') + '\n')
await writeFile(join(scope, 'index_meta.json'), JSON.stringify({ count: 2, dim: 8, vectorFile: 'vectors_v1.f32' }))
await writeFile(join(scope, 'vectors_v1.f32'), Buffer.alloc(2 * 8 * 4))

// 造假会话：s-alive 存在，s-gone 不存在
const sess = join(home, 'sessions', 'wsA', 's-alive')
await mkdir(sess, { recursive: true })
await writeFile(join(sess, 'session.v4.jsonl.zstd'), Buffer.alloc(4096))

// 造其他层
for (const [p, n] of [['process/alice', 3], ['year/alice', 5], ['persona/cards', 7], ['_backup/archive', 9], ['_dryrun', 11]]) {
  await mkdir(join(dataRoot, p), { recursive: true })
  await writeFile(join(dataRoot, p, 'x.bin'), Buffer.alloc(n * 1024))
}

const { storageReport, recordStorageSnapshot } = await import('../lib/storage.mjs')

const listTree = async (dir) => {
  const out = []
  const walk = async (d, rel = '') => {
    let ents = []
    try { ents = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const p = join(d, e.name)
      if (e.isDirectory()) { out.push(r + '/'); await walk(p, r) }
      else { const s = await stat(p); out.push(`${r}:${s.size}:${s.mtimeMs}`) }
    }
  }
  await walk(dir)
  return out.sort()
}

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`) } catch (e) { fail++; console.log(`❌ ${name}`); console.log('   ' + String(e?.stack || e).split('\n').slice(0, 5).join('\n   ')) }
}

await t('各层体积统计（scopes/process/year/persona/_backup/_dryrun）', async () => {
  const r = await storageReport({ dataRoot })
  assert.equal(r.ok, true)
  assert.ok(r.layers.scopes.bytes > 0, 'scopes')
  assert.ok(r.layers.process.bytes > 0, 'process')
  assert.ok(r.layers.year.bytes > 0, 'year')
  assert.ok(r.layers.persona.bytes > 0, 'persona')
  assert.ok(r.layers._backup.bytes > 0, '_backup')
  assert.ok(r.layers._dryrun.bytes > 0, '_dryrun')
  assert.equal(r.scopes.alice.chunks, 2)
  assert.ok(r.total.bytes >= r.layers.scopes.bytes)
  assert.ok(r.disk && r.disk.freeBytes > 0, 'disk statfs 可用')
})

await t('sourceGone：只统计不删、样本带 chunkId', async () => {
  const before = await listTree(dataRoot)
  const r = await storageReport({ dataRoot })
  const after = await listTree(dataRoot)
  assert.equal(r.sourceGone.goneChunks, 1)
  assert.equal(r.sourceGone.byPersona.alice, 1)
  assert.equal(r.sourceGone.sample[0].chunkId, 'c2')
  assert.deepEqual(after, before, 'GET 报告不得写盘/改文件')
})

await t('快照：写入 history，第二次快照后增长口径切到 snapshot', async () => {
  const t0 = Date.now() - 3 * 86400000
  const s1 = await recordStorageSnapshot({ dataRoot, now: t0 })
  assert.equal(s1.ok, true)
  assert.equal(s1.snapshot.totalBytes > 0, true)
  // 增长 1MB 后再拍
  await writeFile(join(dataRoot, 'process', 'alice', 'grow.bin'), Buffer.alloc(1024 * 1024))
  const s2 = await recordStorageSnapshot({ dataRoot, now: Date.now() })
  assert.equal(s2.ok, true)
  const r = await storageReport({ dataRoot, now: Date.now() + 1000 })
  assert.equal(r.growth.basis, 'snapshot', JSON.stringify(r.growth))
  assert.ok(r.growth.points >= 2)
  assert.ok(r.growth.dailyBytes > 0)
  assert.ok(r.growth.daysToExhaust > 0)
})

await t('没有快照时：估算口径明确标注，不冒充实测', async () => {
  // 换一个没有会话的 DSH_HOME，源增长 = 0 → 不得瞎预测
  const home2 = join(tmp, 'home2')
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home2
  try {
    const d2 = join(home2, 'memory-jianmu')
    await mkdir(join(d2, 'scopes'), { recursive: true })
    const r = await storageReport({ dataRoot: d2 })
    assert.equal(r.growth.basis, 'session-mtime')
    assert.equal(r.growth.points, 0)
    assert.equal(r.growth.dailyBytes, 0)
    assert.equal(r.growth.daysToExhaust, null, '增长为 0 时不得瞎预测')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) process.exitCode = 1
