// Travel Atlas: cross-device sync, view-only pages, pairing, import (docs/SYNC.md, "Client behaviour").
// Runs against the local Worker (`npm run dev:test`), so the API and the app share one origin.
// Each "device" is its own browser context (its own localStorage).
import { test, expect } from '@playwright/test';

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
  expect(Object.keys(JSON.parse(await stored(page, 'travel-atlas:clock'))).sort()).toEqual(['FRA', 'US-CA']);

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
