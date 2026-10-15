// Travel Atlas: cross-device sync, view-only pages, pairing, import (docs/SYNC.md, "Client behaviour").
// Runs against the local Worker (`npm run dev:test`), so the API and the app share one origin.
// Each "device" is its own browser context (its own localStorage).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- helpers ----------

function appRoot(testInfo) {
  const b = testInfo.project.use.baseURL;
  return b.endsWith('/') ? b : b + '/';
}

function watchErrors(page) {
  const errs = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // the browser logs failed fetches (expected: 401/404 answers, offline) as console errors
    if (/Failed to load resource|net::ERR_/.test(t)) return;
    errs.push('console: ' + t);
  });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}

async function newDevice(browser, testInfo, opts = {}, { dialogs = [], answer = true } = {}) {
  const ctx = await browser.newContext({ baseURL: appRoot(testInfo), viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  // confirm() for pairing / reset / stop / delete / switch; messages are recorded
  page.on('dialog', d => { dialogs.push(d.message()); return answer ? d.accept() : d.dismiss(); });
  return { ctx, page, dialogs };
}

async function waitMaps(page) {
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
}

async function openApp(page, url = './') {
  await page.goto(url);
  await waitMaps(page);
}

/** Put marks (and optionally an owner) into this device's storage, as if made earlier. */
async function seed(page, ids, ownerName) {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(([ids, o]) => {
    localStorage.clear();
    const m = {}; for (const id of ids) m[id] = true;
    localStorage.setItem('travel-atlas:v1', JSON.stringify(m));
    if (o) localStorage.setItem('travel-atlas:owner', o);
  }, [ids, ownerName || '']);
}

async function hitPoint(page, sel) {
  const pt = await page.evaluate(sel => {
    const elm = document.querySelector(sel);
    if (!elm) return { err: 'no element ' + sel };
    const id = elm.dataset.id;
    elm.scrollIntoView({ block: 'center', inline: 'center' });
    const bb = elm.getBBox(), ctm = elm.getScreenCTM(), svg = elm.ownerSVGElement;
    const N = 60, cand = [];
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const p = svg.createSVGPoint(); p.x = bb.x + bb.width * i / N; p.y = bb.y + bb.height * j / N;
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
      if (hid && hid.dataset.id === id) return { x: c.x, y: c.y };
    }
    return { err: `no clickable point for ${sel}` };
  }, sel);
  expect(pt.err, pt.err).toBeUndefined();
  return pt;
}

const PLACE = id => (/^[A-Z]{3}$/.test(id) ? `svg.map[data-map="world"] path.place[data-id="${id}"]` : `svg.map[data-map="na"] path.place[data-id="${id}"]`);

async function clickPlace(page, id) {
  const p = await hitPoint(page, PLACE(id));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
}

async function isMarked(page, id) {
  return page.evaluate(id => {
    const ns = [...document.querySelectorAll(`svg.map [data-id="${id}"]`)];
    return ns.length > 0 && ns.every(n => n.classList.contains('on'));
  }, id);
}

const stored = (page, key) => page.evaluate(k => localStorage.getItem(k), key);
const storedLink = async page => JSON.parse((await stored(page, 'travel-atlas:link')) || 'null');

/** A real sync trigger: the page becoming visible again. */
async function wake(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

/** Keep waking the device until the condition holds (a sync may already be in flight). */
async function pollWith(page, fn, expected, timeout = 15000) {
  await expect.poll(async () => { await wake(page); await page.waitForTimeout(250); return fn(); }, { timeout, intervals: [400] }).toEqual(expected);
}

/** Server copy of a map: { visitedIds (sorted), owner, raw }. */
async function serverMap(request, id) {
  const r = await request.get(`./api/maps/${id}`);
  if (r.status() !== 200) return { status: r.status() };
  const m = await r.json();
  return { status: 200, owner: m.owner, visited: Object.keys(m.places).filter(k => m.places[k][0] === 1).sort(), raw: m };
}

async function openShare(page) {
  await page.click('#share-btn');
  await expect(page.locator('#share')).toBeVisible();
}

/** Device A: marks + owner, then Create link in the Share dialog. Returns the link. */
async function createLink(page, { marks = ['FRA', 'US-CA'], ownerName = 'Ana' } = {}) {
  await seed(page, marks, ownerName);
  await openApp(page);
  await expect(page.locator('#status')).toHaveText('Saved on this device');
  await openShare(page);
  await expect(page.locator('#share-off')).toBeVisible();
  await expect(page.locator('#share-name')).toHaveValue(ownerName);
  await page.click('#share-create');
  await expect(page.locator('#share-on')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Synced');
  const link = await storedLink(page);
  expect(link.id).toMatch(/^[a-z0-9-]{1,20}-[a-hjkmnp-z2-9]{5}$/);
  expect(link.editKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
  return link;
}

async function closeShare(page) {
  await page.click('#share .dlg-head .x');
  await expect(page.locator('#share')).toBeHidden();
}

/** Device B pairs with the edit link; returns once it's linked and the hash is gone. */
async function pair(page, link) {
  await page.goto(`./map/${link.id}#edit=${link.editKey}`);
  await waitMaps(page);
  await expect.poll(() => page.evaluate(() => location.pathname + location.hash)).toBe('/');
  await expect.poll(async () => (await storedLink(page) || {}).id).toBe(link.id);
  await expect(page.locator('#status')).toHaveText('Synced');
}

// ---------- tests ----------

test('s1 Create link shows the view link and a QR code; the server holds the marks', async ({ browser, request }, testInfo) => {
  const { ctx, page } = await newDevice(browser, testInfo);
  const errs = watchErrors(page);
  const link = await createLink(page);
  expect(link.id.startsWith('ana-')).toBe(true);
  await expect(page.locator('#share-view')).toHaveValue(new URL(`/map/${link.id}`, appRoot(testInfo)).href);
  await expect(page.locator('#share-qr svg')).toHaveCount(1);
  // dark modules on a white quiet zone, whatever the theme
  const qr = await page.$eval('#share-qr svg', s => ({ bg: s.querySelector('rect').getAttribute('fill'), fg: s.querySelector('path').getAttribute('fill'), d: s.querySelector('path').getAttribute('d').length }));
  expect(qr).toMatchObject({ bg: '#ffffff', fg: '#000000' });
  expect(qr.d).toBeGreaterThan(100);
  // the edit link is only behind "Copy edit link instead", with its warning
  await expect(page.locator('#share-edit-warn')).toBeHidden();
  await page.click('#share-copy-edit');
  await expect(page.locator('#share-edit-warn')).toHaveText('Anyone with this link can change your map.');
  const srv = await serverMap(request, link.id);
  expect(srv.visited).toEqual(['FRA', 'US-CA']);
  expect(srv.owner).toBe('Ana');
  expect(errs, errs.join('\n')).toEqual([]);
  await ctx.close();
});

test('s2 the Share dialog fits a 375 px phone and its buttons are finger-sized', async ({ browser }, testInfo) => {
  const { ctx, page } = await newDevice(browser, testInfo, { viewport: { width: 375, height: 700 } });
  await createLink(page);
  for (const id of ['#share-copy', '#share-copy-edit', '#share-reset', '#share-stop', '#share-delete']) {
    const b = await page.locator(id).boundingBox();
    expect(b.height, id).toBeGreaterThanOrEqual(40);
    expect(b.x + b.width, id).toBeLessThanOrEqual(375);
  }
  expect(await page.$eval('#share', d => d.scrollHeight > d.clientHeight ? getComputedStyle(d).overflowY : 'fits')).toMatch(/auto|scroll|fits/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await ctx.close();
});

test('s3 a view link on another device is read-only and never touches that device\'s own marks', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  const before = await serverMap(request, link.id);

  const b = await newDevice(browser, testInfo);
  const errs = watchErrors(b.page);
  await seed(b.page, ['DEU', 'US-TX'], 'Bo');            // B has its own atlas
  const own = await stored(b.page, 'travel-atlas:v1');
  await openApp(b.page, `./map/${link.id}`);
  await expect(b.page.locator('#view-banner')).toHaveText('Ana’s map · view only · Make your own atlas');
  await expect(b.page.locator('#view-banner a')).toHaveAttribute('href', './');
  expect(await b.page.$eval('#view-banner a', a => a.href)).toBe(appRoot(testInfo));
  await expect(b.page).toHaveTitle('Ana’s Travel Atlas');
  await expect(b.page.locator('h1')).toHaveText('Ana’s Travel Atlas');
  await expect(b.page.locator('#owner')).toHaveAttribute('contenteditable', 'false');
  for (const sel of ['#backup-btn', '#share-btn', '#status']) await expect(b.page.locator(sel), sel).toBeHidden();
  expect(await isMarked(b.page, 'FRA')).toBe(true);
  expect(await isMarked(b.page, 'US-CA')).toBe(true);
  expect(await isMarked(b.page, 'DEU')).toBe(false);       // B's own marks are not shown here

  await clickPlace(b.page, 'JPN');
  await expect(b.page.locator('#toast-world')).toHaveText('View only');
  expect(await isMarked(b.page, 'JPN')).toBe(false);
  await clickPlace(b.page, 'FRA');
  expect(await isMarked(b.page, 'FRA')).toBe(true);
  await expect(b.page.locator('#list-world button.chip')).toHaveCount(0);
  await b.page.waitForTimeout(1500);                         // past any debounce
  expect((await serverMap(request, link.id)).raw).toEqual(before.raw);
  expect(await stored(b.page, 'travel-atlas:v1')).toBe(own);
  expect(await stored(b.page, 'travel-atlas:link')).toBeNull();
  expect(await stored(b.page, 'travel-atlas:clock')).toBeNull();

  // "Make your own atlas" goes to B's own atlas, untouched
  await b.page.click('#view-banner a');
  await waitMaps(b.page);
  await expect.poll(() => b.page.evaluate(() => location.pathname)).toBe('/');
  expect(await isMarked(b.page, 'DEU')).toBe(true);
  expect(await isMarked(b.page, 'FRA')).toBe(false);
  await expect(b.page.locator('h1')).toHaveText('Bo’s Travel Atlas');
  expect(await stored(b.page, 'travel-atlas:v1')).toBe(own);
  expect(errs, errs.join('\n')).toEqual([]);
  await a.ctx.close(); await b.ctx.close();
});

test('s4 pairing with the edit link merges this device\'s marks and cleans the address bar', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  const c = await newDevice(browser, testInfo);
  const errs = watchErrors(c.page);
  await seed(c.page, ['JPN']);
  await pair(c.page, link);
  expect(c.page.url()).not.toContain('#edit');
  expect(c.page.url()).toBe(appRoot(testInfo));
  for (const id of ['JPN', 'FRA', 'US-CA']) expect(await isMarked(c.page, id), id).toBe(true);
  await expect(c.page.locator('h1')).toHaveText('Ana’s Travel Atlas');
  await expect(c.page.locator('#note-bar')).toContainText('now syncs with');
  await expect.poll(async () => (await serverMap(request, link.id)).visited).toEqual(['FRA', 'JPN', 'US-CA']);
  // the merged marks are written to this device's storage
  expect(Object.keys(JSON.parse(await stored(c.page, 'travel-atlas:v1'))).sort()).toEqual(['FRA', 'JPN', 'US-CA']);
  // A sees C's JPN at its next sync
  await pollWith(a.page, () => isMarked(a.page, 'JPN'), true);
  expect(errs, errs.join('\n')).toEqual([]);
  await a.ctx.close(); await c.ctx.close();
});

test('s5 an edit on one device reaches the other; a removal beats an older add', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  await closeShare(a.page);
  const b = await newDevice(browser, testInfo);
  await pair(b.page, link);

  await clickPlace(a.page, 'BRA');                          // add on A
  await expect.poll(async () => (await serverMap(request, link.id)).visited).toContain('BRA');
  await expect(a.page.locator('#status')).toHaveText('Synced');
  await pollWith(b.page, () => isMarked(b.page, 'BRA'), true);

  await clickPlace(b.page, 'BRA');                          // later removal on B
  expect(await isMarked(b.page, 'BRA')).toBe(false);
  await expect.poll(async () => (await serverMap(request, link.id)).visited).not.toContain('BRA');
  await pollWith(a.page, () => isMarked(a.page, 'BRA'), false);
  // A still has its older add in its clock; syncing again doesn't bring BRA back
  await wake(a.page);
  await a.page.waitForTimeout(800);
  expect((await serverMap(request, link.id)).visited).not.toContain('BRA');
  expect(await isMarked(a.page, 'BRA')).toBe(false);
  expect(JSON.parse(await stored(a.page, 'travel-atlas:v1')).BRA).toBeUndefined();
  await a.ctx.close(); await b.ctx.close();
});

test('s6 offline edits on two devices merge when both are back online', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  await closeShare(a.page);
  const b = await newDevice(browser, testInfo);
  await pair(b.page, link);

  await a.ctx.setOffline(true);
  await b.ctx.setOffline(true);
  await clickPlace(a.page, 'MEX');
  await clickPlace(b.page, 'CAN');
  await clickPlace(b.page, 'FRA');                          // B removes FRA while offline
  await expect(a.page.locator('#status')).toHaveText('Offline · will sync');
  await expect(b.page.locator('#status')).toHaveText('Offline · will sync');
  await a.page.waitForTimeout(1500);
  expect((await serverMap(request, link.id)).visited).toEqual(['FRA', 'US-CA']);   // nothing went up
  // local saves happened first
  expect(JSON.parse(await stored(a.page, 'travel-atlas:v1')).MEX).toBe(true);

  await a.ctx.setOffline(false);
  await b.ctx.setOffline(false);
  const want = ['CAN', 'MEX', 'US-CA'];
  await expect.poll(async () => (await serverMap(request, link.id)).visited, { timeout: 15000 }).toEqual(want);
  const marks = async p => (await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('travel-atlas:v1') || '{}')).sort()));
  await pollWith(a.page, () => marks(a.page), want);
  await pollWith(b.page, () => marks(b.page), want);
  for (const id of want) { expect(await isMarked(a.page, id), 'A ' + id).toBe(true); expect(await isMarked(b.page, id), 'B ' + id).toBe(true); }
  expect(await isMarked(a.page, 'FRA')).toBe(false);
  await a.ctx.close(); await b.ctx.close();
});

