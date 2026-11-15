#!/usr/bin/env node
/**
 * tools/lab-prompt.mjs —— 提示词实验台（本地 Ollama，零成本、不出网）
 *
 * 目的：在花真钱（宿主模型）之前，先验证「提示词能不能让模型吐出合格 JSON」。
 * 它不写任何年轮数据，只打印：
 *   · 模型原始输出（截断）
 *   · 每条 claim 的校验结果（quote 是否逐字、kind/epistemic 是否合法）
 *   · 合格率 / 拒收原因分布
 *
 * 用法：
 *   node tools/lab-prompt.mjs [--persona alice] [--chunks 12] [--model qwen3:8b] [--scope last:7d]
 */
import { defaultDataRoot, isSafePersonaId } from '../lib/paths.mjs'
import { readIdentity } from '../lib/root.mjs'
import { readScope } from '../lib/root.mjs'
import { readProcessState } from '../lib/process-read.mjs'
import { selectBatches } from '../lib/select.mjs'
import { SYSTEM_PROMPT, buildUserPrompt } from '../lib/prompt.mjs'
import { parseClaimsJson } from '../lib/llm.mjs'
import { validateClaim } from '../lib/claim.mjs'
import { scanClaimFields } from '../lib/guards.mjs'

const argv = process.argv.slice(2)
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

const dataRoot = flag('dataRoot', defaultDataRoot())
const OLLAMA = flag('ollama', 'http://127.0.0.1:11434')
const model = flag('model', 'qwen3:8b')
const nChunks = Number(flag('chunks', 12))
const scope = flag('scope', 'last:7d')

let personaId = flag('persona', null)
if (!personaId) {
  const id = await readIdentity(dataRoot)
  const list = id.ok ? Object.keys(id.identity.personas || {}) : []
  personaId = list.includes('alice') ? 'alice' : list[0]
}
if (!personaId || !isSafePersonaId(personaId)) { console.error('需要 --persona'); process.exit(2) }

const root = await readScope(dataRoot, personaId)
if (!root.ok) { console.error('根藏不可读：', root.error); process.exit(1) }
const state = await readProcessState(dataRoot, personaId)

const sel = selectBatches({
  chunks: root.chunks,
  statusByChunk: state.statusByChunk,
  covered: new Set(),
  topics: null,
  scope,
  maxInputChars: 12000,
  maxChunks: nChunks,
  maxBatches: 1,
})
if (!sel.batches.length) { console.error('没有可选块'); process.exit(1) }

const batch = sel.batches[0]
const user = buildUserPrompt(batch.chunks, { personaId })
console.log(`模型：${model}｜块数：${batch.chunks.length}｜输入字符：${user.length}`)
console.log('─'.repeat(60))

const t0 = Date.now()
const res = await fetch(`${OLLAMA}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    options: { temperature: 0, num_predict: 4000 },
  }),
})
if (!res.ok) { console.error('Ollama 失败：', res.status, await res.text()); process.exit(1) }
const data = await res.json()
const text = data?.message?.content ?? ''
console.log(`耗时：${Date.now() - t0}ms｜输出字符：${text.length}`)
console.log('─'.repeat(60))
console.log(text.slice(0, 1600))
console.log('─'.repeat(60))

let arr
try {
  arr = parseClaimsJson(text)
} catch (e) {
  console.error('❌ JSON 解析失败：', e.message)
  process.exit(1)
}

const chunksById = new Map(batch.chunks.map((c) => [c.id, c]))
let valid = 0
const rejected = []
for (const raw of arr) {
  const v = validateClaim(raw, { personaId, chunksById })
  if (!v.ok) { rejected.push({ title: String(raw?.title ?? '').slice(0, 60), reasons: v.reasons }); continue }
  const sc = scanClaimFields({ title: v.claim.title, body: v.claim.body, quote: v.claim.derivedFrom?.[0]?.quote })
  if (!sc.ok) { rejected.push({ title: v.claim.title.slice(0, 60), reasons: ['scan 红项'] }); continue }
  valid += 1
  console.log(`✅ [${v.claim.kind}/${v.claim.epistemic}] ${v.claim.title}`)
  console.log(`   quote: 「${v.claim.derivedFrom[0].quote.slice(0, 70)}」`)
}
for (const r of rejected) console.log(`❌ ${r.title}  ← ${JSON.stringify(r.reasons)}`)

console.log('─'.repeat(60))
console.log(`模型输出 ${arr.length} 条｜合格 ${valid} 条｜拒收 ${rejected.length} 条｜合格率 ${arr.length ? Math.round((valid / arr.length) * 100) : 0}%`)
if (data?.eval_count) console.log(`tokens：prompt ${data.prompt_eval_count ?? '?'} / output ${data.eval_count}`)
