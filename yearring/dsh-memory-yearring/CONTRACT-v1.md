# 年轮 · 数据契约 v1（定稿 2026-11-08；2026-11-12 追加 speaker）

> 包：`dsh-memory-yearring@0.3.0`｜层：建木·认知层
> 本契约冻结 v1a 的落盘结构与硬规则；改结构必须升 `contractVersion`。
> 对外规格以本契约与 README 为准。

---

## 0. 一句话

**年轮只做一件事：从根藏原话里提炼「带原话锚点」的 claim，并把它们拼成 topic 正文；不改原文、不改人格、不注入。**
（v0.2.0 起：默认自带插件内定时消化，但每一轮仍受批大小、token 预算与每日安全阀约束；`run` 工具的手动两步确认语义不变。）

## 1. 层间边界

| 层 | 读 | 写 | 判据 |
|---|---|---|---|
| 根藏 `scopes/` | ✅ 只读 | ❌ | 原话唯一事实源，永不改 |
| 熏习 `process/` | ✅ 只读 | ❌ | 状态与 topic 归属归熏习 |
| 镜台 `persona/` | ❌ 不读 | ❌ | 人格归镜台 |
| 年轮 `year/` | ✅ | ✅ **唯一可写** | 派生层，可全量重建 |
| 注入 | ❌ | ❌ | 注入只有镜台 |

硬规则：**只改状态/元数据 → 熏习；产生新表述 → 年轮；注入 → 镜台。**

## 2. 目录布局

```text
<dataRoot>/year/<personaId>/
  claims.jsonl       唯一事实源（append-only，latest-wins）
  manifest.json      计数/代数/预算/最近运行（原子写）
  runs.jsonl         每次 run 一行（append-only）
  topic_docs/*.md    派生正文（可删，rebuild 全量恢复，0 LLM）
  _archive/<tag>/    旧快照（topic docs 镜像、陈旧锁），不物理删 claim
  .lock              单写者锁（pid/时间/主机）
```

`<dataRoot>` 默认 `~/.dsh/memory-jianmu`，与根藏同根。

## 3. `claims.jsonl`

一行一条 claim（JSONL，append-only）。**同一 `claimId` 重复出现时后者覆盖（latest-wins），但正常流程不产生重复。**

| 字段 | 类型 | 说明 |
|---|---|---|
| `claimId` | string | `sha256(personaId|kind|claimGroupId|derivedFromHash|revision)` |
| `claimGroupId` | string | `sha256(personaId|kind|normalizedTitle)`，稳定分组键 |
| `revision` | number | 同组修订号，从 1 起 |
| `personaId` | string | 归属人格（slug） |
| `kind` | enum | `event/fact/preference/boundary/relation/timeline/conclusion/knowledge` |
| `epistemic` | enum | `fact/inference/hearsay/unknown` |
| `speaker` | enum | `user/assistant/unknown`（**v0.3.0 追加，可选**；缺失视为 unknown） |
| `speakerSource` | enum | `llm/anchor/missing/inference-rule/backfill`（**v0.3.0 追加**，审计用：这个值从哪来） |
| `title` | string | 一句话结论，≤120 字，不换行 |
| `body` | string | 展开说明，≤300 字，可为空 |
| `topicId` | string\|null | 熏习的 topic（v1a 通常 null） |
| `topicHint` | string\|null | 建议主题名（年轮只建议，不写归属） |
| `status` | enum | `active/superseded/expired/archived/draft/conflicted` |
| `confidence` | number | 0..1 |
| `derivedFrom` | array | 锚点，见下 |
| `derivedFromHash` | string | `sha256(sorted "chunkId|quote")` |
| `supersedes` | string\|null | 本 claim 取代的旧 claimId |
| `supersededBy` | string\|null | 被谁取代（推导字段，落盘可空） |
| `conflictsWith` | string[] | 冲突的 claimGroupId 列表 |
| `reportedBy` | string\|null | `epistemic=hearsay` 时的转述来源 |
| `source` | enum | `llm/rule/manual` |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |
| `runId` | string\|null | 产生它的 run |
| `model` | string\|null | `provider/model` |
| `promptVersion` | string\|null | 如 `year-v1` |
| `costTokens` | number | 该条分摊的输出 token |
| `review` | object | `{status: unreviewed/confirmed/rejected, by, at}`（v1b 才写 confirmed） |