test('s7 Reset edit access: the other device stops syncing with the reset message and keeps its marks', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  const b = await newDevice(browser, testInfo);
  await pair(b.page, link);
  const qrBefore = await a.page.$eval('#share-qr svg path', p => p.getAttribute('d'));

  await a.page.click('#share-reset');
  await expect(a.page.locator('#share-note')).toHaveText(/Edit access reset/);
  const newLink = await storedLink(a.page);
  expect(newLink.editKey).not.toBe(link.editKey);
  await expect.poll(() => a.page.$eval('#share-qr svg path', p => p.getAttribute('d'))).not.toBe(qrBefore);
  await expect(a.page.locator('#status')).toHaveText('Synced');

  await clickPlace(b.page, 'ITA');                          // B's next sync is refused
  await expect(b.page.locator('#status')).toHaveText('Edit access was reset — this device stopped syncing');
  expect(await storedLink(b.page)).toBeNull();
  expect(await isMarked(b.page, 'ITA')).toBe(true);
  expect(await isMarked(b.page, 'FRA')).toBe(true);
  expect(JSON.parse(await stored(b.page, 'travel-atlas:v1'))).toMatchObject({ FRA: true, 'US-CA': true, ITA: true });
  expect((await serverMap(request, link.id)).visited).not.toContain('ITA');
  // the old edit link no longer pairs: it falls back to the view page
  const c = await newDevice(browser, testInfo);
  await c.page.goto(`./map/${link.id}#edit=${link.editKey}`);
  await waitMaps(c.page);
  await expect(c.page.locator('#view-banner')).toHaveText('Ana’s map · view only · Make your own atlas');
  expect(c.page.url()).not.toContain('#edit');
  expect(await storedLink(c.page)).toBeNull();
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
});

