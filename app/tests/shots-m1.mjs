// M1 smoke + screenshots for the customer page and the status page, driven against the in-browser mock (?mock=1)
// because bb1's Worker is not on this branch yet. This is NOT the Playwright suite: the M2 specs run against the
// real Worker. Real input only: every tap goes through tap(), which hit-tests the target's centre with
// elementFromPoint first; typing is page.keyboard. Nothing sets page state with evaluate (it only reads).
// Usage (from app/): node tests/shots-m1.mjs [--engine chromium|webkit|all] [--no-shots]
// Screenshots (chromium only) go to tests/shots/<name>-<390|1280>.png. Exit 1 on any FAIL.
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 7301
const BASE = `http://127.0.0.1:${PORT}`
const SHOP = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'
const args = process.argv.slice(2)
const engineArg = args.includes('--engine') ? args[args.indexOf('--engine') + 1] : 'all'
const SHOTS = !args.includes('--no-shots')
const T = 6000

let failures = 0
let passes = 0

/* ---- server ------------------------------------------------------------- */
async function up() {
  try { return (await fetch(BASE + '/')).ok } catch { return false }
}
let server = null
if (!(await up())) {
  server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: APP, stdio: 'ignore' })
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100))
  if (!(await up())) { console.error(`FAIL could not start serve.mjs on ${PORT}`); process.exit(1) }
}

/* ---- helpers ------------------------------------------------------------ */
function check(name, ok, detail = '') {
  if (ok) passes++
  else failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) throw new Error(`check failed: ${name}`)
}

async function tap(page, loc, label, touch) {
  await loc.waitFor({ state: 'visible', timeout: T })
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = await loc.evaluate((el, [px, py]) => {
    const t = document.elementFromPoint(px, py)
    return t === el || el.contains(t) ? '' : t ? t.outerHTML.slice(0, 140) : 'nothing'
  }, [x, y])
  if (hit) {
    failures++
    console.log(`  FAIL tap(${label}) hit-test: centre ${Math.round(x)},${Math.round(y)} lands on ${hit}`)
    throw new Error(`tap(${label}) is covered`)
  }
  if (touch) await page.touchscreen.tap(x, y)
  else await page.mouse.click(x, y)
}

async function typeInto(page, sel, text, touch) {
  await tap(page, page.locator(sel), sel, touch)
  await page.keyboard.type(text)
}

const see = (page, text) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: T })

async function tall(page, loc, label, size) {
  if (size !== 390) return
  const box = await loc.boundingBox()
  check(`${label} is at least 44 px tall at 390`, box.height >= 44, `${Math.round(box.height)} px`)
}

async function badge(page) {
  await page.locator('[data-sample]').waitFor({ state: 'visible', timeout: T })
  check('SAMPLE badge visible', (await page.locator('[data-sample]').innerText()).trim() === 'SAMPLE')
  check('shop name shown', (await page.locator('[data-shop-name]').innerText()).trim() === SHOP)
}

