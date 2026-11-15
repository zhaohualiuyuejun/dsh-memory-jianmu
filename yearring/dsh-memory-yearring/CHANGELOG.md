# CHANGELOG

## 0.4.5 — 2026-11-15

修复：归档目录 archiveDir 读不到（1.0.2 里「配了也不生效」）：
- 根因：年轮 `inject` 只有 `tools`，`ctx.settings` 为 undefined，设置行/profile 覆盖全部读不到；
- 修法：`inject` 加 `settings`（并保留 `ctx.get('settings')` 兜底）；
- 设置行解析改为「条目 id + 包名」双匹配；只合并设置层明确写过的字段，不再整体回退默认；
- 新增三层解析：设置行 → describe() 全行扫描 → 直接读 profile patch（兜底）；
- `status.config` 现在直接显示 `archiveDir`，便于用户自检。
- 实测：C 盘 `_archive` 3 份 → 归档 3、保留 2、C 盘清零；H 盘出现 2 份。

## 0.4.4 — 2026-11-15

星图可重建 + 快照不再无限增长：
- **修复「重建星图」必失败**：`build-starmap.py` / `layout-blades.py` 默认人格不再回退测试夹具 `alice/bob`，
  改为扫描 `year/*/claims.jsonl`（布局扫 `stats-*.json`）自动发现；面板按钮改为显式传 personas；
  `starmap-ui/app.js` 去掉 alice 特判；缺 claims 时给中文提示而不是英文栈；
- 新增设置 `archiveDir`：`rebuildTopicDocs` 成功后 `settleTopicSnapshots()` 只保留最近 2 份时间戳快照；
  配了归档 → 搬到 `<archiveDir>/year/<pid>/_archive/`；没配 → 清理更旧的；
  `hard-claim-*` / `lock-stale-*` 不参与清理；
- 修复 `normalizeConfig` 把字符串 `archiveDir` 当数字丢弃的问题；
- 本机实收：`year` 1,018MB → 25MB（165 份小时快照搬到 H 盘，未删除）；
- 背景：`rebuildTopicDocs` 每小时镜像整份 topic_docs，旧快照只建不删。

> **2026-11-15 发布前修正（同版本重打，代码有变）**：星图空态新增「重建星图」按钮（空态即可构建，轮询进度）；失败时把 numpy / 找不到 Python 翻成中文。；文档：去掉指向内部施工计划的悬空提及（公开集不含研发计划）

## 0.4.3 — 2026-11-14

年轮「主题」侧栏加分组口径说明（纯文案 + 一条提示，不改分类逻辑、不动数据）：
- 侧栏标题下方新增一行：**「与星图同源：同一份 claim。分类不同：这里是关键词分组，星图的『旋臂』是语义聚类，所以数量不一样。」**
- 标题加 `title` 悬浮说明，讲清「19 组 vs 25 臂」是归类方式不同，不是数据不一致。
- 背景：年轮用 `lib/topicgroups.mjs` 的关键词规则把 `topicHint` 归成 18+「其他」=19 组；
  星图用 claim 向量 k-means 聚成 25 臂（Bob 13）。用户 11-14 看到数字对不上，决定**不改分类、只加说明**。

## 0.4.2 — 2026-11-14

星图收尾三项：构建自动化（A1）、iframe↔宿主通信（A2）、原型归档（A3）。

- **重建星图按钮**（A1）：面板「01 星图」新增「重建星图」。`POST /api/jianmu-starmap/build?confirm=1` → 202，后台 `spawn` 构建脚本；`GET /api/jianmu-starmap/build-status` 每 2 秒轮询 `{running, startedAt, elapsedMs, ok, code, tail}`；完成后自动重载当前人格并刷新统计。
  - 安全：只接受本机回环（非本机 403）；必须 `confirm=1`（缺失 400）；并发返回 **409** + 当前状态；`personas` 白名单 `[A-Za-z0-9_-]{1,64}`、最多 16 个；不经过 shell；只写 `<dataRoot>/starmap`；插件卸载时结束子进程。
  - 日志：stdout/stderr 收进 8KB 环形缓冲，失败时把尾部几行显示到面板，不静默。
  - Python 探测：`JIANMU_PYTHON` > DSH 运行时自带 Python（带 numpy）> PATH 的 `python`/`python3`；强制 `PYTHONIOENCODING=utf-8`（否则 Windows 下日志尾是 GBK 乱码）。
  - 进面板时若已有构建在跑，会接上进度；若读到构建中的半成品，等构建结束再加载，不当成故障。