### 锚点 `derivedFrom[]`

```json
{ "chunkId": "sha256(...)", "session": "session-...", "messageId": "...", "seq": 15, "part": 0, "t": 1762018800000, "quote": "原话逐字片段（8–200字）" }
```

> **v0.3.0 追加字段（向后兼容）**：`speaker` / `speakerSource` 是**纯追加**，不改动任何已有字段语义与校验硬规则，故 `contractVersion` 仍为 1。
> · 取值非法/缺省**不拒收**（降为 `unknown` + warning），老提示词还在跑时不会因新字段丢 claim。
> · `epistemic=inference` 的 `speaker` 强制 `unknown`（推测不是任何人的原话）。
> · 缺省时按第一个锚点所在块的 `role/sourceType` **确定性补全**（与回填工具同一规则）；锚点角色也不明才写 `unknown`。
> · 老数据回填：`node tools/backfill-claim-speaker.mjs --persona <id>`（默认 dry-run；`--apply` 时先快照再 append 同 claimId 新行，latest-wins，可回滚）。

### 硬规则（服务端逐条校验，违反即拒收）

1. **非 draft 必须至少 1 条 `derivedFrom`**，且 `quote` 是对应 `chunk.text` 的**逐字子串**（不做模糊匹配）；找不到 → 拒收，不降级为「无来源」。
2. `quoteChunkId` 必须存在于该 persona 的根藏；跨人格 → 拒收。
3. `quote` 长度 8–200。
4. `epistemic=inference` 的 `title` 必须带「推测：」（服务端自动补）。
5. `kind/epistemic/status/confidence` 必须合法。
6. `title/body/quote` 过入库扫描：**红项拒收**（注入句/密钥/后门/不可见字符），黄项收但记 warning。
7. `claimGroupId` 稳定；修订 = 同组 `revision+1`，旧 revision 保留（有效状态由索引推导为 `superseded`）。
8. **（v0.3.0）`speaker` 不走拒收**：缺失/非法 → 归一 `unknown`（能按锚点判定则补 `user/assistant`）并记 warning；`epistemic=inference` 时强制 `unknown`。`verify` 里缺 speaker 只告警（老数据），非法值或 inference 非 unknown 记 error。

### 有效状态推导（append-only 的落地方式）

`claims.jsonl` 只追加。某条 claim 的**有效状态** = 

1. 若它的 `claimId` 出现在任何其他 claim 的 `supersedes` 里 → `superseded`（跨组取代）；
2. 否则若它所在组有更高 `revision` → `superseded`；
3. 否则用自身 `status`。

**不修改历史行。** `supersededBy` 是派生字段（读时推导），不要求落盘。

> 与施工计划 §3.1 的差异：计划里 `supersedes` 写的是 `claimGroupId`，实现改为 **`claimId`**（精确到版本，否则无法只取代某一条而不是整组）。`claimGroupId` 仍用于分组与去重。

## 4. `topic_docs/*.md`

front-matter：

```yaml
---
topicId: topic-... | hint-<hash10> | untitled
title: LoRA 训练
version: 3
status: active
generator: rule-v1
ruleVersion: 2026-11-08.1
claimCount: 12
activeCount: 9
conflictedCount: 1
historyCount: 2
generatedAt: 1762018800000
derivedFromHash: sha256(...)
claimIds: [claim-..., claim-...]
---
```

正文规则（0 LLM）：

- `active` claims 按锚点最早时间排序，每条一行，附 `[^cN]`；
- 冲突 claim 单列「存在矛盾」小节，不合并；
- 被取代/过期/归档进 `<details>历史版本</details>`；
- footer 列锚点：`chunkId · session · seq · 「quote」`；
- 没有 claim 的 topic **不生成正文**（「正文待生成」，不编）。

## 5. `manifest.json`

