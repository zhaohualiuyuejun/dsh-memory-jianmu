/**
 * lib/write.mjs —— 镜台的写动作（create / save / delete / default / bind / rollback / import）
 *
 * 顺序：锁 → 读当前 → 校验 expectedGeneration → 备份 → 原子写 → 版本追加 → 读回。
 * 失败绝不回报 ok；部分写入给 PARTIAL_WRITE 并让 verify 能发现。
 */
import { readFile, readdir, rename, cp, unlink, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import {
  ensureDir, readJson, readJsonl, writeJsonAtomic, appendJsonl, pathExists, atomicWrite,
} from './fsatomic.mjs'
import {
  cardDir, cardFile, cardManifestFile, versionsFile, cardArchiveDir, importsDir, registryFile,
  assertPersonaWritable, assertPersonaWritableReal, isSafeCardId, personaRoot, tsSlugMs, profilePatchFile,
} from './paths.mjs'
import {
  readCard, writeCard, readCardManifest, writeCardManifest, readVersions, appendVersion,
  readRegistry, writeRegistry, readGlobalManifest, readIdentity, listCardDirs,
  withPersonaLock, resolveCardId, personaIdByName,
} from './store.mjs'
import { parseCard, templateCard, replaceZones, serializeCard, protectedDiff, sha256, zoneOutline } from './card.mjs'
import { validateSettingsPatch, pickInjectSettings, invalidateRegistrySettingsSync, INJECT_SETTINGS_KEYS } from './settings.mjs'
import { invalidateSyncCache } from './cardsync.mjs'
import { SCHEMA_VERSION, CONTRACT_VERSION, VERSION } from './version.mjs'

const now = () => Date.now()

function err(code, message, detail) {
  return { ok: false, code, error: { code, message, detail: detail ?? null } }
}

// ── 内部：generation 事务 ────────────────────────────────────────────────

/**
 * 在锁内执行一次写事务；成功后 generation+1。
 * 失败语义：任何一步失败 → 先恢复 registry/全局 manifest，再跑 fn 注册的 rollback，
 * 保证不出现「card.md 已改、版本链没行、generation 没动」的半提交。
 *
 * @param {object} args
 * @param {string} args.dataRoot
 * @param {number|string} args.expectedGeneration
 * @param {(ctx:{manifest:object, generation:number, registry:object, registerRollback:(f:Function)=>void}) => Promise<any>} fn
 */
async function withWriteTransaction({ dataRoot, expectedGeneration, fn }) {
  return withPersonaLock(dataRoot, async () => {
    const gm = await readGlobalManifest(dataRoot)
    if (!gm.ok) return gm
    const manifest = gm.manifest
    const expected = Number(expectedGeneration)
    if (!Number.isFinite(expected)) {
      return err('STALE_GENERATION', 'expectedGeneration 必填：先调 status 读当前 generation，再带回来')
    }
    if (expected !== Number(manifest.generation)) {
      return err('STALE_GENERATION', `generation 已变化（期望 ${expected}，当前 ${manifest.generation}）；请重新读取后再写`, {
        expected, current: manifest.generation,
      })
    }
    const reg = await readRegistry(dataRoot)
    if (!reg.ok) return reg
    const registry = reg.registry

    const globalFile = join(personaRoot(dataRoot), 'manifest.json')
    const registryPath = join(personaRoot(dataRoot), 'registry.json')
    const rollbacks = []
    const registerRollback = (f) => { if (typeof f === 'function') rollbacks.push(f) }
    const runRollbacks = async () => {
      let ok = true
      for (const f of rollbacks.reverse()) {
        try { await f() } catch { ok = false }
      }
      return ok
    }
    /** 失败收尾：恢复 registry/全局 manifest，再跑数据级回滚 */
    const abort = async (message, cause) => {
      let metaOk = true
      try { await writeJsonAtomic(registryPath, registry) } catch { metaOk = false }
      try { await writeJsonAtomic(globalFile, manifest) } catch { metaOk = false }
      try {
        await writeJsonAtomic(globalFile, {
          ...manifest,
          lastError: { code: 'PARTIAL_WRITE', message, at: now(), cause: cause === undefined ? null : String(cause?.message || cause) },
        })
      } catch { /* 恢复都失败时不再覆盖 */ }
      const dataOk = await runRollbacks()
      const rolledBack = metaOk && dataOk
      return err('PARTIAL_WRITE', `${message}${rolledBack ? '，已回滚' : '，回滚不完整（请用 status --deep 检查）'}`, {
        cause: cause === undefined ? null : String(cause?.message || cause),
        rolledBack,
        metaRestored: metaOk,
        dataRolledBack: dataOk,
      })
    }

    let result
    try {
      result = await fn({ manifest, generation: Number(manifest.generation), registry, registerRollback })
    } catch (e) {
      return abort('写动作中途失败', e)
    }
    if (!result || result.ok === false) {
      // fn 主动拒绝：如果它已经登记过回滚，一并执行
      const rolled = await runRollbacks()
      if (!rolled) return { ...(result || err('PARTIAL_WRITE', '写动作被拒绝且回滚不完整')), rollbackFailed: true }
      return result || err('PARTIAL_WRITE', '写动作被拒绝')
    }

    // noop 写（例如「设置没有变化」）不占 generation：否则会白白让别人的 CAS 失效
    const nextGen = Number(manifest.generation) + (result.noop === true ? 0 : 1)
    const nextRegistry = { ...(result.registry || registry), generation: nextGen, updatedAt: now() }
    try {
      assertPersonaWritable(dataRoot, globalFile)
      assertPersonaWritable(dataRoot, registryPath)
      await assertPersonaWritableReal(dataRoot, globalFile)
      await assertPersonaWritableReal(dataRoot, registryPath)
      await writeJsonAtomic(registryPath, nextRegistry)
      await writeJsonAtomic(globalFile, { ...manifest, generation: nextGen, lastError: null, updatedAt: now() })
      if (result.versionRow) {
        const { cardId, row } = result.versionRow
        await appendVersion(dataRoot, cardId, row)
      }
    } catch (e) {
      return abort('提交阶段失败', e)
    }
    if (typeof result.afterCommit === 'function') {
      try { await result.afterCommit() } catch { /* 非关键（快照等） */ }
    }
    return { ...result, ok: true, generation: nextGen, registry: nextRegistry }
  })
}

/** 读回校验：found / missing / mismatch / unknown */
async function readback(dataRoot, cardId, expectedHash) {
  try {
    const c = await readCard(dataRoot, cardId)
    if (!c.ok) return { status: 'missing', error: c.error }
    if (c.sourceHash === expectedHash) return { status: 'found', sourceHash: c.sourceHash }
    return { status: 'mismatch', expected: expectedHash, actual: c.sourceHash }
  } catch (e) {
    return { status: 'unknown', error: String(e?.message || e) }
  }
}

/** 备份当前卡到 _archive/revision-<n>-<ts>/ */
async function snapshotRevision(dataRoot, cardId, { raw, frontMatter, zoneHashes, version, reason }) {
  const dir = join(cardArchiveDir(dataRoot, cardId), `revision-${version}-${tsSlugMs()}`)
  assertPersonaWritable(dataRoot, dir)
  await ensureDir(dir)
  const cardDest = join(dir, 'card.md')
  assertPersonaWritable(dataRoot, cardDest)
  await assertPersonaWritableReal(dataRoot, cardDest)
  await (await import('./fsatomic.mjs')).writeExclusive(cardDest, raw)
  const fp = {
    cardId,
    revision: version,
    createdAt: now(),
    reason,
    hash: sha256(raw),
    zoneHashes,
    frontMatter,
  }
  const fpFile = join(dir, '.fingerprint.json')
  assertPersonaWritable(dataRoot, fpFile)
  await assertPersonaWritableReal(dataRoot, fpFile)
  await writeJsonAtomic(fpFile, fp)
  return { dir, fingerprint: fp }
}

/** 找某 revision 的快照 */
async function findRevisionSnapshot(dataRoot, cardId, revision) {
  const arch = cardArchiveDir(dataRoot, cardId)
  let ents = []
  try { ents = await readdir(arch, { withFileTypes: true }) } catch { return null }
  const names = ents.filter((e) => e.isDirectory() && e.name.startsWith(`revision-${revision}-`)).map((e) => e.name).sort()
  if (!names.length) return null
  const dir = join(arch, names[names.length - 1])
  const file = join(dir, 'card.md')
  try {
    const raw = await readFile(file, 'utf8')
    return { dir, file, raw }
  } catch { return null }
}

function nextVersionOf(card) {
  const fm = Number(card?.frontMatter?.version)
  if (Number.isFinite(fm) && fm >= 1) return fm
  const mf = Number(card?.manifest?.version)
  return Number.isFinite(mf) && mf >= 1 ? mf : 0
}

function registryCardEntry(card, manifest) {
  return {
    name: card.frontMatter.name ?? manifest.name,
    source: card.frontMatter.source ?? manifest.source ?? 'manual',
    status: card.frontMatter.status ?? manifest.status ?? 'active',
    version: Number(card.frontMatter.version) || Number(manifest.version) || 1,
  }
}

// ── 新建卡 ───────────────────────────────────────────────────────────────

export async function createCard({
  dataRoot, cardId, name, personaId, memoryScope, content, source = 'manual',
  expectedGeneration, confirm = false, author = 'user',
}) {
  if (!confirm) return err('CONFIRM_REQUIRED', '新建卡必须带 confirm=true')
  if (!isSafeCardId(cardId)) return err('BAD_CARD_ID', `cardId 非法：${cardId}（[a-z0-9][a-z0-9_-]{0,63}）`)
  const pid = String(personaId || cardId)
  const scope = String(memoryScope || cardId)
  if (pid !== cardId || scope !== cardId) {
    return err('CARD_ID_MISMATCH', `v1a 一卡一人格：cardId = personaId = memoryScope（收到 ${cardId}/${pid}/${scope}）`)
  }
  const identity = await readIdentity(dataRoot)
  const personas = identity.ok ? (identity.personas || {}) : {}
  const personaRegistered = Boolean(personas[pid])
  const warning = identity.ok
    ? (personaRegistered ? null : `persona「${pid}」不在 <dataRoot>/identity.json 里：卡可以建，但在 identity 注册前它没有记忆 scope（identity 归根藏，只读）`)
    : `identity.json 不可读（${identity.code || identity.error?.code || 'UNKNOWN'}）：卡可以建，但无法确认 persona 注册与记忆 scope`

  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry, registerRollback }) => {
    if (await pathExists(cardDir(dataRoot, cardId))) return err('CARD_EXISTS', `卡片已存在：${cardId}`)
    const body = content !== undefined && content !== null && String(content).trim()
      ? String(content)
      : templateCard(name || personas[pid]?.displayName || cardId, pid)
    const parsed = parseCard(body)
    if (parsed.frontMatter?.id && parsed.frontMatter.id !== cardId) {
      return err('CARD_ID_MISMATCH', `提交内容的 id=${parsed.frontMatter.id} 与目标卡 ${cardId} 不一致`)
    }
    const displayName = String(name || personas[pid]?.displayName || cardId)
    const fm = {
      id: cardId,
      name: displayName,
      personaId: pid,
      memoryScope: scope,
      source,
      status: 'active',
      version: 1,
      updatedAt: now(),
    }
    const raw = serializeCard(fm, parsed.body)
    const finalParsed = parseCard(raw)

    registerRollback(async () => {
      try { await rm(cardDir(dataRoot, cardId), { recursive: true, force: true }) } catch { /* 回滚失败由事务层报告 */ }
    })
    await ensureDir(cardDir(dataRoot, cardId))
    const w = await writeCard(dataRoot, cardId, fm, parsed.body)
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      cardId,
      personaId: pid,
      name: displayName,
      memoryScope: scope,
      source,
      status: 'active',
      version: 1,
      createdAt: now(),
      updatedAt: now(),
      sourceHash: sha256(raw),
      zoneHashes: finalParsed.zoneHashes,
      zones: finalParsed.zones,
      importedFrom: null,
      lastSave: { revision: 1, author, at: now() },
    }
    const mw = await writeCardManifest(dataRoot, cardId, manifest)
    if (!mw.ok) return err('PARTIAL_WRITE', '卡已写但 manifest 写失败', { cardId })
    // 每个 revision 都留快照，保证任何版本都能直接回滚
    let snapshotOk = false
    try {
      await snapshotRevision(dataRoot, cardId, {
        raw, frontMatter: fm, zoneHashes: finalParsed.zoneHashes, version: 1, reason: 'initial revision',
      })
      snapshotOk = true
    } catch { /* 快照失败不阻断建卡；version 行记 snapshot=false */ }
    await appendVersion(dataRoot, cardId, {
      revision: 1, createdAt: now(), author, reason: source === 'mirror:soul-md' ? 'import from soul-md' : 'create',
      hash: sha256(raw), prevHash: null, note: `source=${source}`, snapshot: snapshotOk,
    })
    const nextRegistry = {
      ...registry,
      cards: { ...(registry.cards || {}), [cardId]: { name: displayName, source, status: 'active', version: 1 } },
    }
    const rb = await readback(dataRoot, cardId, manifest.sourceHash)
    if (rb.status !== 'found') return err('READBACK_MISMATCH', `写后读回异常：${rb.status}`, rb)
    return { ok: true, cardId, name: displayName, source, version: 1, personaRegistered, warning, sourceHash: manifest.sourceHash, readback: rb, registry: nextRegistry, zones: zoneOutline(finalParsed.body, finalParsed.zones) }
  } })
}

