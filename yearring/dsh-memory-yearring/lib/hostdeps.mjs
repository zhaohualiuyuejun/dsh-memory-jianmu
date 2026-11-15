/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到本地等价实现）
 *
 * 来源：根藏 dsh-memory-store 0.1.0 `lib/hostdeps.mjs`（同作者），只改插件名。
 * 背景：桌面版 profile 是 autoInstallPeers:false ⇒ 裸 import @deepseek-ai/* 可能让整条插件不激活。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
    } catch { /* 没有就算了 */ }
  }
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try { const mod = await import(url); log(`${name}：从宿主树取到`); return mod } catch { /* 下一个 */ }
  }
  return null
}

export function compileParameterSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec || {})) {
    if (!node || typeof node !== 'object') continue
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  const parameters = compileParameterSchema(options.parameters)
  for (const [k, v] of Object.entries(parameters.properties)) check(v, `parameters.properties.${k}`)
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上（工具 ${options.name}）`)
  return { ...options, parameters }
}

export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); log('schemastery：用自己依赖里那份') }
    catch { log('⚠️ schemastery 拿不到 —— 没有 Config，设置页降级') }
  }
  const z = zMod?.default ?? zMod ?? null

  let defineTool = null
  let defineToolKind = 'host'
  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：用自己依赖里那份') } catch { dtMod = null }
  }
  if (dtMod?.defineTool) defineTool = dtMod.defineTool
  else {
    defineToolKind = 'local-fallback'
    defineTool = (options) => localDefineTool(options, log)
    try { console.warn('[memory-yearring] 宿主 @deepseek-ai/dsh-tools 不可用，改用本地等价 defineTool') } catch { /* 没有 console 就算了 */ }
  }
  return { z, defineTool, defineToolKind, notes }
}