test('s8 Delete shared map: this device unlinks, the other one shows the deleted message', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  const b = await newDevice(browser, testInfo);
  await pair(b.page, link);

  await a.page.click('#share-delete');
  await expect(a.page.locator('#share-off')).toBeVisible();
  await expect(a.page.locator('#share-note')).toHaveText(/Shared map deleted/);
  expect(await storedLink(a.page)).toBeNull();
  await expect(a.page.locator('#status')).toHaveText('Saved on this device');
  expect(await isMarked(a.page, 'FRA')).toBe(true);
  expect((await serverMap(request, link.id)).status).toBe(404);

  await pollWith(b.page, () => b.page.locator('#status').textContent(), 'This shared map was deleted');
  expect(await storedLink(b.page)).toBeNull();
  expect(await isMarked(b.page, 'FRA')).toBe(true);
  await a.ctx.close(); await b.ctx.close();
});

test('s9 Stop syncing on this device keeps marks and leaves the shared map alone', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  await a.page.click('#share-stop');
  await expect(a.page.locator('#share-off')).toBeVisible();
  expect(await storedLink(a.page)).toBeNull();
  await expect(a.page.locator('#status')).toHaveText('Saved on this device');
  await closeShare(a.page);
  await clickPlace(a.page, 'PER');
  await a.page.waitForTimeout(1500);
  expect((await serverMap(request, link.id)).visited).toEqual(['FRA', 'US-CA']);
  await a.ctx.close();
});

