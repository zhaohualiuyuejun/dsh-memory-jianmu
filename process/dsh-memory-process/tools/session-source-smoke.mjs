#!/usr/bin/env node
/**
 * tools/session-source-smoke.mjs —— P1-4 只读会话源冒烟（2026-11-08）
 *
 * 在临时 DSH_HOME 里造假会话（zstd 多帧），验证：
 *   · 没有根藏时 sourceProbe.rootData=false（UI 会切到原话看板）
 *   · 工作区聚合 / 角色 / 关键词 / 工作区过滤
 *   · 会话文件零改动（只读）
 *   · 一旦根藏有数据，rootData 变 true（有根藏读根藏）
 *
 * 用法：node tools/session-source-smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jianmu-src-'))
process.env.DSH_HOME = tmp

const SESS = path.join(tmp, 'sessions')
fs.mkdirSync(path.join(SESS, '--H-tmp-ws--', 'session-aaaa'), { recursive: true })
fs.mkdirSync(path.join(SESS, '--H-second-ws--', 'session-bbbb'), { recursive: true })
const writeSession = (ws, sid, lines) => {
  const file = path.join(SESS, ws, sid, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.map((x) => JSON.stringify(x)).join('\n') + '\n')))
  return file
}
const f1 = writeSession('--H-tmp-ws--', 'session-aaaa', [
  { type: 'user/message', time: 1000, seq: 1, data: { content: [{ type: 'text', text: '我喜欢喝咖啡，这是第一条测试原话' }] } },
  { type: 'assistant/message', time: 2000, seq: 2, data: { content: [{ type: 'text', text: '收到，这是助手的回复内容，长度足够' }] } },
  { type: 'tool/call', time: 3000, seq: 3, data: { name: 'mcp__snowluma__qq_send_message', callId: 'c1', arguments: JSON.stringify({ messages: ['群里发的一条消息，应该被抽成助手原话'] }) } },
])
const f2 = writeSession('--H-second-ws--', 'session-bbbb', [
  { type: 'user/message', time: 4000, seq: 1, data: { content: [{ type: 'text', text: '第二个工作区的一条用户原话，足够长' }] } },
  { type: 'user/message', time: 5000, seq: 2, data: { content: [{ type: 'text', text: '短' }] } },
  { type: 'user/message', time: 6000, seq: 3, data: { content: [{ type: 'text', text: 'Current runtime context: 这段是系统注入，必须被滤掉' }] } },
])
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const before = { f1: hash(f1), f2: hash(f2) }

const src = await import('../lib/session-source.mjs')
const results = []
const ok = (name, cond, detail) => results.push([cond ? '✅' : '❌', name, cond ? '' : JSON.stringify(detail ?? '')])

try {
  const probe = await src.sourceProbe()
  ok('无根藏 → rootData=false', probe.ok === true && probe.rootData === false, probe)

  const st = await src.sourceStatus({ days: 7 })
  ok('状态：2 个会话文件 / 2 个工作区', st.files === 2 && st.workspaces === 2, st)
  ok('状态：原话块 > 0', st.utterances >= 4, st.utterances)

  const wss = await src.sourceWorkspaces({ days: 7 })
  const wsNames = wss.rows.map((r) => r.ws)
  ok('工作区聚合包含两个工作区', wss.total === 2 && wsNames.includes('H:\\tmp\\ws') && wsNames.includes('H:\\second\\ws'), wsNames)

  const all = await src.sourceMemories({ days: 7, limit: 100 })
  ok('系统注入被滤掉', !all.rows.some((r) => r.text.includes('Current runtime context')), all.rows.map((r) => r.text))
  ok('过短消息被滤掉', !all.rows.some((r) => r.text === '短'), all.rows.map((r) => r.text))
  ok('桥接 tool/call 被抽成助手原话', all.rows.some((r) => r.role === 'assistant' && r.text.includes('群里发的一条消息')), all.rows.map((r) => [r.role, r.text]))

  const users = await src.sourceMemories({ days: 7, role: 'user', limit: 100 })
  ok('角色过滤：只剩 user', users.rows.length > 0 && users.rows.every((r) => r.role === 'user'), users.rows.map((r) => r.role))

  const search = await src.sourceMemories({ days: 7, q: '咖啡', limit: 100 })
  ok('关键词过滤命中 1 条', search.total === 1 && search.rows[0].text.includes('咖啡'), search)

  const byWs = await src.sourceMemories({ days: 7, ws: 'H:\\second\\ws', limit: 100 })
  ok('工作区过滤生效', byWs.total === 1 && byWs.rows[0].ws === 'H:\\second\\ws', byWs)

  ok('会话文件零改动（只读）', hash(f1) === before.f1 && hash(f2) === before.f2)

  // 有根藏时：rootData 变 true（有根藏读根藏）
  // defaultDataRoot = <DSH_HOME>/memory-jianmu（不是 DSH_HOME 根）
  fs.mkdirSync(path.join(tmp, 'memory-jianmu', 'scopes', 'alice'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'memory-jianmu', 'scopes', 'alice', 'chunks.jsonl'), JSON.stringify({ id: 'c1', kind: 'utterance', personaId: 'alice', text: '一条根藏原话，够长了吧' }) + '\n')
  const probe2 = await src.sourceProbe()
  ok('有根藏 → rootData=true', probe2.rootData === true, probe2)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

for (const [mark, name, detail] of results) console.log(mark, name, detail)
const failed = results.filter((r) => r[0] === '❌').length
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
