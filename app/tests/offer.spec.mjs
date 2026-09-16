// The shop offers another time from its card; the customer sees New time offered, accepts, and is Confirmed.
import { test, expect } from '@playwright/test'
import { fresh, tap, type, shot, newContext, signInThroughPage, bookThroughPage } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

test('shop offers another time → customer accepts → Confirmed', async ({ page, browser }, testInfo) => {
  const link = await bookThroughPage(page)

  const shopContext = await newContext(browser, testInfo)
  const shop = await shopContext.newPage()
  await signInThroughPage(shop)
  const card = shop.locator('.pending article.req', { hasText: 'Pat Sample (sample)' })
  await tap(shop, card.getByRole('button', { name: 'Offer another time' }), 'Offer another time')
  await tap(shop, card.locator('.picker button.day', { hasText: 'Sep 16' }), 'Wed Sep 16')
  await tap(shop, card.locator('.picker button.time[data-time="14:00"]'), '2:00 PM')
  await type(shop, card.locator('input[data-note]'), 'Tuesday is full. Wednesday afternoon works.')
  await shot(shop, testInfo, 'shop-offer')
  await tap(shop, card.getByRole('button', { name: 'Offer Wed Sep 16, 2:00 PM' }), 'Offer Wed Sep 16, 2:00 PM')
  const done = shop.locator('.recent article.req', { hasText: 'Pat Sample (sample)' })
  await expect(done.locator('.chip')).toHaveText('New time offered')
  await expect(done.locator('.text-row', { hasText: 'Text with the new time' }).locator('p')).toContainText(link)
  await shopContext.close()

  await page.goto(link)
  await expect(page.locator('#status-pill')).toHaveText('New time offered')
  await expect(page.locator('.offer')).toContainText('Wed Sep 16, 2:00 PM')
  await expect(page.locator('.shop-note')).toContainText('Wednesday afternoon works.')
  await shot(page, testInfo, 'status-offered')
  await tap(page, page.getByRole('button', { name: 'Accept this time' }), 'Accept this time')
  await expect(page.locator('#status-pill')).toHaveText('Confirmed')
  await expect(page.locator('.details')).toContainText('Wed Sep 16, 2:00 PM')
})
