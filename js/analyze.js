/*
 * Quanttum Photo Inspector — analysis engine (vanilla JS, no dependencies)
 *
 * inspect(bytes, opts)        -> structured report (no pixel decoding)
 * addComparison(report, ...)  -> adds thumbnail-vs-main findings after the UI has decoded pixels
 *
 * Findings are INDICATORS for an examiner, never verdicts of authenticity:
 *   flag  = contradiction or strong trace worth explaining
 *   note  = trace that is common in edited files but also has innocent causes
 *   info  = neutral technical observation
 *   ok    = checked, nothing found (does not prove the file is unmodified)
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};
  var VERSION = '0.1.0';

  var LIMITS = [
    'JPEG files only. PNG, HEIC/HEIF, WebP, TIFF and RAW files are recognised but not analysed.',
    'Metadata is a set of claims stored in the file. Anyone can rewrite it with free tools, so it is a lead for an examiner, not proof of origin, time or place.',
    'A clean result proves nothing: most editors and messaging apps either regenerate the embedded thumbnail or strip the metadata entirely.',
    'The thumbnail comparison is heuristic. It models axis-aligned crops that keep the aspect ratio, EXIF rotations, letterbox bars and brightness/contrast changes. It does not model arbitrary-angle rotation, perspective changes or heavy filters, and thumbnails (often 160×120) can only reveal large changes.',
    'Crops that remove less than about 4% of the frame on every side, and retouching smaller than about 1% of the frame, are below the resolution of a typical thumbnail.',
    'Maker notes (vendor-specific data) are located but not decoded. Use exiftool for those.',
    'No pixel-level forensics is performed (no error-level analysis, double-compression, sensor-noise or clone detection).',
    'C2PA / Content Credentials manifests are detected but not cryptographically validated.',
    'Educational and triage software. It has not been validated for casework; confirm findings with accredited tools and procedures before relying on them.'
  ];

  var BRANDS = ['Canon', 'Nikon', 'Sony', 'Fujifilm', 'Olympus', 'Panasonic', 'Pentax', 'Leica', 'Samsung', 'Apple', 'Google', 'Huawei', 'Xiaomi', 'OnePlus', 'Motorola', 'Ricoh', 'Kodak', 'Casio', 'Sigma', 'Hasselblad', 'GoPro', 'DJI'];

  // ---------- small helpers ----------
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  /** EXIF "YYYY:MM:DD HH:MM:SS" -> {valid, naiveMs, text, issue} ; naiveMs treats the clock reading as UTC (for differences only). */
  function parseExifDate(s) {
    if (typeof s !== 'string') return { valid: false, issue: 'missing' };
    var t = s.replace(/\0/g, '').trim();
    if (!t) return { valid: false, issue: 'empty' };
    var m = /^(\d{4})[:\-\/](\d{2})[:\-\/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(t);
    if (!m) {
      var m2 = /^(\d{4}):(\d{2}):(\d{2})$/.exec(t);
      if (m2 && +m2[2] >= 1 && +m2[2] <= 12) return { valid: true, dateOnly: true, naiveMs: Date.UTC(+m2[1], +m2[2] - 1, +m2[3]), text: m2[1] + '-' + m2[2] + '-' + m2[3] };
      return { valid: false, issue: 'unrecognised format', raw: t };
    }
    var y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5], ss = +m[6];
    if (y === 0 || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) return { valid: false, issue: 'placeholder or out-of-range value', raw: t };
    var ms = Date.UTC(y, mo - 1, d, hh, mi, ss);
    var dd = new Date(ms);
    if (dd.getUTCMonth() !== mo - 1) return { valid: false, issue: 'impossible calendar date', raw: t };
    var frac = m[7] ? parseFloat('0.' + m[7]) * 1000 : 0;
    return { valid: true, naiveMs: ms + frac, text: fmtDate(ms) + (m[7] ? '.' + m[7] : ''), nonStandardFormat: !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(t) };
  }

  function parseOffset(s) {
    if (typeof s !== 'string') return null;
    var m = /^([+\-])(\d{2}):?(\d{2})$/.exec(s.trim());
    if (!m) return /^Z$/i.test(s.trim()) ? 0 : null;
    var v = +m[2] * 60 + +m[3];
    return m[1] === '-' ? -v : v;
  }

  function parseIso(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+\-]\d{2}:?\d{2})?$/.exec(s.trim());
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    if (m[7]) ms += parseFloat('0.' + m[7]) * 1000;
    return { naiveMs: ms, offsetMin: m[8] ? parseOffset(m[8]) : null, hasTime: !!m[4], text: fmtDate(ms) + (m[8] ? ' ' + m[8] : '') };
  }

  function dms(v, pos, neg) {
    var hemi = v >= 0 ? pos : neg, a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
    return d + '° ' + m + '′ ' + s.toFixed(2) + '″ ' + hemi;
  }

  function haversine(la1, lo1, la2, lo2) {
    var R = 6371000, rad = Math.PI / 180, dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function ascii(u8, s, e) { var r = ''; for (var i = s; i < e && i < u8.length; i++) r += String.fromCharCode(u8[i]); return r; }

  // ---------- software classification ----------
  var SW_RULES = [
    ['ai', /dall[\s\-·.]?e|midjourney|stable[\s\-]?diffusion|adobe firefly|\bfirefly\b|imagen|leonardo\.?ai|comfyui|automatic1111|runway|nightcafe|dreamstudio|bing image creator|ideogram|\bflux\b|\bsora\b|gemini|openai|nano banana|stability\.?ai|synthid/i, 'AI image generator or AI-assisted tool'],
    ['editor', /photoshop|lightroom|\bgimp\b|paint\.net|pixelmator|affinity|capture one|snapseed|picsart|canva|fotor|photoscape|irfanview|acdsee|paintshop|corel|luminar|dxo|on1 |polarr|vsco|facetune|lightx|pixlr|photopea|krita|xnview|picasa|windows photo|microsoft photos|apple photos|google photos|instagram|photodirector|paint\b|preview\.app|adobe/i, 'Image editor / photo software'],
    ['raw', /darktable|rawtherapee|dcraw|digital photo professional|nikon capture|nx studio|silkypix|camera raw|dng converter|photo ninja|raw power/i, 'RAW converter'],
    ['library', /imagemagick|graphicsmagick|libjpeg|\bpil\b|pillow|gd-jpeg|gd library|exiftool|jhead|jpegtran|mozjpeg|jpegoptim|jpegmini|tinypng|optimizilla|ffmpeg|opencv|skia|java|\.net|system\.drawing|libvips|\bvips\b|sharp|php|imagick|kakadu|piexif/i, 'Library / command-line tool'],
    ['firmware', /^(v|ver\.?|version)?\s*\d+(\.\d+)+\s*$|\bv\d+(\.\d+)+\b|\bver\.?\s?\d|firmware|^hdr\+?$|^\d+\.\d+(\.\d+)*$/i, 'Looks like camera firmware / OS version']
  ];

  function classifySoftware(str) {
    if (typeof str !== 'string' || !str.trim()) return { kind: 'empty', label: '' };
    for (var i = 0; i < SW_RULES.length; i++) if (SW_RULES[i][1].test(str)) return { kind: SW_RULES[i][0], label: SW_RULES[i][2] };
    return { kind: 'unknown', label: 'Unrecognised (may be camera firmware or a tool)' };
  }

  // ---------- main ----------
  function inspect(u8, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var R = QPI, rep = {
      tool: { name: 'Quanttum Photo Inspector', version: VERSION },
      file: { name: opts.fileName || '', size: u8.length, lastModified: opts.lastModified || null, sha256: '', md5: '' },
      jpeg: null, exif: null, exifRows: [], xmp: null, xmpInfo: null, irb: null, iptc: null, icc: null, c2pa: null, mpf: null,
      embedded: [], summary: { device: {}, capture: {}, gps: null, timestamps: [], software: [], dimensions: {} }, findings: [], comparisons: [], limits: LIMITS, errors: []
    };
    var F = rep.findings;
    function add(sev, cat, title, detail, evidence) { F.push({ id: F.length + 1, severity: sev, category: cat, title: title, detail: detail || '', evidence: evidence || [] }); }

    rep.file.sha256 = R.hash.sha256(u8); rep.file.md5 = R.hash.md5(u8);

    var sig = ascii(u8, 0, 12);
    var jp = R.jpeg.parse(u8);
    rep.jpeg = jp;
    if (!jp.frame && !(u8[0] === 0xFF && u8[1] === 0xD8)) {
      var kind = 'unknown';
      if (u8[0] === 0x89 && sig.indexOf('PNG') === 1) kind = 'PNG'; else if (sig.indexOf('ftyp') === 4) kind = /heic|heix|mif1|hevc|avif/.test(ascii(u8, 8, 12)) ? 'HEIC/HEIF/AVIF' : 'MP4/MOV';
      else if (sig.indexOf('RIFF') === 0) kind = 'RIFF/WebP'; else if (sig.indexOf('GIF8') === 0) kind = 'GIF'; else if (sig.slice(0, 2) === 'II' || sig.slice(0, 2) === 'MM') kind = 'TIFF/RAW';
      rep.errors.push(jp.errors[0] || 'Not a JPEG.');
      add('flag', 'structure', 'Not a JPEG file', 'This file does not start with a JPEG header (detected: ' + kind + '). Only JPEG files are analysed. ' + (kind === 'HEIC/HEIF/AVIF' ? 'iPhone HEIC photos must be exported as JPEG first, which may alter the metadata.' : ''), ['First bytes: ' + Array.prototype.slice.call(u8.subarray(0, 12)).map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(' ')]);
      return rep;
    }
    jp.errors.forEach(function (e) { rep.errors.push(e); add('flag', 'structure', 'JPEG structure error', e); });
    jp.warnings.forEach(function (w) { add('note', 'structure', 'JPEG structure warning', w); });

    var segs = jp.segments;
    var exifSeg = null, xmpSegs = [], extXmp = [], irbSeg = null, mpfSeg = null, exifCount = 0;
    segs.forEach(function (s) {
      if (s.marker === 0xE1 && s.id === 'Exif') { exifCount++; if (!exifSeg) exifSeg = s; }
      else if (s.marker === 0xE1 && s.id.indexOf('http://ns.adobe.com/xap/1.0/') === 0) xmpSegs.push(s);
      else if (s.marker === 0xE1 && s.id.indexOf('http://ns.adobe.com/xmp/extension/') === 0) extXmp.push(s);
      else if (s.marker === 0xED && s.id.indexOf('Photoshop 3.0') === 0 && !irbSeg) irbSeg = s;
      else if (s.marker === 0xE2 && s.id === 'MPF' && !mpfSeg) mpfSeg = s;
    });
    if (exifCount > 1) add('note', 'structure', 'Multiple Exif segments', exifCount + ' APP1 Exif segments are present; only the first is read. Some tools append a second Exif block when re-saving.', []);

    // ---------- EXIF ----------
    var ex = null;
    if (exifSeg) {
      ex = R.exif.parseExifSegment(u8, exifSeg);
      rep.exif = ex;
      ex.errors.forEach(function (e) { add('flag', 'structure', 'EXIF structure error', e); });
      ex.warnings.forEach(function (w) { add('note', 'structure', 'EXIF structure warning', w); });
      rep.exifRows = flattenExif(ex);
    }
    function ev(name) { return ex ? R.exif.getValue(ex, name) : undefined; }
    function evText(name) { var t = ex ? R.exif.getTag(ex, name) : null; return t ? R.exif.display(t) : ''; }
    var S = rep.summary;

    var frame = jp.frame;
    S.dimensions = { width: frame ? frame.width : null, height: frame ? frame.height : null };

    // ---------- XMP / IRB / IPTC / ICC / C2PA ----------
    var xi = null;
    if (xmpSegs.length) {
      var packet = R.xmp.extractPacket(u8, xmpSegs[0]);
      rep.xmp = { size: xmpSegs[0].dataLength, segments: xmpSegs.length, extended: extXmp.length > 0 };
      xi = R.xmp.parseXmp(packet);
      rep.xmpInfo = xi;
      if (xi.parseTruncated) add('note', 'structure', 'XMP parsing stopped early', 'The XMP packet is unusually large or deeply nested; only part of it was read.');
      if (extXmp.length) add('info', 'structure', 'Extended XMP present', 'The file has ' + extXmp.length + ' extended XMP segment(s) (more than 64 KB of XMP, typically editing history). They are listed but not parsed.');
    }
    var irb = irbSeg ? R.irb.parseIRB(u8, irbSeg) : null;
    rep.irb = irb;
    if (irb) { rep.iptc = irb.iptc; irb.warnings.forEach(function (w) { add('note', 'structure', 'Photoshop resource warning', w); }); }
    rep.icc = R.irb.collectICC(u8, segs);
    rep.c2pa = R.irb.detectC2PA(u8, segs);
    if (mpfSeg) rep.mpf = R.exif.parseMPF(u8, mpfSeg);

    // ---------- device ----------
    var D = S.device;
    D.make = ev('Make') || (xi && xi.props['tiff:Make']) || ''; D.model = ev('Model') || (xi && xi.props['tiff:Model']) || '';
    D.lensMake = ev('LensMake') || ''; D.lensModel = ev('LensModel') || (xi && xi.props['aux:Lens']) || '';
    D.bodySerial = ev('BodySerialNumber') || (xi && xi.props['aux:SerialNumber']) || ''; D.lensSerial = ev('LensSerialNumber') || '';
    D.owner = ev('CameraOwnerName') || ''; D.hostComputer = ev('HostComputer') || ''; D.artist = ev('Artist') || ''; D.copyright = ev('Copyright') || '';
    D.software = ev('Software') || '';
    D.description = ev('ImageDescription') || ''; D.userComment = ex && R.exif.getTag(ex, 'UserComment') ? R.exif.decodeUserComment(ev('UserComment')) : '';
    D.xpAuthor = ex ? R.exif.decodeXP(R.exif.getTag(ex, 'XPAuthor')) : ''; D.xpComment = ex ? R.exif.decodeXP(R.exif.getTag(ex, 'XPComment')) : '';
    D.xpTitle = ex ? R.exif.decodeXP(R.exif.getTag(ex, 'XPTitle')) : ''; D.xpKeywords = ex ? R.exif.decodeXP(R.exif.getTag(ex, 'XPKeywords')) : '';
    D.orientation = ev('Orientation') || null;
    var C = S.capture;
    C.exposureTime = evText('ExposureTime'); C.fNumber = evText('FNumber'); C.iso = evText('ISOSpeedRatings'); C.focalLength = evText('FocalLength');
    C.focalLength35 = evText('FocalLengthIn35mmFilm'); C.flash = evText('Flash'); C.exposureProgram = evText('ExposureProgram'); C.whiteBalance = evText('WhiteBalance');
    C.meteringMode = evText('MeteringMode'); C.colorSpace = evText('ColorSpace'); C.exifVersion = evText('ExifVersion'); C.compositeImage = evText('CompositeImage');
    C.imageUniqueID = ev('ImageUniqueID') || '';

    if (ex) {
      if (!D.make && !D.model) add('note', 'device', 'No camera make or model', 'The EXIF block has no Make or Model. Photos from cameras and phones normally carry them; they are often missing after editing, export or social-media processing.');
      else add('ok', 'device', 'Device identified in EXIF', [D.make, D.model].filter(Boolean).join(' ') + (D.lensModel ? ' · ' + D.lensModel : ''), []);
      if (D.bodySerial) add('info', 'device', 'Camera body serial number present', 'A body serial number can link several photos to the same physical camera. It is shown in this report as written in the file.', ['BodySerialNumber: ' + D.bodySerial]);
      var mk = String(D.make).toLowerCase(), md = String(D.model).toLowerCase();
      BRANDS.forEach(function (b) {
        var bl = b.toLowerCase();
        if (md && new RegExp('(^|\\W)' + bl + '(\\W|$)').test(md) && mk && mk.indexOf(bl) < 0) {
          var other = BRANDS.filter(function (b2) { return mk.indexOf(b2.toLowerCase()) >= 0; })[0];
          if (other && other !== b) add('flag', 'device', 'Make and Model name different brands', 'Make says "' + D.make + '" but Model says "' + D.model + '". This combination does not occur on genuine cameras and suggests hand-edited metadata.', ['Make: ' + D.make, 'Model: ' + D.model]);
        }
      });
      if (ex.makerNote) {
        var v = ex.makerNote.vendor || '', hdr = ex.makerNote.header || '';
        var sigMap = [['Apple iOS', 'apple'], ['Nikon', 'nikon'], ['OLYMP', 'olympus'], ['SONY', 'sony'], ['FUJIFILM', 'fujifilm'], ['Panasonic', 'panasonic'], ['LEICA', 'leica'], ['SIGMA', 'sigma'], ['SAMSUNG', 'samsung'], ['Ricoh', 'ricoh'], ['PENTAX', 'pentax']];
        var hit = null;
        sigMap.forEach(function (p) { if (hdr.indexOf(p[0]) === 0) hit = p[1]; });
        if (hit && mk && mk.indexOf(hit) < 0 && !(hit === 'olympus' && /om digital|olympus/.test(mk))) {
          add('flag', 'device', 'Maker note does not match the Make tag', 'The maker-note header identifies ' + v + ', but the Make tag says "' + D.make + '". Editing the Make/Model tags without rewriting the maker note is a common spoofing mistake.', ['MakerNote header: ' + hdr, 'Make: ' + D.make]);
        } else if (hit && !mk) {
          add('note', 'device', 'Maker note present but Make tag missing', 'A ' + v + ' maker note is present, yet the Make tag is empty or missing, which can happen when metadata was partly stripped.', []);
        }
        add('info', 'device', 'Maker note present (not decoded)', ex.makerNote.length + ' bytes of vendor-specific data (' + v + '). This tool does not decode maker notes; use exiftool to read them.', []);
      }
      if (D.xpAuthor || D.xpComment || D.xpTitle || D.xpKeywords) {
        add('note', 'software', 'Windows Explorer property fields present', 'XP* tags (Title/Author/Comment/Keywords) are written when a user edits file properties in Windows Explorer, so they are a trace of manual editing after capture.', [D.xpTitle && 'XPTitle: ' + D.xpTitle, D.xpAuthor && 'XPAuthor: ' + D.xpAuthor, D.xpComment && 'XPComment: ' + D.xpComment, D.xpKeywords && 'XPKeywords: ' + D.xpKeywords].filter(Boolean));
      }
      if (C.compositeImage && ev('CompositeImage') && ev('CompositeImage') !== 1) {
        add('note', 'software', 'EXIF marks the image as a composite', 'CompositeImage = ' + C.compositeImage + '. Cameras set this for in-camera composites (e.g. HDR or live composite); software may set it for merged exposures.', []);
      }
    }

    // ---------- dimension consistency ----------
    if (ex && frame && frame.width && frame.height) {
      var px = ev('PixelXDimension'), py = ev('PixelYDimension');
      if (typeof px === 'number' && typeof py === 'number' && (px !== frame.width || py !== frame.height)) {
        var swapped = (px === frame.height && py === frame.width);
        var rEx = px / py, rJ = frame.width / frame.height, aspectDiff = Math.abs(rEx / rJ - 1);
        if (swapped) add('info', 'consistency', 'EXIF dimensions are swapped relative to the JPEG', 'EXIF PixelXDimension × PixelYDimension is ' + px + '×' + py + ' but the JPEG is ' + frame.width + '×' + frame.height + ' (width and height swapped, usually a display-orientation convention).', []);
        else if (aspectDiff > 0.01) add('flag', 'consistency', 'EXIF dimensions disagree with the image (different shape)', 'EXIF records ' + px + '×' + py + ' (' + rEx.toFixed(3) + ':1) but the JPEG is ' + frame.width + '×' + frame.height + ' (' + rJ.toFixed(3) + ':1). The picture has a different aspect ratio than at capture, which is consistent with cropping by software that kept the old EXIF.', ['EXIF: ' + px + '×' + py, 'JPEG: ' + frame.width + '×' + frame.height]);
        else add('note', 'consistency', 'EXIF dimensions disagree with the image (same shape)', 'EXIF records ' + px + '×' + py + ' but the JPEG is ' + frame.width + '×' + frame.height + '. The proportions match, which is consistent with the image having been resized and re-saved with the old EXIF kept.', ['EXIF: ' + px + '×' + py, 'JPEG: ' + frame.width + '×' + frame.height]);
      } else if (typeof px === 'number' && typeof py === 'number') {
        add('ok', 'consistency', 'EXIF dimensions match the JPEG', frame.width + '×' + frame.height, []);
      }
    }

    // ---------- GPS ----------
    analyseGps(rep, ex, xi, add);

    // ---------- timestamps ----------
    analyseTimes(rep, ex, xi, add, now);

    // ---------- software / edit traces ----------
    analyseSoftware(rep, ex, xi, irb, add);

    // ---------- structure ----------
    analyseStructure(rep, ex, add);

    // ---------- embedded images (thumbnails & previews) ----------
    collectEmbedded(u8, rep, ex, exifSeg, irb, mpfSeg, add);

    return rep;
  }

  function flattenExif(ex) {
    var rows = [], names = ['ifd0', 'exif', 'gps', 'interop', 'ifd1'], labels = { ifd0: 'IFD0 (main image)', exif: 'Exif', gps: 'GPS', interop: 'Interoperability', ifd1: 'IFD1 (thumbnail)' };
    names.forEach(function (n) {
      var ifd = ex.ifds[n]; if (!ifd) return;
      ifd.order.forEach(function (id) {
        var t = ifd.tags[id], raw = t.value;
        if (raw instanceof Uint8Array) raw = Array.prototype.slice.call(raw.subarray(0, 64));
        rows.push({ ifd: n, ifdLabel: labels[n], id: t.id, idHex: '0x' + t.id.toString(16).toUpperCase().padStart(4, '0'), name: t.name, known: t.known, type: t.typeName, count: t.count, display: R_display(t), raw: raw, rational: t.rational || null, invalid: t.invalid || null, offset: t.offset });
      });
    });
    return rows;
  }
  function R_display(t) { return QPI.exif.display(t); }

  // ---------- GPS ----------
  function ratToDeg(v) {
    if (!Array.isArray(v) || v.length < 2) return null;
    var d = v[0], m = v[1], s = v.length > 2 ? v[2] : 0;
    if (d === null || m === null || s === null) return null;
    return { value: d + m / 60 + s / 3600, d: d, m: m, s: s };
  }

  function analyseGps(rep, ex, xi, add) {
    var gps = { present: false, issues: [] };
    var ifd = ex && ex.ifds.gps;
    function gv(name) { return ifd ? QPI.exif.getValue({ ifds: { gps: ifd } }, name) : undefined; }
    if (ifd) {
      gps.present = true;
      var latRef = gv('GPSLatitudeRef'), lonRef = gv('GPSLongitudeRef'), lat = ratToDeg(gv('GPSLatitude')), lon = ratToDeg(gv('GPSLongitude'));
      var hasCoords = !!(lat || lon);
      if (!hasCoords) {
        add('info', 'gps', 'GPS block without coordinates', 'The file has a GPS directory but no usable latitude/longitude (it may have been partly stripped or written by a device with no fix).', ['Tags present: ' + ifd.order.map(function (i) { return ifd.tags[i].name; }).join(', ')]);
      } else {
        if (!lat || !lon) gps.issues.push('Only one of latitude/longitude is usable.');
        if (!/^[NS]$/i.test(String(latRef || ''))) gps.issues.push('GPSLatitudeRef is missing or invalid ("' + (latRef || '') + '"); hemisphere unknown.');
        if (!/^[EW]$/i.test(String(lonRef || ''))) gps.issues.push('GPSLongitudeRef is missing or invalid ("' + (lonRef || '') + '"); hemisphere unknown.');
        if (lat && (lat.m >= 60 || lat.s >= 60 || lat.d > 90 || lat.d < 0)) gps.issues.push('Latitude components are out of range.');
        if (lon && (lon.m >= 60 || lon.s >= 60 || lon.d > 180 || lon.d < 0)) gps.issues.push('Longitude components are out of range.');
        var latOk = !!lat && /^[NS]$/i.test(String(latRef || '')) && lat.m < 60 && lat.s < 60 && lat.d <= 90 && lat.d >= 0;
        var lonOk = !!lon && /^[EW]$/i.test(String(lonRef || '')) && lon.m < 60 && lon.s < 60 && lon.d <= 180 && lon.d >= 0;
        if (latOk && lonOk) {
          gps.lat = lat.value * (String(latRef).toUpperCase() === 'S' ? -1 : 1);
          gps.lon = lon.value * (String(lonRef).toUpperCase() === 'W' ? -1 : 1);
          gps.latDMS = dms(gps.lat, 'N', 'S'); gps.lonDMS = dms(gps.lon, 'E', 'W');
          if (gps.lat === 0 && gps.lon === 0) gps.issues.push('Coordinates are exactly 0°, 0° ("Null Island"), a common placeholder for "no GPS fix".');
        } else if (lat || lon) {
          gps.issues.push('The position was not interpreted because it is not reliable.');
        }
      }
      var alt = gv('GPSAltitude'), altRef = gv('GPSAltitudeRef');
      if (typeof alt === 'number') {
        gps.altitude = alt * (altRef === 1 ? -1 : 1); gps.altitudeText = QPI.exif.getTag({ ifds: { gps: ifd } }, 'GPSAltitudeRef') ? (Math.abs(alt).toFixed(1) + ' m ' + (altRef === 1 ? 'below' : 'above') + ' sea level') : alt.toFixed(1) + ' m';
        if (gps.altitude > 9000 || gps.altitude < -500) gps.issues.push('Altitude (' + gps.altitude.toFixed(0) + ' m) is implausible for a photograph.');
      }
      gps.status = gv('GPSStatus'); gps.measureMode = gv('GPSMeasureMode'); gps.dop = gv('GPSDOP'); gps.datum = gv('GPSMapDatum') || ''; gps.satellites = gv('GPSSatellites') || '';
      gps.speed = gv('GPSSpeed'); gps.speedRef = gv('GPSSpeedRef'); gps.direction = gv('GPSImgDirection'); gps.directionRef = gv('GPSImgDirectionRef'); gps.hError = gv('GPSHPositioningError');
      var pm = QPI.exif.getTag({ ifds: { gps: ifd } }, 'GPSProcessingMethod');
      gps.processingMethod = pm && pm.value instanceof Uint8Array ? QPI.exif.decodeUserComment(pm.value) : (pm ? String(pm.value) : '');
      gps.area = (function () { var t = QPI.exif.getTag({ ifds: { gps: ifd } }, 'GPSAreaInformation'); return t && t.value instanceof Uint8Array ? QPI.exif.decodeUserComment(t.value) : ''; })();
      if (gps.status === 'V') gps.issues.push('GPSStatus is "V" (measurement void): the receiver reported no valid fix.');
      if (typeof gps.dop === 'number' && gps.dop > 20) gps.issues.push('GPS DOP is ' + gps.dop + ' (above 20 means very poor accuracy).');
      if (gps.datum && !/wgs[\s\-]?84/i.test(gps.datum)) gps.issues.push('Map datum is "' + gps.datum + '" rather than WGS-84.');
      if (/manual/i.test(gps.processingMethod)) gps.issues.push('GPSProcessingMethod is "' + gps.processingMethod + '": the location was entered by hand, not measured.');
      if (gps.lat !== undefined && gps.lon !== undefined && gps.issues.length === 0) {
        add('info', 'gps', 'GPS position recorded', gps.latDMS + ', ' + gps.lonDMS + (gps.altitudeText ? ' · ' + gps.altitudeText : ''), ['Decimal: ' + gps.lat.toFixed(6) + ', ' + gps.lon.toFixed(6), gps.processingMethod && ('Method: ' + gps.processingMethod)].filter(Boolean));
      } else if (gps.lat !== undefined) {
        add('note', 'gps', 'GPS position recorded, with irregularities', gps.latDMS + ', ' + gps.lonDMS + '. ' + gps.issues.join(' '), gps.issues);
      } else if (gps.issues.length) {
        add('note', 'gps', 'GPS data is incomplete or invalid', gps.issues.join(' '), []);
      }
      if (/network|cell|wlan|wifi|fused/i.test(gps.processingMethod)) add('info', 'gps', 'Location came from network/fused positioning', 'GPSProcessingMethod is "' + gps.processingMethod + '": the position may be only as accurate as the cell/Wi-Fi source (often tens to hundreds of metres).', []);
      // XMP cross-check
      if (xi && xi.gps && gps.lat !== undefined && xi.gps.lat !== null && xi.gps.lon !== null) {
        var dist = haversine(gps.lat, gps.lon, xi.gps.lat, xi.gps.lon);
        if (dist > 100) add('flag', 'consistency', 'EXIF GPS and XMP GPS disagree', 'The two copies of the location are ' + (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m') + ' apart. A tool that edits only one of the two blocks leaves this signature.', ['EXIF: ' + gps.lat.toFixed(6) + ', ' + gps.lon.toFixed(6), 'XMP: ' + xi.gps.lat.toFixed(6) + ', ' + xi.gps.lon.toFixed(6)]);
      }
    } else if (xi && xi.gps) {
      gps.present = true; gps.lat = xi.gps.lat; gps.lon = xi.gps.lon; gps.source = 'XMP';
      if (gps.lat !== null && gps.lon !== null) { gps.latDMS = dms(gps.lat, 'N', 'S'); gps.lonDMS = dms(gps.lon, 'E', 'W'); }
      add('note', 'gps', 'GPS only in XMP, not in EXIF', 'A location is stored in the XMP packet but the EXIF GPS block is absent. Some editors move or rewrite location data this way.', ['XMP: ' + gps.lat + ', ' + gps.lon]);
    } else if (ex) {
      add('info', 'gps', 'No GPS data', 'The file contains no location. Cameras without GPS, privacy settings, and metadata-stripping all produce this.', []);
    }
    rep.summary.gps = gps;
  }

  // ---------- timestamps ----------
  function analyseTimes(rep, ex, xi, add, now) {
    function ev(name) { return ex ? QPI.exif.getValue(ex, name) : undefined; }
    var T = rep.summary.timestamps;
    function push(key, label, source, raw, parsedObj, extra) {
      if (raw === undefined || raw === null || raw === '') return null;
      var o = { key: key, label: label, source: source, raw: String(raw), valid: !!(parsedObj && parsedObj.valid !== false), naiveMs: parsedObj ? parsedObj.naiveMs : null, text: parsedObj && parsedObj.text ? parsedObj.text : String(raw), offsetMin: extra && extra.offsetMin !== undefined ? extra.offsetMin : null, offsetText: extra && extra.offsetText || '', issue: parsedObj && parsedObj.issue || '', subsec: extra && extra.subsec || '' };
      T.push(o); return o;
    }
    function exifDate(key, label, tag, subTag, offTag) {
      var raw = ev(tag); if (raw === undefined || raw === '') return null;
      var p = parseExifDate(raw), sub = ev(subTag), off = ev(offTag);
      var o = push(key, label, 'EXIF', raw, p, { subsec: sub ? String(sub).trim() : '', offsetMin: parseOffset(off), offsetText: off || '' });
      if (o && !p.valid) add('note', 'time', label + ' is not a valid date', 'The value "' + String(raw).replace(/[^\x20-\x7e]/g, '?') + '" is ' + (p.issue || 'invalid') + '. Placeholder dates are written by some editors and by cameras whose clock was never set.', []);
      if (o && p.valid && p.nonStandardFormat) add('info', 'time', label + ' uses a non-standard format', 'EXIF dates should read YYYY:MM:DD HH:MM:SS; this one reads "' + raw + '", which suggests the value was written by software rather than a camera.', []);
      return o;
    }
    var dto = exifDate('dto', 'DateTimeOriginal (capture)', 'DateTimeOriginal', 'SubSecTimeOriginal', 'OffsetTimeOriginal');
    var dtd = exifDate('dtd', 'DateTimeDigitized', 'DateTimeDigitized', 'SubSecTimeDigitized', 'OffsetTimeDigitized');
    var dtm = exifDate('dtm', 'DateTime (last modified by software)', 'DateTime', 'SubSecTime', 'OffsetTime');
    // GPS UTC
    var gpsUtc = null, gd = null, gt = null;
    if (ex && ex.ifds.gps) {
      gd = QPI.exif.getValue({ ifds: { gps: ex.ifds.gps } }, 'GPSDateStamp'); gt = QPI.exif.getValue({ ifds: { gps: ex.ifds.gps } }, 'GPSTimeStamp');
      if (typeof gd === 'string' && Array.isArray(gt) && gt.length === 3 && gt.every(function (x) { return typeof x === 'number'; })) {
        var m = /^(\d{4}):(\d{2}):(\d{2})$/.exec(gd.trim());
        if (m) {
          var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0) + ((gt[0] * 60 + gt[1]) * 60 + gt[2]) * 1000;
          gpsUtc = ms; push('gps', 'GPS date/time (UTC)', 'EXIF GPS', gd + ' ' + gt.map(function (x) { return Math.round(x * 100) / 100; }).join(':'), { valid: true, naiveMs: ms, text: fmtDate(ms) + ' UTC' });
        }
      }
    }
    if (xi) {
      [['xmp:CreateDate', 'XMP CreateDate'], ['xmp:ModifyDate', 'XMP ModifyDate'], ['xmp:MetadataDate', 'XMP MetadataDate'], ['photoshop:DateCreated', 'Photoshop DateCreated'], ['exif:DateTimeOriginal', 'XMP exif:DateTimeOriginal'], ['tiff:DateTime', 'XMP tiff:DateTime']].forEach(function (p) {
        var v = xi.props[p[0]]; if (typeof v !== 'string') return;
        var pi = parseIso(v); push('xmp:' + p[0], p[1], 'XMP', v, pi ? { valid: true, naiveMs: pi.naiveMs, text: pi.text } : { valid: false, issue: 'unrecognised format' }, { offsetMin: pi ? pi.offsetMin : null });
      });
      (xi.history || []).forEach(function (h, i) {
        if (!h.when) return; var pi = parseIso(h.when);
        push('hist' + i, 'XMP history: ' + (h.action || 'event') + (h.softwareAgent ? ' (' + h.softwareAgent + ')' : ''), 'XMP', h.when, pi ? { valid: true, naiveMs: pi.naiveMs, text: pi.text } : { valid: false, issue: 'unrecognised' }, { offsetMin: pi ? pi.offsetMin : null });
      });
    }
    if (rep.iptc) {
      var f = rep.iptc.fields, dc = f['2:55'] && f['2:55'].values[0], tc = f['2:60'] && f['2:60'].values[0];
      if (dc) push('iptc', 'IPTC DateCreated' + (tc ? ' + TimeCreated' : ''), 'IPTC', dc + (tc ? ' ' + tc : ''), /^\d{8}$/.test(dc) ? { valid: true, naiveMs: Date.UTC(+dc.slice(0, 4), +dc.slice(4, 6) - 1, +dc.slice(6, 8)), text: dc.slice(0, 4) + '-' + dc.slice(4, 6) + '-' + dc.slice(6, 8) + (tc ? ' ' + tc.replace(/^(\d{2})(\d{2})(\d{2}).*$/, '$1:$2:$3') : ''), dateOnly: true } : { valid: false, issue: 'unrecognised format' });
    }
    if (rep.icc && rep.icc.created) push('icc', 'ICC profile creation', 'ICC', rep.icc.created, { valid: true, naiveMs: parseExifDate(rep.icc.created.replace(/-/g, ':')).naiveMs, text: rep.icc.created });
    if (rep.file.lastModified) push('fs', 'File system modified (not embedded)', 'File system', new Date(rep.file.lastModified).toISOString(), { valid: true, naiveMs: rep.file.lastModified, text: fmtDate(rep.file.lastModified) + ' UTC' });

    // checks
    function tsOf(o) { return o && o.valid ? o.naiveMs : null; }
    if (dto && dto.valid && dtm && dtm.valid) {
      var diff = (dtm.naiveMs - dto.naiveMs) / 1000;
      if (diff > 60) add('note', 'time', 'File was re-saved after capture', 'EXIF DateTime (' + dtm.text + ') is ' + humanDuration(diff) + ' later than DateTimeOriginal (' + dto.text + '). Cameras normally write the same moment in both; a later DateTime is written by software that saved the file again.', ['DateTimeOriginal: ' + dto.text, 'DateTime: ' + dtm.text]);
      else if (diff < -60) add('note', 'time', 'Modification time precedes capture time', 'EXIF DateTime (' + dtm.text + ') is ' + humanDuration(-diff) + ' EARLIER than DateTimeOriginal (' + dto.text + '), which is physically inconsistent and suggests hand-edited timestamps or a wrong clock.', ['DateTimeOriginal: ' + dto.text, 'DateTime: ' + dtm.text]);
    }
    if (dto && dto.valid && dtd && dtd.valid && Math.abs(dto.naiveMs - dtd.naiveMs) > 2000) {
      add('info', 'time', 'Capture and digitisation times differ', 'DateTimeOriginal (' + dto.text + ') and DateTimeDigitized (' + dtd.text + ') differ by ' + humanDuration(Math.abs(dto.naiveMs - dtd.naiveMs) / 1000) + '. On a camera they are normally identical; they differ for scans or when one value was edited.', []);
    }
    // XMP vs EXIF
    if (dto && dto.valid) {
      [['xmp:exif:DateTimeOriginal', 'flag'], ['xmp:xmp:CreateDate', 'note'], ['xmp:photoshop:DateCreated', 'note']].forEach(function (pair) {
        var xd = T.filter(function (o) { return o.key === pair[0]; })[0];
        if (!xd || !xd.valid) return;
        var d2 = Math.abs(dto.naiveMs - xd.naiveMs) / 1000, tzAllow = (xd.offsetMin !== null || dto.offsetMin !== null) ? 15 * 3600 : 2;
        if (xd.offsetMin !== null && dto.offsetMin !== null) tzAllow = 2;
        if (d2 > tzAllow) add(pair[1], 'consistency', 'EXIF and XMP capture times disagree', 'EXIF DateTimeOriginal is ' + dto.text + ' but XMP ' + xd.label + ' says ' + xd.text + ' (' + humanDuration(d2) + ' apart). A tool that rewrites only one of the two copies leaves this signature.', ['EXIF: ' + dto.text, 'XMP (' + xd.label + '): ' + xd.text]);
      });
    }
    // GPS vs local
    if (gpsUtc !== null && dto && dto.valid) {
      var diffMin = (dto.naiveMs - gpsUtc) / 60000;
      if (dto.offsetMin !== null) {
        var resid = diffMin - dto.offsetMin;
        if (Math.abs(resid) > 2) add('note', 'time', 'GPS time and local capture time do not agree', 'Local time ' + dto.text + ' with offset ' + dto.offsetText + ' implies ' + fmtDate(dto.naiveMs - dto.offsetMin * 60000) + ' UTC, but the GPS timestamp is ' + fmtDate(gpsUtc) + ' UTC (' + humanDuration(Math.abs(resid) * 60) + ' apart).', []);
        else add('ok', 'time', 'GPS time agrees with local capture time', 'Within ' + Math.max(1, Math.round(Math.abs(resid))) + ' min once the declared UTC offset (' + dto.offsetText + ') is applied.', []);
      } else {
        var implied = Math.round(diffMin / 15) * 15, off = Math.abs(diffMin - implied);
        if (Math.abs(diffMin) > 14 * 60 + 5) add('note', 'time', 'GPS time and local capture time are implausibly far apart', 'The difference is ' + (diffMin / 60).toFixed(1) + ' hours, larger than any real time-zone offset. One of the timestamps was probably edited, or the camera clock was wrong.', ['Local: ' + dto.text, 'GPS UTC: ' + fmtDate(gpsUtc)]);
        else if (off > 2) add('note', 'time', 'GPS time does not fit a whole time-zone offset', 'Local capture time and the GPS UTC time differ by ' + (diffMin / 60).toFixed(2) + ' h, which is not a multiple of 15 minutes (within 2 min). The camera clock may have drifted, or a timestamp was edited.', ['Local: ' + dto.text, 'GPS UTC: ' + fmtDate(gpsUtc)]);
        else add('info', 'time', 'Implied UTC offset', 'Comparing local capture time with GPS UTC time implies a local offset of UTC' + (implied >= 0 ? '+' : '−') + pad(Math.floor(Math.abs(implied) / 60)) + ':' + pad(Math.abs(implied) % 60) + ' at the place the picture was taken.', []);
      }
    }
    // plausibility
    T.forEach(function (o) {
      if (!o.valid || o.source === 'File system' || o.source === 'ICC' || o.key.indexOf('hist') === 0) return;
      if (o.naiveMs > now + 86400000) add('note', 'time', o.label + ' is in the future', o.text + ' is later than the date on which this analysis was run.', []);
      else if (o.naiveMs < Date.UTC(1995, 0, 1) && o.key !== 'iptc') add('note', 'time', o.label + ' predates consumer digital cameras', o.text + ' is before 1995.', []);
    });
    var fsT = T.filter(function (o) { return o.key === 'fs'; })[0];
    if (fsT && dto && dto.valid && dto.naiveMs - fsT.naiveMs > 36 * 3600 * 1000) {
      add('info', 'time', 'File-system date is earlier than the capture date', 'The file\'s last-modified time (' + fsT.text + ') is more than a day before its EXIF capture time (' + dto.text + '). File-system times change when files are copied or extracted and are not embedded evidence.', []);
    }
    if (ex && !dto && !dtd && !dtm && !(xi && Object.keys(xi.props).some(function (k) { return /Date/.test(k); }))) {
      add('note', 'time', 'No capture timestamp', 'There is no DateTimeOriginal, DateTimeDigitized, DateTime or XMP date in the file.', []);
    }
  }

  function humanDuration(sec) {
    sec = Math.round(sec);
    if (sec < 120) return sec + ' s';
    if (sec < 7200) return Math.round(sec / 60) + ' min';
    if (sec < 172800) return (sec / 3600).toFixed(1) + ' h';
    return (sec / 86400).toFixed(1) + ' days';
  }

  // ---------- software ----------
  function analyseSoftware(rep, ex, xi, irb, add) {
    var list = rep.summary.software;
    function push(source, value, extra) {
      if (!value || typeof value !== 'string') return;
      var c = classifySoftware(value);
      list.push({ source: source, value: value.trim(), kind: c.kind, label: c.label, extra: extra || '' });
    }
    var sw = ex ? QPI.exif.getValue(ex, 'Software') : '', host = ex ? QPI.exif.getValue(ex, 'HostComputer') : '';
    push('EXIF Software', sw);
    push('EXIF HostComputer', host);
    if (xi) {
      push('XMP CreatorTool', xi.creatorTool);
      (xi.history || []).forEach(function (h) { if (h.softwareAgent) push('XMP history agent (' + (h.action || 'event') + ')', h.softwareAgent, h.when); });
    }
    if (irb && irb.version) { push('Photoshop resource: writer', irb.version.writer); push('Photoshop resource: reader', irb.version.reader); }
    if (rep.iptc && rep.iptc.fields['2:65']) push('IPTC OriginatingProgram', rep.iptc.fields['2:65'].values[0] + (rep.iptc.fields['2:70'] ? ' ' + rep.iptc.fields['2:70'].values[0] : ''));
    (rep.jpeg.comments || []).forEach(function (c) { if (c.text) push('JPEG comment', c.text.slice(0, 200)); });
    // dedupe
    var seen = {}; rep.summary.software = list = list.filter(function (s) { var k = s.source + '|' + s.value; if (seen[k]) return false; seen[k] = 1; return true; });

    var editors = list.filter(function (s) { return s.kind === 'editor' || s.kind === 'raw'; });
    var libs = list.filter(function (s) { return s.kind === 'library'; });
    var ais = list.filter(function (s) { return s.kind === 'ai'; });
    var unknown = list.filter(function (s) { return s.kind === 'unknown' && s.source.indexOf('JPEG comment') !== 0; });
    if (ais.length) add('flag', 'software', 'AI-generation tool named in the metadata', 'Metadata names a tool associated with generative AI. This is a self-declared label (it can be added or removed by anyone), not a detection of synthetic content.', ais.map(function (s) { return s.source + ': ' + s.value; }));
    if (editors.length) add('note', 'software', 'Editing software named in the metadata', 'Metadata names software that edits or develops images. Camera originals usually carry only the camera\'s own firmware string.', editors.map(function (s) { return s.source + ': ' + s.value + (s.extra ? ' (' + s.extra + ')' : ''); }));
    if (libs.length) add('info', 'software', 'Image library or command-line tool named', 'The file was written or processed by a library or tool rather than directly by a camera.', libs.map(function (s) { return s.source + ': ' + s.value; }));
    if (unknown.length) add('info', 'software', 'Unrecognised software string', 'This may be camera firmware, a phone OS version, or a tool the classifier does not know.', unknown.map(function (s) { return s.source + ': ' + s.value; }));
    if (xi && xi.history && xi.history.length) {
      var evs = xi.history.filter(function (h) { return h.action; });
      var acts = evs.map(function (h) { return h.action + (h.softwareAgent ? ' by ' + h.softwareAgent : '') + (h.when ? ' at ' + h.when : '') + (h.changed ? ' [' + h.changed + ']' : ''); });
      add('note', 'software', 'XMP edit history present (' + xi.history.length + ' event' + (xi.history.length === 1 ? '' : 's') + ')', 'Adobe-style XMP history records saves and conversions. Camera originals do not normally contain it.', acts.slice(0, 12).concat(acts.length > 12 ? ['… ' + (acts.length - 12) + ' more'] : []));
    }
    if (xi && xi.derivedFrom) add('note', 'software', 'File is derived from another document', 'XMP DerivedFrom shows this file was produced from an earlier document.', Object.keys(xi.derivedFrom).map(function (k) { return k + ': ' + xi.derivedFrom[k]; }));
    var did = xi && xi.props['xmpMM:DocumentID'], odid = xi && xi.props['xmpMM:OriginalDocumentID'];
    if (typeof did === 'string' && typeof odid === 'string' && did !== odid) add('note', 'software', 'Document ID differs from the original document ID', 'xmpMM:DocumentID and xmpMM:OriginalDocumentID differ, which means the file was saved as a new document derived from an earlier one.', ['DocumentID: ' + did, 'OriginalDocumentID: ' + odid]);
    if (xi && xi.crop && (xi.crop.hasCrop || xi.crop.left > 0 || xi.crop.top > 0 || xi.crop.right < 1 || xi.crop.bottom < 1)) {
      add('note', 'software', 'Camera Raw / Lightroom crop settings recorded', 'XMP holds crop settings (left ' + fmtPct(xi.crop.left) + ', top ' + fmtPct(xi.crop.top) + ', right ' + fmtPct(xi.crop.right) + ', bottom ' + fmtPct(xi.crop.bottom) + (isFinite(xi.crop.angle) && xi.crop.angle ? ', angle ' + xi.crop.angle + '°' : '') + '), a direct record that the image was cropped in an Adobe workflow.', []);
    }
    if (xi && xi.digitalSourceType) {
      var ai = /trainedAlgorithmicMedia|compositeWithTrained|algorithmicMedia|compositeSynthetic/.test(xi.digitalSourceType.key);
      add(ai ? 'flag' : 'info', 'software', 'IPTC Digital Source Type: ' + xi.digitalSourceType.label, 'Self-declared label in XMP (' + xi.digitalSourceType.uri + '). It can be added or removed by anyone.', []);
    }
    if (irb) {
      add('note', 'software', 'Photoshop image-resource block present', 'APP13 "Photoshop 3.0" is written by Adobe products and compatible tools (' + irb.resources.length + ' resources' + (irb.version ? '; writer "' + irb.version.writer + '"' : '') + '). Camera originals do not normally contain it.', irb.resources.slice(0, 10).map(function (r) { return '0x' + r.id.toString(16).toUpperCase() + ' ' + r.name + ' (' + r.size + ' bytes)'; }));
    }
    if (rep.icc && /adobe/i.test(rep.icc.cmm || '') ) add('info', 'software', 'ICC profile embedded by Adobe tooling', 'ICC profile "' + (rep.icc.description || '') + '" has CMM "' + rep.icc.cmm + '".', []);
    if (rep.jpeg.adobe) add('info', 'software', 'Adobe APP14 marker present', 'Colour transform ' + rep.jpeg.adobe.transform + '. Written by Adobe software and by libraries that mimic it.', []);
    if (!ais.length && !editors.length && !libs.length && !(xi && (xi.history.length || xi.derivedFrom)) && !irb && ex) {
      add('ok', 'software', 'No edit-software traces in the metadata', 'No editor, library, history or Photoshop block was found. This does not prove the image is unedited: tools can write nothing, or remove all traces.', []);
    }
  }
  function fmtPct(x) { return isFinite(x) ? (Math.round(x * 1000) / 10) + '%' : '?'; }

  // ---------- structure ----------
  function analyseStructure(rep, ex, add) {
    var jp = rep.jpeg, f = jp.frame;
    if (f) {
      var q = jp.quality, qText = '';
      if (q) qText = q.exact ? ('quantisation tables are the standard libjpeg tables at quality ' + q.quality + (q.chromaExact === false ? ' (luminance only)' : '')) : ('quantisation tables are custom (closest libjpeg quality ' + q.quality + ', RMS error ' + q.rmsError.toFixed(1) + ')');
      add('info', 'structure', 'JPEG encoding profile', f.type + ', ' + f.precision + '-bit, ' + f.width + '×' + f.height + ', ' + f.subsampling + (jp.progressive ? ', progressive' : ', sequential') + (jp.restartInterval ? ', restart interval ' + jp.restartInterval : '') + (qText ? '; ' + qText : '') + '. Encoder settings help show whether a file was re-encoded, but many cameras and apps share them.', []);
    }
    if (jp.trailing) {
      var tr = jp.trailing, sev = tr.kind === 'zero-padding' ? 'info' : (tr.vendorTrailer || tr.kind === 'mp4' || tr.kind === 'jpeg' ? 'note' : 'flag');
      add(sev, 'structure', 'Data after the end of the JPEG image', tr.length + ' bytes follow the final EOI marker at offset ' + tr.offset + '. ' + tr.note + (tr.vendorTrailer ? ' ' + tr.vendorTrailer + '.' : '') + (sev === 'flag' ? ' Appended data of unknown type is a classic place to hide a payload.' : ''), ['Offset: ' + tr.offset, 'Length: ' + tr.length + ' bytes', 'Type: ' + tr.kind]);
    }
    if (jp.comments.length) add('info', 'structure', 'JPEG comment segment(s)', jp.comments.length + ' COM segment(s): "' + jp.comments.map(function (c) { return c.text.slice(0, 120); }).join('" · "') + '"', []);
    if (rep.c2pa) add('info', 'structure', 'Content Credentials (C2PA) manifest present', 'An APP11 JUMBF block' + (rep.c2pa.c2pa ? ' with a C2PA label' : '') + ' is present (' + rep.c2pa.length + ' bytes). This tool does NOT validate its signature; use a C2PA verifier.', []);
    if (!ex && f) add('note', 'structure', 'No EXIF metadata', rep.jpeg.jfif ? 'The file has a JFIF header but no EXIF block. This is typical of images exported from editors, screenshots, downloaded web images, and files processed by messaging apps or social networks.' : 'The file has neither EXIF nor JFIF headers.', []);
    if (rep.jpeg.appCounts && jp.segments.filter(function (s) { return s.marker === 0xE1; }).length > 4) add('info', 'structure', 'Many APP1 segments', 'There are several APP1 segments (EXIF, XMP, extended XMP).', []);
  }

  // ---------- embedded images ----------
  function collectEmbedded(u8, rep, ex, exifSeg, irb, mpfSeg, add) {
    var emb = rep.embedded;
    function describe(off, len) {
      var sub = u8.subarray(off, Math.min(u8.length, off + len));
      var p = QPI.jpeg.parse(sub);
      return { width: p.frame ? p.frame.width : null, height: p.frame ? p.frame.height : null, ok: !!p.frame, parsed: p };
    }
    // IFD1 thumbnail
    if (ex && ex.thumbnail) {
      var th = ex.thumbnail;
      if (th.kind === 'jpeg' && th.valid) {
        var d = describe(th.offset, th.length);
        emb.push({ id: 'ifd1', label: 'EXIF thumbnail (IFD1)', offset: th.offset, length: th.length, width: d.width, height: d.height, valid: d.ok, issues: th.issues.slice(), hash: QPI.hash.sha256(u8.subarray(th.offset, th.offset + th.length)) });
        if (!d.ok) add('note', 'thumbnail', 'EXIF thumbnail is not a decodable JPEG', 'The thumbnail data at offset ' + th.offset + ' has no valid JPEG frame header.', th.issues);
        else if (th.issues.length) add('note', 'thumbnail', 'EXIF thumbnail structure issues', th.issues.join(' '), []);
      } else if (th.kind === 'jpeg') {
        add('note', 'thumbnail', 'EXIF thumbnail cannot be extracted', th.issues.join(' '), []);
      } else if (th.kind === 'uncompressed') {
        add('info', 'thumbnail', 'Uncompressed EXIF thumbnail', th.issues.join(' '), []);
      }
    }
    // Other candidates inside the Exif segment (maker-note previews etc.)
    if (exifSeg) {
      var s = exifSeg.dataOffset + 6, e = exifSeg.dataOffset + exifSeg.dataLength, found = 0, thRange = ex && ex.thumbnail && ex.thumbnail.valid ? [ex.thumbnail.offset, ex.thumbnail.offset + ex.thumbnail.length] : null;
      var p = s;
      while (p < e - 4 && found < 4) {
        var q = u8.indexOf(0xFF, p);
        if (q < 0 || q >= e - 4) break;
        if (u8[q + 1] === 0xD8 && u8[q + 2] === 0xFF && (u8[q + 3] >= 0xC0 && u8[q + 3] <= 0xFE) && !(thRange && q >= thRange[0] && q < thRange[1])) {
          var sub = u8.subarray(q, e), pj = QPI.jpeg.parse(sub);
          if (pj.frame && pj.eoiEnd > 0 && pj.frame.width >= 32 && pj.frame.height >= 32) {
            emb.push({ id: 'preview' + found, label: 'Embedded JPEG preview (inside EXIF / maker note)', offset: q, length: pj.eoiEnd, width: pj.frame.width, height: pj.frame.height, valid: true, issues: [], hash: QPI.hash.sha256(u8.subarray(q, q + pj.eoiEnd)) });
            found++; p = q + pj.eoiEnd; continue;
          }
        }
        p = q + 1;
      }
    }
    if (irb && irb.thumbnail) {
      var t = irb.thumbnail, dd = describe(t.offset, t.length);
      emb.push({ id: 'irb', label: 'Photoshop thumbnail (resource 0x' + t.resourceId.toString(16).toUpperCase() + ')', offset: t.offset, length: t.length, width: dd.width || t.width, height: dd.height || t.height, valid: dd.ok, issues: [], hash: QPI.hash.sha256(u8.subarray(t.offset, t.offset + t.length)) });
      add('info', 'thumbnail', 'Photoshop thumbnail present', 'A second, independent thumbnail is stored in the Photoshop resource block (' + t.width + '×' + t.height + '). Editors update it separately from the EXIF thumbnail, so the two may show different stages of the file\'s history.', []);
    }
    if (rep.jpeg.jfxx && rep.jpeg.jfxx.extensionCode === 0x10) {
      var jx = rep.jpeg.jfxx, dj = describe(jx.dataOffset, jx.dataLength);
      if (dj.ok) emb.push({ id: 'jfxx', label: 'JFXX thumbnail', offset: jx.dataOffset, length: jx.dataLength, width: dj.width, height: dj.height, valid: true, issues: [], hash: QPI.hash.sha256(u8.subarray(jx.dataOffset, jx.dataOffset + jx.dataLength)) });
    }
    if (rep.mpf && rep.mpf.images && rep.mpf.images.length > 1) {
      rep.mpf.images.slice(1, 4).forEach(function (im, i) {
        if (im.offset > 0 && im.offset + im.size <= u8.length && u8[im.offset] === 0xFF && u8[im.offset + 1] === 0xD8) {
          var dm = describe(im.offset, im.size);
          if (dm.ok) emb.push({ id: 'mpf' + (i + 1), label: 'Multi-Picture image ' + (i + 2) + ' (' + im.type + ')', offset: im.offset, length: im.size, width: dm.width, height: dm.height, valid: true, issues: [], hash: QPI.hash.sha256(u8.subarray(im.offset, im.offset + im.size)) });
        }
      });
      add('info', 'structure', 'Multi-Picture Format (MPF) index present', rep.mpf.images.length + ' images are indexed (e.g. large previews or gain maps).', rep.mpf.images.map(function (im) { return '#' + (im.index + 1) + ' ' + im.type + ', ' + im.size + ' bytes at ' + im.offset; }));
    }
    if (rep.jpeg.trailing && rep.jpeg.trailing.kind === 'jpeg') {
      var tt = rep.jpeg.trailing, dt = describe(tt.offset, tt.length);
      if (dt.ok) emb.push({ id: 'trailer', label: 'JPEG stream after the main image', offset: tt.offset, length: tt.length, width: dt.width, height: dt.height, valid: true, issues: [], hash: QPI.hash.sha256(u8.subarray(tt.offset, tt.offset + tt.length)) });
    }
    if (ex && !emb.some(function (x) { return x.id === 'ifd1'; }) && !(ex.thumbnail && ex.thumbnail.kind !== 'none')) {
      add('info', 'thumbnail', 'No EXIF thumbnail', 'The EXIF block has no embedded thumbnail. Many phones omit it and many editors strip it, so nothing can be compared.', []);
    }
  }

  // ---------- comparison findings ----------
  function pct(x) { return Math.round(x * 100) + '%'; }

  function addComparison(rep, embeddedId, cmp) {
    var emb = rep.embedded.filter(function (e) { return e.id === embeddedId; })[0] || {}, label = emb.label || 'Embedded image';
    var F = rep.findings;
    function add(sev, title, detail, evidence) { F.push({ id: F.length + 1, severity: sev, category: 'thumbnail', title: title, detail: detail || '', evidence: evidence || [], embeddedId: embeddedId }); }
    var sc = cmp.scores || {};
    var ev = ['Thumbnail: ' + cmp.thumb.w + '×' + cmp.thumb.h + (emb.length ? ' (' + emb.length + ' bytes)' : ''), 'Main image: ' + cmp.main.w + '×' + cmp.main.h,
      'Correlation — whole frame: ' + (sc.full === null || sc.full === undefined ? 'n/a' : sc.full.toFixed(3)) + '; main inside thumbnail: ' + (sc.mainInThumb == null ? 'n/a' : sc.mainInThumb.toFixed(3)) + '; thumbnail inside main: ' + (sc.thumbInMain == null ? 'n/a' : sc.thumbInMain.toFixed(3))];
    rep.comparisons.push({ embeddedId: embeddedId, label: label, result: cmp });
    var m = cmp.margins;
    switch (cmp.verdict) {
      case 'main-cropped':
        add('flag', label + ' shows more of the scene than the main image',
          'The main image matches only part of the thumbnail. Compared with the thumbnail frame, the main image is missing ' + pct(m.left) + ' on the left, ' + pct(m.right) + ' on the right, ' + pct(m.top) + ' at the top and ' + pct(m.bottom) + ' at the bottom. This is the signature of an image that was cropped after capture by software that left the original thumbnail in the file. The thumbnail may reveal what was cropped out.',
          ev.concat(['Match rectangle inside the thumbnail (fraction of frame): x ' + cmp.rect.x.toFixed(3) + ', y ' + cmp.rect.y.toFixed(3) + ', w ' + cmp.rect.w.toFixed(3) + ', h ' + cmp.rect.h.toFixed(3)]));
        break;
      case 'thumb-partial': {
        var symmetric = Math.abs(m.left - m.right) < 0.03 && Math.abs(m.top - m.bottom) < 0.03;
        add(symmetric ? 'info' : 'note', label + ' shows only part of the main image',
          'The thumbnail matches a region of the main image: it lacks ' + pct(m.left) + ' left, ' + pct(m.right) + ' right, ' + pct(m.top) + ' top and ' + pct(m.bottom) + ' bottom of the main frame. ' + (symmetric ? 'The region is centred, which is typical of cameras that centre-crop their thumbnails to a fixed aspect ratio, so this is usually benign.' : 'The region is off-centre, so the thumbnail was probably made from a different crop of the picture than the one now stored.'), ev);
        break;
      }
      case 'mismatch':
        add('flag', label + ' shows different content from the main image', 'No orientation, crop or exposure change explains the difference: the thumbnail does not correspond to the main image. This happens when the main image was replaced or heavily altered while the old thumbnail stayed in the file. It can also result from rotation by an arbitrary angle, perspective correction or strong filters, which this comparison does not model.', ev);
        break;
      case 'weak':
        add('note', label + ' only loosely resembles the main image', 'Correlation is moderate. Heavy filters, tone mapping, an arbitrary-angle rotation or very low-texture content can cause this; it may also indicate a substantial edit.', ev);
        break;
      case 'consistent': {
        var d = cmp.diff;
        if (d && d.regions.length && d.fraction >= 0.015 && d.fraction <= 0.35) {
          add('note', label + ' matches overall, but some regions differ',
            'The frames line up, but ' + d.regions.length + ' region(s) covering about ' + pct(d.fraction) + ' of the frame differ from the thumbnail after brightness/contrast alignment. This can reflect retouching or objects added/removed after the thumbnail was written, but also camera processing (HDR, tone-mapping, lens correction) and thumbnail rendering. Treat it as a lead and inspect the highlighted areas.',
            ev.concat(d.regions.map(function (r, i) { return 'Region ' + (i + 1) + ': x ' + r.x.toFixed(2) + ', y ' + r.y.toFixed(2) + ', w ' + r.w.toFixed(2) + ', h ' + r.h.toFixed(2) + ' (' + pct(r.fraction) + ' of frame)'; })));
        } else if (d && d.fraction > 0.35) {
          add('note', label + ' matches in layout but differs widely in tone', 'More than a third of the frame differs after brightness/contrast alignment; the picture may have been strongly filtered or colour-graded after the thumbnail was written.', ev);
        } else {
          add('ok', label + ' matches the main image', 'The thumbnail shows the same frame as the main image. This is the expected result for a straight-out-of-camera file, but it is NOT proof of authenticity: most editors regenerate the thumbnail, so a matching thumbnail is also what an edited file usually shows.', ev);
        }
        if (cmp.notes.indexOf('distorted-aspect') >= 0) add('info', label + ' has a different aspect ratio', 'Thumbnail aspect ' + cmp.aspect.thumb.toFixed(3) + ' vs main ' + cmp.aspect.main.toFixed(3) + ' (' + pct(cmp.aspect.mismatch) + ' different), yet the content matches when stretched, so the thumbnail was squeezed to fit. Some cameras do this.', []);
        break;
      }
      default:
        add('info', label + ' could not be compared', cmp.reason || 'The comparison was inconclusive.', ev);
    }
    if (cmp.orientation && cmp.verdict !== 'inconclusive' && !cmp.orientation.expected && cmp.verdict !== 'mismatch') {
      add('info', label + ' is stored ' + cmp.orientation.text + ' relative to the main image', 'The comparison had to transform the thumbnail (' + cmp.orientation.text + ') to line it up with the displayed main image. Cameras that rotate the main image but not the thumbnail (or the reverse) do this.', []);
    }
    if (cmp.thumb.bars) add('info', label + ' has black letterbox bars', 'Bars of ' + [cmp.thumb.bars.top, cmp.thumb.bars.bottom, cmp.thumb.bars.left, cmp.thumb.bars.right].join('/') + ' px (top/bottom/left/right) were excluded from the comparison.', []);
  }

  function summaryCounts(rep) {
    var c = { flag: 0, note: 0, info: 0, ok: 0 };
    rep.findings.forEach(function (f) { c[f.severity]++; });
    return c;
  }

  function toJSON(rep) {
    var out = JSON.parse(JSON.stringify({
      tool: rep.tool, file: rep.file, summary: rep.summary, findings: rep.findings, embedded: rep.embedded, errors: rep.errors,
      jpeg: rep.jpeg ? { size: rep.jpeg.size, ok: rep.jpeg.ok, frame: rep.jpeg.frame, quality: rep.jpeg.quality ? { quality: rep.jpeg.quality.quality, exact: rep.jpeg.quality.exact, chromaExact: rep.jpeg.quality.chromaExact } : null, progressive: rep.jpeg.progressive, restartInterval: rep.jpeg.restartInterval, trailing: rep.jpeg.trailing, comments: rep.jpeg.comments, segments: rep.jpeg.segments.map(function (s) { return { marker: s.name, offset: s.offset, length: s.length, id: s.id }; }), jfif: rep.jpeg.jfif, adobe: rep.jpeg.adobe } : null,
      exif: rep.exifRows, xmp: rep.xmpInfo ? { props: rep.xmpInfo.props, history: rep.xmpInfo.history } : null,
      iptc: rep.iptc ? rep.iptc.fields : null, icc: rep.icc, c2pa: rep.c2pa, mpf: rep.mpf,
      comparisons: rep.comparisons.map(function (c) { var r = c.result; return { embeddedId: c.embeddedId, label: c.label, verdict: r.verdict, reason: r.reason, scores: r.scores, rect: r.rect, margins: r.margins, orientation: r.orientation ? { transform: r.orientation.transform, text: r.orientation.text } : null, thumb: r.thumb, main: r.main, aspect: r.aspect, notes: r.notes, diff: r.diff ? { fraction: r.diff.fraction, regions: r.diff.regions } : null }; }),
      limits: rep.limits
    }, function (k, v) { return (typeof v === 'number' && !isFinite(v)) ? null : v; }));
    return out;
  }

  QPI.analyze = { inspect: inspect, addComparison: addComparison, summaryCounts: summaryCounts, toJSON: toJSON, parseExifDate: parseExifDate, parseIso: parseIso, parseOffset: parseOffset, classifySoftware: classifySoftware, haversine: haversine, flattenExif: flattenExif, LIMITS: LIMITS, VERSION: VERSION, dms: dms };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.analyze;
})(typeof window !== 'undefined' ? window : globalThis);
