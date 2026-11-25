'use strict';
// 학습 모니터 - 슈퍼바이저 서버 (선생님 PC · Windows/Mac 공용). 외부 패키지 없이 Node 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 47800;
const DISCOVERY_PORT = 47801;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STUDENT_CONFIG = path.join(ROOT, '..', 'student', 'config.txt');
const MAX_BODY = 8 * 1024 * 1024;
const REPO = 'seraph0153/itc-study-monitor'; // 주소로 설치할 때 쓰는 GitHub 저장소

const DEFAULTS = {
  classCode: '',
  captureIntervalSec: 3,
  saveEverySec: 30,
  retentionDays: 14,
  idleMinutes: 5,
  keywords: [
    'youtube', '유튜브', 'netflix', '넷플릭스', 'twitch', '치지직', 'tiktok', '틱톡',
    'instagram', '인스타그램', 'facebook', 'discord', '디스코드', 'kakaotalk', '카카오톡',
    'roblox', '로블록스', 'minecraft', '마인크래프트', 'league of legends', 'steam',
    '웹툰', 'webtoon', '게임',
  ],
  names: {},
  known: {},
  layout: { cols: 2, fit: false, order: [] }, // 대시보드 배열 (모든 화면에서 같이 쓰임)
};

// ---------- 설정 ----------
let cfg = { ...DEFAULTS };
try {
  cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
} catch { /* 첫 실행 */ }
cfg.layout = { ...DEFAULTS.layout, ...(cfg.layout || {}) };
if (!/^[a-f0-9]{16}$/.test(cfg.classCode)) cfg.classCode = crypto.randomBytes(8).toString('hex');
saveConfig();
syncStudentConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// 학생용 폴더의 config.txt에 연결 키를 자동으로 적어 둡니다 (폴더째 복사하면 바로 연결됨).
function syncStudentConfig() {
  try {
    let lines;
    try {
      lines = fs.readFileSync(STUDENT_CONFIG, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    } catch {
      lines = [
        '# Study Monitor - student agent settings',
        '# code   : connection key (written automatically by the supervisor)',
        '# server : leave empty for auto-discovery, or set the teacher PC IP (e.g. 192.168.0.10)',
        '# name   : leave empty to use the PC name',
        'code=',
        'server=',
        'name=',
      ];
    }
    let found = false;
    lines = lines.map((l) => {
      if (/^code\s*=/.test(l)) { found = true; return 'code=' + cfg.classCode; }
      return l;
    });
    if (!found) lines.push('code=' + cfg.classCode);
    fs.mkdirSync(path.dirname(STUDENT_CONFIG), { recursive: true });
    fs.writeFileSync(STUDENT_CONFIG, lines.join('\r\n'));
  } catch (e) {
    console.error('student/config.txt 를 쓰지 못했습니다:', e.message);
  }
}

// ---------- 유틸 ----------
const pad = (n) => String(n).padStart(2, '0');
function ymd(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hms(d = new Date()) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function sanitizeId(s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40); }
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}
function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// ---------- 클라이언트 상태 ----------
const clients = new Map();
let msgSeq = Date.now();

function getClient(id) {
  let c = clients.get(id);
  if (!c) {
    c = {
      id, pcName: cfg.known[id] || id, lastSeen: 0, title: '', proc: '', idleSec: 0,
      frame: null, frameSeq: 0, distracted: false, keyword: null,
      lockWanted: false, lockText: '', lockedReported: false,
      messages: [], lastSavedAt: 0, lastLogKey: null,
      addr: '', self: false, power: null, offUntil: 0, remove: null,
    };
    clients.set(id, c);
  }
  return c;
}
for (const id of Object.keys(cfg.known)) getClient(id);

