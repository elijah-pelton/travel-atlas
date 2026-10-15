// Travel Atlas: cities layer, city search, counters and lists (js/cities.js; docs/plan-cities.md §6-§8,
// §12 C4/C5; docs/plan-ux.md §2.5, §8 cities.spec).
// Part 1 is Node-only (pure functions on the real data/cities.json). Part 2 drives the app in Chromium
// against a local `wrangler dev` (BASE_URL=http://127.0.0.1:8801/ npx playwright test cities.spec.mjs).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'js', 'cities.js'), 'utf8');
const DATA = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'cities.json'), 'utf8'));

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'self', SRC)(mod, undefined);
  return mod.exports;
}
const M = loadModule();
const W = 1000, H = 487;
const vbAt = (k, cx, cy) => { const w = W / k, h = w * H / W; return { x: cx - w / 2, y: cy - h / 2, w, h }; };
const KYOTO = 'C-1159149967', KYIV = 'C-1159151495', TOKYO = 'C-1159151609';

// ======================================================================================
// Part 1: pure
// ======================================================================================
test.describe('pure', () => {
  const C = M.parse(DATA);
  const idx = id => C.byId.get(id);

  test('p1 parse: 3,309 rows, C- ids, admin-1 names, capitals per country', () => {
    expect(C.n).toBe(DATA.c.length);
    expect(C.n).toBe(3309);
    expect(C.id[idx(KYOTO)]).toBe(KYOTO);
    expect(C.name[idx(KYOTO)]).toBe('Kyoto');
    expect(C.cc[idx(KYOTO)]).toBe('JPN');
    expect(new Set(C.id).size).toBe(C.n);
    expect(M.capitalTotal(C)).toBeGreaterThan(190);
  });

  test('p2 norm folds accents and the extra letters', () => {
    expect(M.norm('São Paulo')).toBe('sao paulo');
    expect(M.norm('Straße')).toBe('strasse');
    expect(M.norm('Tromsø')).toBe('tromso');
    expect(M.norm('Ærø')).toBe('aero');
    expect(M.norm('Łódź')).toBe('lodz');
    expect(M.norm('Đà Nẵng')).toBe('da nang');
    expect(M.norm('Diyarbakır')).toBe('diyarbakir');
    expect(M.norm("St. Louis")).toBe('st louis');
    expect(M.norm("T'Bilisi")).toBe('tbilisi');
  });

  test('p3 tier rule: z <= k * frameWidth / 360, marked always, cap 600', () => {
    const marked = [idx(KYOTO)];                 // z = 10: only a marked Kyoto shows at low zoom
    for (const [fw, k] of [[343, 1], [343, 3], [343, 10], [1200, 1], [1200, 3], [1200, 10]]) {
      const vb = vbAt(k, 500, 243.5);
      const out = M.select(C, vb, fw / vb.w, W, [], 600, 1);
      expect(out.length, `fw ${fw} k ${k}`).toBeLessThanOrEqual(600);
      const thr = k * fw / 360;
      for (const i of out) expect(C.z[i]).toBeLessThanOrEqual(thr + 1e-6);
    }
    const vb1 = vbAt(1, 500, 243.5);
    const withK = M.select(C, vb1, 1200 / vb1.w, W, marked, 600, 1);
    expect(withK).toContain(idx(KYOTO));
    expect(withK[0]).toBe(idx(KYOTO));          // marked go first so the cap never drops them
    // tier cap 400, marked fill up to 600
    const many = Array.from({ length: 300 }, (_, j) => j * 11);
    const capped = M.select(C, vb1, 1200 / vb1.w, W, many, 600, 1, 400);
    expect(capped.length).toBeLessThanOrEqual(600);
    for (const i of many) if (C.x[i] >= vb1.x && C.x[i] <= vb1.x + vb1.w) expect(capped).toContain(i);
    // below the minimum zoom only marked cities show
    expect(M.select(C, vb1, 1200 / vb1.w, W, marked, 600, M.TIER_MIN_K)).toEqual([idx(KYOTO)]);
    // culling: a view over Japan has no Brazilian city
    const jp = vbAt(10, 845, 115);
    const out = M.select(C, jp, 1200 / jp.w, W, [], 600, M.TIER_MIN_K);
    expect(out.some(i => C.cc[i] === 'BRA')).toBe(false);
    expect(out.includes(idx(KYOTO))).toBe(true);
    // view + 5% margin only
    for (const i of out) { expect(C.x[i]).toBeGreaterThanOrEqual(jp.x - jp.w * 0.05 - 1e-3); expect(C.x[i]).toBeLessThanOrEqual(jp.x + jp.w * 1.05 + 1e-3); }
  });

  test('p4 Europe at max zoom stays under ~400 nodes (desktop and phone)', () => {
    for (const [cx, cy] of [[525, 75], [505, 85], [545, 70], [560, 95]]) {
      const vb = vbAt(10, cx, cy);
      const raw = M.select(C, vb, 1180 / vb.w, W, [], 600, M.TIER_MIN_K).length;
      const desk = M.select(C, vb, 1180 / vb.w, W, [], 600, M.TIER_MIN_K, M.TIER_CAP).length;
      const phone = M.select(C, vb, 343 / vb.w, W, [], 600, M.TIER_MIN_K, M.TIER_CAP).length;
      console.log(`[cities] Europe k=10 at (${cx},${cy}): desktop ${desk} (uncapped ${raw}), phone ${phone}`);
      expect(desk).toBeLessThanOrEqual(400);
      expect(phone).toBeLessThanOrEqual(400);
    }
  });

  test('p5 nearest grid: within 12 px nearest wins, beyond 12 px nothing', () => {
    const pts = [{ i: 1, sx: 100, sy: 100 }, { i: 2, sx: 110, sy: 100 }, { i: 3, sx: 300, sy: 40 }, { i: 4, sx: 31, sy: 31 }, { i: 5, sx: 33, sy: 33 }];
    const g = M.buildGrid(pts, 32);
    expect(M.nearest(g, 104, 100, 12).i).toBe(1);
    expect(M.nearest(g, 106, 100, 12).i).toBe(2);
    expect(M.nearest(g, 300, 51.9, 12).i).toBe(3);
    expect(M.nearest(g, 300, 52.5, 12)).toBe(null);
    expect(M.nearest(g, 200, 200, 12)).toBe(null);
    expect(M.nearest(g, 34, 34, 12).i).toBe(5);  // across a cell border
    expect(M.nearest(g, 30, 30, 12).i).toBe(4);
    // agrees with brute force on random points
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const many = Array.from({ length: 600 }, (_, i) => ({ i, sx: rnd() * 1200, sy: rnd() * 600 }));
    const g2 = M.buildGrid(many, 32);
    for (let t = 0; t < 500; t++) {
      const x = rnd() * 1200, y = rnd() * 600;
      let best = null, bd = 144;
      for (const p of many) { const d = (p.sx - x) ** 2 + (p.sy - y) ** 2; if (d <= bd) { bd = d; best = p; } }
      const got = M.nearest(g2, x, y, 12);
      expect(got && got.i, `probe ${t}`).toBe(best && best.i);
    }
  });

  test('p6 labels: no overlaps, inside the frame, capped 40/80', () => {
    const vb = vbAt(4, 525, 80), s = 1200 / vb.w;
    const vis = M.select(C, vb, s, W, [], 600, M.TIER_MIN_K);
    const items = vis.map(i => ({ i, sx: (C.x[i] - vb.x) * s, sy: (C.y[i] - vb.y) * s, r: 2.4, len: C.name[i].length }));
    for (const max of [40, 80]) {
      const placed = M.placeLabels(items, items, 10.5, max, 1200, 584);
      expect(placed.length).toBeLessThanOrEqual(max);
      expect(placed.length).toBeGreaterThan(10);
      const boxes = placed.map(it => ({ x0: it.sx + it.r + 2, x1: it.sx + it.r + 2 + it.len * 10.5 * 0.56, y0: it.sy - 6.6, y1: it.sy + 6.6 }));
      for (let a = 0; a < boxes.length; a++) {
        const b = boxes[a];
        expect(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 1200 && b.y1 <= 584).toBe(true);
        for (let c = a + 1; c < boxes.length; c++) {
          const o = boxes[c];
          expect(o.x0 < b.x1 && o.x1 > b.x0 && o.y0 < b.y1 && o.y1 > b.y0, `${C.name[placed[a].i]} vs ${C.name[placed[c].i]}`).toBe(false);
        }
      }
    }
  });

  test('p7 search: sao paulo, kiev -> Kyiv, springfield in 2+ states, georgia has no city, < 2 ms', () => {
    const names = q => M.search(C, q).map(h => C.name[h.i]);
    expect(names('sao paulo')[0]).toBe('São Paulo');
    const kiev = M.search(C, 'kiev');
    expect(C.id[kiev[0].i]).toBe(KYIV);
    expect(kiev[0].alias).toBe('Kiev');
    const sp = M.search(C, 'springfield').filter(h => C.name[h.i] === 'Springfield');
    expect(new Set(sp.map(h => C.adm[h.i])).size).toBeGreaterThanOrEqual(2);
    expect(M.whereText(C, sp[0].i, 'United States')).toMatch(/^[A-Z][a-z]+, United States$/);
    expect(M.whereText(C, idx(KYOTO), 'Japan')).toBe('Japan');
    // ranking: exact before prefix before word-prefix before substring; ties by rank (population)
    const lon = M.search(C, 'london');
    expect(C.name[lon[0].i]).toBe('London');
    expect(lon[0].cls).toBe(0);
    for (let j = 1; j < lon.length; j++) expect(lon[j].cls >= lon[j - 1].cls).toBe(true);
    expect(M.search(C, 'tok').map(h => C.id[h.i])[0]).toBe(TOKYO);
    expect(names('munchen')).toContain('Munich');
    expect(names('zurich')).toContain('Zürich');
    expect(M.search(C, 'georgia').every(h => C.cc[h.i] !== 'GEO' || C.name[h.i] !== 'Georgia')).toBe(true);
    expect(M.matchClass('Georgia', 'georgia')).toBe(0);
    // speed
    const t0 = performance.now();
    for (const q of ['s', 'sa', 'sao', 'sao ', 'sao p', 'sao pa', 'sao pau', 'sao paul', 'sao paulo', 'k', 'ky', 'kyo']) M.search(C, q);
    const per = (performance.now() - t0) / 12;
    console.log(`[cities] search ${per.toFixed(2)} ms per keystroke (Node)`);
    expect(per).toBeLessThan(2);
  });

  test('p8 tally: cities, countries, distinct capital countries', () => {
    const been = [idx(KYOTO), idx(TOKYO), idx(KYIV)];
    const t = M.tally(C, been, [idx('C-1159151621')]);
    expect(t).toEqual({ been: 3, want: 1, countries: 2, capitals: 2 });
  });
});

