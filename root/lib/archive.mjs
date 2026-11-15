/**
 * lib/archive.mjs —— 归档目录（备份/回退快照放到别的盘）
 *
 * 目的：C 盘只留「正在用的那一份」；历史备份/回退快照移到用户指定目录。
 * 解析顺序：设置 archiveDir > 环境变量 JIANMU_ARCHIVE_DIR > 空（不归档）。
 * 为空时各模块退化为「只保留最近 N 份并清理更旧」，保证不会无限增长。
 */
import { join } from 'node:path'

let current = ''

export function setArchiveRoot(v) {
  current = String(v || '').trim()
}

export function getArchiveRoot() {
  const v = current || String(process.env.JIANMU_ARCHIVE_DIR || '').trim()
  return v || ''
}

/** 归档子目录；未配置归档时返回 '' */
export function archiveSubdir(...parts) {
  const root = getArchiveRoot()
  return root ? join(root, ...parts) : ''
}
