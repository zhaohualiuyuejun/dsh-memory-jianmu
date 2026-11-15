/**
 * lib/topicgroups.mjs —— 主题归并：把细碎的 topicHint 归到 L1 大主题
 *
 * 设计（P2-4）：
 *   · 两级：L1 = 固定的 19 个大主题；L2 = claim 原有 topicHint（细粒度子主题）
 *   · 归并规则 = 有序匹配，先领域词、后动作词——避免「年轮审查」被归到「工作方法」
 *   · 匹配不到 → 「其他」；未来新 hint 自动归，不需要维护 1143 条映射
 *   · 用户可在 <dataRoot>/year/<personaId>/topic_groups.json 里覆盖单条
 *     { "overrides": { "某个主题": "memory" } }
 *
 * 0 LLM、纯规则、可解释、可重复。
 */

/** L1 大主题（有序；第一个命中的规则生效） */
export const L1_GROUPS = [
  {
    id: 'bili', title: 'B站运营', order: 10,
    test: /B站|bilibili|楼中楼|刷片|视频日报|值守|刷B站|B站情报|B站评论|B站采集|B站抓取|B站回复|B站推送|B站运营|B站观察|B站插件|B站日报|B站视频日报|评论|日报|刷量/,
  },
  {
    id: 'social', title: 'QQ与社交', order: 20,
    test: /QQ|NapCat|微信|群聊|社交插件|通道搭建|通道配置|QQ桥接|桥接运维|桥接诊断|桥接仓库|桥接故障|封号|账号|通讯通道|跨平台|三端|收件箱/,
  },
  {
    id: 'localai', title: '本地AI', order: 25,
    test: /本地模型|Ollama|qwen3|句向量|嵌入配置|嵌入通道|embedding/,
  },
  {
    id: 'training', title: '模型训练', order: 30,
    test: /训练|LoRA|数据集|打标|显存|步数|Qwen|V4|V5|V3\.1|模型验收|模型测试|模型评估|模型选型|模型下载|模型调用|模型配置|模型性能|模型接入|模型盯梢|模型巡查|画风训练|画风LoRA|人设LoRA|角色LoRA|示例角色LoRA|权重|批次参数|批处理调参|参数调优|批处理参数|补图方案/,
  },
  {
    id: 'image', title: '图像生成', order: 40,
    test: /出图|生图|图生图|文生图|ComfyUI|表情包|抠图|透明底|2K|局部重绘|多图参考|背景生成|图像生成|图像编辑|图像打标|图像模型|修图|PS桥接|PS插件|PS下载|PS 采购|手部特写|画风|找图|素材|跑图产出|文字渲染|出图管线|出图参数|出图提示词|生图提示词|出图调试|出图调优|出图筛选|出图工作流|出图验证|图集创作|成品压测|成品管线|表情包制作|表情包出图|表情包系列|提示词/,
  },
  {
    id: 'novel', title: '小说创作', order: 50,
    test: /小说|九州|拆文|卷纲|细纲|剧情|人物|角色设定|正文|文风|伏笔|章节|章号|写作|拆解|书稿|小说设定|作品设定|题材设定|设定拆分|设定文档|设定口径|设定资料|剧情设定|题材|短剧|分镜|大纲|人名|用字|去AI味|日更|续写|书库|错字|功法|Oh Story/,
  },
  {
    id: 'memory', title: '记忆系统', order: 60,
    test: /记忆|根藏|熏习|年轮|镜台|寻枝|存储|摄取|抽取|索引|向量|检索|嵌入|墓碑|遗忘|原话|会话源|语义|记忆库|归档|scope|分库|多源|库重建|空库|session_recall|话题卡|时间语义|时间感知|分桶|导出|删除语义|主题碎片化|主题聚合|锚点|生成器|预览一致性|后台消化|四层机制|源隔离|认知层|外置进化|日摘要/,
  },
  {
    id: 'plugin', title: '插件生态', order: 70,
    test: /插件|npm|灵枢|Obsidian|README|插件页简介|宣传贴|0\.3\.0发布|0\.3\.1/,
  },
  {
    id: 'dsh', title: 'DSH平台', order: 80,
    test: /DSH|dsh|浏览器桥|CDP|MCP|任务看板|定时任务|定时调度|定时提醒|设置页|UI|界面|扩展|preset|工作区|会话|上下文|inspector|super-agent|网页端|端口|启动|客户端|前端|后台页面|运行时API|推理档位/,
  },
  {
    id: 'automation', title: '自动化与桌面', order: 90,
    test: /自动化|键鼠|窗口|输入|记事本|桌面|网页操作|浏览器扩展|浏览器插件|独立输入|屏幕|截图|界面自动化|桌面自动化|输入自动化|窗口聚焦|浏览器助手|扩展调试|扩展排障/,
  },
  {
    id: 'media', title: '媒体与影音', order: 100,
    test: /Live2D|桌宠|TTS|语音|字幕|视频|剪辑|分镜|音频|抽帧|短剧|漫画|条漫|转写|数字形象|3D识海|动作编排|换装/,
  },
  {
    id: 'game', title: '游戏与娱乐', order: 110,
    test: /游戏|奥斯德拉|鸣潮/,
  },
  {
    id: 'persona', title: '人格与关系', order: 120,
    test: /人格|人设|Bob|助手|称呼|关系|画像|身份|行为准则|角色|用户偏好|用户习惯|用户标准|助手|AI润色|卡文件|卡解析|弟弟的AI/,
  },
  {
    id: 'security', title: '安全与权限', order: 130,
    test: /安全|权限|边界|隐私|注入|红线|审计|守卫|护栏|放行|沙箱|攻击|写盘安全|写入安全|写闸门|操作安全|白名单|安装授权|安装约束|隔离/,
  },
  {
    id: 'env', title: '环境与设备', order: 140,
    test: /环境|磁盘|移动硬盘|USB|显卡|端口|代理|网络|故障|重启|系统|电脑|硬件|安装部署|路径|shell|键鼠|外设|依赖|运行环境|执行环境|本机|资源|限流|磁盘空间|磁盘占用|便携|鸿蒙|下载|搬家|私人目录/,
  },
  {
    id: 'product', title: '产品与项目', order: 150,
    test: /建木|产品|竞品|发布|发版|开源|商业化|用户反馈|官方反馈|官方动态|使用反馈|文档|定位|路线|市场|经济性|成本|费用|预算|立项|项目|目标|方向|缺口|价值|标准|需求|生态|合作|营销|宣传|许可证|开源合规|问卷|彩蛋|鉴微/,
  },
  {
    id: 'workflow', title: '工作方法', order: 160,
    test: /协作|纪律|施工|计划|验收|测试|审查|代码|交付|交接|报告|流程|规约|方法论|工作|进度|排期|任务|审计|待办|决策|拍板|规范|规则|原则|习惯|节奏|安排|顺序|分期|实施|落地|检查|核对|修复|补丁|缺陷|回归|冒烟|基线|口径|证据|质量|脚本|工具|配置|部署|运维|升级|迁移|备份|清理|恢复|回滚|快照|日志|监控|性能|调试|排障|排查|契约|追踪|版本|误删|落库|核验|架构|模块|模式|职责|文本整理|文件写入|增量写入|写入校验|工程导入|上游维护|上游仓库|跑题|跑分|评测|检定|守护|日程|待定|交互澄清|错误处理|生产状态|验证|接口设计|技术选型|操作坑|操作兜底|导入铁律|文件格式|文件位置|源文件结构|数据治理|数据完整性|数据一致性|数据补充|数据规模|数据抢救|上线自检|批量处理/,
  },
  {
    id: 'knowledge', title: '知识方法', order: 170,
    test: /知识|方法|教训|踩坑|经验|术语|原理|参考|调研|资料|实验|文献|借鉴|评估|题库|see-now|SurfCore|排错技巧/,
  },
]