- **iframe ↔ 宿主 postMessage**（A2）：iframe 切人格后回写宿主 `localStorage['jianmu.starmap.personaId']`，切走侧栏再回来人格保持；卡片新增「在年轮打开」——年轮页目前没有「按 claimId 选中」的入口，因此只复制 claimId 并在宿主弹 toast 提示去「年轮」搜索框粘贴，不硬造 URL。
- **原型归档**（A3）：`jianmu/star-map/`（V1–V10 独立静态原型）在 README 与文件头标为已归档、停止同步；现役以 `starmap-ui/` 为准；已确认无运行代码引用。
- 测试：`starmap-route-smoke` 11 → **21 项**（新增构建端点 confirm / persona / 405 / 403 / 202 / 409 / 路径穿造型 persona）；真跑全量构建 alice 6,429 / bob 1,637，用时 7 秒。

## 0.4.1 — 2026-11-14

记忆星图定版（V20–V22）+ 数据更新：
- 背景：三条交叉银河带 + 双层星云壳（第二层加色、朝向垂直）+ 34 远景云 + 第二条粒子银河带；相机转一圈都有星云底，不再出现纯黑角度。
- 取景：按视口 `fitDistance` 自适应（树占约七成高）；最大缩放收紧；窗口/全屏尺寸变化自动重新取景。
- 全屏：顶栏「全屏」按钮；原生 Fullscreen → 同源 iframe 铺满 → 宿主 postMessage 三条路，Esc 退出；全屏时两侧面板垂直居中。
- UI：暖灰调降亮约 20–25%、字重细一档、bloom/曝光下调，更 AR；远景星 1 万颗 + 最小像素保底（`minSize`）；树干约 1.7 倍粗；旋臂放大 1.2 倍（`ARM_SCALE`）。
- 俯视：盘子目标投影半径 0.26→0.33，直径约屏高 78%。
- 数据：重建 alice **6,429** / bob **1,637**，缺失向量 0（补嵌 295 条新 claim）。
- 新增调试参数 `?az=`、`?fs=`；`starmap-ui/.npmignore` 排除贴图备份，包体不夹带开发快照。

## 0.4.0 — 2026-11-13

记忆星图（V10 星云旋臂）接进 DSH：
- 侧栏新增「星图」入口 + 主视图；iframe 承载 `starmap-ui/`（three.js 全内置，运行期零 CDN）。
- host 新增只读路由 `/api/jianmu-starmap/*`：status/personas、stats、meta、bin（优先 `-blade.bin`）、`ui/` 静态文件；本机回环限制 + 路径穿越拦截。
- 新增 `tools/starmap-build.mjs` + `tools/starmap/*.py`：从年轮 claim 生成 `<dataRoot>/starmap/`（聚类 → V10 旋臂布局）；支持 `JIANMU_PYTHON` / `JIANMU_DATA_ROOT` / `JIANMU_STARMAP_OUT`。
- 空状态：没有星图数据时面板提示构建命令，不报错。
- 新增 `tools/starmap-route-smoke.mjs`（11 项）；`client-smoke` 增加「星图侧栏始终注册」断言。
- 星图数据只读；面板不改年轮/根藏/熏习。

## 0.3.2 — 2026-11-13

P4 #10 · 硬认领（年轮侧）：claim 按锚点随块搬迁：
- 新增 `lib/hardclaim.mjs`：`previewMoveClaims` / `moveClaims` / `rebuildAfterMove` / `rollbackMoveClaims`。
  - 只搬「整组全锚点都在 S」的 claimGroup；混合锚点按拍板保留在原人格 + warning（不复制、不改写锚点）；
  - 搬入 claim 的 `claimId` / `claimGroupId` 按新 personaId 重算；
  - 目标已有同组 → revision 续接；同 `derivedFromHash` → 跳过重复；
  - 搬完两边 rebuild topic_docs（0 LLM）；回滚整文件恢复 claims/manifest/topic_docs。
- `jianmuYear` 服务新增 `claimHardPreviewClaims` / `claimHardMoveClaims` / `claimHardRebuild` / `claimHardRollbackClaims`（工具面不变）。

