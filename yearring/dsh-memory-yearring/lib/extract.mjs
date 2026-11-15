/**
 * lib/extract.mjs —— 年轮 run 主流程（唯一花钱的地方）
 *
 * 流程：
 *   1. 只读：根藏 chunks + 熏习 state/topics/duplicates + 已有 claims/runs
 *   2. 选块（增量，跳过已处理）→ 预算内分批
 *   3. dryRun：只算预估，不调模型
 *   4. 真跑：每批 提示词 → ctx.llm → 严格 JSON → 逐条校验(quote 逐字/scan 红项/跨人格)
 *           → 去重/冲突决策 → append claims → 读回校验
 *   5. 更新 manifest + 写 runs.jsonl（含 token/费用）
 *
 * 铁律：
 *   · 失败不写半成品（单批 append 失败会截回原尺寸）
 *   · 不自动重试（重试会烧钱）
 *   · 只写 <dataRoot>/year/<personaId>/
 */
import { readScope } from './root.mjs'
import {
  readProcessState, readProcessTopics, readDuplicateChunkIds, readProcessManifest,
} from './process-read.mjs'
import {
  ensureYearHome, readManifest, writeManifest, readClaims, appendClaims, readRuns, appendRun,
  computeCounts,
} from './store.mjs'
import { selectBatches, collectCoveredFromRuns } from './select.mjs'
import { callLlm, parseClaimsJson, costYuan, estimateTokens } from './llm.mjs'
import { SYSTEM_PROMPT, buildUserPrompt, PROMPT_VERSION } from './prompt.mjs'
import {
  validateClaim, planWrites, resolveHints, finalizeClaim,
} from './claim.mjs'
import { scanClaimFields } from './guards.mjs'
import { acquireLock } from './lock.mjs'
import { VERSION, RULE_VERSION, DEFAULT_BUDGET, MAX_REVISIONS_PER_GROUP } from './version.mjs'
import { YearError, toErrInfo } from './errors.mjs'
import { yearDir } from './paths.mjs'

const rand = () => Math.random().toString(36).slice(2, 8)

export function newRunId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `run-${ts}-${rand()}`
}

/**
 * 加载只读上下文（根藏 + 熏习）。
 */
export async function loadInputs({ dataRoot, personaId }) {
  const root = await readScope(dataRoot, personaId)
  if (!root.ok) return { ok: false, code: root.code, error: root.error }
  // P0-2：空库必须明确报 EMPTY_ROOT，绝不伪装成 NOTHING_TO_DO（会掩盖缺根藏）
  if (root.empty) {
    return {
      ok: false,
      code: 'EMPTY_ROOT',
      personaId,
      error: { code: 'EMPTY_ROOT', message: '根藏为空（没有可提炼的原话）：先装根藏并摄取，再来跑年轮' },
      hint: '年轮只读根藏；根藏没有原话时不会产生 claim。',
    }
  }

  const [state, topics, dups, processManifest] = await Promise.all([
    readProcessState(dataRoot, personaId),
    readProcessTopics(dataRoot, personaId),
    readDuplicateChunkIds(dataRoot, personaId),
    readProcessManifest(dataRoot, personaId),
  ])

  const chunksById = new Map()
  for (const c of root.chunks) chunksById.set(c.id, c)

  return {
    ok: true,
    root,
    chunksById,
    chunks: root.chunks,
    state,
    topics,
    duplicates: dups,
    processManifest,
    rootSignature: {
      builtAt: root.manifest?.builtAt ?? null,
      generation: root.manifest?.generation ?? null,
      chunks: root.chunks.length,
    },
  }
}

const clampInt = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 字符串取值（防设置层把值包成对象；拿不到就回退） */
function pickStr(...candidates) {
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim() && v !== '[object Object]') return v.trim()
    if (v && typeof v === 'object') {
      for (const k of ['value', 'default', 'name', 'id']) {
        const s = v[k]
        if (typeof s === 'string' && s.trim()) return s.trim()
      }
    }
  }
  return ''
}

/**
 * run 主入口。
 * @param {object} opts
 * @param {object} opts.llmHost 宿主 ctx.llm（dryRun 时可为 null）
 */
