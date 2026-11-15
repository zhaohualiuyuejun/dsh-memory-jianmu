> **包内副本**：以 `C:\work\alice\jianmu\persona\CONTRACT-v1.md` 为准；本副本随 npm 包分发，便于安装后查阅。

# 建木 · 人格层「镜台」契约 v1（2026-11-07 冻结）

> 状态：**v1a 冻结（2026-11-07）**。本文是 `dsh-memory-persona@0.1.0` 的实现与验收口径。
> 包体：`dsh-memory-persona`，`schemaVersion = 1`，`contractVersion = 1`。
> 根藏契约：`../root/CONTRACT-v1.md`；熏习契约：`../process/dsh-memory-process/CONTRACT-v1.md`。
> 一句话：**镜台是人格卡与「注入设置」的唯一写者；它不改记忆、不替熏习判断、v1a 不接管注入。**

## 0. 边界

| 做 | 不做 |
|---|---|
| 人格卡：创建 / 编辑 / 删除 / 默认 / 工作区绑定 / 会话覆盖 | 改根藏 `chunks` / `vectors` / `manifest` / `identity` |
| 版本链 / diff / 回滚 / 备份 | 改熏习的 `state` / `topics` / `pending` |
| **AI 生成人设（一句种子 → 整卡草稿 → 人工保存）** | 自动保存 AI 结果 / 自动演化人格 |
| 注入设置：展示现在注入什么、多少、为什么没注入 | **v1a 接管注入**（沿用 soul-md 注入） |
| 只读 API + UI 壳（照 soul-md 设置页） | 写 soul-md 的 `cordis.patch.yml`（v1a 只读导入） |
| 权限 / 预算 / 开关 | 每轮调用模型（AI 生成是显式单次动作） |
| 跨 persona 隔离 | 跨人格共享 / 合并 |

- **唯一可写区 = `<dataRoot>/persona/`**；运行时闸门 `assertPersonaWritable` 拒绝写 `scopes/`、`process/`、`sessions/`、`<DSH_HOME>/soul-md/`、profile 配置目录。
- **v1a 不写 soul-md、不改注入**。soul-md 仍是现役注入源；镜台读它、显示它、编辑自己的副本。
- 任何写动作必须：**备份 → generation+1 → 原子写 → 写后读回**（found/missing/unknown；`unknown ≠ 成功`）。

## 1. 路径与写入纪律

```
<dataRoot>/persona/
  manifest.json                 # 全局 generation / 契约版本 / 写入者
  registry.json                 # 默认卡 / 工作区 / 会话 / 注入设置镜像
  cards/<cardId>/
    card.md                     # 唯一真源（front-matter + Markdown 正文）
    manifest.json               # 分区映射 / 分区 hash / version / source / updatedAt
    versions.jsonl              # 追加，latest-wins
    _archive/
      import-<ts>/              # 从 soul-md 导入的原始快照
      revision-<n>-<ts>/        # 每次保存/回滚的 card.md + .fingerprint.json
      lock-stale-<ts>.json
    .lock                       # 兼容占位（全局锁在 persona/.lock）
  _imports/
    soul-md-<ts>/               # cards.json + config.json + source.json + registry-before.json
                                # 只存 soul-md 相关快照；**不复制整份 profile**（避免无关凭据进入 persona 目录）
  _deleted/<ts>-<cardId>/<cardId>/  # 删除的卡（整目录移入，不物理删）
  .lock                         # 全局单写者锁（pid + 时间 + 主机）
```

- `dataRoot` 默认 `<DSH_HOME>/memory-jianmu`；实际值写进 `persona/manifest.json`。
- 所有状态文件**原子写**（tmp wx → write → fsync → close → rename）；追加日志失败截回原尺寸。
- 写前快照：保存 / 回滚 / 导入 / 删除先备份到 `_archive/`。
- 写后读回：found / missing / unknown 三态；`unknown ≠ 成功`。
- 锁冲突 → `LOCK_BUSY`，不重试覆盖。

## 2. 数据模型（v1 冻结字段）

### 2.1 `card.md`

