/**
 * lib/injectsource.mjs —— 「人格段从哪张卡来」的**唯一**解析口径
 *
 * 注入（index.js buildInjection）和预览（api.mjs apiPreview）必须共用这一个函数，
 * 否则就会出现「预览一套、实际一套」——2026-11-08 已经踩过一次（记忆根不同源）。
 *
 * cardSource:
 *   'soul-md'（默认/回退）→ soul-md 的 config.cards[卡名]
 *   'jianmu'            → <dataRoot>/persona/cards/<cardId>/card.md（真源切换）
 * jianmu 读不到（registry 坏 / 卡目录缺失 / 卡解析失败）→ **自动回退 soul-md**，并带 fallbackReason；
 * 只有「该工作区绑定 none」才是合法的空人格（不许把 none 当失败去回退）。
 */
import { resolveFromRegistry } from './store.mjs'
import { readRegistrySync, readCardSync } from './cardsync.mjs'

const noneResult = (reason) => ({
  ok: true, personaSource: 'none', cardId: null, name: null, persona: '', reason,
})

/**
 * 「空模板卡」判定：createCard 生成的是占位模板（身份/红线写「（待填写：…）」）。
 * 默认卡源切到 jianmu 之后，若新环境还没从 soul-md 导入卡，注入就会变成一段
 * 「（待填写：Alice是谁……」——比空人格更糟。所以模板卡一律视为「未初始化」：
 * 回退 soul-md 卡（读得到就用），读不到就退成空人格并写明原因，绝不注入占位文字。
 * 用户显式把正文清空（不含模板标记）不受影响——那是「不要人格」的合法意图。
 */
const TEMPLATE_MARK = '（待填写：'
export const isTemplateCardBody = (body) => String(body || '').includes(TEMPLATE_MARK)

/**
 * 记忆段的渲染参数（镜台自己的口径，不依赖 soul-md 配置）。
 * 这是「摘除 soul-md 依赖」的关键：卸载 soul-md 后记忆段仍要能渲染。
 */
export function memoryRenderConfig(cfg = {}) {
  return {
    memory: {
      inject: true,
      layered: cfg.memoryLayered !== false,
      recall: 'off', // 镜台尚未实现关键词召回；固定 off（与当前 soul-md 口径一致）
      indexMode: cfg.memoryIndexMode === 'recall' || cfg.memoryIndexMode === 'off' ? cfg.memoryIndexMode : 'all',
      injectMaxChars: Number(cfg.injectMaxChars) || 12000,
      order: Number.isFinite(Number(cfg.injectMemoryOrder)) ? Number(cfg.injectMemoryOrder) : 0.5,
      compactionRecall: cfg.compactionRecall === true,
      maxBytes: Number(cfg.maxBytes) || 262144,
      recallMaxTopics: Number(cfg.recallMaxTopics) || 8,
      recallMaxChars: Number(cfg.recallMaxChars) || 1600,
      path: '',
      workspaceFile: '',
    },
  }
}

