#!/usr/bin/env node
/**
 * tools/client-smoke.mjs —— 客户端壳冒烟（不重启、不需要浏览器）
 *
 * 验证：
 *   · client.js 能被 __ModuleLoader__ 加载（语法/结构正确）
 *   · factory 返回 { inject, apply }
 *   · apply() 会把「年轮」tab 注册进 globalThis.__jianmuLibraryTabs
 *   · 重复 apply（HMR）不会重复注册
 *   · render 是函数，能接受 { personaId } 参数
 *
 * 不验证：真实 DOM 渲染、HTTP 数据——那些要重启后在 GUI 里看。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(HERE, '..')
const results = []
let failed = 0
const ok = (name, cond, detail) => {
  if (cond) results.push(['✅', name])
  else { failed += 1; results.push(['❌', `${name}  ← ${JSON.stringify(detail)}`]) }
}

// ── mock 浏览器环境 ───────────────────────────────────────────────────────
let captured = null
const sandbox = {
  console,
  URLSearchParams,
  AbortController,
  fetch: () => Promise.reject(new Error('client-smoke 不发请求')),
  setTimeout,
  clearTimeout,
}
sandbox.globalThis = sandbox
sandbox.window = {
  __ModuleLoader__: {
    load: (mod) => { captured = mod },
  },
}
sandbox.__jianmuLibraryTabs = []

const sandboxRequire = (name) => {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (v) => ({ current: v }),
    }
  }
  throw new Error(`client-smoke: 未预期的 require('${name}')`)
}

const code = fs.readFileSync(join(PKG_DIR, 'client.js'), 'utf8')
vm.createContext(sandbox)
try {
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  ok('client.js 能被 __ModuleLoader__ 加载', true)
} catch (e) {
  ok('client.js 能被 __ModuleLoader__ 加载', false, String(e?.message || e))
}

ok('模块 id 正确', captured?.id === 'dsh-memory-yearring', captured?.id)
ok('有 factory', typeof captured?.factory === 'function')

let plugin = null
try {
  plugin = captured.factory(sandboxRequire)
  ok('factory 返回插件对象', Boolean(plugin) && typeof plugin === 'object')
} catch (e) {
  ok('factory 返回插件对象', false, String(e?.message || e))
}

ok('声明 inject: [slots]', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'), plugin?.inject)
ok('有 apply', typeof plugin?.apply === 'function')

// ── apply：注册 tab ───────────────────────────────────────────────────────
const ctx = { logger: { warn: () => {}, info: () => {} }, get: () => undefined }
try {
  plugin.apply(ctx)
  ok('apply 不抛', true)
} catch (e) {
  ok('apply 不抛', false, String(e?.message || e))
}

const tabs = sandbox.__jianmuLibraryTabs || []
ok('注册了 1 个外部 tab', tabs.length === 1, tabs.map((t) => t.id))
const t0 = tabs[0]
ok('tab id = yearring', t0?.id === 'yearring', t0?.id)
ok('tab 标签 = 年轮', t0?.label === '年轮', t0?.label)
ok('tab 有 render 函数', typeof t0?.render === 'function')

// 重复 apply（模拟 HMR）不应重复注册
try {
  plugin.apply(ctx)
  const again = sandbox.__jianmuLibraryTabs || []
  ok('重复 apply 不重复注册（幂等）', again.length === 1, again.map((t) => t.id))
} catch (e) {
  ok('重复 apply 不重复注册（幂等）', false, String(e?.message || e))
}

// render 能被调用（无 persona 时走空态，不崩）
try {
  const tree = t0.render({ personaId: null })
  ok('render({personaId:null}) 不崩', Boolean(tree))
} catch (e) {
  ok('render({personaId:null}) 不崩', false, String(e?.message || e))
}

// ── P0-1：独立入口（只装年轮时也要有侧栏 + 主页面）────────────────────────
function makeSlots(entries = []) {
  const regs = []
  return {
    regs,
    entriesOfSlot: () => entries,
    inject(_name, factory) {
      const d = factory()
      if (typeof d === 'function') d.__injected = true
      return d
    },
    register(spec, render) {
      const d = () => {}
      regs.push({ spec, render, d })
      return d
    },
  }
}

try {
  delete sandbox.__jianmuLibraryShell
  const slots = makeSlots([])
  plugin.apply({ logger: { warn: () => {} }, slots })
  const sidebar = slots.regs.find((r) => r.spec?.name === 'sidebar.panellist')
  const main = slots.regs.find((r) => r.spec?.name === 'main')
  ok('无记忆库壳时注册独立侧栏入口', sidebar?.spec?.id === 'jianmu-yearring', sidebar?.spec)
  ok('无记忆库壳时注册独立主页面', main?.spec?.key === 'jianmu-yearring', main?.spec)
  ok('独立入口 render 可调用', typeof sidebar?.render === 'function' && Boolean(sidebar.render({ size: 20 })), typeof sidebar?.render)
} catch (e) {
  ok('P0-1 独立入口注册不抛', false, String(e?.message || e))
}

try {
  // 记忆库壳存在（① slots 里已有面板）→ 年轮不再重复注册；星图入口仍应存在
  const slots2 = makeSlots([{ options: { id: 'jianmu-memory' } }])
  plugin.apply({ logger: { warn: () => {} }, slots: slots2 })
  const yr2 = slots2.regs.filter((r) => r.spec?.id === 'jianmu-yearring' || r.spec?.key === 'jianmu-yearring')
  ok('记忆库壳存在时不重复注册侧栏', yr2.length === 0, slots2.regs.map((r) => r.spec?.id))
  ok('星图侧栏始终注册', slots2.regs.some((r) => r.spec?.id === 'jianmu-starmap'), slots2.regs.map((r) => r.spec?.id))
} catch (e) {
  ok('P0-1 壳存在判定不抛', false, String(e?.message || e))
}

try {
  // 记忆库壳存在（② 全局标记兜底）→ 年轮不再重复注册；星图入口仍应存在
  sandbox.__jianmuLibraryShell = { id: 'jianmu-memory', version: 1 }
  const slots3 = makeSlots([])
  plugin.apply({ logger: { warn: () => {} }, slots: slots3 })
  const yr3 = slots3.regs.filter((r) => r.spec?.id === 'jianmu-yearring' || r.spec?.key === 'jianmu-yearring')
  ok('全局标记存在时不重复注册侧栏', yr3.length === 0, slots3.regs.map((r) => r.spec?.id))
  ok('全局标记下星图入口仍注册', slots3.regs.some((r) => r.spec?.id === 'jianmu-starmap'), slots3.regs.map((r) => r.spec?.id))
} catch (e) {
  ok('P0-1 全局标记判定不抛', false, String(e?.message || e))
} finally {
  delete sandbox.__jianmuLibraryShell
}

// ── 熏习那边的扩展点语法也顺手查一下（它不是本包的，但我们的 tab 依赖它） ──
try {
  const procClient = join(PKG_DIR, '..', '..', 'process', 'dsh-memory-process', 'client.js')
  const src = fs.readFileSync(procClient, 'utf8')
  ok('记忆库（熏习）client.js 已含外部 tab 扩展点', src.includes('__jianmuLibraryTabs') && src.includes('externalTabs'), '未找到扩展点')
} catch (e) {
  ok('记忆库（熏习）client.js 可读', false, String(e?.message || e))
}

for (const [mark, name] of results) console.log(mark, name)
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `，${failed} 失败` : ''}`)
process.exit(failed ? 1 : 0)