/* ---- scenarios ---------------------------------------------------------- */
const scenarios = {
  async journey(page, { touch, size, shot, engine }) {
    await page.goto(`${BASE}/?mock=1`)
    await see(page, 'Pick a service')
    await badge(page)
    await shot('book-1-service')

    await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change', touch)
    await see(page, 'Pick a day')
    const sunday = page.locator('button.day', { hasText: 'Sep 20' })
    check('Sunday chip is disabled', await sunday.isDisabled())
    check('Sunday chip says Closed Sundays', (await sunday.innerText()).includes('Closed Sundays'))
    const full = page.locator('button.day', { hasText: 'Sep 19' })
    check('fully booked Saturday says Full and is disabled', (await full.innerText()).includes('Full') && (await full.isDisabled()))
    check('closure shows its reason', (await page.locator('button.day', { hasText: 'Sep 21' }).innerText()).includes('Staff training (sample)'))
    check('14 day chips', (await page.locator('button.day').count()) === 14)
    await shot('book-2-day')

    await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15', touch)
    await see(page, 'Pick a time')
    await page.locator('button.time').first().waitFor({ timeout: T })
    check('time buttons listed', (await page.locator('button.time').count()) > 0)
    await shot('book-3-time')

    await tap(page, page.locator('button.time', { hasText: '10:00 AM' }), '10:00 AM', touch)
    await see(page, 'Your details')
    const send = page.locator('#send')
    await tall(page, send, 'Send request', size)
    await tap(page, send, 'Send request (empty)', touch)
    await see(page, 'Please enter your name.')
    check('phone error shown', await page.locator('#e-phone').isVisible())
    check('make error shown', await page.locator('#e-make').isVisible())
    await shot('book-4-details-errors')

    await typeInto(page, '#f-name', 'Pat Sample (sample)', touch)
    check('name error clears while typing', await page.locator('#e-name').isHidden())
    await typeInto(page, '#f-phone', '709-555-0142', touch)
    await typeInto(page, '#f-year', '2016', touch)
    await typeInto(page, '#f-make', 'Toyota', touch)
    await typeInto(page, '#f-model', 'Corolla', touch)
    await typeInto(page, '#f-note', 'Squeak from the front left when braking.', touch)
    await shot('book-4-details')
    await tap(page, send, 'Send request', touch)

    await see(page, 'Request sent')
    await see(page, 'The shop will confirm your time. Keep this link to check on it.')
    const link = await page.locator('#status-link').inputValue()
    check('status link is shown', /\/r\/\?t=[A-Za-z0-9_-]{32,}$/.test(link), link)
    const copy = page.getByRole('button', { name: 'Copy link' })
    await tall(page, copy, 'Copy link', size)
    await tap(page, copy, 'Copy link', touch)
    if (engine === 'chromium') {
      await page.getByRole('button', { name: 'Copied' }).waitFor({ timeout: T })
      check('clipboard holds the status link', (await page.evaluate(() => navigator.clipboard.readText())) === link)
    } else {
      await page.locator('#copy-note').filter({ hasText: /copied|copy it/ }).waitFor({ timeout: T })
      check('copy gives feedback', true)
    }
    await shot('book-5-sent')

    await tap(page, page.getByRole('link', { name: 'Check on your request' }), 'Check on your request', touch)
    await page.locator('#status-pill').waitFor({ timeout: T })
    check('status page says Requested', (await page.locator('#status-pill').innerText()).trim() === 'Requested')
    await badge(page)
    check('details show the vehicle', (await page.locator('.details').innerText()).includes('2016 Toyota Corolla'))
    check('details show the time', (await page.locator('.details').innerText()).includes('Tue Sep 15, 10:00 AM'))
    await shot('status-requested')

    await tap(page, page.getByRole('button', { name: 'Cancel my request' }), 'Cancel my request', touch)
    await tap(page, page.getByRole('button', { name: 'Yes, cancel it' }), 'Yes, cancel it', touch)
    await page.locator('#status-pill', { hasText: 'Cancelled' }).waitFor({ timeout: T })
    check('cancel reaches Cancelled', true)
    await shot('status-cancelled')
  },

  async taken(page, { touch, shot }) {
    await page.goto(`${BASE}/?mock=1&taken=1`)
    await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change', touch)
    await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15', touch)
    await tap(page, page.locator('button.time', { hasText: '10:00 AM' }), '10:00 AM', touch)
    await typeInto(page, '#f-name', 'Sam Sample (sample)', touch)
    await typeInto(page, '#f-phone', '709 555 0199', touch)
    await typeInto(page, '#f-make', 'Ford', touch)
    await tap(page, page.locator('#send'), 'Send request', touch)
    await see(page, 'Sorry, that time was just taken. Here are the next three:')
    const alts = page.locator('.taken .alts button')
    check('exactly three alternatives', (await alts.count()) === 3, `${await alts.count()}`)
    await shot('book-taken')
    const label = (await alts.first().innerText()).trim()
    await tap(page, alts.first(), `alternative ${label}`, touch)
    check('alternative becomes the chosen time', (await page.locator('[data-when]').innerText()).trim() === label, label)
    check('form kept what was typed', (await page.locator('#f-name').inputValue()) === 'Sam Sample (sample)')
    await tap(page, page.locator('#send'), 'Send request', touch)
    await see(page, 'Request sent')
    check('alternative reaches Request sent', true)
  },

  async offered(page, { touch, size, shot }) {
    await page.goto(`${BASE}/r/?t=demo-offered&mock=1`)
    await page.locator('#status-pill').waitFor({ timeout: T })
    check('pill says New time offered', (await page.locator('#status-pill').innerText()).trim() === 'New time offered')
    await badge(page)
    check('offer shows the new time', (await page.locator('.offer').innerText()).includes('Thu Sep 17, 1:30 PM'))
    check('shop note shown', await page.locator('.shop-note').isVisible())
    const accept = page.getByRole('button', { name: 'Accept this time' })
    await tall(page, accept, 'Accept this time', size)
    check('Pick another time offered', await page.getByRole('button', { name: 'Pick another time' }).isVisible())
    await shot('status-offered')
    await tap(page, accept, 'Accept this time', touch)
    await page.locator('#status-pill', { hasText: 'Confirmed' }).waitFor({ timeout: T })
    check('accept reaches Confirmed', true)
    check('Add to calendar links ics_url', (await page.locator('#add-to-calendar').getAttribute('href')) === '/api/r/demo-offered/ics')
    await shot('status-confirmed')
  },

  async repick(page, { touch, shot }) {
    await page.goto(`${BASE}/r/?t=demo-offered&mock=1`)
    await tap(page, page.getByRole('button', { name: 'Pick another time' }), 'Pick another time', touch)
    await see(page, 'Pick a day')
    await tap(page, page.locator('.picker button.day', { hasText: 'Sep 16' }), 'Wed Sep 16', touch)
    await page.locator('.picker button.time').first().waitFor({ timeout: T })
    await tap(page, page.locator('.picker button.time[data-time="14:00"]'), '2:00 PM', touch)
    const ask = page.getByRole('button', { name: /^Ask for/ })
    check('ask button names the time', (await ask.innerText()).includes('Wed Sep 16, 2:00 PM'))
    await shot('status-pick')
    await tap(page, ask, 'Ask for this time', touch)
    await page.locator('#status-pill', { hasText: 'Requested' }).waitFor({ timeout: T })
    check('repick reaches Requested at the new time', (await page.locator('.details').innerText()).includes('Wed Sep 16, 2:00 PM'))
  },

  async declined(page, { shot }) {
    await page.goto(`${BASE}/r/?t=demo-declined&mock=1`)
    await page.locator('#status-pill').waitFor({ timeout: T })
    check('pill says Declined', (await page.locator('#status-pill').innerText()).trim() === 'Declined')
    check('declined shows the shop note', (await page.locator('.shop-note').innerText()).includes('diagnostic tech'))
    check('no cancel on a declined booking', (await page.getByRole('button', { name: 'Cancel my request' }).count()) === 0)
    await shot('status-declined')
  },

  async badLink(page, { shot }) {
    await page.goto(`${BASE}/r/?t=not-a-real-token&mock=1`)
    await see(page, 'We could not open that booking')
    await badge(page)
    await shot('status-not-found')
  },
}

