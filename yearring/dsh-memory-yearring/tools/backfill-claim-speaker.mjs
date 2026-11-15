#!/usr/bin/env node
/**
 * tools/backfill-claim-speaker.mjs —— 老 claim 回填 speaker（P1.5，2026-11-12）
 *
 * 规则（确定性，零 LLM、零网络）：
 *   · epistemic=inference            → speaker=unknown（推测不是任何人的原话）
 *   · 其余按第一个锚点所在块的 role/sourceType：
 *       role=user / sourceType=user(-bridge)          → user
 *       role=assistant / sourceType=assistant(-bridge) → assistant
 *       其余（工具/系统/缺块）                          → unknown
 *
 * 写纪律（append-only，不物理改历史行）：
 *   1) 先备份 claims.jsonl → year/<pid>/_archive/<ts>/claims-mirror.jsonl
 *   2) 拿年轮单写者锁
 *   3) 用同 claimId 追加新行（speaker / speakerSource / speakerBackfilledAt）
 *      —— 读侧 latest-wins，旧行原样保留，天然可回滚
 *   4) 读回校验每条都落地
 *
 * 用法：
 *   node tools/backfill-claim-speaker.mjs --persona alice            # 预览（默认 dry-run）
 *   node tools/backfill-claim-speaker.mjs --persona alice --apply
 *   node tools/backfill-claim-speaker.mjs --all --apply --json
 *   node tools/backfill-claim-speaker.mjs --persona alice --apply --limit 50   # 小口试
 *   node tools/backfill-claim-speaker.mjs --persona alice --apply --force      # 覆盖已有值
 *
 * 退出码：0 = 成功（含「无需回填」）；1 = 有错误
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaims, appendClaims } from '../lib/store.mjs'
import { readScope } from '../lib/root.mjs'
import { speakerFromClaim } from '../lib/claim.mjs'
import { defaultDataRoot, yearDir, archiveDir, assertYearWrite, tsSlugMs } from '../lib/paths.mjs'
import { copyFileIfExists } from '../lib/fsatomic.mjs'
import { acquireLock } from '../lib/lock.mjs'
import { toErrInfo } from '../lib/errors.mjs'
import { VERSION, PROMPT_VERSION } from '../lib/version.mjs'

// ── 参数 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { persona: null, all: false, apply: false, force: false, limit: null, json: false, dataRoot: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--persona' || a === '-p') out.persona = String(argv[++i] || '')
    else if (a === '--all') out.all = true
    else if (a === '--apply') out.apply = true
    else if (a === '--dry-run') out.apply = false
    else if (a === '--force') out.force = true
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 0) || null
    else if (a === '--json') out.json = true
    else if (a === '--data-root') out.dataRoot = String(argv[++i] || '')
    else if (a === '--help' || a === '-h') out.help = true
    else if (!a.startsWith('-')) out.persona = a
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const HELP = `年轮 · claim speaker 回填（P1.5，零 LLM）
用法：node tools/backfill-claim-speaker.mjs --persona <id>|--all [--apply] [--force] [--limit N] [--json] [--data-root PATH]
默认 dry-run（只预览不写）；--apply 才落盘（先备份、再 append 同 claimId 新行）。`

async function listPersonas(dataRoot) {
  try {
    const ents = await readdir(join(dataRoot, 'year'), { withFileTypes: true })
    return ents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_')).map((d) => d.name).sort()
  } catch { return [] }
}

/**
 * 给一个 persona 做计划（不写盘）。
 * @returns {{ok:boolean, ...}}
 */
