// M1 smoke + screenshots for the customer page and the status page.
//   default: against the in-browser mock (?mock=1) on the dev server, 7301.
//   --real:  against bb1's real Worker on 7303 (start it with --var TEST_MODE:1), no mock; every scenario resets first and
//            the clock is pinned with X-Test-Now. Steps that need bb1 M2 routes (accept, repick, cancel, ics, decline)
//            are reported as WAIT, not run.
// Not the @playwright/test suite (that is M2). Real input only: every tap goes through tap(), which hit-tests the target's
// centre with elementFromPoint first; typing is page.keyboard. evaluate only reads.
// Usage (from app/): node tests/shots-m1.mjs [--real] [--engine chromium|webkit|all] [--no-shots]
// Screenshots (chromium, mock mode) go to tests/shots/<name>-<390|1280>.png. Exit 1 on any FAIL.
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const REAL = args.includes('--real')
const PORT = REAL ? Number(process.env.E2E_PORT || 7303) : 7301
const BASE = `http://127.0.0.1:${PORT}`
const NOW = '2026-09-14T11:30:00Z'
const SHOP = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'
const engineArg = args.includes('--engine') ? args[args.indexOf('--engine') + 1] : 'all'
const SHOTS = !REAL && !args.includes('--no-shots')
const T = 6000

let failures = 0
let passes = 0
const waits = new Set()

/* ---- server ------------------------------------------------------------- */
async function up() {
  // Mock mode needs only the static server (its /api proxy has nothing behind it); real mode needs the Worker's API.
  try {
    return (await fetch(BASE + (REAL ? '/api/shop' : '/'), { headers: { 'X-Test-Now': NOW } })).status === 200
  } catch {
    return false
  }
}
let server = null
if (!(await up())) {
  if (REAL) {
    console.error(`FAIL no Worker on ${BASE}; start wrangler dev --port ${PORT} --var TEST_MODE:1`)
    process.exit(1)
  }
  server = spawn(process.execPath, ['serve.mjs', String(PORT)], { cwd: APP, stdio: 'ignore' })
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100))
  if (!(await up())) {
    console.error(`FAIL could not start serve.mjs on ${PORT}`)
    process.exit(1)
  }
}

// Page URL: the mock flag only in mock mode.
const at = (p, extra = '') => {
  const q = [REAL ? '' : 'mock=1', extra].filter(Boolean).join('&')
  return BASE + p + (q ? (p.includes('?') ? '&' : '?') + q : '')
}

// Setup through the API (real mode only): arranging data is not UI state.
async function call(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', 'X-Test-Now': NOW, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, body: json ?? text, type: r.headers.get('content-type') }
}
async function shopToken() {
  const r = await call('POST', '/api/shop/signin', { pin: '2468' })
  return r.body.token
}

/* ---- helpers ------------------------------------------------------------ */
function check(name, ok, detail = '') {
  if (ok) passes++
  else failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) throw new Error(`check failed: ${name}`)
}
function wait(name) {
  waits.add(name)
  console.log(`  WAIT ${name} (needs a bb1 M2 route)`)
}