// ======================================================================================
// Part 2: in the app
// ======================================================================================
const CITY_RE = /\/data\/cities\.json/;

async function openApp(page, url = './') {
  await page.goto(url);
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  await page.waitForFunction(() => window.Atlas && window.Atlas.views && window.Atlas.views.world, null, { timeout: 20_000 });
  const tagged = await page.evaluate(() => !!document.querySelector('script[src$="js/cities.js"]'));
  if (!tagged && !(await page.evaluate(() => !!window.AtlasCities))) await page.addScriptTag({ url: './js/cities.js' });
  await page.waitForFunction(() => window.AtlasCities && window.AtlasCities.ready, null, { timeout: 10_000 });
}
// set the world view (map units) through the core; returns once cities rendered
async function setView(page, k, cx, cy) {
  await page.evaluate(([k, cx, cy]) => {
    const v = window.Atlas.views.world, w = v.W / k, h = w * v.H / v.W;
    v.set(cx - w / 2, cy - h / 2, w);
  }, [k, cx, cy]);
}
async function loadCities(page) {
  await page.evaluate(() => window.AtlasCities.load());
  await page.waitForFunction(() => window.AtlasCities.loaded);
}
const status = (page, id) => page.evaluate(id => { const s = window.Atlas.getStatus(id); return typeof s === 'number' ? s : ({ been: 1, want: 2 }[s] || 0); }, id);
const domCount = page => page.evaluate(() => document.querySelectorAll('svg.map[data-map="world"] g.cities circle.city').length);
async function scrollToWorld(page) {
  await page.evaluate(() => document.getElementById('frame-world').scrollIntoView({ block: 'center' }));
}