// ── 保存 ─────────────────────────────────────────────────────────────────

export async function saveCard({
  dataRoot, cardId, content, behavior, style, expectedGeneration, confirm = false,
  note = '', author = 'user', allowProtectedSectionsChange = false,
}) {
  if (!confirm) return err('CONFIRM_REQUIRED', '保存必须带 confirm=true')
  const resolved = await resolveCardId(dataRoot, { cardId })
  if (!resolved.ok) return resolved
  const id = resolved.cardId
  if (!isSafeCardId(id)) return err('BAD_CARD_ID', `cardId 非法：${id}`)

  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry, registerRollback }) => {
    const current = await readCard(dataRoot, id)
    if (!current.ok) return current
    const bodyNow = current.body
    const zonesNow = current.zones
    let newBody = bodyNow
    let replaced = []
    if (content !== undefined && content !== null && String(content).length > 0 && (behavior !== undefined || style !== undefined)) {
      return err('CARD_PARSE_FAILED', 'content 与 behavior/style 只能二选一：要么给完整正文，要么只给分区')
    }
    if (content !== undefined && content !== null && String(content).length > 0) {
      const parsed = parseCard(String(content))
      for (const [field, value] of [['id', parsed.frontMatter?.id], ['personaId', parsed.frontMatter?.personaId], ['memoryScope', parsed.frontMatter?.memoryScope]]) {
        if (value && value !== id) {
          return err('CARD_ID_MISMATCH', `提交内容的 ${field}=${value} 与目标卡 ${id} 不一致（v1a 一卡一人格）`)
        }
      }
      newBody = parsed.body
    } else if (behavior !== undefined || style !== undefined) {
      const r = replaceZones(bodyNow, zonesNow, { behavior, style })
      if (!r.ok) return err(r.code, r.message)
      newBody = r.body
      replaced = r.replaced
    } else {
      return err('CARD_PARSE_FAILED', '保存需要 content，或至少一个行为/风格分区正文')
    }

    const parsedNew = parseCard(newBody)
    if (!parsedNew.body.trim()) return err('CARD_PARSE_FAILED', '保存后的卡正文为空')

    const before = parseCard(current.raw)
    const changedProtected = protectedDiff(before, parsedNew)
    if (changedProtected.length && !(allowProtectedSectionsChange && confirm)) {
      return err('IMMUTABLE_SECTION_CHANGED', `受保护分区被改动：${changedProtected.join(', ')}；普通保存直接拒绝（AI 草稿需二次确认 allowProtectedSectionsChange=true）`, { changed: changedProtected })
    }

    const versionNow = nextVersionOf(current)
    const nextVersion = versionNow + 1
    const fmNow = { ...current.frontMatter }
    const fmNext = {
      ...fmNow,
      id,
      name: fmNow.name ?? current.manifest?.name ?? id,
      personaId: id,
      memoryScope: id,
      source: fmNow.source ?? current.manifest?.source ?? 'manual',
      status: fmNow.status ?? 'active',
      version: nextVersion,
      updatedAt: now(),
    }
    const rawNext = serializeCard(fmNext, parsedNew.body)
    const parsedNext = parseCard(rawNext)

    // 备份失败 → 不写
    let snap
    try {
      snap = await snapshotRevision(dataRoot, id, {
        raw: current.raw,
        frontMatter: fmNow,
        zoneHashes: before.zoneHashes,
        version: versionNow,
        reason: `save → revision ${nextVersion}`,
      })
    } catch (e) {
      return err('WRITE_EXCLUSIVE_FAILED', `备份失败，未写入：${String(e?.message || e)}`)
    }

    // 任何后续失败 → 恢复 card.md 与 card manifest（registry/全局 manifest 由事务层恢复）
    registerRollback(async () => {
      await atomicWrite(cardFile(dataRoot, id), current.raw)
      if (current.manifest) await writeJsonAtomic(cardManifestFile(dataRoot, id), current.manifest)
      else { try { await unlink(cardManifestFile(dataRoot, id)) } catch { /* 原本就没有 */ } }
    })

    await writeCard(dataRoot, id, fmNext, parsedNew.body)
    const manifest = {
      ...(current.manifest || {}),
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      cardId: id,
      personaId: fmNext.personaId,
      name: fmNext.name,
      memoryScope: fmNext.memoryScope,
      source: fmNext.source,
      status: fmNext.status,
      version: nextVersion,
      createdAt: current.manifest?.createdAt ?? now(),
      updatedAt: now(),
      sourceHash: sha256(rawNext),
      zoneHashes: parsedNext.zoneHashes,
      zones: parsedNext.zones,
      lastSave: { revision: nextVersion, author, at: now() },
    }
    await writeCardManifest(dataRoot, id, manifest)
    let snapshotOk = false
    try {
      await snapshotRevision(dataRoot, id, {
        raw: rawNext, frontMatter: fmNext, zoneHashes: parsedNext.zoneHashes, version: nextVersion, reason: `save revision ${nextVersion}`,
      })
      snapshotOk = true
    } catch { /* 快照失败不阻断保存；version 行记 snapshot=false */ }
    const versionRow = {
      cardId: id,
      row: {
        revision: nextVersion,
        createdAt: now(),
        author,
        reason: replaced.length ? `edit: ${replaced.join(', ')}` : 'edit: full content',
        hash: sha256(rawNext),
        prevHash: before.sourceHash,
        note: note || (changedProtected.length ? `protected changed: ${changedProtected.join(',')}` : ''),
        snapshot: snapshotOk,
      },
    }
    const nextRegistry = {
      ...registry,
      cards: { ...(registry.cards || {}), [id]: registryCardEntry({ frontMatter: fmNext }, manifest) },
    }
    const rb = await readback(dataRoot, id, manifest.sourceHash)
    if (rb.status !== 'found') throw new Error(`写后读回异常：${rb.status}`)
    return {
      ok: true, cardId: id, version: nextVersion, sourceHash: manifest.sourceHash,
      replaced, protectedChanged: changedProtected, snapshot: snap.dir, readback: rb,
      zones: zoneOutline(parsedNext.body, parsedNext.zones), registry: nextRegistry,
      versionRow,
    }
  } })
}

