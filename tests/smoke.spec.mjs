// Travel Atlas smoke tests — one test (or group) per acceptance check in the brief.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'screenshots');

// ---------- helpers ----------

/** Absolute app root URL (always ends in "/"), derived from the configured baseURL. */
function appRoot(testInfo) {
  const b = testInfo.project.use.baseURL;
  return b.endsWith('/') ? b : b + '/';
}

/** Collect console errors and page errors from the moment of the call. */
function watchErrors(page) {
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}

/** Load the app and wait until both maps and all five counters exist. */
async function openApp(page) {
  await page.goto('./');
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  await expect(page.locator('.stats .stat')).toHaveCount(5);
}

async function counters(page) {
  return page.$$eval('.stats .stat .num', els => els.map(e => e.textContent.replace(/\s+/g, '')));
}

/**
 * Find an on-screen point that really hits the element `sel` (or another node with the same
 * data-id). Scrolls it into view, samples its geometry with isPointInFill, converts to screen
 * coordinates, and confirms with elementFromPoint (so labels/overlays covering it are avoided).
 */
async function hitPoint(page, sel) {
  const pt = await page.evaluate(sel => {
    const elm = document.querySelector(sel);
    if (!elm) return { err: 'no element ' + sel };
    const id = elm.dataset.id;
    elm.scrollIntoView({ block: 'center', inline: 'center' });
    const bb = elm.getBBox();
    const ctm = elm.getScreenCTM();
    const svg = elm.ownerSVGElement;
    const N = 60, cand = [];
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = bb.x + bb.width * i / N, y = bb.y + bb.height * j / N;
      const p = svg.createSVGPoint(); p.x = x; p.y = y;
      let inside = true;
      try { inside = elm.isPointInFill(p); } catch (_) {}
      if (!inside) continue;
      const s = p.matrixTransform(ctm);
      cand.push({ x: s.x, y: s.y, d: Math.hypot(i - N / 2, j - N / 2) });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand) {
      if (c.x < 1 || c.y < 1 || c.x > innerWidth - 1 || c.y > innerHeight - 1) continue;
      const hit = document.elementFromPoint(c.x, c.y);
      const hid = hit && hit.closest && hit.closest('[data-id]');
      if (hid && hid.dataset.id === id) return { x: c.x, y: c.y, tag: hit.tagName };
    }
    return { err: `no clickable point for ${sel} (${cand.length} candidates)` };
  }, sel);
  expect(pt.err, pt.err).toBeUndefined();
  return pt;
}

async function clickPlace(page, sel) {
  const p = await hitPoint(page, sel);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  return p;
}

/** Every node with this data-id carries class "on" (how paint() marks a visited place). */
async function isMarked(page, id) {
  return page.evaluate(id => {
    const ns = [...document.querySelectorAll(`svg.map [data-id="${id}"]`)];
    return ns.length > 0 && ns.every(n => n.classList.contains('on'));
  }, id);
}

async function chipNames(page, map) {
  return page.$$eval(`#list-${map} .chip`, els => els.map(e => e.firstChild.textContent));
}

/**
 * Clear storage the way a user would see it: leave the app first (its pagehide handler
 * re-saves marks, so clearing while the app is open and then reloading would be undone),
 * clear localStorage from a same-origin non-app document, then come back.
 */
async function clearStorageAndReopen(page) {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(() => localStorage.clear());
  await openApp(page);
}

async function openBackup(page) {
  await page.click('#backup-btn');
  await expect(page.locator('#backup')).toBeVisible();
}

// ---------- 1 + 2: clean load ----------

test('01 loads with no console errors', async ({ page }) => {
  const errs = watchErrors(page);
  await openApp(page);
  await page.waitForTimeout(1500); // let SW registration / late fetches settle
  expect(errs, errs.join('\n')).toEqual([]);
  await expect(page.locator('#status')).toHaveText('Saved on this device');
});

test('02 counters read 0/50 0/6 0/13 0/196 0/45 in order', async ({ page }) => {
  await openApp(page);
  expect(await counters(page)).toEqual(['0/50', '0/6', '0/13', '0/196', '0/45']);
  const labels = await page.$$eval('.stats .stat .label', els => els.map(e => e.textContent));
  expect(labels).toEqual(['U.S. states', 'D.C. & territories', 'Canadian provinces & territories', 'Countries', 'Territories & other places']);
});

// ---------- 3 + 4: marking and persistence ----------

