# 建木 · 模块化记忆层

> 给 **DeepSeek Harness** 的五层记忆插件：原话可查、语义检索、去重整理、claim 认知、人格注入。
> 层间只走一份显式契约；可整层安装，也可单包装。

**建木 1.0.1**（1.0.0 首发后的小修：注入预览不再误报错误）· 五包版本见下表 · [MIT](LICENSE)

> 建木 **1.0.1** 是产品版本；五个包仍按各自 semver（0.x）演进。包内 API 以各包 README 为准。

---

## 五层与包

| 层 | 包 | 目录 | 作用 | 文档 |
|---|---|---|---|---|
| 检索 | `dsh-semantic-recall`（寻枝） | [`dsh-semantic-recall/`](dsh-semantic-recall/README.md) | 召回原话、带回锚点；不写、不注入 | [README](dsh-semantic-recall/README.md) |
| 存储 | `dsh-memory-store`（根藏） | [`root/`](root/README.md) | 摄取原话、落盘、可重建；不检索、不注入 | [README](root/README.md) |
| 处理 | `dsh-memory-process`（熏习） | [`process/dsh-memory-process/`](process/dsh-memory-process/README.md) | 去重、标记取代、时效、归档 | [README](process/dsh-memory-process/README.md) |
| 认知 | `dsh-memory-yearring`（年轮） | [`yearring/dsh-memory-yearring/`](yearring/dsh-memory-yearring/README.md) | 从原话提炼带锚点的 claim、主题正文、星图 | [README](yearring/dsh-memory-yearring/README.md) |
| 人格注入 | `dsh-memory-persona`（镜台） | [`persona/dsh-memory-persona/`](persona/dsh-memory-persona/README.md) | 人格卡、版本链、回滚、注入预览 | [README](persona/dsh-memory-persona/README.md) |

> 五包同属一套契约，按**整层**发布；单包也可独立安装，但只有整层才能得到「原话 → 检索 → 整理 → claim → 注入」的完整链路。

---

## 安装

### 需要

- DeepSeek Harness **≥ 0.2.1-rc.5**（0.2.1-rc.5 与 0.2.2-rc.3 已实测；0.2.2 预发布由 `engines.dsh` 显式覆盖）
- Node.js **≥ 22**（DSH 自带 node 即可，`install-jianmu.bat`/安装建木.bat 会自动找）
- **Windows 10/11** 已实测；macOS / Linux **未验证**
- 检索需要一个 OpenAI 兼容的嵌入服务（云端或本机 Ollama）；年轮抽取走宿主模型；详见[隐私与外部请求](docs/隐私与外部请求.md)
- 记忆星图的「重建星图」需要带 numpy 的 Python（优先用 DSH 自带 Python，面板会自动探测；没有也不影响其它层）

> ⚠️ **不要用插件管理器 / npm 去装 `dsh-semantic-recall`**：npm 上同名包的 latest 停在 **0.3.0**（旧版），与这里发布的 **0.4.5** 不是同一份，混着装会得到不匹配的一套。请一律用本页 Releases 里的 tarball + 安装脚本。

### 推荐：五包 + 一键脚本

> ⚠️ **Release 资产名说明**：GitHub 不接受中文资产名（会被清洗成 `default.bat` 之类），所以 Release 里的文件用 ASCII 名。
> 对照：`install-jianmu.bat` = 安装建木.bat、`RELEASE-NOTES-1.0.1.md` = 发布说明、`docs-*.md` = 五份中文文档。
> **最省事**：直接下载 `jianmu-1.0.1-release.zip`，解压后就是带中文名的完整发布目录（`sha256sum -c SHA256SUMS-public` 原样可用）。
> 详细对照见 Release 里的 `ASSET-MAP.md`。

