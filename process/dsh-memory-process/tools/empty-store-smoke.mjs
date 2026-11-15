#!/usr/bin/env node
/**
 * tools/empty-store-smoke.mjs —— P0-2 空库友好冒烟（2026-11-08）
 *
 * 验证：没有 scopes/ 时
 *   · readScope        → ok:true, empty:true, chunks:[]（引导态，不是故障）
 *   · rootStorageStats → 空存储卡（不报 SCOPE_NOT_FOUND）
 *   · runProcess       → 明确 EMPTY_ROOT（不能伪装成 NOTHING_TO_DO）
 * 真错误仍应是错误：manifest 坏了要报 MANIFEST_INVALID。
 *
 * 用法：node tools/empty-store-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readScope, rootStorageStats } from '../lib/root.mjs'
import { runProcess } from '../lib/run.mjs'

const results = []
const ok = (name, cond, detail) => results.push([cond ? '✅' : '❌', name, cond ? '' : JSON.stringify(detail ?? '')])
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jianmu-empty-'))
fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify({ version: 1, defaultPersonaId: null, personas: { alice: { displayName: 'Alice' } }, workspaces: {}, sessions: {} }))

try {
  const sc = await readScope(root, 'alice')
  ok('缺 scope 目录 → 空库引导态', sc.ok === true && sc.empty === true && Array.isArray(sc.chunks) && sc.chunks.length === 0, sc)
  ok('空库带引导 hint', typeof sc.hint === 'string' && sc.hint.length > 0, sc.hint)

  const st = await rootStorageStats(root, 'alice')
  ok('存储卡 → 空卡（非 SCOPE_NOT_FOUND）', st.ok === true && st.empty === true && st.chunks === 0, st)

  const run = await runProcess({ dataRoot: root, personaId: 'alice' })
  ok('run → EMPTY_ROOT（明确报空，不伪装成没活干）', run.ok === false && run.code === 'EMPTY_ROOT', run)

  // 真错误：manifest 损坏仍是错误
  fs.mkdirSync(path.join(root, 'scopes', 'alice'), { recursive: true })
  fs.writeFileSync(path.join(root, 'scopes', 'alice', 'manifest.json'), '{ bad json')
  fs.writeFileSync(path.join(root, 'scopes', 'alice', 'chunks.jsonl'), '')
  const bad = await readScope(root, 'alice')
  ok('坏 manifest 仍是真错误', bad.ok === false && bad.code === 'MANIFEST_INVALID', bad)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

for (const [mark, name, detail] of results) console.log(mark, name, detail)
const failed = results.filter((r) => r[0] === '❌').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
