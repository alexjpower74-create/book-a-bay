// Shop screens against the real Worker on the seeded SAMPLE week: pending on top, Today by bay (segmented at 390), Week,
// item details, Send to Shop Board (501 without SHOP_BOARD_URL), decline with a note, cancel a confirmed booking,
// Block out time create and remove, Settings refusal and save, and Change PIN.
import { test, expect } from '@playwright/test'
import { fresh, tap, type, api, shot, shopToken, signInThroughPage, signOutThroughPage } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => {
  await fresh(context, request)
  expect((await api(request, 'POST', '/api/test/seed', {})).status).toBe(200)
})

const phone = (testInfo) => testInfo.project.name.endsWith('390')

async function boardFromApi(request, query) {
  const token = await shopToken(request)
  return (await api(request, 'GET', `/api/shop/board?${query}`, null, { Authorization: `Bearer ${token}` })).body
}

// Open a request or block on the Today grid; on a phone, pick its bay first. Waits for the day to be the one asked for,
// so a tap never lands on a board that is about to be redrawn.
async function openItem(page, testInfo, id, bay, dayLabel = 'Tue Sep 15') {
  await expect(page.locator('#board-range')).toHaveText(dayLabel)
  if (phone(testInfo)) await tap(page, page.locator(`.bayseg button[data-bay="${bay}"]`), `Bay ${bay}`)
  await tap(page, page.locator(`[data-bay-col="${bay}"] .item[data-item="${id}"]`), `board item ${id}`)
}

test('pending on top, Today by bay, Week, and item details', async ({ page, request }, testInfo) => {
  const board = await boardFromApi(request, 'days=7')

  await signInThroughPage(page)
  await expect(page.locator('#pending-count')).toHaveText(String(board.pending.length))
  await expect(page.locator('.pending article.req')).toHaveCount(board.pending.length)
  await expect(page.locator('.pending .text-row')).toHaveCount(0)
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

  await tap(page, phone(testInfo) ? truckItem(2) : truckItem(truck.bays[0]), 'truck job on the board')
  const menu = page.locator('#item-menu article.req')
  await expect(menu).toContainText(truck.customer.name)
  await expect(menu.locator('.chip')).toHaveText('Confirmed')
  await expect(menu.getByRole('button', { name: 'Send to Shop Board' })).toBeVisible()
  await shot(page, testInfo, 'shop-item')
  await tap(page, menu.getByRole('button', { name: 'Close' }), 'Close')
  await expect(page.locator('#item-menu')).toHaveCount(0)

  await tap(page, page.getByRole('tab', { name: 'Week' }), 'Week')
  await expect(page.locator('.wday')).toHaveCount(7)
  const week = await boardFromApi(request, 'date=2026-09-15&days=7')
  await expect(page.locator('.witem')).toHaveCount(week.days.reduce((n, d) => n + d.items.length, 0))
  await shot(page, testInfo, 'shop-week')
})

test('Send to Shop Board shows the not-connected message (no SHOP_BOARD_URL)', async ({ page, request }, testInfo) => {
  const board = await boardFromApi(request, 'date=2026-09-15&days=1')
  const confirmed = board.days[0].items.find((it) => it.kind === 'request' && it.request.status === 'confirmed').request
  await signInThroughPage(page)
  await tap(page, page.getByRole('button', { name: 'Next day' }), 'Next day')
  await openItem(page, testInfo, confirmed.id, confirmed.bays[0])
  const menu = page.locator('#item-menu article.req')
  const pushed = page.waitForResponse((r) => r.url().endsWith(`/api/shop/requests/${confirmed.id}/push`))
  await tap(page, menu.getByRole('button', { name: 'Send to Shop Board' }), 'Send to Shop Board')
  const res = await pushed
  expect(res.status()).toBe(501)
  await expect(page.locator('#item-menu .alert')).toHaveText('Shop Board is not connected yet. Use "Download for Shop Board" instead.')
})

test('Decline with a note: the customer sees Declined and the note', async ({ page, request }) => {
  const board = await boardFromApi(request, 'days=7')
  const target = board.pending.find((r) => r.status === 'requested')
  await signInThroughPage(page)
  const card = page.locator(`.pending article.req[data-id="${target.id}"]`)
  await tap(page, card.getByRole('button', { name: 'Decline', exact: true }), 'Decline')
  await type(page, card.locator('input[data-note]'), 'We are short a mechanic that day.')
  await tap(page, card.getByRole('button', { name: 'Decline request' }), 'Decline request')
  const done = page.locator(`.recent article.req[data-id="${target.id}"]`)
  await expect(done.locator('.chip')).toHaveText('Declined')
  await expect(done.locator('.text-row', { hasText: 'Text to decline' }).locator('p')).toContainText('We are short a mechanic that day.')
  await expect(card).toHaveCount(0)

  await page.goto(target.status_url)
  await expect(page.locator('#status-pill')).toHaveText('Declined')
  await expect(page.locator('.shop-note')).toContainText('We are short a mechanic that day.')
})

