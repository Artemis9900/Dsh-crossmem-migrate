// dsh-crossmem —— 跨会话记忆打通（DeepSeek Harness 插件）
//
// 解决什么问题
//   dsh 每个会话是独立上下文：你在 A 会话里定下的规矩，B 会话完全不知道。
//   这个插件让所有会话共用一份记忆库，并且**自动**把该记的记下来、该提醒的塞回去。
//
// 三个能力
//   1) 注入：挂 system-prompt/assemble，每个会话组装提示词时追加一段「跨会话记忆」。
//   2) 记录：挂 agent/pre-step，从用户消息里按启发式抓明确陈述的事实（零成本）。
//   3) 隔离：记忆带 origin（dsd=本机会话 / qq=QQ 群聊）。默认**不把 QQ 群里学到的
//      东西注入本机会话**（config.includeQq=false），这是操作者明确要求的隐私边界。
//   4) QQ 内部打通：QQ 的会话身份是 group:<群号> / private:<QQ号>（QQ 桥维护在
//      state/sessions.json），而不是随时会被重建的 DSH session id。所以 QQ 里学到的
//      东西写进 scope=qq：所有 QQ 会话都能看到，本机会话看不到（除非 includeQq）。
//      显式打通组仍然优先——把 QQ 会话和一个本机会话放进同一组，那条路照常通。
//
// 设计取舍
//   · 零 token：不调用任何模型，纯本地 SQLite + 正则。摘要在需要时手动调工具。
//   · 失败必须静默：注入/记录一旦抛错，只记日志，绝不连累会话创建。
//   · 不碰别人的表：自建 memories_fts_crossmem，且写入用独立 source 前缀，方便一键清理。
//   · 默认**不启用自动记录**的激进策略：只记「我叫/记住/以后都用/喜欢/讨厌」这类明确句，
//     宁可少记，也不要往库里灌废话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

// -- boot beacon (diagnostics only) --
function crossmemBeacon(stage, extra = '') {
  try {
    const dir = path.join(os.homedir(), '.dsh-crossmem');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'boot.log'),
      new Date().toISOString() + ' pid=' + process.pid + ' ' + stage + (extra ? ' ' + String(extra).slice(0, 600) : '') + '\n');
  } catch { /* beacon must never break the plugin */ }
}
crossmemBeacon('module-imported', 'dsh-crossmem');

export const name = 'dsh-crossmem';
export const inject = ['tools'];

export const Config = Schema.object({
  dbPath: Schema.string().description('SQLite 路径。默认 ~/.dsh-ebbinghaus/memory-shared.db（与记忆插件、QQ 机器人共用）'),
  injectCount: Schema.number().default(5).description('每次注入几条记忆（1-10）'),
  maxInjectChars: Schema.number().default(800).description('注入块的最大字符数，超出就截断'),
  includeQq: Schema.boolean().default(false).description('是否把 QQ 群里学到的记忆也注入本机会话（默认否，隐私隔离）'),
  autoCapture: Schema.boolean().default(true).description('是否从用户消息里自动抓记忆（启发式，零成本）'),
  captureMinLen: Schema.number().default(6).description('自动抓取时正文最短字符数'),
  captureLocal: Schema.boolean().default(true).description('会话结束时用本地 Ollama 模型再抽一遍（零 API 费用，占显存）'),
  ollamaUrl: Schema.string().default('http://127.0.0.1:11434').description('本地 Ollama 地址'),
  ollamaModel: Schema.string().default('modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M').description('抽取用的本地模型名'),
  curve: Schema.string().default('power').description('排序用的遗忘曲线：exponential / power / hyperbolic / logarithmic / gaussian'),
  curveK: Schema.number().default(1.5).description('曲线形状参数'),
  statePath: Schema.string().description('软开关文件。默认 ~/.dsh-crossmem/state.json（rollback.ps1 会写它）'),
});

const DAY = 86400000;

const TEXT_OUT = {
  schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
  render: (_args, v) => [{ type: 'text', text: String(v?.text ?? '') }],
};

/** 遗忘曲线族（与 dsh-ebbinghaus 同源）。x = 闲置天数 / 强度。 */
function curveValue(x, curve, k) {
  const t = Math.max(0, Number(x) || 0);
  const kk = Math.max(0.1, Number(k) || 1.5);
  switch (String(curve || 'power').toLowerCase()) {
    case 'exponential': return Math.exp(-t);
    case 'hyperbolic': return 1 / (1 + t);
    case 'logarithmic': return 1 / (1 + kk * Math.log(1 + t));
    case 'gaussian': return Math.exp(-(t * t) / (2 * kk));
    case 'power':
    default: return Math.pow(1 + t, -kk);
  }
}

function retrievability(row, now, curve, curveK) {
  const s = Math.max(0.2, Number(row.strength) || (1 + (Number(row.importance) || 3)));
  const last = Math.max(Number(row.last_review_at) || 0, Number(row.last_used_at) || 0, Number(row.created_at) || 0) || now;
  return curveValue(Math.max(0, (now - last) / DAY) / s, curve, curveK);
}

/** 记忆来源 → 大类。用于隐私隔离（qq 的不注入本机会话）。 */
function originOf(row) {
  const src = String(row?.source ?? '');
  return isQqSource(src) ? 'qq' : 'dsd';
}

/**
 * 什么算"QQ 那边来的"。名单要跟着 QQ 桥的实际写法走：
 *   · qq-bridge / crossmem:qq  —— 桥和本插件自己写的
 *   · digest:*                 —— 桥每天的群聊摘要
 *   · group:<群号> / private:<QQ号> —— 桥按会话写进同一张表（以前被漏判成 dsd，
 *     结果 QQ 的东西反而漏进本机会话；这里必须收进来）
 *   · slang*                   —— 群里学来的黑话
 */
function isQqSource(src) {
  const s = String(src ?? '');
  return s.startsWith('crossmem:qq')
    || s.startsWith('qq-bridge')
    || s.startsWith('digest')
    || s.startsWith('qq')
    || s.startsWith('group:')
    || s.startsWith('private:')
    || s.startsWith('slang');
}

