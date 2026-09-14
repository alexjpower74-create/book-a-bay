// Sticky bars must hide whatever scrolls under them (DECISIONS 26). Found in the lead's demo shots on webkit-390: the progress
// tiles read straight through the glass header after Send request, and Settings fields read through the glass Save bar.
// For the header on every page with a sticky .bar, and for the Save bar on Settings, after scrolling: the bar's own background
// is at least 0.99 opaque, and the bar, not the content under it, is what a point in its middle hits.
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fresh, tap, api, bookThroughPage, signInThroughPage } from './helpers.mjs'

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

test('Settings: fields under the sticky Save bar do not show through it', async ({ page }, testInfo) => {
  await signInThroughPage(page)
  await tap(page, page.getByRole('tab', { name: 'Settings' }), 'Settings')
  await expect(page.getByRole('heading', { name: 'Opening hours' })).toBeVisible()
  await scrollDown(page, 400)

  const facts = await page.locator('.savebar').evaluate((bar) => {
    const cs = getComputedStyle(bar)
    const nums = (cs.backgroundColor.match(/[\d.]+/g) || []).map(Number)
    const alpha = nums.length >= 4 ? nums[3] : nums.length === 3 ? 1 : 0
    const r = bar.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    // What lies under the bar: every element stacked at points across it, keeping those that are settings content.
    const under = new Set()
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const el of document.elementsFromPoint(r.left + r.width * fx, r.top + r.height / 2)) {
        if (!bar.contains(el) && el.closest('[data-section], .pin-form')) under.add(el.closest('.field, .hours-row, .list-row, [data-section], .pin-form'))
      }
    }
    return {
      background: cs.backgroundColor, alpha, onTop: bar.contains(hit), hitTag: hit?.tagName,
      showing: r.top < window.innerHeight && r.bottom > 0, underCount: under.size, bottomGap: Math.round(window.innerHeight - r.bottom),
    }
  })
  expect(facts.showing, 'the Save bar is on screen').toBe(true)
  expect(facts.underCount, 'settings content sits under the Save bar').toBeGreaterThan(0)
  expect(facts.onTop, `the Save bar (or its button) is on top at its centre, hit ${facts.hitTag}`).toBe(true)
  expect(facts.alpha, `Save bar background ${facts.background} is solid`).toBeGreaterThanOrEqual(0.99)
  await page.screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-header-settings-savebar.png`), animations: 'disabled' })
})
