// Old-address forwarding (redirect/): what visitors to https://elijah-pelton.github.io/travel-atlas/
// get once the site moves to https://atlas.elijahpelton.com/.
// Each suite serves a temp folder laid out like GitHub Pages (the site under /travel-atlas/) with
// python's http.server. The new domain is never contacted: every request to it is answered by a
// stub page via context.route, and the test reads the URL the page was sent to.
import { test, expect } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const REDIRECT = path.join(REPO, 'redirect');
const TMP_BASE = '/private/tmp/claude-501';
const NEW_SITE = 'https://atlas.elijahpelton.com/';
const OLD_APP_COMMIT = 'de776e1'; // last version published on GitHub Pages
const REDIRECT_FILES = ['index.html', '404.html', 'sw.js'];

// ---------- helpers ----------

/** Serve `root` on `port` (the Pages-like layout: <root>/travel-atlas/...) and wait until it answers. */
async function serve(root, port) {
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
    { cwd: root, stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/blank.html`)).ok) break; } catch (_) { /* not up */ }
    if (Date.now() > deadline) { server.kill(); throw new Error('temp server did not start on ' + port); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return server;
}

/** A same-origin page outside /travel-atlas/ for seeding and reading storage without the app. */
function writeBlank(root) {
  fs.writeFileSync(path.join(root, 'blank.html'), '<!doctype html><title>blank</title>');
}

function copyRedirectFiles(dest) {
  for (const f of REDIRECT_FILES) fs.copyFileSync(path.join(REDIRECT, f), path.join(dest, f));
}

/** Answer every request to the new domain with a stub page; return the list of URLs requested. */
async function stubNewSite(context) {
  const hits = [];
  await context.route(NEW_SITE + '**', (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>new site stub</title><p>stub</p>' });
  });
  return hits;
}

/** The fragment of the page URL as URLSearchParams (null when there is no fragment). */
function fragmentParams(url) {
  const u = new URL(url);
  return u.hash ? new URLSearchParams(u.hash.slice(1)) : null;
}

const isNewSite = (u) => String(u).startsWith(NEW_SITE);

// ---------- (a) + (b): plain visits to the old address ----------

test.describe('forwarding page', () => {
  const PORT = 8791;
  const OLD = `http://127.0.0.1:${PORT}/travel-atlas/`;
  let tmp, server;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(TMP_BASE, 'atlas-redirect-'));
    fs.mkdirSync(path.join(tmp, 'travel-atlas'));
    copyRedirectFiles(path.join(tmp, 'travel-atlas'));
    writeBlank(tmp);
    server = await serve(tmp, PORT);
  });
  test.afterAll(() => {
    if (server) server.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a carries old marks, owner, accent and style to the new address in the fragment; keeps them here', async ({ browser }) => {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const hits = await stubNewSite(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}/blank.html`);
      const seeded = {
        'travel-atlas:v1': JSON.stringify({ 'US-CO': true, FRA: true }),
        'travel-atlas:owner': 'Sam',
        'travel-atlas:accent': 'teal',
        'travel-atlas:style': 'real',
      };
      await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, seeded);

      await page.goto(OLD);
      await expect(page.locator('h1')).toHaveText('Travel Atlas has moved');
      await page.waitForURL(isNewSite, { timeout: 10000 });

      const url = page.url();
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe(NEW_SITE);
      expect(u.search).toBe('');
      const p = fragmentParams(url);
      expect(p, 'fragment present').not.toBeNull();
      expect([...p.keys()].sort()).toEqual(['accent', 'import', 'owner', 'style']);
      expect(p.get('import')).toBe('atlas1:FRA,US-CO');
      expect(p.get('owner')).toBe('Sam');
      expect(p.get('accent')).toBe('teal');
      expect(p.get('style')).toBe('real');
      await expect(page).toHaveTitle('new site stub');
      // The fragment never reaches a server: the request to the new site carries none of it.
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) { expect(h).not.toContain('import'); expect(h).not.toContain('Sam'); }

      // Nothing was deleted under the old address.
      await page.goto(`http://127.0.0.1:${PORT}/blank.html`);
      const after = await page.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), Object.keys(seeded));
      expect(after).toEqual(seeded);
    } finally {
      await ctx.close();
    }
  });

  test('a2 owner names with spaces and symbols survive the trip', async ({ browser }) => {
    const ctx = await browser.newContext();
    await stubNewSite(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}/blank.html`);
      await page.evaluate(() => {
        localStorage.setItem('travel-atlas:v1', JSON.stringify({ JPN: true, 'CA-ON': true, FRA: false }));
        localStorage.setItem('travel-atlas:owner', 'Zoë & Ana #1');
      });
      await page.goto(OLD);
      await page.waitForURL(isNewSite, { timeout: 10000 });
      const p = fragmentParams(page.url());
      expect(p.get('import')).toBe('atlas1:CA-ON,JPN'); // unmarked (false) entries are not carried
      expect(p.get('owner')).toBe('Zoë & Ana #1');
      expect(p.has('accent')).toBe(false);
      expect(p.has('style')).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test('b a visitor with nothing stored goes to the new address with no fragment', async ({ browser }) => {
    const ctx = await browser.newContext();
    await stubNewSite(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(OLD);
      await page.waitForURL(isNewSite, { timeout: 10000 });
      expect(page.url()).toBe(NEW_SITE);
      expect(new URL(page.url()).hash).toBe('');
    } finally {
      await ctx.close();
    }
  });

  test('b2 any other old path (GitHub Pages 404.html) forwards too', async ({ browser }) => {
    // python's http.server does not serve 404.html for missing paths the way GitHub Pages does,
    // so load the file directly: the page itself must behave the same as index.html.
    const ctx = await browser.newContext();
    await stubNewSite(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}/blank.html`);
      await page.evaluate(() => localStorage.setItem('travel-atlas:v1', JSON.stringify({ FRA: true })));
      await page.goto(OLD + '404.html');
      await page.waitForURL(isNewSite, { timeout: 10000 });
      expect(fragmentParams(page.url()).get('import')).toBe('atlas1:FRA');
    } finally {
      await ctx.close();
    }
  });
});

