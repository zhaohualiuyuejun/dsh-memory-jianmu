# 根藏 · dsh-memory-store

> 建木记忆层的**存储层**：把「谁、在什么时候、说了什么」原话摄取、落盘、可重建。
> 不检索、不注入、不判断谁取代谁。版本 `0.2.8` · 契约 `contractVersion = 1`。

## UI：侧边栏「根藏」（0.2.6 起）

装好本插件（profile `dsh.profile.bundles` 里列出 `dsh-memory-store`）重启后，侧边栏出现「根藏」：

- **状态卡**：数据目录、总块数、未归属块、磁盘余量、上次/下次自动摄取、嵌入服务是否已配置；
- **人格 scope 表**：块数、向量缺失与坏行、会话/工作区数、时间范围、降级标记；
- **设置**：`autoIngest` 开关、`embeddingApiBase`、`embeddingApiKey`（只写不读）、**归档目录 `archiveDir`**、**测试连接**；
- 数字口径与工具 `jianmu_store_status` 完全一致（UI 与工具调用同一个 `statusAll`）。

HTTP 面（同源、只读为主）：`GET /api/memory-store/status`、`GET /api/memory-store/settings`、
`POST /api/memory-store/settings`、`POST /api/memory-store/test-embedding`。
写动作三条闸门：`content-type: application/json` + 自定义头 `x-dsh-jianmu: 1` + 同源；服务端强制 `confirm: true`。

**UI 不写记忆数据**：它只读状态、只改插件设置。首次导入让 Agent 调 `jianmu_store_ingest`
（`from=sessions`，会写一次完整快照）；之后自动摄取按小时增量（`tools/ingest-hourly.mjs` 是已有 scope 的运维增量，不是首次导入）；
不做导入向导 / scope 管理 / 批量删除 / 跨人格操作。

### 设置写到哪（0.2.6 spike 结论，2026-11-13）

**写 `ctx.settings.update(ns, patch, expectedRevision)`——即 profile 的 `cordis.patch.yml`；不做第二层配置文件。**

| 问题 | 结论 | 证据 |
|---|---|---|
| 会不会落盘 | 会 | `@deepseek-ai/dsh-settings/lib/index.js#update` → `configEditor.edit()` → `writeFileAtomic(profile.patchPath)` |
| 会不会毁掉注释/排版 | 不会 | `@deepseek-ai/dsh-config-editor/lib/index.js#edit` 用 `yaml.parseDocument` 就地 `setIn` 只改目标 `config` 节点 |
| 本机真发生过吗 | 发生过 | 生产 patch 里 `ui-chat.transcriptView: verbose`；`transcriptView` 在 `ui-chat` 的 Config 里是 `.volatile()`（默认 `detailed`） |
| 要重启吗 | 不用 | volatile 字段热重载；`describe().user` 即时反映写入，`liveCfg()` 读的就是它 |

读设置时**只回 `configured: true/false`**，任何响应与日志都不出现 Key 明文。
并发保护：`POST /settings` 必须带 `expectedRevision`（来自 `GET /settings`）；不匹配 → `409 STALE_SETTINGS`。
宿主没有可写的设置服务时，UI 降级为**只显示**并提示手工改 `cordis.patch.yml`（不假装保存成功）。


## 插件内自动摄取（0.2.0 起）

- 默认 **每小时第 7 分钟**（`:07`）增量摄取一次；DSH 启动 60 秒后先补跑一次。
- 流水线：抽取 → 折叠记录类型 → 校验 → 去重 → **先嵌向量后写**（不会写半截向量）。
- **不 spawn、不弹控制台黑框**；旧的 Windows 计划任务 `JianmuRootIngest` 已由它取代。
- 设置页可开关与改间隔：`autoIngest` / `autoIngestIntervalMinutes` / `autoIngestMinute`。
- 嵌入密钥：`embeddingApiKey` / `embeddingApiBase`（留空回退读寻枝的 `~/.dsh/session-recall/config.json`）。
- 运行状态看 `jianmu_store_status` 的 `autoIngest` 字段（上次结果 / 下次时间 / 本次写入）。

## A2 自动摘要（0.2.2 起，默认关）

- 打开后：每次自动摄取写入新块，后台给**缺摘要的长块**（默认 ≥80 字）生成一句摘要，
  写回 `chunk.summary`（原文不动），并按「摘要 + 原文」**增量重嵌**；
  `manifest.embeddingMeta.summaryMode = concat` 随之后端可验证。
- 只对**已经是 concat 口径**的库生效（没做过 A2 的库不擅自改造）；只处理本轮真有新块的人格。
- 不阻塞摄取：detached 子进程 + `windowsHide`，失败只记日志；单飞锁
  `<dataRoot>/.locks/auto-summary-<pid>.lock`；Ollama 不可达或没有待摘要块时直接跳过。
