/**
 * lib/simhash.mjs —— 64-bit SimHash + 字符 3-gram Jaccard
 *
 * 设计（施工计划 §6.1）：
 *   · SimHash 64-bit 分 4 段 ×16-bit 分桶；Hamming ≤ 3 的候选必然至少一段相同；
 *   · 候选再用字符 3-gram Jaccard ≥ 0.9 复核；
 *   · 只同 scope，不做全量向量两两比。
 */
import { createHash } from 'node:crypto'

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

export function fnv1a32(str) {
  let h = FNV_OFFSET
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return h >>> 0
}

export function shingleHashes(text, n = 3) {
  const s = String(text ?? '')
  if (!s) return []
  if (s.length <= n) return [fnv1a32(s)]
  const out = []
  const seen = new Set()
  for (let i = 0; i + n <= s.length; i++) {
    const h = fnv1a32(s.slice(i, i + n))
    if (!seen.has(h)) { seen.add(h); out.push(h) }
  }
  return out
}

/** 64-bit SimHash（BigInt，0..2^64-1） */
export function simhash64(text) {
  const hashes = shingleHashes(text, 3)
  if (hashes.length === 0) return 0n
  const v = new Int32Array(64)
  for (const h of hashes) {
    const h2 = (Math.imul(h ^ 0x9e3779b9, FNV_PRIME) ^ (h >>> 13)) >>> 0
    for (let b = 0; b < 32; b++) {
      v[b] += (h >>> b) & 1 ? 1 : -1
      v[32 + b] += (h2 >>> b) & 1 ? 1 : -1
    }
  }
  let out = 0n
  for (let b = 0; b < 64; b++) {
    if (v[b] > 0) out |= (1n << BigInt(b))
  }
  return out
}

export function hamming64(a, b) {
  let x = (a ^ b) & ((1n << 64n) - 1n)
  let n = 0
  while (x) {
    x &= x - 1n
    n++
  }
  return n
}

/** 4 段 ×16-bit 分桶键 */
export function bandKeys(sim) {
  const out = []
  for (let k = 0; k < 4; k++) {
    const v = (sim >> BigInt(16 * k)) & 0xffffn
    out.push(v.toString(16).padStart(4, '0'))
  }
  return out
}

export function hex64(sim) {
  return sim.toString(16).padStart(16, '0')
}

export function jaccard3(aText, bText, cache = null) {
  const a = getSet(aText, cache)
  const b = getSet(bText, cache)
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  const small = a.size <= b.size ? a : b
  const big = a.size <= b.size ? b : a
  let inter = 0
  for (const h of small) if (big.has(h)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 1 : inter / union
}

function getSet(text, cache) {
  if (cache && cache.has(text)) return cache.get(text)
  const set = new Set(shingleHashes(text, 3))
  if (cache) cache.set(text, set)
  return set
}

export function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}
