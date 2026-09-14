// Shop screens on the seeded SAMPLE week: pending on top, the Today board by bay (a segmented bay control at 390),
// the Week list, item details, Block out time, and Settings. Steps on bb1 M2 routes skip while those routes are missing.
import { test, expect } from '@playwright/test'
import { fresh, tap, type, api, shot, shopToken, signInThroughPage, needsRoute } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => {
  await fresh(context, request)
  expect((await api(request, 'POST', '/api/test/seed', {})).status).toBe(200)
})

const phone = (testInfo) => testInfo.project.name.endsWith('390')

test('pending on top, Today by bay, Week, and item details', async ({ page, request }, testInfo) => {
  const token = await shopToken(request)
  const board = (await api(request, 'GET', '/api/shop/board?days=7', null, { Authorization: `Bearer ${token}` })).body

  await signInThroughPage(page)
  await expect(page.locator('#pending-count')).toHaveText(String(board.pending.length))
  await expect(page.locator('.pending article.req')).toHaveCount(board.pending.length)
  const offered = board.pending.find((r) => r.status === 'offered')
  await expect(page.locator('.pending article.req[data-status="offered"]')).toContainText(`Offered ${offered.offer.label}`)
  await shot(page, testInfo, 'shop-pending')

  // Today is Mon Sep 14 (nothing booked); the next day has the seeded jobs.
  await expect(page.locator('#board-range')).toHaveText('Mon Sep 14')
  await tap(page, page.getByRole('button', { name: 'Next day' }), 'Next day')
  await expect(page.locator('#board-range')).toHaveText('Tue Sep 15')
  const tue = board.days.find((d) => d.date === '2026-09-15')
  const truck = tue.items.find((it) => it.kind === 'request' && it.request.service.id === 'truck-rv').request
  const truckItem = (bay) => page.locator(`[data-bay-col="${bay}"] .item[data-item="${truck.id}"]`)
  if (phone(testInfo)) {
    // One bay at a time on a phone: bay 1 shows first; the truck job also holds bay 2.
    await expect(page.locator('.bayseg')).toBeVisible()
    await expect(truckItem(2)).toBeHidden()
    await tap(page, page.locator('.bayseg button[data-bay="2"]'), 'Bay 2')
    await expect(truckItem(2)).toBeVisible()
    await expect(truckItem(1)).toBeHidden()
  } else {
    await expect(page.locator('.bayseg')).toBeHidden()
    for (const bay of truck.bays) await expect(truckItem(bay)).toBeVisible()
  }
  await expect(page.locator('.item[data-status="block"]').first()).toBeAttached()
  await shot(page, testInfo, 'shop-today')

  const item = phone(testInfo) ? truckItem(2) : truckItem(truck.bays[0])
  await tap(page, item, 'truck job on the board')
  const menu = page.locator('#item-menu article.req')
  await expect(menu).toContainText(truck.customer.name)
  await expect(menu.locator('.chip')).toHaveText('Confirmed')
  await expect(menu.getByRole('button', { name: 'Send to Shop Board' })).toBeVisible()
  await shot(page, testInfo, 'shop-item')
  await tap(page, menu.getByRole('button', { name: 'Close' }), 'Close')
  await expect(page.locator('#item-menu')).toHaveCount(0)

  await tap(page, page.getByRole('tab', { name: 'Week' }), 'Week')
  await expect(page.locator('.wday')).toHaveCount(7)
  const itemsInWeek = board.days.reduce((n, d) => n + d.items.length, 0)
  // The board is one week from Tue Sep 15 now, so count that range from the API too.
  const week = (await api(request, 'GET', '/api/shop/board?date=2026-09-15&days=7', null, { Authorization: `Bearer ${token}` })).body
  await expect(page.locator('.witem')).toHaveCount(week.days.reduce((n, d) => n + d.items.length, 0))
  expect(itemsInWeek).toBeGreaterThan(0)
  await shot(page, testInfo, 'shop-week')
})

