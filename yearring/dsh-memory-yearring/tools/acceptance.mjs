#!/usr/bin/env node
/**
 * tools/acceptance.mjs —— 年轮验收（真实数据，只读 + dryRun；不调模型、不装插件、不重启）
 *
 * 验收项（对应施工计划 §8.1 的可在「不重启」前提下验证的部分）：
 *   1. 包骨架完整（package.json / cordis.patch.yml / index.js 导出）
 *   2. 工具面正好 7 个、命名合规
 *   3. 真实根藏可读（persona 由 identity 解析）
 *   4. 真实 dataRoot 上 dryRun 能算出预估（0 次模型调用）
 *   5. verify 在空/已有数据上都 ok
 *   6. 写闸门：真实路径上拒绝写 scopes/process/persona/soul-md
 *   7. 只读源前后 hash 不变（对照开工基线）
 *
 * 用法：
 *   node tools/acceptance.mjs [--persona alice] [--baseline <baseline.sha256>] [--json]
 */
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { ALLOWED_TOOLS } from '../lib/version.mjs'
import { checkToolSurface } from '../lib/guards.mjs'
import { defaultDataRoot, assertYearWrite, yearDir, scopeDir, isSafePersonaId } from '../lib/paths.mjs'
import { readIdentity, readScope, hashRootKeyFiles } from '../lib/root.mjs'
import { apiStatus, apiTopics, apiVerify } from '../lib/api.mjs'
import { runYear } from '../lib/extract.mjs'
import { readClaims, readRuns } from '../lib/store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')

const args = process.argv.slice(2)
const getArg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const asJson = args.includes('--json')
const personaArg = getArg('persona', null)
const baselinePath = getArg('baseline', null)

const dataRoot = getArg('dataRoot', defaultDataRoot())
const results = []
let failed = 0
const ok = (name, cond, detail) => {
  if (cond) results.push({ name, pass: true })
  else { failed += 1; results.push({ name, pass: false, detail }) }
  return Boolean(cond)
}
const notes = []

function sha256File(text) { return createHash('sha256').update(text).digest('hex') }

