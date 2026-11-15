window.__ModuleLoader__.load({
  id: 'dsh-memory-process',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/memory-process'
    // UI 显示的插件版本：与 package.json 一致（发布检查会强制核对，别再手写 v1a/v2）
    const PLUGIN_VERSION = '0.2.7'
    const PERSONA_KEY = 'jianmu.memory.persona'
    // P0-1（2026-11-08）：给「记忆库」壳打一个加载期标记。
    // 年轮等寄生层在渲染前读它，决定要不要自建独立侧栏入口；
    // 模块求值早于渲染，所以与插件 apply 顺序无关。卸载本插件后标记自然消失。
    try { globalThis.__jianmuLibraryShell = { id: 'jianmu-memory', version: 1, since: '2026-11-08' } } catch { /* ignore */ }
    // 镜台（人格卡）如果装了，就把它的主面板切出来；没装时 tab 不出现。
    // ⚠️ 不要在 apply 时缓存 layout：宿主注册服务的时机可能晚于本插件，
    // 缓存到 null 会让「人格卡」tab 与「打开记忆库」按钮静默失效（2026-11-07 实机）。
    let layoutRef = null
    let ctxRef = null
    function resolveLayout() {
      try {
        const live = ctxRef?.get?.('layout')
        if (live) return live
      } catch { /* ignore */ }
      return layoutRef
    }
    function openPersonaPanel() {
      try { resolveLayout()?.selectPanel?.('jianmu-persona') } catch { /* ignore */ }
    }

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

    function useApi(path, params, enabled, rev, base = API) {
      const [state, setState] = React.useState({ loading: Boolean(enabled), data: null, error: null })
      const url = `${base}${path}${qs({ ...(params || {}), _r: rev || 0 })}`
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

    /**
     * 只探测「别的层装没装」用的轻量 GET。
     * 只读、同源；404/非 JSON/非 ok 一律当「未安装」，不冒充可用。
     */
    function useProbe(path, enabled, rev) {
      const [state, setState] = React.useState({ ok: null, data: null })
      React.useEffect(() => {
        if (!enabled) return undefined
        let alive = true
        fetch(path, { cache: 'no-store' })
          .then(async (res) => {
            const body = await res.json().catch(() => null)
            if (alive) setState({ ok: Boolean(res.ok && body && body.ok !== false), data: body })
          })
          .catch(() => { if (alive) setState({ ok: false, data: null }) })
        return () => { alive = false }
      }, [path, enabled, rev])
      return state
    }

    // ── write helpers（P1-1：显式确认后的写动作）────────────────────────────
    // 安全：POST + content-type + x-dsh-jianmu:1（自定义头，跨源要预检必被拒）；
    // 每个写动作都带 confirm:true 与 expectedGeneration，后端再校验一次。
    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-dsh-jianmu': '1' }
    const WRITE_ERROR_TEXT = {
      STALE_GENERATION: '有人先改过了（generation 变了），已刷新，请重新确认',
      STALE_ROOT: '根藏已更新，旧候选作废：请重新跑熏习生成候选',
      PENDING_NOT_PENDING: '这条候选已经被处理过了',
      LOCK_BUSY: '另一个写动作正在执行，请稍后重试',
      CONFIRM_REQUIRED: '需要确认后才写入',
      CSRF_GUARD: '缺少安全头（可能是旧页面，刷新后重试）',
      CROSS_ORIGIN: '拒绝跨源写动作',
      EMPTY_ROOT: '根藏为空：先装根藏并摄取',
      CHUNK_NOT_FOUND: '根藏里已经找不到这个块了',
    }
    const writeErrText = (e) => WRITE_ERROR_TEXT[e?.code] || `${e?.code ? `[${e.code}] ` : ''}${e?.message || '写入失败'}`
    async function postWrite(path, body) {
      let res
      try {
        res = await fetch(`${API}${path}`, {
          method: 'POST', headers: WRITE_HEADERS, cache: 'no-store', body: JSON.stringify(body || {}),
        })
      } catch (e) {
        const err = new Error(`请求失败：${String(e?.message || e)}`)
        err.code = 'NETWORK_ERROR'
        throw err
      }
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) {
        const err = new Error(data?.error?.message || data?.message || `HTTP ${res.status}`)
        err.code = data?.code || data?.error?.code || `HTTP_${res.status}`
        err.status = res.status
        throw err
      }
      return data
    }

    function WriteMsg({ msg, onClose }) {
      if (!msg) return null
      return h('div', { className: `jm-msg jm-msg-${msg.tone || 'info'}` },
        h('span', null, msg.text),
        onClose ? h('button', { className: 'jm-msg-x', onClick: onClose, title: '关闭' }, '×') : null)
    }
    function ConfirmInline({ text, danger, busy, onConfirm, onCancel }) {
      return h('div', { className: `jm-confirm ${danger ? 'jm-confirm-danger' : ''}` },
        h('span', { className: 'jm-confirm-text' }, text),
        h('div', { className: 'jm-confirm-actions' },
          h('button', { className: 'jm-btn jm-btn-sm', onClick: onCancel, disabled: busy }, '取消'),
          h('button', { className: `jm-btn jm-btn-sm ${danger ? 'jm-btn-danger' : ''}`, onClick: onConfirm, disabled: busy }, busy ? '写入中…' : '确认')))
    }

    function storedPersona() {
      try { return localStorage.getItem(PERSONA_KEY) || null } catch { return null }
    }    function savePersona(id) {
      try { if (id) localStorage.setItem(PERSONA_KEY, id) } catch { /* ignore */ }
    }

    function usePersona(workspace, sessionId) {
      const [manual, setManual] = React.useState(() => storedPersona())
      const [override, setOverride] = React.useState(null)
      // 会话视图：host 侧按「活会话 cwd → 根藏同 session 块」解析 persona；不让客户端猜
      const ctx = useApi('/context', sessionId ? { session: sessionId } : (workspace ? { workspace } : {}), true)
      const personas = ctx.data?.personas || {}
      const first = Object.keys(personas)[0] || null
      const resolved = ctx.data?.personaId || null
      const personaId = override || resolved || manual || first
      const scoped = useApi('/context', personaId ? { personaId } : {}, Boolean(personaId))
      React.useEffect(() => {
        // 只有「按工作区显式解析」的结果写全局偏好；会话解析结果不串到记忆库
        if (!sessionId && resolved) {
          savePersona(resolved)
          if (manual !== resolved) setManual(resolved)
        }
      }, [resolved, sessionId])
      const choose = (id) => {
        savePersona(id)
        setManual(id)
        setOverride(id)
      }
      return {
        personaId,
        personas,
        context: ctx.data,
        scoped: scoped.data,
        loading: ctx.loading || scoped.loading,
        error: ctx.error || scoped.error,
        choose,
        sessionUnresolved: Boolean(sessionId) && !ctx.loading && !resolved,
        sessionSource: ctx.data?.sessionSource || null,
        sessionCwd: ctx.data?.sessionCwd || null,
      }
    }

    function bytes(n) {
      if (!Number.isFinite(Number(n))) return '—'
      const v = Number(n)
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
      return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
    }
    function time(ts) {
      if (!Number.isFinite(Number(ts))) return '—'
      try { return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) } catch { return '—' }
    }
    // manifest 里的 builtAt 是 UTC ISO 字符串；显示时换成用户本地时区，别直接切字符串
    function isoLocal(s) {
      if (!s) return '—'
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return String(s)
      try { return d.toLocaleString('zh-CN', { hour12: false }) } catch { return String(s) }
    }
    function num(n) {
      if (!Number.isFinite(Number(n))) return '—'
      return Number(n).toLocaleString('zh-CN')
    }
    function toneForStatus(s) {
      if (s === 'active') return 'success'
      if (s === 'superseded') return 'warn'
      if (s === 'expired' || s === 'archived') return 'idle'
      return 'idle'
    }
    function toneForEpistemic(s) {
      if (s === 'fact') return 'success'
      if (s === 'inference') return 'brand'
      if (s === 'hypothesis') return 'warn'
      if (s === 'quote') return 'idle'
      return 'idle'
    }
    function toneForSensitivity(s) {
      if (s === 'sensitive') return 'error'
      if (s === 'boundary') return 'warn'
      return 'idle'
    }
    function labelStatus(s) {
      return ({ active: '正常', superseded: '已取代', expired: '过期', archived: '归档', unprocessed: '未处理' })[s] || s || '—'
    }
    function labelEpistemic(s) {
      return ({ fact: '事实', inference: '推断', hypothesis: '假设', quote: '转述', unknown: '未知' })[s] || s || '—'
    }
    function labelAttribution(s) {
      return ({ user: '用户', assistant: '助手', 'third-party': '第三方', tool: '工具', unknown: '未知' })[s] || s || '—'
    }
    function labelSensitivity(s) {
      return ({ normal: '正常', boundary: '边界', sensitive: '敏感' })[s] || s || '—'
    }

    // ── atoms ──────────────────────────────────────────────────────────────
    function Badge({ tone = 'idle', children, title }) {
      return h('span', { className: `jm-badge jm-badge-${tone}`, title }, children)
    }
    function Card({ title, kicker, right, children, className }) {
      return h('section', { className: `jm-card ${className || ''}` },
        h('header', { className: 'jm-card-head' },
          h('div', null,
            kicker ? h('div', { className: 'jm-kicker' }, kicker) : null,
            h('h3', { className: 'jm-card-title' }, title)),
          right || null),
        h('div', { className: 'jm-card-body' }, children))
    }
    function Stat({ label, value, sub, tone }) {
      return h('div', { className: 'jm-stat' },
        h('div', { className: 'jm-stat-label' }, label),
        h('div', { className: `jm-stat-value ${tone ? `jm-tone-${tone}` : ''}` }, value),
        sub ? h('div', { className: 'jm-stat-sub' }, sub) : null)
    }
    function Bar({ segments }) {
      const total = segments.reduce((s, x) => s + (Number(x.value) || 0), 0) || 1
      return h('div', { className: 'jm-bar', role: 'img', 'aria-label': segments.map((x) => `${x.label} ${x.value}`).join('，') },
        segments.map((x, i) => h('span', {
          key: i,
          className: `jm-bar-seg jm-seg-${x.tone || 'idle'}`,
          style: { width: `${Math.max(0, (Number(x.value) || 0) / total * 100)}%` },
          title: `${x.label}：${x.value}`,
        })))
    }
    function Loading({ text = '读取中…' }) {
      return h('div', { className: 'jm-state' }, h('span', { className: 'jm-spinner' }), text)
    }
    function ErrorBox({ error, onRetry }) {
      // 新装 / 首导入后还没 identity.json 是正常一步，不是故障：给中文指路，别用红色「读取失败」吓人
      const code = error?.code
      if (code === 'IDENTITY_MISSING' || code === 'IDENTITY_CORRUPT') {
        const missing = code === 'IDENTITY_MISSING'
        return h('div', { className: 'jm-empty' },
          h('div', null,
            h('strong', null, missing ? '还没有人格身份（identity.json）' : 'identity.json 读不出来'),
            h('div', null, missing
              ? '这不是故障：刚装好或刚导入时还没有身份文件，所以记忆库先显示为空。'
              : '身份文件存在但格式不对，修好后点「重试」。'),
            h('div', null, missing
              ? '下一步：打开侧栏「人格卡」→「一键登记」（或让 AI 调 jianmu_store_identity_add_persona），登记后回到本页点「重试」。'
              : `详情：${error?.message || 'identity.json 不可读'}`),
            h('div', { className: 'jm-error-code' }, code)),
          onRetry ? h('button', { className: 'jm-btn', onClick: onRetry }, '重试') : null)
      }
      return h('div', { className: 'jm-error' },
        h('div', null,
          h('strong', null, '读取失败'),
          h('div', { className: 'jm-error-detail' }, error?.message || String(error || '未知错误')),
          error?.code ? h('div', { className: 'jm-error-code' }, error.code) : null),
        onRetry ? h('button', { className: 'jm-btn', onClick: onRetry }, '重试') : null)
    }
    function Empty({ children }) {
      return h('div', { className: 'jm-empty' }, children)
    }
    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error, info) { try { console.error('[jianmu-memory] view crashed', error, info) } catch { /* ignore */ } }
      render() {
        if (this.state.error) {
          return h('div', { className: 'jm-error' },
            h('div', null,
              h('strong', null, '视图渲染失败'),
              h('div', { className: 'jm-error-detail' }, String(this.state.error?.message || this.state.error))))
        }
        return this.props.children
      }
    }

    function ViewHead({ title, subtitle, right, onRefresh }) {
      return h('div', { className: 'jm-head' },
        h('div', { className: 'jm-head-main' },
          h('div', { className: 'jm-title-row' },
            h('h1', { className: 'jm-title' }, title),
            h('span', { className: 'jm-readonly', title: '熏习按规则自动维护；这里只展示，不需要手动操作' }, '自动维护')),
          h('div', { className: 'jm-subtitle' }, subtitle)),
        h('div', { className: 'jm-head-actions' },
          right || null,
          onRefresh ? h('button', { className: 'jm-btn', onClick: onRefresh, title: '刷新' }, '刷新') : null))
    }

    // ── 只读原话看板（P1-4：没根藏时，熏习单独可用的模式）──────────────────
    // 数据源不是根藏，而是 DSH 会话本身；只读、无写动作、无 LLM。
    const SOURCE_API = '/api/memory-process/source'

    function SessionDashboardPage() {
      const [days, setDays] = React.useState(7)
      const [ws, setWs] = React.useState('')
      const [role, setRole] = React.useState('')
      const [qInput, setQInput] = React.useState('')
      const [q, setQ] = React.useState('')
      const [offset, setOffset] = React.useState(0)
      const [selected, setSelected] = React.useState(null)
      const [rev, setRev] = React.useState(0)
      const limit = 100
      const st = useApi('/status', { days, refresh: rev ? 1 : 0 }, true, rev, SOURCE_API)
      const wss = useApi('/workspaces', { days, refresh: rev ? 1 : 0 }, true, rev, SOURCE_API)
      const listApi = useApi('/memories', { days, ws, role, q, limit, offset, refresh: rev ? 1 : 0 }, true, rev, SOURCE_API)
      const s = st.data || {}
      const rows = listApi.data?.rows || []
      const total = listApi.data?.total || 0
      const workspaces = wss.data?.rows || []
      const pages = Math.max(1, Math.ceil(total / limit))
      const page = Math.floor(offset / limit) + 1
      const refresh = () => setRev((x) => x + 1)
      const applySearch = () => { setQ(qInput); setOffset(0) }
      const clear = () => { setQInput(''); setQ(''); setRole(''); setWs(''); setOffset(0) }
      const chosen = (selected && rows.find((r) => r.chunkId === selected)) || rows[0] || null
      return h('div', { className: 'jm-page jm-library' },
        h('style', null, CSS),
        h(ViewHead, {
          title: '原话看板',
          subtitle: '建木 · 只读 · 直接读 DSH 会话（不依赖根藏）',
          onRefresh: refresh,
          right: h(Badge, { tone: 'brand' }, `v${PLUGIN_VERSION} · 只读`),
        }),
        h('div', { className: 'jm-empty-guide' },
          h('div', { className: 'jm-empty-guide-title' }, '没检测到根藏数据 → 已切换到只读看板'),
          h('div', { className: 'jm-empty-guide-text' },
            '本页直接读取 DSH 会话，把用户/助手的原话按工作区汇总。它不写任何文件、不调 LLM、不做嵌入；要使用记忆状态与熏习规则，请另装根藏。')),
        st.error ? h(ErrorBox, { error: st.error, onRetry: refresh }) : null,
        h('div', { className: 'jm-stat-grid' },
          h(Stat, { label: '工作区', value: num(s.workspaces), sub: s.days ? `近 ${s.days} 天` : '—' }),
          h(Stat, { label: '会话', value: num(s.sessions), sub: `${num(s.files)} 个会话文件` }),
          h(Stat, { label: '原话块', value: num(s.utterances), sub: '1200 字 / 块' }),
          h(Stat, { label: '缓存文件', value: num(s.cachedFiles), sub: '只读内存缓存' })),
        h('div', { className: 'jm-filterbar' },
          h('select', { className: 'jm-select', value: String(days), onChange: (e) => { setDays(Number(e.target.value)); setOffset(0) } },
            h('option', { value: '7' }, '近 7 天'), h('option', { value: '30' }, '近 30 天'), h('option', { value: '90' }, '近 90 天')),
          h('select', { className: 'jm-select', value: ws, onChange: (e) => { setWs(e.target.value); setOffset(0) } },
            h('option', { value: '' }, '全部工作区'),
            workspaces.map((w) => h('option', { key: w.ws, value: w.ws }, `${w.ws}（${num(w.utterances)}）`))),
          h('select', { className: 'jm-select', value: role, onChange: (e) => { setRole(e.target.value); setOffset(0) } },
            h('option', { value: '' }, '全部角色'),
            h('option', { value: 'user' }, '用户'), h('option', { value: 'assistant' }, '助手')),
          h('input', {
            className: 'jm-input jm-search', value: qInput, placeholder: '搜索原话（本地子串）',
            onChange: (e) => setQInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') applySearch() },
          }),
          h('button', { className: 'jm-btn', onClick: applySearch }, '搜索'),
          h('span', { className: 'jm-filter-count' }, `${num(total)} 条`),
          h('button', { className: 'jm-btn jm-btn-ghost', onClick: clear }, '清空')),
        h('div', { className: 'jm-split' },
          h('div', { className: 'jm-list' },
            listApi.loading && !rows.length ? h(Loading) : null,
            listApi.error ? h(ErrorBox, { error: listApi.error, onRetry: refresh }) : null,
            !listApi.loading && !listApi.error && rows.length === 0 ? h(Empty, null, '这段时间没有原话：换个天数或清空筛选试试') : null,
            h('div', { className: 'jm-mem-head' },
              h('span', null, '时间'), h('span', null, '角色'), h('span', null, '工作区 · 原话摘要'), h('span', null, '来源')),
            rows.map((row) => h('button', {
              key: row.chunkId,
              className: `jm-mem-row ${chosen && chosen.chunkId === row.chunkId ? 'is-selected' : ''}`,
              onClick: () => setSelected(row.chunkId),
              title: row.text,
            },
            h('span', { className: 'jm-mem-time' }, time(row.t)),
            h('span', { className: 'jm-mem-role' }, row.role === 'assistant' ? '助手' : row.role === 'user' ? '用户' : row.role),
            h('span', { className: 'jm-mem-preview' }, `${row.ws || '—'} · ${row.text.slice(0, 90)}`),
            h('span', { className: 'jm-mem-badges' }, h(Badge, { tone: 'idle' }, row.sourceType || '会话')))),
            h('div', { className: 'jm-pager' },
              h('button', { className: 'jm-btn jm-btn-sm', disabled: page <= 1, onClick: () => setOffset(Math.max(0, offset - limit)) }, '上一页'),
              h('span', null, `${page} / ${pages}`),
              h('button', { className: 'jm-btn jm-btn-sm', disabled: page >= pages, onClick: () => setOffset(offset + limit) }, '下一页'))),
          h('aside', { className: 'jm-detail-pane' },
            chosen
              ? h('div', { className: 'jm-detail' },
                h('div', { className: 'jm-detail-head' },
                  h('div', null,
                    h('div', { className: 'jm-kicker' }, 'UTTERANCE'),
                    h('div', { className: 'jm-detail-time' }, `${time(chosen.t)} · ${chosen.ws}`)),
                  h('div', { className: 'jm-detail-badges' },
                    h(Badge, { tone: chosen.role === 'user' ? 'brand' : 'idle' },
                      chosen.role === 'user' ? '用户' : chosen.role === 'assistant' ? '助手' : chosen.role))),
                h('div', { className: 'jm-detail-text' }, chosen.text),
                h('div', { className: 'jm-detail-meta' },
                  h('div', null, h('span', null, '会话'), h('b', { className: 'jm-mono' }, chosen.session)),
                  h('div', null, h('span', null, 'seq / part'), h('b', null, `${chosen.seq ?? '—'} / ${chosen.part ?? 0}`)),
                  h('div', null, h('span', null, 'messageId'), h('b', { className: 'jm-mono' }, chosen.msgId || '—')),
                  h('div', null, h('span', null, '工作区'), h('b', { className: 'jm-mono' }, chosen.ws || '—')),
                  h('div', null, h('span', null, '来源'), h('b', null, chosen.sourceType || '—'))),
                h('div', { className: 'jm-footnote' }, '只读：本页不写任何文件；原话可能含未脱敏内容，请勿在群聊展示。'))
              : h(Empty, null, '选择左侧一条原话查看详情')))
      )
    }

    // ── icon ───────────────────────────────────────────────────────────────
    function MemoryIcon({ size = 20, active }) {
      const s = Number(size) || 20
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', display: 'block' },
      },
      h('path', { d: 'M12 3v4M12 17v4M5.5 7.5l3.5 2M15 14.5l3.5 2M5.5 16.5l3.5-2M15 9.5l3.5-2' }),
      h('circle', { cx: 12, cy: 12, r: 3.2 }),
      h('circle', { cx: 12, cy: 3, r: 1.4 }),
      h('circle', { cx: 12, cy: 21, r: 1.4 }),
      h('circle', { cx: 4.5, cy: 7, r: 1.4 }),
      h('circle', { cx: 19.5, cy: 7, r: 1.4 }),
      h('circle', { cx: 4.5, cy: 17, r: 1.4 }),
      h('circle', { cx: 19.5, cy: 17, r: 1.4 }))
    }

    // ── persona bar ────────────────────────────────────────────────────────
    function PersonaBar({ personaId, personas, onChoose, context }) {
      const entries = Object.entries(personas || {})
      if (entries.length === 0) return null
      return h('div', { className: 'jm-persona-bar' },
        h('span', { className: 'jm-persona-label' }, '当前人格'),
        entries.length === 1
          ? h('span', { className: 'jm-persona-name' }, entries[0][1]?.displayName || entries[0][0])
          : h('select', {
            className: 'jm-select',
            value: personaId || '',
            onChange: (e) => onChoose(e.target.value),
          }, entries.map(([id, p]) => h('option', { key: id, value: id }, p?.displayName || id))),
        context?.scopes?.length
          ? h('span', { className: 'jm-persona-scopes' }, context.scopes.map((s) => `${s.displayName || s.personaId} ${num(s.chunks)}`).join(' · '))
          : null,
        h('span', { className: 'jm-persona-note' }, '一次只显示一个人格；不混合、不跨人格检索'))
    }

    // ── overview tab ───────────────────────────────────────────────────────
    function OverviewTab({ personaId, rev, onGoPending }) {
      const api = useApi('/overview', { personaId }, Boolean(personaId), rev)
      // 人格归属诊断（P4 第 1 步）：不依赖当前 persona，所以不带参数。
      // ⚠️ 必须在任何 early return 之前调用——hook 顺序一变就是 React #310（2026-11-12 踩过）。
      const life = useApi('/lifecycle', {}, true, rev)
      if (!personaId) return h(Empty, null, '未解析当前人格')
      if (api.loading && !api.data) return h(Loading)
      if (api.error) return h(ErrorBox, { error: api.error })
      const d = api.data || {}
      const root = d.rootStorage || {}
      const eff = d.states?.effective || {}
      const vec = root.vectors || {}
      const warn = [...new Set([...(d.warnings || []), ...(root.warnings || [])])]
      const ls = life.data?.summary || null
      const statusSegments = [
        { label: '正常', value: eff.active || 0, tone: 'success' },
        { label: '已取代', value: eff.superseded || 0, tone: 'warn' },
        { label: '过期', value: eff.expired || 0, tone: 'warn' },
        { label: '归档', value: eff.archived || 0, tone: 'idle' },
      ]
      const healthTone = d.degraded ? 'warn' : 'success'
      return h('div', { className: 'jm-tab-body' },
        root.empty
          ? h('div', { className: 'jm-empty-guide' },
            h('div', { className: 'jm-empty-guide-title' }, '还没有根藏数据'),
            h('div', { className: 'jm-empty-guide-text' }, d.emptyHint || '根藏里还没有原话：先装根藏并摄取。'),
            h('ol', { className: 'jm-empty-guide-steps' },
              h('li', null, '确认根藏插件（dsh-memory-store）已安装并启用'),
              h('li', null, '在会话里摄取原话（或等待自动摄取），根藏出现块'),
              h('li', null, '回到本页刷新：记忆 / 待处理 / 年轮才会有数据')))
          : null,
        warn.length ? h('div', { className: 'jm-warn-line' }, warn.slice(0, 3).join('；')) : null,
        h('div', { className: 'jm-grid' },
          h(Card, {
            title: '根藏存储', kicker: 'STORAGE',
            right: h(Badge, { tone: root.ok ? (root.degraded ? 'warn' : 'success') : 'error' }, root.ok ? (root.degraded ? '部分可用' : '正常') : '不可读'),
          },
          h('div', { className: 'jm-stat-grid' },
            h(Stat, { label: '原话块', value: num(root.chunks ?? d.root?.chunks), sub: `${num(d.states?.processed)} 已处理` }),
            h(Stat, { label: '根藏体积', value: bytes(root.volumeBytes), sub: `${root.files?.length ?? 0} 个文件` }),
            h(Stat, { label: '向量行', value: num(vec.rows), sub: vec.missing ? `缺 ${num(vec.missing)} 块` : '完整', tone: vec.missing ? 'warn' : 'success' }),
            h(Stat, { label: '覆盖天数', value: root.coverageDays != null ? `${root.coverageDays} 天` : '—', sub: root.builtAt ? `建于 ${isoLocal(root.builtAt)}` : '—' }))),
          h(Card, {
            title: '记忆状态', kicker: 'STATE',
            right: h(Badge, { tone: healthTone }, d.degraded ? '需关注' : '健康'),
          },
          h('div', null,
            h('div', { className: 'jm-big-number' }, num(d.states?.unique ?? 0), h('span', null, ' 条记忆')),
            h(Bar, { segments: statusSegments }),
            h('div', { className: 'jm-legend' }, statusSegments.map((x, i) => h('span', { key: i, className: 'jm-legend-item' },
              h('i', { className: `jm-dot jm-seg-${x.tone}` }), `${x.label} ${num(x.value)}`))))),
          h(Card, {
            title: '待处理', kicker: 'INBOX',
            right: onGoPending ? h('button', { className: 'jm-btn jm-btn-sm', onClick: onGoPending }, '查看') : null,
          },
          h('div', { className: 'jm-stat-grid' },
            h(Stat, { label: '取代/归档候选', value: num(d.pending?.pending), sub: '默认不自动应用', tone: d.pending?.pending ? 'warn' : 'success' }),
            h(Stat, { label: '重复组', value: num(d.duplicates?.pending), sub: `精确 ${num(d.duplicates?.exact)} / 近重复 ${num(d.duplicates?.near)}` }),
            h(Stat, { label: '未解释矛盾', value: num(d.conflicts?.open), sub: '不自动裁决', tone: d.conflicts?.open ? 'warn' : 'success' }),
            h(Stat, { label: '主题归属', value: '系统维护', sub: '正文归年轮' })),
          h('div', { className: 'jm-footnote' }, '候选由规则自动归纳；在本页查看或标记，都不改变 AI 的记忆与检索。')),
          h(Card, {
            title: '人格归属', kicker: 'PERSONA',
            right: h(Badge, { tone: ls ? (ls.healthy ? 'success' : 'warn') : 'idle' }, ls ? (ls.healthy ? '正常' : '需关注') : '加载中'),
          },
          h('div', { className: 'jm-stat-grid' },
            h(Stat, {
              label: '无卡人格', value: num(ls?.cardless ?? 0), sub: '有记忆、没卡；仍在继续记',
              tone: ls?.cardless ? 'warn' : 'success',
            }),
            h(Stat, {
              label: '未注册卡', value: num(ls?.unregistered ?? 0), sub: '有卡、根藏不认识',
              tone: ls?.unregistered ? 'warn' : 'success',
            }),
            h(Stat, {
              label: '未归属块',
              value: num(ls?.unassignedChunks ?? 0),
              sub: ls?.unassignedClaimed
                ? `其中 ${num(ls.unassignedClaimed)} 条已软认领（可检索）`
                : '存着但检索不到',
              tone: (ls?.unassignedChunks ?? 0) > (ls?.unassignedClaimed ?? 0) ? 'warn' : 'success',
            })),
          h('div', { className: 'jm-footnote' },
            (life.data && !ls?.healthy)
              ? [
                ...(life.data.cardlessPersonas || []).map((p) => `无卡：${p.displayName}（${num(p.chunks)} 块）`),
                ...(life.data.unregisteredCards || []).map((c) => `未注册：${c.name}`),
                ...((life.data.unassigned?.byWorkspace) || []).map((w) => (w.claimedBy
                  ? `${w.ws}：${num(w.chunks)} 条已软认领到 ${w.claimedBy}`
                  : `${w.ws}：${num(w.chunks)} 条未归属`)),
                '—— 建卡后需让根藏认识这个工作区；软认领只补映射、不搬数据。',
              ].join('；')
              : '人格卡、根藏人格表与记忆归属一致；未发现孤儿。')),
          h(Card, {
            title: '处理状态', kicker: 'PIPELINE',
            right: h(Badge, { tone: d.lastError ? 'error' : 'success' }, d.lastError ? '有错误' : '无错误'),
          },
          h('div', { className: 'jm-kv' },
            h('div', null, h('span', null, '规则版本'), h('b', null, d.ruleVersion || '—')),
            h('div', null, h('span', null, '代际 generation'), h('b', null, d.generation ?? '—')),
            h('div', null, h('span', null, '最近运行'), h('b', null, d.lastRunAt ? time(d.lastRunAt) : '—')),
            h('div', null, h('span', null, 'LLM 调用'), h('b', null, d.llmEnabled ? '开启' : '关闭（0 调用）')),
            h('div', null, h('span', null, '处理目录'), h('b', { className: 'jm-mono' }, d.processVolume ? bytes(d.processVolume.bytes) : '—')),
            h('div', null, h('span', null, '最近错误'), h('b', { className: d.lastError ? 'jm-tone-error' : '' }, d.lastError ? `${d.lastError.code}: ${d.lastError.message}` : '无'))))),
        d.lastRunCheckpoint ? h('div', { className: 'jm-footnote' },
          `checkpoint：${num(d.lastRunCheckpoint.nextIndex)} / ${num(d.lastRunCheckpoint.total)}${d.lastRunCheckpoint.complete ? '（完成）' : '（续跑中）'}`) : null)
    }

    // ── memories tab ───────────────────────────────────────────────────────
    function MemoryRow({ row, selected, onClick }) {
      const s = row.state || {}
      return h('button', {
        className: `jm-mem-row ${selected ? 'is-selected' : ''}`,
        onClick,
        title: row.textPreview || row.chunkId,
      },
      h('span', { className: 'jm-mem-time' }, row.dateText || time(row.t)),
      h('span', { className: 'jm-mem-role' }, row.role === 'assistant' ? '助手' : row.role === 'user' ? '用户' : row.role),
      h('span', { className: 'jm-mem-preview' }, row.textPreview || '（空）'),
      h('span', { className: 'jm-mem-badges' },
        s.synthetic ? h(Badge, { tone: 'idle', title: '该块尚未进入熏习状态（默认按正常可见）' }, '未处理') : null,
        !s.synthetic ? h(Badge, { tone: toneForStatus(s.status) }, labelStatus(s.status)) : null,
        !s.synthetic ? h(Badge, { tone: toneForEpistemic(s.epistemic) }, labelEpistemic(s.epistemic)) : null,
        s.sensitivity && s.sensitivity !== 'normal' ? h(Badge, { tone: toneForSensitivity(s.sensitivity) }, labelSensitivity(s.sensitivity)) : null))
    }

    function MemoryDetail({ personaId, chunkId }) {
      const api = useApi('/memory', { personaId, chunkId }, Boolean(personaId && chunkId))
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      if (api.loading) return h(Loading)
      if (api.error) return h(ErrorBox, { error: api.error })
      const row = api.data?.row
      if (!row) return h(Empty, null, '没有详情')
      const s = row.state || {}
      const mark = async (kind) => {
        setBusy(true)
        try {
          await postWrite('/manual', { personaId, kind, chunkIds: [chunkId] })
          setMsg({ tone: 'success', text: kind === 'expire' ? '已建立「过期」候选：去「待处理」确认应用' : '已建立「归档」候选：去「待处理」确认应用' })
        } catch (e) {
          setMsg({ tone: 'error', text: writeErrText(e) })
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'jm-detail' },
        h('div', { className: 'jm-detail-head' },
          h('div', null,
            h('div', { className: 'jm-kicker' }, 'MEMORY DETAIL'),
            h('div', { className: 'jm-detail-time' }, row.dateText || time(row.t))),
          h('div', { className: 'jm-detail-badges' },
            s.synthetic
              ? h(Badge, { tone: 'idle', title: '该块尚未进入熏习状态（默认按正常可见）' }, '未处理')
              : h(React.Fragment, null,
                h(Badge, { tone: toneForStatus(s.status) }, labelStatus(s.status)),
                h(Badge, { tone: toneForEpistemic(s.epistemic) }, labelEpistemic(s.epistemic)),
                h(Badge, { tone: 'idle' }, labelAttribution(s.attribution))))),
        h('div', { className: 'jm-detail-text' }, row.text || row.textPreview || '（空）'),
        h('div', { className: 'jm-write-actions' },
          h('button', { className: 'jm-btn jm-btn-sm', disabled: busy || s.synthetic, onClick: () => mark('expire'), title: s.synthetic ? '该块还没进入熏习状态，先跑一次熏习' : '建立过期候选，去待处理确认' }, '标记过期'),
          h('button', { className: 'jm-btn jm-btn-sm', disabled: busy || s.synthetic, onClick: () => mark('archive'), title: s.synthetic ? '该块还没进入熏习状态，先跑一次熏习' : '建立归档候选，去待处理确认' }, '归档'),
          h('span', { className: 'jm-write-hint' }, '只建候选、不直接改状态；原话永不删除')),
        h(WriteMsg, { msg, onClose: () => setMsg(null) }),
        h('div', { className: 'jm-detail-meta' },
          h('div', null, h('span', null, '锚点'), h('b', { className: 'jm-mono' }, row.anchorKey || '—')),
          h('div', null, h('span', null, '会话'), h('b', { className: 'jm-mono' }, row.session || '—')),
          h('div', null, h('span', null, 'messageId'), h('b', { className: 'jm-mono' }, row.messageId || '—')),
          h('div', null, h('span', null, 'seq / part'), h('b', null, `${row.seq ?? '—'} / ${row.part ?? 0}`)),
          h('div', null, h('span', null, '来源'), h('b', null, `${row.channel || '—'} · ${row.role || '—'}`)),
          h('div', null, h('span', null, '敏感度'), h('b', null, labelSensitivity(s.sensitivity))),
          h('div', null, h('span', null, '状态理由'), h('b', null, s.synthetic ? '尚未处理（默认按正常可见）' : (s.reason || '—'))),
          h('div', null, h('span', null, 'sourceHash'), h('b', { className: 'jm-mono' }, (row.sourceHash || '—').slice(0, 18) + (row.sourceHash ? '…' : '')))),
        row.topics?.length ? h('div', { className: 'jm-topic-chips' }, row.topics.map((t) => h(Badge, { key: t.topicId, tone: 'brand' }, t.name || t.topicId))) : null)
    }

    function MemoriesTab({ personaId, rev }) {
      const [qInput, setQInput] = React.useState('')
      const [q, setQ] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [role, setRole] = React.useState('')
      const [channel, setChannel] = React.useState('')
      const [offset, setOffset] = React.useState(0)
      const [selected, setSelected] = React.useState(null)
      const limit = 50
      const api = useApi('/memories', {
        personaId, status, role, channel, q: qInput ? q : '', limit, offset,
      }, Boolean(personaId), rev)
      const d = api.data
      const rows = d?.rows || []
      const total = d?.total || 0
      const pages = Math.max(1, Math.ceil(total / limit))
      const page = Math.floor(offset / limit) + 1
      const applySearch = () => { setQ(qInput); setOffset(0) }
      const clear = () => { setQInput(''); setQ(''); setStatus(''); setRole(''); setChannel(''); setOffset(0) }
      return h('div', { className: 'jm-tab-body' },
        h('div', { className: 'jm-filterbar' },
          h('input', {
            className: 'jm-input jm-search', value: qInput, placeholder: '搜索原文（本地全文子串）',
            onChange: (e) => setQInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') applySearch() },
          }),
          h('button', { className: 'jm-btn', onClick: applySearch }, '搜索'),
          h('select', { className: 'jm-select', value: status, onChange: (e) => { setStatus(e.target.value); setOffset(0) } },
            h('option', { value: '' }, '全部状态'),
            ['active', 'superseded', 'expired', 'archived'].map((x) => h('option', { key: x, value: x }, labelStatus(x)))),
          h('select', { className: 'jm-select', value: role, onChange: (e) => { setRole(e.target.value); setOffset(0) } },
            h('option', { value: '' }, '全部角色'),
            h('option', { value: 'user' }, '用户'), h('option', { value: 'assistant' }, '助手')),
          h('select', { className: 'jm-select', value: channel, onChange: (e) => { setChannel(e.target.value); setOffset(0) } },
            h('option', { value: '' }, '全部通道'),
            ['dsh', 'qq', 'wechat', 'file'].map((x) => h('option', { key: x, value: x }, x))),
          h('span', { className: 'jm-filter-count' }, `${num(total)} 条`),
          h('button', { className: 'jm-btn jm-btn-ghost', onClick: clear }, '清空')),
        api.error ? h(ErrorBox, { error: api.error }) : null,
        h('div', { className: 'jm-split' },
          h('div', { className: 'jm-list' },
            api.loading && !rows.length ? h(Loading) : null,
            !api.loading && rows.length === 0 ? h(Empty, null, api.data?.empty ? '根藏还没有数据：先装根藏并摄取（见「概览」里的引导）' : '没有匹配的记忆') : null,
            h('div', { className: 'jm-mem-head' },
              h('span', null, '时间'), h('span', null, '角色'), h('span', null, '原文摘要'), h('span', null, '状态 / 分类')),
            rows.map((row) => h(MemoryRow, {
              key: row.chunkId, row, selected: selected === row.chunkId,
              onClick: () => setSelected(row.chunkId),
            })),
            h('div', { className: 'jm-pager' },
              h('button', { className: 'jm-btn jm-btn-sm', disabled: page <= 1, onClick: () => setOffset(Math.max(0, offset - limit)) }, '上一页'),
              h('span', null, `${page} / ${pages}`),
              h('button', { className: 'jm-btn jm-btn-sm', disabled: page >= pages, onClick: () => setOffset(offset + limit) }, '下一页'))),
          h('aside', { className: 'jm-detail-pane' },
            selected
              ? h(MemoryDetail, { personaId, chunkId: selected })
              : h(Empty, null, '选择左侧一条记忆，查看原文与锚点'))))
    }

    // ── pending tab ────────────────────────────────────────────────────────
    function CandidateChunks({ chunks, onOpen }) {
      if (!Array.isArray(chunks) || chunks.length === 0) return null
      return h('div', { className: 'jm-cand-chunks' }, chunks.map((c, i) => {
        const missing = Boolean(c.missing) || !c.chunkId
        return h('button', {
          key: c.chunkId || i,
          type: 'button',
          className: 'jm-cand-chunk jm-cand-chunk-btn',
          disabled: missing,
          title: missing ? '根藏已找不到该块' : '查看原文与锚点（只读）',
          onClick: (e) => { e.stopPropagation(); if (!missing && onOpen) onOpen(c.chunkId) },
        },
        h('span', { className: 'jm-mono jm-cand-id' }, c.chunkId ? `${c.chunkId.slice(0, 8)}…` : 'missing'),
        h('span', { className: 'jm-cand-time' }, c.dateText || time(c.t)),
        h('span', { className: 'jm-cand-role' }, c.role || '—'),
        h('span', { className: 'jm-cand-preview' }, c.textPreview || (missing ? '根藏已找不到该块' : '（空）')))
      }))
    }

    /** 只读原文弹窗：批量按 chunkId 取全文 + 锚点；不提供任何写动作。 */
    function ChunkDetailModal({ personaId, chunkIds, title, onClose }) {
      const api = useApi('/chunks', {
        personaId, chunkIds: (chunkIds || []).join(','), includeText: 1,
      }, Boolean(personaId && chunkIds && chunkIds.length))
      const rows = api.data?.rows || []
      return h('div', { className: 'jm-modal', onClick: onClose },
        h('div', { className: 'jm-modal-card', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'jm-modal-head' },
            h('div', null,
              h('div', { className: 'jm-kicker' }, 'READ ONLY'),
              h('h3', { className: 'jm-modal-title' }, title || '原文与锚点')),
            h('button', { className: 'jm-btn jm-btn-sm', onClick: onClose }, '关闭')),
          api.loading ? h(Loading) : null,
          api.error ? h(ErrorBox, { error: api.error }) : null,
          !api.loading && !api.error ? h('div', { className: 'jm-modal-body' },
            rows.length === 0 ? h(Empty, null, '没有可显示的原文（可能已被根藏清理）') : rows.map((row) => {
              const s = row.state || {}
              return h('div', { key: row.chunkId, className: 'jm-modal-item' },
                h('div', { className: 'jm-detail-head' },
                  h('div', null,
                    h('div', { className: 'jm-kicker' }, 'MEMORY DETAIL'),
                    h('div', { className: 'jm-detail-time' }, row.dateText || time(row.t))),
                  h('div', { className: 'jm-detail-badges' },
                    s.synthetic
                      ? h(Badge, { tone: 'idle' }, '未处理')
                      : h(React.Fragment, null,
                        h(Badge, { tone: toneForStatus(s.status) }, labelStatus(s.status)),
                        h(Badge, { tone: toneForEpistemic(s.epistemic) }, labelEpistemic(s.epistemic)),
                        h(Badge, { tone: 'idle' }, labelAttribution(s.attribution))))),
                h('div', { className: 'jm-detail-text' }, row.text || row.textPreview || '（空）'),
                h('div', { className: 'jm-detail-meta' },
                  h('div', null, h('span', null, '锚点'), h('b', { className: 'jm-mono' }, row.anchorKey || '—')),
                  h('div', null, h('span', null, '会话'), h('b', { className: 'jm-mono' }, row.session || '—')),
                  h('div', null, h('span', null, 'messageId'), h('b', { className: 'jm-mono' }, row.messageId || '—')),
                  h('div', null, h('span', null, 'seq / part'), h('b', null, `${row.seq ?? '—'} / ${row.part ?? 0}`)),
                  h('div', null, h('span', null, '来源'), h('b', null, `${row.channel || '—'} · ${row.role || '—'}`)),
                  h('div', null, h('span', null, '状态理由'), h('b', null, s.synthetic ? '尚未处理（默认按正常可见）' : (s.reason || '—')))))
            })) : null,
          h('div', { className: 'jm-footnote' },
            api.data?.missing?.length
              ? `缺失 ${api.data.missing.length} 块（根藏已找不到）`
              : '只读：看完关闭即可，不会改动任何东西。'))
      )
    }

    function PendingTab({ personaId, rev }) {
      const [localRev, setLocalRev] = React.useState(0)
      const [detail, setDetail] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null) // 保留：写动作由 agent 工具走，界面不提供
      const [busy, setBusy] = React.useState(false)
      // 「知道了」= 纯前端收起，localStorage 记账；不调用任何写接口，不改变记忆与检索。
      const [acked, setAcked] = React.useState(() => new Set())
      const [showAcked, setShowAcked] = React.useState(false)
      const ackKey = `jm-ack-${personaId}`
      React.useEffect(() => {
        try { setAcked(new Set(JSON.parse(localStorage.getItem(ackKey) || '[]'))) } catch { setAcked(new Set()) }
      }, [ackKey])
      const isAcked = (id) => acked.has(String(id))
      const markAcked = (id) => {
        const key = String(id)
        const next = new Set(acked)
        next.add(key)
        setAcked(next)
        try { localStorage.setItem(ackKey, JSON.stringify([...next])) } catch { /* 隐私模式：只影响本次显示 */ }
      }
      const api = useApi('/pending', { personaId }, Boolean(personaId), rev + localRev)
      if (!personaId) return h(Empty, null, '未解析当前人格')
      if (api.loading && !api.data) return h(Loading)
      if (api.error) return h(ErrorBox, { error: api.error })
      const d = api.data || {}
      const dups = d.duplicates?.rows || []
      const pend = d.rows || []
      const conf = d.conflicts?.rows || []
      const visibleDups = showAcked ? dups : dups.filter((g) => !isAcked(g.groupId))
      const visiblePend = showAcked ? pend : pend.filter((p) => !isAcked(p.pendingId))
      const ackedCount = dups.filter((g) => isAcked(g.groupId)).length + pend.filter((p) => isAcked(p.pendingId)).length
      const idsOf = (x) => ((x?.chunks || []).map((c) => c.chunkId).filter(Boolean))
      const openAll = (x, label) => {
        const ids = idsOf(x)
        if (ids.length) setDetail({ chunkIds: ids, title: label })
      }
      const openOne = (chunkId) => setDetail({ chunkIds: [chunkId], title: '单条原文与锚点' })
      const refresh = () => { setLocalRev((x) => x + 1); setConfirming(null); setMsg(null) }
      const runWrite = async (action, target) => {
        setBusy(true)
        try {
          if (action === 'apply' || action === 'dismiss') {
            await postWrite(action === 'apply' ? '/apply' : '/dismiss', {
              personaId, pendingIds: [target.pendingId], expectedGeneration: d.generation, confirm: true,
            })
          } else if (action === 'dedupe') {
            await postWrite('/manual', {
              personaId, kind: 'dedupe', chunkIds: target.chunkIds || [],
              proposed: { groupId: target.groupId, status: 'merged' },
            })
          }
          setMsg({
            tone: 'success',
            text: action === 'apply' ? '已应用：状态已写入（写前已自动快照）'
              : action === 'dismiss' ? '已驳回：只标记 dismissed，不删任何数据'
                : '已建立「去重」候选：请在上方「取代 / 归档 / 过期候选」里确认应用',
          })
          setLocalRev((x) => x + 1)
        } catch (e) {
          setMsg({ tone: 'error', text: writeErrText(e) })
          if (e.code === 'STALE_GENERATION' || e.code === 'STALE_ROOT' || e.code === 'PENDING_NOT_PENDING') setLocalRev((x) => x + 1)
        } finally {
          setBusy(false)
          setConfirming(null)
        }
      }
      return h('div', { className: 'jm-tab-body' },
        h(WriteMsg, { msg, onClose: () => setMsg(null) }),
        h('div', { className: 'jm-purpose' },
          h('b', null, '这些是什么：'),
          '熏习按规则（精确哈希 / SimHash / Jaccard / 改口规则）自动归纳的观察结果，不调 LLM。',
          h('span', null, ' 重复组＝同一句话出现多次；取代/归档/过期＝状态变更候选；未解释矛盾＝两句话互相冲突，保留双方不自动裁决。'),
          h('span', null, ' 检索层自己按规则折叠重复，不依赖本页的任何操作——查看、标记都只影响本页显示，不写任何数据。')),
        h('div', { className: 'jm-summary-chips' },
          h('span', { className: 'jm-chip' }, `取代/归档候选 ${num(d.total)}`),
          h('span', { className: 'jm-chip' }, `重复组 ${num(d.duplicates?.total)}`),
          h('span', { className: 'jm-chip' }, `未解释矛盾 ${num(d.conflicts?.total)}`),
          h('span', { className: 'jm-chip jm-chip-muted' }, '本页只读：不写数据、不改记忆与检索'),
          ackedCount > 0 ? h('button', { className: 'jm-btn jm-btn-sm jm-btn-ghost', onClick: () => setShowAcked((x) => !x) },
            showAcked ? `隐藏已看过（${ackedCount}）` : `显示已看过（${ackedCount}）`) : null),
        h('div', { className: 'jm-pending-grid' },
          h(Card, { title: '重复组', kicker: 'DUPLICATES', right: h(Badge, { tone: dups.length ? 'warn' : 'success' }, `${dups.length} 组`) },
            visibleDups.length === 0 ? h(Empty, null, dups.length ? '都标记为已看过（仅本页，不影响检索）' : '没有待处理重复组') : visibleDups.map((g) => h('div', { key: g.groupId, className: 'jm-cand-card' },
              h('div', { className: 'jm-cand-head' },
                h('b', null, g.method === 'exact' ? '精确重复' : '近重复'),
                h('span', null, `相似度 ${g.similarity ?? '—'}`),
                h('span', null, `证据 ${g.evidenceCount ?? g.chunkIds?.length ?? 0} 次`),
                h(Badge, { tone: 'idle' }, g.status),
                h('button', { className: 'jm-btn jm-btn-sm', onClick: () => markAcked(g.groupId), title: '只在本页收起；不写数据、不影响检索' }, '知道了'),
                h('button', { className: 'jm-btn jm-btn-sm jm-cand-open', onClick: () => openAll(g, (g.method === 'exact' ? '精确重复' : '近重复') + ' · 全部成员') }, '查看全文')),
              h(CandidateChunks, { chunks: g.chunks, onOpen: openOne })))),
          h(Card, { title: '取代 / 归档 / 过期候选', kicker: 'PENDING', right: h(Badge, { tone: pend.length ? 'warn' : 'success' }, `${pend.length} 条`) },
            visiblePend.length === 0 ? h(Empty, null, pend.length ? '都标记为已看过（仅本页，不影响检索）' : '没有待处理候选') : visiblePend.map((p) => h('div', { key: p.pendingId, className: 'jm-cand-card' },
              h('div', { className: 'jm-cand-head' },
                h('b', null, ({ supersede: '取代', archive: '归档', expire: '过期', dedupe: '重复', topic: '主题' })[p.kind] || p.kind),
                h('span', null, p.reason || '—'),
                h('span', null, `置信度 ${p.confidence ?? '—'}`),
                h(Badge, { tone: 'idle' }, p.status),
                h('button', { className: 'jm-btn jm-btn-sm jm-cand-open', onClick: () => openAll(p, '候选 · 涉及记忆') }, '查看全文')),
              h(CandidateChunks, { chunks: p.chunks, onOpen: openOne }),
              h('div', { className: 'jm-write-actions' },
                h('button', { className: 'jm-btn jm-btn-sm', onClick: () => markAcked(p.pendingId), title: '只在本页收起；不写数据、不影响检索' }, '知道了'))))),
          h(Card, { title: '未解释矛盾', kicker: 'CONFLICTS', right: h(Badge, { tone: conf.length ? 'warn' : 'success' }, `${conf.length} 组`) },
            conf.length === 0 ? h(Empty, null, '没有未解释矛盾') : conf.map((c) => h('div', { key: c.conflictId, className: 'jm-cand-card' },
              h('div', { className: 'jm-cand-head' },
                h('b', null, c.kind === 'unexplained-contradiction' ? '未解释矛盾' : c.kind),
                h('span', null, c.note || '保留双方，不自动裁决'),
                h(Badge, { tone: 'warn' }, c.status),
                h('button', { className: 'jm-btn jm-btn-sm jm-cand-open', onClick: () => openAll(c, '未解释矛盾 · 双方原文') }, '查看全文')),
              h(CandidateChunks, { chunks: c.chunks, onOpen: openOne }))))),
        detail ? h(ChunkDetailModal, {
          personaId, chunkIds: detail.chunkIds, title: detail.title,
          onClose: () => setDetail(null),
        }) : null)
    }

    // ── settings tab ───────────────────────────────────────────────────────
    function SettingsTab({ personaId, rev }) {
      const st = useApi('/status', { personaId }, Boolean(personaId), rev)
      const root = useApi('/root-storage', { personaId }, Boolean(personaId), rev)
      const [storageRev, setStorageRev] = React.useState(0)
      const storageApi = useApi('/storage', {}, true, (rev || 0) + storageRev)
      const capsApi = useApi('/capabilities', {}, true, rev)
      // 别的层装没装：只读探测，404/非 ok 一律当未安装，不冒充可用
      const recallProbe = useProbe('/api/session-recall/state', true, rev)
      const personaProbe = useProbe('/api/persona/status', true, rev)
      const yearRingProbe = useProbe('/api/year-ring/status', true, rev)
      const [writeMsg, setWriteMsg] = React.useState(null)
      const [confirmRebuild, setConfirmRebuild] = React.useState(false)
      const [writeBusy, setWriteBusy] = React.useState(false)
      const [snapBusy, setSnapBusy] = React.useState(false)
      const [snapMsg, setSnapMsg] = React.useState(null)
      if (!personaId) return h(Empty, null, '未解析当前人格')
      if (st.loading && !st.data) return h(Loading)
      if (st.error) return h(ErrorBox, { error: st.error })
      const d = st.data || {}
      const m = d.manifest || {}
      const cfg = d.config || {}
      const r = root.data || {}
      const caps = capsApi.data?.capabilities || {}
      const sd = storageApi.data || {}
      const g = sd.growth || {}
      // 新前端 + 旧宿主的版本错配：/storage 路由要重启 DSH 才加载，这不是数据故障
      const storagePending = Boolean(storageApi.error) && ['PERSONA_UNRESOLVED', 'HTTP_409', 'HTTP_404'].includes(storageApi.error.code)
      const layerRows = [['根藏 scopes', 'scopes'], ['熏习 process', 'process'], ['年轮 year', 'year'], ['镜台 persona', 'persona'], ['归档 _backup', '_backup']]
      const doSnapshot = async () => {
        setSnapBusy(true)
        try {
          await postWrite('/storage/snapshot', { confirm: true })
          setSnapMsg({ tone: 'success', text: '已记录快照（只追加一行；下次打开可看到真实增长）' })
          setStorageRev((n) => n + 1)
        } catch (e) {
          setSnapMsg({ tone: 'error', text: writeErrText(e) })
        } finally {
          setSnapBusy(false)
        }
      }
      // config 里可能是对象/字符串/NaN（设置层序列化差异）；只认正数，否则显示默认值
      const mcrRaw = Number(cfg.maxChunksPerRun)
      const maxChunksText = Number.isFinite(mcrRaw) && mcrRaw > 0 ? num(mcrRaw) : '20,000（默认）'
      // 模块 → 功能 两级：模块头显示装没装，功能行只说自己可不可用
      const mod = (name, layer, installed, features, desc) => h('div', { key: name, className: 'jm-cap-module' },
        h('div', { className: 'jm-cap-module-head' },
          h('b', null, name),
          h('span', { className: 'jm-cap-layer' }, layer),
          h(Badge, { tone: installed === true ? 'success' : installed === null ? 'warn' : 'idle' },
            installed === true ? '已安装' : installed === null ? '检测中' : '未安装')),
        desc ? h('div', { className: 'jm-cap-desc' }, desc) : null,
        h('div', { className: 'jm-cap-features' },
          features.map(([k, v, tone]) => h('div', { key: k, className: 'jm-cap-feature' },
            h('span', null, k),
            h(Badge, { tone: tone || 'success' }, v)))))
      const recallRootMode = recallProbe.data?.status?.dataSource === 'root'
      const doRebuild = async () => {
        setWriteBusy(true)
        try {
          await postWrite('/rebuild', { personaId, confirm: true })
          setWriteMsg({ tone: 'success', text: '已重建状态（写前自动快照；写后读回校验）' })
        } catch (e) {
          setWriteMsg({ tone: 'error', text: writeErrText(e) })
        } finally {
          setWriteBusy(false)
          setConfirmRebuild(false)
        }
      }
      return h('div', { className: 'jm-tab-body' },
        h('div', { className: 'jm-grid' },
          h(Card, { title: '熏习设置', kicker: 'PROCESS' },
            h('div', { className: 'jm-kv' },
              h('div', null, h('span', null, 'dataRoot'), h('b', { className: 'jm-mono' }, d.dataRoot || '—')),
              h('div', null, h('span', null, 'rootDataRoot'), h('b', { className: 'jm-mono' }, d.rootDataRoot || '—')),
              h('div', null, h('span', null, 'generation'), h('b', null, d.generation ?? '—')),
              h('div', null, h('span', null, 'ruleVersion'), h('b', null, d.ruleVersion || '—')),
              h('div', null, h('span', null, 'processEnabled'), h('b', null, cfg.processEnabled === false ? '关闭' : '开启')),
              h('div', null, h('span', null, 'autoMirrorRetention'), h('b', null, cfg.autoMirrorRetention === false ? '关闭' : '开启')),
              h('div', null, h('span', null, 'llmEnabled'), h('b', null, (m.llmEnabled ?? cfg.llmEnabled) ? '开启' : '关闭（默认 0 调用）')),
              h('div', null, h('span', null, 'maxChunksPerRun'), h('b', null, maxChunksText))),
            h('div', { className: 'jm-write-actions' },
              confirmRebuild
                ? h(ConfirmInline, {
                  text: '重建会按规则重算状态（写前自动快照；有用户态时会被拒绝，不会静默丢）',
                  busy: writeBusy,
                  onConfirm: doRebuild,
                  onCancel: () => setConfirmRebuild(false),
                })
                : h('button', { className: 'jm-btn jm-btn-sm', onClick: () => setConfirmRebuild(true), disabled: writeBusy }, '重建状态（rebuild）')),
            h(WriteMsg, { msg: writeMsg, onClose: () => setWriteMsg(null) })),
          h(Card, { title: '阈值', kicker: 'THRESHOLDS' },
            h('div', { className: 'jm-kv' },
              Object.entries(d.thresholds || {}).map(([k, v]) => h('div', { key: k }, h('span', null, k), h('b', null, String(v)))))),
          h(Card, { title: '根藏（只读）', kicker: 'ROOT STORAGE', right: h(Badge, { tone: r.ok ? (r.degraded ? 'warn' : 'success') : 'error' }, r.ok ? (r.degraded ? '部分可用' : '正常') : '不可读') },
            h('div', { className: 'jm-kv' },
              h('div', null, h('span', null, '块数'), h('b', null, num(r.chunks))),
              h('div', null, h('span', null, '体积'), h('b', null, bytes(r.volumeBytes))),
              h('div', null, h('span', null, '向量'), h('b', null, `${num(r.vectors?.rows)} 行 / 缺 ${num(r.vectors?.missing)}`)),
              h('div', null, h('span', null, '维度'), h('b', null, r.vectors?.dim ?? '—')),
              h('div', null, h('span', null, '模型'), h('b', { className: 'jm-mono' }, r.vectors?.model || '—')),
              h('div', null, h('span', null, '保留期（预留）'), h('b', null, r.retentionDays != null ? `${r.retentionDays} 天（不自动过期）` : '—')),
              h('div', null, h('span', null, '覆盖'), h('b', null, r.coverageDays != null ? `${r.coverageDays} 天` : '—')))),
          h(Card, { title: '存储总览', kicker: 'STORAGE', right: h(Badge, { tone: storagePending ? 'warn' : (storageApi.error ? 'error' : (storageApi.data ? 'success' : 'idle')) }, storageApi.loading ? '读取中' : (storagePending ? '待重启' : (storageApi.error ? '不可读' : '正常'))) },
            storagePending
              ? h('div', null,
                h('div', { className: 'jm-footnote' }, '存储面板的宿主路由还没加载：这是新前端 + 旧宿主的版本错配，重启 DSH 后自动恢复；根藏数据本身正常。'),
                h('div', { className: 'jm-write-actions' },
                  h('button', { className: 'jm-btn jm-btn-sm', onClick: () => setStorageRev((n) => n + 1) }, '重试')))
              : storageApi.error ? h(ErrorBox, { error: storageApi.error }) : h('div', null,
              h('div', { className: 'jm-kv' },
                h('div', null, h('span', null, '数据根'), h('b', { className: 'jm-mono' }, sd.dataRoot || '—')),
                h('div', null, h('span', null, '总占用'), h('b', null, `${bytes(sd.total?.bytes)} / ${num(sd.total?.files)} 个文件`)),
                layerRows.map(([label, key]) => h('div', { key }, h('span', null, label), h('b', null, bytes(sd.layers?.[key]?.bytes || 0)))),
                h('div', null, h('span', null, '磁盘剩余'), h('b', null, sd.disk ? `${bytes(sd.disk.freeBytes)}（${(Number(sd.disk.freeRatio || 0) * 100).toFixed(1)}%）` : '—')),
                h('div', null, h('span', null, '日增长'), h('b', null, g.dailyBytes != null ? `${bytes(g.dailyBytes)}/天 · ${g.basis === 'snapshot' ? '快照实测' : '源会话估算'}` : '—')),
                h('div', null, h('span', null, '耗尽预测'), h('b', null, g.daysToExhaust != null ? `${num(g.daysToExhaust)} 天（约 ${String(g.exhaustAt || '').slice(0, 10)}）` : '不预测（增长为 0/未知）')),
                h('div', null, h('span', null, '源会话孤儿'), h('b', null, `${num(sd.sourceGone?.goneChunks)} 块（只提示不删）`))),
              h('div', { className: 'jm-footnote' }, g.note || ''),
              h('div', { className: 'jm-write-actions' },
                h('button', { className: 'jm-btn jm-btn-sm', onClick: doSnapshot, disabled: snapBusy }, snapBusy ? '记录中…' : '记录快照（用于测周增速）')),
              h(WriteMsg, { msg: snapMsg, onClose: () => setSnapMsg(null) }))),
          h(Card, { title: '模块能力', kicker: 'CAPABILITIES' },
            h('div', { className: 'jm-cap-modules' },
              mod('根藏', '存储层', true, [
                ['读取记忆', '可用', 'success'],
                ['根藏存储卡', r.ok ? (r.degraded ? '部分可用' : '可用') : '不可读', r.ok ? (r.degraded ? 'warn' : 'success') : 'error'],
                ['向量完整度', r.vectors?.missing ? `缺 ${num(r.vectors.missing)}（待重嵌）` : '完整', r.vectors?.missing ? 'warn' : 'success'],
              ], '把「谁、何时、说了什么」原话按人格落盘、可重建；给检索与处理读，不检索、不注入。'),
              mod('寻枝', '检索层', recallProbe.ok, recallProbe.ok ? [
                ['检索工具', '可用（session_recall）', 'success'],
                ['根藏检索', recallRootMode ? '已接根藏' : '自带索引', recallRootMode ? 'success' : 'warn'],
              ] : [['检索工具', '未启用', 'idle']], '按需做语义/字面检索；只读根藏，不写根藏、不注入。'),
              mod('熏习', '处理层', true, [
                ['读取记忆', '可用', 'success'],
                ['待处理查看', '可用', 'success'],
                ['主题写动作', caps.topics ? '可用' : '按设计不提供（正文归年轮）', caps.topics ? 'success' : 'idle'],
                ['动作 API', caps.actions ? '可用' : '仅供 agent（界面不提供）', caps.actions ? 'success' : 'idle'],
              ], '把根藏原话整理成状态/重复/取代候选；不改原文、不写正文、默认零 LLM。'),
              mod('镜台', '人格层', personaProbe.ok, [
                ['人格卡', personaProbe.ok ? '可用' : '未启用', personaProbe.ok ? 'success' : 'idle'],
              ], '人格卡的唯一写者：版本/回滚/AI 生成/注入预览；注入由镜台接管。'),
              mod('年轮', '认知层', yearRingProbe.ok, [
                ['主题正文 / 结论', yearRingProbe.ok ? '可用' : '未启用', yearRingProbe.ok ? 'success' : 'idle'],
              ], '从原话提炼主题与结论（带来源）；默认自动消化。')),
            h('div', { className: 'jm-footnote' }, '模块级状态来自实际探测：没装的层只显示「未安装」，其功能一律「未启用」，不冒充可用。'))))
    }

    // ── library page ───────────────────────────────────────────────────────
    function LibraryPage() {
      const [tab, setTab] = React.useState('overview')
      const [rev, setRev] = React.useState(0)
      const p = usePersona(null)
      // 镜台装没装：只读探测；404/非 ok 一律当未安装，tab 不出现
      const personaProbe = useProbe('/api/persona/status', true, rev)
      // 有没有根藏：决定走「记忆库」还是「只读原话看板」（P1-4）
      const sourceProbe = useProbe('/api/memory-process/source/probe', true, rev)
      if (sourceProbe.ok === null) return h('div', { className: 'jm-page' }, h(Loading))
      if (sourceProbe.ok === true && sourceProbe.data?.rootData === false) return h(SessionDashboardPage)
      // 其它建木层（如年轮）可以把自己的 tab 注册进来；
      // 没注册就是空数组——本页不认识任何具体插件，只认「有注册就渲染」。
      const externalTabs = (() => {
        try {
          const list = globalThis.__jianmuLibraryTabs
          return Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string' && typeof t.render === 'function') : []
        } catch { return [] }
      })()
      const tabs = [
        ['overview', '概览'], ['memories', '记忆'], ['pending', '待处理'], ['settings', '设置'],
        ...(personaProbe.ok && personaProbe.data?.enabled !== false ? [['persona', '人格卡']] : []),
        ...externalTabs.map((t) => [t.id, String(t.label || t.id)]),
      ]
      const refresh = () => setRev((x) => x + 1)
      return h('div', { className: 'jm-page jm-library' },
        h('style', null, CSS),
        h(ViewHead, {
          title: '记忆库',
          subtitle: '建木 · 处理层 · 自动维护，只读查看',
          onRefresh: refresh,
          right: h(Badge, { tone: 'brand' }, `v${PLUGIN_VERSION} · 只读`),
        }),
        h('div', { className: 'jm-intro' }, '记忆库（处理层）：读根藏原话，查看状态/重复/取代候选与各模块能力。应用/驳回需逐条确认；只改状态，**不删原话**。'),
        h(PersonaBar, { personaId: p.personaId, personas: p.personas, onChoose: p.choose, context: p.scoped }),
        p.error ? h(ErrorBox, { error: p.error, onRetry: refresh }) : null,
        h('div', { className: 'jm-tabs', role: 'tablist' },
          tabs.map(([id, label]) => h('button', {
            key: id, role: 'tab', 'aria-selected': tab === id,
            className: `jm-tab ${tab === id ? 'is-active' : ''}`,
            onClick: () => { if (id === 'persona') openPersonaPanel(); else setTab(id) },
          }, label))),
        tab === 'overview' ? h(OverviewTab, { personaId: p.personaId, rev, onGoPending: () => setTab('pending') }) : null,
        tab === 'memories' ? h(MemoriesTab, { personaId: p.personaId, rev }) : null,
        tab === 'pending' ? h(PendingTab, { personaId: p.personaId, rev }) : null,
        tab === 'settings' ? h(SettingsTab, { personaId: p.personaId, rev }) : null,
        ...externalTabs.map((t) => (tab === t.id
          ? h('div', { key: t.id, className: 'jm-external-tab' }, t.render({ personaId: p.personaId, personas: p.personas, rev }))
          : null)))
    }

    // ── session view ───────────────────────────────────────────────────────
    function SessionMemoryView(props) {
      const sessionId = props.sessionId
      const p = usePersona(null, sessionId)
      const [rev, setRev] = React.useState(0)
      const api = useApi('/memories', {
        personaId: p.personaId, session: sessionId, limit: 200,
      }, Boolean(p.personaId && sessionId), rev)
      const rows = api.data?.rows || []
      const total = api.data?.total || 0
      const count = (s) => rows.filter((r) => r.state?.status === s).length
      const resolvedName = p.personaId ? (p.personas[p.personaId]?.displayName || p.personaId) : null
      const resolveNote = p.sessionSource
        ? `已从会话自动解析人格：${resolvedName || p.personaId}（${p.sessionSource === 'session-cwd' ? '会话工作区' : '根藏同会话块'}）`
        : null
      const unresolvedNote = p.sessionUnresolved
        ? `未能从该会话自动解析人格，暂沿用上次选择${resolvedName ? `（${resolvedName}）` : ''}；可在上方切换`
        : null
      const body = sessionId && p.personaId ? h('div', { className: 'jm-session-body' },
        h('div', { className: 'jm-session-stats' },
          h(Stat, { label: '本对话记忆', value: num(total), sub: '按记忆时间倒序' }),
          h(Stat, { label: '正常', value: num(count('active')), tone: 'success' }),
          h(Stat, { label: '已取代', value: num(count('superseded')), tone: 'warn' }),
          h(Stat, { label: '过期/归档', value: num(count('expired') + count('archived')), tone: 'idle' })),
        api.loading && !rows.length ? h(Loading) : null,
        api.error ? h(ErrorBox, { error: api.error }) : null,
        !api.loading && rows.length === 0 ? h(Empty, null, p.sessionUnresolved
          ? '未能自动解析该会话的人格；若人格其实正确，可能是该会话尚未进入根藏'
          : '本对话暂无已收录记忆（或该会话尚未进入根藏）') : null,
        h('div', { className: 'jm-session-list' },
          rows.map((row) => h('div', { key: row.chunkId, className: 'jm-session-row' },
            h('span', { className: 'jm-mem-time' }, row.dateText || time(row.t)),
            h('span', { className: 'jm-mem-role' }, row.role === 'assistant' ? '助手' : row.role === 'user' ? '用户' : row.role),
            h('span', { className: 'jm-mem-preview' }, row.textPreview || '（空）'),
            h('span', { className: 'jm-mem-badges' },
              row.state?.synthetic
                ? h(Badge, { tone: 'idle', title: '该块尚未进入熏习状态（默认按正常可见）' }, '未处理')
                : h(React.Fragment, null,
                  h(Badge, { tone: toneForStatus(row.state?.status) }, labelStatus(row.state?.status)),
                  h(Badge, { tone: toneForEpistemic(row.state?.epistemic) }, labelEpistemic(row.state?.epistemic)))),
            h('span', { className: 'jm-mono jm-session-anchor' }, row.anchorKey ? row.anchorKey.split('|').slice(-2).join(':') : ''))))) : null
      return h('div', { className: 'jm-page jm-session' },
        h('style', null, CSS),
        h(ViewHead, {
          title: '本对话记忆',
          subtitle: sessionId ? `会话 ${String(sessionId).slice(0, 18)}…` : '未选择会话',
          onRefresh: () => setRev((x) => x + 1),
          right: h('div', { className: 'jm-head-actions' },
            h(Badge, { tone: 'brand' }, '只读'),
            props.onOpenLibrary ? h('button', { className: 'jm-btn', onClick: props.onOpenLibrary }, '打开记忆库') : null),
        }),
        h(PersonaBar, { personaId: p.personaId, personas: p.personas, onChoose: p.choose, context: p.scoped }),
        unresolvedNote ? h('div', { className: 'jm-warn-line jm-note-line' }, unresolvedNote) : null,
        resolveNote ? h('div', { className: 'jm-footnote jm-note-line' }, resolveNote) : null,
        !sessionId ? h(Empty, null, '当前没有选中的会话') : null,
        p.error ? h(ErrorBox, { error: p.error, onRetry: () => setRev((x) => x + 1) }) : null,
        body)
    }

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS = `
.jm-page{width:100%;height:100%;overflow:auto;padding:22px 26px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;box-sizing:border-box}
.jm-library{width:100%}
.jm-note-line{margin:-5px 0 12px}
.jm-intro{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:-4px 0 14px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.jm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.jm-title-row{display:flex;align-items:center;gap:10px}
.jm-title{font-size:24px;line-height:1.2;margin:0;font-weight:650;letter-spacing:.2px}
.jm-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:5px}
.jm-readonly,.jm-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:999px;white-space:nowrap}
.jm-readonly{font-size:11px;padding:2px 8px;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.jm-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.jm-btn{font:inherit;font-size:12px;line-height:1;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.jm-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.jm-btn:disabled{opacity:.42;cursor:not-allowed}
.jm-btn-sm{padding:5px 9px;font-size:11px}
.jm-btn-ghost{background:transparent}
.jm-select,.jm-input{font:inherit;font-size:12px;height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 9px;box-sizing:border-box}
.jm-select{min-width:112px}
.jm-input::placeholder{color:var(--dsw-alias-label-secondary)}
.jm-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin:4px 0 16px}
.jm-tab{font:inherit;font-size:13px;padding:9px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.jm-tab:hover{color:var(--dsw-alias-label-primary)}
.jm-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.jm-tab-body{display:flex;flex-direction:column;gap:14px}
.jm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.jm-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:15px 16px;min-width:0}
.jm-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:11px}
.jm-kicker{font-size:10px;letter-spacing:.12em;color:var(--dsw-alias-label-secondary);font-weight:600}
.jm-card-title{font-size:15px;line-height:1.3;margin:3px 0 0;font-weight:600}
.jm-badge{font-size:10.5px;line-height:1;padding:4px 7px;font-weight:500}
.jm-badge-success{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}
.jm-badge-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 24%,transparent)}
.jm-badge-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent)}
.jm-badge-brand{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}
.jm-badge-idle{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.jm-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
.jm-stat{min-width:0}
.jm-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-stat-value{font-size:25px;line-height:1.2;font-weight:650;letter-spacing:-.2px;margin-top:2px}
.jm-stat-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jm-tone-success{color:var(--dsw-alias-state-success-primary)}
.jm-tone-warn{color:var(--dsw-alias-state-warn-primary)}
.jm-tone-error{color:var(--dsw-alias-state-error-primary)}
.jm-big-number{font-size:38px;line-height:1.1;font-weight:700;letter-spacing:-1px}
.jm-big-number span{font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary);letter-spacing:0;margin-left:5px}
.jm-bar{display:flex;height:9px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);margin:12px 0 9px;gap:1px}
.jm-bar-seg{display:block;height:100%;min-width:2px}
.jm-seg-success{background:var(--dsw-alias-state-success-primary)}
.jm-seg-warn{background:var(--dsw-alias-state-warn-primary)}
.jm-seg-error{background:var(--dsw-alias-state-error-primary)}
.jm-seg-brand{background:var(--dsw-alias-brand-primary)}
.jm-seg-idle{background:var(--dsw-alias-state-idle-primary)}
.jm-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-legend-item{display:inline-flex;align-items:center;gap:5px}
.jm-dot{width:7px;height:7px;border-radius:999px;display:inline-block}
.jm-kv{display:flex;flex-direction:column;gap:7px}
.jm-kv>div{display:flex;justify-content:space-between;gap:14px;font-size:12px;min-width:0}
.jm-kv>div>span{color:var(--dsw-alias-label-secondary);flex:none}
.jm-kv>div>b{font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.jm-warn-line{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-state-warn-primary);border-radius:9px;padding:8px 11px;font-size:12px}
.jm-footnote{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:9px}
.jm-persona-bar{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin-bottom:13px}
.jm-persona-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-persona-name{font-size:12px;font-weight:600}
.jm-persona-scopes{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-persona-note{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.jm-filterbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.jm-search{flex:1 1 260px;min-width:180px}
.jm-filter-count{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.jm-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,360px);gap:14px;align-items:start}
.jm-list{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.jm-mem-head,.jm-mem-row{display:grid;grid-template-columns:118px 46px minmax(0,1fr) 190px;gap:9px;align-items:center}
.jm-mem-head{padding:8px 12px;font-size:10.5px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.jm-mem-row{width:100%;text-align:left;font:inherit;padding:9px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.jm-mem-row:hover{background:var(--dsw-alias-bg-layer-2)}
.jm-mem-row.is-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.jm-mem-time{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jm-mem-role{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-mem-preview{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.jm-mem-badges{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.jm-pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-detail-pane{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px;min-height:180px;position:sticky;top:12px}
.jm-detail-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:10px}
.jm-detail-time{font-size:12px;font-weight:600;margin-top:3px}
.jm-detail-badges{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.jm-detail-text{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.65;max-height:320px;overflow:auto;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.jm-detail-meta{display:flex;flex-direction:column;gap:6px;margin-top:11px}
.jm-detail-meta>div{display:flex;justify-content:space-between;gap:12px;font-size:11px}
.jm-detail-meta>div>span{color:var(--dsw-alias-label-secondary);flex:none}
.jm-detail-meta>div>b{font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jm-topic-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
.jm-summary-chips{display:flex;gap:7px;flex-wrap:wrap}
.jm-chip{font-size:11px;padding:5px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.jm-chip-muted{border-style:dashed}
.jm-pending-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.jm-cand-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;margin-bottom:9px;background:var(--dsw-alias-bg-layer-2)}
.jm-cand-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:7px}
.jm-cand-head b{font-size:12px;color:var(--dsw-alias-label-primary)}
.jm-cand-chunks{display:flex;flex-direction:column;gap:5px}
.jm-cand-chunk{display:grid;grid-template-columns:70px 112px 34px minmax(0,1fr);gap:7px;align-items:center;font-size:11px;padding:5px 6px;border-radius:7px;background:var(--dsw-alias-bg-layer-1)}
.jm-cand-id{color:var(--dsw-alias-label-secondary)}
.jm-cand-time{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jm-cand-role{color:var(--dsw-alias-label-secondary)}
.jm-cand-preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.jm-cap-list{display:flex;flex-direction:column;gap:7px}
.jm-cap{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px}
.jm-cap-modules{display:flex;flex-direction:column;gap:9px}
.jm-cap-module{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}
.jm-cap-module-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.jm-cap-module-head b{font-size:12.5px}
.jm-cap-layer{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.jm-cap-module-head .jm-badge{margin-left:auto}
.jm-cap-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin:-2px 0 7px}
.jm-cap-features{display:flex;flex-direction:column;gap:5px}
.jm-cap-feature{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;padding-left:2px}
.jm-purpose{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:8px 11px}
.jm-purpose b{color:var(--dsw-alias-label-primary)}
.jm-cand-chunk-btn{width:100%;text-align:left;font:inherit;border:1px solid transparent;cursor:pointer;color:inherit}
.jm-cand-chunk-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.jm-cand-chunk-btn:disabled{cursor:default;opacity:.55}
.jm-cand-open{margin-left:auto;flex:none}
.jm-modal{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.jm-modal-card{width:min(900px,94vw);max-height:84vh;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:16px 18px;box-shadow:0 18px 50px rgba(0,0,0,.28);box-sizing:border-box}
.jm-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.jm-modal-title{margin:3px 0 0;font-size:16px;font-weight:650}
.jm-modal-body{display:flex;flex-direction:column;gap:14px}
.jm-modal-item{border-top:1px solid var(--dsw-alias-border-l1);padding-top:13px}
.jm-modal-item:first-child{border-top:0;padding-top:0}
.jm-state{display:flex;align-items:center;gap:9px;padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px}
.jm-spinner{width:13px;height:13px;border-radius:999px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:jm-spin .8s linear infinite;display:inline-block}
@keyframes jm-spin{to{transform:rotate(360deg)}}
.jm-empty{padding:22px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
.jm-empty-guide{margin:0 0 12px;padding:14px 16px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);border-radius:12px;font-size:12px;line-height:1.7}
.jm-empty-guide-title{font-size:13px;font-weight:650;margin-bottom:3px}
.jm-empty-guide-text{color:var(--dsw-alias-label-secondary)}
.jm-empty-guide-steps{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary)}
.jm-write-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.jm-write-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.jm-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}
.jm-msg{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.jm-msg-success{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.jm-msg-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.jm-msg-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.jm-msg-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
.jm-confirm{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;border-radius:9px;font-size:12px;line-height:1.55;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.jm-confirm-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.jm-confirm-text{flex:1;min-width:0}
.jm-confirm-actions{display:flex;gap:6px;flex:none}
.jm-error{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:10px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.jm-error-detail{margin-top:3px;font-size:11px}
.jm-error-code{font-size:10px;opacity:.8;margin-top:2px;font-family:ui-monospace,Consolas,monospace}
.jm-session-body{display:flex;flex-direction:column;gap:14px}
.jm-session-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px}
.jm-session-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.jm-session-row{display:grid;grid-template-columns:118px 46px minmax(0,1fr) 170px 70px;gap:9px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.jm-session-row:last-child{border-bottom:0}
.jm-session-anchor{color:var(--dsw-alias-label-secondary);text-align:right}
@media (max-width:1100px){.jm-split{grid-template-columns:minmax(0,1fr)}.jm-detail-pane{position:static}.jm-session-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.jm-grid,.jm-pending-grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){.jm-page{padding:16px 14px 30px}.jm-mem-head{display:none}.jm-mem-row{grid-template-columns:1fr auto;grid-template-areas:'time badges' 'preview preview';row-gap:5px}.jm-mem-time{grid-area:time}.jm-mem-role{display:none}.jm-mem-preview{grid-area:preview;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.jm-mem-badges{grid-area:badges}.jm-session-row{grid-template-columns:1fr auto;grid-template-areas:'time badges' 'preview preview'}.jm-session-anchor{display:none}}
`
    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx?.slots) return
        ctxRef = ctx
        layoutRef = (() => { try { return ctx.get?.('layout') } catch { return null } })()
        const openLibrary = () => { try { resolveLayout()?.selectPanel?.('jianmu-memory') } catch { /* ignore */ } }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'jianmu-memory', order: 25,
          label: () => '记忆库',
        }, MemoryIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'jianmu-memory', locale: 'jianmu-memory',
        }, () => h(ErrorBoundary, null, h(LibraryPage))))

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'jianmu-memory', order: 25,
          label: () => '记忆',
        }, (props) => h(ErrorBoundary, null, h(SessionMemoryView, { ...props, onOpenLibrary: openLibrary }))))
      },
    }
  },
})
