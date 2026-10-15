// Service-worker tests for Travel Atlas: version stamping, offline launch, cache-first
// navigation, the unversioned terrain cache, and the "Update available · Reload" flow.
import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const STAMP = path.join(REPO, 'tools', 'stamp-sw.py');
const TMP_BASE = '/private/tmp/claude-501';
const ALT_PORT = 8790;
const ALT_URL = `http://127.0.0.1:${ALT_PORT}/`; // the copy is served at the root of its own port
const TERRAIN_FILES = 9;

// ---------- helpers ----------

function stamp(...args) {
  return spawnSync('python3', [STAMP, ...args], { encoding: 'utf8' });
}

function swVersion(root) {
  const m = fs.readFileSync(path.join(root, 'sw.js'), 'utf8').match(/^const VERSION = '([^']*)';/m);
  return m && m[1];
}

/** Copy the site (without tests, git, local tooling and wrangler state) to <parent>/travel-atlas. */
function copySite(parent) {
  const dest = path.join(parent, 'travel-atlas');
  const skip = new Set(['tests', '.git', '.claude', 'node_modules', '.wrangler']);
  fs.cpSync(REPO, dest, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)) || path.dirname(src) !== REPO,
  });
  return dest;
}

/** Load the app, make sure the service worker controls the page, and both maps rendered. */
async function openControlled(page, url = './') {
  await page.goto(url);
  await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await page.waitForSelector('#frame-na svg.map[data-map="na"]');
  }
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller), 'SW controls page').toBe(true);
}

const cacheKeys = (page) => page.evaluate(() => caches.keys());

async function terrainCount(page) {
  return page.evaluate(async () => {
    if (!(await caches.has('atlas-terrain'))) return 0;
    return (await (await caches.open('atlas-terrain')).keys()).length;
  });
}

async function openRealMap(page) {
  await page.click('#style-seg button[data-style="real"]');
  await expect(page.locator('body')).toHaveClass(/\breal\b/);
  await expect.poll(() => terrainCount(page), { timeout: 15000 }).toBeGreaterThanOrEqual(TERRAIN_FILES);
}

// ---------- (a) stamping ----------

test.describe('stamp-sw.py', () => {
  let tmp;
  test.beforeAll(() => { tmp = fs.mkdtempSync(path.join(TMP_BASE, 'atlas-stamp-')); });
  test.afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('a1 stamping is stable, --check passes after it and fails after a change', () => {
    const site = copySite(tmp);
    let r = stamp('--root', site);
    expect(r.status, r.stderr).toBe(0);
    const v1 = swVersion(site);
    expect(v1).toMatch(/^[0-9a-f]{10}$/);
    const bytes1 = fs.readFileSync(path.join(site, 'sw.js'));

    r = stamp('--root', site, '--check');
    expect(r.status, r.stderr).toBe(0);

    r = stamp('--root', site);                      // second run: no-op
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(site, 'sw.js')).equals(bytes1)).toBe(true);

    fs.appendFileSync(path.join(site, 'css', 'app.css'), '\n/* changed */\n');
    r = stamp('--root', site, '--check');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/out of date/);
    expect(swVersion(site)).toBe(v1);               // --check never writes

    r = stamp('--root', site);
    expect(r.status, r.stderr).toBe(0);
    expect(swVersion(site)).not.toBe(v1);

    // Logic changes in sw.js itself also bump the version.
    const v2 = swVersion(site);
    fs.appendFileSync(path.join(site, 'sw.js'), '\n// tweak\n');
    expect(stamp('--root', site, '--check').status).toBe(1);
    stamp('--root', site);
    expect(swVersion(site)).not.toBe(v2);
  });

  test('a2 the repo sw.js is stamped for the current files', () => {
    const r = stamp('--check');
    expect(r.status, r.stderr + r.stdout).toBe(0);
  });
});

// ---------- (b) offline launch ----------

test('b offline reload renders both maps', async ({ page, context }) => {
  await openControlled(page);
  await context.setOffline(true);
  try {
    await page.reload();
    await page.waitForSelector('#frame-na svg.map[data-map="na"]');
    await page.waitForSelector('#frame-world svg.map[data-map="world"]');
    await expect(page.locator('svg.map')).toHaveCount(2);
    expect(await page.locator('.frame-loading.err').count()).toBe(0);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  } finally {
    await context.setOffline(false);
  }
});

// ---------- (c) navigation comes from the precache ----------

test('c navigations are served from the precached index.html', async ({ page, context }) => {
  await openControlled(page);
  const cached = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.startsWith('atlas-shell-'));
    const res = await (await caches.open(name)).match('./index.html');
    return res ? res.text() : null;
  });
  expect(cached, 'index.html is precached').toBeTruthy();

  // Online: still answered by the worker from the cache (not network-first).
  let res = await page.goto('./?from=online');
  expect(res.fromServiceWorker()).toBe(true);
  expect(await res.text()).toBe(cached);

  // Offline: same HTML, and the app still starts.
  await context.setOffline(true);
  try {
    res = await page.goto('./index.html?from=offline');
    expect(res.ok()).toBe(true);
    expect(res.fromServiceWorker()).toBe(true);
    expect(await res.text()).toBe(cached);
    await page.waitForSelector('#frame-world svg.map[data-map="world"]');
  } finally {
    await context.setOffline(false);
  }
});