// ── 删除 ─────────────────────────────────────────────────────────────────

export async function deleteCard({ dataRoot, cardId, expectedGeneration, confirm = false }) {
  if (!confirm) return err('CONFIRM_REQUIRED', '删除必须带 confirm=true')
  if (!isSafeCardId(cardId)) return err('BAD_CARD_ID', `cardId 非法：${cardId}`)
  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry, registerRollback }) => {
    const current = await readCard(dataRoot, cardId)
    if (!current.ok) return current
    if (registry.activeCardId === cardId) {
      return err('DEFAULT_CARD_PROTECTED', '默认卡不能删：先把默认卡改成别的卡（或 none），再删')
    }
    // 统一放到 persona/_deleted/<ts>-<cardId>/<cardId>/，不物理删
    const ts = tsSlugMs()
    const deletedRoot = join(personaRoot(dataRoot), '_deleted')
    const target = join(deletedRoot, `${ts}-${cardId}`, cardId)
    assertPersonaWritable(dataRoot, target)
    await assertPersonaWritableReal(dataRoot, target)
    await ensureDir(join(deletedRoot, `${ts}-${cardId}`))
    try {
      await rename(cardDir(dataRoot, cardId), target)
    } catch (e) {
      // 跨卷/占用时退化为复制（不物理删，保留原目录并明确报告）
      try {
        await cp(cardDir(dataRoot, cardId), target, { recursive: true, errorOnExist: false })
      } catch (e2) {
        return err('WRITE_ATOMIC_FAILED', `删除失败：无法移入 _archive（${e.code || e.message}）`, { rename: String(e.message), copy: String(e2.message) })
      }
      return err('PARTIAL_WRITE', '无法移动卡片目录（可能被占用）；已复制到 _archive，原目录保留', { target })
    }
    registerRollback(async () => {
      try { await rename(target, cardDir(dataRoot, cardId)) } catch { /* 回滚失败由事务层报告 */ }
    })
    const removedBindings = []
    const workspaces = { ...(registry.workspaces || {}) }
    const sessions = { ...(registry.sessions || {}) }
    for (const [k, v] of Object.entries(workspaces)) if (v === cardId) { removedBindings.push({ scope: 'workspace', key: k }); delete workspaces[k] }
    for (const [k, v] of Object.entries(sessions)) if (v === cardId) { removedBindings.push({ scope: 'session', key: k }); delete sessions[k] }
    const cards = { ...(registry.cards || {}) }
    delete cards[cardId]
    const nextRegistry = { ...registry, cards, workspaces, sessions }
    // 元数据写失败不阻断删除（卡片本身已归档）；只在结果里如实报告
    let metaWarning = null
    try {
      const metaFile = join(deletedRoot, `${ts}-${cardId}`, 'delete.json')
      assertPersonaWritable(dataRoot, metaFile)
      await assertPersonaWritableReal(dataRoot, metaFile)
      await writeJsonAtomic(metaFile, { cardId, deletedAt: now(), removedBindings, archivedAt: target })
    } catch (e) {
      metaWarning = `delete.json 写入失败：${String(e?.message || e)}`
    }
    return { ok: true, cardId, archivedTo: target, removedBindings, warning: metaWarning, registry: nextRegistry }
  } })
}