test('03-04 click US-CO, Hawaii inset, FRA, SGP dot; counters + chips; survive reload', async ({ page }) => {
  const errs = watchErrors(page);
  await openApp(page);
  await clickPlace(page, 'svg.map[data-map="na"] path.place[data-id="US-CO"]');
  await clickPlace(page, 'svg.map[data-map="na"] rect.inset-bg[data-id="US-HI"]');
  await clickPlace(page, 'svg.map[data-map="world"] path.place[data-id="FRA"]');
  const sg = await clickPlace(page, 'svg.map[data-map="world"] circle.dot[data-id="SGP"]');
  expect(sg.tag.toLowerCase()).toBe('circle');

  for (const id of ['US-CO', 'US-HI', 'FRA', 'SGP']) expect(await isMarked(page, id), id).toBe(true);
  expect(await counters(page)).toEqual(['2/50', '0/6', '0/13', '2/196', '0/45']);
  expect((await chipNames(page, 'na')).sort()).toEqual(['Colorado', 'Hawaii']);
  expect((await chipNames(page, 'world')).sort()).toEqual(['France', 'Singapore']);
  await expect(page.locator('#list-na .lead')).toHaveText('Been there (2):');

  await page.reload();
  await openApp(page);
  for (const id of ['US-CO', 'US-HI', 'FRA', 'SGP']) expect(await isMarked(page, id), id + ' after reload').toBe(true);
  expect(await counters(page)).toEqual(['2/50', '0/6', '0/13', '2/196', '0/45']);
  expect(errs, errs.join('\n')).toEqual([]);
});

// ---------- 5: drag never toggles ----------

test('05 dragging across Brazil does not toggle it', async ({ page }) => {
  await openApp(page);
  // zoom in first so the drag also visibly pans (at 1x the view is clamped and cannot move)
  const p = await hitPoint(page, 'svg.map[data-map="world"] path.place[data-id="BRA"]');
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(50); }
  const q = await hitPoint(page, 'svg.map[data-map="world"] path.place[data-id="BRA"]');
  const vb0 = await page.getAttribute('svg.map[data-map="world"]', 'viewBox');
  await page.mouse.move(q.x, q.y);
  await page.mouse.down();
  await page.mouse.move(q.x + 120, q.y + 40, { steps: 12 });
  await page.mouse.up();
  const vb1 = await page.getAttribute('svg.map[data-map="world"]', 'viewBox');
  expect(vb1, 'drag should pan the zoomed map').not.toBe(vb0);
  expect(await isMarked(page, 'BRA')).toBe(false);
  expect(await counters(page)).toEqual(['0/50', '0/6', '0/13', '0/196', '0/45']);

  // and a drag at 1x zoom (no pan possible) still doesn't toggle
  await page.click('.zoom[data-for="world"] [data-z="reset"]');
  const r = await hitPoint(page, 'svg.map[data-map="world"] path.place[data-id="BRA"]');
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + 60, r.y + 10, { steps: 8 });
  await page.mouse.move(r.x + 2, r.y + 1, { steps: 8 }); // end back inside Brazil
  await page.mouse.up();
  expect(await isMarked(page, 'BRA')).toBe(false);
});

// ---------- 6: wheel ----------

test('06 wheel-up zooms; wheel-down at full zoom-out scrolls the page', async ({ page }) => {
  await openApp(page);
  const sel = 'svg.map[data-map="na"]';
  // put the NA map in view with page room above/below
  await page.evaluate(() => {
    const f = document.querySelector('#frame-na').getBoundingClientRect();
    window.scrollTo(0, Math.max(0, scrollY + f.top - 60));
  });
  const box = await page.locator(sel).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 300);

  // wheel-down at 1x passes through to page scroll
  const y0 = await page.evaluate(() => scrollY);
  const vbStart = await page.getAttribute(sel, 'viewBox');
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0);
  expect(await page.getAttribute(sel, 'viewBox')).toBe(vbStart);

  // wheel-up over the map zooms (viewBox changes) and does not scroll the page
  const box2 = await page.locator(sel).boundingBox();
  const mx = box2.x + box2.width / 2, my = Math.max(box2.y + 50, Math.min(box2.y + box2.height / 2, 400));
  await page.mouse.move(mx, my);
  const y1 = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => page.getAttribute(sel, 'viewBox')).not.toBe(vbStart);
  const [, , w] = (await page.getAttribute(sel, 'viewBox')).split(' ').map(Number);
  expect(w).toBeLessThan(1000);
  expect(await page.evaluate(() => scrollY)).toBe(y1);
});

