#!/usr/bin/env node
/**
 * 构建记忆星图数据（Python + numpy）
 * 输出：<dataRoot>/starmap/{stats,meta,bin,blades}
 * 用法：node tools/starmap-build.mjs [personaId ...]   （不给 persona 就跑全部）
 * 环境：JIANMU_PYTHON / JIANMU_DATA_ROOT / JIANMU_CLAIM_VEC
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { defaultDataRoot } from '../lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const python = process.env.JIANMU_PYTHON || 'python'
const dataRoot = defaultDataRoot()
const out = resolve(process.env.JIANMU_STARMAP_OUT || join(dataRoot, 'starmap'))
const personas = process.argv.slice(2)
const env = { ...process.env, JIANMU_DATA_ROOT: dataRoot, JIANMU_STARMAP_OUT: out }

mkdirSync(out, { recursive: true })

function run(script) {
  const args = [script, ...personas]
  const r = spawnSync(python, args, { stdio: 'inherit', env })
  if (r.error) {
    console.error(`[starmap] 无法启动 Python（${python}）：${r.error.message}`)
    console.error('[starmap] 用 JIANMU_PYTHON 指定带 numpy 的 python.exe')
    process.exit(1)
  }
  if (r.status !== 0) process.exit(r.status || 1)
}

run(join(here, 'starmap', 'build-starmap.py'))
run(join(here, 'starmap', 'layout-blades.py'))
console.log(`[starmap] 已写入 ${out}`)
