// The sticky header must hide whatever scrolls under it. Found in the lead's demo shots on webkit-390: after Send request the
// progress tiles read straight through the glass header (crisp, so neither the tint nor the blur was hiding them).
// On every page with a sticky .bar, after scrolling: the header's own background is at least 0.9 opaque, and the header,
// not the content under it, is what a point in its middle hits.
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fresh, api, bookThroughPage, signInThroughPage } from './helpers.mjs'

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots')

test.beforeEach(async ({ context, request }) => fresh(context, request))

// Scroll content up under the header: a real wheel where the project has one. Touch projects have no wheel in Playwright,
// so there the page is scrolled directly (staging only; the checks below read paint and stacking, not input).
async function scrollDown(page, by) {
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (coarse) await page.evaluate((y) => window.scrollBy(0, y), by)
  else {
    await page.mouse.move(200, 500)
    await page.mouse.wheel(0, by)
  }
  await page.waitForTimeout(250)
}

async function headerHides(page, testInfo, name) {
  const facts = await page.locator('.bar').evaluate((bar) => {
    const cs = getComputedStyle(bar)
    const nums = (cs.backgroundColor.match(/[\d.]+/g) || []).map(Number)
    const alpha = nums.length >= 4 ? nums[3] : nums.length === 3 ? 1 : 0
    const r = bar.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const room = document.documentElement.scrollHeight - window.innerHeight
    return { background: cs.backgroundColor, alpha, onTop: bar.contains(hit), scrollY: Math.round(window.scrollY), headerBottom: Math.round(r.bottom), room: Math.round(room) }
  })
  // A page shorter than the screen cannot put anything under the header; where it can, it must have.
  if (facts.room > facts.headerBottom) {
    expect(facts.scrollY, `${name}: scrolled so content sits under the header (room ${facts.room}px)`).toBeGreaterThan(facts.headerBottom)
  }
  expect(facts.onTop, `${name}: the header is on top of the scrolled content`).toBe(true)
  // Solid, not "mostly": at 0.94 the webkit-390 shots still showed card text legibly through the header (no blur there).
  expect(facts.alpha, `${name}: header background ${facts.background} is solid`).toBeGreaterThanOrEqual(0.99)
  await page.screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-header-${name}.png`), animations: 'disabled' })
}

test('Request sent: scrolled content does not show through the header', async ({ page }, testInfo) => {
  await bookThroughPage(page)
  await expect(page.getByRole('heading', { name: 'Request sent' })).toBeVisible()
  await scrollDown(page, 2000)
  await headerHides(page, testInfo, 'request-sent')
})

test('status page: scrolled content does not show through the header', async ({ page, request }, testInfo) => {
  const made = await api(request, 'POST', '/api/requests', { service: 'oil', date: '2026-09-15', time: '10:00', name: 'Pat Sample (sample)', phone: '709-555-0142', make: 'Toyota', model: 'Corolla', note: 'Squeak from the front left when braking.' })
  expect(made.status).toBe(201)
  await page.goto(made.body.status_url)
  await expect(page.locator('#status-pill')).toHaveText('Requested')
  await scrollDown(page, 2000)
  await headerHides(page, testInfo, 'status')
})

test('shop board: scrolled content does not show through the header', async ({ page, request }, testInfo) => {
  expect((await api(request, 'POST', '/api/test/seed', {})).status).toBe(200)
  await signInThroughPage(page)
  await expect(page.locator('.pending article.req')).toHaveCount(4)
  await scrollDown(page, 500)
  await headerHides(page, testInfo, 'shop-board')
})
