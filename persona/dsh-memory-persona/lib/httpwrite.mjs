/**
 * lib/httpwrite.mjs —— 镜台写路由（v1a.1）
 *
 * 只做三件事：**CSRF/JSON 校验 → 分发到 write.mjs / expand.mjs → 统一错误口径**。
 * 不新增任何写逻辑：confirm / expectedGeneration / 锁 / 路径闸门 / 写事务全在 write.mjs。
 *
 * 安全（交接书 §5.1）：
 *   · 只接受 content-type: application/json
 *   · 必须带自定义头 x-dsh-persona: 1（跨站表单带不了；浏览器会预检）
 *   · Origin / Host 同源（头存在才校验）；sec-fetch-site 禁止 cross-site
 *   · 不新增任何 CORS 头
 *   · 服务端强制 confirm:true（写动作），不信任 UI
 *
 * 错误口径：直接返回 {ok,code,error,detail}；HTTP 状态按错误码映射。
 */
import { createCard, saveCard, deleteCard, setDefaultCard, bindCard, rollbackCard, saveSettings } from './write.mjs'
import { expandPersona } from './expand.mjs'
import { apiCard } from './api.mjs'
import { readCard, readRegistry } from './store.mjs'

/** 写端点（白名单；未列出的 POST 一律 404） */
export const POST_PATHS = ['/create', '/save', '/delete', '/default', '/bind', '/rollback', '/expand', '/settings', '/register', '/claim-workspace']

const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 错误码 → HTTP 状态（UI 主要看 code，这里只保证语义不误导） */
const STATUS_BY_CODE = Object.freeze({
  BAD_JSON: 400,
  BAD_ARGS: 400,
  BAD_CARD_ID: 400,
  BAD_BINDING: 400,
  CONFIRM_REQUIRED: 400,
  EMPTY_SEED: 400,
  CARD_PARSE_FAILED: 400,
  BUDGET_EXCEEDED: 400,
  NO_MODEL_ROUTE: 400,
  UNKNOWN_SETTING: 400,
  BAD_SETTING_VALUE: 400,
  CSRF_BLOCKED: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  READ_ONLY_V1A: 403,
  DISABLED: 403,
  STALE_GENERATION: 409,
  IMMUTABLE_SECTION_CHANGED: 409,
  CARD_EXISTS: 409,
  DEFAULT_CARD_PROTECTED: 409,
  LOCK_BUSY: 409,
  CARD_ID_MISMATCH: 409,
  ZONE_FRAGMENTED: 409,
  ZONE_UNKNOWN: 409,
  VERSION_NOT_FOUND: 404,
  CARD_NOT_FOUND: 404,
  PARTIAL_WRITE: 500,
  WRITE_ATOMIC_FAILED: 500,
  WRITE_EXCLUSIVE_FAILED: 500,
  READBACK_MISMATCH: 500,
  JSONL_CORRUPT: 500,
  LLM_FAILED: 502,
  LLM_TIMEOUT: 504,
  LLM_UNAVAILABLE: 503,
  // P4 #6/#7：根藏 identity 受控写
  ROOT_SERVICE_UNAVAILABLE: 503,
  IDENTITY_UNREADABLE: 500,
  IDENTITY_CHANGED: 409,
  WORKSPACE_TAKEN: 409,
  SCAN_RED: 422,
})

function fail(status, code, message, detail) {
  return { status, body: { ok: false, code, error: { code, message, detail: detail ?? null } } }
}

/** 根藏服务（identity 的唯一写者）；没装/没加载 → null（不代写文件） */
function rootStoreService(ctx) {
  try { return ctx?.get?.('jianmuStore') || null } catch { return null }
}

/** 这张卡在镜台 registry 里绑定了哪些工作区/会话（注册与停记都用它，UI 不用自己拼） */
async function cardBindings(dataRoot, cardId) {
  const reg = await readRegistry(dataRoot)
  if (!reg.ok) return { ok: false, code: reg.code, error: reg.error }
  const workspaces = Object.entries(reg.registry?.workspaces || {}).filter(([, v]) => v === cardId).map(([k]) => k)
  const sessions = Object.entries(reg.registry?.sessions || {}).filter(([, v]) => v === cardId).map(([k]) => k)
  return { ok: true, workspaces, sessions }
}

function wrap(result) {
  if (!result || typeof result !== 'object') {
    return fail(500, 'UNKNOWN', '写动作没有返回结果')
  }
  if (result.ok === true) return { status: 200, body: result }
  const code = String(result.code || result.error?.code || 'UNKNOWN')
  const status = STATUS_BY_CODE[code] ?? (result.error ? 400 : 500)
  return { status, body: result }
}

