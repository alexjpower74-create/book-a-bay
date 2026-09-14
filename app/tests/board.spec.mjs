// Board behaviour: the 15 s poll never redraws an open Offer picker (fake timers), Download for Shop Board saves real
// JSON and CSV files, and on the seeded week the Today board is reachable (within two screens), the header stays one row,
// and time labels stay on one line.
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fresh, tap, api, signInThroughPage } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => {
  await fresh(context, request)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const booking = (name, time, ip) => ({ service: 'oil', date: '2026-09-15', time, name, phone: '709-555-0142', make: 'Toyota', _ip: ip })
async function book(request, b) {
  const { _ip, ...body } = b
  const r = await api(request, 'POST', '/api/requests', body, { 'X-Test-IP': _ip })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
}
const boardPoll = (page) => page.waitForResponse((r) => new URL(r.url()).pathname === '/api/shop/board')

test('the board poll does not redraw an open Offer picker', async ({ page, request }) => {
  await page.clock.install()
  await book(request, booking('Pat Sample (sample)', '10:00', '10.0.0.1'))
  await signInThroughPage(page)
  const card = page.locator('.pending article.req', { hasText: 'Pat Sample (sample)' })
  await tap(page, card.getByRole('button', { name: 'Offer another time' }), 'Offer another time')
  await tap(page, card.locator('.picker button.day', { hasText: 'Sep 16' }), 'Wed Sep 16')
  await expect(card.locator('.picker button.day[aria-pressed="true"]')).toContainText('Sep 16')
  // The picker's own load (the times for that day) redraws it once; take hold of it after that.
  await expect(card.locator('.picker button.time').first()).toBeVisible()
  const picker = await card.locator('.picker').elementHandle()

  // Another customer books while the shop is choosing, so the next poll has something new to draw.
  await book(request, booking('Kim Sample (sample)', '11:00', '10.0.0.2'))
  const polled = boardPoll(page)
  await page.clock.runFor(16_000)
  await polled
  await sleep(500)
  expect(await picker.evaluate((el) => el.isConnected), 'the open picker is the same element after the poll').toBe(true)
  await expect(card.locator('.picker button.day[aria-pressed="true"]')).toContainText('Sep 16')
  await expect(page.locator('.pending article.req', { hasText: 'Kim Sample (sample)' })).toHaveCount(0)

  // Once the picker closes, the next poll does draw: the poll above really ran with new data.
  await tap(page, card.getByRole('button', { name: 'Never mind' }), 'Never mind')
  const polledAgain = boardPoll(page)
  await page.clock.runFor(16_000)
  await polledAgain
  await expect(page.locator('.pending article.req', { hasText: 'Kim Sample (sample)' })).toBeVisible()
})

test('Download for Shop Board saves the JSON patches and the CSV', async ({ page, request }) => {
  expect((await api(request, 'POST', '/api/test/seed', {})).status).toBe(200)
  await signInThroughPage(page)
  await tap(page, page.getByRole('tab', { name: 'Week' }), 'Week')
  await expect(page.locator('#board-range')).toHaveText('Mon Sep 14 to Sun Sep 20')

  const jsonDownload = page.waitForEvent('download')
  await tap(page, page.getByRole('button', { name: 'Download for Shop Board (JSON)' }), 'Download JSON')
  const json = await jsonDownload
  expect(json.suggestedFilename()).toBe('shop-board-2026-09-14-to-2026-09-20.json')
  const data = JSON.parse(await readFile(await json.path(), 'utf8'))
  expect(data.format).toBe('shop-board-patches/v1')
  expect(data.items.length).toBeGreaterThan(0)
  for (const item of data.items) expect(item.id).toMatch(/^bab-/)

  const csvDownload = page.waitForEvent('download')
  await tap(page, page.getByRole('button', { name: 'CSV', exact: true }), 'Download CSV')
  const csv = await csvDownload
  expect(csv.suggestedFilename()).toBe('shop-board-2026-09-14-to-2026-09-20.csv')
  const lines = (await readFile(await csv.path(), 'utf8')).trim().split(/\r?\n/)
  expect(lines[0]).toBe('id,date,slot,bay,name,phone,year,make,model,issue,estTime')
  expect(lines.length - 1).toBe(data.items.length)
})

test('with the seeded week the Today board is within two screens, the header is one row, time labels one line', async ({ page, request }) => {
  expect((await api(request, 'POST', '/api/test/seed', {})).status).toBe(200)
  await signInThroughPage(page)
  await expect(page.locator('.pending article.req')).toHaveCount(4)

  const { top, screen } = await page.locator('.baycol.is-shown').evaluate((el) => ({ top: el.getBoundingClientRect().top + window.scrollY, screen: window.innerHeight }))
  expect(top, `first bay column starts at ${Math.round(top)} px; two screens are ${2 * screen} px`).toBeLessThanOrEqual(2 * screen)

  for (const toggle of await page.locator('.pending .texts-toggle').all()) {
    expect((await toggle.boundingBox()).height, 'Texts to send is a 44 px tap target').toBeGreaterThanOrEqual(44)
  }

  const h1 = await page.locator('.shop-bar h1').boundingBox()
  const nav = await page.locator('#nav').boundingBox()
  expect(Math.abs(h1.y + h1.height / 2 - (nav.y + nav.height / 2)), 'brand and Board/Settings share one header row').toBeLessThan(12)
  expect((await page.locator('.shop-bar').boundingBox()).height, 'header is one row').toBeLessThan(80)

  const lines = await page.locator('.tlabel').evaluateAll((els) =>
    els.filter((el) => el.textContent.trim()).map((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return { text: el.textContent.trim(), lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size }
    }),
  )
  expect(lines.length).toBeGreaterThan(0)
  for (const l of lines) expect(l.lines, `time label "${l.text}" is on one line`).toBe(1)
})
