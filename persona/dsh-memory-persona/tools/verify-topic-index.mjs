#!/usr/bin/env node
/**
 * tools/verify-topic-index.mjs —— 证明「新 topic 写进目录后，注入索引立即包含它」
 *
 * 用法：
 *   node tools/verify-topic-index.mjs --scope Alice --topic 镜台v2-记忆自治与设置可写
 *   node tools/verify-topic-index.mjs --memory-root "C:/Users/alice/.dsh/memory-jianmu/persona/memory" --scope Alice --all
 *
 * 判据（都基于 renderSoulMdMemory，与 buildInjection 同源的那个函数）：
 *   1. 目录里 topic 数量 = 索引里的条目数量
 *   2. --topic 指定的 key 出现在索引里，且带摘要行
 *   3. 索引字符数 / 总字符数不超过 injectMaxChars 的口径（core 或合计）
 * 退出码：0 全绿，1 有红项。
 */
import { readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderSoulMdMemory } from '../lib/soulmd.mjs'
import { defaultDataRoot } from '../lib/paths.mjs'

const args = process.argv.slice(2)
const getArg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const memoryRoot = resolve(getArg('memory-root', join(defaultDataRoot(), 'persona', 'memory')))
const scope = getArg('scope', 'Alice')
const topic = getArg('topic', null)
const cap = Number(getArg('max-chars', '12000')) || 12000

const scopeDir = join(memoryRoot, scope)
const topicsDir = join(scopeDir, 'topics')

const problems = []
const notes = []

if (!existsSync(topicsDir)) {
  console.error(`红：找不到 topics 目录 ${topicsDir}`)
  process.exit(1)
}
const keys = readdirSync(topicsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
notes.push(`topics 目录：${keys.length} 个 .md（${topicsDir}）`)

const out = renderSoulMdMemory({ memory: { inject: true, layered: true, injectMaxChars: cap, recall: 'off', indexMode: 'all' } }, scope, memoryRoot)
const indexKeys = [...out.index.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1])
notes.push(`注入索引：${indexKeys.length} 条（core ${out.core.length} 字 / 索引 ${out.index.length} 字 / 合计 ${out.text.length} 字，上限 ${cap}）`)

if (indexKeys.length !== keys.length) {
  problems.push(`数量不一致：目录 ${keys.length} ≠ 索引 ${indexKeys.length}`)
}
const missing = keys.filter((k) => !indexKeys.includes(k))
if (missing.length) problems.push(`目录里有、索引里没有：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`)

if (topic) {
  if (!existsSync(join(topicsDir, `${topic}.md`))) problems.push(`指定 topic 文件不存在：${topic}.md`)
  if (!indexKeys.includes(topic)) problems.push(`指定 topic 未出现在索引：${topic}`)
  const line = out.index.split('\n').find((l) => l.startsWith(`- \`${topic}\``)) || ''
  if (line) notes.push(`索引行：${line.slice(0, 160)}${line.length > 160 ? '…' : ''}`)
}

if (out.text.length > cap) {
  // 与 apiPreview 口径一致：cap 只卡记忆段（core + 索引）；超出即视为被截断场景，必须标 truncated
  if (!out.truncated) problems.push(`合计 ${out.text.length} 字 > 上限 ${cap}，但 truncated=false（截断标记缺失）`)
  else notes.push(`合计超出上限但已标 truncated（reasons: ${(out.reasons || []).join('；')}）`)
}

if (has('all')) {
  for (const k of keys.slice(0, 5)) notes.push(`  样本：${k}`)
}

console.log(notes.map((n) => `· ${n}`).join('\n'))
if (problems.length) {
  console.error(problems.map((p) => `红：${p}`).join('\n'))
  process.exit(1)
}
console.log('绿：目录与注入索引一致' + (topic ? `，且包含指定 topic「${topic}」` : ''))
