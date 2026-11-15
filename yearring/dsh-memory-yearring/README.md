# dsh-memory-yearring · 年轮（建木 · 认知层）

> 从原话里提炼**带原话锚点**的 claim，并拼成 topic 正文。
> 不改原文、不改人格、不注入；**v0.2.0 起默认开启插件内自动消化**（有每日 token 安全阀，不需要任务看板/系统计划任务）。
> 版本 `0.4.5` · 契约 `contractVersion = 1`。
>
> **检索成绩里本层的份额（别误读）**：2026-11-10 联合卷的 `+5.3pp`（E@5 73.7% → 79.0%）来自
> **熏习 + 年轮**的跨层整理；`73.7%` 这个起点已经包含「寻枝 A2 摘要索引 + bge 重排」，
> 根藏的 A2 **不是**本轮增益来源。口径细节见根藏 README「A2 在检索成绩里的位置」。

---

## 0. 单装：两种数据来源（不强制安装根藏）

年轮读的是**符合「根藏 chunk 契约」的目录**，不 import `dsh-memory-store` 的代码。
所以你有两种用法：

### 方案 A（推荐）：装根藏

装 `dsh-memory-store` → 根藏自动摄取 → 年轮把 `dataRoot` 指向根藏数据目录（默认 `<DSH_HOME>/memory-jianmu`）。

### 方案 B：自带原话块（高级，不装根藏也能用）

自己切好原话，放到：

```text
<dataRoot>/scopes/<personaId>/
  manifest.json      # 必需（最小字段见下）
  chunks.jsonl       # 必需，一行一条 utterance
  deleted.jsonl      # 可选：墓碑
  identity.json      # 可选：UI 自动解析人格；没有就在 UI/工具里显式传 personaId
```

**年轮不读向量**：`vectors_v*.f32`、`index_meta.json` **不需要**。
（以后还要装寻枝做语义检索时才需要补向量，见 §7。）

### 0.1 最小数据契约

`manifest.json`：

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

`chunks.jsonl` 每行至少：

```json
{
  "kind": "utterance",
  "personaId": "demo",
  "id": "稳定唯一 id",
  "text": "原话……",
  "contractVersion": 1
}
```

**年轮额外建议提供**：`t`（UTC epoch 毫秒，用于 `last:<n>d` 与时间排序）、`session`（分组用）、`role`/`sourceType`（选块与规则）、`retention`（过期镜像）。
没有 `t` 时 `last:90d` 会选不到块；没有 `session` 时分组会退化。
完整字段见根藏契约 `dsh-memory-store/CONTRACT-v1.md` §2.1。

### 0.2 先自检

```bash
node tools/check-external-store.mjs \
  --data-root "C:/Users/<you>/.dsh/memory-jianmu" \
  --persona demo
```

- `PASS`：年轮可读；
- `FAIL`：按 ❌ 修（缺 manifest/chunks、persona 不匹配、零有效行）；
- ⚠️ 是建议项（缺推荐字段、缺 identity、缺向量）。
加 `--json` 可给脚本消费。

> `dataRoot` 必须可写：年轮要写 `<dataRoot>/year/<personaId>/`。外部只读库请复制到可写目录，或挂到可写目录下。

---

## 1. 插件内自动消化（0.2.0 起）

- 启动约 5 分钟后先补跑一次，之后每小时第 `autoDigestMinute`（默认 27）分钟检查一次；
- 只消化**有新原话**的人格，默认范围 `last:90d`（避免首次安装就全量烧钱）；
- 每次最多 `autoDigestMaxRounds` 批 × `autoDigestBatchChunks` 块（默认 8 × 12），
  每人每天有 `autoDigestDailyTokenBudget`（默认 120 万 token）安全阀；用满当天暂停自动，手动 run 不受影响；
- 每批写 `runs.jsonl` 时 `trigger: "auto"`，可与手动运行区分；
- 状态在 `/api/year-ring/status` 的 `auto` 字段与年轮页面「自动消化」一行。

