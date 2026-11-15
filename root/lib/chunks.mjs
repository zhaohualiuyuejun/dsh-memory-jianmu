/**
 * lib/chunks.mjs —— 原话块（utterance）的构造、校验、旧库换算
 *
 * 唯一真源的一行 = 契约 2.2 的 utterance。字段一旦冻结，只加可选字段。
 * id = sha256(session | messageId | seq | part | normalizedText)
 *   ⇒ 同一会话重复摄取幂等；同一条消息切多块时 part 参与指纹。
 */
import { createHash } from 'node:crypto'
import { CONTRACT_VERSION, SCHEMA_VERSION, INGEST_VERSION } from './version.mjs'
import { prettyWorkspace, PERSONA_UNASSIGNED } from './paths.mjs'

export const ROLE_VALUES = Object.freeze(['user', 'assistant', 'tool', 'system'])
export const SOURCE_TYPE_VALUES = Object.freeze(['user', 'assistant', 'tool', 'injected'])
export const CHANNEL_VALUES = Object.freeze(['dsh', 'qq', 'wechat', 'file'])
export const IDENTITY_SOURCE_VALUES = Object.freeze(['session', 'workspace', 'default', 'manual', 'unassigned'])
export const RETENTION_VALUES = Object.freeze(['active', 'expired'])

/** 归一化只做两件事：CRLF→LF、去首尾空白。不做折叠（会把不同原话合并） */
export function normalizeText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

