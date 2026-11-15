/**
 * lib/export.mjs —— 导出熏习状态（备份用，只读根藏）
 *
 * 只导出 status/topic 元数据，不导出原文正文（正文在根藏，可另由根藏 export）。
 * 输出目标必须在 process/<personaId>/ 之内（守卫：所有写只落熏习目录）。
 */
import { join, resolve, basename } from 'node:path'
import { processDir, assertProcessWrite, tsSlugMs, isInside, PROCESS_FILES } from './paths.mjs'
import {
  readManifest, readStateMap, readPendingMap, readDuplicatesMap,
  readConflictsMap, readTopics,
} from './store.mjs'
import { writeExclusive, ensureDir } from './fsatomic.mjs'
import { toErrInfo } from './errors.mjs'

const FORBIDDEN_EXPORT_NAMES = new Set([...Object.values(PROCESS_FILES), 'manifest.json', '.lock'])

export async function exportProcess(opts = {}) {
  const { dataRoot, personaId, out = null, now = Date.now } = opts
  try {
    const man = await readManifest(dataRoot, personaId)
    if (!man.ok) return { ok: false, code: man.code, error: man.error }
    const [state, pending, duplicates, conflicts, topics] = await Promise.all([
      readStateMap(dataRoot, personaId),
      readPendingMap(dataRoot, personaId),
      readDuplicatesMap(dataRoot, personaId),
      readConflictsMap(dataRoot, personaId),
      readTopics(dataRoot, personaId),
    ])
    const payload = {
      kind: 'jianmu-process-export',
      schemaVersion: 1,
      contractVersion: 1,
      personaId,
      exportedAt: now,
      manifest: man.manifest,
      state: [...state.map.values()],
      pending: [...pending.map.values()],
      duplicates: [...duplicates.map.values()],
      conflicts: [...conflicts.map.values()],
      topics: topics.topics,
      topicMembers: topics.members,
    }
    const archiveDir = join(processDir(dataRoot, personaId), '_archive')
    const file = out ? resolve(String(out)) : join(archiveDir, `export-${tsSlugMs()}.json`)
    if (!isInside(archiveDir, file) || basename(file) === 'manifest.json' || FORBIDDEN_EXPORT_NAMES.has(basename(file))) {
      return {
        ok: false,
        code: 'BAD_EXPORT_PATH',
        error: { code: 'BAD_EXPORT_PATH', message: `导出目标必须在 process/<personaId>/_archive/ 内，且不能是状态文件：${file}` },
      }
    }
    assertProcessWrite(dataRoot, personaId, file)
    await ensureDir(archiveDir)
    await writeExclusive(file, `${JSON.stringify(payload, null, 2)}\n`)
    return {
      ok: true,
      file,
      bytes: JSON.stringify(payload).length,
      counts: {
        state: payload.state.length,
        pending: payload.pending.length,
        duplicates: payload.duplicates.length,
        conflicts: payload.conflicts.length,
        topics: payload.topics.length,
        topicMembers: payload.topicMembers.length,
      },
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      return { ok: false, code: 'EXPORT_FAILED', error: { code: 'EXPORT_FAILED', message: '导出目标已存在，拒绝覆盖（请换文件名）' } }
    }
    return { ok: false, code: e.code || 'EXPORT_FAILED', error: toErrInfo(e) }
  }
}