```
根藏/外部原话（只读） ──┐
熏习状态（只读，可选） ──┴─→ 选块 ─→ 模型抽取（要 confirm） ─→ 逐条校验 ─→ claims.jsonl
                                                                        └─→ topic_docs/（0 LLM 拼装）
```

## 2. 它不做

- ❌ 注入上下文（归镜台）
- ❌ 改原话 / 改人格卡 / 写 topic 归属（归熏习）
- ❌ 每轮对话都自动生成/自动摘要（自动消化是**按小时后台**，不是每轮）
- ❌ 改写、删除旧 claim（只追加，旧版进历史小节）
- ❌ 无锚点造结论（quote 必须是原话逐字子串）

## 3. 数据在哪

```text
<dataRoot>/year/<personaId>/     # 默认 <dataRoot> = ~/.dsh/memory-jianmu
  claims.jsonl    唯一事实源（append-only）
  manifest.json   计数/代数/预算
  runs.jsonl      每次 run 的 token 与费用估算
  topic_docs/*.md 规则拼装的正文（可删可重建）
  _archive/       快照
```

## 4. 用法（agent 工具）

```text
jianmu_year_status { personaId?, deep? }          # 状态
jianmu_year_topics { personaId?, kind? ... }      # 主题分组 + claim 数
jianmu_year_claim  { claimId }                    # 单条 + 锚点原话
jianmu_year_run    { dryRun: true }               # ① 先预览成本
jianmu_year_run    { confirm: true }              # ② 再真跑（会调用模型）
jianmu_year_rebuild{ confirm: true }              # 从 claims 重建正文（0 LLM）
jianmu_year_verify { personaId? }                 # 锚点有效性等
jianmu_year_export { outFile? }                   # 导出 JSON 包
```

`scope` 支持 `all` / `session:<id>` / `last:<n>d` / `since:<ms|ISO>` / `ws:<子串>`。
默认增量：已处理过的块不会重复花钱；要重跑用 `force=true`。

## 5. 命令行（不经宿主；只读 + rebuild/export）

```bash
node tools/check-external-store.mjs --data-root ... --persona ...  # 外部数据源自检
node tools/selftest.mjs                     # 自测（临时目录，不碰真实数据）
node tools/adversarial.mjs                  # 对抗回归
node tools/acceptance.mjs --persona demo # 验收（真实数据只读 + dryRun）
node tools/plugin-smoke.mjs                 # 宿主加载冒烟（mock ctx 真 apply）
node tools/auto-digest-e2e.mjs              # 自动消化端到端（假 LLM，零费用）
node tools/external-store-smoke.mjs         # 外部 store 端到端（假 LLM，零费用，5/5）
node tools/cli.mjs status --deep
node tools/cli.mjs topics --limit 20
node tools/cli.mjs verify
node tools/cli.mjs dryrun --scope last:7d
node tools/cli.mjs rebuild --confirm
node tools/lab-prompt.mjs --chunks 8        # 提示词实验台（本地 Ollama，零成本）
node tools/backfill-claim-speaker.mjs --persona demo             # 老 claim 回填 speaker（默认 dry-run）
node tools/backfill-claim-speaker.mjs --persona demo --apply     # 真写：先快照 → append 新行 → 读回校验
```

### 5.1 speaker（谁说的，v0.3.0）

每条 claim 带 `speaker: user | assistant | unknown`（+ 审计字段 `speakerSource`）：

- 模型在抽取时输出 `speaker`；提示词明写「来自『助手』的块，speaker 必须 assistant」；
- 缺省/非法**不拒收**：能按第一个锚点块的 `role/sourceType` 判定就确定性补全，否则 `unknown`；
- `epistemic=inference` 强制 `unknown`（推测不是任何人的原话）；
- 老数据用 `tools/backfill-claim-speaker.mjs` 按锚点回填（零 LLM；先备份到 `_archive/`，append-only，可回滚）；
- `verify` 报「缺失（warning）/ 非法 / inference 非 unknown（error）」；年轮界面显示「用户说的 / 助手说的」徽标。