// ── 默认卡 ───────────────────────────────────────────────────────────────

export async function setDefaultCard({ dataRoot, cardId, expectedGeneration, confirm = false }) {
  if (!confirm) return err('CONFIRM_REQUIRED', '设默认卡必须带 confirm=true')
  const target = String(cardId ?? '')
  const isNone = target === '' || target === 'none'
  if (!isNone && !isSafeCardId(target)) return err('BAD_CARD_ID', `cardId 非法：${target}`)
  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry }) => {
    if (!isNone) {
      const c = await readCard(dataRoot, target)
      if (!c.ok) return c
    }
    const nextRegistry = { ...registry, activeCardId: isNone ? null : target }
    return { ok: true, activeCardId: nextRegistry.activeCardId, previous: registry.activeCardId ?? null, registry: nextRegistry }
  } })
}

// ── 绑定 ─────────────────────────────────────────────────────────────────

export async function bindCard({ dataRoot, scope, key, cardId, expectedGeneration, confirm = false }) {
  if (!confirm) return err('CONFIRM_REQUIRED', '绑定必须带 confirm=true')
  const kind = String(scope || '')
  if (kind !== 'workspace' && kind !== 'session') return err('BAD_BINDING', 'scope 只允许 workspace / session')
  const k = String(key || '').trim()
  if (!k) return err('BAD_BINDING', 'key 不能为空')
  const value = String(cardId ?? '')
  const isNone = value === 'none'
  const isRemove = value === ''
  if (!isNone && !isRemove && !isSafeCardId(value)) return err('BAD_CARD_ID', `cardId 非法：${value}`)

  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry }) => {
    if (!isNone && !isRemove) {
      const c = await readCard(dataRoot, value)
      if (!c.ok) return c
    }
    const mapKey = kind === 'workspace' ? 'workspaces' : 'sessions'
    const map = { ...(registry[mapKey] || {}) }
    const previous = Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined
    if (isRemove) delete map[k]
    else map[k] = isNone ? 'none' : value
    const nextRegistry = { ...registry, [mapKey]: map }
    if (kind === 'workspace' && !isRemove) {
      const list = Array.isArray(registry.workspaceList) ? [...registry.workspaceList] : []
      if (!list.some((x) => String(x?.path || '').toLowerCase() === k.toLowerCase())) {
        list.push({ path: k, title: basename(k) || k })
        nextRegistry.workspaceList = list
      }
    }
    return { ok: true, scope: kind, key: k, cardId: isRemove ? null : (isNone ? 'none' : value), previous, registry: nextRegistry }
  } })
}

