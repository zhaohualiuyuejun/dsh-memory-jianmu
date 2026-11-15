/**
 * lib/fsatomic.mjs —— 落盘原语（沿用根藏附录 F1/F2/F8/F9 的纪律）
 *
 * 纪律：
 *   · 原子写 = tmp(wx 独占) → write → fsync → close → rename；失败清 tmp，绝不回报 ok。
 *   · 读 JSON 容忍 UTF-8 / UTF-16 BOM；写出一律 UTF-8 无 BOM。
 *   · JSONL 读取把「末尾半行」当撕裂尾巴（tornTail），不当作损坏；中间坏行必须暴露。
 *   · 写后读回：found / missing / unknown 三态分开（unknown ≠ 成功）。
 */
import { mkdir, open, rename, unlink, readFile, readdir, stat, truncate } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

const rand = () => randomBytes(6).toString('hex')

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function pathExists(file) {
  try { await stat(file); return true } catch { return false }
}

export async function fileSize(file) {
  try { return (await stat(file)).size } catch { return -1 }
}

export function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom', hadBom: true }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le-bom', hadBom: true }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2))
    const even = body.length - (body.length % 2)
    body.subarray(0, even).swap16()
    return { text: body.subarray(0, even).toString('utf16le'), encoding: 'utf16be-bom', hadBom: true }
  }
  return { text: buf.toString('utf8'), encoding: 'utf8', hadBom: false }
}

/** 读 JSON（容忍 BOM）。解析失败不回落默认值，返回明确错误。 */
export async function readJson(file) {
  let buf
  try {
    buf = await readFile(file)
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, code: 'ENOENT', error: { code: 'ENOENT', message: `文件不存在：${file}` } }
    return { ok: false, code: e.code || 'READ_FAILED', error: { code: e.code || 'READ_FAILED', message: `读失败：${e.message}` } }
  }
  const { text, encoding, hadBom } = decodeTextBuffer(buf)
  try {
    return { ok: true, value: JSON.parse(text), encoding, hadBom, bytes: buf.length }
  } catch (e) {
    return {
      ok: false,
      code: 'JSON_PARSE',
      error: { code: 'JSON_PARSE', message: `JSON 解析失败（${file}）：${e.message}` },
      encoding,
      bytes: buf.length,
    }
  }
}

/** 原子写。只承诺「单文件 + 同目录 rename + 旧或新完整」。 */
export async function atomicWrite(file, data, opts = {}) {
  const { mode = 0o600 } = opts
  const dir = dirname(file)
  await ensureDir(dir)
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${rand()}`)
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  let fh = null
  try {
    fh = await open(tmp, 'wx', mode)
    await fh.writeFile(buf)
    await fh.sync()
    await fh.close()
    fh = null
    await rename(tmp, file)
    return { ok: true, path: file, bytes: buf.length }
  } catch (e) {
    try { if (fh) await fh.close() } catch { /* 忽略 */ }
    try { await unlink(tmp) } catch { /* 没建出来就算了 */ }
    const err = new Error(`原子写失败（${file}）：${e.message}`)
    err.code = 'WRITE_ATOMIC_FAILED'
    err.detail = { file, tmp, cause: e.code || e.message }
    throw err
  }
}

export async function writeJsonAtomic(file, value) {
  return atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 独占创建（绝不覆盖已有文件）；备份/快照用 */
export async function writeExclusive(file, data, opts = {}) {
  const { mode = 0o600 } = opts
  await ensureDir(dirname(file))
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  let fh = null
  try {
    fh = await open(file, 'wx', mode)
    await fh.writeFile(buf)
    await fh.sync()
    await fh.close()
    fh = null
    return { ok: true, path: file, bytes: buf.length }
  } catch (e) {
    try { if (fh) await fh.close() } catch { /* 忽略 */ }
    const err = new Error(`独占写失败（${file}）：${e.message}`)
    err.code = e.code === 'EEXIST' ? 'EEXIST' : 'WRITE_EXCLUSIVE_FAILED'
    err.detail = { file, cause: e.code || e.message }
    throw err
  }
}

/** 追加 JSONL。失败时截回原尺寸，避免半行把下一次追加拼成中间坏行。 */
export async function appendJsonl(file, rows, opts = {}) {
  const { durable = false } = opts
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, bytes: 0, lines: 0 }
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  await ensureDir(dirname(file))
  const preBytes = await fileSize(file)
  let fh = null
  try {
    fh = await open(file, 'a')
    await fh.writeFile(text, 'utf8')
    if (durable) await fh.datasync()
    await fh.close()
    fh = null
    return { ok: true, bytes: Buffer.byteLength(text), lines: rows.length }
  } catch (e) {
    try { if (fh) await fh.close() } catch { /* 忽略 */ }
    let truncated = false
    try {
      if (preBytes >= 0) { await truncate(file, preBytes); truncated = true }
    } catch { /* 截断失败：错误里带出来 */ }
    const err = new Error(`JSONL 追加失败（${file}）：${e.message}`)
    err.code = 'WRITE_ATOMIC_FAILED'
    err.detail = { file, cause: e.code || e.message, preBytes, truncated }
    throw err
  }
}

/**
 * 读 JSONL。最后一非空行坏了 → tornTail（可接受）；中间坏行 → corrupt（必须暴露）。
 */
export async function readJsonl(file) {
  let buf
  try {
    buf = await readFile(file)
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, rows: [], lines: 0, bytes: 0, corrupt: [], tornTail: false }
    return { exists: false, rows: [], lines: 0, bytes: 0, corrupt: [], tornTail: false, error: { code: e.code, message: e.message } }
  }
  const { text } = decodeTextBuffer(buf)
  const all = text.split('\n')
  let lastIdx = -1
  for (let i = all.length - 1; i >= 0; i--) if (all[i].trim()) { lastIdx = i; break }
  const rows = []
  const corrupt = []
  let tornTail = false
  for (let i = 0; i < all.length; i++) {
    const s = all[i]
    if (!s.trim()) continue
    try {
      rows.push(JSON.parse(s))
    } catch (e) {
      if (i === lastIdx) tornTail = true
      else corrupt.push({ line: i + 1, error: String(e.message || e) })
    }
  }
  return { exists: true, rows, lines: rows.length, bytes: buf.length, corrupt, tornTail }
}

/** 文件 sha256（流式） */
export async function hashFile(file) {
  const { createReadStream } = await import('node:fs')
  const h = createHash('sha256')
  await new Promise((res, rej) => {
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('end', res)
    s.on('error', rej)
  })
  return h.digest('hex')
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export async function listOrphanTmp(dir) {
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  return ents.filter((d) => d.isFile() && /\.tmp-\d+-[0-9a-f]+$/.test(d.name)).map((d) => join(dir, d.name))
}

export async function clearOrphanTmp(dir) {
  const files = await listOrphanTmp(dir)
  const removed = []
  for (const f of files) {
    try { await unlink(f); removed.push(f) } catch { /* 忽略 */ }
  }
  return removed
}

/** 把文件复制到备份目录（不存在就跳过）；返回是否复制 */
export async function copyFileIfExists(src, destDir, name = basename(src)) {
  await ensureDir(destDir)
  try {
    const data = await readFile(src)
    const dest = join(destDir, name)
    await writeExclusive(dest, data)
    return { ok: true, dest, bytes: data.length }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing' }
    if (e.code === 'EEXIST') return { ok: false, reason: 'exists' }
    throw e
  }
}
