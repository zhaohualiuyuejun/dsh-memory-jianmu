/**
 * 2026-11-08：切块器收敛到共享库 `dsh-jianmu-utterance-core`（唯一实现）。
 * 保留本文件只为兼容既有相对 import（ingest.mjs / tools/*）；行为与共享库一致。
 */
export * from 'dsh-jianmu-utterance-core/lib/chunker.mjs'
