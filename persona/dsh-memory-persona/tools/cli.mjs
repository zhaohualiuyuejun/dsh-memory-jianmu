#!/usr/bin/env node
/**
 * tools/cli.mjs —— 镜台只读 CLI（排查/验收用）
 *
 * 用法：
 *   node tools/cli.mjs status  [--data-root <dir>] [--deep]
 *   node tools/cli.mjs list    [--data-root <dir>]
 *   node tools/cli.mjs card    [--data-root <dir>] [--card <id>]
 *   node tools/cli.mjs versions[--data-root <dir>] [--card <id>]
 *   node tools/cli.mjs diff    [--data-root <dir>] [--card <id>] [--from 1] [--to current]
 *   node tools/cli.mjs settings[--data-root <dir>]
 *   node tools/cli.mjs preview [--data-root <dir>] [--card <id>] [--workspace <path>]
 *   node tools/cli.mjs verify  [--data-root <dir>]
 *   node tools/cli.mjs sources [--data-root <dir>]
 *   node tools/cli.mjs import  [--data-root <dir>] --yes [--expected-generation N]
 *
 * 默认 data-root = <DSH_HOME>/memory-jianmu；只写 persona/（import 是唯一写命令）。
 */
import { resolve } from 'node:path'
import { defaultDataRoot } from '../lib/paths.mjs'
import { apiStatus, apiCards, apiCard, apiVersions, apiDiff, apiSettings, apiPreview, apiImportSources, deepCheck } from '../lib/api.mjs'
import { importFromSoulMd } from '../lib/write.mjs'
import { readGlobalManifest } from '../lib/store.mjs'
import { readSoulMdConfigFromYaml } from '../lib/soulmd.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '--deep') out[a.slice(2)] = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const dataRoot = resolve(args['data-root'] || defaultDataRoot())
const cmd = args._[0] || 'status'
const cardId = args.card || null

function print(v) { console.log(JSON.stringify(v, null, 2)) }
function die(v) { print(v); process.exit(1) }

if (cmd === 'status') {
  print(await apiStatus({ dataRoot, deep: Boolean(args.deep) }))
} else if (cmd === 'list') {
  print(await apiCards({ dataRoot }))
} else if (cmd === 'card') {
  if (!cardId) die({ ok: false, error: '--card 必填' })
  print(await apiCard({ dataRoot, cardId }))
} else if (cmd === 'versions') {
  if (!cardId) die({ ok: false, error: '--card 必填' })
  print(await apiVersions({ dataRoot, cardId }))
} else if (cmd === 'diff') {
  if (!cardId) die({ ok: false, error: '--card 必填' })
  print(await apiDiff({ dataRoot, cardId, from: args.from || 1, to: args.to || 'current' }))
} else if (cmd === 'settings') {
  print(await apiSettings({ dataRoot }))
} else if (cmd === 'preview') {
  print(await apiPreview({ dataRoot, cardId, workspace: args.workspace || null, sessionId: args.session || null }))
} else if (cmd === 'verify') {
  print(await deepCheck({ dataRoot }))
} else if (cmd === 'sources') {
  print(await apiImportSources({ dataRoot }))
} else if (cmd === 'import') {
  if (!args.yes) die({ ok: false, error: 'import 会写入 persona/；确认后加 --yes' })
  const soul = await readSoulMdConfigFromYaml({ profile: args.profile || 'desktop' })
  if (!soul.ok) die(soul)
  const gm = await readGlobalManifest(dataRoot)
  const gen = args['expected-generation'] !== undefined ? Number(args['expected-generation']) : Number(gm.manifest?.generation ?? 0)
  print(await importFromSoulMd({
    dataRoot, config: soul.config, rawConfig: soul.raw, sourceLabel: soul.resolvedFrom,
    profileFile: soul.file, expectedGeneration: gen, confirm: true,
  }))
} else {
  die({ ok: false, error: `未知命令：${cmd}` })
}
