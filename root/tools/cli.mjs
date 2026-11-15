#!/usr/bin/env node
/**
 * tools/cli.mjs —— 根藏命令行（施工/运维用；不是插件工具面）
 *
 * 子命令：
 *   init-identity  从旧寻枝 sources 生成 v1 identity.json（人格解析层职责的临时替代）
 *   migrate        旧寻枝库 → 根藏 chunks/vectors（默认写 _dryrun）
 *   status         看块数/人格/未归属/向量缺失/错误
 *   export         导出某人格 chunks.jsonl
 *   verify         块数/重复 id/孤儿 tmp/墓碑/归档检查
 *   rebuild        从 chunks.jsonl 重建 index_meta（0 次嵌入）
 *   sources        看旧寻枝库的源映射（只读）
 */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { legacyRecallRoot, legacyIndexDir, defaultDataRoot, dryRunRoot, prettyWorkspace } from '../lib/paths.mjs'
import { buildIdentity, writeIdentity } from '../lib/identity.mjs'
import { migrateLegacyIndex } from '../lib/migrate.mjs'
import { statusAll, statusOfScope, exportChunks, rebuildIndexMeta, verifyScope } from '../lib/store.mjs'
import { ensureDir, decodeTextBuffer } from '../lib/fsatomic.mjs'
import { VERSION, CONTRACT_VERSION } from '../lib/version.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

function readLegacyConfig() {
  const file = join(legacyRecallRoot(), 'config.json')
  const r = readJsonSync(file)
  if (!r.ok) return { ok: false, error: r.error, file }
  let sources = []
  try { sources = JSON.parse(r.value.sources || '[]') } catch { sources = [] }
  return { ok: true, file, config: r.value, sources: Array.isArray(sources) ? sources : [] }
}

function readJsonSync(file) {
  try {
    const { text } = decodeTextBuffer(readFileSync(file))
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: { code: e.code || 'READ_FAILED', message: String(e.message || e) } }
  }
}

const PERSONA_SLUG_DEFAULT = { src1: 'alice', srcmvwe6u4u: 'bob' }
const DISPLAY_DEFAULT = { src1: 'Alice', srcmvwe6u4u: 'Bob' }

function buildIdentityFromSources(sources, personaMap = {}) {
  const personas = {}
  const workspaces = {}
  const map = { ...PERSONA_SLUG_DEFAULT, ...personaMap }
  const display = { ...DISPLAY_DEFAULT }
  for (const s of sources) {
    const pid = map[s.id]
    if (!pid) continue
    personas[pid] = { displayName: display[s.id] || s.name || pid }
    for (const wsDir of s.workspaces || []) {
      const real = prettyWorkspace(wsDir)
      // 已有映射且不同人格 → 冲突，保留先到的并警告
      if (workspaces[real] && workspaces[real] !== pid) {
        console.warn(`⚠️ 工作区冲突：${real} 同时映射到 ${workspaces[real]} 与 ${pid}（保留前者）`)
        continue
      }
      workspaces[real] = pid
    }
  }
  return buildIdentity({ personas, workspaces, sessions: {}, defaultPersonaId: null })
}

function parsePersonaMap(s) {
  const out = {}
  if (!s || s === true) return out
  for (const part of String(s).split(',')) {
    const [k, v] = part.split('=')
    if (k && v) out[k.trim()] = v.trim()
  }
  return out
}

async function cmdInitIdentity(args) {
  const dataRoot = resolve(String(args['data-root'] || args.out || defaultDataRoot()))
  const legacy = readLegacyConfig()
  if (!legacy.ok) {
    console.error(`旧寻枝配置读不到：${legacy.error.message}`)
    return 2
  }
  const identity = buildIdentityFromSources(legacy.sources, parsePersonaMap(args.persona))
  await ensureDir(dataRoot)
  const w = await writeIdentity(dataRoot, identity)
  console.log(JSON.stringify({
    ok: true,
    dataRoot,
    identityFile: join(dataRoot, 'identity.json'),
    bytes: w.bytes,
    personas: identity.personas,
    workspaces: Object.keys(identity.workspaces).length,
    sources: legacy.sources.map((s) => ({ id: s.id, name: s.name, personaId: (parsePersonaMap(args.persona)[s.id] || PERSONA_SLUG_DEFAULT[s.id] || null) })),
  }, null, 2))
  return 0
}

async function cmdMigrate(args) {
  const outRoot = resolve(String(args.out || args['data-root'] || dryRunRoot(defaultDataRoot())))
  const legacy = readLegacyConfig()
  if (!legacy.ok) {
    console.error(`旧寻枝配置读不到：${legacy.error.message}`)
    return 2
  }
  const personaMap = { ...PERSONA_SLUG_DEFAULT, ...parsePersonaMap(args.persona) }
  const sources = []
  for (const s of legacy.sources) {
    const pid = personaMap[s.id]
    if (!pid) { console.warn(`跳过无 persona 映射的源：${s.id}`); continue }
    const indexDir = legacyIndexDir(s.id)
    sources.push({ id: s.id, personaId: pid, displayName: DISPLAY_DEFAULT[s.id] || s.name || pid, indexDir })
  }
  if (!sources.length) { console.error('没有可迁移的源'); return 2 }

  await ensureDir(outRoot)
  // 先把 identity.json 铺到目标根（status 需要它；也是演练产物的一部分）
  const identity = buildIdentityFromSources(legacy.sources, personaMap)
  await writeIdentity(outRoot, identity)

  const report = await migrateLegacyIndex({
    outRoot,
    sources,
    identity,
    limitPerSource: Number(args.limit) || 250,
    perWsMax: Number(args['per-ws-max']) || 120,
    write: args.dry ? false : true,
    overwrite: Boolean(args.overwrite),
    retentionDays: Number(args['retention-days']) || 30,
  })
  console.log(JSON.stringify(report, null, 2))
  if (args.dry) return report.sources.every((s) => s.ok) ? 0 : 1
  return report.gate?.allGreen ? 0 : 1
}

