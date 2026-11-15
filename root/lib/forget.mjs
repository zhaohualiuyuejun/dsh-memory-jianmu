/**
 * lib/forget.mjs —— 显式「忘记」（Stage 0 / F6）
 *
 * 红线：**永远不物理删 chunks.jsonl**。
 * 忘记 = 往 deleted.jsonl 追加一条墓碑；宽限期内可 revive（追加一条 revive 行，读墓碑时按最新状态裁决）。
 * 写前必须快照（chunks.jsonl + deleted.jsonl），并提交指纹；没有 confirm 只返回预览，不落盘。
 *
 * 语义：
 *   · forget  → 该块对检索/年轮不可见（各层读墓碑后过滤）
 *   · revive  → 撤销忘记（只追加，不改旧行）
 *   · graceUntil → 宽限期，UI/工具提示「在此之前可撤销」
 */
import { basename } from 'node:path'
import { archiveBeforeWrite, commitFingerprint } from './backup.mjs'
import { readScopeChunks } from './store.mjs'
import { appendJsonl } from './fsatomic.mjs'
import { chunksPath, deletedPath, isSafePersonaId, PERSONA_UNASSIGNED } from './paths.mjs'

const MAX_BATCH = 500

function validPersona(pid) {
  return pid === PERSONA_UNASSIGNED || isSafePersonaId(pid)
}

function badArgs(code, message) {
  return { ok: false, code, error: { code, message } }
}