// 선생님 컴퓨터 자신에서 실행 중인 학생 프로그램인지 (전원 끄기 대상에서 빼기 위해)
function isSelfAddr(a) {
  if (process.env.SM_DEV_NO_SELF === '1') return false; // 개발용: 같은 컴퓨터의 가짜 학생으로 시험할 때
  a = String(a || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || lanIPs().includes(a);
}

function isOnline(c) {
  return Date.now() - c.lastSeen < Math.max(10000, cfg.captureIntervalSec * 3000);
}
function matchKeyword(title, proc) {
  const hay = (title + ' ' + proc).toLowerCase();
  return cfg.keywords.find((k) => k && hay.includes(k.toLowerCase())) || null;
}

// ---------- 기록 ----------
function dayDir(id, date = ymd()) { return path.join(DATA, date, id); }
function appendLog(id, entry) {
  const dir = dayDir(id);
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) return;
    fs.appendFile(path.join(dir, 'log.jsonl'), JSON.stringify({ t: hms(), ...entry }) + '\n', () => {});
  });
}
function record(c, gotFrame, justDistracted) {
  const key = `${c.title}|${c.proc}|${c.keyword || ''}`;
  if (key !== c.lastLogKey) {
    c.lastLogKey = key;
    appendLog(c.id, { type: 'activity', title: c.title, proc: c.proc, keyword: c.keyword || undefined });
  }
  const now = Date.now();
  if (gotFrame && cfg.saveEverySec > 0 && (justDistracted || now - c.lastSavedAt >= cfg.saveEverySec * 1000)) {
    c.lastSavedAt = now;
    const dir = dayDir(c.id);
    const file = path.join(dir, hms().replace(/:/g, '') + (c.distracted ? '_d' : '') + '.jpg');
    const buf = c.frame;
    fs.mkdir(dir, { recursive: true }, (err) => { if (!err) fs.writeFile(file, buf, () => {}); });
  }
}
function cleanupOldRecords() {
  if (!(cfg.retentionDays > 0)) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - cfg.retentionDays);
  const cutoffStr = ymd(cutoff);
  let dirs = [];
  try { dirs = fs.readdirSync(DATA); } catch { return; }
  for (const d of dirs) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoffStr) {
      fs.rm(path.join(DATA, d), { recursive: true, force: true }, () => {});
    }
  }
}
cleanupOldRecords();
setInterval(cleanupOldRecords, 6 * 3600 * 1000).unref();

// ---------- 목록에서 제거 ----------
function forgetClient(id) {
  clients.delete(id);
  delete cfg.known[id];
  delete cfg.names[id];
  cfg.layout.order = cfg.layout.order.filter((x) => x !== id);
  saveConfig();
}
// 원격 제거 명령을 받은 PC는 프로그램을 지우고 꺼집니다. 연결이 끊기면 목록에서도 지웁니다.
// 2분 안에 꺼지지 않으면(예전 버전 프로그램) 명령을 거둡니다.
setInterval(() => {
  for (const c of [...clients.values()]) {
    if (!c.remove) continue;
    if (!isOnline(c)) forgetClient(c.id);
    else if (Date.now() > c.remove.expires) { c.remove = null; c.removeFailed = Date.now(); }
  }
}, 2000).unref();

// ---------- HTTP ----------
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res, obj, status = 200) { send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (ch) => {
      size += ch.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// 대시보드와 관리 API는 이 컴퓨터에서만 열립니다 (같은 와이파이의 다른 기기는 접근 불가).
function isLocalAdmin(req) {
  const a = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && (host === 'localhost' || host === '127.0.0.1');
}

// ---------- 다른 컴퓨터에서 보기 (비밀번호 로그인) ----------
// 설정에서 비밀번호를 정해 켰을 때만, 같은 와이파이의 다른 컴퓨터가 로그인 후 대시보드를 볼 수 있습니다.
const SESSION_MS = 12 * 3600 * 1000;
const sessions = new Map();   // 토큰 -> 만료 시각
const loginFails = new Map(); // IP -> { count, until }
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 32); }
function remoteEnabled() { return !!(cfg.remote && cfg.remote.hash && cfg.remote.salt); }
function hasSession(req) {
  const m = /(?:^|;\s*)sm_session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}