// ── 回滚 ─────────────────────────────────────────────────────────────────

export async function rollbackCard({ dataRoot, cardId, revision, expectedGeneration, confirm = false }) {
  if (!confirm) return err('CONFIRM_REQUIRED', '回滚必须带 confirm=true')
  const resolved = await resolveCardId(dataRoot, { cardId })
  if (!resolved.ok) return resolved
  const id = resolved.cardId
  const rev = Number(revision)
  if (!Number.isFinite(rev) || rev < 1) return err('VERSION_NOT_FOUND', `revision 非法：${revision}`)

  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry, registerRollback }) => {
    const current = await readCard(dataRoot, id)
    if (!current.ok) return current
    const snap = await findRevisionSnapshot(dataRoot, id, rev)
    if (!snap) return err('VERSION_NOT_FOUND', `找不到 revision ${rev} 的快照（_archive/revision-${rev}-*）`)
    const parsedSnap = parseCard(snap.raw)
    for (const [field, value] of [['id', parsedSnap.frontMatter?.id], ['personaId', parsedSnap.frontMatter?.personaId], ['memoryScope', parsedSnap.frontMatter?.memoryScope]]) {
      if (value && value !== id) return err('CARD_ID_MISMATCH', `快照 ${field}=${value} 与目标卡 ${id} 不一致`)
    }
    const versionNow = nextVersionOf(current)
    const nextVersion = versionNow + 1
    const fmNext = {
      ...current.frontMatter,
      id,
      name: current.frontMatter.name ?? current.manifest?.name ?? id,
      personaId: current.frontMatter.personaId ?? id,
      memoryScope: current.frontMatter.memoryScope ?? id,
      source: current.frontMatter.source ?? 'manual',
      status: 'active',
      version: nextVersion,
      updatedAt: now(),
    }
    const rawNext = serializeCard(fmNext, parsedSnap.body)
    const parsedNext = parseCard(rawNext)

    let snapCurrent
    try {
      snapCurrent = await snapshotRevision(dataRoot, id, {
        raw: current.raw,
        frontMatter: current.frontMatter,
        zoneHashes: parseCard(current.raw).zoneHashes,
        version: versionNow,
        reason: `rollback → revision ${rev}`,
      })
    } catch (e) {
      return err('WRITE_EXCLUSIVE_FAILED', `备份失败，未写入：${String(e?.message || e)}`)
    }

    registerRollback(async () => {
      await atomicWrite(cardFile(dataRoot, id), current.raw)
      if (current.manifest) await writeJsonAtomic(cardManifestFile(dataRoot, id), current.manifest)
      else { try { await unlink(cardManifestFile(dataRoot, id)) } catch { /* 原本就没有 */ } }
    })

    await writeCard(dataRoot, id, fmNext, parsedSnap.body)
    const manifest = {
      ...(current.manifest || {}),
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      cardId: id,
      personaId: fmNext.personaId,
      name: fmNext.name,
      memoryScope: fmNext.memoryScope,
      source: fmNext.source,
      status: 'active',
      version: nextVersion,
      createdAt: current.manifest?.createdAt ?? now(),
      updatedAt: now(),
      sourceHash: sha256(rawNext),
      zoneHashes: parsedNext.zoneHashes,
      zones: parsedNext.zones,
      lastSave: { revision: nextVersion, author: 'rollback', at: now() },
    }
    await writeCardManifest(dataRoot, id, manifest)
    let snapshotOk = false
    try {
      await snapshotRevision(dataRoot, id, {
        raw: rawNext, frontMatter: fmNext, zoneHashes: parsedNext.zoneHashes, version: nextVersion, reason: `rollback revision ${nextVersion}`,
      })
      snapshotOk = true
    } catch { /* 快照失败不阻断回滚；version 行记 snapshot=false */ }
    const versionRow = {
      cardId: id,
      row: {
        revision: nextVersion,
        createdAt: now(),
        author: 'rollback',
        reason: `rollback to revision ${rev}`,
        hash: sha256(rawNext),
        prevHash: parseCard(current.raw).sourceHash,
        note: `from ${basename(snap.dir)}`,
        snapshot: snapshotOk,
      },
    }
    const nextRegistry = {
      ...registry,
      cards: { ...(registry.cards || {}), [id]: registryCardEntry({ frontMatter: fmNext }, manifest) },
    }
    const rb = await readback(dataRoot, id, manifest.sourceHash)
    if (rb.status !== 'found') throw new Error(`写后读回异常：${rb.status}`)
    const bodyHash = sha256(parseCard(rawNext).body)
    const targetBodyHash = sha256(parsedSnap.body)
    return {
      ok: true, cardId: id, revision: nextVersion, rolledBackTo: rev,
      bodyMatchesTarget: bodyHash === targetBodyHash,
      snapshot: snap.dir, backupOfPrevious: snapCurrent.dir, readback: rb,
      registry: nextRegistry, versionRow,
    }
  } })
}

