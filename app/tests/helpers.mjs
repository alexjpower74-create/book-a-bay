// Shared test helpers. REAL input only: tap() hit-tests the target's centre with elementFromPoint before a real
// touch or click, typing is page.keyboard, and evaluate is only ever used to read.
import { expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOW = '2026-09-14T11:30:00Z' // Mon Sep 14, 9:00 AM NDT
export const PIN = '2468'
export const SHOP = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots')
const clock = { 'X-Test-Now': NOW }

// Every test starts here: a clean database and the pinned clock on every request the page makes.
export async function fresh(context, request) {
  await context.setExtraHTTPHeaders(clock)
  const r = await request.post('/api/test/reset', { headers: clock })
  expect(r.status(), 'POST /api/test/reset').toBe(200)
}

// A second person (the shop, or another customer) on the same device type as the project.
export async function newContext(browser, testInfo) {
  const { browserName, defaultBrowserType, ...device } = testInfo.project.use
  const context = await browser.newContext({ ...device, baseURL: `http://127.0.0.1:${process.env.E2E_PORT || 7303}` })
  await context.setExtraHTTPHeaders(clock)
  return context
}

export async function tap(page, locator, label = String(locator)) {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  let box = await locator.boundingBox()
  expect(box, `tap(${label}): no box`).not.toBeNull()
  // "In view" to Playwright includes under the sticky header, where a person could not tap it; a person would scroll it
  // down first, so do that (only in that case). Anything else on top still fails the hit-test below.
  const headerBottom = await page.evaluate(() => document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0)
  if (box.y + box.height / 2 < headerBottom) {
    await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    box = await locator.boundingBox()
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = await locator.evaluate((el, [px, py]) => {
    const t = document.elementFromPoint(px, py)
    return t === el || el.contains(t) ? '' : t ? t.outerHTML.slice(0, 160) : 'nothing'
  }, [x, y])
  expect(hit, `tap(${label}) hit-test at ${Math.round(x)},${Math.round(y)}: something else is on top`).toBe('')
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (coarse) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

export async function type(page, locator, text) {
  await tap(page, locator)
  await page.keyboard.type(text)
}

export async function api(request, method, url, data, headers = {}) {
  const r = await request.fetch(url, { method, data, headers: { ...clock, ...headers } })
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status(), body, type: r.headers()['content-type'] || '' }
}

export async function shopToken(request) {
  const r = await api(request, 'POST', '/api/shop/signin', { pin: PIN })
  expect(r.status, 'sign in with the SAMPLE PIN').toBe(200)
  return r.body.token
}

// Sign out the way a person would: the header button on a wide screen, Settings on a phone.
export async function signOutThroughPage(page) {
  if (await page.locator('#signout').isVisible()) return tap(page, page.locator('#signout'), 'Sign out')
  await tap(page, page.getByRole('tab', { name: 'Settings' }), 'Settings')
  await tap(page, page.locator('#signout-phone'), 'Sign out (Settings)')
}

export async function shot(page, testInfo, name) {
  await page.evaluate(() => document.fonts.ready)
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  // Back to the top so sticky parts are not painted mid-page in a full-page picture. A real wheel where there is one;
  // touch projects have no wheel in Playwright, so there (screenshot staging only, after every check) scroll directly.
  if (!coarse) {
    await page.mouse.move(200, 200)
    for (let i = 0; i < 6 && (await page.evaluate(() => window.scrollY)) > 0; i++) {
      await page.mouse.wheel(0, -4000)
      await page.waitForTimeout(120)
    }
  } else {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(120)
  }
  await page.screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-${name}.png`), fullPage: true, animations: 'disabled' })
}

// Book through the customer page with real input, from service to Request sent. Returns the status link.
export async function bookThroughPage(page, { service = 'Oil change', day = 'Sep 15', time = '10:00', name = 'Pat Sample (sample)' } = {}) {
  await page.goto('/')
  await tap(page, page.locator('button.service', { hasText: service }), service)
  await tap(page, page.locator('button.day', { hasText: day }), day)
  await tap(page, page.locator(`button.time[data-time="${time}"]`), time)
  await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible()
  await type(page, page.locator('#f-name'), name)
  await type(page, page.locator('#f-phone'), '709-555-0142')
  await type(page, page.locator('#f-year'), '2016')
  await type(page, page.locator('#f-make'), 'Toyota')
  await type(page, page.locator('#f-model'), 'Corolla')
  await tap(page, page.locator('#send'), 'Send request')
  await expect(page.getByRole('heading', { name: 'Request sent' })).toBeVisible()
  return page.locator('#status-link').inputValue()
}

export async function signInThroughPage(page, pin = PIN) {
  await page.goto('/shop/')
  await type(page, page.locator('#pin'), pin)
  await tap(page, page.locator('#signin-btn'), 'Sign in')
}
