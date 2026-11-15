# 镜台 · `dsh-memory-persona` v0.3.7

> 建木 · 人格层。**人格卡与「注入设置」的唯一写者**；v2 起可选接管人格/记忆两段注入（`injectEnabled`，**默认关**；打开后接管，与 soul-md 同时开 = 双注入）。
> 契约：`CONTRACT-v1.md`（本包唯一规格来源）。
>
> **0.3.6（2026-11-13）**：新增工具 `jianmu_persona_claim_hard`（硬认领：unassigned → 指定人格，连向量/熏习 state/年轮 claim 一起搬，可预览/备份/回滚）；
> 0.3.5 起 UI 版本号跟随包版本，不再显示 v1a/v1a.1/v2 这类里程碑号。

---

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 人格卡：创建 / 编辑 / 删除 / 默认 / 工作区绑定 / 会话覆盖 | 改根藏 `chunks` / `vectors` / `manifest` / `identity` |
| 版本链 / diff / 回滚 / 备份 | 改熏习的 `state` / `topics` / `pending` |
| AI 生成人设（一句种子 → 整卡**草稿** → 人工保存） | 自动保存 AI 结果 / 自动演化人格 |
| 注入设置：展示 soul-md 现在注入什么、多少、为什么没注入 | **默认不接管注入**（`injectEnabled=false`，仍由 soul-md 执行）；打开 `injectEnabled` 后才接管 |
| 只读 API + UI 壳（照 soul-md 设置页） | 写 soul-md 的 `cordis.patch.yml` / settings |
| 跨 persona 隔离 | 跨人格共享 / 合并 |

**唯一可写区 = `<dataRoot>/persona/`**。`lib/paths.mjs#assertPersonaWritable` 拒绝写 `scopes/`、`process/`、`sessions/`、`<DSH_HOME>/soul-md/` 以及 persona 之外的任何路径。

---

## 安装

> 本包随《建木》发布件提供（`dsh-memory-persona-0.3.7.tgz`）。推荐用发布件里的 `安装建木.bat` / `install-jianmu.mjs` 一次装五包；也可按下述步骤手工安装。

步骤：

1. `plugin_manager install_bundle` 指向 tarball（或解包后的绝对路径）。
2. 把包名加入 desktop profile 的 `dsh.profile.bundles`（只装不写 bundles 不会加载）。
3. 重启 DSH（清旧 HTTP 路由）。
4. 若本机启用了 `cc-safety-net` 之类的补丁，重启后按需 repatch（非本包必需）。
5. 验证：
   - `plugin_manager list_plugins` 里出现 `memory-persona`
   - `curl` 同源 fetch `/api/persona/status`（GUI 内）
   - 侧栏出现「人格卡」；记忆库出现「人格卡」tab
6. 首次导入：`jianmu_persona_import`（或 `node tools/cli.mjs import --yes`）。

回滚：卸载包即回到「无镜台」；删掉 `<dataRoot>/persona/` 不影响根藏/熏习；soul-md 全程不动。

---

## 数据布局

```
<dataRoot>/persona/
  manifest.json                 # 全局 generation / 契约版本
  registry.json                 # 默认卡 / 工作区 / 会话 / 注入设置镜像
  cards/<cardId>/
    card.md                     # 唯一真源（front-matter + 正文）
    manifest.json               # zones / zoneHashes / version / source
    versions.jsonl              # 追加，latest-wins
    _archive/
      import-<ts>/              # 从 soul-md 导入的原文快照
      revision-<n>-<ts>/        # 每个 revision 的 card.md + .fingerprint.json
  _imports/soul-md-<ts>/        # cards.json + config.json + source.json + registry-before.json（不复制整份 profile）
  _deleted/<ts>-<id>/<id>/      # 删除的卡（整目录移入，不物理删）
  .lock                         # 全局单写者锁
```

- 卡片 `cardId = personaId = memoryScope`（v1a 一卡一人格）。
- 分区固定：`identity` / `redline` / `behavior` / `style`；**身份/红线只读**（保存时 hash 变化 → `IMMUTABLE_SECTION_CHANGED`）。
- 导入保留原文逐字（`zones` 存字符偏移，不重写正文）。
- 所有写：**锁 → 校验 generation → 备份 → 原子写 → 版本追加 → 读回**。

---

## 工具面（18 件，冻结）

