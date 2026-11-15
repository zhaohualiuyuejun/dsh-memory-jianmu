#!/usr/bin/env node
/**
 * tools/compact-claims.mjs —— claims.jsonl 压缩（同 claimId 多行 → 一行 latest-wins）
 *
 * 为什么需要：元数据回填（如 speaker）按 append-only 追加同 claimId 的新行（latest-wins 读侧正确），
 * 但文件只增不减；按行读的消费者（如寻枝 claim 召回）会重复计数。本工具把历史行压成当前值。
 *
 * 纪律：
 *   · 默认 dry-run，--apply 才写
 *   · 写前：坏行/撕裂尾巴 → 拒绝（压缩不能吞掉半行）
 *   · 写前：备份 claims.jsonl → _archive/compact-claims-<ts>/claims-mirror.jsonl
 *   · 拿年轮单写者锁；原子写（tmp→rename）
 *   · 写后读回：唯一数、id 集合、每条内容逐条比对；不通过就报错（旧文件仍在备份里）
 *
 * 语义：
 *   · 保留**首次出现位置**（与 readClaims.byId 的 Map 迭代顺序一致），内容取**最后一次出现**的那行
 *   · 不碰 manifest / runs / topic_docs；计数由下次 rebuild 自然对齐
 *
 * 用法：
 *   node tools/compact-claims.mjs --persona alice           # 预览
 *   node tools/compact-claims.mjs --persona alice --apply
 *   node tools/compact-claims.mjs --all --apply --json
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaims } from '../lib/store.mjs'
import { defaultDataRoot, yearDir, yearFile, archiveDir, assertYearWrite, tsSlugMs } from '../lib/paths.mjs'
import { copyFileIfExists, atomicWrite } from '../lib/fsatomic.mjs'
import { acquireLock } from '../lib/lock.mjs'
import { toErrInfo } from '../lib/errors.mjs'

function parseArgs(argv) {
  const out = { persona: null, all: false, apply: false, json: false, dataRoot: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--persona' || a === '-p') out.persona = String(argv[++i] || '')
    else if (a === '--all') out.all = true
    else if (a === '--apply') out.apply = true
    else if (a === '--dry-run') out.apply = false
    else if (a === '--json') out.json = true
    else if (a === '--data-root') out.dataRoot = String(argv[++i] || '')
    else if (a === '--help' || a === '-h') out.help = true
    else if (!a.startsWith('-')) out.persona = a
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const HELP = `年轮 · claims.jsonl 压缩（latest-wins）
用法：node tools/compact-claims.mjs --persona <id>|--all [--apply] [--json] [--data-root PATH]
默认 dry-run；--apply 先备份再原子重写。`

async function listPersonas(dataRoot) {
  try {
    const ents = await readdir(join(dataRoot, 'year'), { withFileTypes: true })
    return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_')).map((d) => d.name).sort()
  } catch { return [] }
}

/** 算压缩后的行（保留首次出现位置，内容取最后一次出现） */
function buildCompacted(rows) {
  const order = []          // claimId 首次出现顺序
  const latest = new Map()  // claimId -> 最后一次出现的 row
  for (const row of rows) {
    const id = row.claimId
    if (!latest.has(id)) order.push(id)
    latest.set(id, row)
  }
  return order.map((id) => latest.get(id))
}

async function planPersona({ dataRoot, personaId }) {
  const claims = await readClaims(dataRoot, personaId)
  if (claims.corrupt?.length) {
    return { ok: false, personaId, code: 'CORRUPT_ROWS', error: { code: 'CORRUPT_ROWS', message: `claims.jsonl 有 ${claims.corrupt.length} 个坏行：压缩会丢数据，先修坏行` } }
  }
  if (claims.tornTail) {
    return { ok: false, personaId, code: 'TORN_TAIL', error: { code: 'TORN_TAIL', message: 'claims.jsonl 末尾有撕裂行：压缩会丢半行，先修' } }
  }
  const compacted = buildCompacted(claims.rows)
  const dupRows = claims.rows.length - compacted.length
  const bytesBefore = claims.bytes
  const text = compacted.map((r) => JSON.stringify(r)).join('\n') + (compacted.length ? '\n' : '')
  return {
    ok: true,
    personaId,
    rowsBefore: claims.rows.length,
    unique: compacted.length,
    dupRows,
    bytesBefore,
    bytesAfter: Buffer.byteLength(text, 'utf8'),
    text,
    compacted,
  }
}