export const L1_BY_ID = new Map(L1_GROUPS.map((g) => [g.id, g]))
export const MISC_ID = 'misc'
export const MISC_TITLE = '其他'

export const normHint = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * 把一个 topicHint 归到 L1。
 * @returns {{ groupId: string, groupTitle: string, matched: boolean }}
 */
export function classifyHint(hint) {
  const h = normHint(hint)
  if (!h) return { groupId: MISC_ID, groupTitle: MISC_TITLE, matched: false }
  for (const g of L1_GROUPS) {
    if (g.test.test(h)) return { groupId: g.id, groupTitle: g.title, matched: true }
  }
  return { groupId: MISC_ID, groupTitle: MISC_TITLE, matched: false }
}

/** 用户覆盖表（可选；不存在就是空） */
export async function loadOverrides(dataRoot, personaId, joinFn, yearDirFn) {
  // 由调用方注入路径函数，避免这里直接依赖 paths（便于单测）
  try {
    const { readFile } = await import('node:fs/promises')
    const file = joinFn(yearDirFn(dataRoot, personaId), 'topic_groups.json')
    const raw = await readFile(file, 'utf8')
    const j = JSON.parse(raw)
    const o = j && typeof j === 'object' ? (j.overrides || {}) : {}
    const out = new Map()
    for (const [k, v] of Object.entries(o)) if (L1_BY_ID.has(String(v))) out.set(normHint(k), String(v))
    return out
  } catch {
    return new Map()
  }
}

/**
 * 一个 claim → L1（先查覆盖表，再按 topicHint 规则；topicId 情况也走 hint）
 * @returns {{ groupId: string, groupTitle: string, matched: boolean }}
 */
export function groupOfClaim(claim, overrides = null) {
  const h = normHint(claim?.topicHint)
  if (h && overrides && overrides.has(h)) {
    const id = overrides.get(h)
    const g = L1_BY_ID.get(id)
    if (g) return { groupId: g.id, groupTitle: g.title, matched: true }
  }
  return classifyHint(h)
}
