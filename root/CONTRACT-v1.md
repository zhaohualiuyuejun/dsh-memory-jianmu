# 建木 · 存储层「根藏」契约 v1（冻结）

> 状态：**v1 冻结（2026-11-07）**。初稿见 `../docs/contract-v1-草案.md`；本文是实现与验收的唯一口径。
> 包体：`dsh-memory-store@0.1.0`，`contractVersion = 1`，`schemaVersion = 1`。
> 仓库：https://github.com/zhaohualiuyuejun/dsh-memory-jianmu

## 0. 一句话

**根藏只做一件事：把「谁、在什么时候、说了什么」原样摄取、落盘、可重建。**
不检索、不注入、不判断谁取代谁。它的价值是**证据层**。

## 1. 层与工具面

| 层 | 插件 | 读原始会话 | 写记忆库 | 注册检索工具 | 注入上下文 |
|---|---|---|---|---|---|
| 存储 · 根藏 | `dsh-memory-store` | ✅ 只读源 | ✅ 只写自己的库 | ❌ | ❌ |
| 检索 · 寻枝 | `dsh-semantic-recall` | ❌ | ❌ | ✅ | ❌ |
| 处理 · 熏习 | `dsh-memory-process` | ✅ | ✅ 只写状态/标注 | ❌ | ❌ |
| 人格 · 镜台 | `dsh-memory-persona` | ✅ 只读人格卡 | ✅ 只写人格卡 | ❌ | ✅ 唯一有权注入 |
| 认知 · 年轮 | 待定 | ✅ | ✅ 只写派生知识 | ❌ | ❌ |

**根藏对外工具（七件；`contractVersion` 仍为 1，工具面为追加式扩展）**

| 工具 | 作用 |
|---|---|
| `jianmu_store_ingest` | 摄取：`sessions`（只读 DSH 会话）/ `utterances`（显式行）/ `legacy`（迁移旧库） |
| `jianmu_store_status` | 块数、会话数、人格、未归属、向量缺失/坏行、错误、数据目录、磁盘余量 |
| `jianmu_store_rebuild` | 从 `chunks.jsonl` 重建 `index_meta`；**0 次嵌入** |
| `jianmu_store_export` | 导出某人格的 `chunks.jsonl`（可带 manifest） |
| `jianmu_store_forget` | 显式忘记：写墓碑（不物理删） |
| `jianmu_store_revive` | 撤销忘记（追加 revive 行） |
| `jianmu_store_identity_add_persona` | 登记人格 + 工作区/会话映射（默认只预览；备份 + 幂等 + 只增不删） |

**禁止（守卫要能红）**

- ❌ 注册任何 `*recall*` / `*search*` / `*query*` 工具（检索归寻枝）
- ❌ 注册任何注入钩子 / pre-step 注入（注入归镜台）
- ❌ 写入 `~/.dsh/sessions/`（只读源）
- ❌ 无 `contractVersion` 写库；`contractVersion > 1` 仍写入
- ❌ 静默吞掉摄取/落盘失败（必须给 code）
- ❌ 跨 persona 读取 / 查询 / 合并；不提供 `_shared`
- ❌ 未归属块静默归入具名人格
- ❌ `manifest.personaId` 与所在目录不一致仍写入

## 2. 数据模型：原话是原子

### 2.1 utterance（v1 冻结字段）

```json
{
  "id": "sha256(session|messageId|seq|part|normalizedText)",
  "kind": "utterance",
  "schemaVersion": 1,
  "contractVersion": 1,
  "session": "session-example01-...",
  "personaId": "alice",
  "identitySource": "workspace",
  "messageId": "e41999df-...",
  "seq": 15,
  "turn": null,
  "part": 0,
  "role": "user",
  "sourceType": "user",
  "t": 1762018800000,
  "tz": "Asia/Shanghai",
  "text": "原话……",
  "ws": "C:\\work\\alice",
  "wsDir": "--C-work-alice--",
  "channel": "dsh",
  "attachments": [],
  "sourceHash": "…",
  "retention": "active",
  "ingestVersion": "0.1.0",
  "provenance": { "migratedFrom": "dsh-semantic-recall", "legacyScope": "src1", "legacyRowIndex": 0 }
}
```

