/**
 * lib/store.mjs —— 镜台的 registry / manifest / versions 读写
 *
 * 所有写都走：锁 → 读当前 → 校验 expectedGeneration → 备份 → 原子写 → 读回。
 * 本模块只提供落盘原语；业务顺序在 write.mjs。
 */
import { join } from 'node:path'
import {
  ensureDir, readJson, writeJsonAtomic, readJsonl, appendJsonl, pathExists, fileSize,
} from './fsatomic.mjs'
import { acquireLock, peekLock } from './lock.mjs'
import {
  personaRoot, registryFile, globalManifestFile, cardDir, cardFile, cardManifestFile,
  versionsFile, cardsDir, importsDir, personaLockFile, assertPersonaWritable, assertPersonaWritableReal, isSafeCardId,
} from './paths.mjs'
import { parseCard, serializeCard } from './card.mjs'
import { SCHEMA_VERSION, CONTRACT_VERSION, VERSION } from './version.mjs'

const now = () => Date.now()

// ── 初始化 ───────────────────────────────────────────────────────────────

export async function ensurePersonaLayout(dataRoot) {
  const root = personaRoot(dataRoot)
  await ensureDir(root)
  await ensureDir(cardsDir(dataRoot))
  await ensureDir(importsDir(dataRoot))
  const mf = globalManifestFile(dataRoot)
  const rf = registryFile(dataRoot)
  assertPersonaWritable(dataRoot, mf)
  assertPersonaWritable(dataRoot, rf)
  await assertPersonaWritableReal(dataRoot, mf)
  await assertPersonaWritableReal(dataRoot, rf)
  if (!(await pathExists(mf))) {
    await writeJsonAtomic(mf, {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      generation: 0,
      dataRoot: String(dataRoot),
      createdAt: now(),
      updatedAt: now(),
      lastError: null,
      writer: { name: 'dsh-memory-persona', version: VERSION },
    })
  }
  if (!(await pathExists(rf))) {
    await writeJsonAtomic(rf, {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      generation: 0,
      activeCardId: null,
      cards: {},
      workspaces: {},
      workspaceList: [],
      sessions: {},
      settings: { source: 'soul-md', readOnly: true, injection: null },
      updatedAt: now(),
    })
  }
  return { ok: true, root }
}

// ── 全局 manifest ────────────────────────────────────────────────────────

export async function readGlobalManifest(dataRoot) {
  const r = await readJson(globalManifestFile(dataRoot))
  if (!r.ok) return r
  const v = r.value
  if (!v || typeof v !== 'object') {
    return { ok: false, code: 'MANIFEST_INVALID', error: { code: 'MANIFEST_INVALID', message: '全局 manifest 不是对象' } }
  }
  if (v.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: 'SCHEMA_UNSUPPORTED', error: { code: 'SCHEMA_UNSUPPORTED', message: `schemaVersion ${v.schemaVersion} 不受支持` } }
  }
  if (v.contractVersion !== undefined && v.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, code: 'CONTRACT_UNSUPPORTED', error: { code: 'CONTRACT_UNSUPPORTED', message: `contractVersion ${v.contractVersion} 不受支持` } }
  }
  return { ok: true, manifest: v, encoding: r.encoding }
}

export async function writeGlobalManifest(dataRoot, manifest) {
  const file = globalManifestFile(dataRoot)
  assertPersonaWritable(dataRoot, file)
  await assertPersonaWritableReal(dataRoot, file)
  await writeJsonAtomic(file, { ...manifest, updatedAt: now() })
  return readGlobalManifest(dataRoot)
}

// ── registry ─────────────────────────────────────────────────────────────

export async function readRegistry(dataRoot) {
  const r = await readJson(registryFile(dataRoot))
  if (!r.ok) return r
  const v = r.value
  if (!v || typeof v !== 'object') {
    return { ok: false, code: 'MANIFEST_INVALID', error: { code: 'MANIFEST_INVALID', message: 'registry 不是对象' } }
  }
  if (v.contractVersion !== undefined && v.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, code: 'CONTRACT_UNSUPPORTED', error: { code: 'CONTRACT_UNSUPPORTED', message: `registry contractVersion ${v.contractVersion} 不受支持` } }
  }
  return { ok: true, registry: v }
}

export async function writeRegistry(dataRoot, registry) {
  const file = registryFile(dataRoot)
  assertPersonaWritable(dataRoot, file)
  await assertPersonaWritableReal(dataRoot, file)
  await writeJsonAtomic(file, { ...registry, updatedAt: now() })
  return readRegistry(dataRoot)
}

// ── 卡片 manifest ────────────────────────────────────────────────────────

export async function readCardManifest(dataRoot, cardId) {
  const r = await readJson(cardManifestFile(dataRoot, cardId))
  if (!r.ok) return r
  const v = r.value
  if (v && typeof v === 'object' && v.contractVersion !== undefined && v.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, code: 'CONTRACT_UNSUPPORTED', error: { code: 'CONTRACT_UNSUPPORTED', message: `卡片 manifest contractVersion ${v.contractVersion} 不受支持` } }
  }
  return r
}