async function planPersona({ dataRoot, personaId, force, limit }) {
  const claims = await readClaims(dataRoot, personaId)
  const scope = await readScope(dataRoot, personaId)
  if (!scope.ok) {
    return { ok: false, personaId, code: scope.code, error: scope.error, note: '根藏不可读：无法按锚点推导 speaker' }
  }
  const chunksById = new Map()
  for (const c of scope.chunks) chunksById.set(c.id, c)

  const counts = { total: claims.byId.size, fill: 0, overwrite: 0, unchanged: 0, kept: 0, noAnchor: 0, selected: 0 }
  const byTarget = { user: 0, assistant: 0, unknown: 0 }
  const rows = []
  const samples = []

  for (const c of claims.byId.values()) {
    const target = speakerFromClaim(c, chunksById)
    const source = target === 'unknown'
      ? (c.epistemic === 'inference' ? 'inference-rule' : 'unknown')
      : 'anchor'
    byTarget[target] += 1
    const cur = typeof c.speaker === 'string' && c.speaker ? c.speaker : null
    const needFill = !cur || (cur === 'unknown' && target !== 'unknown')
    let action = null
    if (force && cur !== target) action = 'overwrite'
    else if (needFill) action = 'fill'
    else if (cur !== target) action = 'kept' // 保留模型/人工判断（只在 --force 时覆盖）
    else action = 'unchanged'

    if (action === 'fill' || action === 'overwrite') {
      if (action === 'fill') counts.fill += 1
      else counts.overwrite += 1
      if (rows.length < (limit ?? Infinity)) {
        rows.push({
          claimId: c.claimId,
          claim: c,
          speaker: target,
          speakerSource: source,
        })
        counts.selected += 1
        if (samples.length < 10) {
          samples.push({ claimId: c.claimId, title: String(c.title || '').slice(0, 60), epistemic: c.epistemic, from: cur, to: target, source })
        }
      }
    } else if (action === 'kept') counts.kept += 1
    else counts.unchanged += 1
    if (c.epistemic !== 'inference' && !(c.derivedFrom || []).length) counts.noAnchor += 1
  }

  return {
    ok: true,
    personaId,
    plan: { counts, byTarget, planned: rows.length },
    byTarget,
    rows,
    samples,
    note: counts.kept ? `${counts.kept} 条已有 speaker 且与锚点不一致：默认保留（--force 才覆盖）` : null,
  }
}