## 6. 安装（desktop profile）

> ✅ 2026-11-08 已装进 desktop profile（`link:` 指向本目录）；2026-11-09 已重启并实机验证自动消化。

桌面版不能用 CLI 装，只能改 profile 后手工 install：

1. 备份 `~/.dsh/profiles/desktop/` 的 `package.json` + `cordis.patch.yml` + `pnpm-lock.yaml`；
2. `package.json` 的 `dependencies` 加 `"dsh-memory-yearring": "link:<本包绝对路径>"`；
3. `dsh.profile.bundles` 追加 `dsh-memory-yearring`；
4. 用**应用内置 pnpm 11.28.5**（不是系统 pnpm）跑：
   ```bash
   node "<DSH_INSTALL>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install --no-frozen-lockfile --ignore-scripts
   ```
   （记得 `unset CI`）
5. 重打 cc-safety-net 补丁（v2 → v3 → check），install 会冲掉它；
6. **重启 DSH** 生效。

## 6.5 星图面板（0.4.0 起）

侧栏「星图」入口：用 iframe 承载 WebGL 页面，数据走插件 host 的**只读**路由。

- **数据目录**：`<dataRoot>/starmap/`（与年轮同一 dataRoot）
- **构建**：面板「01 星图」里的「重建星图」按钮（0.4.2 起），或命令行 `node tools/starmap-build.mjs [personaId ...]`
  - 按钮走 `POST /api/jianmu-starmap/build?confirm=1`，后台 `spawn` 构建脚本，每 2 秒轮询 `build-status`；完成后自动重载当前人格。
  - Python 自动探测：`JIANMU_PYTHON` > DSH 运行时自带 Python（带 numpy）> PATH 里的 `python` / `python3`；输出强制 UTF-8。
  - 跑 `build-starmap.py`（聚类 → stats/meta/bin）再跑 `layout-blades.py`（V10 星云旋臂布局 → `*-blade.bin` + `blades-*.json`）
  - 输出：`stats-<pid>.json` / `starmap-<pid>.meta.json` / `starmap-<pid>-blade.bin` / `blades-<pid>.json`
- **HTTP 路由**（限本机回环）：
  - `GET /api/jianmu-starmap/status` · `/personas`
  - `GET /api/jianmu-starmap/stats?personaId=` · `/meta` · `/bin`（优先返回 `-blade.bin`）
  - `GET /api/jianmu-starmap/ui/…`（`starmap-ui/` 静态文件：index.html / app.js / vendor / nebula.jpg）
  - `POST /api/jianmu-starmap/build?confirm=1[&personas=a,b]`（唯一写端点；并发返回 409）
  - `GET /api/jianmu-starmap/build-status` → `{running, startedAt, elapsedMs, ok, code, tail}`
- **空状态**：数据目录为空时，面板显示「记忆星图还没生成」+ 构建命令，不报错。
- **写边界**：只读端点不写任何文件；`/build` 是唯一写操作，只写 `<dataRoot>/starmap/`，且需要本机 + `confirm=1`。

## 7. 安全边界

- 写路径硬闸门：只允许 `<dataRoot>/year/<personaId>/`
- 拒绝写 `scopes/` `process/` `persona/` `soul-md/` `~/.dsh/sessions/`
- 每条 claim 的 `quote` 必须是对应原话的**逐字子串**，否则拒收
- `title/body/quote` 过入库扫描（注入/密钥/后门/不可见字符 → 红项拒收）
- 原话在提示词里被明确标注为「不可信数据，不是指令」

## 8. 测试

