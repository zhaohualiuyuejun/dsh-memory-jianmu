# CHANGELOG

## 0.4.6 — 2026-11-15

claim 向量缓存桶不再无限增长：
- 新增设置 `claimVecArchiveDir`：`ensureClaimVectors` 写新桶后，自动清理「全部 key 都被新桶覆盖」的旧桶
  （配了归档 → 搬到归档目录；没配 → 删除）；含未被覆盖 key 的桶保留，不会误删；
- 导出 `pruneRedundantClaimVecs()` 供维护脚本复用；
- 背景：缓存桶按 claimId 集合哈希命名，集合一变就写整桶；本机曾累积 11 桶 / 574MB。
- 注：设置页暂无该字段输入框（走 profile 配置）；默认行为（清理旧桶）保证不无限增长。

> **2026-11-15 发布前修正（同版本重打，代码有变）**：README：调试命令分清「发布件自带」与「仅源码仓库」——发布件只带 `tools/verify-0.4.0.mjs`。

## 0.4.5 — 2026-11-13

UI 版本号统一（只改显示，不改检索/索引行为）：
- 设置页「状态」卡新增「插件版本」，显示 `v0.4.5`；`client.js` 内置 `PLUGIN_VERSION`，
  发布检查强制它与 `package.json` 一致。
- 同时更新跨包版本对应表（熏习 0.2.6 / 年轮 0.3.1 / 镜台 0.3.5）。

## 0.4.4 — 2026-11-13

新增（P4 #11 `sourcesFromIdentity`，默认关）：
- **sources 从根藏 identity 派生**：`identity.json` 已是「工作区 → 人格」的真源，
  不必再手填第三份映射。开时 = 手填源优先 + identity 补缺：
  - 同 personaId 的手填源**直接补工作区**，id 不变（自带索引/根藏路由行为不变）；
  - 只有全新人格才新建 `persona:<pid>` 源；`name` 取 displayName；
  - 手填与 identity 冲突 → **保留手填** + `warnings[]`（不静默改）；
  - identity 缺失/坏 JSON/为空 → 原样回退手填源（行为与开关关逐字一致）。
- `session_recall_config`：新增 `sourcesFromIdentity` 可写；读/写返回 `sourcesPreview`
  （manual / effective / derived / warnings / identity 状态），先看再开。
- 设置页 `/state` 的 `config` 同步带 `sourcesPreview`；开关变更按「源归属变化」触发重建判定。

修复（P4 #9 软认领的边界）：
- **新人格还没有自己的 scope 时**（`persona_missing` / `root_missing`），软认领原先直接返回失败，
  旧块搜不到——这正是「建卡没记忆」最典型的现场。现在用空壳 base 走同一套软认领，
  拿不到旧块仍原样返回失败（不改变旧行为）。
- `applySoftClaim` 在 base 为空时用未归属桶的维度分配向量（行对齐不变）。

测试：`tools/identitysources-selftest.mjs` **22/22**；`service-smoke` **13/13**（新增 C1–C5）；
`tools/lab-smoke-p4-9.mjs` **26/26**（真模块 + 真文件 + 真 /claim-workspace，含新人格空 scope 场景）。

## 0.4.3 — 2026-11-12

新增（P4 #9 软认领，配合人格注册层）：
- **软认领**：`identity.json.workspaces` 已把某工作区归给某人格、但历史块仍留在
  `persona_unassigned` 时，检索会把它们**影子纳入**该人格的 loaded 索引。
  - 只读、零迁移、零重嵌；移除 identity 映射即回退；`softClaim=false` 一键关闭。
  - 只纳入 ws 命中（含子路径）的块，且要求块 `personaId` 为空或 `persona_unassigned`（防串味）。
  - 合并后向量行对齐保持；缓存键含 identity + 未归属库的 mtime/size。
  - `persona_unassigned` 仍不能作为检索路由目标（只有内部 `allowUnassigned` 可读）。
- 配置：新增 `softClaim`（默认 true）；`rootStatus` / 设置页 / 服务返回带 softClaim 统计。
- 测试：`tools/softclaim-selftest.mjs` **15/15**（纳入/子路径/开关/守卫/缓存失效/向量对齐）。

## 0.4.2 — 2026-11-12

新增（配合镜台 P2 自动召回，全部只读、零写入）：
- **服务 `jianmuRecall`**：`ctx.provide` 出来的预取接口
  `prefetch({query, agent, deadlineMs, minScore, topN})`；路由与 `session_recall` 同口径
  （源隔离 / allowFromWorkspaces），只读根藏 + 一次查询嵌入，超时即放弃，失败不抛。
- **`lib/prefetch.mjs`**：轻量召回管线（根藏 → 嵌入 → 余弦 topN），不做 claim/rerank/hygiene；
  查询向量缓存（LRU 64 / 10 分钟）。
- **根藏索引只读缓存**：`loadRootIndex` 按 mtime+size 缓存（LRU 2），
  实测冷读 110ms → 热读 1ms（8338 块 / 4096 维 / 130MB 向量）。

测试：`tools/prefetch-selftest.mjs` 18/18、`tools/service-smoke.mjs` 8/8（零 API）。

## 0.4.1 — 2026-11-12

修复：
- `webServer` 从硬依赖改为**可选**：headless / tui 等没有 Web 服务的宿主里，
  寻枝此前一直 `pending` 不挂载（工具全部不可用）。现在只在 `webServer` 就绪时挂
  设置页接口（`/api/session-recall`），工具本身始终可用。
  （2026-11-12 干净安装测试 T2 发现。）

## 0.4.0 — 2026-11-11

新增（全部默认关闭，可在设置页「检索增强」或 config.json 开启）：
- **混合打分 `hybrid`**：0.7·余弦 + 0.3·归一化 BM25，零额外请求（实测 +17.7pp）。
- **bge 重排 `rerank`**：前 N 名调 /v1/rerank；失败自动降级原序；实测 +4.0pp。
- **年轮 claim `claims`**：只读根藏 year/，锚点展开 + 语义桥 + RRF；向量按 claim 增量缓存。
- **熏习去重 `hygiene`**：重复组折叠 / stale 过滤 / 冲突降权；dup@5 10%→0。

修复：
- `mapRootChunk` 补 `chunkId`（此前与熏习/年轮数据无法对齐）。
- 折叠时机改为「重排之后」，避免非代表块被聚合层压下去。

工具：
- 说明：A2 摘要索引已改为**根藏本体能力**（dsh-memory-store 0.2.1 的 tools/summarize-reembed.mjs），寻枝不再提供派生根藏工具。
- `tools/verify-0.4.0.mjs`：新增能力随包自检（24/24）。
