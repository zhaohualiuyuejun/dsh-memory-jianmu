/**
 * lib/cardsync.mjs —— 注入热路径用的**同步**读（registry + 卡片文件）
 *
 * 为什么要同步：`ctx.systemPrompt.section({ text })` 的 text 函数按同步调用处理
 * （宿主每轮现算），不能在注入路径里 await。异步版本在 lib/store.mjs。
 *
 * 缓存：registry.json 只有几 KB，按 mtime+size 缓存，写入方主动失效
 * （lib/write.mjs 的 saveSettings 已接 settings 那套；卡片写入靠 mtime 自然失效）。
 */
import { readFileSync, statSync } from 'node:fs'
import { cardFile, registryFile } from './paths.mjs'
import { parseCard } from './card.mjs'

const cache = new Map() // file → { mtimeMs, size, value }

function cached(file, loader) {
  let st
  try {
    st = statSync(file)
  } catch {
    cache.delete(file)
    return { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: `读不到：${file}` } }
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
  let value
  try {
    value = loader()
  } catch (e) {
    value = { ok: false, code: 'READ_FAILED', error: { code: 'READ_FAILED', message: String(e?.message || e) } }
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

/** 读 registry（含 cards / workspaces / sessions / activeCardId / settings） */
export function readRegistrySync(dataRoot) {
  const file = registryFile(dataRoot)
  const r = cached(file, () => {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    if (!v || typeof v !== 'object') throw new Error('registry 不是对象')
    return { ok: true, registry: v, file }
  })
  return r.ok ? r : { ok: false, ...r, file }
}

/**
 * 读一张卡（front-matter + 正文），守卫与 store.readCard 对齐：
 * id / personaId / memoryScope 必须与目录 cardId 一致（一卡一人格）。
 */
export function readCardSync(dataRoot, cardId) {
  const file = cardFile(dataRoot, cardId)
  const r = cached(file, () => {
    const raw = readFileSync(file, 'utf8')
    const parsed = parseCard(raw)
    if (!parsed.hadFrontMatter) throw new Error(`card.md 缺少 front-matter：${file}`)
    const fm = parsed.frontMatter
    for (const [field, value] of [['id', fm.id], ['personaId', fm.personaId], ['memoryScope', fm.memoryScope]]) {
      if (value && value !== cardId) throw new Error(`卡 front-matter.${field}=${value} 与目录 ${cardId} 不一致（一卡一人格）`)
    }
    return { ok: true, cardId, file, frontMatter: fm, body: parsed.body, sourceHash: parsed.sourceHash }
  })
  return r.ok ? r : { ok: false, ...r, cardId, file }
}

/** 写动作之后主动丢缓存（卡片/registry 被外部改时也靠 mtime 兜底） */
export function invalidateSyncCache(file) {
  if (file) cache.delete(file)
  else cache.clear()
}