async function applyPersona({ dataRoot, personaId, plan }) {
  if (!plan.dupRows) return { ok: true, personaId, written: false, note: '没有重复行，跳过' }
  const lock = await acquireLock(yearDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, personaId, code: lock.code, error: lock.error }
  try {
    const tag = `compact-claims-${tsSlugMs()}`
    const snapDir = archiveDir(dataRoot, personaId, tag)
    assertYearWrite(dataRoot, personaId, join(snapDir, 'claims-mirror.jsonl'))
    const snap = await copyFileIfExists(yearFile(dataRoot, personaId, 'claims'), snapDir, 'claims-mirror.jsonl')
    if (!snap.ok) {
      return { ok: false, personaId, code: 'SNAPSHOT_FAILED', error: { code: 'SNAPSHOT_FAILED', message: `备份失败（${snap.reason}）：不写` } }
    }
    await atomicWrite(yearFile(dataRoot, personaId, 'claims'), plan.text)

    // 读回校验：唯一数 / id 集合 / 每条 JSON 逐字比对
    const back = await readClaims(dataRoot, personaId)
    const missing = []
    const changed = []
    for (const c of plan.compacted) {
      const got = back.byId.get(c.claimId)
      if (!got) missing.push(c.claimId)
      else if (JSON.stringify(got) !== JSON.stringify(c)) changed.push(c.claimId)
    }
    const extra = back.unique - plan.compacted.length
    if (missing.length || changed.length || extra !== 0) {
      return {
        ok: false, personaId,
        code: 'READBACK_MISMATCH',
        error: { code: 'READBACK_MISMATCH', message: `读回不一致：缺 ${missing.length} / 变 ${changed.length} / 多 ${extra}（备份在 ${snap.dest}，可回滚）` },
        snapshot: snap.dest,
      }
    }
    return {
      ok: true, personaId, written: true,
      rowsBefore: plan.rowsBefore, rowsAfter: back.rows.length, unique: back.unique,
      bytesBefore: plan.bytesBefore, bytesAfter: back.bytes,
      snapshot: snap.dest,
      duplicated: back.rows.length - back.unique,
    }
  } catch (e) {
    return { ok: false, personaId, code: e?.code || 'APPLY_FAILED', error: toErrInfo(e) }
  } finally {
    await lock.release().catch(() => {})
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return 0 }
  const dataRoot = args.dataRoot || defaultDataRoot()
  const targets = args.all || args.persona === 'all'
    ? await listPersonas(dataRoot)
    : (args.persona ? [args.persona] : [])
  if (!targets.length) {
    console.error(`没有目标人格。请给 --persona <id> 或 --all（dataRoot=${dataRoot}）`)
    return 2
  }
  const report = { tool: 'compact-claims', mode: args.apply ? 'apply' : 'dry-run', dataRoot, at: new Date().toISOString(), personas: [] }
  let failed = 0
  for (const pid of targets) {
    const plan = await planPersona({ dataRoot, personaId: pid })
    if (!plan.ok) { failed += 1; report.personas.push(plan); continue }
    const applied = args.apply ? await applyPersona({ dataRoot, personaId: pid, plan }) : null
    if (args.apply && !applied.ok) failed += 1
    report.personas.push({
      personaId: pid, rowsBefore: plan.rowsBefore, unique: plan.unique, dupRows: plan.dupRows,
      bytesBefore: plan.bytesBefore, bytesAfter: plan.bytesAfter,
      applied: applied ? { ok: applied.ok, written: applied.written, rowsAfter: applied.rowsAfter, unique: applied.unique, bytesAfter: applied.bytesAfter, duplicated: applied.duplicated, snapshot: applied.snapshot, code: applied.code, error: applied.error, note: applied.note } : undefined,
    })
  }
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`年轮 · claims 压缩 · ${report.mode} · ${dataRoot}`)
    for (const p of report.personas) {
      if (p.error) { console.log(`❌ ${p.personaId}: ${p.code} ${p.error.message}`); continue }
      const kb = (n) => `${(n / 1024).toFixed(1)}KB`
      console.log(`\n✅ ${p.personaId}: ${p.rowsBefore} 行 → ${p.unique} 行（重复 ${p.dupRows}） | ${kb(p.bytesBefore)} → ${kb(p.bytesAfter)}`)
      if (p.applied) {
        console.log(p.applied.ok
          ? `   ✔ 已重写；读回校验通过；快照 ${p.applied.snapshot}`
          : `   ✖ ${p.applied.code}: ${p.applied.error?.message || ''}`)
      }
    }
    if (!args.apply) console.log('\n这是 dry-run，未写盘。确认后加 --apply。')
  }
  return failed ? 1 : 0
}

const code = await main().catch((e) => { console.error(`❌ ${e?.message || e}`); return 1 })
process.exit(code)
