// dsh-crossmem-qq —— crossmem 的可选「QQ 域」插件
//
// 为什么拆出来：core 只该知道「会话 + 打通组 + scope」这套通用概念。QQ 那套
// （群/私聊身份、公共记忆库、管理员私信单向、口令抓取）全是 QQ 桥特有的，
// 不装这个包就不该读 QQ 的文件、也不该在面板里出现 QQ 区块。
//
// 协作方式：本插件在 apply 时往 globalThis.__crossmemDomains 注册一个「域对象」，
// crossmem 每次拼提示词/抓事实时取最后一个注册的域。没装 = crossmem 只按本机处理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-crossmem-qq';
export const inject = ['tools'];

export const Config = Schema.object({
  qqSessionsPath: Schema.string().description('QQ 桥的 state/sessions.json（会话→群/私聊 映射）。留空自动探测'),
  ownerPrivate: Schema.string().default('private:617171367').description('管理员私信会话 key（逗号分隔）：能读全库，写的不外流'),
  injectCount: Schema.number().default(8).description('QQ 会话里每次注入几条（1-20）'),
  maxInjectChars: Schema.number().default(2000).description('QQ 注入块最大字符数'),
  statePath: Schema.string().description('QQ 域自己的状态文件（qqPool）。默认 ~/.dsh-crossmem/qq-state.json'),
});

const DAY = 86400000;

