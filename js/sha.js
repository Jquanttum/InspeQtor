/*
 * Quanttum Photo Inspector — hashing (pure JS, no dependencies)
 * SHA-256 and MD5 over a Uint8Array. Used for the evidence hashes in the case
 * report. Constants are derived at load time (cube/square roots of primes,
 * sines) and verified against Node's crypto module and Python's hashlib in the
 * test suite.
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  // ---------- SHA-256 ----------
  var K256 = new Uint32Array(64);
  var H256 = new Uint32Array(8);
  (function () {
    var primes = [], n = 2;
    while (primes.length < 64) {
      var ok = true;
      for (var i = 0; i < primes.length; i++) { if (n % primes[i] === 0) { ok = false; break; } }
      if (ok) primes.push(n);
      n++;
    }
    for (var j = 0; j < 64; j++) {
      var c = Math.cbrt(primes[j]);
      K256[j] = Math.floor((c - Math.floor(c)) * 4294967296);
    }
    for (var k = 0; k < 8; k++) {
      var s = Math.sqrt(primes[k]);
      H256[k] = Math.floor((s - Math.floor(s)) * 4294967296);
    }
  })();

  function toHex32(arr, littleEndian) {
    var out = '';
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i] >>> 0;
      for (var b = 0; b < 4; b++) {
        var byte = littleEndian ? (v >>> (8 * b)) & 255 : (v >>> (24 - 8 * b)) & 255;
        out += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return out;
  }

  function sha256(data) {
    var h = new Uint32Array(H256);
    var w = new Uint32Array(64);
    function block(buf, off) {
      var i, t1, t2;
      for (i = 0; i < 16; i++) {
        var p = off + i * 4;
        w[i] = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], gg = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & gg);
        t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        t2 = (S0 + maj) >>> 0;
        hh = gg; gg = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + gg) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var len = data.length, full = len - (len % 64), i;
    for (i = 0; i < full; i += 64) block(data, i);
    var rem = len - full;
    var tail = new Uint8Array(rem + 9 <= 64 ? 64 : 128);
    tail.set(data.subarray(full));
    tail[rem] = 0x80;
    var bitsHi = Math.floor(len / 536870912); // len*8 / 2^32
    var bitsLo = (len * 8) >>> 0;
    var tl = tail.length;
    tail[tl - 8] = (bitsHi >>> 24) & 255; tail[tl - 7] = (bitsHi >>> 16) & 255;
    tail[tl - 6] = (bitsHi >>> 8) & 255; tail[tl - 5] = bitsHi & 255;
    tail[tl - 4] = (bitsLo >>> 24) & 255; tail[tl - 3] = (bitsLo >>> 16) & 255;
    tail[tl - 2] = (bitsLo >>> 8) & 255; tail[tl - 1] = bitsLo & 255;
    for (i = 0; i < tl; i += 64) block(tail, i);
    return toHex32(h, false);
  }

  // ---------- MD5 ----------
  var K5 = new Uint32Array(64);
  for (var mi = 0; mi < 64; mi++) K5[mi] = Math.floor(Math.abs(Math.sin(mi + 1)) * 4294967296);
  var R5 = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  function md5(data) {
    var s = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    var m = new Uint32Array(16);
    function block(buf, off) {
      var i;
      for (i = 0; i < 16; i++) {
        var p = off + i * 4;
        m[i] = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
      }
      var a = s[0], b = s[1], c = s[2], d = s[3];
      for (i = 0; i < 64; i++) {
        var f, gi;
        if (i < 16) { f = (b & c) | (~b & d); gi = i; }
        else if (i < 32) { f = (d & b) | (~d & c); gi = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; gi = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); gi = (7 * i) & 15; }
        var tmp = d; d = c; c = b;
        var x = (a + (f >>> 0) + K5[i] + m[gi]) >>> 0;
        b = (b + ((x << R5[i]) | (x >>> (32 - R5[i])))) >>> 0;
        a = tmp;
      }
      s[0] = (s[0] + a) >>> 0; s[1] = (s[1] + b) >>> 0; s[2] = (s[2] + c) >>> 0; s[3] = (s[3] + d) >>> 0;
    }
    var len = data.length, full = len - (len % 64), i;
    for (i = 0; i < full; i += 64) block(data, i);
    var rem = len - full;
    var tail = new Uint8Array(rem + 9 <= 64 ? 64 : 128);
    tail.set(data.subarray(full));
    tail[rem] = 0x80;
    var bitsLo = (len * 8) >>> 0, bitsHi = Math.floor(len / 536870912), tl = tail.length;
    for (i = 0; i < 4; i++) { tail[tl - 8 + i] = (bitsLo >>> (8 * i)) & 255; tail[tl - 4 + i] = (bitsHi >>> (8 * i)) & 255; }
    for (i = 0; i < tl; i += 64) block(tail, i);
    return toHex32(s, true);
  }

  QPI.hash = { sha256: sha256, md5: md5 };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.hash;
})(typeof window !== 'undefined' ? window : globalThis);
