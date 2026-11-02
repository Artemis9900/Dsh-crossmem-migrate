/**
 * dsh-crossmem-qq —— 设置页「QQ 记忆库」区块（可选插件）
 *
 * 只做一件事：列出 QQ 桥里的群/私聊，让你自由挑选哪些进「QQ 公共记忆库」。
 * 数据来自本插件自己的 /api/crossmem-qq，不碰 crossmem core。
 */
window.__ModuleLoader__.load({
  id: 'dsh-crossmem-qq',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/crossmem-qq'

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
      [data-xq-wrap] { display: flex; flex-direction: column; gap: 10px; }
      [data-xq-row] { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      [data-xq-kv] { font-size: 12px; opacity: .75; }
      [data-xq-sub] { font-size: 12px; opacity: .6; line-height: 1.5; }
      [data-xq-list] { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow: auto; }
      [data-xq-item] { display: flex; align-items: center; gap: 8px; padding: 3px 2px; }
      [data-xq-item] [data-xq-title] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
      [data-xq-mini] { font-size: 11.5px; padding: 2px 8px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; }
      [data-xq-mini][data-on] { border-color: rgba(60,160,255,.7); color: rgb(60,160,255); }
      [data-xq-mini][data-danger] { border-color: rgba(220,80,80,.6); color: rgb(220,80,80); }
      [data-xq-tag] { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid rgba(60,160,255,.5); color: rgb(60,160,255); }
      [data-xq-msg] { font-size: 12px; }
    `

    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() {
        if (this.state.err) {
          return h('div', { 'data-xq-wrap': '' },
            h('div', { 'data-xq-kv': '' }, 'QQ 记忆库：这页出错了'),
            h('div', { 'data-xq-sub': '' }, String(this.state.err?.message ?? this.state.err)),
            h('button', { 'data-xq-mini': '', onClick: () => this.setState({ err: null }) }, '重试'))
        }
        return this.props.children
      }
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')

      const load = async () => setSt(await jget('/state'))
      React.useEffect(() => { load().catch((e) => setMsg('加载失败：' + e.message)) }, [])

      const act = async (name, fn) => {
        setBusy(name); setMsg('')
        try { await fn(); await load() } catch (e) { setMsg('失败：' + e.message) } finally { setBusy('') }
      }

      if (!st) return h('div', { 'data-xq-wrap': '' }, h('div', { 'data-xq-kv': '' }, 'QQ 记忆库：加载中…'))

      const convs = st.conversations || []
      const pool = st.qqPool || []
      const normal = convs.filter((x) => !x.isOwner)
      const inPoolCount = normal.filter((x) => x.inPool).length

      return h('div', { 'data-xq-wrap': '' },
        h('div', { 'data-xq-row': '' },
          h('span', { 'data-xq-kv': '' }, `QQ 公共记忆库（${inPoolCount}/${normal.length}）`),
          h('button', {
            'data-xq-mini': '', disabled: Boolean(busy),
            onClick: () => act('all', () => jpost('/pool', { all: true, inPool: true })),
          }, '全部加入'),
          h('button', {
            'data-xq-mini': '', 'data-danger': '', disabled: Boolean(busy),
            onClick: () => act('none', () => jpost('/pool', { all: true, inPool: false })),
          }, '清空'),
          h('span', { 'data-xq-kv': '', style: { marginLeft: 8 } },
            pool.length ? `仅池内 ${pool.length} 个会话共享` : '空 = 全部 QQ 会话共享')),

        h('div', { 'data-xq-sub': '' },
          'QQ 桥接机器人的会话，想加几个加几个：进库的会话彼此共享记忆；移出的只保留自己的。'
          + '管理员私信是单向汇（能读全库、写的不外流），不能加入。'),

        convs.length === 0
          ? h('div', { 'data-xq-sub': '' }, st.mapError ? `没读到 QQ 会话映射：${st.mapError}` : '没读到 QQ 会话映射')
          : h('div', { 'data-xq-list': '' },
            convs.map((c) => h('div', { key: c.key, 'data-xq-item': '' },
              h('span', {
                'data-xq-tag': '',
                style: c.isOwner ? { borderColor: 'rgba(220,150,80,.6)', color: 'rgba(220,150,80,.95)' } : undefined,
              }, c.kind === 'group' ? '群' : '私聊'),
              h('div', { 'data-xq-title': '', title: c.key }, c.key),
              c.isOwner
                ? h('span', { 'data-xq-kv': '' }, '管理员 · 单向（不可加入）')
                : h('button', {
                  'data-xq-mini': '', 'data-on': c.inPool ? '' : undefined, disabled: Boolean(busy),
                  onClick: () => act(c.key, () => jpost('/pool', { conversation: c.key, inPool: !c.inPool })),
                }, c.inPool ? '已加入' : '加入')))),

        h('div', { 'data-xq-kv': '', style: { opacity: .5 } },
          st.mapPath ? `映射来源：${st.mapPath}` : '映射来源：未找到 sessions.json'),

        msg ? h('div', { 'data-xq-msg': '' }, msg) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-crossmem-qq')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-crossmem-qq: 样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'crossmem-qq', order: 34, label: 'QQ 记忆库' },
          () => h(Boundary, null, h(Panel)),
        ))
      },
    }
  },
})
