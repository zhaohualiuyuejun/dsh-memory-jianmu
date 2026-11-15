#!/usr/bin/env node
/**
 * tools/cli.mjs —— 熏习命令行（施工/运维/验收用；不是插件工具面）
 *
 * 子命令：
 *   status     状态概览（块数/状态数/topic/pending/conflicts/最近运行/错误）
 *   run        扫根藏生成候选（默认不应用）
 *   review     列出 pending / duplicates / conflicts
 *   apply      确认应用（带 generation + confirm）
 *   restore    把 superseded/expired/archived 恢复为 active
 *   verify     孤儿/stale/计数一致性检查
 *   repair     不删数据的修复（重算计数/清孤儿 tmp/写 anchor 重映射候选）
 *   rebuild    从根藏 + ruleVersion 重建 state/duplicates/conflicts
 *   export     导出状态/topic 元数据（备份）
 *   conflict-add  手动标记未解释矛盾（两条都保持 active）
 *   archive    手动创建「归档」候选（只进 pending）
 *   expire     手动创建「过期」候选（只进 pending）
 *   api        只读 API（overview/memories/topics/pending/conflicts/verify）
 */
import { defaultDataRoot } from '../lib/paths.mjs'
import { runProcess } from '../lib/run.mjs'
import { applyPending, restoreChunks, createManualPending, addConflict } from '../lib/apply.mjs'
import { verifyProcess, repairProcess } from '../lib/verify.mjs'
import { rebuildProcess } from '../lib/rebuild.mjs'
import { exportProcess } from '../lib/export.mjs'
import { readScope, listScopes, readIdentity } from '../lib/root.mjs'
import { overview, readPendingMap, readDuplicatesMap, readConflictsMap, readTopics } from '../lib/store.mjs'
import {
  apiContext, apiCapabilities, apiOverview, apiRootStorage, apiMemories, apiMemory,
  apiChunks, apiTopics, apiPending, apiConflicts, apiVerify, apiStatus,
} from '../lib/api.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else { out[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

function pickRoot(args) {
  return args['data-root'] && args['data-root'] !== true ? args['data-root'] : defaultDataRoot()
}

function pickPersona(args, fallback = 'alice') {
  return !args.persona || args.persona === true ? fallback : String(args.persona)
}

