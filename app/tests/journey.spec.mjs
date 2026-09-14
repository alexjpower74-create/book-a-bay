// The whole journey with real input: a customer books, the shop confirms on its own screen, and the customer's open
// status page turns Confirmed by itself (its 15 s poll) with an Add to calendar link.
import { test, expect } from '@playwright/test'
import { fresh, tap, type, api, shot, shopToken, newContext, signInThroughPage } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

test('customer books → shop confirms → status page shows Confirmed', async ({ page, browser }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Pick a service' })).toBeVisible()
  await shot(page, testInfo, 'book-1-service')
  await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change')
  await expect(page.getByRole('heading', { name: 'Pick a day' })).toBeVisible()
  await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15')
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible()
  await shot(page, testInfo, 'book-3-time')
  await tap(page, page.locator('button.time[data-time="10:00"]'), '10:00 AM')
  await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible()
  await type(page, page.locator('#f-name'), 'Pat Sample (sample)')
  await type(page, page.locator('#f-phone'), '709-555-0142')
  await type(page, page.locator('#f-year'), '2016')
  await type(page, page.locator('#f-make'), 'Toyota')
  await type(page, page.locator('#f-model'), 'Corolla')
  await tap(page, page.locator('#send'), 'Send request')

  await expect(page.getByRole('heading', { name: 'Request sent' })).toBeVisible()
  await expect(page.getByText('The shop will confirm your time. Keep this link to check on it.')).toBeVisible()
  const link = await page.locator('#status-link').inputValue()
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/\?t=[A-Za-z0-9_-]{32,}$/)
  await shot(page, testInfo, 'book-5-sent')

  await tap(page, page.getByRole('link', { name: 'Check on your request' }), 'Check on your request')
  await expect(page.locator('#status-pill')).toHaveText('Requested')
  await shot(page, testInfo, 'status-requested')

  // The shop, on its own device.
  const shopContext = await newContext(browser, testInfo)
  if (testInfo.project.name.startsWith('chromium')) await shopContext.grantPermissions(['clipboard-read', 'clipboard-write'])
  const shop = await shopContext.newPage()
  await signInThroughPage(shop)
  const card = shop.locator('.pending article.req', { hasText: 'Pat Sample (sample)' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Tue Sep 15, 10:00 AM')
  await expect(card).toContainText('2016 Toyota Corolla')
  // Texts sit folded behind one button on a pending card; they carry the full status link, not the bare path (clarification 4).
  await expect(card.locator('.text-row')).toHaveCount(0)
  await tap(shop, card.getByRole('button', { name: 'Texts to send (3)' }), 'Texts to send')
  const confirmText = card.locator('.text-row', { hasText: 'Text to confirm' })
  await expect(confirmText.locator('p')).toContainText(`Details: ${link}`)
  const copy = confirmText.getByRole('button', { name: 'Copy text' })
  await tap(shop, copy, 'Copy text')
  await expect(confirmText.getByRole('button')).toHaveText('Copied')
  if (testInfo.project.name.startsWith('chromium')) {
    expect(await shop.evaluate(() => navigator.clipboard.readText())).toContain(`Details: ${link}`)
  }
  await shot(shop, testInfo, 'shop-pending')

  await tap(shop, card.getByRole('button', { name: 'Confirm' }), 'Confirm')
  await expect(shop.locator('.recent article.req', { hasText: 'Pat Sample (sample)' }).locator('.chip')).toHaveText('Confirmed')
  await expect(shop.locator('.pending article.req', { hasText: 'Pat Sample (sample)' })).toHaveCount(0)
  await shopContext.close()

  // No reload: the customer's page finds out on its own.
  await expect(page.locator('#status-pill')).toHaveText('Confirmed', { timeout: 20_000 })
  const token = new URL(link).searchParams.get('t')
  await expect(page.locator('#add-to-calendar')).toHaveAttribute('href', `/api/r/${token}/ics`)
  await shot(page, testInfo, 'status-confirmed')
})

test('the Add to calendar link returns text/calendar', async ({ page, request }, testInfo) => {
  const made = await api(request, 'POST', '/api/requests', { service: 'oil', date: '2026-09-15', time: '10:00', name: 'Pat Sample (sample)', phone: '709-555-0142', make: 'Toyota' })
  expect(made.status).toBe(201)
  const token = await shopToken(request)
  const board = await api(request, 'GET', '/api/shop/board?days=7', null, { Authorization: `Bearer ${token}` })
  const id = board.body.pending.find((r) => r.status_url === made.body.status_url).id
  expect((await api(request, 'POST', `/api/shop/requests/${id}/confirm`, {}, { Authorization: `Bearer ${token}` })).status).toBe(200)

  await page.goto(made.body.status_url)
  const link = page.locator('#add-to-calendar')
  await expect(link).toBeVisible()
  const res = await request.get(await link.getAttribute('href'), { headers: { 'X-Test-Now': '2026-09-14T11:30:00Z' } })
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toMatch(/^text\/calendar/)
  expect(await res.text()).toContain('BEGIN:VCALENDAR')
})
