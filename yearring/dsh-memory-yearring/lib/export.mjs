/**
 * lib/export.mjs —— 年轮导出（只读：导出 claims + topic docs 的元数据/正文）
 *
 * 纪律：
 *   · 导出目标**只能落在 <dataRoot>/year/<personaId>/exports/ 内**
 *     （不能写回 claims/manifest 等运行时文件——审查实测过 outFile=claims.jsonl 会清空 claims）
 *   · 拒绝覆盖保留文件名（claims.jsonl / manifest.json / runs.jsonl / .lock / cost.jsonl）
 *   · 导出不删不写 claims；只读
 *   · 不导出 vectors（年轮没有向量）
 */
import { join, basename, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { yearDir, assertYearWrite, tsSlugMs, isInside } from './paths.mjs'
import { ensureDir, atomicWrite } from './fsatomic.mjs'
import { readClaims, readManifest, listTopicDocs } from './store.mjs'

/** 运行时文件：导出绝不能落到这些名字上（否则等于用导出毁库） */
export const RESERVED_NAMES = Object.freeze(['claims.jsonl', 'manifest.json', 'runs.jsonl', '.lock', 'cost.jsonl'])

export function exportsDirOf(dataRoot, personaId) {
  return join(yearDir(dataRoot, personaId), 'exports')
}

export async function exportYear({ dataRoot, personaId, outFile = null }) {
  const claims = await readClaims(dataRoot, personaId)
  const manifestRes = await readManifest(dataRoot, personaId)
  const docs = await listTopicDocs(dataRoot, personaId)

  const topicDocs = []
  for (const file of docs) {
    try {
      const text = await readFile(file, 'utf8')
      topicDocs.push({ file: file.split(/[\\/]/).pop(), bytes: Buffer.byteLength(text), text })
    } catch (e) {
      topicDocs.push({ file: file.split(/[\\/]/).pop(), error: e.code || String(e.message) })
    }
  }

  const bundle = {
    kind: 'yearring-export',
    exportedAt: Date.now(),
    personaId,
    manifest: manifestRes.ok ? manifestRes.manifest : { error: manifestRes.error },
    counts: { claims: claims.byId.size, groups: claims.byGroup.size, topicDocs: topicDocs.length },
    claims: [...claims.byId.values()],
    topicDocs,
  }

  // ── 目标路径：只允许 exports/ 子目录，且不能是运行时保留名
  const exportsDir = exportsDirOf(dataRoot, personaId)
  let target
  if (outFile) {
    target = resolve(String(outFile))
    if (!isInside(exportsDir, target)) {
      return {
        ok: false,
        code: 'BAD_EXPORT_PATH',
        error: {
          code: 'BAD_EXPORT_PATH',
          message: `导出只能写到 ${exportsDir} 之内（不接受 year/ 根下的运行时文件或其他目录）：${target}`,
        },
      }
    }
    if (RESERVED_NAMES.includes(basename(target).toLowerCase())) {
      return {
        ok: false,
        code: 'BAD_EXPORT_PATH',
        error: { code: 'BAD_EXPORT_PATH', message: `拒绝用导出覆盖运行时文件：${basename(target)}` },
      }
    }
  } else {
    target = join(exportsDir, `year-${personaId}-${tsSlugMs()}.json`)
  }

  try {
    assertYearWrite(dataRoot, personaId, target)
  } catch (e) {
    return {
      ok: false,
      code: 'BAD_EXPORT_PATH',
      error: { code: 'BAD_EXPORT_PATH', message: `导出路径被写闸门拒绝：${target}`, detail: e.detail ?? null },
    }
  }

  await ensureDir(exportsDir)
  const body = `${JSON.stringify(bundle, null, 2)}\n`
  await atomicWrite(target, body)
  return {
    ok: true,
    personaId,
    file: target,
    bytes: Buffer.byteLength(body),
    claims: claims.byId.size,
    topicDocs: topicDocs.length,
    note: '导出只读：不改 claims、不删任何东西；目标被限制在 exports/ 内',
  }
}
