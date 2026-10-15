// Travel Atlas: "Ratings" map style (docs/plan-ux.md §2.3, §4, §5, §8 ratings.spec; js/ratings.js).
// Runs against the local Worker (`npm run dev:test`) or any server via BASE_URL.
import { test, expect } from '@playwright/test';

const ACCENTS = ['amber', 'coral', 'rose', 'violet', 'blue', 'teal', 'green'];

// world: one place per ramp step, one been without rating, one want; NA: one rated, one unrated
const RATED = { FRA: 1, DEU: 2, ESP: 3, ITA: 4, PRT: 5, 'US-CO': 2 };
const UNRATED = ['POL', 'US-TX'];
const WANT = ['JPN', 'US-NY'];

function appRoot(testInfo) {
  const b = testInfo.project.use.baseURL;
  return b.endsWith('/') ? b : b + '/';
}

function watchErrors(page) {
  const errs = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|net::ERR_/.test(m.text())) return;
    errs.push('console: ' + m.text());
  });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}

/** Write a v2 store document (plan-data-sync "Client (localStorage)") before the app loads. */
async function seed(page, { rated = {}, unrated = [], want = [], style = null, accent = null } = {}) {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(({ rated, unrated, want, style, accent }) => {
    localStorage.clear();
    const t = Date.now() - 60000;
    const doc = { v: 2, places: {}, notes: {}, owner: ['', 0], dirty: {} };
    for (const id in rated) { doc.places[id] = [1, t]; doc.notes[id] = [rated[id], 0, '', t]; }
    for (const id of unrated) doc.places[id] = [1, t];
    for (const id of want) doc.places[id] = [2, t];
    localStorage.setItem('travel-atlas:v2', JSON.stringify(doc));
    if (style) localStorage.setItem('travel-atlas:style', style);
    if (accent) localStorage.setItem('travel-atlas:accent', accent);
  }, { rated, unrated, want, style, accent });
}

/** Load the app, make sure the maps, window.Atlas and the Ratings module are there. */
async function openApp(page, url = './') {
  await page.goto(url);
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  await page.waitForFunction(() => !!window.Atlas);
  // until index.html carries them (T1), load the stylesheet and the module the way the page will
  if (!(await page.$('link[href$="css/features.css"]'))) await page.addStyleTag({ url: './css/features.css' });
  if (!(await page.$('script[src$="js/ratings.js"]'))) await page.addScriptTag({ url: './js/ratings.js' });
  await page.waitForSelector('#sec-world .legend.legend-ratings', { state: 'attached' });
}

const ratingsBtn = page => page.locator('#style-seg button[data-style="ratings"]');
const bodyHas = (page, c) => page.evaluate(c => document.body.classList.contains(c), c);

/** Class list of every node of a place that the ramp paints. */
const rampClasses = (page, id) => page.evaluate(id =>
  [...document.querySelectorAll(`svg.map :is(.place, .dot, .city)[data-id="${id}"]`)]
    .map(n => ['r1', 'r2', 'r3', 'r4', 'r5', 'unrated'].filter(c => n.classList.contains(c)).join(' ')), id);