/** 真写：备份 → 锁 → append → 读回校验 */
async function applyPersona({ dataRoot, personaId, rows }) {
  if (!rows.length) return { ok: true, personaId, written: 0, snapshot: null, note: '没有要回填的行' }
  const lock = await acquireLock(yearDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, personaId, code: lock.code, error: lock.error }
  try {
    // 1) 备份（不可逆动作前先留快照）
    const tag = `backfill-speaker-${tsSlugMs()}`
    const snapDir = archiveDir(dataRoot, personaId, tag)
    assertYearWrite(dataRoot, personaId, join(snapDir, 'claims-mirror.jsonl'))
    const snap = await copyFileIfExists(join(yearDir(dataRoot, personaId), 'claims.jsonl'), snapDir, 'claims-mirror.jsonl')
    if (!snap.ok) {
      return { ok: false, personaId, code: 'SNAPSHOT_FAILED', error: { code: 'SNAPSHOT_FAILED', message: `备份失败（${snap.reason}）：不写`, detail: snap } }
    }

    // 2) append 同 claimId 新行（latest-wins）
    const now = Date.now()
    const out = rows.map((r) => ({
      ...r.claim,
      speaker: r.speaker,
      speakerSource: r.speakerSource,
      speakerBackfilledAt: now,
      updatedAt: now,
    }))
    await appendClaims(dataRoot, personaId, out)

    // 3) 读回校验（不信写入成功的提示，只看产物）
    const reread = await readClaims(dataRoot, personaId)
    const missing = out.filter((c) => {
      const got = reread.byId.get(c.claimId)
      return !got || got.speaker !== c.speaker
    })
    if (missing.length) {
      return {
        ok: false, personaId, written: out.length, snapshot: snap.dest,
        code: 'READBACK_MISMATCH',
        error: { code: 'READBACK_MISMATCH', message: `写入后读回 ${missing.length} 条未生效（旧行仍在，未丢数据）`, detail: missing.slice(0, 5).map((c) => c.claimId) },
      }
    }

    return {
      ok: true, personaId, written: out.length, snapshot: snap.dest,
      verified: { claims: reread.byId.size, withSpeaker: [...reread.byId.values()].filter((c) => typeof c.speaker === 'string' && c.speaker).length },
    }
  } catch (e) {
    return { ok: false, personaId, code: e?.code || 'APPLY_FAILED', error: toErrInfo(e) }
  } finally {
    await lock.release().catch(() => {})
  }
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return 0 }
  const dataRoot = args.dataRoot || defaultDataRoot()
  const targets = args.all || args.persona === 'all'
    ? await listPersonas(dataRoot)
    : (args.persona ? [args.persona] : [])
  if (!targets.length) {
    console.error(`没有目标人格。请给 --persona <id> 或 --all（dataRoot=${dataRoot}）`)
    return 2
  }

  const report = {
    tool: 'backfill-claim-speaker',
    version: VERSION,
    promptVersion: PROMPT_VERSION,
    dataRoot,
    mode: args.apply ? 'apply' : 'dry-run',
    at: new Date().toISOString(),
    personas: [],
  }
  let failed = 0

  for (const pid of targets) {
    const planned = await planPersona({ dataRoot, personaId: pid, force: args.force, limit: args.limit })
    if (!planned.ok) {
      failed += 1
      report.personas.push(planned)
      continue
    }
    let applied = null
    if (args.apply) applied = await applyPersona({ dataRoot, personaId: pid, rows: planned.rows })
    if (args.apply && !applied.ok) failed += 1
    report.personas.push({
      ok: args.apply ? Boolean(applied.ok) : true,
      personaId: pid,
      plan: planned.plan,
      byTarget: planned.byTarget,
      samples: planned.samples,
      note: planned.note,
      applied: applied ? { ok: applied.ok, written: applied.written, snapshot: applied.snapshot, verified: applied.verified, code: applied.code, error: applied.error } : undefined,
    })
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`年轮 speaker 回填 · ${report.mode} · ${dataRoot}`)
    for (const p of report.personas) {
      if (!p.plan) {
        console.log(`❌ ${p.personaId}: ${p.code} ${p.error?.message || ''}`)
        continue
      }
      const c = p.plan.counts
      console.log(`\n${p.ok ? '✅' : '❌'} ${p.personaId}: 共 ${c.total} 条 | 待回填 ${c.fill} | 覆盖 ${c.overwrite} | 无需改 ${c.unchanged} | 保留原值 ${c.kept}`)
      if (c.selected !== c.fill + c.overwrite) console.log(`   本次只选中 ${c.selected} 条（--limit 限制；其余下次再跑）`)
      console.log(`   按证据应是：user ${p.byTarget.user} / assistant ${p.byTarget.assistant} / unknown ${p.byTarget.unknown}`)
      if (p.note) console.log(`   ⚠️ ${p.note}`)
      if (p.applied) {
        console.log(p.applied.ok
          ? `   ✔ 已追加 ${p.applied.written} 行；读回校验通过；快照 ${p.applied.snapshot}`
          : `   ✖ 写入失败：${p.applied.code} ${p.applied.error?.message || ''}${p.applied.snapshot ? `（快照 ${p.applied.snapshot}）` : ''}`)
      }
      if (p.samples?.length) {
        console.log('   样例：')
        for (const s of p.samples) console.log(`   · [${s.epistemic}] ${s.from ?? '缺'} → ${s.to}（${s.source}） ${s.title}`)
      }
    }
    if (!args.apply) console.log('\n这是 dry-run，未写盘。确认后加 --apply。')
  }
  return failed ? 1 : 0
}

const code = await main().catch((e) => {
  console.error(`❌ ${e?.message || e}`)
  return 1
})
process.exit(code)