// ── 1. 包骨架 ─────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url)
let pkg = null
try { pkg = require(join(PKG_DIR, 'package.json')) } catch (e) { notes.push(`package.json 读不出：${e.message}`) }
ok('package.json 名称为 dsh-memory-yearring', pkg?.name === 'dsh-memory-yearring', pkg?.name)
ok('package.json 声明 dsh.bundle.patch', Boolean(pkg?.dsh?.bundle?.patch), pkg?.dsh)
ok('engines.dsh >=0.2.1-rc.5', String(pkg?.engines?.dsh || '').includes('0.2.1'), pkg?.engines)
const patchExists = await stat(join(PKG_DIR, 'cordis.patch.yml')).then((s) => s.isFile()).catch(() => false)
ok('cordis.patch.yml 存在', patchExists)
const patchText = patchExists ? await readFile(join(PKG_DIR, 'cordis.patch.yml'), 'utf8') : ''
ok('cordis.patch.yml 注册 memory-yearring', patchText.includes('dsh-memory-yearring'))
const indexText = await readFile(join(PKG_DIR, 'index.js'), 'utf8').catch(() => '')
ok('index.js 导出 name/Config/apply', /export const name/.test(indexText) && /export function apply/.test(indexText) || /export const Config/.test(indexText))
ok('index.js 无注入钩子（源码闸门）', !/ctx\.on\(\s*['"]prompt|appendSystem|injectPrompt/i.test(indexText))

// ── 2. 工具面 ─────────────────────────────────────────────────────────────
ok('工具面正好 7 个', ALLOWED_TOOLS.length === 7)
ok('工具面守卫通过', checkToolSurface([...ALLOWED_TOOLS]).ok)
ok('工具名全部 jianmu_year_ 前缀', ALLOWED_TOOLS.every((n) => n.startsWith('jianmu_year_')))

// ── 3. persona 解析 ───────────────────────────────────────────────────────
const idRes = await readIdentity(dataRoot)
ok('identity.json 可读', idRes.ok, idRes.error)
let personaId = personaArg
if (!personaId && idRes.ok) {
  const list = Object.keys(idRes.identity.personas || {})
  personaId = list.includes('alice') ? 'alice' : list[0]
}
ok('personaId 合法', Boolean(personaId) && isSafePersonaId(personaId), personaId)

// ── 4. 真实根藏可读 ───────────────────────────────────────────────────────
const root = personaId ? await readScope(dataRoot, personaId) : { ok: false }
ok('真实根藏可读', root.ok, root.error)
if (root.ok) {
  notes.push(`根藏：${root.chunks.length} 块 / ${root.stats?.sessions ?? '?'} 场 / builtAt=${root.manifest?.builtAt}`)
}

// ── 5. dryRun（0 次模型调用） ─────────────────────────────────────────────
let dry = null
if (personaId && root.ok) {
  dry = await runYear({
    dataRoot, personaId, llmHost: null, dryRun: true,
    budget: { maxInputChars: 24000, maxOutputTokens: 8000, timeoutMs: 90000, maxClaimsPerRun: 80 },
    pricing: { inputPerMTokens: 0.5, outputPerMTokens: 1.5 },
    config: { maxChunksPerRun: 400 },
    maxBatches: 1,
  })
  ok('dryRun 返回 ok', dry.ok === true, dry.error)
  ok('dryRun 真的没调模型（llmHost=null 也没炸）', dry.ok === true)
  ok('dryRun 选中了块（真实根藏不该是 0）', (dry.selected?.chunks ?? 0) > 0, dry.selected)
  if (dry.ok) {
    notes.push(`dryRun：选 ${dry.selected.chunks} 块 / ${dry.selected.chars} 字符 / 预估 ${dry.estimate.promptTokens}+${dry.estimate.outputTokens} token / ${dry.estimate.costYuan} 元`)
  }
}

// ── 6. 只读 API ───────────────────────────────────────────────────────────
if (personaId) {
  const st = await apiStatus({ dataRoot, personaId })
  ok('apiStatus ok', st.ok === true)
  ok('apiStatus 有 counts', Boolean(st.counts))
  const tp = await apiTopics({ dataRoot, personaId })
  ok('apiTopics ok', tp.ok === true)
  const ver = await apiVerify({ dataRoot, personaId })
  ok('apiVerify 必须 ok=true（不是「能跑」就算过）', ver.ok === true, ver.problems?.slice(0, 3) || ver.note || ver.error)
  notes.push(`verify：ok=${ver.ok} claims=${ver.summary?.claims ?? 0}，orphan=${ver.summary?.anchors?.orphan ?? 0}，problems=${ver.problems?.length ?? '?'}`)
}

// ── 7. 写闸门（真实路径，只做「拒绝」测试） ───────────────────────────────
if (personaId) {
  const denyCases = [
    ['scopes/', join(scopeDir(dataRoot, personaId), 'chunks.jsonl')],
    ['process/', join(dataRoot, 'process', personaId, 'state.jsonl')],
    ['persona/', join(dataRoot, 'persona', 'cards', personaId, 'card.md')],
    ['soul-md/', join(dataRoot, '..', 'soul-md', 'memory', 'x.md')],
    ['年轮外', join(dataRoot, 'identity.json')],
  ]
  for (const [label, target] of denyCases) {
    let denied = false
    try { assertYearWrite(dataRoot, personaId, target) } catch { denied = true }
    ok(`写闸门拒绝：${label}`, denied, target)
  }
  // 允许写自己目录
  let allowed = false
  try { allowed = assertYearWrite(dataRoot, personaId, join(yearDir(dataRoot, personaId), 'claims.jsonl')) === true } catch { allowed = false }
  ok('写闸门允许：year/<personaId>/', allowed)
}

// ── 8. 基线 hash 对照（只读源：严格组 + 允许自动增量的组） ────────────────
// 根藏/熏习有每小时自动摄取，hash 会变；soul-md / persona 是年轮绝不碰的，必须严格一致。
if (baselinePath) {
  const baseText = await readFile(baselinePath, 'utf8').catch(() => null)
  ok('基线文件可读', Boolean(baseText), baselinePath)
  if (baseText) {
    const expected = new Map()
    for (const line of baseText.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
      if (m) expected.set(m[2].replace(/\\/g, '/').toLowerCase(), m[1])
    }
    const isAutoGrowing = (f) => /memory-jianmu[\\/](scopes|process)[\\/]/i.test(f) || /[\\/]sessions[\\/]/i.test(f)
    let checked = 0
    const strictChanged = []
    const tolerantChanged = []
    const missing = []
    for (const [file, want] of expected) {
      const real = file.replace(/\//g, '\\')
      const text = await readFile(real).catch(() => null)
      if (!text) { missing.push(file); continue }
      checked += 1
      const got = sha256File(text)
      if (got === want) continue
      if (isAutoGrowing(file)) tolerantChanged.push({ file, want, got })
      else strictChanged.push({ file, want, got })
    }
    ok('基线：没有只读文件被删', missing.length === 0, missing.slice(0, 5))
    ok('基线：soul-md / persona 严格未变（年轮绝不写）', strictChanged.length === 0, strictChanged.slice(0, 5))
    if (tolerantChanged.length) {
      // 不判失败：根藏/熏习有自动摄取。但要把「涨了多少」摆出来，供人核对是不是纯增量
      notes.push(`⚠️ 根藏/熏习有 ${tolerantChanged.length} 个文件因自动摄取而变化（允许）：` +
        tolerantChanged.map((c) => c.file.split('/').slice(-2).join('/')).slice(0, 6).join('、'))
    } else {
      notes.push('根藏/熏习基线也完全未变')
    }
    notes.push(`基线对照：${checked} 个文件（严格 ${checked - tolerantChanged.length}，允许增量 ${tolerantChanged.length}）`)
  }
}

// ── 9. 既有年份数据健康 ───────────────────────────────────────────────────
if (personaId) {
  const claims = await readClaims(dataRoot, personaId)
  const runs = await readRuns(dataRoot, personaId, 5)
  notes.push(`年轮现状：claims=${claims.byId.size}，runs=${runs.total}`)
  ok('claims.jsonl 无坏行', claims.corrupt.length === 0, claims.corrupt.slice(0, 3))
}

// ── 输出 ──────────────────────────────────────────────────────────────────
const summary = {
  ok: failed === 0,
  passed: results.length - failed,
  failed,
  total: results.length,
  personaId,
  dataRoot,
  notes,
  results,
}
if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  ← ' + JSON.stringify(r.detail)}`)
  console.log('')
  for (const n of notes) console.log(`· ${n}`)
  console.log(`\n${summary.passed}/${summary.total} 通过${failed ? `，${failed} 失败` : ''}`)
}
process.exit(failed ? 1 : 0)
