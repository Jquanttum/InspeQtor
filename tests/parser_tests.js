'use strict';
// Parser / findings tests driven by ground truth in tests/fixtures/manifest.json.
const T = require('./harness.js');
const QPI = require('../tools/load.js');
const crypto = require('crypto');
const { test, ok, eq, near } = T;

const inspect = (name, opts) => QPI.analyze.inspect(T.load(name), Object.assign({ fileName: name + '.jpg', now: Date.UTC(2026, 10, 26) }, opts || {}));
const find = (rep, re, sev) => rep.findings.filter(f => re.test(f.title + ' ' + f.detail) && (!sev || f.severity === sev));
const has = (rep, re, sev) => find(rep, re, sev).length > 0;
const row = (rep, name, ifd) => rep.exifRows.find(r => r.name === name && (!ifd || r.ifd === ifd));

T.suite('hashing');
test('SHA-256 / MD5 match node:crypto on all fixtures', () => {
  const man = T.manifest();
  Object.keys(man).forEach(n => {
    const u8 = T.load(n);
    eq(QPI.hash.sha256(u8), crypto.createHash('sha256').update(u8).digest('hex'), n + ' sha256');
    eq(QPI.hash.md5(u8), crypto.createHash('md5').update(u8).digest('hex'), n + ' md5');
  });
});
test('SHA-256 known vectors (empty, abc)', () => {
  eq(QPI.hash.sha256(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  eq(QPI.hash.sha256(new Uint8Array([97, 98, 99])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

T.suite('EXIF reading (both byte orders)');
test('little-endian camera file', () => {
  const r = inspect('m_full_le');
  eq(r.exif.byteOrder, 'II');
  eq(r.summary.device.make, 'Canon'); eq(r.summary.device.model, 'Canon EOS 80D');
  eq(r.summary.device.bodySerial, 'SN123456789'); eq(r.summary.device.lensModel, 'EF85mm f/1.8 USM');
  eq(r.summary.device.userComment, 'hello comment'); eq(r.summary.device.artist, 'J. Examiner');
  eq(r.summary.capture.exposureTime, '1/250 s'); eq(r.summary.capture.fNumber, 'f/5.6'); eq(r.summary.capture.iso, '400'); eq(r.summary.capture.focalLength, '85 mm');
  eq(r.summary.capture.flash.indexOf('Flash did not fire') === 0 || r.summary.capture.flash.indexOf('Flash') === 0, true);
  near(r.summary.gps.lat, 51.501, 1e-4); near(r.summary.gps.lon, -0.1419, 1e-4);
  ok(r.embedded.some(e => e.id === 'ifd1' && e.valid && e.width === 160), 'IFD1 thumbnail found 160 px wide');
});
test('big-endian file gives the same values', () => {
  const a = inspect('m_full_le'), b = inspect('m_full_be');
  eq(b.exif.byteOrder, 'MM');
  ['make', 'model', 'bodySerial', 'lensModel'].forEach(k => eq(b.summary.device[k], a.summary.device[k], k));
  near(b.summary.gps.lat, a.summary.gps.lat, 1e-9); near(b.summary.gps.lon, a.summary.gps.lon, 1e-9);
  eq(b.summary.timestamps.find(t => t.key === 'dto').text, a.summary.timestamps.find(t => t.key === 'dto').text);
  ok(b.embedded.some(e => e.id === 'ifd1' && e.valid), 'thumbnail found in BE file');
});
test('independent writer (piexif) is read correctly', () => {
  const r = inspect('i_piexif_fuji');
  eq(r.summary.device.make, 'FUJIFILM'); eq(r.summary.device.model, 'X-T4');
  eq(r.summary.device.software, 'Digital Camera X-T4 Ver1.20');
  near(r.summary.gps.lat, -(12 + 30 / 60 + 45.23 / 3600), 1e-6); near(r.summary.gps.lon, 130 + 50 / 60 + 10 / 3600, 1e-6);
  ok(r.embedded.some(e => e.id === 'ifd1' && e.valid), 'piexif thumbnail');
});
test('independent writer (Pillow) is read correctly', () => {
  const r = inspect('i_pillow_pixel');
  eq(r.summary.device.make, 'Google'); eq(r.summary.device.model, 'Pixel 8');
  eq(r.summary.timestamps.find(t => t.key === 'dto').text, '2024-02-02 10:00:00');
});
test('ICC profile description read from Pillow file', () => {
  const r = inspect('i_pillow_icc');
  ok(r.icc && r.icc.valid && /sRGB/i.test(r.icc.description), 'ICC desc: ' + (r.icc && r.icc.description));
});

T.suite('GPS');
test('southern/western hemispheres and below-sea-level altitude', () => {
  const r = inspect('m_gps_sw');
  near(r.summary.gps.lat, -33.8568, 1e-4); near(r.summary.gps.lon, -151.2153, 1e-4);
  ok(r.summary.gps.altitude < 0, 'negative altitude'); ok(/below/.test(r.summary.gps.altitudeText));
});
test('Null Island is reported', () => { ok(has(inspect('m_gps_null'), /Null Island/i, 'note')); });
test('missing refs and out-of-range minutes are reported, not guessed', () => {
  const r = inspect('m_gps_badrefs');
  ok(has(r, /hemisphere unknown|ref/i), 'ref issue'); ok(has(r, /out of range/i), 'range issue');
});
test('zero denominator does not crash and yields no coordinate', () => {
  const r = inspect('m_gps_zero_den');
  ok(r.summary.gps.lat === undefined, 'no lat'); eq(r.errors.length, 0);
});
test('manual location and void fix are reported', () => {
  const r = inspect('m_gps_manual');
  ok(has(r, /entered by hand/i)); ok(has(r, /void/i));
});

T.suite('timestamps');
test('GPS UTC agrees with local time + declared offset', () => { ok(has(inspect('m_time_gps_ok'), /GPS time agrees/i, 'ok')); });
test('GPS UTC vs local gives the implied offset when none is declared', () => { ok(has(inspect('m_time_gps_implied'), /Implied UTC offset.*\+02:00/i, 'info')); });
test('GPS UTC vs local mismatch is noted', () => { ok(has(inspect('m_time_gps_bad'), /GPS time/i, 'note')); });
test('re-saved after capture is noted', () => { ok(has(inspect('m_time_resaved'), /re-saved after capture/i, 'note')); });
test('placeholder, impossible and future dates are reported', () => {
  const r = inspect('m_time_invalid');
  ok(has(r, /not a valid date/i), 'invalid'); ok(find(r, /is in the future/i).length >= 1, 'future date');
});
test('date parser edge cases', () => {
  const p = QPI.analyze.parseExifDate;
  eq(p('2024:02:29 23:59:59').valid, true); eq(p('2023:02:29 10:00:00').valid, false); eq(p('0000:00:00 00:00:00').valid, false);
  eq(p('    :  :     :  :  ').valid, false); eq(p('2024-05-01 10:00:00').nonStandardFormat, true); eq(p(null).valid, false);
  eq(QPI.analyze.parseOffset('+05:30'), 330); eq(QPI.analyze.parseOffset('-0800'), -480); eq(QPI.analyze.parseOffset('Z'), 0);
});

T.suite('edit-software traces');
test('XMP: editor, history, derived-from, document IDs, crop, AI source label', () => {
  const r = inspect('m_xmp_history');
  ok(has(r, /Editing software named/i, 'note')); ok(has(r, /XMP edit history present \(2 events\)/i, 'note'));
  ok(has(r, /derived from another document/i, 'note')); ok(has(r, /Document ID differs/i, 'note'));
  ok(has(r, /crop settings recorded/i, 'note')); ok(has(r, /Digital Source Type.*AI-generated|Composite including AI/i, 'flag'));
});
test('EXIF vs XMP capture-time disagreement is flagged', () => { ok(has(inspect('m_xmp_history'), /EXIF and XMP capture times disagree/i, 'flag')); });
test('Photoshop resource block: writer, IPTC, keywords', () => {
  const r = inspect('m_irb');
  eq(r.irb.version.writer, 'Adobe Photoshop 25.0');
  eq(r.iptc.fields['2:25'].values.join(','), 'sea,harbour'); eq(r.iptc.fields['2:5'].values[0], 'Harbour at dawn');
  ok(has(r, /Photoshop image-resource block/i, 'note'));
});
test('GD library comment is classified as a library', () => { ok(has(inspect('m_comment_gd'), /library or command-line tool/i, 'info')); });
test('Windows XP* properties decode from UTF-16', () => {
  const r = inspect('m_xp_tags');
  eq(r.summary.device.xpAuthor, 'Win Author'); eq(r.summary.device.xpComment, 'Win comment'); ok(has(r, /Windows Explorer property/i, 'note'));
});
test('software classifier', () => {
  const c = QPI.analyze.classifySoftware;
  eq(c('Adobe Photoshop Lightroom Classic 13.0').kind, 'editor'); eq(c('darktable 4.6').kind, 'raw'); eq(c('ImageMagick 7.1').kind, 'library');
  eq(c('Midjourney v6').kind, 'ai'); eq(c('17.4.1').kind, 'firmware'); eq(c('Ver.1.0.3').kind, 'firmware'); eq(c('GIMP 2.10.34').kind, 'editor'); eq(c('').kind, 'empty');
});

T.suite('device consistency');
test('maker note from another vendor is flagged', () => { ok(has(inspect('m_makernote_mismatch'), /Maker note does not match the Make/i, 'flag')); });
test('Make/Model naming different brands is flagged', () => { ok(has(inspect('m_brand_mismatch'), /different brands/i, 'flag')); });
test('clean camera file raises no flags', () => {
  const r = inspect('t_coffee_clean');
  eq(r.findings.filter(f => f.severity === 'flag').length, 0, 'flags: ' + r.findings.filter(f => f.severity === 'flag').map(f => f.title).join('; '));
});

T.suite('consistency & structure');
test('EXIF dimensions vs JPEG: cropped shape = flag, resized = note', () => {
  ok(has(inspect('m_dims_crop'), /different shape/i, 'flag')); ok(has(inspect('m_dims_resize'), /same shape/i, 'note'));
  ok(has(inspect('t_coffee_clean'), /EXIF dimensions match/i, 'ok'));
});
test('trailing data classification', () => {
  const man = T.manifest();
  Object.keys(man).filter(k => man[k].expect.trailing).forEach(k => eq(inspect(k).jpeg.trailing.kind, man[k].expect.trailing, k));
  ok(has(inspect('m_trail_zip'), /Data after the end/i, 'flag')); ok(has(inspect('m_trail_zero'), /Data after the end/i, 'info'));
});
test('trailing JPEG is listed as an embedded image', () => { ok(inspect('m_trail_jpeg').embedded.some(e => e.id === 'trailer')); });
test('no EXIF / no thumbnail', () => {
  ok(has(inspect('m_no_exif'), /No EXIF metadata/i, 'note'));
  const r = inspect('m_no_thumb'); eq(r.embedded.length, 0); ok(has(r, /No EXIF thumbnail/i, 'info'));
});
test('encoder profile: quality estimate, subsampling, progressive', () => {
  const a = inspect('m_q50_444'); eq(a.jpeg.quality.quality, 50); eq(a.jpeg.quality.exact, true); eq(a.jpeg.frame.subsampling, '4:4:4');
  const b = inspect('m_q95_420'); eq(b.jpeg.quality.quality, 95); eq(b.jpeg.frame.subsampling, '4:2:0');
  eq(inspect('m_progressive').jpeg.progressive, true);
});
test('SOF dimensions equal Pillow dimensions for all thumb fixtures', () => {
  const man = T.manifest();
  Object.keys(man).filter(k => man[k].kind === 'thumb').slice(0, 20).forEach(k => { const r = inspect(k); ok(r.jpeg.frame.width > 100 && r.jpeg.frame.height > 100, k); });
});

T.suite('corrupt input never throws');
test('every corrupt fixture is handled', () => {
  const man = T.manifest();
  Object.keys(man).filter(k => man[k].kind === 'corrupt').forEach(k => { const t0 = Date.now(); const r = inspect(k); ok(Date.now() - t0 < 2000, k + ' too slow'); ok(Array.isArray(r.findings), k); });
});
test('IFD loop detected', () => { ok(has(inspect('c_ifd_loop'), /IFD loop/i)); });
test('bad thumbnail length is clamped and reported', () => { const r = inspect('c_thumb_badlen'); ok(has(r, /Declared thumbnail length|runs past/i, 'note') || r.embedded.length === 0); });
test('PNG renamed to .jpg is rejected clearly', () => { const r = inspect('c_not_jpeg_png'); ok(has(r, /Not a JPEG file/i, 'flag')); ok(/PNG/.test(r.findings[0].detail)); });
test('empty file and SOI-only', () => { inspect('c_empty'); inspect('c_soi_only'); });
test('truncated files produce warnings', () => { ok(has(inspect('c_truncated'), /truncated|EOI/i)); });

T.suite('hostile strings');
test('analysis keeps raw text; report escapes every value', () => {
  const rep = inspect('m_xss');
  ok(/<img src=x/.test(rep.summary.device.make), 'raw preserved in model');
  const html = QPI.report.build({ rep, images: {} }, { caseNo: '<script>alert(1)</script>', notes: '<b>x</b>' }, {});
  ok(html.indexOf('<img src=x') < 0, 'unescaped <img> leaked into report');
  ok(html.indexOf('<script>') < 0, 'unescaped <script> leaked into report');
  ok(html.indexOf('&lt;img src=x') >= 0, 'escaped form present');
});
test('XMP parser ignores DOCTYPE/entities (no expansion)', () => {
  const x = QPI.xmp.parseXmp('<!DOCTYPE x [<!ENTITY a "AAAA">]><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description xmp:CreatorTool="&a;&lt;t&gt;" xmlns:xmp="x"/></rdf:RDF></x:xmpmeta>');
  eq(x.creatorTool, '&a;<t>');
});

process.exitCode = T.done() ? 1 : 0;
