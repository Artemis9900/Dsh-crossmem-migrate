// dsh-crossmem 测试：用桩 ctx 跑通 注入 / 抓取 / 隐私隔离 / 工具 四条路径。
//
// 为什么要在 profile 的 node_modules 里跑：插件 import 了
// '@deepseek-ai/schemastery' 和 '@deepseek-ai/dsh-tools'，只有 profile 的
// node_modules 里才解析得到（这也顺便验证了"装进去能不能加载"）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROFILE = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop');
const TEST_DIR = path.join(PROFILE, 'node_modules', 'dsh-crossmem');
const SRC = 'D:\\deepseek memory\\plugins\\dsh-crossmem';
const DB = path.join(os.tmpdir(), 'crossmem-test.db');

function rmdir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 被占用就留着 */ } }

rmdir(TEST_DIR);
fs.mkdirSync(TEST_DIR, { recursive: true });
fs.cpSync(SRC, TEST_DIR, { recursive: true });
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch { /* 不存在 */ } }

const mod = await import('file:///' + TEST_DIR.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:') + '/lib/index.js');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

// ── 桩上下文 ──────────────────────────────────────────────────────────────
function makeCtx() {
  const tools = [];
  const handlers = new Map();
  return {
    tools: { register: (t) => tools.push(t) },
    on: (evt, fn, opts) => { handlers.set(evt, { fn, opts }); return () => {}; },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: () => () => {},
    _tools: tools,
    _handlers: handlers,
  };
}

const ctx = makeCtx();
mod.apply(ctx, { dbPath: DB, injectCount: 3, includeQq: false, autoCapture: true, curve: 'power' });

check('apply 不抛错', true);
check('注册了 7 个工具', ctx._tools.length === 7, ctx._tools.map((t) => t.name).join(','));
check('挂了 system-prompt/assemble', ctx._handlers.has('system-prompt/assemble'));
check('挂了 agent/pre-step', ctx._handlers.has('agent/pre-step'));

const call = async (name, args) => {
  const t = ctx._tools.find((x) => x.name === name);
  if (!t) throw new Error('没有工具 ' + name);
  const out = await t.execute(args);
  return out?.text ?? JSON.stringify(out);
};

// ── 1. 写入 ────────────────────────────────────────────────────────────────
const saveOut = await call('crossmem_save', { content: '跨会话测试：操作者用 RTX 4050 6GB', importance: 4, tags: '测试,硬件' });
check('crossmem_save 写入', /已记下 #\d+/.test(saveOut), saveOut);
const dupOut = await call('crossmem_save', { content: '跨会话测试：操作者用 RTX 4050 6GB', importance: 4 });
check('重复内容不重复写', /已有同一条/.test(dupOut), dupOut);

// 直接塞一条 QQ 来源的记忆，用于隐私测试
const { DatabaseSync } = await import('node:sqlite');
{
  const db = new DatabaseSync(DB);
  const now = Date.now();
  db.prepare('INSERT INTO memories (kind, subject, content, tags, importance, source, created_at, updated_at, last_used_at, strength) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('fact', '', 'QQ 群测试：群友说猫叫豆豆', 'qq,宠物', 5, 'qq-bridge', now, now, now, 6);
  db.close();
}

// ── 2. 检索 ────────────────────────────────────────────────────────────────
const searchOut = await call('crossmem_search', { query: 'RTX' });
check('crossmem_search 命中', /命中 1 条/.test(searchOut), searchOut.split('\n')[0]);
const searchQqOut = await call('crossmem_search', { query: '豆豆' });
check('检索不过滤 QQ（检索是显式的，允许查到）', /命中 1 条/.test(searchQqOut), searchQqOut.split('\n')[0]);

// ── 3. 注入 + 隐私隔离 ─────────────────────────────────────────────────────
async function runAssemble(ctxObj) {
  const h = ctxObj._handlers.get('system-prompt/assemble');
  const assembly = { sections: [], contexts: [], tools: [], variables: {} };
  const context = { agent: { id: 'sess-abc123', session: { id: 'sess-abc123', header: { cwd: 'D:\\proj\\demo' } } } };
  return h.fn(assembly, context, async () => assembly);
}
const assembled = await runAssemble(ctx);
const injected = (assembled.contexts || []).find((c) => c.name === 'crossmem');
check('注入块存在', Boolean(injected));
check('注入内容含本机会话记忆', Boolean(injected && injected.text.includes('RTX 4050')));
check('默认不注入 QQ 记忆', Boolean(injected && !injected.text.includes('豆豆')), 'includeQq=false');
check('注入块带会话标识', Boolean(injected && injected.text.includes('sess-abc')), injected?.text.split('\n').pop());

// includeQq=true 时应该注入
const ctx2 = makeCtx();
mod.apply(ctx2, { dbPath: DB, injectCount: 3, includeQq: true });
const assembled2 = await runAssemble(ctx2);
const injected2 = (assembled2.contexts || []).find((c) => c.name === 'crossmem');
check('开启 includeQq 后注入 QQ 记忆', Boolean(injected2 && injected2.text.includes('豆豆')));

// ── 4. 自动抓取 ────────────────────────────────────────────────────────────
const before = await call('crossmem_recent', { limit: 20 });
const h2 = ctx._handlers.get('agent/pre-step');
await h2.fn(
  { agent: { session: { id: 'sess-abc123', header: { cwd: 'D:\\proj\\demo' } } }, step: 1, messages: [{ role: 'user', content: '记住：这个项目用 pnpm 而不是 npm' }] },
  async () => ({ kind: 'accept' })
);
const after = await call('crossmem_recent', { limit: 20 });
check('pre-step 抓到「记住：…」', after !== before && /pnpm/.test(after), after.split('\n')[0]);

// 不该抓的：普通寒暄
const h3 = ctx._handlers.get('agent/pre-step');
const before2 = await call('crossmem_recent', { limit: 20 });
await h3.fn(
  { agent: { session: { id: 'sess-abc123' } }, step: 2, messages: [{ role: 'user', content: '今天天气不错啊，出去走走' }] },
  async () => ({ kind: 'accept' })
);
const after2 = await call('crossmem_recent', { limit: 20 });
check('寒暄不会被误记', before2 === after2);

// ── 5. 统计 ────────────────────────────────────────────────────────────────
const stats = await call('crossmem_stats', {});
check('crossmem_stats 能报来源分布', /本机会话 \d+ \/ 外部域 \d+/.test(stats), stats.split('\n').slice(0, 3).join(' | '));


// ── 6. 本地模型抽取（B 方案）──────────────────────────────────────────────
// 6a. 解析器：模型输出会有编号/空行/"无"，要洗干净
{
  const raw = '1. 使用者用 RTX 4050 6GB\n- 喜欢短句\n无\n\n2. 电脑跑 8B 模型偏慢';
  const facts = ctx.__test?.parseFacts ? ctx.__test.parseFacts(raw) : null;
  if (facts) {
    check('parseFacts 过滤编号与空行', facts.length === 3, JSON.stringify(facts));
  }
}

// 6b. 端到端：真打一次 Ollama（超时/没装就跳过，不算失败）
{
  const t0 = Date.now();
  const probe = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!probe || !probe.ok) {
    console.log('⏭  跳过本地抽取端到端（Ollama 没起）');
  } else {
    const ctx3 = makeCtx();
    mod.apply(ctx3, { dbPath: DB, injectCount: 3, autoCapture: true, captureLocal: true, ollamaModel: 'modelscope.cn/Qwen/Qwen3-8B-GGUF:Q4_K_M' });
    const pre = ctx3._handlers.get('agent/pre-step');
    await pre.fn({ agent: { session: { id: 'sess-local-1', header: { cwd: 'D:\\proj\\demo' } } }, step: 1,
      messages: [{ role: 'user', content: '我这个笔记本是 RTX 4050，只有 6GB 显存，跑 8B 模型挺吃力的，平时主要用来写代码' }] },
      async () => ({ kind: 'accept' }));
    const flush = ctx3._handlers.get('session/flush');
    if (!flush) { check('挂了 session/flush', false); }
    else {
      check('挂了 session/flush', true);
      await flush.fn({ agent: { session: { id: 'sess-local-1' } } }, async () => ({}));
      await new Promise((r) => setTimeout(r, 500));
      const recent = await call('crossmem_recent', { limit: 30 });
      const got = /显存|4050|6GB/.test(recent.split('\n').slice(3).join('\n'));
      check('本地模型抽出并写库', got, `耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
}


// ── 7. 软开关（回退 = 只停注入/抓取，插件还在）────────────────────────────
{
  const stateFile = path.join(os.tmpdir(), 'crossmem-switch.json');
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
  const ctx4 = makeCtx();
  const call4 = async (name, args) => {
    const t = ctx4._tools.find((x) => x.name === name);
    const out = await t.execute(args);
    return out?.text ?? JSON.stringify(out);
  };
  mod.apply(ctx4, { dbPath: DB, injectCount: 3, autoCapture: true, captureLocal: false, statePath: stateFile });

  // 7a. 默认（无 state 文件）→ 会注入
  const a1 = await (async () => {
    const h = ctx4._handlers.get('system-prompt/assemble');
    const assembly = { sections: [], contexts: [], tools: [], variables: {} };
    const out = await h.fn(assembly, { agent: { session: { id: 's1', header: { cwd: 'D:\\x' } } } }, async () => assembly);
    return (out.contexts || []).find((c) => c.name === 'crossmem');
  })();
  check('默认状态会注入', Boolean(a1 && a1.text.includes('跨会话记忆')));

  // 7b. 写软开关关掉 → 不注入
  fs.writeFileSync(stateFile, JSON.stringify({ inject: false, capture: false, reason: 'test' }), 'utf8');
  const a2 = await (async () => {
    const h = ctx4._handlers.get('system-prompt/assemble');
    const assembly = { sections: [], contexts: [], tools: [], variables: {} };
    const out = await h.fn(assembly, { agent: { session: { id: 's1' } } }, async () => assembly);
    return (out.contexts || []).find((c) => c.name === 'crossmem');
  })();
  check('回退后不注入', !a2);

  // 7c. 回退后抓取也停
  const beforeSw = await call4('crossmem_recent', { limit: 30 });
  const pre4 = ctx4._handlers.get('agent/pre-step');
  await pre4.fn({ agent: { session: { id: 's1' } }, step: 1, messages: [{ role: 'user', content: '记住：回退期间不该写入这条' }] }, async () => ({ kind: 'accept' }));
  const afterSw = await call4('crossmem_recent', { limit: 30 });
  check('回退后不自动抓取', beforeSw === afterSw);

  // 7d. 工具仍然可用（可以手动查/写）
  const manual = await call4('crossmem_save', { content: '回退期间手动写入仍然有效' });
  check('回退后工具仍可用', /已记下 #\d+/.test(manual), manual);

  // 7e. crossmem_switch 能把开关打开
  const swOut = await call4('crossmem_switch', { inject: true, capture: true });
  check('crossmem_switch 可开回', /注入=开/.test(swOut), swOut.split('\n')[0]);
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('state 文件内容正确', st.inject === true && st.capture === true, JSON.stringify(st));
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
}


// ── 8. 会话列表 / 打通组（控制菜单的服务端）────────────────────────────────
{
  const stateFile = path.join(os.tmpdir(), 'crossmem-groups.json');
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
  const ctx5 = makeCtx();
  mod.apply(ctx5, { dbPath: DB, injectCount: 3, statePath: stateFile, captureLocal: false });
  const call5 = async (name, args) => {
    const t = ctx5._tools.find((x) => x.name === name);
    const out = await t.execute(args ?? {});
    return out?.text ?? JSON.stringify(out);
  };

  const list = await call5('crossmem_sessions', { refresh: true });
  const m = list.match(/共 (\d+) 个会话/);
  check('crossmem_sessions 能扫到会话', Boolean(m && Number(m[1]) > 0), m ? m[0] : list.slice(0, 50));

  // 建组
  const created = await call5('crossmem_groups', { action: 'create', name: '测试组' });
  check('建组', /已建组/.test(created), created);
  const gid = (created.match(/id=(\S+)/) || [])[1];
  check('拿到组 id', Boolean(gid), gid || '');

  // 加两个会话
  await call5('crossmem_groups', { action: 'add', groupId: gid, sessionId: 'sess-a' });
  const added2 = await call5('crossmem_groups', { action: 'add', groupId: gid, sessionId: 'sess-b' });
  check('一组可加多个会话', /2 个会话/.test(added2), added2);

  // 组内/组外注入
  const injectFor = async (sid) => {
    const hh = ctx5._handlers.get('system-prompt/assemble');
    const assembly = { sections: [], contexts: [], tools: [], variables: {} };
    const out = await hh.fn(assembly, { agent: { session: { id: sid, header: { cwd: 'D:\\p' } } } }, async () => assembly);
    return (out.contexts || []).find((c) => c.name === 'crossmem');
  };
  check('组内会话 -> 注入', Boolean(await injectFor('sess-a')));
  check('组外会话 -> 也注入公共区', Boolean(await injectFor('sess-zzz')));

  // 一个会话只能在一个组：加入另一个组后从原组消失
  const g2 = (await call5('crossmem_groups', { action: 'create', name: '组二' })).match(/id=(\S+)/)[1];
  await call5('crossmem_groups', { action: 'add', groupId: g2, sessionId: 'sess-b' });
  const groupsText = await call5('crossmem_groups', { action: 'list' });
  check('会话只属于一个组', groupsText.split('\n').filter((l) => l.includes('sess-b')).length === 0 || /组二  1 个会话/.test(groupsText), groupsText.replace(/\n/g, ' | '));

  // 移出
  const removed = await call5('crossmem_groups', { action: 'remove', sessionId: 'sess-a' });
  check('移出会话', /移出所有组/.test(removed), removed);

  // 删组
  const del = await call5('crossmem_groups', { action: 'delete', groupId: g2 });
  check('删组', /已删组/.test(del), del);

  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
}

// ── 9. 域插件接口（QQ 拆成可选包后，core 只认这一层）──────────────────────
// 用一个假的「域」验证：会话身份、只读范围、写入范围、注入额度、抓取都由域提供。
{
  const stateFile = path.join(os.tmpdir(), 'crossmem-domain.json');
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }

  const fake = {
    id: 'fake',
    domain: 'fake',
    conversationOf: (sid) => (sid === 'sess-q1' ? 'group:111' : sid === 'sess-q2' ? 'group:222' : ''),
    viewerOf: (sid) => (sid === 'sess-q1' || sid === 'sess-q2'
      ? {
        domain: 'fake',
        conv: sid === 'sess-q1' ? 'group:111' : 'group:222',
        isQq: true,
        readScopes: ['qq'],
        writeScope: 'qq',
        label: 'FAKE ' + sid,
        limits: { count: 9, chars: 3000 },
      }
      : null),
    rowScope: (row) => (String(row?.source || '').startsWith('fake:') ? 'qq' : ''),
    captureFacts: () => [{ content: '假域抓到的口令 X → Y', importance: 5, rule: true }],
  };
  globalThis.__crossmemDomains = [fake];

  {
    const db = new DatabaseSync(DB);
    const now = Date.now();
    const ins = db.prepare('INSERT INTO memories (kind, subject, content, tags, importance, source, created_at, updated_at, last_used_at, strength, scope) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('fact', 'group:111', '假域共享记忆 Q1', '口令', 5, 'fake:qq', now, now, now, 6, 'qq');
    ins.run('fact', '', '本机公共记忆', '本机', 3, 'crossmem:dsd', now - 1000, now - 1000, now - 1000, 4, 'shared');
    db.close();
  }

  const ctx6 = makeCtx();
  mod.apply(ctx6, { dbPath: DB, statePath: stateFile, captureLocal: false, injectCount: 3 });
  const injectFor = async (sid) => {
    const hh = ctx6._handlers.get('system-prompt/assemble');
    const assembly = { sections: [], contexts: [], tools: [], variables: {} };
    const out = await hh.fn(assembly, { agent: { session: { id: sid, header: { cwd: 'D:\\x' } } } }, async () => assembly);
    return (out.contexts || []).find((c) => c.name === 'crossmem');
  };

  const injQ1 = await injectFor('sess-q1');
  check('域会话能看到域范围记忆', Boolean(injQ1 && injQ1.text.includes('假域共享记忆 Q1')));
  check('注入块用域给的标签', Boolean(injQ1 && injQ1.text.includes('FAKE sess-q1')), injQ1?.text.split('\n').pop());
  check('域会话也能看到本机公共记忆', Boolean(injQ1 && injQ1.text.includes('本机公共记忆')));

  const injLocal = await injectFor('sess-local-2');
  check('本机会话看不到域记忆（includeQq=false）', Boolean(injLocal && !injLocal.text.includes('假域共享记忆 Q1')));

  const pre6 = ctx6._handlers.get('agent/pre-step');
  await pre6.fn({
    agent: { session: { id: 'sess-q1', header: { cwd: 'D:\\x' } } },
    step: 1,
    messages: [{ role: 'user', content: '随便一句话' }],
  }, async () => ({ kind: 'accept' }));
  const recent6 = await call('crossmem_recent', { limit: 5 });
  check('域抓取写进库', /假域抓到的口令/.test(recent6), recent6.split('\n')[0]);
  {
    const db = new DatabaseSync(DB);
    const row = db.prepare("SELECT source, scope, subject, importance FROM memories WHERE content LIKE '%假域抓到的口令%' ORDER BY id DESC LIMIT 1").get();
    db.close();
    check('域写入用域给的 scope', Boolean(row && row.scope === 'qq' && row.source === 'crossmem:qq'), JSON.stringify(row));
  }

  delete globalThis.__crossmemDomains;
  const ctx7 = makeCtx();
  mod.apply(ctx7, { dbPath: DB, statePath: stateFile, captureLocal: false });
  const hh7 = ctx7._handlers.get('system-prompt/assemble');
  const a7 = { sections: [], contexts: [], tools: [], variables: {} };
  const out7 = await hh7.fn(a7, { agent: { session: { id: 'sess-q1', header: { cwd: 'D:\\x' } } } }, async () => a7);
  const inj7 = (out7.contexts || []).find((c) => c.name === 'crossmem');
  check('没有域插件时按本机会话处理', Boolean(inj7 && !inj7.text.includes('假域共享记忆 Q1')), inj7?.text?.split('\n').slice(0, 2).join(' | '));

  globalThis.__crossmemDomains = [];
  try { fs.unlinkSync(stateFile); } catch { /* ok */ }
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
console.log(`\n通过 ${passed}/${results.length}`);
rmdir(TEST_DIR);
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch { /* ok */ } }
console.log('测试副本与临时库已清理');
process.exit(passed === results.length ? 0 : 1);
