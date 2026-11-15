window.__ModuleLoader__.load({
  id: 'dsh-memory-store',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/memory-store'
    // UI 显示的插件版本：与 package.json 一致（发布检查会强制核对）
    const PLUGIN_VERSION = '0.2.7'

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

    // 写动作：POST + JSON + 自定义头（跨源带不了，天然 CSRF 防护）+ confirm:true
    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-dsh-jianmu': '1' }
    const WRITE_ERROR_TEXT = {
      STALE_SETTINGS: '设置被人改过了（revision 变了）：已刷新，请重新保存',
      CSRF_BLOCKED: '缺少安全头（可能是旧页面，刷新后重试）',
      UNSUPPORTED_MEDIA_TYPE: '请求格式不对（缺少 JSON 头）',
      SETTINGS_UNAVAILABLE: '宿主没有可写的设置服务：请手工改 profile 的 cordis.patch.yml',
      UNKNOWN_SETTING: '有不认识的设置字段（可能 UI 与服务端版本不一致）',
      BAD_SETTING_VALUE: '设置值不合法',
      CONFIRM_REQUIRED: '需要确认后才写入',
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
        err.actualRevision = data?.actualRevision
        throw err
      }
      return data
    }

    function fmtTime(v) {
      if (v === undefined || v === null || v === '') return '—'
      const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
      if (Number.isNaN(d.getTime())) return String(v)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    function fmtNum(n) {
      const v = Number(n)
      if (!Number.isFinite(v)) return '—'
      return v.toLocaleString('zh-CN')
    }
    function fmtDay(v) {
      if (v === undefined || v === null || v === '') return '—'
      const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
      if (Number.isNaN(d.getTime())) return String(v)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    function fmtAgo(v) {
      if (!v) return '—'
      const t = typeof v === 'number' ? v : new Date(String(v)).getTime()
      if (!Number.isFinite(t)) return '—'
      const s = Math.max(0, Math.round((Date.now() - t) / 1000))
      if (s < 90) return `${s} 秒前`
      const m = Math.round(s / 60)
      if (m < 90) return `${m} 分钟前`
      const hrs = Math.round(m / 60)
      if (hrs < 48) return `${hrs} 小时前`
      return `${Math.round(hrs / 24)} 天前`
    }

    function Msg({ msg, onClose }) {
      if (!msg) return null
      return h('div', { className: `jm-msg jm-msg-${msg.tone || 'info'}` },
        h('span', null, msg.text),
        onClose ? h('button', { className: 'jm-msg-x', onClick: onClose, title: '关闭' }, '×') : null)
    }

    function Badge({ tone, children }) {
      return h('span', { className: `jm-badge jm-badge-${tone || 'muted'}` }, children)
    }

    function Card({ label, value, sub, tone }) {
      return h('div', { className: `jm-card ${tone ? `jm-card-${tone}` : ''}` },
        h('div', { className: 'jm-card-label' }, label),
        h('div', { className: 'jm-card-value' }, value),
        sub ? h('div', { className: 'jm-card-sub' }, sub) : null)
    }

    function Toggle({ checked, onChange, disabled }) {
      return h('button', {
        type: 'button',
        className: `jm-toggle ${checked ? 'on' : ''}`,
        onClick: () => { if (!disabled) onChange(!checked) },
        disabled: Boolean(disabled),
        role: 'switch',
        'aria-checked': Boolean(checked),
      }, h('span', { className: 'jm-toggle-knob' }))
    }

    // 出错不能白屏：错误边界只换掉自己这一块，不牵连别的面板
    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(e) { return { err: e } }
      render() { return this.state.err ? h(ErrorBox, { error: this.state.err }) : this.props.children }
    }

    function ErrorBox({ error }) {
      return h('div', { className: 'jm-error' },
        h('div', null,
          h('b', null, '根藏界面出错了'),
          h('div', { className: 'jm-error-detail' }, String(error?.message || error)),
          h('div', { className: 'jm-error-code' }, '刷新页面可重试；数据层不受影响')),
        h('button', { className: 'jm-btn jm-btn-sm', onClick: () => location.reload() }, '刷新'))
    }

    function StoreIcon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('ellipse', { cx: 12, cy: 6, rx: 7, ry: 3 }),
      h('path', { d: 'M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6' }),
      h('path', { d: 'M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6' }))
    }

    // ── 主页面 ─────────────────────────────────────────────────────────────
    function StorePage() {
      const [rev, setRev] = React.useState(0)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [test, setTest] = React.useState(null)
      const status = useApi('/status', {}, true, rev)
      const st = status.data
      const s = st?.settings

      // 草稿：只在「第一次拿到设置」时初始化；保存成功后按服务端回值重置
      const [draft, setDraft] = React.useState(null)
      React.useEffect(() => {
        if (!s) return
        setDraft({
          autoIngest: Boolean(s.autoIngest?.value),
          embeddingApiBase: String(s.embeddingApiBase?.value || ''),
          embeddingApiKey: '',
        })
      }, [s?.revision, s?.autoIngest?.value, s?.embeddingApiBase?.value, s?.embeddingApiKey?.configured])

      const refresh = () => setRev((v) => v + 1)
      const dirty = Boolean(s && draft) && (
        draft.autoIngest !== Boolean(s.autoIngest?.value)
        || String(draft.embeddingApiBase || '') !== String(s.embeddingApiBase?.value || '')
        || String(draft.embeddingApiKey || '').length > 0
      )

      async function save() {
        if (!s || !draft) return
        const patch = {}
        if (draft.autoIngest !== Boolean(s.autoIngest?.value)) patch.autoIngest = Boolean(draft.autoIngest)
        if (String(draft.embeddingApiBase || '') !== String(s.embeddingApiBase?.value || '')) patch.embeddingApiBase = String(draft.embeddingApiBase || '').trim()
        if (String(draft.embeddingApiKey || '').length > 0) patch.embeddingApiKey = String(draft.embeddingApiKey).trim()
        if (!Object.keys(patch).length) {
          setMsg({ tone: 'warn', text: '没有改动：改一个字段再保存' })
          return
        }
        setBusy('save')
        setMsg(null)
        try {
          const r = await postWrite('/settings', { confirm: true, expectedRevision: s.revision, patch })
          setMsg({ tone: 'success', text: Object.prototype.hasOwnProperty.call(patch, 'embeddingApiKey') ? '已保存（密钥只写入、不会回显）' : '已保存，当场生效' })
          setTest(null)
          setDraft({
            autoIngest: Boolean(r.autoIngest?.value),
            embeddingApiBase: String(r.embeddingApiBase?.value || ''),
            embeddingApiKey: '',
          })
          refresh()
        } catch (e) {
          setMsg({ tone: 'error', text: writeErrText(e) })
          if (e?.code === 'STALE_SETTINGS') refresh()
        } finally {
          setBusy(null)
        }
      }

      async function clearKey() {
        if (!s) return
        if (!window.confirm('确定清除已保存的嵌入密钥？清除后自动摄取会停摆，直到重新填写（或寻枝配置里有 Key）。')) return
        setBusy('clear')
        setMsg(null)
        try {
          await postWrite('/settings', { confirm: true, expectedRevision: s.revision, patch: { embeddingApiKey: '' } })
          setMsg({ tone: 'success', text: '密钥已清除' })
          setTest(null)
          refresh()
        } catch (e) {
          setMsg({ tone: 'error', text: writeErrText(e) })
          if (e?.code === 'STALE_SETTINGS') refresh()
        } finally {
          setBusy(null)
        }
      }

      async function runTest() {
        setBusy('test')
        setTest(null)
        setMsg(null)
        try {
          const r = await postWrite('/test-embedding', { confirm: true })
          setTest(r)
        } catch (e) {
          setTest({ ok: false, message: writeErrText(e), latencyMs: 0 })
        } finally {
          setBusy(null)
        }
      }

      if (status.loading && !st) {
        return h('div', { className: 'jm-page' },
          h('div', { className: 'jm-state' }, h('span', { className: 'jm-spinner' }), '正在读取根藏状态…'))
      }
      if (status.error && !st) {
        return h('div', { className: 'jm-page' },
          h('div', { className: 'jm-page-head' },
            h('div', null, h('h2', { className: 'jm-title' }, '根藏'), h('div', { className: 'jm-subtitle' }, '存储层 · 原话摄取')),
            h('button', { className: 'jm-btn', onClick: refresh }, '重试')),
          h('div', { className: 'jm-error' },
            h('div', null,
              h('b', null, '读不到根藏状态'),
              h('div', { className: 'jm-error-detail' }, status.error.message),
              h('div', { className: 'jm-error-code' }, status.error.code || '')),
            h('button', { className: 'jm-btn jm-btn-sm', onClick: refresh }, '重试')))
      }

      const auto = st?.autoIngest || {}
      const totals = st?.totals || {}
      const scopes = st?.scopes || {}
      const scopeIds = Object.keys(scopes)
      const disk = st?.disk
      const embed = auto.embedding || {}
      const last = auto.lastReport
      const lastTone = auto.lastOk === true ? 'success' : (auto.lastOk === false ? 'error' : 'muted')
      const degraded = Boolean(st?.degraded)

      return h('div', { className: 'jm-page' }, h('div', { className: 'jm-wrap' },
        h('div', { className: 'jm-page-head' },
          h('div', null,
            h('h2', { className: 'jm-title' }, '根藏',
              h('span', { className: 'jm-ver' }, `v${st?.version || PLUGIN_VERSION}`)),
            h('div', { className: 'jm-subtitle' }, '存储层：把「谁、在什么时候、说了什么」原话落盘、可重建；不检索、不注入')),
          h('div', { className: 'jm-head-actions' },
            degraded ? h(Badge, { tone: 'warn' }, '有告警') : h(Badge, { tone: 'success' }, '正常'),
            h('button', { className: 'jm-btn', onClick: refresh, disabled: status.loading }, status.loading ? '刷新中…' : '刷新'))),

        msg ? h(Msg, { msg, onClose: () => setMsg(null) }) : null,

        h('div', { className: 'jm-cards' },
          h(Card, {
            label: '数据目录',
            value: h('span', { className: 'jm-mono' }, st?.dataRoot || '—'),
            sub: s?.dataRoot?.source === 'default' ? '默认位置（未在配置里指定）' : '来自配置（只读）',
          }),
          h(Card, { label: '总块数', value: fmtNum(totals.chunks), sub: `${fmtNum(totals.scopes)} 个人格 scope` }),
          h(Card, {
            label: '未归属',
            value: fmtNum(totals.unassignedChunks),
            sub: totals.unassignedChunks ? '存在于 persona_unassigned：需人工指派' : '没有待归属的块',
            tone: totals.unassignedChunks ? 'warn' : null,
          }),
          h(Card, {
            label: '磁盘余量',
            value: disk ? `${disk.freeGB} GB` : '—',
            sub: disk && disk.freeGB < 1 ? '偏低（只告警，不自动删）' : '数据根所在盘',
            tone: disk && disk.freeGB < 1 ? 'warn' : null,
          }),
          h(Card, {
            label: '上次自动摄取',
            value: auto.lastRunAt ? fmtAgo(auto.lastRunAt) : '还没跑',
            sub: last
              ? `${last.ok === false ? '失败' : '成功'}${last.skipped ? '（跳过）' : ''} · 写入 ${fmtNum(last.written)} 块`
              : '插件内定时，每小时 :' + String(auto.minute ?? 7).padStart(2, '0'),
            tone: lastTone === 'muted' ? null : lastTone,
          }),
          h(Card, {
            label: '下次自动摄取',
            value: auto.enabled ? fmtTime(auto.nextRunAt) : '已关闭',
            sub: auto.running ? '正在跑…' : (auto.enabled ? `间隔 ${auto.intervalMinutes} 分钟` : '开关在下面的设置里'),
            tone: auto.enabled ? null : 'warn',
          }),
          h(Card, {
            label: '嵌入服务',
            value: embed.configured ? '已配置' : '未配置',
            sub: embed.configured ? `来源：${embed.source || '—'}` : '不配置就没法补向量（块会存下但检索看不见）',
            tone: embed.configured ? 'success' : 'warn',
          })),

        // 告警原样展示：以前只在 degraded 时渲染，导致 defaultPersonaId 这类 warning 永远看不见
        (Array.isArray(st?.warnings) && st.warnings.length)
          ? h('div', { className: 'jm-warnbox' },
            h('b', null, '告警（原样列出，不只说「正常」）'),
            h('ul', null, st.warnings.map((w, i) => h('li', { key: i }, String(w)))))
          : null,

        // ── 人格 scope ────────────────────────────────────────────────────
        h('div', { className: 'jm-section' },
          h('div', { className: 'jm-section-head' }, h('h3', null, '人格 scope'), h('span', { className: 'jm-hint' }, '数字与工具 jianmu_store_status 同口径')),
          scopeIds.length
            ? h('div', { className: 'jm-table' },
              h('div', { className: 'jm-trow jm-thead' },
                h('span', null, '人格'), h('span', null, '块数'), h('span', null, '向量缺失'),
                h('span', null, '会话/工作区'), h('span', null, '时间范围'), h('span', null, '状态')),
              scopeIds.map((pid) => {
                const sc = scopes[pid] || {}
                const v = sc.vectors || {}
                const missing = Number(v.missing) || 0
                const bad = Number(v.badRows) || 0
                // sessions 是数字；workspaces 在 statusAll 里也可能是数字（不是数组），两种都认
                const wsCount = Array.isArray(sc.workspaces) ? sc.workspaces.length : (Number(sc.workspaces) || 0)
                return h('div', { className: 'jm-trow', key: pid },
                  h('span', { className: 'jm-mono' }, pid === 'persona_unassigned' ? '未归属' : pid),
                  h('span', null, fmtNum(sc.chunks)),
                  h('span', { className: missing || bad ? 'jm-bad' : '' },
                    missing ? `${fmtNum(missing)} 块缺` : '0', bad ? ` · 坏行 ${fmtNum(bad)}` : ''),
                  h('span', null, `${fmtNum(sc.sessions)} / ${fmtNum(wsCount)}`),
                  h('span', { className: 'jm-mono jm-small' },
                    sc.tMin || sc.tMax ? `${fmtDay(sc.tMin)} → ${fmtDay(sc.tMax)}` : '—'),
                  h('span', null, sc.degraded ? h(Badge, { tone: 'warn' }, '降级') : h(Badge, { tone: 'success' }, '正常')))
              }))
            : h('div', { className: 'jm-empty' }, '还没有任何人格的块：首次导入请让 Agent 调用 jianmu_store_ingest（会写一次完整快照）')),

        // ── 设置 ──────────────────────────────────────────────────────────
        h('div', { className: 'jm-section' },
          h('div', { className: 'jm-section-head' },
            h('h3', null, '设置'),
            h('span', { className: 'jm-hint' }, s?.writable ? '写入 profile 的 cordis.patch.yml（当场生效）' : '宿主设置服务不可用：只读')),

          !s?.writable
            ? h('div', { className: 'jm-warnbox' }, h('b', null, '这里只显示、不能改'),
              h('div', null, '宿主没有可写的设置服务。请手工编辑 profile 的 cordis.patch.yml 里 dsh-memory-store 条目的 config。'))
            : null,

          h('div', { className: 'jm-form' },
            h('div', { className: 'jm-field' },
              h('div', { className: 'jm-field-label' }, '自动摄取'),
              h('div', { className: 'jm-field-row' },
                h(Toggle, {
                  checked: Boolean(draft?.autoIngest),
                  disabled: !s?.writable || busy === 'save',
                  onChange: (v) => setDraft((d) => ({ ...d, autoIngest: v })),
                }),
                h('span', { className: 'jm-field-note' },
                  draft?.autoIngest ? '开着：每小时 :' + String(auto.minute ?? 7).padStart(2, '0') + ' 增量摄取（带向量）' : '关着：不追加新块，已有数据不受影响'))),

            h('div', { className: 'jm-field' },
              h('div', { className: 'jm-field-label' }, '嵌入接口地址'),
              h('input', {
                className: 'jm-input', type: 'text', spellCheck: false,
                placeholder: '留空 = https://api.siliconflow.cn/v1',
                value: draft?.embeddingApiBase ?? '',
                disabled: !s?.writable || busy === 'save',
                onChange: (e) => setDraft((d) => ({ ...d, embeddingApiBase: e.target.value })),
              }),
              h('div', { className: 'jm-field-note' }, 'OpenAI 兼容接口，填到 /v1 为止（不填就用默认）')),

            h('div', { className: 'jm-field' },
              h('div', { className: 'jm-field-label' }, '嵌入服务密钥',
                s?.embeddingApiKey?.configured
                  ? h(Badge, { tone: 'success' }, `已配置 · ${s.embeddingApiKey.source || ''}`)
                  : h(Badge, { tone: 'warn' }, '未配置')),
              h('div', { className: 'jm-field-row' },
                h('input', {
                  className: 'jm-input jm-grow', type: 'password', spellCheck: false, autoComplete: 'new-password',
                  placeholder: s?.embeddingApiKey?.configured ? '已保存，留空 = 不修改' : '粘贴 API Key（只写入，不回显）',
                  value: draft?.embeddingApiKey ?? '',
                  disabled: !s?.writable || busy === 'save',
                  onChange: (e) => setDraft((d) => ({ ...d, embeddingApiKey: e.target.value })),
                }),
                s?.embeddingApiKey?.configured
                  ? h('button', { className: 'jm-btn jm-btn-sm', disabled: busy === 'clear', onClick: clearKey }, busy === 'clear' ? '清除中…' : '清除')
                  : null),
              h('div', { className: 'jm-field-note' }, '只写不读：读接口只回「配没配」，任何日志都不落明文')),

            h('div', { className: 'jm-actions' },
              h('button', { className: 'jm-btn jm-btn-primary', disabled: !s?.writable || busy === 'save' || !dirty, onClick: save },
                busy === 'save' ? '保存中…' : '保存'),
              h('button', { className: 'jm-btn', disabled: busy === 'test', onClick: runTest }, busy === 'test' ? '测试中…' : '测试连接'),
              dirty ? h('span', { className: 'jm-hint' }, '有未保存的改动') : null))),

        test
          ? h('div', { className: `jm-test ${test.ok ? 'jm-test-ok' : 'jm-test-bad'}` },
            h('b', null, test.ok ? '连接成功' : '连接失败'),
            h('div', { className: 'jm-test-line' },
              test.ok
                ? `延迟 ${test.latencyMs} ms · 模型 ${test.model} · 维度 ${test.dim}${test.dimMatch === false ? '（与库不符！）' : ''}`
                : `${test.message || test.code}${test.latencyMs ? ` · ${test.latencyMs} ms` : ''}`),
            test.mixedModels ? h('div', { className: 'jm-test-line jm-bad' }, `注意：库里的人格用了不同模型：${(test.models || []).join('、')}`) : null)
          : null,

        // ── 说明 ──────────────────────────────────────────────────────────
        h('div', { className: 'jm-note' },
          h('b', null, '这一版只做「看得见 + 开得了」'),
          h('ul', null,
            h('li', null, '状态卡与设置之外，不提供导入向导、scope 管理、批量删除（首次导入让 Agent 调 jianmu_store_ingest；之后增量才用 tools/ingest-hourly.mjs）。'),
            h('li', null, '界面不会写、不会删任何记忆数据：只读状态 + 改插件设置。'),
            h('li', null, '设置写进 profile 的 cordis.patch.yml（volatile 字段热生效），不做第二层配置文件。'))),

        h('div', { className: 'jm-foot' },
          h('span', null, `根藏 v${st?.version || PLUGIN_VERSION}`),
          st?.checkedAt ? h('span', null, `· 读取于 ${fmtTime(st.checkedAt)}`) : null,
          st?.contractVersion ? h('span', null, `· 契约 v${st.contractVersion}`) : null)))
    }

    const CSS = `
.jm-page{width:100%;height:100%;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.jm-wrap{display:flex;flex-direction:column;gap:16px;padding:22px 26px 40px;max-width:1180px;margin:0 auto;box-sizing:border-box}
.jm-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.jm-title{margin:0;font-size:19px;font-weight:650;display:flex;align-items:center;gap:8px}
.jm-ver{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}
.jm-subtitle{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.jm-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.jm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.jm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px;display:flex;flex-direction:column;gap:3px;min-width:0}
.jm-card-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.jm-card-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent)}
.jm-card-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent)}
.jm-card-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jm-card-value{font-size:15px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jm-card-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5;white-space:normal;word-break:break-all}
.jm-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
.jm-small{font-size:11px}
.jm-bad{color:var(--dsw-alias-state-warn-primary)}
.jm-section{display:flex;flex-direction:column;gap:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px}
.jm-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.jm-section-head h3{margin:0;font-size:13.5px;font-weight:650}
.jm-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.jm-table{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden}
.jm-trow{display:grid;grid-template-columns:minmax(90px,1.1fr) 78px 108px 108px minmax(150px,1.4fr) 78px;gap:8px;align-items:center;padding:7px 10px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.jm-trow:last-child{border-bottom:0}
.jm-thead{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.jm-badge{display:inline-block;font-size:10.5px;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1)}
.jm-badge-success{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,transparent)}
.jm-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,transparent)}
.jm-badge-muted{color:var(--dsw-alias-label-secondary)}
.jm-badge-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent)}
.jm-form{display:flex;flex-direction:column;gap:12px}
.jm-field{display:flex;flex-direction:column;gap:5px}
.jm-field-label{font-size:12px;font-weight:560;display:flex;align-items:center;gap:7px}
.jm-field-row{display:flex;align-items:center;gap:8px}
.jm-field-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.55}
.jm-grow{flex:1;min-width:0}
.jm-input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.jm-input:disabled{opacity:.6}
.jm-toggle{width:40px;height:22px;border-radius:999px;border:1px solid #b8bcc6;background:#cfd3db;position:relative;cursor:pointer;padding:0;flex:none;transition:background .15s,border-color .15s;box-sizing:border-box}
.jm-toggle.on{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.jm-toggle:disabled{opacity:.5;cursor:default}
.jm-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .15s;display:block}
.jm-toggle.on .jm-toggle-knob{transform:translateX(18px)}
.jm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
.jm-btn{font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.jm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.jm-btn:disabled{opacity:.5;cursor:default}
.jm-btn-sm{font-size:11.5px;padding:4px 9px}
.jm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.jm-btn-primary:hover:not(:disabled){filter:brightness(1.06)}
.jm-msg{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.jm-msg-success{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.jm-msg-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.jm-msg-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.jm-msg-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
.jm-warnbox{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);border-radius:10px;padding:10px 13px;font-size:11.5px;line-height:1.65}
.jm-warnbox ul{margin:5px 0 0;padding-left:18px}
.jm-test{border-radius:10px;padding:10px 13px;font-size:12px;border:1px solid var(--dsw-alias-border-l1)}
.jm-test-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-state-success-primary)}
.jm-test-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.jm-test-line{margin-top:3px;color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.6;word-break:break-word}
.jm-note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:10px 13px}
.jm-note ul{margin:5px 0 0;padding-left:18px}
.jm-foot{display:flex;gap:5px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.jm-state{display:flex;align-items:center;gap:9px;padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px}
.jm-spinner{width:13px;height:13px;border-radius:999px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:jm-spin .8s linear infinite;display:inline-block}
@keyframes jm-spin{to{transform:rotate(360deg)}}
.jm-empty{padding:16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
.jm-error{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:10px;color:var(--dsw-alias-state-error-primary);font-size:12px}
.jm-error-detail{margin-top:3px;font-size:11px}
.jm-error-code{font-size:10px;opacity:.8;margin-top:2px;font-family:ui-monospace,Consolas,monospace}
@media (max-width:900px){.jm-trow{grid-template-columns:minmax(80px,1fr) 64px 90px 84px 74px}.jm-trow>span:nth-child(5){display:none}}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx?.slots) return
        let styleEl = null
        try {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-jianmu-store', PLUGIN_VERSION)
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
        } catch { /* 没有 DOM（非浏览器环境）就跳过样式 */ }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'jianmu-store', order: 24,
          label: () => '根藏',
        }, StoreIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'jianmu-store', locale: 'jianmu-store',
        }, () => h(ErrorBoundary, null, h(StorePage))))
      },
    }
  },
})
