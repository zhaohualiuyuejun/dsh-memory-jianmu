/**
 * lib/card.mjs —— 人格卡：front-matter、分区、分区 hash、模板、局部替换
 *
 * 设计要点（契约 §2.1）：
 *   · 原文逐字保留：分区不靠重写正文，只记录边界（zones）。
 *   · 身份/红线 hash = 该区所有精确切片的 sha256 拼接；行为/风格改动不会动它。
 *   · 保存可只给 behavior / style，由这里按分区边界替换。
 */
import { createHash } from 'node:crypto'
import { ZONES } from './version.mjs'

const FM_KEYS = ['id', 'name', 'personaId', 'memoryScope', 'source', 'status', 'version', 'updatedAt']

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function normEol(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

function parseScalar(raw) {
  const v = String(raw).trim()
  if (v === '') return ''
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) } catch { return v.slice(1, -1) }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  return v
}

function parseFrontMatter(text) {
  // 先统一为 LF，再切 front-matter/正文；否则 CRLF 卡会出现 body 带 \r、zones 偏移错位
  const src = normEol(String(text ?? ''))
  const canonical = src.replace(/\n+$/, '')
  if (!src.startsWith('---')) return { frontMatter: {}, body: canonical, hadFrontMatter: false, problems: [] }
  const lines = src.split('\n')
  if (lines[0].trim() !== '---') return { frontMatter: {}, body: canonical, hadFrontMatter: false, problems: [] }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close < 0) return { frontMatter: {}, body: src, hadFrontMatter: false, problems: ['front-matter 未闭合'] }
  const fm = {}
  const problems = []
  for (let i = 1; i < close; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) { problems.push(`front-matter 第 ${i + 1} 行无法解析：${line.slice(0, 80)}`); continue }
    fm[m[1]] = parseScalar(m[2])
  }
  const body = lines.slice(close + 1).join('\n').replace(/^\n/, '').replace(/\n+$/, '')
  return { frontMatter: fm, body, hadFrontMatter: true, problems }
}

/** 解析一份 card.md（front-matter + 正文 + 分区 + hash） */
export function parseCard(markdown) {
  const raw = String(markdown ?? '')
  const { frontMatter, body, hadFrontMatter, problems } = parseFrontMatter(raw)
  const zones = splitZones(body)
  const zoneHashes = {}
  for (const zone of ZONES) zoneHashes[zone] = zoneHash(body, zones, zone)
  const fmMissing = hadFrontMatter ? FM_KEYS.filter((k) => frontMatter[k] === undefined) : FM_KEYS.slice()
  return {
    ok: true,
    frontMatter,
    body,
    zones,
    zoneHashes,
    sourceHash: sha256(raw),
    hadFrontMatter,
    problems,
    fmMissing,
  }
}

/** 序列化 card.md（固定 key 顺序；字符串一律 JSON 引号，YAML 合法） */
export function serializeCard(frontMatter, body) {
  const fm = { ...frontMatter }
  const lines = ['---']
  for (const key of FM_KEYS) {
    const v = fm[key]
    if (v === undefined) continue
    if (typeof v === 'string') lines.push(`${key}: ${JSON.stringify(v)}`)
    else if (v === null) lines.push(`${key}: null`)
    else lines.push(`${key}: ${String(v)}`)
  }
  lines.push('---', '')
  // 正文规范化：去尾部换行，文件恒以一个换行结束（导入/保存/读回共用同一口径）
  const cleanBody = normEol(body).replace(/\n+$/, '')
  return lines.join('\n') + '\n' + cleanBody + '\n'
}

// ── 分区切分 ─────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})[ \t]+(\S.*)$/

export function classifyHeading(title, level = 2) {
  const t = String(title || '').replace(/\s+/g, '')
  if (level <= 1) return 'identity'
  if (/红线|底线|禁区|禁止|安全边界/.test(t)) return 'redline'
  if (/示例|例句|范例|few-?shot|对话示例/i.test(t)) return 'style'
  if (/身份|外貌|设定|关系|家庭|私人文件夹|私人空间|世界观/.test(t)) return 'identity'
  return 'behavior'
}

/**
 * 按 H1/H2 切分正文；忽略 fenced code block 里的标题。
 * 返回 [{index, level, title, zone, start, end}]（start/end 为 body 字符偏移）
 */
