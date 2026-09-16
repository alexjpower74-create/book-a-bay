// Moving an existing request uses the request's own service snapshot and treats its own hold as free (API.md
// clarification 19). With one bay and one booking per start, a time held by this request is blocked for everyone else,
// so it only shows in a picker that frees the request's own hold. And once the shop takes the service offline, the
// shop can still offer and the customer can still pick another time for a request that already has it.
import { test, expect } from '@playwright/test'
import { fresh, tap, api, shot, shopToken, newContext, signInThroughPage } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

// A picker draws twice (loading, then its days); tap a day only once all 14 are there.
async function pickDay(page, scope, day) {
  await expect(scope.locator('.picker button.day')).toHaveCount(14)
  await tap(page, scope.locator('.picker button.day', { hasText: day }), day)
  await expect(scope.locator('.picker button.day[aria-pressed="true"]')).toContainText(day)
}

test('own hold stays pickable, and after Oil change goes offline the shop can offer and the customer can pick another time', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const token = await shopToken(request)
  const auth = { Authorization: `Bearer ${token}` }
  const settings = (await api(request, 'GET', '/api/shop/settings', null, auth)).body
  const put = await api(
    request,
    'PUT',
    '/api/shop/settings',
    { ...settings, bays: 1, max_per_slot: 1, services: settings.services.map((s) => ({ ...s, bays_needed: 1 })) },
    auth,
  )
  expect(put.status, JSON.stringify(put.body)).toBe(200)
  const made = await api(request, 'POST', '/api/requests', {
    service: 'oil',
    date: '2026-09-15',
    time: '10:00',
    name: 'Pat Sample (sample)',
    phone: '709-555-0142',
    make: 'Toyota',
  })
  expect(made.status, JSON.stringify(made.body)).toBe(201)

  const shopContext = await newContext(browser, testInfo)
  const shop = await shopContext.newPage()
  await signInThroughPage(shop)
  const card = shop.locator('.pending article.req', { hasText: 'Pat Sample (sample)' })

  // Shop: the request's own Tue 10:00 is offered on its own day; then offer Wed 2:00 PM.
  await tap(shop, card.getByRole('button', { name: 'Offer another time' }), 'Offer another time')
  await pickDay(shop, card, 'Sep 15')
  await expect(card.locator('.picker button.time[data-time="10:00"]'), "the shop sees the booking's own time").toBeVisible()
  await pickDay(shop, card, 'Sep 16')
  await tap(shop, card.locator('.picker button.time[data-time="14:00"]'), '2:00 PM')
  await tap(shop, card.getByRole('button', { name: 'Offer Wed Sep 16, 2:00 PM' }), 'Offer Wed Sep 16, 2:00 PM')
  await expect(shop.locator('.recent article.req', { hasText: 'Pat Sample (sample)' }).locator('.chip')).toHaveText('New time offered')

  // Customer: Wed 2:00 PM is held only by this request's offer, and it is still in their picker.
  await page.goto(made.body.status_url)
  await expect(page.locator('#status-pill')).toHaveText('New time offered')
  await tap(page, page.getByRole('button', { name: 'Pick another time' }), 'Pick another time')
  await pickDay(page, page, 'Sep 16')
  await expect(page.locator('.picker button.time').first()).toBeVisible()
  await expect(page.locator('.picker button.time[data-time="14:00"]'), 'the time held only by this booking is offered to it').toBeVisible()
  await tap(page, page.getByRole('button', { name: 'Never mind' }), 'Never mind')

  // The shop takes Oil change offline.
  await tap(shop, shop.getByRole('tab', { name: 'Settings' }), 'Settings')
  const oilOnline = shop
    .locator('.service-row')
    .filter({ has: shop.locator('input[value="Oil change"]') })
    .locator('input[data-s="svc-active"]')
  await expect(oilOnline).toBeChecked()
  await tap(shop, oilOnline, 'Oil change: Bookable online')
  await expect(oilOnline).not.toBeChecked()
  const saved = shop.waitForResponse((r) => r.url().endsWith('/api/shop/settings') && r.request().method() === 'PUT')
  await tap(shop, shop.locator('#settings-save'), 'Save settings')
  expect((await saved).status()).toBe(200)
  await expect(shop.locator('#settings-saved')).toHaveText('Saved.')

  // New customers cannot book it any more.
  await page.goto('/')
  await expect(page.locator('button.service')).toHaveCount(settings.services.length - 1)
  await expect(page.locator('button.service', { hasText: 'Oil change' })).toHaveCount(0)

  // The shop can still offer a different time for the existing oil change.
  const boardLoaded = shop.waitForResponse((r) => new URL(r.url()).pathname === '/api/shop/board')
  await tap(shop, shop.getByRole('tab', { name: 'Board' }), 'Board')
  await boardLoaded
  const offered = shop.locator('.pending article.req', { hasText: 'Pat Sample (sample)' })
  await tap(shop, offered.getByRole('button', { name: 'Offer a different time' }), 'Offer a different time')
  await pickDay(shop, offered, 'Sep 17')
  await tap(shop, offered.locator('.picker button.time[data-time="09:00"]'), '9:00 AM')
  await tap(shop, offered.getByRole('button', { name: 'Offer Thu Sep 17, 9:00 AM' }), 'Offer Thu Sep 17, 9:00 AM')
  await expect(shop.locator('.recent article.req', { hasText: 'Pat Sample (sample)' })).toContainText('Offered Thu Sep 17, 9:00 AM')
  await shopContext.close()

  // And the customer can still pick another time.
  await page.goto(made.body.status_url)
  await expect(page.locator('.offer')).toContainText('Thu Sep 17, 9:00 AM')
  await tap(page, page.getByRole('button', { name: 'Pick another time' }), 'Pick another time')
  await pickDay(page, page, 'Sep 18')
  await tap(page, page.locator('.picker button.time[data-time="08:00"]'), '8:00 AM')
  await tap(page, page.getByRole('button', { name: /^Ask for/ }), 'Ask for Fri Sep 18, 8:00 AM')
  await expect(page.locator('#status-pill')).toHaveText('Requested')
  await expect(page.locator('.details')).toContainText('Fri Sep 18, 8:00 AM')
  await shot(page, testInfo, 'status-moved-offline-service')
})