function listArg(v) {
  if (!v || v === true) return []
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function print(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`)
  process.exitCode = code
}

async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const cmd = args._[0]
  const dataRoot = pickRoot(args)
  const personaId = pickPersona(args)

  switch (cmd) {
    case 'context': {
      const r = await apiContext({
        dataRoot,
        workspace: args.workspace && args.workspace !== true ? String(args.workspace) : null,
        personaId: args.persona && args.persona !== true ? String(args.persona) : null,
      })
      return print(r, r.ok ? 0 : 1)
    }
    case 'status': {
      if (args.deep) {
        const root = await readScope(dataRoot, personaId)
        if (!root.ok) return print({ ok: false, code: root.code, error: root.error }, 1)
        const ov = await overview(dataRoot, personaId, { chunks: root.chunks, rootBuiltAt: root.manifest?.builtAt ?? null })
        const identity = await readIdentity(dataRoot)
        const scopes = await listScopes(dataRoot)
        return print({
          ...ov,
          root: {
            ...ov.root,
            manifest: { generation: root.manifest?.generation, builtAt: root.manifest?.builtAt, contractVersion: root.manifest?.contractVersion, retentionDays: root.manifest?.retentionDays },
            stats: root.stats,
            invalid: root.invalid.length,
            problems: root.problems,
          },
          identity: identity.ok ? { ok: true, personas: Object.keys(identity.identity.personas ?? {}), defaultPersonaId: identity.identity.defaultPersonaId ?? null } : { ok: false, code: identity.code },
          scopes,
        })
      }
      const r = await apiOverview({ dataRoot, personaId })
      return print(r, r.ok ? 0 : 1)
    }
    case 'run': {
      const r = await runProcess({
        dataRoot,
        personaId,
        force: Boolean(args.force),
        maxChunks: args['max-chunks'] ? Number(args['max-chunks']) : undefined,
      })
      return print(r, r.ok ? 0 : 1)
    }
    case 'review': {
      const kind = args.kind && args.kind !== true ? String(args.kind) : null
      const [pending, duplicates, conflicts] = await Promise.all([
        readPendingMap(dataRoot, personaId),
        readDuplicatesMap(dataRoot, personaId),
        readConflictsMap(dataRoot, personaId),
      ])
      const out = {
        ok: true,
        personaId,
        summary: {
          pending: [...pending.map.values()].filter((p) => p.status === 'pending').length,
          duplicates: [...duplicates.map.values()].filter((d) => d.status === 'pending').length,
          conflicts: [...conflicts.map.values()].filter((c) => c.status === 'open').length,
        },
      }
      if (!kind || kind === 'pending') out.pending = [...pending.map.values()].filter((p) => p.status === 'pending').slice(0, Number(args.limit) || 200)
      if (!kind || kind === 'duplicates') out.duplicates = [...duplicates.map.values()].filter((d) => d.status === 'pending').slice(0, Number(args.limit) || 200)
      if (!kind || kind === 'conflicts') out.conflicts = [...conflicts.map.values()].filter((c) => c.status === 'open').slice(0, Number(args.limit) || 200)
      return print(out)
    }
    case 'apply': {
      const r = await applyPending({
        dataRoot,
        personaId,
        pendingIds: listArg(args.pending),
        expectedGeneration: args['expected-generation'] ? Number(args['expected-generation']) : undefined,
        confirm: Boolean(args.confirm),
        applyId: args['apply-id'] && args['apply-id'] !== true ? String(args['apply-id']) : undefined,
      })
      return print(r, r.ok ? 0 : 1)
    }
    case 'restore': {
      const r = await restoreChunks({ dataRoot, personaId, chunkIds: listArg(args.chunks) })
      return print(r, r.ok ? 0 : 1)
    }
    case 'verify': {
      const r = await verifyProcess({ dataRoot, personaId })
      return print(r, r.ok ? 0 : 1)
    }
    case 'repair': {
      const r = await repairProcess({ dataRoot, personaId })
      return print(r, r.ok ? 0 : 1)
    }
    case 'rebuild': {
      const r = await rebuildProcess({ dataRoot, personaId, confirm: Boolean(args.confirm) })
      return print(r, r.ok ? 0 : 1)
    }
    case 'export': {
      const r = await exportProcess({ dataRoot, personaId, out: args.out && args.out !== true ? String(args.out) : null })
      return print(r, r.ok ? 0 : 1)
    }
    case 'conflict-add': {
      const r = await addConflict({
        dataRoot,
        personaId,
        chunkIds: listArg(args.chunks),
        kind: args.kind && args.kind !== true ? String(args.kind) : 'unexplained-contradiction',
        note: args.note && args.note !== true ? String(args.note) : '用户手动标记',
      })
      return print(r, r.ok ? 0 : 1)
    }
    case 'archive':
    case 'expire': {
      const ids = listArg(args.chunk ?? args.chunks)
      const r = await createManualPending({
        dataRoot,
        personaId,
        kind: cmd,
        chunkIds: ids,
        proposed: {},
        reason: 'user:manual',
        confidence: 1,
      })
      return print(r, r.ok ? 0 : 1)
    }
    case 'topics': {
      const r = await apiTopics({ dataRoot, personaId })
      return print(r)
    }
    case 'conflicts': {
      const r = await apiConflicts({ dataRoot, personaId, status: args.status && args.status !== true ? String(args.status) : 'open' })
      return print(r)
    }
    case 'api': {
      const what = args._[1] ?? 'overview'
      let r
      if (what === 'context') {
        r = await apiContext({
          dataRoot,
          workspace: args.workspace && args.workspace !== true ? String(args.workspace) : null,
          personaId: args.persona && args.persona !== true ? String(args.persona) : null,
        })
      } else if (what === 'capabilities') r = apiCapabilities()
      else if (what === 'overview') r = await apiOverview({ dataRoot, personaId })
      else if (what === 'root-storage') r = await apiRootStorage({ dataRoot, personaId })
      else if (what === 'memories') {
        r = await apiMemories({
          dataRoot, personaId,
          status: args.status && args.status !== true ? String(args.status) : null,
          role: args.role && args.role !== true ? String(args.role) : null,
          channel: args.channel && args.channel !== true ? String(args.channel) : null,
          q: args.q && args.q !== true ? String(args.q) : null,
          chunkIds: args.chunkIds && args.chunkIds !== true ? String(args.chunkIds) : null,
          session: args.session && args.session !== true ? String(args.session) : null,
          topicId: args.topicId && args.topicId !== true ? String(args.topicId) : null,
          conflictGroup: args.conflictGroup && args.conflictGroup !== true ? String(args.conflictGroup) : null,
          includeText: Boolean(args['include-text']),
          limit: Number(args.limit) || 50,
          offset: Number(args.offset) || 0,
        })
      } else if (what === 'memory') {
        r = await apiMemory({ dataRoot, personaId, chunkId: String(args.chunk ?? args.chunkId ?? ''), includeText: args['include-text'] !== false })
      } else if (what === 'chunks') {
        r = await apiChunks({ dataRoot, personaId, chunkIds: listArg(args.chunkIds ?? args.chunks), includeText: Boolean(args['include-text']) })
      } else if (what === 'topics') r = await apiTopics({ dataRoot, personaId })
      else if (what === 'pending') r = await apiPending({ dataRoot, personaId, kind: args.kind && args.kind !== true ? String(args.kind) : null })
      else if (what === 'conflicts') r = await apiConflicts({ dataRoot, personaId })
      else if (what === 'verify') r = await apiVerify({ dataRoot, personaId })
      else if (what === 'status') r = await apiStatus({ dataRoot, personaId })
      else r = { ok: false, code: 'BAD_ARGS', error: { code: 'BAD_ARGS', message: `未知 api：${what}` } }
      return print(r, r.ok ? 0 : 1)
    }
    default: {
      print({
        ok: false,
        code: 'BAD_ARGS',
        error: {
          code: 'BAD_ARGS',
          message: `用法：cli.mjs <status|run|review|apply|restore|verify|repair|rebuild|export|conflict-add|archive|expire|api|topics|conflicts> [--data-root <根藏>] [--persona <id>]`,
        },
      }, 1)
    }
  }
}

main().catch((e) => {
  print({ ok: false, code: e.code || 'CLI_FAILED', error: { code: e.code || 'CLI_FAILED', message: String(e.message || e) } }, 1)
})
