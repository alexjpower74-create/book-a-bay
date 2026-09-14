// The race from the customer's side: settings leave one slot on Tuesday, two customers pick it, the second to send sees
// "just taken" and exactly three alternatives, and one tap on an alternative books straight through.
import { test, expect } from '@playwright/test'
import { fresh, tap, type, api, shot, shopToken, newContext } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

async function toDetails(page, name) {
  await page.goto('/')
  await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change')
  await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15')
  await expect(page.locator('button.time')).toHaveCount(1)
  await tap(page, page.locator('button.time[data-time="08:00"]'), '8:00 AM')
  await type(page, page.locator('#f-name'), name)
  await type(page, page.locator('#f-phone'), '709-555-0142')
  await type(page, page.locator('#f-make'), 'Ford')
}

test('the second customer to send sees "just taken" and three alternatives', async ({ page, browser, request }, testInfo) => {
  const token = await shopToken(request)
  const auth = { Authorization: `Bearer ${token}` }
  const settings = (await api(request, 'GET', '/api/shop/settings', null, auth)).body
  // One bay, one booking per start, Tuesdays 8:00 to 8:30: Tue Sep 15 has exactly one oil change slot.
  // A one-bay shop cannot keep a two-bay service, so the truck service drops to one bay here.
  const services = settings.services.map((s) => ({ ...s, bays_needed: 1 }))
  const saved = await api(request, 'PUT', '/api/shop/settings', { ...settings, services, bays: 1, max_per_slot: 1, hours: { ...settings.hours, 2: { open: '08:00', close: '08:30' } } }, auth)
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)

  const other = await newContext(browser, testInfo)
  const second = await other.newPage()
  await toDetails(page, 'Lee Sample (sample)')
  await toDetails(second, 'Kim Sample (sample)')

  await tap(page, page.locator('#send'), 'first Send request')
  await expect(page.getByRole('heading', { name: 'Request sent' })).toBeVisible()

  await tap(second, second.locator('#send'), 'second Send request')
  await expect(second.getByText('Sorry, that time was just taken. Here are the next three:')).toBeVisible()
  const alts = second.locator('.taken .alts button')
  await expect(alts).toHaveCount(3)
  await shot(second, testInfo, 'book-taken')

  const label = (await alts.first().innerText()).trim()
  await tap(second, alts.first(), `alternative ${label}`)
  await expect(second.locator('[data-when]')).toHaveText(label)
  await tap(second, second.locator('#send'), 'Send request at the alternative')
  await expect(second.getByRole('heading', { name: 'Request sent' })).toBeVisible()
  await other.close()
})
