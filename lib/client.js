/**
 * dsh-session-explorer — 浏览器侧（Web 界面）。
 *
 * 这是**浏览器 bundle**，不是 ESM：外层必须是 `window.__ModuleLoader__.load({id, factory})`，
 * React 由宿主的模块表提供，不能自己再装一份。
 *
 * 数据来自宿主侧注册的同源路由 `/api/session-explorer`：
 *   GET  /state?q=…   统计 + 会话摘要 + 检索命中
 *   GET  /session?id= 单个会话的可读正文
 *   POST /refresh     强制重建索引
 *
 * 面板挂在左侧栏的「全局面板图标」+「主区域」这一对上：
 * `sidebar.panellist`（图标，id 即面板 id）负责入口，`main`（keyed）负责正文。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-explorer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 宿主路由前缀，必须与 lib/index.js 的 ROUTE_PATH 一致。 */
    const ROUTE = '/api/session-explorer'
    /** 面板 id：sidebarlist 的 id 与 main 的 key 都用它。 */
    const PANEL_ID = 'session-explorer'
    /** 轮询间隔：空闲 2s，检索时稍快一点。 */
    const POLL_IDLE_MS = 2000
    const POLL_SEARCH_MS = 1200

    /* ─────────────────────────── 样式 ─────────────────────────── */

    // 只引用宿主的 --dsw-alias-* 设计变量：主题改名最多让配色退化，不会让面板崩掉。
    const CSS = `
.sx-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.sx-head{display:flex;align-items:center;gap:10px;padding:calc(14px + var(--dsh-frame-top-clearance,0px)) 18px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.sx-title{display:flex;align-items:baseline;gap:8px;font-size:15px;font-weight:600;letter-spacing:.2px}
.sx-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.sx-search{flex:1;min-width:220px;display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2)}
.sx-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.sx-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit}
.sx-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sx-kbd{font-size:11px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 5px}
.sx-btn{height:30px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px}
.sx-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sx-btn:disabled{opacity:.5;cursor:default}
.sx-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.sx-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.sx-dot.busy{background:var(--dsw-alias-state-warn-primary)}
.sx-dot.off{background:var(--dsw-alias-state-idle-primary)}
.sx-scroll{flex:1;min-height:0;overflow:auto;padding:16px 18px 28px}
.sx-scroll::-webkit-scrollbar{width:8px;height:8px}
.sx-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.sx-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:16px}
.sx-card{padding:12px 14px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.sx-card-label{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.sx-card-value{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.sx-card-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.sx-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:12px;margin-bottom:16px}
@media (max-width:880px){.sx-grid{grid-template-columns:minmax(0,1fr)}}
.sx-panel{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px;min-width:0}
.sx-panel-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:12px}
.sx-panel-title small{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.sx-legend{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.sx-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.sx-bars{display:flex;align-items:flex-end;gap:6px;height:104px}
.sx-bar-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;gap:1px;min-width:0;height:100%}
.sx-bar-col:hover .sx-bar{filter:brightness(1.15)}
.sx-bar{border-radius:2px 2px 0 0;min-height:0}
.sx-bar.user{background:var(--dsw-alias-brand-primary)}
.sx-bar.assistant{background:var(--dsw-alias-state-business-primary)}
.sx-bar.tool{background:var(--dsw-alias-state-success-secondary)}
.sx-bar.other{background:var(--dsw-alias-state-idle-primary)}
.sx-axis{display:flex;gap:6px;margin-top:6px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.sx-axis span{flex:1;text-align:center;overflow:hidden;white-space:nowrap}
.sx-rank{display:flex;flex-direction:column;gap:8px}
.sx-rank-row{display:grid;grid-template-columns:minmax(56px,38%) 1fr auto;align-items:center;gap:8px;font-size:12px}
.sx-rank-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.sx-rank-track{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.sx-rank-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);opacity:.75}
.sx-rank-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sx-list{display:flex;flex-direction:column;gap:2px}
.sx-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;border:0;background:transparent;color:inherit;text-align:left;font:inherit;width:100%}
.sx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sx-row-main{min-width:0}
.sx-row-title{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.sx-row-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.sx-live-pill{font-size:10px;padding:0 5px;border-radius:3px;background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.sx-group{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);overflow:hidden;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.sx-group-head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sx-group-title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-group-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-hit{padding:9px 14px;border-top:.5px solid var(--dsw-alias-border-l1);cursor:pointer}
.sx-hit:first-of-type{border-top:0}
.sx-hit:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sx-hit-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.sx-chip{font-size:10px;padding:1px 6px;border-radius:3px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.sx-chip.user{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sx-chip.assistant{color:var(--dsw-alias-state-business-primary)}
.sx-chip.tool{color:var(--dsw-alias-state-success-primary)}
.sx-hit-time{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.sx-hit-text{font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;white-space:pre-wrap}
.sx-hit-text mark{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border-radius:2px;padding:0 1px}
.sx-empty{padding:46px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.7}
.sx-error{margin-bottom:12px;padding:10px 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}
.sx-overlay{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-drop);display:flex;justify-content:flex-end;z-index:20}
.sx-drawer{width:min(720px,100%);height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border-left:.5px solid var(--dsw-alias-border-l2);box-shadow:-8px 0 24px var(--dsw-alias-bg-mask-2)}
.sx-drawer-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sx-drawer-title{flex:1;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-drawer-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-drawer-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 24px}
.sx-msg{margin-bottom:14px}
.sx-msg-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.sx-msg-text{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sx-msg-text mark{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border-radius:2px}
`

    /* ─────────────────────────── 工具函数 ─────────────────────────── */

    /** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 / 日期。 */
    function relativeTime(time) {
      if (typeof time !== 'number' || time <= 0) return '—'
      const delta = Date.now() - time
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${String(Math.floor(delta / 60_000))} 分钟前`
      if (delta < 86_400_000) return `${String(Math.floor(delta / 3_600_000))} 小时前`
      if (delta < 7 * 86_400_000) return `${String(Math.floor(delta / 86_400_000))} 天前`
      const date = new Date(time)
      return `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
    }

    /** 绝对时间，用于 title 提示。 */
    function absoluteTime(time) {
      if (typeof time !== 'number' || time <= 0) return ''
      const date = new Date(time)
      const pad = (value) => String(value).padStart(2, '0')
      return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 大数字缩写：12.3k。 */
    function compactNumber(value) {
      const number = typeof value === 'number' ? value : 0
      if (number < 1000) return String(number)
      if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}k`
      return `${(number / 1_000_000).toFixed(1)}M`
    }

    /** 工作区路径缩写：只留最后两段。 */
    function shortPath(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return '未记录工作区'
      const parts = cwd.split(/[\\/]+/u).filter(Boolean)
      return parts.length <= 2 ? parts.join(' / ') : `… / ${parts.slice(-2).join(' / ')}`
    }

    /** 角色中文名。 */
    function roleLabel(role) {
      switch (role) {
        case 'user':
          return '你'
        case 'assistant':
          return '助手'
        case 'tool':
          return '工具'
        default:
          return '其他'
      }
    }

    /** 事件类型 → 更好读的短标签。 */
    function typeLabel(type) {
      const map = {
        'user/message': '消息',
        'assistant/message': '回复',
        'tool/call': '调用',
        'tool/result': '结果',
        'todo/write': '待办',
        'compaction/summary': '摘要',
        'turn/end': '回合',
      }
      return map[type] ?? type
    }

    /** 把 {text, marks} 渲染成带 <mark> 的片段。 */
    function renderMarked(excerpt, keyPrefix) {
      const text = excerpt?.text ?? ''
      const marks = Array.isArray(excerpt?.marks) ? excerpt.marks : []
      if (text === '' || marks.length === 0) return text
      const nodes = []
      let cursor = 0
      marks.forEach((range, index) => {
        const from = Math.max(0, Math.min(text.length, range[0]))
        const to = Math.max(from, Math.min(text.length, range[1]))
        if (from > cursor) nodes.push(text.slice(cursor, from))
        if (to > from) nodes.push(h('mark', { key: `${keyPrefix}-m${String(index)}` }, text.slice(from, to)))
        cursor = to
      })
      if (cursor < text.length) nodes.push(text.slice(cursor))
      return nodes
    }

    /**
     * 数据钩子：拉取面板快照 + 轮询。
     * @param {string} query 用户输入。
     */
    function useExplorer(query) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [pending, setPending] = useState(true)
      const mounted = useRef(true)
      const timer = useRef(null)
      const controller = useRef(null)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (timer.current !== null) clearTimeout(timer.current)
          controller.current?.abort?.()
        }
      }, [])

      const load = useCallback(async () => {
        controller.current?.abort?.()
        const next = typeof AbortController === 'function' ? new AbortController() : null
        controller.current = next
        try {
          const url = `${ROUTE}/state?q=${encodeURIComponent(query)}`
          const response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: next?.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          const payload = await response.json()
          if (!mounted.current) return
          if (payload?.ok !== true) throw new Error(payload?.error ?? '宿主返回了错误')
          setData(payload)
          setError('')
        } catch (cause) {
          if (!mounted.current) return
          if (cause?.name === 'AbortError') return
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (mounted.current) setPending(false)
        }
      }, [query])

      // 输入变化：短防抖后立刻查一次。
      useEffect(() => {
        setPending(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = null
          void load()
        }, 180)
        return () => {
          if (timer.current !== null) {
            clearTimeout(timer.current)
            timer.current = null
          }
        }
      }, [load])

      // 常驻轮询：让「实时」真的实时。
      useEffect(() => {
        const interval = query.trim() === '' ? POLL_IDLE_MS : POLL_SEARCH_MS
        const id = setInterval(() => void load(), interval)
        return () => clearInterval(id)
      }, [load, query])

      const refresh = useCallback(async () => {
        try {
          await fetch(`${ROUTE}/refresh`, { method: 'POST' })
        } catch {
          /* 刷新失败不影响下一次轮询 */
        }
        void load()
      }, [load])

      return { data, error, pending, reload: load, refresh }
    }

    /**
     * 详情钩子：按 id 拉一个会话的可读正文。
     * @param {string | null} id 会话 id。
     */
    function useSessionDetail(id) {
      const [state, setState] = useState({ loading: false, data: null, error: '' })

      useEffect(() => {
        if (id === null) {
          setState({ loading: false, data: null, error: '' })
          return undefined
        }
        let alive = true
        setState({ loading: true, data: null, error: '' })
        void (async () => {
          try {
            const response = await fetch(`${ROUTE}/session?id=${encodeURIComponent(id)}`, {
              headers: { accept: 'application/json' },
            })
            const payload = await response.json()
            if (!alive) return
            if (payload?.ok !== true) throw new Error(payload?.error ?? '读取失败')
            setState({ loading: false, data: payload, error: '' })
          } catch (cause) {
            if (!alive) return
            setState({ loading: false, data: null, error: cause instanceof Error ? cause.message : String(cause) })
          }
        })()
        return () => {
          alive = false
        }
      }, [id])

      return state
    }

    /* ─────────────────────────── 组件 ─────────────────────────── */

    /** 统计卡片。 */
    function StatCards({ data }) {
      const totals = data?.stats?.totals ?? {}
      const sessions = data?.sessions ?? []
      const live = sessions.filter((item) => item.live).length
      const workspaces = new Set(sessions.map((item) => item.cwd).filter(Boolean)).size
      const cards = [
        { label: '会话', value: compactNumber(totals.sessions ?? sessions.length), note: live > 0 ? `${String(live)} 个正在聊` : '全部历史' },
        { label: '可检索消息', value: compactNumber(totals.user + totals.assistant + totals.tool || 0), note: `工具调用 ${compactNumber(totals.tool ?? 0)} 条` },
        { label: '文本量', value: compactNumber(totals.characters ?? 0), note: '字符（已抽取正文）' },
        { label: '工作区', value: String(workspaces), note: '按会话 cwd 统计' },
      ]
      return h(
        'div',
        { className: 'sx-cards' },
        cards.map((card) =>
          h(
            'div',
            { className: 'sx-card', key: card.label },
            h('div', { className: 'sx-card-label' }, card.label),
            h('div', { className: 'sx-card-value' }, card.value),
            h('div', { className: 'sx-card-note' }, card.note),
          ),
        ),
      )
    }

    /** 近 14 天活动柱状图（纯 SVG 太细，用 div 堆叠更省事且自适应）。 */
    function Timeline({ timeline }) {
      const days = Array.isArray(timeline) ? timeline : []
      const max = days.reduce((top, day) => Math.max(top, day.user + day.assistant + day.tool + day.other), 0)
      const total = days.reduce((sum, day) => sum + day.user + day.assistant + day.tool + day.other, 0)

      return h(
        'div',
        { className: 'sx-panel' },
        h(
          'div',
          { className: 'sx-panel-title' },
          h('span', null, '近 14 天活动'),
          h('small', null, `${compactNumber(total)} 条`),
        ),
        h(
          'div',
          { className: 'sx-bars' },
          days.map((day) =>
            h(
              'div',
              { className: 'sx-bar-col', key: day.date, title: `${day.date}\n你 ${String(day.user)} · 助手 ${String(day.assistant)} · 工具 ${String(day.tool)}` },
              ['other', 'tool', 'assistant', 'user'].map((role) => {
                const count = day[role] ?? 0
                if (count === 0 || max === 0) return null
                return h('div', {
                  key: role,
                  className: `sx-bar ${role}`,
                  style: { height: `${String(Math.max(1, Math.round((count / max) * 88)))}px` },
                })
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'sx-axis' },
          days.map((day, index) =>
            h('span', { key: day.date }, index % 2 === 0 ? day.date.slice(5) : ''),
          ),
        ),
        h(
          'div',
          { className: 'sx-legend', style: { marginTop: '10px' } },
          ['user', 'assistant', 'tool'].map((role) =>
            h('span', { key: role }, h('i', { className: `sx-bar ${role}`, style: { height: '8px' } }), roleLabel(role)),
          ),
        ),
      )
    }

    /** 竖向排行条。 */
    function Ranking({ title, rows, unit }) {
      const items = Array.isArray(rows) ? rows : []
      const max = items.reduce((top, row) => Math.max(top, row.value), 0)
      return h(
        'div',
        { className: 'sx-panel' },
        h('div', { className: 'sx-panel-title' }, h('span', null, title)),
        items.length === 0
          ? h('div', { className: 'sx-empty', style: { padding: '18px 0' } }, '暂无数据')
          : h(
              'div',
              { className: 'sx-rank' },
              items.map((row) =>
                h(
                  'div',
                  { className: 'sx-rank-row', key: row.key, title: row.title ?? row.key },
                  h('span', { className: 'sx-rank-name' }, row.label ?? row.key),
                  h('span', { className: 'sx-rank-track' }, h('span', { className: 'sx-rank-fill', style: { width: `${String(max === 0 ? 0 : Math.round((row.value / max) * 100))}%` } })),
                  h('span', { className: 'sx-rank-value' }, `${compactNumber(row.value)}${unit ?? ''}`),
                ),
              ),
            ),
      )
    }

    /** 会话行。 */
    function SessionRow({ session, onOpen, hitCount }) {
      return h(
        'button',
        { type: 'button', className: 'sx-row', onClick: () => onOpen(session.id), title: absoluteTime(session.updatedAt) },
        h(
          'span',
          { className: 'sx-row-main' },
          h(
            'span',
            { className: 'sx-row-title' },
            session.live ? h('span', { className: 'sx-live-pill' }, '进行中') : null,
            session.title,
          ),
          h('span', { className: 'sx-row-sub' }, `${shortPath(session.cwd)} · ${relativeTime(session.updatedAt)}`),
        ),
        h(
          'span',
          { className: 'sx-row-meta' },
          hitCount === undefined
            ? `${compactNumber(session.messages)} 条`
            : `${String(hitCount)} 处命中`,
        ),
      )
    }

    /** 概览页。 */
    function Overview({ data, onOpen }) {
      const sessions = Array.isArray(data?.sessions) ? data.sessions : []
      const stats = data?.stats ?? {}
      const tools = (stats.tools ?? []).map((item) => ({
        key: item.name,
        label: item.name,
        value: item.calls,
      }))
      const workspaces = (stats.workspaces ?? []).map((item) => ({
        key: item.cwd,
        label: shortPath(item.cwd),
        title: item.cwd,
        value: item.messages,
      }))

      return h(
        React.Fragment,
        null,
        h(StatCards, { data }),
        h(
          'div',
          { className: 'sx-grid' },
          h(Timeline, { timeline: stats.timeline }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } },
            h(Ranking, { title: '工具调用排行', rows: tools, unit: ' 次' }),
            h(Ranking, { title: '工作区分布', rows: workspaces, unit: ' 条' }),
          ),
        ),
        h(
          'div',
          { className: 'sx-panel' },
          h(
            'div',
            { className: 'sx-panel-title' },
            h('span', null, '最近会话'),
            h('small', null, `${String(sessions.length)} 个`),
          ),
          sessions.length === 0
            ? h('div', { className: 'sx-empty' }, '还没有可索引的会话。开始聊一句，这里就会出现记录。')
            : h(
                'div',
                { className: 'sx-list' },
                sessions.slice(0, 40).map((session) => h(SessionRow, { key: session.id, session, onOpen })),
              ),
        ),
      )
    }

    /** 检索结果页。 */
    function Results({ data, onOpen, query }) {
      const groups = Array.isArray(data?.groups) ? data.groups : []
      const totalHits = data?.totalHits ?? 0

      if (groups.length === 0) {
        return h(
          'div',
          { className: 'sx-empty' },
          h('div', null, `没有找到包含「${query}」的记录`),
          h('div', { style: { marginTop: '6px', fontSize: '12px' } }, '多个关键词用空格分隔，会要求同时命中；中文可以只搜两个字。'),
        )
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'sx-panel-title', style: { padding: '0 2px 10px' } },
          h('span', null, '检索结果'),
          h('small', null, `${compactNumber(totalHits)} 处命中 · ${String(groups.length)} 个会话`),
        ),
        groups.map((group) =>
          h(
            'div',
            { className: 'sx-group', key: group.id },
            h(
              'div',
              { className: 'sx-group-head' },
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h('div', { className: 'sx-group-title' }, group.title),
                h('div', { className: 'sx-group-sub' }, `${shortPath(group.cwd)} · ${relativeTime(group.updatedAt)} · ${String(group.hitCount)} 处命中`),
              ),
              h('button', { type: 'button', className: 'sx-btn', onClick: () => onOpen(group.id) }, '查看全文'),
            ),
            group.hits.map((hit) =>
              h(
                'div',
                { className: 'sx-hit', key: `${group.id}-${String(hit.seq)}`, onClick: () => onOpen(group.id) },
                h(
                  'div',
                  { className: 'sx-hit-head' },
                  h('span', { className: `sx-chip ${hit.role}` }, roleLabel(hit.role)),
                  h('span', { className: 'sx-chip' }, typeLabel(hit.type)),
                  h('span', { className: 'sx-hit-time' }, absoluteTime(hit.time)),
                ),
                h('div', { className: 'sx-hit-text' }, renderMarked(hit.excerpt, `${group.id}-${String(hit.seq)}`)),
              ),
            ),
          ),
        ),
      )
    }

    /** 详情抽屉：整段对话的可读正文，关键词照样高亮。 */
    function DetailDrawer({ sessionId, query, openSession, onClose }) {
      const { loading, data, error } = useSessionDetail(sessionId)
      const terms = useMemo(
        () => query.trim().split(/\s+/u).filter(Boolean).map((term) => term.toLowerCase()),
        [query],
      )

      useEffect(() => {
        if (sessionId === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [sessionId, onClose])

      if (sessionId === null) return null
      const session = data?.session
      const events = Array.isArray(data?.events) ? data.events : []

      return h(
        'div',
        { className: 'sx-overlay', onClick: onClose },
        h(
          'div',
          { className: 'sx-drawer', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'sx-drawer-head' },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { className: 'sx-drawer-title' }, session?.title ?? '会话详情'),
              h(
                'div',
                { className: 'sx-drawer-sub' },
                session === undefined
                  ? '加载中…'
                  : `${shortPath(session.cwd)} · ${String(session.messages)} 条消息 · ${relativeTime(session.updatedAt)}`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'sx-btn',
                disabled: session === undefined,
                onClick: () => openSession(session.id),
                title: '在 DSH 里直接打开这个会话',
              },
              '打开会话',
            ),
            h('button', { type: 'button', className: 'sx-btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'sx-drawer-body' },
            error !== ''
              ? h('div', { className: 'sx-error' }, error)
              : loading
                ? h('div', { className: 'sx-empty' }, '正在读取…')
                : events.map((event) =>
                    h(
                      'div',
                      { className: 'sx-msg', key: String(event.seq) },
                      h(
                        'div',
                        { className: 'sx-msg-head' },
                        h('span', { className: `sx-chip ${event.role}` }, roleLabel(event.role)),
                        h('span', { className: 'sx-chip' }, typeLabel(event.type)),
                        h('span', { className: 'sx-hit-time' }, absoluteTime(event.time)),
                      ),
                      h('div', { className: 'sx-msg-text' }, highlightText(event.text, terms, String(event.seq))),
                    ),
                  ),
          ),
        ),
      )
    }

    /** 给正文做关键词高亮（详情页用；片段由前端自己算区间）。 */
    function highlightText(text, terms, keyPrefix) {
      const source = typeof text === 'string' ? text : ''
      if (source === '' || terms.length === 0) return source
      const lowered = source.toLowerCase()
      const spans = []
      for (const term of terms) {
        let index = lowered.indexOf(term)
        while (index !== -1) {
          spans.push([index, index + term.length])
          index = lowered.indexOf(term, index + term.length)
        }
      }
      if (spans.length === 0) return source
      spans.sort((a, b) => a[0] - b[0])
      const merged = []
      for (const span of spans) {
        const last = merged.at(-1)
        if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
        else merged.push(span)
      }
      const nodes = []
      let cursor = 0
      merged.forEach((span, index) => {
        if (span[0] > cursor) nodes.push(source.slice(cursor, span[0]))
        nodes.push(h('mark', { key: `${keyPrefix}-h${String(index)}` }, source.slice(span[0], span[1])))
        cursor = span[1]
      })
      if (cursor < source.length) nodes.push(source.slice(cursor))
      return nodes
    }

    /** 面板主体。 */
    function ExplorerPanel(props) {
      const [query, setQuery] = useState('')
      const [detailId, setDetailId] = useState(null)
      const { data, error, pending, refresh } = useExplorer(query)
      const openSession = useCallback(
        (id) => {
          try {
            props.openSession?.(id)
          } catch {
            /* 宿主没有暴露打开会话的能力时，静默降级 */
          }
        },
        [props],
      )
      const closeDetail = useCallback(() => setDetailId(null), [])
      const trimmed = query.trim()
      const index = data?.index
      const status = error !== ''
        ? { className: 'off', text: '宿主未连接' }
        : index?.building === true
          ? { className: 'busy', text: `索引中 ${String(data?.sessions?.length ?? 0)} 个会话` }
          : index?.ready === true
            ? { className: '', text: '实时' }
            : { className: 'busy', text: '准备中' }

      return h(
        'div',
        { className: 'sx-root', style: { position: 'relative' } },
        h(
          'div',
          { className: 'sx-head' },
          h('div', { className: 'sx-title' }, '会话检索', h('span', { className: 'sx-count' }, `${String(data?.sessions?.length ?? 0)} 个会话`)),
          h(
            'label',
            { className: 'sx-search' },
            h('input', {
              value: query,
              placeholder: '搜关键词：支持中文子串，空格分隔多个词',
              onChange: (event) => setQuery(event.target.value),
              spellCheck: false,
              'aria-label': '关键词检索',
            }),
            trimmed !== ''
              ? h('button', { type: 'button', className: 'sx-kbd', style: { cursor: 'pointer', background: 'transparent' }, onClick: () => setQuery('') }, '清空')
              : h('span', { className: 'sx-kbd' }, '/'),
          ),
          h('button', { type: 'button', className: 'sx-btn', onClick: () => void refresh(), disabled: pending === true }, '刷新'),
          h('span', { className: 'sx-status' }, h('span', { className: `sx-dot ${status.className}` }), status.text),
        ),
        h(
          'div',
          { className: 'sx-scroll' },
          error !== ''
            ? h(
                'div',
                { className: 'sx-error' },
                `连不上宿主侧接口（${error}）。请确认 dsh-session-explorer 已安装并在本 profile 生效；若刚安装，重启一次 DSH。`,
              )
            : null,
          data === null
            ? h('div', { className: 'sx-empty' }, '正在读取会话索引…')
            : trimmed === ''
              ? h(Overview, { data, onOpen: setDetailId })
              : h(Results, { data, onOpen: setDetailId, query: trimmed }),
        ),
        h(DetailDrawer, { sessionId: detailId, query: trimmed, openSession, onClose: closeDetail }),
      )
    }

    /** 左侧栏图标。 */
    function ExplorerIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M15.4 15.4 21 21', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M7.6 11.8v-2M10.5 11.8v-4M13.4 11.8v-1.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.75 }),
      )
    }

    /* ─────────────────────────── 插件入口 ─────────────────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式属于「资源」，必须在 effect 里注册并返回清理函数。
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-session-explorer', 'styles')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-explorer: styles')

        // 左侧栏入口：id 即面板 id，点它就是选中 main 里同 key 的正文。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: '会话检索',
            },
            ExplorerIcon,
          ),
        )

        // 主区域正文：keyed slot，key 与上面的 id 对齐。
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({
                openSession: (id) => {
                  try {
                    // uiWorkspace 是可选服务：先用 ctx.get 拿，拿不到再按属性取，
                    // 两者都可能因未声明 inject 而抛，所以整段兜住。
                    const workspace =
                      typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
                    const target = workspace ?? ctx.uiWorkspace
                    target?.openSession?.(id)
                  } catch {
                    /* 打开失败不影响面板 */
                  }
                },
              }),
            },
            ExplorerPanel,
          ),
        )
      },
    }
  },
})
