/*
 * Quanttum Photo Inspector — EXIF / TIFF reader (vanilla JS, no dependencies)
 *
 * Reads IFD0, Exif, GPS, Interoperability and IFD1 (thumbnail) directories from
 * an APP1 "Exif" segment, in either byte order, with strict bounds checking and
 * IFD-loop protection. Also reads the Multi-Picture Format (MPF) index from APP2.
 * MakerNotes are located and sniffed but NOT decoded (see README: limits).
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  var TYPE_NAME = { 1: 'BYTE', 2: 'ASCII', 3: 'SHORT', 4: 'LONG', 5: 'RATIONAL', 6: 'SBYTE', 7: 'UNDEFINED', 8: 'SSHORT', 9: 'SLONG', 10: 'SRATIONAL', 11: 'FLOAT', 12: 'DOUBLE', 13: 'IFD' };

  var TAGS = {
    ifd0: {
      0x100: 'ImageWidth', 0x101: 'ImageHeight', 0x102: 'BitsPerSample', 0x103: 'Compression', 0x106: 'PhotometricInterpretation',
      0x10E: 'ImageDescription', 0x10F: 'Make', 0x110: 'Model', 0x111: 'StripOffsets', 0x112: 'Orientation', 0x115: 'SamplesPerPixel',
      0x116: 'RowsPerStrip', 0x117: 'StripByteCounts', 0x11A: 'XResolution', 0x11B: 'YResolution', 0x11C: 'PlanarConfiguration',
      0x128: 'ResolutionUnit', 0x12D: 'TransferFunction', 0x131: 'Software', 0x132: 'DateTime', 0x13B: 'Artist', 0x13C: 'HostComputer',
      0x13E: 'WhitePoint', 0x13F: 'PrimaryChromaticities', 0x201: 'JPEGInterchangeFormat', 0x202: 'JPEGInterchangeFormatLength',
      0x211: 'YCbCrCoefficients', 0x212: 'YCbCrSubSampling', 0x213: 'YCbCrPositioning', 0x214: 'ReferenceBlackWhite',
      0x8298: 'Copyright', 0x8769: 'ExifIFDPointer', 0x8825: 'GPSInfoIFDPointer', 0xC4A5: 'PrintIM',
      0x9C9B: 'XPTitle', 0x9C9C: 'XPComment', 0x9C9D: 'XPAuthor', 0x9C9E: 'XPKeywords', 0x9C9F: 'XPSubject', 0x4746: 'Rating', 0x4749: 'RatingPercent'
    },
    exif: {
      0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8822: 'ExposureProgram', 0x8824: 'SpectralSensitivity', 0x8827: 'ISOSpeedRatings',
      0x8828: 'OECF', 0x8830: 'SensitivityType', 0x8831: 'StandardOutputSensitivity', 0x8832: 'RecommendedExposureIndex', 0x8833: 'ISOSpeed',
      0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
      0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel', 0x9201: 'ShutterSpeedValue',
      0x9202: 'ApertureValue', 0x9203: 'BrightnessValue', 0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
      0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash', 0x920A: 'FocalLength', 0x9214: 'SubjectArea', 0x927C: 'MakerNote',
      0x9286: 'UserComment', 0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0xA000: 'FlashpixVersion',
      0xA001: 'ColorSpace', 0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension', 0xA004: 'RelatedSoundFile', 0xA005: 'InteroperabilityIFDPointer',
      0xA20B: 'FlashEnergy', 0xA20E: 'FocalPlaneXResolution', 0xA20F: 'FocalPlaneYResolution', 0xA210: 'FocalPlaneResolutionUnit',
      0xA214: 'SubjectLocation', 0xA215: 'ExposureIndex', 0xA217: 'SensingMethod', 0xA300: 'FileSource', 0xA301: 'SceneType', 0xA302: 'CFAPattern',
      0xA401: 'CustomRendered', 0xA402: 'ExposureMode', 0xA403: 'WhiteBalance', 0xA404: 'DigitalZoomRatio', 0xA405: 'FocalLengthIn35mmFilm',
      0xA406: 'SceneCaptureType', 0xA407: 'GainControl', 0xA408: 'Contrast', 0xA409: 'Saturation', 0xA40A: 'Sharpness', 0xA40B: 'DeviceSettingDescription',
      0xA40C: 'SubjectDistanceRange', 0xA420: 'ImageUniqueID', 0xA430: 'CameraOwnerName', 0xA431: 'BodySerialNumber', 0xA432: 'LensSpecification',
      0xA433: 'LensMake', 0xA434: 'LensModel', 0xA435: 'LensSerialNumber', 0xA460: 'CompositeImage', 0xA461: 'SourceImageNumberOfCompositeImage',
      0xA462: 'SourceExposureTimesOfCompositeImage'
    },
    gps: {
      0: 'GPSVersionID', 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 5: 'GPSAltitudeRef', 6: 'GPSAltitude',
      7: 'GPSTimeStamp', 8: 'GPSSatellites', 9: 'GPSStatus', 10: 'GPSMeasureMode', 11: 'GPSDOP', 12: 'GPSSpeedRef', 13: 'GPSSpeed',
      14: 'GPSTrackRef', 15: 'GPSTrack', 16: 'GPSImgDirectionRef', 17: 'GPSImgDirection', 18: 'GPSMapDatum', 19: 'GPSDestLatitudeRef',
      20: 'GPSDestLatitude', 21: 'GPSDestLongitudeRef', 22: 'GPSDestLongitude', 23: 'GPSDestBearingRef', 24: 'GPSDestBearing',
      25: 'GPSDestDistanceRef', 26: 'GPSDestDistance', 27: 'GPSProcessingMethod', 28: 'GPSAreaInformation', 29: 'GPSDateStamp',
      30: 'GPSDifferential', 31: 'GPSHPositioningError'
    },
    interop: { 1: 'InteroperabilityIndex', 2: 'InteroperabilityVersion' },
    mpf: { 0xB000: 'MPFVersion', 0xB001: 'NumberOfImages', 0xB002: 'MPEntry', 0xB003: 'ImageUIDList', 0xB004: 'TotalFrames' }
  };
  TAGS.ifd1 = TAGS.ifd0;

  var MAX_IFD_ENTRIES = 2000, MAX_ARRAY = 4096, MAX_TAGS_TOTAL = 6000;

  function utf8OrLatin1(bytes) {
    var i, s;
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) { /* fall through to latin1 */ }
    s = '';
    for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function utf16(bytes, le) {
    var s = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      var c = le ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function stripNul(s) { return s.replace(/\0+$/, ''); }

  /**
   * Read a TIFF structure. tiffStart/limit are absolute offsets in u8.
   * dict = { ifd0:{...}, exif:{...}, ... } tag-name dictionaries.
   */
  function readTiff(u8, tiffStart, limit, dict, opts) {
    opts = opts || {};
    var out = { tiffStart: tiffStart, limit: limit, byteOrder: null, ifds: {}, warnings: [], errors: [], makerNote: null, thumbnail: null, tagCount: 0 };
    if (limit - tiffStart < 8) { out.errors.push('TIFF header truncated.'); return out; }
    var bo = String.fromCharCode(u8[tiffStart], u8[tiffStart + 1]);
    var le;
    if (bo === 'II') le = true; else if (bo === 'MM') le = false;
    else { out.errors.push('Invalid TIFF byte-order mark (' + bo.replace(/[^\x20-\x7e]/g, '?') + ').'); return out; }
    out.byteOrder = bo;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var magic = dv.getUint16(tiffStart + 2, le);
    if (magic !== 42 && !(opts.allowMagic && magic === opts.allowMagic)) { out.errors.push('Invalid TIFF magic number (' + magic + ').'); return out; }
    var visited = {};

    function readValue(type, cnt, valOff, total, tagId) {
      var i, arr, v;
      if (cnt > MAX_ARRAY && type !== 2 && type !== 7 && type !== 1) cnt = MAX_ARRAY;
      switch (type) {
        case 2: {
          var bytes = u8.subarray(valOff, valOff + total);
          var firstNul = bytes.indexOf(0);
          var shown = firstNul >= 0 ? bytes.subarray(0, firstNul) : bytes;
          var s = utf8OrLatin1(shown.length > 4096 ? shown.subarray(0, 4096) : shown);
          return { value: stripNul(s), hasMore: firstNul >= 0 && firstNul < bytes.length - 1 && bytes.subarray(firstNul + 1).some(function (b) { return b !== 0; }) };
        }
        case 1: case 7: {
          var cap = (tagId === 0xB002) ? 1024 : 512;
          var slice = u8.slice(valOff, valOff + Math.min(total, cap));
          if (type === 1 && cnt === 1) return { value: slice[0] };
          return { value: slice, bytesTruncated: total > cap };
        }
        case 6: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getInt8(valOff + i)); return { value: cnt === 1 ? arr[0] : arr };
        case 3: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getUint16(valOff + i * 2, le)); return { value: cnt === 1 ? arr[0] : arr };
        case 8: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getInt16(valOff + i * 2, le)); return { value: cnt === 1 ? arr[0] : arr };
        case 4: case 13: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getUint32(valOff + i * 4, le)); return { value: cnt === 1 ? arr[0] : arr };
        case 9: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getInt32(valOff + i * 4, le)); return { value: cnt === 1 ? arr[0] : arr };
        case 5: case 10: {
          var vals = [], rats = [];
          for (i = 0; i < cnt; i++) {
            var n = type === 5 ? dv.getUint32(valOff + i * 8, le) : dv.getInt32(valOff + i * 8, le);
            var d = type === 5 ? dv.getUint32(valOff + i * 8 + 4, le) : dv.getInt32(valOff + i * 8 + 4, le);
            rats.push([n, d]); vals.push(d === 0 ? null : n / d);
          }
          return { value: cnt === 1 ? vals[0] : vals, rational: rats };
        }
        case 11: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getFloat32(valOff + i * 4, le)); return { value: cnt === 1 ? arr[0] : arr };
        case 12: arr = []; for (i = 0; i < cnt; i++) arr.push(dv.getFloat64(valOff + i * 8, le)); return { value: cnt === 1 ? arr[0] : arr };
      }
      v = null;
      return { value: v };
    }

    function readIFD(rel, name, depth) {
      var abs = tiffStart + rel;
      if (depth > 6) { out.warnings.push('IFD nesting too deep at ' + name + '.'); return null; }
      if (rel < 8 || abs + 2 > limit) { out.warnings.push(name + ' offset ' + rel + ' is outside the Exif data.'); return null; }
      if (visited[abs]) { out.warnings.push('IFD loop detected: ' + name + ' at offset ' + rel + ' was already read.'); return null; }
      visited[abs] = true;
      var count = dv.getUint16(abs, le);
      var ifd = { name: name, offset: abs, relOffset: rel, tags: {}, order: [], next: 0, count: count };
      if (count > MAX_IFD_ENTRIES) { out.warnings.push(name + ' declares ' + count + ' entries; only the first ' + MAX_IFD_ENTRIES + ' are read.'); }
      var n = Math.min(count, MAX_IFD_ENTRIES), dictName = dict[name] || {};
      for (var i = 0; i < n; i++) {
        var eo = abs + 2 + i * 12;
        if (eo + 12 > limit) { out.warnings.push(name + ' is truncated after ' + i + ' of ' + count + ' entries.'); break; }
        if (++out.tagCount > MAX_TAGS_TOTAL) { out.warnings.push('Too many tags; parsing stopped.'); break; }
        var id = dv.getUint16(eo, le), type = dv.getUint16(eo + 2, le), cnt = dv.getUint32(eo + 4, le);
        var tag = { id: id, name: dictName[id] || ('Tag0x' + id.toString(16).toUpperCase().padStart(4, '0')), known: !!dictName[id], type: type, typeName: TYPE_NAME[type] || ('type' + type), count: cnt, ifd: name, value: null, entryOffset: eo };
        var sz = TYPE_SIZE[type];
        if (!sz) { tag.invalid = 'unknown data type ' + type; }
        else {
          var total = sz * cnt, valOff = total <= 4 ? eo + 8 : tiffStart + dv.getUint32(eo + 8, le);
          tag.size = total; tag.offset = valOff;
          if (total > 4 && (valOff < tiffStart + 8 || valOff + total > limit)) {
            tag.invalid = 'value at offset ' + (valOff - tiffStart) + ' (' + total + ' bytes) lies outside the Exif data';
            out.warnings.push(name + ' tag ' + tag.name + ': ' + tag.invalid + '.');
          } else if (cnt === 0) {
            tag.value = (type === 2) ? '' : null;
          } else if (id === 0x927C && name === 'exif') {
            tag.value = null; tag.skipped = 'maker note (not decoded)';
            out.makerNote = { offset: valOff, length: total, tagOffset: eo };
          } else {
            var r = readValue(type, cnt, valOff, total, id);
            tag.value = r.value;
            if (r.rational) tag.rational = r.rational;
            if (r.hasMore) tag.hasMore = true;
            if (r.bytesTruncated) tag.bytesTruncated = true;
          }
        }
        ifd.tags[id] = tag; ifd.order.push(id);
      }
      var nextOff = abs + 2 + n * 12;
      if (nextOff + 4 <= limit && count <= MAX_IFD_ENTRIES) ifd.next = dv.getUint32(nextOff, le);
      out.ifds[name] = ifd;
      return ifd;
    }

    var ifd0Off = dv.getUint32(tiffStart + 4, le);
    var ifd0 = readIFD(ifd0Off, 'ifd0', 0);
    if (!ifd0) return out;
    var ptrs = [['exif', 0x8769], ['gps', 0x8825]];
    if (opts.noPointers) ptrs = [];
    ptrs.forEach(function (p) {
      var t = ifd0.tags[p[1]];
      if (t && typeof t.value === 'number' && !t.invalid) readIFD(t.value, p[0], 1);
    });
    if (out.ifds.exif) {
      var it = out.ifds.exif.tags[0xA005];
      if (it && typeof it.value === 'number' && !it.invalid) readIFD(it.value, 'interop', 2);
    }
    if (ifd0.next && !opts.noIfd1) {
      var ifd1 = readIFD(ifd0.next, 'ifd1', 1);
      if (ifd1) {
        var t = tagOf(ifd1, 0x103), jo = tagOf(ifd1, 0x201), jl = tagOf(ifd1, 0x202);
        var th = { present: true, compression: t ? t.value : null, width: (tagOf(ifd1, 0x100) || {}).value || null, height: (tagOf(ifd1, 0x101) || {}).value || null, issues: [] };
        if (jo && typeof jo.value === 'number') {
          th.kind = 'jpeg'; th.offset = tiffStart + jo.value; th.declaredLength = jl && typeof jl.value === 'number' ? jl.value : null;
          th.length = th.declaredLength;
        } else if (t && t.value === 1) {
          th.kind = 'uncompressed';
          th.issues.push('IFD1 describes an uncompressed (TIFF-style) thumbnail; it is reported but not decoded.');
        } else {
          th.kind = 'none';
        }
        out.thumbnail = th;
      }
    }
    return out;
  }

  function tagOf(ifd, id) { return ifd && ifd.tags[id] ? ifd.tags[id] : null; }

  /** Locate and validate the IFD1 JPEG thumbnail. Returns the thumbnail descriptor with offset/length, or null. */
  function resolveThumbnail(u8, tiff, fileLimit) {
    var th = tiff && tiff.thumbnail;
    if (!th || th.kind !== 'jpeg') return th || null;
    var off = th.offset, limit = tiff.limit;
    th.valid = false;
    if (off < tiff.tiffStart || off + 4 > u8.length) { th.issues.push('Thumbnail offset lies outside the file.'); return th; }
    if (!(u8[off] === 0xFF && u8[off + 1] === 0xD8)) { th.issues.push('Data at the thumbnail offset does not start with a JPEG SOI marker (FF D8).'); return th; }
    var len = th.declaredLength;
    if (len == null || len <= 0) {
      var p = off + 2, end = -1;
      while (p < limit - 1) {
        var q = u8.indexOf(0xFF, p);
        if (q < 0 || q + 1 >= limit) break;
        if (u8[q + 1] === 0xD9) { end = q + 2; break; }
        p = q + 1;
      }
      if (end < 0) { th.issues.push('Thumbnail length is not declared and no end marker was found inside the Exif segment.'); return th; }
      len = end - off;
      th.issues.push('Thumbnail length was not declared; derived from the first EOI marker.');
    }
    if (off + len > limit) {
      th.issues.push('Declared thumbnail length (' + len + ') runs past the end of the Exif segment (' + (limit - off) + ' bytes available); clamped.');
      len = limit - off;
    }
    if (off + len > u8.length) len = u8.length - off;
    var hasEOI = len >= 2 && u8[off + len - 2] === 0xFF && u8[off + len - 1] === 0xD9;
    if (!hasEOI) th.issues.push('Thumbnail data does not end with an EOI marker (FF D9); it may be truncated or its length may be wrong.');
    th.length = len; th.hasEOI = hasEOI; th.valid = true;
    return th;
  }

  // ---------- value helpers ----------
  function mainTag(exif, name) {
    if (!exif) return null;
    var order = ['ifd0', 'exif', 'gps', 'interop', 'ifd1'];
    for (var i = 0; i < order.length; i++) {
      var ifd = exif.ifds[order[i]]; if (!ifd) continue;
      var dict = TAGS[order[i]];
      for (var id in dict) if (dict[id] === name && ifd.tags[id]) return ifd.tags[id];
    }
    return null;
  }
  function getValue(exif, name) { var t = mainTag(exif, name); return t ? t.value : undefined; }

  function decodeUserComment(bytes) {
    if (!bytes || bytes.length < 8) return '';
    var head = '';
    for (var i = 0; i < 8; i++) head += String.fromCharCode(bytes[i]);
    var body = bytes.subarray(8);
    if (head.indexOf('ASCII') === 0) return stripNul(utf8OrLatin1(body)).trim();
    if (head.indexOf('UNICODE') === 0) {
      // Byte order of UserComment UNICODE is not declared; guess by NUL pattern.
      var le = body.length > 1 && body[1] === 0 && body[0] !== 0;
      return utf16(body, le).trim();
    }
    if (head.indexOf('JIS') === 0) return '[JIS-encoded text]';
    return stripNul(utf8OrLatin1(bytes)).trim();
  }

  function decodeXP(tag) {
    if (!tag || !(tag.value instanceof Uint8Array)) return '';
    return utf16(tag.value, true);
  }

  function bytesToVersion(v) {
    if (!(v instanceof Uint8Array) || v.length !== 4) return null;
    var s = '';
    for (var i = 0; i < 4; i++) s += String.fromCharCode(v[i]);
    return /^[0-9]{4}$/.test(s) ? s : null;
  }

  function sniffMakerNote(u8, mn, make) {
    if (!mn) return null;
    var head = '';
    for (var i = 0; i < Math.min(12, mn.length); i++) { var c = u8[mn.offset + i]; head += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.'; }
    var kind = null;
    var map = [['Apple iOS', 'Apple'], ['Nikon', 'Nikon'], ['OLYMP', 'Olympus'], ['SONY', 'Sony'], ['FUJIFILM', 'Fujifilm'], ['Panasonic', 'Panasonic'],
      ['LEICA', 'Leica'], ['SIGMA', 'Sigma'], ['SAMSUNG', 'Samsung'], ['Ricoh', 'Ricoh'], ['PENTAX', 'Pentax'], ['AOC', 'Pentax/Casio'], ['QVC', 'Casio'], ['EPSON', 'Epson'], ['KDK', 'Kodak']];
    for (var j = 0; j < map.length; j++) if (head.indexOf(map[j][0]) === 0) { kind = map[j][1]; break; }
    if (!kind && make) kind = String(make).replace(/\s+.*$/, '') + ' (by Make tag)';
    return { offset: mn.offset, length: mn.length, header: head, vendor: kind || 'unknown' };
  }

  function parseExifSegment(u8, seg) {
    var d = seg.dataOffset, dl = seg.dataLength;
    if (dl < 14) return { errors: ['Exif segment too short.'], warnings: [], ifds: {}, thumbnail: null };
    if (u8[d + 5] !== 0) { /* Exif\0 + non-zero padding: tolerated, flagged below */ }
    var tiffStart = d + 6, limit = d + dl;
    var res = readTiff(u8, tiffStart, limit, TAGS);
    if (u8[d + 5] !== 0) res.warnings.push('Exif header padding byte is 0x' + u8[d + 5].toString(16) + ' instead of 0x00.');
    res.segmentOffset = seg.offset;
    res.thumbnail = resolveThumbnail(u8, res, u8.length);
    var make = getValue(res, 'Make');
    res.makerNote = sniffMakerNote(u8, res.makerNote, make);
    return res;
  }

  /** Multi-Picture Format (APP2 'MPF\0'). */
  function parseMPF(u8, seg) {
    var d = seg.dataOffset, dl = seg.dataLength;
    if (dl < 12 || String.fromCharCode(u8[d], u8[d + 1], u8[d + 2]) !== 'MPF' || u8[d + 3] !== 0) return null;
    var tiffStart = d + 4;
    var t = readTiff(u8, tiffStart, d + dl, { ifd0: TAGS.mpf }, { noPointers: true, noIfd1: true });
    if (!t.ifds.ifd0) return { images: [], errors: t.errors, warnings: t.warnings };
    var ent = t.ifds.ifd0.tags[0xB002], images = [];
    var le = t.byteOrder === 'II';
    if (ent && ent.value instanceof Uint8Array) {
      var dv = new DataView(ent.value.buffer, ent.value.byteOffset, ent.value.byteLength);
      for (var i = 0; i + 16 <= ent.value.length; i += 16) {
        var attr = dv.getUint32(i, le), size = dv.getUint32(i + 4, le), off = dv.getUint32(i + 8, le);
        var typeCode = attr & 0xFFFFFF;
        var typeName = { 0x030000: 'Baseline MP primary image', 0x010001: 'Large thumbnail (VGA)', 0x010002: 'Large thumbnail (full HD)', 0x010003: 'Large thumbnail (other)', 0x020001: 'Multi-frame panorama', 0x020002: 'Multi-frame disparity', 0x020003: 'Multi-angle', 0x000000: 'Undefined' }[typeCode] || ('type 0x' + typeCode.toString(16));
        images.push({ index: images.length, attr: attr, type: typeName, size: size, offset: i === 0 ? 0 : tiffStart + off, relOffset: off });
      }
    }
    var n = t.ifds.ifd0.tags[0xB001];
    return { images: images, declaredCount: n ? n.value : null, errors: t.errors, warnings: t.warnings };
  }

  // ---------- enumerations ----------
  var ENUM = {
    Orientation: { 1: 'Normal (1)', 2: 'Mirrored horizontally (2)', 3: 'Rotated 180° (3)', 4: 'Mirrored vertically (4)', 5: 'Mirrored + rotated 90° CCW (5)', 6: 'Rotated 90° CW (6)', 7: 'Mirrored + rotated 90° CW (7)', 8: 'Rotated 90° CCW (8)' },
    ResolutionUnit: { 1: 'none', 2: 'inches', 3: 'centimetres' },
    Compression: { 1: 'Uncompressed', 6: 'JPEG (old-style)', 7: 'JPEG' },
    ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 0xFFFF: 'Uncalibrated' },
    ExposureProgram: { 0: 'Not defined', 1: 'Manual', 2: 'Normal program', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' },
    MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 4: 'Multi-spot', 5: 'Pattern', 6: 'Partial', 255: 'Other' },
    LightSource: { 0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten', 4: 'Flash', 9: 'Fine weather', 10: 'Cloudy', 11: 'Shade', 255: 'Other' },
    WhiteBalance: { 0: 'Auto', 1: 'Manual' },
    ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
    SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
    CustomRendered: { 0: 'Normal', 1: 'Custom' },
    SensingMethod: { 1: 'Not defined', 2: 'One-chip colour area', 3: 'Two-chip', 4: 'Three-chip', 5: 'Colour sequential area', 7: 'Trilinear', 8: 'Colour sequential linear' },
    FileSource: { 3: 'Digital still camera' },
    SceneType: { 1: 'Directly photographed' },
    YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
    GPSAltitudeRef: { 0: 'Above sea level', 1: 'Below sea level' },
    GPSStatus: { A: 'Measurement active', V: 'Measurement void' },
    GPSMeasureMode: { 2: '2-dimensional', 3: '3-dimensional' },
    CompositeImage: { 0: 'Unknown', 1: 'Not a composite image', 2: 'General composite image', 3: 'Composite image captured while shooting' },
    PhotometricInterpretation: { 2: 'RGB', 6: 'YCbCr' }
  };

  function flashText(v) {
    if (typeof v !== 'number') return String(v);
    var fired = !!(v & 1), ret = (v >> 1) & 3, mode = (v >> 3) & 3, none = !!(v & 32), red = !!(v & 64);
    var parts = [fired ? 'Flash fired' : 'Flash did not fire'];
    if (mode === 1) parts.push('compulsory'); else if (mode === 2) parts.push('suppressed'); else if (mode === 3) parts.push('auto');
    if (ret === 2) parts.push('no strobe return'); else if (ret === 3) parts.push('strobe return detected');
    if (none) parts.push('no flash function');
    if (red) parts.push('red-eye reduction');
    return parts.join(', ');
  }

  function fmtNum(x) {
    if (x === null || x === undefined || Number.isNaN(x)) return '—';
    if (typeof x !== 'number') return String(x);
    if (Number.isInteger(x)) return String(x);
    var a = Math.abs(x);
    return String(a >= 100 ? Math.round(x * 100) / 100 : Math.round(x * 10000) / 10000);
  }

  /** Human-readable rendering of a tag, used by the UI and the report. */
  function display(tag) {
    if (!tag) return '';
    if (tag.invalid) return '(unreadable: ' + tag.invalid + ')';
    if (tag.skipped) return '(' + tag.skipped + ', ' + tag.count + ' bytes)';
    var name = tag.name, v = tag.value, e = ENUM[name];
    if (name === 'Flash') return flashText(v) + ' (' + v + ')';
    if (e && (typeof v === 'number' || typeof v === 'string') && e[v] !== undefined) return e[v] + (/\(\d+\)$/.test(e[v]) ? '' : ' (' + v + ')');
    if (name === 'UserComment') return decodeUserComment(v);
    if (/^XP/.test(name)) return decodeXP(tag);
    if (name === 'ExifVersion' || name === 'FlashpixVersion') { var ver = bytesToVersion(v); return ver ? (ver.slice(0, 2) + '.' + ver.slice(2)).replace(/^0/, '') : '—'; }
    if (name === 'ExposureTime' && typeof v === 'number') return v >= 1 ? fmtNum(v) + ' s' : '1/' + Math.round(1 / v) + ' s';
    if (name === 'FNumber' && typeof v === 'number') return 'f/' + fmtNum(v);
    if (name === 'FocalLength' && typeof v === 'number') return fmtNum(v) + ' mm';
    if (name === 'FocalLengthIn35mmFilm' && typeof v === 'number') return fmtNum(v) + ' mm';
    if (name === 'ISOSpeedRatings') return String(v);
    if (v instanceof Uint8Array) {
      var s = '', n = Math.min(v.length, 32);
      for (var i = 0; i < n; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16) + ' ';
      return '[' + tag.typeName + ' ' + tag.count + ' bytes] ' + s.trim() + (v.length > n || tag.bytesTruncated ? ' …' : '');
    }
    if (Array.isArray(v)) {
      var shown = v.slice(0, 12).map(fmtNum).join(', ');
      return shown + (v.length > 12 ? ', … (' + v.length + ' values)' : '');
    }
    if (typeof v === 'number') return fmtNum(v);
    if (v === null || v === undefined) return tag.rational && tag.rational[0] && tag.rational[0][1] === 0 ? '(undefined: denominator 0)' : '—';
    return String(v);
  }

  QPI.exif = {
    parseExifSegment: parseExifSegment, parseMPF: parseMPF, readTiff: readTiff, TAGS: TAGS, ENUM: ENUM,
    getValue: getValue, getTag: mainTag, display: display, decodeUserComment: decodeUserComment, decodeXP: decodeXP,
    bytesToVersion: bytesToVersion, resolveThumbnail: resolveThumbnail, flashText: flashText, utf16: utf16
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.exif;
})(typeof window !== 'undefined' ? window : globalThis);