| 工具 | 作用 |
|---|---|
| `jianmu_persona_status` | 卡数/版本/锁/generation/错误；`deep=true` 完整性检查 |
| `jianmu_persona_list` | 卡片列表 |
| `jianmu_persona_card` | 读卡（分区 + hash） |
| `jianmu_persona_versions` | 版本列表 |
| `jianmu_persona_diff` | 两版行级 diff |
| `jianmu_persona_create` | 新建卡（`confirm`） |
| `jianmu_persona_save` | 保存（`expectedGeneration` + `confirm`；备份/版本+1/读回） |
| `jianmu_persona_delete` | 删除（进 `_deleted/`，不物理删；默认卡不能删） |
| `jianmu_persona_set_default` | 设默认卡（`none` = 全局关） |
| `jianmu_persona_bind` | 工作区/会话 → 卡（或 `none`） |
| `jianmu_persona_rollback` | 回滚到 revision（写成新版本） |
| `jianmu_persona_import` | 从 soul-md 导入（不覆盖已有卡） |
| `jianmu_persona_expand` | **AI 生成人设（一句种子 → 整卡草稿；不保存）** |
| `jianmu_persona_preview` | 注入预览（字符/token/截断原因；不触发注入） |
| `jianmu_persona_settings` | 注入设置：不传 patch = 读有效值；传 patch = 写 `registry.settings`（需 generation + confirm） |
| `jianmu_persona_memory_list` | 列建木记忆主题（不读正文） |
| `jianmu_persona_memory_read` | 读某 topic 正文（core 只能手工维护） |
| `jianmu_persona_memory_append` | 追加写 topic（先扫描红项；core 禁写） |

禁止：`recall/search/query` 工具名、注入钩子、写 soul-md、每轮调模型、自动保存 AI 结果。

### AI 生成（`jianmu_persona_expand`）

- **一次显式调用**：种子 → 整卡草稿；结果只返回，不落盘。
- 模型路由：`expandProvider/expandModel` 配置 → 当前会话 `modelSelection` → 模型目录默认。
- 预算：输入 ≤ 8000 字符、输出 ≤ 8000 token、超时 60s、最多 1 次重试。
- 扫描：注入/凭据/后门/不可见字符；**红项 → 拒绝返回草稿**（编辑框不动）。
- 老卡：system 要求保留身份/红线；生成后校验，改了会标 `protectedChanged`，保存时需 `allowProtectedSectionsChange=true + confirm`。

---

## P2 自动召回（v0.3.0，默认关）

每用户回合按闸门决定是否去**寻枝**预取旧记忆，命中才在「记忆段」末尾附 ≤320 字：

| 闸门 | 判据 |
|---|---|
| G0 | 用户原话命中线索词（上次/之前/记得/那个…）或句尾问号；闲聊直接跳过，零成本 |
| G1 | 拿到命中后看查询与原文的词面重合；无重合则要求分数高出阈值 0.08（防纯语义漂移） |
| G2 | 寻枝 `jianmuRecall.prefetch`：一次查询嵌入 + 余弦 topN，死线 800ms，超时即弃 |

- 注入格式带 `dateText` 与「用户/助手」，末尾写明「无关请忽略，不要主动提起」。
- **首步时序**：实测 `user/message → request/header` 只隔 4ms，纯异步拿不到；因此 `system-prompt/assemble` 前最多等 `autoRecallWaitMs`（默认 800，0=不等）。
- 配置：`jianmu_persona_settings` 写 `autoRecall / autoRecallMinScore / autoRecallTopN / autoRecallMaxChars / autoRecallDeadlineMs / autoRecallWaitMs / autoRecallCooldownMs / autoRecallCues / autoRecallLabOnly / autoRecallLabWorkspaces`。
- 观测：`<dataRoot>/persona/_logs/auto-recall.jsonl`（只有元数据，绝不写正文/query）。
- 回滚：`autoRecall=false`；没装寻枝时自动退化为「no-service」，不阻塞对话。

---

## P2.5 冲突卡（v0.3.1，默认关、只读）

有**未裁决冲突**时，在「记忆段」末尾附一张 A/B 两说卡（只提示，不替用户裁决）：

```text
【未裁决的两种说法（只提示，不替你做结论）】
- ⚠️ 2026-06-10 10:00:00 · 用户：生日是三月五号。（A）
- ⚠️ 2026-06-12 11:00:00 · 助手：用户的生日是四月八号。（B）
（以上是两种说法并存，请勿把其中一条当成定论。）
```

- 数据源：熏习服务 `jianmuConflicts.list`（只读 open 冲突 + 根藏原文）；没装熏习就静默跳过。
- 纪律：默认 `conflictCard=false`；每回合最多注入一次；≤2 张、总预算 ≤300 字、单边 ≤120 字；
  **放不下整卡就跳过，绝不截半卡**；同内容 10 分钟内不重复。
- 与自动召回共用 G0 线索词闸门，但开关独立（可以只开冲突卡）。
- 观测：`<dataRoot>/persona/_logs/conflict-card.jsonl`（`{t,sid,n,chars,conflictIds}`，无正文）。
- 回滚：`conflictCard=false` 一个开关；关掉时注入与之前逐字一致。
- 测试：`tools/conflictcard-selftest.mjs` 31/31、`tools/conflictcard-e2e.mjs` 12/12（真加载熏习+镜台）。

