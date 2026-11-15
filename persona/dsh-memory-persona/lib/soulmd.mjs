/**
 * lib/soulmd.mjs —— 只读读取 soul-md 的有效配置与记忆布局
 *
 * 有效值来源链（契约 §2.6）：
 *   settings.get('soul-md') → settings.describe() → loader entry → configEditor
 *   → cordis.patch.yml（YAML 兜底）→ schema 默认值
 *
 * 本模块**从不写** soul-md；只读文件、只读服务。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dshHome, profilePatchFile } from './paths.mjs'

// ── 默认值（与 dsh-soul-md@0.10.3 的 Config schema 对齐） ──────────────────
export const SOULMD_DEFAULTS = Object.freeze({
  cards: {},
  active: '',
  sessions: {},
  workspaces: {},
  workspaceList: [],
  memory: {
    maxBytes: 1024 * 1024,
    inject: true,
    layered: false,
    injectMaxChars: 8000,
    recall: 'off',
    indexMode: 'all',
    recallMaxTopics: 5,
    recallMaxChars: 1600,
    compactionRecall: false,
    order: 0.5,
    path: '',
    workspaceFile: '',
  },
  allowTemplates: false,
  skipSubagents: false,
  soulMaxBytes: 64 * 1024,
})

function unwrapVolatiles(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') {
    if (typeof value.get === 'function') return unwrapVolatiles(value.get())
    if (Array.isArray(value)) return value.map(unwrapVolatiles)
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = unwrapVolatiles(v)
    return out
  }
  return value
}

function service(ctx, name) {
  try {
    const v = typeof ctx?.get === 'function' ? ctx.get(name, false) : undefined
    return v
  } catch { return undefined }
}

function deepMerge(base, patch) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(base) || !isObj(patch)) return patch !== undefined ? patch : base
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  }
  return out
}

/** 规范化 soul-md 配置：补默认值、展开 volatile */
export function normalizeSoulMdConfig(raw) {
  const base = unwrapVolatiles(raw) || {}
  return deepMerge(SOULMD_DEFAULTS, base)
}

/**
 * 从宿主服务读 soul-md 有效配置。
 * @returns {{ok:boolean, config?:object, resolvedFrom?:string, raw?:object, warnings?:string[], error?:object}}
 */
export function readSoulMdConfigFromServices(ctx) {
  const warnings = []
  const settings = service(ctx, 'settings')
  if (settings) {
    try {
      if (typeof settings.get === 'function') {
        const v = settings.get('soul-md')
        if (v !== undefined && v !== null) {
          return { ok: true, config: normalizeSoulMdConfig(v), raw: unwrapVolatiles(v), resolvedFrom: 'settings.get', warnings }
        }
      }
      if (typeof settings.describe === 'function') {
        const rows = settings.describe({ redactSecrets: true })
        const row = Array.isArray(rows) ? rows.find((r) => r?.ns === 'soul-md' || r?.ns === 'dsh-soul-md' || String(r?.ns || '').endsWith('/soul-md')) : null
        if (row?.value !== undefined) {
          return { ok: true, config: normalizeSoulMdConfig(row.value), raw: unwrapVolatiles(row.value), resolvedFrom: 'settings.describe', warnings }
        }
      }
    } catch (e) {
      warnings.push(`settings 读取失败：${String(e?.message || e)}`)
    }
  }

  const loader = (() => { try { return ctx?.root?.loader ?? ctx?.loader } catch { return undefined } })()
  if (loader && typeof loader.entries === 'function') {
    try {
      for (const entry of loader.entries()) {
        const id = entry?.options?.id
        const name = entry?.options?.name
        if (id === 'soul-md' || name === 'dsh-soul-md' || String(name || '').endsWith('/soul-md') || String(name || '').endsWith('dsh-soul-md')) {
          const cfg = entry?.fiber?.config
          if (cfg !== undefined) {
            return { ok: true, config: normalizeSoulMdConfig(cfg), raw: unwrapVolatiles(cfg), resolvedFrom: 'loader.entries', warnings }
          }
        }
      }
    } catch (e) {
      warnings.push(`loader 读取失败：${String(e?.message || e)}`)
    }
  }

  const editor = service(ctx, 'configEditor')
  if (editor && typeof editor.configuration === 'function') {
    try {
      const rows = editor.configuration()
      const row = Array.isArray(rows) ? rows.find((r) => {
        const id = r?.entry?.options?.id
        const name = r?.entry?.options?.name
        return id === 'soul-md' || name === 'dsh-soul-md' || String(name || '').endsWith('/soul-md')
      }) : null
      if (row) {
        const cfg = row?.entry?.fiber?.config !== undefined
          ? row.entry.fiber.config
          : deepMerge(row?.inherited, row?.override)
        if (cfg !== undefined) {
          return { ok: true, config: normalizeSoulMdConfig(cfg), raw: unwrapVolatiles(cfg), resolvedFrom: 'configEditor', warnings }
        }
      }
    } catch (e) {
      warnings.push(`configEditor 读取失败：${String(e?.message || e)}`)
    }
  }

  return { ok: false, code: 'SOULMD_UNAVAILABLE', error: { code: 'SOULMD_UNAVAILABLE', message: '读不到 soul-md 有效配置（settings/loader/configEditor 都不可用）' }, warnings }
}