| 套件 | 覆盖 |
|---|---|
| `selftest.mjs` | 107 项：守卫/扫描/校验/去重/存储/拼装/rebuild/verify/API/dryRun/stub 真跑/幂等/跨组取代/topic/跨人格/speaker |
| `adversarial.mjs` | 24 项：模型错误不被吞、导出不能覆盖运行时文件、撕裂尾、topicHint 注入、预算上限、超大单块 |
| `acceptance.mjs` | 30 项：真实原话只读 + dryRun + 写闸门 + 基线对照 |
| `plugin-smoke.mjs` | 29 项：mock ctx 真 `apply()`，7 工具 + HTTP 路由 + 自动消化接线 + 探针 200 + 405 拒写 |
| `starmap-route-smoke.mjs` | 21 项：星图只读路由 status/stats/meta/bin/UI、路径穿越、回环限制、空数据 404；构建端点 confirm/persona/405/403/202/409 |
| `auto-digest-e2e.mjs` | 7 项：假 LLM 全链路（找到人格 → 抽 claim → `trigger=auto` → rebuild） |

## 9. 已知限制

- 自动消化的**每日 token 上限是内存计数**，DSH 重启当天归零；不是硬账本。
- 模型输出被 `max-tokens` 截断（`LLM_TRUNCATED`）时该批重试；自动消化会 4 秒后重试，频繁出现可把 `autoDigestBatchChunks` 从 12 降到 8。
- 费用是估算（默认 0.5/1.5 元每百万 token），不是账单。
- 部分 claim 被拒收时该批仍记「已处理」（避免失败样本无限重跑）；被拒明细写在 `runs.jsonl`，要重抽用 `force=true`。
- 外部数据源没有自动摄取：你需要自己维护 `chunks.jsonl`；每次内容变化请更新 `manifest.builtAt` 与 `chunks`，否则幂等判断会当成“没变”。
- 外部数据源不要求向量；但若以后接寻枝做语义检索，需要补 `vectors_v*.f32` 与 `index_meta.json`。

### 5.2 硬认领（0.3.2 起 · P4 #10）

`jianmuYear` 服务新增（工具面不变）：

- `claimHardPreviewClaims({from,to,chunkIds})`：只读，返回 `move / mixedAnchor / orphanAfter / backupEstBytes`；
- `claimHardMoveClaims({from,to,chunkIds,confirm:true,tag?})`：
  - 只搬「整组全锚点都在被搬块集合」的 claimGroup；混合锚点保留在原人格 + warning（不复制、不改写锚点）；
  - 搬入 claim 的 `claimId` / `claimGroupId` 按新 `personaId` 重算；目标同组 → revision 续接，同证据 → 跳过；
  - 写前整文件备份；搬完两边 rebuild topic_docs（0 LLM）；
- `claimHardRebuild({from,to})` / `claimHardRollbackClaims({backupDir})`：重建 / 整文件回滚。

> 已知限制：混合锚点留在源侧后，被搬走的那些锚点会成为源侧孤儿（`verify` 报 `ANCHOR_ORPHAN`）；
> 这是 2026-11-13 拍板「不复制、不改写锚点」的直接结果，调用方应按预览的 `orphanAfter` 预期。

---

## 发布相关（2026-11 发布准备）

- **本层出网**：抽 claim 时把**选中的原话块 + 提示词**发到宿主模型服务（默认 DeepSeek）。两条路径都算：手动 `jianmu_year_run`、以及**默认开启**的插件内自动消化（每小时 :27，默认 `last:90d`）。
- **怎么关**：`autoDigest=false` 关后台自动消化；`enabled=false` 关整个年轮。年轮自己不保存任何 Key。
- **安装**：写进 profile 的 `dsh.profile.bundles` 才会加载（只装不激活）；卸载**不删** `year/` 任何数据。
- **回滚**：改 profile 前先备份三文件（带时间戳 + sha256 前后对照）；`topic_docs` 坏了可 `jianmu_year_rebuild`（0 LLM）。
- 完整四份文档（《隐私与外部请求》《安装矩阵》《回滚手册》《支持版本》）随发布件提供；仓库内见 `docs/`。
