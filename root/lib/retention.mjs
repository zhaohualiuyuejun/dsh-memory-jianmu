/**
 * lib/retention.mjs —— _archive 保留策略（Stage 0）
 *
 * 规则：
 *   · 每次新建备份后，只保留最近 keep 份（默认 2）；
 *   · 超出的旧目录**移动**到 <dataRoot>/_backup/archive/<personaId>/，不物理删除；
 *   · 移动用 rename（同一 dataRoot 内 = 同卷，原子且快），失败只报告不动手；
 *   · 清理 _backup 必须由人确认后再做（本模块不提供删除入口）。
 */
import { readdir, stat, mkdir, rename, access } from 'node:fs/promises'
import { join } from 'node:path'
import { archiveDir } from './paths.mjs'

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

/**
 * @returns {Promise<{ok:true, keep:number, total:number, moved:Array<{name:string,bytes:number,files:number,to:string}>, backupRoot:string, errors:string[]}>}
 */
export async function pruneArchives(dataRoot, personaId, { keep = 2 } = {}) {
  const keepN = Math.max(1, Math.min(20, Number(keep) || 2))
  const dir = archiveDir(dataRoot, personaId)
  const backupRoot = join(dataRoot, '_backup', 'archive', personaId)
  const out = { ok: true, keep: keepN, total: 0, moved: [], backupRoot, errors: [] }

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
      await mkdir(backupRoot, { recursive: true })
      const dest = await uniqueDest(join(backupRoot, r.name))
      const size = await dirBytes(r.dir)
      await rename(r.dir, dest)
      out.moved.push({ name: r.name, bytes: size.bytes, files: size.files, to: dest })
    } catch (e) {
      out.errors.push(`${r.name}: ${e?.code || e?.message || e}`)
    }
  }
  return out
}
