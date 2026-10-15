// Travel Atlas: "Browse as a list" under each map (js/browse.js, css/browse.css, data/regions.json).
// Runs against the local Worker (the view-only test makes a real shared map).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, 'screenshots');
const WORLD = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'world.json'), 'utf8'));
const REGIONS = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'regions.json'), 'utf8'));
const AUSTIN = 'C-1159149261';
const CITY_RE = /\/data\/cities\.json/;

function appRoot(testInfo) {
  const b = testInfo.project.use.baseURL;
  return b.endsWith('/') ? b : b + '/';
}
function watchErrors(page) {
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + String(e)));
  return errs;
}
async function openApp(page, url = './') {
  await page.goto(url);
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  await page.waitForFunction(() => window.AtlasBrowse && window.AtlasCities && window.AtlasCities.ready);
}
const status = (page, id) => page.evaluate(id => window.Atlas.getStatus(id), id);
const list = (page, map) => page.locator(`#browse-${map}`);
const group = (page, map, key) => page.locator(`#browse-${map} details.browse-group[data-group="${key}"]`);
const row = (page, map, id) => page.locator(`#browse-${map} li.brow[data-id="${id}"]`).first();
const line = (page, map, id) => row(page, map, id).locator(':scope > .brow-line');

async function openList(page, map) {
  await list(page, map).locator('summary.browse-sum').click();
  await expect(list(page, map)).toHaveAttribute('open', '');
}
async function openGroup(page, map, key) {
  await group(page, map, key).locator(':scope > summary').click();
  await expect(group(page, map, key)).toHaveAttribute('open', '');
}

test('b1 each map gets a collapsed "Browse as a list" with a marked count', async ({ page }) => {
  const errs = watchErrors(page);
  await openApp(page);
  for (const [map, total] of [['na', 69], ['world', 241]]) {
    const d = list(page, map);
    await expect(d).toHaveCount(1);
    expect(await d.evaluate(e => e.open)).toBe(false);
    await expect(d.locator('.browse-title')).toHaveText('Browse as a list');
    await expect(d.locator('.browse-count')).toHaveText(`0 of ${total} marked`);
    // after the map section's lists
    expect(await d.evaluate((e, m) => e.parentElement.id === 'sec-' + m && e.parentElement.lastElementChild === e, map)).toBe(true);
    // collapsed: no rows built yet
    await expect(d.locator('li.brow')).toHaveCount(0);
  }
  // no copy with em dashes
  expect(await page.evaluate(() => document.querySelectorAll('.browse')[0].textContent + document.querySelectorAll('.browse')[1].textContent)).not.toContain('—');
  expect(errs).toEqual([]);
});

test('b2 U.S. & Canada groups: 50 states, 6 D.C. & territories, 13 provinces & territories', async ({ page }) => {
  await openApp(page);
  await openList(page, 'na');
  const want = [['states', 'U.S. states', 50], ['dc', 'D.C. & territories', 6], ['provinces', 'Canadian provinces & territories', 13]];
  await expect(list(page, 'na').locator('details.browse-group')).toHaveCount(3);
  for (const [key, label, n] of want) {
    const g = group(page, 'na', key);
    await expect(g.locator('h3.bg-title')).toHaveText(label);
    await expect(g.locator('.bg-count')).toHaveText(`0 of ${n}`);
    await expect(g.locator('li.brow')).toHaveCount(0);           // lazy: nothing until opened
    await openGroup(page, 'na', key);
    await expect(g.locator('ul.brow-list > li.brow')).toHaveCount(n);
  }
  await expect(row(page, 'na', 'US-DC')).toBeVisible();
  await expect(row(page, 'na', 'US-PRI')).toBeVisible();
  await expect(row(page, 'na', 'CA-NU')).toBeVisible();
});