// ---------- 7: real map ----------

test('07 real map: terrain only after toggle; "Algeria" label appears when zoomed', async ({ page, context }) => {
  const reqs = [];
  context.on('request', r => reqs.push(r.url()));
  const terrainResp = [];
  page.on('response', r => { if (/\/terrain\/[^/]+\.jpg/.test(r.url())) terrainResp.push({ url: r.url(), status: r.status() }); });
  await openApp(page);
  await page.waitForTimeout(1500);
  const terrainBefore = reqs.filter(u => /\/terrain\/.*\.jpg/.test(u));
  expect(terrainBefore, 'no terrain before toggle').toEqual([]);
  expect(await page.locator('svg.map image.terrain[href]').count()).toBe(0);

  await page.click('#style-seg button[data-style="real"]');
  await expect(page.locator('body')).toHaveClass(/\breal\b/);
  await expect.poll(() => terrainResp.map(r => r.url.split('/').pop()).sort()).toEqual(
    expect.arrayContaining(['na.jpg', 'world.jpg', 'inset-0.jpg', 'inset-6.jpg']));
  await expect.poll(() => terrainResp.length).toBeGreaterThanOrEqual(9);
  for (const r of terrainResp) expect(r.status, r.url).toBe(200);
  // the images actually decoded in the page
  const decoded = await page.evaluate(async () => {
    const urls = [...document.querySelectorAll('svg.map image.terrain')].map(i => new URL(i.getAttribute('href'), location.href).href);
    return Promise.all(urls.map(u => new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth); im.onerror = () => res(0); im.src = u; })));
  });
  expect(decoded.length).toBe(9);
  for (const w of decoded) expect(w).toBeGreaterThan(0);

  // zoom over Algeria. At 1280px wide Algeria already fits its name at 1x, so narrow the
  // viewport first to prove the label is hidden at 1x and appears only after zooming in.
  const lbl = page.locator('svg.map[data-map="world"] text.lbl', { hasText: /^Algeria$/ });
  await expect(lbl).toHaveCount(1);
  const at1280 = await lbl.evaluate(t => getComputedStyle(t).display);
  await page.setViewportSize({ width: 480, height: 800 });
  await expect.poll(() => lbl.evaluate(t => getComputedStyle(t).display)).toBe('none');
  const before = 'none';
  const p = await hitPoint(page, 'svg.map[data-map="world"] path.place[data-id="DZA"]');
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(60); }
  const vbw = +(await page.getAttribute('svg.map[data-map="world"]', 'viewBox')).split(' ')[2];
  expect(vbw).toBeLessThan(600);
  await expect.poll(() => lbl.evaluate(t => getComputedStyle(t).display)).not.toBe('none');
  await expect(lbl).toBeVisible();
  test.info().annotations.push({ type: 'note', description: `Algeria label at 1280px/1x: ${at1280}; at 480px/1x: ${before}; viewBox width after zoom ${vbw}` });
  // the choice is remembered
  await page.reload();
  await openApp(page);
  await expect(page.locator('body')).toHaveClass(/\breal\b/);
});

// ---------- 8: owner name ----------

test('08 owner name "Sam" shows "Sam’s Travel Atlas" and survives reload', async ({ page }) => {
  await openApp(page);
  // rendered text (innerText honours display:none) — the possessive must hide when the name is empty
  await expect.poll(() => page.locator('h1').evaluate(h => h.innerText.trim())).toBe('Travel Atlas');
  await page.click('#owner');
  await page.keyboard.type('Sam');
  await page.keyboard.press('Enter');
  await expect(page.locator('h1')).toHaveText('Sam’s Travel Atlas');
  expect(await page.locator('h1').evaluate(h => h.innerText.trim())).toBe('Sam’s Travel Atlas');
  expect(await page.title()).toContain('Sam’s Travel Atlas');
  await page.reload();
  await openApp(page);
  await expect(page.locator('h1')).toHaveText('Sam’s Travel Atlas');
  expect(await page.title()).toContain('Sam’s Travel Atlas');
});

// ---------- 9: backup ----------

