# 建木 · 处理层「熏习」契约 v1（2026-11-07 冻结）

> 状态：**v1a 冻结（2026-11-07）**。本文是 `dsh-memory-process@0.2.0` 的实现与验收口径。
> 包体：`dsh-memory-process`，`schemaVersion = 1`，`contractVersion = 1`（根藏 `rootContractVersion = 1`）。
> 根藏契约：`../../root/CONTRACT-v1.md`。
> 一句话：**熏习是「记忆的整理台」，不是「记忆的作家」。**
> v0.2.0（2026-11-09）：默认插件内自动跟随（每小时 :17，根藏 :07 之后），取代旧脚本里的 `spawnSync`；仍是零 LLM、零网络、幂等增量。

## 0. 边界

| 做 | 不做 |
|---|---|
| 读根藏 `chunks.jsonl`（只读） | 改根藏任何文件（`chunks` / `vectors` / `manifest` / `identity`） |
| 一个 process scope = 一个 `personaId` | 跨 persona 读写 / 共享记忆 / `_shared` |
| 写自己的状态、topic 归属、待处理队列 | 写 topic 正文 / 摘要 / 结论（归年轮） |
| 重复检测、取代候选、过期/归档状态 | 自动总结、自动反思、人格演化 |
| topic 创建、手动归属、规则建议（v1b） | 注入上下文（归镜台） |
| 只读 UI API + 动作 API | 注册 `recall/search/query` 工具（归寻枝） |
| 确定性规则优先，LLM 默认关 | 每轮调用模型、后台无限重试 |

`persona_unassigned` 是独立 scope：可以单独处理，但**不得并入具名人格**；人工指派后再按 `personaId` 迁移状态。

## 1. 路径与写入纪律

```
<dataRoot>/identity.json                    # 根藏只读
<dataRoot>/scopes/<personaId>/...           # 根藏只读（熏习不打开写句柄）
<dataRoot>/process/<personaId>/
  manifest.json
  state.jsonl
  topics.jsonl
  topic_members.jsonl
  duplicates.jsonl
  pending.jsonl
  conflicts.jsonl
  cost.jsonl
  _archive/                                 # 备份 / apply 快照 / 导出 / anchor 重映射候选
  .lock                                     # 单写者锁（pid+时间+主机）
```

- `dataRoot` 默认 `<DSH_HOME>/memory-jianmu`；实际值写进 `process/<personaId>/manifest.json`。
- **唯一可写区 = `process/<personaId>/`**。运行时闸门 `assertProcessWrite` 拒绝写 `scopes/`、`~/.dsh/sessions/` 与熏习目录之外的路径。
- 所有状态文件**原子写**（tmp wx → write → fsync → close → rename）；追加日志失败截回原尺寸。
- 写前快照：`apply` / `restore` / `conflict` / `rebuild` 先备份到 `_archive/<reason>-<ts>/`。
- 写后读回：found / missing / unknown 三态；`unknown ≠ 成功`。

## 2. 数据模型（v1 冻结字段）

### 2.1 `state.jsonl` — 每条记忆的状态（追加日志，latest-wins）

```json
{
  "chunkId": "sha256(...)",
  "anchorKey": "session-xxx|messageId|seq|part",
  "scope": "alice",
  "status": "active | superseded | expired | archived",
  "validFrom": 1762018800000,
  "validTo": null,
  "supersededBy": null,
  "reason": "rule:classified | root:retention | rule:explicit-correction | user:manual | user:restore",
  "source": "rule | user | model",
  "confidence": 0.9,
  "version": 1,
  "epistemic": "fact | inference | hypothesis | quote | unknown",
  "attribution": "user | assistant | third-party | tool | unknown",
  "sensitivity": "normal | boundary | sensitive",
  "conflictGroup": null,
  "ruleRef": { "ruleId": "rule:role-default", "ruleVersion": "2026-11-07.1" },
  "updatedAt": 1762018800000,
  "generation": "1",
  "rootBuiltAt": "2026-11-07T03:11:37.633Z",
  "sourceHash": "…"
}
```