test('s10 /#import= adds marks, sets an unset owner, and cleans the address bar', async ({ browser }, testInfo) => {
  const { ctx, page } = await newDevice(browser, testInfo);
  await seed(page, ['JPN']);
  await page.goto('./#import=atlas1:US-CA,FRA&owner=Sam&accent=teal&style=real');
  await waitMaps(page);
  for (const id of ['US-CA', 'FRA', 'JPN']) expect(await isMarked(page, id), id).toBe(true);
  await expect(page.locator('h1')).toHaveText('Sam’s Travel Atlas');
  expect(page.url()).toBe(appRoot(testInfo));
  await expect(page.locator('#note-bar')).toBeVisible();
  await expect(page.locator('#note-text')).toHaveText('Brought over 2 places from your old Travel Atlas address.');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal');
  await expect(page.locator('body')).toHaveClass(/\breal\b/);
  expect(JSON.parse(await stored(page, 'travel-atlas:v1'))).toEqual({ JPN: true, 'US-CA': true, FRA: true });
  // only the imported places were edited now (JPN keeps its pre-sync t = 1)
  const v2 = JSON.parse(await stored(page, 'travel-atlas:v2'));
  expect(Object.keys(v2.places).filter(k => v2.places[k][1] > 1).sort()).toEqual(['FRA', 'US-CA']);
  expect(v2.places.JPN).toEqual([1, 1]);
  expect(await stored(page, 'travel-atlas:clock')).toBeNull();

  // a second import never removes and never overwrites a name that is already set
  await page.goto('./#import=atlas1:DEU&owner=Someone');
  await waitMaps(page);
  for (const id of ['US-CA', 'FRA', 'JPN', 'DEU']) expect(await isMarked(page, id), id).toBe(true);
  await expect(page.locator('h1')).toHaveText('Sam’s Travel Atlas');
  expect(page.url()).toBe(appRoot(testInfo));
  await ctx.close();
});