```markdown
---
id: alice
name: "Alice"
personaId: alice
memoryScope: alice
source: "mirror:soul-md"
status: active
version: 3
updatedAt: 1794040000000
---

# 角色设定：示例助手——Alice

## 身份与外貌
...
## 红线
...
## 行为准则
...
## 风格示例
...
```

- **v1a 一卡一人格**：`cardId = personaId = memoryScope`；不一致直接拒绝。
- 分区固定四类：`identity`（身份）/ `redline`（红线）/ `behavior`（行为准则）/ `style`（风格示例）。
- 分区不是靠重写正文实现：导入时保留**原文逐字不变**，分区边界记录在 `manifest.json` 的 `zones`（按 `##` 标题切分）。
- **身份 / 红线 hash 保护**：`zoneHashes.identity` / `zoneHashes.redline` 为原文精确切片的 sha256；保存时变化 → `IMMUTABLE_SECTION_CHANGED`。只有显式 `allowProtectedSectionsChange: true` + `confirm: true` 才允许（仅 AI 草稿的二次确认路径使用），仍会写新版本、可回滚。
- 分区归类（标题级，不看正文）：红线 → `红线/底线/禁止/安全边界`；风格 → `示例/例句/范例/Few-shot`；身份 → `身份/外貌/关系/家庭/设定/私人文件夹`；其余（性格/准则/工作风格/社交/反注入/记忆纪律…）→ `behavior`。未识别一律归 `behavior`，保证导入卡可维护；H1 标题归 `identity`。
- 新建卡使用固定四段模板；导入卡保留原结构。

### 2.2 `manifest.json`（全局）

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "generation": 7,
  "dataRoot": "C:\\Users\\alice\\.dsh\\memory-jianmu",
  "createdAt": 0,
  "updatedAt": 0,
  "lastError": null,
  "writer": { "name": "dsh-memory-persona", "version": "0.1.0" }
}
```

- `generation` 在**每次成功写**（导入 / 保存 / 回滚 / 新建 / 删除 / 默认 / 绑定）后 +1；所有写工具必须带 `expectedGeneration`，不一致 → `STALE_GENERATION`。
- **失败语义**：任何一步失败 → 先恢复 registry/全局 manifest（含 `lastError`），再跑数据级回滚（card.md / 卡目录 / 删除移回）；不出现「card.md 已改、版本链没行、generation 没动」的半提交。

### 2.3 `cards/<cardId>/manifest.json`

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "cardId": "alice",
  "personaId": "alice",
  "name": "Alice",
  "memoryScope": "alice",
  "source": "mirror:soul-md",
  "status": "active",
  "version": 3,
  "createdAt": 0,
  "updatedAt": 0,
  "sourceHash": "sha256(card.md)",
  "zoneHashes": {
    "identity": "sha256(身份区分区原文拼接)",
    "redline": "sha256(红线区原文拼接)",
    "behavior": "…",
    "style": "…"
  },
  "zones": [
    { "index": -1, "level": 0, "title": "", "zone": "identity", "start": 0, "end": 120 },
    { "index": 0, "level": 2, "title": "身份与外貌", "zone": "identity", "start": 120, "end": 320 }
  ],
  "importedFrom": {
    "kind": "soul-md",
    "cardName": "Alice",
    "profileFile": "C:\\Users\\alice\\.dsh\\profiles\\desktop\\cordis.patch.yml",
    "importedAt": 0
  },
  "lastSave": { "revision": 3, "author": "user", "at": 0 }
}
```

- `sourceHash` = 整份 `card.md`（含 front-matter）的 sha256，用于读回校验与 `status --deep`。
- `zones` 的 `start/end` 是**正文（front-matter 之后）**的字符偏移；`-1` 为 H1 前导区。

### 2.4 `versions.jsonl`（追加，latest-wins）

```json
{"revision":3,"createdAt":1794040000000,"author":"user|ai-expand|import|rollback","reason":"manual edit: behavior","hash":"sha256(card.md)","prevHash":"…","note":"…","snapshot":true}
```