- `status` 只表达可见性/有效性，**不删原文**；未处理块默认 `active`（铁律：未处理 ≠ 不可见）。
- `scope = personaId`；一个 process scope 只服务一个 persona。
- `epistemic` 默认从根藏 `role` 推导（user→fact / assistant→inference / tool|system→unknown）；规则只能保持或降低（`fact > inference > hypothesis > quote > unknown`），**绝不升级**。
- `attribution` 保留「谁说的」；助手自述、第三方转述不能当成用户事实。
- `sensitivity`：`normal / boundary / sensitive`；敏感 scope 不跨 scope 合并。
- `conflictGroup` 关联 `conflicts.jsonl`；未解释的矛盾只开组，不裁决。
- `version`：规则/用户写新记录时递增；旧记录保留。
- `ruleRef`：规则 id + 版本；状态可从根藏 + 规则重建。
- `rootBuiltAt` / `sourceHash`：v1a 冻结的审计字段，用于 `verify` 判断 stale。
- latest-wins：同一 `chunkId` 取 `updatedAt` 最大；并列取后出现者。
- `reason = user:restore` 的 `active` 记录优先于根藏 retention 镜像（restore 不会被下一次 run 立即冲掉）。

### 2.2 `duplicates.jsonl` — 重复组

```json
{
  "groupId": "dup-exact-… | dup-near-…",
  "chunkIds": ["…", "…"],
  "method": "exact | simhash+3gram",
  "similarity": 0.97,
  "evidenceCount": 2,
  "mergedFrom": ["…", "…"],
  "version": 2,
  "status": "pending | merged | dismissed",
  "createdAt": 1762018800000,
  "updatedAt": 1762018800000,
  "generatedAt": 1762018800000,
  "normalizer": "nfkc-collapse-v1"
}
```

- 精确组优先；近重复只在「不属于精确组」的块之间计算，避免组重叠。
- `evidenceCount` / `mergedFrom` 保留全部成员；`merged` 只影响展示，不物理删。
- 组 id 确定性（成员 + 方法哈希），重跑不重复。
- **增量对账**：根藏追加后，已有 `pending` 组必须更新成员（同组新版本 + version+1）；近重复重叠组合并到主组，其余标 `dismissed`；`merged/dismissed` 不复活。`verify` 会报 `DUPLICATE_GROUP_OVERLAP`。
- `createdAt` 记记忆时间（chunk.t），`generatedAt`/`updatedAt` 记生成时间；UI 候选排序用 `generatedAt`。

### 2.3 `pending.jsonl` — 待处理队列

```json
{
  "pendingId": "pending-supersede-…",
  "kind": "dedupe | supersede | expire | archive | topic",
  "chunkIds": ["…", "…"],
  "proposed": { "status": "superseded", "chunkId": "…", "supersededBy": "…", "validTo": 0 },
  "reason": "rule:explicit-correction | user:manual",
  "confidence": 0.7,
  "status": "pending | applied | dismissed",
  "createdAt": 1762018800000,
  "memoryT": 1762018800000,
  "generatedAt": 1762018800000,
  "updatedAt": 1762018800000,
  "generation": "1",
  "rootGeneration": 1,
  "rootBuiltAt": "…",
  "applyId": null
}
```

- 所有不确定动作先 pending；`apply` 才写 state/duplicates。
- `apply` 必须带 `expectedGeneration` + `confirm=true`；`rootGeneration` 或 `rootBuiltAt` 变化 → `STALE_ROOT`（「旧任务未写入」）。根藏 append 只改 builtAt 不递增 generation，所以两者都必须比。
- 同一 `applyId` 重复调用幂等（`_archive/applied/<applyId>.json` + pending 状态复核）；`applyId` 只允许 `[A-Za-z0-9._-]` 且不得含 `..`，解析后必须在 `_archive/applied/` 下。
- `createdAt` = 记忆时间（chunk.t），`generatedAt`/`updatedAt` = 生成时间；UI 按 `generatedAt` 排候选。