test('s11 a view page for a missing map, and offline, says it couldn\'t load', async ({ browser }, testInfo) => {
  const { ctx, page } = await newDevice(browser, testInfo);
  await seed(page, ['FRA']);
  const own = await stored(page, 'travel-atlas:v1');
  await openApp(page, './map/nobody-zzzzz');
  await expect(page.locator('#view-banner')).toContainText('Couldn’t load this map');
  await expect(page.locator('#view-banner a')).toHaveText('Make your own atlas');
  expect(await isMarked(page, 'FRA')).toBe(false);

  // offline (app shell from the service worker, API unreachable)
  await openApp(page, './');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  const res = await page.goto('./map/someone-abcde');
  expect(res.fromServiceWorker()).toBe(true);
  await waitMaps(page);
  await expect(page.locator('#view-banner')).toContainText('Couldn’t load this map');
  await expect(page.locator('#view-banner button')).toHaveText('Try again');
  expect(await isMarked(page, 'FRA')).toBe(false);
  await ctx.setOffline(false);
  expect(await stored(page, 'travel-atlas:v1')).toBe(own);
  await ctx.close();
});

test('s12 the sync API is never cached by the service worker; only same-origin requests', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const all = [];
  a.ctx.on('request', r => all.push(r.url()));
  const link = await createLink(a.page);
  await a.page.evaluate(() => navigator.serviceWorker.ready);
  await a.page.reload();
  await waitMaps(a.page);
  await expect(a.page.locator('#status')).toHaveText('Synced');
  const cached = await a.page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
  expect(cached.filter(u => u.includes('/api/'))).toEqual([]);
  expect(cached.some(u => u.endsWith('/js/vendor/qrcode.js'))).toBe(true);
  const origin = new URL(appRoot(testInfo)).origin;
  const off = [...new Set(all)].filter(u => !/^(blob|data|about):/.test(u) && new URL(u).origin !== origin);
  expect(off).toEqual([]);
  expect((await serverMap(request, link.id)).status).toBe(200);
  await a.ctx.close();
});

test('s13 pairing a device that already has marks asks first: OK merges, Cancel stays view-only', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);

  // Cancel: nothing uploaded, no link stored, falls back to the view page, own marks untouched
  const no = await newDevice(browser, testInfo, {}, { answer: false });
  await seed(no.page, ['JPN', 'PER']);
  const own = await stored(no.page, 'travel-atlas:v1');
  await no.page.goto(`./map/${link.id}#edit=${link.editKey}`);
  await waitMaps(no.page);
  await expect(no.page.locator('#view-banner')).toHaveText('Ana’s map · view only · Make your own atlas');
  expect(no.dialogs).toEqual(['Add your 2 places to “Ana”? Anyone with this map’s edit link can change them.']);
  expect(no.page.url()).toBe(new URL(`/map/${link.id}`, appRoot(testInfo)).href);
  expect(await storedLink(no.page)).toBeNull();
  expect(await no.page.evaluate(() => sessionStorage.getItem('travel-atlas:pending-pair'))).toBeNull();
  expect(await stored(no.page, 'travel-atlas:v1')).toBe(own);
  expect(await isMarked(no.page, 'JPN')).toBe(false);
  await no.page.waitForTimeout(1200);
  expect((await serverMap(request, link.id)).visited).toEqual(['FRA', 'US-CA']);

  // OK: merges
  const yes = await newDevice(browser, testInfo);
  await seed(yes.page, ['PER']);
  await pair(yes.page, link);
  expect(yes.dialogs).toEqual(['Add your 1 place to “Ana”? Anyone with this map’s edit link can change them.']);
  await expect.poll(async () => (await serverMap(request, link.id)).visited).toEqual(['FRA', 'PER', 'US-CA']);

  // an empty device pairs without asking
  const empty = await newDevice(browser, testInfo);
  await pair(empty.page, link);
  expect(empty.dialogs).toEqual([]);
  await a.ctx.close(); await no.ctx.close(); await yes.ctx.close(); await empty.ctx.close();
});

test('s14 pairing while offline never leaves the key in the address bar and finishes once online', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  const b = await newDevice(browser, testInfo);
  await openApp(b.page, './');
  await b.page.evaluate(() => navigator.serviceWorker.ready);
  await b.page.reload();
  await waitMaps(b.page);
  expect(await b.page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await b.ctx.setOffline(true);
  await b.page.goto(`./map/${link.id}#edit=${link.editKey}`);   // app shell from the service worker
  await waitMaps(b.page);
  await expect.poll(() => b.page.evaluate(() => location.href)).not.toContain('#edit');
  expect(b.page.url()).not.toContain(link.editKey);
  await expect(b.page.locator('#note-text')).toContainText('Couldn’t reach the sync server');
  expect(await storedLink(b.page)).toBeNull();
  // a reload while still offline retries from sessionStorage, still without the key in the URL
  await b.page.reload();
  await waitMaps(b.page);
  expect(b.page.url()).not.toContain('#edit');

  await b.ctx.setOffline(false);                                  // 'online' retries the pairing
  await expect.poll(async () => (await storedLink(b.page) || {}).id, { timeout: 15000 }).toBe(link.id);
  await expect.poll(() => b.page.evaluate(() => location.pathname + location.hash)).toBe('/');
  expect(await b.page.evaluate(() => sessionStorage.getItem('travel-atlas:pending-pair'))).toBeNull();
  await expect(b.page.locator('#status')).toHaveText('Synced');
  expect(await isMarked(b.page, 'FRA')).toBe(true);
  await a.ctx.close(); await b.ctx.close();
});