/** Resolve any CSS color (color-mix, oklab, ...) to sRGB bytes by painting it on a canvas. */
const COLOR_FN = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  return c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
})()`;
const installRgb = page => page.evaluate(`window.__rgb = window.__rgb || ${COLOR_FN}`);

test('r1 Ratings button joins the style seg; aria-pressed; body.ratings; terrain hidden', async ({ page }) => {
  const errs = watchErrors(page);
  await seed(page, { rated: RATED, unrated: UNRATED, want: WANT });
  await openApp(page);
  const btn = ratingsBtn(page);
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText('Ratings');
  await expect(btn).toHaveAttribute('type', 'button');
  await expect(page.locator('#style-seg button')).toHaveText(['Flat colors', 'Real map', 'Ratings']);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');

  // from Real map: Ratings drops the terrain and labels and is the only pressed button
  await page.click('#style-seg button[data-style="real"]');
  expect(await bodyHas(page, 'real')).toBe(true);
  await btn.click();
  expect(await bodyHas(page, 'ratings')).toBe(true);
  expect(await bodyHas(page, 'real')).toBe(false);
  await expect(page.locator('#style-seg button[aria-pressed="true"]')).toHaveCount(1);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const terrainShown = await page.$$eval('svg.map .terrain', ns => ns.filter(n => getComputedStyle(n).display !== 'none').length);
  expect(terrainShown).toBe(0);

  // keyboard: Tab focus + Enter on Flat leaves Ratings
  await page.focus('#style-seg button[data-style="flat"]');
  await page.keyboard.press('Enter');
  expect(await bodyHas(page, 'ratings')).toBe(false);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#style-seg button[data-style="flat"]')).toHaveAttribute('aria-pressed', 'true');
  await page.focus('#style-seg button[data-style="ratings"]');
  await page.keyboard.press('Space');
  expect(await bodyHas(page, 'ratings')).toBe(true);
  expect(errs).toEqual([]);
});

test('r2 ramp classes match ratings; unrated outline; want and unmarked stay plain', async ({ page }) => {
  await seed(page, { rated: { ...RATED, SGP: 4 }, unrated: UNRATED, want: [...WANT, 'MCO'], style: 'ratings' });
  await openApp(page);
  await expect.poll(() => bodyHas(page, 'ratings')).toBe(true);
  for (const [id, r] of Object.entries({ ...RATED, SGP: 4 })) {
    await expect.poll(() => rampClasses(page, id), id).toEqual(expect.arrayContaining(['r' + r]));
    const cls = await rampClasses(page, id);
    expect(cls.every(c => c === 'r' + r), `${id}: ${cls}`).toBe(true);
  }
  for (const id of UNRATED) expect((await rampClasses(page, id)).every(c => c === 'unrated'), id).toBe(true);
  for (const id of [...WANT, 'MCO', 'BRA', 'US-WA']) expect((await rampClasses(page, id)).every(c => c === ''), id).toBe(true);
  // small places (dots) are painted by the same ramp
  expect(await page.$$eval('svg.map .dot[data-id="SGP"]', ns => ns.length)).toBeGreaterThan(0);
  expect(await page.$eval('svg.map .dot[data-id="SGP"]', n => n.classList.contains('r4'))).toBe(true);

  await page.waitForTimeout(300);   // app.css fades fills over .12s
  await installRgb(page);
  const looks = await page.evaluate(() => {
    const rgb = window.__rgb;
    const root = getComputedStyle(document.documentElement);
    const v = name => rgb(root.getPropertyValue(name).trim());
    const node = id => document.querySelector(`svg.map .place[data-id="${id}"]`);
    const cs = id => getComputedStyle(node(id));
    return {
      land: v('--land'), line: v('--line'), stripe: v('--want-stripe'),
      r: [1, 2, 3, 4, 5].map(i => v('--r' + i)),
      fill: Object.fromEntries(['FRA', 'DEU', 'ESP', 'ITA', 'PRT', 'POL', 'JPN', 'BRA'].map(id => [id, rgb(cs(id).fill)])),
      unrated: { stroke: rgb(cs('POL').stroke), width: cs('POL').strokeWidth },
      want: { stroke: rgb(cs('JPN').stroke), dash: cs('JPN').strokeDasharray },
    };
  });
  expect(looks.fill.FRA).toEqual(looks.r[0]);
  expect(looks.fill.DEU).toEqual(looks.r[1]);
  expect(looks.fill.ESP).toEqual(looks.r[2]);
  expect(looks.fill.ITA).toEqual(looks.r[3]);
  expect(looks.fill.PRT).toEqual(looks.r[4]);
  // been, no rating: land fill + 1.5px accent outline
  expect(looks.fill.POL).toEqual(looks.land);
  expect(looks.unrated.stroke).toEqual(looks.stripe);
  expect(looks.unrated.width).toBe('1.5px');
  // want and unmarked: plain land, no stripes, no dashes
  expect(looks.fill.JPN).toEqual(looks.land);
  expect(looks.fill.BRA).toEqual(looks.land);
  expect(looks.want.stroke).toEqual(looks.line);
  expect(looks.want.dash).toBe('none');
});

test('r3 legend: ramp with written numbers, "Been, no rating", "Not been or want to go"; hint when nothing is rated', async ({ page }) => {
  await seed(page, { unrated: UNRATED, want: WANT });
  await openApp(page);
  // hidden outside Ratings
  await expect(page.locator('.legend-ratings').first()).toBeHidden();
  await expect(page.locator('.ratings-hint').first()).toBeHidden();
  await ratingsBtn(page).click();
  for (const sec of ['#sec-na', '#sec-world']) {
    const lg = page.locator(`${sec} .legend.legend-ratings`);
    await expect(lg).toHaveCount(1);
    await expect(lg).toBeVisible();
    await expect(page.locator(`${sec} .legend:not(.legend-ratings)`)).toBeHidden();
    await expect(lg.locator('.ramp i')).toHaveCount(5);
    await expect(lg.locator('.ramp .num')).toHaveText(['1 ★', '2 ★', '3 ★', '4 ★', '5 ★']);
    for (let r = 1; r <= 5; r++) await expect(lg.locator('.ramp i').nth(r - 1)).toHaveClass(`r${r}`);
    await expect(lg.locator('.ramp')).toHaveAttribute('aria-label', /1 star.*5 stars/);
    await expect(lg).toContainText('Been, no rating');
    await expect(lg).toContainText('Not been or want to go');
    await expect(lg.locator('i.unrated')).toHaveCount(1);
    await expect(page.locator(`${sec} .ratings-hint`)).toBeVisible();
    await expect(page.locator(`${sec} .ratings-hint`)).toHaveText('Rate places from the lists below to color this map.');
  }
  // rating one world place (through the core) hides the world hint and recolors live
  await page.evaluate(() => window.Atlas.setInfo('POL', { rating: 3 }));
  await expect.poll(() => rampClasses(page, 'POL')).toEqual(expect.arrayContaining(['r3']));
  await expect(page.locator('#sec-world .ratings-hint')).toBeHidden();
  await expect(page.locator('#sec-na .ratings-hint')).toBeVisible();
  // clearing the rating brings back the outline and the hint
  await page.evaluate(() => window.Atlas.setInfo('POL', { rating: 0 }));
  await expect.poll(() => rampClasses(page, 'POL')).toEqual(expect.arrayContaining(['unrated']));
  await expect(page.locator('#sec-world .ratings-hint')).toBeVisible();
  // a new been place shows up as unrated at once; clearing it drops the paint
  await page.evaluate(() => window.Atlas.setStatus('BRA', 'been'));
  await expect.poll(() => rampClasses(page, 'BRA')).toEqual(expect.arrayContaining(['unrated']));
  await page.evaluate(() => window.Atlas.setStatus('BRA', 'none'));
  await expect.poll(async () => (await rampClasses(page, 'BRA')).every(c => c === '')).toBe(true);
});

test('r4 the Ratings style is saved per device and survives a reload', async ({ page }) => {
  await seed(page, { rated: RATED });
  await openApp(page);
  await ratingsBtn(page).click();
  expect(await page.evaluate(() => localStorage.getItem('travel-atlas:style'))).toBe('ratings');
  await page.reload();
  await openApp(page);
  await expect.poll(() => bodyHas(page, 'ratings')).toBe(true);
  await expect(ratingsBtn(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#style-seg button[aria-pressed="true"]')).toHaveCount(1);
  expect(await bodyHas(page, 'real')).toBe(false);
  await expect.poll(() => rampClasses(page, 'PRT')).toEqual(expect.arrayContaining(['r5']));
  await page.click('#style-seg button[data-style="flat"]');
  expect(await bodyHas(page, 'ratings')).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('travel-atlas:style'))).toBe('flat');
  await page.reload();
  await openApp(page);
  await expect(page.locator('#style-seg button[data-style="flat"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await bodyHas(page, 'ratings')).toBe(false);
});

test('r5 a plain view link hides Ratings (ratings are private), even if this device saved it', async ({ page, request }) => {
  const t = Date.now();
  const res = await request.post('./api/maps', { data: { name: 'Ana', owner: 'Ana', ownerT: t, places: { FRA: [1, t], 'US-CA': [1, t] } } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = await res.json();
  await seed(page, { rated: { DEU: 4 }, style: 'ratings' });
  await openApp(page, `./map/${id}`);
  await expect(page.locator('#view-banner')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.Atlas.viewMode)).toBe('plain');
  await expect(ratingsBtn(page)).toBeHidden();
  expect(await bodyHas(page, 'ratings')).toBe(false);
  await expect(page.locator('.legend-ratings').first()).toBeHidden();
  await expect(page.locator('#style-seg button[data-style="flat"]')).toBeVisible();
  // the device's own choice is untouched
  expect(await page.evaluate(() => localStorage.getItem('travel-atlas:style'))).toBe('ratings');
});

test('r7 a map-with-notes view link offers Ratings, colored from the shared notes', async ({ page, request }) => {
  const t = Date.now();
  const res = await request.post('./api/maps', {
    data: { name: 'Ana', owner: 'Ana', ownerT: t, places: { FRA: [1, t], DEU: [1, t], JPN: [2, t] }, notes: { FRA: [4, 2019, 'Paris', t], JPN: [5, 0, '', t] } },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { id, editKey } = await res.json();
  const on = await request.post(`./api/maps/${id}/notes-link`, { data: { action: 'on' }, headers: { Authorization: `Bearer ${editKey}` } });
  expect(on.status()).toBe(200);
  const { notesToken } = await on.json();
  await seed(page, {});
  await openApp(page, `./map/${id}#notes=${notesToken}`);
  await expect.poll(() => page.evaluate(() => window.Atlas.viewMode)).toBe('notes');
  await expect(ratingsBtn(page)).toBeVisible();
  await ratingsBtn(page).click();
  await expect(ratingsBtn(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await bodyHas(page, 'ratings')).toBe(true);
  await expect.poll(() => rampClasses(page, 'FRA')).toEqual(expect.arrayContaining(['r4']));
  expect((await rampClasses(page, 'DEU')).every(c => c === 'unrated')).toBe(true);
  expect((await rampClasses(page, 'JPN')).every(c => c === '')).toBe(true);   // want stays plain, rating or not
  await expect(page.locator('#sec-world .ratings-hint')).toBeHidden();
});