- 每次保存/回滚：`_archive/revision-<n>-<ts>/card.md` + `.fingerprint.json`；`snapshot` 记录该版快照是否成功（`apiVersions` 同时扫目录复核）。
- 回滚 = 历史快照写成**新版本**（revision = 当前 version + 1），不删当前、不改历史。
- `versions.jsonl` latest-wins：同一 revision 只保留最后一条，再按 revision 升序。
- AI 生成本身**不进版本链**；只有用户点「保存」才写版本，`author: "ai-expand"`，note 记 provider/model/token（`jianmu_persona_save` 的 `author` 参数）。

### 2.5 `registry.json`

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "generation": 7,
  "activeCardId": "alice",
  "cards": {
    "alice": { "name": "Alice", "source": "mirror:soul-md", "status": "active", "version": 3 }
  },
  "workspaces": { "C:\\work\\alice": "alice" },
  "workspaceList": [{ "path": "C:\\work\\alice", "title": "alice" }],
  "sessions": {},
  "settings": { "source": "soul-md", "readOnly": true, "injection": { "…": "见 §2.6" } },
  "updatedAt": 0
}
```

- `activeCardId` = 默认卡；`null` 表示全局不注入。
- `workspaces` = 工作区 → 卡；值为 `none` 表示该工作区不注入。
- `sessions` = 会话覆盖（最高优先级）。
- **解析顺序**：会话覆盖 → 工作区最长前缀 → 默认卡 → 不注入。与 soul-md 一致。
- v1a 的 registry 是镜台的副本；从 soul-md 导入时**逐字保留**，不猜。

### 2.6 注入设置（v1a 只读展示）

按 soul-md 现有有效值镜像（字段名不同，含义对齐）：

| 字段 | 对应 soul-md | 默认 |
|---|---|---|
| `inject.persona` | 有卡即注入（无单独开关） | 开 |
| `inject.memorySegment` | `memory.inject` | 开 |
| `inject.layered` | `memory.layered` | 关 |
| `inject.topicIndex` | `layered` + `recall` + `indexMode` | all |
| `inject.keywordRecall` | `memory.recall === "keyword"` | 关 |
| `inject.compactionCompensation` | `memory.compactionRecall` | 关 |
| `inject.subagentSkip` | `skipSubagents` | 关 |
| `inject.promptVariables` | `allowTemplates` | 关 |
| `limits.maxRecallTopics` | `memory.recallMaxTopics` | 5 |
| `limits.recallMaxChars` | `memory.recallMaxChars` | 1600 |
| `limits.injectMaxChars` | `memory.injectMaxChars` | 8000 |
| `limits.memoryMaxBytes` | `memory.maxBytes` | 1048576 |
| `mode` | soul-md 无只写模式 → `normal` | normal |

- 有效值来源链：`settings.get('soul-md')` → `settings.describe()` → loader entry config → `configEditor` → `cordis.patch.yml`（YAML 兜底）→ schema 默认值；整体标 `resolvedFrom`，失败层写入 `warnings`。
- v1a：**写 → `READ_ONLY_V1A`**。

## 3. 工具面（冻结）

允许恰好十五件，全部 `jianmu_persona_*`：

| 工具 | 作用 | 守卫 |
|---|---|---|
| `jianmu_persona_status` | 卡数/版本/来源/锁/generation/错误 | 只读；`deep=true` 跑完整性检查 |
| `jianmu_persona_list` | 卡片列表（id/name/personaId/source/default） | 只读 |
| `jianmu_persona_card` | 读当前卡（分区 + hash） | 只读 |
| `jianmu_persona_versions` | 版本列表 | 只读 |
| `jianmu_persona_diff` | 两版 diff | 只读 |
| `jianmu_persona_create` | 新建卡 | `confirm`；id 白名单；persona 未在 identity 注册时仍可建但返回警告 |
| `jianmu_persona_save` | 保存行为/风格区（备份 + version+1） | `expectedGeneration` + `confirm`；`author`（user / ai-expand）；身份/红线 hash 变化→拒绝 |
| `jianmu_persona_delete` | 删除卡（进 `_archive`，不物理删） | `expectedGeneration` + `confirm`；默认卡不能删 |
| `jianmu_persona_set_default` | 设默认卡（`none` = 全局关） | `confirm` |
| `jianmu_persona_bind` | 工作区/会话 → 卡（或 none） | `confirm` |
| `jianmu_persona_rollback` | 回滚到 revision（写成新版本） | `expectedGeneration` + `confirm` |
| `jianmu_persona_import` | 从 soul-md 导入（draft） | `confirm`；不覆盖已有卡 |
| `jianmu_persona_expand` | **AI 生成人设（一句种子 → 整卡草稿；不保存）** | 显式调用 + 预算 + 扫描；失败不返回草稿 |
| `jianmu_persona_preview` | 注入预览（渲染文本 + 字符/token + 截断原因） | 只读；不触发注入 |
| `jianmu_persona_settings` | 注入设置读取（v1a）/ 写入（v2） | v1a 写→`READ_ONLY_V1A` |

禁止：

- ❌ 工具名含 `recall/search/query`（检索归寻枝）
- ❌ 注册注入钩子 / pre-step / systemPrompt / 消息侧合成
- ❌ 写 `scopes/` / `process/` / `sessions/` / soul-md 目录 / profile 配置
- ❌ 每轮调用模型（`expand` 只在用户显式调用时发生）
- ❌ 自动保存 AI 结果 / 自动演化

### 3.1 AI 生成人设（`jianmu_persona_expand`）

- 输入：`seed`（编辑框全文）、可选 `cardId`、`existingContent`、`name`、`confirmOverwrite`。
- 行为：**一次调用**，把种子扩成一张完整人格卡；结果只**返回草稿**，不写盘。
- 模型路由：配置指定 → 当前会话 `modelSelection` → 模型目录默认；可配 `expandProvider: "ollama"` 走本地。
- 预算：**最终输入**（seed + 现有卡）≤ 8000 字符、输出 ≤ 8000 token、超时 60s、最多 1 次重试（0–1）。
- 扫描：`scanText`（注入模式/凭据/后门/不可见字符）；红 → 拒绝返回草稿（`EDITOR_UNTOUCHED`），黄 → 返回草稿并附带警告。
- 保护分区：老卡生成时 system 提示要求保留 `## 身份与外貌` / `## 红线` 原文；若生成结果改了保护分区，草稿标记 `protectedChanged: true`，保存时必须 `allowProtectedSectionsChange: true` + `confirm`。
- 失败（模型/网络/扫描/解析）→ 编辑框不动（不返回可用的 `draft`）。