// ---------- v2: want to go, notes, since/rev deltas, chunking, view links ----------

const v2Doc = page => page.evaluate(() => JSON.parse(localStorage.getItem('travel-atlas:v2') || 'null'));

/** Bodies of the POST /sync requests this page sends (parsed). */
function watchSyncBodies(page) {
  const bodies = [];
  page.on('request', r => {
    if (r.method() === 'POST' && /\/api\/maps\/[^/]+\/sync$/.test(new URL(r.url()).pathname)) {
      try { bodies.push(JSON.parse(r.postData() || '{}')); } catch (_) { bodies.push(null); }
    }
  });
  return bodies;
}

test('s15 want to go and notes reach a second device; the next sync is a delta (since = rev)', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const errs = watchErrors(a.page);
  const link = await createLink(a.page);
  await closeShare(a.page);
  const b = await newDevice(browser, testInfo);
  await pair(b.page, link);
  const bodies = watchSyncBodies(a.page);

  // A: Want mode + tap Japan, and a note on France
  await a.page.click('#frame-world .mark-seg button[data-mode="want"]');
  await clickPlace(a.page, 'JPN');
  await a.page.evaluate(() => window.Atlas.setInfo('FRA', { rating: 4, year: 2019, note: 'Croissants' }));
  await expect.poll(async () => { const m = (await serverMap(request, link.id)).raw; return m && m.places.JPN && m.places.JPN[0]; }).toBe(2);
  await expect(a.page.locator('#status')).toHaveText('Synced');
  const l = await storedLink(a.page);
  expect(Number.isInteger(l.rev)).toBe(true);
  // every request after the first full one carries the cursor
  expect(bodies.length).toBeGreaterThan(0);
  for (const bd of bodies) expect(typeof bd.since, JSON.stringify(bd)).toBe('number');
  expect(bodies.some(bd => bd.notes && bd.notes.FRA)).toBe(true);
  // the plain GET never shows notes
  const plain = (await serverMap(request, link.id)).raw;
  expect(plain.notes).toBeUndefined();
  expect(JSON.stringify(plain)).not.toContain('Croissants');

  await pollWith(b.page, () => b.page.evaluate(() => window.Atlas.getStatus('JPN')), 2);
  await pollWith(b.page, () => b.page.evaluate(() => window.Atlas.getInfo('FRA')), { rating: 4, year: 2019, note: 'Croissants' });
  expect(await b.page.$eval('svg.map [data-id="JPN"].place', n => n.classList.contains('want'))).toBe(true);
  await expect(b.page.locator('#list-world .chip.want')).toHaveText(['Japan']);
  await expect(b.page.locator('#list-world .chip[data-id="FRA"] .ci-rate')).toHaveText('★4');
  expect(errs, errs.join('\n')).toEqual([]);
  await a.ctx.close(); await b.ctx.close();
});

test('s16 an old-format linked device (v1 + clock + ownerT, no rev) upgrades losslessly with one full sync', async ({ browser, request }, testInfo) => {
  const t0 = Date.now() - 60_000;
  const res = await request.post('./api/maps', { data: { name: 'Old', owner: 'Old', ownerT: t0 - 5000, places: { DEU: [1, t0 - 5000], ITA: [1, t0 - 5000] } } });
  expect(res.status()).toBe(201);
  const { id, editKey } = await res.json();
  const d = await newDevice(browser, testInfo);
  const errs = watchErrors(d.page);
  await d.page.goto('./manifest.webmanifest');
  await d.page.evaluate(([id, editKey, t0]) => {
    localStorage.clear();
    localStorage.setItem('travel-atlas:v1', JSON.stringify({ FRA: true, PER: true }));
    // PER was marked before sync existed (no clock entry: t = 1); ITA was removed here later than the server's add
    localStorage.setItem('travel-atlas:clock', JSON.stringify({ FRA: t0, ITA: t0 }));
    localStorage.setItem('travel-atlas:owner', 'Mo');
    localStorage.setItem('travel-atlas:ownerT', String(t0));
    localStorage.setItem('travel-atlas:link', JSON.stringify({ id, editKey, name: 'Old', synced: Date.now() }));
  }, [id, editKey, t0]);
  const bodies = watchSyncBodies(d.page);
  await openApp(d.page);
  await expect(d.page.locator('#status')).toHaveText('Synced');
  await expect.poll(async () => (await serverMap(request, id)).visited).toEqual(['DEU', 'FRA', 'PER']);
  expect((await serverMap(request, id)).owner).toBe('Mo');
  // the first request was a full send (no since) with every entry
  expect(bodies[0].since).toBeUndefined();
  expect(bodies[0].places).toEqual({ FRA: [1, t0], ITA: [0, t0], PER: [1, 1] });
  const doc = await v2Doc(d.page);
  expect(doc.places).toMatchObject({ FRA: [1, t0], ITA: [0, t0], PER: [1, 1], DEU: [1, t0 - 5000] });
  expect(doc.dirty).toEqual({});
  expect(Number.isInteger((await storedLink(d.page)).rev)).toBe(true);
  for (const x of ['DEU', 'FRA', 'PER']) expect(await isMarked(d.page, x), x).toBe(true);
  expect(await isMarked(d.page, 'ITA')).toBe(false);
  await expect(d.page.locator('h1')).toHaveText('Mo’s Travel Atlas');
  expect(errs, errs.join('\n')).toEqual([]);
  await d.ctx.close();
});