export function resolvePersonaForInjection({ dataRoot, config, workspace = '', sessionId = '', cardSource = 'soul-md', soulAvailable = true }) {
  const fromSoulMd = () => {
    // soulAvailable=false 时**绝不**再从 config 取卡：调用方（buildInjection）在 soul-md
    // 读不到时会把 config 置 null，但这里再防一道——防的是「传了 config 却说不可用」的自相矛盾输入，
    // 免得某天有人改调用方时悄悄把 soul-md 又接回来。
    if (!soulAvailable) {
      return {
        ok: true, personaSource: 'soul-md', cardId: null, name: null, persona: '',
        reason: 'soul-md 配置不可读（插件已禁用/卸载？）且卡源=soul-md → 人格段不注入',
        fallbackReason: null,
      }
    }
    let name = null
    if (sessionId && config?.sessions?.[sessionId]) name = config.sessions[sessionId]
    else if (workspace && config?.workspaces?.[workspace]) name = config.workspaces[workspace]
    else if (config?.active && config.active !== 'none') name = config.active
    return {
      ok: true,
      personaSource: 'soul-md',
      cardId: null,
      name: name || null,
      persona: name ? String(config?.cards?.[name] ?? '') : '',
      reason: name ? null : '没有命中任何卡（会话/工作区/默认都没有）→ 人格段不注入',
      fallbackReason: null,
    }
  }

  if (cardSource !== 'jianmu') return fromSoulMd()

  const reg = readRegistrySync(dataRoot)
  if (!reg.ok) {
    const base = fromSoulMd()
    return { ...base, fallbackReason: `registry 读不出来（${reg.code}）→ 回退 soul-md 卡${soulAvailable ? '' : '；但 soul-md 也不可用 → 人格段为空'}` }
  }
  const resolved = resolveFromRegistry(reg.registry, { workspace, sessionId })
  if (!resolved.cardId) {
    // 合法空人格（不回退），但要分清两种原因，别把「没设默认卡」说成「绑定了 none」
    const why = resolved.source === 'none'
      ? '镜台没有设默认卡、也没命中工作区/会话绑定 → 人格段不注入'
      : `镜台显式绑定 none（${resolved.source}：${resolved.key || '—'}）→ 人格段不注入`
    return noneResult(why)
  }
  const card = readCardSync(dataRoot, resolved.cardId)
  if (!card.ok) {
    const base = fromSoulMd()
    return {
      ...base,
      fallbackReason: `镜台卡读不出来（${card.cardId || resolved.cardId}：${card.code}）→ 回退 soul-md 卡${soulAvailable ? '' : '；但 soul-md 也不可用 → 人格段为空'}`,
    }
  }
  const body = String(card.body ?? '')
  if (isTemplateCardBody(body)) {
    const base = fromSoulMd()
    return {
      ...base,
      fallbackReason: `镜台卡（${resolved.cardId}）仍是空模板（还没从 soul-md 导入）→ 回退 soul-md 卡${soulAvailable ? '' : '；但 soul-md 也不可用 → 人格段为空'}`,
    }
  }
  return {
    ok: true,
    personaSource: 'jianmu',
    cardId: resolved.cardId,
    name: card.frontMatter?.name || resolved.cardId,
    persona: body,
    file: card.file,
    matchedBy: resolved.source,
    reason: null,
    fallbackReason: null,
  }
}

/**
 * 只解析「这个人格在根藏/熏习里的 personaId」，不读卡正文（P2.5 冲突卡用）。
 * v1a 一卡一人格：优先取卡片 front-matter 的 personaId，缺省回退 cardId。
 * 只读、不猜：没有卡（含显式绑定 none）就返回 ok:false —— 冲突卡宁可不注入。
 */
export function resolvePersonaIdForScope({ dataRoot, workspace = '', sessionId = '' }) {
  let reg
  try { reg = readRegistrySync(dataRoot) } catch (e) {
    return { ok: false, code: 'REGISTRY_UNREADABLE', personaId: null, error: { code: 'REGISTRY_UNREADABLE', message: String(e?.message || e) } }
  }
  if (!reg.ok) return { ok: false, code: reg.code, personaId: null, error: reg.error || { code: reg.code, message: 'registry 不可读' } }
  const resolved = resolveFromRegistry(reg.registry, { workspace, sessionId })
  if (!resolved.cardId) return { ok: false, code: 'NO_CARD', personaId: null, cardId: null }
  let pid = resolved.cardId
  try {
    const card = readCardSync(dataRoot, resolved.cardId)
    if (card.ok && card.frontMatter?.personaId) pid = String(card.frontMatter.personaId)
  } catch { /* 卡读不出来就用 cardId；v1a 二者相等 */ }
  if (!pid) return { ok: false, code: 'NO_PERSONA', personaId: null, cardId: resolved.cardId }
  return { ok: true, cardId: resolved.cardId, personaId: pid, matchedBy: resolved.source }
}
