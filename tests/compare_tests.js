'use strict';
// Thumbnail-vs-main comparison tests. Pixels come from Pillow (independent decoder) as PGM files;
// ground truth (crop rectangles, retouch patches, expected verdicts) comes from the fixture factory.
const fs = require('fs');
const path = require('path');
const T = require('./harness.js');
const QPI = require('../tools/load.js');
const { test, ok, eq } = T;
const C = QPI.compare;

function pgm(p) {
  const b = fs.readFileSync(p); let i = 0; const tok = [];
  while (tok.length < 4) { while (b[i] <= 32) i++; let s = ''; while (b[i] > 32) s += String.fromCharCode(b[i++]); tok.push(s); }
  i++; const w = +tok[1], h = +tok[2];
  return C.makeGray(w, h, Float32Array.from(b.subarray(i, i + w * h)));
}

const man = T.manifest();
const names = Object.keys(man).filter(k => man[k].kind === 'thumb' && fs.existsSync(path.join(T.FIX, k + '.main.pgm')));
const results = {};
let correct = 0;

T.suite('thumbnail comparison vs ground truth (' + names.length + ' fixtures)');
names.forEach(name => {
  const m = man[name], ex = m.expect;
  test(name + ' -> ' + ex.verdict, () => {
    const main = pgm(path.join(T.FIX, name + '.main.pgm')), thumb = pgm(path.join(T.FIX, name + '.thumb.pgm'));
    const t0 = Date.now();
    const r = C.compareThumbToMain(thumb, main, { expectedOrientation: ex.orientation || 1 });
    const ms = Date.now() - t0;
    results[name] = { expected: ex.verdict, got: r.verdict, scores: r.scores, ms, rect: r.rect, margins: r.margins, diffFraction: r.diff ? r.diff.fraction : null, regions: r.diff ? r.diff.regions.length : null, notes: r.notes };
    eq(r.verdict, ex.verdict, 'verdict (scores ' + JSON.stringify(r.scores) + ')');
    if (ex.rect) {
      const [x, y, w, h] = ex.rect, g = r.rect;
      ['x', 'y', 'w', 'h'].forEach((k, i) => { if (Math.abs(g[k] - [x, y, w, h][i]) > 0.035) throw new Error('rect.' + k + ' expected ' + [x, y, w, h][i].toFixed(3) + ' got ' + g[k].toFixed(3)); });
    }
    if (ex.diff) {
      ok(r.diff && r.diff.regions.length >= 1, 'retouched patch should produce a differing region');
      const p = ex.patch, reg = r.diff.regions.reduce((a, b) => (b.fraction > a.fraction ? b : a));
      const cx = reg.x + reg.w / 2, cy = reg.y + reg.h / 2;
      ok(cx > p[0] - 0.05 && cx < p[0] + p[2] + 0.05 && cy > p[1] - 0.05 && cy < p[1] + p[3] + 0.05, 'region centre (' + cx.toFixed(2) + ',' + cy.toFixed(2) + ') should lie on patch ' + p.map(v => v.toFixed(2)));
    } else if (ex.verdict === 'consistent' && !ex.limit) {
      ok(!r.diff || r.diff.regions.length === 0 || r.diff.fraction < 0.015, 'unexpected differing regions on an untouched/regenerated file: ' + (r.diff && r.diff.fraction.toFixed(3)));
    }
    if (ex.note === 'distorted-aspect') ok(r.notes.indexOf('distorted-aspect') >= 0, 'squashed thumbnail should be noted');
    if (ex.orientation) ok(r.orientation.transform === ex.orientation, 'orientation ' + r.orientation.transform);
    correct++;
  });
});

T.suite('degenerate inputs');
test('tiny thumbnail and flat image are inconclusive, not wrong', () => {
  const flat = C.makeGray(200, 200, new Float32Array(200 * 200).fill(120));
  const tiny = C.makeGray(8, 8, new Float32Array(64));
  eq(C.compareThumbToMain(tiny, flat, {}).verdict, 'inconclusive');
  const noisy = C.makeGray(200, 200, Float32Array.from({ length: 40000 }, (_, i) => (i * 7919) % 255));
  eq(C.compareThumbToMain(C.makeGray(160, 120, new Float32Array(160 * 120).fill(100)), noisy, {}).verdict, 'inconclusive');
});
test('orientation transforms are consistent with EXIF semantics', () => {
  const g = C.makeGray(3, 2, Float32Array.from([1, 2, 3, 4, 5, 6]));
  eq(Array.from(C.orient(g, 6).data).join(), '4,1,5,2,6,3'); // 90 deg clockwise
  eq(Array.from(C.orient(g, 8).data).join(), '3,6,2,5,1,4'); // 90 deg counter-clockwise
  eq(Array.from(C.orient(g, 3).data).join(), '6,5,4,3,2,1');
  eq(Array.from(C.orient(g, 2).data).join(), '3,2,1,6,5,4');
  const d = C.orient(g, 5); eq(d.w + 'x' + d.h, '2x3');
});

fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'compare.json'), JSON.stringify(results, null, 1));
const vals = Object.values(results);
console.log('\nmedian time per comparison: ' + vals.map(v => v.ms).sort((a, b) => a - b)[Math.floor(vals.length / 2)] + ' ms, max ' + Math.max.apply(null, vals.map(v => v.ms)) + ' ms');
process.exitCode = T.done() ? 1 : 0;