test('s17 view links: the plain link shows want but no notes; the notes link shows notes until it is turned off', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page);
  await closeShare(a.page);
  await a.page.evaluate(() => { window.Atlas.setStatus('JPN', 'want', { quiet: true }); window.Atlas.setInfo('FRA', { rating: 5, note: 'Paris in May' }); });
  const on = await a.page.evaluate(() => window.Atlas.notesLink('on'));
  expect(on.ok).toBe(true);
  expect(on.notesToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const info = await a.page.evaluate(() => window.Atlas.link());
  expect(info.notesUrl).toBe(new URL(`/map/${link.id}#notes=${on.notesToken}`, appRoot(testInfo)).href);
  expect((await storedLink(a.page)).notesToken).toBe(on.notesToken);
  await expect.poll(async () => { const m = (await serverMap(request, link.id)).raw; return m.places.JPN && m.places.JPN[0]; }).toBe(2);
  await a.page.waitForTimeout(1500);                         // let the notes sync land too

  // plain view: want shows, notes don't, chips are plain text
  const v = await newDevice(browser, testInfo);
  const errs = watchErrors(v.page);
  await openApp(v.page, `./map/${link.id}`);
  await expect(v.page.locator('#view-banner')).toHaveText('Ana’s map · view only · Make your own atlas');
  expect(await v.page.evaluate(() => window.Atlas.viewMode)).toBe('plain');
  await expect.poll(() => v.page.evaluate(() => window.Atlas.getStatus('JPN'))).toBe(2);
  expect(await v.page.evaluate(() => window.Atlas.getInfo('FRA'))).toBeNull();
  await expect(v.page.locator('#list-world span.chip.want')).toHaveText(['Japan']);
  await expect(v.page.locator('#list-world button.chip')).toHaveCount(0);
  await expect(v.page.locator('.mark-seg').first()).toBeHidden();

  // notes view: read-only notes, chips are buttons that open details
  await v.page.goto('./manifest.webmanifest');
  await openApp(v.page, `./map/${link.id}#notes=${on.notesToken}`);
  await expect(v.page.locator('#view-banner')).toHaveText('Ana’s map with notes · view only · Make your own atlas');
  expect(v.page.url()).toContain('#notes=' + on.notesToken);   // the visitor's link stays as given
  await expect(v.page.locator('body')).toHaveClass(/view-notes/);
  await expect.poll(() => v.page.evaluate(() => window.Atlas.getInfo('FRA'))).toEqual({ rating: 5, year: 0, note: 'Paris in May' });
  expect(await v.page.evaluate(() => window.Atlas.viewMode)).toBe('notes');
  await expect(v.page.locator('#list-world button.chip[data-id="FRA"]')).toHaveCount(1);
  expect(await v.page.evaluate(() => window.Atlas.setInfo('FRA', { note: 'x' }))).toBe(false);
  expect(await v.page.evaluate(() => window.Atlas.setStatus('DEU', 1))).toBe(false);
  expect(await stored(v.page, 'travel-atlas:v2')).toBeNull();   // viewing never writes this device's atlas

  // turned off: the same link falls back to the plain map with a note
  expect((await a.page.evaluate(() => window.Atlas.notesLink('off'))).notesToken).toBeNull();
  await v.page.goto('./manifest.webmanifest');
  await openApp(v.page, `./map/${link.id}#notes=${on.notesToken}`);
  await expect(v.page.locator('#view-banner .banner-sub')).toHaveText('This link no longer shows notes.');
  await expect(v.page.locator('#view-banner > span')).toHaveText('Ana’s map · view only · Make your own atlas');
  expect(await v.page.evaluate(() => window.Atlas.viewMode)).toBe('plain');
  expect(await v.page.evaluate(() => window.Atlas.getInfo('FRA'))).toBeNull();
  await expect.poll(() => v.page.evaluate(() => window.Atlas.getStatus('JPN'))).toBe(2);
  expect(errs, errs.join('\n')).toEqual([]);

  // the owner's own device opens its notes link as its own atlas
  const again = await a.page.evaluate(() => window.Atlas.notesLink('on'));
  await openApp(a.page, `./map/${link.id}#notes=${again.notesToken}`);
  expect(await a.page.evaluate(() => window.Atlas.viewMode)).toBe('own');
  expect(a.page.url()).not.toContain('#notes');
  await a.ctx.close(); await v.ctx.close();
});

