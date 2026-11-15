/**
 * lib/backup.mjs —— 变更前备份（F3）
 *
 * 规则：
 *   · 变更前自动备份，落到 `_archive/<reason>-<时间>/`；
 *   · 备份用独占创建（COPYFILE_EXCL），**绝不覆盖更早备份**；
 *   · 「已备份」指纹只在替换成功后才提交；失败写不推进指纹；
 *   · 常规备份不能当不可逆删除的唯一后路（purge 另存独立快照，见 F6）。
 */
import { copyFile, mkdir, stat, constants } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { hashFile, atomicWrite, pathExists, readJson } from './fsatomic.mjs'
import { archiveDir } from './paths.mjs'
import { getArchiveRoot } from './archive.mjs'
import { pruneArchives } from './retention.mjs'

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/**
 * 把 scope 里若干文件独占复制到 `_archive/<reason>-<stamp>/`。
 * @returns {Promise<{ok:true, dir:string, files:Array<{name:string, bytes:number, sha256:string}>, stamp:string, reason:string}>}
 */
export async function archiveBeforeWrite(root, personaId, files, reason = 'write') {
  const ts = stamp()
  // 配了 archiveDir 就写到别的盘（C 盘只留正在用的数据）；没配则留在 scope/_archive
  const ar = getArchiveRoot()
  const dir = ar
    ? join(ar, '_archive', personaId, `${reason}-${ts}`)
    : join(archiveDir(root, personaId), `${reason}-${ts}`)
  await mkdir(dir, { recursive: true })
  const out = []
  for (const src of files) {
    if (!(await pathExists(src))) continue
    // 只备份常规文件；目录/符号链接跳过（否则 copyFile 直接失败，连备份都做不成）
    const st0 = await stat(src)
    if (!st0.isFile()) continue
    const name = basename(src)
    const dest = join(dir, name)
    // COPYFILE_EXCL：目标已存在就失败，不覆盖更早备份
    await copyFile(src, dest, constants.COPYFILE_EXCL)
    const st = await stat(dest)
    out.push({ name, bytes: st.size, sha256: await hashFile(dest) })
  }
  const result = { ok: true, dir, files: out, stamp: ts, reason }
  // 只保留最近 2 份：配了 archiveDir → 旧份移到归档的 cold 目录；没配 → 清理更旧的（防 C 盘无限增长）
  try {
    result.pruned = await pruneArchives(root, personaId, { keep: 2 })
  } catch (e) {
    result.pruneError = e?.code || e?.message || String(e)
  }
  return result
}

/**
 * 替换成功后提交指纹（失败写不得推进指纹 —— F3）。
 * @param {{dir:string, files:Array, stamp?:string, reason?:string}} backup
 */
export async function commitFingerprint(backup, extra = {}) {
  const payload = {
    reason: backup.reason || 'write',
    stamp: backup.stamp || null,
    committedAt: new Date().toISOString(),
    files: backup.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    ...extra,
  }
  await atomicWrite(join(backup.dir, '.fingerprint.json'), JSON.stringify(payload, null, 2) + '\n')
  return payload
}

/** 读指纹（verify 用） */
export async function readFingerprint(backupDir) {
  return readJson(join(backupDir, '.fingerprint.json'))
}
