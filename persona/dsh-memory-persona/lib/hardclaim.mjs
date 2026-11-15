/**
 * lib/hardclaim.mjs —— 硬认领（镜台侧 · 协调器）
 *
 * 镜台是唯一有资格发起「换人格归属」的层：它串行调用
 *   根藏（chunks + vectors + identity）→ 熏习（state 行）→ 年轮（claims/topic_docs）
 * 每层自己备份、自己 verify；镜台写顶层 journal，失败时按相反顺序回滚已完成的层。
 *
 * 纪律：
 *   · 默认 dryRun 预览；真写必须 confirm=true + expectedGeneration（目标已存在时）；
 *   · 只做 persona_unassigned → 已声明人格；
 *   · 不重嵌、不调 LLM、不动私人文件夹；
 *   · journal 落在 <dataRoot>/persona/hard-claim/<tag>/journal.json（镜台自己的写区）。
 */
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWrite, ensureDir, readJson } from './fsatomic.mjs'
import { assertPersonaWritable, personaRoot, tsSlugMs } from './paths.mjs'
import { readCard } from './store.mjs'
import { fail, toErrInfo } from './errors.mjs'

export const HARD_CLAIM_JOURNAL_PREFIX = 'hard-claim'

function svc(ctx, name) {
  try { return ctx?.get?.(name) || null } catch { return null }
}

function services(ctx) {
  return {
    store: svc(ctx, 'jianmuStore'),
    process: svc(ctx, 'jianmuProcess'),
    year: svc(ctx, 'jianmuYear'),
  }
}

function unavailable(s, need = ['store']) {
  const missing = need.filter((n) => !s[n])
  if (!missing.length) return null
  const map = { store: 'jianmuStore（根藏）', process: 'jianmuProcess（熏习）', year: 'jianmuYear（年轮）' }
  return fail('SERVICE_UNAVAILABLE', `缺服务：${missing.map((n) => map[n] || n).join('、')}。硬认领需要三层同时在线（对应插件未加载/被关）`, { missing })
}

async function cardWarning(dataRoot, to) {
  try {
    const c = await readCard(dataRoot, to)
    if (c.ok) return null
    return `目标人格 ${to} 在 identity 里已声明，但镜台没有可用人格卡（${c.code}）：建议先 jianmu_persona_create`
  } catch { return null }
}

/** 备份估算：根藏 + 熏习 + 年轮（process/year 没装则只算根藏） */
function sumBackup(...parts) {
  return parts.reduce((a, b) => a + (Number(b) || 0), 0)
}

/**
 * 预览：汇总三层数字（零写入）。
 */
export async function hardClaimPreview({ dataRoot, ctx, from = 'persona_unassigned', to, workspace = null, sessionIds = null } = {}) {
  const root = resolve(dataRoot)
  const s = services(ctx)
  const off = unavailable(s, ['store'])
  if (off) return off
  if (!to) return fail('BAD_ARGS', '必须给 to（目标人格）')
  const pv = await s.store.claimHardPreview({ from, to, workspace, sessionIds, includeIds: true })
  if (!pv.ok) return pv
  const chunkIds = Array.isArray(pv.chunkIds) ? pv.chunkIds : []
  const warnings = [...(pv.warnings || [])]

  const cardWarn = await cardWarning(root, to)
  if (cardWarn) warnings.push(cardWarn)

  let proc = null
  if (s.process) {
    proc = await s.process.claimHardPreviewState({ from, to, chunkIds })
    if (!proc.ok) warnings.push(`熏习预览失败：${proc.error?.message || proc.code || 'unknown'}`)
  } else {
    warnings.push('熏习服务不在线：预览不含 state 行；真写会被拒绝（需要三层同时在线）')
  }
  let yr = null
  if (s.year) {
    yr = await s.year.claimHardPreviewClaims({ from, to, chunkIds })
    if (!yr.ok) warnings.push(`年轮预览失败：${yr.error?.message || yr.code || 'unknown'}`)
    warnings.push(...(yr.warnings || []))
  } else {
    warnings.push('年轮服务不在线：预览不含 claims；真写会被拒绝（需要三层同时在线）')
  }

  const out = {
    ok: true,
    dryRun: true,
    from,
    to,
    selection: pv.selection,
    chunks: pv.chunks,
    vectors: pv.vectors,
    duplicates: pv.duplicates,
    process: proc && proc.ok ? {
      stateRows: proc.stateRows,
      duplicatesTouched: proc.duplicatesTouched,
      pendingTouched: proc.pendingTouched,
    } : (proc ? { error: proc.code || 'PREVIEW_FAILED', message: proc.error?.message || null } : null),
    claims: yr && yr.ok ? {
      move: yr.move,
      mixedAnchor: yr.mixedAnchor,
      mixedClaims: yr.mixedClaims,
      orphanAfter: yr.orphanAfter,
    } : (yr ? { error: yr.code || 'PREVIEW_FAILED', message: yr.error?.message || null } : null),
    target: pv.target,
    source: pv.source,
    identity: pv.identity,
    size: {
      root: pv.size?.backupEstBytes ?? null,
      process: proc?.ok ? proc.backupEstBytes ?? 0 : 0,
      year: yr?.ok ? yr.backupEstBytes ?? 0 : 0,
      backupEstBytes: sumBackup(pv.size?.backupEstBytes, proc?.ok ? proc.backupEstBytes : 0, yr?.ok ? yr.backupEstBytes : 0),
    },
    warnings,
    next: pv.target?.generation == null
      ? '目标 scope 尚不存在：真写时不强制 expectedGeneration'
      : `真写请带 expectedGeneration=${pv.target.generation} + confirm=true（先看上面数字再点头）`,
  }
  return out
}