test('s18 another tab\'s notes and want marks arrive through the :v2 storage event', async ({ context }) => {
  const a = await context.newPage();
  await openApp(a);
  const b = await context.newPage();
  await openApp(b);
  await b.evaluate(() => { window.Atlas.setStatus('PER', 2, { quiet: true }); window.Atlas.setInfo('PER', { note: 'Machu Picchu' }); });
  await expect.poll(() => a.evaluate(() => window.Atlas.getStatus('PER'))).toBe(2);
  await expect.poll(() => a.evaluate(() => (window.Atlas.getInfo('PER') || {}).note)).toBe('Machu Picchu');
  await expect(a.locator('#list-world .chip.want')).toHaveText(['Peru✎']);
});

test('s19 the first full sync of 2,000 city ids goes up in chunks without 413/429 loops', async ({ browser, request }, testInfo) => {
  const ids = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'cities-ids.json'), 'utf8')).slice(0, 2000);
  const d = await newDevice(browser, testInfo);
  const statuses = [];
  d.page.on('response', r => { if (/\/api\/maps/.test(r.url())) statuses.push(r.status()); });
  const bodies = watchSyncBodies(d.page);
  await d.page.goto('./manifest.webmanifest');
  await d.page.evaluate(ids => {
    localStorage.clear();
    const t = Date.now() - 1000, places = {}, dirty = {};
    for (const id of ids) { places[id] = [1, t]; dirty['p:' + id] = 1; }
    places.FRA = [1, t]; dirty['p:FRA'] = 1;
    localStorage.setItem('travel-atlas:v2', JSON.stringify({ v: 2, places, notes: {}, owner: ['Cy', t], dirty: Object.assign(dirty, { o: 1 }) }));
  }, ids);
  await openApp(d.page);
  await d.page.click('#share-btn');
  await d.page.fill('#share-name', 'Cy');
  await d.page.click('#share-create');
  await expect(d.page.locator('#share-on')).toBeVisible();
  await expect.poll(async () => { const m = (await serverMap(request, (await storedLink(d.page)).id)).raw; return m ? Object.keys(m.places).length : 0; }, { timeout: 20000 }).toBe(2001);
  await expect.poll(async () => Number.isInteger((await storedLink(d.page)).rev)).toBe(true);
  await expect(d.page.locator('#status')).toHaveText('Synced');
  expect(statuses.filter(s => s === 413 || s === 429)).toEqual([]);
  expect(bodies.length).toBeLessThanOrEqual(4);
  for (const bd of bodies) expect(Object.keys(bd.places || {}).length).toBeLessThanOrEqual(1000);
  expect((await v2Doc(d.page)).dirty).toEqual({});
  await d.ctx.close();
});

test('s20 an interrupted full send keeps its progress (link.full) and resumes without starting over', async ({ browser, request }, testInfo) => {
  const ids = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'cities-ids.json'), 'utf8')).slice(0, 2500);
  const res = await request.post('./api/maps', { data: { name: 'Big' } });
  const { id, editKey } = await res.json();
  const d = await newDevice(browser, testInfo);
  await d.page.goto('./manifest.webmanifest');
  await d.page.evaluate(([ids, id, editKey]) => {
    localStorage.clear();
    const t = Date.now() - 1000, places = {}, dirty = {};
    for (const x of ids) { places[x] = [2, t]; dirty['p:' + x] = 1; }
    localStorage.setItem('travel-atlas:v2', JSON.stringify({ v: 2, places, notes: {}, owner: ['', 0], dirty }));
    localStorage.setItem('travel-atlas:link', JSON.stringify({ id, editKey, name: 'Big', synced: Date.now() }));
  }, [ids, id, editKey]);
  // the second sync request fails once with 503 busy
  let n = 0;
  const sent = [];
  await d.page.route('**/api/maps/*/sync', async route => {
    n++;
    const body = JSON.parse(route.request().postData() || '{}');
    sent.push({ since: body.since, count: Object.keys(body.places || {}).length, first: Object.keys(body.places || {})[0] });
    if (n === 2) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Retry-After': '2' }, body: '{"error":"busy","message":"busy"}' });
    return route.continue();
  });
  await openApp(d.page);
  await expect(d.page.locator('#status')).toHaveText('Sync paused · will retry');
  expect(n).toBe(2);
  const mid = await storedLink(d.page);
  expect(mid.rev).toBeUndefined();
  expect(mid.full).toMatchObject({ done: 1 });
  await wake(d.page);
  await expect.poll(async () => Number.isInteger((await storedLink(d.page)).rev), { timeout: 15000 }).toBe(true);
  await expect(d.page.locator('#status')).toHaveText('Synced');
  expect((await storedLink(d.page)).full).toBeUndefined();
  const m = (await serverMap(request, id)).raw;
  expect(Object.keys(m.places).length).toBe(2500);
  // chunk 1 (no since), chunk 2 refused, then the resume starts at chunk 2 with the cursor
  expect(sent[0]).toMatchObject({ since: undefined, count: 1000 });
  expect(sent[1].count).toBe(1000);
  expect(sent[2]).toMatchObject({ count: 1000, first: sent[1].first });
  expect(typeof sent[2].since).toBe('number');
  expect(sent.reduce((a, s) => a + s.count, 0)).toBeLessThanOrEqual(3500);
  await d.ctx.close();
});
