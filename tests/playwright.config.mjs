// Smoke tests for Travel Atlas.
// Local (default): serves the PARENT folder of the repo with python3, so the app lives at
//   http://127.0.0.1:8765/travel-atlas/  (this is the brief's subpath check).
// Live:  BASE_URL=https://elijah-pelton.github.io/travel-atlas/ npx playwright test
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = 'http://127.0.0.1:8765/travel-atlas/';
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
    command: 'python3 -m http.server 8765 --bind 127.0.0.1',
    cwd: path.resolve(here, '../..'),
    url: LOCAL,
    reuseExistingServer: true,
    timeout: 20_000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