// ── YAML 兜底 ────────────────────────────────────────────────────────────

function candidateYamlRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  try {
    const home = dshHome()
    for (const p of readdirSync(join(home, 'profiles'))) {
      push(join(home, 'profiles', p, 'node_modules', 'yaml', 'dist', 'index.js'))
      push(join(home, 'profiles', p, 'node_modules', 'yaml'))
    }
  } catch { /* ignore */ }
  if (process.env.APPDATA) {
    push(join(process.env.APPDATA, 'npm', 'node_modules', 'yaml', 'dist', 'index.js'))
  }
  return out
}

async function loadYamlModule() {
  try { return await import('yaml') } catch { /* 下一层 */ }
  for (const p of candidateYamlRoots()) {
    try {
      const url = p.endsWith('.js') ? pathToFileURL(p).href : pathToFileURL(join(p, 'dist', 'index.js')).href
      const mod = await import(url)
      if (mod?.parse) return mod
    } catch { /* 下一个 */ }
  }
  return null
}

/** 从 profile 的 cordis.patch.yml 读 soul-md 配置（只读） */
export async function readSoulMdConfigFromYaml({ profile = 'desktop' } = {}) {
  const file = profilePatchFile(profile)
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) {
    return { ok: false, code: 'SOULMD_UNAVAILABLE', error: { code: 'SOULMD_UNAVAILABLE', message: `读不到 profile 配置：${file}（${e.code || e.message}）` } }
  }
  const yaml = await loadYamlModule()
  if (!yaml) {
    return { ok: false, code: 'SOULMD_UNAVAILABLE', error: { code: 'SOULMD_UNAVAILABLE', message: 'yaml 解析库不可用（宿主树里找不到 yaml）' } }
  }
  let doc
  try { doc = yaml.parse(text) } catch (e) {
    return { ok: false, code: 'SOULMD_UNAVAILABLE', error: { code: 'SOULMD_UNAVAILABLE', message: `YAML 解析失败：${e.message}` } }
  }
  const rows = []
  const walk = (node) => {
    if (!node) return
    if (Array.isArray(node)) { for (const n of node) walk(n); return }
    if (typeof node !== 'object') return
    if (Array.isArray(node.insert)) { for (const n of node.insert) walk(n); return }
    const name = node.name
    if (name === 'dsh-soul-md' || String(name || '').endsWith('/soul-md')) {
      rows.push({ name, config: node.config || {} })
    }
  }
  walk(doc)
  if (!rows.length) {
    return { ok: false, code: 'SOULMD_UNAVAILABLE', error: { code: 'SOULMD_UNAVAILABLE', message: `profile 配置里没有 dsh-soul-md：${file}` } }
  }
  return {
    ok: true,
    config: normalizeSoulMdConfig(rows[0].config),
    raw: rows[0].config,
    resolvedFrom: 'yaml',
    file,
    fileBytes: Buffer.byteLength(text),
    warnings: [],
  }
}