export async function writeCardManifest(dataRoot, cardId, manifest) {
  const file = cardManifestFile(dataRoot, cardId)
  assertPersonaWritable(dataRoot, file)
  await assertPersonaWritableReal(dataRoot, file)
  await writeJsonAtomic(file, { ...manifest, updatedAt: now() })
  return readCardManifest(dataRoot, cardId)
}

// ── 读卡 ─────────────────────────────────────────────────────────────────

export async function readCard(dataRoot, cardId) {
  const file = cardFile(dataRoot, cardId)
  const fs = await import('node:fs/promises')
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, code: 'CARD_NOT_FOUND', error: { code: 'CARD_NOT_FOUND', message: `卡片不存在：${cardId}` } }
    return { ok: false, code: 'READ_FAILED', error: { code: 'READ_FAILED', message: String(e.message || e) } }
  }
  const parsed = parseCard(raw)
  if (!parsed.hadFrontMatter) {
    return { ok: false, code: 'CARD_PARSE_FAILED', error: { code: 'CARD_PARSE_FAILED', message: `card.md 缺少 front-matter：${file}` } }
  }
  const fm = parsed.frontMatter
  // 跨 persona 守卫：一卡一人格，front-matter 必须与目录/cardId 一致
  if (fm.id && fm.id !== cardId) {
    return { ok: false, code: 'CARD_ID_MISMATCH', error: { code: 'CARD_ID_MISMATCH', message: `卡 front-matter.id=${fm.id} 与目录 ${cardId} 不一致` } }
  }
  if (fm.personaId && fm.personaId !== cardId) {
    return { ok: false, code: 'CARD_ID_MISMATCH', error: { code: 'CARD_ID_MISMATCH', message: `卡 front-matter.personaId=${fm.personaId} 与卡 ${cardId} 不一致（v1a 一卡一人格）` } }
  }
  if (fm.memoryScope && fm.memoryScope !== cardId) {
    return { ok: false, code: 'CARD_ID_MISMATCH', error: { code: 'CARD_ID_MISMATCH', message: `卡 front-matter.memoryScope=${fm.memoryScope} 与卡 ${cardId} 不一致（v1a 一卡一人格）` } }
  }
  const mf = await readCardManifest(dataRoot, cardId)
  return {
    ok: true,
    cardId,
    raw,
    frontMatter: parsed.frontMatter,
    body: parsed.body,
    zones: parsed.zones,
    zoneHashes: parsed.zoneHashes,
    sourceHash: parsed.sourceHash,
    manifest: mf.ok ? mf.value : null,
    manifestError: mf.ok ? null : mf,
  }
}

export async function writeCard(dataRoot, cardId, frontMatter, body) {
  const file = cardFile(dataRoot, cardId)
  assertPersonaWritable(dataRoot, file)
  await assertPersonaWritableReal(dataRoot, file)
  await ensureDir(cardDir(dataRoot, cardId))
  const text = serializeCard(frontMatter, body)
  const { atomicWrite } = await import('./fsatomic.mjs')
  const w = await atomicWrite(file, text)
  return { ...w, text }
}

// ── versions ─────────────────────────────────────────────────────────────

export async function readVersions(dataRoot, cardId) {
  const r = await readJsonl(versionsFile(dataRoot, cardId))
  if (!r.exists) return { ok: true, rows: [], corrupt: [], tornTail: false }
  // latest-wins：同一 revision 只保留最后一条（追加顺序），再按 revision 升序
  const byRev = new Map()
  for (const x of r.rows) {
    if (!x || typeof x !== 'object') continue
    const rev = Number(x.revision)
    if (!Number.isFinite(rev)) continue
    byRev.set(rev, x)
  }
  const rows = [...byRev.values()].sort((a, b) => Number(a.revision) - Number(b.revision))
  return { ok: r.corrupt.length === 0, rows, corrupt: r.corrupt, tornTail: r.tornTail }
}

export async function appendVersion(dataRoot, cardId, row) {
  const file = versionsFile(dataRoot, cardId)
  assertPersonaWritable(dataRoot, file)
  await assertPersonaWritableReal(dataRoot, file)
  await appendJsonl(file, [{ ...row, createdAt: row.createdAt ?? now() }], { durable: true })
  return readVersions(dataRoot, cardId)
}

// ── 列表 ─────────────────────────────────────────────────────────────────

export async function listCardDirs(dataRoot) {
  const fs = await import('node:fs/promises')
  try {
    const ents = await fs.readdir(cardsDir(dataRoot), { withFileTypes: true })
    return ents.filter((d) => d.isDirectory() && isSafeCardId(d.name)).map((d) => d.name).sort()
  } catch { return [] }
}