### 2.4 `conflicts.jsonl` — 未解释的矛盾

```json
{
  "conflictId": "conflict-unexplained-contradiction-…",
  "chunkIds": ["…", "…"],
  "kind": "unexplained-contradiction | change | correction",
  "status": "open | resolved | dismissed",
  "resolution": null,
  "createdAt": 1762018800000,
  "updatedAt": 1762018800000,
  "note": "…",
  "rootBuiltAt": "…"
}
```

- v1a 只做显式线索 + 用户标记；未解释矛盾的**自动配对放 v1b**，不猜。
- v1a 的「无对照目标改口」只计数 `manifest.lastRunStats.unpairedCorrections`，**不自动写 conflict**；用户可用 `conflict-add` 手动开。`conflicts` 里的 `ruleRef:null` 表示用户手动标记。
- `open` 不参与自动 apply；两条都保持 `active`；不因时间新就自动选新。

### 2.5 `topics.jsonl` / `topic_members.jsonl`（v1b 写入）

```json
{ "topicId": "topic-…", "name": "LoRA 训练", "kind": "manual | suggested | imported", "parentId": null, "source": "user | rule | soul-md", "createdAt": 0, "updatedAt": 0 }
{ "topicId": "topic-…", "chunkId": "…", "assignedBy": "user | rule", "confidence": 0.0, "assignedAt": 0 }
```

- 不写 topic 正文；正文在年轮/外部文档。
- `(topicId, chunkId)` 唯一；重复 assign 幂等；v1 允许多归属，UI 显示 `confidence` 最高者为主 topic。

### 2.6 `cost.jsonl` — 可选 LLM 记账

```json
{ "at": 0, "kind": "supersede-suggest", "provider": "…", "model": "…", "tokens": 0, "cost": 0 }
```

- v1a 默认零 LLM，文件为空；开启后单次有预算上限，记账失败只告警。

