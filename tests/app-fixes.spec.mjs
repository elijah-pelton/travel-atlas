// Travel Atlas — regression tests for the review fixes (multi-tab storage, backup reminder,
// touch targets, Replace/Undo, search + toast semantics, phone sizing).
import { test, expect } from '@playwright/test';

// ---------- helpers (small copies of the ones in smoke.spec.mjs) ----------

function appRoot(testInfo) {
  const b = testInfo.project.use.baseURL;
  return b.endsWith('/') ? b : b + '/';
}

function watchErrors(page) {
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}

async function openApp(page) {
  await page.goto('./');
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  // feature modules (<script defer>) finish wiring after the maps: wait so the layout is final
  await page.waitForFunction(() => window.Atlas && (!document.querySelector('script[src$="js/cities.js"]') || (window.AtlasCities && window.AtlasCities.ready)));
  await expect(page.locator('.stats .stat:not(.city-stat)')).toHaveCount(5);
}

async function counters(page) {
  return page.$$eval('.stats .stat:not(.city-stat) .num', els => els.map(e => e.textContent.replace(/\s+/g, '')));
}

/** An on-screen point that really hits `sel` (or another node with its data-id). */
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

async function isMarked(page, id) {
  return page.evaluate(id => {
    const ns = [...document.querySelectorAll(`svg.map [data-id="${id}"]`)];
    return ns.length > 0 && ns.every(n => n.classList.contains('on'));
  }, id);
}

async function openBackup(page) {
  await page.click('#backup-btn');
  await expect(page.locator('#backup')).toBeVisible();
}

async function closeBackup(page) {
  await page.click('#backup .dlg-head .x');
  await expect(page.locator('#backup')).toBeHidden();
}

async function restoreCode(page, code, { replace = false } = {}) {
  await page.fill('#code-in', code);
  if (replace) await page.check('#restore-replace');
  await page.click('#restore-code');
}

const stored = (page, key = 'travel-atlas:v1') => page.evaluate(k => localStorage.getItem(k), key);

/** Fire the "leaving / hidden" events the app listens to, as a backgrounded tab would. */
async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });
}

const FRA = 'svg.map[data-map="world"] path.place[data-id="FRA"]';
const SGP_DOT = 'svg.map[data-map="world"] circle.dot[data-id="SGP"]';
const BRA = 'svg.map[data-map="world"] path.place[data-id="BRA"]';

// ---------- 1: several copies of the app open at once ----------

test('fix1 a second tab repaints from storage, and hiding/closing a stale tab never overwrites marks', async ({ context }) => {
  const a = await context.newPage();
  const errsA = watchErrors(a);
  await openApp(a);
  const b = await context.newPage();
  await openApp(b);

  // mark in B -> A repaints (storage event), counters + chips follow
  await clickPlace(b, FRA);
  await clickPlace(b, SGP_DOT);
  await expect.poll(() => isMarked(a, 'FRA')).toBe(true);
  expect(await isMarked(a, 'SGP')).toBe(true);
  expect(await counters(a)).toEqual(['0/50', '0/6', '0/13', '2/196', '0/45']);
  await expect(a.locator('#list-world .lead')).toHaveText('Been there (2):');

  // the owner name follows too
  await b.click('#owner'); await b.keyboard.type('Ana'); await b.keyboard.press('Enter');
  await expect(a.locator('h1')).toHaveText('Ana’s Travel Atlas');
  expect(await a.title()).toContain('Ana’s Travel Atlas');

  // make A genuinely stale: a write from A's own document never reaches A's storage listener
  await a.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('travel-atlas:v2'));
    d.places.JPN = [1, Date.now()];
    localStorage.setItem('travel-atlas:v2', JSON.stringify(d));
  });
  expect(await isMarked(a, 'JPN')).toBe(false);          // A's in-memory set is now behind storage
  await expect.poll(() => isMarked(b, 'JPN')).toBe(true); // B adopted it

  // hiding and closing the stale tab must not write its old set back
  const v2Been = async p => { const d = JSON.parse(await stored(p, 'travel-atlas:v2')); return Object.keys(d.places).filter(k => d.places[k][0] === 1).sort(); };
  await hidePage(a);
  expect(await v2Been(b)).toEqual(['FRA', 'JPN', 'SGP']);
  await a.close({ runBeforeUnload: true });
  await b.waitForTimeout(200);
  expect(await v2Been(b)).toEqual(['FRA', 'JPN', 'SGP']);
  expect(await stored(b, 'travel-atlas:owner')).toBe('Ana');

  // B's marks survive a reload
  await b.reload();
  await openApp(b);
  for (const id of ['FRA', 'SGP', 'JPN']) expect(await isMarked(b, id), id).toBe(true);
  expect(errsA, errsA.join('\n')).toEqual([]);
});