function journalDirOf(dataRoot, tag) {
  return join(personaRoot(dataRoot), HARD_CLAIM_JOURNAL_PREFIX, tag)
}

async function writeJournal(dataRoot, dir, journal) {
  assertPersonaWritable(dataRoot, join(dir, 'journal.json'))
  await ensureDir(dir)
  await atomicWrite(join(dir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n')
}

/**
 * 真写：根藏 → 熏习 → 年轮 → identity。失败按相反顺序回滚。
 */
export async function hardClaimApply({
  dataRoot, ctx, from = 'persona_unassigned', to, workspace = null, sessionIds = null,
  expectedGeneration = null, confirm = false,
} = {}) {
  const root = resolve(dataRoot)
  if (confirm !== true) return fail('CONFIRM_REQUIRED', '硬认领会真搬 chunks/vectors/state/claims：必须 confirm=true（先跑 dryRun 预览）')
  const s = services(ctx)
  const off = unavailable(s, ['store', 'process', 'year'])
  if (off) return off
  if (!to) return fail('BAD_ARGS', '必须给 to（目标人格）')

  // 先按当前状态预览；数字/选择以这一刻为准
  const pv = await hardClaimPreview({ dataRoot: root, ctx, from, to, workspace, sessionIds })
  if (!pv.ok) return pv
  if (pv.target?.exists && expectedGeneration == null) {
    return fail('STALE_GENERATION', `真写必须带 expectedGeneration（当前目标 generation=${pv.target.generation}）：先预览，再把同一个数字传回来`, { generation: pv.target.generation })
  }
  if (expectedGeneration != null && pv.target?.exists && Number(expectedGeneration) !== Number(pv.target.generation)) {
    return fail('STALE_GENERATION', `目标 generation 已变化（调用方 ${expectedGeneration}，当前 ${pv.target.generation}）：重新预览`, { generation: pv.target.generation })
  }

  const tag = tsSlugMs()
  const jdir = journalDirOf(root, tag)
  const journal = {
    version: 1,
    kind: 'persona-hard-claim-journal',
    tag,
    createdAt: new Date().toISOString(),
    status: 'started',
    dataRoot: root,
    from,
    to,
    workspace: workspace ?? null,
    sessionIds: sessionIds ?? null,
    expectedGeneration: expectedGeneration ?? null,
    preview: {
      chunks: pv.chunks,
      duplicates: pv.duplicates,
      vectors: pv.vectors,
      process: pv.process,
      claims: pv.claims,
      size: pv.size,
    },
    layers: {},
    phases: [],
  }
  await writeJournal(root, jdir, journal)
  const phase = async (name, ok, detail = {}) => {
    journal.phases.push({ name, at: new Date().toISOString(), ok, ...detail })
    await writeJournal(root, jdir, journal).catch(() => {})
  }

  let rootRes = null
  let procRes = null
  let yearRes = null
  let idRes = null

  const rollbackAll = async (reason) => {
    const rb = { year: null, process: null, root: null }
    if (journal.layers.year?.backupDir) {
      try { rb.year = await s.year.claimHardRollbackClaims({ backupDir: journal.layers.year.backupDir }) } catch (e) { rb.year = { ok: false, error: toErrInfo(e) } }
    }
    if (journal.layers.process?.backupDir) {
      try { rb.process = await s.process.claimHardRollbackState({ backupDir: journal.layers.process.backupDir }) } catch (e) { rb.process = { ok: false, error: toErrInfo(e) } }
    }
    if (journal.layers.root?.backupDir) {
      try { rb.root = await s.store.claimHardRollback({ backupDir: journal.layers.root.backupDir, expectHashes: true }) } catch (e) { rb.root = { ok: false, error: toErrInfo(e) } }
    }
    journal.status = 'failed'
    journal.failure = { reason, at: new Date().toISOString() }
    journal.rollback = rb
    await writeJournal(root, jdir, journal).catch(() => {})
    return rb
  }

  try {
    // ── 1. 根藏（chunks + vectors）
    rootRes = await s.store.claimHardApply({
      from, to, workspace, sessionIds,
      expectedGeneration: pv.target?.exists ? pv.target.generation : null,
      confirm: true, stampTag: tag,
    })
    journal.layers.root = {
      backupDir: rootRes.backupDir || null,
      targetExistedBefore: rootRes.targetExistedBefore !== false,
    }
    await phase('root', rootRes.ok === true, {
      moved: rootRes.moved ?? null, duplicatesSkipped: rootRes.duplicatesSkipped ?? null,
      source: rootRes.source ? { chunks: rootRes.source.chunks, generation: rootRes.source.generation } : null,
      target: rootRes.target ? { chunks: rootRes.target.chunks, generation: rootRes.target.generation } : null,
      code: rootRes.ok ? null : rootRes.error?.code || rootRes.code || null,
    })
    if (!rootRes.ok) {
      const rb = await rollbackAll(`根藏搬迁失败：${rootRes.error?.message || rootRes.code || 'unknown'}`)
      return { ...rootRes, ok: false, phase: 'root', rollback: rb, journal: join(jdir, 'journal.json') }
    }

    const movedIds = Array.isArray(rootRes.movedIds) ? rootRes.movedIds : []
    if (!movedIds.length) {
      journal.status = 'done'
      journal.result = { moved: 0, note: '没有选中块（可能全是目标已有重复）' }
      await writeJournal(root, jdir, journal)
      return { ok: true, moved: 0, root: rootRes, journal: join(jdir, 'journal.json'), note: '没有新增块；源侧未变' }
    }

    // ── 2. 熏习（state 行）
    procRes = await s.process.claimHardMoveState({ from, to, chunkIds: movedIds, confirm: true, tag })
    journal.layers.process = { backupDir: procRes.backupDir || null }
    await phase('process', procRes.ok === true, {
      moved: procRes.moved ?? null, skipped: procRes.skipped ?? null,
      stale: procRes.stale ?? null, code: procRes.ok ? null : procRes.error?.code || procRes.code || null,
    })
    if (!procRes.ok) {
      const rb = await rollbackAll(`熏习搬迁失败：${procRes.error?.message || procRes.code || 'unknown'}`)
      return { ok: false, code: procRes.code || 'PROCESS_MOVE_FAILED', error: procRes.error || null, phase: 'process', root: rootRes, rollback: rb, journal: join(jdir, 'journal.json') }
    }
    const procRebuild = await s.process.claimHardRebuild({ from, to })
    journal.processRebuild = procRebuild
    await phase('process-rebuild', Object.values(procRebuild || {}).every((x) => x?.ok !== false), {})

    // ── 3. 年轮（claims + topic_docs）
    yearRes = await s.year.claimHardMoveClaims({ from, to, chunkIds: movedIds, confirm: true, tag })
    journal.layers.year = { backupDir: yearRes.backupDir || null }
    await phase('year', yearRes.ok === true, {
      moved: yearRes.moved ?? null, mixedAnchor: yearRes.mixedAnchor ?? null,
      skipped: yearRes.skipped ?? null, code: yearRes.ok ? null : yearRes.error?.code || yearRes.code || null,
    })
    if (!yearRes.ok) {
      const rb = await rollbackAll(`年轮搬迁失败：${yearRes.error?.message || yearRes.code || 'unknown'}`)
      return { ok: false, code: yearRes.code || 'YEAR_MOVE_FAILED', error: yearRes.error || null, phase: 'year', root: rootRes, process: procRes, rollback: rb, journal: join(jdir, 'journal.json') }
    }
    const yearRebuild = await s.year.claimHardRebuild({ from, to })
    journal.yearRebuild = yearRebuild
    await phase('year-rebuild', Object.values(yearRebuild || {}).every((x) => x?.ok !== false), {})

    // ── 4. identity：只补「尚未映射」的工作区/会话；已属别人在预览/根藏闸门已拒绝
    const wsAdd = pv.identity?.workspacesToAdd || []
    const sesAdd = pv.identity?.sessionsToAdd || []
    if (wsAdd.length || sesAdd.length) {
      idRes = await s.store.identityAddPersona({
        personaId: to, workspaces: wsAdd, sessions: sesAdd,
        updateDisplayName: false, dryRun: false, confirm: true,
      })
      await phase('identity', idRes.ok === true, { workspaces: wsAdd.length, sessions: sesAdd.length, code: idRes.ok ? null : idRes.code || null })
      if (!idRes.ok) {
        const rb = await rollbackAll(`identity 登记失败：${idRes.error?.message || idRes.code || 'unknown'}`)
        return { ok: false, code: idRes.code || 'IDENTITY_WRITE_FAILED', error: idRes.error || null, phase: 'identity', root: rootRes, process: procRes, year: yearRes, rollback: rb, journal: join(jdir, 'journal.json') }
      }
    } else {
      idRes = { ok: true, noop: true, note: '工作区/会话已属于目标人格，无需登记' }
      await phase('identity', true, { noop: true })
    }

    // ── 5. 终验：根藏两边 / 熏习两边 / 年轮两边（混合锚点的预期孤儿不算失败）
    const expectOrphans = Number(pv.claims?.orphanAfter) || 0
    const rootVerify = await s.store.claimHardVerify({ from, to })
    const procVerify = {
      from: s.process.verify ? await s.process.verify(from) : null,
      to: s.process.verify ? await s.process.verify(to) : null,
    }
    const yearVerify = {
      from: s.year.verify ? await s.year.verify(from) : null,
      to: s.year.verify ? await s.year.verify(to) : null,
    }
    const yearOrphan = Number(yearVerify.from?.summary?.anchors?.orphan) || 0
    const yearProblemsFrom = (yearVerify.from?.problems || []).filter((p) => !(p.code === 'ANCHOR_ORPHAN' && yearOrphan <= expectOrphans))
    const yearProblemsTo = (yearVerify.to?.problems || [])
    const ok = rootVerify.ok === true
      && (procVerify.from?.ok !== false) && (procVerify.to?.ok !== false)
      && yearProblemsFrom.length === 0 && yearProblemsTo.length === 0
    const verify = {
      ok,
      root: rootVerify,
      process: procVerify,
      year: yearVerify,
      yearOrphan,
      expectedOrphans: expectOrphans,
    }
    journal.verify = verify
    if (!ok) {
      const rb = await rollbackAll(`终验未通过：root=${rootVerify.ok} process=${procVerify.from?.ok}/${procVerify.to?.ok} yearProblems=${yearProblemsFrom.length + yearProblemsTo.length}`)
      return { ok: false, code: 'FINAL_VERIFY_FAILED', error: { code: 'FINAL_VERIFY_FAILED', message: '终验未通过，已按相反顺序回滚' }, phase: 'verify', root: rootRes, process: procRes, year: yearRes, verify, rollback: rb, journal: join(jdir, 'journal.json') }
    }

    journal.status = 'done'
    journal.result = {
      moved: rootRes.moved, duplicatesSkipped: rootRes.duplicatesSkipped,
      process: { moved: procRes.moved, stale: procRes.stale },
      claims: { moved: yearRes.moved, mixedAnchor: yearRes.mixedAnchor },
      verifyOk: true,
    }
    await phase('done', true, {})
    await writeJournal(root, jdir, journal)
    return {
      ok: true,
      from, to,
      moved: rootRes.moved,
      duplicatesSkipped: rootRes.duplicatesSkipped,
      process: { moved: procRes.moved, skipped: procRes.skipped, stale: procRes.stale, rebuild: procRebuild },
      claims: { moved: yearRes.moved, mixedAnchor: yearRes.mixedAnchor, skipped: yearRes.skipped, rebuild: yearRebuild },
      identity: idRes,
      verify,
      backup: {
        journal: join(jdir, 'journal.json'),
        root: rootRes.backupDir || null,
        process: procRes.backupDir || null,
        year: yearRes.backupDir || null,
      },
      backupBytes: sumBackup(rootRes.backupBytes, procRes.backupBytes, yearRes.backupBytes),
      rollbackHint: `回滚：jianmu_persona_claim_hard { rollbackBackup: "${join(jdir, 'journal.json')}", confirm: true }`,
      elapsedMs: rootRes.elapsedMs || null,
    }
  } catch (e) {
    const rb = await rollbackAll(`未预期异常：${e?.message || e}`)
    return { ok: false, code: e?.code || 'HARD_CLAIM_FAILED', error: toErrInfo(e), rollback: rb, journal: join(jdir, 'journal.json') }
  }
}

/** 读 journal：接受目录或 journal.json 路径 */
async function readJournalAt(p) {
  let file = String(p || '')
  try {
    const st = await stat(file)
    if (st.isDirectory()) file = join(file, 'journal.json')
  } catch { /* 不存在就按文件读，报错给调用方 */ }
  const r = await readJson(file)
  if (!r.ok) return { ok: false, code: 'JOURNAL_NOT_FOUND', error: { code: 'JOURNAL_NOT_FOUND', message: `读不到硬认领 journal：${file}` }, file }
  return { ok: true, journal: r.value, file }
}

/**
 * 回滚：按 journal 记录，年轮 → 熏习 → 根藏（根藏含 identity）逐层整文件恢复。
 */
export async function hardClaimRollback({ dataRoot, ctx, rollbackBackup, confirm = false } = {}) {
  const root = resolve(dataRoot)
  if (confirm !== true) return fail('CONFIRM_REQUIRED', '回滚会覆盖当前文件：必须 confirm=true')
  if (!rollbackBackup) return fail('BAD_ARGS', '必须给 rollbackBackup（journal.json 或其目录）')
  const s = services(ctx)
  const off = unavailable(s, ['store'])
  if (off) return off
  const jr = await readJournalAt(rollbackBackup)
  if (!jr.ok) return jr
  const j = jr.journal
  if (j.status === 'rolledback') {
    return { ok: true, alreadyRolledBack: true, journal: jr.file, note: '该 journal 已回滚过（幂等）' }
  }
  const out = { year: null, process: null, root: null }
  if (j.layers?.year?.backupDir && s.year?.claimHardRollbackClaims) {
    out.year = await s.year.claimHardRollbackClaims({ backupDir: j.layers.year.backupDir })
  }
  if (j.layers?.process?.backupDir && s.process?.claimHardRollbackState) {
    out.process = await s.process.claimHardRollbackState({ backupDir: j.layers.process.backupDir })
  }
  if (j.layers?.root?.backupDir) {
    out.root = await s.store.claimHardRollback({ backupDir: j.layers.root.backupDir, expectHashes: true })
  }
  const verify = await s.store.claimHardVerify({
    from: j.from, to: j.to,
    allowMissingTarget: j.layers?.root?.targetExistedBefore === false,
  }).catch((e) => ({ ok: false, error: toErrInfo(e) }))
  const ok = out.year?.ok !== false && out.process?.ok !== false && out.root?.ok !== false && verify.ok !== false
  j.status = ok ? 'rolledback' : 'rollback-partial'
  j.rolledBackAt = new Date().toISOString()
  j.rollbackResult = { ok, year: out.year?.ok ?? null, process: out.process?.ok ?? null, root: out.root?.ok ?? null }
  await writeJournal(root, join(personaRoot(root), HARD_CLAIM_JOURNAL_PREFIX, j.tag || 'unknown'), j).catch(() => {})
  return {
    ok,
    journal: jr.file,
    rolledBack: { year: out.year, process: out.process, root: out.root },
    verify,
    note: ok ? '三层已按备份整文件恢复；根藏 identity 也一并还原' : '部分层回滚失败：看 rolledBack 里的 problems，不要重复写入',
  }
}

/** 只读：按 journal 报告当前状态（给 UI/排障用） */
export async function hardClaimJournal({ dataRoot, rollbackBackup } = {}) {
  const root = resolve(dataRoot)
  const jr = await readJournalAt(rollbackBackup)
  if (!jr.ok) return jr
  const j = jr.journal
  return { ok: true, file: jr.file, tag: j.tag, status: j.status, from: j.from, to: j.to, phases: j.phases, layers: j.layers, result: j.result ?? null, failure: j.failure ?? null }
}
