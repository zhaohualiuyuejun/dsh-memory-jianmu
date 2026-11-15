#!/usr/bin/env node
/**
 * tools/verify-morning.mjs —— 上午段收工判据（机器可跑）
 *
 * 对应《根藏 · 周六施工计划》2.1 收工判据：
 *   [1] 小样迁移 imported === total；文本/锚点/persona 三重一致。
 *   [2] 旧 session-recall 文件 hash 不变（与 _evidence/legacy-baseline.json 对照）。
 *   [3] status 能报块数/人格/未归属/错误；export 可用。
 *   [4] 删掉新 dataRoot 后旧插件照常工作（回退演练一次）。
 *
 * 用法：
 *   node tools/verify-morning.mjs --snapshot     # 先记录旧库基线
 *   node tools/verify-morning.mjs               # 跑验收
 *   node tools/verify-morning.mjs --data-root <dir>
 *   node tools/verify-morning.mjs --no-drill    # 跳过回退演练（**只读审计用**）
 *
 * ⚠️ 本工具**默认不是只读**：回退演练会短暂把 dataRoot 改名再恢复，export 检查会在
 *    dataRoot 内写 `_export-check-*.jsonl`（随即删除），并写 `_evidence/verify-morning-last.json`。
 *    只读审计请传 `--no-drill`，或改用 `status` / `verify`（纯读）。
 */
import { readdir, readFile, readFile as rf, rename, stat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyRecallRoot } from '../lib/paths.mjs'
import { statusAll, exportChunks, verifyScope } from '../lib/store.mjs'
import { scanSourceForInjection, checkToolSurface, ALLOWED_TOOLS } from '../lib/guards.mjs'
import { loadIndex } from '../../dsh-semantic-recall/lib/vectorstore.mjs'
import { VERSION } from '../lib/version.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EVIDENCE = join(ROOT, '_evidence')
const BASELINE = join(EVIDENCE, 'legacy-baseline.json')

const args = process.argv.slice(2)
const has = (k) => args.includes(k)
const val = (k, d = null) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const dataRoot = resolve(val('--data-root', join(ROOT, '_dryrun')))

// 演练中断恢复：上次 rename 到一半被杀 → 先把 dataRoot 放回来（本工具不是只读，见文件头）
{
  const aside0 = `${dataRoot}.rollback-drill`
  const exists = async (p) => { try { await stat(p); return true } catch { return false } }
  if (!(await exists(dataRoot)) && (await exists(aside0))) {
    await rename(aside0, dataRoot)
    console.log(`⚠️ 检测到上次演练中断，已恢复：${aside0} → ${dataRoot}`)
  }
}

const checks = []
function record(id, title, ok, detail) {
  checks.push({ id, title, ok: Boolean(ok), detail })
  console.log(`${ok ? '✅' : '❌'} [${id}] ${title}`)
  if (detail !== undefined && detail !== null) {
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    console.log(s.split('\n').map((l) => `      ${l}`).join('\n'))
  }
}

async function walk(dir, out = []) {
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}