test('fix1 a half-typed name is still saved when the tab is hidden', async ({ page }) => {
  await openApp(page);
  await page.click('#owner');
  await page.keyboard.type('Lee');
  await hidePage(page);
  expect(await stored(page, 'travel-atlas:owner')).toBe('Lee');
});

test('fix1 unreadable stored marks are kept aside, not overwritten at startup', async ({ page }) => {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('travel-atlas:v1', '{oops not json'); });
  await openApp(page);
  await expect(page.locator('#status')).toHaveText('Saved on this device');
  // the v2 migration parks the unreadable value under :v1.bad before :v1 becomes a mirror again
  expect(await stored(page, 'travel-atlas:v1.bad')).toBe('{oops not json');
  await clickPlace(page, FRA);
  expect(JSON.parse(await stored(page))).toEqual({ FRA: true });
  expect(await stored(page, 'travel-atlas:v1.bad')).toBe('{oops not json'); // copy survives the next save
});

// ---------- 3: backup reminder ----------

test('fix3 five marks with no backup shows "Back up your marks"; copying the code clears it', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(appRoot(testInfo)).origin });
  await openApp(page);
  const pill = page.locator('#status');
  await expect(pill).toHaveText('Saved on this device');

  await openBackup(page);
  await restoreCode(page, 'atlas1:FRA,DEU,ITA,JPN');
  await closeBackup(page);
  await expect(pill).toHaveText('Saved on this device');         // 4 marks: no nudge yet
  await clickPlace(page, SGP_DOT);                                 // 5th mark
  await expect(pill).toHaveText('Back up your marks');
  await expect(pill).toHaveAttribute('data-state', 'unsaved');
  await expect(pill).toHaveAttribute('role', 'button');
  // still there after a reload (it's derived from the stored marks + lastBackup)
  await page.reload();
  await openApp(page);
  await expect(pill).toHaveText('Back up your marks');

  // clicking the pill opens Backup; Copy code clears the reminder
  await pill.click();
  await expect(page.locator('#backup')).toBeVisible();
  expect(await page.inputValue('#code-out')).toBe('atlas2:b=DEU,FRA,ITA,JPN,SGP');
  await page.click('#copy-code');
  await expect(page.locator('#copy-note')).toHaveText(/Copied/);
  await expect(pill).toHaveText('Saved on this device');
  await expect(pill).toHaveAttribute('data-state', 'saved');
  await expect(pill).not.toHaveAttribute('role', 'button');
  const t = +(await stored(page, 'travel-atlas:lastBackup'));
  expect(Date.now() - t).toBeLessThan(60_000);

  // a backup older than 30 days brings the reminder back
  await page.evaluate(() => localStorage.setItem('travel-atlas:lastBackup', String(Date.now() - 31 * 864e5)));
  await page.reload();
  await openApp(page);
  await expect(pill).toHaveText('Back up your marks');
  // downloading a backup file also counts
  await pill.click();
  await Promise.all([page.waitForEvent('download'), page.click('#download-backup')]);
  await expect(pill).toHaveText('Saved on this device');
});

test('fix3 iOS hint warns to install before marking', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#ios-hint span')).toHaveText(/Install before marking/);
  await expect(page.locator('#ios-hint span')).toHaveText(/use Backup to carry them/);
});

