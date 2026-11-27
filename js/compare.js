/*
 * Quanttum Photo Inspector — thumbnail vs main-image comparison (vanilla JS)
 *
 * Pure maths on greyscale grids; no DOM, no decoding (decode.js feeds it).
 *
 * Question answered: does the embedded thumbnail show the same frame as the
 * main image, MORE than the main image (the main image was cropped but the old
 * thumbnail survived), LESS than the main image, or something else entirely?
 *
 * Method (all brightness/contrast invariant — Pearson correlation on luma):
 *   A. full-frame:     whole thumbnail  vs whole main image (anisotropic resize)
 *   B. main-in-thumb:  search the thumbnail for an aspect-locked rectangle that
 *                      matches the (downscaled) main image  -> main was cropped
 *   C. thumb-in-main:  search the main image for a rectangle that matches the
 *                      thumbnail                              -> thumbnail is partial
 * over the EXIF orientation candidates, with and without black letterbox bars.
 * If the frames align, a residual map highlights regions that differ.
 *
 * Limits are deliberate and documented in the README: axis-aligned crops with
 * preserved aspect ratio only; no arbitrary-angle rotation or perspective;
 * thumbnails are tiny (typically 160x120) so only large changes are visible.
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  var CFG = {
    T_FULL: 0.90,       // full-frame correlation that counts as "same picture"
    T_SUB: 0.88,        // rectangle-search correlation that counts as a match
    SUB_GAIN: 0.03,     // a sub-rectangle must beat the full frame by this much
    MIN_MARGIN: 0.04,   // smallest removed margin (fraction of frame) we dare call a crop
    T_WEAK: 0.75,       // loose resemblance (null maxima observed: 0.68 plain sub-rectangle, 0.50 robust full-frame)
    TRIM: 0.20,         // fraction of cells ignored by the robust whole-frame score (tolerates ~20% locally edited area)
    MIN_THUMB: 16,      // thumbnails smaller than this are not compared
    FLAT_STD: 3.0,      // images flatter than this (luma std) are inconclusive
    WORK_MAX: 256       // main image working resolution (long side)
  };

  function makeGray(w, h, data) { return { w: w, h: h, data: data || new Float32Array(w * h) }; }

  function rgbaToGray(rgba, w, h) {
    var out = new Float32Array(w * h);
    for (var i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return makeGray(w, h, out);
  }

  // ---------- resampling ----------
  function axisPlan(srcLen, dstLen) {
    var starts = new Int32Array(dstLen), counts = new Int32Array(dstLen), weights = [], scale = srcLen / dstLen, i, j;
    for (i = 0; i < dstLen; i++) {
      starts[i] = weights.length;
      if (scale >= 1) {
        var s0 = i * scale, s1 = (i + 1) * scale, j0 = Math.floor(s0), j1 = Math.min(srcLen, Math.ceil(s1 - 1e-9)), tot = 0, n = 0;
        for (j = j0; j < j1; j++) { var wgt = Math.min(j + 1, s1) - Math.max(j, s0); if (wgt > 0) { weights.push(j, wgt); tot += wgt; n++; } }
        for (j = 0; j < n; j++) weights[starts[i] + j * 2 + 1] /= tot;
        counts[i] = n;
      } else {
        var c = (i + 0.5) * scale - 0.5, a = Math.floor(c), f = c - a;
        var a0 = Math.max(0, Math.min(srcLen - 1, a)), a1 = Math.max(0, Math.min(srcLen - 1, a + 1));
        weights.push(a0, 1 - f, a1, f); counts[i] = 2;
      }
    }
    return { starts: starts, counts: counts, w: weights };
  }

  function resize(gr, nw, nh) {
    nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
    if (nw === gr.w && nh === gr.h) return gr;
    var px = axisPlan(gr.w, nw), py = axisPlan(gr.h, nh), tmp = new Float32Array(nw * gr.h), x, y, k;
    for (y = 0; y < gr.h; y++) {
      var row = y * gr.w;
      for (x = 0; x < nw; x++) {
        var s = 0, st = px.starts[x], cn = px.counts[x];
        for (k = 0; k < cn; k++) s += gr.data[row + px.w[st + k * 2]] * px.w[st + k * 2 + 1];
        tmp[y * nw + x] = s;
      }
    }
    var out = new Float32Array(nw * nh);
    for (y = 0; y < nh; y++) {
      var sy = py.starts[y], cy = py.counts[y];
      for (x = 0; x < nw; x++) {
        var v = 0;
        for (k = 0; k < cy; k++) v += tmp[py.w[sy + k * 2] * nw + x] * py.w[sy + k * 2 + 1];
        out[y * nw + x] = v;
      }
    }
    return makeGray(nw, nh, out);
  }

  function downscaleMax(gr, maxSide) {
    var m = Math.max(gr.w, gr.h);
    if (m <= maxSide) return gr;
    var s = maxSide / m;
    return resize(gr, Math.max(1, Math.round(gr.w * s)), Math.max(1, Math.round(gr.h * s)));
  }

  // ---------- orientation (EXIF semantics: stored raster -> displayed raster) ----------
  function orientDims(w, h, o) { return (o >= 5 && o <= 8) ? { w: h, h: w } : { w: w, h: h }; }

  function orient(gr, o) {
    if (!o || o === 1) return gr;
    var w = gr.w, h = gr.h, d = orientDims(w, h, o), out = new Float32Array(d.w * d.h), x, y, sx, sy;
    for (y = 0; y < d.h; y++) {
      for (x = 0; x < d.w; x++) {
        switch (o) {
          case 2: sx = w - 1 - x; sy = y; break;
          case 3: sx = w - 1 - x; sy = h - 1 - y; break;
          case 4: sx = x; sy = h - 1 - y; break;
          case 5: sx = y; sy = x; break;
          case 6: sx = y; sy = h - 1 - x; break;
          case 7: sx = w - 1 - y; sy = h - 1 - x; break;
          default: sx = w - 1 - y; sy = x; break; // 8
        }
        out[y * d.w + x] = gr.data[sy * w + sx];
      }
    }
    return makeGray(d.w, d.h, out);
  }

  /** Same transform for 4-channel pixel data (used by the UI to draw the oriented thumbnail). */
  function orientRGBA(rgba, w, h, o) {
    if (!o || o === 1) return { data: rgba, w: w, h: h };
    var d = orientDims(w, h, o), out = new Uint8ClampedArray(d.w * d.h * 4), x, y, sx, sy, k;
    for (y = 0; y < d.h; y++) {
      for (x = 0; x < d.w; x++) {
        switch (o) {
          case 2: sx = w - 1 - x; sy = y; break;
          case 3: sx = w - 1 - x; sy = h - 1 - y; break;
          case 4: sx = x; sy = h - 1 - y; break;
          case 5: sx = y; sy = x; break;
          case 6: sx = y; sy = h - 1 - x; break;
          case 7: sx = w - 1 - y; sy = h - 1 - x; break;
          default: sx = w - 1 - y; sy = x; break;
        }
        var si = (sy * w + sx) * 4, di = (y * d.w + x) * 4;
        for (k = 0; k < 4; k++) out[di + k] = rgba[si + k];
      }
    }
    return { data: out, w: d.w, h: d.h };
  }

  var ORIENT_TEXT = { 1: 'as stored', 2: 'mirrored horizontally', 3: 'rotated 180°', 4: 'mirrored vertically', 5: 'transposed', 6: 'rotated 90° clockwise', 7: 'transverse (mirrored, 90°)', 8: 'rotated 90° counter-clockwise' };

  // ---------- letterbox bars ----------
  function stripBars(gr) {
    var w = gr.w, h = gr.h, d = gr.data;
    function rowStat(y) { var s = 0, s2 = 0; for (var x = 0; x < w; x++) { var v = d[y * w + x]; s += v; s2 += v * v; } var m = s / w; return { m: m, sd: Math.sqrt(Math.max(0, s2 / w - m * m)) }; }
    function colStat(x) { var s = 0, s2 = 0; for (var y = 0; y < h; y++) { var v = d[y * w + x]; s += v; s2 += v * v; } var m = s / h; return { m: m, sd: Math.sqrt(Math.max(0, s2 / h - m * m)) }; }
    function isBar(st) { return st.m <= 10 && st.sd <= 3; }
    var top = 0, bottom = 0, left = 0, right = 0;
    while (top < h * 0.4 && isBar(rowStat(top))) top++;
    while (bottom < h * 0.4 && isBar(rowStat(h - 1 - bottom))) bottom++;
    while (left < w * 0.4 && isBar(colStat(left))) left++;
    while (right < w * 0.4 && isBar(colStat(w - 1 - right))) right++;
    var aw = w - left - right, ah = h - top - bottom;
    if ((top + bottom + left + right) < 2 || aw < 16 || ah < 16) return { trimmed: false };
    var out = new Float32Array(aw * ah);
    for (var y = 0; y < ah; y++) for (var x = 0; x < aw; x++) out[y * aw + x] = d[(y + top) * w + (x + left)];
    return { trimmed: true, gray: makeGray(aw, ah, out), top: top, bottom: bottom, left: left, right: right };
  }

  // ---------- summed-area table sampling ----------
  function makeSAT(gr) {
    var w = gr.w, h = gr.h, s = w + 1, F = new Float64Array(s * (h + 1));
    for (var y = 0; y < h; y++) {
      var run = 0;
      for (var x = 0; x < w; x++) { run += gr.data[y * w + x]; F[(y + 1) * s + x + 1] = F[y * s + x + 1] + run; }
    }
    return { F: F, w: w, h: h, s: s };
  }

  var _bx = new Int32Array(0), _fx = new Float64Array(0), _by = new Int32Array(0), _fy = new Float64Array(0), _B = new Float64Array(0);

  /** Area-average the rectangle (rx,ry,rw,rh) of the SAT's image onto a gw x gh grid. */
  function sampleGrid(sat, rx, ry, rw, rh, gw, gh, out) {
    var W = sat.w, H = sat.h, s = sat.s, F = sat.F, k, l;
    if (_bx.length < gw + 1) { _bx = new Int32Array(gw + 1); _fx = new Float64Array(gw + 1); }
    if (_by.length < gh + 1) { _by = new Int32Array(gh + 1); _fy = new Float64Array(gh + 1); }
    if (_B.length < (gw + 1) * (gh + 1)) _B = new Float64Array((gw + 1) * (gh + 1));
    for (k = 0; k <= gw; k++) {
      var x = rx + rw * k / gw; x = x < 0 ? 0 : (x > W ? W : x);
      var ix = Math.floor(x); if (ix >= W) ix = W - 1;
      _bx[k] = ix; _fx[k] = x - ix;
    }
    for (l = 0; l <= gh; l++) {
      var y = ry + rh * l / gh; y = y < 0 ? 0 : (y > H ? H : y);
      var iy = Math.floor(y); if (iy >= H) iy = H - 1;
      _by[l] = iy; _fy[l] = y - iy;
    }
    var gw1 = gw + 1;
    for (l = 0; l <= gh; l++) {
      var r0 = _by[l] * s, fy = _fy[l];
      for (k = 0; k <= gw; k++) {
        var i0 = r0 + _bx[k], fx = _fx[k];
        _B[l * gw1 + k] = F[i0] * (1 - fx) * (1 - fy) + F[i0 + 1] * fx * (1 - fy) + F[i0 + s] * (1 - fx) * fy + F[i0 + s + 1] * fx * fy;
      }
    }
    var area = (rw / gw) * (rh / gh);
    if (area <= 0) area = 1e-9;
    for (l = 0; l < gh; l++) {
      for (k = 0; k < gw; k++) {
        out[l * gw + k] = (_B[(l + 1) * gw1 + k + 1] - _B[l * gw1 + k + 1] - _B[(l + 1) * gw1 + k] + _B[l * gw1 + k]) / area;
      }
    }
    return out;
  }

  function prepTemplate(gr) {
    var n = gr.data.length, m = 0, i;
    for (i = 0; i < n; i++) m += gr.data[i];
    m /= n;
    var t = new Float32Array(n), ss = 0;
    for (i = 0; i < n; i++) { t[i] = gr.data[i] - m; ss += t[i] * t[i]; }
    var sd = Math.sqrt(ss / n), norm = Math.sqrt(ss) || 1;
    for (i = 0; i < n; i++) t[i] /= norm;
    return { t: t, n: n, w: gr.w, h: gr.h, std: sd };
  }

  function nccWith(tpl, cand) {
    var n = tpl.n, m = 0, i;
    for (i = 0; i < n; i++) m += cand[i];
    m /= n;
    var dot = 0, ss = 0;
    for (i = 0; i < n; i++) { var d = cand[i] - m; dot += tpl.t[i] * d; ss += d * d; }
    if (ss / n < 4) return 0; // flat candidate region (std < 2): no information
    return dot / Math.sqrt(ss);
  }

  function gridDims(aspect, cells) {
    var gh = Math.max(6, Math.round(Math.sqrt(cells / aspect))), gw = Math.max(6, Math.round(gh * aspect));
    while (gw * gh > cells * 1.5 && gw > 6 && gh > 6) { gw--; gh = Math.max(6, Math.round(gw / aspect)); }
    return { w: Math.min(gw, 64), h: Math.min(gh, 64) };
  }

  /**
   * Find the aspect-locked rectangle of `container` that best matches `template`.
   * Returns { x, y, w, h, ncc } in container pixels.
   */
  function searchSub(containerSat, template, opts) {
    opts = opts || {};
    var W = containerSat.w, H = containerSat.h, ta = template.w / template.h;
    var gc = gridDims(ta, 150), gf = gridDims(ta, 600);
    var tc = prepTemplate(resize(template, gc.w, gc.h)), tf = prepTemplate(resize(template, gf.w, gf.h));
    if (tc.std < CFG.FLAT_STD) return null;
    var bufC = new Float32Array(gc.w * gc.h), bufF = new Float32Array(gf.w * gf.h);
    var fmax = Math.min(1, H * ta / W), fmin = Math.max(0.2, 24 / W);
    if (fmin > fmax) fmin = fmax;
    var top = [], K = 6, f, x, y;
    function score(rx, ry, rw, fine) {
      var rh = rw / ta;
      if (fine) { sampleGrid(containerSat, rx, ry, rw, rh, gf.w, gf.h, bufF); return nccWith(tf, bufF); }
      sampleGrid(containerSat, rx, ry, rw, rh, gc.w, gc.h, bufC); return nccWith(tc, bufC);
    }
    for (f = fmax; f >= fmin - 1e-9; f *= 0.965) {
      var rw = f * W, rh = rw / ta, step = Math.max(1, rw / 20), xs = [], ys = [];
      for (x = 0; x < W - rw - 1e-9; x += step) xs.push(x); xs.push(Math.max(0, W - rw));
      for (y = 0; y < H - rh - 1e-9; y += step) ys.push(y); ys.push(Math.max(0, H - rh));
      for (var yi = 0; yi < ys.length; yi++) {
        for (var xi = 0; xi < xs.length; xi++) {
          var sc = score(xs[xi], ys[yi], rw, false);
          if (top.length < K || sc > top[top.length - 1].s) {
            var near = false;
            for (var q = 0; q < top.length; q++) {
              if (Math.abs(top[q].x - xs[xi]) < rw * 0.08 && Math.abs(top[q].y - ys[yi]) < rh * 0.08 && Math.abs(top[q].w - rw) < rw * 0.1) { near = true; if (sc > top[q].s) { top[q] = { x: xs[xi], y: ys[yi], w: rw, s: sc }; } break; }
            }
            if (!near) { top.push({ x: xs[xi], y: ys[yi], w: rw, s: sc }); }
            top.sort(function (a, b) { return b.s - a.s; });
            if (top.length > K) top.length = K;
          }
        }
      }
    }
    var best = null;
    top.forEach(function (c0) {
      var cx = c0.x, cy = c0.y, cw = c0.w, cs = score(cx, cy, cw, true);
      var posSteps = [2, 1, 0.5, 0.25], scaleSteps = [0.04, 0.02, 0.01, 0.005];
      for (var si = 0; si < posSteps.length; si++) {
        var improved = true, guard = 0;
        while (improved && guard++ < 40) {
          improved = false;
          var moves = [[posSteps[si], 0, 0], [-posSteps[si], 0, 0], [0, posSteps[si], 0], [0, -posSteps[si], 0], [0, 0, 1 + scaleSteps[si]], [0, 0, 1 / (1 + scaleSteps[si])]];
          for (var mi = 0; mi < moves.length; mi++) {
            var nw = cw * (moves[mi][2] || 1), nx = cx + moves[mi][0] - (moves[mi][2] ? (nw - cw) / 2 : 0), ny = cy + moves[mi][1] - (moves[mi][2] ? (nw / ta - cw / ta) / 2 : 0);
            var nh = nw / ta;
            if (nw > W + 1e-6 || nh > H + 1e-6 || nw < Math.max(16, fmin * W * 0.9)) continue;
            nx = Math.max(0, Math.min(W - nw, nx)); ny = Math.max(0, Math.min(H - nh, ny));
            var ns = score(nx, ny, nw, true);
            if (ns > cs + 1e-6) { cs = ns; cx = nx; cy = ny; cw = nw; improved = true; }
          }
        }
      }
      if (!best || cs > best.ncc) best = { x: cx, y: cy, w: cw, h: cw / ta, ncc: cs };
    });
    if (best) {
      sampleGrid(containerSat, best.x, best.y, best.w, best.h, gf.w, gf.h, bufF);
      best.cand = Float32Array.from(bufF); best.tpl = Float32Array.from(resize(template, gf.w, gf.h).data);
    }
    return best;
  }

  /**
   * Pearson correlation after discarding the `trim` fraction of cells that fit a straight line worst.
   * Tolerates a locally edited region (retouching, an added or removed object) that plain correlation does not.
   */
  function robustPearson(tpl, cand, trim) {
    var n = tpl.length, use = new Uint8Array(n).fill(1), a = 1, b = 0, pass, i;
    for (pass = 0; pass < 3; pass++) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
      for (i = 0; i < n; i++) if (use[i]) { sx += tpl[i]; sy += cand[i]; sxx += tpl[i] * tpl[i]; sxy += tpl[i] * cand[i]; cnt++; }
      var den = cnt * sxx - sx * sx;
      if (cnt < 10 || Math.abs(den) < 1e-9) return 0;
      a = (cnt * sxy - sx * sy) / den; b = (sy - a * sx) / cnt;
      var res = new Array(n);
      for (i = 0; i < n; i++) res[i] = Math.abs(cand[i] - (a * tpl[i] + b));
      var sorted = res.slice().sort(function (p, q) { return p - q; });
      var cut = sorted[Math.min(n - 1, Math.floor(n * (1 - trim)))];
      for (i = 0; i < n; i++) use[i] = res[i] <= cut ? 1 : 0;
    }
    var m1 = 0, m2 = 0, c = 0;
    for (i = 0; i < n; i++) if (use[i]) { m1 += tpl[i]; m2 += cand[i]; c++; }
    m1 /= c; m2 /= c;
    var dot = 0, s1 = 0, s2 = 0;
    for (i = 0; i < n; i++) if (use[i]) { var d1 = tpl[i] - m1, d2 = cand[i] - m2; dot += d1 * d2; s1 += d1 * d1; s2 += d2 * d2; }
    if (s1 / c < 4 || s2 / c < 4) return 0;
    return dot / Math.sqrt(s1 * s2);
  }

  function fullFrameNcc(a, b, cells) {
    var asp = b.w / b.h, d = gridDims(asp, cells || 800);
    var ra = prepTemplate(resize(a, d.w, d.h)), rb = resize(b, d.w, d.h);
    if (ra.std < CFG.FLAT_STD) return 0;
    return nccWith(ra, rb.data);
  }

  function evaluate(thumb, mainW) {
    var out = { full: fullFrameNcc(thumb, mainW), mIn: null, tIn: null };
    out.mIn = searchSub(makeSAT(thumb), mainW);
    out.tIn = searchSub(makeSAT(mainW), thumb);
    out.rob = robustScores(thumb, mainW, out, CFG.TRIM);
    out.best = Math.max(out.full, out.rob.full, out.mIn ? out.mIn.ncc : -1, out.tIn ? out.tIn.ncc : -1);
    return out;
  }

  /** Trimmed (outlier-tolerant) scores for the three hypotheses of one oriented thumbnail. */
  function robustScores(thumb, mainW, ev, trim) {
    var d = gridDims(mainW.w / mainW.h, 600), A = resize(thumb, d.w, d.h).data, B = resize(mainW, d.w, d.h).data;
    return {
      full: robustPearson(B, A, trim),
      mIn: ev.mIn ? robustPearson(ev.mIn.tpl, ev.mIn.cand, trim) : null,
      tIn: ev.tIn ? robustPearson(ev.tIn.tpl, ev.tIn.cand, trim) : null
    };
  }

  // ---------- local differences ----------
  /**
   * Align (thumb region) and main on a common grid, fit y = a*x + b robustly,
   * and flag clusters of cells whose residual is far above the noise level.
   */
  function localDiff(thumbSat, rect, mainW, longSide) {
    var asp = rect.w / rect.h, gw = asp >= 1 ? longSide : Math.max(8, Math.round(longSide * asp)), gh = asp >= 1 ? Math.max(8, Math.round(longSide / asp)) : longSide;
    var A = new Float32Array(gw * gh), M = resize(mainW, gw, gh).data, n = gw * gh, i;
    sampleGrid(thumbSat, rect.x, rect.y, rect.w, rect.h, gw, gh, A);
    // 3x3 box blur on both to suppress sub-pixel alignment noise
    function blur(src) {
      var o = new Float32Array(n);
      for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) {
        var s = 0, c = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var xx = x + dx, yy = y + dy; if (xx >= 0 && xx < gw && yy >= 0 && yy < gh) { s += src[yy * gw + xx]; c++; } }
        o[y * gw + x] = s / c;
      }
      return o;
    }
    var Ab = blur(A), Mb = blur(M), use = new Uint8Array(n).fill(1), a = 1, b = 0, pass;
    for (pass = 0; pass < 3; pass++) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
      for (i = 0; i < n; i++) if (use[i]) { sx += Mb[i]; sy += Ab[i]; sxx += Mb[i] * Mb[i]; sxy += Mb[i] * Ab[i]; cnt++; }
      var den = cnt * sxx - sx * sx;
      if (cnt < 10 || Math.abs(den) < 1e-6) break;
      a = (cnt * sxy - sx * sy) / den; b = (sy - a * sx) / cnt;
      var res = new Float32Array(n);
      for (i = 0; i < n; i++) res[i] = Math.abs(Ab[i] - (a * Mb[i] + b));
      var sorted = Array.prototype.slice.call(res).sort(function (p, q) { return p - q; });
      var cut = sorted[Math.floor(n * 0.85)];
      for (i = 0; i < n; i++) use[i] = res[i] <= cut ? 1 : 0;
    }
    var r = new Float32Array(n);
    for (i = 0; i < n; i++) r[i] = Ab[i] - (a * Mb[i] + b);
    var absr = Array.prototype.slice.call(r).map(Math.abs).sort(function (p, q) { return p - q; });
    var mad = absr[Math.floor(n / 2)], sigma = 1.4826 * mad;
    var thr = Math.max(3.5 * sigma, 16);
    var flag = new Uint8Array(n);
    for (i = 0; i < n; i++) flag[i] = Math.abs(r[i]) > thr ? 1 : 0;
    // 4-connected clusters
    var label = new Int32Array(n).fill(-1), clusters = [], stack = [];
    for (i = 0; i < n; i++) {
      if (!flag[i] || label[i] >= 0) continue;
      var id = clusters.length, cells = [];
      stack.push(i); label[i] = id;
      while (stack.length) {
        var c = stack.pop(); cells.push(c);
        var cx = c % gw, cy = (c / gw) | 0, nb = [cx > 0 ? c - 1 : -1, cx < gw - 1 ? c + 1 : -1, cy > 0 ? c - gw : -1, cy < gh - 1 ? c + gw : -1];
        for (var q = 0; q < 4; q++) if (nb[q] >= 0 && flag[nb[q]] && label[nb[q]] < 0) { label[nb[q]] = id; stack.push(nb[q]); }
      }
      clusters.push(cells);
    }
    var minCells = Math.max(4, Math.round(n * 0.012)), kept = [], keptCells = 0, mask = new Uint8Array(n);
    clusters.forEach(function (cells) {
      if (cells.length < minCells) return;
      var x0 = gw, y0 = gh, x1 = -1, y1 = -1, sum = 0;
      cells.forEach(function (c) { var x = c % gw, y = (c / gw) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; sum += r[c]; mask[c] = 1; });
      kept.push({ x: x0 / gw, y: y0 / gh, w: (x1 - x0 + 1) / gw, h: (y1 - y0 + 1) / gh, cells: cells.length, fraction: cells.length / n, meanResidual: sum / cells.length });
      keptCells += cells.length;
    });
    return { gridW: gw, gridH: gh, fraction: keptCells / n, regions: kept, mask: mask, gain: a, offset: b, sigma: sigma, threshold: thr };
  }

  function orientationCandidates(thumb, mainAspect, expected) {
    var list = [];
    function add(t) { if (t >= 1 && t <= 8 && list.indexOf(t) < 0) list.push(t); }
    add(expected || 1); add(1);
    var ta = thumb.w / thumb.h, mainLandscape = mainAspect >= 1, thumbLandscape = ta >= 1;
    if (Math.abs(Math.log(ta)) < 0.08 || Math.abs(Math.log(mainAspect)) < 0.08) { [6, 8, 3, 2, 4, 5, 7].forEach(add); }
    else if (mainLandscape !== thumbLandscape) { add(6); add(8); add(5); add(7); }
    else { add(3); add(2); add(4); }
    return list.slice(0, 5);
  }

  function frameFrom(r, W, H, bars) {
    var ox = bars ? bars.left : 0, oy = bars ? bars.top : 0, FW = W + (bars ? bars.left + bars.right : 0), FH = H + (bars ? bars.top + bars.bottom : 0);
    return { x: (ox + r.x) / FW, y: (oy + r.y) / FH, w: r.w / FW, h: r.h / FH };
  }

  function margins(r, W, H) { return { left: r.x / W, top: r.y / H, right: (W - r.x - r.w) / W, bottom: (H - r.y - r.h) / H }; }
  function maxMargin(m) { return Math.max(m.left, m.top, m.right, m.bottom); }

  /**
   * thumbGray / mainGray: {w,h,data}. mainGray may be any size (it is reduced to a working size).
   * opts.expectedOrientation: EXIF Orientation of the main image (thumbnails usually share the stored raster).
   *
   * Decision rules (thresholds in CFG, calibrated on unrelated-image null distributions):
   *   main-cropped  plain correlation of the main image inside a thumbnail rectangle >= T_SUB, removed margin >= MIN_MARGIN,
   *                 and clearly better than the plain whole-frame match (the robust score would hide crops of low-texture scenes)
   *   thumb-partial same, with the roles swapped
   *   consistent    robust whole-frame correlation >= T_FULL (up to ~TRIM of the frame may differ)
   *   weak/mismatch otherwise
   */
  function compareThumbToMain(thumbGray, mainGray, opts) {
    opts = opts || {};
    var res = { verdict: 'inconclusive', reason: '', orientation: null, scores: {}, notes: [], thumb: { w: thumbGray.w, h: thumbGray.h }, main: { w: mainGray.w, h: mainGray.h }, rect: null, margins: null, diff: null, config: CFG };
    if (thumbGray.w < CFG.MIN_THUMB || thumbGray.h < CFG.MIN_THUMB) { res.reason = 'The thumbnail is too small (' + thumbGray.w + '×' + thumbGray.h + ') to compare.'; return res; }
    var mainW = downscaleMax(mainGray, CFG.WORK_MAX);
    if (mainW.w < 16 || mainW.h < 16) { res.reason = 'The main image is too small to compare.'; return res; }
    if (prepTemplate(mainW).std < CFG.FLAT_STD) { res.reason = 'The main image is almost uniform in brightness; there is not enough structure to compare.'; return res; }
    if (prepTemplate(thumbGray).std < CFG.FLAT_STD) { res.reason = 'The thumbnail is almost uniform in brightness; there is not enough structure to compare.'; return res; }
    var mainAspect = mainW.w / mainW.h, expected = opts.expectedOrientation || 1, cands = orientationCandidates(thumbGray, mainAspect, expected), entries = [];
    cands.forEach(function (t) {
      var ot = orient(thumbGray, t), b = stripBars(ot);
      if (b.trimmed) entries.push({ t: t, img: b.gray, bars: b });   // letterbox bars are not scene content: try the stripped version first
      entries.push({ t: t, img: ot, bars: null });
    });
    var best = null;
    for (var ei = 0; ei < entries.length; ei++) {
      var e = entries[ei];
      e.ev = evaluate(e.img, mainW);
      e.rank = e.ev.best + (e.t === expected ? 0.01 : 0) + (e.bars ? 0.02 : 0);
      if (!best || e.rank > best.rank) best = e;
      if (best.ev.best >= 0.97) break; // unambiguous: no need to try the remaining candidates
    }
    var ev = best.ev, aspThumb = best.img.w / best.img.h, aspMain = mainAspect, aspDiff = Math.abs(aspThumb / aspMain - 1), fullR = ev.rob.full;
    res.orientation = { transform: best.t, text: ORIENT_TEXT[best.t], expected: best.t === expected, candidatesTried: cands };
    res.thumb.orientedW = best.t >= 5 ? thumbGray.h : thumbGray.w; res.thumb.orientedH = best.t >= 5 ? thumbGray.w : thumbGray.h;
    res.thumb.bars = best.bars ? { top: best.bars.top, bottom: best.bars.bottom, left: best.bars.left, right: best.bars.right } : null;
    res.aspect = { thumb: aspThumb, main: aspMain, mismatch: aspDiff };
    var mIn = ev.mIn, tIn = ev.tIn;
    res.scores = { full: ev.full, robustFull: fullR, mainInThumb: mIn ? mIn.ncc : null, thumbInMain: tIn ? tIn.ncc : null };
    var tw = best.img.w, th = best.img.h;
    var mMar = mIn ? margins(mIn, tw, th) : null, tMar = tIn ? margins(tIn, mainW.w, mainW.h) : null;

    if (mIn && mIn.ncc >= CFG.T_SUB && maxMargin(mMar) >= CFG.MIN_MARGIN && mIn.ncc >= ev.full + CFG.SUB_GAIN) {
      res.verdict = 'main-cropped'; res.rect = frameFrom(mIn, tw, th, best.bars); res.margins = mMar;
    } else if (tIn && tIn.ncc >= CFG.T_SUB && maxMargin(tMar) >= CFG.MIN_MARGIN && tIn.ncc >= ev.full + CFG.SUB_GAIN) {
      res.verdict = 'thumb-partial'; res.rect = { x: tIn.x / mainW.w, y: tIn.y / mainW.h, w: tIn.w / mainW.w, h: tIn.h / mainW.h }; res.margins = tMar;
    } else if (fullR >= CFG.T_FULL || (mIn && mIn.ncc >= CFG.T_FULL) || (tIn && tIn.ncc >= CFG.T_FULL)) {
      res.verdict = 'consistent';
      if (aspDiff > 0.03 && fullR >= CFG.T_FULL && (!mIn || fullR >= mIn.ncc)) res.notes.push('distorted-aspect');
    } else if (Math.max(fullR, mIn ? mIn.ncc : 0, tIn ? tIn.ncc : 0) >= CFG.T_WEAK) {
      res.verdict = 'weak';
    } else {
      res.verdict = 'mismatch';
    }
    // Local differences when the frames are aligned
    if (res.verdict === 'consistent' || res.verdict === 'main-cropped') {
      var thumbSat = makeSAT(best.img), rect;
      if (res.verdict === 'main-cropped') rect = mIn;
      else if (mIn && mIn.ncc >= CFG.T_FULL && mIn.ncc > fullR) rect = mIn;       // small crop / sub-pixel shift
      else if (res.notes.indexOf('distorted-aspect') >= 0) rect = null;           // stretched thumbnail: positions would be misleading
      else rect = { x: 0, y: 0, w: tw, h: th };
      if (rect) {
        var d = localDiff(thumbSat, rect, mainW, opts.diffGrid || 40);
        d.frame = frameFrom(rect, tw, th, best.bars);
        d.regions = d.regions.map(function (r0) { return { x: d.frame.x + r0.x * d.frame.w, y: d.frame.y + r0.y * d.frame.h, w: r0.w * d.frame.w, h: r0.h * d.frame.h, cells: r0.cells, fraction: r0.fraction, meanResidual: r0.meanResidual }; });
        res.diff = d;
      }
    }
    return res;
  }

  QPI.compare = {
    CFG: CFG, rgbaToGray: rgbaToGray, makeGray: makeGray, resize: resize, downscaleMax: downscaleMax, orient: orient, orientRGBA: orientRGBA,
    orientDims: orientDims, stripBars: stripBars, robustPearson: robustPearson, robustScores: robustScores, _evaluate: evaluate, _orientCands: null, compareThumbToMain: compareThumbToMain, fullFrameNcc: fullFrameNcc, ORIENT_TEXT: ORIENT_TEXT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.compare;
})(typeof window !== 'undefined' ? window : globalThis);