test.describe('app', () => {
  test('a1 no city request before zoom or search; zoom k>=2 loads them', async ({ page }) => {
    const reqs = [];
    page.on('request', r => { if (CITY_RE.test(r.url())) reqs.push(r.url()); });
    await openApp(page);
    await scrollToWorld(page);
    await page.waitForTimeout(800);
    // a country tap and a small zoom (k < 2) don't load cities
    const box = await page.locator('#frame-world svg.map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.53, box.y + box.height * 0.3);
    await page.click('.zoom[data-for="world"] [data-z="in"]');         // k = 1.7
    await page.waitForTimeout(500);
    expect(reqs, 'no cities.json yet').toEqual([]);
    expect(await page.evaluate(() => window.AtlasCities.loaded)).toBe(false);
    await page.click('.zoom[data-for="world"] [data-z="in"]');         // k = 2.89
    await page.waitForFunction(() => window.AtlasCities.loaded);
    expect(reqs.length).toBe(1);
    expect(await domCount(page)).toBeGreaterThan(0);
    const st = await page.evaluate(() => window.AtlasCities.stats);
    console.log(`[cities] first load: parse ${st.parseMs.toFixed(1)} ms, build ${st.buildMs.toFixed(1)} ms`);
  });

  test('a2 search focus loads cities', async ({ page }) => {
    const reqs = [];
    page.on('request', r => { if (CITY_RE.test(r.url())) reqs.push(r.url()); });
    await openApp(page);
    await page.waitForTimeout(500);
    expect(reqs).toEqual([]);
    await page.focus('#q');
    await page.waitForFunction(() => window.AtlasCities.loaded);
    expect(reqs.length).toBe(1);
  });

  test('a3 node counts <= 600 at k = 1, 3, 10; Europe at k = 10 <= 400', async ({ page }) => {
    await openApp(page);
    await loadCities(page);
    for (const k of [1, 3, 10]) {
      await setView(page, k, 500, 243);
      const n = await domCount(page);
      expect(n, `k=${k}`).toBeLessThanOrEqual(600);
      expect(n).toBe(await page.evaluate(() => window.AtlasCities.count()));
      console.log(`[cities] desktop k=${k}: ${n} nodes`);
    }
    await setView(page, 10, 525, 75);
    const eu = await domCount(page);
    console.log(`[cities] desktop Europe k=10: ${eu} nodes, ${await page.evaluate(() => window.AtlasCities.labels())} labels`);
    expect(eu).toBeLessThanOrEqual(400);
    expect(await page.evaluate(() => window.AtlasCities.labels())).toBeLessThanOrEqual(80);
  });

  test('a4 a marked city shows at k = 1 (and an unmarked z=10 one does not)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(id => window.Atlas.setStatus(id, 1, { quiet: true }), KYOTO);
    await page.reload();
    await openApp(page);
    // the store holds a city mark, so the data loads at once for the counters, lists and the dot
    await page.waitForFunction(() => window.AtlasCities.loaded);
    const k = await page.evaluate(() => window.Atlas.views.world.k);
    expect(k).toBeLessThan(1.01);
    await expect(page.locator(`svg.map[data-map="world"] circle.city[data-id="${KYOTO}"]`)).toHaveClass(/\bon\b/);
    expect(await page.locator('svg.map[data-map="world"] circle.city[data-id="C-1159149741"]').count()).toBe(0);  // Osaka, unmarked
  });

  test('a5 tap within 12 px marks the nearest city; Kyoto marks Japan, clearing Kyoto keeps Japan', async ({ page }) => {
    await openApp(page);
    await loadCities(page);
    await scrollToWorld(page);
    await setView(page, 10, 844, 116.6);
    const p = await page.evaluate(id => window.AtlasCities.screenOf(id), KYOTO);
    // pick an offset (<= 10 px) where Kyoto is the nearest visible city
    let tap = null;
    for (const [dx, dy] of [[0, -9], [0, -6], [6, -6], [-6, -6], [0, 0]]) {
      const id = await page.evaluate(([x, y]) => window.AtlasCities.hit(x, y), [p.x + dx, p.y + dy]);
      if (id === KYOTO) { tap = { x: p.x + dx, y: p.y + dy, d: Math.hypot(dx, dy) }; break; }
    }
    expect(tap, 'an offset where Kyoto is nearest').not.toBe(null);
    expect(await status(page, 'JPN')).toBe(0);
    await page.mouse.click(tap.x, tap.y);
    expect(await status(page, KYOTO)).toBe(1);
    expect(await status(page, 'JPN')).toBe(1);
    await expect(page.locator('#toast-world')).toContainText('Kyoto and Japan: been there');
    await expect(page.locator(`circle.city[data-id="${KYOTO}"]`)).toHaveClass(/\bon\b/);
    // tile + capitals line + list
    const tile = page.locator('#stats-world .stat.city-stat');
    await expect(tile.locator('.n')).toHaveText('1');
    await expect(tile).toContainText('in 1 country');
    await expect(tile).toContainText(/Capitals 0 \/ \d+/);
    const list = page.locator('#list-cities');
    await expect(list).toContainText('Cities (1):');
    await expect(list.locator('.city-group .grp')).toHaveText('Japan:');
    await expect(list.locator('button.chip')).toHaveText(/Kyoto/);
    // tap again: Kyoto cleared, Japan kept
    await page.waitForTimeout(400);
    await page.mouse.click(tap.x, tap.y);
    expect(await status(page, KYOTO)).toBe(0);
    expect(await status(page, 'JPN')).toBe(1);
    await expect(page.locator('#toast-world')).toContainText('Kyoto: cleared');
    await expect(list).toBeHidden();
    // a tap > 12 px from every visible city goes to the country as before
    await setView(page, 3, 560, 160);
    const far = await page.evaluate(() => {
      const r = window.Atlas.views.world.svg.getBoundingClientRect();
      for (let y = r.top + 40; y < r.bottom - 40; y += 9) for (let x = r.left + 40; x < r.right - 40; x += 9) {
        if (window.AtlasCities.hit(x, y)) continue;
        const el = document.elementFromPoint(x, y);
        if (el && el.classList.contains('place') && el.dataset.id && el.dataset.id !== 'JPN') return { x, y, id: el.dataset.id };
      }
      return null;
    });
    expect(far).not.toBe(null);
    const before = await status(page, far.id);
    await page.mouse.click(far.x, far.y);
    expect(await status(page, far.id)).not.toBe(before);
  });

  test('a6 Want mode on a city; Been on a want city; Want on a been city is blocked', async ({ page }) => {
    await openApp(page);
    await loadCities(page);
    await scrollToWorld(page);
    await setView(page, 10, 844, 116.6);
    const want = page.locator('#frame-world .mark-seg button[data-mode="want"]');
    const been = page.locator('#frame-world .mark-seg button[data-mode="been"]');
    if (!(await want.count())) test.skip(true, 'marking switch not in the page yet');
    // clicking the switch may scroll the page: always re-read Kyoto's screen position
    const tapKyoto = async () => { const p = await page.evaluate(id => window.AtlasCities.screenOf(id), KYOTO); await page.mouse.click(p.x, p.y); };
    await want.click();
    await tapKyoto();
    expect(await status(page, KYOTO)).toBe(2);
    expect(await status(page, 'JPN')).toBe(0);                           // want never marks the country
    await expect(page.locator(`circle.city[data-id="${KYOTO}"]`)).toHaveClass(/\bwant\b/);
    await expect(page.locator('#list-cities button.chip.want')).toHaveText(/Kyoto/);
    await been.click();
    await page.waitForTimeout(400);
    await tapKyoto();
    expect(await status(page, KYOTO)).toBe(1);
    await expect(page.locator('#toast-world')).toContainText('Kyoto and Japan: been there');
    await want.click();
    await page.waitForTimeout(400);
    await tapKyoto();
    expect(await status(page, KYOTO)).toBe(1);
    await expect(page.locator('#toast-world')).toContainText('Already been to Kyoto');
  });

  test('a7 dragging over a city does not toggle it', async ({ page }) => {
    await openApp(page);
    await loadCities(page);
    await scrollToWorld(page);
    await setView(page, 10, 844, 116.6);
    const p = await page.evaluate(id => window.AtlasCities.screenOf(id), KYOTO);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(p.x + i * 6, p.y + i * 2);
    await page.mouse.up();
    expect(await status(page, KYOTO)).toBe(0);
    expect(await status(page, 'JPN')).toBe(0);
  });

  test('a8 hover shows the city tooltip', async ({ page }) => {
    await openApp(page);
    await loadCities(page);
    await scrollToWorld(page);
    await setView(page, 10, 844, 116.6);
    const p = await page.evaluate(id => window.AtlasCities.screenOf(id), KYOTO);
    await page.mouse.move(p.x - 30, p.y - 30);
    await page.mouse.move(p.x, p.y - 2);
    await expect(page.locator('#tip')).toHaveClass(/\bshow\b/);
    await expect(page.locator('#tip')).toContainText('Kyoto');
  });

  test('a9 search: sao paulo, kiev -> Kyiv, springfield >= 2 states, georgia country first; pick centers at k >= 4', async ({ page }) => {
    await openApp(page);
    await page.focus('#q');
    await page.waitForFunction(() => window.AtlasCities.loaded);
    const rows = page.locator('#results li[data-id]');
    await page.fill('#q', 'sao paulo');
    await expect(rows.first()).toContainText('São Paulo');
    await page.fill('#q', 'kiev');
    await expect(page.locator(`#results li[data-id="${KYIV}"]`)).toContainText('Kyiv');
    await expect(page.locator(`#results li[data-id="${KYIV}"]`)).toContainText('Kiev');
    await page.fill('#q', 'springfield');
    await expect(rows.first()).toBeVisible();
    const where = await page.locator('#results li[data-id^="C-"]').allTextContents();
    const states = new Set(where.map(t => (t.match(/(Illinois|Missouri|Massachusetts|Ohio|Oregon)/) || [])[1]).filter(Boolean));
    expect(states.size, where.join(' | ')).toBeGreaterThanOrEqual(2);
    await page.fill('#q', 'georgia');
    await expect(page.locator('#results li[data-id="GEO"]')).toBeVisible();
    // places (the country Georgia, the U.S. state) come before any city row
    const order = await rows.evaluateAll(lis => lis.map(li => li.dataset.id));
    const firstCity = order.findIndex(id => /^C-/.test(id));
    expect(order.indexOf('GEO')).toBeGreaterThanOrEqual(0);
    if (firstCity >= 0) expect(order.indexOf('GEO')).toBeLessThan(firstCity);
    expect(/^C-/.test(order[0])).toBe(false);
    // picking a city marks it and centers the world map at k >= 4
    await page.fill('#q', 'kyoto');
    const li = page.locator(`#results li[data-id="${KYOTO}"]`);
    await expect(li).toBeVisible();
    await li.click();
    expect(await status(page, KYOTO)).toBe(1);
    expect(await status(page, 'JPN')).toBe(1);
    const k = await page.evaluate(() => window.Atlas.views.world.k);
    expect(k).toBeGreaterThanOrEqual(4 - 1e-6);
    const c = await page.evaluate(id => { const p = window.AtlasCities.screenOf(id), r = window.Atlas.views.world.svg.getBoundingClientRect(); return { dx: p.x - (r.left + r.width / 2), dy: p.y - (r.top + r.height / 2) }; }, KYOTO);
    expect(Math.abs(c.dx)).toBeLessThan(4);
    expect(Math.abs(c.dy)).toBeLessThan(4);
    await expect(page.locator(`svg.map[data-map="world"] circle.city[data-id="${KYOTO}"]`)).toHaveClass(/\bon\b/);
  });

  test('a10 offline after one visit still shows cities', async ({ page, context }) => {
    await openApp(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await openApp(page); }
    const precached = await page.evaluate(async () => {
      for (const k of await caches.keys()) { const c = await caches.open(k); if (await c.match('./data/cities.json')) return true; }
      return false;
    });
    expect(precached, 'cities.json in the SW cache (tools/asset-list.json + sw.js, core agent)').toBe(true);
    // offline in this page (script already here): the data comes from the SW cache
    await context.setOffline(true);
    await setView(page, 3, 525, 80);
    await page.waitForFunction(() => window.AtlasCities.loaded, null, { timeout: 10_000 });
    expect(await domCount(page)).toBeGreaterThan(10);
    await context.setOffline(false);
    const tagged = await page.evaluate(async () => /<script[^>]+js\/cities\.js/.test(await (await fetch('./index.html')).text()));
    test.skip(!tagged, 'index.html has no <script defer src="./js/cities.js"> yet, so the SW cannot serve the script offline');
    await context.setOffline(true);
    await page.reload();
    await openApp(page);
    await setView(page, 3, 525, 80);
    await page.waitForFunction(() => window.AtlasCities.loaded, null, { timeout: 10_000 });
    expect(await domCount(page)).toBeGreaterThan(10);
    await context.setOffline(false);
  });

  test('a11 offline without the data: search says "Cities need one online visit first."', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await openApp(page);
    await context.route(CITY_RE, r => r.abort('internetdisconnected'));
    await page.focus('#q');
    await page.waitForFunction(() => window.AtlasCities.failed);
    await page.fill('#q', 'kyoto');
    await expect(page.locator('#results')).toContainText('Cities need one online visit first.');
    await context.close();
  });

  test('a12 pan frame budget with 4x CPU throttle (reported)', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openApp(page);
    await loadCities(page);
    await scrollToWorld(page);
    const cdp = await page.context().newCDPSession(page);
    const runs = {};
    for (const [label, k, cx, cy] of [['europe-k4', 4, 525, 80], ['europe-k10', 10, 525, 75], ['world-k2', 2, 500, 200]]) {
      await setView(page, k, cx, cy);
      await page.waitForTimeout(300);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.evaluate(() => {
        const s = window.AtlasCities.stats; s.ms.length = 0; s.labelMs.length = 0;
        window.__frames = []; let last = performance.now();
        window.__raf = true;
        const tick = t => { window.__frames.push(t - last); last = t; if (window.__raf) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      const box = await page.locator('#frame-world svg.map').boundingBox();
      const x0 = box.x + box.width * 0.7, y0 = box.y + box.height * 0.5;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 60; i++) await page.mouse.move(x0 - i * 8, y0 + Math.sin(i / 6) * 20);
      await page.mouse.up();
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        window.__raf = false;
        const q = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
        const s = window.AtlasCities.stats, f = window.__frames.slice(2);
        return { updates: s.ms.length, updP50: q(s.ms, 0.5), updP95: q(s.ms, 0.95), updMax: Math.max(0, ...s.ms), labelMax: Math.max(0, ...s.labelMs), frameP50: q(f, 0.5), frameP95: q(f, 0.95), nodes: window.AtlasCities.count(), labels: window.AtlasCities.labels() };
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      runs[label] = r;
      const line = `[cities perf 4x] ${label}: ${r.nodes} nodes, ${r.labels} labels; cities update p50 ${r.updP50.toFixed(2)} ms, p95 ${r.updP95.toFixed(2)} ms, max ${r.updMax.toFixed(2)} ms (${r.updates} updates); label relayout max ${r.labelMax.toFixed(2)} ms; rAF frame p50 ${r.frameP50.toFixed(1)} ms, p95 ${r.frameP95.toFixed(1)} ms`;
      console.log(line);
      testInfo.annotations.push({ type: 'perf', description: line });
      if (r.updP95 > 4) console.warn(`[cities perf] WARN ${label}: update p95 ${r.updP95.toFixed(2)} ms > 4 ms budget`);
      if (r.frameP95 > 16.7 * 1.5) console.warn(`[cities perf] WARN ${label}: frame p95 ${r.frameP95.toFixed(1)} ms`);
      if (r.labelMax > 8) console.warn(`[cities perf] WARN ${label}: label relayout ${r.labelMax.toFixed(2)} ms > 8 ms`);
    }
    fs.writeFileSync(testInfo.outputPath('cities-perf.json'), JSON.stringify(runs, null, 2));
  });
});
