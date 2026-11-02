// 扫会话日志，看有没有「跨会话记忆」注入的痕迹。
//
// 为什么需要它：注入是**每轮重新组装**的，所以关掉开关后下一轮就干净了；
// 但已经发生过的轮次已经写进会话日志（system/message、request/context）。
// 这个脚本用来回答："这个会话里还有没有注入残留？"
//
// 用法：
//   node scan-injection.mjs --cwd "C:\some\project"     # 扫该工作目录下所有会话
//   node scan-injection.mjs --session <session-id>
//   node scan-injection.mjs --all
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MARKER = '【跨会话记忆';

function readFrames(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')); } catch { /* 坏帧跳过 */ }
  }
  return parts.join('');
}

function sessionsUnder(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name === 'session.v4.jsonl.zstd') out.push(full);
    }
  };
  walk(root);
  return out;
}

const argv = process.argv.slice(2);
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? String(argv[i + 1] ?? d) : d; };

const cwdFilter = argOf('--cwd');
const sessionFilter = argOf('--session');
const all = argv.includes('--all');

let files = sessionsUnder(SESSIONS);
if (sessionFilter) files = files.filter((f) => f.includes(sessionFilter));
if (cwdFilter) {
  const norm = cwdFilter.replace(/[\\/]+$/, '').toLowerCase();
  files = files.filter((f) => f.toLowerCase().includes(norm.replace(/[\\:]/g, '-')));
}
if (!files.length) { console.log('没找到匹配的会话文件'); process.exit(0); }

let hits = 0;
let scanned = 0;
for (const file of files) {
  scanned += 1;
  let txt = '';
  try { txt = readFrames(file); } catch { continue; }
  // 只看「系统提示 / 请求上下文」这两类记录：注入只会出现在那里。
  // 不能全文 grep —— 我们在对话里讨论过这段文字，会被误判成注入残留（实测踩过）。
  const ONLY_SYSTEM = new Set(['system/message', 'request/context', 'request/header']);
  let injectedLines = '';
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let j = null;
    try { j = JSON.parse(line); } catch { continue; }
    const kind = j.type || j.kind || '';
    if (!ONLY_SYSTEM.has(kind)) continue;
    injectedLines += line + '\n';
  }
  const n = injectedLines.split(MARKER).length - 1;
  const sid = path.basename(path.dirname(file));
  if (n > 0) {
    hits += 1;
    console.log(`⚠️  ${sid}  含 ${n} 处注入残留`);
  } else if (all) {
    console.log(`✅ ${sid}  干净`);
  }
}
console.log(`\n扫描 ${scanned} 个会话，${hits} 个含注入痕迹。`);
if (hits > 0) {
  console.log('说明：这是历史轮次留下的记录（当时确实注入过），不是"当前还在注入"。');
  console.log('     关掉开关后新的一轮不再注入；想要完全干净的上下文就新开一个会话。');
}
