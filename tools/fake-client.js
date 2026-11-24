'use strict';
// 테스트용 가짜 학생 PC. Windows PC 없이 대시보드를 확인할 때 씁니다.
//   node tools/fake-client.js        (가짜 학생 4명)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'supervisor', 'config.json'), 'utf8'));

function makeJpeg(r, g, b, tag) {
  const W = 640, H = 360, row = W * 3;
  const buf = Buffer.alloc(54 + row * H);
  buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(W, 18); buf.writeInt32LE(H, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * H, 34);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 54 + y * row + x * 3;
    const bar = y > H - 40 || (x > 40 && x < 600 && y > 60 && y < 280 && (y % 24) < 10);
    buf[o] = bar ? 235 : b; buf[o + 1] = bar ? 235 : g; buf[o + 2] = bar ? 235 : r;
  }
  const bmp = path.join(os.tmpdir(), `sm-fake-${tag}.bmp`);
  const jpg = path.join(os.tmpdir(), `sm-fake-${tag}.jpg`);
  fs.writeFileSync(bmp, buf);
  execFileSync('sips', ['-s', 'format', 'jpeg', bmp, '--out', jpg], { stdio: 'ignore' });
  return fs.readFileSync(jpg);
}

const students = [
  { id: 'PC-01', title: '수학 3단원 문제풀이 - Chrome', proc: 'chrome', idle: 4, img: makeJpeg(40, 90, 160, 1) },
  { id: 'PC-02', title: '롤 하이라이트 모음 - YouTube - Chrome', proc: 'chrome', idle: 1, img: makeJpeg(150, 40, 40, 2) },
  { id: 'PC-03', title: '영어 단어장.hwp - 한글', proc: 'Hwp', idle: 12, img: makeJpeg(40, 120, 80, 3) },
  { id: 'PC-04', title: 'EBS 인강 - Microsoft Edge', proc: 'msedge', idle: 420, img: makeJpeg(90, 70, 130, 4) },
];

function report(s) {
  const q = new URLSearchParams({ id: s.id, name: s.id, title: s.title, proc: s.proc, idle: s.idle, locked: s.locked ? 1 : 0, ack: s.ack || 0, pw: s.pw || 0 });
  const req = http.request({ host: '127.0.0.1', port: 47800, path: '/api/client/report?' + q, method: 'POST',
    headers: { 'X-Class-Code': cfg.classCode, 'Content-Type': 'image/jpeg', 'Content-Length': s.img.length } }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      s.locked = /^locked=1$/m.test(body);
      const pm = /^power=(\d+)\|(\w+)\|(\d+)$/m.exec(body);
      if (pm && Number(pm[1]) > (s.pw || 0)) { s.pw = Number(pm[1]); console.log(`[${s.id}] 전원 명령: ${pm[2]} (${pm[3]}초)`); }
      for (const m of body.matchAll(/^msg=(\d+)\|(.*)$/gm)) {
        if (Number(m[1]) > (s.ack || 0)) { s.ack = Number(m[1]); console.log(`[${s.id}] 메시지 수신: ${decodeURIComponent(m[2])}`); }
      }
    });
  });
  req.on('error', (e) => console.error(`[${s.id}] ${e.message}`));
  req.end(s.img);
}

console.log('가짜 학생 4명이 접속합니다. 종료: Ctrl+C');
setInterval(() => students.forEach(report), 2000);
students.forEach(report);