test('09a backup code round-trip', async ({ page }) => {
  await openApp(page);
  await clickPlace(page, 'svg.map[data-map="na"] path.place[data-id="US-CO"]');
  await clickPlace(page, 'svg.map[data-map="world"] path.place[data-id="FRA"]');
  await clickPlace(page, 'svg.map[data-map="world"] circle.dot[data-id="SGP"]');
  await openBackup(page);
  const code = await page.inputValue('#code-out');
  expect(code).toBe('atlas1:FRA,SGP,US-CO');

  await clearStorageAndReopen(page);
  expect(await counters(page)).toEqual(['0/50', '0/6', '0/13', '0/196', '0/45']);

  await openBackup(page);
  await page.fill('#code-in', code);
  await page.click('#restore-code');
  await expect(page.locator('#restore-note')).toHaveText(/Added 3 new places/);
  for (const id of ['US-CO', 'FRA', 'SGP']) expect(await isMarked(page, id), id).toBe(true);
  expect(await counters(page)).toEqual(['1/50', '0/6', '0/13', '2/196', '0/45']);
  expect(await page.inputValue('#code-out')).toBe(code);
});

test('09b pasting atlas1:US-CA,FRA,ZZZ adds 2 and skips 1', async ({ page }) => {
  await openApp(page);
  await openBackup(page);
  await page.fill('#code-in', 'atlas1:US-CA,FRA,ZZZ');
  await page.click('#restore-code');
  const note = page.locator('#restore-note');
  await expect(note).toHaveText(/Added 2 new places/);
  await expect(note).toHaveText(/1 unrecognized entry skipped/);
  expect(await isMarked(page, 'US-CA')).toBe(true);
  expect(await isMarked(page, 'FRA')).toBe(true);
  expect(await counters(page)).toEqual(['1/50', '0/6', '0/13', '1/196', '0/45']);
});

test('09c backup file download + restore round-trip (JSON and .txt)', async ({ page }, testInfo) => {
  await openApp(page);
  await page.click('#owner'); await page.keyboard.type('Sam'); await page.keyboard.press('Enter');
  await clickPlace(page, 'svg.map[data-map="na"] rect.inset-bg[data-id="US-HI"]');
  await clickPlace(page, 'svg.map[data-map="world"] path.place[data-id="FRA"]');
  await openBackup(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-backup')]);
  expect(dl.suggestedFilename()).toMatch(/^travel-atlas-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = testInfo.outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(Object.keys(data).sort()).toEqual(['format', 'marks', 'owner', 'savedAt']);
  expect(data.format).toBe('atlas1');
  expect(data.owner).toBe('Sam');
  expect(data.marks).toEqual(['FRA', 'US-HI']);
  expect(Number.isNaN(Date.parse(data.savedAt))).toBe(false);

  await clearStorageAndReopen(page);
  expect(await counters(page)).toEqual(['0/50', '0/6', '0/13', '0/196', '0/45']);
  await openBackup(page);
  await page.setInputFiles('#restore-file-input', file);
  await expect(page.locator('#restore-note')).toHaveText(/Added 2 new places/);
  expect(await isMarked(page, 'US-HI')).toBe(true);
  expect(await isMarked(page, 'FRA')).toBe(true);
  await expect(page.locator('h1')).toHaveText('Sam’s Travel Atlas'); // owner restored from file

  // .txt holding an atlas1: code
  await clearStorageAndReopen(page);
  const txt = testInfo.outputPath('code.txt');
  fs.writeFileSync(txt, 'My atlas backup\natlas1:CA-ON,JPN,US-TX\n');
  await openBackup(page);
  await page.setInputFiles('#restore-file-input', txt);
  await expect(page.locator('#restore-note')).toHaveText(/Added 3 new places/);
  for (const id of ['CA-ON', 'JPN', 'US-TX']) expect(await isMarked(page, id), id).toBe(true);
  expect(await counters(page)).toEqual(['1/50', '0/6', '1/13', '1/196', '0/45']);
});

// ---------- 10: offline ----------

test('10 offline reload shows both maps and previously viewed terrain', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await openApp(page);
  }
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller), 'SW controls page').toBe(true);
  await page.click('#style-seg button[data-style="real"]');
  // wait for the SW to have stored the terrain
  await expect.poll(() => page.evaluate(async () => {
    const keys = await caches.keys();
    const t = keys.find(k => k === 'atlas-terrain' || k.startsWith('atlas-terrain'));
    if (!t) return 0;
    return (await (await caches.open(t)).keys()).length;
  }), { timeout: 15000 }).toBeGreaterThanOrEqual(9);

  await context.setOffline(true);
  const errs = watchErrors(page);
  await page.reload();
  await openApp(page);
  await expect(page.locator('svg.map')).toHaveCount(2);
  expect(await page.locator('.frame-loading.err').count()).toBe(0);
  await expect(page.locator('body')).toHaveClass(/\breal\b/);
  const res = await page.evaluate(async () => {
    const out = {};
    for (const img of document.querySelectorAll('svg.map image.terrain')) {
      const u = new URL(img.getAttribute('href'), location.href).href;
      out[u.split('/').pop()] = await new Promise(r => { const im = new Image(); im.onload = () => r(im.naturalWidth); im.onerror = () => r(0); im.src = u; });
    }
    const f = await fetch('./terrain/world.jpg').then(r => r.status).catch(e => 'ERR ' + e);
    return { out, f, online: navigator.onLine };
  });
  test.info().annotations.push({ type: 'note', description: JSON.stringify(res) });
  expect(res.online).toBe(false);
  expect(res.f).toBe(200);
  for (const [k, w] of Object.entries(res.out)) expect(w, k).toBeGreaterThan(0);
  expect(errs, errs.join('\n')).toEqual([]);
  await context.setOffline(false);
});