## 4. 只读 API（给 UI）

前缀 `/api/persona`，**只接受 GET**：

| API | 返回 |
|---|---|
| `/status` | 卡数、版本数、generation、source、锁、soul-md 可用性、AI 预算、capabilities、warnings |
| `/cards` | 卡片列表 + 默认卡 |
| `/card?cardId=` | 卡名 + 正文 + front-matter + 分区 + hash + version |
| `/versions?cardId=` | 版本列表（新→旧） |
| `/diff?cardId=&from=&to=` | 行级 diff（unified 文本 + 结构化行） |
| `/registry` | registry 全文（含绑定） |
| `/settings` | 注入设置有效值 + 来源 + 只读标记 |
| `/preview?cardId=&workspace=&session=` | 渲染文本 + 字符/token + 截断原因 + 哪段没注入 |
| `/import-sources` | soul-md 可导入的卡（名称、映射到 persona、是否已存在） |

- 所有只读 API 只读当前 `dataRoot/persona/`；不写任何文件。
- UI v1a **全只读**：保存 / 删除 / 回滚 / 默认 / 绑定 / AI 按钮均禁用并注明 v1a.1。
- 动作 API（POST）v1a.1；v1a 不提供。

## 5. 守卫（必须能红）

1. `assertPersonaWritable`：只允许 `<dataRoot>/persona/`。
2. 身份/红线区 hash 变化 → `IMMUTABLE_SECTION_CHANGED`。
3. 无备份不写；备份失败 → 不写。
4. 旧 `expectedGeneration` → `STALE_GENERATION`。
5. 跨 persona 读写 → `CARD_ID_MISMATCH`：`readCard` 校验 `front-matter.id/personaId/memoryScope === cardId`；`save` 的 content 路径同样校验，且写回时强制 personaId/memoryScope = cardId。
6. v1a 注入接管 / 写 soul-md / 写 settings → `READ_ONLY_V1A`。
7. AI 生成：未保存不落盘；老卡保护分区不动（或显式二次确认）；扫描红 → 不返回草稿；失败 → 编辑框不动。
8. 写后读回：`unknown ≠ 成功`。
9. 锁冲突 → `LOCK_BUSY`，不重试覆盖。
10. 注入预览/设置读取不影响注入、不写卡。
11. 删除卡 → 进 `_archive`，不物理删；默认卡不能删。
12. 工具面按**实际注册名**校验；多注册/缺注册/检索词工具必须红。