/**
 * 写请求的 CSRF / 媒体类型闸门。只读，不消费请求体。
 * @returns {{ok:true}|{ok:false,status:number,body:object}}
 */
export function checkWriteRequest(req) {
  const headers = (req && req.headers) || {}
  const ct = String(headers['content-type'] || '').trim()
  if (!/^application\/json(?:\s*;|$)/i.test(ct)) {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '写动作只接受 content-type: application/json')
  }
  if (String(headers['x-dsh-persona'] || '') !== '1') {
    return fail(403, 'CSRF_BLOCKED', '缺少自定义头 x-dsh-persona: 1（跨站表单无法携带，这是 CSRF 防护）')
  }
  const origin = headers.origin
  if (origin) {
    let originHost = null
    try { originHost = new URL(String(origin)).host } catch { originHost = null }
    const host = String(headers.host || '')
    if (!originHost || !host || originHost.toLowerCase() !== host.toLowerCase()) {
      return fail(403, 'CSRF_BLOCKED', `Origin 与 Host 不同源（origin=${origin} host=${host}）`)
    }
  }
  const site = headers['sec-fetch-site']
  if (site && !['same-origin', 'same-site', 'none'].includes(String(site).toLowerCase())) {
    return fail(403, 'CSRF_BLOCKED', `sec-fetch-site=${site} 不是同源请求`)
  }
  return { ok: true }
}

/**
 * 读 JSON 请求体（有上限）。兼容三种宿主形态：
 *   1) Node IncomingMessage（异步可迭代）
 *   2) 已解析的 req.body 对象（宿主中间件）
 *   3) 测试夹具的 req.body 字符串
 */
export async function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  const finish = (text) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return { ok: true, value: {} }
    let value
    try { value = JSON.parse(trimmed) } catch { return { ok: false, status: 400, code: 'BAD_JSON', message: '请求体不是合法 JSON' } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 400, code: 'BAD_JSON', message: '请求体必须是 JSON 对象' }
    }
    return { ok: true, value }
  }
  if (req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return { ok: true, value: req.body }
  }
  if (req && typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > limitBytes) {
      return { ok: false, status: 413, code: 'BODY_TOO_LARGE', message: `请求体超过上限 ${limitBytes} 字节` }
    }
    return finish(req.body)
  }
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > limitBytes) return { ok: false, status: 413, code: 'BODY_TOO_LARGE', message: `请求体超过上限 ${limitBytes} 字节` }
      chunks.push(buf)
    }
    return finish(Buffer.concat(chunks).toString('utf8'))
  }
  return { ok: true, value: {} }
}

/**
 * 处理一次 POST /api/persona/<sub>。
 * @returns {{status:number, body:object}} 直接交给 res 写回
 */