// ---------- (d) terrain cache ----------

test('d terrain is runtime-cached in the unversioned "atlas-terrain" cache', async ({ page }) => {
  await openControlled(page);
  await openRealMap(page);
  const keys = await cacheKeys(page);
  expect(keys).toContain('atlas-terrain');
  expect(keys.filter((k) => k.startsWith('atlas-terrain-'))).toEqual([]);
  expect(keys.filter((k) => k.startsWith('atlas-shell-'))).toHaveLength(1);
});

// ---------- (e) update flow on a separate copy of the site ----------

test.describe('update flow', () => {
  let parent, site, server;

  test.beforeAll(async () => {
    parent = fs.mkdtempSync(path.join(TMP_BASE, 'atlas-update-'));
    site = copySite(parent);
    const r = stamp('--root', site);
    if (r.status !== 0) throw new Error('stamp failed: ' + r.stderr);
    // python's http.server answers If-Modified-Since with 1-second granularity. Backdate the
    // first sw.js so the re-stamp below (often within the same second) is seen as modified.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(site, 'sw.js'), past, past);
    // Static copy at the root of its own port, like the Worker's assets at the domain root.
    // No API here: an unlinked device never calls it.
    server = spawn('python3', ['-m', 'http.server', String(ALT_PORT), '--bind', '127.0.0.1'],
      { cwd: site, stdio: 'ignore' });
    const deadline = Date.now() + 15000;
    for (;;) {
      try { if ((await fetch(ALT_URL)).ok) break; } catch (_) { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('temp server did not start on ' + ALT_PORT);
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  test.afterAll(() => {
    if (server) server.kill();
    if (parent) fs.rmSync(parent, { recursive: true, force: true });
  });

  test('e new deploy shows the toast, Reload switches version, terrain survives', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: ALT_URL, serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    try {
      await openControlled(page);
      await openRealMap(page);
      const v1 = swVersion(site);
      expect(await cacheKeys(page)).toContain('atlas-shell-' + v1);
      await expect(page.locator('#update-toast')).toBeHidden();

      // Deploy: change the page and the CSS, then stamp.
      const MARK = 'sw-spec-' + Date.now();
      fs.appendFileSync(path.join(site, 'css', 'app.css'), `\n/* ${MARK} */\n`);
      const indexPath = path.join(site, 'index.html');
      fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8') + `\n<!-- ${MARK} -->\n`);

      // Before stamping, the live page keeps getting the old version's HTML: navigation is
      // cache-first and nothing from the network is written into the shell cache.
      let res = await page.goto('./');
      expect(res.fromServiceWorker()).toBe(true);
      expect(await res.text()).not.toContain(MARK);
      await page.waitForSelector('#frame-world svg.map[data-map="world"]');

      const r = stamp('--root', site);
      expect(r.status, r.stderr).toBe(0);
      const v2 = swVersion(site);
      expect(v2).not.toBe(v1);

      // Ask for an update check. The navigation above may have started its own (pre-stamp)
      // check, and the browser folds an update() made while that is still running into it,
      // so keep asking until the new worker shows up. It installs and then waits
      // (no skipWaiting in install)...
      await expect.poll(() => page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg.waiting && !reg.installing) await reg.update().catch(() => {});
        return reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'none';
      }), { timeout: 15000, intervals: [250, 500, 1000] }).toBe('waiting');
      // ...and the page offers it.
      await expect(page.locator('#update-toast')).toBeVisible({ timeout: 5000 });
      // Never auto-refreshes: the old version is still in charge until Reload is tapped.
      expect(await page.evaluate(() => fetch('./css/app.css').then((x) => x.text()))).not.toContain(MARK);

      await Promise.all([
        page.waitForEvent('load', { timeout: 15000 }),
        page.click('#update-reload'),
      ]);
      await page.waitForSelector('#frame-world svg.map[data-map="world"]');
      await expect(page.locator('#update-toast')).toBeHidden();

      await expect.poll(async () => {
        const keys = await cacheKeys(page);
        return keys.filter((k) => k.startsWith('atlas-shell-'));
      }).toEqual(['atlas-shell-' + v2]);
      expect(await page.evaluate(() => fetch('./css/app.css').then((x) => x.text()))).toContain(MARK);
      res = await page.goto('./');
      expect(res.fromServiceWorker()).toBe(true);
      expect(await res.text()).toContain(MARK);
      await page.waitForSelector('#frame-world svg.map[data-map="world"]');

      // Terrain was not thrown away by the new version's activate.
      expect(await cacheKeys(page)).toContain('atlas-terrain');
      expect(await terrainCount(page)).toBeGreaterThanOrEqual(TERRAIN_FILES);
    } finally {
      await ctx.close();
    }
  });
});
