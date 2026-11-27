/*
 * Quanttum Photo Inspector — JPEG segment parser (vanilla JS, no dependencies)
 *
 * Walks the marker structure of a JPEG file without decoding any pixels:
 * every segment with its file offset, frame header (dimensions, subsampling,
 * progressive/baseline), quantisation tables (+ IJG quality estimate), JFIF /
 * Adobe / comment markers, and any bytes after the final EOI.
 * Never throws on malformed input: problems are collected in errors/warnings.
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  var ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
  var STD_LUM = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  var STD_CHR = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

  var SOF_TYPES = {
    0xC0: 'baseline DCT', 0xC1: 'extended sequential DCT', 0xC2: 'progressive DCT', 0xC3: 'lossless',
    0xC5: 'differential sequential', 0xC6: 'differential progressive', 0xC7: 'differential lossless',
    0xC9: 'arithmetic sequential', 0xCA: 'arithmetic progressive', 0xCB: 'arithmetic lossless',
    0xCD: 'differential arithmetic sequential', 0xCE: 'differential arithmetic progressive', 0xCF: 'differential arithmetic lossless'
  };

  function markerName(m) {
    if (m >= 0xE0 && m <= 0xEF) return 'APP' + (m - 0xE0);
    if (SOF_TYPES[m]) return 'SOF' + (m - 0xC0);
    if (m >= 0xD0 && m <= 0xD7) return 'RST' + (m - 0xD0);
    var n = { 0xD8: 'SOI', 0xD9: 'EOI', 0xDA: 'SOS', 0xDB: 'DQT', 0xC4: 'DHT', 0xDD: 'DRI', 0xFE: 'COM', 0xDC: 'DNL', 0xDE: 'DHP', 0xDF: 'EXP', 0xCC: 'DAC', 0x01: 'TEM' };
    return n[m] || ('0x' + m.toString(16).toUpperCase());
  }

  function ascii(u8, start, end) {
    var s = '';
    for (var i = start; i < end && i < u8.length; i++) {
      var c = u8[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : (c === 0 ? '\0' : '.');
    }
    return s;
  }

  function segmentId(u8, seg) {
    var s = seg.dataOffset, e = Math.min(seg.dataOffset + Math.min(seg.dataLength, 48), u8.length);
    var out = '';
    for (var i = s; i < e; i++) {
      var c = u8[i];
      if (c === 0) break;
      if (c < 32 || c > 126) { if (out.length < 4) return ''; break; }
      out += String.fromCharCode(c);
    }
    return out;
  }

  function classifyTrailing(u8, off) {
    var n = u8.length, len = n - off;
    if (len <= 0) return null;
    var i, allZero = true, sample = Math.min(len, 4096);
    for (i = 0; i < sample; i++) { if (u8[off + i] !== 0) { allZero = false; break; } }
    var kind = 'unknown', note = '';
    var b0 = u8[off], b1 = u8[off + 1], b2 = u8[off + 2], b3 = u8[off + 3];
    if (allZero) { kind = 'zero-padding'; note = 'Only zero bytes (padding).'; }
    else if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) { kind = 'jpeg'; note = 'Another JPEG stream (e.g. multi-picture / preview / gain map, or a hidden second image).'; }
    else if (len > 8 && ascii(u8, off + 4, off + 8) === 'ftyp') { kind = 'mp4'; note = 'MP4/QuickTime container (typical of Motion Photo / Live Photo style files).'; }
    else if (b0 === 0x50 && b1 === 0x4B && (b2 === 3 || b2 === 5)) { kind = 'zip'; note = 'ZIP archive signature.'; }
    else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) { kind = 'png'; note = 'PNG image signature.'; }
    else if (ascii(u8, off, off + 4) === 'GIF8') { kind = 'gif'; note = 'GIF image signature.'; }
    else if (ascii(u8, off, off + 4) === '%PDF') { kind = 'pdf'; note = 'PDF signature.'; }
    else if (ascii(u8, off, off + 4) === 'RIFF') { kind = 'riff'; note = 'RIFF container (WAV/WebP/AVI).'; }
    else if (ascii(u8, off, off + 4) === 'Rar!') { kind = 'rar'; note = 'RAR archive signature.'; }
    else if (b0 === 0x37 && b1 === 0x7A && b2 === 0xBC && b3 === 0xAF) { kind = '7z'; note = '7-Zip archive signature.'; }
    else {
      var printable = 0;
      for (i = 0; i < sample; i++) { var c = u8[off + i]; if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) printable++; }
      if (printable / sample > 0.92) { kind = 'text'; note = 'Mostly printable text.'; }
    }
    var tail = ascii(u8, Math.max(off, n - 4), n);
    var vendorTrailer = (tail === 'SEFT') ? 'Samsung SEF trailer' : '';
    return { offset: off, length: len, kind: kind, note: note, vendorTrailer: vendorTrailer };
  }

  function subsamplingOf(comps) {
    if (!comps || !comps.length) return '';
    if (comps.length === 1) return 'grayscale';
    if (comps.length < 3) return comps.length + ' components';
    var y = comps[0], c1 = comps[1], c2 = comps[2];
    if (c1.h !== c2.h || c1.v !== c2.v) return 'non-uniform';
    var hr = y.h / c1.h, vr = y.v / c1.v;
    if (hr === 1 && vr === 1) return '4:4:4';
    if (hr === 2 && vr === 1) return '4:2:2';
    if (hr === 2 && vr === 2) return '4:2:0';
    if (hr === 1 && vr === 2) return '4:4:0';
    if (hr === 4 && vr === 1) return '4:1:1';
    if (hr === 4 && vr === 2) return '4:1:0';
    return hr + 'x' + vr;
  }

  function toNatural(zz) {
    var nat = new Array(64);
    for (var i = 0; i < 64; i++) nat[ZIGZAG[i]] = zz[i];
    return nat;
  }

  function scaledTable(std, q) {
    var scale = q < 50 ? 5000 / q : 200 - 2 * q;
    var t = new Array(64);
    for (var i = 0; i < 64; i++) {
      var v = Math.floor((std[i] * scale + 50) / 100);
      t[i] = v < 1 ? 1 : (v > 255 ? 255 : v);
    }
    return t;
  }

  /** Estimate libjpeg (IJG) quality from DQT tables. */
  function estimateQuality(dqt) {
    var lum = null, chr = null, i;
    for (i = 0; i < dqt.length; i++) {
      if (dqt[i].id === 0 && !lum) lum = dqt[i];
      if (dqt[i].id === 1 && !chr) chr = dqt[i];
    }
    if (!lum || lum.values.length !== 64) return null;
    var nat = toNatural(lum.values), best = -1, bestErr = Infinity;
    for (var q = 1; q <= 100; q++) {
      var t = scaledTable(STD_LUM, q), err = 0;
      for (i = 0; i < 64; i++) { var d = t[i] - nat[i]; err += d * d; }
      if (err < bestErr) { bestErr = err; best = q; }
    }
    var exact = bestErr === 0, chromaExact = null;
    if (exact && chr && chr.values.length === 64) {
      var ct = scaledTable(STD_CHR, best), cn = toNatural(chr.values), cerr = 0;
      for (i = 0; i < 64; i++) { var dd = ct[i] - cn[i]; cerr += dd * dd; }
      chromaExact = cerr === 0;
    }
    return { quality: best, exact: exact, chromaExact: chromaExact, rmsError: Math.sqrt(bestErr / 64), luminanceTable: nat };
  }

  function parse(u8) {
    var n = u8.length;
    var res = {
      size: n, ok: false, errors: [], warnings: [], segments: [], frame: null, dqt: [], dhtCount: 0,
      restartInterval: 0, scans: 0, jfif: null, jfxx: null, adobe: null, comments: [], appCounts: {},
      eoiOffset: -1, eoiEnd: -1, trailing: null, quality: null, progressive: false, truncated: false
    };
    if (n < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) { res.errors.push('Not a JPEG: file does not start with the SOI marker (FF D8).'); return res; }
    res.segments.push({ marker: 0xD8, name: 'SOI', offset: 0, length: 2, dataOffset: 2, dataLength: 0, id: '' });
    var pos = 2, guard = 0;
    while (pos < n && guard++ < 200000) {
      if (u8[pos] !== 0xFF) {
        var nx = u8.indexOf(0xFF, pos);
        res.warnings.push('Unexpected non-marker bytes at offset ' + pos + (nx < 0 ? ' to end of file.' : ' (skipped ' + (nx - pos) + ' bytes).'));
        if (nx < 0) { pos = n; break; }
        pos = nx; continue;
      }
      while (pos < n && u8[pos] === 0xFF) pos++;
      if (pos >= n) break;
      var m = u8[pos], mpos = pos - 1; pos++;
      if (m === 0x00) continue;
      if (m === 0xD9) {
        res.segments.push({ marker: m, name: 'EOI', offset: mpos, length: 2, dataOffset: pos, dataLength: 0, id: '' });
        res.eoiOffset = mpos; res.eoiEnd = pos; break;
      }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) {
        res.segments.push({ marker: m, name: markerName(m), offset: mpos, length: 2, dataOffset: pos, dataLength: 0, id: '' });
        continue;
      }
      if (pos + 2 > n) { res.warnings.push('File ends inside a marker header at offset ' + mpos + '.'); res.truncated = true; pos = n; break; }
      var len = (u8[pos] << 8) | u8[pos + 1];
      if (len < 2) { res.errors.push('Invalid segment length (' + len + ') for ' + markerName(m) + ' at offset ' + mpos + '.'); break; }
      var segEnd = pos + len;
      if (segEnd > n) { res.warnings.push(markerName(m) + ' segment at offset ' + mpos + ' runs past the end of the file (truncated file).'); segEnd = n; res.truncated = true; }
      var seg = { marker: m, name: markerName(m), offset: mpos, length: segEnd - mpos, dataOffset: pos + 2, dataLength: Math.max(0, segEnd - pos - 2), id: '' };
      if (m >= 0xE0 && m <= 0xEF) { seg.id = segmentId(u8, seg); res.appCounts[seg.name] = (res.appCounts[seg.name] || 0) + 1; }
      handleSegment(u8, seg, res);
      res.segments.push(seg);
      pos = segEnd;
      if (m === 0xDA) {
        res.scans++;
        var p = pos;
        for (;;) {
          p = u8.indexOf(0xFF, p);
          if (p < 0 || p + 1 >= n) { p = n; break; }
          var nb = u8[p + 1];
          if (nb === 0x00 || (nb >= 0xD0 && nb <= 0xD7)) { p += 2; continue; }
          if (nb === 0xFF) { p++; continue; }
          break;
        }
        seg.entropyOffset = pos; seg.entropyLength = p - pos;
        pos = p;
      }
    }
    if (guard >= 200000) res.warnings.push('Stopped after 200000 segments (possible malformed file).');
    if (res.eoiEnd < 0) {
      res.warnings.push('No EOI marker (FF D9) found: the file is truncated or has been cut.');
      res.truncated = true;
    } else if (res.eoiEnd < n) {
      res.trailing = classifyTrailing(u8, res.eoiEnd);
    }
    if (!res.frame) res.errors.push('No frame header (SOF) found: image dimensions unknown.');
    res.progressive = !!(res.frame && (res.frame.marker === 0xC2 || res.frame.marker === 0xC6 || res.frame.marker === 0xCA || res.frame.marker === 0xCE));
    if (res.dqt.length) res.quality = estimateQuality(res.dqt);
    res.ok = !!res.frame && res.errors.length === 0;
    return res;
  }

  function handleSegment(u8, seg, res) {
    var m = seg.marker, d = seg.dataOffset, dl = seg.dataLength, i;
    if (SOF_TYPES[m] && dl >= 6) {
      var comps = [], nc = u8[d + 5];
      for (i = 0; i < nc && d + 6 + i * 3 + 2 < d + dl + 1; i++) {
        var o = d + 6 + i * 3;
        comps.push({ id: u8[o], h: u8[o + 1] >> 4, v: u8[o + 1] & 15, tq: u8[o + 2] });
      }
      var frame = {
        marker: m, type: SOF_TYPES[m], precision: u8[d], height: (u8[d + 1] << 8) | u8[d + 2],
        width: (u8[d + 3] << 8) | u8[d + 4], components: comps, subsampling: subsamplingOf(comps), offset: seg.offset
      };
      if (!res.frame) res.frame = frame; else res.warnings.push('Additional frame header (SOF) at offset ' + seg.offset + '.');
      if (frame.width === 0 || frame.height === 0) res.warnings.push('Frame header declares a zero dimension (height may be defined by a DNL marker).');
    } else if (m === 0xDB) {
      var p = d, end = d + dl;
      while (p < end) {
        var pq = u8[p] >> 4, tq = u8[p] & 15, cnt = 64 * (pq ? 2 : 1);
        if (p + 1 + cnt > end) { res.warnings.push('Truncated DQT segment at offset ' + seg.offset + '.'); break; }
        var vals = [];
        for (i = 0; i < 64; i++) vals.push(pq ? ((u8[p + 1 + i * 2] << 8) | u8[p + 2 + i * 2]) : u8[p + 1 + i]);
        res.dqt.push({ id: tq, precision: pq ? 16 : 8, values: vals });
        p += 1 + cnt;
      }
    } else if (m === 0xC4) {
      res.dhtCount++;
    } else if (m === 0xDD && dl >= 2) {
      res.restartInterval = (u8[d] << 8) | u8[d + 1];
    } else if (m === 0xFE) {
      var txt = ascii(u8, d, d + Math.min(dl, 2000)).replace(/\0/g, '');
      res.comments.push({ offset: seg.offset, length: dl, text: txt });
    } else if (m === 0xE0) {
      if (ascii(u8, d, d + 5) === 'JFIF\0' && dl >= 14) {
        res.jfif = { version: u8[d + 5] + '.' + (u8[d + 6] < 10 ? '0' : '') + u8[d + 6], units: u8[d + 7], xDensity: (u8[d + 8] << 8) | u8[d + 9], yDensity: (u8[d + 10] << 8) | u8[d + 11], thumbW: u8[d + 12], thumbH: u8[d + 13], offset: seg.offset };
        seg.id = 'JFIF';
      } else if (ascii(u8, d, d + 5) === 'JFXX\0' && dl >= 6) {
        var code = u8[d + 5];
        res.jfxx = { extensionCode: code, offset: seg.offset, dataOffset: d + 6, dataLength: dl - 6 };
        seg.id = 'JFXX';
      }
    } else if (m === 0xEE) {
      if (ascii(u8, d, d + 5) === 'Adobe' && dl >= 12) {
        res.adobe = { version: (u8[d + 5] << 8) | u8[d + 6], flags0: (u8[d + 7] << 8) | u8[d + 8], flags1: (u8[d + 9] << 8) | u8[d + 10], transform: u8[d + 11], offset: seg.offset };
        seg.id = 'Adobe';
      }
    }
  }

  QPI.jpeg = { parse: parse, markerName: markerName, estimateQuality: estimateQuality, classifyTrailing: classifyTrailing, ZIGZAG: ZIGZAG };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.jpeg;
})(typeof window !== 'undefined' ? window : globalThis);