- 配置：`autoSummaryIndex`（开关，默认 `false`）/ `summaryModel`（`qwen3:8b`）/
  `summaryBase`（`http://127.0.0.1:11434`）/ `summaryMinChars`（`80`）。
- 日志：`<dataRoot>/_logs/auto-summary.jsonl`（事件）、`auto-summary-<pid>.out.log`（子进程输出）。
- 首次全量仍建议先手动跑一次 `tools/summarize-reembed.mjs`（自动挂载只做增量）。

### A2 在检索成绩里的位置（别误读）

- **A2 是检索基线的一部分，不是「熏习 + 年轮」那 +5.3pp 的来源**：
  2026-11-10 联合卷的起点是 **寻枝 A2 摘要索引 + bge 重排 = 73.7% E@5**，
  叠加熏习 + 年轮后才到 **79.0%**（内部计划原话：「基线已锁定：寻枝 A2+R(bge) = 73.7% E@5；不要改寻枝」；
  该计划属研发资料，不随公开集发布）。
- 单看 A2 摘要索引本身的离线收益：H 67.3 → 70.7、R 71.7 → 73.7（其余 9 种变体都没超过 73.7）。
- **口径边界**：bench 里的 A2 索引由离线脚本（`bench-jianmu/index-summary/`）建；
  插件内 A2 是**同口径**（长块摘要 + 原文 concat、同一嵌入模型 / 4096 维、`summaryMode=concat`）
  但**不是同一份数据**，产品化后**没有单独重跑**那套 79% 评测。
  对外只能说「机制在位、口径一致」，不能说「产品版 A2 已验证达到 73.7%」。


## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 原话（utterance）的唯一真源 | 检索器（那是**寻枝**） |
| 按 `personaId` 物理隔离的人格库 | 注入层（那是**镜台**） |
| 只追加、可重建（`chunks.jsonl` → 向量/索引） | 去重/时效/取代判断（那是**熏习**） |
| 0 token 固定注入、0 次额外 LLM 调用 | 摘要/结论提炼（那是**年轮**） |

## 数据布局

```
<dataRoot>/                      # 默认 <DSH_HOME>/memory-jianmu（数据与代码分离）
  identity.json                  # 人格解析层维护；根藏只读
  _logs/                         # 自动摄取的运行锁 / 状态 / 日志（0.2.0 起）
  scopes/<personaId>/
    manifest.json                # 自证 provider/model/dim/normalizerVersion
    chunks.jsonl                 # 唯一真源，只追加
    vectors_v1.f32               # 派生，行序与 chunks 严格一致
    index_meta.json              # 指向当前向量文件 + 缺失/坏行
    deleted.jsonl  cost.jsonl    # 侧表（墓碑 / 成本）
    .lock  _archive/
```

## 工具面（恰好七件）

- `jianmu_store_ingest` — `from=sessions|utterances|legacy`
- `jianmu_store_status` — 块数/人格/未归属/向量缺失/错误/磁盘
- `jianmu_store_rebuild` — 从 `chunks.jsonl` 重建索引，**0 次嵌入**
- `jianmu_store_export` — 导出某人格 `chunks.jsonl`
- `jianmu_store_forget` — 显式忘记：写墓碑，读边界立刻消失（不物理删）
- `jianmu_store_revive` — 撤销忘记（追加 revive 行）
- `jianmu_store_identity_add_persona` — 登记人格/工作区映射（默认只预览；备份 + 幂等 + 只增不删）

**没有** `recall/search/query`：检索归寻枝。**没有**注入钩子：注入归镜台。

### host 服务 `jianmuStore`（0.2.4 起）

根藏是 `identity.json` 唯一写者；镜台的一键注册经 `ctx.get('jianmuStore')` 调用，不直接写文件。

- `identityAddPersona({ personaId, displayName, workspaces, sessions, allowReassign, dryRun, confirm })`
- `identityRemoveMappings({ personaId, workspaces, sessions, dryRun, confirm })` —— 「停记」：只摘映射，**不删任何记忆**
- `identitySummary()` —— 只读摘要

写纪律：默认预览；confirm 才写；先备份到 `<dataRoot>/_archive/`；写后读回；幂等；损坏的 identity 拒绝覆盖。

## 命令行（施工/运维）

```bash
node tools/cli.mjs sources                       # 看旧寻枝库的源映射（只读）
node tools/cli.mjs init-identity --data-root ... # 生成 v1 identity.json
node tools/cli.mjs migrate --out <dir>           # 旧库 → 根藏（默认写 _dryrun）
node tools/cli.mjs status --data-root <dir> --deep
node tools/cli.mjs export --data-root <dir> --persona demo --out x.jsonl
node tools/cli.mjs verify --data-root <dir>
node tools/cli.mjs rebuild --data-root <dir> --persona demo
```