/** 内容指纹 */
export function makeChunkId({ session, messageId, seq, part, text }) {
  const payload = [
    String(session ?? ''),
    messageId == null ? '' : String(messageId),
    seq == null ? '' : String(seq),
    part == null ? 0 : String(part),
    normalizeText(text),
  ].join('|')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** 迁移源行指纹（旧库没有 sourceHash；用旧行本身做指纹，能发现旧库行变了） */
export function legacyRowHash(row) {
  const payload = [
    row?.session ?? '', row?.role ?? '', row?.t ?? '', row?.part ?? 0,
    row?.msgId ?? '', row?.seq ?? '', normalizeText(row?.text),
  ].join('|')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** 旧 sourceType → 新枚举（bridge 后缀折叠，原始值留在 provenance） */
export function foldLegacySourceType(legacy, role) {
  const s = String(legacy || '').trim()
  if (SOURCE_TYPE_VALUES.includes(s)) return s
  if (s === 'user-bridge') return 'user'
  if (s === 'assistant-bridge') return 'assistant'
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool') return 'tool'
  return 'injected'
}

/** 通道推断（v1 尽力而为；v1.1 起由桥接显式写入） */
export function inferChannel(ws, session = '') {
  const s = `${ws || ''} ${session || ''}`
  if (/dsh[_-]?wechat/i.test(s)) return 'wechat'
  if (/[\\/]qq[\\/]|dsh-qq|qq-state/i.test(s)) return 'qq'
  if (/[\\/]bili[\\/]?duty|example-duty/i.test(s)) return 'dsh'
  return 'dsh'
}

/** 校验一行 chunk；返回错误数组（空 = ok） */
export function validateChunk(c) {
  const errs = []
  if (!c || typeof c !== 'object') return ['不是对象']
  if (c.kind !== 'utterance') errs.push(`kind 必须是 utterance（读到 ${JSON.stringify(c.kind)}）`)
  if (typeof c.id !== 'string' || !/^[0-9a-f]{64}$/.test(c.id)) errs.push('id 必须是 64 位 hex')
  if (typeof c.session !== 'string' || !c.session) errs.push('session 必须是非空字符串')
  if (!c.personaId || (c.personaId !== PERSONA_UNASSIGNED && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.personaId))) {
    errs.push(`personaId 非法：${JSON.stringify(c.personaId)}`)
  }
  if (!IDENTITY_SOURCE_VALUES.includes(c.identitySource)) errs.push(`identitySource 非法：${JSON.stringify(c.identitySource)}`)
  if (!ROLE_VALUES.includes(c.role)) errs.push(`role 非法：${JSON.stringify(c.role)}`)
  if (!Number.isFinite(c.t) || c.t <= 0) errs.push('t 必须是正的 epoch ms 数字')
  // 原话原样存；只允许「内容为空/纯空白」被判无效（判定用归一化文本，不 trim 存储值）
  if (typeof c.text !== 'string' || !normalizeText(c.text)) errs.push('text 必须是非空字符串')
  if (c.part != null && (!Number.isInteger(c.part) || c.part < 0)) errs.push('part 必须是非负整数')
  if (c.seq != null && !Number.isInteger(c.seq)) errs.push('seq 必须是整数或 null')
  if (c.turn != null && (!Number.isInteger(c.turn) || c.turn < 1)) errs.push('turn 必须是正整数或 null')
  if (c.sourceType != null && !SOURCE_TYPE_VALUES.includes(c.sourceType)) errs.push(`sourceType 非法：${JSON.stringify(c.sourceType)}`)
  if (c.channel != null && !CHANNEL_VALUES.includes(c.channel)) errs.push(`channel 非法：${JSON.stringify(c.channel)}`)
  if (c.retention != null && !RETENTION_VALUES.includes(c.retention)) errs.push(`retention 非法：${JSON.stringify(c.retention)}`)
  if (c.attachments != null && !Array.isArray(c.attachments)) errs.push('attachments 必须是数组')
  if (c.schemaVersion != null && c.schemaVersion > SCHEMA_VERSION) errs.push(`schemaVersion ${c.schemaVersion} > 本程序 ${SCHEMA_VERSION}`)
  if (c.contractVersion != null && c.contractVersion > CONTRACT_VERSION) errs.push(`contractVersion ${c.contractVersion} > 本程序 ${CONTRACT_VERSION}`)
  return errs
}

/**
 * 造一行规范 utterance。字段顺序固定，方便人肉比对。
 * ⚠️ `text` 原样保存（不 trim、不改写）——契约 §2「原话原样」；
 *    归一化只用于 `id` 的计算（normalizeText）。
 */
export function makeUtterance(input) {
  const text = String(input.text ?? '')
  const row = {
    id: input.id || makeChunkId({ session: input.session, messageId: input.messageId ?? input.msgId, seq: input.seq, part: input.part ?? 0, text }),
    kind: 'utterance',
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    session: String(input.session || ''),
    personaId: input.personaId,
    identitySource: input.identitySource || 'unassigned',
    messageId: input.messageId ?? input.msgId ?? null,
    seq: input.seq ?? null,
    turn: input.turn ?? null,
    part: input.part ?? 0,
    role: input.role,
    sourceType: input.sourceType || foldLegacySourceType(null, input.role),
    t: Number(input.t),
    tz: input.tz || 'Asia/Shanghai',
    text,
    ws: input.ws || null,
    wsDir: input.wsDir || null,
    channel: input.channel || 'dsh',
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    sourceHash: input.sourceHash || null,
    retention: input.retention || 'active',
    ingestVersion: INGEST_VERSION,
    ...(input.provenance ? { provenance: input.provenance } : {}),
  }
  return row
}

/**
 * 旧寻枝库的一块 → 新 utterance。
 * identitySource 由调用方决定（迁移时用源级映射 → 'manual'；工作区命中 → 'workspace'）。
 */
export function legacyToUtterance(row, opts) {
  const {
    personaId,
    identitySource = 'manual',
    displayName = null,
    sourceId = null,
    rowIndex = null,
    legacyBuiltAt = null,
    legacySourceType = null,
    ws = null,
  } = opts || {}
  const realWs = ws || row?.wsPretty || prettyWorkspace(row?.ws)
  const prov = {
    migratedFrom: 'dsh-semantic-recall',
    legacyScope: sourceId,
    legacyRowIndex: rowIndex,
    legacyBuiltAt,
  }
  if (legacySourceType && legacySourceType !== row?.sourceType) prov.legacySourceType = legacySourceType
  if (row?.sourceType && !SOURCE_TYPE_VALUES.includes(row.sourceType)) prov.legacySourceType = row.sourceType
  const utt = makeUtterance({
    session: row?.session,
    personaId,
    identitySource,
    messageId: row?.msgId ?? null,
    seq: row?.seq ?? null,
    part: row?.part ?? 0,
    role: row?.role,
    sourceType: foldLegacySourceType(row?.sourceType, row?.role),
    t: row?.t,
    text: row?.text,
    ws: realWs,
    wsDir: row?.ws || null,
    channel: inferChannel(realWs, row?.session),
    attachments: [],
    sourceHash: legacyRowHash(row),
    retention: 'active',
    provenance: prov,
  })
  if (displayName) prov.displayName = displayName
  return utt
}

/** 统计块数/会话数/工作区数/时间范围 */
export function summarizeChunks(rows) {
  const sessions = new Set()
  const workspaces = new Set()
  const personas = new Map()
  let minT = Infinity
  let maxT = -Infinity
  for (const c of rows) {
    sessions.add(c.session)
    if (c.ws) workspaces.add(c.ws)
    personas.set(c.personaId, (personas.get(c.personaId) || 0) + 1)
    if (Number.isFinite(c.t)) {
      if (c.t < minT) minT = c.t
      if (c.t > maxT) maxT = c.t
    }
  }
  return {
    chunks: rows.length,
    sessions: sessions.size,
    workspaces: workspaces.size,
    personas: Object.fromEntries(personas),
    tMin: Number.isFinite(minT) ? minT : null,
    tMax: Number.isFinite(maxT) ? maxT : null,
  }
}