async function cmdStatus(args) {
  const dataRoot = resolve(String(args['data-root'] || defaultDataRoot()))
  const pid = args.persona ? String(args.persona) : null
  if (pid) {
    const st = await statusOfScope(dataRoot, pid, { deep: Boolean(args.deep) })
    if (args.verify) st.verify = await verifyScope(dataRoot, pid)
    console.log(JSON.stringify({ ok: true, version: VERSION, contractVersion: CONTRACT_VERSION, dataRoot, scope: st }, null, 2))
    return st.degraded ? 1 : 0
  }
  const all = await statusAll(dataRoot, { deep: Boolean(args.deep) })
  all.version = VERSION
  if (args.verify) {
    all.verify = {}
    for (const p of Object.keys(all.scopes)) all.verify[p] = await verifyScope(dataRoot, p)
  }
  console.log(JSON.stringify(all, null, 2))
  return all.degraded ? 1 : 0
}

async function cmdExport(args) {
  const dataRoot = resolve(String(args['data-root'] || defaultDataRoot()))
  const pid = String(args.persona || '')
  if (!pid) { console.error('--persona 必填'); return 2 }
  const r = await exportChunks({ dataRoot, personaId: pid, outFile: args.out ? resolve(String(args.out)) : null, includeManifest: Boolean(args.manifest) })
  console.log(JSON.stringify(r, null, 2))
  return r.ok ? 0 : 1
}

async function cmdVerify(args) {
  const dataRoot = resolve(String(args['data-root'] || defaultDataRoot()))
  const pid = args.persona ? String(args.persona) : null
  if (pid) {
    const r = await verifyScope(dataRoot, pid)
    console.log(JSON.stringify(r, null, 2))
    return r.ok ? 0 : 1
  }
  const all = await statusAll(dataRoot, { deep: true })
  const out = { dataRoot, scopes: {} }
  let ok = true
  for (const p of Object.keys(all.scopes)) {
    const r = await verifyScope(dataRoot, p)
    out.scopes[p] = r
    if (!r.ok) ok = false
  }
  console.log(JSON.stringify({ ok, ...out }, null, 2))
  return ok ? 0 : 1
}

async function cmdRebuild(args) {
  const dataRoot = resolve(String(args['data-root'] || defaultDataRoot()))
  const pid = String(args.persona || '')
  if (!pid) { console.error('--persona 必填'); return 2 }
  const r = await rebuildIndexMeta({ dataRoot, personaId: pid })
  console.log(JSON.stringify(r, null, 2))
  return r.ok ? 0 : 1
}

async function cmdSources() {
  const legacy = readLegacyConfig()
  if (!legacy.ok) { console.error(legacy.error.message); return 2 }
  const out = {
    configFile: legacy.file,
    legacyRoot: legacyRecallRoot(),
    provider: legacy.config.provider,
    model: legacy.config.model || '(默认)',
    sources: legacy.sources.map((s) => ({
      id: s.id,
      name: s.name,
      personaId: PERSONA_SLUG_DEFAULT[s.id] || null,
      indexDir: legacyIndexDir(s.id),
      workspaces: (s.workspaces || []).map((d) => ({ dirName: d, pretty: prettyWorkspace(d) })),
    })),
  }
  console.log(JSON.stringify(out, null, 2))
  return 0
}

const USAGE = `dsh-memory-store ${VERSION}（根藏 · 建木存储层）
用法：node tools/cli.mjs <command> [options]

  sources                                 看旧寻枝库的源映射（只读）
  init-identity --data-root <dir>         生成 v1 identity.json
  migrate --out <dir>                     旧库 → 根藏（默认写 <dataRoot>/_dryrun）
          --limit 250 --per-ws-max 120 --persona src1=alice,srcmvwe6u4u=bob
          --dry                             只读演练，不落盘
          --overwrite                       允许覆盖已有 scope（先自动备份）
  status  --data-root <dir> [--persona p] [--deep] [--verify]
  export  --data-root <dir> --persona p [--out file] [--manifest]
  verify  --data-root <dir> [--persona p]
  rebuild --data-root <dir> --persona p   从 chunks.jsonl 重建 index_meta（0 次嵌入）
`

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const cmd = args._[0]
  try {
    switch (cmd) {
      case 'sources': return await cmdSources()
      case 'init-identity': return await cmdInitIdentity(args)
      case 'migrate': return await cmdMigrate(args)
      case 'status': return await cmdStatus(args)
      case 'export': return await cmdExport(args)
      case 'verify': return await cmdVerify(args)
      case 'rebuild': return await cmdRebuild(args)
      case undefined:
      case 'help':
      case '--help': console.log(USAGE); return 0
      default:
        console.error(`未知命令：${cmd}\n\n${USAGE}`)
        return 2
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, code: e.code || 'FAILED', message: String(e.message || e) }, null, 2))
    return 1
  }
}

process.exitCode = await main()
