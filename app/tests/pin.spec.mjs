// Shop sign-in: a wrong PIN is refused on screen AND by the server (401), the right one signs in and out.
import { test, expect } from '@playwright/test'
import { fresh, tap, type, shot, PIN } from './helpers.mjs'

test.beforeEach(async ({ context, request }) => fresh(context, request))

const signinResponse = (page) => page.waitForResponse((r) => new URL(r.url()).pathname === '/api/shop/signin' && r.request().method() === 'POST')

test('a wrong PIN shows "That PIN is not right." and the sign-in answers 401', async ({ page }, testInfo) => {
  await page.goto('/shop/')
  await expect(page.locator('[data-sample]')).toBeVisible()
  await shot(page, testInfo, 'shop-signin')
  await type(page, page.locator('#pin'), '1111')
  const response = signinResponse(page)
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  expect((await response).status()).toBe(401)
  await expect(page.locator('#signin-error')).toHaveText('That PIN is not right.')
  await expect(page.locator('#nav')).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('book-a-bay:shop-token'))).toBeNull()
  await shot(page, testInfo, 'shop-signin-wrong')
})

test('the right PIN signs in, keeps the token, and Sign out ends it', async ({ page }) => {
  await page.goto('/shop/')
  await type(page, page.locator('#pin'), PIN)
  const response = signinResponse(page)
  await tap(page, page.locator('#signin-btn'), 'Sign in')
  expect((await response).status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('book-a-bay:shop-token'))).toMatch(/^[A-Za-z0-9_-]{32,}$/)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toBeVisible()

  await tap(page, page.locator('#signout'), 'Sign out')
  await expect(page.locator('#signin-btn')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('book-a-bay:shop-token'))).toBeNull()
})