test('b3 marking Texas Been from the list paints the map, counters, chips and the live region', async ({ page }) => {
  const errs = watchErrors(page);
  await openApp(page);
  await openList(page, 'na');
  await openGroup(page, 'na', 'states');
  const been = page.getByRole('button', { name: 'Mark Texas as been there' });
  await expect(been).toHaveAttribute('aria-pressed', 'false');
  await been.click();
  expect(await status(page, 'US-TX')).toBe(1);
  await expect(been).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Mark Texas as want to go' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('svg.map[data-map="na"] path.place[data-id="US-TX"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('#stats-na .stat').first().locator('.n')).toHaveText('1');
  await expect(page.locator('#list-na .chip[data-id="US-TX"]')).toHaveCount(1);
  await expect(row(page, 'na', 'US-TX')).toHaveClass(/\bon\b/);
  await expect(group(page, 'na', 'states').locator('.bg-count')).toHaveText('1 of 50');
  await expect(list(page, 'na').locator('.browse-count')).toHaveText('1 of 69 marked');
  await expect(list(page, 'na').locator('.browse-live')).toHaveText('Texas: been there');
  await expect(list(page, 'na').locator('.browse-live')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#toast-na')).not.toHaveClass(/\bshow\b/);   // quiet: the list announces it
  // Been again clears
  await been.click();
  expect(await status(page, 'US-TX')).toBe(0);
  await expect(list(page, 'na').locator('.browse-live')).toHaveText('Texas: cleared');
  await expect(page.locator('#list-na .chip[data-id="US-TX"]')).toHaveCount(0);
  expect(errs).toEqual([]);
});

test('b4 the Want toggle marks and clears Want to go', async ({ page }) => {
  await openApp(page);
  await openList(page, 'na');
  await openGroup(page, 'na', 'states');
  const want = page.getByRole('button', { name: 'Mark Texas as want to go' });
  await want.click();
  expect(await status(page, 'US-TX')).toBe(2);
  await expect(want).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('svg.map[data-map="na"] path.place[data-id="US-TX"]')).toHaveClass(/\bwant\b/);
  await expect(page.locator('#list-na .chip.want[data-id="US-TX"]')).toHaveCount(1);
  await expect(list(page, 'na').locator('.browse-live')).toHaveText('Texas: want to go');
  // Been from Want switches over
  await page.getByRole('button', { name: 'Mark Texas as been there' }).click();
  expect(await status(page, 'US-TX')).toBe(1);
  await expect(want).toHaveAttribute('aria-pressed', 'false');
  await expect(list(page, 'na').locator('.browse-live')).toHaveText('Texas: been there (was on Want to go)');
  await want.click();
  await want.click();
  expect(await status(page, 'US-TX')).toBe(0);
  await expect(want).toHaveAttribute('aria-pressed', 'false');
});

test('b5 expanding Texas lists its cities; cities.json loads only then', async ({ page }) => {
  const reqs = [];
  page.on('request', r => { if (CITY_RE.test(r.url())) reqs.push(r.url()); });
  await openApp(page);
  await openList(page, 'na');
  await openGroup(page, 'na', 'states');
  await openList(page, 'world');
  await page.waitForTimeout(300);
  expect(reqs).toEqual([]);
  expect(await page.evaluate(() => window.AtlasCities.loaded)).toBe(false);
  const exp = line(page, 'na', 'US-TX').locator('button.brow-exp');
  await expect(exp).toHaveAttribute('aria-expanded', 'false');
  await expect(exp).toHaveText(/Texas · cities/);
  await exp.click();
  await expect(exp).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'na', 'US-TX').locator('li.brow-city')).toHaveCount(25);
  expect(reqs.length).toBe(1);
  await expect(exp).toHaveText('Texas · 0 of 25 cities');
  await expect(row(page, 'na', AUSTIN)).toBeVisible();
  await expect(row(page, 'na', AUSTIN).locator('.brow-name')).toHaveText('Austin');
  // the expanded list is labelled by its button
  const cid = await exp.getAttribute('aria-controls');
  await expect(page.locator('#' + cid)).toHaveCount(1);
  // collapse
  await exp.click();
  await expect(row(page, 'na', 'US-TX').locator('li.brow-city')).toHaveCount(0);
});

