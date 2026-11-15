/**
 * lib/settings.mjs —— 镜台的注入设置（v2 可写）
 *
 * 为什么不是写 cordis.patch.yml / ctx.settings.update：
 *   - 本机 DSH 的 `ctx.settings.update()` 返回成功但不落盘（寻枝 2026-10-31 实测），
 *     改 patch YAML 又要重启才生效；
 *   - 施工计划 §3.4 已拍板「v2 写进 registry.settings，注入由镜台执行」。
 * 所以：`<dataRoot>/persona/registry.json` 的 `settings` 字段 = 唯一权威层，
 * 优先级 DEFAULTS(代码) < patch 配置行 < registry.settings（用户当场改的）。
 *
 * 本模块只做「读 / 归一 / 校验」；落盘走 lib/write.mjs 的 saveSettings（带锁 + CAS + 原子写）。
 */
import { readFileSync, statSync } from 'node:fs'
import { registryFile } from './paths.mjs'

/** 镜台自己管的注入设置字段（与 index.js 的 DEFAULTS 对齐） */
export const INJECT_SETTINGS_KEYS = Object.freeze([
  'injectEnabled',
  'injectMaxChars',
  'injectPersonaOrder',
  'injectMemoryOrder',
  'injectCacheMs',
  'cardSource',
  'memoryLayered',
  'memoryIndexMode',
  'subagentSkip',
  'recallMaxTopics',
  'recallMaxChars',
  'compactionRecall',
  'maxBytes',
  // P2 自动召回（2026-11-12，默认关）
  'autoRecall',
  'autoRecallMinScore',
  'autoRecallTopN',
  'autoRecallMaxChars',
  'autoRecallDeadlineMs',
  'autoRecallWaitMs',
  'autoRecallCooldownMs',
  'autoRecallCues',
  'autoRecallLabOnly',
  'autoRecallLabWorkspaces',
  // P2.5 冲突卡（2026-11-12，默认关、只读）
  'conflictCard',
])

/** 合法区间：越界不静默截断，直接拒绝，免得「改了个数却不像自己想要的」 */
export const INJECT_SETTINGS_LIMITS = Object.freeze({
  injectMaxChars: { min: 500, max: 200000, step: 100 },
  injectPersonaOrder: { min: -100, max: 100 },
  injectMemoryOrder: { min: -100, max: 100 },
  injectCacheMs: { min: 0, max: 600000, step: 100 },
  recallMaxTopics: { min: 1, max: 20, step: 1 },
  recallMaxChars: { min: 200, max: 8000, step: 100 },
  maxBytes: { min: 1024, max: 10485760, step: 1024 },
  autoRecallMinScore: { min: 0.3, max: 0.95, step: 0.01 },
  autoRecallTopN: { min: 1, max: 5, step: 1 },
  autoRecallMaxChars: { min: 100, max: 2000, step: 20 },
  autoRecallDeadlineMs: { min: 100, max: 5000, step: 50 },
  autoRecallWaitMs: { min: 0, max: 3000, step: 50 },
  autoRecallCooldownMs: { min: 0, max: 3600000, step: 1000 },
})

const BOOL_KEYS = new Set(['injectEnabled', 'memoryLayered', 'subagentSkip', 'compactionRecall', 'autoRecall', 'autoRecallLabOnly', 'conflictCard'])
const NUM_KEYS = new Set([
  'injectMaxChars', 'injectPersonaOrder', 'injectMemoryOrder', 'injectCacheMs', 'recallMaxTopics', 'recallMaxChars', 'maxBytes',
  'autoRecallMinScore', 'autoRecallTopN', 'autoRecallMaxChars', 'autoRecallDeadlineMs', 'autoRecallWaitMs', 'autoRecallCooldownMs',
])
/** 字符串型字段（线索词 / 工作区列表；有长度上限，防止把整段提示词塞进来） */
const STRING_KEYS = { autoRecallCues: 500, autoRecallLabWorkspaces: 500 }
/** 枚举型字段：只接受列出的值（拼错就拒绝，别让它静默退默认） */
const ENUM_KEYS = {
  cardSource: ['soul-md', 'jianmu'],
  memoryIndexMode: ['all', 'recall', 'off'],
}

/**
 * 从 registry.settings 里只挑合法字段（读路径用；脏值忽略，不抛异常）。
 * @returns {object} 只有明确存在的合法字段
 */