/** 服务优先、YAML 兜底 */
export async function resolveSoulMdConfig(ctx, opts = {}) {
  if (ctx) {
    const viaServices = readSoulMdConfigFromServices(ctx)
    if (viaServices.ok) return viaServices
    const viaYaml = await readSoulMdConfigFromYaml(opts)
    if (viaYaml.ok) {
      return { ...viaYaml, warnings: [...(viaServices.warnings || []), '服务读取失败，已回退到 profile YAML'] }
    }
    return { ...viaServices, yamlError: viaYaml.error }
  }
  return readSoulMdConfigFromYaml(opts)
}

// ── 注入设置视图（契约 §2.6） ────────────────────────────────────────────

export function settingsView(config, resolvedFrom = 'unknown') {
  const c = normalizeSoulMdConfig(config)
  const m = c.memory
  const topicIndex = !m.layered ? 'off' : (m.recall === 'keyword' && m.indexMode === 'recall' ? 'recall' : 'all')
  return {
    source: 'soul-md',
    readOnly: true,
    resolvedFrom,
    inject: {
      persona: true,
      memorySegment: Boolean(m.inject),
      layered: Boolean(m.layered),
      topicIndex,
      keywordRecall: m.recall === 'keyword',
      compactionCompensation: Boolean(m.compactionRecall),
      subagentSkip: Boolean(c.skipSubagents),
      promptVariables: Boolean(c.allowTemplates),
    },
    limits: {
      maxRecallTopics: Number(m.recallMaxTopics) || 5,
      recallMaxChars: Number(m.recallMaxChars) || 1600,
      injectMaxChars: Number(m.injectMaxChars) || 8000,
      memoryMaxBytes: Number(m.maxBytes) || 1048576,
    },
    mode: 'normal',
    notes: [
      '人格卡：有卡即注入；绑定 none 或未命中才不注入。',
      '只写模式：镜台接管后可用。',
      '主题索引口径：分层记忆关 → off；开 → 仅召回（indexMode=recall）或全量。',
    ],
    raw: {
      active: c.active,
      cards: Object.keys(c.cards || {}),
      sessions: c.sessions,
      workspaces: c.workspaces,
      workspaceList: c.workspaceList,
      memory: m,
      allowTemplates: c.allowTemplates,
      skipSubagents: c.skipSubagents,
    },
  }
}

// ── 记忆布局（只读） ─────────────────────────────────────────────────────

export function safeMemoryName(value, fallback = 'memory') {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 64) || fallback
}

