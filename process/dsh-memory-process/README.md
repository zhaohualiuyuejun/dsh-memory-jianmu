# 熏习 · dsh-memory-process

> 建木 · **处理层**：把根藏原话整理成状态、重复、待处理与冲突候选。
> 不改原文、不写 topic 正文、不注入、不检索、**默认零 LLM**。
> 版本 `0.2.7` · 契约 `contractVersion = 1`。

---

## 1. 它需要什么数据

熏习**只需要一个符合「根藏 chunk 契约」的目录**，不强制安装 `dsh-memory-store` 包。
你有两种用法：

### 方案 A（推荐）：装根藏

1. 安装 `dsh-memory-store`（根藏）；
2. 根藏自动摄取会话原话，写 `scopes/<personaId>/manifest.json + chunks.jsonl`；
3. 熏习把 `dataRoot` 指向根藏数据目录（默认 `<DSH_HOME>/memory-jianmu`），即可工作。

### 方案 B：自带原话块（高级，不装根藏也能用）

你自己把原话切好，放到：

```text
<dataRoot>/scopes/<personaId>/
  manifest.json      # 必需（最小字段见下）
  chunks.jsonl       # 必需，一行一条 utterance
  deleted.jsonl      # 可选：墓碑（forget/revive）
  identity.json      # 可选：UI 自动解析人格用；不提供就在 UI/工具里显式传 personaId
```

**熏习不读向量**：`vectors_v*.f32`、`index_meta.json` **不需要**。
（但如果你以后还要装寻枝做语义检索，那就需要补向量；见 §6。）

> **即使两者都没有**：只要 DSH 有 `<DSH_HOME>/sessions/`，熏习仍可显示「原话看板」——只读扫描会话、按人/天/工作区看原话（P1-4）。它不做状态/重复/待处理；那些仍需要上面的 chunk store。

---

## 2. 最小数据契约

### 2.1 `manifest.json`（最小字段）

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "generation": 1,
  "personaId": "demo",
  "builtAt": "2026-11-09T08:00:00.000Z",
  "chunks": 1234
}
```

- `personaId` 必须与目录名一致；
- `generation` / `builtAt` / `chunks` 建议提供：熏习用 `builtAt + chunks` 做幂等判断，缺了会反复处理或不续跑；
- 其他字段（provider/model/dim 等）熏习不依赖，可以缺省。

### 2.2 `chunks.jsonl`（一行一条）

**必需字段**（缺了会被跳过）：

```json
{
  "kind": "utterance",
  "personaId": "demo",
  "id": "sha256(...稳定 id...)",
  "text": "原话……",
  "contractVersion": 1
}
```

**强烈建议提供**（规则分类、时间过滤、分组会用到）：

```json
{
  "schemaVersion": 1,
  "session": "session-...",
  "messageId": "m1",
  "seq": 1,
  "part": 0,
  "role": "user",
  "sourceType": "user",
  "t": 1762018800000,
  "tz": "Asia/Shanghai",
  "ws": "H:/work/demo-project",
  "wsDir": "--H-work-demo-project--",
  "channel": "dsh",
  "attachments": [],
  "sourceHash": "...",
  "retention": "active",
  "ingestVersion": "external-1"
}
```

- `t` 是 **UTC epoch 毫秒**；没有它，时间类规则会退化；
- `id` 必须稳定且唯一；后续 claim/锚点都指向它；
- `role` / `sourceType` 决定分类；`retention=expired` 会被镜像成过期状态（不物理删）。

> 完整字段口径见根藏契约：`dsh-memory-store/CONTRACT-v1.md` §2.1。
> 熏习的读取代码只硬校验 `kind/personaId/id/text/contractVersion`，其余缺失会降级但不会崩。

---

## 3. 先自检：外部数据源检查器

不装根藏也能查：

```bash
node tools/check-external-store.mjs \
  --data-root "C:/Users/<you>/.dsh/memory-jianmu" \
  --persona demo
```

- `PASS`：熏习可读；
- `FAIL`：按 ❌ 修（缺 manifest/chunks、persona 不匹配、零有效行）；
- ⚠️ 是建议项（缺 recommend 字段、缺 identity、缺向量）。

加 `--json` 可给脚本消费。

---

## 4. 装好之后怎么用

### 4.1 设置

`dataRoot` 指向你的数据目录（默认 `<DSH_HOME>/memory-jianmu`）。
**这个目录必须可写**：熏习要写 `<dataRoot>/process/<personaId>/`。

如果外部 chunk store 是只读的：把它复制到一个可写目录，或把它挂在可写目录下再跑。

### 4.2 工具（宿主内）

```text
jianmu_process_status { personaId?, deep? }
jianmu_process_run    { personaId?, force?, maxChunks? }
jianmu_process_review { personaId?, kind? }
jianmu_process_apply  { personaId, pendingIds, expectedGeneration, confirm }
jianmu_process_topics / conflicts / rebuild / verify / export
```

### 4.3 CLI（运维）

```bash
node tools/cli.mjs status  --data-root "..." --persona demo
node tools/cli.mjs run     --data-root "..." --persona demo
node tools/cli.mjs verify  --data-root "..." --persona demo
node tools/cli.mjs review  --data-root "..." --persona demo
```

### 4.4 自动跟随

插件内定时器默认每小时 **:17**（根藏 :07 之后），启动 180 秒后补跑一次；根藏没变化时幂等跳过。
设置项：`autoRun` / `autoRunIntervalMinutes` / `autoRunMinute`。

---

## 5. 数据写在哪 / 边界

```text
<dataRoot>/process/<personaId>/
  manifest.json   state.jsonl  duplicates.jsonl  pending.jsonl  conflicts.jsonl  log.jsonl