---

## P4 人格注册层（v0.3.3，产品体验）

**解决「建了卡却没记忆」**：镜台建卡只写第 1 份映射（工作区→卡），根藏 `identity.json`
（工作区→personaId）过去只有一次性 CLI 会写，于是新工作区的原话全进 `persona_unassigned`。

- **一键登记**：卡片页对「未注册」的卡显示提示条 + 按钮；点一下调 `POST /api/persona/register`，
  镜台把卡名/绑定的工作区/会话交给根藏服务 `ctx.get('jianmuStore').identityAddPersona`（**根藏是唯一写者**，镜台不直接写文件）。
  显示名/工作区来自卡与 registry，用户不用手拼 JSON。
- **写纪律**（根藏侧）：默认预览；`dryRun=false + confirm=true` 才写；备份到 `<dataRoot>/_archive/`；
  幂等；写后读回；identity 损坏拒绝覆盖；**只增不删**（工作区已属于别人默认跳过，`allowReassign` 才改）。
- **删卡三选项**（`POST /delete` 带 `mode`）：
  | 选项 | 行为 | 数据 |
  |---|---|---|
  | 保留记忆（默认，`mode=archive`） | 卡归档到 `_deleted/`，identity 不动 | 记忆保留；新对话仍记进该人格（只是无人格注入） |
  | 停记（`mode=stop`） | 先摘 identity 里指向该人格的工作区/会话映射，再归档卡 | **记忆保留**；新对话不再归到它；重新登记可恢复 |
  | 彻底删除 | **本轮不提供**（破坏性；需单独工具 + 预览 N 条原话/M 条 claim + 二次确认） | —— |
- 删卡弹窗用熏习 `/lifecycle` 的 `scopes[]` 显示「该人格已有 N 条原话」，先讲代价再让用户选。
- **未归属块认领**（P4 #8/#9）：卡片页顶部显示「有 N 条未归属原话」+ 按工作区分组；
  选一张卡点「归到当前卡」→ `POST /api/persona/claim-workspace`：
  1. 根藏 `identityAddPersona` 补身份映射（核心；不搬数据）；
  2. 镜台 `bindCard` 把该工作区绑到这张卡（注入层，失败不算认领失败）。
  3. 寻枝 `softClaim`（默认开）把未归属桶里这些工作区的旧块**影子纳入**检索；移除映射即回退。
  已在 identity 里属于别人的人格 → `409 WORKSPACE_TAKEN`，绝不静默改归属。
- 观测/诊断：`GET /api/memory-process/lifecycle` 的 `cardlessPersonas / unregisteredCards / unassigned / scopes`；
  `unassigned` 区分 `pureChunks`（真正没人检索得到）与 `claimedChunks`（已软认领，可检索）。
- 回滚：登记只改 identity 映射（有备份）；停记可用同一按钮重新登记恢复；卡归档可从 `persona/_deleted/` 找回。

---

## 只读 API（GET）+ 写动作（POST）

`GET /api/persona/{status,cards,card,versions,diff,registry,settings,preview,import-sources}`

`POST /api/persona/{create,save,delete,default,bind,rollback,expand,register,claim-workspace}`（v1a.1；`/delete` 支持 `mode=archive|stop`）

- **v1a.1**：UI 写动作已接线（编辑全文保存 / 回滚 / 删除 / 默认卡 / 工作区与会话绑定 / AI 生成草稿）。
- POST 安全：只接受 `content-type: application/json` + 自定义头 `x-dsh-persona: 1` + 同源 Origin；写动作服务端强制 `confirm:true`；不新增 CORS 头。
- `POST /expand` 只返回草稿，不写盘（AI 生成仍是显式单次动作）。

---

## UI

- 独立侧栏入口「人格卡」（`sidebar.panellist` id `jianmu-persona`）+ 主面板 `main` key `jianmu-persona`。
- 记忆库壳新增「人格卡」tab（**仅在镜台已装、`/api/persona/status` 可用时出现**），点击切到人格卡主面板。
- 页面：卡片 / 默认与绑定 / 注入设置（只读）/ 版本历史 / 注入预览。
- 复用 `--dsw-alias-*` token 与 `jm-*` 命名空间。

---

## 自测与验收

```bash
cd path/to/jianmu/persona/dsh-memory-persona
node tools/selftest.mjs                 # 205/205（临时夹具，不碰生产）
node tools/acceptance.mjs               # 真实 profile 配置 + 生产根藏只读副本
node tools/plugin-smoke.mjs             # 99/99（假 ctx 装配 + GET/POST 路由 + 写动作端到端）
node tools/client-smoke.mjs             # 假 window/react 装配 + 写动作接线
node tools/autorecall-selftest.mjs      # 37/37（P2 闸门/预算/状态机，零 API）
node tools/autorecall-e2e.mjs           # 14/14（P2 假宿主全链路，零 API）
node tools/cli.mjs status --deep        # 生产只读排查
```