1. 从 [Releases](https://github.com/zhaohualiuyuejun/dsh-memory-jianmu/releases) 下载 5 个 tarball、`install-jianmu.mjs`、`install-jianmu.bat` 和 `docs-*.md`（或直接下 `jianmu-1.0.1-release.zip` 解压）。
2. 把 5 个 `dsh-*.tgz` 与 `install-jianmu.mjs` 放在**同一个目录**里，先看计划（不改任何文件）：
   ```bash
   node install-jianmu.mjs --dry-run
   ```
3. 安装：
   ```bash
   node install-jianmu.mjs
   ```
   或双击 `install-jianmu.bat`（= 安装建木.bat）。
4. **重启 DSH**（关掉窗口再打开）。

脚本会：备份 profile 三文件 → 装包 → 写 `dsh.profile.bundles` → 核验；任一步失败自动还原。它**不碰数据**，也不删任何东西。

> 若 DSH 不在默认的 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，可设 `JIANMU_PNPM=<DSH 安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs`；脚本也会回退到 PATH 上的 pnpm / npm。

### 手工安装

1. 五个 tarball 装进 profile；
2. `dsh.profile.bundles` 里追加五个包名：
   `dsh-semantic-recall`、`dsh-memory-store`、`dsh-memory-process`、`dsh-memory-yearring`、`dsh-memory-persona`；
3. 重启 DSH。

> ⚠️ 只安装、不写 `bundles` = **不会加载**。
> ⚠️ 卸载不删数据：`~/.dsh/memory-jianmu`（根藏/熏习/年轮/镜台/星图）与 `~/.dsh/session-recall`（寻枝索引）都会留着。
> ⚠️ 公开版**不含元包** `jianmu-all`；元包仅内部实验用，`file:` 依赖是绝对路径，不适合 Release 分发。

---

## 快速开始

重启后侧栏会出现：

- **根藏**：数据量、自动摄取、嵌入 Key、测试连接
- **记忆库**：原话看板、待处理、设置、人格卡、年轮
- **人格卡**：卡片/绑定/版本历史/注入预览
- **星图**：年轮 claim 的 3D 视图
- **寻枝设置**：左下角头像 → 设置 → 会话语义检索

第一次使用：

1. 在**根藏**里配置嵌入服务（云端或本机 Ollama），点「测试连接」；
2. 让根藏自动摄取一段对话；
3. 在**寻枝**设置页建索引；
4. 在**人格卡**里建卡、绑定工作区；
5. 在**注入预览**里看当前会注入什么、为什么。

---

## 它是什么 / 不是什么

**是：**
- 一套可装卸的五层记忆插件；
- 原话可回查、检索带锚点、claim 可追溯到原话；
- 除「年轮自动消化」外默认不调用外部 LLM：它默认每小时检查一次、有每人每日 token 上限，可在设置里关掉（`autoDigest=false`）；嵌入服务由你自己配置（云端或本机 Ollama）；
- 数据在本地，按人格隔离。

**不是：**
- 不是通用 Agent，不替宿主模型做推理；
- 不是图数据库；不要求 Neo4j；
- 不是「全自动记住一切」；默认关的能力（自动召回、conflict card 等）需手动开；
- 不是五个独立仓库；五包按一套契约发布。

---

## 文档

- [隐私与外部请求](docs/隐私与外部请求.md) — 每层什么时候把什么发到哪、怎么关
- [安装矩阵](docs/安装矩阵.md) — 单装/组合/谁调用谁/卸载残留
- [回滚手册](docs/回滚手册.md) — profile 三文件、数据根、设置回滚
- [支持版本](docs/支持版本.md) — DSH/Node/平台支持矩阵
- [安装脚本使用说明](docs/安装脚本-使用说明.md) — 备份/还原/`--dry-run`

---

## 支持范围

| 项 | 声明 |
|---|---|
| DSH | ≥ 0.2.1-rc.5（五包 `engines.dsh` 一致） |
| Node.js | ≥ 22 |
| Windows 10/11 | **已实测** |
| macOS | **未验证** |
| Linux | **未验证** |
| 无网页界面的宿主 | 部分能力降级，未逐项实测 |

---

## 版本

| 层 | 包 | 版本 |
|---|---|---|
| 产品 | **建木** | **1.0.1** |
| 检索 | `dsh-semantic-recall` | 0.4.5 |
| 存储 | `dsh-memory-store` | 0.2.7 |
| 处理 | `dsh-memory-process` | 0.2.7 |
| 认知 | `dsh-memory-yearring` | 0.4.3 |
| 人格注入 | `dsh-memory-persona` | 0.3.8 |

> 建木 1.0.0 是首个公开发布，1.0.1 修「注入预览误报」；五包仍按各自 semver 演进。发布 tag 用 `v1.0.1`，后续按产品线计数。

### 1.0.1 修了什么

> 1.0.0 里，在「镜台未接管注入 + 本机没有 soul-md 回退源」时，**人格卡 → 注入预览**会显示红色「读取失败 / SOULMD_UNAVAILABLE」。
> 实际不是故障，只是注入开关没打开。1.0.1 改成正常说明 + 一个**「打开接管注入」按钮**（点一下当场生效，不用重启）。
> **默认行为不变**：镜台默认不接管注入，想用就在预览页或「注入设置」里打开。

---

## 仓库结构

```
.
├── README.md                 # 本页
├── LICENSE                   # MIT
├── dsh-semantic-recall/      # 寻枝
├── root/                     # 根藏
├── process/dsh-memory-process/   # 熏习
├── yearring/dsh-memory-yearring/ # 年轮
├── persona/dsh-memory-persona/   # 镜台
├── docs/                     # 用户文档（5 份）
├── install-jianmu.mjs
└── 安装建木.bat
```

> 内部计划、调研、验收报告、备份与实验数据不放在公开仓库；它们不属于运行所需文件。

---

## 反馈

- 通过 GitHub Issues 报告 bug / 题目歧义 / 安装差异；
- 不要提交密钥、私人对话或真实用户身份资料；
- 安装/回滚问题请附上 `node install-jianmu.mjs --dry-run` 的输出（隐去个人路径）。

---

## License

[MIT](LICENSE)

---

> 建木 1.0.1 · 2026-11-15
