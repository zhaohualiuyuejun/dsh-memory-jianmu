/**
 * lib/guards.mjs —— 年轮的守卫（每条都要能红）
 *
 *   1. 工具名必须 jianmu_year_ 开头，且不得含 recall/search/query
 *   2. 工具面必须正好是允许的集合（7 个）
 *   3. 源码不得注册注入钩子 / pre-step / systemPrompt
 *   4. 任何写动作只许落 year/<personaId>/（assertYearWrite）
 *   5. claim 的 title/body/quote 必须过入库扫描（scan_text.py 等价规则）
 *
 * 说明：源码扫描是启发式闸门（能抓回归，不是形式化证明）；
 *       运行时 assertYearWrite 才是硬拦。
 */
import {
  TOOL_PREFIX,
  FORBIDDEN_TOOL_WORDS,
  ALLOWED_TOOLS,
} from './version.mjs'
import { assertYearWrite, isInside, normPath, yearDir, sessionsRoot, soulMdRoot } from './paths.mjs'

export { TOOL_PREFIX, FORBIDDEN_TOOL_WORDS, ALLOWED_TOOLS }

export function checkToolName(name) {
  const problems = []
  if (!String(name).startsWith(TOOL_PREFIX)) problems.push(`工具名必须以 ${TOOL_PREFIX} 开头：${name}`)
  const low = String(name).toLowerCase()
  for (const w of FORBIDDEN_TOOL_WORDS) {
    if (low.includes(w)) problems.push(`工具名含禁用词「${w}」：${name}（检索归寻枝）`)
  }
  return { ok: problems.length === 0, problems }
}

export function checkToolSurface(names) {
  const problems = []
  const set = [...new Set(names)]
  for (const n of set) problems.push(...checkToolName(n).problems)
  for (const n of set) if (!ALLOWED_TOOLS.includes(n)) problems.push(`未登记的工具：${n}`)
  for (const n of ALLOWED_TOOLS) if (!set.includes(n)) problems.push(`缺少工具：${n}`)
  return { ok: problems.length === 0, problems, tools: set }
}