### 2.7 `manifest.json`

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "rootContractVersion": 1,
  "personaId": "alice",
  "generation": 1,
  "ruleVersion": "2026-11-07.1",
  "dataRoot": "C:\\Users\\alice\\.dsh\\memory-jianmu",
  "rootDataRoot": "…",
  "rootBuiltAt": "…",
  "createdAt": 0,
  "updatedAt": 0,
  "lastRunAt": 0,
  "lastRunRootBuiltAt": "…",
  "lastRunRootChunks": 4043,
  "lastRunSignature": { "builtAt": "…", "generation": 1, "chunks": 4043, "chunksBytes": 0, "chunksMtimeMs": 0 },
  "lastRunCheckpoint": { "rootBuiltAt": "…", "nextIndex": 4043, "total": 4043, "complete": true, "lastChunkId": "…" },
  "lastError": null,
  "counts": { "chunks": 4043, "states": 4043, "processed": 4043, "topics": 0, "pending": 0, "conflicts": 0, "duplicates": 9 },
  "thresholds": { "simhashDistance": 3, "jaccard": 0.9, "supersedeMinConfidence": 0.6, "supersedeMinJaccard": 0.35, "dedupeNormalizer": "nfkc-collapse-v1" },
  "llmEnabled": false,
  "autoMirrorRetention": true,
  "writer": { "name": "dsh-memory-process", "version": "0.1.0" }
}
```

- `generation` 在每次成功写（run/apply/restore/conflict/rebuild）后 +1；用于旧快照拒绝。
- `lastRunSignature` 用于增量/幂等判断（`rootBuiltAt` + 块数）。

## 3. 处理规则（v1a）

- **精确重复**：NFKC + 合并连续空白 + 去首尾空白后 sha256；同 scope 分组。
- **近重复**：SimHash 64-bit（4×16-bit 分桶，Hamming ≤ 3）+ 字符 3-gram Jaccard ≥ 0.9；只同 scope，不做全量向量两两比。
- **分类**：`epistemic` / `attribution` / `sensitivity`；规则只降不升；不写原文片段进状态。
- **过期**：只镜像根藏 `retention=expired` → `state.expired`，不物理删；用户 restore 优先。
- **归档**：只处理用户显式归档，默认进 pending。
- **取代**：明确改口/纠错（「不是…是…」「改成」「更正」「说错了」等）+ 同 session + 3-gram 相似度 ≥ 0.35 + 置信度 ≥ 0.6 → pending；找不到对照目标只计入 `unpairedCorrections`，不自动开 conflict（自动配对 v1b）。
- **未解释矛盾**：v1a 只接受用户标记（`conflict-add`）；自动配对 v1b。
- **无时间衰减**：`expire` 只按 retention/显式策略；不做「越旧越降权」。

## 4. 工具面（冻结）

允许恰好九件：

| 工具 | v1a 行为 |
|---|---|
| `jianmu_process_run` | 生成候选，不应用 |
| `jianmu_process_status` | 概览/计数/最近运行/错误/锁 |
| `jianmu_process_review` | 列 pending / duplicates / conflicts |
| `jianmu_process_apply` | 确认应用（generation + confirm） |
| `jianmu_process_topics` | 只读列表（创建/归属 v1b） |
| `jianmu_process_conflicts` | 只读列表（解决 v1.1） |
| `jianmu_process_rebuild` | 从根藏 + ruleVersion 重建，不调 LLM/不重嵌 |
| `jianmu_process_verify` | 孤儿/stale/缺失/跨 scope/计数 |
| `jianmu_process_export` | 导出状态/topic 元数据 |

禁止：

- ❌ 工具名含 `recall/search/query`
- ❌ 注册注入钩子 / pre-step / systemPrompt
- ❌ 写 `chunks.jsonl` / 根藏任何文件
- ❌ 写 topic 正文 / `claims.jsonl`
- ❌ 静默吞摄取/应用失败（必须写 `lastError`）

## 5. 只读 API（给 UI v1）

| API | 返回 |
|---|---|
| `context` | 当前 persona / 身份 / 各 scope 计数；默认按工作区解析，不强制传 personaId |
| `capabilities` | v1a 能力开关（只读、主题/检索/人格卡/动作均 false） |
| `overview` | 块数、状态计数、topic 数、pending 数、最近运行、错误、`degraded/warnings/errors`、`rootStorage`、`processVolume` |
| `rootStorage` | 根藏存储卡：chunks、向量 rows/missing/badRows/dim/model、volumeBytes、tMin/tMax/coverageDays、builtAt/retentionDays、warnings；**只 stat，不读向量内容** |
| `memories` | 当前 scope 的 chunk 列表（默认 `textPreview`，详情才全文）；支持 `status/role/channel/q/from/to/chunkIds/session/topicId/conflictGroup` 过滤 |
| `memory` | 单条详情：原文、锚点、附件、状态、topics、conflictGroup |
| `chunks` | 按 chunkIds 批量取锚点/摘要/状态（候选解析用） |
| `topics` | topic 列表 + `uniqueMemberCount` + 最后更新（`recallCount` 由寻枝另给，未装为 null） |
| `pending` | 候选列表 + 理由 + 置信度；每条内嵌 `chunks:[锚点+摘要]`；duplicates/conflicts 同样内嵌 |
| `conflicts` | 未解释矛盾列表 + 双方锚点/摘要 + 状态 |
| `verify` | 孤儿/stale/缺失/跨 scope/枚举/重复重叠/冲突联动/计数问题 |
| `status` | generation/阈值/ruleVersion/dataRoot + 可选 effective config |

- 所有只读 API 只返回当前 persona scope；不提供跨 persona 读取/合并。
- UI 不直接读写文件；只调 API。API 模块（`lib/api.mjs`）不导出任何写函数。
- host 端额外暴露 `jianmuProcess` 服务与 `/api/memory-process/*`：
  - 只读 = GET；
  - 写动作 = POST `/apply`、`/dismiss`、`/manual`、`/rebuild`（必须带 `x-dsh-jianmu: 1` + 同源 Origin + body `confirm:true` + `expectedGeneration`；写前快照、写后读回）。
- **P2.5（0.2.3）额外暴露 `jianmuConflicts` 只读服务**（不注册 HTTP 路由）：
  - `list({ personaId?, workspace?, limit? })` → `{ ok, personaId, total, cards:[{ conflictId, kind, createdAt, note, a:{chunkId,dateText,role,text,session,seq}, b:{...} }] }`
  - 只读 `status=open` 的 conflicts + 根藏块；缺块/跨人格/非 open 一律跳过；A/B 各截 ≤120 字；**不写、不裁决、绝不抛**。
  - 消费者：镜台 `conflictCard=true`（默认 false）时每回合最多读一次；没装熏习时镜台静默跳过。
- **不提供删除原话的端点**；`restore` 仍是命令行/工具面能力。
- 动作 API v1.1 的剩余部分（topic create/assign/resolve conflict）仍未做。

### 5.2 只读会话源（2026-11-08，P1-4）

用途：用户**没装根藏/根藏为空**时，熏习单独也能当「原话汇总看板」。

| API（GET） | 返回 |
|---|---|
| `source/probe` | 轻量探针：`rootData`（根藏里有没有 chunks.jsonl 非空），不扫会话，秒回 |
| `source/status` | 会话文件数、会话数、工作区数、原话块数、缓存文件数、`lastScanAt`、`rootData` |
| `source/workspaces` | 工作区聚合：`ws`（真实路径）、会话数、原话块数、tMin/tMax |
| `source/memories` | 原话列表（按时间倒序）；支持 `days/ws/session/role/q/from/to/limit/offset/refresh` |

- 数据源：直接只读 `<DSH_HOME>/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`。
- 用共享库 `dsh-jianmu-utterance-core` 抽取（与根藏同一实现）；**不依赖根藏插件**。
- 只读：不写 sessions/scopes/process；缓存只在内存（按文件 mtime 增量，TTL 30s）。
- 不调 LLM、不做嵌入、不跑熏习规则；返回值可能含原话，只适合本机/owner 查看。
- UI 切换：`source/probe.rootData === false` → 自动显示「原话看板」，否则显示现有「记忆库」。

### 5.1 UI v1 只读壳（2026-11-07 已落地）

- 侧栏入口：`sidebar.panellist` id `jianmu-memory`；主面板：`main` key `jianmu-memory`。
- 对话入口：`conversation.view` id `jianmu-memory`（tab 挤不下时进 More）。
- 页面：概览 / 记忆（列表 + 详情）/ 待处理 / 设置；主题 tab 未显示（v1b）。
- 人格：顶部「当前人格」选择器，一次只显示一个 scope，选择只存 localStorage。
- 写动作（2026-11-08 起）：应用/驳回候选、标记过期/归档（只建候选）、rebuild；逐条二次确认，无删除原话入口。
- 已知限制：对话记忆默认沿用上次选择的人格，v1.1 自动从会话工作区解析；当前会话未进根藏时显示 0。

## 6. 守卫（必须能红）

1. `run`/`apply` 后根藏文件 hash 前后不变。
2. 不注册任何 `recall/search/query` 工具；无注入钩子。
3. 不产生 topic 正文 / `claims.jsonl`；状态记录不含原文正文字段。
4. 同一 `applyId` 重复调用幂等。
5. 过期/归档/取代都不物理删；`restore` 能恢复。
6. 默认 LLM 调用数 = 0；`cost.jsonl` 为空；源码无网络/模型调用。
7. 根藏 `generation` 变化后旧 `apply` 被拒（`STALE_ROOT`）。
8. 未处理/未评分块仍 `active` 可见；`run` 失败不隐藏任何记忆。
9. `epistemic` 只能保持或降低；未解释矛盾不自动裁决；`attribution` / `sensitivity` 保留。
10. 重复组合并保留 `evidenceCount` / `mergedFrom`；不丢成员。
11. 不做时间衰减 / 相关性降权；`expire` 只按 retention/显式策略。
12. `rebuild` 同 `ruleVersion` 可复现，且不调 LLM、不重嵌；`run` 断点续跑，同 `rootBuiltAt` 不重复。
13. 两个 persona scope 交错跑，state/topic/pending 不串味。
14. 原子写/备份/generation/锁（F1–F4）全绿。
15. UI 只读 API 不写文件；API 模块无写导出。
16. 跨 persona 的 state/topic/pending 不出现；一个 process scope 只读一个 persona 的 chunks。
17. `persona_unassigned` 不被自动并入具名人格；需要人工指派。
18. 工具面守卫按**实际注册名**校验（不是常量自证）；多注册/注册检索词工具必须红。
19. `applyId`/`export out` 不得路径穿越；不得覆盖 `state/manifest` 等核心文件。
20. 根藏 append 可能只改 `builtAt` 不改 `generation`；旧 apply 必须同时比 `rootBuiltAt`，变化即 `STALE_ROOT`。
21. 增量后重复组必须对账：同组更新成员、近重复重叠组合并；`verify` 报 `DUPLICATE_GROUP_OVERLAP`。
22. `rebuild` 检测到用户态（restore/归档/过期/已应用候选/手工冲突）默认拒绝；不得静默丢用户决定。

## 7. 变更记录（冻结后只追加）

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-07 | 从施工计划 §4 冻结为 v1a：补 `rootBuiltAt` / `sourceHash` 审计字段、`lastRunRootChunks` / `lastRunSignature`、pending `rootGeneration`、确定性 id、`user:restore` 优先级 | 块 1 冻结合同；验收要能判 stale / 旧快照 |
| 2026-11-07 | **UI 开工前独立审查后的补丁**：API 增加 context/capabilities/rootStorage/memory/chunks 与候选内嵌锚点；memories 默认 preview；pending/duplicates/conflicts 增加 `generatedAt`；apply 必填 `expectedGeneration` 且同时比 `rootBuiltAt`；applyId/export 路径收紧；重复组增量对账；rebuild 用户态保护；新增守卫 18–22 | 独立审查 P0/P1；避免 UI 返工与数据毁损 |
| 2026-11-07 | **UI v1 只读壳落地**：`client.js` 注册侧栏 `sidebar.panellist`/`main`（id `jianmu-memory`）与对话 `conversation.view`（id `jianmu-memory`）；概览/记忆/待处理/设置；人格选择器只存 UI 偏好；host 路由改为 `ctx.inject(['webServer'])` 延迟挂载 | 用户拍板按上下文统计形式做只读 UI；UI 前先审后修 |
| 2026-11-08 | **写动作 v1.1（P1-1）**：新增 `dismissPending`；POST `/apply` `/dismiss` `/manual` `/rebuild`，安全闸 = `x-dsh-jianmu:1` + 同源 Origin + `confirm:true` + `expectedGeneration`；UI 加应用/驳回/标记/rebuild；**禁删原话** | 熏习核心价值是状态管理，UI 一直只读很别扭；开状态、禁删除 |
| 2026-11-08 | **只读会话源（P1-4）**：抽取器收敛到共享库 `dsh-jianmu-utterance-core`（根藏 shim 指向它）；熏习新增 `source/*` 只读 API 与「原话看板」；`source/probe.rootData=false` 时自动切换 | 用户没装根藏时熏习单独无用；用户要求「有根藏读根藏，没根藏当只读原话看板」 |