export function pickInjectSettings(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of INJECT_SETTINGS_KEYS) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (BOOL_KEYS.has(key)) {
      if (typeof v === 'boolean') out[key] = v
      continue
    }
    if (NUM_KEYS.has(key)) {
      if (typeof v !== 'number' && typeof v !== 'string') continue
      const n = Number(v)
      if (!Number.isFinite(n)) continue
      const lim = INJECT_SETTINGS_LIMITS[key]
      if (lim && (n < lim.min || n > lim.max)) continue
      out[key] = n
      continue
    }
    if (ENUM_KEYS[key]) {
      if (typeof v === 'string' && ENUM_KEYS[key].includes(v)) out[key] = v
      continue
    }
    if (STRING_KEYS[key]) {
      if (typeof v === 'string' && v.length <= STRING_KEYS[key]) out[key] = v
    }
  }
  return out
}

// ── 同步读取（注入热路径：buildInjection 每轮都要 liveCfg） ────────────────
// registry.json 只有几 KB；用 mtime+size 做一次缓存，避免每轮都 JSON.parse。
const syncCache = new Map() // file → { mtimeMs, size, value }

/** 写完 registry.json 后主动丢缓存：不赌 mtime/size 一定能变（同尺寸快写在 NTFS 上可能撞车） */
export function invalidateRegistrySettingsSync(file) {
  if (file) syncCache.delete(file)
  else syncCache.clear()
}

export function readRegistrySettingsSync(dataRoot) {
  const file = registryFile(dataRoot)
  let st
  try {
    st = statSync(file)
  } catch {
    syncCache.delete(file)
    return { ok: true, settings: {}, revision: 0, file, exists: false }
  }
  const hit = syncCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
  let value
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const settings = pickInjectSettings(raw?.settings)
    const revision = Number(raw?.settingsRevision) || 0
    value = { ok: true, settings, revision, file, exists: true, updatedAt: Number(raw?.settingsUpdatedAt) || null }
  } catch (e) {
    // 读坏了不能拖垮注入：回退「没有设置」，但要如实告诉调用方
    value = { ok: false, code: 'REGISTRY_UNREADABLE', error: { code: 'REGISTRY_UNREADABLE', message: `registry.json 读不出来：${String(e?.message || e)}` }, settings: {}, revision: 0, file, exists: true }
  }
  syncCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

/** 合并三个来源：代码默认 < 配置行(patch) < registry.settings；返回 { cfg, source } */
export function mergeInjectSettings(base, registrySettings) {
  const out = { ...base }
  let source = 'config'
  for (const key of INJECT_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(registrySettings || {}, key)) {
      out[key] = registrySettings[key]
      source = 'registry'
    }
  }
  return { cfg: out, source }
}