for (const scheme of ['light', 'dark']) {
  test(`r6 ${scheme}: ramp lightness is monotonic from land to 5 in all 7 accents (legend and map)`, async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ baseURL: appRoot(testInfo), colorScheme: scheme, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await seed(page, { rated: RATED, style: 'ratings' });
    await openApp(page);
    await expect.poll(() => bodyHas(page, 'ratings')).toBe(true);
    const report = [];
    for (const accent of ACCENTS) {
      await page.evaluate(a => { if (a === 'amber') document.documentElement.removeAttribute('data-accent'); else document.documentElement.setAttribute('data-accent', a); }, accent);
      await page.waitForTimeout(300);   // .12s fill transition on map places
      await installRgb(page);
      const m = await page.evaluate(() => {
        const rgb = window.__rgb;
        // WCAG relative luminance and OKLab L
        const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const L = ([r, g, b]) => {
          const R = lin(r), G = lin(g), B = lin(b);
          const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
          const mm = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
          const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
          return 0.2104542553 * l + 0.7936177850 * mm - 0.0040720468 * s;
        };
        const land = rgb(getComputedStyle(document.documentElement).getPropertyValue('--land').trim());
        const legend = [...document.querySelectorAll('#sec-world .legend-ratings .ramp i')].map(i => rgb(getComputedStyle(i).backgroundColor));
        const map = ['FRA', 'DEU', 'ESP', 'ITA', 'PRT'].map(id => rgb(getComputedStyle(document.querySelector(`svg.map .place[data-id="${id}"]`)).fill));
        return { land, legend, map, Lland: L(land), L: legend.map(L), Y: [land, ...legend].map(Y) };
      });
      // the map uses exactly the legend's colors
      expect(m.map, `${scheme}/${accent} map = legend`).toEqual(m.legend);
      const seq = [m.Lland, ...m.L];
      const steps = seq.slice(1).map((v, i) => v - seq[i]);
      const dir = Math.sign(steps[steps.length - 1]);
      report.push(`${accent}: L ${seq.map(v => v.toFixed(3)).join(' ')}`);
      expect(dir, `${scheme}/${accent} ramp has a direction`).not.toBe(0);
      // light theme: darker with each step; dark theme: lighter with each step
      expect(dir, `${scheme}/${accent} direction`).toBe(scheme === 'light' ? -1 : 1);
      for (const [i, d] of steps.entries()) {
        expect(d * dir, `${scheme}/${accent} step ${i}->${i + 1} (${seq.map(v => v.toFixed(3)).join(' ')})`).toBeGreaterThan(0.015);
      }
      // luminance (what contrast is computed from) moves the same way
      for (let i = 1; i < m.Y.length; i++) expect((m.Y[i] - m.Y[i - 1]) * dir, `${scheme}/${accent} Y step ${i}`).toBeGreaterThan(0);
    }
    testInfo.annotations.push({ type: 'ramp', description: report.join(' | ') });
    await ctx.close();
  });
}
