'use strict';
// Fuzz: mutate/truncate every fixture; the analyzer must never throw or hang.
const fs = require('fs'), path = require('path');
const QPI = require('../tools/load.js');
const dir = path.join(__dirname, 'fixtures');
const files = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f));
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
let runs = 0, fails = 0, slow = 0;
function run(name, u8) {
  runs++; const t = Date.now();
  try { const r = QPI.analyze.inspect(u8, { fileName: name }); QPI.analyze.toJSON(r); if (QPI.report) QPI.report.build({ report: r, json: null }, {}, {}); }
  catch (e) { if (!/build|report/i.test(String(e && e.stack).split('\n')[1] || '')) { fails++; console.log('THROW', name, String(e && e.stack).split('\n').slice(0, 3).join(' | ')); } }
  if (Date.now() - t > 3000) { slow++; console.log('SLOW', name, Date.now() - t); }
}
files.forEach(f => {
  const buf = fs.readFileSync(path.join(dir, f));
  const lim = Math.min(buf.length, 6000);
  for (let k = 0; k < 12; k++) {                       // truncations
    const cut = k < 6 ? Math.floor(rnd() * lim) : Math.floor(rnd() * buf.length);
    run(f + '@cut' + cut, new Uint8Array(buf.subarray(0, cut)));
  }
  for (let k = 0; k < 25; k++) {                       // byte flips concentrated in the header region
    const c = new Uint8Array(buf); const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) c[Math.floor(rnd() * Math.min(lim, c.length))] = Math.floor(rnd() * 256);
    run(f + '@flip' + k, c);
  }
  for (let k = 0; k < 4; k++) {                        // 0xFF / 0x00 / huge-length injections
    const c = new Uint8Array(buf); const o = Math.floor(rnd() * Math.min(lim, c.length - 4));
    c[o] = 0xFF; c[o + 1] = 0xFF; c[o + 2] = 0xFF; c[o + 3] = 0xFF; run(f + '@ff' + k, c);
  }
});
for (const n of [0, 1, 2, 3, 10]) run('tiny' + n, new Uint8Array(n));
run('ffd8only', Uint8Array.from([0xFF, 0xD8]));
console.log(`fuzz: ${runs} runs, ${fails} throws, ${slow} slow`);
process.exit(fails || slow ? 1 : 0);