/**
 * 校验一次写入的 patch：不认识的键 → 拒绝（防止拼错字段静默不生效）。
 * @returns {{ok:true, value:object}|{ok:false, code:string, error:object}}
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'patch 必须是对象，例如 {"injectMaxChars":12000}' } }
  }
  const keys = Object.keys(patch)
  if (!keys.length) {
    return { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: 'patch 是空的：至少要给一个字段' } }
  }
  const unknown = keys.filter((k) => !INJECT_SETTINGS_KEYS.includes(k))
  if (unknown.length) {
    return {
      ok: false, code: 'UNKNOWN_SETTING',
      error: { code: 'UNKNOWN_SETTING', message: `不认识的字段：${unknown.join('、')}（可用：${INJECT_SETTINGS_KEYS.join('、')}）`, allowed: INJECT_SETTINGS_KEYS },
    }
  }
  const out = {}
  for (const key of keys) {
    const v = patch[key]
    if (BOOL_KEYS.has(key)) {
      if (typeof v !== 'boolean') {
        return { ok: false, code: 'BAD_SETTING_VALUE', error: { code: 'BAD_SETTING_VALUE', message: `${key} 只接受 true / false` } }
      }
      out[key] = v
      continue
    }
    if (ENUM_KEYS[key]) {
      if (typeof v !== 'string' || !ENUM_KEYS[key].includes(v)) {
        return {
          ok: false, code: 'BAD_SETTING_VALUE',
          error: { code: 'BAD_SETTING_VALUE', message: `${key} 只接受 ${ENUM_KEYS[key].join(' / ')}` },
        }
      }
      out[key] = v
      continue
    }
    if (STRING_KEYS[key]) {
      if (typeof v !== 'string' || v.length > STRING_KEYS[key]) {
        return {
          ok: false, code: 'BAD_SETTING_VALUE',
          error: { code: 'BAD_SETTING_VALUE', message: `${key} 只接受不超过 ${STRING_KEYS[key]} 字的字符串` },
        }
      }
      out[key] = v
      continue
    }
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return { ok: false, code: 'BAD_SETTING_VALUE', error: { code: 'BAD_SETTING_VALUE', message: `${key} 只接受数字` } }
    }
    const lim = INJECT_SETTINGS_LIMITS[key]
    if (lim && (n < lim.min || n > lim.max)) {
      return {
        ok: false, code: 'BAD_SETTING_VALUE',
        error: { code: 'BAD_SETTING_VALUE', message: `${key} 超出范围：${n}（允许 ${lim.min}~${lim.max}）` },
      }
    }
    out[key] = n
  }
  return { ok: true, value: out }
}

/** 给 UI / 工具看的可写能力描述 */
export function settingsCapabilities() {
  return {
    keys: [...INJECT_SETTINGS_KEYS],
    limits: { ...INJECT_SETTINGS_LIMITS },
    enums: { cardSource: ['soul-md', 'jianmu'], memoryIndexMode: ['all', 'recall', 'off'] },
    strings: { autoRecallCues: '线索词用 | 分隔；留空用默认词表', autoRecallLabWorkspaces: '只在这些工作区生效（逗号分隔；空=只认路径含 tester 的）' },
    defaults: {
      cardSource: 'jianmu', memoryLayered: true, memoryIndexMode: 'all',
      autoRecall: false, autoRecallMinScore: 0.62, autoRecallTopN: 2, autoRecallMaxChars: 320,
      autoRecallDeadlineMs: 800, autoRecallWaitMs: 800, autoRecallCooldownMs: 60000,
      autoRecallLabOnly: true, autoRecallLabWorkspaces: '',
      conflictCard: false,
    },
    liveEffect: {
      injectEnabled: '当场生效（关闭立即停注入；打开时注入段会即时补注册）',
      injectMaxChars: '下一轮生效（渲染缓存过期后）',
      injectCacheMs: '当场生效',
      injectPersonaOrder: '需重启（段顺序在启动时注册）',
      injectMemoryOrder: '需重启（段顺序在启动时注册）',
      cardSource: '当场生效：人格段改读镜台卡 / soul-md 卡（读失败自动回退 soul-md）',
      memoryLayered: '下一轮生效：记忆段是否分层（core + 主题索引）',
      memoryIndexMode: '下一轮生效：主题索引全量 / 仅召回 / 关（镜台未实现关键词召回，recall 时退化为全量说明）',
      subagentSkip: '下一轮生效：子代理会话（origin: subagent）不再自动注入人格与记忆两段',
      compactionRecall: '下一轮生效：会话压缩后，下一次注入附上本会话读过主题的 key/摘要（不注入正文）',
      recallMaxTopics: '下一轮生效：压缩补偿最多列几个主题（1–20）',
      recallMaxChars: '下一轮生效：补偿块总字符预算（200–8000）',
      maxBytes: '立即生效：单个记忆文件上限；memory_append 超过即拒绝',
      autoRecall: '下一轮生效（默认关）：每用户回合按 G0 闸门决定是否去寻枝预取旧记忆',
      autoRecallMinScore: '下一轮生效：向量相关度下限（越高越少提）',
      autoRecallTopN: '下一轮生效：最多注入几条',
      autoRecallMaxChars: '下一轮生效：自动召回块字符预算（不占 injectMaxChars）',
      autoRecallDeadlineMs: '下一轮生效：预取死线；超时当没有记忆',
      autoRecallWaitMs: '下一轮生效：组装 prompt 时最多等预取多久（0=完全不等，首步通常拿不到）',
      autoRecallCooldownMs: '下一轮生效：同会话两次召回的最小间隔',
      autoRecallCues: '下一轮生效：G0 线索词（| 分隔）',
      autoRecallLabOnly: '下一轮生效：只对实验工作区生效（默认 true）',
      autoRecallLabWorkspaces: '下一轮生效：实验白名单（逗号分隔）',
      conflictCard: '下一轮生效（默认关）：有未裁决冲突时，附一张 ≤2 条、≤300 字的 A/B 说法卡（只提示，不裁决；不占 injectMaxChars）',
    },
  }
}
