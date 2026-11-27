#!/usr/bin/env node
'use strict';
// Usage: node tools/dump-all.js <file-or-dir>... > out.json
// Dumps the analysis of many JPEGs as one JSON map (used by tests/crosscheck.py).
const fs = require('fs');
const path = require('path');
const QPI = require('./load.js');
const files = [];
process.argv.slice(2).forEach(a => {
  if (fs.statSync(a).isDirectory()) fs.readdirSync(a).filter(f => /\.jpe?g$/i.test(f)).sort().forEach(f => files.push(path.join(a, f)));
  else files.push(a);
});
const out = {};
files.forEach(f => {
  const buf = fs.readFileSync(f), u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    const rep = QPI.analyze.inspect(u8, { fileName: path.basename(f), now: Date.UTC(2026, 10, 26) });
    out[f] = { ok: true, json: QPI.analyze.toJSON(rep) };
  } catch (e) { out[f] = { ok: false, error: String(e && e.stack || e) }; }
});
process.stdout.write(JSON.stringify(out));
