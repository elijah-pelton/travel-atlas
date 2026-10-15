// Travel Atlas: "Want to go" (docs/plan-ux.md §2.1, §3, §4, §8 want.spec) and the window.Atlas seam (§7).
import { test, expect } from '@playwright/test';

// ---------- helpers ----------

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

async function openApp(page, url = './') {
  await page.goto(url);
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  // feature modules (<script defer>) finish wiring after the maps: wait so the layout is final
  await page.waitForFunction(() => window.Atlas && (!document.querySelector('script[src$="js/cities.js"]') || (window.AtlasCities && window.AtlasCities.ready)));
}

async function fresh(page) {
  await page.goto('./manifest.webmanifest');
  await page.evaluate(() => localStorage.clear());
  await openApp(page);
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

async function clickSel(page, sel) {
  const p = await hitPoint(page, sel);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
}
const clickPlace = (page, id) => clickSel(page, PLACE(id));

const status = (page, id) => page.evaluate(id => window.Atlas.getStatus(id), id);
const classesOf = (page, id) => page.evaluate(id => [...document.querySelectorAll(`svg.map [data-id="${id}"]`)].map(n => n.getAttribute('class')), id);
const wantMode = page => page.click('#frame-world .mark-seg button[data-mode="want"]');
const beenMode = page => page.click('#frame-world .mark-seg button[data-mode="been"]');
const toastMsg = (page, map = 'world') => page.locator(`#toast-${map} .toast-msg`);

// ---------- tests ----------

test('w1 the marking switch sits in both frames, starts on Been there, and both frames share it', async ({ page }) => {
  const errs = watchErrors(page);
  await fresh(page);
  for (const m of ['na', 'world']) {
    const seg = page.locator(`#frame-${m} .seg.mark-seg`);
    await expect(seg).toBeVisible();
    await expect(seg).toHaveAttribute('role', 'group');
    await expect(seg).toHaveAttribute('aria-label', 'What a tap marks');
    await expect(seg.locator('button')).toHaveText(['Been there', 'Want to go']);
    await expect(seg.locator('button[data-mode="been"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.locator('.sw.want')).toHaveCount(1);
  }
  expect(await page.evaluate(() => window.Atlas.mode)).toBe('been');
  await page.click('#frame-na .mark-seg button[data-mode="want"]');   // one switch drives both frames
  for (const m of ['na', 'world']) {
    await expect(page.locator(`#frame-${m} .mark-seg button[data-mode="want"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`#frame-${m}`)).toHaveClass(/\bmode-want\b/);
  }
  expect(await page.evaluate(() => window.Atlas.mode)).toBe('want');
  // the dashed frame outline is the Want-mode cue
  expect(await page.$eval('#frame-world', f => getComputedStyle(f).outlineStyle)).toBe('dashed');
  // keyboard reachable
  await page.focus('#frame-world .mark-seg button[data-mode="been"]');
  await page.keyboard.press('Enter');
  await expect(page.locator('#frame-world')).not.toHaveClass(/\bmode-want\b/);
  expect(errs, errs.join('\n')).toEqual([]);
});

test('w2 Want tap: striped fill + dashed outline, "+1 want to go", striped bar, outline chip, toast', async ({ page }) => {
  const errs = watchErrors(page);
  await fresh(page);
  await wantMode(page);
  await clickPlace(page, 'JPN');
  expect(await status(page, 'JPN')).toBe(2);
  await expect(toastMsg(page)).toHaveText('Japan: want to go');
  expect(await classesOf(page, 'JPN')).toEqual(['place want']);
  await page.waitForTimeout(300);                                       // app.css fill transition
  const paint = await page.$eval(PLACE('JPN'), n => ({ fill: getComputedStyle(n).fill, dash: getComputedStyle(n).strokeDasharray }));
  expect(paint.fill).toContain('url(');
  expect(paint.fill).toContain('want-world');
  expect(paint.dash).not.toBe('none');
  // counters: tile still counts been, plus a muted want line and a second bar segment
  const tile = page.locator('#stats-world .stat').first();
  await expect(tile.locator('.n')).toHaveText('0');
  await expect(tile.locator('.want-line')).toBeVisible();
  await expect(tile.locator('.want-line')).toHaveText('+1 want to go');
  expect(await tile.locator('.bar i.want').evaluate(i => i.getBoundingClientRect().width)).toBeGreaterThan(0);
  await expect(page.locator('#stats-world .stat').nth(1).locator('.want-line')).toBeHidden();
  // lists
  await expect(page.locator('#list-world .lead')).toHaveText(['Want to go (1):']);
  await expect(page.locator('#list-world .chip.want')).toHaveText(['Japan']);
  await expect(page.locator('#list-world .chip.want')).toHaveAttribute('aria-label', 'Japan, want to go. Open details.');
  expect(await page.$eval('#list-world .chip.want', c => getComputedStyle(c).borderTopStyle)).toBe('dashed');
  // small places and inset boxes: dot ring, dashed inset
  await page.click('#frame-na .mark-seg button[data-mode="want"]');
  await clickSel(page, 'svg.map[data-map="na"] rect.inset-bg[data-id="US-HI"]');
  expect((await classesOf(page, 'US-HI')).every(c => /\bwant\b/.test(c))).toBe(true);
  await clickSel(page, 'svg.map[data-map="world"] circle.dot[data-id="SGP"]');
  expect(await page.$eval('svg.map circle.dot[data-id="SGP"]', n => n.classList.contains('want') && !n.classList.contains('on'))).toBe(true);
  // stored as status 2
  const doc = await page.evaluate(() => JSON.parse(localStorage.getItem('travel-atlas:v2')));
  expect(doc.places.JPN[0]).toBe(2);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('travel-atlas:v1')))).toEqual({});   // :v1 mirrors been only
  expect(errs, errs.join('\n')).toEqual([]);
});

test('w3 tap rules: Been on want -> been; Want on been -> unchanged + "Already been"; Want on want clears', async ({ page }) => {
  await fresh(page);
  await wantMode(page);
  await clickPlace(page, 'PER');
  expect(await status(page, 'PER')).toBe(2);
  await beenMode(page);
  await clickPlace(page, 'PER');
  expect(await status(page, 'PER')).toBe(1);
  await expect(toastMsg(page)).toHaveText('Peru: been there (was on Want to go)');
  expect(await classesOf(page, 'PER')).toEqual(['place on']);
  await expect(page.locator('#list-world .lead')).toHaveText(['Been there (1):']);

  await wantMode(page);
  await clickPlace(page, 'PER');
  expect(await status(page, 'PER')).toBe(1);                            // no change
  await expect(toastMsg(page)).toHaveText('Already been to Peru');

  await clickPlace(page, 'CHL');
  await clickPlace(page, 'CHL');
  expect(await status(page, 'CHL')).toBe(0);
  await expect(toastMsg(page)).toHaveText('Chile: cleared');

  await beenMode(page);
  await clickPlace(page, 'PER');
  expect(await status(page, 'PER')).toBe(0);
  await expect(toastMsg(page)).toHaveText('Peru: cleared');
  // no em dashes in any toast
  expect(await page.locator('#toast-world').textContent()).not.toContain('—');
});

test('w4 reload resets the switch to Been there and keeps the marks', async ({ page }) => {
  await fresh(page);
  await wantMode(page);
  await clickPlace(page, 'ISL');
  await page.reload();
  await openApp(page);
  expect(await page.evaluate(() => window.Atlas.mode)).toBe('been');
  await expect(page.locator('#frame-world .mark-seg button[data-mode="been"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#frame-world')).not.toHaveClass(/\bmode-want\b/);
  expect(await status(page, 'ISL')).toBe(2);
  expect(await classesOf(page, 'ISL')).toEqual(['place want']);
});

test('w5 a drag in Want mode marks nothing', async ({ page }) => {
  await fresh(page);
  await wantMode(page);
  const p = await hitPoint(page, PLACE('BRA'));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + i * 6, p.y + 2);
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await status(page, 'BRA')).toBe(0);
  expect(await classesOf(page, 'BRA')).toEqual(['place']);
});