function head(text, n = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 解析目标块（id 列表或整个会话），只读 */
async function resolveTargets({ dataRoot, personaId, chunkIds, sessionId }) {
  if (!validPersona(personaId)) return badArgs('BAD_PERSONA_ID', `personaId 非法：${personaId}`)
  const wanted = Array.isArray(chunkIds) ? chunkIds.map((x) => String(x || '').trim()).filter(Boolean) : []
  const sid = String(sessionId || '').trim()
  if (!wanted.length && !sid) return badArgs('BAD_ARGS', '必须给 chunkIds（数组）或 sessionId（整个会话）')

  const chunks = await readScopeChunks(dataRoot, personaId)
  const byId = new Map(chunks.rows.map((r) => [r.id, r]))
  let rows = []
  const missing = []
  if (wanted.length) {
    if (wanted.length > MAX_BATCH) return badArgs('TOO_MANY', `一次最多忘记 ${MAX_BATCH} 块（本次 ${wanted.length}）`)
    for (const id of [...new Set(wanted)]) {
      const r = byId.get(id)
      if (r) rows.push(r)
      else missing.push(id)
    }
  } else {
    rows = chunks.rows.filter((r) => r && r.session === sid)
    if (rows.length > MAX_BATCH) return badArgs('TOO_MANY', `会话 ${sid} 有 ${rows.length} 块，超过单次上限 ${MAX_BATCH}；请按 chunkIds 分批`)
  }
  return { ok: true, rows, missing, sessionId: sid || null, chunksFile: chunksPath(dataRoot, personaId), totalChunks: chunks.rows.length }
}

/** 预览：只读，不写 */
export async function forgetPreview({ dataRoot, personaId, chunkIds = null, sessionId = null, graceDays = 7, now = Date.now() }) {
  const t = await resolveTargets({ dataRoot, personaId, chunkIds, sessionId })
  if (!t.ok) return t
  const grace = clampGrace(graceDays)
  const sessions = new Map()
  for (const r of t.rows) sessions.set(r.session || '(未知)', (sessions.get(r.session || '(未知)') || 0) + 1)
  return {
    ok: true,
    preview: true,
    personaId,
    count: t.rows.length,
    missing: t.missing,
    sessions: [...sessions.entries()].map(([session, count]) => ({ session, count })),
    sample: t.rows.slice(0, 10).map((r) => ({ id: r.id, session: r.session ?? null, t: r.t ?? null, role: r.role ?? null, text: head(r.text) })),
    totalChunks: t.totalChunks,
    graceDays: grace,
    undoUntil: new Date(now + grace * 86400000).toISOString(),
    confirmHint: '确认要写：重复调用并传 confirm=true（会先快照，再追加墓碑；数据不会物理删除）',
  }
}

/** 执行忘记：快照 → 追加墓碑 */
export async function forgetChunks({ dataRoot, personaId, chunkIds = null, sessionId = null, reason = 'user:forget', graceDays = 7, confirm = false, now = Date.now() }) {
  const t = await resolveTargets({ dataRoot, personaId, chunkIds, sessionId })
  if (!t.ok) return t
  const grace = clampGrace(graceDays)
  const undoUntil = new Date(now + grace * 86400000).toISOString()
  if (!confirm) {
    return {
      ok: false,
      code: 'CONFIRM_REQUIRED',
      error: { code: 'CONFIRM_REQUIRED', message: '忘记必须二次确认：先看预览，再传 confirm=true' },
      preview: {
        personaId, count: t.rows.length, missing: t.missing,
        sessions: [...new Set(t.rows.map((r) => r.session).filter(Boolean))],
        sample: t.rows.slice(0, 5).map((r) => ({ id: r.id, text: head(r.text) })),
        graceDays: grace, undoUntil,
      },
    }
  }
  if (!t.rows.length) return { ok: false, code: 'NOT_FOUND', error: { code: 'NOT_FOUND', message: '没有匹配到任何块（可能已被忘记或 id 不存在）' } }

  // 写前快照（两个文件都备份；备份独占创建，绝不覆盖旧备份）
  const backup = await archiveBeforeWrite(dataRoot, personaId, [t.chunksFile, deletedPath(dataRoot, personaId)], 'forget')
  await commitFingerprint(backup, { action: 'forget', count: t.rows.length, reason, graceDays: grace })

  const at = new Date(now).toISOString()
  const rows = t.rows.map((r) => ({
    id: r.id,
    action: 'forget',
    deletedAt: at,
    reason: String(reason || 'user:forget'),
    graceUntil: undoUntil,
    backup: basename(backup.dir),
  }))
  await appendJsonl(deletedPath(dataRoot, personaId), rows, { durable: true })

  return {
    ok: true,
    personaId,
    forgotten: rows.length,
    missing: t.missing,
    graceDays: grace,
    undoUntil,
    backup: { dir: backup.dir, files: backup.files.map((f) => f.name) },
    hint: `已写墓碑 ${rows.length} 条（原话未物理删除）。宽限期内可用 jianmu_store_revive 撤销。`,
  }
}

/** 撤销忘记：追加 revive 行（不改旧行） */
export async function reviveChunks({ dataRoot, personaId, chunkIds = [], reason = 'user:revive', confirm = false, now = Date.now() }) {
  if (!validPersona(personaId)) return badArgs('BAD_PERSONA_ID', `personaId 非法：${personaId}`)
  const ids = [...new Set((Array.isArray(chunkIds) ? chunkIds : []).map((x) => String(x || '').trim()).filter(Boolean))]
  if (!ids.length) return badArgs('BAD_ARGS', 'chunkIds 必填（数组）')
  if (!confirm) return { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: '撤销忘记需要 confirm=true' } }

  const backup = await archiveBeforeWrite(dataRoot, personaId, [deletedPath(dataRoot, personaId)], 'revive')
  await commitFingerprint(backup, { action: 'revive', count: ids.length, reason })
  const at = new Date(now).toISOString()
  await appendJsonl(deletedPath(dataRoot, personaId), ids.map((id) => ({ id, action: 'revive', revivedAt: at, reason })), { durable: true })
  return {
    ok: true,
    personaId,
    revived: ids.length,
    backup: { dir: backup.dir, files: backup.files.map((f) => f.name) },
    hint: '已写 revive 行；各层读墓碑时会按最新状态裁决。',
  }
}

function clampGrace(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 7
  return Math.max(0, Math.min(90, Math.floor(n)))
}