| 字段 | 规则 |
|---|---|
| `id` | `sha256(session\|messageId\|seq\|part\|normalizedText)`；同内容同 id ⇒ 摄取幂等 |
| `text` | **原话原样保存**：不 trim、不改写、不折叠（前后空白也是原文的一部分）；归一化只用于 `id` 计算。**例外**：`from=sessions` 的抽取环节会裁剪首尾空白（与寻枝 0.3.1 的抽取口径一致，内容不改写）；`from=legacy` 迁移逐字节保留旧库文本 |
| `normalizedText` | 只做 `CRLF→LF` + 去首尾空白 + 去 BOM；**不折叠空白**（折叠会把不同原话合并） |
| `kind` | 固定 `utterance`（预留 `claim`） |
| `personaId` | 稳定 slug `[a-z0-9][a-z0-9_-]{0,63}`，或 `persona_unassigned` |
| `identitySource` | `session` / `workspace` / `default` / `manual` / `unassigned` |
| `messageId` / `seq` / `part` / `turn` | 锚点；`turn` 可选（E2，由摄取器从原始会话重建时写；迁移旧库没有就 `null`） |
| `role` | `user` / `assistant` / `tool` / `system` |
| `sourceType` | `user` / `assistant` / `tool` / `injected`（E4）；旧库 `*-bridge` 折叠到基础角色，原值进 `provenance.legacySourceType` |
| `t` | **UTC epoch 毫秒**（唯一时间标准）；不存时间字符串（D5） |
| `tz` | 原始时区，默认 `Asia/Shanghai` |
| `ws` | 工作区真实路径（v1 以旧库 `wsPretty` 为准，见 §3.3） |
| `wsDir` | DSH 会话目录名（迁移期对账用；可选） |
| `channel` | `dsh` / `qq` / `wechat` / `file`（v1 尽力推断；v1.1 由桥接显式写） |
| `attachments` | **只存引用+元数据**（kind/name/path/sha256/size/missing），不存字节 |
| `sourceHash` | 原始消息/源行指纹，用于发现源变化（F14） |
| `retention` | `active` / `expired`；**expired ≠ 删除** |
| `provenance` | 可选；迁移来源审计（不是派生知识） |

**不存**：摘要/结论/话题标签、重要性评分、reasoning、工具调用结构、系统注入、附件字节。

### 2.2 分块

1200 字一块 / 80 字重叠（与寻枝 0.3.1 逐字一致）。块是检索物理单位，不是记忆最小单位。

### 2.3 人格与作用域

- **隔离键 = `personaId`**；`scopeId = personaId`；物理布局 `scopes/<personaId>/`。
- 解析顺序（实现冻结）：**会话显式覆盖 → 调用方人工指定 → 工作区最长前缀 → 显式默认 → `persona_unassigned`**。
- 工作区匹配按**路径段边界**、不区分大小写（Windows）。
- **未归属 fail-closed**：不静默归入任何具名人格；`status` 报警。
- 子代理继承父会话 `personaId`（靠 `identity.sessions` 覆盖；不单独建库）。
- 不做跨人格共享/合并；不提供 `_shared`。

`identity.json`（根藏**只读**；由人格解析层维护）：

```json
{
  "version": 1,
  "defaultPersonaId": null,
  "personas": { "alice": { "displayName": "Alice" }, "bob": { "displayName": "Bob" } },
  "workspaces": { "C:\\work\\alice": "alice", "C:\\work\\bob": "bob" },
  "sessions": {}
}
```

## 3. 文件布局

```
<dataRoot>/identity.json                 # 人格解析层维护；根藏只读
<dataRoot>/scopes/<personaId>/
  manifest.json      # schemaVersion/contractVersion/generation/personaId/displayName/identitySource
                     # provider/model/dim/normalizerVersion/tokenizerVersion/embeddingMeta
                     # chunks/sessions/workspaces/tMin/tMax/retentionDays/builtAt/writer
  chunks.jsonl       # 唯一真源，只追加（事实源）
  vectors_v<N>.f32   # 派生，可重建；行序与 chunks 严格一致；小端 f32
  index_meta.json    # 指向当前生效向量文件 + 缺失/坏行清单
  deleted.jsonl      # 墓碑侧表：id/deletedAt/reason（软删除，不改 chunks）
  cost.jsonl         # 嵌入/重建成本明细（append-only；记账失败只告警）
  .lock              # scope 级单写者锁（pid+时间+主机；陈旧锁改名归档再抢）
  _archive/          # 备份：<reason>-<时间>/ + .fingerprint.json；旧向量、purge 前快照
```

