/**
 * lib/lock.mjs —— scope 级单写者锁（F4）
 *
 * 规则：
 *   · `scopes/<personaId>/.lock`（pid + 时间 + 主机）；
 *   · 拿不到就排队等，等不到返回 LOCK_BUSY，**不做 last-write-wins**；
 *   · 陈旧锁（进程已死 / 超过 staleMs）改名进 _archive 再抢，不直接删。
 */
import { open, rename, unlink, readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CODES } from './errors.mjs'
import { ensureDir, readJson } from './fsatomic.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程在，只是没权限
    return e.code === 'EPERM'
  }
}

/**
 * 拿锁。
 * @returns {Promise<{ok:true, file:string, release:()=>Promise<void>, stolen?:string}|{ok:false, code:string, error:object, held?:any}>}
 */
export async function acquireLock(scopeDir, opts = {}) {
  const { timeoutMs = 5000, staleMs = 10 * 60 * 1000, pollMs = 100, now = Date.now } = opts
  await ensureDir(scopeDir)
  const file = join(scopeDir, '.lock')
  const started = now()
  const token = randomUUID()
  let stolen = null

  for (;;) {
    try {
      const fh = await open(file, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: hostname(), token, tool: 'dsh-memory-store' }), 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      /**
       * 释放：只有「文件里还是我自己的 token」才删。
       * 否则（锁被抢走/被改名/被别人重建）绝不删别人的锁 —— 否则两个写者会互相踩。
       */
      const release = async () => {
        try {
          const r = await readJson(file)
          if (r.ok && r.value?.token === token) {
            await unlink(file)
            return { released: true }
          }
          return { released: false, reason: r.ok ? 'not-owner' : 'lock-gone' }
        } catch {
          return { released: false, reason: 'error' }
        }
      }
      return { ok: true, file, token, release, stolen }
    } catch (e) {
      if (e.code !== 'EEXIST') {
        return { ok: false, code: e.code || CODES.WRITE_EXCLUSIVE_FAILED, error: { code: e.code || 'LOCK_FAILED', message: String(e.message || e) } }
      }
    }

    // 有人持有：判断是否陈旧
    let held = null
    try {
      const r = await readJson(file)
      if (r.ok) held = r.value
    } catch { /* 读不到当未知 */ }

    let age = Infinity
    try { age = now() - (await stat(file)).mtimeMs } catch { /* 刚被释放 */ }

    const stale = age > staleMs || (held && held.host === hostname() && !pidAlive(Number(held.pid)))

    if (stale) {
      const dest = join(scopeDir, '_archive', `lock-stale-${Date.now()}.json`)
      try {
        await ensureDir(join(scopeDir, '_archive'))
        await rename(file, dest)
        stolen = dest
        continue
      } catch { /* 抢不到就继续等 */ }
    }

    if (now() - started >= timeoutMs) {
      return {
        ok: false,
        code: CODES.LOCK_BUSY,
        error: {
          code: CODES.LOCK_BUSY,
          message: `scope 正被另一个写者占用（${held ? `pid ${held.pid} @ ${held.at}` : '未知持有者'}）`,
        },
        held,
      }
    }
    await sleep(pollMs)
  }
}

/** 只读探测：锁在不在（status 用，不抢）；不返回 token */
export async function peekLock(scopeDir) {
  const file = join(scopeDir, '.lock')
  try {
    const raw = await readFile(file, 'utf8')
    const info = JSON.parse(raw)
    const ageMs = Date.now() - (await stat(file)).mtimeMs
    const alive = info?.host === hostname() ? pidAlive(Number(info.pid)) : null
    return { exists: true, info: { pid: info?.pid ?? null, at: info?.at ?? null, host: info?.host ?? null, tool: info?.tool ?? null }, ageMs, alive }
  } catch {
    return { exists: false }
  }
}
