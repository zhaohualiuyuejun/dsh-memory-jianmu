#!/usr/bin/env node
/**
 * tools/check-external-store.mjs —— 检查「自带原话块」是否符合年轮可读的最小契约
 *
 * 不依赖根藏包、不依赖本插件 lib；只用 Node 内置模块。
 * 用法：
 *   node tools/check-external-store.mjs --data-root "C:/path/to/data" --persona alice
 *   node tools/check-external-store.mjs --data-root ... --persona ... --json
 *
 * 退出码：0 = 可读（允许 warning）；1 = 致命问题（缺 manifest/chunks、零有效行、persona 不匹配）
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const k = a.slice(2)
  const next = process.argv[i + 1]
  if (next && !next.startsWith('--')) { args[k] = next; i++ } else { args[k] = true }
}
const dataRoot = resolve(String(args['data-root'] || ''))
const persona = String(args.persona || '').trim()
const json = Boolean(args.json)
const fatal = []
const warnings = []
const info = {}

function fail(code, message) { fatal.push({ code, message }) }
function warn(code, message) { warnings.push({ code, message }) }

if (!args['data-root'] || !dataRoot) {
  console.error('用法：node tools/check-external-store.mjs --data-root <目录> --persona <personaId> [--json]')
  process.exit(1)
}
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(persona) && persona !== 'persona_unassigned') {
  console.error(`persona 非法：${persona || '(空)'}；只允许 [a-z0-9][a-z0-9_-]{0,63}`)
  process.exit(1)
}

const dir = join(dataRoot, 'scopes', persona)
const manifestFile = join(dir, 'manifest.json')
const chunksFile = join(dir, 'chunks.jsonl')
const identityFile = join(dataRoot, 'identity.json')

const dirStat = await stat(dir).catch(() => null)
if (!dirStat || !dirStat.isDirectory()) {
  fail('SCOPE_NOT_FOUND', `scope 目录不存在：${dir}`)
} else {
  // manifest
  let manifest = null
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (e) {
    fail('MANIFEST_INVALID', `manifest.json 不可读/不是 JSON：${manifestFile}（${e.code || e.message}）`)
  }
  if (manifest) {
    info.manifest = {
      personaId: manifest.personaId,
      generation: manifest.generation,
      builtAt: manifest.builtAt,
      chunks: manifest.chunks,
      contractVersion: manifest.contractVersion,
    }
    if (manifest.personaId !== persona) fail('PERSONA_MISMATCH', `manifest.personaId=${manifest.personaId} ≠ 目录 ${persona}`)
    if (!Number.isFinite(manifest.generation)) warn('MANIFEST_GENERATION_MISSING', 'manifest.generation 缺失/非数字：幂等与续跑可能失效')
    if (!Number.isFinite(Date.parse(manifest.builtAt))) warn('MANIFEST_BUILTAT_MISSING', 'manifest.builtAt 缺失/非法：看门狗与幂等可能失效')
    if (!Number.isFinite(manifest.chunks)) warn('MANIFEST_CHUNKS_MISSING', 'manifest.chunks 缺失/非数字：UI 计数可能不准')
    if (manifest.contractVersion > 1) warn('CONTRACT_NEWER', `manifest.contractVersion=${manifest.contractVersion} > 1：本插件只保证读 v1`)
  }

  // chunks.jsonl
  let lines = []
  try {
    const text = await readFile(chunksFile, 'utf8')
    lines = text.split(/\r?\n/).filter((l) => l.trim())
  } catch (e) {
    fail('CHUNKS_NOT_FOUND', `chunks.jsonl 不可读：${chunksFile}（${e.code || e.message}）`)
  }
  if (!fatal.some((x) => x.code === 'CHUNKS_NOT_FOUND')) {
    let valid = 0
    let invalid = 0
    const ids = new Set()
    const dupIds = []
    const missingRecommended = new Map()
    for (let i = 0; i < lines.length; i++) {
      let row
      try { row = JSON.parse(lines[i]) } catch { invalid++; continue }
      const problems = []
      if (!row || typeof row !== 'object') problems.push('not-object')
      else {
        if (row.kind !== 'utterance') problems.push('kind')
        if (row.personaId !== persona) problems.push('personaId')
        if (!row.id || typeof row.id !== 'string') problems.push('id')
        if (typeof row.text !== 'string') problems.push('text')
        if (Number(row.contractVersion) > 1) problems.push('contractVersion')
      }
      if (problems.length) { invalid++; continue }
      valid++
      if (ids.has(row.id)) dupIds.push(row.id)
      ids.add(row.id)
      // 推荐字段（不致命，但规则/时间/分组会变差）
      for (const k of ['t', 'session', 'role', 'sourceType', 'retention', 'ws', 'channel']) {
        if (row[k] === undefined || row[k] === null || row[k] === '') {
          missingRecommended.set(k, (missingRecommended.get(k) || 0) + 1)
        }
      }
    }
    info.chunks = { lines: lines.length, valid, invalid, duplicateIds: dupIds.length }
    if (!valid) fail('NO_VALID_CHUNKS', `chunks.jsonl 里没有一条可用的 utterance 行（共 ${lines.length} 行）`)
    if (invalid) warn('INVALID_ROWS', `${invalid} 行会被跳过（kind/personaId/id/text/contractVersion 不合规）`)
    if (dupIds.length) warn('DUPLICATE_IDS', `${dupIds.length} 个重复 id（示例：${dupIds.slice(0, 3).join(', ')}）`)
    for (const [k, n] of missingRecommended) warn('MISSING_RECOMMENDED', `${n} 行缺推荐字段 ${k}：规则分类/时间过滤/分组可能退化`)
    if (Number.isFinite(manifest?.chunks) && manifest.chunks !== valid) {
      warn('CHUNKS_COUNT_MISMATCH', `manifest.chunks=${manifest.chunks}，实际有效行=${valid}`)
    }
  }
}

// identity.json 可选：UI 解析人格用；CLI/工具显式传 personaId 可不用
const idStat = await stat(identityFile).catch(() => null)
info.identity = Boolean(idStat?.isFile())
if (!idStat) warn('IDENTITY_MISSING', 'identity.json 不存在：UI 可能无法自动解析人格；请在 UI/工具里显式传 personaId')

// 这些不是年轮必需；如果以后要接寻枝，才需要
const hasVectors = await stat(join(dir, 'vectors_v1.f32')).then(() => true).catch(() => false)
const hasIndexMeta = await stat(join(dir, 'index_meta.json')).then(() => true).catch(() => false)
info.vectors = hasVectors
info.indexMeta = hasIndexMeta
if (!hasVectors || !hasIndexMeta) {
  warn('NO_VECTORS', '没有 vectors_v1.f32 / index_meta.json：年轮可读；但寻枝的语义检索需要向量，后续接寻枝时要补')
}

const result = {
  ok: fatal.length === 0,
  dataRoot,
  persona,
  dir,
  manifestFile,
  chunksFile,
  info,
  fatal,
  warnings,
  note: '年轮只要求 manifest.json + chunks.jsonl（kind=utterance / personaId / id / text / contractVersion≤1）；不要求根藏包、不要求向量。',
}
if (json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`外部 chunk store 检查：${dataRoot} / ${persona}`)
  if (info.manifest) {
    console.log(`  manifest: personaId=${info.manifest.personaId} generation=${info.manifest.generation} builtAt=${info.manifest.builtAt}`)
  }
  if (info.chunks) {
    console.log(`  chunks: ${info.chunks.lines} 行 / 有效 ${info.chunks.valid} / 无效 ${info.chunks.invalid} / 重复 id ${info.chunks.duplicateIds}`)
  }
  for (const x of warnings) console.log(`  ⚠️ [${x.code}] ${x.message}`)
  for (const x of fatal) console.log(`  ❌ [${x.code}] ${x.message}`)
  console.log(result.ok ? '\n结论：PASS（年轮可读）' : '\n结论：FAIL（修掉 ❌ 后再试）')
}
process.exit(result.ok ? 0 : 1)