默认 `dataRoot = <DSH_HOME>/memory-jianmu`（**不得放插件安装目录**，F15）。
演练目录 `<dataRoot>/_dryrun/`（结构同 dataRoot，**不写生产 `scopes/`**）。

### 3.1 写入纪律

1. **顺序固定**：`chunks.jsonl`（事实源）→ `vectors_v<N>.f32` → `manifest/index_meta`。（D6）
2. `chunks.jsonl` 只追加，永不重写；修正走侧表或重放。
   **唯一例外 = 快照导入**：`writeScopeBundle` 是迁移/bootstrap 的整库写入口，必须显式 `overwrite:true`、先独占备份、成功后 `generation + 1`；**只允许用于迁移/首次导入**，日常摄取一律走 `appendUtterances`。生产迁移应从空目录开始，不覆盖已有生产 scope。
3. 所有状态文件**原子写**：`tmp(wx 独占，带 pid+随机段) → write → fsync → rename → close`；失败清 tmp，**绝不回报 ok**。（D7/F1/F2）
4. 原子写只承诺「单文件 + 同目录 rename + 旧或新完整」；不承诺多文件事务、多写者 CAS、断电后目录项持久。
5. **写后读回**：found / missing / unknown 三态；`unknown ≠ missing`，unknown 不算成功。（F9）
6. 覆盖已有 scope 必须显式 `overwrite`；覆盖前自动独占备份，**替换成功后才提交备份指纹**。（F3）
7. 存储初始化失败 → 降级模式，构造**永不抛**；降级原因进 `status`。（D9/D10）
8. `dataRoot` 落在只读源 `sessions/` 下 → **拒绝使用**（连探针都不写）。
9. `statusAll` 会遍历所有 scope 读 `chunks.jsonl`，**仅用于计数/统计**，不返回正文、不做跨 persona 检索/合并 —— 这是 F17 的显式运维例外。
10. 只追加文本（不嵌向量）到已有向量的 scope，会让对齐暂时不完整（`alignmentBroken`）；reembed 补向量前禁止再追加向量。这是 v1 骨架「不嵌向量」的已知代价。

### 3.2 向量

- 文件字节数必须 `count × dim × 4`，否则拒绝使用（不静默截断）。
- 写入时 L2 归一化；非有限值置 0；模长 `< 1e-10` 记零向量。
- **坏行保留占位以维持行对齐**（迁移不重嵌，不能丢行）；坏行记入 `index_meta.badVectorRows`，形如 `{index, reason, id}`，`status` 报「需 reembed」。
- **写前自证（D1）**：任何向量写入都要比对 `manifest.dim/provider/model/normalizerVersion`；任一不一致 → 写前拒绝（`EMBEDDING_MISMATCH`），换模型/维度必须走 reembed 并新建 `vectors_v<N+1>`。
- **对齐自检**：追加后向量文件字节数必须等于 `块数 × dim × 4`；追加失败必须把向量文件截回原尺寸；对齐破坏后拒绝继续追加向量（`alignmentBroken` 进 status/verify）。
- 换模型/维度：新建 `vectors_v<N+1>`，旧的进 `_archive/`，不硬删。（D4）
- `manifest` 自证 `provider/model/dim/normalizerVersion`；任一变化标「需重嵌」，不静默继续。（D1）

### 3.3 identity 的 `workspaces` 键（v1 施工决定）

v1 的键取**旧库 `wsPretty`**（由 DSH 会话目录名解码，与寻枝 0.3.1 `prettyWorkspace` 逐字一致）。
理由：迁移期必须逐字命中，不能靠猜真实路径（含连字符的目录名无法从目录名反推）。
已知偏差：`...-deepseek-harness-default-workspace--` 会解成 `...\deepseek\harness\default\workspace`；`...-example-duty--` 会解成 `...\bili\duty`。
v1.1 起由镜台/人格解析层提供真实路径映射；根藏只读，不改写。
> 2026-11-12（0.2.4）更新：P4 #5 起根藏提供**受控写**（`identityAddPersona` / `identityRemoveMappings`），
> 仍是 `contractVersion = 1` 的追加能力；写入纪律见 §3.4。§3.3 的历史结论仅描述 0.2.2 之前。

### 3.4 identity 的受控写（0.2.4 起，P4 #5）

根藏是 `identity.json` **唯一写者**；其它插件（镜台）通过 host 服务 `ctx.get('jianmuStore')` 调用，
**不得直接写该文件**。