// ---------- 4: tap targets and touch jitter ----------

test('fix4 phone: tapping near the Singapore dot marks it; small finger wobble is a tap; a drag is not', async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ baseURL: appRoot(testInfo), viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  const errs = watchErrors(page);
  await openApp(page);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) })) });

  // the dot itself is tiny on a phone; the invisible hit circle around it is ~22 px across
  const geo = await page.evaluate(() => {
    const dot = document.querySelector('svg.map[data-map="world"] circle.dot[data-id="SGP"]');
    dot.scrollIntoView({ block: 'center' });
    const hit = document.querySelector('svg.map[data-map="world"] circle.dot-hit[data-id="SGP"]');
    const d = dot.getBoundingClientRect(), h = hit.getBoundingClientRect();
    return { cx: d.x + d.width / 2, cy: d.y + d.height / 2, dotW: d.width, hitW: h.width };
  });
  testInfo.annotations.push({ type: 'note', description: `SGP dot ${geo.dotW.toFixed(1)}px, hit ${geo.hitW.toFixed(1)}px across at 375px` });
  expect(geo.dotW).toBeLessThan(6);
  // ~22 px across, except where a neighbouring dot (Brunei) is closer: then it stops halfway
  expect(geo.hitW).toBeGreaterThan(Math.max(10, geo.dotW * 4));
  expect(geo.hitW).toBeLessThan(25);

  // a point well outside the visible dot, but inside the hit circle, belongs to Singapore
  const off = Math.min(7, geo.hitW / 2 - 1.5);
  expect(off).toBeGreaterThan(geo.dotW / 2 + 2);
  const tx = geo.cx + off, ty = geo.cy;
  const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return { cls: e.getAttribute('class'), id: e.dataset.id }; }, [tx, ty]);
  expect(under).toEqual({ cls: 'dot-hit', id: 'SGP' });
  await page.touchscreen.tap(tx, ty);
  await expect.poll(() => isMarked(page, 'SGP')).toBe(true);
  await expect(page.locator('#toast-world .toast-msg')).toHaveText('Singapore: been there');
  // the hit circle is never painted, even when its place is marked
  const paint = await page.$eval('svg.map[data-map="world"] circle.dot-hit[data-id="SGP"]', h => {
    const cs = getComputedStyle(h);
    return { on: h.classList.contains('on'), fill: cs.fill, stroke: cs.stroke };
  });
  expect(paint.on).toBe(true);
  expect(paint.fill).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(paint.stroke).toBe('none');

  // a touch that wobbles 7 px before lifting is still a tap (clears it again)
  await touch('touchStart', [[tx, ty]]);
  await touch('touchMove', [[tx - 4, ty + 3]]);
  await touch('touchMove', [[tx - 7, ty + 5]]);
  await touch('touchEnd', []);
  await expect.poll(() => isMarked(page, 'SGP')).toBe(false);

  // a real finger drag across Brazil never toggles it
  const p = await hitPoint(page, BRA);
  await touch('touchStart', [[p.x, p.y]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[p.x + i * 8, p.y + 1]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  expect(await isMarked(page, 'BRA')).toBe(false);

  // the hit circle stays ~22 px across when zoomed in
  await page.click('.zoom[data-for="world"] [data-z="in"]');
  await page.click('.zoom[data-for="world"] [data-z="in"]');
  const hitW2 = await page.$eval('svg.map[data-map="world"] circle.dot-hit[data-id="SGP"]', h => h.getBoundingClientRect().width);
  expect(hitW2).toBeGreaterThan(19);
  expect(hitW2).toBeLessThan(25);

  expect(errs, errs.join('\n')).toEqual([]);
  await ctx.close();
});

test('fix4 desktop: hovering the hit circle shows that place in the tooltip', async ({ page }) => {
  await openApp(page);
  const pt = await page.evaluate(() => {
    const dot = document.querySelector('svg.map[data-map="world"] circle.dot[data-id="SGP"]');
    dot.scrollIntoView({ block: 'center' });
    const d = dot.getBoundingClientRect();
    return { x: d.x + d.width / 2 + 7, y: d.y + d.height / 2 };
  });
  await page.mouse.move(pt.x - 20, pt.y);
  await page.mouse.move(pt.x, pt.y, { steps: 3 });
  await expect(page.locator('#tip')).toHaveClass(/show/);
  await expect(page.locator('#tip')).toContainText('Singapore');
});

