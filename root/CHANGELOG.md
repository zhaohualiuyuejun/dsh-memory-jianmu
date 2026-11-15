# CHANGELOG

> **2026-11-15 发布前修正（同版本重打，代码有变）**：`tools/ingest-hourly.mjs` 尊重 `DSH_HOME`（不再写死 `~/.dsh`），读不到寻枝配置时给中文下一步。；文档：去掉指向内部施工计划的悬空提及（公开集不含研发计划）

## 0.2.7 — 2026-11-14

#13 · `defaultPersonaId` 强提示（发布前小修，不动数据、不改写路径）：
- `statusAll`：`identity.defaultPersonaId` 非空时，往 `warnings` 追加一条明确告警——
  「默认人格已启用：所有未映射的工作区/会话都会被归到它（串味源）。建议置空，改用工作区/会话绑定」。
  由于 `degraded = !identityState.ok || warnings.length > 0`，这条会同时把状态卡标成需要关注。
- UI：告警框不再只看 `degraded`，改为**只要 `warnings` 非空就原样展示**；
  以前 `degraded` 为假时任何 warning 都会被吞掉，这条提示永远看不见。
- 实跑核验：临时根写 `defaultPersonaId: "alice"` → 告警出现；改回 `null` → 告警消失（`_tmp/b4check/run.mjs`）。
- 自测：`tools/selftest.mjs` **77/77**。

## 0.2.6 — 2026-11-13

发布准备 · 根藏精简 UI（B 方案）+ 设置写路径定案：
- 新增 `client.js`：侧边栏「根藏」面板（`sidebar.panellist` id `jianmu-store` + `main` key `jianmu-store`）。
  - 状态卡：数据目录 / 总块数 / 未归属 / 磁盘余量 / 上次与下次自动摄取 / 嵌入是否已配置；
  - 人格 scope 表：块数、向量缺失与坏行、会话/工作区数、时间范围、降级标记；
  - 设置：`autoIngest` 开关、`embeddingApiBase`、`embeddingApiKey`（**只写不读**）、测试连接。
- 新增 host HTTP 路由 `/api/memory-store`（`kind: prefix`，经 `ctx.inject(['webServer'])` 挂载）：
  - `GET /status`：与 `jianmu_store_status` 同口径（复用 `statusAll`），附 `autoIngest` + `settings`；
  - `GET /settings`：只回白名单字段 + `embeddingApiKey.configured`，**永不回 Key 明文**；
  - `POST /settings`：`confirm:true` + `expectedRevision`（CAS）；写成功立刻重排自动摄取定时器；
  - `POST /test-embedding`：一次最小 embeddings 调用（15s 超时），不落盘、不打日志明文、不回 Key。
- 新增 `lib/httpapi.mjs`：写请求闸门（JSON + `x-dsh-jianmu: 1` + 同源）、设置白名单校验、测试连接实现。
- **设置写入走 `ctx.settings.update(ns, patch, expectedRevision)`**（0.2.6 spike 结论）：
  - 落地 = `configEditor.edit()` 就地改 profile 的 `cordis.patch.yml`，注释与排版保留；
  - volatile 字段热生效，不要求重启；**不新增 `ui-settings.json` 第二层配置**。
  - 证据：`dsh-settings/lib/index.js#update`、`dsh-config-editor/lib/index.js#edit`；
    本机产物 = profile patch 里 `ui-chat.transcriptView`（该字段在 `ui-chat` 的 Config 里是 `.volatile()`）。
- 修正：`liveCfg()` 改用 `ctx.get('settings', false)`（本插件没有 inject `settings`，原写法在拿不到服务时会静默退化成启动值）；
  `dataRoot()` 改读 `liveCfg()`，`ensureStore()` 在路径变化时重开库。
- 新增 `tools/httpapi-selftest.mjs`：闸门 / 白名单 / 不回显 Key / 测试连接（假 fetch）用例。
- **实机 GUI 验收后修的三处显示缺陷**（2026-11-13 16:10，见 `docs/生产GUI验收-2026-11-13.md`）：
  1. 页面不可滚动：「保存 / 测试连接」被裁在窗口外 → `.jm-page` 补 `width/height:100% + overflow-y:auto`，内容移入 `.jm-wrap`（与熏习/镜台同一容器口径）；
  2. 人格表「会话/工作区」显示 `—`：`workspaces` 在 `statusAll` 里是**数字**不是数组，改两种都认；
  3. 人格表「时间范围」显示原始毫秒：新增 `fmtDay()` 格式化为 `YYYY-MM-DD`。
  另：开关滑块补对比度（灰底白钮 → 品牌色底白钮 + 阴影），开/关两态一眼可辨。
- 仍不做：导入向导、scope 管理、批量删除、跨人格操作。UI 不写任何记忆数据。

## 0.2.5 — 2026-11-13