```json
{
  "schemaVersion": 1, "contractVersion": 1, "personaId": "alice", "generation": 7,
  "counts": { "claims": 0, "active": 0, "draft": 0, "conflicted": 0, "topicDocs": 0, "runs": 3 },
  "lastRunAt": 1762018800000, "lastRunId": "run-...", "lastRunRootBuiltAt": "...",
  "model": "deepseek-account/deepseek-flash", "promptVersion": "year-v1", "ruleVersion": "2026-11-08.1",
  "budget": { "maxInputChars": 24000, "maxOutputTokens": 8000, "timeoutMs": 90000, "maxClaimsPerRun": 80 },
  "degraded": false, "lastError": null, "createdAt": 0, "updatedAt": 0,
  "writer": { "name": "dsh-memory-yearring", "version": "0.1.0" }
}
```

`generation` 每次写 claim / rebuild 递增，用于「调用方看到的是不是旧状态」。

## 6. `runs.jsonl`

```json
{
  "runId": "run-20261108-095512-ab12cd", "at": 1762018800000, "startedAt": 0, "elapsedMs": 0,
  "trigger": "manual", "personaId": "alice", "scope": "all", "topicId": null,
  "model": "deepseek-account/deepseek-flash", "promptVersion": "year-v1",
  "inputChunks": 61, "inputChars": 23892, "batches": 1,
  "batchReports": [ { "group": "session:...", "chunks": 61, "status": "ok", "rawItems": 6, "accepted": 6, "written": 6, "skipped": 0, "rejected": 0, "elapsedMs": 47000, "usage": {} } ],
  "promptTokens": 1931, "outputTokens": 2296, "tokensEstimated": false,
  "costYuan": 0.0118, "claimsWritten": 6, "drafts": 0,
  "conflicts": 0, "superseded": 0, "rejected": 0, "skipped": 0,
  "coveredChunks": ["<chunkId>", "..."],
  "status": "ok | error", "error": null
}
```

- `coveredChunks` 是增量去重的依据（下次不含 force 时跳过）。
- `costYuan` 按配置单价估算（默认输入 0.5 / 输出 1.5 元每百万 token）；**是估算，不是账单**。

## 7. 工具面（7 个，写只有 2 个）

| 工具 | 读写 | 关键参数 |
|---|---|---|
| `jianmu_year_status` | 只读 | `personaId?` `deep?` |
| `jianmu_year_topics` | 只读 | `personaId?` `limit?` `kind?` `status?` `epistemic?` |
| `jianmu_year_claim` | 只读 | `claimId` `includeText?` |
| `jianmu_year_run` | **写** | `personaId?` `topicId?` `scope?` `maxChunks?` `budgetTokens?` `model?` `provider?` `maxBatches?` `force?` **`dryRun?` `confirm=true`** |
| `jianmu_year_rebuild` | **写** | `personaId?` `confirm=true`（0 LLM） |
| `jianmu_year_verify` | 只读 | `personaId?` |
| `jianmu_year_export` | 只读 | `personaId?` `outFile?`（必须在 `year/<personaId>/` 内） |

## 8. HTTP 只读 API

```text
GET /api/year-ring/context?personaId=|workspace=
GET /api/year-ring/status?personaId=&deep=1
GET /api/year-ring/topics?personaId=&limit=&kind=&status=&epistemic=
GET /api/year-ring/claims?personaId=&kind=&status=&topicId=&epistemic=&q=&limit=&offset=
GET /api/year-ring/claim?claimId=&personaId=&includeText=0
GET /api/year-ring/verify?personaId=
GET /api/year-ring/capabilities
```

写动作**不走 HTTP**（v1a 只读）；写只走 `jianmu_year_run` / `jianmu_year_rebuild` 工具。

## 9. 错误码