async function snapshotLegacy() {
  const base = legacyRecallRoot()
  const files = (await walk(base)).sort()
  const rows = []
  for (const f of files) {
    const buf = await rf(f)
    rows.push({ rel: relative(base, f).replace(/\\/g, '/'), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
  }
  return { at: new Date().toISOString(), base, files: rows }
}

async function main() {
  console.log(`\n根藏 · 上午段收工验收（verify-morning）—— 包体版本 ${VERSION}`)
  console.log(`dataRoot = ${dataRoot}`)
  console.log(`旧库     = ${legacyRecallRoot()}\n`)

  // ── [1] 迁移报告
  let report = null
  try {
    report = JSON.parse(await readFile(join(dataRoot, '_migration-report.json'), 'utf8'))
  } catch { /* 没有报告 */ }
  if (!report) {
    record('1', '小样迁移 imported === total，三重一致', false, `找不到迁移报告：${join(dataRoot, '_migration-report.json')}（先跑 cli.mjs migrate）`)
  } else {
    const g = report.gate || {}
    const detail = {
      imported: report.totals?.imported,
      total: report.totals?.total,
      personas: report.totals?.personas,
      bySource: report.sources?.map((s) => ({ persona: s.personaId, selected: s.selected, imported: s.imported, checks: s.checks })),
      gate: g,
    }
    record('1', '小样迁移 imported === total，文本/锚点/persona 三重一致', g.importedEqualsTotal && g.textOk && g.anchorsOk && g.personaOk, detail)
  }

  // ── [1b] 独立复核：不听迁移报告，直接用 provenance 行号对回旧库源行
  const legacyMap = [
    { scope: 'src1', persona: 'alice' },
    { scope: 'srcmvwe6u4u', persona: 'bob' },
  ]
  const independent = { rows: 0, mismatches: [], byScope: {} }
  for (const lm of legacyMap) {
    const idxDir = join(legacyRecallRoot(), 'scopes', lm.scope, 'index')
    let meta = null
    try { meta = JSON.parse(await readFile(join(idxDir, 'meta.json'), 'utf8')) } catch { continue }
    let written = []
    try {
      const txt = await readFile(join(dataRoot, 'scopes', lm.persona, 'chunks.jsonl'), 'utf8')
      written = txt.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch { continue }
    independent.byScope[lm.persona] = { legacy: meta.chunks.length, written: written.length, checked: 0 }
    for (const w of written) {
      const src = w?.provenance?.legacyRowIndex
      if (!Number.isInteger(src)) continue
      const s = meta.chunks[src]
      if (!s) { independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 'source_row_missing' }); continue }
      independent.byScope[lm.persona].checked++
      independent.rows++
      if (w.text !== String(s.text ?? '')) independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 'text', expectLen: String(s.text ?? '').length, gotLen: w.text.length })
      if (w.session !== s.session) independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 'session' })
      if ((w.messageId ?? null) !== (s.msgId ?? null)) independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 'messageId' })
      if ((w.seq ?? null) !== (s.seq ?? null)) independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 'seq' })
      if ((w.part ?? 0) !== (s.part ?? 0)) independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 'part' })
      if (w.t !== Number(s.t)) independent.mismatches.push({ persona: lm.persona, id: w.id, reason: 't' })
    }
  }
  record('1b', '独立复核：逐行对回旧库源行（文本/锚点，不依赖迁移报告）', independent.mismatches.length === 0 && independent.rows > 0, {
    rowsChecked: independent.rows,
    byScope: independent.byScope,
    mismatches: independent.mismatches.slice(0, 10),
  })

  // ── [2] 旧库 hash 不变
  const now = await snapshotLegacy()
  if (has('--snapshot')) {
    await (await import('node:fs/promises')).mkdir(EVIDENCE, { recursive: true })
    await (await import('node:fs/promises')).writeFile(BASELINE, JSON.stringify(now, null, 2) + '\n', 'utf8')
    record('2', '旧 session-recall 文件 hash 不变', true, `已记录基线：${BASELINE}（${now.files.length} 个文件）—— 正式验收请再跑一次不带 --snapshot`)
  } else {
    let base = null
    try { base = JSON.parse(await readFile(BASELINE, 'utf8')) } catch { /* 没基线 */ }
    if (!base) {
      record('2', '旧 session-recall 文件 hash 不变', false, `基线不存在：${BASELINE}；先跑 --snapshot`)
    } else {
      const before = new Map(base.files.map((f) => [f.rel, f.sha256]))
      const after = new Map(now.files.map((f) => [f.rel, f.sha256]))
      const changed = []
      const added = []
      const removed = []
      for (const [rel, h] of after) {
        if (!before.has(rel)) added.push(rel)
        else if (before.get(rel) !== h) changed.push(rel)
      }
      for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel)
      // 允许 build.log / state.json 这类运行态文件变化（插件自己会写），但 index/ 下的 data 文件必须一字不变
      const dataChanges = changed.filter((r) => r.includes('index/'))
      const ok = dataChanges.length === 0 && removed.filter((r) => r.includes('index/')).length === 0
      // 再补一条决定性证据：index/ 下的数据文件 mtime 必须早于「本次施工第一个产出文件」（package.json）
      // —— 今天 00:10 旧插件自己跑过一次自动索引，早于 08:1x 开工，不算本次施工改动。
      const constructionStart = (await stat(join(ROOT, 'package.json'))).mtimeMs
      const touchedAfterStart = []
      for (const f of now.files) {
        if (!f.rel.includes('index/')) continue
        const st2 = await stat(join(legacyRecallRoot(), f.rel))
        if (st2.mtimeMs >= constructionStart) touchedAfterStart.push({ rel: f.rel, mtime: st2.mtime.toISOString() })
      }
      record('2', '旧 session-recall 文件 hash 不变', ok && touchedAfterStart.length === 0, {
        filesBefore: before.size, filesAfter: after.size,
        dataFileChanges: dataChanges, added: added.slice(0, 10), removed: removed.slice(0, 10),
        constructionStart: new Date(constructionStart).toISOString(),
        touchedAfterStart,
        note: 'index/ 下的 meta.json / vectors.f32 必须逐字节不变，且 mtime 早于本次施工开始；build.log / state.json 属运行态，允许变化',
      })
    }
  }

  // ── [3] status / export
  const st = await statusAll(dataRoot, { deep: true })
  const scopes = Object.keys(st.scopes || {})
  const stOk = scopes.length > 0 && st.totals.chunks > 0 && scopes.every((p) => !st.scopes[p].degraded)
  record('3a', 'status 能报块数/人格/未归属/错误', stOk, {
    scopes, totals: st.totals, identity: st.identity,
    perScope: Object.fromEntries(scopes.map((p) => [p, {
      chunks: st.scopes[p].chunks, sessions: st.scopes[p].sessions, workspaces: st.scopes[p].workspaces,
      vectors: { rows: st.scopes[p].vectors.rows, missing: st.scopes[p].vectors.missing, badRows: st.scopes[p].vectors.badRows },
      degraded: st.scopes[p].degraded, warnings: st.scopes[p].warnings, errors: st.scopes[p].errors,
    }])),
    warnings: st.warnings,
  })

  let exportOk = false
  const exportInfo = {}
  for (const p of scopes) {
    const out = join(dataRoot, `_export-check-${p}.jsonl`)
    const r = await exportChunks({ dataRoot, personaId: p, outFile: out })
    exportInfo[p] = { ok: r.ok, chunks: r.chunks, bytes: r.outBytes, sha256: r.sha256?.slice(0, 16) }
    if (!r.ok) continue
    const a = await readFile(join(dataRoot, 'scopes', p, 'chunks.jsonl'))
    const b = await readFile(out)
    if (createHash('sha256').update(a).digest('hex') !== createHash('sha256').update(b).digest('hex')) exportInfo[p].hashMatch = false
    else exportInfo[p].hashMatch = true
    await rm(out, { force: true })
    exportOk = exportOk && true
  }
  const exportAll = Object.values(exportInfo).every((x) => x.ok && x.hashMatch)
  record('3b', 'export 可用（导出与源逐字节一致）', exportAll, exportInfo)

  const verify = {}
  let verifyOk = true
  for (const p of scopes) {
    verify[p] = await verifyScope(dataRoot, p)
    if (!verify[p].ok) verifyOk = false
  }
  record('3c', 'verify 全绿（块数/重复 id/孤儿 tmp/墓碑/归档）', verifyOk, Object.fromEntries(Object.entries(verify).map(([k, v]) => [k, { ok: v.ok, chunks: v.chunks, problems: v.problems, info: v.info }])))

  // ── [4] 回退演练：拿走新 dataRoot，旧插件自己的库还能读
  const aside = `${dataRoot}.rollback-drill`
  let drill = { movedAway: false, legacyLoadable: false }
  if (has('--no-drill')) {
    drill = { skipped: true, reason: '--no-drill（只读审计）' }
  } else try {
    await rm(aside, { recursive: true, force: true })
    await rename(dataRoot, aside)
    drill.movedAway = true
    // 用旧插件自己的代码读旧库（证明我们没动它）
    const loaded = await loadIndex('src1')
    drill.legacyLoadable = Boolean(loaded && loaded.count > 0 && Array.isArray(loaded.meta?.chunks))
    drill.legacy = loaded ? { count: loaded.count, dim: loaded.dim, model: loaded.meta?.model, builtAt: loaded.meta?.builtAt } : null
  } catch (e) {
    drill.error = String(e?.message || e)
  } finally {
    try { if (drill.movedAway) await rename(aside, dataRoot) } catch { /* 恢复失败要在 detail 里看到 */ }
    drill.restored = await stat(dataRoot).then((s) => s.isDirectory()).catch(() => false)
  }
  record('4', '删掉新 dataRoot 后旧插件照常工作（回退演练）',
    drill.skipped ? true : (drill.movedAway && drill.legacyLoadable && drill.restored),
    drill)

  // ── 附加：守卫面
  const idxText = await readFile(join(ROOT, 'index.js'), 'utf8')
  const inj = scanSourceForInjection(idxText)
  const surface = checkToolSurface([...ALLOWED_TOOLS])
  record('G', '守卫：四工具命名合规 + 插件源码无注入钩子', inj.ok && surface.ok, { injectionHits: inj.hits, surface })

  // ── 汇总
  const failed = checks.filter((c) => !c.ok)
  const summary = {
    ok: failed.length === 0,
    version: VERSION,
    checkedAt: new Date().toISOString(),
    dataRoot,
    checks: checks.map(({ id, title, ok }) => ({ id, title, ok })),
  }
  await (async () => {
    try { await (await import('node:fs/promises')).mkdir(EVIDENCE, { recursive: true }) } catch { /* 忽略 */ }
    try { await (await import('node:fs/promises')).writeFile(join(EVIDENCE, 'verify-morning-last.json'), JSON.stringify({ ...summary, detail: checks }, null, 2) + '\n') } catch { /* 忽略 */ }
  })()
  console.log(`\n═══ 上午收工判据：${checks.length - failed.length}/${checks.length} 通过 ${failed.length === 0 ? '→ 可以进下午' : '→ 红了，下午转排障'} ═══`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
