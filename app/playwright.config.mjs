// Book a Bay end-to-end suite. Every spec runs against the real Worker (app/public served by it), started fresh by
// tests/start-worker.mjs on E2E_PORT (default 7303, inspector +10) with TEST_MODE=1. One worker: the specs share one D1.
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT || 7303)

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  outputDir: './tests/results',
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests/start-worker.mjs',
    url: `http://127.0.0.1:${PORT}/api/shop`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
  projects: [
    { name: 'chromium-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: 'chromium-1280', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'webkit-390', use: { ...devices['iPhone 14'], browserName: 'webkit' } },
    { name: 'webkit-1280', use: { browserName: 'webkit', viewport: { width: 1280, height: 800 } } },
  ],
})