// ---------- 11: manifest, SW, install ----------

test('11 manifest valid, icons load, SW controls, Install button', async ({ page }, testInfo) => {
  let realBIP = false;
  await page.addInitScript(() => { window.addEventListener('beforeinstallprompt', () => { window.__realBIP = true; }); });
  await openApp(page);
  const href = await page.getAttribute('link[rel="manifest"]', 'href');
  expect(href).toBe('./manifest.webmanifest');
  const m = await page.evaluate(async () => {
    const url = new URL(document.querySelector('link[rel=manifest]').getAttribute('href'), location.href).href;
    const r = await fetch(url, { cache: 'no-store' });
    return { url, status: r.status, text: await r.text() };
  });
  expect(m.status).toBe(200);
  const man = JSON.parse(m.text);
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) expect(man[k], k).toBeTruthy();
  expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(man.display);
  const sizes = man.icons.map(i => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(man.icons.some(i => (i.purpose || '').split(/\s+/).includes('maskable'))).toBe(true);
  // start_url / scope resolve inside the app's folder
  expect(new URL(man.start_url, m.url).href).toBe(appRoot(testInfo));
  expect(new URL(man.scope, m.url).href).toBe(appRoot(testInfo));
  for (const ic of man.icons) {
    const r = await page.request.get(new URL(ic.src, m.url).href);
    expect(r.status(), ic.src).toBe(200);
    expect(r.headers()['content-type'], ic.src).toMatch(/^image\//);
  }

  // SW controls the page after a reload
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await openApp(page);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
  expect(scope).toBe(appRoot(testInfo));

  // Install button: real beforeinstallprompt if headless fires it, else a synthetic one
  await page.waitForTimeout(3000);
  realBIP = await page.evaluate(() => !!window.__realBIP);
  if (!realBIP) {
    await expect(page.locator('#install-btn')).toBeHidden();
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = () => { window.__prompted = true; return Promise.resolve(); };
      e.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(e);
    });
  }
  await expect(page.locator('#install-btn')).toBeVisible();
  await page.click('#install-btn');
  if (!realBIP) expect(await page.evaluate(() => window.__prompted)).toBe(true);
  await expect(page.locator('#install-btn')).toBeHidden();
  testInfo.annotations.push({ type: 'note', description: `real beforeinstallprompt observed: ${realBIP}` });
});

// ---------- 12: relative URLs / subpath / no off-site requests ----------

test('12 every request stays under the app path (no off-site requests)', async ({ page, context }, testInfo) => {
  const root = appRoot(testInfo);
  const all = [];
  context.on('request', r => all.push(r.url()));
  await openApp(page);
  expect(page.url().startsWith(root)).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.click('#style-seg button[data-style="real"]');
  await page.waitForTimeout(1500);
  await clickPlace(page, 'svg.map[data-map="world"] path.place[data-id="FRA"]');
  await openBackup(page);
  await Promise.all([page.waitForEvent('download'), page.click('#download-backup')]);
  await page.keyboard.press('Escape');
  await page.reload();
  await openApp(page);
  await page.waitForTimeout(1000);
  const net = [...new Set(all)].filter(u => !/^(blob|data|about|chrome-extension):/.test(u));
  const bad = net.filter(u => !u.startsWith(root));
  testInfo.annotations.push({ type: 'note', description: `${net.length} distinct URLs, all under ${root}` });
  expect(bad, 'requests outside ' + root).toEqual([]);
  // static check of the HTML too: no absolute or root-relative src/href (except the GitHub link)
  const refs = await page.$$eval('[src],[href]', els => els.map(e => e.getAttribute('src') || e.getAttribute('href')));
  const abs = refs.filter(u => /^(\/|https?:)/.test(u) && !u.startsWith('https://github.com/'));
  expect(abs).toEqual([]);
});

