// Place details panel (js/places-panel.js): docs/plan-ux.md §2.2, §5, §6 state 4/13, §8 panel.spec.
// Talks to the app through window.Atlas only. If index.html does not load the panel yet, the test
// injects ./js/places-panel.js after load.
import { test, expect } from '@playwright/test';

// ---------- helpers ----------
function watchErrors(page) {
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}

async function openApp(page) {
  await page.goto('./');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  await page.waitForFunction(() => !!window.Atlas);
  if (!(await page.evaluate(() => !!window.AtlasPanel))) await page.addScriptTag({ url: './js/places-panel.js' });
  await page.waitForFunction(() => !!window.AtlasPanel);
}

const BEEN = 1, WANT = 2;
async function mark(page, id, s) { await page.evaluate(([id, s]) => window.Atlas.setStatus(id, s, { quiet: true }), [id, s]); }
async function status(page, id) {
  return page.evaluate(id => { const s = window.Atlas.getStatus(id); return s === 'been' ? 1 : s === 'want' ? 2 : s ? +s : 0; }, id);
}
async function info(page, id) {
  return page.evaluate(id => { const n = window.Atlas.getInfo(id); return n ? { rating: n.rating | 0, year: n.year | 0, note: n.note || '' } : null; }, id);
}

/** The chip for a place, by data-id when chips carry one, else by its visible name. */
function chip(page, id, name) {
  return page.locator(`.visited-list .chip[data-id="${id}"]`).or(page.locator('.visited-list .chip', { hasText: name })).first();
}

const panel = page => page.locator('dialog.place-panel');
const statusBtn = (page, label) => panel(page).locator('.status-seg [role="radio"]', { hasText: label });

/** Find an on-screen point that hits a map node with this data-id (as smoke.spec's hitPoint). */
async function hitPoint(page, sel) {
  const pt = await page.evaluate(sel => {
    const elm = document.querySelector(sel);
    if (!elm) return { err: 'no element ' + sel };
    const id = elm.dataset.id;
    elm.scrollIntoView({ block: 'center', inline: 'center' });
    const bb = elm.getBBox(), ctm = elm.getScreenCTM(), svg = elm.ownerSVGElement;
    const N = 40, cand = [];
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
    return { err: 'no clickable point for ' + sel };
  }, sel);
  expect(pt.err, pt.err).toBeUndefined();
  return pt;
}