## 自测 / 验收

```bash
node tools/selftest.mjs          # 68 项：落盘/锁/identity/chunks/vectors/store/迁移/摄取/守卫/A2 自动摘要/插件面
node tools/verify-morning.mjs    # 上午四条收工判据（含旧库零改动、回退演练）
```

## 安装（DSH）

包自带 `cordis.patch.yml`（`id: memory-store`）。两级开关分开：
- `autoIngest`（默认 **开**）：插件内定时增量摄取（`:07`，不弹窗）。
- `ingestEnabled`（默认 **关**）：只控制 `jianmu_store_ingest from=sessions` 这个**工具入口**，
  关着时需要显式传 `force=true`；它不影响后台定时摄取。

## 纪律（摘要）

1. 写入顺序：`chunks.jsonl` → 向量 → `manifest/index_meta`。
2. 原子写（tmp→fsync→rename）；失败绝不回报 ok；tmp 用 `wx` 独占、带 pid+随机段。
3. 写后读回三态：found / missing / unknown；unknown 不算成功。
4. `contractVersion` 不兼容 → 拒绝写。
5. `scopeId = personaId`；未归属 fail-closed；不跨人格读写合并。
6. 绝不写 `~/.dsh/sessions/`（只读源）。
7. 初始化失败进降级，构造函数永不抛；降级原因进 `status`。

完整规则见 [CONTRACT-v1.md](CONTRACT-v1.md)。

## 已知限制（v1 骨架）

- `turn`（轮次）字段已预留，迁移旧库时为 `null`（旧库没有该字段）。
- `identity.json` 的 `workspaces` 键 v1 沿用旧库 `wsPretty`（见契约 §3.3）。
- A2 自动摘要只做**增量**；首次全量 / 换嵌入模型仍需手动跑 `tools/summarize-reembed.mjs`。
- 每次增量更新会重写整个向量文件（单个大库约 129MB）；实测小时级可接受，分块追加留待后续优化。
- A2 写前快照在 `<scope>/.backup/a2-<ts>/`，**只保留最近 2 份**（`JIANMU_A2_BACKUP_KEEP` 可调）；成功写盘后更旧的快照会被清理，否则小时级重嵌会把 C 盘吃出数 GB。

## 硬认领（0.2.5 起 · P4 #10）

把 `persona_unassigned` 里指定「工作区 / 会话」的原话块**真搬到**目标人格（连同向量），可预览、备份、回滚、验证。

- **只做** `persona_unassigned → 已在 identity.personas 声明的人格`；不做人格→人格；不重嵌、不自动触发。
- 工具面不变（仍 7 件）；能力经 host 服务 `jianmuStore` 暴露：
  - `claimHardPreview({from,to,workspace|sessionIds,includeIds?})` —— 只读，返回块/向量/重复/备份估算；
  - `claimHardApply({from,to,workspace|sessionIds,expectedGeneration,confirm:true,stampTag?})` —— 真搬；先目标后源，每步 verify；
  - `claimHardRollback({backupDir,expectHashes:true})` —— 用快照整文件恢复源/目标 + identity；
  - `claimHardVerify({from,to,allowMissingTarget?})` —— 只读校验。
- 备份：`<dataRoot>/_archive/hard-claim-<tag>/`（含 `root-journal.json` 与逐文件 sha256）；
- 闸门：双 scope 锁（字典序）、`expectedGeneration`、向量行对齐、总块数守恒、源侧墓碑。
- 典型调用顺序由镜台 `jianmu_persona_claim_hard` 串起；单独调用本层服务时请自行保证 process/year 层同步。

---

## 发布相关（2026-11 发布准备）

- **本层出网**：自动摄取时把**新摄取的原话块**发到 `embeddingApiBase`（OpenAI 兼容 `/v1/embeddings`）；A2 摘要只走**本机 Ollama**（`127.0.0.1:11434`）；除此之外不发任何请求。
- **怎么关**：`autoIngest=false`（最稳）。只清空 `embeddingApiKey` **不够**——留空会回退读寻枝的 `~/.dsh/session-recall/config.json`。
- **密钥**：`embeddingApiKey` 在 profile 的 `cordis.patch.yml`（0.2.6 起经宿主设置服务就地写入）；读接口只回 `configured: true/false`，日志与响应都不出现明文。
- **安装**：写进 profile 的 `dsh.profile.bundles` 才会加载（只装不激活）；卸载**不删** `<dataRoot>/` 任何数据。
- **回滚**：改 profile 前先备份 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml`（带时间戳 + sha256 前后对照）。
- 完整四份文档（《隐私与外部请求》《安装矩阵》《回滚手册》《支持版本》）随发布件提供；仓库内见 `docs/`。