test('b6 marking Austin Been from the list also marks Texas and the United States', async ({ page }) => {
  await openApp(page);
  await openList(page, 'na');
  await openGroup(page, 'na', 'states');
  await line(page, 'na', 'US-TX').locator('button.brow-exp').click();
  await page.getByRole('button', { name: 'Mark Austin as been there' }).click();
  expect(await status(page, AUSTIN)).toBe(1);
  expect(await status(page, 'US-TX')).toBe(1);
  expect(await status(page, 'USA')).toBe(1);
  await expect(list(page, 'na').locator('.browse-live')).toHaveText('Austin, Texas and United States: been there');
  await expect(line(page, 'na', 'US-TX').locator('.bt-been')).toHaveAttribute('aria-pressed', 'true');
  await expect(line(page, 'na', 'US-TX').locator('button.brow-exp')).toHaveText('Texas · 1 of 25 cities');
  await expect(page.locator('svg.map[data-map="na"] path.place[data-id="US-TX"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('#list-cities-na .chip[data-id="' + AUSTIN + '"]')).toHaveCount(1);
  // clearing the city leaves Texas alone (same rule as the map)
  await page.getByRole('button', { name: 'Mark Austin as been there' }).click();
  expect(await status(page, AUSTIN)).toBe(0);
  expect(await status(page, 'US-TX')).toBe(1);
  // Want on a city doesn't mark anything else
  await page.getByRole('button', { name: 'Mark Houston as want to go' }).click();
  const houston = await page.evaluate(() => window.AtlasCities.find('Houston'));
  expect(await status(page, houston)).toBe(2);
});

test('b7 world continents: every place exactly once; France in Europe, Brazil in South America', async ({ page }) => {
  // the generated file itself
  const all = Object.values(REGIONS.regions).flat();
  expect(all.length).toBe(WORLD.places.length);
  expect(new Set(all)).toEqual(new Set(WORLD.places.map(p => p.id)));
  await openApp(page);
  await openList(page, 'world');
  await expect(list(page, 'world').locator('details.browse-group')).toHaveCount(7);
  const names = await list(page, 'world').locator('h3.bg-title').allTextContents();
  expect(names).toEqual(['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']);
  // open every continent, then read the rows
  await page.evaluate(() => { for (const d of document.querySelectorAll('#browse-world details.browse-group')) d.open = true; });
  await expect(row(page, 'world', 'FRA')).toBeVisible();
  const placed = await page.evaluate(() => [...document.querySelectorAll('#browse-world ul.brow-list > li.brow')].map(li => [li.dataset.id, li.closest('details.browse-group').dataset.group]));
  expect(placed.length).toBe(WORLD.places.length);
  expect(new Set(placed.map(p => p[0])).size).toBe(WORLD.places.length);
  const where = Object.fromEntries(placed);
  expect(where.FRA).toBe('Europe');
  expect(where.BRA).toBe('South America');
  expect(where.ATA).toBe('Antarctica');
  expect(where.JPN).toBe('Asia');
  // territories sit under their own heading, after the countries
  const eu = group(page, 'world', 'Europe');
  await expect(eu.locator('h4.bg-sub')).toHaveText('Territories & other places');
  expect(await eu.evaluate(g => g.querySelector('h4.bg-sub').nextElementSibling.querySelector('li.brow[data-id="FRO"]') !== null)).toBe(true);
  // the U.S. and Canada point at the other list instead of 600 city rows
  await line(page, 'world', 'USA').locator('button.brow-exp').click();
  await expect(row(page, 'world', 'USA').getByRole('button', { name: 'Open that list' })).toBeVisible();
  await expect(row(page, 'world', 'USA').locator('li.brow-city')).toHaveCount(0);
  await line(page, 'world', 'FRA').locator('button.brow-exp').click();
  await expect(row(page, 'world', 'FRA').locator('li.brow-city').first()).toBeVisible();
  // counts per continent
  await page.evaluate(() => window.Atlas.setStatus('FRA', 1, { quiet: true }));
  await expect(eu.locator('.bg-count')).toHaveText(`1 of ${REGIONS.regions.Europe.length}`);
});

test('b8 filter: diacritic-insensitive, matches places and cities, "No matches"', async ({ page }) => {
  await openApp(page);
  await openList(page, 'world');
  await expect(list(page, 'world').locator('details.browse-group')).toHaveCount(7);
  const q = list(page, 'world').locator('input.browse-q');
  await expect(q).toHaveAttribute('aria-label', 'Filter the World list');
  await q.fill('sao');
  // São Tomé and Principe (country) and São Paulo (a city in Brazil): groups open on their own
  await expect(row(page, 'world', 'STP')).toBeVisible();
  await expect(group(page, 'world', 'Africa')).toHaveAttribute('open', '');
  const saoPaulo = await page.evaluate(() => window.AtlasCities.find('São Paulo'));
  await expect(row(page, 'world', saoPaulo)).toBeVisible();
  await expect(line(page, 'world', 'BRA').locator('button.brow-exp')).toHaveAttribute('aria-expanded', 'true');
  // only matching places are listed
  await expect(row(page, 'world', 'FRA')).toHaveCount(0);
  await expect(group(page, 'world', 'Europe')).toBeHidden();
  // and only matching cities under Brazil
  const brCities = await row(page, 'world', 'BRA').locator('li.brow-city .brow-name').allTextContents();
  expect(brCities.length).toBeGreaterThan(0);
  for (const n of brCities) expect(n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()).toContain('sao');
  await q.fill('zzqx');
  await expect(list(page, 'world').locator('.browse-empty')).toHaveText('No matches');
  await expect(list(page, 'world').locator('.browse-empty')).toBeVisible();
  await q.fill('');
  await expect(list(page, 'world').locator('.browse-empty')).toBeHidden();
  await expect(group(page, 'world', 'Europe')).toBeVisible();
  expect(await group(page, 'world', 'Africa').evaluate(d => d.open)).toBe(false);    // back to how it was
  // NA filter with accents typed: "québec"
  await openList(page, 'na');
  await list(page, 'na').locator('input.browse-q').fill('QUEBEC');
  await expect(row(page, 'na', 'CA-QC')).toBeVisible();
});

test('b9 filtering loads the cities (and nothing before)', async ({ page }) => {
  const reqs = [];
  page.on('request', r => { if (CITY_RE.test(r.url())) reqs.push(r.url()); });
  await openApp(page);
  await openList(page, 'na');
  expect(reqs).toEqual([]);
  await list(page, 'na').locator('input.browse-q').fill('austin');
  await expect(row(page, 'na', AUSTIN)).toBeVisible();
  expect(reqs.length).toBe(1);
  await expect(line(page, 'na', 'US-TX').locator('button.brow-exp')).toHaveAttribute('aria-expanded', 'true');
});

test('b10 a view-only page shows a read-only list', async ({ browser, page }, testInfo) => {
  test.setTimeout(90_000);
  const root = appRoot(testInfo);
  await openApp(page);
  await page.evaluate(() => { window.Atlas.setStatus('US-CA', 1, { quiet: true }); window.Atlas.setStatus('US-TX', 2, { quiet: true }); window.Atlas.setStatus('FRA', 1, { quiet: true }); });
  await expect(page.locator('#status')).toHaveText('Saved on this device');
  await page.click('#share-btn');
  await page.fill('#share-name', 'Ana');
  await page.click('#share-create');
  await expect(page.locator('#share-on')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Synced');
  const link = JSON.parse(await page.evaluate(() => localStorage.getItem('travel-atlas:link')));
  const ctx = await browser.newContext({ baseURL: root, viewport: { width: 1280, height: 800 } });
  const v = await ctx.newPage();
  const errs = watchErrors(v);
  await openApp(v, `./map/${link.id}`);
  await expect(v.locator('body')).toHaveClass(/view-only/);
  await expect(list(v, 'na').locator('.browse-count')).toHaveText('2 of 69 marked');
  await openList(v, 'na');
  await openGroup(v, 'na', 'states');
  await expect(line(v, 'na', 'US-CA').locator('.brow-st')).toHaveText('Been there');
  await expect(line(v, 'na', 'US-TX').locator('.brow-st')).toHaveText('Want to go');
  await expect(line(v, 'na', 'US-NY').locator('.brow-st')).toHaveText('');
  await expect(list(v, 'na').locator('button.bt')).toHaveCount(0);       // no toggles
  await expect(list(v, 'na').locator('button.bt-info')).toHaveCount(0);  // plain view: no details
  // cities still browse, read-only
  await line(v, 'na', 'US-TX').locator('button.brow-exp').click();
  await expect(row(v, 'na', AUSTIN)).toBeVisible();
  await expect(row(v, 'na', AUSTIN).locator('button.bt')).toHaveCount(0);
  expect(await v.evaluate(() => window.Atlas.getStatus('US-NY'))).toBe(0);
  expect(errs).toEqual([]);
  await ctx.close();
});

test('b11 375 px: no horizontal scroll, 40 px targets, 16 px filter', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openApp(page);
  await openList(page, 'na');
  await openGroup(page, 'na', 'states');
  await line(page, 'na', 'US-TX').locator('button.brow-exp').click();
  await expect(row(page, 'na', AUSTIN)).toBeVisible();
  await page.evaluate(() => window.Atlas.setStatus('US-CA', 1, { quiet: true }));
  await openList(page, 'world');
  await expect(list(page, 'world').locator('details.browse-group')).toHaveCount(7);
  await page.evaluate(() => { for (const d of document.querySelectorAll('#browse-world details.browse-group')) d.open = true; });
  await expect(row(page, 'world', 'STP')).toBeVisible();
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement;
    const small = [];
    for (const b of document.querySelectorAll('.browse button, .browse summary')) {
      const rc = b.getBoundingClientRect();
      if (!rc.width) continue;
      if (rc.height < 40 || (b.classList.contains('bt-info') && rc.width < 40)) small.push(b.textContent.trim() + ' ' + rc.width + 'x' + rc.height);
    }
    const wide = [...document.querySelectorAll('.browse li.brow')].filter(li => li.getBoundingClientRect().right > window.innerWidth + 0.5).length;
    return { sw: doc.scrollWidth, cw: doc.clientWidth, small: small.slice(0, 5), nSmall: small.length, wide, fs: getComputedStyle(document.querySelector('.browse-q')).fontSize };
  });
  expect(r.sw).toBeLessThanOrEqual(r.cw);
  expect(r.wide).toBe(0);
  expect(r.small, JSON.stringify(r.small)).toEqual([]);
  expect(r.fs).toBe('16px');
});