// ── 注入设置（v2 可写；落在 registry.settings） ──────────────────────────

/**
 * 写入注入设置。只碰 registry.settings / settingsRevision，不动任何卡片文件。
 *
 * 守卫：
 *  - confirm=true 必填（服务端不信任 UI）
 *  - 未知字段 / 类型错 / 越界 → 拒绝，不静默截断
 *  - expectedGeneration 必须等于当前 generation（与其它写动作同一把 CAS）
 * @returns 成功时给出 prev / settings / revision / generation，并带 requiresRestart 提示
 */
export async function saveSettings({ dataRoot, patch, expectedGeneration, confirm = false }) {
  if (!confirm) return err('CONFIRM_REQUIRED', '写注入设置必须带 confirm=true')
  const checked = validateSettingsPatch(patch)
  if (!checked.ok) return checked
  const next = checked.value

  const result = await withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry }) => {
    const prevAll = pickInjectSettings(registry.settings)
    const nextAll = { ...prevAll, ...next }
    const revision = (Number(registry.settingsRevision) || 0) + 1
    const changed = INJECT_SETTINGS_KEYS.filter((k) => prevAll[k] !== nextAll[k])
    if (!changed.length) {
      // 没有实际变化就不占一次 generation
      return {
        ok: true, noop: true, changed: [], settings: nextAll,
        revision: Number(registry.settingsRevision) || 0, registry,
      }
    }
    const nextRegistry = {
      ...registry,
      settings: nextAll,
      settingsRevision: revision,
      settingsUpdatedAt: now(),
    }
    const orderChanged = changed.some((k) => k === 'injectPersonaOrder' || k === 'injectMemoryOrder')
    return {
      ok: true,
      changed,
      settings: nextAll,
      previous: prevAll,
      revision,
      requiresRestart: orderChanged,
      requiresRestartReason: orderChanged ? '段顺序（persona/memory order）在启动时注册，改动需重启生效' : null,
      registry: nextRegistry,
    }
  } })
  // 落盘成功（且不是 noop）就丢掉同步读缓存，保证注入热路径立刻看到新值
  if (result.ok && !result.noop) {
    // 两套 mtime 缓存都要失效：settings 那套 + 注入热路径（cardsync）那套
    invalidateRegistrySettingsSync(registryFile(dataRoot))
    invalidateSyncCache(registryFile(dataRoot))
  }
  return result
}

