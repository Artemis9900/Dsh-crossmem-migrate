/**
 * dsh-crossmem —— 浏览器半端（设置页「跨会话记忆」）
 * ============================================================================
 * v0.2 控制菜单（build 2）：
 *   1) 总开关：注入 / 自动记录
 *   2) 本地模型状态（名字 + 在不在 + 一键检测）
 *   3) 打通组：任意多个组，每组任意多个会话；组内共享，组外看不到
 *   4) 会话按工作区折叠
 *
 * 老规矩：整个面板包在 Boundary 里，出错只坏这一块，不会让整页消失。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-crossmem',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/crossmem'
    const PANEL_BUILD = 5

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      let detail = ''
      try { detail = (await res.json()).error || '' } catch { /* 非 JSON */ }
      throw new Error(`HTTP ${res.status}${why}${detail ? '：' + detail : ''}`)
    }
    const jget = (p) => fetch(API + p, { credentials: 'same-origin' }).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(asJson)

    const CSS = `
      [data-xm-wrap] { display: flex; flex-direction: column; gap: 12px; }
      [data-xm-row] { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      [data-xm-kv] { font-size: 12px; opacity: .75; }
      [data-xm-sub] { font-size: 12px; opacity: .6; line-height: 1.5; }
      [data-xm-list] { display: flex; flex-direction: column; gap: 6px; max-height: 380px; overflow: auto; }
      [data-xm-group] { border: 1px solid rgba(127,127,127,.22); border-radius: 10px; padding: 8px 10px; }
      [data-xm-group][data-hi] { border-color: rgba(60,160,255,.55); background: rgba(60,160,255,.06); }
      [data-xm-head] { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
      [data-xm-item] { display: flex; align-items: center; gap: 8px; padding: 4px 2px; }
      [data-xm-item] [data-xm-title] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
      [data-xm-mini] { font-size: 11.5px; padding: 2px 7px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; }
      [data-xm-mini][data-on] { border-color: rgba(60,160,255,.7); color: rgb(60,160,255); }
      [data-xm-mini][data-danger] { border-color: rgba(220,80,80,.6); color: rgb(220,80,80); }
      [data-xm-btn] { font-size: 12.5px; padding: 4px 10px; border-radius: 8px; cursor: pointer; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
      [data-xm-input] { font-size: 12.5px; padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
      [data-xm-tag] { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid rgba(60,160,255,.5); color: rgb(60,160,255); }
      [data-xm-msg] { font-size: 12px; }
      [data-xm-dot] { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    `

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() {
        if (this.state.err) {
          return h('div', { 'data-xm-wrap': '' },
            h('div', { 'data-xm-kv': '' }, '跨会话记忆：这页出错了'),
            h('div', { 'data-xm-sub': '' }, String(this.state.err?.message ?? this.state.err)),
            h('button', { 'data-xm-btn': '', onClick: () => this.setState({ err: null }) }, '重试'))
        }
        return this.props.children
      }
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [workspaces, setWorkspaces] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [newGroup, setNewGroup] = React.useState('')
      const [open, setOpen] = React.useState({})
      const [picking, setPicking] = React.useState({})
      const [groupOpen, setGroupOpen] = React.useState({})
      const [showArchived, setShowArchived] = React.useState(false)
      const [archivedCount, setArchivedCount] = React.useState(0)

      const load = async (opts = {}) => {
        const params = []
        if (opts.refresh) params.push('refresh=1')
        if (showArchived) params.push('showArchived=1')
        const q = params.length ? '?' + params.join('&') : ''
        const [s1, s2] = await Promise.all([
          jget('/state' + (opts.force ? '?force=1' : '')),
          jget('/sessions' + q),
        ])
        setSt(s1)
        setWorkspaces(s2.workspaces || [])
        setArchivedCount(Number(s2.archivedCount) || 0)
      }
      React.useEffect(() => { load().catch((e) => setMsg('加载失败：' + e.message)) }, [])

      const act = async (name, fn) => {
        setBusy(name); setMsg('')
        try { await fn(); await load() } catch (e) { setMsg('失败：' + e.message) } finally { setBusy('') }
      }
      const toggle = (key) => act(key, () => jpost('/switch', { [key]: !st[key] }))
      const groupAction = (body) => act('group:' + body.action, () => jpost('/group', body))

      if (!st) return h('div', { 'data-xm-wrap': '' }, h('div', { 'data-xm-kv': '' }, '跨会话记忆：加载中…'))

      const lm = st.localModel || {}
      const lmText = lm.status === 'ok'
        ? `本地模型 ✓ ${String(lm.model || '').split('/').pop()}`
        : lm.status === 'off'
          ? '本地模型：已关闭'
          : lm.status === 'missing'
            ? `本地模型 ✗ ${lm.reason || '未安装'}`
            : '本地模型：未探测'
      const lmColor = lm.status === 'ok' ? 'rgb(90,200,120)' : lm.status === 'missing' ? 'rgb(220,120,80)' : 'rgba(150,150,150,.8)'
      const groups = st.groups || []

      return h('div', { 'data-xm-wrap': '' },
        h('div', { 'data-xm-row': '' },
          h('div', { 'data-xm-kv': '' }, `跨会话记忆 · v0.2 · b${PANEL_BUILD}`),
          h('div', { 'data-xm-kv': '', style: { marginLeft: 'auto' } },
            `库 ${String(st.dbPath || '').split(/[\\/]/).pop()} · 曲线 ${st.curve} · 注入 ${st.injectCount} 条`)),

        h('div', { 'data-xm-row': '' },
          h('span', { 'data-xm-kv': '' }, '注入'),
          h('button', { 'data-xm-mini': '', 'data-on': st.inject ? '' : undefined, disabled: Boolean(busy), onClick: () => toggle('inject') }, st.inject ? '开' : '关'),
          h('span', { 'data-xm-kv': '', style: { marginLeft: 10 } }, '自动记录'),
          h('button', { 'data-xm-mini': '', 'data-on': st.capture ? '' : undefined, disabled: Boolean(busy), onClick: () => toggle('capture') }, st.capture ? '开' : '关'),
          h('span', { 'data-xm-kv': '', style: { marginLeft: 14, color: lmColor } },
            h('span', { 'data-xm-dot': '', style: { background: lmColor, marginRight: 5 } }), lmText),
          h('button', { 'data-xm-mini': '', disabled: Boolean(busy), onClick: () => act('probe', () => load({ force: true })) }, '检测')),

        h('div', { 'data-xm-row': '' },
          h('span', { 'data-xm-kv': '' }, `打通组（${groups.length}）`),
          h('input', {
            'data-xm-input': '', placeholder: '新组名字', value: newGroup, disabled: Boolean(busy),
            onChange: (e) => setNewGroup(e.target.value), style: { width: 130 },
          }),
          h('button', {
            'data-xm-btn': '', disabled: Boolean(busy) || !newGroup.trim(),
            onClick: () => act('create', async () => { await jpost('/group', { action: 'create', name: newGroup.trim() }); setNewGroup('') }),
          }, '建组')),

        h('div', { 'data-xm-sub': '' },
          '组内会话共享记忆，组外看不到；不在任何组里的会话只用「公共区」（所有会话都能看到）。'),

        groups.length === 0 ? null : h('div', { 'data-xm-list': '' },
          groups.map((g) => {
            const isOpen = groupOpen[g.id] === true   // 默认折叠
            return h('div', { key: g.id, 'data-xm-group': '', 'data-hi': '' },
              h('div', {
                'data-xm-head': '',
                title: isOpen ? '点一下折叠' : '点一下展开',
                onClick: (e) => {
                  // 点「删组」按钮时不要顺带折叠
                  if (e && e.target && e.target.tagName === 'BUTTON') return
                  setGroupOpen({ ...groupOpen, [g.id]: !isOpen })
                },
              },
                h('span', { 'data-xm-kv': '', style: { width: 10 } }, isOpen ? '▾' : '▸'),
                h('span', { 'data-xm-tag': '' }, g.name),
                h('span', { 'data-xm-kv': '' }, `${g.sessions.length} 个会话`),
                h('button', {
                  'data-xm-mini': '', 'data-danger': '', style: { marginLeft: 'auto' }, disabled: Boolean(busy),
                  onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); groupAction({ action: 'delete', groupId: g.id }) },
                }, '删组')),
              !isOpen ? null : (g.sessions.length === 0
                ? h('div', { 'data-xm-sub': '' }, '还没加会话 —— 在下面「按工作区」里给会话选组后点「加入」')
                : g.sessions.map((sid) => h('div', { key: sid, 'data-xm-item': '' },
                  h('div', { 'data-xm-title': '', title: sid }, sid.slice(0, 24)),
                  h('button', {
                    'data-xm-mini': '', 'data-danger': '', disabled: Boolean(busy),
                    onClick: () => groupAction({ action: 'remove', sessionId: sid }),
                  }, '移出')))))
          })),

        h('div', { 'data-xm-row': '', style: { marginTop: 4 } },
          h('span', { 'data-xm-kv': '' }, `会话 ${workspaces.reduce((n, w) => n + w.count, 0)} 个 · ${workspaces.length} 个工作区`),
          h('button', { 'data-xm-mini': '', disabled: Boolean(busy), onClick: () => act('refresh', () => load({ refresh: true })) }, '重新扫描'),
          h('button', {
            'data-xm-mini': '', 'data-on': showArchived ? '' : undefined,
            disabled: Boolean(busy),
            onClick: () => { const next = !showArchived; setShowArchived(next); act('archived', () => load()) },
          }, (showArchived ? '隐藏归档' : '显示归档') + (archivedCount ? ' ' + archivedCount : ''))),

        h('div', { 'data-xm-list': '' },
          workspaces.map((w) => {
            const isOpen = open[w.cwd] !== false
            return h('div', { key: w.cwd, 'data-xm-group': '' },
              h('div', {
                'data-xm-head': '',
                onClick: () => setOpen({ ...open, [w.cwd]: !isOpen }),
              },
                h('span', { 'data-xm-kv': '', style: { width: 10 } }, isOpen ? '▾' : '▸'),
                h('span', { 'data-xm-tag': '', style: { borderColor: 'rgba(127,127,127,.4)', color: 'inherit' } }, w.name),
                h('span', { 'data-xm-kv': '' }, `${w.count} 个会话${w.linked ? ` · ${w.linked} 已分组` : ''}`)),
              !isOpen ? null : w.sessions.map((x) => {
                const inGroup = groups.find((g) => g.sessions.includes(x.id))
                return h('div', { key: x.id, 'data-xm-item': '', style: x.archived ? { opacity: .55 } : undefined },
                  h('div', { 'data-xm-title': '', title: x.id }, String(x.title || '(无标题)').slice(0, 34)),
                  x.archived ? h('span', { 'data-xm-tag': '', style: { borderColor: 'rgba(160,160,160,.6)', color: 'rgba(160,160,160,.9)' } }, '归档') : null,
                  inGroup ? h('span', { 'data-xm-tag': '' }, inGroup.name) : null,
                  h('select', {
                    'data-xm-input': '', style: { fontSize: 11, padding: '1px 4px' },
                    value: picking[x.id] || '',
                    onChange: (e) => setPicking({ ...picking, [x.id]: e.target.value }),
                    disabled: Boolean(busy) || !groups.length,
                  },
                    h('option', { value: '' }, groups.length ? '选择组…' : '先建组'),
                    groups.map((g) => h('option', { key: g.id, value: g.id }, g.name))),
                  h('button', {
                    'data-xm-mini': '', disabled: Boolean(busy) || !picking[x.id],
                    onClick: () => groupAction({ action: 'add', groupId: picking[x.id], sessionId: x.id }),
                  }, '加入'),
                  inGroup ? h('button', {
                    'data-xm-mini': '', 'data-danger': '', disabled: Boolean(busy),
                    onClick: () => groupAction({ action: 'remove', sessionId: x.id }),
                  }, '移出') : null)
              }))
          })),

        msg ? h('div', { 'data-xm-msg': '' }, msg) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-crossmem')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-crossmem: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'crossmem', order: 33, label: '跨会话记忆' },
          () => h(Boundary, null, h(Panel)),
        ))
      },
    }
  },
})