// ---------- (c): retiring an installed copy of the old app ----------

test.describe('retiring the installed old app', () => {
  const PORT = 8792;
  const OLD = `http://127.0.0.1:${PORT}/travel-atlas/`;
  let tmp, site, server;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(TMP_BASE, 'atlas-retire-'));
    site = path.join(tmp, 'travel-atlas');
    fs.mkdirSync(site);
    // The last version published on GitHub Pages.
    execSync(`git -C "${REPO}" archive ${OLD_APP_COMMIT} | tar -x -C "${site}"`);
    // python's http.server answers If-Modified-Since with 1-second granularity: backdate every old
    // file so the swapped-in sw.js / index.html are never answered with a 304 for the old one.
    const past = new Date(Date.now() - 60_000);
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name); if (e.isDirectory()) walk(p); fs.utimesSync(p, past, past); } };
    walk(site);
    writeBlank(tmp);
    server = await serve(tmp, PORT);
  });
  test.afterAll(() => {
    if (server) server.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('c an installed copy updates to the retiring worker, forwards with its marks, and cleans up', async ({ browser }) => {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const hits = await stubNewSite(ctx);
    const page = await ctx.newPage();
    try {
      // 1. The old app, installed: its service worker controls the page and has caches.
      await page.goto(OLD);
      await page.waitForSelector('#frame-world svg.map[data-map="world"]');
      await page.evaluate(() => navigator.serviceWorker.ready);
      if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
        await page.reload();
        await page.waitForSelector('#frame-world svg.map[data-map="world"]');
      }
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller), 'old SW controls page').toBe(true);
      expect((await page.evaluate(() => caches.keys())).some((k) => k.startsWith('atlas-shell-'))).toBe(true);

      // 2. Mark a place through the old app's own UI (Backup → paste a code → Restore).
      await page.click('#backup-btn');
      await expect(page.locator('#backup')).toBeVisible();
      await page.fill('#code-in', 'atlas1:FRA');
      await page.click('#restore-code');
      await expect(page.locator('#restore-note')).toHaveText(/Added 1 new place/);
      await page.keyboard.press('Escape');
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem('travel-atlas:v1')))).toMatchObject({ FRA: true });

      // 3. Publish the forwarding site in place of the old app.
      for (const e of fs.readdirSync(site)) fs.rmSync(path.join(site, e), { recursive: true, force: true });
      copyRedirectFiles(site);

      // 4. The installed copy checks for an update (as it would on its next launch). Keep asking
      //    until the retiring worker takes over and the page is sent on to the new address.
      await expect.poll(async () => {
        if (isNewSite(page.url())) return 'forwarded';
        try {
          await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {}));
        } catch (_) { /* the page navigated away mid-call */ }
        return isNewSite(page.url()) ? 'forwarded' : page.url();
      }, { timeout: 20000, intervals: [500, 1000] }).toBe('forwarded');

      const p = fragmentParams(page.url());
      expect(p, 'fragment present').not.toBeNull();
      expect(p.get('import')).toBe('atlas1:FRA');
      expect(new URL(page.url()).origin + new URL(page.url()).pathname).toBe(NEW_SITE);
      expect(hits.length).toBeGreaterThan(0);

      // 5. Back on the old origin (outside the old app's scope): caches emptied, worker gone,
      //    marks kept.
      await page.goto(`http://127.0.0.1:${PORT}/blank.html`);
      await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([]);
      await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
      expect(JSON.parse(await page.evaluate(() => localStorage.getItem('travel-atlas:v1')))).toMatchObject({ FRA: true });

      // 6. Opening the old address again now gets the forwarding page from the network, not the old app.
      const res = await page.goto(OLD);
      expect(res.fromServiceWorker()).toBe(false);
      await page.waitForURL(isNewSite, { timeout: 10000 });
      expect(fragmentParams(page.url()).get('import')).toBe('atlas1:FRA');
    } finally {
      await ctx.close();
    }
  });
});