export const INJECTION_PATTERNS = Object.freeze([
  /pre-?step/i,
  /before-?step/i,
  /systemPrompt/i,
  /system_prompt/i,
  /appendSystem/i,
  /injectPrompt/i,
  /promptInject/i,
  /ctx\.on\(\s*['"]prompt/i,
])

export function scanSourceForInjection(text) {
  const hits = []
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    if (/^\/.*\/[dgimsuvy]*,\s*$/.test(trimmed)) continue
    for (const re of INJECTION_PATTERNS) {
      if (re.test(line)) hits.push({ line: i + 1, text: trimmed.slice(0, 160), pattern: String(re) })
    }
  }
  return { ok: hits.length === 0, hits }
}

/** 运行时写闸门 */
export function guardWrite(dataRoot, personaId, target) {
  return assertYearWrite(dataRoot, personaId, target)
}

/** 只读根藏闸门：任何试图打开只读源写句柄的地方都应先过这里（目前没有写入口，留作守卫） */
export function assertReadOnlySource(dataRoot, target) {
  const t = normPath(target)
  const sessions = normPath(sessionsRoot())
  const soulmd = normPath(soulMdRoot())
  const dirs = [
    ['sessions/', sessions],
    ['soul-md/', soulmd],
    ['scopes/', normPath(`${dataRoot}/scopes`)],
    ['process/', normPath(`${dataRoot}/process`)],
    ['persona/', normPath(`${dataRoot}/persona`)],
  ]
  for (const [label, dir] of dirs) {
    if (t === dir || t.startsWith(dir + '/') || t.startsWith(dir + '\\')) {
      return { ok: true, readOnly: true, reason: `${label} 只读` }
    }
  }
  return { ok: true, readOnly: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// claim 入库扫描（scan_text.py 四类规则的 JS 等价实现）
// 红 = 确定性命中，拒收该条 claim；黄 = 可疑，收但记 warning
// ─────────────────────────────────────────────────────────────────────────────

const RED = 'red'
const YELLOW = 'yellow'
const GREEN = 'green'

const SCAN_RULES = Object.freeze([
  // 1. 注入模式
  //    ⚠️ 这些规则跑在「归一化文本」上（NFKC + 去空白 + 去零宽 + 小写），
  //    所以 `忽略 以上` / `Ignore   the  above` 也能命中（审查实测过字面匹配会被绕过）
  { cat: '注入模式', level: RED, what: '忽略以上/忽略此前', re: /忽略(以上|此前|之前|先前)/ },
  { cat: '注入模式', level: RED, what: 'ignore previous/above', re: /ignore.{0,8}(all.{0,8})?(previous|above|prior)/ },
  { cat: '注入模式', level: RED, what: '作为AI你必须', re: /作为(一个)?ai你必须/ },
  { cat: '注入模式', level: RED, what: '从现在起你必须', re: /(从现在起|从现在开始|从此|此后)(你|请|必须).{0,6}(必须|要|得)/ },
  { cat: '注入模式', level: RED, what: '删除/清空 scopes·memory·claims', re: /(删除|清空|抹掉|销毁).{0,12}(scopes|memory|claims|记忆库|根藏)/ },
  { cat: '注入模式', level: YELLOW, what: '你现在是', re: /你现在是/ },
  { cat: '注入模式', level: YELLOW, what: 'system prompt', re: /systemprompt/ },
  // 2. 凭据泄露
  { cat: '凭据泄露', level: RED, what: '疑似 sk- 密钥', re: /sk-[a-z0-9]{16,}/ },
  { cat: '凭据泄露', level: RED, what: '私钥头', re: /begin[\w ]*privatekey/ },
  { cat: '凭据泄露', level: RED, what: 'SESSDATA', re: /sessdata/ },
  { cat: '凭据泄露', level: RED, what: 'Authorization 头', re: /authorization:/ },
  { cat: '凭据泄露', level: YELLOW, what: 'token=（可能只是教程）', re: /token=/ },
  // 3. 后门迹象
  { cat: '后门迹象', level: RED, what: 'authorized_keys', re: /authorized_keys/ },
  { cat: '后门迹象', level: RED, what: 'curl | sh 管道执行', re: /curl[^\n|]*\|\s*(ba)?sh/ },
  { cat: '后门迹象', level: RED, what: 'powershell -enc', re: /powershell[^\n]*-e(nc|ncodedcommand)/ },
  { cat: '后门迹象', level: YELLOW, what: 'ssh-rsa（可能只是算法）', re: /ssh-rsa/ },
])

/** 归一化：NFKC → 去不可见字符 → 去所有空白（含全角空格）→ 小写 */
export function normalizeForScan(text) {
  let t = String(text ?? '')
  try { t = t.normalize('NFKC') } catch { /* 老 node 没有就算了 */ }
  t = t.replace(/[\u200b-\u200f\ufeff\u202a-\u202e]/g, '')
  t = t.replace(/[\s\u3000]+/g, '')
  return t.toLowerCase()
}

const INVISIBLE = /[\u200b\u200c\u200d\ufeff\u202a-\u202e]/g
const INVISIBLE_NAMES = Object.freeze({
  '\u200b': '零宽空格 U+200B',
  '\u200c': '零宽非连接符 U+200C',
  '\u200d': '零宽连接符 U+200D',
  '\ufeff': 'BOM U+FEFF',
  '\u202a': '双向控制 U+202A',
  '\u202b': '双向控制 U+202B',
  '\u202c': '双向控制 U+202C',
  '\u202d': '双向控制 U+202D',
  '\u202e': '双向控制 U+202E',
})

const clip = (s, n = 48) => {
  const one = String(s ?? '').replace(/\n/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n) + '…'
}

/**
 * 扫描一段文本。
 *
 * 两级匹配（审查教训：只做字面逐行匹配会被空格/换行/Unicode 绕过）：
 *   · 逐行归一化匹配 → 给行号
 *   · 整段归一化匹配（去换行）→ 抓跨行拆分（「忽略\n以上」）
 *   · 不可见字符在原始行上查（归一化会删掉它们）
 *
 * @returns {{verdict:'red'|'yellow'|'green', hits:Array<{line:number,cat:string,level:string,what:string,snippet:string}>}}
 */
export function scanText(text) {
  const raw = String(text ?? '')
  const hits = []
  const lines = raw.split(/\r?\n/)

  // 逐行（给行号）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const norm = normalizeForScan(line)
    for (const r of SCAN_RULES) {
      if (r.re.test(norm)) hits.push({ line: i + 1, cat: r.cat, level: r.level, what: r.what, snippet: clip(line) })
    }
    const seen = new Set()
    for (const ch of line.match(INVISIBLE) || []) {
      if (seen.has(ch)) continue
      seen.add(ch)
      hits.push({
        line: i + 1, cat: '不可见字符', level: RED,
        what: INVISIBLE_NAMES[ch] || `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        snippet: clip(line),
      })
    }
  }

  // 整段（抓跨行拆分；已在逐行命中过的不重复记）
  const normAll = normalizeForScan(raw)
  const already = new Set(hits.map((h) => `${h.cat}|${h.what}`))
  for (const r of SCAN_RULES) {
    const key = `${r.cat}|${r.what}`
    if (already.has(key)) continue
    if (r.re.test(normAll)) hits.push({ line: 0, cat: r.cat, level: r.level, what: r.what, snippet: clip(raw, 60) })
  }

  let verdict = GREEN
  if (hits.some((h) => h.level === RED)) verdict = RED
  else if (hits.length) verdict = YELLOW
  return { verdict, hits }
}

/** claim 入库前过扫描：红项拒收 */
export function scanClaimFields({ title, body, quote }) {
  const parts = [['title', title], ['body', body], ['quote', quote]]
  const all = []
  for (const [field, text] of parts) {
    if (!text) continue
    const r = scanText(text)
    for (const h of r.hits) all.push({ field, ...h })
  }
  const verdict = all.some((h) => h.level === RED) ? RED : (all.length ? YELLOW : GREEN)
  return { verdict, ok: verdict !== RED, hits: all }
}

export function guardSummary({ tools = [], sourceText = '' } = {}) {
  const surface = checkToolSurface(tools)
  const injection = scanSourceForInjection(sourceText)
  return { ok: surface.ok && injection.ok, surface, injection }
}

export function isInsideYear(dataRoot, personaId, target) {
  return isInside(yearDir(dataRoot, personaId), target)
}