/* ---- run ---------------------------------------------------------------- */
const engines = engineArg === 'all' ? ['chromium', 'webkit'] : [engineArg]
if (SHOTS) await mkdir(path.join(APP, 'tests', 'shots'), { recursive: true })

for (const engine of engines) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch()
  for (const size of [390, 1280]) {
    const touch = size === 390
    const opts =
      size === 390
        ? engine === 'webkit' ? { ...devices['iPhone 14'] } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
    for (const [name, fn] of Object.entries(scenarios)) {
      console.log(`${engine}-${size} ${name}`)
      const context = await browser.newContext({ ...opts, ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      const shot = async (file) => {
        if (!SHOTS || engine !== 'chromium') return
        await page.evaluate(() => document.fonts.ready)
        // Back to the top with a real wheel so the sticky header is not painted mid-page in a full-page shot.
        await page.mouse.move(size / 2, 200)
        for (let i = 0; i < 6 && (await page.evaluate(() => window.scrollY)) > 0; i++) {
          await page.mouse.wheel(0, -4000)
          await page.waitForTimeout(150)
        }
        await page.screenshot({ path: path.join(APP, 'tests', 'shots', `${file}-${size}.png`), fullPage: true, animations: 'disabled' })
      }
      try {
        await fn(page, { touch, size, shot, engine })
        check('no page errors', errors.length === 0, errors.join(' | '))
      } catch (e) {
        if (!/^check failed|is covered$/.test(e.message)) {
          failures++
          console.log(`  FAIL ${name}: ${e.message.split('\n')[0]}`)
        }
      }
      await context.close()
    }
  }
  await browser.close()
}

server?.kill()
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