export async function handleWriteRequest({ req, sub, dataRoot, ctx = null, cfg = {}, sessionId = null, hooks = {} }) {
  const guard = checkWriteRequest(req)
  if (!guard.ok) return guard
  if (cfg && cfg.enabled === false) {
    return fail(403, 'DISABLED', '镜台在设置里已关闭（dsh-memory-persona → 总开关）：不接受写动作')
  }
  if (!POST_PATHS.includes(sub)) {
    return fail(404, 'NOT_FOUND', `未知写端点：${sub}（可用：${POST_PATHS.join(' ')}）`)
  }
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return fail(parsed.status, parsed.code, parsed.message)
  const body = parsed.value

  // ── AI 生成（只回草稿，不写盘；不要求 confirm:true，但要求显式调用） ──
  if (sub === '/expand') {
    if (cfg && cfg.expandEnabled === false) {
      return fail(403, 'DISABLED', 'AI 生成已在设置里关闭（expandEnabled=false）')
    }
    let existingCard = null
    if (body.cardId) {
      const c = await apiCard({ dataRoot, cardId: String(body.cardId) })
      if (c.ok) existingCard = c.body
    }
    const r = await expandPersona({
      ctx,
      sessionId,
      seed: body.seed,
      existingContent: body.existingContent,
      existingCard,
      name: body.name,
      confirmOverwrite: body.confirmOverwrite === true,
      cfg,
    })
    return wrap(r)
  }

  // ── 以下全是写动作：服务端强制 confirm:true，不信任 UI ──
  if (body.confirm !== true) {
    return fail(400, 'CONFIRM_REQUIRED', '写动作必须在请求体里带 confirm: true')
  }

  if (sub === '/create') {
    if (!body.cardId) return fail(400, 'BAD_ARGS', 'create 需要 cardId')
    return wrap(await createCard({
      dataRoot,
      cardId: String(body.cardId),
      name: body.name,
      personaId: body.personaId,
      memoryScope: body.memoryScope,
      content: body.content,
      expectedGeneration: body.expectedGeneration,
      confirm: true,
    }))
  }

  if (sub === '/save') {
    if (!body.cardId) return fail(400, 'BAD_ARGS', 'save 需要 cardId（v1a.1 的 UI 总是显式传，避免写错卡）')
    return wrap(await saveCard({
      dataRoot,
      cardId: String(body.cardId),
      content: body.content,
      behavior: body.behavior,
      style: body.style,
      note: body.note,
      author: body.author === 'ai-expand' ? 'ai-expand' : 'user',
      expectedGeneration: body.expectedGeneration,
      confirm: true,
      allowProtectedSectionsChange: body.allowProtectedSectionsChange === true,
    }))
  }

  if (sub === '/delete') {
    if (!body.cardId) return fail(400, 'BAD_ARGS', 'delete 需要 cardId')
    const mode = body.mode === 'stop' ? 'stop' : 'archive'
    const cardId = String(body.cardId)
    let unregister = null
    if (mode === 'stop') {
      // 「停记」：先把指向该人格的映射摘掉（只摘映射、不删记忆），再归档卡。
      // 顺序不能反：反了会出现「卡没了、identity 还在继续记」的最坏状态。
      // 但默认卡本来就不能删：必须在摘映射之前拦下，否则会「映射没了、卡还在」。
      const reg = await readRegistry(dataRoot)
      if (reg.ok && reg.registry?.activeCardId === cardId) {
        return fail(409, 'DEFAULT_CARD_PROTECTED', '默认卡不能删：先把默认卡改成别的卡（或 none），再删除/停记')
      }
      const card = await readCard(dataRoot, cardId)
      if (!card.ok) return wrap(card)
      const binds = await cardBindings(dataRoot, cardId)
      if (!binds.ok) return wrap(binds)
      const svc = rootStoreService(ctx)
      if (!svc || typeof svc.identityRemoveMappings !== 'function') {
        return fail(503, 'ROOT_SERVICE_UNAVAILABLE', '没装/没加载根藏（dsh-memory-store）：无法「停记」。可先只归档卡，或装好根藏再试。')
      }
      const personaId = String(card.frontMatter?.personaId || cardId)
      if (binds.workspaces.length || binds.sessions.length) {
        unregister = await svc.identityRemoveMappings({
          personaId, workspaces: binds.workspaces, sessions: binds.sessions, dryRun: false, confirm: true,
        })
        if (!unregister?.ok) return wrap(unregister || { ok: false, code: 'IDENTITY_REMOVE_FAILED', error: { code: 'IDENTITY_REMOVE_FAILED', message: '停记失败：没有归档卡（可重试）' } })
      } else {
        unregister = { ok: true, noop: true, removed: { workspaces: [], sessions: [] }, note: '这张卡没有绑定工作区/会话，无需停记' }
      }
    }
    const del = await deleteCard({
      dataRoot,
      cardId,
      expectedGeneration: body.expectedGeneration,
      confirm: true,
    })
    return wrap({ ...del, mode, unregister })
  }

  if (sub === '/register') {
    if (!body.cardId) return fail(400, 'BAD_ARGS', 'register 需要 cardId')
    const cardId = String(body.cardId)
    const card = await readCard(dataRoot, cardId)
    if (!card.ok) return wrap(card)
    const binds = await cardBindings(dataRoot, cardId)
    if (!binds.ok) return wrap(binds)
    const svc = rootStoreService(ctx)
    if (!svc || typeof svc.identityAddPersona !== 'function') {
      return fail(503, 'ROOT_SERVICE_UNAVAILABLE', '没装/没加载根藏（dsh-memory-store）：无法登记到 identity.json。装好根藏后再点一次即可。')
    }
    const personaId = String(card.frontMatter?.personaId || cardId)
    const displayName = String(card.frontMatter?.name || cardId)
    const r = await svc.identityAddPersona({
      personaId, displayName, workspaces: binds.workspaces, sessions: binds.sessions,
      dryRun: false, confirm: true,
    })
    return wrap({ ...(r || {}), workspaces: binds.workspaces, sessions: binds.sessions })
  }

  // P4 #8：认领一个未归属工作区到当前卡（软认领：只补 identity 映射 + 绑定卡，不搬数据）
  if (sub === '/claim-workspace') {
    const workspace = String(body.workspace || '').trim()
    if (!workspace) return fail(400, 'BAD_ARGS', 'claim-workspace 需要 workspace（真实路径）')
    if (!body.cardId) return fail(400, 'BAD_ARGS', 'claim-workspace 需要 cardId（归到哪张卡）')
    const cardId = String(body.cardId)
    const card = await readCard(dataRoot, cardId)
    if (!card.ok) return wrap(card)
    const svc = rootStoreService(ctx)
    if (!svc || typeof svc.identityAddPersona !== 'function') {
      return fail(503, 'ROOT_SERVICE_UNAVAILABLE', '没装/没加载根藏（dsh-memory-store）：无法认领工作区。')
    }
    const personaId = String(card.frontMatter?.personaId || cardId)
    const displayName = String(card.frontMatter?.name || cardId)
    const reg = await svc.identityAddPersona({
      personaId, displayName, workspaces: [workspace], sessions: [], dryRun: false, confirm: true,
    })
    if (!reg?.ok) return wrap(reg)
    const claimed = (reg.changes?.workspacesAdded || []).includes(workspace)
      || (reg.changes?.workspacesReassigned || []).some((x) => x.workspace === workspace)
    const taken = (reg.skipped || []).some((x) => x.kind === 'workspace' && x.key === workspace)
    if (!claimed && (taken || reg.noop !== true)) {
      return fail(409, 'WORKSPACE_TAKEN', `工作区「${workspace}」已属于其他人格，未认领（不会静默改归属）`, { warnings: reg.warnings || [] })
    }
    // identity 是记忆归属的核心；卡绑定是注入层，失败不算认领失败（可稍后重试）
    let binding = null
    try {
      binding = await bindCard({
        dataRoot,
        scope: 'workspace',
        key: workspace,
        cardId,
        expectedGeneration: body.expectedGeneration,
        confirm: true,
      })
    } catch (e) {
      binding = { ok: false, code: e?.code || 'BIND_FAILED', error: { code: e?.code || 'BIND_FAILED', message: String(e?.message || e) } }
    }
    const warnings = [...(reg.warnings || [])]
    if (binding && binding.ok === false) warnings.push('身份映射已写好（旧记忆可被这个人格检索到），但卡片绑定失败：请到「默认与绑定」手动把该工作区绑到这张卡')
    return wrap({
      ...reg, workspace, cardId, personaId, binding,
      softClaim: { applied: true, workspace, note: '不搬数据、不重嵌；旧块会被这个人格影子纳入检索，移除 identity 映射即回退' },
      warnings,
    })
  }

  if (sub === '/default') {
    const target = body.cardId === undefined || body.cardId === null ? '' : String(body.cardId)
    if (!target) return fail(400, 'BAD_ARGS', 'default 需要 cardId（none = 全局不注入）')
    return wrap(await setDefaultCard({
      dataRoot,
      cardId: target,
      expectedGeneration: body.expectedGeneration,
      confirm: true,
    }))
  }

  if (sub === '/bind') {
    if (!body.scope) return fail(400, 'BAD_ARGS', 'bind 需要 scope（workspace / session）')
    if (body.key === undefined || body.key === null || String(body.key).trim() === '') {
      return fail(400, 'BAD_ARGS', 'bind 需要 key')
    }
    if (body.cardId === undefined || body.cardId === null) {
      return fail(400, 'BAD_ARGS', 'bind 需要 cardId（空字符串 = 删除绑定；none = 该范围不注入）')
    }
    return wrap(await bindCard({
      dataRoot,
      scope: String(body.scope),
      key: String(body.key),
      cardId: String(body.cardId),
      expectedGeneration: body.expectedGeneration,
      confirm: true,
    }))
  }

  if (sub === '/rollback') {
    if (!body.cardId) return fail(400, 'BAD_ARGS', 'rollback 需要 cardId')
    return wrap(await rollbackCard({
      dataRoot,
      cardId: String(body.cardId),
      revision: body.revision,
      expectedGeneration: body.expectedGeneration,
      confirm: true,
    }))
  }

  if (sub === '/settings') {
    const r = await saveSettings({
      dataRoot,
      patch: body.patch,
      expectedGeneration: body.expectedGeneration,
      confirm: true,
    })
    if (!r.ok) return wrap(r)
    // 设置真的变了才清缓存 / 补注册注入段
    try { hooks.onSettingsSaved?.(r) } catch { /* 钩子失败不影响写入结果 */ }
    return wrap(r)
  }

  return fail(404, 'NOT_FOUND', `未知写端点：${sub}`)
}