test('Send to Shop Board says plainly when it is not set up', async ({ page, request }, testInfo) => {
  await needsRoute(request, 'POST', '/api/shop/requests/r_0000000000000000/push', 'POST /api/shop/requests/:id/push')
  const token = await shopToken(request)
  const board = (await api(request, 'GET', '/api/shop/board?date=2026-09-15&days=1', null, { Authorization: `Bearer ${token}` })).body
  const confirmed = board.days[0].items.find((it) => it.kind === 'request' && it.request.status === 'confirmed').request
  await signInThroughPage(page)
  await tap(page, page.getByRole('button', { name: 'Next day' }), 'Next day')
  if (phone(testInfo)) await tap(page, page.locator(`.bayseg button[data-bay="${confirmed.bays[0]}"]`), 'bay')
  await tap(page, page.locator(`[data-bay-col="${confirmed.bays[0]}"] .item[data-item="${confirmed.id}"]`), 'confirmed job')
  const menu = page.locator('#item-menu article.req')
  const pushed = page.waitForResponse((r) => r.url().endsWith(`/api/shop/requests/${confirmed.id}/push`))
  await tap(page, menu.getByRole('button', { name: 'Send to Shop Board' }), 'Send to Shop Board')
  const res = await pushed
  const body = await res.json()
  if (res.status() === 501) await expect(page.locator('#item-menu .alert')).toHaveText(body.error)
  else expect(res.status(), JSON.stringify(body)).toBe(200)
})

test('Block out time adds a walk-in block to the board', async ({ page, request }, testInfo) => {
  await signInThroughPage(page)
  await tap(page, page.getByRole('button', { name: 'Block out time' }), 'Block out time')
  const form = page.locator('#block-form')
  await expect(form).toBeVisible()
  await shot(page, testInfo, 'shop-block-form')
  await needsRoute(request, 'POST', '/api/shop/blocks', 'POST /api/shop/blocks')
  await form.locator('#bf-time').selectOption('14:00')
  await form.locator('#bf-end').selectOption('15:00')
  await tap(page, form.getByRole('button', { name: 'Block out this time' }), 'Block out this time')
  await expect(form).toHaveCount(0)
  await expect(page.locator('.item[data-status="block"]', { hasText: '2:00 PM to 3:00 PM' }).first()).toBeAttached()
})

test('Settings load, save, and show the API refusal inline', async ({ page, request }, testInfo) => {
  await needsRoute(request, 'GET', '/api/shop/settings', 'GET/PUT /api/shop/settings')
  await signInThroughPage(page)
  await tap(page, page.getByRole('tab', { name: 'Settings' }), 'Settings')
  await expect(page.getByRole('heading', { name: 'Opening hours' })).toBeVisible()
  await shot(page, testInfo, 'shop-settings')

  // Refused: bookings sit on bay 3 from Tue Sep 15, so 2 bays is not allowed.
  await page.locator('#s-bays').selectOption('2')
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/shop/settings') && r.request().method() === 'PUT')
  await tap(page, page.locator('#settings-save'), 'Save settings')
  const refused = await saved
  const body = await refused.json()
  expect(refused.status(), JSON.stringify(body)).toBe(409)
  await expect(page.locator('[data-section="rules"] .alert')).toHaveText(body.error)

  // Accepted: Saturday closed.
  await page.locator('#s-bays').selectOption('3')
  await tap(page, page.locator('.hours-row[data-day="6"] input[type="checkbox"]'), 'Saturday Closed')
  const ok = page.waitForResponse((r) => r.url().endsWith('/api/shop/settings') && r.request().method() === 'PUT')
  await tap(page, page.locator('#settings-save'), 'Save settings')
  expect((await ok).status()).toBe(200)
  await expect(page.locator('#settings-saved')).toHaveText('Saved.')
  await page.goto('/')
  await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change')
  await expect(page.locator('button.day', { hasText: 'Sep 19' })).toContainText('Closed Saturdays')
})