function readTextOrNull(file) {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

function topicDescriptor(key, text) {
  const lines = String(text ?? '').split(/\r?\n/)
  // 只认「首个非空行就是标题」的文件。
  // 记忆纪律是 topic 首行写「日期 — 结论」，这类文件里后面出现的 ## 小标题
  // 只是正文分节，拿它当标题会让注入索引错位（2026-11-08 实测踩到）。
  const firstNonEmpty = lines.find((line) => line.trim() !== '')
  const isHeading = firstNonEmpty ? /^#{1,6}\s+\S/.test(firstNonEmpty.trim()) : false
  const title = (isHeading ? firstNonEmpty.trim().replace(/^#{1,6}\s+/, '').trim() : key).slice(0, 80)
  const summaryLine = lines.find((line) => {
    const v = line.trim()
    return v && !/^#{1,6}\s+/.test(v) && !/^<!--/.test(v)
  })
  const summary = summaryLine ? summaryLine.trim().replace(/^[-*>]\s*/, '').replace(/\s+/g, ' ').slice(0, 240) : '（无摘要 / no summary）'
  return { key, title, summary }
}

export function renderTopicIndex(topics) {
  if (!topics.length) return ''
  const rows = topics.map(({ key, title, summary }) => {
    // 没有标题的 topic（首行直接是「日期 — 结论」）会拿到 title===key，
    // 这时只显示摘要，别把 key 重复两遍浪费注入预算。
    const head = title && title !== key ? title : ''
    const body = summary && summary !== title && summary !== key ? summary : ''
    if (head && body) return `- \`${key}\` — ${head}：${body}`
    if (head) return `- \`${key}\` — ${head}`
    return `- \`${key}\` — ${body || '（无摘要 / no summary）'}`
  })
  return ['## 主题记忆索引 / Topic memory index', '用 memory_read 的 topic 参数按需读取全文 / Use memory_read(topic) for full text.', '', ...rows].join('\n')
}

export function retainMemoryEnds(text, cap) {
  const value = String(text ?? '')
  const limit = Math.max(0, Math.floor(cap))
  if (value.length <= limit) return value
  if (!limit) return ''
  const separator = '\n…\n'
  if (limit <= separator.length) return value.slice(-limit)
  const contentCap = limit - separator.length
  const headLength = Math.ceil(contentCap / 2)
  const tailLength = contentCap - headLength
  return value.slice(0, headLength) + separator + (tailLength ? value.slice(-tailLength) : '')
}

export function soulMdMemoryDir() {
  return join(dshHome(), 'soul-md', 'memory')
}

export function listTopicsInScope(scope, memoryRoot = soulMdMemoryDir()) {
  const dir = join(memoryRoot, safeMemoryName(scope, 'global'), 'topics')
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return ents
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    // 2026-11-09：`-待审` 是外部内容隔离区（QQ群/B站评论先进这里），
    // 不进注入索引、也不出现在 memory_list —— 未审内容一律不进上下文。
    .filter((e) => !basename(e.name, '.md').endsWith('-待审'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap((e) => {
      const file = join(dir, e.name)
      const text = readTextOrNull(file)
      if (text === null) return []
      const key = basename(e.name, '.md')
      return [{ ...topicDescriptor(key, text), file }]
    })
}

export function readLayeredScope(scope, memoryRoot = soulMdMemoryDir()) {
  const root = join(memoryRoot, safeMemoryName(scope, 'global'))
  const coreFile = join(root, 'core.md')
  const legacyFile = join(memoryRoot, `${safeMemoryName(scope, 'global')}.md`)
  const coreText = readTextOrNull(coreFile)
  const legacyText = coreText === null ? readTextOrNull(legacyFile) : null
  const topics = listTopicsInScope(scope, memoryRoot)
  const text = coreText ?? legacyText ?? ''
  return {
    exists: coreText !== null || legacyText !== null || topics.length > 0,
    scope,
    text,
    file: coreText !== null ? coreFile : legacyText !== null ? legacyFile : coreFile,
    topics,
    index: renderTopicIndex(topics),
    inheritedLegacy: coreText === null && legacyText !== null,
  }
}

/** soul-md 非分层（layered=false）只读 legacy `<memory>/<scope>.md`，不出索引 */
export function readLegacyScope(scope, memoryRoot = soulMdMemoryDir()) {
  const file = join(memoryRoot, `${safeMemoryName(scope, 'global')}.md`)
  const text = readTextOrNull(file)
  return {
    exists: text !== null,
    scope,
    text: text ?? '',
    file,
    topics: [],
    index: '',
    inheritedLegacy: false,
    mode: 'legacy',
  }
}

/** soul-md 的读取链：卡 scope → global；layered=false 时只读 legacy 文件 */
export function readMemoryChain(scopes, { layered = true, memoryRoot = soulMdMemoryDir() } = {}) {
  const chain = [...new Set(scopes)]
  const read = (scope) => (layered ? readLayeredScope(scope, memoryRoot) : readLegacyScope(scope, memoryRoot))
  for (const scope of chain) {
    const v = read(scope)
    if (v.exists) return v
  }
  return read(chain[0] ?? 'global')
}

/**
 * 忠实复刻 soul-md renderMemory 的截断逻辑。
 * @returns {{text:string, core:string, index:string, scope:string, file:string, topics:Array, truncated:boolean, reasons:string[], rawChars:number}}
 */
export function renderSoulMdMemory(config, cardName, memoryRoot = soulMdMemoryDir()) {
  const c = normalizeSoulMdConfig(config)
  const m = c.memory
  if (!m.inject) {
    return { text: '', core: '', index: '', scope: null, file: null, topics: [], truncated: false, reasons: ['memory.inject=false → 记忆段不注入'], rawChars: 0 }
  }
  const scopes = cardName ? [cardName, 'global'] : ['global']
  const chain = readMemoryChain(scopes, { layered: Boolean(m.layered), memoryRoot })
  const index = m.layered && m.recall === 'keyword' && m.indexMode === 'recall'
    ? 'Use jianmu_persona_memory_list for topic keys and summaries; jianmu_persona_memory_read(topic) retrieves full text.'
    : chain.index
  const rendered = [chain.text, index].filter(Boolean).join('\n\n')
  const cap = Math.max(0, Math.floor(m.injectMaxChars ?? 8000))
  const base = {
    core: chain.text,
    index,
    scope: chain.scope,
    file: chain.file,
    topics: chain.topics,
    rawChars: rendered.length,
    cap,
  }
  if (!rendered) return { ...base, text: '', truncated: false, reasons: ['没有可注入的记忆（core 为空、主题索引为空）'] }
  if (rendered.length <= cap) return { ...base, text: rendered, truncated: false, reasons: [] }
  if (!index) {
    return {
      ...base,
      text: retainMemoryEnds(rendered, cap) + '\n\n> 部分记忆未注入（已保留首尾），请用 jianmu_persona_memory_read 读取全文 / part of memory omitted (beginning and end retained); use jianmu_persona_memory_read for the full text.',
      truncated: true,
      reasons: [`超出 injectMaxChars=${cap}，无主题索引 → 保留 core 首尾`],
    }
  }
  if (index.length > cap) {
    return {
      ...base,
      text: index.slice(0, cap) + '\n\n> 主题索引未完整注入，core 未注入；请用 jianmu_persona_memory_read 读取全文 / topic index incomplete; core omitted; use jianmu_persona_memory_read.',
      truncated: true,
      reasons: [`主题索引 ${index.length} 字符 > cap ${cap} → 只截索引，core 完全省略`],
    }
  }
  const coreCap = Math.max(0, cap - index.length - (chain.text ? 2 : 0))
  const core = retainMemoryEnds(chain.text, coreCap)
  return {
    ...base,
    text: [core, index].filter(Boolean).join('\n\n')
      + '\n\n> core 部分内容未注入，请用 jianmu_persona_memory_read 读取全文 / part of core omitted; use jianmu_persona_memory_read for the full text.',
    truncated: true,
    reasons: [`主题索引保留 ${index.length} 字符，core 配额 ${coreCap} 字符 → core 首尾保留`],
  }
}

/** 卡名解析：会话 → 工作区最长前缀 → 默认卡（与 soul-md 一致） */
export function resolveSoulMdCardName(config, { workspace = null, sessionId = null } = {}) {
  const c = normalizeSoulMdConfig(config)
  const sid = sessionId ? String(sessionId) : null
  if (sid && c.sessions && Object.prototype.hasOwnProperty.call(c.sessions, sid)) {
    const v = c.sessions[sid]
    if (v === 'none') return { name: null, reason: 'session:none', key: sid }
    if (typeof v === 'string' && v && c.cards?.[v] !== undefined) return { name: v, reason: 'session', key: sid }
  }
  if (workspace) {
    const target = String(workspace).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
    let best = null
    for (const [w, v] of Object.entries(c.workspaces || {})) {
      const nw = String(w).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
      if (target === nw || target.startsWith(nw + '\\')) {
        if (!best || nw.length > best.len) best = { v, len: nw.length, key: w }
      }
    }
    if (best) {
      if (best.v === 'none') return { name: null, reason: 'workspace:none', key: best.key }
      if (typeof best.v === 'string' && c.cards?.[best.v] !== undefined) return { name: best.v, reason: 'workspace', key: best.key }
    }
  }
  if (c.active && c.cards?.[c.active] !== undefined) return { name: c.active, reason: 'default', key: null }
  return { name: null, reason: 'none', key: null }
}

export function profileInfo(profile = 'desktop') {
  const file = profilePatchFile(profile)
  let stat = null
  try { stat = statSync(file) } catch { /* ignore */ }
  return { profile, file, exists: Boolean(stat), bytes: stat?.size ?? null, mtimeMs: stat?.mtimeMs ?? null }
}

export { homedir }