export async function listCards(dataRoot) {
  const reg = await readRegistry(dataRoot)
  const registry = reg.ok ? reg.registry : { cards: {}, activeCardId: null }
  const dirs = await listCardDirs(dataRoot)
  const cards = []
  for (const id of dirs) {
    const c = await readCard(dataRoot, id)
    if (!c.ok) {
      cards.push({ cardId: id, broken: true, error: c.error })
      continue
    }
    cards.push({
      cardId: id,
      name: c.frontMatter.name ?? registry.cards?.[id]?.name ?? id,
      personaId: c.frontMatter.personaId ?? id,
      memoryScope: c.frontMatter.memoryScope ?? id,
      source: c.frontMatter.source ?? registry.cards?.[id]?.source ?? 'manual',
      status: c.frontMatter.status ?? 'active',
      version: Number(c.frontMatter.version) || Number(c.manifest?.version) || 0,
      updatedAt: Number(c.frontMatter.updatedAt) || Number(c.manifest?.updatedAt) || 0,
      isDefault: registry.activeCardId === id,
      inRegistry: Boolean(registry.cards?.[id]),
      manifestOk: Boolean(c.manifest),
    })
  }
  return {
    ok: true,
    cards,
    activeCardId: registry.activeCardId ?? null,
    registryCards: registry.cards ?? {},
    orphanDirs: dirs.filter((id) => !registry.cards?.[id]),
    missingDirs: Object.keys(registry.cards ?? {}).filter((id) => !dirs.includes(id)),
  }
}

// ── 解析默认卡 ───────────────────────────────────────────────────────────

function normWs(p) {
  return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function resolveFromRegistry(registry, { workspace = null, sessionId = null } = {}) {
  const sid = sessionId ? String(sessionId) : null
  if (sid && registry?.sessions && Object.prototype.hasOwnProperty.call(registry.sessions, sid)) {
    const v = registry.sessions[sid]
    return { cardId: v === 'none' ? null : v, source: 'session', key: sid }
  }
  if (workspace) {
    const target = normWs(workspace)
    let best = null
    for (const [w, v] of Object.entries(registry?.workspaces ?? {})) {
      const nw = normWs(w)
      if (target === nw || target.startsWith(nw + '\\')) {
        if (!best || nw.length > best.len) best = { v, len: nw.length, key: w }
      }
    }
    if (best) return { cardId: best.v === 'none' ? null : best.v, source: 'workspace', key: best.key }
  }
  const active = registry?.activeCardId ?? null
  return { cardId: active || null, source: active ? 'default' : 'none', key: null }
}

export async function resolveCardId(dataRoot, args = {}) {
  if (args.cardId) {
    if (!isSafeCardId(args.cardId)) {
      return { ok: false, code: 'BAD_CARD_ID', error: { code: 'BAD_CARD_ID', message: `cardId 非法：${args.cardId}` } }
    }
    return { ok: true, cardId: String(args.cardId), source: 'explicit' }
  }
  if (args.personaId) {
    if (!isSafeCardId(args.personaId)) {
      return { ok: false, code: 'BAD_CARD_ID', error: { code: 'BAD_CARD_ID', message: `personaId 非法：${args.personaId}` } }
    }
    return { ok: true, cardId: String(args.personaId), source: 'explicit-persona' }
  }
  const reg = await readRegistry(dataRoot)
  if (!reg.ok) return reg
  const resolved = resolveFromRegistry(reg.registry, { workspace: args.workspace, sessionId: args.sessionId })
  if (!resolved.cardId) {
    return {
      ok: false,
      code: 'CARD_NOT_FOUND',
      error: { code: 'CARD_NOT_FOUND', message: '没有可用的人格卡：registry 未设默认卡，也没有命中的工作区/会话绑定' },
    }
  }
  return { ok: true, cardId: resolved.cardId, source: resolved.source, key: resolved.key }
}

// ── 锁 ───────────────────────────────────────────────────────────────────

export async function withPersonaLock(dataRoot, fn, opts = {}) {
  await ensurePersonaLayout(dataRoot)
  const lock = await acquireLock(personaRoot(dataRoot), opts)
  if (!lock.ok) return lock
  try {
    return await fn()
  } finally {
    try { await lock.release() } catch { /* 忽略 */ }
  }
}

export async function peekPersonaLock(dataRoot) {
  return peekLock(personaRoot(dataRoot))
}

// ── 身份 ─────────────────────────────────────────────────────────────────

export async function readIdentity(dataRoot) {
  const r = await readJson(join(dataRoot, 'identity.json'))
  if (!r.ok) return { ok: false, code: r.code, error: r.error }
  const v = r.value
  if (!v || typeof v !== 'object' || !v.personas || typeof v.personas !== 'object') {
    return { ok: false, code: 'MANIFEST_INVALID', error: { code: 'MANIFEST_INVALID', message: 'identity.json 缺少 personas' } }
  }
  return { ok: true, identity: v, personas: v.personas }
}

/** 卡名（如「Alice」）→ personaId；只按 displayName 精确匹配，不猜 */
export function personaIdByName(personas, name) {
  const target = String(name || '').trim()
  if (!target) return null
  for (const [pid, meta] of Object.entries(personas || {})) {
    const display = String(meta?.displayName || '').trim()
    if (display === target) return pid
    if (String(pid).toLowerCase() === target.toLowerCase()) return pid
  }
  return null
}

export { readJson, readJsonl, fileSize }
