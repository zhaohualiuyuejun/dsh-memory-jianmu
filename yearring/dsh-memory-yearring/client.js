window.__ModuleLoader__.load({
  id: 'dsh-memory-yearring',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/year-ring'
    const STARMAP_API = '/api/jianmu-starmap'
    // UI 显示的插件版本：与 package.json 一致（发布检查会强制核对）
    const PLUGIN_VERSION = '0.4.3'

    // ── helpers ────────────────────────────────────────────────────────────
    function qs(params) {
      const u = new URLSearchParams()
      Object.keys(params || {}).sort().forEach((k) => {
        const v = params[k]
        if (v === undefined || v === null || v === '') return
        u.set(k, String(v))
      })
      const s = u.toString()
      return s ? `?${s}` : ''
    }

    function useApi(path, params, enabled, rev) {
      const [state, setState] = React.useState({ loading: Boolean(enabled), data: null, error: null })
      const url = `${API}${path}${qs({ ...(params || {}), _r: rev || 0 })}`
      React.useEffect(() => {
        if (!enabled) {
          setState({ loading: false, data: null, error: null })
          return undefined
        }
        const ac = new AbortController()
        setState((s) => ({ ...s, loading: true, error: null }))
        fetch(url, { cache: 'no-store', signal: ac.signal })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (!res.ok || !body || body.ok === false) {
              const msg = body?.error?.message || body?.message || `HTTP ${res.status}`
              const err = new Error(msg)
              err.code = body?.code || body?.error?.code || `HTTP_${res.status}`
              throw err
            }
            setState({ loading: false, data: body, error: null })
          })
          .catch((e) => {
            if (e?.name === 'AbortError') return
            setState({ loading: false, data: null, error: { message: String(e?.message || e), code: e?.code || 'API_FAILED' } })
          })
        return () => ac.abort()
      }, [url, enabled])
      return state
    }

    /** 向导：启动后台消化（POST /run；带安全头 + confirm） */
    async function postRun(body) {
      const res = await fetch(`${API}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-jianmu': '1' },
        body: JSON.stringify(body),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || !out || out.ok === false) {
        const e = new Error(out?.error?.message || out?.message || `HTTP ${res.status}`)
        e.code = out?.code || out?.error?.code || `HTTP_${res.status}`
        throw e
      }
      return out
    }

    const KIND_LABEL = {
      event: '事件', fact: '事实', preference: '偏好', boundary: '边界',
      relation: '关系', timeline: '时间线', conclusion: '结论', knowledge: '知识',
    }
    const EPI_LABEL = { fact: '原话明确', inference: '推测', hearsay: '转述', unknown: '不确定' }
    const SPEAKER_LABEL = { user: '用户说的', assistant: '助手说的', unknown: '说话人不明' }
    const STATUS_LABEL = {
      active: '有效', superseded: '已被取代', conflicted: '有矛盾',
      expired: '已过期', archived: '已归档', draft: '草稿',
    }
    const KIND_TONE = {
      event: 'muted', fact: 'brand', preference: 'ok', boundary: 'warn',
      relation: 'muted', timeline: 'muted', conclusion: 'brand', knowledge: 'ok',
    }

    const num = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : '—')
    const fmtTime = (t) => {
      if (!t) return ''
      const d = new Date(Number(t))
      if (Number.isNaN(d.getTime())) return ''
      const p = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    // ── primitives ─────────────────────────────────────────────────────────
    function Badge(props) {
      return h('span', { className: `yr-badge yr-badge-${props.tone || 'muted'}` }, props.children)
    }
    function ViewHead(props) {
      return h('div', { className: 'yr-head' },
        h('div', null,
          h('div', { className: 'yr-title' }, props.title),
          props.subtitle ? h('div', { className: 'yr-subtitle' }, props.subtitle) : null),
        h('div', { className: 'yr-head-right' },
          props.right || null,
          props.onRefresh ? h('button', { className: 'yr-btn', onClick: props.onRefresh }, '刷新') : null))
    }
    function Stat(props) {
      return h('div', { className: 'yr-stat' },
        h('div', { className: 'yr-stat-label' }, props.label),
        h('div', { className: 'yr-stat-value' }, props.value),
        props.sub ? h('div', { className: 'yr-stat-sub' }, props.sub) : null)
    }
    function Empty(props) {
      return h('div', { className: 'yr-empty' },
        h('div', { className: 'yr-empty-title' }, props.title || '暂无数据'),
        props.hint ? h('div', { className: 'yr-empty-hint' }, props.hint) : null)
    }
    function ErrorBox(props) {
      return h('div', { className: 'yr-error' },
        h('div', null, `${props.error?.code ? `[${props.error.code}] ` : ''}${props.error?.message || '请求失败'}`),
        props.onRetry ? h('button', { className: 'yr-btn yr-btn-sm', onClick: props.onRetry }, '重试') : null)
    }
    function Loading() {
      return h('div', { className: 'yr-loading' }, '读取中…')
    }

    // ── claim detail ───────────────────────────────────────────────────────
    function ClaimDetail(props) {
      const { claimId, personaId, onClose } = props
      const api = useApi('/claim', { personaId, claimId, includeText: 1 }, Boolean(claimId && personaId))
      const c = api.data?.claim
      const anchors = api.data?.anchors || []
      return h('div', { className: 'yr-detail' },
        h('div', { className: 'yr-detail-head' },
          h('div', { className: 'yr-detail-title' }, 'claim 详情'),
          h('button', { className: 'yr-btn yr-btn-sm', onClick: onClose }, '关闭')),
        api.loading ? h(Loading) : null,
        api.error ? h(ErrorBox, { error: api.error }) : null,
        c ? h('div', null,
          h('div', { className: 'yr-detail-row' },
            h(Badge, { tone: KIND_TONE[c.kind] || 'muted' }, KIND_LABEL[c.kind] || c.kind),
            h(Badge, { tone: 'muted' }, EPI_LABEL[c.epistemic] || c.epistemic),
            c.speaker ? h(Badge, { tone: c.speaker === 'assistant' ? 'warn' : 'muted' }, SPEAKER_LABEL[c.speaker] || c.speaker) : null,
            h(Badge, { tone: api.data.effectiveStatus === 'active' ? 'ok' : 'warn' }, STATUS_LABEL[api.data.effectiveStatus] || api.data.effectiveStatus),
            h('span', { className: 'yr-detail-conf' }, `置信 ${c.confidence}`)),
          h('div', { className: 'yr-detail-title-text' }, c.title),
          c.body ? h('div', { className: 'yr-detail-body' }, c.body) : null,
          h('dl', { className: 'yr-kv' },
            h('dt', null, 'claimId'), h('dd', null, c.claimId),
            h('dt', null, '分组'), h('dd', null, c.claimGroupId),
            h('dt', null, '修订'), h('dd', null, `r${c.revision}`),
            h('dt', null, '说话人'), h('dd', null, c.speaker ? `${SPEAKER_LABEL[c.speaker] || c.speaker}${c.speakerSource ? `（${c.speakerSource}）` : ''}` : '未回填'),
            h('dt', null, '主题建议'), h('dd', null, c.topicHint || '—'),
            h('dt', null, '模型'), h('dd', null, c.model || '—'),
            h('dt', null, '时间'), h('dd', null, fmtTime(c.createdAt))),
          anchors.length ? h('div', { className: 'yr-anchors' },
            h('div', { className: 'yr-anchors-title' }, `锚点（${anchors.length}）`),
            anchors.map((a, i) => h('div', { key: i, className: 'yr-anchor' },
              h('div', { className: 'yr-anchor-meta' },
                h('code', null, String(a.chunkId || '').slice(0, 12)),
                h('span', null, a.session || ''),
                h('span', null, `seq ${a.seq ?? '?'}`),
                a.quoteInChunk === false ? h(Badge, { tone: 'warn' }, '锚点已失效') : null),
              h('blockquote', { className: 'yr-quote' }, a.quote),
              a.chunkText ? h('details', { key: `t${i}`, className: 'yr-chunk' },
                h('summary', null, '查看所在块原文'),
                h('pre', null, a.chunkText)) : null))
          ) : null
        ) : null)
    }

    // ── claim cards ────────────────────────────────────────────────────────
    function ClaimCard(props) {
      const { claim, active, onClick } = props
      return h('button', {
        className: `yr-claim ${active ? 'is-active' : ''}`,
        onClick,
      },
      h('div', { className: 'yr-claim-top' },
        h(Badge, { tone: KIND_TONE[claim.kind] || 'muted' }, KIND_LABEL[claim.kind] || claim.kind),
        h(Badge, { tone: claim.status === 'active' ? 'ok' : 'warn' }, STATUS_LABEL[claim.status] || claim.status),
        claim.speaker === 'assistant' ? h(Badge, { tone: 'warn' }, SPEAKER_LABEL.assistant) : null,
        h('span', { className: 'yr-claim-conf' }, `${claim.confidence}`)),
      h('div', { className: 'yr-claim-title' }, claim.title),
      claim.body ? h('div', { className: 'yr-claim-body' }, claim.body) : null,
      h('div', { className: 'yr-claim-meta' },
        h('span', null, fmtTime(claim.createdAt)),
        claim.topicHint ? h('span', null, `· ${claim.topicHint}`) : null,
        h('span', null, `· ${claim.anchors?.length || 0} 个锚点`)))
    }

    // ── main panel ─────────────────────────────────────────────────────────
    function YearringPanel(props) {
      const personaId = props?.personaId || null
      const [rev, setRev] = React.useState(0)
      const [topicId, setTopicId] = React.useState('')
      const [groupId, setGroupId] = React.useState('')
      const [openGroup, setOpenGroup] = React.useState('')
      const [groupShown, setGroupShown] = React.useState(12)
      const [kind, setKind] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [epistemic, setEpistemic] = React.useState('')
      const [q, setQ] = React.useState('')
      const [claimId, setClaimId] = React.useState('')
      const [runBusy, setRunBusy] = React.useState(false)
      const [runMsg, setRunMsg] = React.useState(null)
      const refresh = () => setRev((x) => x + 1)

      const st = useApi('/status', { personaId }, Boolean(personaId), rev)
      const topics = useApi('/topics', { personaId, limit: 200 }, Boolean(personaId), rev)
      const claims = useApi('/claims', {
        personaId, topicId: topicId || '', groupId: groupId || '', kind, status, epistemic, q,
        limit: 100, includeText: 1,
      }, Boolean(personaId), rev)

      const s = st.data || {}
      const counts = s.counts || {}
      const eff = s.effective || {}
      const rows = claims.data?.rows || []
      const topicRows = topics.data?.rows || []
      const groupRows = topics.data?.groups || []
      const lastRun = (s.runs?.recent || [])[(s.runs?.recent || []).length - 1] || null
      const totalCost = (s.runs?.recent || []).reduce((n, r) => n + (Number(r.costYuan) || 0), 0)
      const cov = s.coverage || {}
      const uiRun = s.uiRun || null
      const running = Boolean(uiRun?.running)
      // 后台跑着的时候，每 4 秒刷新一次进度
      React.useEffect(() => {
        if (!running) return undefined
        const id = setInterval(() => setRev((x) => x + 1), 4000)
        return () => clearInterval(id)
      }, [running])
      const startRun = async (scope) => {
        setRunBusy(true)
        setRunMsg(null)
        try {
          await postRun({ personaId, scope, confirm: true })
          setRunMsg({ tone: 'ok', text: scope === 'all' ? '已开始全量后台消化' : '已开始「最近 90 天」后台消化' })
          refresh()
        } catch (e) {
          setRunMsg({ tone: 'warn', text: `${e.code ? `[${e.code}] ` : ''}${e.message || e}` })
        } finally {
          setRunBusy(false)
        }
      }

      if (!personaId) {
        return h('div', { className: 'yr-panel' },
          h('style', null, CSS),
          h(Empty, { title: '还没有解析到人格', hint: '请在页面上方选择人格，或显式指定 personaId' }))
      }

      return h('div', { className: 'yr-panel' },
        h('style', null, CSS),
        h(ViewHead, {
          title: '年轮',
          subtitle: '建木 · 认知层 · 从原话提炼的结论（带锚点）',
          onRefresh: refresh,
          right: h(Badge, { tone: 'brand' }, `v${PLUGIN_VERSION} · 只读`),
        }),
        s.degraded ? h('div', { className: 'yr-warn' }, '状态降级：建议先跑一次 jianmu_year_verify 看原因') : null,
        st.error ? h(ErrorBox, { error: st.error, onRetry: refresh }) : null,

        // 产品层兜底：首次消化向导 + 覆盖率进度（后台跑，关页面也能续）
        cov.rootChunks !== undefined
          ? h('div', { className: 'yr-run' },
            h('div', { className: 'yr-run-head' },
              h('b', null, (counts.claims || 0) === 0 ? '第一次消化' : '消化进度'),
              h(Badge, { tone: running ? 'warn' : (cov.remaining === 0 ? 'ok' : 'muted') },
                running ? '后台消化中' : (cov.remaining === 0 ? '已全部消化' : '待消化'))),
            cov.rootChunks === 0
              ? h('div', { className: 'yr-run-note' }, '根藏里还没有这个人的原话：先装根藏并摄取，年轮才有原料。')
              : h('div', { className: 'yr-run-body' },
                h('div', { className: 'yr-bar' },
                  h('div', { className: 'yr-bar-fill', style: { width: `${cov.percent || 0}%` } })),
                h('div', { className: 'yr-run-meta' }, `已覆盖 ${num(cov.covered)} / ${num(cov.rootChunks)} 块（${cov.percent || 0}%）· 剩余 ${num(cov.remaining)} 块`),
                running
                  ? h('div', { className: 'yr-run-meta' },
                    `第 ${uiRun?.rounds || 0} 轮 · 最近一轮写入 ${num(uiRun?.last?.wrote?.claims ?? 0)} 条${uiRun?.last?.remaining != null ? ` · 剩 ${num(uiRun.last.remaining)} 块` : ''}`)
                  : null,
                (!running && cov.remaining > 0)
                  ? h('div', { className: 'yr-run-actions' },
                    h('button', { className: 'yr-btn', disabled: runBusy, onClick: () => startRun('last:90d') },
                      `只消化最近 90 天（约 ${num(cov.estimate?.last90?.minutes)} 分钟 / ¥${cov.estimate?.last90?.costYuan ?? '—'}）`),
                    h('button', { className: 'yr-btn', disabled: runBusy, onClick: () => startRun('all') },
                      `全部历史（约 ${num(cov.estimate?.all?.minutes)} 分钟 / ¥${cov.estimate?.all?.costYuan ?? '—'}）`))
                  : null,
                h('div', { className: 'yr-run-note' }, '后台运行，可关闭页面；进度会保留，下次打开可续跑。'),
                uiRun?.trigger === 'auto'
                  ? h('div', { className: 'yr-run-note' }, '最近一轮由插件自动消化（不需要你在页面上点）。')
                  : null,
                s.auto
                  ? h('div', { className: 'yr-run-note' },
                    s.auto.running
                      ? '自动消化：正在后台消化…'
                      : (s.auto.enabled
                        ? `自动消化：每 ${num(s.auto.intervalMinutes)} 分钟检查一次${s.auto.nextRunAt ? ` · 下次 ${fmtTime(s.auto.nextRunAt)}` : ''}`
                        : '自动消化：已关闭（设置 → 年轮 → 自动消化）'))
                  : null,
                runMsg ? h('div', { className: `yr-run-note ${runMsg.tone === 'warn' ? 'is-warn' : ''}` }, runMsg.text) : null,
                h('div', { className: 'yr-run-note' }, cov.basis || '')))
          : null,

        h('div', { className: 'yr-stats' },
          h(Stat, { label: 'claim 总数', value: num(counts.claims), sub: `有效 ${num(eff.active ?? counts.active)}` }),
          h(Stat, { label: '主题', value: num(groupRows.length), sub: `${num(topics.data?.total ?? topicRows.length)} 个子主题` }),
          h(Stat, { label: '最近运行', value: lastRun ? fmtTime(lastRun.at) : '—', sub: lastRun ? `${lastRun.claimsWritten} 条 / ${lastRun.status}` : '还没跑过' }),
          h(Stat, { label: '近期花费', value: totalCost ? `¥${totalCost.toFixed(4)}` : '—', sub: '按估算单价' })),

        (counts.claims || 0) === 0
          ? (cov.rootChunks > 0 ? null : h(Empty, {
            title: '根藏里还没有原话',
            hint: '先装根藏并摄取；年轮从原话提炼，不凭空造。',
          }))
          : h('div', { className: 'yr-body' },
            h('div', { className: 'yr-sidebar' },
              h('div', {
                className: 'yr-sidebar-title',
                title: '年轮按关键词把 claim 归成若干组；星图按 claim 向量做语义聚类分臂。两边读的是同一份 claim 数据，只是分类方式不同，所以组数/臂数对不上是正常的。',
              }, `主题（${num(groupRows.length)} 组 · ${num(topics.data?.total ?? 0)} 子主题）`),
              h('div', { className: 'yr-hint yr-group-note' },
                '与星图同源：同一份 claim。分类不同：这里是关键词分组，星图的「旋臂」是语义聚类，所以数量不一样。'),
              h('button', {
                className: `yr-topic ${!topicId && !groupId ? 'is-active' : ''}`,
                onClick: () => { setTopicId(''); setGroupId(''); setOpenGroup('') },
              },
              h('span', { className: 'yr-topic-name' }, '全部'),
              h('span', { className: 'yr-topic-count' }, num(counts.claims))),
              groupRows.map((g) => {
                const open = openGroup === g.groupId
                const kids = g.children || []
                const shown = kids.slice(0, groupShown)
                const hidden = kids.length - shown.length
                return h('div', { key: g.groupId, className: 'yr-group-wrap' },
                  h('button', {
                    className: `yr-topic yr-group ${open ? 'is-open' : ''}`,
                    onClick: () => {
                      const next = open ? '' : g.groupId
                      setOpenGroup(next)
                      if (!open) setGroupShown(12)
                    },
                  },
                  h('span', { className: 'yr-group-arrow' }, open ? '▾' : '▸'),
                  h('span', { className: 'yr-topic-name' }, g.title),
                  h('span', { className: 'yr-topic-count' }, `${num(g.topics)}·${num(g.claims)}`)),
                  open ? h('div', { className: 'yr-sublist' },
                    h('button', {
                      className: `yr-topic yr-sub ${groupId === g.groupId ? 'is-active' : ''}`,
                      onClick: () => { setGroupId(g.groupId); setTopicId('') },
                    },
                    h('span', { className: 'yr-topic-name' }, '查看本组全部'),
                    h('span', { className: 'yr-topic-count' }, num(g.claims))),
                    shown.map((t) => h('button', {
                      key: t.topicId,
                      className: `yr-topic yr-sub ${topicId === t.topicId ? 'is-active' : ''}`,
                      onClick: () => { setTopicId(t.topicId); setGroupId('') },
                    },
                    h('span', { className: 'yr-topic-name' }, t.title || t.topicId),
                    h('span', { className: 'yr-topic-count' }, num(t.claims)))),
                    hidden > 0 ? h('button', {
                      className: 'yr-topic yr-sub yr-more',
                      onClick: () => setGroupShown(groupShown + 50),
                    }, `显示其余 ${num(hidden)} 个`) : null
                  ) : null
                )
              })),

            h('div', { className: 'yr-main' },
              h('div', { className: 'yr-filters' },
                h('select', { className: 'yr-select', value: kind, onChange: (e) => setKind(e.target.value) },
                  h('option', { value: '' }, '全部类型'),
                  Object.entries(KIND_LABEL).map(([k, v]) => h('option', { key: k, value: k }, v))),
                h('select', { className: 'yr-select', value: status, onChange: (e) => setStatus(e.target.value) },
                  h('option', { value: '' }, '全部状态'),
                  Object.entries(STATUS_LABEL).map(([k, v]) => h('option', { key: k, value: k }, v))),
                h('select', { className: 'yr-select', value: epistemic, onChange: (e) => setEpistemic(e.target.value) },
                  h('option', { value: '' }, '全部确定度'),
                  Object.entries(EPI_LABEL).map(([k, v]) => h('option', { key: k, value: k }, v))),
                h('input', {
                  className: 'yr-input', placeholder: '搜标题/正文…', value: q,
                  onChange: (e) => setQ(e.target.value),
                }),
                h('span', { className: 'yr-count' }, `${num(claims.data?.total ?? rows.length)} 条`)),

              claims.loading ? h(Loading) : null,
              claims.error ? h(ErrorBox, { error: claims.error, onRetry: refresh }) : null,
              !claims.loading && !claims.error && rows.length === 0
                ? h(Empty, { title: '这个条件下没有 claim', hint: '换个主题或清空过滤器试试' })
                : null,

              h('div', { className: 'yr-list' },
                rows.map((c) => h(React.Fragment, { key: c.claimId },
                  h(ClaimCard, {
                    claim: c,
                    active: claimId === c.claimId,
                    onClick: () => setClaimId(claimId === c.claimId ? '' : c.claimId),
                  }),
                  // 详情必须跟在被点开的那条 claim 下面，不能统一堆到列表末尾
                  claimId === c.claimId
                    ? h(ClaimDetail, {
                      claimId, personaId,
                      onClose: () => setClaimId(''),
                    })
                    : null))),

              !claimId ? h('div', { className: 'yr-hint' }, '点任意一条 claim 展开详情与原话锚点') : null))
      )
    }

    // ── css ────────────────────────────────────────────────────────────────
    const CSS = `
.yr-panel{display:flex;flex-direction:column;gap:12px;width:100%;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.yr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.yr-title{font-size:16px;font-weight:600}
.yr-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.yr-head-right{display:flex;align-items:center;gap:8px}
.yr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}
.yr-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.yr-btn-sm{padding:3px 9px;font-size:11px}
.yr-badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid transparent;white-space:nowrap}
.yr-badge-brand{background:rgba(80,140,255,.14);border-color:rgba(80,140,255,.35);color:#4a7fe0}
.yr-badge-ok{background:rgba(46,160,120,.14);border-color:rgba(46,160,120,.35);color:#2e9e78}
.yr-badge-warn{background:rgba(220,140,40,.16);border-color:rgba(220,140,40,.4);color:#b87319}
.yr-badge-muted{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.yr-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.yr-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.yr-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.yr-stat-value{font-size:18px;font-weight:600;margin-top:2px}
.yr-stat-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.yr-body{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;align-items:start}
.yr-sidebar{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.yr-sidebar-title{padding:9px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.yr-topic{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:12px}
.yr-topic:last-child{border-bottom:0}
.yr-topic:hover{background:var(--dsw-alias-bg-layer-2)}
.yr-topic.is-active{background:rgba(80,140,255,.12);font-weight:600}
.yr-topic-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yr-topic-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.yr-group-wrap{border-bottom:1px solid var(--dsw-alias-border-l1)}
.yr-group-wrap:last-child{border-bottom:0}
.yr-group-wrap .yr-topic{border-bottom:0}
.yr-group{font-weight:600}
.yr-group-arrow{width:12px;flex:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.yr-group.is-open{background:var(--dsw-alias-bg-layer-2)}
.yr-sublist{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.yr-sub{padding-left:24px;font-size:11px}
.yr-sub:hover{background:var(--dsw-alias-bg-layer-3)}
.yr-sub.is-active{background:rgba(80,140,255,.14);font-weight:600}
.yr-more{color:var(--dsw-alias-label-secondary);font-style:italic}
.yr-main{display:flex;flex-direction:column;gap:10px;min-width:0}
.yr-filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.yr-select,.yr-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:8px;padding:5px 9px;font-size:12px}
.yr-input{flex:1;min-width:140px}
.yr-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}
.yr-list{display:flex;flex-direction:column;gap:8px}
.yr-claim{display:block;width:100%;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;cursor:pointer;color:inherit}
.yr-claim:hover{background:var(--dsw-alias-bg-layer-2)}
.yr-claim.is-active{border-color:rgba(80,140,255,.55);box-shadow:0 0 0 1px rgba(80,140,255,.25)}
.yr-claim-top{display:flex;align-items:center;gap:6px}
.yr-claim-conf{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.yr-claim-title{font-weight:600;margin-top:6px}
.yr-claim-body{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.yr-claim-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:6px}
.yr-detail{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.yr-detail-head{display:flex;align-items:center;justify-content:space-between}
.yr-detail-title{font-weight:600;font-size:13px}
.yr-detail-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.yr-detail-conf{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.yr-detail-title-text{font-size:15px;font-weight:600;line-height:1.45}
.yr-detail-body{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.yr-kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}
.yr-kv dt{color:var(--dsw-alias-label-tertiary)}
.yr-kv dd{margin:0;word-break:break-all;font-family:ui-monospace,Consolas,monospace}
.yr-anchors{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
.yr-anchors-title{font-size:11px;color:var(--dsw-alias-label-secondary)}
.yr-anchor{display:flex;flex-direction:column;gap:4px}
.yr-anchor-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.yr-anchor-meta code{background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.yr-quote{margin:0;padding:8px 10px;border-left:3px solid rgba(80,140,255,.5);background:var(--dsw-alias-bg-layer-2);border-radius:0 8px 8px 0;font-size:12px}
.yr-chunk summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary)}
.yr-chunk pre{white-space:pre-wrap;word-break:break-word;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px;margin:6px 0 0;max-height:240px;overflow:auto}
.yr-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:6px 2px}
.yr-group-note{padding:2px 2px 8px;line-height:1.55;font-size:10.5px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}
.yr-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:26px 16px;text-align:center}
.yr-empty-title{font-weight:600}
.yr-empty-hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.yr-error{border:1px solid rgba(220,80,80,.4);background:rgba(220,80,80,.08);border-radius:10px;padding:10px 12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.yr-warn{border:1px solid rgba(220,140,40,.4);background:rgba(220,140,40,.1);border-radius:10px;padding:8px 12px;font-size:12px}
.yr-run{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.yr-run-head{display:flex;align-items:center;justify-content:space-between;font-size:13px}
.yr-run-body{display:flex;flex-direction:column;gap:7px}
.yr-bar{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.yr-bar-fill{height:100%;background:rgba(80,140,255,.75);border-radius:999px;transition:width .4s}
.yr-run-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.yr-run-actions{display:flex;gap:8px;flex-wrap:wrap}
.yr-run-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.yr-run-note.is-warn{color:#b87319}
.yr-loading{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 2px}
.yr-page{padding:18px 22px 34px;max-width:1280px;margin:0 auto;box-sizing:border-box;min-width:0}
.yr-persona-bar{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.yr-persona-label{color:var(--dsw-alias-label-tertiary)}
@media (max-width:900px){.yr-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.yr-body{grid-template-columns:minmax(0,1fr);gap:10px}.yr-sidebar{max-height:180px;overflow:auto}}
.yr-starmap{width:100%;height:100%;position:relative}
.yr-starmap-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,720px);
  padding:8px 14px;border-radius:10px;background:rgba(18,24,38,.94);color:#e8eefc;font-size:12px;line-height:1.5;
  border:1px solid rgba(120,170,255,.35);box-shadow:0 6px 24px rgba(0,0,0,.45)}
.yr-starmap-frame{display:block;width:100%;height:calc(100vh - 56px);min-height:560px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:#04070e}
.yr-empty{padding:26px 24px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-secondary);line-height:1.75}
.yr-empty-title{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:8px}
.yr-empty-body{font-size:12px}
.yr-empty-body code{padding:1px 5px;border-radius:4px;background:rgba(120,170,255,.12)}
`

    // ── icon ───────────────────────────────────────────────────────────────
    // 年轮图标：同心环（年轮），与记忆库的节点图标区分开
    function YearringIcon({ size = 20, active }) {
      const s = Number(size) || 20
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', display: 'block' },
      },
      h('circle', { cx: 12, cy: 12, r: 2.6 }),
      h('circle', { cx: 12, cy: 12, r: 6.6 }),
      h('path', { d: 'M12 1.6v2.2M12 20.2v2.2M1.6 12h2.2M20.2 12h2.2' }))
    }

    // 星图图标：旋臂漩涡
    function StarmapIcon({ size = 20, active }) {
      const s = Number(size) || 20
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', display: 'block' },
      },
      h('circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M3.2 12c0-2.2 2.6-3.1 4.2-1.8 2.1 1.7 1.6 4.6 4.6 4.6 2.6 0 3.6-2.2 2.3-4.1-1.4-2.1-4.7-1.7-6.4.2' }),
      h('path', { d: 'M20.8 12c0 2.2-2.6 3.1-4.2 1.8-2.1-1.7-1.6-4.6-4.6-4.6-2.6 0-3.6 2.2-2.3 4.1 1.4 2.1 4.7 1.7 6.4-.2' }))
    }

    // ── 星图页（iframe 承载 WebGL 页面；数据走 host 只读路由）──────────────
    // 构建失败时把技术日志翻成一句人话（日志尾部仍展示，方便进阶用户）
    function starmapBuildHint(code, tail) {
      const t = String(tail || '')
      if (/No module named '?numpy|ModuleNotFoundError/i.test(t)) {
        return '构建失败：这个 Python 里没有 numpy。DSH 自带 Python 已包含 numpy —— 把 JIANMU_PYTHON 指向它，或给当前 Python 装上 numpy 再试。'
      }
      if (/ENOENT|No such file|cannot find/i.test(t)) {
        return '构建失败：找不到可用的 Python。可设 JIANMU_PYTHON 指向带 numpy 的 Python（DSH 自带 Python 已含）。'
      }
      if (code === 'BUILD_RUNNING') return '已经有一个构建在跑，等它结束后再点。'
      if (code === 'SPAWN_FAILED') return '构建进程没能启动（插件目录可能不完整）。'
      return `构建失败（${code || '未知'}）。下方是日志尾部。`
    }

    function StarmapPage() {
      const [state, setState] = React.useState({ loading: true, data: null, error: null })
      const [build, setBuild] = React.useState({ busy: false, tone: 'muted', msg: null, tail: '' })
      const pollTimer = React.useRef(null)
      const aliveRef = React.useRef(true)

      const stopPoll = () => {
        try { window.clearInterval(pollTimer.current) } catch { /* 忽略 */ }
        pollTimer.current = null
      }
      const loadStatus = () => {
        fetch(`${STARMAP_API}/status`, { cache: 'no-store' })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (!res.ok || !body || body.ok === false) throw new Error(body?.error?.message || body?.message || `HTTP ${res.status}`)
            if (aliveRef.current) setState({ loading: false, data: body, error: null })
          })
          .catch((e) => { if (aliveRef.current) setState({ loading: false, data: null, error: { message: String(e?.message || e) } }) })
      }
      const startPoll = () => {
        stopPoll()
        pollTimer.current = window.setInterval(() => {
          fetch(`${STARMAP_API}/build-status`, { cache: 'no-store' })
            .then(async (res) => (await res.json().catch(() => null)))
            .then((s) => {
              if (!aliveRef.current || !s || !s.ok) return
              if (s.running) {
                setBuild({ busy: true, tone: 'muted', msg: `构建中… 已 ${Math.round((Number(s.elapsedMs) || 0) / 1000)} 秒`, tail: s.tail || '' })
                return
              }
              stopPoll()
              if (s.ok) {
                setBuild({ busy: false, tone: 'ok', msg: '星图已生成，正在载入…', tail: s.tail || '' })
                loadStatus()
              } else {
                setBuild({ busy: false, tone: 'warn', msg: starmapBuildHint(s.code, s.tail), tail: s.tail || '' })
              }
            })
            .catch(() => { /* 网络抖动就等下一轮 */ })
        }, 1500)
      }
      const startBuild = () => {
        setBuild({ busy: true, tone: 'muted', msg: '正在启动构建…', tail: '' })
        fetch(`${STARMAP_API}/build?confirm=1`, { method: 'POST' })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (!res.ok || !body || body.ok === false) {
              const code = body?.code || `HTTP_${res.status}`
              setBuild({ busy: code === 'BUILD_RUNNING', tone: 'warn', msg: starmapBuildHint(code, body?.status?.tail), tail: '' })
              if (code === 'BUILD_RUNNING') startPoll()
              return
            }
            setBuild({ busy: true, tone: 'muted', msg: '构建已开始（后台跑，可以关掉页面再回来）', tail: '' })
            startPoll()
          })
          .catch((e) => setBuild({ busy: false, tone: 'warn', msg: `构建请求没发出去：${String(e?.message || e)}`, tail: '' }))
      }

      React.useEffect(() => {
        aliveRef.current = true
        loadStatus()
        return () => { aliveRef.current = false; stopPoll() }
      }, [])

      // iframe 高度跟随宿主主面板（不让 100vh 把时间轴顶出可视区）
      const wrapRef = React.useRef(null)
      const [frameH, setFrameH] = React.useState(0)
      React.useEffect(() => {
        const el = wrapRef.current
        if (!el) return undefined
        const parent = el.parentElement
        const measure = () => {
          // 取三者最大：父容器高度、窗口底部剩余高度。否则主区底部会留一条空白
          const rect = el.getBoundingClientRect()
          const avail = window.innerHeight - rect.top - 4
          const h = Math.max(parent ? parent.clientHeight : 0, avail)
          if (h > 200) setFrameH(Math.round(h))
        }
        measure()
        let ro = null
        try {
          ro = new ResizeObserver(measure)
          if (parent) ro.observe(parent)
        } catch { /* ignore */ }
        window.addEventListener('resize', measure)
        return () => { try { ro?.disconnect() } catch { /* ignore */ } window.removeEventListener('resize', measure) }
      }, [state.loading, state.data])

      // 全屏：星图 iframe 通过 postMessage 请求「铺满宿主窗口」。
      // 原生 Fullscreen API 在 DSH 的 iframe 里可能被宿主拦，这条是兜底；Esc 退出。
      // 同一通道还承载：人格切换回写（切走侧栏再回来保持）与「在年轮打开」的 claimId 提示。
      const [expanded, setExpanded] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const toastTimer = React.useRef(null)
      React.useEffect(() => {
        const onMsg = (e) => {
          const d = e.data
          if (!d || typeof d.type !== 'string' || !d.type.startsWith('jianmu-starmap:')) return
          const fr = wrapRef.current && wrapRef.current.querySelector('iframe')
          if (!fr || e.source !== fr.contentWindow) return
          if (d.type === 'jianmu-starmap:fullscreen') { setExpanded(Boolean(d.on)); return }
          if (d.type === 'jianmu-starmap:persona') {
            const id = String(d.personaId || '')
            if (id) { try { localStorage.setItem('jianmu.starmap.personaId', id) } catch { /* ignore */ } }
            return
          }
          if (d.type === 'jianmu-starmap:open-claim') {
            setToast({ id: String(d.claimId || ''), copied: Boolean(d.copied) })
            try { window.clearTimeout(toastTimer.current) } catch { /* ignore */ }
            toastTimer.current = window.setTimeout(() => setToast(null), 6500)
          }
        }
        window.addEventListener('message', onMsg)
        return () => {
          window.removeEventListener('message', onMsg)
          try { window.clearTimeout(toastTimer.current) } catch { /* ignore */ }
        }
      }, [])
      React.useEffect(() => {
        if (!expanded) return undefined
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          setExpanded(false)
          const fr = wrapRef.current && wrapRef.current.querySelector('iframe')
          try {
            if (fr && fr.contentWindow) fr.contentWindow.postMessage({ type: 'jianmu-starmap:fullscreen-exit' }, '*')
          } catch { /* ignore */ }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [expanded])

      if (state.loading) return h('div', { className: 'yr-panel' }, h('style', null, CSS), h('div', { className: 'yr-loading' }, '读取星图…'))
      if (state.error || !state.data?.ready) {
        const msg = state.error?.message || '还没有星图数据'
        return h('div', { className: 'yr-panel' },
          h('style', null, CSS),
          h('div', { className: 'yr-empty' },
            h('div', { className: 'yr-empty-title' }, '记忆星图还没生成'),
            h('div', { className: 'yr-empty-body' }, msg),
            h('div', { className: 'yr-empty-hint' }, '生成需要带 numpy 的 Python：DSH 自带的 Python 已包含，面板会自动探测。首次构建通常 1~3 分钟。'),
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { className: 'yr-btn', disabled: build.busy, onClick: startBuild }, build.busy ? '构建中…' : '重建星图'),
              h('button', { className: 'yr-btn yr-btn-sm', onClick: loadStatus }, '刷新状态'),
              build.msg ? h('span', { className: `yr-empty-hint${build.tone === 'warn' ? ' is-warn' : ''}` }, build.msg) : null),
            build.tail
              ? h('pre', { style: { maxHeight: '160px', overflow: 'auto', fontSize: '11px', whiteSpace: 'pre-wrap', marginTop: '8px' } }, build.tail.slice(-1500))
              : null))
      }
      const personas = state.data.personas || []
      // 默认优先Alice（用户自己的星图），其次列表第一个
      let pid = personas.some((p) => p.id === 'alice') ? 'alice' : (personas[0]?.id || 'alice')
      try {
        const saved = localStorage.getItem('jianmu.starmap.personaId')
        if (saved && personas.some((p) => p.id === saved)) pid = saved
      } catch { /* ignore */ }
      const src = `${STARMAP_API}/ui/index.html?persona=${encodeURIComponent(pid)}`
      // 铺满宿主窗口（全屏兜底）：fixed 到视口四边，盖住 DSH 侧栏与内边距
      const wrapStyle = expanded
        ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2147482000, background: '#04070e', borderRadius: 0, height: '100vh' }
        : (frameH ? { height: `${frameH}px` } : undefined)
      const frameStyle = expanded
        ? { height: '100vh', border: 'none', borderRadius: 0 }
        : (frameH ? { height: `${frameH}px` } : undefined)
      return h('div', { className: 'yr-starmap', ref: wrapRef, style: wrapStyle },
        h('style', null, CSS),
        h('iframe', {
          className: 'yr-starmap-frame', title: '记忆星图', src,
          allow: 'fullscreen; clipboard-write',
          allowFullScreen: true,
          style: frameStyle,
        }),
        toast
          ? h('div', { className: 'yr-starmap-toast' },
            `claimId ${toast.copied ? '已复制' : ''}：${toast.id.slice(0, 26)}${toast.id.length > 26 ? '…' : ''} · 到「年轮」页搜索框粘贴`)
          : null)
    }

    // ── standalone page（P0-1：只装年轮时也有入口）──────────────────────────
    function StandaloneYearringPage() {
      const [manual, setManual] = React.useState(() => {
        try { return localStorage.getItem('jianmu.yearring.personaId') || '' } catch { return '' }
      })
      const ctxApi = useApi('/context', {}, true)
      const personas = ctxApi.data?.personas || {}
      const entries = Object.entries(personas)
      const resolved = ctxApi.data?.personaId || null
      const first = entries[0]?.[0] || null
      const personaId = manual || resolved || first
      const choose = (id) => {
        try { localStorage.setItem('jianmu.yearring.personaId', id) } catch { /* ignore */ }
        setManual(id)
      }
      return h('div', { className: 'yr-page' },
        h('style', null, CSS),
        entries.length > 1
          ? h('div', { className: 'yr-persona-bar' },
            h('span', { className: 'yr-persona-label' }, '当前人格'),
            h('select', {
              className: 'yr-select', value: personaId || '', onChange: (e) => choose(e.target.value),
            }, entries.map(([id, meta]) => h('option', { key: id, value: id }, meta?.displayName || id))))
          : null,
        ctxApi.error ? h(ErrorBox, { error: ctxApi.error, onRetry: () => {} }) : null,
        h(YearringPanel, { personaId }))
    }

    // ── plugin ─────────────────────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        // 把自己的 tab 注册到「记忆库」页面（熏习层的通用扩展点）。
        // 熏习不认识年轮：它只读这个数组，没注册就不显示。
        try {
          const list = (globalThis.__jianmuLibraryTabs ||= [])
          const id = 'yearring'
          const existing = list.findIndex((t) => t && t.id === id)
          const entry = {
            id,
            label: '年轮',
            order: 40,
            render: (props) => h(YearringPanel, props || {}),
          }
          if (existing >= 0) list[existing] = entry
          else list.push(entry)
        } catch (e) {
          try { ctx.logger?.warn?.('[memory-yearring] 注册 UI tab 失败：', e) } catch { /* ignore */ }
        }

        // P0-1（2026-11-08）：只装年轮、没装熏习时，「记忆库」壳不存在 →
        // 自建侧栏入口 + 主页面，保证界面找得到。判定顺序：
        //   ① 运行时 slots 里是否已有 jianmu-memory 面板（最准，惰性求值）；
        //   ② 熏习模块加载时打的全局标记（兜底，避开 apply 顺序问题）。
        if (!ctx?.slots || typeof ctx.slots.inject !== 'function') return
        const hasLibraryShell = () => {
          try {
            const entries = ctx.slots.entriesOfSlot?.('sidebar.panellist') || []
            if (entries.some((e) => (e?.options?.id || e?.id) === 'jianmu-memory')) return true
          } catch { /* ignore */ }
          try { return Boolean(globalThis.__jianmuLibraryShell) } catch { return false }
        }
        const noop = () => {}
        ctx.slots.inject('sidebar.panellist', () => {
          if (hasLibraryShell()) return noop
          return ctx.slots.register({
            name: 'sidebar.panellist', id: 'jianmu-yearring', order: 27,
            label: () => '年轮',
          }, YearringIcon)
        })
        ctx.slots.inject('main', () => {
          if (hasLibraryShell()) return noop
          return ctx.slots.register({
            name: 'main', key: 'jianmu-yearring', locale: 'jianmu-yearring',
          }, () => h(StandaloneYearringPage))
        })

        // 星图：独立侧栏入口（无论有没有记忆库壳都注册）
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'jianmu-starmap', order: 28, label: () => '星图',
        }, StarmapIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'jianmu-starmap',
        }, () => h(StarmapPage)))
      },
    }
  },
})
