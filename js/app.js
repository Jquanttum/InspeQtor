/*
 * Quanttum Photo Inspector — UI controller (vanilla JS, no framework).
 * Every string that originates in an examined file is inserted with textContent
 * (never innerHTML), so hostile metadata cannot inject markup or script.
 */
(function () {
  'use strict';
  var QPI = window.QPI;
  var state = { entries: [], current: null, tab: 'summary', showInfo: true, showOk: false, nextId: 1 };
  var TABS = [['summary', 'Summary'], ['thumbnail', 'Thumbnail'], ['metadata', 'Metadata'], ['structure', 'Structure'], ['report', 'Case report'], ['limits', 'Limits']];
  var SEV_LABEL = { flag: 'Flag', note: 'Note', info: 'Info', ok: 'Checked' };
  var CAT_LABEL = { thumbnail: 'Thumbnail', gps: 'GPS', device: 'Device', time: 'Timestamps', software: 'Edit traces', structure: 'Structure', consistency: 'Consistency' };
  var $ = function (id) { return document.getElementById(id); };

  function h(tag, attrs) {
    var el = document.createElement(tag), i, k;
    if (attrs) for (k in attrs) {
      var v = attrs[k];
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function bytesText(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem('qpi.' + k) || ''; localStorage.setItem('qpi.' + k, v); } catch (e) { return ''; } return ''; }

  // ---------------- file handling ----------------
  function addFiles(files) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    document.body.classList.add('has-files');
    $('work').hidden = false;
    list.forEach(function (f) {
      var entry = { id: state.nextId++, file: f, name: f.name, status: 'queued', rep: null, u8: null, images: {}, error: '' };
      state.entries.push(entry);
    });
    if (!state.current) state.current = state.entries[state.entries.length - list.length];
    render();
    processQueue();
  }

  var running = false;
  function processQueue() {
    if (running) return; running = true;
    (function next() {
      var e = state.entries.filter(function (x) { return x.status === 'queued'; })[0];
      if (!e) { running = false; return; }
      processEntry(e).then(next, next);
    })();
  }

  function processEntry(entry) {
    entry.status = 'analysing'; renderList();
    return entry.file.arrayBuffer().then(function (buf) {
      entry.u8 = new Uint8Array(buf);
      return tick();
    }).then(function () {
      entry.rep = QPI.analyze.inspect(entry.u8, { fileName: entry.name, lastModified: entry.file.lastModified });
      entry.status = entry.rep.jpeg && entry.rep.jpeg.frame && entry.rep.embedded.length ? 'comparing' : 'done';
      render();
      if (entry.status !== 'comparing') return null;
      return compareAll(entry);
    }).then(function () {
      entry.status = 'done'; render();
    }, function (err) {
      entry.status = 'error'; entry.error = err && err.message ? err.message : String(err); render();
    });
  }

  function compareAll(entry) {
    var rep = entry.rep, frame = rep.jpeg.frame, mainGray = null, expected = 1;
    return QPI.decode.decode(entry.u8, 1024).then(function (main) {
      entry.main = main;
      mainGray = QPI.compare.rgbaToGray(main.rgba, main.w, main.h);
      var applied = QPI.decode.orientationApplied(frame.width, frame.height, main.naturalW, main.naturalH);
      expected = applied ? (rep.summary.device.orientation || 1) : 1;
      var pv = document.createElement('canvas'), s = Math.min(1, 520 / Math.max(main.w, main.h));
      pv.width = Math.max(1, Math.round(main.w * s)); pv.height = Math.max(1, Math.round(main.h * s));
      var c0 = QPI.decode.toCanvas(main.rgba, main.w, main.h);
      pv.getContext('2d').drawImage(c0, 0, 0, pv.width, pv.height);
      entry.mainCanvas = pv;
      var chain = Promise.resolve();
      rep.embedded.slice(0, 5).forEach(function (emb) {
        chain = chain.then(function () { return tick(); }).then(function () { return compareOne(entry, emb, mainGray, expected); });
      });
      return chain;
    }, function (err) {
      rep.findings.push({ id: rep.findings.length + 1, severity: 'note', category: 'thumbnail', title: 'Main image could not be decoded for comparison', detail: (err && err.message) || 'Decoder error.', evidence: [] });
    });
  }

  function compareOne(entry, emb, mainGray, expected) {
    var rep = entry.rep;
    if (!emb.valid) return null;
    return QPI.decode.decode(entry.u8.subarray(emb.offset, emb.offset + emb.length), 0).then(function (th) {
      var tg = QPI.compare.rgbaToGray(th.rgba, th.w, th.h);
      var cmp = QPI.compare.compareThumbToMain(tg, mainGray, { expectedOrientation: expected });
      QPI.analyze.addComparison(rep, emb.id, cmp);
      var t = cmp.orientation ? cmp.orientation.transform : 1, o = QPI.compare.orientRGBA(th.rgba, th.w, th.h, t);
      var tc = QPI.decode.toCanvas(o.data, o.w, o.h);
      entry.images[emb.id] = { canvas: tc, cmp: cmp, w: o.w, h: o.h };
      var img = entry.images[emb.id];
      img.thumbUrl = tc.toDataURL('image/png'); img.thumbW = o.w;
      var ov = overlayCanvas(img, cmp.verdict === 'consistent' ? 'diff' : 'outline');
      img.overlayUrl = ov ? ov.toDataURL('image/png') : '';
      if (entry.mainCanvas) { img.mainUrl = entry.mainCanvas.toDataURL('image/jpeg', 0.85); img.mainW = entry.mainCanvas.width; }
    }, function (err) {
      rep.findings.push({ id: rep.findings.length + 1, severity: 'note', category: 'thumbnail', title: emb.label + ' could not be decoded', detail: (err && err.message) || 'Decoder error.', evidence: [] });
    });
  }

  // ---------------- overlays ----------------
  function overlayCanvas(img, mode) {
    var cmp = img.cmp, w = img.w, h = img.h, c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img.canvas, 0, 0);
    if (mode === 'outline' && cmp.verdict === 'main-cropped' && cmp.rect) {
      var r = cmp.rect, x = r.x * w, y = r.y * h, rw = r.w * w, rh = r.h * h;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, w, y); ctx.fillRect(0, y + rh, w, h - y - rh); ctx.fillRect(0, y, x, rh); ctx.fillRect(x + rw, y, w - x - rw, rh);
      ctx.lineWidth = Math.max(1, w / 160); ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ffd400'; ctx.strokeRect(x, y, rw, rh);
      return c;
    }
    if (mode === 'diff' && cmp.diff && cmp.diff.frame) {
      var d = cmp.diff, f = d.frame, cw = f.w * w / d.gridW, ch = f.h * h / d.gridH;
      ctx.fillStyle = 'rgba(255,40,40,0.45)';
      for (var gy = 0; gy < d.gridH; gy++) for (var gx = 0; gx < d.gridW; gx++) if (d.mask[gy * d.gridW + gx]) ctx.fillRect(f.x * w + gx * cw, f.y * h + gy * ch, Math.ceil(cw), Math.ceil(ch));
      return c;
    }
    if (mode === 'outline' && cmp.verdict === 'thumb-partial') return null;
    return null;
  }

  // ---------------- rendering ----------------
  function render() { renderList(); renderTabs(); renderContent(); }

  function counts(rep) { return rep ? QPI.analyze.summaryCounts(rep) : null; }

  function renderList() {
    var ul = $('list'); clear(ul);
    state.entries.forEach(function (e) {
      var c = counts(e.rep), chips = [];
      if (e.status === 'queued' || e.status === 'analysing' || e.status === 'comparing') chips.push(h('span', { class: 'chip busy' }, h('span', { class: 'spinner' }), e.status === 'comparing' ? 'comparing' : 'working'));
      else if (e.status === 'error') chips.push(h('span', { class: 'chip flag', text: 'error' }));
      if (c) { if (c.flag) chips.push(h('span', { class: 'chip flag', text: c.flag + ' flag' + (c.flag > 1 ? 's' : '') })); if (c.note) chips.push(h('span', { class: 'chip note', text: c.note + ' note' + (c.note > 1 ? 's' : '') })); if (!c.flag && !c.note && e.status === 'done') chips.push(h('span', { class: 'chip ok', text: 'no flags' })); }
      var li = h('li', { class: e === state.current ? 'sel' : '' }, h('button', { type: 'button', onclick: function () { state.current = e; render(); } }, h('span', { class: 'fname', text: e.name }), h('span', { class: 'fmeta' }, bytesText(e.file.size), chips)));
      ul.appendChild(li);
    });
  }

  function renderTabs() {
    var nav = $('tabs'); clear(nav);
    TABS.forEach(function (t) {
      nav.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': String(state.tab === t[0]), onclick: function () { state.tab = t[0]; renderTabs(); renderContent(); } }, t[1]));
    });
  }

  function renderContent() {
    var box = $('content'); clear(box);
    var e = state.current;
    if (state.tab === 'limits') { box.appendChild(limitsView()); return; }
    if (!e) { box.appendChild(h('div', { class: 'empty', text: 'No file selected.' })); return; }
    if (e.status === 'error') { box.appendChild(h('div', { class: 'callout' }, 'This file could not be analysed: ' + e.error)); return; }
    if (!e.rep) { box.appendChild(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), 'Reading ' + e.name + '…')); return; }
    var view = { summary: summaryView, thumbnail: thumbnailView, metadata: metadataView, structure: structureView, report: reportView }[state.tab];
    box.appendChild(view(e));
  }

  function sevTag(s) { return h('span', { class: 'sev ' + s, text: SEV_LABEL[s] }); }

  function findingEl(f) {
    var d = h('details', { class: 'finding ' + f.severity, open: f.severity === 'flag' },
      h('summary', null, sevTag(f.severity), h('span', { class: 'ftitle', text: f.title }), h('span', { class: 'fcat', text: CAT_LABEL[f.category] || f.category })));
    var body = h('div', { class: 'fbody' });
    if (f.detail) body.appendChild(h('p', { text: f.detail }));
    if (f.evidence && f.evidence.length) body.appendChild(h('ul', null, f.evidence.map(function (x) { return h('li', { text: x }); })));
    d.appendChild(body);
    return d;
  }

  function fact(k, v) { return h('div', { class: 'fact' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v || '—' })); }

  function summaryView(e) {
    var rep = e.rep, S = rep.summary, c = counts(rep), root = h('div');
    root.appendChild(h('div', { class: 'hero' }, h('div', null, h('h2', { text: e.name }), h('div', { class: 'muted small', text: bytesText(rep.file.size) + (rep.jpeg && rep.jpeg.frame ? ' · ' + rep.jpeg.frame.width + '×' + rep.jpeg.frame.height + ' px' : '') })),
      h('div', { class: 'counts' }, h('span', { class: 'chip flag', text: c.flag + ' flag' + (c.flag === 1 ? '' : 's') }), h('span', { class: 'chip note', text: c.note + ' note' + (c.note === 1 ? '' : 's') }), h('span', { class: 'chip info', text: c.info + ' info' }), h('span', { class: 'chip ok', text: c.ok + ' checked' }))));
    // lead: thumbnail result
    var lead = rep.comparisons.filter(function (x) { return x.embeddedId === 'ifd1'; })[0] || rep.comparisons[0];
    if (lead && e.images[lead.embeddedId]) {
      var img = e.images[lead.embeddedId], r = lead.result, crop = r.verdict === 'main-cropped';
      var title = { 'main-cropped': 'The thumbnail shows more than the main image', consistent: 'The thumbnail matches the main image', 'thumb-partial': 'The thumbnail shows only part of the main image', mismatch: 'The thumbnail shows different content', weak: 'The thumbnail only loosely resembles the main image', inconclusive: 'Thumbnail comparison inconclusive' }[r.verdict];
      var oc = overlayCanvas(img, crop ? 'outline' : 'diff') || img.canvas, shown = cloneCanvas(oc, 260);
      var sub = crop ? 'The main image keeps only the dashed region. Everything dimmed was removed after the thumbnail was written.' : r.verdict === 'consistent' ? 'This is expected for an unedited file, but most editors regenerate thumbnails, so it does not prove the file is original.' : (r.reason || '');
      root.appendChild(h('div', { class: 'lead-card' + (crop || r.verdict === 'mismatch' ? '' : ' calm') }, h('figure', { style: 'margin:0' }, shown), h('div', null, h('h3', { text: title }), h('p', { text: sub }), h('button', { class: 'btn small', type: 'button', onclick: function () { state.tab = 'thumbnail'; renderTabs(); renderContent(); } }, 'See the comparison'))));
    } else if (e.status === 'comparing') {
      root.appendChild(h('div', { class: 'callout' }, h('span', { class: 'spinner' }), 'Comparing thumbnail with the main image…'));
    }
    var G = S.gps || {};
    root.appendChild(h('div', { class: 'facts' },
      fact('Device', [S.device.make, S.device.model].filter(Boolean).join(' ')),
      fact('Captured', (S.timestamps.filter(function (t) { return t.key === 'dto'; })[0] || {}).text),
      fact('GPS', G.lat !== undefined && G.lat !== null ? G.lat.toFixed(5) + ', ' + G.lon.toFixed(5) : (G.present ? 'present, no coordinates' : 'none')),
      fact('Software', (S.software[0] || {}).value),
      fact('SHA-256', rep.file.sha256.slice(0, 16) + '…')));
    root.appendChild(h('div', { class: 'filters' },
      h('label', null, h('input', { type: 'checkbox', checked: state.showInfo, onchange: function (ev) { state.showInfo = ev.target.checked; renderContent(); } }), ' Show informational'),
      h('label', null, h('input', { type: 'checkbox', checked: state.showOk, onchange: function (ev) { state.showOk = ev.target.checked; renderContent(); } }), ' Show “checked, nothing found”')));
    var order = { flag: 0, note: 1, info: 2, ok: 3 };
    var list = rep.findings.filter(function (f) { return f.severity === 'flag' || f.severity === 'note' || (f.severity === 'info' && state.showInfo) || (f.severity === 'ok' && state.showOk); }).sort(function (a, b) { return order[a.severity] - order[b.severity] || a.id - b.id; });
    if (!list.length) root.appendChild(h('p', { class: 'muted', text: 'No indicators to show with the current filters.' }));
    list.forEach(function (f) { root.appendChild(findingEl(f)); });
    return root;
  }

  function cloneCanvas(src, maxW) {
    var c = document.createElement('canvas'), s = Math.max(1, Math.min(4, Math.floor(maxW / src.width) || 1));
    c.width = src.width * s; c.height = src.height * s; c.className = 'px';
    var ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function thumbnailView(e) {
    var rep = e.rep, root = h('div');
    root.appendChild(h('h2', { text: 'Embedded thumbnail vs main image' }));
    root.appendChild(h('p', { class: 'muted', text: 'Cameras store a small preview inside the file. If the main image is cropped later but the old preview is kept, the preview still shows the whole original frame.' }));
    if (!rep.embedded.length) { root.appendChild(h('div', { class: 'empty', text: 'No embedded thumbnail or preview was found in this file, so there is nothing to compare.' })); return root; }
    rep.embedded.forEach(function (emb) {
      var img = e.images[emb.id], card = h('div', { class: 'cmp' });
      card.appendChild(h('h3', { style: 'margin-top:0', text: emb.label }));
      card.appendChild(h('div', { class: 'muted small mono', text: (emb.width || '?') + '×' + (emb.height || '?') + ' px · ' + emb.length + ' bytes at offset ' + emb.offset + ' · SHA-256 ' + emb.hash.slice(0, 16) + '…' }));
      if (!img) {
        card.appendChild(h('p', null, e.status === 'comparing' ? [h('span', { class: 'spinner' }), 'Comparing…'] : 'Not compared (' + (emb.valid ? 'decoder error or limit of 5 images' : 'not a valid JPEG') + ').'));
        root.appendChild(card); return;
      }
      var r = img.cmp, mode = r.verdict === 'main-cropped' ? 'outline' : (r.diff && r.diff.regions.length ? 'diff' : 'none');
      var holder = h('figure'), cap = h('figcaption');
      function draw() {
        clear(holder);
        var src = mode === 'none' ? img.canvas : (overlayCanvas(img, mode) || img.canvas);
        holder.appendChild(cloneCanvas(src, 420));
      }
      var vcls = r.verdict === 'main-cropped' || r.verdict === 'mismatch' ? 'flag' : r.verdict === 'consistent' ? 'ok' : 'note';
      var vtext = { 'main-cropped': 'Shows MORE than the main image — the main image looks cropped', consistent: 'Matches the main image', 'thumb-partial': 'Shows LESS than the main image', mismatch: 'Shows different content', weak: 'Only loosely resembles the main image', inconclusive: 'Inconclusive' }[r.verdict];
      card.appendChild(h('div', { class: 'verdict ' + vcls, text: vtext }));
      var modes = h('div', { class: 'seg', role: 'group', 'aria-label': 'Overlay' });
      [['none', 'Thumbnail'], ['outline', 'Main-image area'], ['diff', 'Differences']].forEach(function (m) {
        var b = h('button', { type: 'button', 'aria-pressed': String(mode === m[0]), onclick: function () { mode = m[0]; Array.prototype.forEach.call(modes.children, function (x, i) { x.setAttribute('aria-pressed', String(['none', 'outline', 'diff'][i] === mode)); }); draw(); } }, m[1]);
        modes.appendChild(b);
      });
      var dl = h('button', { class: 'btn small', type: 'button', onclick: function () { download(new Blob([e.u8.subarray(emb.offset, emb.offset + emb.length)], { type: 'image/jpeg' }), e.name.replace(/\.[^.]+$/, '') + '.' + emb.id + '.jpg'); } }, 'Download extracted image');
      card.appendChild(h('div', { class: 'actions' }, modes, dl));
      draw();
      cap.textContent = 'Embedded image' + (r.orientation && r.orientation.transform !== 1 ? ', ' + r.orientation.text + ' to match the main image' : '') + '. Shown enlarged without smoothing; the real resolution is ' + img.w + '×' + img.h + '.';
      holder.appendChild(cap);
      var mainFig = h('figure'); if (e.mainCanvas) { var mc = cloneCanvas(e.mainCanvas, 420); mc.className = ''; mainFig.appendChild(mc); mainFig.appendChild(h('figcaption', { text: 'Main image (reduced preview)' })); }
      card.appendChild(h('div', { class: 'cmp-grid' }, holder, mainFig));
      var sc = r.scores || {};
      card.appendChild(h('table', { class: 'kv' },
        row('Correlation: whole frame', sc.full == null ? '—' : sc.full.toFixed(3)), row('Correlation: main inside thumbnail', sc.mainInThumb == null ? '—' : sc.mainInThumb.toFixed(3)), row('Correlation: thumbnail inside main', sc.thumbInMain == null ? '—' : sc.thumbInMain.toFixed(3)),
        r.margins && r.verdict === 'main-cropped' ? row('Removed from the frame', 'left ' + Math.round(r.margins.left * 100) + '% · right ' + Math.round(r.margins.right * 100) + '% · top ' + Math.round(r.margins.top * 100) + '% · bottom ' + Math.round(r.margins.bottom * 100) + '%') : null,
        r.diff ? row('Regions that differ', r.diff.regions.length ? r.diff.regions.length + ' (' + Math.round(r.diff.fraction * 100) + '% of frame)' : 'none') : null));
      root.appendChild(card);
    });
    root.appendChild(h('p', { class: 'muted small', text: 'Correlation of 1.0 means identical structure; above about 0.90 counts as the same picture. Values are brightness- and contrast-invariant.' }));
    return root;
  }

  function row(k, v) { return h('tr', null, h('th', { text: k }), h('td', { text: v })); }
  function kvTable(rows) { var t = h('table', { class: 'kv' }); rows.forEach(function (r) { if (r && r[1] !== '' && r[1] !== undefined && r[1] !== null) t.appendChild(row(r[0], r[1])); }); return t; }

  function download(blob, name) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function metadataView(e) {
    var rep = e.rep, S = rep.summary, D = S.device, C = S.capture, G = S.gps || {}, root = h('div');
    root.appendChild(h('h2', { text: 'Metadata' }));
    root.appendChild(h('h3', { text: 'Device' }));
    root.appendChild(kvTable([['Make', D.make], ['Model', D.model], ['Lens', [D.lensMake, D.lensModel].filter(Boolean).join(' ')], ['Body serial', D.bodySerial], ['Lens serial', D.lensSerial], ['Owner', D.owner], ['Artist', D.artist], ['Copyright', D.copyright], ['Host computer', D.hostComputer], ['Description', D.description], ['User comment', D.userComment], ['Windows title', D.xpTitle], ['Windows author', D.xpAuthor], ['Windows comment', D.xpComment], ['Windows keywords', D.xpKeywords],
      ['Exposure', [C.exposureTime, C.fNumber, C.iso && 'ISO ' + C.iso, C.focalLength, C.focalLength35 && '(' + C.focalLength35 + ' equiv.)'].filter(Boolean).join(' · ')], ['Flash', C.flash], ['Exposure program', C.exposureProgram], ['White balance', C.whiteBalance], ['Metering', C.meteringMode], ['Colour space', C.colorSpace], ['EXIF version', C.exifVersion], ['Unique image ID', C.imageUniqueID]]));
    if (!D.make && !D.model && !D.software && !D.bodySerial) root.appendChild(h('p', { class: 'muted', text: 'No device information in the metadata.' }));

    root.appendChild(h('h3', { text: 'GPS' }));
    if (G.present && G.lat !== undefined && G.lat !== null) {
      root.appendChild(kvTable([['Latitude', G.latDMS + '  (' + G.lat.toFixed(6) + ')'], ['Longitude', G.lonDMS + '  (' + G.lon.toFixed(6) + ')'], ['Altitude', G.altitudeText], ['Source', G.source || 'EXIF GPS'], ['Fix status', G.status], ['Measure mode', G.measureMode ? G.measureMode + 'D' : ''], ['DOP', G.dop], ['Datum', G.datum], ['Processing method', G.processingMethod], ['Area', G.area], ['Speed', typeof G.speed === 'number' ? G.speed.toFixed(1) + ' ' + (G.speedRef || '') : ''], ['Direction', typeof G.direction === 'number' ? G.direction.toFixed(1) + '°' : ''], ['Irregularities', (G.issues || []).join(' ')]]));
      root.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onclick: function (ev) { var t = G.lat.toFixed(6) + ', ' + G.lon.toFixed(6); if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { ev.target.textContent = 'Copied'; }, function () { ev.target.textContent = t; }); else ev.target.textContent = t; } }, 'Copy coordinates'),
        h('span', { class: 'muted small', text: 'No map is shown on purpose: loading map tiles would make a network request.' })));
    } else root.appendChild(h('p', { class: 'muted', text: G.present ? 'A GPS block exists but holds no usable position.' : 'No GPS data.' }));

    root.appendChild(h('h3', { text: 'Timestamps' }));
    if (S.timestamps.length) {
      var tb = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', { text: 'Field' }), h('th', { text: 'Source' }), h('th', { text: 'As stored' }), h('th', { text: 'Interpreted' }))));
      var tbody = h('tbody'); S.timestamps.forEach(function (t) { tbody.appendChild(h('tr', null, h('td', { text: t.label }), h('td', { text: t.source }), h('td', { class: 'mono', text: t.raw + (t.subsec ? ' .' + t.subsec : '') + (t.offsetText ? ' ' + t.offsetText : '') }), h('td', { text: t.valid ? t.text : (t.issue || 'invalid') }))); });
      tb.appendChild(tbody); root.appendChild(h('div', { class: 'tablewrap' }, tb));
      root.appendChild(h('p', { class: 'muted small', text: 'EXIF capture times carry no time zone unless an OffsetTime tag exists. File-system time is not embedded evidence.' }));
    } else root.appendChild(h('p', { class: 'muted', text: 'No timestamps in the file.' }));

    root.appendChild(h('h3', { text: 'Edit-software traces' }));
    if (S.software.length) {
      var sb = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', { text: 'Source' }), h('th', { text: 'Value' }), h('th', { text: 'Looks like' }))));
      var sbody = h('tbody'); S.software.forEach(function (s) { sbody.appendChild(h('tr', null, h('td', { text: s.source }), h('td', { text: s.value + (s.extra ? ' (' + s.extra + ')' : '') }), h('td', { text: s.label || s.kind }))); });
      sb.appendChild(sbody); root.appendChild(h('div', { class: 'tablewrap' }, sb));
    } else root.appendChild(h('p', { class: 'muted', text: 'No software identifiers in the metadata.' }));

    if (rep.iptc && rep.iptc.order.length) {
      root.appendChild(h('h3', { text: 'IPTC' }));
      root.appendChild(kvTable(rep.iptc.order.map(function (k) { return [rep.iptc.fields[k].name, rep.iptc.fields[k].values.join('; ')]; })));
    }
    if (rep.icc) { root.appendChild(h('h3', { text: 'ICC colour profile' })); root.appendChild(kvTable([['Description', rep.icc.description], ['Colour space', rep.icc.colorSpace], ['Profile class', rep.icc.deviceClass], ['CMM', rep.icc.cmm], ['Version', rep.icc.version], ['Created', rep.icc.created], ['Size', rep.icc.size + ' bytes']])); }
    if (rep.xmpInfo && Object.keys(rep.xmpInfo.props).length) {
      root.appendChild(h('h3', { text: 'XMP properties (' + Object.keys(rep.xmpInfo.props).length + ')' }));
      var xt = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', { text: 'Property' }), h('th', { text: 'Value' }))));
      var xb = h('tbody'); Object.keys(rep.xmpInfo.props).forEach(function (k) { var v = rep.xmpInfo.props[k]; xb.appendChild(h('tr', null, h('td', { class: 'mono', text: k }), h('td', { class: 'mono', text: (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 600) }))); });
      xt.appendChild(xb); root.appendChild(h('div', { class: 'tablewrap' }, xt));
    }
    // raw EXIF
    root.appendChild(h('h3', { text: 'All EXIF tags (' + rep.exifRows.length + ')' }));
    if (rep.exifRows.length) {
      var filter = h('input', { type: 'search', placeholder: 'Filter tags…', 'aria-label': 'Filter EXIF tags', class: 'filter', style: 'padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);margin-bottom:8px;width:260px;max-width:100%' });
      var et = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', { text: 'Directory' }), h('th', { text: 'Tag' }), h('th', { text: 'ID' }), h('th', { text: 'Type × count' }), h('th', { text: 'Value' }))));
      var eb = h('tbody'); et.appendChild(eb);
      var rows = rep.exifRows.map(function (r) { var tr = h('tr', null, h('td', { text: r.ifd }), h('td', { text: r.name }), h('td', { class: 'mono', text: r.idHex }), h('td', { class: 'mono', text: r.type + ' × ' + r.count }), h('td', { class: 'mono', text: r.display })); tr._t = (r.ifd + ' ' + r.name + ' ' + r.display).toLowerCase(); eb.appendChild(tr); return tr; });
      filter.addEventListener('input', function () { var q = filter.value.toLowerCase(); rows.forEach(function (tr) { tr.hidden = q && tr._t.indexOf(q) < 0; }); });
      root.appendChild(filter); root.appendChild(h('div', { class: 'tablewrap' }, et));
    } else root.appendChild(h('p', { class: 'muted', text: 'No EXIF block.' }));
    root.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: function () { download(new Blob([JSON.stringify(QPI.analyze.toJSON(rep), null, 2)], { type: 'application/json' }), e.name.replace(/\.[^.]+$/, '') + '.metadata.json'); } }, 'Download everything as JSON')));
    return root;
  }

  function structureView(e) {
    var rep = e.rep, jp = rep.jpeg, root = h('div');
    root.appendChild(h('h2', { text: 'File structure' }));
    if (jp && jp.frame) {
      var q = jp.quality;
      root.appendChild(kvTable([['Frame', jp.frame.type + ', ' + jp.frame.precision + '-bit'], ['Dimensions', jp.frame.width + ' × ' + jp.frame.height], ['Chroma subsampling', jp.frame.subsampling], ['Scans', jp.scans + (jp.progressive ? ' (progressive)' : ' (sequential)')], ['Restart interval', jp.restartInterval || ''], ['Quantisation', q ? (q.exact ? 'Standard libjpeg tables, quality ' + q.quality : 'Custom tables (closest libjpeg quality ' + q.quality + ')') : ''], ['JFIF', jp.jfif ? 'v' + jp.jfif.version + ', ' + jp.jfif.xDensity + '×' + jp.jfif.yDensity + (jp.jfif.units === 1 ? ' dpi' : jp.jfif.units === 2 ? ' dpcm' : '') : 'absent'], ['Data after EOI', jp.trailing ? jp.trailing.length + ' bytes (' + jp.trailing.kind + ') at offset ' + jp.trailing.offset : 'none']]));
    }
    root.appendChild(h('h3', { text: 'Segments' }));
    var t = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', { text: '#' }), h('th', { text: 'Marker' }), h('th', { text: 'Offset' }), h('th', { text: 'Length' }), h('th', { text: 'Identifier' }))));
    var b = h('tbody'); (jp ? jp.segments : []).forEach(function (s, i) { b.appendChild(h('tr', null, h('td', { text: String(i + 1) }), h('td', { text: s.name }), h('td', { class: 'mono', text: String(s.offset) }), h('td', { class: 'mono', text: s.length + (s.entropyLength ? ' + ' + s.entropyLength + ' image data' : '') }), h('td', { class: 'mono', text: s.id || '' }))); });
    t.appendChild(b); root.appendChild(h('div', { class: 'tablewrap' }, t));
    root.appendChild(h('h3', { text: 'Embedded images' }));
    if (rep.embedded.length) {
      var et = h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', { text: 'Image' }), h('th', { text: 'Size' }), h('th', { text: 'Offset / length' }), h('th', { text: 'SHA-256' }))));
      var eb = h('tbody'); rep.embedded.forEach(function (m) { eb.appendChild(h('tr', null, h('td', { text: m.label }), h('td', { text: (m.width || '?') + '×' + (m.height || '?') }), h('td', { class: 'mono', text: m.offset + ' / ' + m.length }), h('td', { class: 'mono', text: m.hash }))); });
      et.appendChild(eb); root.appendChild(h('div', { class: 'tablewrap' }, et));
    } else root.appendChild(h('p', { class: 'muted', text: 'None found.' }));
    return root;
  }

  var lastReport = { url: null };
  function reportView(e) {
    var root = h('div'), info = { caseNo: store('caseNo'), examiner: store('examiner'), org: store('org'), evidenceNo: '', purpose: '', notes: '' };
    var opts = { maskSensitive: false, includeImages: true };
    root.appendChild(h('h2', { text: 'Printable case report' }));
    root.appendChild(h('p', { class: 'muted', text: 'Builds a standalone report with file hashes, findings, the thumbnail comparison, a segment map and the limitations. Use “Print / save as PDF” and choose “Save as PDF” in the print dialog.' }));
    function input(label, key, wide, area) {
      var el = area ? h('textarea', { rows: '3' }) : h('input', { type: 'text' });
      el.value = info[key] || '';
      el.addEventListener('input', function () { info[key] = el.value; if (key === 'caseNo' || key === 'examiner' || key === 'org') store(key, el.value); });
      return h('label', { class: wide ? 'wide' : '' }, label, el);
    }
    root.appendChild(h('div', { class: 'form' }, input('Case / reference no.', 'caseNo'), input('Examiner', 'examiner'), input('Organisation / lab', 'org'), input('Evidence item no.', 'evidenceNo'), input('Request / purpose', 'purpose', true), input('Examiner notes (printed in the report)', 'notes', true, true)));
    root.appendChild(h('div', { class: 'checks' },
      h('label', null, h('input', { type: 'checkbox', onchange: function (ev) { opts.maskSensitive = ev.target.checked; } }), ' Mask GPS coordinates, serial numbers and owner name'),
      h('label', null, h('input', { type: 'checkbox', checked: true, onchange: function (ev) { opts.includeImages = ev.target.checked; } }), ' Include thumbnail and preview images')));
    var frameBox = h('div');
    function build() { return QPI.report.build(e, info, opts); }
    function show() {
      clear(frameBox);
      if (lastReport.url) { URL.revokeObjectURL(lastReport.url); lastReport.url = null; }
      lastReport.url = URL.createObjectURL(new Blob([build()], { type: 'text/html' }));
      frameBox.appendChild(h('iframe', { class: 'preview', src: lastReport.url, title: 'Report preview' }));
    }
    root.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: function () { show(); var f = frameBox.firstChild; f.addEventListener('load', function () { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (err) { alert('Printing is blocked here. Use “Download report” and print the saved file.'); } }, { once: true }); } }, 'Print / save as PDF'),
      h('button', { class: 'btn', type: 'button', onclick: show }, 'Preview'),
      h('button', { class: 'btn', type: 'button', onclick: function () { download(new Blob([build()], { type: 'text/html' }), 'photo-report-' + e.name.replace(/\.[^.]+$/, '') + '.html'); } }, 'Download report (.html)'),
      h('button', { class: 'btn', type: 'button', onclick: function () { download(new Blob([JSON.stringify(QPI.analyze.toJSON(e.rep), null, 2)], { type: 'application/json' }), 'photo-report-' + e.name.replace(/\.[^.]+$/, '') + '.json'); } }, 'Download JSON')));
    if (e.status === 'comparing') root.appendChild(h('div', { class: 'callout', text: 'The thumbnail comparison is still running; wait for it to finish before building the report so that it includes the result.' }));
    root.appendChild(frameBox);
    return root;
  }

  function limitsView() {
    var root = h('div');
    root.appendChild(h('h2', { text: 'What this tool can and cannot tell you' }));
    root.appendChild(h('div', { class: 'callout', text: 'Findings are leads for an examiner, not verdicts. A file with no flags can still be edited; a file with flags can have innocent explanations.' }));
    root.appendChild(h('ol', { class: 'limits' }, QPI.analyze.LIMITS.map(function (l) { return h('li', { text: l }); })));
    root.appendChild(h('h3', { text: 'How the thumbnail comparison works' }));
    root.appendChild(h('p', { text: 'Both images are reduced to brightness values. The tool searches the thumbnail for a rectangle that matches the whole main image (meaning the main image was cropped), and the main image for a rectangle that matches the thumbnail (the thumbnail is partial). Matching uses correlation, which ignores overall brightness and contrast changes. It tries the EXIF rotations and ignores black letterbox bars. If the frames line up, residual differences are mapped.' }));
    root.appendChild(h('h3', { text: 'Independent verification' }));
    root.appendChild(h('p', { text: 'The metadata parser is cross-checked against exiftool and Pillow/piexif in the project\'s test suite (tests/CROSSCHECK.md lists every compared field and any disagreement).' }));
    return root;
  }

  // ---------------- wiring ----------------
  function init() {
    $('ver').textContent = 'v' + QPI.analyze.VERSION;
    var drop = $('drop'), input = $('file');
    drop.addEventListener('click', function (ev) { if (ev.target.id !== 'demo') input.click(); });
    drop.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (n) { document.addEventListener(n, function (ev) { ev.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { document.addEventListener(n, function (ev) { ev.preventDefault(); if (n === 'drop' || ev.target === document.documentElement) drop.classList.remove('over'); }); });
    document.addEventListener('drop', function (ev) { if (ev.dataTransfer && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files); });
    $('add').addEventListener('click', function () { input.click(); });
    $('to-limits').addEventListener('click', function () { $('work').hidden = false; document.body.classList.add('has-files'); state.tab = 'limits'; render(); });
    $('demo').addEventListener('click', function (ev) {
      ev.stopPropagation();
      var s = QPI.samples && QPI.samples[0];
      if (!s) { alert('No demo photo is bundled in this build.'); return; }
      var bin = atob(s.b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      addFiles([new File([u8], s.name, { type: 'image/jpeg', lastModified: 1700000000000 })]);
    });
    renderTabs();
  }
  init();
})();