```

- ❌ 不写 `scopes/`（根藏地盘）、不写 `year/`（年轮）、不写 `persona/`（镜台）；
- ❌ 不跨 persona 读写；
- ✅ 默认零 LLM、零网络、零嵌入；
- ✅ 未处理块默认 active 可见，不隐藏任何记忆。

### 5.1 给镜台用的只读服务（0.2.5 起）

- `jianmuProcess`：原有只读服务（context / overview / memories / pending / conflicts / verify / status / lifecycle）。
- `jianmuConflicts.list({ personaId?, workspace?, limit? })`：P2.5 冲突卡数据源。
  只读 `status=open` 的冲突 + 根藏块原文，A/B 各截 ≤120 字；缺块/跨人格直接跳过；
  **不写 conflicts 状态、不自动裁决、绝不抛**。镜台默认 `conflictCard=false`（不调用）。

---

## 6. 常见问题

**Q：不装根藏，熏习能读我自己切的原话吗？**
能。只要满足 §2 的 `manifest.json + chunks.jsonl`。已用最小外部库实测：1 块原话 → `runProcess` 成功写出 `process/<personaId>/`。

**Q：需要向量吗？**
熏习不需要。要接寻枝做语义检索时才需要 `vectors_v*.f32` 与 `index_meta.json`（那是根藏/寻枝的职责）。

**Q：我改了原话内容，熏习会重跑吗？**
会看 `manifest.builtAt` 与 `chunks`。**每次内容变化请更新 `builtAt`（并更新 `chunks` 计数）**，否则同 `builtAt + 同块数` 会被当成“没变”而跳过。

**Q：能只装熏习、不装根藏吗？**
可以，而且有两种形态：
- 只装熏习 + DSH 有 sessions：显示「原话看板」（只读扫会话，不做状态/重复）；
- 再给它一个外部 chunk store（或装根藏）：才有状态/重复/待处理/冲突。
没有自动摄取就自己维护原话块；想要自动摄取就装根藏（方案 A）。

---

## 7. 测试

```bash
node tools/selftest.mjs
node tools/acceptance.mjs
node tools/check-external-store.mjs --data-root ... --persona ...
node tools/external-store-smoke.mjs          # 外部 store 端到端（零网络，4/4）
```

当前：selftest **111/111**；自动跟随实机按点；外部最小库实测 PASS；外部 store 冒烟 **4/4**。

### 5.2 硬认领（0.2.7 起 · P4 #10）

`jianmuProcess` 服务新增（工具面不变）：

- `claimHardPreviewState({from,to,chunkIds})`：只读，返回 `stateRows / duplicatesTouched / pendingTouched / backupEstBytes`；
- `claimHardMoveState({from,to,chunkIds,confirm:true,tag?})`：只搬 latest-wins 的当前 state 行；
  `duplicates/pending` 引用被搬块的行追加 `status=stale`（不逐行改）；写前整文件备份；
- `claimHardRebuild({from,to})`：搬完对两边尽力 `rebuildProcess`（0 LLM；用户态存在时如实拒绝）；
- `claimHardRollbackState({backupDir})`：按 `process-journal.json` 整文件恢复（目标原先不存在则删回）。

> 注意：`state.jsonl` 是派生状态；本层不搬原文、不动 `scopes/`。

---

## 发布相关（2026-11 发布准备）

- **本层出网**：**不会**。默认零 LLM、零网络、零嵌入；只做规则整理（读根藏 `scopes/`，写自己的 `process/`）。
- **安装**：写进 profile 的 `dsh.profile.bundles` 才会加载（只装不激活）；卸载**不删** `process/` 任何数据。
- **回滚**：改 profile 前先备份 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`（带时间戳 + sha256 前后对照）；状态坏了可 `jianmu_process_rebuild`（0 LLM）。
- 完整四份文档（《隐私与外部请求》《安装矩阵》《回滚手册》《支持版本》）随发布件提供；仓库内见 `docs/`。
