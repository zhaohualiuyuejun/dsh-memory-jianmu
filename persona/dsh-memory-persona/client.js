window.__ModuleLoader__.load({
  id: 'dsh-memory-persona',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/persona'
    // UI 显示的插件版本：与 package.json 一致（发布检查会强制核对，别再写 v1a/v2）
    const PLUGIN_VERSION = '0.3.7'
    const CARD_KEY = 'jianmu.persona.cardId'

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
        if (!enabled) { setState({ loading: false, data: null, error: null }); return undefined }
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
     * 人格在根藏里的注册状态（P4 第 2 展示面，2026-11-12）
     * 数据来自熏习的只读端点 /api/memory-process/lifecycle；
     * 没装熏习 → 404 → 返回 null，本页不显示徽标，也不报错。
     */
    function useLifecycle(rev) {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        const ac = new AbortController()
        fetch(`/api/memory-process/lifecycle?_r=${rev || 0}`, { cache: 'no-store', signal: ac.signal })
          .then(async (res) => (res.ok ? await res.json().catch(() => null) : null))
          .then((body) => setState(body && body.ok ? body : null))
          .catch((e) => { if (e?.name !== 'AbortError') setState(null) })
        return () => ac.abort()
      }, [rev])
      return state
    }
    /** 'registered' | 'unregistered' | null(未知/没数据) */
    function cardRegState(cardId, life) {
      if (!life || !cardId) return null
      if ((life.unregisteredCards || []).some((c) => c.cardId === cardId)) return 'unregistered'
      const pids = life.identity?.personas || []
      return pids.includes(cardId) ? 'registered' : null
    }

    function storedCard() {
      try { return localStorage.getItem(CARD_KEY) || null } catch { return null }
    }
    function saveCard(cardId) {
      try { if (cardId) localStorage.setItem(CARD_KEY, cardId) } catch { /* ignore */ }
    }

    // ── write helpers（POST 动作 API）─────────────────────────────────────
    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-dsh-persona': '1' }
    const WRITE_ERROR_TEXT = {
      STALE_GENERATION: '有人先改过了，已为您刷新，请再保存一次',
      IMMUTABLE_SECTION_CHANGED: '身份/红线是受保护分区，普通保存不能改',
      PARTIAL_WRITE: '写入失败且可能已回滚，请用 status --deep 检查',
      LOCK_BUSY: '另一个写动作正在执行，请稍后重试',
      DEFAULT_CARD_PROTECTED: '默认卡不能删，先换默认卡',
      SCAN_RED: 'AI 输出含红项，已拒绝；编辑框未改动',
      NO_MODEL_ROUTE: '没有可用的模型路由，请先配置 expandProvider/expandModel',
      ROOT_SERVICE_UNAVAILABLE: '没装/没加载根藏（dsh-memory-store）：无法登记身份或停记',
      IDENTITY_UNREADABLE: 'identity.json 读不出来或结构非法；不会覆盖它，请先修好',
      IDENTITY_CHANGED: 'identity.json 刚被别处改过，请再点一次',
      WORKSPACE_TAKEN: '这个工作区已属于其他人格，没有静默改归属；请先在「默认与绑定」里改绑',
    }

    async function post(path, body) {
      let res
      try {
        res = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: WRITE_HEADERS,
          cache: 'no-store',
          body: JSON.stringify(body || {}),
        })
      } catch (e) {
        const err = new Error(`请求失败：${String(e?.message || e)}`)
        err.code = 'NETWORK_ERROR'
        err.status = 0
        throw err
      }
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) {
        const info = data?.error && typeof data.error === 'object' ? data.error : {}
        const err = new Error(info.message || data?.message || `HTTP ${res.status}`)
        err.code = data?.code || info.code || `HTTP_${res.status}`
        err.detail = info.detail ?? data?.detail ?? null
        err.status = res.status
        err.body = data
        throw err
      }
      return data
    }

    async function getStatus() {
      const res = await fetch(`${API}/status?_r=${Date.now()}`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) {
        const err = new Error(data?.error?.message || `HTTP ${res.status}`)
        err.code = data?.code || data?.error?.code || `HTTP_${res.status}`
        throw err
      }
      return data
    }

    function humanizeError(e) {
      const code = e?.code || ''
      if (WRITE_ERROR_TEXT[code]) return WRITE_ERROR_TEXT[code]
      const msg = e?.message || String(e || '未知错误')
      return code ? `${code}：${msg}` : msg
    }

    function protList(v) {
      if (!v) return []
      if (Array.isArray(v)) return v.map(String)
      if (typeof v === 'string') return [v]
      if (v === true) return ['identity', 'redline']
      if (typeof v === 'object') return Object.keys(v).filter((k) => v[k])
      return []
    }

    function num(n) {
      if (!Number.isFinite(Number(n))) return '—'
      return Number(n).toLocaleString('zh-CN')
    }
    function time(ts) {
      if (!Number.isFinite(Number(ts))) return '—'
      try { return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) } catch { return '—' }
    }
    function labelZone(z) {
      return ({ identity: '身份', redline: '红线', behavior: '行为准则', style: '风格示例' })[z] || z
    }
    function labelAuthor(a) {
      return ({ user: '用户', 'ai-expand': 'AI 生成', import: '导入', rollback: '回滚', system: '系统' })[a] || a || '—'
    }
    function labelSource(s) {
      if (!s) return '手工'
      if (String(s).startsWith('mirror:soul-md')) return '导入'
      return s
    }

    // ── atoms ──────────────────────────────────────────────────────────────
    function Badge({ tone = 'idle', children, title }) {
      return h('span', { className: `jm-badge jm-badge-${tone}`, title }, children)
    }
    function Panel({ title, kicker, right, children, className }) {
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
    function Loading({ text = '读取中…' }) {
      return h('div', { className: 'jm-state' }, h('span', { className: 'jm-spinner' }), text)
    }
    function ErrorBox({ error, onRetry }) {
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
    function Notice({ msg, onClose }) {
      if (!msg) return null
      return h('div', { className: `jm-msg jm-msg-${msg.tone || 'info'}` },
        h('span', { className: 'jm-msg-text' }, msg.text),
        msg.code ? h('span', { className: 'jm-msg-code' }, msg.code) : null,
        onClose ? h('button', { className: 'jm-msg-x', type: 'button', onClick: onClose, title: '关闭' }, '×') : null)
    }
    function ConfirmBar({ text, confirmLabel = '确认', cancelLabel = '取消', tone = 'warn', busy, onConfirm, onCancel }) {
      return h('div', { className: `jm-confirm jm-confirm-${tone}` },
        h('span', { className: 'jm-confirm-text' }, text),
        h('div', { className: 'jm-confirm-actions' },
          h('button', { className: 'jm-btn jm-btn-sm jm-btn-primary', type: 'button', onClick: onConfirm, disabled: Boolean(busy) }, busy || confirmLabel),
          h('button', { className: 'jm-btn jm-btn-sm jm-btn-ghost', type: 'button', onClick: onCancel, disabled: Boolean(busy) }, cancelLabel)))
    }
    /**
     * 删卡三选项（P4 #7）：卡是外观，记忆是资产 —— 先讲清代价再让用户选。
     * 「彻底删除」本轮不提供（破坏性；等单独工具 + 预览数字 + 二次确认）。
     */
    function DeleteCardPanel({ name, chunks, busy, onArchive, onStop, onCancel }) {
      const known = chunks !== null && chunks !== undefined
      const n = known ? (Number(chunks) || 0) : 0
      return h('div', { className: 'jm-confirm jm-confirm-danger' },
        h('div', { className: 'jm-confirm-text', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('b', null, `删除「${name}」？`),
          h('span', { className: 'jm-muted' },
            known
              ? `这是软删除：卡移到 persona/_deleted/（可恢复）。该人格在根藏有 ${num(n)} 条原话——删卡不会删记忆。`
              : '这是软删除：卡移到 persona/_deleted/（可恢复）。删卡不会删记忆（没装熏习，暂时显示不了条数）。'),
          h('span', { className: 'jm-muted' },
            '「保留记忆」（默认）：卡归档、记忆不动；新对话仍会继续记进这个人格，只是没有人格注入。'),
          h('span', { className: 'jm-muted' },
            '「停记」：卡归档 + 从根藏 identity 摘掉这个人的工作区映射；已有记忆保留，但新对话不再归到它。可重新登记恢复。')),
        h('div', { className: 'jm-confirm-actions', style: { flexWrap: 'wrap' } },
          h('button', { className: 'jm-btn jm-btn-sm jm-btn-primary', type: 'button', onClick: onArchive, disabled: Boolean(busy) },
            busy === 'archive' ? '处理中…' : '保留记忆并删卡'),
          h('button', { className: 'jm-btn jm-btn-sm', type: 'button', onClick: onStop, disabled: Boolean(busy) },
            busy === 'stop' ? '处理中…' : '停记并删卡'),
          h('button', {
            className: 'jm-btn jm-btn-sm jm-btn-ghost', type: 'button', disabled: true,
            title: '彻底删除会移除该人格的 scopes/year/process/persona 记忆目录；属破坏性动作，本轮先不提供。需要时可让 agent 先给「将删除 N 条原话 / M 条 claim」的预览再单独执行。',
          }, '彻底删除（暂未提供）'),
          h('button', { className: 'jm-btn jm-btn-sm jm-btn-ghost', type: 'button', onClick: onCancel, disabled: Boolean(busy) }, '取消')))
    }
    function AiBar({ meta, busy, onRegenerate, onUndo }) {
      const route = [meta?.provider, meta?.model].filter(Boolean).join('/') || '未知路由'
      const warns = (meta?.warnings || []).slice()
      return h('div', { className: 'jm-ai-bar' },
        h('div', { className: 'jm-ai-main' },
          h('b', null, `AI 生成（${route}）`),
          h('span', { className: 'jm-muted' }, ' 请检查后保存'),
          meta?.protectedChanged?.length
            ? h('div', { className: 'jm-ai-warn' }, `受保护分区有改动：${meta.protectedChanged.join('、')}（保存时会二次确认）`)
            : null,
          warns.length ? h('div', { className: 'jm-ai-warn' }, warns.join('；')) : null),
        h('div', { className: 'jm-head-actions' },
          h('button', { className: 'jm-btn jm-btn-sm', type: 'button', onClick: onRegenerate, disabled: Boolean(busy) }, '再生成一版'),
          h('button', { className: 'jm-btn jm-btn-sm jm-btn-ghost', type: 'button', onClick: onUndo, disabled: Boolean(busy) }, '撤销')))
    }
    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error, info) { try { console.error('[jianmu-persona] view crashed', error, info) } catch { /* ignore */ } }
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
            h('span', { className: 'jm-readonly' }, `v${PLUGIN_VERSION} · 可编辑`)),
          h('div', { className: 'jm-subtitle' }, subtitle)),
        h('div', { className: 'jm-head-actions' },
          right || null,
          onRefresh ? h('button', { className: 'jm-btn', onClick: onRefresh, title: '刷新' }, '刷新') : null))
    }
    function LockIcon({ size = 13 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }),
        h('path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }))
    }
    function PersonaIcon({ size = 20, active }) {
      const s = Number(size) || 20
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', display: 'block' },
      },
      h('rect', { x: 4, y: 3.5, width: 16, height: 17, rx: 3 }),
      h('path', { d: 'M8 8.5h8M8 12h8M8 15.5h5' }),
      h('circle', { cx: 17, cy: 16.5, r: 2.2 }))
    }

    // ── cards tab ──────────────────────────────────────────────────────────
    function ZoneBlock({ zone, body }) {
      const [open, setOpen] = React.useState(true)
      const slice = body.slice(zone.start, zone.end).replace(/\s+$/, '')
      return h('div', { className: `jm-zone ${zone.protected ? 'is-protected' : ''}` },
        h('button', { type: 'button', className: 'jm-zone-head', onClick: () => setOpen((x) => !x) },
          h('span', { className: 'jm-zone-chevron' }, open ? '▾' : '▸'),
          h('span', { className: 'jm-zone-title' }, zone.title || '（标题前）'),
          h('span', { className: 'jm-zone-zone' }, labelZone(zone.zone)),
          zone.protected ? h('span', { className: 'jm-zone-lock', title: '身份/红线只读：保存时 hash 变化会被拒绝' }, h(LockIcon), '只读') : null,
          h('span', { className: 'jm-zone-chars' }, `${num(zone.chars)} 字`)),
        open ? h('pre', { className: 'jm-zone-body' }, slice || '（空）') : null)
    }

    function CardEditor({ cardId, rev, life, onGoVersions, onRefresh, onDeleted, onDirtyChange }) {
      const api = useApi('/card', { cardId }, Boolean(cardId), rev)
      const [showRaw, setShowRaw] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [note, setNote] = React.useState('')
      const [aiDraft, setAiDraft] = React.useState(false)
      const [aiMeta, setAiMeta] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)

      const d = api.data || {}
      const body = draft === null ? String(d.body || '') : String(draft)
      const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
      const dirty = editing && norm(body) !== norm(d.body)
      const seed = (draft === null ? String(d.body || '') : String(draft)).trim()

      React.useEffect(() => { if (onDirtyChange) onDirtyChange(Boolean(dirty)) }, [dirty, onDirtyChange])
      React.useEffect(() => () => { if (onDirtyChange) onDirtyChange(false) }, [])

      if (!cardId) return h(Empty, null, '还没有人格卡')
      if (api.loading && !api.data) return h(Loading)
      if (api.error) return h(ErrorBox, { error: api.error })

      const name = d.name || cardId
      const scopeRow = (life?.scopes || []).find((s) => s.personaId === cardId) || null
      const memChunks = scopeRow ? (Number(scopeRow.chunks) || 0) : null
      const regState = cardRegState(cardId, life)

      /** P4 #6：一键把这张卡登记到根藏 identity（不自动做；用户点才写） */
      async function doRegister() {
        setBusy('register')
        setMsg(null)
        try {
          const st = await getStatus()
          const r = await post('/register', { cardId, expectedGeneration: st.generation, confirm: true })
          const n = Array.isArray(r.workspaces) ? r.workspaces.length : 0
          setMsg({ tone: 'success', text: n
            ? `已在根藏登记「${r.displayName || name}」+ ${n} 个工作区；该工作区的新对话会记进这个人格。`
            : `已在根藏登记「${r.displayName || name}」；这张卡还没绑定工作区，去「默认与绑定」绑一个才会开始记录。` })
          if (onRefresh) onRefresh()
        } catch (e) {
          setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
        } finally {
          setBusy(null)
        }
      }

      function aiNoteText() {
        if (!aiMeta) return ''
        const route = [aiMeta.provider, aiMeta.model].filter(Boolean).join('/')
        const rawTok = aiMeta.usage?.totalTokens ?? aiMeta.usage?.total_tokens ?? aiMeta.usage?.total
        const tok = Number(rawTok)
        const tail = Number.isFinite(tok) && tok > 0 ? `${tok} token` : ''
        return [route, tail].filter(Boolean).join(' · ')
      }

      function clearEditing() {
        setDraft(null)
        setEditing(false)
        setAiDraft(false)
        setAiMeta(null)
        setNote('')
        setConfirm(null)
      }

      function handleEditToggle() {
        if (editing) {
          if (dirty) { setConfirm({ kind: 'collapse' }); return }
          clearEditing()
          setMsg(null)
          return
        }
        setDraft(String(d.body || ''))
        setEditing(true)
        setMsg(null)
      }

      function doCollapse() {
        setConfirm(null)
        clearEditing()
        setMsg({ tone: 'info', text: '已放弃未保存的改动' })
      }

      function handleSaveClick() {
        if (busy) return
        if (!dirty) { setMsg({ tone: 'warn', text: '没有未保存的改动' }); return }
        if (aiDraft && aiMeta && protList(aiMeta.protectedChanged).length) {
          setConfirm({ kind: 'protected' })
          return
        }
        doSave({})
      }

      async function doSave(opts) {
        setConfirm(null)
        setBusy('save')
        setMsg(null)
        const content = String(body)
        try {
          const st = await getStatus()
          const payload = {
            cardId,
            content,
            author: aiDraft ? 'ai-expand' : 'user',
            note: aiDraft ? (aiNoteText() || 'ai-expand') : (note.trim() || undefined),
            expectedGeneration: st.generation,
            confirm: true,
          }
          if (opts && opts.allowProtectedSectionsChange) payload.allowProtectedSectionsChange = true
          const res = await post('/save', payload)
          const ver = Number(res.version ?? res.card?.version ?? res.current)
          setMsg({ tone: 'success', text: Number.isFinite(ver) ? `已保存 v${ver}，快照在 _archive` : '已保存，快照在 _archive' })
          setDraft(content)
          setAiDraft(false)
          setAiMeta(null)
          setNote('')
          if (onRefresh) onRefresh()
        } catch (e) {
          if (e.code === 'STALE_GENERATION') {
            setMsg({ tone: 'warn', text: '有人先改过了，已为您刷新，请再保存一次' })
            if (onRefresh) onRefresh()
          } else if (e.code === 'IMMUTABLE_SECTION_CHANGED') {
            const changed = protList(e.detail && e.detail.changed)
            if (aiDraft && changed.length) {
              setMsg({ tone: 'warn', text: '受保护分区将变更，需要二次确认。' })
              setConfirm({ kind: 'protected' })
            } else {
              setMsg({ tone: 'error', text: '身份/红线是受保护分区，普通保存不能改', code: e.code })
            }
          } else {
            setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
          }
        } finally {
          setBusy(null)
        }
      }

      function requestExpand() {
        if (busy) return
        if (!seed) { setMsg({ tone: 'warn', text: '先写一句人设种子，例如：你是一个示例助手' }); return }
        if (!editing) {
          setDraft(String(d.body || ''))
          setEditing(true)
        }
        setConfirm({ kind: 'expand' })
      }

      async function doExpand() {
        setConfirm(null)
        setBusy('expand')
        setMsg(null)
        const seedText = draft === null ? String(d.body || '') : String(draft)
        const preAi = seedText
        try {
          const res = await post('/expand', {
            seed: seedText,
            cardId,
            existingContent: seedText,
            name: d.name,
            confirmOverwrite: true,
          })
          const next = typeof res.draft === 'string' ? res.draft : (typeof res.content === 'string' ? res.content : '')
          if (!next) {
            const err = new Error('模型没有返回草稿')
            err.code = 'EMPTY_DRAFT'
            throw err
          }
          const provider = res.provider || res.route?.provider || res.modelRoute?.provider || 'model'
          const model = res.model || res.route?.model || res.modelRoute?.model || '—'
          setDraft(next)
          setAiDraft(true)
          setAiMeta({ preAi, provider, model, protectedChanged: protList(res.protectedChanged), warnings: res.warnings || [], usage: res.usage || null })
          setMsg({ tone: 'success', text: `AI 生成（${provider}/${model}），请检查后保存` })
        } catch (e) {
          setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
        } finally {
          setBusy(null)
        }
      }

      function undoAi() {
        const pre = aiMeta && typeof aiMeta.preAi === 'string' ? aiMeta.preAi : null
        setDraft(pre)
        setAiDraft(false)
        setAiMeta(null)
        setMsg({ tone: 'info', text: '已撤销 AI 生成（未落盘）' })
      }

      async function doDelete(mode = 'archive') {
        setBusy(mode)
        try {
          const st = await getStatus()
          await post('/delete', { cardId, expectedGeneration: st.generation, confirm: true, mode })
          setConfirm(null)
          if (onDeleted) onDeleted(cardId)
        } catch (e) {
          setConfirm(null)
          if (e.code === 'STALE_GENERATION') {
            setMsg({ tone: 'warn', text: '有人先改过了，已为您刷新，请再试一次' })
            if (onRefresh) onRefresh()
          } else {
            setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
          }
        } finally {
          setBusy(null)
        }
      }

      function confirmNode() {
        if (!confirm) return null
        if (confirm.kind === 'delete') {
          return h(DeleteCardPanel, {
            name,
            chunks: memChunks,
            busy,
            onArchive: () => doDelete('archive'),
            onStop: () => doDelete('stop'),
            onCancel: () => setConfirm(null),
          })
        }
        if (confirm.kind === 'collapse') {
          return h(ConfirmBar, {
            text: '编辑框有未保存的改动，收起会丢弃。',
            confirmLabel: '丢弃并收起',
            onConfirm: doCollapse,
            onCancel: () => setConfirm(null),
          })
        }
        if (confirm.kind === 'expand') {
          return h(ConfirmBar, {
            text: '将基于当前内容生成整卡、编辑框会被替换（可撤销）、不会自动保存。文本会发送到模型服务端（默认云端模型，可能产生费用）。继续？',
            confirmLabel: '生成',
            busy: busy === 'expand' ? '生成中…' : null,
            onConfirm: doExpand,
            onCancel: () => setConfirm(null),
          })
        }
        if (confirm.kind === 'protected') {
          return h(ConfirmBar, {
            tone: 'danger',
            text: '受保护分区（身份/红线）将变更，确认覆盖？',
            confirmLabel: '确认覆盖并保存',
            busy: busy === 'save' ? '保存中…' : null,
            onConfirm: () => { setConfirm(null); doSave({ allowProtectedSectionsChange: true }) },
            onCancel: () => setConfirm(null),
          })
        }
        return null
      }

      return h('div', { className: 'jm-tab-body' },
        h(Panel, {
          title: name,
          kicker: 'PERSONA CARD',
          right: h('div', { className: 'jm-head-actions' },
            h(Badge, { tone: 'brand' }, `卡片 v${d.version ?? '—'}`),
            h(Badge, { tone: d.source?.startsWith('mirror') ? 'warn' : 'idle' }, labelSource(d.source)),
            h(Badge, { tone: d.status === 'active' ? 'success' : 'idle' }, d.status === 'active' ? '启用' : d.status),
            aiDraft ? h(Badge, { tone: 'warn' }, 'AI 草稿未保存') : null),
        },
        h('div', { className: 'jm-form' },
          h('label', { className: 'jm-field' },
            h('span', null, '卡名称'),
            h('input', { className: 'jm-input', value: d.name || '', readOnly: true })),
          h('div', { className: 'jm-inline-note' },
            '编辑 / AI 生成 / 删除 / 版本回滚已接入；身份与红线是受保护分区，普通保存不能改。')),
        h('div', { className: 'jm-zone-list' },
          (d.zones || []).map((z) => h(ZoneBlock, { key: `${z.index}-${z.start}`, zone: z, body: d.body || '' }))),
        editing ? h('div', { className: 'jm-footnote' }, '分区视图跟随已保存的正文；编辑全文不会实时重算分区。') : null,
        editing ? h('div', { className: 'jm-editwrap' },
          h('div', { className: 'jm-editlabel' }, '完整正文（Markdown 正文，不含 front-matter）'),
          h('textarea', {
            className: 'jm-textarea',
            value: body,
            spellCheck: false,
            onChange: (e) => {
              setDraft(e.target.value)
              if (msg && msg.tone === 'error') setMsg(null)
            },
          }),
          h('label', { className: 'jm-field jm-editnote' },
            h('span', null, aiDraft ? '版本备注（AI 草稿固定记 provider/model）' : '版本备注（可选）'),
            h('input', {
              className: 'jm-input',
              value: aiDraft ? aiNoteText() : note,
              readOnly: Boolean(aiDraft),
              placeholder: '例如：调整行为准则',
              onChange: (e) => setNote(e.target.value),
            }))) : null,
        h('div', { className: 'jm-editor-status' },
          regState === 'unregistered' ? h('div', { className: 'jm-msg jm-msg-warn', style: { alignItems: 'center' } },
            h('span', { className: 'jm-msg-text' },
              `这张卡还没在根藏登记：绑定工作区的对话会进「未归属桶」，等于建了卡却没记忆。${memChunks ? `该人格已有 ${num(memChunks)} 条旧原话。` : ''}`),
            h('button', {
              className: 'jm-btn jm-btn-sm jm-btn-primary', type: 'button',
              disabled: Boolean(busy), onClick: doRegister,
            }, busy === 'register' ? '登记中…' : '一键登记到根藏')) : null,
          msg ? h(Notice, { msg, onClose: () => setMsg(null) }) : null,
          aiDraft && aiMeta ? h(AiBar, { meta: aiMeta, busy, onRegenerate: requestExpand, onUndo: undoAi }) : null,
          confirmNode()),
        h('div', { className: 'jm-actions' },
          h('button', {
            className: 'jm-btn jm-btn-primary',
            type: 'button',
            onClick: handleSaveClick,
            disabled: Boolean(busy) || !dirty,
            title: dirty ? '保存为新版本（写前快照到 _archive）' : '没有未保存的改动',
          }, busy === 'save' ? '保存中…' : '保存'),
          h('button', {
            className: 'jm-btn',
            type: 'button',
            onClick: requestExpand,
            disabled: Boolean(busy) || !seed,
            title: seed ? '基于当前编辑框生成整卡草稿（不会自动保存）' : '先写一句人设种子，例如：你是一个示例助手',
          }, busy === 'expand' ? '生成中…' : 'AI 润色'),
          h('button', {
            className: 'jm-btn jm-btn-danger',
            type: 'button',
            onClick: () => setConfirm({ kind: 'delete' }),
            disabled: Boolean(busy),
            title: '删除会移入 persona/_deleted/（可恢复）；可选择保留记忆或停记',
          }, '删除'),
          h('button', { className: 'jm-btn jm-btn-ghost', type: 'button', onClick: onGoVersions }, '版本历史'),
          h('button', { className: 'jm-btn jm-btn-ghost', type: 'button', onClick: () => setShowRaw((x) => !x) }, showRaw ? '收起完整 Markdown' : '查看完整 Markdown'),
          h('button', { className: 'jm-btn jm-btn-ghost', type: 'button', onClick: handleEditToggle }, editing ? '收起编辑' : '编辑全文')),
        showRaw ? h('pre', { className: 'jm-raw' }, d.raw || '') : null,
        h('div', { className: 'jm-hashes' },
          h('div', null, h('span', null, '身份区 hash'), h('b', { className: 'jm-mono' }, (d.zoneHashes?.identity || '—').slice(0, 16) + '…')),
          h('div', null, h('span', null, '红线区 hash'), h('b', { className: 'jm-mono' }, (d.zoneHashes?.redline || '—').slice(0, 16) + '…')),
          h('div', null, h('span', null, '整卡 hash'), h('b', { className: 'jm-mono' }, (d.sourceHash || '—').slice(0, 16) + '…')),
          h('div', null, h('span', null, '版本数'), h('b', null, num(d.versions))))))
    }

    function CardsTab({ cards, selected, onSelect, rev, onGoVersions, dirty, onDirtyChange, onRefresh, onDeleted }) {
      const [pendingSelect, setPendingSelect] = React.useState(null)
      // 新增人格卡（2026-11-08）：UI 直接建卡，不再要求用户去跑工具
      const [creating, setCreating] = React.useState(false)
      const [newId, setNewId] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [busyNew, setBusyNew] = React.useState(false)
      const [newMsg, setNewMsg] = React.useState(null)
      // 未归属块认领（P4 #8，2026-11-12）
      const [claimBusy, setClaimBusy] = React.useState(null)
      const [claimMsg, setClaimMsg] = React.useState(null)
      const list = cards.data?.cards || []
      // 根藏注册状态（只读；没装熏习时为 null，不显示徽标）
      const life = useLifecycle(rev)
      const unassigned = life?.unassigned || null
      const pureRows = (unassigned?.byWorkspace || []).filter((r) => !r.claimedBy)
      const pureChunks = unassigned?.pureChunks ?? (unassigned?.chunks || 0)
      const claimedChunks = unassigned?.claimedChunks || 0

      /** 把某个未归属工作区「软认领」到当前卡：只补 identity 映射 + 绑卡，不搬数据 */
      async function doClaim(ws) {
        if (!selected) { setClaimMsg({ tone: 'warn', text: '先在左边选一张人格卡，再认领这个工作区' }); return }
        setClaimBusy(ws)
        setClaimMsg(null)
        try {
          const st = await getStatus()
          const r = await post('/claim-workspace', {
            workspace: ws, cardId: selected, expectedGeneration: st.generation, confirm: true,
          })
          setClaimMsg({ tone: 'success', text: `已把「${ws}」归到「${r.displayName || selected}」：旧块不搬动，检索会影子纳入（${num(pureChunks)} 条未归属仍留在库里）。` })
          if (onRefresh) onRefresh()
        } catch (e) {
          setClaimMsg({ tone: 'error', text: humanizeError(e), code: e.code })
        } finally {
          setClaimBusy(null)
        }
      }

      const pick = (id) => {
        if (id === selected) return
        if (dirty) { setPendingSelect(id); return }
        onSelect(id)
      }
      const confirmSwitch = () => {
        const id = pendingSelect
        setPendingSelect(null)
        if (onDirtyChange) onDirtyChange(false)
        if (id) onSelect(id)
      }
      async function doCreate() {
        if (busyNew) return
        const id = String(newId || '').trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
          setNewMsg({ tone: 'error', text: 'id 只能用小写字母/数字/_/-，且以字母或数字开头' })
          return
        }
        if (list.some((c) => c.cardId === id)) {
          setNewMsg({ tone: 'error', text: `已存在同名卡：${id}` })
          return
        }
        setBusyNew(true)
        setNewMsg(null)
        try {
          const st = await getStatus()
          await post('/create', {
            cardId: id,
            name: String(newName || '').trim() || id,
            expectedGeneration: st.generation,
            confirm: true,
          })
          setCreating(false)
          setNewId('')
          setNewName('')
          setNewMsg(null)
          if (onRefresh) onRefresh()
          if (onSelect) onSelect(id)
        } catch (e) {
          setNewMsg({ tone: 'error', text: humanizeError(e), code: e.code })
        } finally {
          setBusyNew(false)
        }
      }
      return h('div', { className: 'jm-tab-body' },
        pendingSelect ? h(ConfirmBar, {
          text: '当前卡有未保存的修改，切换会丢弃。',
          confirmLabel: '确认切换',
          onConfirm: confirmSwitch,
          onCancel: () => setPendingSelect(null),
        }) : null,
        // P4 #8：未归属块认领（只引导、不自动做；软认领不搬数据）
        pureChunks > 0 ? h('div', { className: 'jm-msg jm-msg-warn', style: { margin: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('b', null, `有 ${num(pureChunks)} 条未归属原话`),
          h('span', { className: 'jm-muted' },
            '它们存在根藏里，但没有任何人格能检索到。选一张卡后点「归到当前卡」：只补 identity 映射 + 绑定卡，不搬数据、不重嵌；旧块会被这个人格影子纳入检索，移除映射即回退。'),
          ...pureRows.slice(0, 8).map((row) => h('div', { key: row.ws, style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { className: 'jm-mono' }, row.ws),
            h('span', { className: 'jm-muted' }, `${num(row.chunks)} 条`),
            h('button', {
              className: 'jm-btn jm-btn-sm', type: 'button',
              disabled: Boolean(claimBusy) || !selected,
              title: selected ? `把「${row.ws}」归到当前卡（软认领）` : '先在左边选一张卡',
              onClick: () => doClaim(row.ws),
            }, claimBusy === row.ws ? '认领中…' : '归到当前卡'))),
          claimMsg ? h(Notice, { msg: claimMsg, onClose: () => setClaimMsg(null) }) : null) : null,
        claimedChunks > 0 && pureChunks === 0
          ? h('div', { className: 'jm-msg jm-msg-info', style: { margin: '8px 12px' } },
            h('span', { className: 'jm-msg-text' }, `另有 ${num(claimedChunks)} 条旧原话已软认领：仍在未归属桶（不搬数据），但对应人格已能检索到。`))
          : null,
        h('div', { className: 'jm-split' },
          h('div', { className: 'jm-cardlist' },
            h('div', { className: 'jm-cardlist-head' },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('b', null, '人格卡'),
                h('span', { className: 'jm-muted' }, `${num(list.length)} 张`)),
              h('button', {
                className: 'jm-btn jm-btn-sm jm-btn-primary',
                type: 'button',
                disabled: busyNew,
                title: '新建一张人格卡',
                onClick: () => { setCreating((x) => !x); setNewMsg(null) },
              }, creating ? '取消' : '＋ 新增')),
            creating ? h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              h('label', { className: 'jm-field' },
                h('span', null, 'id（小写字母 / 数字 / _ / -）'),
                h('input', {
                  className: 'jm-input',
                  value: newId,
                  placeholder: '例如 alice',
                  disabled: busyNew,
                  onChange: (e) => setNewId(e.target.value),
                })),
              h('label', { className: 'jm-field' },
                h('span', null, '显示名（可留空，默认同 id）'),
                h('input', {
                  className: 'jm-input',
                  value: newName,
                  placeholder: '例如 Alice',
                  disabled: busyNew,
                  onChange: (e) => setNewName(e.target.value),
                })),
              h('div', { className: 'jm-actions' },
                h('button', {
                  className: 'jm-btn jm-btn-sm jm-btn-primary',
                  type: 'button',
                  disabled: busyNew || !String(newId || '').trim(),
                  onClick: doCreate,
                }, busyNew ? '创建中…' : '创建')),
              newMsg ? h(Notice, { msg: newMsg, onClose: () => setNewMsg(null) }) : null) : null,
            list.length === 0 ? h(Empty, null, '还没有人格卡：点上方「＋ 新增」新建一张') : null,
            list.map((c) => h('button', {
              key: c.cardId,
              type: 'button',
              className: `jm-cardrow ${selected === c.cardId ? 'is-selected' : ''}`,
              onClick: () => pick(c.cardId),
            },
            h('span', { className: 'jm-cardrow-name' }, c.name || c.cardId),
            h('span', { className: 'jm-cardrow-badges' },
              c.isDefault ? h(Badge, { tone: 'brand' }, '默认') : null,
              (() => {
                const rs = cardRegState(c.cardId, life)
                if (!rs) return null
                return rs === 'unregistered'
                  ? h(Badge, { tone: 'warn', title: '根藏 identity.json 里没有这个人格：这张卡绑定工作区的对话会进未归属桶，等于“建了卡却没记忆”。' }, '未注册')
                  : h(Badge, { tone: 'success', title: '根藏已登记这个人格：原话会归到它自己的 scope。' }, '已注册')
              })(),
              h(Badge, { tone: c.source?.startsWith('mirror') ? 'warn' : 'idle' }, labelSource(c.source)),
              h(Badge, { tone: 'idle' }, `卡片 v${c.version ?? '—'}`))))),
          h('div', { className: 'jm-editorpane' },
            h(CardEditor, {
              key: selected || 'none',
              cardId: selected,
              rev: rev || 0,
              life,
              onGoVersions: onGoVersions || (() => {}),
              onRefresh,
              onDeleted,
              onDirtyChange,
            }))))
    }

    // ── bindings tab ───────────────────────────────────────────────────────
    function BindingsTab({ rev, onRefresh }) {
      const reg = useApi('/registry', {}, true, rev)
      const cards = useApi('/cards', {}, true, rev)
      const [defSel, setDefSel] = React.useState(null)
      const [wsEdits, setWsEdits] = React.useState({})
      const [sesEdits, setSesEdits] = React.useState({})
      const [newWs, setNewWs] = React.useState('')
      const [newWsCard, setNewWsCard] = React.useState('none')
      const [newSes, setNewSes] = React.useState('')
      const [newSesCard, setNewSesCard] = React.useState('none')
      const [busy, setBusy] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const activeId = reg.data?.registry?.activeCardId || 'none'
      React.useEffect(() => { setDefSel(null) }, [activeId])

      if (reg.loading && !reg.data) return h(Loading)
      if (reg.error) return h(ErrorBox, { error: reg.error })

      const r = reg.data?.registry || {}
      const list = cards.data?.cards || []
      const nameOf = (id) => {
        if (id === 'none') return '不注入'
        const c = list.find((x) => x.cardId === id)
        return c ? `${c.name}（${id}）` : id
      }
      const workspaces = Object.entries(r.workspaces || {})
      const sessions = Object.entries(r.sessions || {})
      const defValue = defSel === null ? activeId : defSel

      function cardOptions(withDelete) {
        const opts = [h('option', { key: '__none', value: 'none' }, '不注入（none）')]
        list.forEach((c) => opts.push(h('option', { key: c.cardId, value: c.cardId }, `${c.name || c.cardId}（${c.cardId}）`)))
        if (withDelete) opts.push(h('option', { key: '__delete', value: '' }, '删除绑定'))
        return opts
      }

      async function runWrite(key, path, payload, okText, clearEdits) {
        if (busy) return
        setBusy(key)
        setMsg(null)
        try {
          const st = await getStatus()
          await post(path, { ...payload, expectedGeneration: st.generation, confirm: true })
          setMsg({ tone: 'success', text: okText })
          if (clearEdits) clearEdits()
          if (onRefresh) onRefresh()
        } catch (e) {
          if (e.code === 'STALE_GENERATION') {
            setMsg({ tone: 'warn', text: '有人先改过了，已为您刷新，请再试一次' })
            if (onRefresh) onRefresh()
          } else {
            setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
          }
        } finally {
          setBusy(null)
        }
      }

      return h('div', { className: 'jm-tab-body' },
        h('div', { className: 'jm-purpose' },
          h('b', null, '解析顺序：'), '会话覆盖 → 工作区最长前缀 → 默认卡 → 不注入。',
          h('span', null, ' 绑定可直接修改；每次写都先取 /status 的 generation。')),
        msg ? h(Notice, { msg, onClose: () => setMsg(null) }) : null,
        h('div', { className: 'jm-grid' },
          h(Panel, {
            title: '默认卡',
            kicker: 'DEFAULT',
            right: h('div', { className: 'jm-head-actions' },
              h(Badge, { tone: r.activeCardId ? 'brand' : 'idle' }, r.activeCardId ? '已设' : '不注入'),
              h('button', {
                className: 'jm-btn jm-btn-sm',
                type: 'button',
                disabled: busy !== null,
                onClick: () => runWrite('default', '/default', { cardId: defValue }, defValue === 'none' ? '已设为全局不注入（none）' : `已设为默认：${nameOf(defValue)}`),
              }, '设为默认')),
          },
          h('div', { className: 'jm-kv' },
            h('div', null, h('span', null, '当前默认'), h('b', null, r.activeCardId ? nameOf(r.activeCardId) : '不启用（全局关人格）')),
            h('div', null, h('span', null, 'generation'), h('b', null, num(r.generation))),
            h('div', null, h('span', null, '更新时间'), h('b', null, time(r.updatedAt)))),
          h('div', { className: 'jm-bind-new' },
            h('select', { className: 'jm-select', value: defValue, onChange: (e) => setDefSel(e.target.value) }, cardOptions(false)),
            h('span', { className: 'jm-muted' }, 'none = 全局不注入'))),
          h(Panel, {
            title: '工作区人设',
            kicker: 'WORKSPACES',
            right: h('div', { className: 'jm-head-actions' }, h(Badge, { tone: 'idle' }, `${workspaces.length} 条`)),
          },
          workspaces.length === 0 ? h(Empty, null, '没有工作区绑定') : h('div', { className: 'jm-table jm-bind-table' },
            h('div', { className: 'jm-table-head' }, h('span', null, '工作区'), h('span', null, '人格卡 / 操作')),
            workspaces.map(([k, v]) => {
              const val = wsEdits[k] !== undefined ? wsEdits[k] : v
              return h('div', { key: k, className: 'jm-table-row jm-bind-row' },
                h('span', { className: 'jm-mono jm-ellipsis', title: k }, k),
                h('span', { className: 'jm-bind-ctl' },
                  h('select', {
                    className: 'jm-select jm-select-sm',
                    value: val,
                    onChange: (e) => setWsEdits((s) => ({ ...s, [k]: e.target.value })),
                  }, cardOptions(true)),
                  h('button', {
                    className: 'jm-btn jm-btn-sm',
                    type: 'button',
                    disabled: busy !== null,
                    onClick: () => runWrite(`ws:${k}`, '/bind',
                      { scope: 'workspace', key: k, cardId: val },
                      val === '' ? `已删除工作区绑定：${k}` : `已绑定 ${k} → ${nameOf(val)}`,
                      () => setWsEdits((s) => ({ ...s, [k]: undefined }))),
                  }, busy === `ws:${k}` ? '保存中…' : '保存')))
            })),
          h('div', { className: 'jm-bind-new' },
            h('input', { className: 'jm-input', value: newWs, placeholder: '新增工作区绑定：工作区路径（如 C:/work/my-project）', onChange: (e) => setNewWs(e.target.value) }),
            h('select', { className: 'jm-select', value: newWsCard, onChange: (e) => setNewWsCard(e.target.value) }, cardOptions(false)),
            h('button', {
              className: 'jm-btn jm-btn-sm',
              type: 'button',
              disabled: busy !== null || !newWs.trim(),
              onClick: () => runWrite('ws:new', '/bind',
                { scope: 'workspace', key: newWs.trim(), cardId: newWsCard },
                `已新增工作区绑定：${newWs.trim()}`,
                () => { setNewWs(''); setNewWsCard('none') }),
            }, busy === 'ws:new' ? '绑定中…' : '绑定'))),
          h(Panel, {
            title: '会话覆盖',
            kicker: 'SESSIONS',
            right: h('div', { className: 'jm-head-actions' }, h(Badge, { tone: 'idle' }, `${sessions.length} 条`)),
          },
          sessions.length === 0 ? h(Empty, null, '没有会话覆盖（跟随工作区/默认卡）') : h('div', { className: 'jm-table jm-bind-table' },
            h('div', { className: 'jm-table-head' }, h('span', null, '会话 id'), h('span', null, '人格卡 / 操作')),
            sessions.map(([k, v]) => {
              const val = sesEdits[k] !== undefined ? sesEdits[k] : v
              return h('div', { key: k, className: 'jm-table-row jm-bind-row' },
                h('span', { className: 'jm-mono jm-ellipsis', title: k }, k),
                h('span', { className: 'jm-bind-ctl' },
                  h('select', {
                    className: 'jm-select jm-select-sm',
                    value: val,
                    onChange: (e) => setSesEdits((s) => ({ ...s, [k]: e.target.value })),
                  }, cardOptions(true)),
                  h('button', {
                    className: 'jm-btn jm-btn-sm',
                    type: 'button',
                    disabled: busy !== null,
                    onClick: () => runWrite(`ses:${k}`, '/bind',
                      { scope: 'session', key: k, cardId: val },
                      val === '' ? `已删除会话覆盖：${k}` : `已绑定 ${k} → ${nameOf(val)}`,
                      () => setSesEdits((s) => ({ ...s, [k]: undefined }))),
                  }, busy === `ses:${k}` ? '保存中…' : '保存')))
            })),
          h('div', { className: 'jm-bind-new' },
            h('input', { className: 'jm-input', value: newSes, placeholder: '新增会话覆盖：会话 id', onChange: (e) => setNewSes(e.target.value) }),
            h('select', { className: 'jm-select', value: newSesCard, onChange: (e) => setNewSesCard(e.target.value) }, cardOptions(false)),
            h('button', {
              className: 'jm-btn jm-btn-sm',
              type: 'button',
              disabled: busy !== null || !newSes.trim(),
              onClick: () => runWrite('ses:new', '/bind',
                { scope: 'session', key: newSes.trim(), cardId: newSesCard },
                `已新增会话覆盖：${newSes.trim()}`,
                () => { setNewSes(''); setNewSesCard('none') }),
            }, busy === 'ses:new' ? '绑定中…' : '绑定')))))
    }

    // ── settings tab ───────────────────────────────────────────────────────
    function Toggle({ label, value, note }) {
      return h('div', { className: 'jm-toggle-row' },
        h('span', null, label),
        h('span', { className: `jm-toggle ${value ? 'is-on' : ''}`, title: '只读展示' }, value ? '开' : '关'),
        note ? h('span', { className: 'jm-muted jm-toggle-note' }, note) : null)
    }

    // 可写字段的界面描述（顺序 = 显示顺序）
    const SETTING_FIELDS = [
      { key: 'injectMaxChars', label: '记忆段字符上限', kind: 'number', step: 100, min: 500, max: 200000, unit: '字', hint: '只卡记忆段（core + 主题索引）；人格段不计入。超了保留首尾' },
      { key: 'injectCacheMs', label: '渲染缓存', kind: 'number', step: 100, min: 0, max: 600000, unit: 'ms', hint: '0 = 每轮重读；调小更实时、更耗一点' },
      { key: 'injectPersonaOrder', label: 'persona 段排序', kind: 'number', step: 0.1, min: -100, max: 100, unit: '', hint: '数字越小越靠前；改这个需要重启' },
      { key: 'injectMemoryOrder', label: 'memory 段排序', kind: 'number', step: 0.1, min: -100, max: 100, unit: '', hint: '默认 0.5（人格在前、记忆在后）；改这个需要重启' },
      { key: 'memoryLayered', label: '分层记忆（core + 主题索引）', kind: 'bool', hint: '关掉后只注入 core.md；开启则 core + 主题索引' },
      { key: 'memoryIndexMode', label: '主题索引口径', kind: 'enum', options: [['all', '全量索引'], ['recall', '仅召回'], ['off', '关闭']], hint: '仅召回模式镜台尚未实现检索，会退化为全量说明' },
      { key: 'subagentSkip', label: '子代理会话跳过注入', kind: 'bool', hint: '开启后 DSH 委派的子会话（origin: subagent）不再收到人格/记忆两段' },
      { key: 'compactionRecall', label: '压缩后补偿已查阅主题', kind: 'bool', hint: '会话被压缩后，下一次注入附上本会话读过主题的 key/摘要（不注入正文）' },
      { key: 'recallMaxTopics', label: '每组召回主题上限', kind: 'number', step: 1, min: 1, max: 20, unit: '条', hint: '压缩补偿最多列几个主题（1–20）' },
      { key: 'recallMaxChars', label: '召回与压缩补偿总字符上限', kind: 'number', step: 100, min: 200, max: 8000, unit: '字', hint: '补偿块预算（200–8000）；同时受「记忆段上限」剩余额度限制（不是另开一份预算）' },
      { key: 'maxBytes', label: '记忆文件大小上限', kind: 'number', step: 1024, min: 1024, max: 10485760, unit: '字节', hint: '单个记忆文件上限；memory_append 超过即拒绝，提示先精简合并' },
      // P2 / P2.5（2026-11-13 T2.5）：以前只有 agent 工具能改，UI 里找不到
      { key: 'autoRecall', label: '自动召回（默认关）', kind: 'bool', hint: '每回合按线索判断是否去寻枝预取旧记忆；默认关、只对 lab 生效。不确定就保持关' },
      { key: 'conflictCard', label: '冲突卡（默认关）', kind: 'bool', hint: '有未裁决矛盾时注入 ≤2 条 / ≤300 字的「两说并存」提示；默认关。它不是页面，没冲突时不会出现' },
    ]

    function SettingsTab({ rev, onRefresh }) {
      // hooks 必须在任何 return 之前（否则 loading→loaded 会改变 hook 顺序）
      const api = useApi('/settings', {}, true, rev)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const d = api.data || {}
      const jm = d.jianmu || {}
      const values = jm.values || {}
      const v = d.view || {}
      const inj = v.inject || {}
      const lim = v.limits || {}
      const takeover = d.mode === 'jianmu'
      const caps = jm.capabilities || {}
      const key0 = `${jm.settingsRevision ?? 'x'}|${d.generation ?? 'x'}|${takeover ? 1 : 0}`
      React.useEffect(() => {
        if (!api.data) return
        setForm({
          injectEnabled: values.injectEnabled !== false,
          injectMaxChars: String(values.injectMaxChars ?? 12000),
          injectCacheMs: String(values.injectCacheMs ?? 5000),
          injectPersonaOrder: String(values.injectPersonaOrder ?? 0),
          injectMemoryOrder: String(values.injectMemoryOrder ?? 0.5),
          cardSource: values.cardSource || 'jianmu',
          memoryLayered: values.memoryLayered !== false,
          memoryIndexMode: values.memoryIndexMode || 'all',
          subagentSkip: values.subagentSkip === true,
          compactionRecall: values.compactionRecall === true,
          recallMaxTopics: String(values.recallMaxTopics ?? 8),
          recallMaxChars: String(values.recallMaxChars ?? 1600),
          maxBytes: String(values.maxBytes ?? 262144),
          autoRecall: values.autoRecall === true,
          conflictCard: values.conflictCard === true,
        })
      }, [key0])

      if (api.loading && !api.data) return h(Loading)
      if (api.error) return h(ErrorBox, { error: api.error })

      const pristine = {
        injectEnabled: values.injectEnabled !== false,
        injectMaxChars: String(values.injectMaxChars ?? 12000),
        injectCacheMs: String(values.injectCacheMs ?? 5000),
        injectPersonaOrder: String(values.injectPersonaOrder ?? 0),
        injectMemoryOrder: String(values.injectMemoryOrder ?? 0.5),
        cardSource: values.cardSource || 'jianmu',
        memoryLayered: values.memoryLayered !== false,
        memoryIndexMode: values.memoryIndexMode || 'all',
        subagentSkip: values.subagentSkip === true,
        compactionRecall: values.compactionRecall === true,
        recallMaxTopics: String(values.recallMaxTopics ?? 8),
        recallMaxChars: String(values.recallMaxChars ?? 1600),
        maxBytes: String(values.maxBytes ?? 262144),
        autoRecall: values.autoRecall === true,
        conflictCard: values.conflictCard === true,
      }
      const cur = form || pristine
      const dirty = JSON.stringify(cur) !== JSON.stringify(pristine)
      const editable = jm.editable !== false

      function buildPatch() {
        const patch = {}
        if (cur.injectEnabled !== pristine.injectEnabled) patch.injectEnabled = cur.injectEnabled
        if (cur.cardSource !== pristine.cardSource) patch.cardSource = cur.cardSource
        for (const f of SETTING_FIELDS) {
          if (f.kind === 'bool' || f.kind === 'enum') {
            if (cur[f.key] !== pristine[f.key]) patch[f.key] = cur[f.key]
            continue
          }
          const a = Number(cur[f.key])
          const b = Number(pristine[f.key])
          if (Number.isFinite(a) && a !== b) patch[f.key] = a
        }
        return patch
      }

      async function doSave() {
        const patch = buildPatch()
        if (!Object.keys(patch).length) { setMsg({ tone: 'warn', text: '没有改动' }); return }
        setBusy(true)
        setMsg(null)
        try {
          const st = await getStatus()
          const r = await post('/settings', { patch, expectedGeneration: st.generation, confirm: true })
          const changed = (r.changed || []).map((k) => (SETTING_FIELDS.find((f) => f.key === k)?.label || k))
          const tail = r.requiresRestart ? '；段顺序改动需重启生效' : ''
          setMsg({ tone: 'success', text: `已保存：${changed.join('、') || '无变化'}${r.noop ? '（值没变）' : ''}${tail}` })
          if (onRefresh) onRefresh()
        } catch (e) {
          if (e.code === 'STALE_GENERATION') {
            setMsg({ tone: 'warn', text: '有人先改过了，已为您刷新，请确认后再次保存' })
            if (onRefresh) onRefresh()
          } else {
            setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
          }
        } finally {
          setBusy(false)
        }
      }

      function fieldRow(f) {
        if (f.kind === 'bool') {
          return h('div', { className: 'jm-toggle-row', key: f.key },
            h('span', null, f.label),
            h('button', {
              className: `jm-btn jm-btn-sm ${cur[f.key] ? 'jm-btn-primary' : ''}`,
              type: 'button',
              disabled: busy || !editable,
              onClick: () => setForm({ ...cur, [f.key]: !cur[f.key] }),
            }, cur[f.key] ? '开' : '关'),
            h('span', { className: 'jm-muted jm-toggle-note' }, f.hint || ''))
        }
        if (f.kind === 'enum') {
          return h('label', { className: 'jm-field', key: f.key },
            h('span', null, f.label),
            h('select', {
              className: 'jm-select',
              value: cur[f.key],
              disabled: busy || !editable,
              onChange: (e) => setForm({ ...cur, [f.key]: e.target.value }),
            }, (f.options || []).map(([val, label]) => h('option', { key: val, value: val }, label))),
            h('span', { className: 'jm-muted jm-toggle-note' }, f.hint || ''))
        }
        const bad = !Number.isFinite(Number(cur[f.key]))
        return h('label', { className: 'jm-field', key: f.key },
          h('span', null, `${f.label}${f.unit ? `（${f.unit}）` : ''}`),
          h('input', {
            className: 'jm-input',
            type: 'number',
            value: cur[f.key],
            step: f.step,
            min: f.min,
            max: f.max,
            disabled: busy || !editable,
            onChange: (e) => setForm({ ...cur, [f.key]: e.target.value }),
          }),
          h('span', { className: 'jm-muted jm-toggle-note' },
            `${f.hint}${bad ? ' ⚠️ 需要填数字' : ''}`))
      }

      return h('div', { className: 'jm-tab-body' },
        h('div', { className: 'jm-warn-line' },
          takeover
            ? '镜台已接管注入：人格段走 jianmu:persona，记忆段走 jianmu:memory。'
            : '镜台未接管：下面改的是镜台自己的设置，打开接管后才生效。',
          h('span', { className: 'jm-muted' }, `（值来源：${jm.settingsSource === 'registry' ? '镜台设置' : '启动配置'}${jm.settingsRevision ? `，第 ${jm.settingsRevision} 版` : ''}）`)),

        h('div', { className: 'jm-grid' },
          h(Panel, {
            title: '镜台注入（可改）',
            kicker: 'JIANMU INJECTION',
            right: h('div', { className: 'jm-head-actions' },
              h(Badge, { tone: takeover ? 'success' : 'idle' }, takeover ? '已接管' : '未接管'),
              dirty ? h(Badge, { tone: 'warn' }, '有未保存改动') : null),
          },
          h('div', { className: 'jm-form' },
            h('div', { className: 'jm-toggle-row' },
              h('span', null, '接管注入'),
              h('button', {
                className: `jm-btn jm-btn-sm ${cur.injectEnabled ? 'jm-btn-primary' : ''}`,
                type: 'button',
                disabled: busy || !editable,
                title: cur.injectEnabled
                  ? '关掉后镜台立刻停止注入（等于谁都不注入人格与记忆）'
                  : '打开后镜台当场补注册注入段（若宿主不支持动态注册，则需要重启）',
                onClick: () => setForm({ ...cur, injectEnabled: !cur.injectEnabled }),
              }, cur.injectEnabled ? '开' : '关'),
              h('span', { className: 'jm-muted jm-toggle-note' }, '关掉 = 镜台不再注入人格与记忆')),
            h('label', { className: 'jm-field' },
              h('span', null, '人格卡来源'),
              h('select', {
                className: 'jm-select',
                value: cur.cardSource,
                disabled: busy || !editable,
                onChange: (e) => setForm({ ...cur, cardSource: e.target.value }),
              },
              h('option', { value: 'jianmu' }, '镜台卡（persona/cards/*/card.md，真源）'),
              h('option', { value: 'soul-md' }, '旧版卡（回退）')),
              h('span', { className: 'jm-muted jm-toggle-note' }, '镜台卡读失败会自动回退旧版卡；改这个当场生效（下一轮注入起）')),
            SETTING_FIELDS.map(fieldRow)),
          h('div', { className: 'jm-editor-status' },
            msg ? h(Notice, { msg, onClose: () => setMsg(null) }) : null),
          h('div', { className: 'jm-actions' },
            h('button', {
              className: 'jm-btn jm-btn-primary',
              type: 'button',
              onClick: doSave,
              disabled: busy || !dirty || !editable,
              title: dirty ? '写进 registry.settings（带 generation 并发闸门）' : '没有未保存的改动',
            }, busy ? '保存中…' : '保存设置'),
            h('button', {
              className: 'jm-btn',
              type: 'button',
              disabled: busy || !dirty,
              onClick: () => { setForm(pristine); setMsg(null) },
            }, '放弃改动')),
          h('div', { className: 'jm-footnote' },
            editable
              ? `设置落在 registry.json 的 settings 字段（${jm.settingsFile || '—'}）。injectEnabled / injectMaxChars / injectCacheMs 当场生效，段顺序需重启。自动召回与冲突卡默认关；冲突卡是注入给 AI 的提示，不是页面，没冲突时不会出现。`
              : '镜台总开关（enabled=false）关着：设置不可写。')),

          h(Panel, { title: '说明', kicker: 'NOTES' },
            h('ul', { className: 'jm-list-plain' },
              (v.notes || []).map((n, i) => h('li', { key: `n${i}` }, n)),
              Object.entries(caps.liveEffect || {}).map(([k, txt], i) => h('li', { key: `e${i}` }, `${k}：${txt}`))),
            h('div', { className: 'jm-footnote' }, takeover
              ? '回退：用备份的配置覆盖回去并重启（备份目录见交接书）。'
              : '这些值改由镜台管理。'))))
    }

    // ── versions tab ───────────────────────────────────────────────────────
    function VersionsTab({ cardId, rev, onRefresh }) {
      const versions = useApi('/versions', { cardId }, Boolean(cardId), rev)
      const [from, setFrom] = React.useState(1)
      const [to, setTo] = React.useState('current')
      const [want, setWant] = React.useState(false)
      const [roll, setRoll] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const diff = useApi('/diff', { cardId, from, to }, Boolean(cardId && want), rev)
      if (!cardId) return h(Empty, null, '先选一张卡')
      if (versions.loading && !versions.data) return h(Loading)
      if (versions.error) return h(ErrorBox, { error: versions.error })
      const rows = versions.data?.versions || []
      const current = Number(versions.data?.current) || 0

      async function doRollback(revision) {
        setBusy(true)
        setMsg(null)
        try {
          const st = await getStatus()
          const res = await post('/rollback', { cardId, revision, expectedGeneration: st.generation, confirm: true })
          const nv = Number(res.version ?? res.revision ?? res.card?.version ?? (current + 1))
          setRoll(null)
          setMsg({ tone: 'success', text: `已回滚：写成新版本 v${Number.isFinite(nv) ? nv : current + 1}，快照在 _archive` })
          if (onRefresh) onRefresh()
        } catch (e) {
          if (e.code === 'STALE_GENERATION') {
            setRoll(null)
            setMsg({ tone: 'warn', text: '有人先改过了，已为您刷新，请再试一次' })
            if (onRefresh) onRefresh()
          } else {
            setMsg({ tone: 'error', text: humanizeError(e), code: e.code })
          }
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'jm-tab-body' },
        h(Panel, {
          title: '版本历史',
          kicker: 'REVISIONS',
          right: h('div', { className: 'jm-head-actions' },
            h(Badge, { tone: 'brand' }, `当前卡片版 v${versions.data?.current ?? '—'}`),
            h('button', { className: 'jm-btn jm-btn-sm', type: 'button', onClick: () => setWant(true) }, '对比所选')),
        },
        rows.length === 0 ? h(Empty, null, '还没有版本记录') : h('div', { className: 'jm-table' },
          h('div', { className: 'jm-table-head jm-ver-head' }, h('span', null, '版本'), h('span', null, '时间'), h('span', null, '作者'), h('span', null, '原因'), h('span', null, '快照'), h('span', null, '操作')),
          rows.map((r) => {
            const canRoll = Boolean(r.snapshot) && !r.isCurrent
            const title = r.isCurrent ? '当前版本无需回滚' : (r.snapshot ? '把这个快照写成新版本' : '这一版没有快照，不能回滚')
            return h('div', { key: r.revision, className: 'jm-table-row jm-ver-row' },
              h('span', null, `v${r.revision}`, r.isCurrent ? h('span', { className: 'jm-muted' }, ' 当前') : null),
              h('span', null, time(r.createdAt)),
              h('span', null, labelAuthor(r.author)),
              h('span', { className: 'jm-ellipsis', title: r.reason || '' }, r.reason || '—'),
              h('span', { className: 'jm-ver-snap' }, r.snapshot ? h(Badge, { tone: 'success' }, '在位') : h(Badge, { tone: 'idle' }, '无')),
              h('span', { className: 'jm-ver-act' },
                h('button', {
                  className: 'jm-btn jm-btn-sm',
                  type: 'button',
                  disabled: !canRoll || busy,
                  title,
                  onClick: () => setRoll(r.revision),
                }, '回滚到此版')))
          }))),
        roll != null ? h(ConfirmBar, {
          tone: 'danger',
          text: `将回滚到 v${roll}（当前 v${current}），会写成新版本 v${current + 1}`,
          confirmLabel: '确认回滚',
          busy: busy ? '回滚中…' : null,
          onConfirm: () => doRollback(roll),
          onCancel: () => setRoll(null),
        }) : null,
        msg ? h(Notice, { msg, onClose: () => setMsg(null) }) : null,
        h('div', { className: 'jm-diffbar' },
          h('span', null, '对比'),
          h('select', { className: 'jm-select', value: String(from), onChange: (e) => { setFrom(Number(e.target.value)); setWant(true) } },
            rows.map((r) => h('option', { key: r.revision, value: r.revision }, `v${r.revision}`))),
          h('span', null, '→'),
          h('select', { className: 'jm-select', value: String(to), onChange: (e) => { setTo(e.target.value); setWant(true) } },
            h('option', { value: 'current' }, '当前'),
            rows.map((r) => h('option', { key: r.revision, value: r.revision }, `v${r.revision}`)))),
        want ? (diff.loading && !diff.data ? h(Loading)
          : diff.error ? h(ErrorBox, { error: diff.error })
            : h(Panel, {
              title: '差异',
              kicker: 'DIFF',
              right: h('div', { className: 'jm-head-actions' },
                h(Badge, { tone: 'success' }, `+${diff.data?.stats?.added ?? 0}`),
                h(Badge, { tone: 'error' }, `-${diff.data?.stats?.removed ?? 0}`)),
            },
            h('pre', { className: 'jm-diff' }, diff.data?.unified || '（无差异）'),
            h('div', { className: 'jm-footnote' }, '只读对比；回滚用上表每行的「回滚到此版」，回滚会写成新版本。注意：这里是**卡片内容版本**，不是插件版本（插件版本见页面右上角）。'))) : null)
    }

    // ── preview tab ────────────────────────────────────────────────────────
    function PreviewTab({ cardId, rev }) {
      const api = useApi('/preview', { cardId }, true, rev)
      if (api.loading && !api.data) return h(Loading)
      if (api.error) return h(ErrorBox, { error: api.error })
      const d = api.data || {}
      const segs = d.segments || []
      const isJm = d.mode === 'jianmu'
      // 口径：injectMaxChars 只卡「记忆段（core + 主题索引）」；人格段不计入。
      // 以前这一栏并排显示「总字符（人格+记忆）」与「记忆段上限」，很容易被读成同一个预算（2026-11-14 已踩）。
      const memCap = Number(d.memory?.cap || d.totals?.injectMaxChars || 12000)
      const memChars = Number(d.memory?.chars || 0)
      const personaChars = Number(d.persona?.chars || 0)
      const memPct = memCap > 0 ? Math.round((memChars / memCap) * 100) : 0
      const memRest = Math.max(0, memCap - memChars)
      return h('div', { className: 'jm-tab-body' },
        h('div', { className: 'jm-purpose' },
          h('b', null, isJm ? '这是镜台现在实际会注入的内容（jianmu:*）。' : '这是回退源实际会注入的内容（镜台未接管）。'),
          h('span', null, ' 预览只读：不触发注入、不写文件、不影响对话。')),
        (d.warnings || []).length ? h('div', { className: 'jm-warn-line' }, d.warnings.join('；')) : null,
        h('div', { className: 'jm-grid' },
          h(Panel, { title: '命中', kicker: 'RESOLUTION' },
            h('div', { className: 'jm-kv' },
              h('div', null, h('span', null, '注入卡'), h('b', null, d.cardName || '不注入')),
              h('div', null, h('span', null, '卡源'),
                h('b', null, isJm
                  ? (d.cardSource === 'jianmu' ? '镜台卡（真源）' : d.cardSource === 'none' ? '绑定 none（不注入）' : '旧版卡（回退）')
                  : '旧版')),
              isJm && d.cardFile ? h('div', null, h('span', null, '卡文件'), h('b', { className: 'jm-mono' }, d.cardFile)) : null,
              isJm && d.fallbackReason ? h('div', null, h('span', null, '回退原因'), h('b', { className: 'jm-warn-text' }, d.fallbackReason)) : null,
              h('div', null, h('span', null, '解析依据'), h('b', null, d.resolution?.reason || '—')),
              h('div', null, h('span', null, '配置来源'), h('b', null, d.mode === 'jianmu' ? '镜台接管（jianmu:*）' : (d.settings?.resolvedFrom || '—'))),
              h('div', null, h('span', null, '记忆段（core + 主题索引）'),
                h('b', { className: memPct >= 90 && !d.memory?.truncated ? 'jm-warn-text' : null },
                  `${num(memChars)} / ${num(memCap)}（${memPct}% · 余 ${num(memRest)}）`)),
              h('div', null, h('span', null, '人格段'), h('b', null, `${num(personaChars)}（不计入上限）`)),
              h('div', null, h('span', null, '合计（仅参考）'),
                h('b', null, `${num(d.totals?.chars)}（人格 + 记忆，不受该上限约束）`)),
              h('div', null, h('span', null, '估算 token'), h('b', null, num(d.totals?.tokensEstimate))))),
          h(Panel, { title: '段落', kicker: 'SEGMENTS', right: h(Badge, { tone: 'brand' }, `${segs.length} 段`) },
            h('div', { className: 'jm-seg-list' },
              segs.map((s) => h('div', { key: s.name, className: 'jm-seg' },
                h('div', { className: 'jm-seg-head' },
                  h('b', null, s.name),
                  s.included === true ? h(Badge, { tone: 'success' }, '注入') : s.included === false ? h(Badge, { tone: 'idle' }, '未注入') : h(Badge, { tone: 'warn' }, '运行时'),
                  h('span', { className: 'jm-muted' }, s.chars != null ? `${num(s.chars)} 字符` : '—'),
                  h('span', { className: 'jm-muted' }, s.tokensEstimate != null ? `≈${num(s.tokensEstimate)} token` : '')),
                s.truncated ? h('div', { className: 'jm-seg-reason' }, `截断：${(s.reasons || []).join('；')}`) : null,
                s.reason ? h('div', { className: 'jm-seg-reason' }, s.reason) : null,
                s.scope ? h('div', { className: 'jm-footnote' }, `scope ${s.scope} · ${s.file || ''}`) : null)))),
          h(Panel, { title: '人格段', kicker: (segs[0]?.name || 'persona').toUpperCase(), right: h(Badge, { tone: 'brand' }, `${num(d.persona?.chars)} 字`) },
            h('pre', { className: 'jm-preview-text' }, d.persona?.text || '（不注入）'))),
        h(Panel, {
          title: '记忆段',
          kicker: (segs[1]?.name || 'memory').toUpperCase(),
          right: h('div', { className: 'jm-head-actions' },
            h(Badge, { tone: 'brand' }, `${num(d.memory?.chars)} 字`),
            d.memory?.topics ? h(Badge, { tone: 'idle' }, `${num(d.memory.topics.length ?? d.memory.topics)} 个 topic`) : null,
            h(Badge, { tone: d.memory?.truncated ? 'warn' : 'success' }, d.memory?.truncated ? '有截断' : '完整')),
        },
          h('pre', { className: 'jm-preview-text jm-preview-memory' }, d.memory?.text || '（不注入）')))
    }

    // ── page ───────────────────────────────────────────────────────────────
    function PersonaPage() {
      const [tab, setTab] = React.useState('cards')
      const [rev, setRev] = React.useState(0)
      const [selected, setSelected] = React.useState(() => storedCard())
      const [dirty, setDirty] = React.useState(false)
      const [pendingTab, setPendingTab] = React.useState(null)
      const status = useApi('/status', {}, true, rev)
      const cards = useApi('/cards', {}, true, rev)

      const list = cards.data?.cards || []
      const active = cards.data?.activeCardId || null
      React.useEffect(() => {
        if (!list.length) return
        const exists = selected && list.some((c) => c.cardId === selected)
        if (!exists) {
          const pick = active && list.some((c) => c.cardId === active) ? active : list[0].cardId
          setSelected(pick)
          saveCard(pick)
        }
      }, [cards.data])

      const choose = (id) => { setSelected(id); saveCard(id) }
      const refresh = () => setRev((x) => x + 1)
      const changeTab = (id) => {
        if (id === tab) return
        if (dirty) { setPendingTab(id); return }
        setTab(id)
      }
      const confirmTabChange = () => {
        const id = pendingTab
        setPendingTab(null)
        setDirty(false)
        if (id) setTab(id)
      }
      const onDeleted = () => {
        setDirty(false)
        setSelected(null)
        refresh()
      }
      const st = status.data || {}
      const tabs = [
        ['cards', '卡片'],
        ['bindings', '默认与绑定'],
        ['settings', '注入设置'],
        ['versions', '版本历史'],
        ['preview', '注入预览'],
      ]
      return h('div', { className: 'jm-page jm-persona' },
        h('style', null, CSS),
        h(ViewHead, {
          title: '人格卡',
          subtitle: `建木 · 人格层 · 镜台（v${PLUGIN_VERSION} · 注入接管）`,
          onRefresh: refresh,
          right: h('div', { className: 'jm-head-actions' },
            h(Badge, { tone: 'brand' }, `v${PLUGIN_VERSION}`),
            h(Badge, { tone: st.capabilities?.injectionTakeover ? 'success' : 'idle' }, st.capabilities?.injectionTakeover ? '已接管注入' : '未接管注入')),
        }),
        status.error ? h(ErrorBox, { error: status.error, onRetry: refresh }) : null,
        h('div', { className: 'jm-intro' }, st.capabilities?.injectionTakeover
          ? '镜台（人格层）：人格卡与注入设置的唯一写者；当前已接管注入（jianmu:persona / jianmu:memory），人格与记忆都来自建木。'
          : '镜台（人格层）：人格卡的唯一写者。'),
        st.soulMd?.driftCount
          ? h('div', { className: 'jm-warn-line' }, `回退源漂移：${st.soulMd.drift.map((d) => d.name).join('、')}`)
          : null,
        st.initialized === false && !status.loading
          ? h('div', { className: 'jm-warn-line' }, '镜台目录尚未初始化：点「＋ 新增人格卡」新建一张。')
          : null,
        h('div', { className: 'jm-summary' },
          h(Stat, { label: '人格卡', value: num(st.cards), sub: st.activeCardId ? `默认 ${st.activeCardId}` : '未设默认' }),
          h(Stat, { label: '版本记录', value: num(st.versions), sub: '卡片内容版本，每次保存 +1' }),
          h(Stat, { label: 'generation', value: num(st.generation), sub: '写动作的并发闸门' }),
          h(Stat, { label: '回退源', value: st.soulMd?.ok ? '可读' : '已停用', tone: st.soulMd?.ok ? 'success' : 'idle', sub: st.soulMd?.ok ? '可用' : '不影响注入' })),
        h('div', { className: 'jm-tabs', role: 'tablist' },
          tabs.map(([id, label]) => h('button', {
            key: id, role: 'tab', 'aria-selected': tab === id,
            className: `jm-tab ${tab === id ? 'is-active' : ''}`,
            onClick: () => changeTab(id),
          }, label))),
        pendingTab ? h(ConfirmBar, {
          text: '当前编辑有未保存的修改，切换后会被丢弃。',
          confirmLabel: '确认切换',
          onConfirm: confirmTabChange,
          onCancel: () => setPendingTab(null),
        }) : null,
        tab === 'cards' ? h(CardsTab, {
          cards, selected, onSelect: choose, rev,
          dirty,
          onDirtyChange: setDirty,
          onRefresh: refresh,
          onDeleted,
          onGoVersions: () => changeTab('versions'),
        }) : null,
        tab === 'bindings' ? h(BindingsTab, { rev, onRefresh: refresh }) : null,
        tab === 'settings' ? h(SettingsTab, { rev, onRefresh: refresh }) : null,
        tab === 'versions' ? h(VersionsTab, { cardId: selected, rev, onRefresh: refresh }) : null,
        tab === 'preview' ? h(PreviewTab, { cardId: selected, rev }) : null)
    }

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS = `
.jm-page{width:100%;height:100%;overflow:auto;padding:22px 26px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;box-sizing:border-box}
.jm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.jm-title-row{display:flex;align-items:center;gap:10px}
.jm-title{font-size:24px;line-height:1.2;margin:0;font-weight:650;letter-spacing:.2px}
.jm-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:5px}
.jm-readonly,.jm-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:999px;white-space:nowrap}
.jm-readonly{font-size:11px;padding:2px 8px;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.jm-head-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.jm-btn{font:inherit;font-size:12px;line-height:1;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.jm-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.jm-btn:disabled{opacity:.42;cursor:not-allowed}
.jm-btn-sm{padding:5px 9px;font-size:11px}
.jm-btn-ghost{background:transparent}
.jm-select,.jm-input{font:inherit;font-size:12px;height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 9px;box-sizing:border-box}
.jm-select{min-width:112px}
.jm-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);margin:16px 0 16px}
.jm-tab{font:inherit;font-size:13px;padding:9px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.jm-tab:hover{color:var(--dsw-alias-label-primary)}
.jm-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.jm-tab-body{display:flex;flex-direction:column;gap:14px}
.jm-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px}
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
.jm-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-stat-value{font-size:25px;line-height:1.2;font-weight:650;letter-spacing:-.2px;margin-top:2px}
.jm-stat-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jm-tone-success{color:var(--dsw-alias-state-success-primary)}
.jm-tone-warn{color:var(--dsw-alias-state-warn-primary)}
.jm-tone-error{color:var(--dsw-alias-state-error-primary)}
.jm-kv{display:flex;flex-direction:column;gap:7px}
.jm-kv>div{display:flex;justify-content:space-between;gap:14px;font-size:12px;min-width:0}
.jm-kv>div>span{color:var(--dsw-alias-label-secondary);flex:none}
.jm-kv>div>b{font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.jm-muted{color:var(--dsw-alias-label-secondary);font-size:11px}
.jm-warn-line{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-state-warn-primary);border-radius:9px;padding:8px 11px;font-size:12px}
.jm-footnote{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:9px}
.jm-intro{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:-4px 0 14px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.jm-purpose{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:8px 11px}
.jm-purpose b{color:var(--dsw-alias-label-primary)}
.jm-split{display:grid;grid-template-columns:minmax(200px,240px) minmax(0,1fr);gap:14px;align-items:start}
.jm-cardlist{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.jm-cardlist-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px}
.jm-cardrow{width:100%;display:flex;flex-direction:column;gap:5px;align-items:flex-start;text-align:left;font:inherit;padding:10px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.jm-cardrow:hover{background:var(--dsw-alias-bg-layer-2)}
.jm-cardrow.is-selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.jm-cardrow-name{font-size:13px;font-weight:600}
.jm-cardrow-badges{display:flex;gap:4px;flex-wrap:wrap}
.jm-editorpane{min-width:0}
.jm-form{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.jm-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-field .jm-input{width:100%}
.jm-inline-note{font-size:11px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}
.jm-zone-list{display:flex;flex-direction:column;gap:9px}
.jm-zone{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.jm-zone.is-protected{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent);border-style:dashed}
.jm-zone-head{width:100%;display:flex;align-items:center;gap:8px;font:inherit;font-size:12px;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.jm-zone-chevron{color:var(--dsw-alias-label-secondary);width:10px}
.jm-zone-title{font-weight:600}
.jm-zone-zone{font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}
.jm-zone-lock{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.jm-zone-chars{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.jm-zone-body{margin:0;padding:9px 11px;border-top:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.65;max-height:260px;overflow:auto;font-family:inherit}
.jm-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.jm-raw{margin-top:12px;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
.jm-hashes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;margin-top:12px}
.jm-hashes>div{display:flex;justify-content:space-between;gap:10px;font-size:11px}
.jm-hashes>div>span{color:var(--dsw-alias-label-secondary)}
.jm-table{display:flex;flex-direction:column}
.jm-table-head,.jm-table-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;padding:7px 2px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.jm-table-head{font-size:10.5px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.06em}
.jm-table-row:last-child{border-bottom:0}
.jm-ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.jm-ver-head,.jm-ver-row{grid-template-columns:90px 150px 90px minmax(0,1fr) 56px 96px}
.jm-toggles{display:flex;flex-direction:column;gap:2px}
.jm-toggle-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.jm-toggle-row:last-child{border-bottom:0}
.jm-toggle{font-size:10.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.jm-toggle.is-on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 25%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.jm-toggle-note{grid-column:1/-1;margin-top:-2px}
.jm-list-plain{margin:0;padding-left:18px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.jm-diffbar{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.jm-diff{margin:0;padding:11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.55}
.jm-seg-list{display:flex;flex-direction:column;gap:8px}
.jm-seg{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}
.jm-seg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px}
.jm-seg-head b{font-size:12px}
.jm-seg-reason{font-size:11px;color:var(--dsw-alias-state-warn-primary);margin-top:5px}
.jm-preview-text{margin:0;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;font-size:12px;line-height:1.6;font-family:inherit}
.jm-preview-memory{max-height:420px}
.jm-state{display:flex;align-items:center;gap:9px;padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px}
.jm-spinner{width:13px;height:13px;border-radius:999px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:jm-spin .8s linear infinite;display:inline-block}
@keyframes jm-spin{to{transform:rotate(360deg)}}
.jm-empty{padding:22px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
.jm-error{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:10px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.jm-error-detail{margin-top:3px;font-size:11px}
.jm-error-code{font-size:10px;opacity:.8;margin-top:2px;font-family:ui-monospace,Consolas,monospace}
@media (max-width:1100px){.jm-grid,.jm-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.jm-split{grid-template-columns:minmax(0,1fr)}.jm-ver-head,.jm-ver-row{grid-template-columns:70px 130px minmax(0,1fr) 56px 96px}.jm-ver-row>span:nth-child(3){display:none}}
@media (max-width:760px){.jm-page{padding:16px 14px 30px}.jm-summary{grid-template-columns:1fr 1fr}.jm-grid{grid-template-columns:minmax(0,1fr)}.jm-ver-head,.jm-ver-row{grid-template-columns:60px minmax(0,1fr) 56px 96px}.jm-ver-row>span:nth-child(3),.jm-ver-row>span:nth-child(4){display:none}}
.jm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.jm-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.jm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:transparent}
.jm-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.jm-editwrap{margin-top:12px;display:flex;flex-direction:column;gap:7px}
.jm-editlabel{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-textarea{width:100%;min-height:340px;resize:vertical;font-size:12px;line-height:1.6;padding:10px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-sizing:border-box;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace}
.jm-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.jm-editnote{margin-top:2px}
.jm-editor-status{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.jm-editor-status:empty{display:none}
.jm-msg{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border-radius:9px;font-size:12px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.jm-msg-text{flex:1;min-width:0}
.jm-msg-code{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);flex:none;padding-top:2px}
.jm-msg-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
.jm-msg-success{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.jm-msg-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.jm-msg-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent)}
.jm-msg-info{color:var(--dsw-alias-label-primary)}
.jm-confirm{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;border-radius:9px;font-size:12px;line-height:1.55;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.jm-confirm-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.jm-confirm-text{flex:1;min-width:0}
.jm-confirm-actions{display:flex;gap:6px;flex:none}
.jm-ai-bar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:9px 11px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);font-size:12px}
.jm-ai-main{min-width:0}
.jm-ai-warn{margin-top:4px;font-size:11px;color:var(--dsw-alias-state-warn-primary)}
.jm-bind-new{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.jm-bind-new .jm-input{flex:1;min-width:180px}
.jm-bind-new .jm-select{flex:none;max-width:220px}
.jm-bind-row{align-items:center}
.jm-bind-ctl{display:flex;align-items:center;gap:6px;justify-content:flex-end;min-width:0}
.jm-select-sm{height:28px;font-size:11.5px;min-width:0;flex:1;max-width:190px}
.jm-ver-snap{display:flex;align-items:center}
.jm-ver-act{display:flex;justify-content:flex-end}
.jm-ver-act .jm-btn{padding:4px 8px;font-size:10.5px}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx?.slots) return
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'jianmu-persona', order: 26,
          label: () => '人格卡',
        }, PersonaIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'jianmu-persona', locale: 'jianmu-persona',
        }, () => h(ErrorBoundary, null, h(PersonaPage))))
      },
    }
  },
})
