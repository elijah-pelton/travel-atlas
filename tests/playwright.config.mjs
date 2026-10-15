// Playwright config for Travel Atlas.
// Local (default): runs the Cloudflare Worker locally (`npm run dev:test` at the repo root:
//   local D1 migrations + `wrangler dev` on 127.0.0.1:8787), so the app lives at the domain
//   root http://127.0.0.1:8787/ exactly as on https://atlas.elijahpelton.com/.
// Live:  BASE_URL=https://atlas.elijahpelton.com/ npx playwright test
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Keep a Mac awake while the suite runs. On battery with the display off, macOS idle-sleeps
// (Maintenance Sleep / DarkWake, see `pmset -g log`) mid-run: wrangler, Chromium and the test
// worker are all frozen for minutes, so tests "take" 4–9 minutes and expect.poll / test
// timeouts fire on wake. `caffeinate -i -w <pid>` blocks idle sleep until this runner exits.
// Only the main runner process spawns it (workers have TEST_WORKER_INDEX).
if (process.platform === 'darwin' && !process.env.TEST_WORKER_INDEX && !process.env.PW_NO_CAFFEINATE) {
  try { spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}).unref(); } catch (_) {}
}

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const LOCAL = 'http://127.0.0.1:8787/';
const baseURL = process.env.BASE_URL || LOCAL;
const CHROME = process.env.PW_CHROMIUM ||
  '/Users/elijah/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: path.join(here, 'test-results'),
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    serviceWorkers: 'allow',
    launchOptions: { executablePath: CHROME },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: process.env.BASE_URL ? undefined : {
    command: 'npm run dev:test',
    cwd: REPO,
    url: LOCAL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