// ---------- 13: themes ----------

const CONTRAST_FN = () => {
  const parse = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const bgOf = el => { // first opaque-ish background up the tree, blended over white as a last resort
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const check = sel => { const el = document.querySelector(sel); if (!el) return { sel, missing: true }; const fg = parse(getComputedStyle(el).color), bg = bgOf(el); return { sel, fg: getComputedStyle(el).color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio: +ratio(fg, bg).toFixed(2) }; };
  return {
    bodyBg: getComputedStyle(document.body).backgroundColor,
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    text: ['h1', '.masthead .sub', '.stats .stat .num', '.stats .stat .label', '.map-head h2', '.map-head .hint', '.visited-list .none', 'footer p'].map(check),
    pill: check('#status'),
  };
};

for (const scheme of ['light', 'dark']) {
  test(`13 ${scheme} theme is readable (contrast) + screenshot`, async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 }, baseURL: testInfo.project.use.baseURL });
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    await openApp(page);
    await page.waitForTimeout(500);
    const r = await page.evaluate(CONTRAST_FN);
    testInfo.annotations.push({ type: 'note', description: JSON.stringify(r) });
    expect(r.scheme).toBe(scheme);
    if (scheme === 'dark') expect(r.bodyBg).toBe('rgb(14, 21, 27)'); else expect(r.bodyBg).toBe('rgb(238, 241, 243)');
    for (const t of r.text) { expect(t.missing, t.sel).toBeFalsy(); expect(t.ratio, `${t.sel} ${t.fg} on ${t.bg}`).toBeGreaterThanOrEqual(4.5); }
    expect(r.pill.ratio, `#status ${r.pill.fg} on ${r.pill.bg}`).toBeGreaterThanOrEqual(3);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${scheme}.png`) });
    await page.screenshot({ path: path.join(SHOTS, `${scheme}-full.png`), fullPage: true });
    await page.click('#style-seg button[data-style="real"]');
    await page.waitForTimeout(1500);
    await page.locator('#sec-world').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `${scheme}-real.png`) });
    expect(errs, errs.join('\n')).toEqual([]);
    await ctx.close();
  });
}

// ---------- 14: hidden-by-default chrome ----------

test('14 update toast and iOS hint exist and are hidden in Chromium', async ({ page }) => {
  await openApp(page);
  await page.waitForTimeout(1000);
  await expect(page.locator('#update-toast')).toHaveCount(1);
  await expect(page.locator('#ios-hint')).toHaveCount(1);
  await expect(page.locator('#update-toast')).toBeHidden();
  await expect(page.locator('#ios-hint')).toBeHidden();
});

// ---------- 15: color picker ----------

test('15 color picker recolors visited places, persists, and fits a phone screen', async ({ browser }, testInfo) => {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ baseURL: appRoot(testInfo), colorScheme: scheme, viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    const errs = watchErrors(page);
    await openApp(page);
    const fill = () => page.$eval('.legend i.on', e => getComputedStyle(e).backgroundColor);
    const amber = await fill();
    await page.click('#accent-btn');
    await expect(page.locator('#accent-pop')).toBeVisible();
    await expect(page.locator('#accent-pop [role="radio"]')).toHaveCount(7);
    // the open palette stays on screen at phone width
    const box = await page.locator('#accent-pop').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await page.click('#accent-pop [data-accent="teal"]');
    await expect(page.locator('#accent-pop')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal');
    const teal = await fill();
    expect(teal).not.toBe(amber);
    await page.screenshot({ path: path.join(SHOTS, `palette-${scheme}-375.png`) });
    await page.reload();
    await page.waitForSelector('#frame-world svg.map');
    expect(await fill()).toBe(teal);
    await expect(page.locator('#accent-pop [data-accent="teal"]')).toHaveAttribute('aria-checked', 'true');
    // back to the default removes the attribute
    await page.click('#accent-btn');
    await page.keyboard.press('Escape');
    await expect(page.locator('#accent-pop')).toBeHidden();
    await page.click('#accent-btn');
    await page.click('#accent-pop [data-accent="amber"]');
    await expect(page.locator('html')).not.toHaveAttribute('data-accent', /.+/);
    expect(await fill()).toBe(amber);
    expect(errs, errs.join('\n')).toEqual([]);
    await ctx.close();
  }
});
