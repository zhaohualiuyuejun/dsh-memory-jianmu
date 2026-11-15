#!/usr/bin/env node
/**
 * tools/client-smoke.mjs —— 客户端壳装配冒烟（不启动浏览器）
 *
 * 用假 window + 假 react 加载 client.js，验证：
 *   · 模块 id 正确（必须等于包名）
 *   · factory 能执行、返回 { inject:['slots'], apply }
 *   · apply 注册侧栏「人格卡」与主面板
 *   · CSS 非空、组件是函数
 *
 * 注意：这不是渲染测试；真正的视觉验收在安装后 F5。
 */
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) { loaded = def },
  },
}

const created = []
const React = {
  createElement(type, props, ...children) {
    created.push({ type, props, children })
    return { type, props, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useRef(v) { return { current: v } },
  Fragment: 'Fragment',
  Component: class Component { constructor(props) { this.props = props } },
}

const mod = await import('../client.js')
let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = null) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push({ name, detail }); console.log(`  ❌ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}

console.log('── A. 模块加载')
check('A1 __ModuleLoader__.load 被调用', Boolean(loaded))
check('A2 模块 id = dsh-memory-persona', loaded?.id === 'dsh-memory-persona', loaded?.id)
check('A3 factory 是函数', typeof loaded?.factory === 'function')

const exported = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未预期的 require：${name}`)
})
check('A4 返回 inject slots + apply', Array.isArray(exported?.inject) && exported.inject.includes('slots') && typeof exported.apply === 'function')

console.log('\n── B. 入口注册')
const regs = []
let panelOpened = null
const ctx = {
  slots: {
    inject(_name, cb) { return cb() },
    register(spec, component) { regs.push({ spec, component }); return () => {} },
  },
  get(name) {
    if (name === 'layout') return { selectPanel: (id) => { panelOpened = id } }
    return undefined
  },
}
exported.apply(ctx)
check('B1 注册 2 个入口（侧栏 + 主面板）', regs.length === 2, regs.map((r) => r.spec?.id || r.spec?.key))
const sidebar = regs.find((r) => r.spec?.name === 'sidebar.panellist')
check('B2 侧栏 id = jianmu-persona', sidebar?.spec?.id === 'jianmu-persona', sidebar?.spec)
check('B3 侧栏 label = 人格卡', typeof sidebar?.spec?.label === 'function' && sidebar.spec.label() === '人格卡')
const main = regs.find((r) => r.spec?.name === 'main')
check('B4 主面板 key = jianmu-persona', main?.spec?.key === 'jianmu-persona', main?.spec)
check('B5 两个入口都有组件', typeof sidebar?.component === 'function' && typeof main?.component === 'function')

console.log('\n── C. 静态结构（v1a.1 写动作接线）')
const src = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('C1 CSS 含 --dsw-alias token', src.includes('--dsw-alias-'))
check('C2 页面含五个 tab 文案', ['卡片', '默认与绑定', '注入设置', '版本历史', '注入预览'].every((x) => src.includes(`'${x}'`)))
check('C3 写请求是同源 POST + 安全头', src.includes("method: 'POST'") && src.includes("'x-dsh-persona'") && src.includes("'content-type'"))
check('C4 六个动作端点已接线', ['/save', '/rollback', '/delete', '/default', '/bind', '/expand'].every((p) => src.includes(`'${p}'`)))
check('C5 写动作带 expectedGeneration 与 confirm', src.includes('expectedGeneration') && src.includes('confirm: true'))
check('C6 保存按钮已接线、不再硬编码只读', src.includes('handleSaveClick') && !src.includes('disabled: true'))
check('C7 版本历史行内有回滚按钮', src.includes('回滚到此版'))
check('C8 只用内联确认条，不用 window.confirm/alert/prompt', !src.includes('window.confirm') && !src.includes('alert(') && !src.includes('prompt('))
check('C9 hooks 只用 useState/useEffect/useRef', !src.includes('useMemo') && !src.includes('useCallback') && !src.includes('useReducer'))
check('C10 顶部标注 v2 注入接管', src.includes('建木 · 人格层 · 镜台（v2 注入接管）') && src.includes("h(Badge, { tone: 'brand' }, 'v2')"))
check('C11 受保护分区二次确认 + AI 确认文案', src.includes('确认覆盖') && src.includes('将基于当前内容生成整卡'))
check('C12 模块工厂入口未改', src.startsWith('window.__ModuleLoader__.load({'))
// v2：注入设置可写
check('C13 注入设置保存已接 POST /settings（带 generation）',
  src.includes("post('/settings'") && src.includes('expectedGeneration: st.generation'))
check('C14 设置页字段可编辑（不再只读展示）',
  src.includes('SETTING_FIELDS') && src.includes('保存设置') && src.includes('放弃改动'))
check('C15 设置页标出生效口径（当场生效 / 需重启）',
  src.includes('capabilities') && src.includes('当场生效') && src.includes('需重启'))
// v2.1：人格卡来源可切（镜台卡 / soul-md 卡）
check('C16 卡源选择器已接线（jianmu / soul-md 两个选项）',
  src.includes("patch.cardSource = cur.cardSource") && src.includes("value: 'jianmu'") && src.includes("value: 'soul-md'"))
check('C17 记忆段预览显示字数（不再只有「完整」）',
  src.includes('`${num(d.memory?.chars)} 字`'))
check('C18 预览显示卡源与卡文件（能看出注入读哪张卡）',
  src.includes("'卡源'") && src.includes("'卡文件'"))

// 2026-11-08：UI 去 soul-md 化 + 卡片页新增按钮
check('C19 卡片页有「＋ 新增」且走 POST /create',
  src.includes('＋ 新增') && src.includes("post('/create'") && src.includes('expectedGeneration: st.generation'))
check('C20 面向文案不再出现 soul-md（回退源已停用）',
  !src.includes("'soul-md 卡（回退）'") && !src.includes("'soul-md 有效值") && !src.includes('SOUL-MD')
    && !src.includes("'soul-md 的只读展示") && !src.includes('soul-md 注入字符上限'))
check('C21 设置页已移除只读回退面板（只留镜台注入 + 说明）',
  !src.includes("title: 'soul-md 有效值（回退源）'") && !src.includes("title: '上限与模式'"))
check('C22 设置页含分层记忆 / 主题索引口径 / 子代理跳过',
  src.includes("key: 'memoryLayered'") && src.includes("key: 'memoryIndexMode'") && src.includes("key: 'subagentSkip'"))
check('C23 设置页含压缩补偿与上限参数',
  src.includes("key: 'compactionRecall'") && src.includes("key: 'recallMaxTopics'")
    && src.includes("key: 'recallMaxChars'") && src.includes("key: 'maxBytes'"))

console.log(`\n══════════════════════════════════`)
console.log(`通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${JSON.stringify(f.detail).slice(0, 300)}` : ''}`)
} else {
  console.log('全部通过 ✅')
}
process.exit(fail ? 1 : 0)