test('Cancel a confirmed booking from the board frees its time', async ({ page, request }, testInfo) => {
  const board = await boardFromApi(request, 'date=2026-09-15&days=1')
  const confirmed = board.days[0].items.find((it) => it.kind === 'request' && it.request.status === 'confirmed').request
  await signInThroughPage(page)
  await tap(page, page.getByRole('button', { name: 'Next day' }), 'Next day')
  await openItem(page, testInfo, confirmed.id, confirmed.bays[0])
  const menu = page.locator('#item-menu article.req')
  await tap(page, menu.getByRole('button', { name: 'Cancel booking' }), 'Cancel booking')
  await type(page, menu.locator('input[data-note]'), 'Customer called to cancel.')
  await tap(page, menu.getByRole('button', { name: 'Cancel booking' }), 'Cancel booking (confirm)')
  await expect(page.locator(`.recent article.req[data-id="${confirmed.id}"] .chip`)).toHaveText('Cancelled')
  await expect(page.locator(`.item[data-item="${confirmed.id}"]`)).toHaveCount(0)

  await page.goto(confirmed.status_url)
  await expect(page.locator('#status-pill')).toHaveText('Cancelled')
})

test('Block out time: create a walk-in block, then remove it', async ({ page }, testInfo) => {
  await signInThroughPage(page)
  await tap(page, page.getByRole('button', { name: 'Block out time' }), 'Block out time')
  const form = page.locator('#block-form')
  await expect(form).toBeVisible()
  await shot(page, testInfo, 'shop-block-form')
  // Native selects: selectOption is Playwright's way to pick from a native list (there is no drawn list to tap).
  await form.locator('#bf-time').selectOption('14:00')
  await form.locator('#bf-end').selectOption('15:00')
  const made = page.waitForResponse((r) => r.url().endsWith('/api/shop/blocks') && r.request().method() === 'POST')
  await tap(page, form.getByRole('button', { name: 'Block out this time' }), 'Block out this time')
  expect((await made).status()).toBe(201)
  await expect(form).toHaveCount(0)
  const block = page.locator('[data-bay-col="1"] .item[data-status="block"]', { hasText: '2:00 PM to 3:00 PM' })
  await expect(block).toBeVisible()

  await tap(page, block, 'the new block')
  await tap(page, page.locator('#item-menu').getByRole('button', { name: 'Remove this block' }), 'Remove this block')
  await expect(page.locator('.item[data-status="block"]', { hasText: '2:00 PM to 3:00 PM' })).toHaveCount(0)
  await expect(page.locator('#item-menu')).toHaveCount(0)
})

test('Settings: the API refusal shows inline, then a save closes Saturdays for customers', async ({ page }, testInfo) => {
  await signInThroughPage(page)
  await tap(page, page.getByRole('tab', { name: 'Settings' }), 'Settings')
  await expect(page.getByRole('heading', { name: 'Opening hours' })).toBeVisible()
  await shot(page, testInfo, 'shop-settings')

  // Refused: the seeded walk-in block holds bay 3 on Tue Sep 15, so 2 bays is not allowed.
  await page.locator('#s-bays').selectOption('2')
  const refusedWait = page.waitForResponse((r) => r.url().endsWith('/api/shop/settings') && r.request().method() === 'PUT')
  await tap(page, page.locator('#settings-save'), 'Save settings')
  const refused = await refusedWait
  const body = await refused.json()
  expect(refused.status(), JSON.stringify(body)).toBe(409)
  expect(body.code).toBe('bays_in_use')
  await expect(page.locator('[data-section="rules"] .alert')).toHaveText(body.error)

  await page.locator('#s-bays').selectOption('3')
  await tap(page, page.locator('.hours-row[data-day="6"] input[type="checkbox"]'), 'Saturday Closed')
  const okWait = page.waitForResponse((r) => r.url().endsWith('/api/shop/settings') && r.request().method() === 'PUT')
  await tap(page, page.locator('#settings-save'), 'Save settings')
  expect((await okWait).status()).toBe(200)
  await expect(page.locator('#settings-saved')).toHaveText('Saved.')
  await expect(page.locator('[data-section="rules"] .alert')).toHaveCount(0)

  await page.goto('/')
  await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change')
  await expect(page.locator('button.day', { hasText: 'Sep 19' })).toContainText('Closed Saturdays')
})

test('Change PIN: a wrong current PIN is refused, then the new PIN signs in', async ({ page }) => {
  await signInThroughPage(page)
  await tap(page, page.getByRole('tab', { name: 'Settings' }), 'Settings')
  const form = page.locator('#pin-form')
  await type(page, form.locator('#pin-current'), '1111')
  await type(page, form.locator('#pin-next'), '1357')
  await tap(page, form.getByRole('button', { name: 'Change PIN' }), 'Change PIN')
  await expect(form.locator('.alert')).toHaveText('That PIN is not right.')

  await tap(page, form.locator('#pin-current'), 'current PIN')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('2468')
  await tap(page, form.getByRole('button', { name: 'Change PIN' }), 'Change PIN again')
  await expect(form.locator('.okmsg')).toContainText('PIN changed.')

  await signOutThroughPage(page)
  await expect(page.locator('#signin-btn')).toBeVisible()
  await type(page, page.locator('#pin'), '2468')
  await tap(page, page.locator('#signin-btn'), 'Sign in with the old PIN')
  await expect(page.locator('#signin-error')).toHaveText('That PIN is not right.')
  await type(page, page.locator('#pin'), '1357')
  await tap(page, page.locator('#signin-btn'), 'Sign in with the new PIN')
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible()
})