// ── 从 soul-md 导入 ──────────────────────────────────────────────────────

/**
 * @param {object} a
 * @param {object} a.config 已解析的 soul-md 配置
 * @param {string} [a.sourceLabel] 证据：配置来源（settings / yaml / 手传）
 * @param {object} [a.rawConfig] 原始配置（写快照）
 * @param {string} [a.profileFile] profile 文件路径（复制快照）
 * @param {object} [a.mapping] 卡名 → personaId 的显式映射
 * @param {boolean} [a.importBindings=true]
 * @param {boolean} [a.preserveLocalBindings=true]
 */
export async function importFromSoulMd({
  dataRoot, config, sourceLabel = 'unknown', rawConfig = null, profileFile = null,
  mapping = {}, expectedGeneration, confirm = false, importBindings = true, preserveLocalBindings = true,
}) {
  if (!confirm) return err('CONFIRM_REQUIRED', '导入必须带 confirm=true')
  const identity = await readIdentity(dataRoot)
  const personas = identity.ok ? (identity.personas || {}) : {}
  const identityWarning = identity.ok ? null : `identity.json 不可读（${identity.code || identity.error?.code || 'UNKNOWN'}）：只能按显式 mapping 导入，未映射的卡会跳过`
  const cardsIn = config?.cards && typeof config.cards === 'object' ? config.cards : {}
  const names = Object.keys(cardsIn)
  if (!names.length) return err('IMPORT_NOTHING', 'soul-md 没有可导入的卡')

  return withWriteTransaction({ dataRoot, expectedGeneration, fn: async ({ registry, registerRollback }) => {
    const ts = tsSlugMs()
    const createdPids = []
    registerRollback(async () => {
      for (const pid of createdPids) {
        try { await rm(cardDir(dataRoot, pid), { recursive: true, force: true }) } catch { /* ignore */ }
      }
    })
    const importDir = join(importsDir(dataRoot), `soul-md-${ts}`)
    assertPersonaWritable(dataRoot, importDir)
    await assertPersonaWritableReal(dataRoot, importDir)
    await ensureDir(importDir)

    // 只保存 soul-md 的相关快照（cards + memory 设置）；**不复制整份 profile**，
    // 避免把无关配置/凭据带进 persona 目录。
    for (const f of ['cards.json', 'config.json', 'source.json', 'registry-before.json', 'fingerprint.json']) assertPersonaWritable(dataRoot, join(importDir, f))
    await writeJsonAtomic(join(importDir, 'cards.json'), cardsIn)
    await writeJsonAtomic(join(importDir, 'config.json'), {
      active: config.active ?? '', sessions: config.sessions ?? {}, workspaces: config.workspaces ?? {},
      workspaceList: config.workspaceList ?? [], memory: config.memory ?? null,
      allowTemplates: config.allowTemplates ?? false, skipSubagents: config.skipSubagents ?? false,
      sourceLabel,
    })
    await writeJsonAtomic(join(importDir, 'source.json'), {
      kind: 'soul-md',
      profileFile: profileFile || null,
      resolvedFrom: sourceLabel,
      importedAt: now(),
      rawConfigHash: rawConfig ? sha256(JSON.stringify(rawConfig)) : null,
      cardNames: names,
      note: '只存 soul-md 的卡与设置快照；不复制整份 profile（避免无关凭据进入 persona 目录）',
    })
    await writeJsonAtomic(join(importDir, 'registry-before.json'), registry)
    await writeJsonAtomic(join(importDir, 'fingerprint.json'), {
      cardsHash: sha256(JSON.stringify(cardsIn)),
      configHash: sha256(JSON.stringify({
        active: config.active ?? '', sessions: config.sessions ?? {}, workspaces: config.workspaces ?? {},
        workspaceList: config.workspaceList ?? [], memory: config.memory ?? null,
        allowTemplates: config.allowTemplates ?? false, skipSubagents: config.skipSubagents ?? false,
      })),
      rawConfigHash: rawConfig ? sha256(JSON.stringify(rawConfig)) : null,
      createdAt: now(),
    })

    const created = []
    const skipped = []
    const unmapped = []
    const cards = { ...(registry.cards || {}) }
    const nowTs = now()

    for (const cardName of names) {
      const rawCard = String(cardsIn[cardName] ?? '')
      const explicit = mapping?.[cardName]
      const pid = explicit || personaIdByName(personas, cardName)
      if (!pid) { unmapped.push({ cardName, reason: 'identity.json 没有同名 displayName；可在 mapping 里显式指定' }); continue }
      if (!isSafeCardId(pid)) { unmapped.push({ cardName, personaId: pid, reason: '映射出的 personaId 不合法' }); continue }
      if (await pathExists(cardDir(dataRoot, pid))) { skipped.push({ cardName, personaId: pid, reason: '卡片已存在（v1a 不覆盖）' }); continue }

      const parsed = parseCard(rawCard)
      const fm = {
        id: pid,
        name: String(cardName),
        personaId: pid,
        memoryScope: pid,
        source: 'mirror:soul-md',
        status: 'active',
        version: 1,
        updatedAt: nowTs,
      }
      const raw = serializeCard(fm, parsed.body)
      const finalParsed = parseCard(raw)
      await ensureDir(cardDir(dataRoot, pid))
      await writeCard(dataRoot, pid, fm, parsed.body)

      // 每张卡自己的导入快照
      const cardImportDir = join(cardArchiveDir(dataRoot, pid), `import-${ts}`)
      assertPersonaWritable(dataRoot, cardImportDir)
      await assertPersonaWritableReal(dataRoot, cardImportDir)
      await ensureDir(cardImportDir)
      const sourceSnap = join(cardImportDir, 'soul-md-card.md')
      assertPersonaWritable(dataRoot, sourceSnap)
      await assertPersonaWritableReal(dataRoot, sourceSnap)
      await (await import('./fsatomic.mjs')).writeExclusive(sourceSnap, rawCard)
      const fpFile = join(cardImportDir, 'fingerprint.json')
      assertPersonaWritable(dataRoot, fpFile)
      await assertPersonaWritableReal(dataRoot, fpFile)
      await writeJsonAtomic(fpFile, {
        importedAt: nowTs, cardName, personaId: pid, source: 'soul-md',
        sourceHash: sha256(rawCard), sourceZoneHashes: parsed.zoneHashes,
        cardZoneHashes: finalParsed.zoneHashes, profileFile,
      })

      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        cardId: pid,
        personaId: pid,
        name: String(cardName),
        memoryScope: pid,
        source: 'mirror:soul-md',
        status: 'active',
        version: 1,
        createdAt: nowTs,
        updatedAt: nowTs,
        sourceHash: sha256(raw),
        zoneHashes: finalParsed.zoneHashes,
        zones: finalParsed.zones,
        importedFrom: { kind: 'soul-md', cardName, profileFile, importedAt: nowTs, importDir: cardImportDir },
        lastSave: { revision: 1, author: 'import', at: nowTs },
      }
      const mw = await writeCardManifest(dataRoot, pid, manifest)
      if (!mw.ok) return err('PARTIAL_WRITE', `卡片 ${pid} 已写但 manifest 失败`, { cardId: pid })
      let snapshotOk = false
      try {
        await snapshotRevision(dataRoot, pid, {
          raw, frontMatter: fm, zoneHashes: finalParsed.zoneHashes, version: 1, reason: 'import revision 1',
        })
        snapshotOk = true
      } catch { /* 快照失败不阻断导入；version 行记 snapshot=false */ }
      await appendVersion(dataRoot, pid, {
        revision: 1, createdAt: nowTs, author: 'import', reason: 'import from soul-md',
        hash: sha256(raw), prevHash: null, note: `soul-md card「${cardName}」`, snapshot: snapshotOk,
      })
      createdPids.push(pid)
      cards[pid] = { name: String(cardName), source: 'mirror:soul-md', status: 'active', version: 1 }
      created.push({ cardName, personaId: pid, version: 1, sourceHash: manifest.sourceHash, zones: zoneOutline(finalParsed.body, finalParsed.zones) })
    }

    let activeCardId = registry.activeCardId ?? null
    let workspaces = { ...(registry.workspaces || {}) }
    let sessions = { ...(registry.sessions || {}) }
    let workspaceList = Array.isArray(registry.workspaceList) ? [...registry.workspaceList] : []

    // 绑定：名字 → cardId；只映射已存在的卡
    if (importBindings) {
      const mapName = (name) => {
        if (name === 'none') return 'none'
        if (!name) return undefined
        const pid = mapping?.[name] || personaIdByName(personas, name)
        return pid && cards[pid] ? pid : undefined
      }
      if (config.active === 'none') {
        if (!preserveLocalBindings || !activeCardId) activeCardId = null
      } else {
        const mappedActive = mapName(config.active)
        if (mappedActive && mappedActive !== 'none' && (!preserveLocalBindings || !activeCardId)) activeCardId = mappedActive
      }
      for (const [k, v] of Object.entries(config.workspaces || {})) {
        const mapped = mapName(v)
        if (mapped === undefined) continue
        if (preserveLocalBindings && Object.prototype.hasOwnProperty.call(workspaces, k)) continue
        workspaces[k] = mapped
      }
      for (const [k, v] of Object.entries(config.sessions || {})) {
        const mapped = mapName(v)
        if (mapped === undefined) continue
        if (preserveLocalBindings && Object.prototype.hasOwnProperty.call(sessions, k)) continue
        sessions[k] = mapped
      }
      for (const item of config.workspaceList || []) {
        const p = String(item?.path || '').trim()
        if (!p) continue
        if (!workspaceList.some((x) => String(x?.path || '').toLowerCase() === p.toLowerCase())) {
          workspaceList.push({ path: p, title: String(item?.title || basename(p)) })
        }
      }
    }

    const nextRegistry = {
      ...registry,
      cards,
      activeCardId,
      workspaces,
      sessions,
      workspaceList,
      settings: {
        ...(registry.settings || {}),
        source: 'soul-md',
        readOnly: true,
        injection: {
          memory: config.memory ?? null,
          allowTemplates: config.allowTemplates ?? false,
          skipSubagents: config.skipSubagents ?? false,
          sourceLabel,
          importedAt: nowTs,
        },
      },
    }
    const summary = {
      ok: true, importDir, created, skipped, unmapped,
      warning: identityWarning,
      counts: { created: created.length, skipped: skipped.length, unmapped: unmapped.length },
      registry: nextRegistry,
    }
    if (!created.length) {
      return { ...summary, ok: true, note: '没有新卡写入（全部已存在或未映射）；快照与 registry 仍已记录' }
    }
    // 读回校验第一张
    const first = created[0]
    const rb = await readback(dataRoot, first.personaId, first.sourceHash)
    if (rb.status !== 'found') return err('READBACK_MISMATCH', `导入后读回异常：${rb.status}`, rb)
    return { ...summary, readback: rb }
  } })
}