export async function runYear({
  dataRoot, personaId, llmHost = null,
  topicId = null, scope = 'all', maxChunks = null, budgetTokens = null,
  model = null, provider = null, dryRun = false, confirm = false,
  force = false, maxBatches = null, trigger = 'manual',
  budget = {}, pricing = {}, config = {},
}) {
  // ── 0. 参数校验
  if (!dryRun && confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRM_REQUIRED',
      error: {
        code: 'CONFIRM_REQUIRED',
        message: '真跑会调用模型并产生费用：请先 dryRun=true 看成本，再带 confirm=true 执行（或用 GUI 的生成按钮）',
      },
    }
  }

  const effBudget = {
    maxInputChars: clampInt(budget.maxInputChars, 2000, 200000, DEFAULT_BUDGET.maxInputChars),
    maxOutputTokens: clampInt(budget.maxOutputTokens, 512, 32000, DEFAULT_BUDGET.maxOutputTokens),
    timeoutMs: clampInt(budget.timeoutMs, 5000, 600000, DEFAULT_BUDGET.timeoutMs),
    maxClaimsPerRun: clampInt(budget.maxClaimsPerRun, 1, 500, DEFAULT_BUDGET.maxClaimsPerRun),
  }
  const effModel = pickStr(model, config.llmModel, 'deepseek-flash')
  const effProvider = pickStr(provider, config.llmProvider, 'deepseek-account')
  // budgetTokens = **本次 run 的总输出 token 上限**（不是每批）；每批还得受 maxOutputTokens 约束
  const totalBudgetTokens = budgetTokens
    ? clampInt(budgetTokens, 32, 200000, effBudget.maxOutputTokens)
    : effBudget.maxOutputTokens
  const maxOut = Math.min(effBudget.maxOutputTokens, totalBudgetTokens)
  const perBatchChunks = maxChunks ? clampInt(maxChunks, 1, 4000, 24) : clampInt(config.maxChunksPerRun, 1, 4000, 24)
  const batchLimit = maxBatches ? clampInt(maxBatches, 1, 20, 1) : 1

  // ── 1. 只读输入
  const inputs = await loadInputs({ dataRoot, personaId })
  if (!inputs.ok) return inputs

  const home = await ensureYearHome(dataRoot, personaId)
  const manifestRes = await readManifest(dataRoot, personaId)
  if (!manifestRes.ok) return { ok: false, code: manifestRes.code, error: manifestRes.error }
  const claims = await readClaims(dataRoot, personaId)
  // 读全部 run（runs.jsonl 很小：每批 400 块 ≈ 25KB/run）；增量覆盖不能只看最近 N 条
  const runs = await readRuns(dataRoot, personaId, 100000)

  // ── 2. 覆盖集合（增量）
  // 只信 runs.coveredChunks：它只有「整批处理干净」才记；
  // 不能拿 claims 的 anchor 当覆盖依据——被预算砍掉的结论就永远补不回来了。
  const covered = collectCoveredFromRuns(runs.rows)

  // ── 3. 选块
  const sel = selectBatches({
    chunks: inputs.chunks,
    statusByChunk: inputs.state.statusByChunk,
    covered,
    duplicateSkip: new Set(), // 重复块照常可提，只是不优先
    topics: inputs.topics,
    topicId,
    scope,
    force,
    maxInputChars: effBudget.maxInputChars,
    maxChunks: perBatchChunks,
    maxBatches: batchLimit,
  })

  const selectedChunks = sel.batches.reduce((n, b) => n + b.chunks.length, 0)
  const selectedChars = sel.batches.reduce((n, b) => n + b.chars, 0)
  const estPromptTokens = sel.batches.reduce((n, b) => n + estimateTokens(buildUserPrompt(b.chunks)), 0)
  // 预估输出：按块数估，但不超过本次总预算（审查实测过 dryRun 只按单批估、严重低估）
  const estOutputTokens = Math.min(totalBudgetTokens, Math.max(64, selectedChunks * 80))
  const pricingCfg = {
    inputPerMTokens: Number(pricing.inputPerMTokens ?? config.pricingInputPerMTokens ?? NaN),
    outputPerMTokens: Number(pricing.outputPerMTokens ?? config.pricingOutputPerMTokens ?? NaN),
  }
  const estCost = costYuan({ promptTokens: estPromptTokens, outputTokens: estOutputTokens }, pricingCfg)

  const baseReport = {
    ok: true,
    dryRun: Boolean(dryRun),
    personaId,
    model: effModel,
    provider: effProvider,
    promptVersion: PROMPT_VERSION,
    budget: {
      ...effBudget,
      maxOutputTokensThisRun: maxOut,
      totalOutputTokenBudget: totalBudgetTokens,
    },
    selected: {
      batches: sel.batches.length,
      chunks: selectedChunks,
      chars: selectedChars,
    },
    estimate: {
      promptTokens: estPromptTokens,
      outputTokens: estOutputTokens,
      costYuan: estCost,
      pricing: Number.isFinite(pricingCfg.inputPerMTokens) ? pricingCfg : null,
      note: Number.isFinite(estCost) ? '按配置单价估算' : '单价未配置（costYuan=null）；token 仍会记账',
    },
    totals: {
      rootChunks: inputs.chunks.length,
      activeChunks: inputs.state.activeCount || inputs.chunks.length,
      covered: covered.size,
      claims: claims.byId.size,
      groups: claims.byGroup.size,
    },
    selection: sel.stats,
    warnings: [
      ...(sel.warnings || []),
      ...(inputs.state?.corrupt?.length
        ? [`熏习 state.jsonl 有 ${inputs.state.corrupt.length} 个坏行：这些块的状态未知，会被当 active 处理（先跑熏习 verify）`]
        : []),
    ],
    runsSeen: runs.total,
  }

  if (selectedChunks === 0) {
    return {
      ...baseReport,
      ok: true,
      code: 'NOTHING_TO_DO',
      note: '没有可处理的新块（全部已覆盖/非 active/被 scope 过滤）。要重跑用 force=true。',
      wrote: null,
    }
  }

  // ── 4. dryRun 预览到此为止
  if (dryRun) {
    return {
      ...baseReport,
      preview: sel.batches.map((b) => ({
        group: b.group,
        chunks: b.chunks.length,
        chars: b.chars,
        head: b.chunks.slice(0, 2).map((c) => ({ chunkId: c.id, seq: c.seq, t: c.t, chars: String(c.text || '').length })),
      })),
      nextStep: '确认后调用同一个工具并传 confirm=true（会真实调用模型、产生费用）',
    }
  }

  // ── 5. 真跑（单写者锁）
  const lock = await acquireLock(yearDir(dataRoot, personaId), { timeoutMs: 5000 })
  if (!lock.ok) return { ok: false, code: lock.code, error: lock.error }

  const runId = newRunId()
  const startedAt = Date.now()
  const written = []
  const rejected = []
  const skipped = []
  const supersededList = []
  const conflictList = []
  const batchReports = []
  // 只有「整批都处理干净」的块才算 covered；被预算/错误截断的块留给下一轮补
  const coveredChunks = []
  // P1.5：本 run 写入的 claim 按说话人计数（验收用；不含正文）
  const speakerTally = { user: 0, assistant: 0, unknown: 0 }
  let totalUsage = { promptTokens: 0, outputTokens: 0, estimated: false }
  let totalClaimsWritten = 0
  let status = 'ok'
  let error = null
  let runLogged = false
  let budgetExceeded = false

  try {
    let idx = claims
    const totalOutCap = totalBudgetTokens
    for (const batch of sel.batches) {
      if (totalUsage.outputTokens >= totalOutCap) {
        budgetExceeded = true
        batchReports.push({ group: batch.group, chunks: batch.chunks.length, status: 'skipped-total-budget', outputTokens: totalUsage.outputTokens, cap: totalOutCap })
        break
      }
      if (totalClaimsWritten >= effBudget.maxClaimsPerRun) {
        batchReports.push({ group: batch.group, chunks: batch.chunks.length, status: 'skipped-claim-budget' })
        continue
      }

      const user = buildUserPrompt(batch.chunks)
      if (user.length > effBudget.maxInputChars * 1.2 && batch.chunks.length > 1) {
        // select 已按 chars 切批；这里只做兜底（单块批允许超限，否则那一块永远跑不到）
        batchReports.push({ group: batch.group, chunks: batch.chunks.length, status: 'skipped-too-large', chars: user.length })
        continue
      }

      let llmRes
      try {
        llmRes = await callLlm(llmHost, {
          provider: effProvider,
          model: effModel,
          system: SYSTEM_PROMPT,
          user,
          maxTokens: maxOut,
          timeoutMs: effBudget.timeoutMs,
        })
      } catch (e) {
        const info = toErrInfo(e)
        // 失败/截断也可能已经消耗 token：能拿到就记账，不能就标 estimated
        const u = e?.detail?.usage
        if (u && Number.isFinite(u.promptTokens) && Number.isFinite(u.outputTokens)) {
          totalUsage.promptTokens += u.promptTokens
          totalUsage.outputTokens += u.outputTokens
          if (u.estimated) totalUsage.estimated = true
        }
        batchReports.push({
          group: batch.group, chunks: batch.chunks.length, status: 'llm-failed', error: info,
          usage: u ?? null,
        })
        status = 'error'
        error = info
        break
      }

      totalUsage.promptTokens += llmRes.usage.promptTokens
      totalUsage.outputTokens += llmRes.usage.outputTokens
      if (llmRes.usage.estimated) totalUsage.estimated = true

      let arr
      try {
        arr = parseClaimsJson(llmRes.text)
      } catch (e) {
        const info = toErrInfo(e)
        batchReports.push({ group: batch.group, chunks: batch.chunks.length, status: 'json-invalid', error: info })
        status = 'error'
        error = info
        break
      }

      // 逐条校验
      const incoming = []
      for (const raw of arr) {
        const v = validateClaim(raw, { personaId, chunksById: inputs.chunksById })
        if (!v.ok) {
          rejected.push({
            title: String(raw?.title ?? '').slice(0, 120),
            reasons: v.reasons,
            chunkId: raw?.quoteChunkId ? String(raw.quoteChunkId).slice(0, 16) : null,
          })
          continue
        }
        const scanned = scanClaimFields({ title: v.claim.title, body: v.claim.body, quote: v.claim.derivedFrom?.[0]?.quote })
        if (!scanned.ok) {
          rejected.push({
            title: v.claim.title.slice(0, 120),
            reasons: ['scan 红项：' + scanned.hits.filter((h) => h.level === 'red').map((h) => `${h.cat}/${h.what}`).join('；')],
            chunkId: String(v.claim.derivedFrom?.[0]?.chunkId || '').slice(0, 16),
          })
          continue
        }
        const hintRes = resolveHints(raw, idx)
        // 本次指定了 topic 就把它写进 claim（契约 §5.4 的「按 topicId 分组」要能生效）
        incoming.push({ ...v.claim, ...hintRes, topicId: topicId ? String(topicId) : v.claim.topicId })
      }

      if (!incoming.length) {
        // 模型输出空数组 = 这批明确没有可记结论 → 算处理过
        // 模型输出了一堆但全被拒（quote 不匹配 / scan 红项）≠ 处理干净 → 不覆盖，下轮可重试
        const rejectedAll = arr.length > 0
        batchReports.push({
          group: batch.group, chunks: batch.chunks.length,
          status: rejectedAll ? 'all-rejected' : 'no-claims',
          rawItems: arr.length, rejected: arr.length,
        })
        if (rejectedAll) {
          status = 'error'
          error = { code: 'CLAIM_INVALID', message: `本批 ${arr.length} 条 claim 全部被拒收（quote 非逐字 / scan 红项），未记覆盖，下轮可重试` }
        } else {
          for (const c of batch.chunks) coveredChunks.push(c.id)
        }
        continue
      }

      // 去重 / 冲突决策
      const plan = planWrites(incoming, idx, {
        maxRevisions: MAX_REVISIONS_PER_GROUP,
      })

      const budgetLeft = Math.max(0, effBudget.maxClaimsPerRun - totalClaimsWritten)
      let toWrite = plan.toWrite.slice(0, budgetLeft)
      const overflow = plan.toWrite.length - toWrite.length
      if (overflow > 0) {
        // 超出单次上限：本批只写预算内的，其余下轮再来（不静默丢）
        for (const c of plan.toWrite.slice(budgetLeft)) {
          skipped.push({ title: c.title.slice(0, 120), reason: 'claim-budget', claimGroupId: c.claimGroupId })
        }
      }

      // token 分摊（按条均分，向上取整）
      const perClaimTokens = toWrite.length ? Math.ceil(llmRes.usage.outputTokens / toWrite.length) : 0
      const now = Date.now()
      toWrite = toWrite.map((c) => finalizeClaim(c, {
        runId,
        model: `${effProvider}/${effModel}`,
        promptVersion: PROMPT_VERSION,
        costTokens: perClaimTokens,
        now,
      }))

      if (toWrite.length) {
        await appendClaims(dataRoot, personaId, toWrite)
        // 读回校验：确认每条都真的落盘
        const reread = await readClaims(dataRoot, personaId)
        const missing = toWrite.filter((c) => !reread.byId.has(c.claimId))
        if (missing.length) {
          throw new YearError('READBACK_MISMATCH', `写入后读回缺失 ${missing.length} 条 claim`, {
            claimIds: missing.map((c) => c.claimId),
          })
        }
        idx = reread
        written.push(...toWrite)
        for (const c of toWrite) {
          if (speakerTally[c.speaker] !== undefined) speakerTally[c.speaker] += 1
        }
        totalClaimsWritten += toWrite.length
        supersededList.push(...plan.superseded)
        conflictList.push(...plan.conflicts)
        skipped.push(...plan.skipped.map((s) => ({
          title: s.claim.title.slice(0, 120), reason: s.reason, existingClaimId: s.existingClaimId ?? null,
        })))
      }

      batchReports.push({
        group: batch.group,
        chunks: batch.chunks.length,
        status: 'ok',
        rawItems: arr.length,
        accepted: incoming.length,
        written: toWrite.length,
        skipped: plan.skipped.length,
        overflow,
        rejected: arr.length - incoming.length,
        elapsedMs: llmRes.elapsedMs,
        usage: llmRes.usage,
      })
      // 有 overflow 的批次不记 covered：下一轮回来把被预算砍掉的结论补上
      if (overflow === 0) for (const c of batch.chunks) coveredChunks.push(c.id)
    }
    // 单批跑完就已经超总预算（没有「下一批」可跳过时，也要如实标记）
    if (totalUsage.outputTokens > totalBudgetTokens) budgetExceeded = true

    // ── 6. 先写 runs.jsonl（含 token / 费用），再写 manifest
    // 顺序很关键：runs 是 covered 与计费的依据。若 runs 写失败，manifest 不能先声称成功。
    const totalCost = costYuan(totalUsage, pricingCfg)
    const runRow = {
      runId,
      at: Date.now(),
      startedAt,
      elapsedMs: Date.now() - startedAt,
      trigger: trigger === 'auto' ? 'auto' : 'manual',
      personaId,
      scope,
      topicId: topicId || null,
      model: `${effProvider}/${effModel}`,
      promptVersion: PROMPT_VERSION,
      inputChunks: selectedChunks,
      inputChars: selectedChars,
      batches: sel.batches.length,
      batchReports,
      speakers: { ...speakerTally },
      topics: null,
      promptTokens: totalUsage.promptTokens,
      outputTokens: totalUsage.outputTokens,
      tokensEstimated: totalUsage.estimated,
      costYuan: totalCost,
      claimsWritten: written.length,
      drafts: 0,
      conflicts: conflictList.length,
      superseded: supersededList.length,
      rejected: rejected.length,
      skipped: skipped.length,
      coveredChunks,
      budgetExceeded,
      status: budgetExceeded && status === 'ok' ? 'partial' : status,
      error,
    }
    await appendRun(dataRoot, personaId, runRow)
    runLogged = true

    // ── 7. 更新 manifest（runs 写完才写；计数用「有效状态」而不是声明状态）
    const counts = computeCounts(idx)
    const nextManifest = {
      ...manifestRes.manifest,
      personaId,
      generation: (Number(manifestRes.manifest.generation) || 0) + 1,
      counts: { ...counts, runs: runs.total + 1 },
      lastRunAt: Date.now(),
      lastRunId: runId,
      lastRunRootBuiltAt: inputs.rootSignature.builtAt,
      model: `${effProvider}/${effModel}`,
      promptVersion: PROMPT_VERSION,
      ruleVersion: RULE_VERSION,
      budget: effBudget,
      degraded: status !== 'ok',
      lastError: error,
      createdAt: manifestRes.manifest.createdAt || Date.now(),
      writer: { name: 'dsh-memory-yearring', version: VERSION },
    }
    const w = await writeManifest(dataRoot, personaId, nextManifest)
    if (!w.ok) throw new YearError('WRITE_ATOMIC_FAILED', 'manifest 写入失败')

    return {
      ...baseReport,
      // 预算耗尽：一条没写 → 判失败（BUDGET_EXCEEDED）；写了部分 → ok 但明确标 budgetExceeded
      ok: status === 'ok' && !(budgetExceeded && written.length === 0),
      code: budgetExceeded && written.length === 0
        ? 'BUDGET_EXCEEDED'
        : (status === 'ok' ? null : (error?.code || 'RUN_FAILED')),
      budgetExceeded,
      runId,
      elapsedMs: runRow.elapsedMs,
      wrote: {
        claims: written.length,
        superseded: supersededList.length,
        conflicts: conflictList.length,
        rejected: rejected.length,
        skipped: skipped.length,
        speakers: { ...speakerTally },
        tokens: { prompt: totalUsage.promptTokens, output: totalUsage.outputTokens, estimated: totalUsage.estimated },
        costYuan: totalCost,
      },
      batches: batchReports,
      rejected: rejected.slice(0, 20),
      skippedDetail: skipped.slice(0, 20),
      conflictsDetail: conflictList.slice(0, 20),
      error,
      note: budgetExceeded
        ? `本次输出 token 已用到 ${totalUsage.outputTokens}/${totalOutCap}（预算耗尽）：已写入 ${written.length} 条完整 claim，剩余批次留到下次；要一次跑完请调大 budgetTokens`
        : (status === 'ok'
          ? '写入完成；topic 正文用 jianmu_year_rebuild 生成（0 LLM）'
          : '本次运行失败/部分失败：已写入的是完整 claim，未写入的没有半成品；下轮可重试'),
    }
  } catch (e) {
    const info = toErrInfo(e)
    // 失败也要留痕（run 记录带 error；不写半成品 claim）
    // 只有「成功路径还没写 run」时才补一条 error run，避免同一 runId 写两行
    let runLogError = null
    if (!runLogged) {
      try {
        await appendRun(dataRoot, personaId, {
          runId, at: Date.now(), startedAt, elapsedMs: Date.now() - startedAt,
          trigger: trigger === 'auto' ? 'auto' : 'manual', personaId, scope, topicId: topicId || null,
          model: `${effProvider}/${effModel}`, promptVersion: PROMPT_VERSION,
          inputChunks: selectedChunks, inputChars: selectedChars, batches: sel.batches.length,
          batchReports,
          promptTokens: totalUsage.promptTokens, outputTokens: totalUsage.outputTokens,
          tokensEstimated: totalUsage.estimated,
          costYuan: costYuan(totalUsage, pricingCfg),
          claimsWritten: written.length, drafts: 0, conflicts: conflictList.length, superseded: supersededList.length,
          rejected: rejected.length, skipped: skipped.length, coveredChunks,
          status: 'error', error: info,
        })
        runLogged = true
      } catch (logErr) {
        // run 日志写不进去也要让用户知道（不能静默吞）
        runLogError = toErrInfo(logErr)
      }
    }
    return {
      ok: false, code: info.code, error: info, runId, runLogError,
      wrote: written.length, batches: batchReports,
    }
  } finally {
    await lock.release().catch(() => {})
  }
}