P4 #10 · 硬认领（unassigned → 目标人格，真搬 chunks + vectors）：
- 新增 `lib/hardclaim.mjs`：`selectChunks` / `previewHardClaim` / `applyHardClaim` / `rollbackHardClaimRoot`。
  - 只做 `persona_unassigned → 已声明人格`；工作区精确前缀 / 会话 id 二选一；命中 0 条直接拒绝；
  - 双 scope 锁按目录字典序获取；目标 generation 不匹配 → `STALE_GENERATION`；锁占用 → `LOCK_BUSY`（一字不动）；
  - 先 T0 全量快照（from/to scope + identity）→ T2 写目标并 verify → T3 重写源并 verify；
    任一失败用快照整文件回滚；总块数守恒断言；
  - 向量按「保留索引重建」（不用字节裁剪）；搬入块 `personaId`/`identitySource` 改写并留 `provenance.hardClaimFrom`；
  - 源侧追加墓碑（`hard-claim-to:<pid>`），读边界不再复活；
  - 目标已有同 id 块 → 不重复追加，但仍从源移除（去重口径）。
- `jianmuStore` 服务新增 `claimHardPreview` / `claimHardApply` / `claimHardRollback` / `claimHardVerify`（工具面仍 7 件）。
- `lib/vectors.mjs`：0 行向量文件的 `normalized` 视为 true（空 scope 不再误报 `VECTOR_NOT_NORMALIZED`）。

## 0.2.4 — 2026-11-12

P4 #5 · identity 受控写（产品体验修复：建卡后不再「没记忆」）：
- 新增 `lib/identity-admin.mjs`：`identityAddPersona` / `identityRemoveMappings` / `identitySummary`。
  - 默认只预览；`dryRun=false + confirm=true` 才写；写前备份到 `<dataRoot>/_archive/identity-<ts>-<rand>.json`；
  - 幂等（无变化不写、不占备份）；写后读回，不一致还原备份；identity 损坏/非法直接拒绝（不覆盖）；
  - **只增不删**：工作区/会话已属于别的人格默认跳过，要改归属需显式 `allowReassign=true`；
  - 返回值带 `skipped[]`（`{kind,key,owner}`），镜台据此报 `WORKSPACE_TAKEN` 而不是误当 noop；
  - 「停记」只摘指向该人格的映射，**不删任何记忆**；不提供「彻底删除」。
- 新增工具 `jianmu_store_identity_add_persona`（工具面 6 → 7 件）。
- 新增 host 服务 `jianmuStore`（`identityAddPersona` / `identityRemoveMappings` / `identitySummary`）：
  镜台「一键注册 / 停记」经 `ctx.get('jianmuStore')` 调用，不直接写 identity.json。
- 自测：更新工具面断言 + 新增 identity-admin 用例（预览/幂等/备份/回收/损坏拒绝/只摘自己的映射）。

## 0.2.2 — 2026-11-12

新增：
- **A2 自动摘要挂载**：自动摄取写入新块之后，后台给「缺摘要的长块」生成摘要并按
  「摘要 + 原文」增量重嵌，用户无感。实现在 `lib/auto-summary.mjs`，
  复用 `tools/summarize-reembed.mjs`（未重写）。
  - 新配置（**默认关**，不改现有行为）：`autoSummaryIndex=false` /
    `summaryModel=qwen3:8b` / `summaryBase=http://127.0.0.1:11434` / `summaryMinChars=80`。
  - 只处理本轮 `written>0` 且 `manifest.embeddingMeta.summaryMode==='concat'` 的人格；
    没做过 A2 的库不擅自改造。
  - detached 子进程 + `windowsHide`：不阻塞摄取、不弹控制台；失败只记日志，不影响摄取。
  - 单飞锁 `<dataRoot>/.locks/auto-summary-<pid>.lock`（30 分钟陈旧），
    子进程退出自行删锁（token 校验）。
  - 先探活 Ollama：不可达就跳过本轮（避免「只重嵌、没摘要」白花嵌入费）。
  - 没有待摘要长块时直接跳过（避免每小时无意义重写整个向量文件）。
  - 事件日志 `<dataRoot>/_logs/auto-summary.jsonl`，子进程输出
    `<dataRoot>/_logs/auto-summary-<pid>.out.log`。
- `jianmu_store_status` 的 `autoIngest` 里新增 `autoSummary` 子字段（开关/模型/最近结果）。
- 自测：68/68（新增 2 项：判定/计数/容错、调度/单飞锁/陈旧锁/Ollama 不可达）。

修复：
- 补上共享抽取库 `dsh-jianmu-utterance-core@0.1.0` 的依赖声明，并以
  `bundledDependencies` 随包内置 —— 此前干净安装会因 `ERR_MODULE_NOT_FOUND` 直接加载失败
  （2026-11-12 干净安装测试 T2 发现；桌面 profile 因源码目录解析碰巧可用）。

## 0.2.1 — 2026-11-11

新增：
- `tools/summarize-reembed.mjs`：**摘要索引（A2）原地构建/增量刷新**。
  给 ≥80 字的长块生成一句检索摘要，写回 chunk 的 `summary` 字段（原文不动），
  按「摘要 + 原文」重嵌向量，并在 `manifest.embeddingMeta.summaryMode = concat` 标记口径。
  支持导入已有摘要文件（`--summaries`），首次全量后增量只嵌新增/变化块；
  写前自动备份 chunks/vectors/manifest，失败不落半成品。

说明：
- 这是「一个根藏 + 一个索引口径」的实现，不再需要派生根藏目录。
- 寻枝无需改动：它按 `manifest.embeddingMeta` 自证口径，直接读取即可。