// ---------- tests ----------
test.describe('place details panel', () => {
  test('chip opens the panel; focus starts on the status seg; Esc closes and returns focus', async ({ page }) => {
    const errs = watchErrors(page);
    await openApp(page);
    await mark(page, 'PER', BEEN);
    const c = chip(page, 'PER', 'Peru');
    await c.click();
    const dlg = panel(page);
    await expect(dlg).toBeVisible();
    await expect(dlg).not.toHaveClass(/readonly/);
    // native modal with an accessible name from the h2
    const a11y = await dlg.evaluate(d => ({ modal: d.matches(':modal'), name: document.getElementById(d.getAttribute('aria-labelledby')).textContent }));
    expect(a11y).toEqual({ modal: true, name: 'Peru' });
    await expect(dlg.locator('.dlg-sub')).toHaveText('Country · World');
    await expect(statusBtn(page, 'Been there')).toHaveAttribute('aria-checked', 'true');
    await expect(statusBtn(page, 'Been there')).toBeFocused();
    await expect(dlg.locator('.pp-rating')).toBeVisible();
    await expect(dlg.locator('#pp-year')).toBeVisible();
    await expect(dlg.locator('#pp-note')).toHaveAttribute('placeholder', 'What do you remember?');
    await expect(dlg.locator('.place-privacy')).toHaveText('Only you see notes and ratings, unless you turn on the notes link in Share.');
    // the chip opens details now; it no longer removes the place
    expect(await status(page, 'PER')).toBe(BEEN);
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(c).toBeFocused();
    expect(errs).toEqual([]);
  });

  test('rating, year and note save and survive a reload', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await chip(page, 'PER', 'Peru').click();
    const dlg = panel(page);
    await dlg.locator('.stars .star').nth(3).click();        // 4 stars
    await expect(dlg.locator('input[aria-label="4 stars"]')).toBeChecked();
    expect((await info(page, 'PER')).rating).toBe(4);          // stars save at once
    await dlg.locator('#pp-year').fill('2019');
    await dlg.locator('#pp-note').fill('Ceviche in Lima 🐟');
    await expect.poll(() => info(page, 'PER'), { timeout: 2000 }).toEqual({ rating: 4, year: 2019, note: 'Ceviche in Lima 🐟' });
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toBeHidden();

    await page.reload();
    await openApp(page);
    expect(await info(page, 'PER')).toEqual({ rating: 4, year: 2019, note: 'Ceviche in Lima 🐟' });
    await chip(page, 'PER', 'Peru').click();
    await expect(panel(page).locator('input[aria-label="4 stars"]')).toBeChecked();
    await expect(panel(page).locator('#pp-year')).toHaveValue('2019');
    await expect(panel(page).locator('#pp-note')).toHaveValue('Ceviche in Lima 🐟');
    // "No rating" clears the stars
    await panel(page).locator('.star-none').click();
    expect((await info(page, 'PER')).rating).toBe(0);
  });

  test('closing right after typing still saves (no wait for the debounce)', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await chip(page, 'PER', 'Peru').click();
    await panel(page).locator('#pp-note').fill('quick one');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    expect((await info(page, 'PER')).note).toBe('quick one');
  });

  test('year is validated with inline error text', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await page.evaluate(() => window.Atlas.setInfo('PER', { year: 2019 }));
    await chip(page, 'PER', 'Peru').click();
    const dlg = panel(page), year = dlg.locator('#pp-year');
    await expect(year).toHaveAttribute('inputmode', 'numeric');
    await year.fill('1850');
    await dlg.locator('#pp-note').focus();
    const next = new Date().getFullYear() + 1;
    await expect(dlg.locator('#pp-year-err')).toHaveText(`Use a year from 1900 to ${next}, or leave it empty.`);
    await expect(year).toHaveAttribute('aria-invalid', 'true');
    expect((await info(page, 'PER')).year).toBe(2019);         // bad value never saved
    await year.fill(String(next + 1));
    await dlg.locator('#pp-note').focus();
    await expect(dlg.locator('#pp-year-err')).toBeVisible();
    await year.fill('20ab');
    await expect(year).toHaveValue('20');                       // digits only
    await year.fill('');
    await dlg.locator('#pp-note').focus();
    await expect(dlg.locator('#pp-year-err')).toBeHidden();
    await expect.poll(async () => (await info(page, 'PER') || { year: 0 }).year).toBe(0);
  });

  test('note counter appears at 400 and counts code points; cap is 500', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await chip(page, 'PER', 'Peru').click();
    const dlg = panel(page), note = dlg.locator('#pp-note'), count = dlg.locator('.note-count');
    await note.fill('a'.repeat(399));
    await expect(count).toBeHidden();
    await note.fill('🐟'.repeat(400));                          // 400 code points, 800 UTF-16 units
    await expect(count).toBeVisible();
    await expect(count).toHaveText('100 left');
    await note.fill('b'.repeat(520));
    await expect(count).toHaveText('0 left');
    expect(await note.evaluate(t => Array.from(t.value).length)).toBe(500);
    await page.keyboard.press('Escape');
    expect(Array.from((await info(page, 'PER')).note).length).toBe(500);
  });

  test('want and not-marked states; removal from the panel', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', WANT);
    await chip(page, 'PER', 'Peru').click();
    const dlg = panel(page);
    await expect(statusBtn(page, 'Want to go')).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.locator('.pp-rating')).toBeHidden();       // rating and year are for been only
    await expect(dlg.locator('#pp-year')).toBeHidden();
    await expect(dlg.locator('#pp-note')).toHaveAttribute('placeholder', 'Why do you want to go?');
    // switching to Been there saves at once and shows rating + year
    await statusBtn(page, 'Been there').click();
    expect(await status(page, 'PER')).toBe(BEEN);
    await expect(dlg.locator('.pp-rating')).toBeVisible();
    await expect(dlg.locator('#pp-note')).toHaveAttribute('placeholder', 'What do you remember?');
    // removal
    await statusBtn(page, 'Not marked').click();
    expect(await status(page, 'PER')).toBe(0);
    await expect(statusBtn(page, 'Not marked')).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.locator('.pp-rating')).toBeHidden();
    await expect(dlg.locator('#pp-note')).toBeHidden();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.visited-list .chip', { hasText: 'Peru' })).toHaveCount(0);
  });

  test('panel follows changes made elsewhere while open', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await chip(page, 'PER', 'Peru').click();
    await mark(page, 'PER', WANT);
    await expect(statusBtn(page, 'Want to go')).toHaveAttribute('aria-checked', 'true');
    await expect(panel(page).locator('.pp-rating')).toBeHidden();
    await mark(page, 'PER', BEEN);
    await page.evaluate(() => window.Atlas.setInfo('PER', { rating: 3 }));
    await expect(panel(page).locator('input[aria-label="3 stars"]')).toBeChecked();
  });

  test('toast Details button opens the panel', async ({ page }) => {
    await openApp(page);
    const p = await hitPoint(page, '#frame-world svg.map [data-id="BRA"]');
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up();
    expect(await status(page, 'BRA')).toBe(BEEN);
    const act = page.locator('#toast-world .toast-act');
    await expect(act).toBeVisible();
    await act.click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('h2')).toHaveText('Brazil');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    // the toast may be gone by now; focus lands on something sensible (the toast button or Brazil's chip)
    const focused = await page.evaluate(() => { const a = document.activeElement; return a && (a.classList.contains('toast-act') || a.classList.contains('chip')); });
    expect(focused).toBe(true);
  });

  test('city panel shows "City · <Country>"', async ({ page }) => {
    await openApp(page);
    // js/cities.js registers cities in Atlas.places as {id, name, kind: 'city', map, country: <ISO3>};
    // register one the same way so this test does not depend on the lazy city data
    await page.evaluate(() => {
      if (!window.Atlas.places.has('C-1159151299')) {
        window.Atlas.places.set('C-1159151299', { id: 'C-1159151299', name: 'Kyoto', kind: 'city', map: 'world', country: 'JPN' });
      }
    });
    await mark(page, 'C-1159151299', BEEN);
    await page.evaluate(() => window.AtlasPanel.open('C-1159151299'));
    await expect(panel(page).locator('h2')).toHaveText(/\S/);
    await expect(panel(page).locator('.dlg-sub')).toHaveText('City · Japan');
    await expect(panel(page).locator('.pp-rating')).toBeVisible();
  });

  test('keyboard-only flow', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', WANT);
    const c = chip(page, 'PER', 'Peru');
    await c.focus();
    await page.keyboard.press('Enter');
    const dlg = panel(page);
    await expect(dlg).toBeVisible();
    await expect(statusBtn(page, 'Want to go')).toBeFocused();
    await page.keyboard.press('ArrowLeft');                    // Want -> Been there, saves at once
    await expect(statusBtn(page, 'Been there')).toBeFocused();
    expect(await status(page, 'PER')).toBe(BEEN);
    await page.keyboard.press('Tab');                          // into the stars
    await page.keyboard.press('ArrowRight');                   // native radios: arrows move and pick
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await info(page, 'PER') || { rating: 0 }).rating).toBeGreaterThan(0);
    const picked = (await info(page, 'PER')).rating;
    await page.keyboard.press('Tab');                          // year
    await expect(dlg.locator('#pp-year')).toBeFocused();
    await page.keyboard.type('2021');
    await page.keyboard.press('Tab');                          // note
    await expect(dlg.locator('#pp-note')).toBeFocused();
    await page.keyboard.type('Back again');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(c).toBeFocused();
    expect(await info(page, 'PER')).toEqual({ rating: picked, year: 2021, note: 'Back again' });
  });

  test('read-only variant on the map-with-notes view', async ({ page }) => {
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await page.evaluate(() => window.Atlas.setInfo('PER', { rating: 4, year: 2019, note: 'Ceviche' }));
    // the real map-with-notes page is covered by share-notes.spec (T6); here the seam's viewMode is
    // overridden so the panel takes its read-only branch against the owner's own data
    await page.evaluate(() => {
      Object.defineProperty(window.Atlas, 'viewMode', { get: () => 'notes', configurable: true });
      Object.defineProperty(window.Atlas, 'ownerName', { value: () => 'Sam', configurable: true });
    });
    await page.evaluate(() => window.AtlasPanel.open('PER'));
    const dlg = panel(page);
    await expect(dlg).toHaveClass(/readonly/);
    await expect(dlg.locator('.pp-rating-ro .dlg-label')).toHaveText('Sam’s rating');
    await expect(dlg.locator('.stars-ro .star-ro.lit')).toHaveCount(4);
    await expect(dlg.locator('.pp-year-ro')).toHaveText('Went in 2019');
    await expect(dlg.locator('.pp-note-ro .place-ro')).toHaveText('Ceviche');
    // no editable controls or privacy line are shown
    await expect(dlg.locator('.pp-note, .pp-year, .pp-rating, .place-privacy')).toHaveCount(4);
    for (const l of await dlg.locator('.pp-note, .pp-year, .pp-rating, .place-privacy').all()) await expect(l).toBeHidden();
    await statusBtn(page, 'Not marked').click({ force: true });  // aria-disabled: clicks do nothing
    expect(await status(page, 'PER')).toBe(BEEN);
    await page.evaluate(() => window.Atlas.setInfo('PER', { note: '' }));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.AtlasPanel.open('PER'));
    await expect(dlg.locator('.pp-note-ro .place-ro')).toHaveText('No note.');
  });

  test('375 px: bottom sheet, 40 px targets, 16 px inputs', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await openApp(page);
    await mark(page, 'PER', BEEN);
    await chip(page, 'PER', 'Peru').click();
    const dlg = panel(page);
    await expect(dlg).toBeVisible();
    await page.waitForTimeout(300);                            // sheet animation
    const m = await dlg.evaluate(d => {
      const r = d.getBoundingClientRect();
      const box = el => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, label: el.getAttribute('aria-label') || el.textContent.trim() }; };
      const targets = [...d.querySelectorAll('.status-seg button, .stars .star, .stars .star-none, .dlg-head .x, .place-foot .btn')].map(box);
      const fonts = [...d.querySelectorAll('#pp-year, #pp-note')].map(e => parseFloat(getComputedStyle(e).fontSize));
      return { left: r.left, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, maxH: r.height, targets, fonts };
    });
    expect(m.left).toBeLessThanOrEqual(1);
    expect(m.right).toBeGreaterThanOrEqual(m.vw - 1);
    expect(Math.abs(m.bottom - m.vh)).toBeLessThanOrEqual(1);
    expect(m.maxH).toBeLessThanOrEqual(m.vh * 0.8 + 1);
    for (const t of m.targets) expect(Math.min(t.w, t.h), t.label).toBeGreaterThanOrEqual(40);
    for (const f of m.fonts) expect(f).toBeGreaterThanOrEqual(16);
    // no horizontal overflow inside the sheet
    expect(await dlg.evaluate(d => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
  });

  test('works from a <script defer> tag that runs before Atlas is ready', async ({ page }) => {
    // serve index.html with the tag the release adds (if it is not there already)
    await page.route(u => new URL(u).pathname === '/', async route => {
      const r = await route.fetch();
      let html = await r.text();
      if (!html.includes('places-panel.js')) html = html.replace('<script src="./js/app.js"></script>', '<script src="./js/app.js"></script>\n<script defer src="./js/places-panel.js"></script>');
      await route.fulfill({ response: r, body: html });
    });
    const errs = watchErrors(page);
    await page.goto('./');
    await page.waitForFunction(() => !!window.Atlas && !!window.AtlasPanel);
    await mark(page, 'PER', BEEN);
    await chip(page, 'PER', 'Peru').click();
    await expect(panel(page)).toBeVisible();
    await expect(page.locator('dialog.place-panel')).toHaveCount(1);
    expect(errs).toEqual([]);
  });
});
