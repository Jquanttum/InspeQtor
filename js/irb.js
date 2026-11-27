/*
 * Quanttum Photo Inspector — Photoshop image resources (APP13), IPTC-IIM,
 * ICC profile (APP2) and C2PA/JUMBF presence (APP11). Vanilla JS, no dependencies.
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  var IRB_NAMES = {
    0x03E9: 'Macintosh print manager info', 0x03ED: 'Resolution info', 0x03F3: 'Print flags', 0x03F5: 'Colour halftoning info',
    0x0400: 'Layer state info', 0x0404: 'IPTC-NAA record', 0x0406: 'JPEG quality (Photoshop)', 0x0408: 'Grid and guides',
    0x0409: 'Thumbnail (Photoshop 4.0)', 0x040A: 'Copyright flag', 0x040B: 'URL', 0x040C: 'Thumbnail (Photoshop 5.0)', 0x040D: 'Global angle',
    0x040F: 'ICC profile (untagged flag)', 0x0414: 'Document-specific IDs', 0x0415: 'Global altitude', 0x0419: 'Global lighting angle',
    0x041A: 'Slices', 0x041E: 'URL list', 0x0421: 'Version info', 0x0425: 'Caption digest', 0x0426: 'Print scale',
    0x2710: 'Print flags info'
  };

  var IPTC_NAMES = {
    '1:90': 'CodedCharacterSet', '2:5': 'ObjectName', '2:7': 'EditStatus', '2:15': 'Category', '2:20': 'SupplementalCategories', '2:25': 'Keywords',
    '2:40': 'SpecialInstructions', '2:55': 'DateCreated', '2:60': 'TimeCreated', '2:62': 'DigitalCreationDate', '2:63': 'DigitalCreationTime',
    '2:65': 'OriginatingProgram', '2:70': 'ProgramVersion', '2:80': 'By-line', '2:85': 'By-lineTitle', '2:90': 'City', '2:92': 'Sub-location',
    '2:95': 'Province-State', '2:100': 'CountryCode', '2:101': 'CountryName', '2:103': 'OriginalTransmissionReference', '2:105': 'Headline',
    '2:110': 'Credit', '2:115': 'Source', '2:116': 'CopyrightNotice', '2:120': 'Caption-Abstract', '2:122': 'WriterEditor'
  };

  function ascii(u8, s, e) { var r = ''; for (var i = s; i < e && i < u8.length; i++) r += String.fromCharCode(u8[i]); return r; }
  function u16(u8, o) { return (u8[o] << 8) | u8[o + 1]; }
  function u32(u8, o) { return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; }

  function decodeText(bytes, utf8Flag) {
    var s, i;
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* not UTF-8 */ }
    }
    s = ''; for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function parseIPTC(u8, start, end) {
    var rec = { fields: {}, order: [], warnings: [] }, p = start, utf8 = false;
    while (p + 5 <= end) {
      if (u8[p] !== 0x1C) { rec.warnings.push('IPTC block ended at an unexpected byte (0x' + u8[p].toString(16) + ') at offset ' + p + '.'); break; }
      var r = u8[p + 1], d = u8[p + 2], len = u16(u8, p + 3), hdr = 5;
      if (len & 0x8000) {
        var ll = len & 0x7FFF; if (ll > 4 || p + 5 + ll > end) { rec.warnings.push('Unsupported IPTC extended length.'); break; }
        len = 0; for (var k = 0; k < ll; k++) len = len * 256 + u8[p + 5 + k];
        hdr = 5 + ll;
      }
      if (p + hdr + len > end) { rec.warnings.push('IPTC dataset truncated.'); break; }
      var key = r + ':' + d, vb = u8.subarray(p + hdr, p + hdr + len);
      if (key === '1:90') { utf8 = vb.length === 3 && vb[0] === 0x1B && vb[1] === 0x25 && vb[2] === 0x47; rec.fields[key] = { name: 'CodedCharacterSet', values: [utf8 ? 'UTF-8' : 'other'] }; if (rec.order.indexOf(key) < 0) rec.order.push(key); }
      else if (r === 2) {
        var name = IPTC_NAMES[key] || ('2:' + d);
        if (!rec.fields[key]) { rec.fields[key] = { name: name, values: [] }; rec.order.push(key); }
        rec.fields[key].values.push(decodeText(vb, utf8).replace(/\0+$/, ''));
      }
      p += hdr + len;
    }
    return rec;
  }

  function parseIRB(u8, seg) {
    var d = seg.dataOffset, end = d + seg.dataLength;
    var out = { resources: [], iptc: null, thumbnail: null, version: null, jpegQuality: null, warnings: [] };
    if (ascii(u8, d, d + 14) !== 'Photoshop 3.0\0') return null;
    var p = d + 14;
    while (p + 12 <= end) {
      var sig = ascii(u8, p, p + 4);
      if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'PHUT' && sig !== 'AgHg' && sig !== 'DCSR') { out.warnings.push('Unrecognised resource signature at offset ' + p + '; stopped.'); break; }
      var id = u16(u8, p + 4), nameLen = u8[p + 6], nameTotal = 1 + nameLen; if (nameTotal & 1) nameTotal++;
      var sizeOff = p + 6 + nameTotal;
      if (sizeOff + 4 > end) { out.warnings.push('Truncated resource header.'); break; }
      var size = u32(u8, sizeOff), dataOff = sizeOff + 4;
      if (dataOff + size > end) { out.warnings.push('Resource 0x' + id.toString(16) + ' runs past the end of the segment.'); size = Math.max(0, end - dataOff); }
      out.resources.push({ id: id, name: IRB_NAMES[id] || ('Resource 0x' + id.toString(16).toUpperCase()), size: size, offset: dataOff });
      if (id === 0x0404) out.iptc = parseIPTC(u8, dataOff, dataOff + size);
      else if ((id === 0x0409 || id === 0x040C) && size > 28) {
        var fmt = u32(u8, dataOff), w = u32(u8, dataOff + 4), h = u32(u8, dataOff + 8), comp = u32(u8, dataOff + 20);
        if (fmt === 1 && u8[dataOff + 28] === 0xFF && u8[dataOff + 29] === 0xD8) {
          var len = Math.min(comp > 0 ? comp : size - 28, size - 28);
          out.thumbnail = { resourceId: id, offset: dataOff + 28, length: len, width: w, height: h, rgbOrder: id === 0x040C ? 'RGB' : 'BGR' };
        }
      } else if (id === 0x0421 && size >= 10) {
        var q = dataOff, ver = u32(u8, q); q += 4; var merged = u8[q]; q += 1;
        var readUni = function () {
          if (q + 4 > dataOff + size) return '';
          var n = u32(u8, q); q += 4; if (n > 1000 || q + n * 2 > dataOff + size) return '';
          var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(u16(u8, q + i * 2)); q += n * 2; return s.replace(/\0+$/, '');
        };
        var writer = readUni(), reader = readUni();
        out.version = { version: ver, hasRealMergedData: !!merged, writer: writer, reader: reader };
      } else if (id === 0x0406 && size >= 2) {
        out.jpegQuality = { raw: u16(u8, dataOff) };
      }
      p = dataOff + size + (size & 1);
    }
    return out;
  }

  function parseICC(bytes) {
    if (!bytes || bytes.length < 132) return null;
    var sig = ascii(bytes, 36, 40);
    if (sig !== 'acsp') return { valid: false, size: bytes.length };
    var prof = { valid: true, size: u32(bytes, 0), cmm: ascii(bytes, 4, 8).trim(), version: bytes[8] + '.' + (bytes[9] >> 4) + '.' + (bytes[9] & 15), deviceClass: ascii(bytes, 12, 16), colorSpace: ascii(bytes, 16, 20).trim(), pcs: ascii(bytes, 20, 24).trim(),
      created: u16(bytes, 24) + '-' + String(u16(bytes, 26)).padStart(2, '0') + '-' + String(u16(bytes, 28)).padStart(2, '0') + ' ' + String(u16(bytes, 30)).padStart(2, '0') + ':' + String(u16(bytes, 32)).padStart(2, '0') + ':' + String(u16(bytes, 34)).padStart(2, '0'),
      platform: ascii(bytes, 40, 44).trim(), manufacturer: ascii(bytes, 48, 52).trim(), model: ascii(bytes, 52, 56).trim(), description: '', copyright: '' };
    var count = u32(bytes, 128);
    if (count > 200) count = 200;
    for (var i = 0; i < count; i++) {
      var eo = 132 + i * 12; if (eo + 12 > bytes.length) break;
      var tsig = ascii(bytes, eo, eo + 4), off = u32(bytes, eo + 4), sz = u32(bytes, eo + 8);
      if (off + sz > bytes.length || sz < 12) continue;
      if (tsig === 'desc' || tsig === 'cprt') {
        var type = ascii(bytes, off, off + 4), text = '';
        if (type === 'desc') { var n = u32(bytes, off + 8); text = ascii(bytes, off + 12, off + 12 + Math.min(n, sz - 12)).replace(/\0+$/, ''); }
        else if (type === 'mluc') {
          var nrec = u32(bytes, off + 8), rsz = u32(bytes, off + 12);
          if (nrec > 0 && rsz >= 12) { var l = u32(bytes, off + 20), o2 = u32(bytes, off + 24); for (var k = 0; k + 1 < l && off + o2 + k + 1 < bytes.length; k += 2) text += String.fromCharCode(u16(bytes, off + o2 + k)); }
        } else if (type === 'text') { text = ascii(bytes, off + 8, off + sz).replace(/\0+$/, ''); }
        if (tsig === 'desc') prof.description = text; else prof.copyright = text;
      }
    }
    return prof;
  }

  function collectICC(u8, segments) {
    var chunks = [];
    segments.forEach(function (s) {
      if (s.marker === 0xE2 && s.dataLength > 14 && ascii(u8, s.dataOffset, s.dataOffset + 12) === 'ICC_PROFILE\0') {
        chunks.push({ seq: u8[s.dataOffset + 12], count: u8[s.dataOffset + 13], data: u8.subarray(s.dataOffset + 14, s.dataOffset + s.dataLength) });
      }
    });
    if (!chunks.length) return null;
    chunks.sort(function (a, b) { return a.seq - b.seq; });
    var total = 0; chunks.forEach(function (c) { total += c.data.length; });
    var all = new Uint8Array(total), p = 0; chunks.forEach(function (c) { all.set(c.data, p); p += c.data.length; });
    var prof = parseICC(all);
    if (prof) prof.chunks = chunks.length;
    return prof;
  }

  /** APP11 JUMBF / C2PA Content Credentials: presence only, signatures are NOT validated. */
  function detectC2PA(u8, segments) {
    var found = null;
    segments.forEach(function (s) {
      if (s.marker !== 0xEB || s.dataLength < 16 || found) return;
      var head = ascii(u8, s.dataOffset, s.dataOffset + 2);
      if (head !== 'JP') return;
      var body = ascii(u8, s.dataOffset, Math.min(s.dataOffset + s.dataLength, s.dataOffset + 600));
      if (body.indexOf('c2pa') >= 0 || body.indexOf('jumb') >= 0) found = { offset: s.offset, length: s.length, c2pa: body.indexOf('c2pa') >= 0 };
    });
    return found;
  }

  QPI.irb = { parseIRB: parseIRB, parseIPTC: parseIPTC, parseICC: parseICC, collectICC: collectICC, detectC2PA: detectC2PA };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.irb;
})(typeof window !== 'undefined' ? window : globalThis);
