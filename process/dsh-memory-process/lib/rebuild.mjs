/**
 * lib/rebuild.mjs —— 从根藏 + ruleVersion 重建 state / duplicates / conflicts
 *
 * · 不调 LLM、不重嵌（本包从不读向量）；
 * · 先快照到 _archive/rebuild-<ts>/，再清空这三份日志，然后用 run(force) 重建；
 * · pending / topics 不动（候选与归属是用户面数据，重建不替用户做决定）；
 * · 同 ruleVersion 下，重建结果的状态/分类/组 id 可复现。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireLock } from './lock.mjs'
import { readManifest, readStateMap, readPendingMap, readConflictsMap, backupLogs } from './store.mjs'
import { readScope } from './root.mjs'
import { runProcess } from './run.mjs'
import { atomicWrite, ensureDir } from './fsatomic.mjs'
import { processFile, processDir, assertProcessWrite, PROCESS_FILES } from './paths.mjs'
import { toErrInfo } from './errors.mjs'

export async function rebuildProcess(opts = {}) {
  const { dataRoot, personaId, confirm = false, includeUserState = false, now = Date.now } = opts
  if (!confirm) {
    return { ok: false, code: 'CONFIRM_REQUIRED', error: { code: 'CONFIRM_REQUIRED', message: 'rebuild 会重写状态日志，需要 confirm=true' } }
  }
  const lock = await acquireLock(processDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }
  try {
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }

    // 用户态保护：rebuild 只从根藏 + 规则重建；用户 restore/归档/过期、已应用候选、
    // 手工冲突都是用户决定，不能静默丢掉。v1a 默认拒绝，回放留 v1.1。
    const [state, pending, conflicts, root] = await Promise.all([
      readStateMap(dataRoot, personaId),
      readPendingMap(dataRoot, personaId),
      readConflictsMap(dataRoot, personaId),
      readScope(dataRoot, personaId),
    ])
    const userStates = [...state.map.values()].filter((s) => s.source === 'user' || String(s.reason ?? '').startsWith('user:'))
    const appliedPending = [...pending.map.values()].filter((p) => p.status === 'applied')
    const manualConflicts = [...conflicts.map.values()].filter((c) => c.ruleRef == null || String(c.ruleRef?.ruleId ?? '').startsWith('user:'))
    const userStateCount = userStates.length + appliedPending.length + manualConflicts.length
    if (userStateCount > 0) {
      return {
        ok: false,
        code: includeUserState ? 'NOT_IMPLEMENTED' : 'REBUILD_USER_STATE_PRESENT',
        error: {
          code: includeUserState ? 'NOT_IMPLEMENTED' : 'REBUILD_USER_STATE_PRESENT',
          message: includeUserState
            ? 'v1a 尚未实现用户态回放；请先用 export 备份并等待 v1.1'
            : '检测到用户态（restore/归档/过期/已应用候选/手工冲突）；rebuild 会丢掉它们，已拒绝。请先 export 备份，或等待 v1.1 用户态回放',
          userStates: userStates.length,
          appliedPending: appliedPending.length,
          manualConflicts: manualConflicts.length,
        },
        counts: { userStates: userStates.length, appliedPending: appliedPending.length, manualConflicts: manualConflicts.length },
      }
    }

    if (!root.ok) return { ok: false, code: root.code, error: root.error }
    const maxChunks = Math.max(1, root.chunks.length)

    // 快照（state/duplicates/conflicts + manifest + pending；pending 只备份不重写）
    const snap = await backupLogs(dataRoot, personaId, 'rebuild', ['state', 'duplicates', 'conflicts', 'pending', 'topics', 'topicMembers'])

    for (const key of ['state', 'duplicates', 'conflicts']) {
      const file = processFile(dataRoot, personaId, key)
      assertProcessWrite(dataRoot, personaId, file)
      await ensureDir(processDir(dataRoot, personaId))
      await atomicWrite(file, '')
    }

    // 让 run 重跑（外层已持锁）；maxChunks 必须覆盖全量，否则只重建前 20000 块
    const r = await runProcess({ dataRoot, personaId, force: true, skipLock: true, maxChunks, now })
    if (!r.ok) {
      // 失败回滚：把快照里的三份日志按原字节放回去，避免留下空 state
      for (const key of ['state', 'duplicates', 'conflicts']) {
        const name = PROCESS_FILES[key]
        try {
          const data = await readFile(join(snap.dir, name))
          await atomicWrite(processFile(dataRoot, personaId, key), data)
        } catch { /* 回滚失败不掩盖原错误 */ }
      }
      return { ok: false, code: r.code || 'REBUILD_FAILED', error: r.error, snapshot: snap.dir, rolledBack: true }
    }
    return {
      ok: true,
      personaId,
      snapshot: snap.dir,
      generation: r.generation,
      state: r.state,
      duplicates: r.duplicates,
      conflicts: r.conflicts,
      llmCalls: 0,
      reembedCalls: 0,
      elapsedMs: r.elapsedMs,
    }
  } catch (e) {
    return { ok: false, code: e.code || 'REBUILD_FAILED', error: toErrInfo(e) }
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}
