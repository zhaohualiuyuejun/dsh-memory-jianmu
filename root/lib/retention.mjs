/**
 * lib/retention.mjs —— 备份保留策略（Stage 0）
 *
 * 规则：
 *   · 每次新建备份后，只保留最近 keep 份（默认 2）；
 *   · 配了归档目录（archiveDir / JIANMU_ARCHIVE_DIR）→ 超出的旧目录**移动**到
 *     <archiveDir>/_archive-archive/<personaId>/，C 盘只留在用的数据；
 *   · 未配归档目录 → 超出的旧目录**直接清理**（备份是可重建的写前快照，
 *     不清理会让 C 盘随时间无限增长）；
 *   · 移动优先 rename（同卷原子）；跨盘 EXDEV 时退化为「复制 + 删除」。
 */
import { readdir, stat, mkdir, rename, access, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { archiveDir } from './paths.mjs'
import { getArchiveRoot } from './archive.mjs'

async function dirBytes(dir) {
  let total = 0
  let files = 0
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return { bytes: 0, files: 0 } }
  for (const d of ents) {
    const p = join(dir, d.name)
    try {
      if (d.isDirectory()) {
        const sub = await dirBytes(p)
        total += sub.bytes; files += sub.files
      } else if (d.isFile()) {
        const s = await stat(p)
        total += s.size; files++
      }
    } catch { /* 忽略单个文件失败 */ }
  }
  return { bytes: total, files }
}

/** 目标名冲突时加后缀，绝不覆盖已有备份 */
async function uniqueDest(dest) {
  try { await access(dest); let n = 1; while (true) { const cand = `${dest}-${n}`; try { await access(cand) } catch { return cand } ; n++ } } catch { return dest }
}

async function moveDir(src, dest) {
  try { await rename(src, dest) } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    await cp(src, dest, { recursive: true, force: false, errorOnExist: true })
    await rm(src, { recursive: true, force: true })
  }
}

/**
 * @returns {Promise<{ok:true, keep:number, total:number, moved:Array, deleted:Array, backupRoot:string, errors:string[]}>}
 */
export async function pruneArchives(dataRoot, personaId, { keep = 2 } = {}) {
  const keepN = Math.max(1, Math.min(20, Number(keep) || 2))
  const ar = getArchiveRoot()
  // 配了归档 → 备份直接写在 <archiveDir>/_archive/<pid>，保留策略也扫这里
  const dir = ar ? join(ar, '_archive', personaId) : archiveDir(dataRoot, personaId)
  const backupRoot = ar ? join(ar, '_archive-archive', personaId) : ''
  const out = { ok: true, keep: keepN, total: 0, moved: [], deleted: [], backupRoot, errors: [] }

  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  const rows = []
  for (const d of ents) {
    if (!d.isDirectory()) continue
    const p = join(dir, d.name)
    const s = await stat(p).catch(() => null)
    rows.push({ name: d.name, dir: p, mtimeMs: s?.mtimeMs ?? 0 })
  }
  out.total = rows.length
  if (rows.length <= keepN) return out

  // 按 mtime 新 → 旧（目录名里的时间戳格式不统一，不能当主键；名字只做兜底）
  rows.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.name.localeCompare(a.name)))
  const old = rows.slice(keepN)
  for (const r of old) {
    try {
      const size = await dirBytes(r.dir)
      if (backupRoot) {
        await mkdir(backupRoot, { recursive: true })
        const dest = await uniqueDest(join(backupRoot, r.name))
        await moveDir(r.dir, dest)
        out.moved.push({ name: r.name, bytes: size.bytes, files: size.files, to: dest })
      } else {
        await rm(r.dir, { recursive: true, force: true })
        out.deleted.push({ name: r.name, bytes: size.bytes, files: size.files })
      }
    } catch (e) {
      out.errors.push(`${r.name}: ${e?.code || e?.message || e}`)
    }
  }
  return out
}
