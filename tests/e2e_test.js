'use strict';
// Browser end-to-end: file:// load, CSP, upload, verdicts, XSS, zero network, report + print.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const root = path.resolve(__dirname, '..'), fx = f => path.join(__dirname, 'fixtures', f);
const out = path.join(__dirname, 'results'); fs.mkdirSync(out, { recursive: true });
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const exe = fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {};
  const b = await chromium.launch(exe); const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const net = [], errs = [], csp = [];
  page.on('request', r => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); });
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (/Content Security Policy|Refused/i.test(m.text())) csp.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', d => { errs.push('DIALOG ' + d.message()); d.dismiss(); });
  await page.goto('file://' + root + '/index.html');
  ok(await page.evaluate(() => !!(window.QPI && QPI.analyze)), 'scripts load from file:// under CSP');
  async function load(files) {
    await page.setInputFiles('#file', files.map(fx));
    await page.waitForFunction(() => !document.querySelector('#content .spinner'), null, { timeout: 30000 });
    await page.waitForTimeout(800);
  }
  const text = () => page.locator('#content').innerText();
  // 1. cropped photo with preserved original thumbnail
  await load(['t_chelsea_crop_c60.jpg']);
  let t = await text();
  ok(/crop/i.test(t), 'cropped fixture: summary mentions crop');
  await page.getByRole('tab', { name: /thumbnail/i }).click(); await page.waitForTimeout(500);
  ok(await page.locator('#content canvas, #content img').count() > 0, 'thumbnail tab shows images/canvases');
  await page.screenshot({ path: path.join(out, 'e2e_thumbnail.png') });
  // 2. clean file
  await page.reload(); await load(['t_chelsea_clean.jpg']);
  t = await text(); ok(!/cropped/i.test(t.split('Metadata')[0]) || /consistent|matches/i.test(t), 'clean fixture: not reported as cropped');
  // 3. GPS + software
  await page.reload(); await load(['m_gps_sw.jpg']);
  t = await text(); ok(/GPS|latitude|°/i.test(t), 'GPS fixture: location reported');
  ok(/software|Photoshop|edit/i.test(t), 'software traces reported');
  // 4. XSS payload
  await page.reload(); await load(['m_xss.jpg']);
  for (const tab of ['Summary', 'Thumbnail', 'Metadata', 'Structure', 'Case report']) {
    const tb = page.getByRole('tab', { name: new RegExp(tab, 'i') }); if (await tb.count()) { await tb.first().click(); await page.waitForTimeout(300); }
  }
  ok(await page.evaluate(() => window.__xss === undefined), 'XSS fixture: payload did not execute (window.__xss unset)');
  ok(!errs.some(e => /DIALOG/.test(e)), 'XSS fixture: no dialogs');
  // 5. report + print
  await page.reload(); await load(['t_chelsea_crop_c60.jpg']);
  await page.getByRole('tab', { name: /case report/i }).click(); await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^preview$/i }).click(); await page.waitForTimeout(1200);
  ok(await page.locator('iframe.preview').count() > 0, 'report preview iframe present');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /download report/i }).click()]);
  await dl.saveAs(path.join(out, 'e2e_report.html'));
  const html = fs.readFileSync(path.join(out, 'e2e_report.html'), 'utf8');
  ok(/SHA-256/.test(html) && /limitations/i.test(html), 'report contains hashes and limitations');
  ok(/<script/i.test(html) === false, 'report contains no script');
  const rp = await ctx.newPage();
  await rp.goto('file://' + path.join(out, 'e2e_report.html'));
  await rp.pdf({ path: path.join(out, 'e2e_report.pdf'), format: 'A4', printBackground: true });
  ok(fs.statSync(path.join(out, 'e2e_report.pdf')).size > 5000, 'report prints to PDF');
  await page.screenshot({ path: path.join(out, 'e2e_report_tab.png') });
  // 5b. bundled demo photo
  await page.reload(); await page.click('#demo'); await page.waitForFunction(() => !document.querySelector('#content .spinner'), null, { timeout: 30000 }); await page.waitForTimeout(800);
  ok(/crop/i.test(await text()), 'demo button: bundled demo reports a cropped main image');
  // 6. non-JPEG & demo
  await page.reload(); await page.setInputFiles('#file', [path.join(root, 'index.html')]); await page.waitForTimeout(1000);
  ok(!errs.some(e => /TypeError|ReferenceError/.test(e)), 'non-JPEG input handled without script errors');
  ok(net.length === 0, 'zero network requests (' + net.length + ')');
  ok(csp.length === 0, 'no CSP violations' + (csp.length ? ': ' + csp[0] : ''));
  if (errs.length) console.log('console/page errors:', errs.slice(0, 5));
  await b.close(); console.log(fail ? fail + ' FAILED' : 'e2e OK'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
