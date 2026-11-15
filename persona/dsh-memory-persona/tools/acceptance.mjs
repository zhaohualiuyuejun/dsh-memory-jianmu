#!/usr/bin/env node
/**
 * tools/acceptance.mjs —— 镜台 v1a 真实副本验收（≥ 16 条）
 *
 * 用真实 profile 的 soul-md 配置 + 真实 identity.json，在**副本**上导入/保存/回滚；
 * 生产根藏、熏习、soul-md 记忆全程只读，验收前后 hash 必须一致。
 *
 * 用法：node tools/acceptance.mjs [--source <生产根藏>] [--work <副本目录>] [--keep]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') out.keep = true
    else if (a === '--source') out.source = argv[++i]
    else if (a === '--work') out.work = argv[++i]
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

const { defaultDataRoot, dshHome } = await import('../lib/paths.mjs')
const { readSoulMdConfigFromYaml, soulMdMemoryDir } = await import('../lib/soulmd.mjs')
const { ensurePersonaLayout, readGlobalManifest, readCard, readVersions, readRegistry } = await import('../lib/store.mjs')
const { importFromSoulMd, saveCard, rollbackCard, setDefaultCard } = await import('../lib/write.mjs')
const { apiStatus, apiCards, apiPreview, apiDiff, apiImportSources, apiSettings, deepCheck } = await import('../lib/api.mjs')
const { parseCard } = await import('../lib/card.mjs')

const SOURCE = args.source || defaultDataRoot()
const WORK = args.work || path.join('C:/work/alice/tmp', `persona-accept-${stamp}`)

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`) }
}
function section(t) { console.log(`\n── ${t}`) }

function hashFile(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}
function hashTree(dir) {
  const out = {}
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out[path.relative(dir, p)] = hashFile(p)
    }
  }
  walk(dir)
  return out
}
function sameTree(a, b) {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false
  return true
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true })

  // 生产只读基线
  const prodScopes = hashTree(path.join(SOURCE, 'scopes'))
  const prodProcess = hashTree(path.join(SOURCE, 'process'))
  const prodIdentity = hashFile(path.join(SOURCE, 'identity.json'))
  const soulMem = soulMdMemoryDir()
  const soulMemBefore = hashTree(soulMem)
  const personaBefore = fs.existsSync(path.join(SOURCE, 'persona')) ? hashTree(path.join(SOURCE, 'persona')) : null

  // 副本：只复制 identity.json
  fs.copyFileSync(path.join(SOURCE, 'identity.json'), path.join(WORK, 'identity.json'))

  section('0. 真实配置')
  const soul = await readSoulMdConfigFromYaml({ profile: 'desktop' })
  check('P0.1 soul-md 配置可读（真实 profile）', soul.ok === true, soul.error)
  if (!soul.ok) throw new Error('soul-md 配置不可读，验收中止')
  check('P0.2 soul-md 卡 ≥ 2', Object.keys(soul.config.cards || {}).length >= 2, Object.keys(soul.config.cards || {}))
  check('P0.3 profile 原文存在', fs.existsSync(soul.file))

  section('1. 导入 soul-md（副本）')
  await ensurePersonaLayout(WORK)
  const g0 = (await readGlobalManifest(WORK)).manifest.generation
  const imp = await importFromSoulMd({
    dataRoot: WORK, config: soul.config, rawConfig: soul.raw, sourceLabel: soul.resolvedFrom,
    profileFile: soul.file, expectedGeneration: g0, confirm: true,
  })
  check('P1.1 导入成功', imp.ok === true, imp.error)
  check('P1.2 导入 ≥ 2 张', (imp.counts?.created || 0) >= 2, imp.counts)
  check('P1.3 每张卡分区 hash 与源一致', (imp.created || []).every((c) => {
    const srcName = c.cardName
    const srcHash = parseCard(String(soul.config.cards[srcName] || '')).zoneHashes
    const card = fs.readFileSync(path.join(WORK, 'persona', 'cards', c.personaId, 'manifest.json'), 'utf8')
    const mf = JSON.parse(card)
    return JSON.stringify(mf.zoneHashes) === JSON.stringify(srcHash)
  }), imp.created)
  const impDir = fs.readdirSync(path.join(WORK, 'persona', '_imports')).find((d) => d.startsWith('soul-md-'))
  check('P1.4 _imports 存 soul-md 快照（cards/config/source）',
    Boolean(impDir)
    && ['cards.json', 'config.json', 'source.json'].every((f) => fs.existsSync(path.join(WORK, 'persona', '_imports', impDir, f))))
  check('P1.5 _imports 不复制整份 profile（不带无关凭据）',
    Boolean(impDir) && !fs.existsSync(path.join(WORK, 'persona', '_imports', impDir, 'cordis.patch.yml')))
  check('P1.6 每卡 _archive/import-* 有原文', fs.readdirSync(path.join(WORK, 'persona', 'cards', 'alice', '_archive')).some((d) => d.startsWith('import-') && fs.existsSync(path.join(WORK, 'persona', 'cards', 'alice', '_archive', d, 'soul-md-card.md'))))

  section('2. 保存 / diff / 保护 / 回滚')
  const card = await readCard(WORK, 'alice')
  const z = card.zones.find((x) => x.zone === 'behavior')
  check('P2.0 找到可编辑的行为区', Boolean(z), card.zones.map((x) => [x.title, x.zone]))
  const secText = card.body.slice(z.start, z.end).replace(/\s+$/, '')
  const newBody = card.body.slice(0, z.start) + secText + '\n- 验收追加：先量化，再下结论。\n\n' + card.body.slice(z.end)
  const saved = await saveCard({
    dataRoot: WORK, cardId: 'alice',
    content: newBody,
    expectedGeneration: await (async () => (await readGlobalManifest(WORK)).manifest.generation)(),
    confirm: true, note: 'acceptance edit',
  })
  check('P2.1 保存行为区成功', saved.ok === true, saved.error)
  check('P2.2 版本 +1', saved.version === 2)
  check('P2.3 revision 1/2 快照都在位', ['revision-1-', 'revision-2-'].every((p) => fs.readdirSync(path.join(WORK, 'persona', 'cards', 'alice', '_archive')).some((d) => d.startsWith(p))))
  const d = await apiDiff({ dataRoot: WORK, cardId: 'alice', from: 1, to: 'current' })
  check('P2.4 diff 能看到行为区变化', d.ok && d.stats.added > 0 && /@@ -\d+,\d+ \+\d+,\d+ @@/.test(d.unified))
  const bad = await saveCard({
    dataRoot: WORK, cardId: 'alice',
    content: (await readCard(WORK, 'alice')).body.replace('量子智能助手', '普通家政'),
    expectedGeneration: (await readGlobalManifest(WORK)).manifest.generation, confirm: true,
  })
  check('P2.5 改身份区被拒', bad.ok === false && bad.code === 'IMMUTABLE_SECTION_CHANGED')
  const gBefore = (await readGlobalManifest(WORK)).manifest.generation
  const rb = await rollbackCard({ dataRoot: WORK, cardId: 'alice', revision: 1, expectedGeneration: gBefore, confirm: true })
  check('P2.6 回滚成新版本且内容等于 v1 快照', rb.ok === true && rb.bodyMatchesTarget === true, rb.error)
  check('P2.7 回滚后版本 = 3', rb.revision === 3)
  const stale = await saveCard({ dataRoot: WORK, cardId: 'alice', behavior: '## 核心工作准则\nx\n', expectedGeneration: gBefore, confirm: true })
  check('P2.8 旧 generation 被拒', stale.ok === false && stale.code === 'STALE_GENERATION')

  section('3. 只读 API / 预览 / 设置')
  const st = await apiStatus({ dataRoot: WORK, ctx: null, deep: true })
  check('P3.1 status deep 完整性通过', st.ok && st.integrity?.ok === true, st.integrity?.problems?.slice(0, 3))
  const cards = await apiCards({ dataRoot: WORK })
  check('P3.2 卡片列表含默认卡', cards.cards.length >= 2 && Boolean(cards.activeCardId))
  const prev = await apiPreview({ dataRoot: WORK, ctx: null, cardId: 'alice' })
  check('P3.3 预览读到真实 soul-md 人格段', prev.ok && prev.persona.chars > 100, prev.error)
  check('P3.4 预览读到真实 soul-md 记忆段', prev.ok && prev.memory.chars > 0, { chars: prev.memory?.chars, reasons: prev.memory?.reasons })
  check('P3.5 预览给出字符/token/截断信息', typeof prev.totals?.chars === 'number' && typeof prev.totals?.tokensEstimate === 'number' && Array.isArray(prev.memory?.reasons))
  const set = await apiSettings({ dataRoot: WORK, ctx: null })
  check('P3.6 设置读到真实有效值', set.ok && set.view.limits.injectMaxChars === Number(soul.config.memory.injectMaxChars), set.view?.limits)
  const src = await apiImportSources({ dataRoot: WORK, ctx: null })
  check('P3.7 import-sources 全部已映射', src.ok && src.counts.unmapped === 0, src.counts)
  const deep = await deepCheck({ dataRoot: WORK })
  check('P3.8 deepCheck 无问题', deep.problems.length === 0, deep.problems.slice(0, 3))

  section('4. 生产只读校验')
  const prodScopesAfter = hashTree(path.join(SOURCE, 'scopes'))
  const prodProcessAfter = hashTree(path.join(SOURCE, 'process'))
  const prodIdentityAfter = hashFile(path.join(SOURCE, 'identity.json'))
  const soulMemAfter = hashTree(soulMem)
  check('P4.1 生产根藏 scopes/ 未变', sameTree(prodScopes, prodScopesAfter))
  check('P4.2 生产熏习 process/ 未变', sameTree(prodProcess, prodProcessAfter))
  check('P4.3 生产 identity.json 未变', prodIdentity === prodIdentityAfter)
  check('P4.4 真实 soul-md 记忆文件未变', sameTree(soulMemBefore, soulMemAfter))
  const personaAfter = fs.existsSync(path.join(SOURCE, 'persona')) ? hashTree(path.join(SOURCE, 'persona')) : null
  check('P4.5 生产 dataRoot/persona 未被创建/改动', JSON.stringify(personaBefore) === JSON.stringify(personaAfter), { before: personaBefore && Object.keys(personaBefore).length, after: personaAfter && Object.keys(personaAfter).length })

  section('5. 幂等与收尾')
  const imp2 = await importFromSoulMd({ dataRoot: WORK, config: soul.config, sourceLabel: soul.resolvedFrom, profileFile: soul.file, expectedGeneration: (await readGlobalManifest(WORK)).manifest.generation, confirm: true })
  check('P5.1 二次导入不覆盖（全部 skipped）', imp2.ok && imp2.counts.skipped >= 2, imp2.counts)
  const reg = await readRegistry(WORK)
  check('P5.2 registry 保留 soul-md 默认卡', reg.ok && Boolean(reg.registry.activeCardId))

  console.log(`\n══════════════════════════════════`)
  console.log(`通过 ${pass} / ${pass + fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
  } else {
    console.log('全部通过 ✅')
  }
  console.log(`副本目录：${WORK}`)
  console.log(`生产根藏：${SOURCE}`)
  console.log(`soul-md 记忆：${soulMem}`)
  if (!args.keep && fail === 0) {
    try { fs.rmSync(WORK, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