| 动作 | 语义 | 纪律 |
|---|---|---|
| `identityAddPersona` | 新增人格 + 工作区/会话映射 | 默认只预览；`dryRun=false + confirm=true` 才写；**只增不删**；已属于别人默认跳过（`allowReassign` 才改） |
| `identityRemoveMappings` | 「停记」：摘掉指向该人格的映射 | 只删 `value === personaId` 的条目；**不删任何记忆**；不提供“一键摘掉全部” |
| `identitySummary` | 只读摘要 | 不写 |

写路径：锁 → 预览漂移检查（`IDENTITY_CHANGED`）→ 备份到 `<dataRoot>/_archive/identity-<ts>-<rand>.json`
→ 原子写 → 读回校验（不一致还原备份）→ 幂等（无变化不写、不占备份）。
`identity.json` 缺失 → 新建；损坏/非法 → **拒绝覆盖**（fail-closed）。
**没有「彻底删除人格/记忆」动作**。

## 4. 版本与迁移

- `contractVersion`：层间契约版本。读取方发现 `> 1` → **拒绝写**（可读）。
- `schemaVersion`：行内 schema。可读旧版本，不写更高版本。
- `identity.json` 缺失/损坏/非法 → 降级：`persona_unassigned` + `status` 报警；**绝不静默归入具名人格**。
- 迁移器（D8/F17）：
  - 读旧 `meta.json` + `vectors.f32`，**只读**；
  - persona 归属以**源级映射**为准（旧库的 source 已经明确属于某人格），工作区命中结果只做一致性校验（冲突报警，不阻断）；
  - 向量按同一行序拆行，**不重嵌**；
  - 块数 / 文本 / 锚点 / persona / 向量逐行，五项全过才算成功；
  - `imported === total` 才写「迁移完成」报告；否则保留源、下次重试；
  - 迁移前后对旧库文件做 sha256 对照，必须一致。

## 5. 经济性（硬指标，附录 C/E5）

| 指标 | 目标 |
|---|---|
| 每轮固定注入（根藏） | **0 token** |
| 每场额外 LLM 调用（根藏） | **0 次**（摄取/切块/落盘不调模型） |
| 每块嵌入 | 1 次（只嵌新块；迁移复用旧向量 = 0 次）。v0.2.0 起由插件内自动摄取执行 |
| 检索一次 | 不归根藏 |
| 贵能力默认关 | 摘要/反思/演化/重排默认不做 |

## 6. v1 明确不做

- ❌ 检索（归寻枝）· ❌ 注入（归镜台）· ❌ 取代/遗忘判断（归熏习）· ❌ 结论提炼（归年轮）
- ❌ GUI / 设置页（v1 只 CLI + 工具面）
- ❌ 跨人格共享记忆
- ❌ 按时间的热冷分区（E6：实测差异 <1.5pp）
- ❌ 会话摄取时的嵌入（v1 骨架不嵌；向量来自迁移复用。**v0.2.0 起**：插件内自动摄取改为「先嵌后写」，仍不改本层只追加/可重建的边界）
- ❌ 修改寻枝的包名/目录名/索引格式（兼容读取即可）

## 7. 变更记录（v1 冻结后只追加）

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-07 | 从草案冻结为 v1；补 `schemaVersion/contractVersion/turn/tz/wsDir/provenance/sourceType` 字段与逐字段规则 | 上午施工验收 |
| 2026-11-07 | 物理布局统一为 `scopes/<personaId>/`（草案 2.4），废弃施工计划里的 `scopes/persona_<id>/` 写法 | 两者冲突；F17 要求 manifest.personaId 与目录一致 |
| 2026-11-07 | 解析顺序补「人工指定」为第二级 | 迁移/导入需要显式指派，且不能静默 |
| 2026-11-09 | v0.2.0：自动摄取搬进插件（每小时 :07，先嵌后写）；日志/状态/锁写到 `<dataRoot>/_logs/`；不再依赖 Windows 计划任务 | 旧 `node.exe` 计划任务每小时弹控制台黑框，真实用户不可接受 |
| 2026-11-07 | 坏向量行保留占位 + 计数，不丢行 | 迁移必须保持 chunks/vectors 行对齐，不能用 D2 的「不入库」语义丢行 |
| 2026-11-07 | `text` 改为**原样保存**（不 trim）；归一化只用于 `id`；迁移校验新增「直接对旧库源行」两项 | 审查发现迁移 trim 造成 2 行非逐字节一致且自证通过（假绿） |
