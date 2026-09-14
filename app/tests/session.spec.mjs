// Shop session edges. A 401 from the PIN form keeps the form only when it is the wrong current PIN (field: current);
// any other 401 means the session is gone and signs out (clarification 21). A confirmed booking already sent to Shop Board
// says when (clarification 22).
import { test, expect } from '@playwright/test'
import { fresh, tap, type, api, shopToken, signInThroughPage } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

test('Change PIN after the session ended elsewhere signs out instead of blaming the PIN', async ({ page, request }) => {
  await signInThroughPage(page)
  await tap(page, page.getByRole('tab', { name: 'Settings' }), 'Settings')
  const form = page.locator('#pin-form')
  await expect(form).toBeVisible()

  // The session ends somewhere else (another device signing out with it).
  const pageToken = await page.evaluate(() => localStorage.getItem('book-a-bay:shop-token'))
  expect((await api(request, 'POST', '/api/shop/signout', {}, { Authorization: `Bearer ${pageToken}` })).status).toBe(200)

  await type(page, form.locator('#pin-current'), '2468')
  await type(page, form.locator('#pin-next'), '1357')
  const waited = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/shop/pin')
  await tap(page, form.getByRole('button', { name: 'Change PIN' }), 'Change PIN')
  const res = await waited
  const body = await res.json()
  expect(res.status()).toBe(401)
  expect(body.field).toBeUndefined()
  await expect(page.locator('#signin-btn')).toBeVisible()
  await expect(page.locator('#signin-error')).toHaveText(body.error)
  expect(await page.evaluate(() => localStorage.getItem('book-a-bay:shop-token'))).toBeNull()
})

test('a confirmed booking already sent to Shop Board says when it went', async ({ page, request }, testInfo) => {
  expect((await api(request, 'POST', '/api/test/seed', {})).status).toBe(200)
  const token = await shopToken(request)
  const board = (await api(request, 'GET', '/api/shop/board?date=2026-09-15&days=1', null, { Authorization: `Bearer ${token}` })).body
  const confirmed = board.days[0].items.find((it) => it.kind === 'request' && it.request.status === 'confirmed').request

  // The test Worker has no Shop Board to send to (its 501 is tested in shop.spec), so only pushed_at is added to the real
  // board response here; everything else the page shows is the Worker's own answer.
  await page.route('**/api/shop/board?*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    for (const day of json.days) for (const it of day.items) if (it.kind === 'request' && it.request.id === confirmed.id) it.request.pushed_at = '2026-09-14T11:42:00.000Z'
    await route.fulfill({ response, json })
  })

  await signInThroughPage(page)
  await tap(page, page.getByRole('button', { name: 'Next day' }), 'Next day')
  await expect(page.locator('#board-range')).toHaveText('Tue Sep 15')
  if (testInfo.project.name.endsWith('390')) await tap(page, page.locator(`.bayseg button[data-bay="${confirmed.bays[0]}"]`), 'bay')
  await tap(page, page.locator(`[data-bay-col="${confirmed.bays[0]}"] .item[data-item="${confirmed.id}"]`), 'confirmed job')
  await expect(page.locator('#item-menu [data-pushed]')).toHaveText('Sent to Shop Board Mon Sep 14, 9:12 AM')
})