// ---------- 5: Replace is never sticky; Undo ----------

test('fix5 Replace is unchecked on reopen, and Undo restores the previous marks exactly', async ({ page }) => {
  await openApp(page);
  await openBackup(page);
  await restoreCode(page, 'atlas1:US-CO,FRA,SGP');
  await expect(page.locator('#restore-note')).toHaveText(/Added 3 new places/);
  const before = await page.inputValue('#code-out');
  expect(before).toBe('atlas2:b=FRA,SGP,US-CO');

  await restoreCode(page, 'atlas1:JPN,ZZZ', { replace: true });
  const note = page.locator('#restore-note');
  await expect(note).toHaveText(/^Replaced with 1 place \(1 unrecognized entry skipped\) · Undo$/);
  expect(await page.inputValue('#code-out')).toBe('atlas2:b=JPN');
  expect(await counters(page)).toEqual(['0/50', '0/6', '0/13', '1/196', '0/45']);

  await note.getByRole('button', { name: 'Undo' }).click();
  await expect(note).toHaveText(/previous 3 places are back/);
  expect(await page.inputValue('#code-out')).toBe(before);
  for (const id of ['US-CO', 'FRA', 'SGP']) expect(await isMarked(page, id), id).toBe(true);
  expect(await isMarked(page, 'JPN')).toBe(false);
  expect(JSON.parse(await stored(page))).toEqual({ 'US-CO': true, FRA: true, SGP: true });
  // an empty parse never replaces anything
  await page.check('#restore-replace');
  await restoreCode(page, 'atlas1:ZZZ', { replace: false });
  await expect(note).toHaveText('That doesn’t look like a backup code from this page.');
  for (const id of ['US-CO', 'FRA', 'SGP']) expect(await isMarked(page, id), id).toBe(true);

  // closing and reopening: Replace is back to unchecked
  await closeBackup(page);
  await openBackup(page);
  await expect(page.locator('#restore-replace')).not.toBeChecked();
  await expect(note).toHaveText('');
  // ... and a restore now adds
  await restoreCode(page, 'atlas1:JPN');
  await expect(note).toHaveText(/Added 1 new place\./);
  expect(await page.inputValue('#code-out')).toBe('atlas2:b=FRA,JPN,SGP,US-CO');

  await page.reload();
  await openApp(page);
  for (const id of ['US-CO', 'FRA', 'SGP', 'JPN']) expect(await isMarked(page, id), id).toBe(true);
});

// ---------- 9: screen-reader semantics ----------

test('fix9 search is a combobox with a listbox; toasts are live; chips open details', async ({ page }) => {
  await openApp(page);
  const q = page.locator('#q');
  await expect(q).toHaveAttribute('role', 'combobox');
  await expect(q).toHaveAttribute('aria-controls', 'results');
  await expect(q).toHaveAttribute('aria-autocomplete', 'list');
  await expect(q).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#results')).toHaveAttribute('role', 'listbox');
  await expect(page.locator('#results')).toHaveAttribute('aria-label', /.+/);

  await q.fill('singa');
  await expect(q).toHaveAttribute('aria-expanded', 'true');
  const opt = page.getByRole('option', { name: /^Singapore/ });
  await expect(opt).toHaveCount(1);
  await expect(opt).toHaveAttribute('aria-checked', 'false');
  await q.press('ArrowDown');
  const optId = await opt.getAttribute('id');
  expect(optId).toBeTruthy();
  await expect(q).toHaveAttribute('aria-activedescendant', optId);
  await expect(opt).toHaveAttribute('aria-selected', 'true');
  await q.press('Enter');
  await expect(opt).toHaveAttribute('aria-checked', 'true');
  await expect(opt).toHaveAccessibleName(/been there/);
  await q.press('Escape');
  await expect(q).toHaveAttribute('aria-expanded', 'false');
  await expect(q).not.toHaveAttribute('aria-activedescendant', /.*/);

  for (const t of ['#toast-na', '#toast-world']) {
    await expect(page.locator(t)).toHaveAttribute('role', 'status');
    await expect(page.locator(t)).toHaveAttribute('aria-live', 'polite');
  }
  await expect(page.locator('#toast-world .toast-msg')).toHaveText('Singapore: been there');
  await expect(page.locator('#list-world .chip')).toHaveAttribute('aria-label', 'Singapore, been there. Open details.');
  await expect(page.getByRole('button', { name: 'Singapore, been there. Open details.' })).toHaveCount(1);
});