async function tap(page, loc, label, touch) {
  await loc.waitFor({ state: 'visible', timeout: T })
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const hit = await loc.evaluate(
    (el, [px, py]) => {
      const t = document.elementFromPoint(px, py)
      return t === el || el.contains(t) ? '' : t ? t.outerHTML.slice(0, 140) : 'nothing'
    },
    [x, y],
  )
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

async function tall(_page, loc, label, size) {
  if (size !== 390) return
  const box = await loc.boundingBox()
  check(`${label} is at least 44 px tall at 390`, box.height >= 44, `${Math.round(box.height)} px`)
}

async function badge(page) {
  await page.locator('[data-sample]').waitFor({ state: 'visible', timeout: T })
  check('SAMPLE badge visible', (await page.locator('[data-sample]').innerText()).trim() === 'SAMPLE')
  check('shop name shown', (await page.locator('[data-shop-name]').innerText()).trim() === SHOP)
}

async function toDetails(page, touch, time = '10:00') {
  await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change', touch)
  await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15', touch)
  await tap(page, page.locator(`button.time[data-time="${time}"]`), time, touch)
  await see(page, 'Your details')
}

/* ---- scenarios ---------------------------------------------------------- */
const scenarios = {
  async journey(page, { touch, size, shot, engine }) {
    await page.goto(at('/', 'full=1'))
    await see(page, 'Pick a service')
    await badge(page)
    await shot('book-1-service')

    await tap(page, page.locator('button.service', { hasText: 'Oil change' }), 'Oil change', touch)
    await see(page, 'Pick a day')
    await page.locator('button.day').first().waitFor({ timeout: T })
    const sunday = page.locator('button.day', { hasText: 'Sep 20' })
    check('Sunday chip is disabled', await sunday.isDisabled())
    check('Sunday chip says Closed Sundays', (await sunday.innerText()).includes('Closed Sundays'))
    if (!REAL) {
      const full = page.locator('button.day', { hasText: 'Sep 19' })
      check('fully booked Saturday says Full and is disabled', (await full.innerText()).includes('Full') && (await full.isDisabled()))
    }
    check(
      'closure shows its reason',
      (await page.locator('button.day', { hasText: 'Sep 21' }).innerText()).includes('Staff training (sample)'),
    )
    check('14 day chips', (await page.locator('button.day').count()) === 14)
    await shot('book-2-day')

    await tap(page, page.locator('button.day', { hasText: 'Sep 15' }), 'Tue Sep 15', touch)
    await see(page, 'Pick a time')
    await page.locator('button.time').first().waitFor({ timeout: T })
    check('time buttons listed', (await page.locator('button.time').count()) > 0)
    await shot('book-3-time')

    await tap(page, page.locator('button.time[data-time="10:00"]'), '10:00 AM', touch)
    await see(page, 'Your details')
    const send = page.locator('#send')
    await tall(page, send, 'Send request', size)
    await tap(page, send, 'Send request (empty)', touch)
    await see(page, 'Please enter your name.')
    check('phone error shown', await page.locator('#e-phone').isVisible())
    check('make error shown', await page.locator('#e-make').isVisible())
    check('Send request is not disabled after errors', !(await send.isDisabled()))
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
    check('status link is shown', new RegExp(`^${BASE}/r/\\?t=[A-Za-z0-9_-]{32,}$`).test(link), link)
    const copy = page.getByRole('button', { name: 'Copy link' })
    await tall(page, copy, 'Copy link', size)
    await tap(page, copy, 'Copy link', touch)
    if (engine === 'chromium') {
      await page.getByRole('button', { name: 'Copied' }).waitFor({ timeout: T })
      check('clipboard holds the status link', (await page.evaluate(() => navigator.clipboard.readText())) === link)
    } else {
      await page
        .locator('#copy-note')
        .filter({ hasText: /copied|copy it/ })
        .waitFor({ timeout: T })
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

    if (REAL) {
      // The shop confirms through the real API; the status page must show it on its next check.
      const tokenParam = new URL(link).searchParams.get('t')
      const shop = await shopToken()
      const board = await call('GET', '/api/shop/board?days=7', null, { Authorization: `Bearer ${shop}` })
      const mine = board.body.pending.find((r) => r.status_url === `/r/?t=${tokenParam}`)
      check('the request is pending on the shop board', !!mine)
      const conf = await call('POST', `/api/shop/requests/${mine.id}/confirm`, {}, { Authorization: `Bearer ${shop}` })
      check('shop confirm answers 200 confirmed', conf.status === 200 && conf.body.status === 'confirmed', `${conf.status}`)
      await page.reload()
      await page.locator('#status-pill', { hasText: 'Confirmed' }).waitFor({ timeout: T })
      check('status page shows Confirmed after the shop confirms', true)
      const href = await page.locator('#add-to-calendar').getAttribute('href')
      check('Add to calendar links ics_url', href === `/api/r/${tokenParam}/ics`, href)
      const ics = await call('GET', href)
      if (ics.status === 404) wait('GET /api/r/<token>/ics returns text/calendar (404 today)')
      else check('ics link returns text/calendar', ics.status === 200 && /text\/calendar/.test(ics.type), `${ics.status} ${ics.type}`)
      wait('Cancel my request → Cancelled')
      return
    }
    await tap(page, page.getByRole('button', { name: 'Cancel my request' }), 'Cancel my request', touch)
    await tap(page, page.getByRole('button', { name: 'Yes, cancel it' }), 'Yes, cancel it', touch)
    await page.locator('#status-pill', { hasText: 'Cancelled' }).waitFor({ timeout: T })
    check('cancel reaches Cancelled', true)
    await shot('status-cancelled')
  },

  async taken(page, { touch, shot }) {
    await page.goto(at('/', REAL ? '' : 'taken=1'))
    await toDetails(page, touch, '10:00')
    if (REAL) {
      // Two other customers take 10:00 while this one types (max_per_slot is 2).
      for (const [i, name] of ['Lee Sample (sample)', 'Kim Sample (sample)'].entries()) {
        const r = await call(
          'POST',
          '/api/requests',
          { service: 'oil', date: '2026-09-15', time: '10:00', name, phone: '709-555-0100', make: 'Ford' },
          { 'X-Test-IP': `10.0.0.${i + 1}` },
        )
        check(`another customer takes 10:00 (${i + 1} of 2)`, r.status === 201, `${r.status}`)
      }
    }
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
    let token = 'demo-offered-sample'
    let offerLabel = 'Thu Sep 17, 1:30 PM'
    if (REAL) {
      await call('POST', '/api/test/seed', {})
      const shop = await shopToken()
      const board = await call('GET', '/api/shop/board?days=7', null, { Authorization: `Bearer ${shop}` })
      const offered = board.body.pending.find((r) => r.status === 'offered')
      check('seed has an offered request', !!offered)
      token = new URLSearchParams(offered.status_url.split('?')[1]).get('t')
      offerLabel = offered.offer.label
    }
    await page.goto(at(`/r/?t=${token}`))
    await page.locator('#status-pill').waitFor({ timeout: T })
    check('pill says New time offered', (await page.locator('#status-pill').innerText()).trim() === 'New time offered')
    await badge(page)
    check('offer shows the new time', (await page.locator('.offer').innerText()).includes(offerLabel), offerLabel)
    check('shop note shown', await page.locator('.shop-note').isVisible())
    const accept = page.getByRole('button', { name: 'Accept this time' })
    await tall(page, accept, 'Accept this time', size)
    check('Pick another time offered', await page.getByRole('button', { name: 'Pick another time' }).isVisible())
    await shot('status-offered')
    if (REAL) return wait('Accept this time → Confirmed')
    await tap(page, accept, 'Accept this time', touch)
    await page.locator('#status-pill', { hasText: 'Confirmed' }).waitFor({ timeout: T })
    check('accept reaches Confirmed', true)
    check('Add to calendar links ics_url', (await page.locator('#add-to-calendar').getAttribute('href')) === `/api/r/${token}/ics`)
    await shot('status-confirmed')
  },

  async repick(page, { touch, shot }) {
    if (REAL) return wait('Pick another time → Requested at the new time')
    await page.goto(at('/r/?t=demo-offered-sample'))
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
    if (REAL) return wait('a declined booking shows Declined and the shop note')
    await page.goto(at('/r/?t=demo-declined-sample'))
    await page.locator('#status-pill').waitFor({ timeout: T })
    check('pill says Declined', (await page.locator('#status-pill').innerText()).trim() === 'Declined')
    check('declined shows the shop note', (await page.locator('.shop-note').innerText()).includes('diagnostic tech'))
    check('no cancel on a declined booking', (await page.getByRole('button', { name: 'Cancel my request' }).count()) === 0)
    await shot('status-declined')
  },

  async badLink(page, { shot }) {
    await page.goto(at('/r/?t=not-a-real-token-at-all'))
    await see(page, 'We could not open that booking')
    await see(page, 'We could not find that booking.')
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
        ? engine === 'webkit'
          ? { ...devices['iPhone 14'] }
          : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
    for (const [name, fn] of Object.entries(scenarios)) {
      console.log(`${REAL ? 'real' : 'mock'} ${engine}-${size} ${name}`)
      if (REAL) await call('POST', '/api/test/reset')
      const context = await browser.newContext({
        ...opts,
        ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
        ...(REAL ? { extraHTTPHeaders: { 'X-Test-Now': NOW } } : {}),
      })
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
console.log(`\n${passes} passed, ${failures} failed, ${waits.size} waiting on bb1 M2${waits.size ? `: ${[...waits].join('; ')}` : ''}`)
process.exit(failures ? 1 : 0)
