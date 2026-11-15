# CHANGELOG

> **2026-11-15 发布前修正（同版本重打，代码有变）**：「记忆库」在缺 `identity.json` 时不再红屏「读取失败」，改为中文指路（去人格卡一键登记 → 重试）。；文档：去掉指向内部施工计划的悬空提及（公开集不含研发计划）

## 0.2.7 — 2026-11-13

P4 #10 · 硬认领（熏习侧）：state 行随块搬迁：
- 新增 `lib/hardclaim.mjs`：`previewMoveState` / `moveState` / `rebuildAfterMove` / `rollbackMoveState`。
  - 只搬 latest-wins 的当前 state 行；`scope` 改写为目标人格；源侧删行、写前整文件备份；
  - `duplicates` / `pending` 引用被搬块的行**不逐行改**，追加 `status=stale` 最新行（旧候选自然隐藏）；
  - 搬完对两边尽力 `rebuildProcess`（0 LLM）；用户态存在时如实返回 `REBUILD_USER_STATE_PRESENT`，不静默丢用户决定；
  - manifest counts 重算；回滚按 journal 整文件恢复（目标 scope 原先不存在则删回）。
- `jianmuProcess` 服务新增 `claimHardPreviewState` / `claimHardMoveState` / `claimHardRebuild` / `claimHardRollbackState`（工具面不变）。

## 0.2.6 — 2026-11-13

UI 版本号统一（只改显示与文案，不改数据/规则/工具面）：
- 「记忆库」与「原话看板」顶栏改为 `v0.2.6 · 只读`，跟随 `package.json`，不再写死 `v1a 只读`。
- 模块说明里的「v1a 不接管注入」改为「注入由镜台接管」（v2 早已接管，旧文案过期）。
- 新增发布检查：`client.js` 的 `PLUGIN_VERSION` 必须与 `package.json` 一致（脚本核对）。

## 0.2.5 — 2026-11-12

P4 配套（只读、追加字段）：
- `lib/lifecycle.mjs` 新增 `scopes[]`：每个 scope 的 `personaId / displayName / chunks / hasCard / inIdentity`
  （按 chunks 倒序）。镜台删卡弹窗用它显示「记忆 N 条仍保留」，根藏注册引导也用它。
- `lifecycle.unassigned` 增加软认领口径：`pureChunks / claimedChunks`，`byWorkspace[].claimedBy`；
  `summary` 增加 `unassignedPure / unassignedClaimed`，`healthy` 只看纯未归属（软认领过的块可检索，不算不健康）。
- 记忆库「人格归属」卡显示「其中 N 条已软认领（可检索）」。
- 不改任何既有字段的语义；不写任何数据。
- 自测：`tools/selftest.mjs` 112/112、`tools/lifecycle-selftest.mjs` 12/12。

## 0.2.3 — 2026-11-12

P2.5 冲突卡（默认关、纯只读，配合镜台 `conflictCard`）：
- 新增 `lib/conflictcards.mjs`：从 `process/<pid>/conflicts.jsonl` 取 `status=open`，
  按 `updatedAt` 倒序，用根藏 `chunks` 拼 A/B 两说；各截 ≤120 字（带「…」）。
- 新增 host 服务 `jianmuConflicts.list({ personaId?, workspace?, limit? })`：
  只读、绝不抛；缺块 / 跨人格 / 非 open / 空文本 → 整卡跳过；未归属桶不渲染。
- chunk 表按 `mtime+size` 缓存（LRU 2），避免每回合整文件 parse 拖慢注入。
- 不写 conflicts 状态、不做自动裁决、不注册 HTTP 写路由。
- 测试：`tools/conflictcards-selftest.mjs` 22/22；`tools/selftest.mjs` 112/112（新增 I16b）。
- 版本：`lib/version.mjs` 补上 0.2.x 的落后版本号（此前仍是 0.2.0）。

## 0.2.2 — 2026-11-12

界面（D 档：透明化，不碰数据）：
- 顶部徽标「只读」→「**自动维护**」，副标题改为「自动维护，只读查看」——与真实能力一致。
- 「待处理」页：**移除所有写按钮**（应用/驳回/建去重候选）。写动作仍只由 agent 走工具 + confirm
  完成，界面不再提供，避免用户误以为能随意改记忆。
- 新增「**知道了**」：纯前端 localStorage 收起，不调用任何写接口、不写任何文件、
  不改变记忆与检索；可「显示已看过」找回。
- 文案说明：重复组由检索层独立折叠，**不依赖本页操作**；本页只读。
- 「主题归属」从「待 v1b」改为「**系统维护**（正文归年轮）」；模块能力里
  「主题写动作 / 动作 API」改为「按设计不提供 / 仅供 agent」。

## 0.2.1 — 2026-11-12

修复：
- 补上共享抽取库 `dsh-jianmu-utterance-core@0.1.0` 的依赖声明，并以
  `bundledDependencies` 随包内置 —— 此前干净安装会因 `ERR_MODULE_NOT_FOUND` 直接加载失败。
  （2026-11-12 干净安装测试 T2 发现；桌面 profile 因源码目录解析碰巧可用。）