## 6. 验收（v1a）

| # | 项 | 判据 |
|---|---|---|
| P1 | 导入 soul-md | 卡生成、原文进 `_archive/`、分区 hash 与源一致 |
| P2 | 编辑行为区保存 | 版本 +1、`_archive` 有快照、写后读回 ok |
| P3 | diff | 新旧两版能看到行为区变化 |
| P4 | 回滚 | 回滚成新版本，内容等于目标快照 |
| P5 | 红线保护 | 改身份/红线 → 拒绝 |
| P6 | 旧 generation | 不一致 → 拒绝 |
| P7 | 锁 | 并发两个 save 只有一个成功 |
| P8 | 崩溃/原子写 | 中途失败不留半文件 |
| P9 | 卡片 CRUD | 新建/删除（进 `_archive`）/默认卡切换/工作区绑定/会话覆盖 |
| P10 | 不影响 soul-md | 注入段前后 hash 一致；soul-md 卡文件未改 |
| P11 | UI | 人格卡入口出现；卡片列表/编辑/默认/工作区/注入设置（只读）/版本/预览均可见 |
| P12 | AI 生成人设 | 一句种子能生成整卡草稿；填回编辑框但不落盘；保存→新版本且 `author=ai-expand`；老卡不覆盖身份/红线；扫描红被拒；失败不动编辑框 |
| P13 | 注入预览 | 渲染文本 + 字符/token + 截断原因；不触发注入 |
| P14 | 根藏/熏习零写入 | 验收前后根藏 hash、process manifest 不变 |

自测目标 **≥ 40 条**；真实副本验收 **≥ 16 条**。

## 7. 变更记录（冻结后只追加）

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-07 18:40 | 从施工计划 §3–§8 冻结为 v1a：补全局 generation、card manifest / zones / zoneHashes、导入映射、AI 生成草稿与扫描、只读 API 九端点、15 件工具面、12 条守卫 | 开工前定型，避免实现漂移 |
| 2026-11-07 19:15 | **独立审查后补丁**：分区替换不全局压空行；写事务失败全量回滚（registry/manifest/`lastError` + 数据级回滚）；跨 persona 读写守卫；AI 预算改为 seed+现有卡合计；save 暴露 `author`（ai-expand）；latest-wins/快照字段；导入只存 soul-md 快照；profile 目录/保留 cardId/junction 真实路径闸门；identity 缺失降级；CRLF 归一；重试上限 1 | 独立审查 5 条 P1 + 高价值 P2 |
| 2026-11-07 19:50 | **v1a.1**：`/api/persona` 增加 POST 写路由（create/save/delete/default/bind/rollback/expand）；CSRF 三闸（JSON content-type、`x-dsh-persona: 1`、Origin/Host 同源 + sec-fetch-site）；服务端强制 `confirm:true`；错误码→HTTP 状态映射；UI 接上写动作与 AI 草稿按钮（全文编辑 / 回滚 / 删除 / 默认 / 绑定 / AI 展开+撤销+受保护二次确认）。**数据模型、15 件工具面、12 条守卫、不接管注入均不变** | 交接书 §5；UI 从只读壳升级为可编辑 |