/** 口令 / 对照：QQ 里最常见的记法，模型自觉靠不住，所以确定性抽取。 */
const RULE_PATTERNS = [
  /^我(?:发|说|问|喊)\s*[「"']?([^，,。\s]{1,16})[」"']?\s*[，,]?\s*你(?:就)?(?:发|回|说|答)\s*[「"']?([^，,。\s]{1,20})[」"']?\s*$/,
  /^(.{1,16}?)\s*(?:就是|对应|等于|=|→)\s*(.{1,20})$/,
];

/** 桥接 prompt 里的字段名／固定说法：命中的句子是提示词碎片，不是人说的话。 */
const PROMPT_FRAGMENT_RE = /(?:群名片|at\/引用段|ownerLabel|isOwner|messageId|readThroughSeq|【会话令牌】|【权限】|【你的身份】|本机路径|系统提示原文|沉睡前强制等待)/;

export function apply(ctx, config = {}) {
  const log = (msg) => { try { ctx.logger?.('dsh-crossmem-qq')?.info?.(msg); } catch { /* ignore */ } };

  const cfg = {
    qqSessionsPath: String(config.qqSessionsPath || ''),
    ownerPrivate: String(config.ownerPrivate ?? 'private:617171367').split(',').map((x) => x.trim()).filter(Boolean),
    injectCount: Math.max(1, Math.min(20, Number(config.injectCount) || 8)),
    maxInjectChars: Math.max(200, Number(config.maxInjectChars) || 2000),
    statePath: config.statePath || path.join(os.homedir(), '.dsh-crossmem', 'qq-state.json'),
  };

  // ── QQ 会话身份映射（只读桥接的 state/sessions.json，5 秒缓存）───────────────
  const MAP_CANDIDATES = [
    () => cfg.qqSessionsPath,
    () => String(process.env.CROSSMEM_QQ_SESSIONS || ''),
    () => path.join(os.homedir(), '.dsh-crossmem', 'qq-sessions.json'),
    () => path.join('D:', 'deepseek memory', 'state', 'sessions.json'),
  ];
  let mapCache = { at: 0, path: '', stamp: 0, map: new Map(), error: '' };

  function mapFile() {
    for (const pick of MAP_CANDIDATES) {
      let p = '';
      try { p = String(pick() || ''); } catch { p = ''; }
      if (p && fs.existsSync(p)) return p;
    }
    return '';
  }

  function readMap(force = false) {
    const file = mapFile();
    let stamp = 0;
    try { if (file) stamp = fs.statSync(file).mtimeMs; } catch { stamp = 0; }
    // 缓存按「路径 + mtime」判断：桥接重写映射后立刻可见，不用等 5 秒
    if (!force && mapCache.path === file && mapCache.stamp === stamp && Date.now() - mapCache.at < 5000) return mapCache;
    if (!file) {
      mapCache = { at: Date.now(), path: '', stamp: 0, map: new Map(), error: '没找到 QQ 桥的 sessions.json' };
      return mapCache;
    }
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const map = new Map();
      for (const [key, sid] of Object.entries(j?.sessions ?? {})) {
        if (typeof key === 'string' && typeof sid === 'string' && sid) map.set(sid, key);
      }
      mapCache = { at: Date.now(), path: file, stamp, map, error: '' };
    } catch (error) {
      mapCache = { at: Date.now(), path: file, stamp, map: new Map(), error: String(error?.message ?? error) };
    }
    return mapCache;
  }

  const conversationOf = (sessionId) => {
    const id = String(sessionId ?? '');
    if (!id) return '';
    return readMap().map.get(id) ?? '';
  };

  const isOwnerPrivate = (conv) => cfg.ownerPrivate.includes(String(conv ?? ''));

  // ── 状态：qqPool（空 = 全部 QQ 会话共享）──────────────────────────────────
  function readState() {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.statePath, 'utf8').replace(/^\uFEFF/, ''));
      return { qqPool: Array.isArray(j?.qqPool) ? j.qqPool.map(String) : [] };
    } catch { return { qqPool: [] }; }
  }

  function writeState(next) {
    fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true });
    fs.writeFileSync(cfg.statePath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }

  function inPool(conv) {
    const pool = readState().qqPool;
    if (!pool.length) return true;      // 空池 = 全部共享
    return pool.includes(String(conv ?? ''));
  }

  // 首次启动：把旧版 crossmem state.json 里的 qqPool 迁过来（一次性）
  try {
    if (!fs.existsSync(cfg.statePath)) {
      const legacy = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-crossmem', 'state.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(legacy.qqPool) && legacy.qqPool.length) {
        writeState({ qqPool: legacy.qqPool.map(String) });
        log('已从 crossmem state.json 迁移 qqPool：' + legacy.qqPool.length + ' 个');
      }
    }
  } catch { /* 没有旧状态就算了 */ }

  // ── 域对象：crossmem 通过它了解「QQ 是什么」────────────────────────────────
  const domain = {
    id: 'qq',
    domain: 'qq',
    conversationOf,
    isOwnerPrivate,
    viewerOf(sessionId, { sw } = {}) {
      const conv = conversationOf(sessionId);
      if (!conv) return null;
      const owner = isOwnerPrivate(conv);
      const pool = inPool(conv);
      const writeScope = owner ? 'own:' + conv : (pool ? 'qq' : 'own:' + conv);
      return {
        domain: 'qq',
        conv,
        isQq: true,
        // 池外会话既不能写 qq、也不该读 qq（各自隔离）；管理员私信能读全部
        readScopes: (owner || pool) ? ['qq'] : [],
        writeScope,
        label: 'QQ ' + conv + '（跨群/跨天连续）',
        limits: { count: cfg.injectCount, chars: cfg.maxInjectChars },
      };
    },
    /** 老行（scope=shared 但来源是 QQ 会话）归到哪个范围 */
    rowScope(row) {
      const src = String(row?.source ?? '');
      const subj = String(row?.subject ?? '');
      const conv = /^(?:private|group):/.test(src) ? src : (/^(?:private|group):/.test(subj) ? subj : '');
      if (!conv) return '';
      if (isOwnerPrivate(conv)) return 'own:' + conv;
      return 'qq';
    },
    /** 从桥接 prompt 里抽【本次消息快照】+ 口令规则 */
    captureFacts(messages) {
      const out = [];
      const texts = [];
      for (let i = messages.length - 1; i >= 0 && !texts.length; i--) {
        if (String(messages[i]?.role ?? messages[i]?.type ?? '') !== 'user') continue;
        const c = messages[i]?.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ') : '';
        if (!t) continue;
        texts.push(...parseSnapshot(t));
        if (!texts.length && t.includes('【本次消息快照】')) texts.push('');   // 有快照但没人说话
      }
      for (const raw of texts) {
        const text = String(raw ?? '').trim();
        if (!text || PROMPT_FRAGMENT_RE.test(text)) continue;
        const rule = ruleFactOf(text);
        if (rule) out.push({ content: rule, importance: 5, rule: true });
      }
      return out;
    },
  };

  function parseSnapshot(raw) {
    const text = String(raw ?? '');
    const at = text.lastIndexOf('【本次消息快照】');
    if (at < 0) return [];
    const from = text.indexOf('{', at);
    if (from < 0) return [];
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let k = from; k < text.length; k++) {
      const ch = text[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) return [];
    let snap = null;
    try { snap = JSON.parse(text.slice(from, end + 1)); } catch { return []; }
    const out = [];
    for (const m of Array.isArray(snap?.messages) ? snap.messages : []) {
      if (!m || m.isSelf === true) continue;
      const t = String(m.text ?? '').trim();
      if (t) out.push(t);
    }
    return out;
  }

  function ruleFactOf(text) {
    const t = String(text ?? '').trim();
    if (!t || t.length > 60) return '';
    for (const re of RULE_PATTERNS) {
      const m = t.match(re);
      if (m) return m[1].trim() + ' → ' + m[2].trim() + '（原话：' + t + '）';
    }
    return '';
  }

  // 注册到 crossmem（core 每次取最后一个）
  globalThis.__crossmemDomains = Array.isArray(globalThis.__crossmemDomains) ? globalThis.__crossmemDomains : [];
  globalThis.__crossmemDomains.push(domain);
  log('QQ 域已注册（映射 ' + readMap().map.size + ' 个会话）');

  // ── 面板接口（自己的前缀，core 不掺和）────────────────────────────────────
  function listConversations() {
    const map = readMap();
    const pool = readState().qqPool;
    const out = [];
    for (const [sessionId, conv] of map.map.entries()) {
      out.push({
        key: conv,
        sessionId,
        kind: conv.startsWith('group:') ? 'group' : 'private',
        id: conv.split(':')[1] || '',
        inPool: pool.length === 0 ? true : pool.includes(conv),
        isOwner: isOwnerPrivate(conv),
      });
    }
    out.sort((a, b) => (a.kind === b.kind ? String(a.id).localeCompare(String(b.id)) : a.kind === 'group' ? -1 : 1));
    return out;
  }

  function readBody(req, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch (error) { cb(null, error); } });
  }

  function handleApi(req, res, url) {
    const send = (code, obj) => {
      try {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(obj));
      } catch { /* 连接已断 */ }
    };
    const p = url.pathname.replace(/^\/api\/crossmem-qq/, '') || '/';
    try {
      if (req.method === 'GET' && p === '/state') {
        const map = readMap();
        return send(200, {
          ok: true,
          qqPool: readState().qqPool,
          conversations: listConversations(),
          ownerPrivate: cfg.ownerPrivate,
          mapPath: map.path,
          mapError: map.error,
        });
      }
      if (req.method === 'POST' && p === '/pool') {
        return readBody(req, (j, err) => {
          if (err) return send(400, { ok: false, error: err.message });
          const cur = readState().qqPool;
          let next = cur;
          if (j && j.all === true) {
            next = j.inPool !== false ? listConversations().filter((x) => !x.isOwner).map((x) => x.key) : [];
          } else {
            const key = String(j?.conversation ?? '').trim();
            if (!key) return send(400, { ok: false, error: '缺 conversation' });
            if (!/^(group|private):\d+$/.test(key)) return send(400, { ok: false, error: 'conversation 格式不对' });
            if (isOwnerPrivate(key)) return send(400, { ok: false, error: '管理员私信是单向汇，不能加入公共库' });
            const want = j.inPool !== false;
            next = want ? [...new Set([...cur, key])] : cur.filter((x) => x !== key);
          }
          writeState({ qqPool: next });
          return send(200, { ok: true, qqPool: next, conversations: listConversations() });
        });
      }
      return send(404, { ok: false, error: 'unknown ' + req.method + ' ' + p });
    } catch (error) {
      return send(500, { ok: false, error: error?.message ?? String(error) });
    }
  }

  let mounted = false;
  const mount = (ws) => {
    if (mounted || !ws || typeof ws.register !== 'function') return mounted;
    try {
      ctx.effect(() => ws.register({
        kind: 'prefix',
        path: '/api/crossmem-qq',
        handler: async (req, res) => handleApi(req, res, new URL(req.url, 'http://127.0.0.1')),
      }), 'crossmem-qq: /api/crossmem-qq 路由');
      mounted = true;
      log('面板路由已挂载：/api/crossmem-qq');
    } catch (error) {
      log('面板路由没挂上：' + (error?.message ?? error));
    }
    return mounted;
  };
  const wsNow = (() => { try { return ctx.get('webServer'); } catch { return null; } })();
  if (!mount(wsNow)) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const ws = (() => { try { return ctx.get('webServer'); } catch { return null; } })();
      if (mount(ws)) { clearInterval(timer); return; }
      if (tries >= 20) { clearInterval(timer); log('20 秒内没等到 webServer：面板不可用'); }
    }, 1000);
    timer?.unref?.();
  }
}