export function apply(ctx, config = {}) {
  crossmemBeacon('apply-enter', JSON.stringify(Object.keys(config || {})));
  const cfg = {
    dbPath: config.dbPath || path.join(os.homedir(), '.dsh-ebbinghaus', 'memory-shared.db'),
    injectCount: Math.max(1, Math.min(10, Number(config.injectCount) || 5)),
    maxInjectChars: Math.max(120, Number(config.maxInjectChars) || 800),
    includeQq: config.includeQq === true,
    autoCapture: config.autoCapture !== false,
    captureMinLen: Math.max(4, Number(config.captureMinLen) || 6),
    captureLocal: config.captureLocal !== false,
    ollamaUrl: String(config.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    ollamaModel: String(config.ollamaModel || 'modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M'),
    curve: String(config.curve || 'power'),
    curveK: Number(config.curveK ?? 1.5),
    statePath: config.statePath || path.join(os.homedir(), '.dsh-crossmem', 'state.json'),
  };
  crossmemBeacon('config-ok', 'inject=' + cfg.injectCount + ' db=' + cfg.dbPath);

  const log = (msg) => {
    try { ctx.logger?.('dsh-crossmem')?.info?.(msg); } catch { /* 日志失败不影响功能 */ }
  };

  // ── 外部会话域（可选插件）───────────────────────────────────────────────────
  // QQ 那套（群/私聊身份、公共记忆库、管理员单向可见）不再写死在这里：
  // 谁装了 dsh-crossmem-qq，谁就通过 globalThis.__crossmemDomains 注册一个域。
  // 没装 = 只有「本机会话 + 打通组」，其它一切照常工作（也不会去读 QQ 桥的文件）。
  function domainProviders() {
    return Array.isArray(globalThis.__crossmemDomains) ? globalThis.__crossmemDomains : [];
  }
  function activeDomain() {
    const list = domainProviders();
    return list.length ? list[list.length - 1] : null;
  }
  /** 这条 DSH 会话属于哪个外部会话（如 QQ 的 group:123）；没有域插件就是 ''。 */
  function conversationOf(sessionId) {
    const p = activeDomain();
    if (!p || typeof p.conversationOf !== 'function') return '';
    try { return String(p.conversationOf(sessionId) || ''); } catch { return ''; }
  }

  let db = null;
  let dbError = null;
  try {
    fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
    db = new DatabaseSync(cfg.dbPath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 4000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL DEFAULT 'fact',
        subject TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 3,
        source TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        strength REAL NOT NULL DEFAULT 1,
        last_review_at INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_crossmem_archived ON memories(archived);
      CREATE INDEX IF NOT EXISTS idx_crossmem_created ON memories(created_at DESC);
    `);
    // 分组：不属于任何组的会话写 'shared'，组内会话写组 id
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name));
      if (!cols.has('scope')) db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'");
    } catch { /* 加不上就退化为所有记忆共享 */ }
  } catch (error) {
    dbError = error?.message ?? String(error);
    log('打开库失败：' + dbError);
  }
  crossmemBeacon('db', dbError ? ('error:' + dbError) : 'ok');

  // ── 软开关（回退 = 只停注入/抓取，插件还在）────────────────────────────────
  // rollback.ps1 会往 statePath 写 {"inject":false,"capture":false}。
  // 每次都用都读一遍磁盘 —— 于是"回退"是**立即生效**的，不需要卸载、不需要重启。
  function readSwitch() {
    const def = { inject: true, capture: true, groups: [], reason: '', at: 0 };
    try {
      const raw = fs.readFileSync(cfg.statePath, 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      let groups = Array.isArray(j.groups) ? j.groups.map((g, i) => ({
        id: String(g?.id ?? 'g' + (i + 1)),
        name: String(g?.name ?? '组 ' + (i + 1)),
        sessions: Array.isArray(g?.sessions) ? g.sessions.map(String) : [],
      })) : [];
      // 兼容 v0.1 的 linkedSessions：有它没 groups 就折成一个默认组
      if (!groups.length && Array.isArray(j.linkedSessions) && j.linkedSessions.length) {
        groups = [{ id: 'legacy', name: '默认组', sessions: j.linkedSessions.map(String) }];
      }
      return {
        inject: j.inject !== false,
        capture: j.capture !== false,
        groups,
        reason: String(j.reason ?? ''),
        at: Number(j.at) || 0,
      };
    } catch {
      return def;
    }
  }

  /** 会话属于哪个组（不在任何组里 → 'shared'）。 */
  function scopeOf(sessionId, groups) {
    const id = String(sessionId ?? '');
    if (!id) return 'shared';
    for (const g of groups) if (g.sessions.includes(id)) return g.id;
    return 'shared';
  }

  /**
   * 一行记忆的"有效范围"。
   * 老数据（QQ 桥写的 source=private:/group:，scope 还是 shared）交给「域插件」判定；
   * 没装域插件就一律 shared —— 核心不认识 QQ。
   */
  function effectiveScope(row) {
    const rs = String(row?.scope || 'shared');
    if (rs !== 'shared') return rs;
    const p = activeDomain();
    if (!p || typeof p.rowScope !== 'function') {
      // 域插件没装：外部来源的行按「外部范围」处理（不可见），避免 QQ/其它端的
      // scope=shared 老数据漏进本机会话。装了域插件则由它给出精确映射。
      return originOf(row) === 'qq' ? 'qq' : 'shared';
    }
    try {
      const scope = p.rowScope(row);
      return scope ? String(scope) : 'shared';
    } catch { return 'shared'; }
  }

  /** 会话视角：本机身份 + 打通组；域插件可追加只读范围、写入范围、注入额度。 */
  function viewerOf(sessionId, groups, sw) {
    const id = String(sessionId ?? '');
    const inGroups = (Array.isArray(groups) ? groups : [])
      .filter((g) => Array.isArray(g?.sessions) && g.sessions.includes(id))
      .map((g) => String(g.id));
    const viewer = {
      id,
      conv: '',
      domain: '',
      isQq: false,
      groups: inGroups,
      scope: inGroups[0] ?? 'shared',
      readScopes: ['shared', ...inGroups],
      writeScope: inGroups[0] ?? 'shared',
      limits: null,
      label: '',
    };
    const p = activeDomain();
    if (p && typeof p.viewerOf === 'function') {
      try {
        const extra = p.viewerOf(id, { groups: inGroups, sw }) || {};
        if (extra.conv) viewer.conv = String(extra.conv);
        if (extra.domain) viewer.domain = String(extra.domain);
        if (extra.isQq) viewer.isQq = true;
        if (extra.label) viewer.label = String(extra.label);
        if (Array.isArray(extra.readScopes)) {
          viewer.readScopes = [...new Set([...viewer.readScopes, ...extra.readScopes.map(String)])];
        }
        if (extra.writeScope) viewer.writeScope = String(extra.writeScope);
        if (extra.limits && typeof extra.limits === 'object') viewer.limits = extra.limits;
      } catch { /* 域插件出错就当没有，绝不连累注入 */ }
    }
    return viewer;
  }

  /** 组标记：让组里的成员会话也能看到（组 = 可见性叠加）。 */
  function groupMarkers(viewer) {
    return (viewer?.groups ?? []).map((g) => '组:' + g);
  }

  /**
   * 可见性（通用规则；域插件的范围用 readScopes 表达）：
   *   shared      → 所有会话
   *   own:<conv>  → 只有那个会话自己
   *   其它        → 在这个会话的 readScopes 里才可见（打通组 id、域插件的 'qq' 等）
   */
  function visibleTo(viewer, row) {
    const rs = effectiveScope(row);
    if (rs === 'shared') return true;
    if (rs.startsWith('own:')) return Boolean(viewer.conv) && rs === 'own:' + viewer.conv;
    if (Array.isArray(viewer.readScopes) && viewer.readScopes.includes(rs)) return true;
    if (cfg.includeQq) return true;   // 老开关：把别的域的记忆也注入本机会话
    return false;
  }

  /** 写一条记忆该归到哪个 scope：域插件说了算，否则按打通组。 */
  function writeScopeOf(sessionId, viewer, groups) {
    if (viewer && viewer.writeScope) return viewer.writeScope;
    return scopeOf(sessionId, groups);
  }

  /** 这条记忆是不是就在这个会话里学到的（同会话优先）。 */
  function sameConversation(row, conv) {
    if (!conv) return false;
    return String(row?.source ?? '') === conv
      || String(row?.subject ?? '') === conv
      || String(row?.tags ?? '').split(',').includes(conv);
  }

  // ── 会话列表（控制菜单用）──────────────────────────────────────────────────
  // 扫 ~/.dsh/sessions/<工作目录>/session-<id>/session.v4.jsonl.zstd，
  // 取 cwd、标题、最后活动时间。带 30 秒缓存 —— 48 个会话全解压要 1-2 秒，面板不该每次等。
  const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
  const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let sessionCache = { at: 0, list: [] };

  function readSessionFrames(file) {
    const buf = fs.readFileSync(file);
    const starts = [];
    let i = buf.indexOf(ZSTD_MAGIC, 0);
    while (i >= 0) { starts.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 4); }
    const parts = [];
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k];
      const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')); } catch { /* 坏帧跳过 */ }
    }
    return parts.join('');
  }

  // DSH 把「归档的会话」记在 workspace.json 的 global.archivedSessionIds。
  // 面板默认不显示它们，点「显示归档」才展开 —— 归档的多半是早就结束的会话，
  // 混在一起会把真正要打通的会话淹掉。
  const WORKSPACE_STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
  let archivedCache = { at: 0, ids: new Set() };

  function readArchivedSessionIds(force = false) {
    if (!force && Date.now() - archivedCache.at < 30000) return archivedCache.ids;
    let ids = new Set();
    try {
      const j = JSON.parse(fs.readFileSync(WORKSPACE_STORE, 'utf8').replace(/^\uFEFF/, ''));
      const list = j?.global?.archivedSessionIds ?? j?.archivedSessionIds ?? [];
      if (Array.isArray(list)) ids = new Set(list.map(String));
    } catch { /* 没有这个文件就当作没有归档 */ }
    archivedCache = { at: Date.now(), ids };
    return ids;
  }

  function listSessions(force = false) {
    if (!force && Date.now() - sessionCache.at < 30000) return sessionCache.list;
    const archivedIds = readArchivedSessionIds(force);
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (e.name !== 'session.v4.jsonl.zstd') continue;
        try {
          const txt = readSessionFrames(full);
          const lines = txt.split('\n').filter(Boolean);
          let meta = null;
          let title = '';
          let lastAt = 0;
          for (const line of lines) {
            let j = null;
            try { j = JSON.parse(line); } catch { continue; }
            if (j.type === 'session' && !meta) meta = j;
            if (j.type === 'session/title' && j.data?.title) title = String(j.data.title);
            if (typeof j.time === 'number' && j.time > lastAt) lastAt = j.time;
          }
          const sid = String(meta?.id || path.basename(path.dirname(full)));
          out.push({
            id: sid,
            archived: archivedIds.has(sid),
            cwd: String(meta?.cwd || ''),
            title,
            createdAt: Number(meta?.createdAt) || 0,
            lastAt,
            bytes: fs.statSync(full).size,
          });
        } catch { /* 读不了就跳过 */ }
      }
    };
    walk(SESSIONS_ROOT, 0);
    out.sort((a, b) => (b.lastAt || b.createdAt) - (a.lastAt || a.createdAt));
    sessionCache = { at: Date.now(), list: out };
    return out;
  }

  function writeSwitch(next) {
    fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true });
    fs.writeFileSync(cfg.statePath, JSON.stringify(next, null, 2), 'utf8');
  }

  // ── 记忆读 ────────────────────────────────────────────────────────────────
  function candidates(limit, viewer) {
    if (!db) return [];
    const now = Date.now();
    const rows = db.prepare('SELECT * FROM memories WHERE archived = 0 ORDER BY created_at DESC LIMIT 400').all();
    const conv = viewer?.conv ?? '';
    const visible = rows
      // 黑话（kind=slang）有 qq_slang_query 专门查，进注入块只会挤掉真正的记忆
      .filter((r) => String(r.kind || '') !== 'slang')
      .filter((r) => visibleTo(viewer, r))
      .map((r) => ({ ...r, R: retrievability(r, now, cfg.curve, cfg.curveK) }))
      // 同一个 QQ 会话里学到的先上：跨群共享但不淹没"这个群自己的事"
      .map((r) => ({ ...r, score: (r.R * (Number(r.importance) || 3)) * (sameConversation(r, conv) ? 1.6 : 1) }))
      .sort((a, b) => b.score - a.score);

    if (!viewer?.isQq) return visible.slice(0, limit);

    // QQ 侧：光按 R×重要度排会出事 —— 一条刚学到的口令会输给几个月前的重要度 5 老记忆，
    // 永远挤不进这 8 条，用户看到的就是「换个群就不记得了」。
    // 所以一半名额按时间发（只认 24h 内新写的），另一半再按分数补。
    const freshSlots = Math.max(1, Math.ceil(limit / 2));
    const picked = [];
    const seen = new Set();
    // visible 是按分数排的，新写的不一定在前面 —— 必须另排一遍按时间取，
    // 否则第一条就是最老的高分记忆，「>24h 就停」会立刻生效（踩过这个坑）。
    const byRecency = [...visible].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    for (const r of byRecency) {
      if (picked.length >= freshSlots) break;
      if (now - Number(r.created_at || 0) > 24 * 60 * 60 * 1000) break;   // 只认 24h 内新写的
      picked.push(r);
      seen.add(r.id);
    }
    for (const r of visible) {
      if (picked.length >= limit) break;
      if (seen.has(r.id)) continue;
      picked.push(r);
      seen.add(r.id);
    }
    return picked;
  }

  function search(query, limit = 8) {
    if (!db) return [];
    const q = String(query ?? '').trim();
    const now = Date.now();
    if (!q) {
      // 显式检索不过滤可见性（工具是"查库"，不是"注入"）：按重要度+新鲜度给最近的
      const rows0 = db.prepare('SELECT * FROM memories WHERE archived = 0 ORDER BY importance DESC, created_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(50, limit)));
      return rows0.map((r) => ({ ...r, R: retrievability(r, now, cfg.curve, cfg.curveK) }));
    }
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const rows = db.prepare('SELECT * FROM memories WHERE archived = 0 AND (content LIKE ? OR tags LIKE ? OR subject LIKE ?) ORDER BY importance DESC, created_at DESC LIMIT ?')
      .all(like, like, like, Math.max(1, Math.min(50, limit)));
    // 命中即续命（弱复习：只刷 last_used_at / use_count，不改强度）
    const bump = db.prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
    for (const r of rows) { try { bump.run(now, r.id); } catch { /* 只读场景下失败无所谓 */ } }
    return rows.map((r) => ({ ...r, R: retrievability(r, now, cfg.curve, cfg.curveK) }));
  }

  function save({ content, importance = 3, tags = '', kind = 'fact', subject = '', source, scope = 'shared' }) {
    if (!db) throw new Error('记忆库不可用：' + (dbError || '未初始化'));
    const text = String(content ?? '').trim();
    if (!text) throw new Error('内容是空的');
    const imp = Math.max(1, Math.min(5, Number(importance) || 3));
    const now = Date.now();
    // 去重：同一条内容不重复写（避免每次 pre-step 都灌一遍）
    const dup = db.prepare('SELECT id FROM memories WHERE content = ? LIMIT 1').get(text);
    if (dup) return { id: Number(dup.id), duplicated: true };
    const info = db.prepare(`INSERT INTO memories (kind, subject, content, tags, importance, source, created_at, updated_at, last_used_at, strength, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(kind || 'fact'), String(subject ?? ''), text, String(tags ?? ''), imp, String(source || 'crossmem:dsd'), now, now, now, 1 + imp, String(scope || 'shared'));
    return { id: Number(info.lastInsertRowid), duplicated: false };
  }

  // ── 能力 1：自动注入 ─────────────────────────────────────────────────────
  function buildInjection(context) {
    if (!db) return '';
    const sw = readSwitch();
    if (!sw.inject) return '';   // 回退模式：不注入，但插件仍在、工具仍可用
    // 打通列表非空时，只对列表里的会话注入（"把这几条会话打通"）。
    // 列表为空 = 不限制（所有会话共享）。
    const sidForLink = String(context?.agent?.session?.id ?? context?.agent?.id ?? '');
    const viewer = viewerOf(sidForLink, sw.groups, sw);
    const limit = Number(viewer.limits?.count) > 0 ? Number(viewer.limits.count) : cfg.injectCount;
    const items = candidates(limit, viewer);
    if (!items.length) return '';
    const sessionId = sidForLink;
    const cwd = String(context?.agent?.session?.header?.cwd ?? '');
    const lines = items.map((r) => {
      const kind = String(r.kind || 'fact');
      const tag = r.tags ? `（${String(r.tags).split(',').slice(0, 2).join('/')}）` : '';
      return `· [${kind}] ${String(r.content).replace(/\s+/g, ' ').slice(0, 120)}${tag}`;
    });
    const head = `【跨会话记忆 · 最近 ${items.length} 条】`;
    const where = viewer.label
      ? viewer.label
      : (viewer.scope === 'shared' ? '本机各会话共享库' : '本机·组 ' + viewer.scope);
    const sidShort = sessionId ? sessionId.replace(/^session-/, '').slice(0, 8) : '未知';
    const tail = `（来源：${where}；当前会话 ${sidShort}${cwd ? ' @ ' + path.basename(cwd) : ''}。` +
      `要细查用 crossmem_search，要补记用 crossmem_save。）`;
    let text = head + '\n' + lines.join('\n') + '\n' + tail;
    const cap = Number(viewer.limits?.chars) > 0 ? Number(viewer.limits.chars) : cfg.maxInjectChars;
    if (text.length > cap) text = text.slice(0, cap - 20) + '\n…（已截断）';
    return text;
  }

  try {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const out = await next();
      try {
        const block = buildInjection(context);
        if (!block) return out;
        const contexts = Array.isArray(out?.contexts) ? [...out.contexts] : [];
        // 用独立 name，避免和 DSH 自带上下文撞名
        contexts.push({ name: 'crossmem', text: block, order: 900 });
        return { ...out, contexts };
      } catch (error) {
        log('注入失败：' + (error?.message ?? error));
        return out;
      }
    }, { prepend: true });
  } catch (error) {
    log('挂 system-prompt/assemble 失败：' + (error?.message ?? error));
  }

  // ── 能力 2：自动抓取（启发式，零成本）─────────────────────────────────────
  // 只抓「明确陈述」的句子。宁可漏，不要脏。
  const PATTERNS = [
    /(?:记住|记一下|别忘了)[：:，,\s]*(.{4,80})/,
    /我(?:叫|的名字是|是)\s*([^\s，。,.!！?？]{1,20})/,
    /(?:以后|以后都|之后都)(?:用|按|叫我|要)(.{2,40})/,
    /我(?:喜欢|讨厌|不喜欢|爱吃|不太喜欢)(.{2,40})/,
    /(?:不要|别再|禁止)(.{2,40})/,
    /我的(?:生日|电脑|显卡|手机|地址|邮箱)(?:是)?(.{2,40})/,
    /(?:这个项目|这个仓库|这里)(?:用|是)(.{2,40})/,
  ];

  const recentHashes = new Set();

  /**
   * 抓取前先给「用户消息」剥壳。
   * QQ 那边喂进来的 message 里可能夹着整段 prompt / XML（曾经写出过
   * `你</message>`、`笨笨</message>` 这种垃圾行），所以：
   * 截断在结束标签处、去掉尖括号块和代码块、压掉多余空白。
   */
  function cleanUserText(raw) {
    let t = String(raw ?? '');
    const cut = t.search(/<\/message>|<\/toolcall>|<\/result>/i);
    if (cut >= 0) t = t.slice(0, cut);
    t = t.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>\n]{1,200}>/g, ' ');
    return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }


  // 桥接 prompt 里的字段名／固定说法：命中的句子是提示词碎片，不是人说的话。
  const PROMPT_FRAGMENT_RE = /(?:群名片|at\/引用段|ownerLabel|isOwner|messageId|readThroughSeq|【会话令牌】|【权限】|【你的身份】|本机路径|系统提示原文|沉睡前强制等待)/;

  function captureFromMessages(agent, messages, step) {
    if (!cfg.autoCapture || !db) return;
    const sw = readSwitch();
    if (!sw.capture) return;   // 回退模式：不自动记
    if (!Array.isArray(messages) || messages.length === 0) return;
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '');
    const cwd = String(agent?.session?.header?.cwd ?? '');
    const viewer = viewerOf(sessionId, sw.groups, sw);

    const messageText = (m) => (typeof m?.content === 'string' ? m.content
      : Array.isArray(m?.content) ? m.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ') : '');

    // 候选事实：域插件能给就直接用（QQ 那套的"消息快照 + 口令规则"在 addon 里）；
    // 否则走本机的启发式：剥壳后的用户消息 + PATTERNS。
    const domain = activeDomain();
    const preExtracted = [];
    if (viewer.domain && domain && typeof domain.captureFacts === 'function') {
      try { preExtracted.push(...(domain.captureFacts(messages) || [])); } catch { /* 域插件出错就走通用路径 */ }
    }

    const sources = [];
    if (!preExtracted.length) {
      for (let i = messages.length - 1; i >= 0 && sources.length < 2; i--) {
        if (String(messages[i]?.role ?? messages[i]?.type ?? '') !== 'user') continue;
        const t = messageText(messages[i]);
        if (t && t.length <= 2000) sources.push(t);
      }
    }

    const candidates = [];
    for (const item of preExtracted) {
      const content = String(item?.content ?? '').trim();
      if (!content) continue;
      candidates.push({ content, importance: Math.max(1, Math.min(5, Number(item?.importance) || 3)), rule: item?.rule === true });
    }
    for (const raw of sources) {
      const text = cleanUserText(raw);
      if (!text) continue;
      for (const re of PATTERNS) {
        const m = text.match(re);
        if (!m) continue;
        const fact = String(m[1] ?? '').trim().replace(/\s+/g, ' ');
        if (fact.length >= cfg.captureMinLen) candidates.push({ content: fact, importance: 3, rule: false });
      }
    }

    for (const c of candidates) {
      if (c.content.length < cfg.captureMinLen) continue;
      if (PROMPT_FRAGMENT_RE.test(c.content)) continue;   // 提示词碎片，不是人说的
      const hash = crypto.createHash('sha1').update(c.content).digest('hex').slice(0, 16);
      if (recentHashes.has(hash)) continue;
      recentHashes.add(hash);
      if (recentHashes.size > 500) recentHashes.clear();
      try {
        save({
          content: c.content,
          importance: c.importance,
          tags: [
            '跨会话',
            c.rule ? '口令' : '',
            viewer.isQq ? viewer.conv : (cwd ? path.basename(cwd) : '会话'),
            ...groupMarkers(viewer),
          ].filter(Boolean).join(','),
          kind: 'fact',
          subject: viewer.isQq ? viewer.conv : (sessionId ? sessionId.slice(0, 12) : ''),
          source: viewer.isQq ? 'crossmem:qq' : 'crossmem:dsd',
          scope: writeScopeOf(sessionId, viewer, sw.groups),
        });
        log('自动记下（step ' + (step ?? '?') + '）：' + c.content.slice(0, 40));
      } catch (error) {
        log('自动记录失败：' + (error?.message ?? error));
      }
    }
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        const sid = payload?.agent?.session?.id ?? payload?.agent?.id;
        const cwd0 = payload?.agent?.session?.header?.cwd;
        for (const m of (Array.isArray(payload?.messages) ? payload.messages.slice(-2) : [])) {
          if (String(m?.role ?? '') !== 'user') continue;
          const t = typeof m?.content === 'string' ? m.content : '';
          if (t) bufferMessage(sid, t);
        }
        payload.__crossmemCwd = cwd0;
        captureFromMessages(payload?.agent, payload?.messages, payload?.step);
      } catch (error) {
        log('pre-step 抓取失败：' + (error?.message ?? error));
      }
      return decision;
    }, { prepend: true });
  } catch (error) {
    log('挂 agent/pre-step 失败：' + (error?.message ?? error));
  }


  // ── 能力 2b：本地模型抽取（B 方案）────────────────────────────────────────
  // 启发式只能抓「记住：…」这种明确句式；日常陈述（"我用的是 RTX 4050，跑 8B 有点吃力"）
  // 抓不到。这部分交给本地 Qwen：会话收尾时把缓存的消息交进去，抽 1-3 条。
  // ── 本地模型可用性探测 ────────────────────────────────────────────────────
  // 装的时候已经提示过一次；运行时要再兜一层：模型被删了 / Ollama 没起，就自动降级，
  // 而不是每次会话收尾都白等 60 秒超时。
  const localStatus = { checked: false, ok: false, reason: '' };

  async function probeLocalModel(force = false) {
    if (localStatus.checked && !force) return localStatus.ok;
    if (force) { localStatus.checked = false; localStatus.reason = ''; }
    localStatus.checked = true;
    if (!cfg.captureLocal) { localStatus.reason = '配置里关掉了 captureLocal'; return false; }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(cfg.ollamaUrl + '/api/tags', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) { localStatus.reason = 'Ollama 没响应（HTTP ' + res.status + '）'; return false; }
      const tags = await res.json();
      const names = (tags?.models ?? []).map((m) => String(m.name ?? m.model ?? ''));
      if (!names.includes(cfg.ollamaModel)) {
        localStatus.reason = '模型没装：' + cfg.ollamaModel;
        return false;
      }
      localStatus.ok = true;
      return true;
    } catch (error) {
      localStatus.reason = '连不上 ' + cfg.ollamaUrl;
      return false;
    }
  }

  const sessionBuffers = new Map();   // sessionId -> [userText]
  const BUFFER_MAX = 24;

  function bufferMessage(sessionId, text) {
    if (!sessionId || !text) return;
    const key = String(sessionId);
    const buf = sessionBuffers.get(key) ?? [];
    buf.push(String(text).slice(0, 800));
    while (buf.length > BUFFER_MAX) buf.shift();
    sessionBuffers.set(key, buf);
  }

  /** 调本地 Ollama 抽事实，返回字符串数组。失败返回 []，绝不上抛。 */
  async function extractWithLocalModel(texts) {
    if (!cfg.captureLocal || !Array.isArray(texts) || texts.length === 0) return [];
    const joined = texts.join('\n').slice(0, 4000);
    const prompt = [
      '从下面的对话片段里，抽取**值得长期记住**的关于使用者的事实或偏好（不要记临时话题、不要记助手的回答）。',
      '要求：每条一句话，最多 3 条；没有值得记的就输出「无」。',
      '只输出条目，每行一条，不要编号，不要解释。',
      '',
      '对话片段：',
      joined,
    ].join('\n');
    const body = JSON.stringify({
      model: cfg.ollamaModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: false,
      options: { num_predict: 220, temperature: 0.2 },
    });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(cfg.ollamaUrl + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { log('本地抽取 HTTP ' + res.status); return []; }
      const data = await res.json();
      const content = String(data?.message?.content ?? data?.message?.thinking ?? '').trim();
      return parseFacts(content);
    } catch (error) {
      log('本地抽取失败：' + (error?.message ?? error));
      return [];
    }
  }

  /** 把模型输出切成干净的条目（去掉编号、空行、"无"）。 */
  function parseFacts(raw) {
    return String(raw ?? '')
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, '').trim())
      .filter((line) => line && line !== '无' && line.length >= 4 && !/^(对话|片段|事实|结果)[:：]/.test(line))
      .slice(0, 3);
  }

  async function flushSession(sessionId, cwd) {
    const key = String(sessionId ?? '');
    const buf = sessionBuffers.get(key);
    if (!buf || buf.length === 0) return;
    sessionBuffers.delete(key);
    if (!cfg.captureLocal) return;
    if (!readSwitch().capture) return;   // 回退模式：不跑本地模型
    if (!(await probeLocalModel())) {
      log('跳过本地抽取：' + (localStatus.reason || '模型不可用'));
      return;
    }
    const facts = await extractWithLocalModel(buf);
    const sw = readSwitch();
    const viewer = viewerOf(key, sw.groups, sw);
    for (const fact of facts) {
      try {
        save({
          content: fact,
          importance: 3,
          tags: [
            '跨会话',
            '本地抽取',
            viewer.isQq ? viewer.conv : (cwd ? path.basename(cwd) : ''),
            ...groupMarkers(viewer),
          ].filter(Boolean).join(','),
          kind: 'fact',
          subject: viewer.isQq ? viewer.conv : key.slice(0, 12),
          source: viewer.isQq ? 'crossmem:qq' : 'crossmem:dsd',
          scope: writeScopeOf(key, viewer, sw.groups),
        });
        log('本地抽取记下：' + fact.slice(0, 40));
      } catch (error) {
        log('本地抽取写库失败：' + (error?.message ?? error));
      }
    }
  }


  // 会话收尾：跑本地抽取。事件载荷差异大，所以这里做三重兜底：
  // 优先用载荷里的 session id；拿不到就 flush 掉所有缓存（宁可多抽，不要漏抽）。
  const flushAny = async (payload) => {
    try {
      const sid = payload?.agent?.session?.id ?? payload?.agent?.id ?? payload?.sessionId;
      const cwd = payload?.agent?.session?.header?.cwd ?? payload?.cwd ?? '';
      if (sid && sessionBuffers.has(String(sid))) {
        await flushSession(sid, cwd);
        return;
      }
      for (const key of [...sessionBuffers.keys()]) {
        await flushSession(key, cwd);
      }
    } catch (error) {
      log('会话收尾抽取失败：' + (error?.message ?? error));
    }
  };
  // 注意：session/flush 和 agent/disposed 是**普通事件**，DSH 不传 next。
  // 写成 async (payload, next) => { await next(); } 会在每次会话/agent 结束时
  // 抛 "next is not a function"（只有 system-prompt/assemble、agent/pre-step 这类
  // 瀑布事件才有 next）。这条坑踩过一次，别改回去。
  for (const evt of ['session/flush', 'agent/disposed']) {
    try {
      ctx.on(evt, (payload) => {
        void flushAny(payload);
      });
    } catch (error) {
      log('挂 ' + evt + ' 失败：' + (error?.message ?? error));
    }
  }


  // ── HTTP 路由（设置页 / 控制菜单用）────────────────────────────────────────
  // 和 dsh-douyin-scroll 同一个坑：webServer 是 optional，apply 往往比它先跑完，
  // 所以必须"读不到就重试"，不能读一次就算了。
  function readBody(req, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try { cb(JSON.parse(body || '{}')); } catch (error) { cb(null, error); }
    });
  }

  function writeGroups(groups, extra = {}) {
    const sw = readSwitch();
    writeSwitch({ ...sw, ...extra, groups, at: Date.now() });
    return groups;
  }

  async function handleApi(req, res, url) {
    const send = (code, obj) => {
      try {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(obj));
      } catch { /* 连接已断 */ }
    };
    const p = url.pathname.replace(/^\/api\/crossmem/, '') || '/';
    try {
      if (req.method === 'GET' && p === '/state') {
        const sw = readSwitch();
        // 面板每次都想知道本地模型到底在不在 —— 探一次（60 秒缓存，force 可强制）
        await probeLocalModel(url.searchParams.get('force') === '1');
        return send(200, {
          ok: true,
          inject: sw.inject,
          capture: sw.capture,
          groups: sw.groups,
          reason: sw.reason,
          at: sw.at,
          dbPath: cfg.dbPath,
          curve: cfg.curve,
          injectCount: cfg.injectCount,
          includeQq: cfg.includeQq,
          localModel: {
            enabled: cfg.captureLocal,
            url: cfg.ollamaUrl,
            model: cfg.ollamaModel,
            status: !cfg.captureLocal ? 'off' : (localStatus.ok ? 'ok' : (localStatus.reason ? 'missing' : 'unknown')),
            reason: localStatus.reason,
          },
        });
      }

      // 会话列表：顺带按工作区归并（客户端直接渲染折叠）
      if (req.method === 'GET' && p === '/sessions') {
        const sw = readSwitch();
        const inGroup = new Map();
        for (const g of sw.groups) for (const sid of g.sessions) inGroup.set(sid, g.id);
        const showArchived = url.searchParams.get('showArchived') === '1';
        const all = listSessions(url.searchParams.get('refresh') === '1');
        const archivedCount = all.filter((x) => x.archived).length;
        const list = (showArchived ? all : all.filter((x) => !x.archived)).map((x) => ({
          ...x,
          groupId: inGroup.get(x.id) ?? '',
        }));
        const byCwd = new Map();
        for (const x of list) {
          const key = x.cwd || '(未知工作区)';
          if (!byCwd.has(key)) byCwd.set(key, []);
          byCwd.get(key).push(x);
        }
        const workspaces = [...byCwd.entries()].map(([cwd, items]) => ({
          cwd,
          name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
          count: items.length,
          linked: items.filter((x) => x.groupId).length,
          sessions: items,
        })).sort((a, b) => b.count - a.count);
        return send(200, { ok: true, sessions: list, workspaces, archivedCount, showArchived });
      }

      // 组：建 / 删 / 改名 / 加会话 / 移会话
      if (req.method === 'POST' && p === '/group') {
        return readBody(req, (j, err) => {
          if (err) return send(400, { ok: false, error: err.message });
          const sw = readSwitch();
          const action = String(j.action || '');
          let groups = sw.groups.map((g) => ({ ...g, sessions: [...g.sessions] }));
          if (action === 'create') {
            const name = String(j.name || '').trim() || '新组';
            const id = 'g' + Date.now().toString(36);
            groups.push({ id, name, sessions: [] });
          } else if (action === 'delete') {
            groups = groups.filter((g) => g.id !== String(j.groupId));
          } else if (action === 'rename') {
            const g = groups.find((x) => x.id === String(j.groupId));
            if (g) g.name = String(j.name || g.name).trim() || g.name;
          } else if (action === 'add' || action === 'remove') {
            const sid = String(j.sessionId || '').trim();
            if (!sid) return send(400, { ok: false, error: '缺 sessionId' });
            if (action === 'remove') {
              for (const g of groups) g.sessions = g.sessions.filter((x) => x !== sid);
            } else {
              // 一个会话只能属于一个组：先把它从别的组摘掉
              for (const g of groups) g.sessions = g.sessions.filter((x) => x !== sid);
              const g = groups.find((x) => x.id === String(j.groupId));
              if (!g) return send(400, { ok: false, error: '组不存在' });
              g.sessions.push(sid);
            }
          } else {
            return send(400, { ok: false, error: 'unknown action ' + action });
          }
          writeGroups(groups);
          return send(200, { ok: true, groups });
        });
      }

      if (req.method === 'POST' && p === '/switch') {
        return readBody(req, (j, err) => {
          if (err) return send(400, { ok: false, error: err.message });
          const sw = readSwitch();
          const next = {
            inject: typeof j.inject === 'boolean' ? j.inject : sw.inject,
            capture: typeof j.capture === 'boolean' ? j.capture : sw.capture,
            groups: Array.isArray(j.groups) ? j.groups : sw.groups,
            reason: String(j.reason ?? sw.reason ?? ''),
            at: Date.now(),
          };
          writeSwitch(next);
          return send(200, { ok: true, ...next });
        });
      }

      return send(404, { ok: false, error: 'unknown ' + req.method + ' ' + p });
    } catch (error) {
      return send(500, { ok: false, error: error?.message ?? String(error) });
    }
  }

  let panelMounted = false;
  const mountPanel = (ws) => {
    if (panelMounted || !ws || typeof ws.register !== 'function') return panelMounted;
    try {
      ctx.effect(() => ws.register({
        kind: 'prefix',
        path: '/api/crossmem',
        handler: async (req, res) => handleApi(req, res, new URL(req.url, 'http://127.0.0.1')),
      }), 'crossmem: /api/crossmem 路由');
      panelMounted = true;
      log('控制菜单路由已挂载：/api/crossmem');
    } catch (error) {
      log('控制菜单路由没挂上：' + (error?.message ?? error));
    }
    return panelMounted;
  };
  const wsNow = (() => { try { return ctx.get('webServer'); } catch { return null; } })();
  if (!mountPanel(wsNow)) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const ws = (() => { try { return ctx.get('webServer'); } catch { return null; } })();
      if (mountPanel(ws)) { clearInterval(timer); return; }
      if (tries >= 20) { clearInterval(timer); log('20 秒内没等到 webServer：控制菜单不可用（工具仍然可用）'); }
    }, 1000);
    timer?.unref?.();
  }

  // ── 能力 3：工具 ─────────────────────────────────────────────────────────
  crossmemBeacon('tools-begin');
  try {
    const actx = ctx;
    const register = (def) => {
      try { actx.tools.register(defineTool(def)); }
      catch (error) { log(`注册 ${def?.name} 失败：${error?.message ?? error}`); }
    };

    register({
      name: 'crossmem_search',
      description: '跨会话记忆检索：查别的会话记下的事（共用一份本地库）。',
      parameters: {
        query: { type: 'string', description: '关键词（中文子串可用）；留空则按重要度返回最近的' },
        limit: { type: 'integer', description: '返回条数 1-20，默认 8' },
      },
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const rows = search(args.query, Number(args.limit) || 8);
        if (!rows.length) return { text: '没有命中。' };
        const lines = rows.map((r) => `#${r.id} [${r.kind} R=${r.R.toFixed(2)} 重要度${r.importance}] ${String(r.content).slice(0, 140)}`);
        return { text: `命中 ${rows.length} 条：\n` + lines.join('\n') };
      },
    });

    register({
      name: 'crossmem_save',
      description: '把一条事实写进跨会话记忆库。不填 scope 时按当前会话自动归档：本机会话→公共区(所有会话可见)；QQ 会话→qq(只在 QQ 内可见，除非把会话放进打通组)。',
      parameters: {
        content: { type: 'string', required: true, description: '一句话说清' },
        importance: { type: 'integer', description: '重要度 1-5，默认 3' },
        tags: { type: 'string', description: '逗号分隔标签' },
        scope: { type: 'string', description: "共享范围：留空=按当前会话自动定；shared=公共区；qq=只在 QQ 内；填组 id=只对该组可见" },
      },
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sid = String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '');
        const sw = readSwitch();
        const viewer = viewerOf(sid, sw.groups, sw);
        const asked = String(args.scope ?? '').trim();
        const scope = asked || writeScopeOf(sid, viewer, sw.groups);
        const tags = [String(args.tags ?? ''), ...(viewer.isQq ? groupMarkers(viewer) : [])].filter(Boolean).join(',');
        const r = save({
          content: args.content,
          importance: args.importance,
          tags,
          scope,
          source: asked ? undefined : (viewer.isQq ? 'crossmem:qq' : 'crossmem:dsd'),
          subject: asked ? '' : (viewer.isQq ? viewer.conv : ''),
        });
        const where = scope === 'shared' ? '公共区' : (scope === 'qq' ? 'QQ 内部' : '组 ' + scope);
        return { text: r.duplicated ? `已有同一条 #${r.id}，没重复写。` : `已记下 #${r.id}（${where}）` };
      },
    });


    register({
      name: 'crossmem_switch',
      description: '打开/关闭跨会话记忆的「注入」和「自动记录」（插件仍装着，工具仍可用）。回退用它。',
      parameters: {
        inject: { type: 'boolean', description: '是否把记忆注入到系统提示（默认不动）' },
        capture: { type: 'boolean', description: '是否自动抓取/本地抽取（默认不动）' },
        reason: { type: 'string', description: '为什么关，方便以后回看' },
      },
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const cur = readSwitch();
        const next = {
          inject: typeof args.inject === 'boolean' ? args.inject : cur.inject,
          capture: typeof args.capture === 'boolean' ? args.capture : cur.capture,
          reason: String(args.reason ?? cur.reason ?? ''),
          at: Date.now(),
        };
        fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true });
        fs.writeFileSync(cfg.statePath, JSON.stringify(next, null, 2), 'utf8');
        return {
          text: `已更新软开关：注入=${next.inject ? '开' : '关'}，自动记录=${next.capture ? '开' : '关'}\n` +
            `文件：${cfg.statePath}\n（立即生效，不用重启；要彻底移除请跑 uninstall.ps1）`,
        };
      },
    });


    register({
      name: 'crossmem_sessions',
      description: '列出本机已有的 dsh 会话（按工作区归并，带所属打通组）。用来配置打通组。',
      parameters: { refresh: { type: 'boolean', description: '强制重新扫描（默认走 30 秒缓存）' } },
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const sw = readSwitch();
        const inGroup = new Map();
        for (const g of sw.groups) for (const sid of g.sessions) inGroup.set(sid, g.name);
        const list = listSessions(args.refresh === true);
        if (!list.length) return { text: '没扫到会话。' };
        const byCwd = new Map();
        for (const x of list) {
          const k = x.cwd || '(未知)';
          if (!byCwd.has(k)) byCwd.set(k, []);
          byCwd.get(k).push(x);
        }
        const lines = [];
        for (const [cwd, items] of byCwd) {
          lines.push(`【${path.basename(cwd) || cwd}】${items.length} 个`);
          for (const x of items.slice(0, 8)) {
            const grp = inGroup.get(x.id);
            lines.push(`  ${grp ? '✅[' + grp + ']' : '⬜'} ${x.id.slice(0, 20)} ${x.title ? '「' + x.title.slice(0, 16) + '」' : ''}`);
          }
        }
        const domain = activeDomain();
        const domainLine = domain ? `外部会话域：${domain.id}` : '外部会话域：未安装（只处理本机会话）';
        return { text: `共 ${list.length} 个会话，${sw.groups.length} 个打通组：\n${domainLine}\n` + lines.join('\n') };
      },
    });

    register({
      name: 'crossmem_groups',
      description: '管理打通组：list / create / delete / add / remove。每组任意多个会话；组内会话共享记忆，组外看不到。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | create | delete | add | remove' },
        groupId: { type: 'string', description: 'delete/add/remove 时必填' },
        name: { type: 'string', description: 'create 时的组名' },
        sessionId: { type: 'string', description: 'add/remove 时的会话 id' },
      },
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const sw = readSwitch();
        const groups = sw.groups.map((g) => ({ ...g, sessions: [...g.sessions] }));
        const action = String(args.action || 'list');
        if (action === 'list') {
          if (!groups.length) return { text: '还没有打通组。\n所有会话会共享同一份记忆（公共区）。' };
          return { text: groups.map((g) => `${g.id}  ${g.name}  ${g.sessions.length} 个会话`).join('\n') };
        }
        if (action === 'create') {
          const id = 'g' + Date.now().toString(36);
          groups.push({ id, name: String(args.name || '新组').trim() || '新组', sessions: [] });
          writeSwitch({ ...sw, groups, at: Date.now() });
          return { text: `已建组 id=${id} name=${args.name || '新组'}` };
        }
        if (action === 'delete') {
          const left = groups.filter((g) => g.id !== String(args.groupId));
          if (left.length === groups.length) return { text: '组不存在：' + args.groupId };
          writeSwitch({ ...sw, groups: left, at: Date.now() });
          return { text: `已删组 ${args.groupId}（里面的会话回到公共区）` };
        }
        if (action === 'add' || action === 'remove') {
          const sid = String(args.sessionId || '').trim();
          if (!sid) return { text: '缺 sessionId' };
          if (action === 'remove') {
            for (const g of groups) g.sessions = g.sessions.filter((x) => x !== sid);
            writeSwitch({ ...sw, groups, at: Date.now() });
            return { text: `已把 ${sid.slice(0, 20)} 移出所有组` };
          }
          for (const g of groups) g.sessions = g.sessions.filter((x) => x !== sid);
          const g = groups.find((x) => x.id === String(args.groupId));
          if (!g) return { text: '组不存在：' + args.groupId };
          g.sessions.push(sid);
          writeSwitch({ ...sw, groups, at: Date.now() });
          return { text: `已把 ${sid.slice(0, 20)} 加入「${g.name}」（该组 ${g.sessions.length} 个会话）` };
        }
        return { text: '未知 action：' + action };
      },
    });

    register({
      name: 'crossmem_stats',
      description: '看跨会话记忆库概况：总数、来源分布、当前曲线。',
      parameters: {},
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute() {
        if (!db) return { text: '记忆库不可用：' + (dbError || '未初始化') };
        const total = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
        const active = db.prepare('SELECT COUNT(*) c FROM memories WHERE archived = 0').get().c;
        const rows = db.prepare('SELECT source, COUNT(*) c FROM memories WHERE archived = 0 GROUP BY source ORDER BY c DESC LIMIT 6').all();
        const byOrigin = { dsd: 0, qq: 0 };
        for (const r of db.prepare('SELECT * FROM memories WHERE archived = 0').all()) byOrigin[originOf(r)] += 1;
        const srcLines = rows.map((r) => `  ${r.source || '(空)'}：${r.c}`).join('\n');
        const domain = activeDomain();
        return {
          text: `共 ${total} 条（活跃 ${active}）\n来源：本机会话 ${byOrigin.dsd} / 外部域 ${byOrigin.qq}\n曲线：${cfg.curve}（k=${cfg.curveK}）\n注入：${cfg.injectCount} 条 / 上限 ${cfg.maxInjectChars} 字\n可见性：公共区(shared) 人人可见；qq 只在 QQ 会话可见（includeQq=${cfg.includeQq ? '开' : '关'}）；打通组内共享\n外部会话域：${domain ? domain.id : '未安装（只处理本机会话）'}\n打通组：${(() => { const gs = readSwitch().groups; return gs.length === 0 ? '未设置（所有会话共享公共区）' : gs.map((g) => g.name + '(' + g.sessions.length + ')').join(' / '); })()}\n软开关：注入${readSwitch().inject ? '开' : '关（回退中）'} / 自动记录${readSwitch().capture ? '开' : '关（回退中）'}${readSwitch().reason ? '（' + readSwitch().reason + '）' : ''}\n本地抽取：${cfg.captureLocal ? (localStatus.checked ? (localStatus.ok ? '可用' : '不可用（' + localStatus.reason + '）') : '未探测') : '关闭'}\n库：${cfg.dbPath}\n${srcLines}`,
        };
      },
    });

    register({
      name: 'crossmem_recent',
      description: '列出最近 N 条跨会话记忆（按创建时间）。',
      parameters: { limit: { type: 'integer', description: '1-20，默认 10' } },
      output: TEXT_OUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!db) return { text: '记忆库不可用' };
        const n = Math.max(1, Math.min(20, Number(args.limit) || 10));
        const rows = db.prepare('SELECT * FROM memories WHERE archived = 0 ORDER BY created_at DESC LIMIT ?').all(n);
        if (!rows.length) return { text: '库是空的。' };
        return { text: rows.map((r) => `#${r.id} [${originOf(r)}] ${String(r.content).slice(0, 120)}`).join('\n') };
      },
    });
  } catch (error) {
    log('工具注册失败：' + (error?.message ?? error));
  }

  // 测试用钩子：把纯函数露出来（不影响运行时行为）
  crossmemBeacon('tools-done');
  ctx.__test = { parseFacts, curveValue, originOf, effectiveScope, cleanUserText, conversationOf };

  const domain = activeDomain();
  log(`已挂载（库=${cfg.dbPath}，注入 ${cfg.injectCount} 条，自动抓取=${cfg.autoCapture ? '开' : '关'}，`
    + `域插件=${domain ? domain.id : '无（只处理本机会话）'}，includeQq=${cfg.includeQq ? '开' : '关'}）`);
}
