#!/usr/bin/env node
/**
 * tools/client-smoke.mjs —— 根藏 UI 客户端「接线」冒烟（0.2.6；不需要浏览器）
 *
 * 它验证不了像素，但能验证**接线**：
 *   · client.js 能被当成模块加载（window.__ModuleLoader__.load 被调用）
 *   · factory(require) 返回的对象带 inject: ['slots'] 和 apply()
 *   · apply 在假 slots 上注册了 sidebar.panellist（id=jianmu-store）与 main（key=jianmu-store）
 *   · 注册的组件不是 null（能渲染成 React 元素）
 *   · PLUGIN_VERSION 与 package.json 一致
 * 真正的「眼睛验收」仍然要在重启后的 GUI 里看一眼（本脚本不替代）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(dir + 'package.json', 'utf8'))
const source = readFileSync(dir + 'client.js', 'utf8')

const results = []
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✅ ${name}`) }
  catch (e) { results.push({ name, ok: false, error: e?.stack || String(e) }); console.log(`  ❌ ${name}`); console.log(String(e?.stack || e).split('\n').slice(0, 8).map((l) => '     ' + l).join('\n')) }
}

// ── 假浏览器环境 ────────────────────────────────────────────────────────────
function makeEnv() {
  const head = []
  const document = {
    createElement() {
      const attrs = {}
      return { setAttribute(k, v) { attrs[k] = v }, getAttribute(k) { return attrs[k] }, attrs, textContent: '' }
    },
    head: { appendChild(n) { head.push(n) } },
  }
  let captured = null
  const window = { __ModuleLoader__: { load(def) { captured = def } } }
  const React = {
    createElement: (...args) => ({ __el: true, args }),
    Component: class { constructor(props) { this.props = props } },
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (f) => f(),
    useRef: (v) => ({ current: v }),
  }
  return { window, document, React, head: head, get captured() { return captured } }
}

const env = makeEnv()
const fn = new Function('window', 'document', 'globalThis', source)
fn(env.window, env.document, { document: env.document })

console.log('\n── UI 客户端接线 ──')

await t('client.js 调用了 window.__ModuleLoader__.load', async () => {
  assert.ok(env.captured, '没有捕获到模块定义')
  assert.equal(env.captured.id, 'dsh-memory-store')
  assert.equal(typeof env.captured.factory, 'function')
})

const mod = env.captured.factory((n) => (n === 'react' ? env.React : (() => { throw new Error(`未预期的 require：${n}`) })()))

await t('factory 只 require react，返回 inject + apply', async () => {
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

await t('PLUGIN_VERSION 与 package.json 一致（发布检查同口径）', async () => {
  const m = source.match(/const PLUGIN_VERSION = ['"]([^'"]+)['"]/)
  assert.ok(m, '找不到 PLUGIN_VERSION')
  assert.equal(m[1], pkg.version)
})

await t('apply 在假 slots 上注册侧栏 + 主页面', async () => {
  const regs = []
  const applied = []
  const fakeSlotCtx = {
    slots: {
      inject(slotName, fn2) { applied.push(slotName); return fn2() },
      register(spec, comp) { regs.push({ spec, comp }); return () => {} },
    },
  }
  mod.apply(fakeSlotCtx)
  const sidebar = regs.find((r) => r.spec.name === 'sidebar.panellist')
  const main = regs.find((r) => r.spec.name === 'main')
  assert.ok(sidebar, '没有注册 sidebar.panellist')
  assert.equal(sidebar.spec.id, 'jianmu-store')
  assert.equal(typeof sidebar.spec.label, 'function')
  assert.equal(sidebar.spec.label(), '根藏')
  assert.ok(main, '没有注册 main')
  assert.equal(main.spec.key, 'jianmu-store')
  assert.equal(typeof main.comp, 'function')
  // 组件能返回一个 React 元素（不算 hooks，只要不抛就好）
  const el = main.comp({})
  assert.ok(el && el.__el, '主页面组件没有返回元素')
})

await t('样式注入到 document.head（一条 <style>，带版本标记）', async () => {
  assert.equal(env.head.length >= 1, true, '没有注入样式')
  assert.equal(env.head[0].getAttribute('data-jianmu-store'), pkg.version)
})

await t('client.js 不碰写记忆的接口（只 /settings 与 /test-embedding 两个 POST）', async () => {
  const posts = [...source.matchAll(/postWrite\('([^']+)'/g)].map((m) => m[1])
  assert.deepEqual([...new Set(posts)].sort(), ['/settings', '/test-embedding'])
  assert.equal(/jianmu_store_(forget|revive|ingest)/.test(source), false, 'UI 里不该出现写记忆的工具调用')
})

const failed = results.filter((r) => !r.ok)
console.log(`\n═══ 根藏 UI 接线冒烟：${results.length - failed.length}/${results.length} 通过 ═══`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}`)
  process.exitCode = 1
}