async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || '';
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) return sendJson(res, { ok: false, error: '여러 번 틀렸습니다. 잠시 후 다시 시도해 주세요.' }, 429);
  if (!String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, 'json only');
  let pw = '';
  try { pw = String(JSON.parse((await readBody(req)).toString('utf8')).password || ''); } catch { /* 빈 값으로 처리 */ }
  const ok = pw.length > 0 && pw.length <= 200
    && crypto.timingSafeEqual(hashPassword(pw, cfg.remote.salt), Buffer.from(cfg.remote.hash, 'hex'));
  if (!ok) {
    const count = (f ? f.count : 0) + 1;
    loginFails.set(ip, { count, until: count >= 5 ? Date.now() + 60000 * Math.min(30, count - 4) : 0 });
    return sendJson(res, { ok: false, error: '비밀번호가 맞지 않습니다.' }, 401);
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': `sm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
  });
  res.end('{"ok":true}');
}
const LOGIN_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>학습 모니터 로그인</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f2f8fc;color:#3b4046;font:15px/1.5 -apple-system,"Apple SD Gothic Neo","Malgun Gothic","Segoe UI",sans-serif}
form{background:#fff;border:1px solid #dbe6ee;border-top:4px solid #00adef;border-radius:12px;padding:28px;width:min(360px,90vw);box-shadow:0 8px 30px rgba(0,120,180,.1)}
img{display:block;height:44px;margin:0 auto 6px}h1{font-size:15px;font-weight:600;color:#7b858f;text-align:center;margin:0 0 18px}
input,button{font:inherit;width:100%;padding:10px 12px;border-radius:8px;border:1px solid #dbe6ee;box-sizing:border-box}
input{background:#f2f8fc;color:#3b4046}button{margin-top:12px;background:#0089cf;border-color:#0089cf;color:#fff;cursor:pointer}
p{color:#e5484d;min-height:1.5em;margin:10px 0 0;font-size:13px}</style></head><body>
<form id="f"><img src="/logo.png" alt="ITC 영어"><h1>학습 모니터</h1><input id="pw" type="password" placeholder="접속 비밀번호" autofocus autocomplete="current-password">
<button>들어가기</button><p id="err"></p></form><script>
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
const j=await r.json().catch(()=>({}));if(j.ok)location.href='/';else document.getElementById('err').textContent=j.error||'로그인하지 못했습니다.';};
</script></body></html>`;

function route(req, res, url) {
  const p = url.pathname;
  if (p === '/api/client/report') {
    return req.method === 'POST' ? handleReport(req, res, url.searchParams) : Promise.resolve(send(res, 405, 'post only'));
  }
  if (p === '/logo.png' && req.method === 'GET') { // 로그인 화면에도 쓰이므로 로그인 전에도 제공
    let logo;
    try { logo = fs.readFileSync(path.join(ROOT, 'public', 'logo.png')); } catch { return Promise.resolve(send(res, 404, 'not found')); }
    return Promise.resolve(send(res, 200, logo, 'image/png'));
  }
  if (isLocalAdmin(req)) return handleAdmin(req, res, url, true);
  if (!remoteEnabled()) return Promise.resolve(send(res, 403, '이 대시보드는 서버를 켠 컴퓨터에서만 열 수 있습니다. (설정에서 "다른 컴퓨터에서도 보기"를 켜면 접속할 수 있습니다)'));
  if (p === '/login' && req.method === 'GET') return Promise.resolve(send(res, 200, LOGIN_PAGE, 'text/html; charset=utf-8'));
  if (p === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (hasSession(req)) return handleAdmin(req, res, url, false);
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    res.end();
    return Promise.resolve();
  }
  return Promise.resolve(send(res, 401, 'login required'));
}

async function handleReport(req, res, q) {
  if (req.headers['x-class-code'] !== cfg.classCode) return send(res, 403, 'ok=0\nerror=bad_code\n');
  const id = sanitizeId(q.get('id'));
  if (!id) return send(res, 400, 'ok=0\nerror=no_id\n');
  let body;
  try { body = await readBody(req); } catch { return send(res, 413, 'ok=0\n'); }

  const c = getClient(id);
  c.pcName = (q.get('name') || id).slice(0, 60);
  if (cfg.known[id] !== c.pcName) { cfg.known[id] = c.pcName; saveConfig(); }
  c.lastSeen = Date.now();
  c.title = (q.get('title') || '').slice(0, 300);
  c.proc = (q.get('proc') || '').slice(0, 80);
  c.idleSec = clampInt(q.get('idle'), 0, 864000, 0);
  c.lockedReported = q.get('locked') === '1';
  c.addr = req.socket.remoteAddress || '';
  c.self = isSelfAddr(c.addr);
  // 전원 명령: 학생 프로그램이 받았다고 알려 오거나(pw) 2분이 지나면 지웁니다. 꺼졌다 다시 켜진 PC가 또 꺼지지 않도록.
  if (c.power) {
    const done = (Number(q.get('pw')) || 0) >= c.power.seq;
    if (done && c.power.action === 'off') c.offUntil = Date.now() + c.power.delay * 1000 + 30000;
    if (done || Date.now() > c.power.expires) c.power = null;
  }
  const ack = Number(q.get('ack')) || 0;
  c.messages = c.messages.filter((m) => m.id > ack);

  const gotFrame = body.length > 3 && body[0] === 0xff && body[1] === 0xd8;
  if (gotFrame) { c.frame = body; c.frameSeq++; }
  const was = c.distracted;
  c.keyword = matchKeyword(c.title, c.proc);
  c.distracted = !!c.keyword;
  record(c, gotFrame, !was && c.distracted);

  const lines = [
    'ok=1',
    'interval=' + cfg.captureIntervalSec,
    'maxw=1280',
    'quality=60',
    'locked=' + (c.lockWanted ? 1 : 0),
    'locktext=' + encodeURIComponent(c.lockText || ''),
  ];
  for (const m of c.messages) lines.push(`msg=${m.id}|${encodeURIComponent(m.text)}`);
  if (c.power) lines.push(`power=${c.power.seq}|${c.power.action}|${c.power.delay}`);
  if (c.remove) lines.push(`remove=${c.remove.seq}`);
  send(res, 200, lines.join('\n') + '\n');
}

function stateJson() {
  const list = [...clients.values()].map((c) => {
    const online = isOnline(c);
    return {
      id: c.id,
      name: cfg.names[c.id] || c.pcName,
      pcName: c.pcName,
      online,
      lastSeen: c.lastSeen,
      title: c.title,
      proc: c.proc,
      idleSec: c.idleSec,
      away: online && c.idleSec >= cfg.idleMinutes * 60,
      distracted: online && c.distracted,
      keyword: c.keyword,
      lockWanted: c.lockWanted,
      locked: c.lockedReported,
      frameSeq: c.frameSeq,
      self: c.self,
      powerPending: !!c.power && c.power.action === 'off',
      removing: !!c.remove,
      removeFailed: !!c.removeFailed && Date.now() - c.removeFailed < 60000,
      shuttingDown: online && c.offUntil > Date.now(),
    };
  });
  // 대시보드에서 정한 순서가 먼저, 순서가 없는 PC는 이름순으로 뒤에
  const pos = (id) => { const i = cfg.layout.order.indexOf(id); return i < 0 ? Infinity : i; };
  list.sort((a, b) => (pos(a.id) - pos(b.id)) || a.name.localeCompare(b.name, 'ko'));
  return {
    ips: lanIPs(),
    port: PORT,
    layout: { cols: cfg.layout.cols, fit: cfg.layout.fit },
    settings: {
      keywords: cfg.keywords,
      captureIntervalSec: cfg.captureIntervalSec,
      saveEverySec: cfg.saveEverySec,
      retentionDays: cfg.retentionDays,
      idleMinutes: cfg.idleMinutes,
    },
    clients: list,
  };
}

function targets(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((i) => clients.get(sanitizeId(i))).filter(Boolean);
}

async function handleAdmin(req, res, url, local) {
  const q = url.searchParams;
  const p = url.pathname;

  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (p === '/api/state') {
      // 학생 설치 명령에는 연결 키가 들어 있으므로 서버를 켠 컴퓨터에서만 보여 줍니다.
      const studentInstall = local
        ? `[Net.ServicePointManager]::SecurityProtocol=3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/${REPO}/main/install-student.ps1))) -Code ${cfg.classCode}`
        : undefined;
      return sendJson(res, { ...stateJson(), local, remoteEnabled: remoteEnabled(), studentInstall });
    }
    if (p === '/api/frame') {
      const c = clients.get(sanitizeId(q.get('id')));
      if (!c || !c.frame) return send(res, 404, 'no frame');
      return send(res, 200, c.frame, 'image/jpeg');
    }
    if (p === '/api/history/dates') {
      const id = sanitizeId(q.get('id'));
      let dates = [];
      try {
        dates = fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(DATA, d, id)));
      } catch { /* 기록 없음 */ }
      return sendJson(res, { dates: dates.sort().reverse() });
    }
    if (p === '/api/history') {
      const id = sanitizeId(q.get('id'));
      const date = q.get('date') || '';
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, 'bad request');
      const dir = dayDir(id, date);
      let log = [];
      let shots = [];
      try {
        log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* 없음 */ }
      try { shots = fs.readdirSync(dir).filter((f) => /^\d{6}(_d)?\.jpg$/.test(f)).sort(); } catch { /* 없음 */ }
      return sendJson(res, { log, shots });
    }
    if (p === '/api/shot') {
      const id = sanitizeId(q.get('id'));
      const date = q.get('date') || '';
      const name = q.get('name') || '';
      if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{6}(_d)?\.jpg$/.test(name)) return send(res, 400, 'bad request');
      try { return send(res, 200, fs.readFileSync(path.join(dayDir(id, date), name)), 'image/jpeg'); } catch { return send(res, 404, 'not found'); }
    }
    return send(res, 404, 'not found');
  }

  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, 'json only');
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return send(res, 400, 'bad json'); }

    if (p === '/api/message') {
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return send(res, 400, 'empty');
      const ts = targets(body.ids);
      for (const c of ts) {
        c.messages.push({ id: ++msgSeq, text });
        if (c.messages.length > 20) c.messages.shift();
        appendLog(c.id, { type: 'message', text });
      }
      return sendJson(res, { ok: true, count: ts.length });
    }
    if (p === '/api/lock') {
      const locked = !!body.locked;
      const text = String(body.text || '').trim().slice(0, 200);
      const ts = targets(body.ids);
      for (const c of ts) {
        if (c.lockWanted !== locked) appendLog(c.id, { type: locked ? 'lock' : 'unlock' });
        c.lockWanted = locked;
        c.lockText = locked ? text : '';
      }
      return sendJson(res, { ok: true, count: ts.length });
    }
    if (p === '/api/layout') {
      if (body.cols !== undefined) cfg.layout.cols = clampInt(body.cols, 1, 4, cfg.layout.cols);
      if (body.fit !== undefined) cfg.layout.fit = !!body.fit;
      if (Array.isArray(body.order)) cfg.layout.order = body.order.map(sanitizeId).filter(Boolean).slice(0, 200);
      saveConfig();
      return sendJson(res, { ok: true });
    }
    if (p === '/api/power') {
      const action = body.action === 'cancel' ? 'cancel' : 'off';
      const delay = action === 'off' ? (Number(body.delay) === 0 ? 0 : 60) : 0;
      let count = 0;
      let skipped = 0;
      for (const c of targets(body.ids)) {
        if (action === 'off' && c.self) { skipped++; continue; } // 선생님 컴퓨터 자신은 끄지 않음
        c.power = { seq: ++msgSeq, action, delay, expires: Date.now() + 120000 };
        if (action === 'cancel') c.offUntil = 0;
        appendLog(c.id, { type: action === 'off' ? 'poweroff' : 'poweroff-cancel' });
        count++;
      }
      return sendJson(res, { ok: true, count, skipped });
    }
    if (p === '/api/rename') {
      const id = sanitizeId(body.id);
      const name = String(body.name || '').trim().slice(0, 30);
      if (!clients.has(id)) return send(res, 404, 'unknown');
      if (name) cfg.names[id] = name; else delete cfg.names[id];
      saveConfig();
      return sendJson(res, { ok: true });
    }
    if (p === '/api/forget') {
      // 켜져 있는 PC는 학생 프로그램에 "스스로 제거" 명령을 보내고, 꺼져 있는 PC는 목록에서만 지웁니다.
      const id = sanitizeId(body.id);
      const c = clients.get(id);
      if (!c) return sendJson(res, { ok: true, mode: 'gone' });
      if (isOnline(c)) {
        c.remove = { seq: ++msgSeq, at: Date.now(), expires: Date.now() + 120000 };
        c.removeFailed = 0;
        appendLog(id, { type: 'remove' });
        return sendJson(res, { ok: true, mode: 'remote' });
      }
      forgetClient(id);
      return sendJson(res, { ok: true, mode: 'list' });
    }
    if (p === '/api/remote-access') {
      // 원격 보기 켜기/끄기와 비밀번호 변경은 서버를 켠 컴퓨터에서만 할 수 있습니다.
      if (!local) return send(res, 403, 'local only');
      const pw = String(body.password || '');
      sessions.clear();
      if (!pw) {
        delete cfg.remote;
        saveConfig();
        return sendJson(res, { ok: true, enabled: false });
      }
      if (pw.length < 8 || pw.length > 200) return sendJson(res, { ok: false, error: '비밀번호는 8자 이상이어야 합니다.' }, 400);
      const salt = crypto.randomBytes(16).toString('hex');
      cfg.remote = { salt, hash: hashPassword(pw, salt).toString('hex') };
      saveConfig();
      return sendJson(res, { ok: true, enabled: true });
    }
    if (p === '/api/settings') {
      if (Array.isArray(body.keywords)) {
        cfg.keywords = [...new Set(body.keywords.map((k) => String(k).trim().slice(0, 50)).filter(Boolean))].slice(0, 300);
      }
      cfg.captureIntervalSec = clampInt(body.captureIntervalSec, 1, 60, cfg.captureIntervalSec);
      cfg.saveEverySec = clampInt(body.saveEverySec, 0, 3600, cfg.saveEverySec);
      cfg.retentionDays = clampInt(body.retentionDays, 0, 365, cfg.retentionDays);
      cfg.idleMinutes = clampInt(body.idleMinutes, 1, 120, cfg.idleMinutes);
      saveConfig();
      for (const c of clients.values()) {
        c.keyword = matchKeyword(c.title, c.proc);
        c.distracted = !!c.keyword;
      }
      cleanupOldRecords();
      return sendJson(res, { ok: true });
    }
    return send(res, 404, 'not found');
  }
  send(res, 405, 'method not allowed');
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'bad url'); }
  route(req, res, url).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'error');
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 이미 켜져 있으면 대시보드만 열어 줍니다 (바로가기를 두 번 눌렀을 때).
    console.error(`학습 모니터가 이미 실행 중입니다. 대시보드를 엽니다.`);
    if (process.env.SM_OPEN === '1') { openBrowser(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 1500); return; }
  }
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('학습 모니터 서버가 시작되었습니다.');
  console.log(`  대시보드 (이 컴퓨터에서만 열림): http://localhost:${PORT}`);
  console.log(`  이 컴퓨터의 IP: ${lanIPs().join(', ') || '(네트워크 연결 없음)'}`);
  console.log('  종료하려면 Ctrl+C 를 누르세요.');
  // start.bat / start.command 로 켰을 때만, 서버가 준비된 뒤 대시보드를 엽니다.
  if (process.env.SM_OPEN === '1') openBrowser(`http://localhost:${PORT}`);
});

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* 브라우저를 못 열어도 서버는 계속 동작 */ }
}

// ---------- 자동 검색 (UDP) ----------
// 학생 PC가 같은 와이파이에 "SM_DISCOVER <nonce>" 를 방송하면, 연결 키를 아는 서버임을 증명하는 값과 함께 응답합니다.
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  const m = /^SM_DISCOVER ([A-Za-z0-9]{8,64})$/.exec(msg.toString('utf8').trim());
  if (!m) return;
  const reply = Buffer.from(`SM_HERE ${PORT} ${sha256hex(m[1] + ':' + cfg.classCode)}`);
  udp.send(reply, rinfo.port, rinfo.address, () => {});
});
udp.on('error', (e) => console.error('자동 검색(UDP) 오류:', e.message));
udp.bind(DISCOVERY_PORT);