test('w6 search follows the switch and reads three states', async ({ page }) => {
  await fresh(page);
  const q = page.locator('#q');
  await wantMode(page);
  await q.fill('portugal');
  const opt = page.getByRole('option', { name: /^Portugal/ });
  await expect(opt).toHaveAttribute('aria-label', 'Portugal, Country · World, not marked');
  await q.press('Enter');
  expect(await status(page, 'PRT')).toBe(2);
  await expect(opt).toHaveAttribute('aria-label', 'Portugal, Country · World, want to go');
  await expect(opt).toHaveClass(/\bwant\b/);
  await expect(opt).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#results')).toBeVisible();                // the list stays open
  await beenMode(page);
  await q.click();                                                      // the switch click closed the list
  await opt.click();
  expect(await status(page, 'PRT')).toBe(1);
  await expect(opt).toHaveAttribute('aria-label', 'Portugal, Country · World, been there');
  await expect(opt).toHaveClass(/\bon\b/);
  await expect(opt).not.toHaveClass(/\bwant\b/);
  await expect(opt).toHaveAttribute('aria-checked', 'true');
});

test('w7 the stripe pattern keeps its on-screen size when zooming and follows the accent', async ({ page }) => {
  await fresh(page);
  const pat = () => page.$eval('#want-world', p => ({ w: +p.getAttribute('width'), lw: +p.querySelector('.want-line').getAttribute('stroke-width'), units: p.getAttribute('patternUnits'), tr: p.getAttribute('patternTransform') }));
  const a = await pat();
  expect(a).toMatchObject({ w: 6, lw: 2, units: 'userSpaceOnUse', tr: 'rotate(45)' });
  await page.click('.zoom[data-for="world"] [data-z="in"]');
  const k = await page.evaluate(() => window.Atlas.views.world.k);
  const b = await pat();
  expect(b.w).toBeCloseTo(6 / k, 2);
  expect(b.lw).toBeCloseTo(2 / k, 2);
  expect(await page.$eval('#want-na', p => +p.getAttribute('width'))).toBe(6);   // per map
  const stripe = () => page.$eval('#want-world .want-line', l => getComputedStyle(l).stroke);
  const amber = await stripe();
  await page.click('#accent-btn');
  await page.click('#accent-pop [data-accent="teal"]');
  expect(await stripe()).not.toBe(amber);
});