自测覆盖：卡片解析/分区/模板、扫描、路径闸门、布局/导入、保存/版本/保护、并发/原子写、CRUD/绑定/删除、解析优先级、AI 生成、只读 API、工具面守卫、根藏/熏习零写入。

验收覆盖：真实 soul-md 配置导入（分区 hash 与源一致）、保存/diff/保护/回滚、只读 API/预览/设置、生产根藏/熏习/soul-md 记忆前后 hash 一致、二次导入幂等。

---

## 已知限制（v1a.1）

1. **新建卡没有 UI**：`POST /create` 与 `jianmu_persona_create` 可用，但卡片页暂无「新建卡」面板。
2. **AI 按钮是显式单次动作**：不自动保存、不自动演化、不每轮调用；首次点击前先确认「文本会发到模型服务端 + 可能产生费用」。
3. **默认不接管注入**：`injectEnabled=false` 时不注册注入段，注入仍由 soul-md 执行，镜台的 `/settings` 与 `/preview` 是只读镜像；在设置里打开会在当场补注册——**别和 soul-md 同时开**（会双注入）。
4. **新建卡不自动设默认**；默认卡不能删。
5. **persona 未在 `identity.json` 注册时仍可建卡**，但会返回警告（无记忆 scope）。
6. **删除用 rename**；跨卷/占用时退化为复制并明确报 `PARTIAL_WRITE`（原目录保留）。
7. **真实浏览器 UI**：侧栏入口已在 DSH 0.2.2-rc.3 隔离实例里确认渲染（2026-11-14/15）；像素级样式与各面板内容仍以实机为准。

---

## 证据

- 契约：`CONTRACT-v1.md`
- 计划：研发计划不随公开集发布；对外规格以 `CONTRACT-v1.md` 与本 README 为准
- 施工报告：`../../docs/镜台-v1a-施工报告-2026-11-07.md`（收尾时生成）
- 自测/验收日志：`../../docs/镜台-selftest-2026-11-07.log`、`../../docs/镜台-acceptance-2026-11-07.log`

## 硬认领（0.3.6 起 · P4 #10）

工具 `jianmu_persona_claim_hard`（工具面 18 → 19 件）：

```jsonc
{
  "from": "persona_unassigned",     // 只能是 unassigned
  "to": "tester",                   // 必须在 identity.personas 已声明
  "workspace": "H:/work/lab", // 与 sessionIds 二选一
  "dryRun": true,                   // 默认 true = 只预览
  "confirm": true,                  // dryRun:false 时必填
  "expectedGeneration": 1,          // 目标 scope 已存在时必填（并发闸门）
  "rollbackBackup": "…/journal.json" // 回滚模式：传了就只回滚
}
```

- 预览汇总三层数字：根藏块/向量/重复、熏习 state 行、年轮 claims（move / mixedAnchor / orphanAfter）、备份估算；
- 应用顺序：根藏（chunks+vectors）→ 熏习（state）→ 年轮（claims）→ identity 补登记；
  任一层失败按「年轮 → 熏习 → 根藏」整文件回滚；
- 顶层 journal：`<dataRoot>/persona/hard-claim/<tag>/journal.json`（记录三层备份路径与每阶段结果）；
- 终验：根藏两边、熏习两边、年轮两边；混合锚点的预期孤儿（预览的 `orphanAfter`）不算失败；
- 三层服务缺任一 → `SERVICE_UNAVAILABLE`（不半搬）。

---

## 发布相关（2026-11 发布准备）

- **本层出网**：只有两处——①「AI 生成人设」点一次发一次（种子/编辑框文本发到 `expandProvider`/`expandModel` → 当前会话模型）；② P2 自动召回（**默认关**）会经寻枝做一次查询嵌入。其余全部本地读写。
- **怎么关**：不点「AI 生成人设」；`autoRecall=false`（默认就是关）；`conflictCard=false`（默认关，且本来不出网）。
- **安装**：写进 profile 的 `dsh.profile.bundles` 才会加载（只装不激活）；卸载**不删** `persona/` 任何数据（`_deleted/` 也保留）。
- **回滚**：改 profile 前先备份三文件（带时间戳 + sha256 前后对照）；卡片有版本快照，可用 `jianmu_persona_rollback` 回滚到某一版；硬认领有 `rollbackBackup` journal。
- 完整四份文档（《隐私与外部请求》《安装矩阵》《回滚手册》《支持版本》）随发布件提供；仓库内见 `docs/`。