| code | 含义 |
|---|---|
| `CONFIRM_REQUIRED` | 真跑/重建缺 confirm |
| `WRITE_DISABLED` | 写总闸关闭 |
| `READ_ONLY_ROOT` | 试图写只读源 |
| `PATH_OUTSIDE_ROOT` | 试图写 year/ 之外 |
| `BAD_PERSONA_ID` / `PERSONA_UNRESOLVED` | 人格非法/无法解析 |
| `SCOPE_NOT_FOUND` | 根藏 scope 不存在 |
| `QUOTE_NOT_FOUND` / `ANCHOR_INVALID` / `CLAIM_INVALID` | 锚点/claim 校验失败（单条拒收，不整批废） |
| `CROSS_PERSONA` | 跨人格锚点 |
| `SCAN_REJECTED` | 入库扫描红项 |
| `LLM_UNAVAILABLE` / `LLM_FAILED` / `LLM_TIMEOUT` / `LLM_JSON_INVALID` | 模型不可用/失败/超时/输出非 JSON |
| `NOTHING_TO_DO` | 没有可处理的新块 |
| `BUDGET_EXCEEDED` | 超出预算 |
| `LOCK_BUSY` | 另一个 run 正在写 |
| `READBACK_MISMATCH` | 写后读回缺条 |
| `JSONL_CORRUPT` | 数据文件有中间坏行 |

## 10. 验收口径

| 项 | 判据 |
|---|---|
| 锚点有效 | 所有非 draft claim 的 quote 是 chunk.text 逐字子串；`verify` 0 orphan |
| 幂等 | 同一输入重跑不产生重复 claim；失败不写半成品 |
| 可重建 | 删掉 `topic_docs/` 后 `rebuild` 从 claims 全量恢复，0 LLM |
| 边界 | `scopes/` `process/` `persona/` `soul-md` 前后 hash 不变 |
| 跨人格 | bob 的 claim 不出现在 alice 的 docs |
| 反注入 | 恶意原话不变成 claim/指令；scan 红项拒收 |
| 成本 | run 记账有 token/费用；超预算拒绝，不静默超支 |

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-08 | v1 | 定稿（v1a 实现对齐） |

---

## 12. 独立审查后的修订（2026-11-08，契约内兼容）

审查（只读对抗）后对行为做了以下收紧，**字段结构不变**，故 contractVersion 仍为 1：

| 项 | 修订后行为 |
|---|---|
| `confidence` | 必须 0..1；越界（如 999）**拒收**，不再静默夹值 |
| `epistemic=hearsay` | 必须填 `reportedBy`；否则拒收 |
| `topicHint` | 去 CR/LF 压平 + 过注入扫描；写入 front-matter 时 **YAML 双引号转义** |
| 入库扫描 | 匹配前做 NFKC + 去空白 + 去零宽 + 小写；**跨行归一化**再扫一遍（`忽略 以上` / `Ignore the above` / 跨行拆分都能命中） |
| `export` | 只允许写 `<year>/<personaId>/exports/`；拒绝覆盖 `claims.jsonl`/`manifest.json`/`runs.jsonl`/`.lock`/`cost.jsonl` |
| `run` 预算 | `budgetTokens` = **本次 run 的总输出 token 上限**（不是每批）；超了停批并标 `budgetExceeded`；一条没写时回 `BUDGET_EXCEEDED` |
| `run` 前置 | `claims.jsonl` 有中间坏行 → 拒跑（`DATA_CORRUPT`）；末尾半行不拦（append 前自动补换行） |
| 模型结束原因 | 按 `finish.reason.kind` 判定：`error/aborted` → 失败；`max-tokens` → `LLM_TRUNCATED` 且不写 |
| 计费 token | 输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`（DSH 三段不重叠） |
| 单块超大 | 超过单批字符预算的块 **单独成批**（不再永远选不中） |
| `rebuild` | 与 `run` 共用同一把 `.lock`；快照失败在结果里回 `snapshotError`，不假装可回滚 |
| topic 正文 | 只写本人格 claim（`groupClaims` 过滤 `personaId`）；topicId 会落到 claim 上 |
| `/api/year-ring/status` | 无 `personaId`/`workspace` 时返回 **200 + `resolved:false`**（UI 探针需要），其它端点在无 persona 时仍 409 |
| verify 新增检查 | quote 长度 8–200、`derivedFromHash` 重算、`claimId` 重算、front-matter 必需字段与 topicId/文件名一致 |

新增错误码：`REALPATH_ESCAPE`、`SYMLINK_TARGET`、`LLM_TRUNCATED`、`DATA_CORRUPT`。