test.describe('without the details panel', () => {
  test.use({ serviceWorkers: 'block' });
  test.beforeEach(async ({ page }) => {
    // no js/places-panel.js here, so nobody listens to 'details' until the test does
    await page.route('**/js/places-panel.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  });
test('w8 the toast\'s Details button and chips emit "details"; without a listener there is no Details button', async ({ page }) => {
  await fresh(page);
  await clickPlace(page, 'MEX');
  await expect(toastMsg(page)).toHaveText('Mexico: been there');
  await expect(page.locator('#toast-world .toast-act')).toHaveCount(0);
  // a chip click with nobody listening is harmless
  await page.click('#list-world .chip[data-id="MEX"]');
  expect(await status(page, 'MEX')).toBe(1);

  await page.evaluate(() => { window.__details = []; window.Atlas.on('details', d => window.__details.push({ id: d.id, map: d.map, opener: d.opener && d.opener.className, readonly: d.readonly })); });
  await clickPlace(page, 'CAN');
  const act = page.locator('#toast-world .toast-act');
  await expect(act).toHaveText('Details');
  await expect(act).toBeVisible();
  await act.click();
  await page.click('#list-world .chip[data-id="MEX"]');
  await wantMode(page);
  await clickPlace(page, 'MEX');                                        // "Already been" also offers Details
  await expect(toastMsg(page)).toHaveText('Already been to Mexico');
  await page.locator('#toast-world .toast-act').click();
  expect(await page.evaluate(() => window.__details)).toEqual([
    { id: 'CAN', map: 'world', opener: 'toast-act', readonly: false },
    { id: 'MEX', map: 'world', opener: 'chip', readonly: false },
    { id: 'MEX', map: 'world', opener: 'toast-act', readonly: false },
  ]);
  // the Details button leaves the tab order once the toast is gone
  await beenMode(page);
  await clickPlace(page, 'ARG');
  await expect(page.locator('#toast-world .toast-act')).toBeVisible();
  await page.waitForTimeout(4600);
  await expect(page.locator('#toast-world')).not.toHaveClass(/\bshow\b/);
  await expect(page.locator('#toast-world .toast-act')).toBeHidden();
});

});

test('w9 seam: Atlas API shape, setStatus/getInfo, hooks, layers, styles, legends, search sources', async ({ page }) => {
  const errs = watchErrors(page);
  await fresh(page);
  const shape = await page.evaluate(() => {
    const A = window.Atlas;
    const fns = ['getStatus', 'setStatus', 'tap', 'ids', 'getInfo', 'setInfo', 'ownerName', 'setMode', 'setStyle', 'on', 'off', 'emit', 'toast', 'openDetails', 'flash', 'tip', 'hideTip', 'addSearchSource', 'norm', 'addLayer', 'onTap', 'addStyle', 'addLegend', 'link', 'notesLink'];
    return {
      missing: fns.filter(f => typeof A[f] !== 'function'),
      maps: A.places instanceof Map && A.nodes instanceof Map,
      views: ['na', 'world'].map(m => { const v = A.views[m]; return [typeof v.k, Array.isArray(v.onView), Array.isArray(v.onTap), typeof v.vb.w, !!v.svg]; }),
      mode: A.mode, viewMode: A.viewMode, style: A.style, ready: A.ready instanceof Promise,
    };
  });
  expect(shape).toEqual({ missing: [], maps: true, views: [['number', true, true, 'number', true], ['number', true, true, 'number', true]], mode: 'been', viewMode: 'own', style: 'flat', ready: true });

  // setStatus takes numbers or names, toasts unless quiet; getInfo/setInfo go to the store notes
  const r = await page.evaluate(() => {
    const A = window.Atlas, ev = [];
    A.on('change', e => ev.push(e.ids && e.ids.join(',')));
    const out = [A.setStatus('ESP', 'want', { quiet: true }), A.getStatus('ESP'), A.setStatus('ESP', 'want'), A.setStatus('ESP', 1), A.getStatus('ESP')];
    out.push(A.setInfo('ESP', { rating: 4, year: 2020, note: 'Tapas' }), A.getInfo('ESP'), A.ids(1), A.ids(2));
    let bad = null; try { A.setInfo('ESP', { rating: 9 }); } catch (e) { bad = e.name; }
    out.push(bad, ev);
    return out;
  });
  expect(r).toEqual([true, 2, false, true, 1, true, { rating: 4, year: 2020, note: 'Tapas' }, ['ESP'], [], 'RangeError', ['ESP', 'ESP', 'ESP']]);
  await expect(toastMsg(page)).toHaveText('Spain: been there (was on Want to go)');
  await expect(page.locator('#list-world .chip[data-id="ESP"] .ci-rate')).toHaveText('★4');
  await expect(page.locator('#list-world .chip[data-id="ESP"]')).toHaveAttribute('aria-label', 'Spain, been there, rated 4, has a note. Open details.');

  // onTap interceptor: returning true skips the place toggle; onView runs on every view update
  await page.evaluate(() => {
    window.__taps = 0; window.__views = 0;
    window.Atlas.views.world.onTap.push(() => { window.__taps++; return true; });
    window.Atlas.views.world.onView.push(() => { window.__views++; });
  });
  await clickPlace(page, 'EGY');
  expect(await status(page, 'EGY')).toBe(0);
  expect(await page.evaluate(() => window.__taps)).toBe(1);
  await page.click('.zoom[data-for="world"] [data-z="in"]');
  expect(await page.evaluate(() => window.__views)).toBeGreaterThan(0);
  await page.evaluate(() => { window.Atlas.views.world.onTap.length = 0; });

  // addLayer: a <g> right after the dots, plus an onView hook
  const layer = await page.evaluate(() => {
    let calls = 0;
    const g = window.Atlas.addLayer('world', (vb, k) => { calls++; window.__lk = k; });
    window.Atlas.views.world.set(0, 0, 500);
    return { tag: g.tagName, prev: g.previousElementSibling.getAttribute('class'), cls: g.getAttribute('class'), calls, k: window.__lk };
  });
  expect(layer).toEqual({ tag: 'g', prev: 'dots', cls: 'layer', calls: 1, k: 2 });

  // addStyle / setStyle / style event; addLegend
  const st = await page.evaluate(() => {
    const A = window.Atlas, seen = [];
    A.on('style', e => seen.push(e.style));
    const b = A.addStyle({ id: 'demo', label: 'Demo' });
    b.click();
    const pressed = b.getAttribute('aria-pressed');
    A.setStyle('flat');
    const lg = document.createElement('div'); lg.className = 'legend extra-legend';
    const hint = document.createElement('p'); hint.className = 'extra-hint';
    const span = document.createElement('span'); span.className = 'extra-item'; span.textContent = 'Extra';
    A.addLegend('world', lg, hint); A.addLegend('na', span);
    return { seen, pressed, style: A.style, stored: localStorage.getItem('travel-atlas:style'),
      lgAfter: lg.previousElementSibling.id, hintAfter: hint.previousElementSibling === lg, span: span.parentElement.id };
  });
  expect(st).toEqual({ seen: ['demo', 'flat'], pressed: 'true', style: 'flat', stored: 'demo', lgAfter: 'legend-world', hintAfter: true, span: 'legend-na' });

  // addSearchSource: extra rows after places, own pick()
  await page.evaluate(() => {
    window.__picked = null;
    window.Atlas.addSearchSource(raw => (/kyo/i.test(raw) ? [{ id: 'C-1', name: 'Kyoto', where: 'City · Japan', label: 'Kyoto, city in Japan', pick: () => { window.__picked = 'C-1'; } }] : []));
  });
  await page.fill('#q', 'kyo');
  const row = page.getByRole('option', { name: /^Kyoto/ });
  await expect(row).toHaveAttribute('aria-label', 'Kyoto, city in Japan, not marked');
  await expect(row.locator('.where')).toHaveText('City · Japan');
  await row.click();
  expect(await page.evaluate(() => window.__picked)).toBe('C-1');
  expect(errs, errs.join('\n')).toEqual([]);
});

test('w10 at 375 px the switch fits inside the frame next to the zoom buttons, with 40 px targets', async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({ baseURL: appRoot(testInfo), viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await openApp(page);
  for (const m of ['na', 'world']) {
    const frame = await page.locator(`#frame-${m}`).boundingBox();
    const seg = await page.locator(`#frame-${m} .mark-seg`).boundingBox();
    const zoom = await page.locator(`.zoom[data-for="${m}"]`).boundingBox();
    expect(seg.x).toBeGreaterThanOrEqual(frame.x);
    expect(seg.x + seg.width).toBeLessThan(zoom.x);
    for (const b of await page.locator(`#frame-${m} .mark-seg button`).all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(40);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await ctx.close();
});