export function splitZones(body) {
  const text = normEol(body)
  const lines = text.split('\n')
  const starts = []
  let off = 0
  for (const line of lines) { starts.push(off); off += line.length + 1 }
  const headings = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const fenceMatch = /^(```|~~~)/.exec(trimmed)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]
      else if (fence === fenceMatch[1]) fence = null
      continue
    }
    if (fence) continue
    const m = HEADING_RE.exec(lines[i])
    if (!m) continue
    const level = m[1].length
    if (level > 2) continue
    headings.push({ line: i, level, title: m[2].trim(), start: starts[i] })
  }
  const zones = []
  if (headings.length === 0) {
    if (text.length) zones.push({ index: 0, level: 0, title: '', zone: 'identity', start: 0, end: text.length })
    return zones
  }
  if (headings[0].start > 0) {
    const pre = text.slice(0, headings[0].start)
    if (pre.trim()) zones.push({ index: -1, level: 0, title: '', zone: 'identity', start: 0, end: headings[0].start })
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const end = i + 1 < headings.length ? headings[i + 1].start : text.length
    zones.push({
      index: zones.length,
      level: h.level,
      title: h.title,
      zone: classifyHeading(h.title, h.level),
      start: h.start,
      end,
    })
  }
  return zones
}

/** 某分区的 hash：该区所有精确切片按文档顺序拼接 */
export function zoneHash(body, zones, zone) {
  const text = normEol(body)
  const parts = (zones || []).filter((z) => z.zone === zone).map((z) => text.slice(z.start, z.end))
  return sha256(parts.join('\n'))
}

export function allZoneHashes(body, zones) {
  const out = {}
  for (const zone of ZONES) out[zone] = zoneHash(body, zones, zone)
  return out
}

/** 分区结构摘要（UI 用）：标题 + 类型 + 字符数 + 预览 */
export function zoneOutline(body, zones) {
  const text = normEol(body)
  return (zones || []).map((z) => {
    const slice = text.slice(z.start, z.end)
    return {
      index: z.index,
      level: z.level,
      title: z.title || '（标题前）',
      zone: z.zone,
      start: z.start,
      end: z.end,
      chars: slice.length,
      preview: slice.replace(/\s+/g, ' ').trim().slice(0, 120),
      protected: z.zone === 'identity' || z.zone === 'redline',
    }
  })
}

// ── 模板 ─────────────────────────────────────────────────────────────────

export function templateCard(name, personaId) {
  const who = String(name || personaId || '这个角色')
  return [
    `# 角色设定：${who}`,
    '',
    '## 身份与外貌',
    `（待填写：${who}是谁、外貌、称呼、与用户的关系。这一段受保护：普通保存会被拒绝，需从 soul-md 导入或显式二次确认。）`,
    '',
    '## 红线',
    '（待填写：绝对不做的事。这一段受保护：普通保存会被拒绝。）',
    '',
    '## 行为准则',
    '- 语气：',
    '- 做事风格：',
    '',
    '## 风格示例',
    '用户：「……」',
    `${who}：「……」`,
    '',
  ].join('\n')
}

// ── 局部替换 ─────────────────────────────────────────────────────────────

/**
 * 用 behavior / style 替换对应分区；其余正文（含身份/红线）逐字不动。
 * @param {string} body
 * @param {Array} zones
 * @param {{behavior?:string, style?:string}} edits
 * @param {{allowFragmentMerge?:boolean}} opts
 * @returns {{ok:boolean, body?:string, code?:string, message?:string, replaced?:Array}}
 */
export function replaceZones(body, zones, edits, opts = {}) {
  const text = normEol(body)
  const ops = []
  for (const [zone, value] of Object.entries(edits || {})) {
    if (value === undefined || value === null) continue
    if (!ZONES.includes(zone)) return { ok: false, code: 'ZONE_UNKNOWN', message: `未知分区：${zone}` }
    const ranges = (zones || []).filter((z) => z.zone === zone)
    const next = normEol(value).replace(/\s+$/, '')
    if (ranges.length === 0) {
      ops.push({ zone, start: text.length, end: text.length, text: `\n\n${next}\n` })
      continue
    }
    const first = ranges[0]
    const last = ranges[ranges.length - 1]
    const between = ranges.length > 1 ? text.slice(ranges[0].end, ranges[ranges.length - 1].start) : ''
    if (ranges.length > 1 && between.trim() && !opts.allowFragmentMerge) {
      return {
        ok: false,
        code: 'ZONE_FRAGMENTED',
        message: `分区 ${zone} 在正文里不连续（${ranges.length} 段）；请保存完整正文，或显式 allowFragmentMerge=true`,
      }
    }
    ops.push({ zone, start: first.start, end: last.end, text: next + '\n\n' })
  }
  ops.sort((a, b) => b.start - a.start)
  let out = text
  for (const op of ops) out = out.slice(0, op.start) + op.text + out.slice(op.end)
  // 只保证拼接点不是「同一行粘连」；**不全局压空行**，否则会改到未编辑的分区（含身份/红线的代码块）
  return { ok: true, body: out, replaced: ops.map((o) => o.zone) }
}

/** 比较新旧卡的保护分区 */
export function protectedDiff(oldCard, newCard) {
  const out = []
  for (const zone of ['identity', 'redline']) {
    if (oldCard.zoneHashes[zone] !== newCard.zoneHashes[zone]) out.push(zone)
  }
  return out
}
