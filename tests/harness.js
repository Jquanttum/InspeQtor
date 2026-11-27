'use strict';
// Minimal test harness (no dependencies).
const fs = require('fs');
const path = require('path');
let passed = 0, failed = 0, suite = '';
const failures = [];
exports.suite = function (name) { suite = name; console.log('\n# ' + name); };
exports.test = function (name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; failures.push(suite + ' > ' + name + ': ' + (e && e.message)); console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
};
exports.ok = function (cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); };
exports.eq = function (a, b, msg) { if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
exports.near = function (a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ' ± ' + tol + ' got ' + a); };
exports.done = function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(failures.map(f => ' - ' + f).join('\n')); }
  return failed;
};
exports.counts = () => ({ passed, failed });
exports.FIX = path.join(__dirname, 'fixtures');
exports.manifest = () => JSON.parse(fs.readFileSync(path.join(exports.FIX, 'manifest.json'), 'utf8'));
exports.load = function (name) {
  const b = fs.readFileSync(path.join(exports.FIX, name + '.jpg'));
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
};
