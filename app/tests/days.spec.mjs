// Closed days, the SAMPLE badge on all three screens, and primary buttons a thumb can hit: at least 44 px tall at 390,
// hit-testing to themselves, enabled, and with text contrast of at least 4.5:1 on every stop of their gradient.
import { test, expect } from '@playwright/test'
import { fresh, tap, api, shot, signInThroughPage, SHOP } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

async function badge(page) {
  await expect(page.locator('[data-sample]')).toBeVisible()
  await expect(page.locator('[data-sample]')).toHaveText('SAMPLE')
  await expect(page.locator('[data-shop-name]')).toHaveText(SHOP)
}

// Height, enabled, hit-test at the centre, and contrast of the text against each colour in its background.
async function primaryOk(page, locator, label, testInfo) {
  await expect(locator, label).toBeVisible()
  await expect(locator, `${label} is enabled`).toBeEnabled()
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (testInfo.project.name.endsWith('390')) expect(box.height, `${label} height at 390`).toBeGreaterThanOrEqual(44)
  const facts = await locator.evaluate((el, [x, y]) => {
    const t = document.elementFromPoint(x, y)
    const cs = getComputedStyle(el)
    return { hits: t === el || el.contains(t), color: cs.color, background: `${cs.backgroundImage} ${cs.backgroundColor}`, opacity: cs.opacity }
  }, [box.x + box.width / 2, box.y + box.height / 2])
  expect(facts.hits, `${label} hit-tests to itself`).toBe(true)
  expect(facts.opacity, `${label} is not faded`).toBe('1')
  const rgb = (s) => [...s.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)].filter((m) => m[4] === undefined || Number(m[4]) > 0.5).map((m) => [1, 2, 3].map((i) => Number(m[i])))
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const text = lum(rgb(facts.color)[0])
  const stops = rgb(facts.background)
  expect(stops.length, `${label} has a solid background colour to measure`).toBeGreaterThan(0)
  const worst = Math.min(...stops.map((c) => { const [hi, lo] = [text, lum(c)].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05) }))
  expect(worst, `${label} text contrast (worst gradient stop)`).toBeGreaterThanOrEqual(4.5)
}

test('Sunday is closed; the SAMPLE badge is on all three screens; primary buttons are big, enabled, legible and hit-test to themselves', async ({ page, request }, testInfo) => {
  // Customer page
  await page.goto('/')
  await badge(page)
  await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change')
  const sunday = page.locator('button.day', { hasText: 'Sep 20' })
  await expect(sunday).toBeDisabled()
  await expect(sunday).toContainText('Closed')
  await expect(page.locator('button.day', { hasText: 'Sep 21' })).toContainText('Staff training (sample)')
  await expect(page.locator('button.day')).toHaveCount(14)
  await shot(page, testInfo, 'book-2-day')
  await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15')
  await tap(page, page.locator('button.time[data-time="10:00"]'), '10:00 AM')
  await primaryOk(page, page.locator('#send'), 'Send request', testInfo)
  await tap(page, page.locator('#send'), 'Send request (empty)')
  await expect(page.getByText('Please enter your name.')).toBeVisible()
  await primaryOk(page, page.locator('#send'), 'Send request after errors', testInfo)
  await shot(page, testInfo, 'book-4-details-errors')

  // Status page
  const made = await api(request, 'POST', '/api/requests', { service: 'oil', date: '2026-09-15', time: '11:00', name: 'Pat Sample (sample)', phone: '709-555-0142', make: 'Toyota' })
  expect(made.status).toBe(201)
  await page.goto(made.body.status_url)
  await expect(page.locator('#status-pill')).toHaveText('Requested')
  await badge(page)

  // Shop side, before and after signing in
  await page.goto('/shop/')
  await badge(page)
  await primaryOk(page, page.locator('#signin-btn'), 'Sign in', testInfo)
  await signInThroughPage(page)
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible()
  await badge(page)
  await primaryOk(page, page.locator('.pending article.req').first().getByRole('button', { name: 'Confirm' }), 'Confirm', testInfo)
})