// ---------- 6 + 11: phone sizing ----------

test('fix6/11 at 375px: 16px inputs, 40px zoom + close buttons, tall chip targets', async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ baseURL: appRoot(testInfo), viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await openApp(page);
  expect(await page.$eval('#q', e => getComputedStyle(e).fontSize)).toBe('16px');
  for (const z of ['in', 'out', 'reset']) {
    const b = await page.locator(`.zoom[data-for="world"] [data-z="${z}"]`).boundingBox();
    expect(b.width, z).toBeGreaterThanOrEqual(40);
    expect(b.height, z).toBeGreaterThanOrEqual(40);
  }
  // iOS hint close button (force-show it to measure)
  await page.evaluate(() => { document.querySelector('#ios-hint').hidden = false; });
  const hx = await page.locator('#ios-hint-close').boundingBox();
  expect(hx.width).toBeGreaterThanOrEqual(40);
  expect(hx.height).toBeGreaterThanOrEqual(40);
  // no horizontal page scroll with the longer hint
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.evaluate(() => { document.querySelector('#ios-hint').hidden = true; });

  await openBackup(page);
  for (const t of ['#code-out', '#code-in']) expect(await page.$eval(t, e => getComputedStyle(e).fontSize), t).toBe('16px');
  const x = await page.locator('#backup .dlg-head .x').boundingBox();
  expect(x.width).toBeGreaterThanOrEqual(40);
  expect(x.height).toBeGreaterThanOrEqual(40);
  await restoreCode(page, 'atlas1:FRA,DEU,JPN');
  await closeBackup(page);

  // chips keep their compact look but the tap area reaches ~36 px tall
  const chip = page.locator('#list-world .chip').first();
  await chip.scrollIntoViewIfNeeded();
  const r = await chip.evaluate(c => {
    const b = c.getBoundingClientRect(), cx = b.x + b.width / 2;
    const above = document.elementFromPoint(cx, b.top - 6), below = document.elementFromPoint(cx, b.bottom + 6);
    return { h: b.height, above: above === c, below: below === c };
  });
  expect(r.h).toBeLessThan(30);
  expect(r.above && r.below, JSON.stringify(r)).toBe(true);
  expect(r.h + 14).toBeGreaterThanOrEqual(36);
  await ctx.close();
});

// ---------- dialog note contrast ----------

for (const scheme of ['light', 'dark']) {
  test(`dialog ok/err notes reach 4.5:1 on the panel (${scheme})`, async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ baseURL: appRoot(testInfo), colorScheme: scheme });
    const page = await ctx.newPage();
    await openApp(page);
    await openBackup(page);
    const ratios = await page.evaluate(() => {
      const parse = s => s.match(/[\d.]+/g).map(Number);
      const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const n = document.querySelector('#restore-note');
      const bg = parse(getComputedStyle(document.querySelector('#backup')).backgroundColor);
      const out = {};
      for (const c of ['ok', 'err']) { n.className = 'dlg-note ' + c; out[c] = ratio(parse(getComputedStyle(n).color), bg); }
      return out;
    });
    expect(ratios.ok, 'ok').toBeGreaterThanOrEqual(4.5);
    expect(ratios.err, 'err').toBeGreaterThanOrEqual(4.5);
    await ctx.close();
  });
}