test('b12 a change event keeps scroll, open groups and expanded places', async ({ page }) => {
  await openApp(page);
  await openList(page, 'na');
  await openGroup(page, 'na', 'states');
  await openGroup(page, 'na', 'provinces');
  await line(page, 'na', 'US-TX').locator('button.brow-exp').click();
  await expect(row(page, 'na', AUSTIN)).toBeVisible();
  await row(page, 'na', 'US-WA').scrollIntoViewIfNeeded();
  await page.evaluate(() => { window.scrollBy(0, 37); document.querySelector('#browse-na li.brow[data-id="US-TX"]').__keep = 1; });
  // where the rows sit on screen (the chip lists above the list grow, and scroll anchoring keeps the rows still)
  const top = () => page.evaluate(() => Math.round(document.querySelector('#browse-na li.brow[data-id="US-WA"]').getBoundingClientRect().top));
  const y0 = await top();
  // changes from elsewhere: the map, a sync, a restore
  await page.evaluate(() => {
    window.Atlas.tap('US-WA');
    window.Atlas.setStatus('CA-BC', 2, { quiet: true });
    window.Atlas.emit('change', { ids: null, source: 'remote', owner: false });
  });
  await expect(line(page, 'na', 'US-WA').locator('.bt-been')).toHaveAttribute('aria-pressed', 'true');
  await expect(line(page, 'na', 'CA-BC').locator('.bt-want')).toHaveAttribute('aria-pressed', 'true');
  await expect(group(page, 'na', 'states').locator('.bg-count')).toHaveText('1 of 50');
  await expect(group(page, 'na', 'provinces').locator('.bg-count')).toHaveText('1 of 13');
  await expect(list(page, 'na').locator('.browse-count')).toHaveText('2 of 69 marked');
  expect(Math.abs((await top()) - y0)).toBeLessThanOrEqual(2);   // sub-pixel rounding only
  expect(await page.evaluate(() => document.querySelector('#browse-na li.brow[data-id="US-TX"]').__keep)).toBe(1);   // same node
  await expect(line(page, 'na', 'US-TX').locator('button.brow-exp')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page, 'na', 'states')).toHaveAttribute('open', '');
  // a rating and a note show as markers
  await page.evaluate(() => window.Atlas.setInfo('US-WA', { rating: 4, note: 'Rain' }));
  await expect(line(page, 'na', 'US-WA').locator('.brow-marks')).toHaveText('★4 ✎');
  await expect(line(page, 'na', 'US-WA').locator('.brow-vh')).toHaveText(', rated 4, has a note');
  // the details button opens the panel
  await page.getByRole('button', { name: 'Details for Washington' }).click();
  await expect(page.locator('dialog.place-panel')).toBeVisible();
});

