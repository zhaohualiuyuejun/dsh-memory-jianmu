/**
 * lib/version.mjs —— 版本口径（单点真源 = package.json）
 *
 * 三个版本别混：
 *   · VERSION         包体版本（发布/归档文件名用）
 *   · CONTRACT_VERSION 层间契约版本（读取方 > 本值 → 拒绝写）
 *   · SCHEMA_VERSION   chunks.jsonl 行内 schema 版本
 */
import { readFileSync } from 'node:fs'

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** 层间契约版本：见 CONTRACT-v1.md */
export const CONTRACT_VERSION = 1

/** chunks.jsonl 行 schema 版本 */
export const SCHEMA_VERSION = 1

/** 写进每行的摄取器版本 */
export const INGEST_VERSION = VERSION

/** 向量归一化口径：换算法要改这个值，旧库会被标「需重嵌」 */
export const NORMALIZER_VERSION = 'l2-v1'

/** 报告里用的自报身份 */
export const WRITER = Object.freeze({ name: 'dsh-memory-store', version: VERSION })
