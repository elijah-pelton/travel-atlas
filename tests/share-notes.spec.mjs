// Travel Atlas: the Share dialog's two view links (docs/plan-ux.md §2.4, §6 states 9-14, §8 share-notes.spec).
// "Map only" is always there; "Map with notes" is off until the switch turns it on, and turning it
// off (or resetting it) makes the old notes link fall back to the plain map.
// Runs against the local Worker, so the API and the app share one origin.
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
    if (/Failed to load resource|net::ERR_/.test(t)) return;   // expected 401s from revoked notes links
    errs.push('console: ' + t);
  });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}

async function newDevice(browser, testInfo, opts = {}) {
  const ctx = await browser.newContext({ baseURL: appRoot(testInfo), viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  const dialogs = [];
  // the notes-link confirm lives in the dialog; a window.confirm here would be a regression
  page.on('dialog', d => { dialogs.push(d.message()); return d.accept(); });
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

async function seed(page, ids, ownerName) {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(([ids, o]) => {
    localStorage.clear();
    const m = {}; for (const id of ids) m[id] = true;
    localStorage.setItem('travel-atlas:v1', JSON.stringify(m));
    if (o) localStorage.setItem('travel-atlas:owner', o);
  }, [ids, ownerName || '']);
}

const storedLink = async page => JSON.parse((await page.evaluate(() => localStorage.getItem('travel-atlas:link'))) || 'null');
const wake = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

async function openShare(page) {
  await page.click('#share-btn');
  await expect(page.locator('#share')).toBeVisible();
}

/** Device A: marks + owner + a note on FRA, then Create link. Returns the stored link. */
async function createLink(page, request) {
  await seed(page, ['FRA', 'US-CA'], 'Ana');
  await openApp(page);
  await expect(page.locator('#status')).toHaveText('Saved on this device');
  await page.evaluate(() => window.Atlas.setInfo('FRA', { rating: 4, year: 2019, note: 'Secret croissant' }));
  await openShare(page);
  await page.click('#share-create');
  await expect(page.locator('#share-on')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Synced');
  const link = await storedLink(page);
  expect(link.id).toBeTruthy();
  return link;
}

const sw = page => page.locator('#share-notes-switch');

/** Turn the notes link on from the Share dialog; returns the token. */
async function switchOn(page) {
  await expect(sw(page)).toHaveAttribute('aria-checked', 'false');
  await sw(page).click();
  await expect(sw(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#share-notes-row')).toBeVisible();
  await expect(page.locator('#share-notes-msg')).toHaveText('Notes link made. Copy it to share.');
  const url = await page.locator('#share-notes-url').inputValue();
  const m = /#notes=([A-Za-z0-9_-]{22})$/.exec(url);
  expect(m, url).not.toBeNull();
  return m[1];
}

/** Open a link in a fresh context (a friend's browser). */
async function visit(browser, testInfo, url) {
  const v = await newDevice(browser, testInfo);
  await v.page.goto(url);
  await waitMaps(v.page);
  return v;
}

// ---------- tests ----------

test('n1 linked state shows "Map only"; the switch makes a second link with #notes=', async ({ browser, request }, testInfo) => {
  const { ctx, page, dialogs } = await newDevice(browser, testInfo);
  const errs = watchErrors(page);
  const link = await createLink(page, request);
  const root = appRoot(testInfo);

  await expect(page.locator('#share-on .dlg-label').first()).toHaveText('View links');
  await expect(page.locator('#share-view-row .link-name')).toHaveText('Map only');
  await expect(page.locator('#share-view')).toHaveValue(new URL(`/map/${link.id}`, root).href);
  await expect(page.locator('#share-view-desc')).toHaveText(/^Places you.ve been and want to go\. No notes or ratings\.$/);
  // off by default: no notes row, no token anywhere
  await expect(sw(page)).toHaveAttribute('role', 'switch');
  await expect(sw(page)).toHaveText('Also make a link that shows my notes and ratings');
  await expect(sw(page)).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#share-notes-row')).toBeHidden();
  expect(link.notesToken).toBeNull();

  const token = await switchOn(page);
  await expect(page.locator('#share-notes-row .link-name')).toHaveText('Map with notes');
  await expect(page.locator('#share-notes-url')).toHaveValue(new URL(`/map/${link.id}#notes=${token}`, root).href);
  await expect(page.locator('#share-notes-desc')).toHaveText('Anyone with this link can read your notes, ratings and years.');
  await expect(page.locator('#share-notes-reset')).toHaveText('Reset notes link');
  expect((await storedLink(page)).notesToken).toBe(token);
  expect(await page.evaluate(() => window.Atlas.link())).toMatchObject({ notesToken: token, notesUrl: new URL(`/map/${link.id}#notes=${token}`, root).href });

  // Copy puts the notes link on the clipboard (or reports why not) in its own row note
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(root).origin });
  await page.click('#share-notes-copy');
  await expect(page.locator('#share-notes-note')).toHaveText('Copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/map/${link.id}#notes=${token}`, root).href);
  await expect(page.locator('#share-copy-note')).toHaveText('');

  // the dialog remembers the state when reopened
  await page.click('#share .dlg-head .x');
  await openShare(page);
  await expect(sw(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#share-notes-row')).toBeVisible();
  await expect(page.locator('#share-notes-msg')).toBeHidden();
  expect(dialogs).toEqual([]);
  expect(errs, errs.join('\n')).toEqual([]);
  await ctx.close();
});

test('n2 the plain link\'s API response never carries notes or the notes token', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page, request);
  const token = await switchOn(a.page);

  const v = await newDevice(browser, testInfo);
  const errs = watchErrors(v.page);
  const respP = v.page.waitForResponse(r => new URL(r.url()).pathname === `/api/maps/${link.id}` && r.request().method() === 'GET');
  await v.page.goto(`./map/${link.id}`);
  const resp = await respP;
  expect(resp.status()).toBe(200);
  const text = await resp.text();
  expect(text).not.toMatch(/notes|notesToken|Secret croissant/);
  expect(text).not.toContain(token);
  expect(Object.keys(JSON.parse(text)).sort()).toEqual(['id', 'name', 'owner', 'ownerT', 'places', 'rev', 'updated']);
  await waitMaps(v.page);
  await expect(v.page.locator('#view-banner')).toHaveText('Ana’s map · view only · Make your own atlas');
  await expect.poll(() => v.page.evaluate(() => window.Atlas.viewMode)).toBe('plain');
  await expect(v.page.locator('#list-world button.chip')).toHaveCount(0);
  await expect(v.page.locator('#style-seg button[data-style="ratings"]')).toBeHidden();
  expect(errs, errs.join('\n')).toEqual([]);
  await a.ctx.close(); await v.ctx.close();
});

test('n3 the notes link in another browser shows the read-only panel and the Ratings style', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  await createLink(a.page, request);
  await switchOn(a.page);
  const url = await a.page.locator('#share-notes-url').inputValue();

  const v = await visit(browser, testInfo, url);
  const errs = watchErrors(v.page);
  await expect.poll(() => v.page.evaluate(() => window.Atlas.viewMode)).toBe('notes');
  await expect(v.page.locator('#view-banner')).toContainText('Ana’s map with notes · view only');
  expect(await v.page.evaluate(() => location.hash)).toMatch(/^#notes=/);   // the visitor keeps the link they were given
  const chip = v.page.locator('#list-world button.chip', { hasText: 'France' });
  await chip.click();
  const dlg = v.page.locator('dialog.place-panel');
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveClass(/readonly/);
  await expect(dlg.locator('.stars-ro .star-ro.lit')).toHaveCount(4);
  await expect(dlg.locator('.pp-year-ro')).toHaveText('Went in 2019');
  await expect(dlg.locator('.pp-note-ro .place-ro')).toHaveText('Secret croissant');
  await v.page.keyboard.press('Escape');
  const ratings = v.page.locator('#style-seg button[data-style="ratings"]');
  await expect(ratings).toBeVisible();
  await ratings.click();
  await expect(ratings).toHaveAttribute('aria-pressed', 'true');
  expect(errs, errs.join('\n')).toEqual([]);
  await a.ctx.close(); await v.ctx.close();
});

test('n4 turning the switch off asks in the dialog; the old notes link falls back to the plain map', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const errs = watchErrors(a.page);
  const link = await createLink(a.page, request);
  const token = await switchOn(a.page);
  const url = await a.page.locator('#share-notes-url').inputValue();

  const confirm = a.page.locator('#share-notes-confirm');
  await expect(confirm).toBeHidden();
  await sw(a.page).click();
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('p')).toHaveText('Turn off the notes link? Anyone who has it will only see the plain map. Turning it back on makes a new link.');
  await expect(a.page.locator('#share-notes-confirm-yes')).toHaveText('Turn off');
  await expect(a.page.locator('#share-notes-confirm-no')).toHaveText('Keep it');
  await expect(a.page.locator('#share-notes-confirm-no')).toBeFocused();
  // Keep it: nothing changes
  await a.page.click('#share-notes-confirm-no');
  await expect(confirm).toBeHidden();
  await expect(sw(a.page)).toHaveAttribute('aria-checked', 'true');
  await expect(sw(a.page)).toBeFocused();
  expect((await storedLink(a.page)).notesToken).toBe(token);
  // Turn off
  await sw(a.page).click();
  await a.page.click('#share-notes-confirm-yes');
  await expect(sw(a.page)).toHaveAttribute('aria-checked', 'false');
  await expect(confirm).toBeHidden();
  await expect(a.page.locator('#share-notes-row')).toBeHidden();
  await expect(a.page.locator('#share-notes-msg')).toHaveText('Notes link turned off. It now shows only the plain map.');
  expect((await storedLink(a.page)).notesToken).toBeNull();
  expect(a.dialogs).toEqual([]);                            // never window.confirm
  expect(errs, errs.join('\n')).toEqual([]);

  const v = await visit(browser, testInfo, url);
  await expect.poll(() => v.page.evaluate(() => window.Atlas.viewMode), { timeout: 20000 }).toBe('plain');
  await expect(v.page.locator('#view-banner .banner-sub')).toHaveText('This link no longer shows notes.');
  await expect(v.page.locator('#view-banner')).toContainText('Ana’s map · view only');
  await expect(v.page.locator('#list-world button.chip')).toHaveCount(0);
  await expect(v.page.locator('#style-seg button[data-style="ratings"]')).toBeHidden();

  // turning it back on makes a new link
  const again = await switchOn(a.page);
  expect(again).not.toBe(token);
  expect((await request.get(`./api/maps/${link.id}/notes`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
  await a.ctx.close(); await v.ctx.close();
});

test('n5 Reset notes link asks first; the old link falls back and the new one works', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const errs = watchErrors(a.page);
  const link = await createLink(a.page, request);
  const token = await switchOn(a.page);
  const oldUrl = await a.page.locator('#share-notes-url').inputValue();

  await a.page.click('#share-notes-reset');
  const confirm = a.page.locator('#share-notes-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('p')).toHaveText(/^Reset the notes link\?/);
  await expect(a.page.locator('#share-notes-confirm-yes')).toHaveText('Reset');
  await a.page.click('#share-notes-confirm-no');
  await expect(confirm).toBeHidden();
  await expect(a.page.locator('#share-notes-reset')).toBeFocused();
  await expect(a.page.locator('#share-notes-url')).toHaveValue(oldUrl);

  await a.page.click('#share-notes-reset');
  await a.page.click('#share-notes-confirm-yes');
  await expect(a.page.locator('#share-notes-msg')).toHaveText('New notes link made. The old one no longer shows notes.');
  await expect(sw(a.page)).toHaveAttribute('aria-checked', 'true');
  const newUrl = await a.page.locator('#share-notes-url').inputValue();
  expect(newUrl).not.toBe(oldUrl);
  const fresh = /#notes=([A-Za-z0-9_-]{22})$/.exec(newUrl)[1];
  expect(fresh).not.toBe(token);
  expect((await storedLink(a.page)).notesToken).toBe(fresh);
  expect(a.dialogs).toEqual([]);
  expect(errs, errs.join('\n')).toEqual([]);

  const old = await visit(browser, testInfo, oldUrl);
  await expect.poll(() => old.page.evaluate(() => window.Atlas.viewMode), { timeout: 20000 }).toBe('plain');
  await expect(old.page.locator('#view-banner .banner-sub')).toHaveText('This link no longer shows notes.');

  const nw = await visit(browser, testInfo, newUrl);
  await expect.poll(() => nw.page.evaluate(() => window.Atlas.viewMode)).toBe('notes');
  await expect(nw.page.locator('#view-banner')).toContainText('Ana’s map with notes');
  await expect(nw.page.locator('#list-world button.chip', { hasText: 'France' })).toBeVisible();
  expect((await request.get(`./api/maps/${link.id}/notes`, { headers: { Authorization: `Bearer ${fresh}` } })).status()).toBe(200);
  await a.ctx.close(); await old.ctx.close(); await nw.ctx.close();
});

test('n6 a second paired device\'s Share dialog shows the notes link after its next sync', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  const link = await createLink(a.page, request);

  const b = await newDevice(browser, testInfo);
  const errs = watchErrors(b.page);
  await b.page.goto(`./map/${link.id}#edit=${link.editKey}`);
  await waitMaps(b.page);
  await expect.poll(async () => (await storedLink(b.page) || {}).id).toBe(link.id);
  await expect(b.page.locator('#status')).toHaveText('Synced');
  await openShare(b.page);
  await expect(sw(b.page)).toHaveAttribute('aria-checked', 'false');
  await expect(b.page.locator('#share-notes-row')).toBeHidden();

  const token = await switchOn(a.page);
  // B's dialog stays open; its next sync brings the token and the dialog follows
  await expect.poll(async () => { await wake(b.page); await b.page.waitForTimeout(300); return b.page.locator('#share-notes-row').isVisible(); }, { timeout: 15000, intervals: [400] }).toBe(true);
  await expect(sw(b.page)).toHaveAttribute('aria-checked', 'true');
  await expect(b.page.locator('#share-notes-url')).toHaveValue(new URL(`/map/${link.id}#notes=${token}`, appRoot(testInfo)).href);

  // A turns it off; B follows on its next sync (an open turn-off confirm on B closes too)
  await sw(b.page).click();
  await expect(b.page.locator('#share-notes-confirm')).toBeVisible();
  await sw(a.page).click();
  await a.page.click('#share-notes-confirm-yes');
  await expect(sw(a.page)).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => { await wake(b.page); await b.page.waitForTimeout(300); return sw(b.page).getAttribute('aria-checked'); }, { timeout: 15000, intervals: [400] }).toBe('false');
  await expect(b.page.locator('#share-notes-row')).toBeHidden();
  await expect(b.page.locator('#share-notes-confirm')).toBeHidden();
  expect(errs, errs.join('\n')).toEqual([]);
  await a.ctx.close(); await b.ctx.close();
});

test('n7 an error while turning the notes link on shows inline and leaves the switch off', async ({ browser, request }, testInfo) => {
  const a = await newDevice(browser, testInfo);
  await createLink(a.page, request);
  await a.page.route('**/notes-link', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }));
  await sw(a.page).click();
  await expect(a.page.locator('#share-notes-msg')).toHaveText(/^Couldn’t make the notes link\./);
  await expect(a.page.locator('#share-notes-msg')).toHaveClass(/err/);
  await expect(sw(a.page)).toHaveAttribute('aria-checked', 'false');
  await expect(sw(a.page)).toBeEnabled();
  await expect(a.page.locator('#share-notes-row')).toBeHidden();
  expect((await storedLink(a.page)).notesToken).toBeNull();
  await a.ctx.close();
});

test('n8 375 px: both link rows fit, no horizontal scroll, targets at least 40 px', async ({ browser, request }, testInfo) => {
  const { ctx, page } = await newDevice(browser, testInfo, { viewport: { width: 375, height: 700 } });
  await createLink(page, request);
  await switchOn(page);
  await sw(page).click();                                   // show the confirm too
  await expect(page.locator('#share-notes-confirm')).toBeVisible();
  const ids = ['#share-copy', '#share-notes-switch', '#share-notes-copy', '#share-notes-reset', '#share-notes-confirm-yes', '#share-notes-confirm-no', '#share-copy-edit', '#share-reset', '#share-stop', '#share-delete'];
  for (const id of ids) {
    await page.locator(id).scrollIntoViewIfNeeded();
    const b = await page.locator(id).boundingBox();
    expect(b, id).not.toBeNull();
    expect(b.height, id).toBeGreaterThanOrEqual(40);
    expect(b.x, id).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, id).toBeLessThanOrEqual(375);
  }
  for (const id of ['#share-view', '#share-notes-url']) {
    const b = await page.locator(id).boundingBox();
    expect(b.x + b.width, id).toBeLessThanOrEqual(375);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(await page.$eval('#share form', f => f.scrollWidth <= f.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('share-375.png') });
  await ctx.close();
});
