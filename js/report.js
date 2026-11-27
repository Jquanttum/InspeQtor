/*
 * Quanttum Photo Inspector — printable case report (vanilla JS)
 *
 * build(entry, caseInfo, options) returns a complete, standalone HTML document
 * (inline CSS, images as data: URIs, no scripts) that prints cleanly to A4 and
 * can be saved as PDF from the browser's print dialog. Every value that comes
 * from the examined file is HTML-escaped.
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function utc(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC'; }
  function bytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' bytes'); }
  var SEV = { flag: 'Flag', note: 'Note', info: 'Info', ok: 'Checked' };
  var CAT = { thumbnail: 'Thumbnail', gps: 'GPS', device: 'Device', time: 'Timestamps', software: 'Edit-software traces', structure: 'File structure', consistency: 'Consistency' };

  var CSS = [
    ':root{--ink:#111827;--muted:#4b5563;--line:#d1d5db;--soft:#f3f4f6;--flag:#b91c1c;--note:#b45309;--info:#1d4ed8;--ok:#15803d;--accent:#0f766e}',
    '*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    'body{font:13px/1.5 "Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif;color:var(--ink);margin:0;background:#e5e7eb}',
    '.page{max-width:860px;margin:18px auto;background:#fff;padding:36px 44px;box-shadow:0 1px 6px rgba(0,0,0,.18)}',
    'h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:26px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--accent);color:var(--accent);break-after:avoid}h3{font-size:13px;margin:14px 0 4px;break-after:avoid}',
    '.sub{color:var(--muted);margin:0 0 14px}.brand{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:700}',
    'table{width:100%;border-collapse:collapse;margin:6px 0 10px}th,td{border:1px solid var(--line);padding:4px 7px;vertical-align:top;text-align:left;overflow-wrap:anywhere}th{background:var(--soft);font-weight:600;width:30%}',
    'table.grid th{width:auto}tr{break-inside:avoid}.mono{font-family:Consolas,"SFMono-Regular",Menlo,monospace;font-size:11.5px}',
    '.tag{display:inline-block;font-size:11px;font-weight:700;padding:0 6px;border-radius:3px;color:#fff;margin-right:6px;vertical-align:1px}',
    '.tag.flag{background:var(--flag)}.tag.note{background:var(--note)}.tag.info{background:var(--info)}.tag.ok{background:var(--ok)}',
    '.finding{border:1px solid var(--line);border-left-width:5px;border-radius:3px;padding:6px 10px;margin:6px 0;break-inside:avoid}',
    '.finding.flag{border-left-color:var(--flag)}.finding.note{border-left-color:var(--note)}.finding.info{border-left-color:var(--info)}.finding.ok{border-left-color:var(--ok)}',
    '.finding p{margin:3px 0}.finding ul{margin:3px 0 3px 18px;padding:0;color:var(--muted);font-size:12px}',
    '.counts span{display:inline-block;margin-right:14px;font-weight:600}.imgs{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin:8px 0}',
    '.imgs figure{margin:0;border:1px solid var(--line);padding:6px;background:var(--soft);break-inside:avoid}.imgs img{display:block;max-width:100%;image-rendering:auto}.imgs figcaption{font-size:11px;color:var(--muted);margin-top:4px;max-width:340px}',
    '.imgs img.px{image-rendering:pixelated}',
    '.box{border:1px dashed var(--muted);min-height:70px;padding:6px 8px;white-space:pre-wrap}.sig{display:flex;gap:30px;margin-top:26px}.sig div{flex:1;border-top:1px solid var(--ink);padding-top:4px;font-size:11px;color:var(--muted)}',
    '.warn{background:#fffbeb;border:1px solid #fcd34d;padding:8px 10px;border-radius:3px;font-size:12px}ol.lim{margin:4px 0 0 18px;padding:0}ol.lim li{margin:3px 0}',
    '.small{font-size:11.5px;color:var(--muted)}',
    '@page{size:A4;margin:14mm 12mm}',
    '@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}h2{break-before:auto}.pb{break-before:page}}'
  ].join('\n');

  function kv(rows) {
    var out = '<table>';
    rows.forEach(function (r) { if (r[1] === '' || r[1] === null || r[1] === undefined) return; out += '<tr><th>' + esc(r[0]) + '</th><td' + (r[2] ? ' class="mono"' : '') + '>' + esc(r[1]) + '</td></tr>'; });
    return out + '</table>';
  }

  function build(entry, caseInfo, options) {
    options = options || {};
    var rep = entry.rep, S = rep.summary, now = new Date(), mask = !!options.maskSensitive, counts = QPI.analyze.summaryCounts(rep);
    caseInfo = caseInfo || {};
    var M = '[masked]';
    var html = [];
    html.push('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photo examination report — ' + esc(rep.file.name || 'file') + '</title><style>' + CSS + '</style></head><body><div class="page">');
    html.push('<div class="brand">Quanttum Photo Inspector · v' + esc(rep.tool.version) + '</div><h1>Photo metadata examination report</h1><p class="sub">Generated ' + esc(stamp(now)) + ' local time (' + esc(utc(now)) + '). Analysis ran entirely on the examiner\'s device; the file was not uploaded.</p>');

    html.push('<h2>1. Case details</h2>' + kv([['Case / reference no.', caseInfo.caseNo], ['Examiner', caseInfo.examiner], ['Organisation / lab', caseInfo.org], ['Evidence item no.', caseInfo.evidenceNo], ['Request / purpose', caseInfo.purpose]]));
    if (!caseInfo.caseNo && !caseInfo.examiner && !caseInfo.org && !caseInfo.evidenceNo && !caseInfo.purpose) html[html.length - 1] = '<h2>1. Case details</h2><p class="small">No case details were entered.</p>';

    html.push('<h2>2. File identification</h2>' + kv([
      ['File name', rep.file.name], ['Size', bytes(rep.file.size) + ' (' + rep.file.size + ' bytes)'], ['SHA-256', rep.file.sha256, true], ['MD5', rep.file.md5, true],
      ['File-system modified', rep.file.lastModified ? utc(new Date(rep.file.lastModified)) + ' (not embedded evidence; changes when files are copied)' : ''],
      ['Image', rep.jpeg && rep.jpeg.frame ? rep.jpeg.frame.width + ' × ' + rep.jpeg.frame.height + ' px, ' + rep.jpeg.frame.type + ', ' + rep.jpeg.frame.subsampling : 'not a decodable JPEG']
    ]));

    html.push('<h2>3. Summary of indicators</h2><p class="counts"><span style="color:var(--flag)">' + counts.flag + ' flag' + (counts.flag === 1 ? '' : 's') + '</span><span style="color:var(--note)">' + counts.note + ' note' + (counts.note === 1 ? '' : 's') + '</span><span style="color:var(--info)">' + counts.info + ' informational</span><span style="color:var(--ok)">' + counts.ok + ' checked, nothing found</span></p>');
    var top = rep.findings.filter(function (f) { return f.severity === 'flag' || f.severity === 'note'; });
    if (top.length) {
      html.push('<table class="grid"><tr><th style="width:62px">Level</th><th style="width:120px">Area</th><th>Indicator</th></tr>');
      top.sort(function (a, b) { return (a.severity === b.severity ? 0 : a.severity === 'flag' ? -1 : 1); }).forEach(function (f) { html.push('<tr><td><span class="tag ' + f.severity + '">' + SEV[f.severity] + '</span></td><td>' + esc(CAT[f.category] || f.category) + '</td><td>' + esc(f.title) + '</td></tr>'); });
      html.push('</table>');
    } else html.push('<p>No flags or notes were raised. This does not establish that the image is unmodified (see section 10).</p>');
    html.push('<p class="small"><b>Flag</b>: a contradiction or strong trace that needs an explanation. <b>Note</b>: a trace common in edited files that also has innocent causes. Indicators are leads for an examiner, not conclusions about authenticity.</p>');

    // thumbnail
    html.push('<h2>4. Embedded thumbnail comparison</h2>');
    if (!rep.embedded.length) html.push('<p>No embedded thumbnail or preview image was found in this file.</p>');
    rep.embedded.forEach(function (em) {
      var cmpE = rep.comparisons.filter(function (c) { return c.embeddedId === em.id; })[0], images = (entry.images && entry.images[em.id]) || {};
      html.push('<h3>' + esc(em.label) + '</h3>' + kv([['Location', 'offset ' + em.offset + ', ' + em.length + ' bytes'], ['Dimensions', em.width && em.height ? em.width + ' × ' + em.height + ' px' : 'unknown'], ['SHA-256 of extracted image', em.hash, true]]));
      if (cmpE) {
        var r = cmpE.result, V = { consistent: 'Matches the main image', 'main-cropped': 'Shows MORE than the main image (main image appears cropped)', 'thumb-partial': 'Shows LESS than the main image', mismatch: 'Shows different content', weak: 'Loose resemblance only', inconclusive: 'Inconclusive' };
        html.push('<p><b>Result:</b> ' + esc(V[r.verdict] || r.verdict) + '</p>');
        if (options.includeImages !== false && (images.thumbUrl || images.mainUrl)) {
          html.push('<div class="imgs">');
          if (images.thumbUrl) html.push('<figure><img class="px" src="' + esc(images.thumbUrl) + '" alt="Embedded thumbnail" style="width:' + Math.min(340, Math.max(160, (images.thumbW || 160) * 2)) + 'px"><figcaption>Embedded image (' + esc(em.width + '×' + em.height) + '), oriented to match the main image' + (r.verdict === 'main-cropped' ? '. Dashed box = the area the main image still shows.' : '.') + '</figcaption></figure>');
          if (images.overlayUrl && r.verdict !== 'consistent') html.push('<figure><img class="px" src="' + esc(images.overlayUrl) + '" alt="Comparison overlay" style="width:' + Math.min(340, Math.max(160, (images.thumbW || 160) * 2)) + 'px"><figcaption>Comparison overlay.</figcaption></figure>');
          if (images.mainUrl) html.push('<figure><img src="' + esc(images.mainUrl) + '" alt="Main image preview" style="width:' + Math.min(340, images.mainW || 340) + 'px"><figcaption>Main image (reduced preview)</figcaption></figure>');
          html.push('</div>');
        }
        var sc = r.scores || {};
        html.push(kv([['Correlation, whole frame', sc.full == null ? '' : sc.full.toFixed(3)], ['Correlation, main inside thumbnail', sc.mainInThumb == null ? '' : sc.mainInThumb.toFixed(3)], ['Correlation, thumbnail inside main', sc.thumbInMain == null ? '' : sc.thumbInMain.toFixed(3)], ['Orientation applied to thumbnail', r.orientation ? r.orientation.text + ' (EXIF code ' + r.orientation.transform + ')' : ''], ['Removed margins (fraction of thumbnail frame)', r.margins && r.verdict === 'main-cropped' ? 'left ' + Math.round(r.margins.left * 100) + '%, right ' + Math.round(r.margins.right * 100) + '%, top ' + Math.round(r.margins.top * 100) + '%, bottom ' + Math.round(r.margins.bottom * 100) + '%' : '']]));
      }
    });

    // device
    var D = S.device, G = S.gps || {};
    html.push('<h2>5. Device</h2>' + kv([['Make', D.make], ['Model', D.model], ['Lens', [D.lensMake, D.lensModel].filter(Boolean).join(' ')], ['Body serial number', D.bodySerial ? (mask ? M : D.bodySerial) : ''], ['Lens serial number', D.lensSerial ? (mask ? M : D.lensSerial) : ''], ['Owner name', D.owner ? (mask ? M : D.owner) : ''], ['Artist', D.artist ? (mask ? M : D.artist) : ''], ['Copyright', D.copyright], ['Host computer', D.hostComputer], ['Software (EXIF)', D.software], ['Exposure', [S.capture.exposureTime, S.capture.fNumber, S.capture.iso && 'ISO ' + S.capture.iso, S.capture.focalLength].filter(Boolean).join(' · ')], ['Flash', S.capture.flash], ['Description', D.description], ['User comment', D.userComment]]));
    if (!D.make && !D.model && !D.bodySerial && !D.software) html.push('<p class="small">No device information was found in the metadata.</p>');

    // GPS
    html.push('<h2>6. GPS</h2>');
    if (G.present && G.lat !== undefined && G.lat !== null) {
      html.push(kv([['Latitude', mask ? M : G.latDMS + '  (' + G.lat.toFixed(6) + ')'], ['Longitude', mask ? M : G.lonDMS + '  (' + G.lon.toFixed(6) + ')'], ['Altitude', G.altitudeText], ['Source', G.source || 'EXIF GPS'], ['Fix status / mode', [G.status, G.measureMode && G.measureMode + 'D'].filter(Boolean).join(' / ')], ['DOP', G.dop], ['Map datum', G.datum], ['Processing method', G.processingMethod], ['Area information', G.area], ['Image direction', typeof G.direction === 'number' ? G.direction.toFixed(1) + '° ' + (G.directionRef === 'M' ? 'magnetic' : G.directionRef === 'T' ? 'true' : '') : ''], ['Irregularities', (G.issues || []).join(' ')]]));
      if (mask) html.push('<p class="small">Coordinates are masked in this copy of the report at the examiner\'s request.</p>');
    } else html.push('<p>No usable GPS position was found.</p>');

    // timestamps
    html.push('<h2>7. Timestamps</h2>');
    if (S.timestamps.length) {
      html.push('<table class="grid"><tr><th>Field</th><th>Source</th><th>Value as stored</th><th>Interpreted</th></tr>');
      S.timestamps.forEach(function (t) { html.push('<tr><td>' + esc(t.label) + '</td><td>' + esc(t.source) + '</td><td class="mono">' + esc(t.raw) + (t.subsec ? ' .' + esc(t.subsec) : '') + (t.offsetText ? ' ' + esc(t.offsetText) : '') + '</td><td>' + (t.valid ? esc(t.text) : '<i>' + esc(t.issue || 'invalid') + '</i>') + '</td></tr>'); });
      html.push('</table><p class="small">EXIF capture times have no time zone unless an OffsetTime tag is present. Times are shown exactly as recorded.</p>');
    } else html.push('<p>No timestamps were found.</p>');

    // software
    html.push('<h2>8. Edit-software traces</h2>');
    if (S.software.length) {
      html.push('<table class="grid"><tr><th>Source</th><th>Value</th><th>Classification</th></tr>');
      S.software.forEach(function (s) { html.push('<tr><td>' + esc(s.source) + '</td><td>' + esc(s.value) + (s.extra ? ' <span class="small">(' + esc(s.extra) + ')</span>' : '') + '</td><td>' + esc(s.label || s.kind) + '</td></tr>'); });
      html.push('</table>');
    } else html.push('<p>No software identifiers were found in the metadata.</p>');

    // findings
    html.push('<h2 class="pb">9. All findings</h2>');
    var order = { flag: 0, note: 1, info: 2, ok: 3 };
    rep.findings.slice().sort(function (a, b) { return order[a.severity] - order[b.severity] || a.id - b.id; }).forEach(function (f) {
      html.push('<div class="finding ' + f.severity + '"><div><span class="tag ' + f.severity + '">' + SEV[f.severity] + '</span><b>' + esc(f.title) + '</b> <span class="small">· ' + esc(CAT[f.category] || f.category) + '</span></div>' + (f.detail ? '<p>' + esc(mask ? maskText(f.detail, S) : f.detail) + '</p>' : '') + (f.evidence && f.evidence.length ? '<ul>' + f.evidence.map(function (e) { return '<li>' + esc(mask ? maskText(e, S) : e) + '</li>'; }).join('') + '</ul>' : '') + '</div>');
    });

    // structure
    html.push('<h2 class="pb">Appendix A. JPEG segment map</h2>');
    if (rep.jpeg && rep.jpeg.segments.length) {
      html.push('<table class="grid"><tr><th>#</th><th>Marker</th><th>Offset</th><th>Length</th><th>Identifier</th></tr>');
      rep.jpeg.segments.forEach(function (s, i) { html.push('<tr><td>' + (i + 1) + '</td><td>' + esc(s.name) + '</td><td class="mono">' + s.offset + '</td><td class="mono">' + s.length + (s.entropyLength ? ' + ' + s.entropyLength + ' image data' : '') + '</td><td class="mono">' + esc(s.id) + '</td></tr>'); });
      html.push('</table>');
      if (rep.jpeg.trailing) html.push('<p>Data after EOI: ' + rep.jpeg.trailing.length + ' bytes at offset ' + rep.jpeg.trailing.offset + ' (' + esc(rep.jpeg.trailing.kind) + ').</p>');
    }
    html.push('<h2>Appendix B. EXIF tags</h2>');
    if (rep.exifRows.length) {
      html.push('<table class="grid"><tr><th>Directory</th><th>Tag</th><th>ID</th><th>Type × count</th><th>Value</th></tr>');
      rep.exifRows.forEach(function (r) {
        var v = r.display, sens = /^GPS(Latitude|Longitude|Altitude|DestLatitude|DestLongitude|AreaInformation)$|SerialNumber|CameraOwnerName/.test(r.name);
        html.push('<tr><td>' + esc(r.ifd) + '</td><td>' + esc(r.name) + '</td><td class="mono">' + esc(r.idHex) + '</td><td class="mono">' + esc(r.type) + ' × ' + r.count + '</td><td class="mono">' + esc(mask && sens ? M : v) + '</td></tr>');
      });
      html.push('</table>');
    } else html.push('<p>No EXIF data.</p>');
    if (rep.xmpInfo && Object.keys(rep.xmpInfo.props).length) {
      html.push('<h2>Appendix C. XMP properties</h2><table class="grid"><tr><th>Property</th><th>Value</th></tr>');
      Object.keys(rep.xmpInfo.props).slice(0, 300).forEach(function (k) { var v = rep.xmpInfo.props[k]; html.push('<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 1200) + '</td></tr>'); });
      html.push('</table>');
    }

    html.push('<h2 class="pb">10. Method and limitations</h2><p>The tool reads the JPEG marker structure and the EXIF, XMP, IPTC, Photoshop and ICC blocks directly from the file, decodes the main image and each embedded thumbnail with the browser\'s JPEG decoder, and compares them with a brightness-invariant correlation search that looks for the main image inside the thumbnail (cropped) and the thumbnail inside the main image (partial), over the EXIF orientations, with and without letterbox bars. The analysis was performed with Quanttum Photo Inspector v' + esc(rep.tool.version) + '. Limitations that apply to every report:</p><ol class="lim">' + rep.limits.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ol>');
    html.push('<h2>Examiner notes</h2><div class="box">' + esc(caseInfo.notes || '') + '</div>');
    html.push('<div class="sig"><div>Examiner signature</div><div>Date</div><div>Reviewer / witness</div></div>');
    html.push('<p class="small" style="margin-top:14px">Report hash note: compute a hash of this file when saving it if it will be used as an exhibit; the SHA-256 above identifies the <i>examined photograph</i>, not this report.</p>');
    html.push('</div></body></html>');
    return html.join('');
  }

  function maskText(t, S) {
    var s = String(t), G = S.gps || {};
    if (G.latDMS) s = s.split(G.latDMS).join('[masked]');
    if (G.lonDMS) s = s.split(G.lonDMS).join('[masked]');
    s = s.replace(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, '[masked]');
    ['bodySerial', 'lensSerial', 'owner'].forEach(function (k) { if (S.device[k]) s = s.split(S.device[k]).join('[masked]'); });
    return s;
  }

  QPI.report = { build: build, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.report;
})(typeof window !== 'undefined' ? window : globalThis);