test('b13 screenshots: light and dark, 1280 and 375', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [[1280, 800], [375, 812]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ baseURL: appRoot(testInfo), viewport: { width: w, height: h }, colorScheme: scheme });
      const page = await ctx.newPage();
      await openApp(page);
      await page.evaluate(() => {
        const A = window.Atlas;
        A.setStatus('US-CA', 1, { quiet: true }); A.setStatus('US-TX', 1, { quiet: true }); A.setStatus('US-NY', 2, { quiet: true });
        A.setInfo('US-CA', { rating: 5, note: 'Big Sur' });
      });
      await openList(page, 'na');
      await openGroup(page, 'na', 'states');
      await line(page, 'na', 'US-TX').locator('button.brow-exp').click();
      await expect(row(page, 'na', AUSTIN)).toBeVisible();
      await page.getByRole('button', { name: 'Mark Austin as been there' }).click();
      await page.getByRole('button', { name: 'Mark Houston as want to go' }).click();
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.evaluate(() => document.querySelector('#browse-na li.brow[data-id="US-SD"]').scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(SHOTS, `browse-${scheme}-${w}.png`) });
      if (scheme === 'light') {
        await page.evaluate(() => document.documentElement.setAttribute('data-accent', 'teal'));
        await page.screenshot({ path: path.join(SHOTS, `browse-${scheme}-${w}-teal.png`) });
        await page.evaluate(() => document.documentElement.removeAttribute('data-accent'));
      }
      await ctx.close();
    }
  }
});
