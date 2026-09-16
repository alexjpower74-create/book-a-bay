// API tests against a running Worker started with --var TEST_MODE:1 and SHOP_BOARD_URL pointing at the fake Shop Board
// (tests/run.mjs does both). BASE defaults to http://127.0.0.1:$PORT (7302). Clock pinned to Mon 2026-09-14 9:00 AM NDT.
// A few tests import the Worker directly (no server) to check what it refuses before it touches the database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { now as clockNow, clientIp } from '../src/clock.js'
import worker from '../src/index.js'

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 7302}`
const FAKE = process.env.FAKE_SHOP_BOARD || 'http://127.0.0.1:7304'
const NOW_ISO = '2026-09-14T11:30:00.000Z'
const later = (minutes) => new Date(Date.parse(NOW_ISO) + minutes * 60000).toISOString()
const TUE = '2026-09-15'
const WED = '2026-09-16'
const THU = '2026-09-17'
const FRI = '2026-09-18'
const SHOP_NAME = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'

async function api(method, path, { body, token, ip = '10.0.0.1', now = NOW_ISO, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'X-Test-Now': now,
      'X-Test-IP': ip,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers }
}

const reset = async () => assert.equal((await api('POST', '/api/test/reset')).status, 200)
const booking = (service, date, time, over = {}) => ({
  service,
  date,
  time,
  name: 'Pat Sample (sample)',
  phone: '709-555-0142',
  year: '2016',
  make: 'Toyota',
  model: 'Corolla',
  note: '',
  ...over,
})
async function create(service, date, time, over = {}, ip) {
  const r = await api('POST', '/api/requests', { body: booking(service, date, time, over), ip })
  assert.equal(r.status, 201, `create ${service} ${date} ${time}: ${r.text}`)
  return r.body
}
const slotTimes = async (service, date) => (await api('GET', `/api/slots?service=${service}&date=${date}`)).body.slots.map((s) => s.time)
const holdsOf = async (id) => (await api('GET', `/api/test/holds?owner=${encodeURIComponent(`r:${id}`)}`)).body
const viewOf = async (token) => (await api('GET', `/api/r/${token}`)).body
async function signin(ip) {
  const r = await api('POST', '/api/shop/signin', { body: { pin: '2468' }, ip })
  assert.equal(r.status, 200, r.text)
  return r.body.token
}
function expectError(r, status, code, what = '') {
  assert.equal(r.status, status, `${what} ${r.text}`)
  assert.equal(r.body.code, code, what)
  assert.equal(typeof r.body.error, 'string', what)
}

/** A stand-in D1 that records every call: proves which refusals happen before the database is touched. */
function stubDb() {
  const calls = []
  const stmt = {
    bind() {
      return stmt
    },
    first: async () => ({ expires_at: '9999-12-31T00:00:00.000Z' }),
    // Just enough settings for the seed handler to run to the end (every day closed, so it writes nothing).
    all: async () => ({
      results: [
        { key: 'services', value: '[]' },
        { key: 'hours', value: '{}' },
        { key: 'bays', value: '3' },
        { key: 'timezone', value: '"America/St_Johns"' },
      ],
    }),
    run: async () => ({ meta: { changes: 0 } }),
  }
  return {
    calls,
    prepare(sql) {
      calls.push(sql)
      return stmt
    },
    batch: async (stmts) => {
      calls.push('batch')
      return stmts.map(() => ({ results: [], meta: { changes: 0 } }))
    },
  }
}

// ---------------------------------------------------------------- M1

test('clock.js honours X-Test-Now and X-Test-IP only when TEST_MODE=1', () => {
  const headers = { 'X-Test-Now': '2020-01-01T00:00:00Z', 'X-Test-IP': '203.0.113.9', 'CF-Connecting-IP': '198.51.100.7' }
  const req = new Request('http://local/api/shop', { headers })
  const pinned = Date.parse('2020-01-01T00:00:00Z')
  assert.equal(clockNow(req, { TEST_MODE: '1' }), pinned)
  assert.equal(clientIp(req, { TEST_MODE: '1' }), '203.0.113.9')
  for (const env of [{}, { TEST_MODE: '0' }, { TEST_MODE: 'true' }, undefined]) {
    const t = clockNow(req, env)
    assert.notEqual(t, pinned, `X-Test-Now must be ignored with env ${JSON.stringify(env)}`)
    assert.ok(Math.abs(t - Date.now()) < 5000)
    assert.equal(clientIp(req, env), '198.51.100.7')
  }
  const garbage = new Request('http://local/', { headers: { 'X-Test-Now': 'not a date' } })
  assert.ok(Math.abs(clockNow(garbage, { TEST_MODE: '1' }) - Date.now()) < 5000)
})

test('GET /api/shop matches API.md', async () => {
  await reset()
  const { status, body } = await api('GET', '/api/shop')
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(body).sort(), ['bays', 'name', 'now', 'sample', 'services', 'timezone', 'today', 'window_days'])
  assert.equal(body.name, SHOP_NAME)
  assert.equal(body.sample, true)
  assert.equal(body.timezone, 'America/St_Johns')
  assert.equal(body.today, '2026-09-14')
  assert.equal(body.now, NOW_ISO)
  assert.equal(body.window_days, 14)
  assert.equal(body.bays, 3)
  assert.deepEqual(body.services, [
    { id: 'oil', name: 'Oil change', minutes: 30, bays_needed: 1 },
    { id: 'tire-swap', name: 'Tire swap', minutes: 45, bays_needed: 1 },
    { id: 'brakes', name: 'Brakes', minutes: 120, bays_needed: 1 },
    { id: 'diagnostic', name: 'Diagnostic', minutes: 60, bays_needed: 1 },
    { id: 'truck-rv', name: 'Truck or RV service', minutes: 120, bays_needed: 2 },
  ])
})

test('GET /api/days matches API.md', async () => {
  await reset()
  const { status, body } = await api('GET', '/api/days?service=oil')
  assert.equal(status, 200)
  assert.equal(body.service, 'oil')
  assert.equal(body.days.length, 14)
  for (const d of body.days) assert.deepEqual(Object.keys(d), ['date', 'label', 'open', 'reason', 'available'])
  assert.deepEqual(body.days[0], { date: '2026-09-14', label: 'Mon Sep 14', open: true, reason: null, available: 14 }) // 10:00-4:30 PM after lead time
  assert.equal(body.days[1].available, 18)
  assert.deepEqual(
    body.days.find((d) => d.date === '2026-09-20'),
    { date: '2026-09-20', label: 'Sun Sep 20', open: false, reason: 'Closed Sundays', available: 0 },
  )
  assert.deepEqual(
    body.days.find((d) => d.date === '2026-09-21'),
    { date: '2026-09-21', label: 'Mon Sep 21', open: false, reason: 'Staff training (sample)', available: 0 },
  )
  assert.equal(body.days.at(-1).date, '2026-09-27')
  expectError(await api('GET', '/api/days?service=nope'), 400, 'bad_request')
})

test('GET /api/slots matches API.md and refuses bad input', async () => {
  await reset()
  const { status, body } = await api('GET', `/api/slots?service=oil&date=${TUE}`)
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(body), ['service', 'date', 'open', 'reason', 'slots'])
  assert.equal(body.open, true)
  assert.equal(body.reason, null)
  assert.deepEqual(body.slots.slice(0, 2), [
    { time: '08:00', label: '8:00 AM' },
    { time: '08:30', label: '8:30 AM' },
  ])
  assert.equal(body.slots.length, 18)
  const sunday = await api('GET', '/api/slots?service=oil&date=2026-09-20')
  assert.deepEqual(sunday.body, { service: 'oil', date: '2026-09-20', open: false, reason: 'Closed Sundays', slots: [] })
  for (const [q, field] of [
    ['service=nope&date=2026-09-15', 'service'],
    ['service=oil&date=2026-9-15', 'date'],
    ['service=oil&date=2026-09-28', 'date'],
    ['service=oil&date=2026-09-13', 'date'],
    ['service=oil&date=2026-02-30', 'date'],
  ]) {
    const r = await api('GET', `/api/slots?${q}`)
    expectError(r, 400, 'bad_request', q)
    assert.equal(r.body.field, field, q)
  }
})

test("POST /api/requests: 201, the time's capacity drops, the status view says requested", async () => {
  await reset()
  assert.ok((await slotTimes('truck-rv', TUE)).includes('10:00'))
  const daysBefore = (await api('GET', '/api/days?service=truck-rv')).body.days[1].available

  const r = await api('POST', '/api/requests', { body: booking('truck-rv', TUE, '10:00', { note: 'Rattle at the back.' }) })
  assert.equal(r.status, 201, r.text)
  assert.deepEqual(Object.keys(r.body).sort(), ['id', 'status', 'status_url', 'token'])
  assert.match(r.body.id, /^r_[a-z0-9]+$/)
  assert.match(r.body.token, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(r.body.status, 'requested')
  assert.equal(r.body.status_url, `/r/?t=${r.body.token}`)

  // Bays 1+2 are now held 10:00-12:00, so a 2-bay service cannot start from 8:30 to 11:30; a 1-bay service still fits on bay 3.
  const truckAfter = await slotTimes('truck-rv', TUE)
  for (const t of ['08:30', '09:00', '10:00', '11:30']) assert.ok(!truckAfter.includes(t), `truck-rv ${t} should be gone`)
  assert.ok(truckAfter.includes('08:00') && truckAfter.includes('12:00'))
  assert.ok((await slotTimes('oil', TUE)).includes('10:00'))
  const daysAfter = (await api('GET', '/api/days?service=truck-rv')).body.days[1].available
  assert.equal(daysAfter, daysBefore - 7)

  const view = await api('GET', `/api/r/${r.body.token}`)
  assert.equal(view.status, 200)
  assert.deepEqual(Object.keys(view.body).sort(), [
    'customer',
    'date',
    'end',
    'ics_url',
    'id',
    'label',
    'offer',
    'service',
    'shop',
    'shop_note',
    'status',
    'time',
    'updated_at',
  ])
  assert.equal(view.body.id, r.body.id)
  assert.equal(view.body.status, 'requested')
  assert.deepEqual(view.body.service, { id: 'truck-rv', name: 'Truck or RV service', minutes: 120 })
  assert.equal(view.body.date, TUE)
  assert.equal(view.body.time, '10:00')
  assert.equal(view.body.end, '12:00')
  assert.equal(view.body.label, 'Tue Sep 15, 10:00 AM')
  assert.equal(view.body.offer, null)
  assert.equal(view.body.ics_url, null)
  assert.equal(view.body.shop_note, '')
  assert.deepEqual(view.body.shop, { name: SHOP_NAME, sample: true })
  assert.deepEqual(view.body.customer, {
    name: 'Pat Sample (sample)',
    phone: '709-555-0142',
    year: '2016',
    make: 'Toyota',
    model: 'Corolla',
    note: 'Rattle at the back.',
  })
  assert.equal(view.body.updated_at, NOW_ISO)

  assert.equal((await api('GET', '/api/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 404)
})

test('POST /api/requests refuses bad input with the field named', async () => {
  await reset()
  const cases = [
    [{ phone: '555' }, 'phone'],
    [{ phone: 'call me maybe' }, 'phone'],
    [{ name: '' }, 'name'],
    [{ make: '' }, 'make'],
    [{ year: '16' }, 'year'],
    [{ note: 'x'.repeat(281) }, 'note'],
    [{ time: '09:10' }, 'time'],
    [{ time: '16:30', service: 'brakes' }, 'time'],
    [{ date: '2026-09-20' }, 'time'],
    [{ date: '2026-10-30' }, 'date'],
    [{ service: 'nope' }, 'service'],
  ]
  for (const [over, field] of cases) {
    const r = await api('POST', '/api/requests', { body: { ...booking('oil', TUE, '09:30'), ...over } })
    expectError(r, 400, 'bad_request', JSON.stringify(over))
    assert.equal(r.body.field, field, JSON.stringify(over))
  }
  assert.equal((await api('POST', '/api/requests', { body: booking('oil', TUE, '09:30', { year: '' }) })).status, 201)
})

test('shop sign-in: wrong PIN is 401, shop routes without a valid token are 401', async () => {
  await reset()
  const wrong = await api('POST', '/api/shop/signin', { body: { pin: '1357' } })
  assert.equal(wrong.status, 401)
  assert.deepEqual(wrong.body, { error: 'That PIN is not right.', code: 'unauthorized' })
  for (const pin of ['', '24681', 2468, null]) {
    assert.equal((await api('POST', '/api/shop/signin', { body: { pin } })).status, 401, String(pin))
  }
  const shopRoutes = [
    ['GET', '/api/shop/board'],
    ['POST', '/api/shop/requests/r_abc/confirm'],
    ['POST', '/api/shop/signout'],
    ['GET', '/api/shop/settings'],
    ['PUT', '/api/shop/settings'],
    ['PUT', '/api/shop/pin'],
    ['GET', `/api/shop/slots?service=oil&date=${TUE}`],
    ['POST', '/api/shop/blocks'],
    ['DELETE', '/api/shop/blocks/b_abc'],
    ['POST', '/api/shop/requests/r_abc/decline'],
    ['POST', '/api/shop/requests/r_abc/offer'],
    ['POST', '/api/shop/requests/r_abc/cancel'],
    ['POST', '/api/shop/requests/r_abc/push'],
    ['GET', '/api/shop/days?exclude=r_abc'],
    ['GET', '/api/shop/export/shop-board?format=json'],
  ]
  for (const [method, path] of shopRoutes) {
    expectError(await api(method, path, { ip: '10.0.0.2' }), 401, 'unauthorized', `${method} ${path} without a token`)
    expectError(
      await api(method, path, { token: 'not-a-real-token', ip: '10.0.0.2' }),
      401,
      'unauthorized',
      `${method} ${path} with a bad token`,
    )
  }
})

test('right PIN gives a token; confirm makes the status view confirmed with ics_url', async () => {
  await reset()
  const r = await api('POST', '/api/shop/signin', { body: { pin: '2468' } })
  assert.equal(r.status, 200)
  assert.match(r.body.token, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(r.body.expires_at, '2026-09-28T11:30:00.000Z')
  const token = r.body.token

  const created = await create('oil', TUE, '09:30')
  const board = await api('GET', `/api/shop/board?date=${TUE}`, { token })
  assert.equal(board.status, 200)
  assert.deepEqual(Object.keys(board.body).sort(), ['bays', 'days', 'from', 'pending', 'to', 'today'])
  assert.equal(board.body.from, TUE)
  assert.equal(board.body.to, TUE)
  assert.equal(board.body.today, '2026-09-14')
  const pending = board.body.pending.find((p) => p.id === created.id)
  assert.ok(pending, 'the new request is pending')
  assert.deepEqual(Object.keys(pending).sort(), [
    'bays',
    'created_at',
    'customer',
    'date',
    'end',
    'id',
    'label',
    'messages',
    'offer',
    'pushed_at',
    'service',
    'shop_note',
    'status',
    'status_url',
    'time',
    'updated_at',
  ])
  assert.deepEqual(pending.bays, [1])
  assert.deepEqual(pending.service, { id: 'oil', name: 'Oil change', minutes: 30, bays_needed: 1 })
  assert.equal(pending.status_url, created.status_url)
  assert.deepEqual(
    pending.messages.map((m) => m.key),
    ['received', 'confirmed', 'declined'],
  )
  assert.deepEqual(board.body.days[0].hours, { open: '08:00', close: '17:00' })

  const confirmed = await api('POST', `/api/shop/requests/${created.id}/confirm`, { token })
  assert.equal(confirmed.status, 200, confirmed.text)
  assert.equal(confirmed.body.status, 'confirmed')
  assert.deepEqual(
    confirmed.body.messages.map((m) => m.key),
    ['confirmed'],
  )

  const view = await viewOf(created.token)
  assert.equal(view.status, 'confirmed')
  assert.equal(view.ics_url, `/api/r/${created.token}/ics`)

  expectError(await api('POST', `/api/shop/requests/${created.id}/confirm`, { token }), 409, 'bad_state')
  expectError(await api('POST', '/api/shop/requests/r_doesnotexist/confirm', { token }), 404, 'not_found')

  const after = (await api('GET', `/api/shop/board?date=${TUE}`, { token })).body
  assert.ok(!after.pending.some((p) => p.id === created.id), 'confirmed is no longer pending')
  const item = after.days[0].items.find((i) => i.kind === 'request' && i.request.id === created.id)
  assert.equal(item.request.status, 'confirmed')
  assert.equal(item.request.time, '09:30')
})

test('the race: 8 customers send for the last free place at one time, exactly one wins', async () => {
  await reset()
  // Bays 1 and 2 are held 8:00-10:00 by two brake jobs; at 9:00 only bay 3 is left, and nothing starts at 9:00 yet.
  for (let i = 0; i < 2; i++) await create('brakes', TUE, '08:00', { name: `Brake Racer ${i} (sample)` }, `10.9.0.${i}`)
  assert.ok((await slotTimes('oil', TUE)).includes('09:00'), 'precondition: oil at 9:00 is offered')
  assert.ok(!(await slotTimes('truck-rv', TUE)).includes('09:00'), 'precondition: only one bay is free at 9:00')

  const racers = Array.from({ length: 8 }, (_, i) =>
    api('POST', '/api/requests', { body: booking('oil', TUE, '09:00', { name: `Racer ${i} (sample)` }), ip: `10.8.0.${i}` }),
  )
  const results = await Promise.all(racers)
  const winners = results.filter((r) => r.status === 201)
  const losers = results.filter((r) => r.status === 409)
  console.log(`RACE winners=${winners.length} losers=${losers.length} statuses=${results.map((r) => r.status).join(',')}`)

  assert.equal(winners.length, 1, `exactly one 201, got ${winners.length}`)
  assert.equal(losers.length, 7)
  const offeredNow = new Map()
  for (const l of losers) {
    assert.equal(l.body.code, 'taken')
    assert.equal(l.body.error, 'Sorry, that time was just taken.')
    assert.equal(l.body.next.length, 3)
    for (const n of l.body.next) {
      assert.deepEqual(Object.keys(n), ['date', 'time', 'label'])
      if (!offeredNow.has(n.date)) offeredNow.set(n.date, await slotTimes('oil', n.date))
      assert.ok(offeredNow.get(n.date).includes(n.time), `next ${n.date} ${n.time} is offered by /api/slots`)
    }
  }
  assert.ok(!(await slotTimes('oil', TUE)).includes('09:00'), 'after the race 9:00 is gone')

  const token = await signin()
  const board = (await api('GET', `/api/shop/board?date=${TUE}`, { token })).body
  const atNine = board.days[0].items.filter((i) => i.kind === 'request' && i.request.time === '09:00')
  assert.equal(atNine.length, 1, 'the board shows one holding item at 9:00')
  assert.equal(atNine[0].request.id, winners[0].body.id)
  assert.deepEqual(atNine[0].request.bays, [3])
})

// ---------------------------------------------------------------- M2

test('test routes are 404 without TEST_MODE, refused before the database is touched', async () => {
  for (const [method, path] of [
    ['POST', '/api/test/reset'],
    ['POST', '/api/test/seed'],
    ['GET', '/api/test/holds?owner=r:x'],
  ]) {
    const off = stubDb()
    const res = await worker.fetch(new Request(`http://local${path}`, { method }), { DB: off })
    assert.equal(res.status, 404, `${path} without TEST_MODE`)
    assert.equal((await res.json()).code, 'not_found')
    assert.deepEqual(off.calls, [], `${path}: no database call without TEST_MODE`)
    for (const env of [{ TEST_MODE: '0' }, { TEST_MODE: 'true' }]) {
      assert.equal((await worker.fetch(new Request(`http://local${path}`, { method }), { DB: stubDb(), ...env })).status, 404)
    }
    // Control: the same call with TEST_MODE=1 reaches the handler (it is not 404, and it uses the database).
    const on = stubDb()
    const res2 = await worker.fetch(new Request(`http://local${path}`, { method }), { DB: on, TEST_MODE: '1' })
    assert.notEqual(res2.status, 404, `${path} with TEST_MODE=1`)
    assert.ok(on.calls.length > 0)
  }
})

test('decline releases the time (it is offered again), keeps the shop note, and refuses a second decline', async () => {
  await reset()
  const token = await signin()
  const a = await create('truck-rv', TUE, '10:00') // bays 1+2
  assert.ok(!(await slotTimes('truck-rv', TUE)).includes('10:00'))
  assert.equal((await holdsOf(a.id)).cells.length, 16)

  const r = await api('POST', `/api/shop/requests/${a.id}/decline`, { token, body: { note: 'We are short a mechanic that day (sample).' } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.status, 'declined')
  assert.equal(r.body.shop_note, 'We are short a mechanic that day (sample).')
  assert.deepEqual(
    r.body.messages.map((m) => m.key),
    ['declined'],
  )
  assert.ok(r.body.messages[0].text.includes('We are short a mechanic that day (sample).'))
  assert.ok((await slotTimes('truck-rv', TUE)).includes('10:00'), 'declined time is offered again')
  assert.deepEqual(await holdsOf(a.id), { owner: `r:${a.id}`, cells: [], starts: [] })
  const view = await viewOf(a.token)
  assert.equal(view.status, 'declined')
  assert.equal(view.shop_note, 'We are short a mechanic that day (sample).')

  expectError(await api('POST', `/api/shop/requests/${a.id}/decline`, { token }), 409, 'bad_state')
  expectError(await api('POST', '/api/shop/requests/r_nope123/decline', { token }), 404, 'not_found')
  expectError(await api('POST', `/api/shop/requests/${a.id}/decline`, { token, body: { note: 'x'.repeat(281) } }), 400, 'bad_request')
})

test('offer another time, then the customer accepts; /api/shop/slots?exclude= treats the own hold as free', async () => {
  await reset()
  const token = await signin()
  const a = await create('oil', TUE, '09:30') // bay 1
  for (const bay of [2, 3]) {
    assert.equal(
      (await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '09:30', end: '10:00', bays: [bay], label: 'Walk-in' } }))
        .status,
      201,
    )
  }
  const plain = await api('GET', `/api/shop/slots?service=oil&date=${TUE}`, { token })
  assert.equal(plain.status, 200)
  assert.deepEqual(Object.keys(plain.body), ['service', 'date', 'open', 'reason', 'slots'])
  assert.ok(!plain.body.slots.some((s) => s.time === '09:30'), 'without exclude 9:30 is full')
  const excluded = await api('GET', `/api/shop/slots?date=${TUE}&exclude=${a.id}`, { token })
  assert.equal(excluded.status, 200, excluded.text)
  assert.equal(excluded.body.service, 'oil')
  assert.ok(
    excluded.body.slots.some((s) => s.time === '09:30'),
    "with exclude the request's own 9:30 is free",
  )
  expectError(await api('GET', `/api/shop/slots?date=${TUE}&exclude=r_nope123`, { token }), 404, 'not_found')

  const offered = await api('POST', `/api/shop/requests/${a.id}/offer`, {
    token,
    body: { date: WED, time: '10:00', note: 'We are full that morning (sample).' },
  })
  assert.equal(offered.status, 200, offered.text)
  assert.equal(offered.body.status, 'offered')
  assert.equal(offered.body.time, '09:30', 'the original ask stays')
  assert.deepEqual(offered.body.offer, { date: WED, time: '10:00', end: '10:30', label: 'Wed Sep 16, 10:00 AM', bays: [1] })
  assert.deepEqual(offered.body.messages, [
    {
      key: 'offered',
      label: 'Text with the new time',
      text: `Hi Pat, it's SAMPLE Auto Service. We can't do Tue Sep 15 at 9:30 AM for your Oil change booking, but we can take you on Wed Sep 16 at 10:00 AM. We are full that morning (sample). Accept it or pick another time here: ${a.status_url}`,
    },
  ])
  const held = await holdsOf(a.id)
  assert.deepEqual(held.cells, [
    { date: WED, bay: 1, cell: 40 },
    { date: WED, bay: 1, cell: 41 },
  ])
  assert.deepEqual(held.starts, [{ date: WED, start_min: 600, n: 1 }])
  const wedBoard = (await api('GET', `/api/shop/board?date=${WED}`, { token })).body
  assert.equal(wedBoard.days[0].items.find((i) => i.kind === 'request').request.id, a.id, 'the board shows it where the hold is')
  const customer = await viewOf(a.token)
  assert.equal(customer.status, 'offered')
  assert.deepEqual(customer.offer, { date: WED, time: '10:00', end: '10:30', label: 'Wed Sep 16, 10:00 AM' })

  const accepted = await api('POST', `/api/r/${a.token}/accept`)
  assert.equal(accepted.status, 200, accepted.text)
  assert.equal(accepted.body.status, 'confirmed')
  assert.equal(accepted.body.date, WED)
  assert.equal(accepted.body.time, '10:00')
  assert.equal(accepted.body.end, '10:30')
  assert.equal(accepted.body.offer, null)
  assert.equal(accepted.body.ics_url, `/api/r/${a.token}/ics`)
  assert.deepEqual((await holdsOf(a.id)).cells, held.cells, 'accepting keeps the hold where it is')
  expectError(await api('POST', `/api/r/${a.token}/accept`), 409, 'bad_state')
})

test('offer refusals: busy over a block, taken at a full start, bad_state once confirmed, 400 off the grid', async () => {
  await reset()
  const token = await signin()
  const b = await create('oil', TUE, '11:00')
  const block = (
    await api('POST', '/api/shop/blocks', { token, body: { date: WED, time: '13:00', end: '14:00', bays: 'all', label: 'Walk-in' } })
  ).body.block
  const busy = await api('POST', `/api/shop/requests/${b.id}/offer`, { token, body: { date: WED, time: '13:00' } })
  expectError(busy, 409, 'busy')
  assert.deepEqual(busy.body.conflicts, [{ id: block.id, name: 'Walk-in', label: 'Wed Sep 16, 1:00 PM', bays: [1, 2, 3] }])

  await create('oil', WED, '15:00')
  await create('oil', WED, '15:00') // max_per_slot 2 reached; bay 3 is still free
  const taken = await api('POST', `/api/shop/requests/${b.id}/offer`, { token, body: { date: WED, time: '15:00' } })
  expectError(taken, 409, 'taken')
  assert.equal(taken.body.next.length, 3)
  assert.equal(taken.body.next[0].time, '15:30')
  assert.equal((await viewOf(b.token)).status, 'requested', 'a refused offer changes nothing')
  assert.equal((await holdsOf(b.id)).cells[0].date, TUE)

  expectError(await api('POST', `/api/shop/requests/${b.id}/offer`, { token, body: { date: WED, time: '15:10' } }), 400, 'bad_request')
  await api('POST', `/api/shop/requests/${b.id}/confirm`, { token })
  expectError(await api('POST', `/api/shop/requests/${b.id}/offer`, { token, body: { date: THU, time: '10:00' } }), 409, 'bad_state')
})

test('repick moves a requested or offered booking in one batch; taken gives next; confirmed cannot repick', async () => {
  await reset()
  const token = await signin()
  const a = await create('oil', TUE, '09:00')
  const moved = await api('POST', `/api/r/${a.token}/repick`, { body: { date: TUE, time: '14:00' } })
  assert.equal(moved.status, 200, moved.text)
  assert.equal(moved.body.status, 'requested')
  assert.equal(moved.body.time, '14:00')
  assert.deepEqual((await holdsOf(a.id)).cells, [
    { date: TUE, bay: 1, cell: 56 },
    { date: TUE, bay: 1, cell: 57 },
  ])

  await create('oil', THU, '10:00')
  await create('oil', THU, '10:00')
  const taken = await api('POST', `/api/r/${a.token}/repick`, { body: { date: THU, time: '10:00' } })
  expectError(taken, 409, 'taken')
  assert.equal(taken.body.next.length, 3)
  assert.equal((await holdsOf(a.id)).cells[0].cell, 56, 'a refused repick leaves the hold')

  await api('POST', `/api/shop/requests/${a.id}/offer`, { token, body: { date: WED, time: '09:00' } })
  const fromOffer = await api('POST', `/api/r/${a.token}/repick`, { body: { date: FRI, time: '09:00' } })
  assert.equal(fromOffer.status, 200, fromOffer.text)
  assert.equal(fromOffer.body.status, 'requested')
  assert.equal(fromOffer.body.date, FRI)
  assert.equal(fromOffer.body.offer, null)
  assert.deepEqual((await holdsOf(a.id)).starts, [{ date: FRI, start_min: 540, n: 1 }])

  expectError(await api('POST', `/api/r/${a.token}/repick`, { body: { date: '2026-10-30', time: '09:00' } }), 400, 'bad_request')
  await api('POST', `/api/shop/requests/${a.id}/confirm`, { token })
  expectError(await api('POST', `/api/r/${a.token}/repick`, { body: { date: FRI, time: '10:00' } }), 409, 'bad_state')
})

test('customer cancel releases the hold from requested or confirmed; shop cancel only from confirmed', async () => {
  await reset()
  const token = await signin()
  const a = await create('truck-rv', TUE, '10:00')
  const c1 = await api('POST', `/api/r/${a.token}/cancel`)
  assert.equal(c1.status, 200, c1.text)
  assert.equal(c1.body.status, 'cancelled')
  assert.deepEqual((await holdsOf(a.id)).cells, [])
  assert.ok((await slotTimes('truck-rv', TUE)).includes('10:00'))
  expectError(await api('POST', `/api/r/${a.token}/cancel`), 409, 'bad_state')

  const b = await create('oil', WED, '09:00')
  await api('POST', `/api/shop/requests/${b.id}/confirm`, { token })
  assert.equal((await api('POST', `/api/r/${b.token}/cancel`)).body.status, 'cancelled')
  assert.deepEqual((await holdsOf(b.id)).starts, [])

  const s = await create('oil', THU, '09:00')
  expectError(await api('POST', `/api/shop/requests/${s.id}/cancel`, { token }), 409, 'bad_state')
  await api('POST', `/api/shop/requests/${s.id}/confirm`, { token })
  const shopCancel = await api('POST', `/api/shop/requests/${s.id}/cancel`, { token, body: { note: 'Our lift is down (sample).' } })
  assert.equal(shopCancel.status, 200, shopCancel.text)
  assert.equal(shopCancel.body.status, 'cancelled')
  assert.equal(shopCancel.body.shop_note, 'Our lift is down (sample).')
  assert.deepEqual(shopCancel.body.messages, [])
  assert.deepEqual((await holdsOf(s.id)).cells, [])
})

test('.ics is text/calendar with UTC DTSTART for a NL date in September (NDT, UTC-2:30)', async () => {
  await reset()
  const token = await signin()
  const a = await create('oil', TUE, '09:30')
  expectError(await api('GET', `/api/r/${a.token}/ics`), 409, 'bad_state')
  await api('POST', `/api/shop/requests/${a.id}/confirm`, { token })
  const res = await fetch(`${BASE}/api/r/${a.token}/ics`, { headers: { 'X-Test-Now': NOW_ISO } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8')
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="booking\.ics"$/)
  const text = await res.text()
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'))
  assert.ok(text.endsWith('END:VCALENDAR\r\n'))
  assert.ok(!/[^\r]\n/.test(text), 'every line ends in CRLF')
  const lines = text.split('\r\n')
  assert.ok(lines.includes('DTSTART:20260915T120000Z'), '9:30 AM NDT is 12:00 UTC')
  assert.ok(lines.includes('DTEND:20260915T123000Z'))
  assert.ok(lines.includes(`UID:${a.id}@book-a-bay`))
  assert.ok(lines.includes('SUMMARY:Oil change at SAMPLE Auto Service — Grand Falls-Windsor (demo)'))
  assert.ok(lines.includes('DTSTAMP:20260914T113000Z'))
  for (const line of lines) assert.ok(new TextEncoder().encode(line).length <= 75, `folded: ${line}`)
})

test('block-out removes times, refuses over a hold with conflicts, and can be deleted', async () => {
  await reset()
  const token = await signin()
  const made = await api('POST', '/api/shop/blocks', {
    token,
    body: { date: TUE, time: '12:00', end: '13:00', bays: 'all', label: 'Walk-in' },
  })
  assert.equal(made.status, 201, made.text)
  assert.deepEqual(Object.keys(made.body), ['block'])
  const block = made.body.block
  assert.match(block.id, /^b_[a-z0-9]+$/)
  assert.deepEqual(
    { ...block, id: undefined },
    { id: undefined, date: TUE, time: '12:00', end: '13:00', label: 'Walk-in', bays: [1, 2, 3] },
  )
  const oil = await slotTimes('oil', TUE)
  assert.ok(!oil.includes('12:00') && !oil.includes('12:30'))
  assert.ok(oil.includes('11:30') && oil.includes('13:00'))
  const items = (await api('GET', `/api/shop/board?date=${TUE}`, { token })).body.days[0].items
  assert.deepEqual(items.find((i) => i.kind === 'block').block, block)

  const a = await create('oil', TUE, '15:00')
  const refused = await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '15:00', end: '16:00', bays: [1] } })
  expectError(refused, 409, 'busy')
  assert.deepEqual(refused.body.conflicts, [{ id: a.id, name: 'Pat Sample (sample)', label: 'Tue Sep 15, 3:00 PM', bays: [1] }])
  assert.equal(
    (await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '15:00', end: '16:00', bays: [2] } })).status,
    201,
    'bay 2 is free',
  )

  const del = await api('DELETE', `/api/shop/blocks/${block.id}`, { token })
  assert.deepEqual([del.status, del.body], [200, { ok: true }])
  assert.ok((await slotTimes('oil', TUE)).includes('12:00'), 'deleting the block gives the time back')
  expectError(await api('DELETE', `/api/shop/blocks/${block.id}`, { token }), 404, 'not_found')

  for (const [body, field] of [
    [{ date: TUE, time: '12:00', end: '13:00', bays: [4] }, 'bays'],
    [{ date: TUE, time: '12:00', end: '11:00', bays: [1] }, 'end'],
    [{ date: '2026-09-13', time: '12:00', end: '13:00', bays: [1] }, 'date'],
    [{ date: TUE, time: '12:10', end: '13:00', bays: [1] }, 'time'],
    [{ date: TUE, time: '12:00', end: '13:00', bays: [1], label: '' }, 'label'],
    [{ date: TUE, time: '12:00', end: '13:00', bays: [1], label: 'x'.repeat(41) }, 'label'],
  ]) {
    const r = await api('POST', '/api/shop/blocks', { token, body })
    expectError(r, 400, 'bad_request', JSON.stringify(body))
    assert.equal(r.body.field, field)
  }
  const forty = await api('POST', '/api/shop/blocks', {
    token,
    body: { date: THU, time: '12:00', end: '13:00', bays: [1], label: 'x'.repeat(40) },
  })
  assert.equal(forty.status, 201, 'control: a 40-character label is accepted (API.md clarification 20)')
  assert.equal(forty.body.block.label.length, 40)
})

test('settings: GET shape, PUT round trip, full validation with the field named', async () => {
  await reset()
  const token = await signin()
  const got = await api('GET', '/api/shop/settings', { token })
  assert.equal(got.status, 200)
  const s = got.body
  assert.deepEqual(Object.keys(s), [
    'shop_name',
    'timezone',
    'bays',
    'slot_step_min',
    'lead_time_min',
    'max_per_slot',
    'window_days',
    'hours',
    'closures',
    'services',
  ])
  assert.deepEqual(s.hours, {
    0: null,
    1: { open: '08:00', close: '17:00' },
    2: { open: '08:00', close: '17:00' },
    3: { open: '08:00', close: '17:00' },
    4: { open: '08:00', close: '17:00' },
    5: { open: '08:00', close: '17:00' },
    6: { open: '09:00', close: '13:00' },
  })
  assert.deepEqual(s.closures, [{ date: '2026-09-21', reason: 'Staff training (sample)' }])
  assert.ok(!('pin' in s), 'the PIN hash never leaves the Worker')
  const put = await api('PUT', '/api/shop/settings', { token, body: s })
  assert.equal(put.status, 200, put.text)
  assert.deepEqual(put.body, s)

  const clone = () => structuredClone(s)
  const cases = [
    [
      'shop_name',
      (x) => {
        x.shop_name = ''
      },
    ],
    [
      'timezone',
      (x) => {
        x.timezone = 'America/Halifax'
      },
    ],
    [
      'bays',
      (x) => {
        x.bays = 0
      },
    ],
    [
      'bays',
      (x) => {
        x.bays = 11
      },
    ],
    [
      'slot_step_min',
      (x) => {
        x.slot_step_min = 20
      },
    ],
    [
      'lead_time_min',
      (x) => {
        x.lead_time_min = -1
      },
    ],
    [
      'lead_time_min',
      (x) => {
        x.lead_time_min = 2881
      },
    ],
    [
      'max_per_slot',
      (x) => {
        x.max_per_slot = 0
      },
    ],
    [
      'window_days',
      (x) => {
        x.window_days = 61
      },
    ],
    [
      'hours',
      (x) => {
        x.hours['1'] = { open: '09:10', close: '17:00' }
      },
    ],
    [
      'hours',
      (x) => {
        delete x.hours['6']
      },
    ],
    [
      'hours',
      (x) => {
        x.hours['2'] = { open: '17:00', close: '08:00' }
      },
    ],
    [
      'closures',
      (x) => {
        x.closures[0].reason = ''
      },
    ],
    [
      'closures',
      (x) => {
        x.closures.push({ date: '2026-9-22', reason: 'x' })
      },
    ],
    [
      'closures',
      (x) => {
        x.closures.push({ ...x.closures[0] })
      },
    ],
    [
      'services',
      (x) => {
        x.services = []
      },
    ],
    [
      'services',
      (x) => {
        x.services[1].id = 'oil'
      },
    ],
    [
      'services',
      (x) => {
        x.services[0].minutes = 50
      },
    ],
    [
      'services',
      (x) => {
        x.services[4].bays_needed = 4
      },
    ],
    [
      'services',
      (x) => {
        x.services[0].active = 'yes'
      },
    ],
    [
      'services',
      (x) => {
        x.services[0].id = 'Oil Change'
      },
    ],
    [
      'services',
      (x) => {
        x.services[0].name = 'n'.repeat(41)
      },
    ],
    [
      'bays',
      (x) => {
        x.bays = '3'
      },
    ],
  ]
  for (const [field, mutate] of cases) {
    const body = clone()
    mutate(body)
    const r = await api('PUT', '/api/shop/settings', { token, body })
    expectError(r, 400, 'bad_request', `${field}: ${mutate}`)
    assert.equal(r.body.field, field, String(mutate))
  }
  assert.deepEqual((await api('GET', '/api/shop/settings', { token })).body, s, 'refused saves changed nothing')
})

test('settings: a bay change is seen through /api/slots; bays_in_use refuses lowering over a booking', async () => {
  await reset()
  const token = await signin()
  const s = (await api('GET', '/api/shop/settings', { token })).body
  await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '10:00', end: '10:30', bays: [1, 2] } })
  assert.ok((await slotTimes('oil', TUE)).includes('10:00'), 'bay 3 still free at 10:00')
  assert.equal((await api('PUT', '/api/shop/settings', { token, body: { ...s, bays: 2 } })).status, 200)
  assert.equal((await api('GET', '/api/shop')).body.bays, 2)
  assert.ok(!(await slotTimes('oil', TUE)).includes('10:00'), 'with 2 bays 10:00 is gone')
  assert.equal((await api('PUT', '/api/shop/settings', { token, body: { ...s, bays: 3 } })).status, 200)
  assert.ok((await slotTimes('oil', TUE)).includes('10:00'), 'back to 3 bays, 10:00 is back')

  await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '16:00', end: '16:30', bays: [1, 2] } })
  const onBay3 = await create('oil', TUE, '16:00')
  assert.deepEqual(
    (await holdsOf(onBay3.id)).cells.map((c) => c.bay),
    [3, 3],
  )
  const refused = await api('PUT', '/api/shop/settings', { token, body: { ...s, bays: 2 } })
  expectError(refused, 409, 'bays_in_use')
  assert.equal(refused.body.error, 'Bay 3 has 1 booking from Tue Sep 15. Move or decline it first.')
  assert.equal((await api('GET', '/api/shop')).body.bays, 3, 'the refused save changed nothing')
  await api('POST', `/api/shop/requests/${onBay3.id}/decline`, { token })
  assert.equal(
    (await api('PUT', '/api/shop/settings', { token, body: { ...s, bays: 2 } })).status,
    200,
    'after declining it the change goes through',
  )
})

test('settings: editing or deactivating a service never changes an existing request', async () => {
  await reset()
  const token = await signin()
  const s = (await api('GET', '/api/shop/settings', { token })).body
  const a = await create('oil', TUE, '09:00')
  const renamed = structuredClone(s)
  renamed.services[0] = { ...renamed.services[0], name: 'Oil and filter', minutes: 45 }
  assert.equal((await api('PUT', '/api/shop/settings', { token, body: renamed })).status, 200)
  assert.deepEqual((await viewOf(a.token)).service, { id: 'oil', name: 'Oil change', minutes: 30 })
  renamed.services[0].active = false
  assert.equal((await api('PUT', '/api/shop/settings', { token, body: renamed })).status, 200)
  assert.ok(!(await api('GET', '/api/shop')).body.services.some((x) => x.id === 'oil'))
  expectError(await api('GET', `/api/slots?service=oil&date=${TUE}`), 400, 'bad_request')
  assert.equal((await viewOf(a.token)).end, '09:30')
  assert.equal((await api('GET', `/api/shop/slots?date=${WED}&exclude=${a.id}`, { token })).status, 200, 'the shop can still move it')
})

test('PIN change: wrong current is 401, other sessions end, the new PIN signs in', async () => {
  await reset()
  const mine = await signin()
  const other = await signin()
  expectError(await api('PUT', '/api/shop/pin', { token: mine, body: { current: '1111', next: '1357' } }), 401, 'unauthorized')
  const bad = await api('PUT', '/api/shop/pin', { token: mine, body: { current: '2468', next: '12' } })
  expectError(bad, 400, 'bad_request')
  assert.equal(bad.body.field, 'next')
  const ok = await api('PUT', '/api/shop/pin', { token: mine, body: { current: '2468', next: '1357' } })
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }])
  expectError(await api('POST', '/api/shop/signin', { body: { pin: '2468' } }), 401, 'unauthorized')
  assert.equal((await api('POST', '/api/shop/signin', { body: { pin: '1357' } })).status, 200)
  assert.equal((await api('GET', '/api/shop/board', { token: mine })).status, 200, 'this device stays signed in')
  expectError(await api('GET', '/api/shop/board', { token: other }), 401, 'unauthorized')
  await reset()
  assert.equal((await api('POST', '/api/shop/signin', { body: { pin: '2468' } })).status, 200, 'reset restores 2468')
})

test('sign out ends the session', async () => {
  await reset()
  const token = await signin()
  const out = await api('POST', '/api/shop/signout', { token })
  assert.deepEqual([out.status, out.body], [200, { ok: true }])
  expectError(await api('GET', '/api/shop/board', { token }), 401, 'unauthorized')
  expectError(await api('POST', '/api/shop/signout', { token }), 401, 'unauthorized')
})

test('sign-in rate guard: 5 wrong PINs in 15 minutes from one IP gives 429, even for the right PIN', async () => {
  await reset()
  for (let i = 0; i < 5; i++)
    expectError(await api('POST', '/api/shop/signin', { body: { pin: '0000' }, ip: '192.0.2.1' }), 401, 'unauthorized', `try ${i + 1}`)
  const locked = await api('POST', '/api/shop/signin', { body: { pin: '2468' }, ip: '192.0.2.1' })
  expectError(locked, 429, 'rate_limited')
  assert.equal((await api('POST', '/api/shop/signin', { body: { pin: '2468' }, ip: '192.0.2.2' })).status, 200, 'another IP is not locked')
  assert.equal(
    (await api('POST', '/api/shop/signin', { body: { pin: '2468' }, ip: '192.0.2.1', now: later(16) })).status,
    200,
    '16 minutes later it works',
  )
})

test('request rate guard: 12 requests an hour from one IP, the 13th is 429', async () => {
  await reset()
  const times = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30']
  for (const t of times) await create('oil', TUE, t, {}, '198.51.100.20')
  const blocked = await api('POST', '/api/requests', { body: booking('oil', TUE, '14:00'), ip: '198.51.100.20' })
  expectError(blocked, 429, 'rate_limited')
  assert.equal((await api('POST', '/api/requests', { body: booking('oil', TUE, '14:00'), ip: '198.51.100.21' })).status, 201)
  assert.equal(
    (await api('POST', '/api/requests', { body: booking('oil', TUE, '14:30'), ip: '198.51.100.20', now: later(61) })).status,
    201,
    'an hour later it works',
  )
})

test('messages read right for every service name', async () => {
  await reset()
  const token = await signin()
  const made = [
    await create('oil', TUE, '08:00'),
    await create('tire-swap', TUE, '09:00'),
    await create('brakes', TUE, '10:00'),
    await create('diagnostic', TUE, '13:00'),
    await create('truck-rv', WED, '10:00'),
  ]
  const pending = (await api('GET', '/api/shop/board', { token })).body.pending
  assert.equal(pending.length, 5)
  for (const p of pending) {
    assert.deepEqual(
      p.messages.map((m) => m.key),
      ['received', 'confirmed', 'declined'],
    )
    for (const m of p.messages) {
      assert.ok(m.text.includes(p.service.name), `${m.key} names "${p.service.name}" as written`)
      assert.doesNotMatch(m.text, /\b(is|are) booked\b|your (brakes|oil change|tire swap|diagnostic|truck or rv service)\b/, m.text)
      assert.ok(m.text.endsWith(p.status_url), 'ends with the status link path')
    }
  }
  const brakes = pending.find((p) => p.service.id === 'brakes')
  assert.deepEqual(
    brakes.messages.map((m) => m.text),
    [
      `Hi Pat, it's SAMPLE Auto Service. We got your request for Brakes on Tue Sep 15 at 10:00 AM. We'll confirm it soon. Details: ${made[2].status_url}`,
      `Hi Pat, it's SAMPLE Auto Service. Your Brakes booking is confirmed for Tue Sep 15 at 10:00 AM. Details: ${made[2].status_url}`,
      `Hi Pat, it's SAMPLE Auto Service. Sorry, we can't fit in your Brakes booking on Tue Sep 15 at 10:00 AM. Details: ${made[2].status_url}`,
    ],
  )
})

test('seed: a SAMPLE week whose pending list is oldest request first', async () => {
  await reset()
  const seeded = await api('POST', '/api/test/seed')
  assert.equal(seeded.status, 200, seeded.text)
  assert.equal(seeded.body.requests, 7)
  const token = await signin()
  const board = (await api('GET', '/api/shop/board?days=7', { token })).body
  assert.deepEqual(
    board.pending.map((p) => p.customer.name),
    ['Jordan Byrne (sample)', 'Sam Oake (sample)', 'Terry Pardy (sample)', 'Morgan Lush (sample)'],
  )
  const created = board.pending.map((p) => p.created_at)
  assert.deepEqual([...created].sort(), created)
  assert.equal(new Set(created).size, created.length, 'no two share a created_at')
  const all = board.days.flatMap((d) => d.items)
  for (const i of all.filter((i) => i.kind === 'request')) assert.match(i.request.customer.name, /\(sample\)$/)
  assert.equal(all.filter((i) => i.kind === 'block').length, 1)
})

test('Confirm and Decline at once, 10 times over: holds are present if and only if the final status holds time', async () => {
  const outcomes = []
  const bad = []
  for (let run = 0; run < 10; run++) {
    await reset()
    const token = await signin()
    const a = await create('oil', TUE, '09:30')
    const held = await holdsOf(a.id) // 2 cells (9:30, 9:45) on bay 1 and 1 numbered start
    assert.equal(held.cells.length, 2)
    const fire = [
      () => api('POST', `/api/shop/requests/${a.id}/confirm`, { token }),
      () => api('POST', `/api/shop/requests/${a.id}/decline`, { token }),
    ]
    if (run % 2) fire.reverse()
    const responses = await Promise.all(fire.map((f) => f()))
    const status = (await viewOf(a.token)).status
    const holds = await holdsOf(a.id)
    outcomes.push(`${status}:${holds.cells.length}c${holds.starts.length}s`)
    const holding = ['requested', 'offered', 'confirmed'].includes(status)
    const consistent = holding ? JSON.stringify(holds) === JSON.stringify(held) : holds.cells.length === 0 && holds.starts.length === 0
    if (!consistent) bad.push(`run ${run}: ${status} with ${holds.cells.length} cells, ${holds.starts.length} starts`)
    const codes = responses.map((r) => r.status).sort()
    if (codes.join() !== '200,409') bad.push(`run ${run}: responses ${codes.join()}`)
  }
  console.log(`STATUS-RACE outcomes=${outcomes.join(',')} bad=${bad.length}`)
  assert.deepEqual(bad, [])
})

test("push to Shop Board: 200 sets pushed_at; a taken or busy row is 502 with Shop Board's own words", async () => {
  await reset()
  assert.equal((await fetch(`${FAKE}/__reset`, { method: 'POST' })).status, 200, `the fake Shop Board answers on ${FAKE}`)
  const token = await signin()
  const a = await create('oil', TUE, '09:30')
  expectError(await api('POST', `/api/shop/requests/${a.id}/push`, { token }), 409, 'bad_state', 'requested cannot be pushed')
  await api('POST', `/api/shop/requests/${a.id}/confirm`, { token })
  const pushed = await api('POST', `/api/shop/requests/${a.id}/push`, { token })
  assert.equal(pushed.status, 200, pushed.text)
  const sbId = `bab-${a.id.slice(2)}`
  assert.equal(pushed.body.pushed, true)
  assert.equal(pushed.body.shop_board.status, 200)
  assert.deepEqual(Object.keys(pushed.body.shop_board.body), ['id', 'booking', 'rejected'])
  assert.equal(pushed.body.shop_board.body.id, sbId)
  const landed = (await (await fetch(`${FAKE}/__bookings`)).json()).bookings.find((b) => b.id === sbId)
  assert.deepEqual(
    { date: landed.date, slot: landed.slot, bay: landed.bay, estTime: landed.estTime, issue: landed.issue, updatedBy: landed.updatedBy },
    { date: TUE, slot: '9:00', bay: '1', estTime: '30m', issue: 'Oil change (booked online for 9:30 AM)', updatedBy: 'Book a Bay' },
  )
  const item = (await api('GET', `/api/shop/board?date=${TUE}`, { token })).body.days[0].items.find((i) => i.request?.id === a.id)
  assert.equal(item.request.pushed_at, NOW_ISO)

  const sb = (id, fields) =>
    fetch(`${FAKE}/api/bookings/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields, at: NOW_ISO, by: 'Front desk' }),
    })
  assert.equal((await sb('sb-walkin-01', { date: WED, slot: '10:00', bay: '1', name: 'Walk-in (sample)', estTime: '30m' })).status, 200)
  const b = await create('oil', WED, '10:00')
  await api('POST', `/api/shop/requests/${b.id}/confirm`, { token })
  const taken = await api('POST', `/api/shop/requests/${b.id}/push`, { token })
  expectError(taken, 502, 'shop_board_error')
  assert.deepEqual(taken.body.shop_board, {
    status: 409,
    body: { error: '10:00 is taken', code: 'taken', conflict: { slot: '10:00', bay: '1' } },
  })
  assert.ok(taken.body.error.includes('10:00 is taken'), taken.body.error)
  assert.equal(
    (await api('GET', `/api/shop/board?date=${WED}`, { token })).body.days[0].items.find((i) => i.request?.id === b.id).request.pushed_at,
    null,
  )

  assert.equal((await sb('sb-long-job-01', { date: THU, slot: '8:00', bay: '1', name: 'Long job (sample)', estTime: '2h' })).status, 200)
  const d = await create('brakes', THU, '09:00')
  await api('POST', `/api/shop/requests/${d.id}/confirm`, { token })
  const busy = await api('POST', `/api/shop/requests/${d.id}/push`, { token })
  expectError(busy, 502, 'shop_board_error')
  assert.equal(busy.body.shop_board.status, 409)
  assert.deepEqual(busy.body.shop_board.body, {
    error: 'Bay 1 is busy until 11:00 with Long job (sample)',
    code: 'busy',
    conflict: { slot: '8:00', bay: '1', until: '11:00', with: 'Long job (sample)' },
  })
  assert.ok(busy.body.error.includes('Bay 1 is busy until 11:00 with Long job (sample)'), busy.body.error)
})

test('push with no SHOP_BOARD_URL is 501 not_configured', async () => {
  const request = () =>
    new Request('http://local/api/shop/requests/r_abc123/push', { method: 'POST', headers: { Authorization: 'Bearer some-session-token' } })
  const res = await worker.fetch(request(), { DB: stubDb() })
  assert.equal(res.status, 501)
  const body = await res.json()
  assert.equal(body.code, 'not_configured')
  assert.match(body.error, /Download for Shop Board/)
  // Control: with a URL set the same call gets past the 501 (the stub row is not confirmed, so it stops at bad_state).
  const configured = await worker.fetch(request(), { DB: stubDb(), SHOP_BOARD_URL: 'http://127.0.0.1:9' })
  assert.equal(configured.status, 409)
})

test('export for Shop Board: confirmed only, JSON patches and CSV', async () => {
  await reset()
  const token = await signin()
  const a = await create('oil', TUE, '09:30')
  await api('POST', `/api/shop/requests/${a.id}/confirm`, { token })
  await create('brakes', TUE, '13:00') // requested: not exported
  const j = await api('GET', `/api/shop/export/shop-board?from=${TUE}&to=${TUE}&format=json`, { token })
  assert.equal(j.status, 200, j.text)
  assert.match(j.headers.get('content-disposition'), /attachment; filename="shop-board-2026-09-15-to-2026-09-15\.json"/)
  assert.deepEqual(j.body, {
    format: 'shop-board-patches/v1',
    target: 'PUT /api/bookings/:id',
    items: [
      {
        id: `bab-${a.id.slice(2)}`,
        patch: {
          fields: {
            date: TUE,
            slot: '9:00',
            bay: '1',
            name: 'Pat Sample (sample)',
            phone: '709-555-0142',
            year: '2016',
            make: 'Toyota',
            model: 'Corolla',
            issue: 'Oil change (booked online for 9:30 AM)',
            estTime: '30m',
          },
          at: NOW_ISO,
          by: 'Book a Bay',
        },
      },
    ],
  })
  const csv = await api('GET', `/api/shop/export/shop-board?from=${TUE}&to=${WED}&format=csv`, { token })
  assert.equal(csv.status, 200)
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.deepEqual(csv.text.split('\r\n'), [
    'id,date,slot,bay,name,phone,year,make,model,issue,estTime',
    `bab-${a.id.slice(2)},2026-09-15,9:00,1,Pat Sample (sample),709-555-0142,2016,Toyota,Corolla,Oil change (booked online for 9:30 AM),30m`,
    '',
  ])
  const none = await api('GET', `/api/shop/export/shop-board?from=${WED}&to=${WED}`, { token })
  assert.deepEqual(none.body.items, [])
  expectError(await api('GET', '/api/shop/export/shop-board?format=xml', { token }), 400, 'bad_request')
  expectError(await api('GET', `/api/shop/export/shop-board?from=${WED}&to=${TUE}`, { token }), 400, 'bad_request')
})

test('lowering bays while bookings are in flight: never a hold above the stored bay count', async () => {
  // API.md clarification 16. Bays 1-2 are blocked at 11:00, so only bay 3 can take an 11:00 oil change. Six customers send for
  // it at the same moment the shop saves bays: 2. Either the save wins (200, nobody on bay 3) or a booking wins (the save is
  // 409 bays_in_use, one booking on bay 3). Never both.
  const runs = Number(process.env.BAYS_RACE_RUNS || 10)
  const outcomes = []
  const bad = []
  for (let run = 0; run < runs; run++) {
    await reset()
    const token = await signin()
    const s = (await api('GET', '/api/shop/settings', { token })).body
    assert.equal(
      (await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '11:00', end: '11:30', bays: [1, 2] } })).status,
      201,
    )
    assert.ok((await slotTimes('oil', TUE)).includes('11:00'), 'precondition: 11:00 is open on bay 3')

    // Send timing only (client side): stagger = (run - offset) * step ms; negative sends the bookings first, positive the
    // save. Defaults (offset 5, step 3) run from bookings 15 ms ahead to the save 12 ms ahead, so both orderings really
    // happen instead of the save always landing first. negative:bays sweeps its own window because its copies add latency.
    const stagger = (run - Number(process.env.BAYS_RACE_STAGGER_OFFSET || 5)) * Number(process.env.BAYS_RACE_STAGGER_STEP_MS || 3)
    const pause = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
    const save = pause(-stagger).then(() => api('PUT', '/api/shop/settings', { token, body: { ...s, bays: 2 } }))
    const bookings = Array.from({ length: 6 }, (_, i) =>
      pause(stagger).then(() =>
        api('POST', '/api/requests', { body: booking('oil', TUE, '11:00', { name: `Bay Racer ${i} (sample)` }), ip: `10.7.${run}.${i}` }),
      ),
    )
    const [saved, ...booked] = await Promise.all([save, ...bookings])

    const stored = (await api('GET', '/api/shop')).body.bays
    const winners = booked.filter((r) => r.status === 201)
    const cells = (await Promise.all(winners.map((w) => holdsOf(w.body.id)))).flatMap((h) => h.cells)
    const onBay3 = cells.some((cell) => cell.bay === 3)
    outcomes.push(`save${saved.status}:bays${stored}:${winners.length}w:${onBay3 ? 'bay3' : 'nobay3'}`)

    const above = cells.filter((cell) => cell.bay > stored)
    if (above.length) bad.push(`run ${run}: stored bays ${stored} but a booking holds bay ${above[0].bay}`)
    if (saved.status === 200) {
      if (stored !== 2 || winners.length || onBay3) bad.push(`run ${run}: save 200 but bays ${stored}, ${winners.length} winners`)
    } else if (saved.status === 409) {
      if (saved.body.code !== 'bays_in_use' || stored !== 3 || winners.length !== 1 || !onBay3)
        bad.push(`run ${run}: save 409 ${saved.body.code} but bays ${stored}, ${winners.length} winners`)
    } else {
      bad.push(`run ${run}: save answered ${saved.status} ${saved.text}`)
    }
    for (const r of booked) {
      if (r.status !== 201 && !(r.status === 409 && r.body.code === 'taken'))
        bad.push(`run ${run}: a booking answered ${r.status} ${r.text}`)
    }
  }
  console.log(`BAYS-RACE outcomes=${outcomes.join(',')} bad=${bad.length}`)
  assert.deepEqual(bad, [])
  // Both ways must have happened, or this run only measured one side of the guard.
  assert.ok(
    outcomes.some((o) => o.startsWith('save200')),
    'at least one run where the save won',
  )
  assert.ok(
    outcomes.some((o) => o.startsWith('save409')),
    'at least one run where a booking won',
  )
})

test('shop view: an offered request carries the bays its offer holds; the customer view does not', async () => {
  // API.md clarification 17. A 2-bay job offered where bay 1 is blocked lands on bays 2 and 3, not on its original 1 and 2.
  await reset()
  const token = await signin()
  const a = await create('truck-rv', TUE, '10:00')
  assert.equal((await api('POST', '/api/shop/blocks', { token, body: { date: WED, time: '10:00', end: '12:00', bays: [1] } })).status, 201)
  const offered = await api('POST', `/api/shop/requests/${a.id}/offer`, { token, body: { date: WED, time: '10:00' } })
  assert.equal(offered.status, 200, offered.text)

  const heldBays = [...new Set((await holdsOf(a.id)).cells.map((cell) => cell.bay))]
  assert.deepEqual(heldBays, [2, 3], 'precondition: the offer holds bays 2 and 3')
  const offer = { date: WED, time: '10:00', end: '12:00', label: 'Wed Sep 16, 10:00 AM' }
  assert.deepEqual(offered.body.offer, { ...offer, bays: heldBays })
  const board = (await api('GET', `/api/shop/board?date=${WED}`, { token })).body
  const item = board.days[0].items.find((i) => i.kind === 'request' && i.request.id === a.id)
  assert.deepEqual(item.request.offer, { ...offer, bays: heldBays }, 'board item offer.bays = the bays the offer holds')
  assert.deepEqual(item.request.bays, [1, 2], 'the request keeps its original bays')
  assert.deepEqual(board.pending.find((p) => p.id === a.id).offer.bays, heldBays)
  assert.deepEqual((await viewOf(a.token)).offer, offer, 'the customer view offer has no bays')
})

test('every miss under /api/r/ is 404 with the booking text, whatever the token looks like', async () => {
  // API.md clarification 18.
  await reset()
  const miss = { error: 'We could not find that booking. Please check the link the shop sent you.', code: 'not_found' }
  const cases = [
    ['GET', '/api/r/nope'],
    ['GET', '/api/r/abc$def'],
    ['POST', '/api/r/nope/accept'],
    ['POST', '/api/r/nope/repick'],
    ['POST', '/api/r/nope/cancel'],
    ['GET', '/api/r/nope/ics'],
    ['POST', '/api/r/abc$def/cancel'],
    ['GET', '/api/r/abc%20def'],
    ['GET', '/api/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['GET', `/api/r/${'x'.repeat(200)}`],
  ]
  for (const [method, path] of cases) {
    const r = await api(method, path)
    assert.equal(r.status, 404, `${method} ${path}: ${r.text}`)
    assert.deepEqual(r.body, miss, `${method} ${path}`)
  }
  const real = await create('oil', TUE, '09:30')
  assert.equal((await api('GET', `/api/r/${real.token}`)).status, 200, 'control: a real token still opens its booking')
})

test('move pickers use the request snapshot: an offline service can still be moved from shop and customer pickers', async () => {
  // API.md clarification 19.
  await reset()
  const token = await signin()
  const a = await create('oil', TUE, '09:30')
  const s = (await api('GET', '/api/shop/settings', { token })).body
  const offline = structuredClone(s)
  offline.services.find((x) => x.id === 'oil').active = false
  assert.equal((await api('PUT', '/api/shop/settings', { token, body: offline })).status, 200)

  const refused = await api('GET', '/api/days?service=oil')
  expectError(refused, 400, 'bad_request', 'the customer /api/days refuses an offline service')
  assert.equal(refused.body.field, 'service')

  const shopDays = await api('GET', `/api/shop/days?exclude=${a.id}`, { token })
  assert.equal(shopDays.status, 200, shopDays.text)
  assert.deepEqual(Object.keys(shopDays.body), ['service', 'days'])
  assert.equal(shopDays.body.service, 'oil')
  assert.equal(shopDays.body.days.length, 14)
  for (const d of shopDays.body.days) assert.deepEqual(Object.keys(d), ['date', 'label', 'open', 'reason', 'available'])
  assert.deepEqual(
    shopDays.body.days.find((d) => d.date === WED),
    { date: WED, label: 'Wed Sep 16', open: true, reason: null, available: 18 },
  )
  assert.equal(shopDays.body.days.find((d) => d.date === '2026-09-20').reason, 'Closed Sundays')

  const customerDays = await api('GET', `/api/r/${a.token}/days`)
  assert.equal(customerDays.status, 200, customerDays.text)
  assert.deepEqual(customerDays.body, shopDays.body, 'customer and shop see the same days for the same request')

  const customerSlots = await api('GET', `/api/r/${a.token}/slots?date=${WED}`)
  assert.equal(customerSlots.status, 200, customerSlots.text)
  assert.deepEqual(Object.keys(customerSlots.body), ['service', 'date', 'open', 'reason', 'slots'])
  assert.equal(customerSlots.body.service, 'oil')
  assert.equal(customerSlots.body.slots.length, 18)
  assert.deepEqual(customerSlots.body.slots[0], { time: '08:00', label: '8:00 AM' })
  const shopSlots = await api('GET', `/api/shop/slots?date=${WED}&exclude=${a.id}`, { token })
  assert.deepEqual(shopSlots.body, customerSlots.body, '/api/shop/slots with exclude and no service gives the same times')
  assert.equal(
    (await api('POST', `/api/r/${a.token}/repick`, { body: { date: WED, time: '10:00' } })).status,
    200,
    'and the move itself goes through',
  )

  // Refusals on the new routes.
  const bookingMiss = { error: 'We could not find that booking. Please check the link the shop sent you.', code: 'not_found' }
  for (const path of ['/api/r/nope/days', `/api/r/nope/slots?date=${WED}`])
    assert.deepEqual((await api('GET', path)).body, bookingMiss, path)
  const outside = await api('GET', `/api/r/${a.token}/slots?date=2026-10-30`)
  expectError(outside, 400, 'bad_request')
  assert.equal(outside.body.field, 'date')
  const noExclude = await api('GET', '/api/shop/days', { token })
  expectError(noExclude, 400, 'bad_request')
  assert.equal(noExclude.body.field, 'exclude')
  expectError(await api('GET', '/api/shop/days?exclude=r_nope123', { token }), 404, 'not_found')
})

test("a time blocked only by the request's own hold is offered to that request", async () => {
  // API.md clarification 19. Bays 2 and 3 are blocked at 9:30 and the request holds bay 1, so 9:30 is full for everyone else.
  await reset()
  const token = await signin()
  assert.equal(
    (await api('POST', '/api/shop/blocks', { token, body: { date: TUE, time: '09:30', end: '10:00', bays: [2, 3] } })).status,
    201,
  )
  const a = await create('oil', TUE, '09:30')
  assert.ok(!(await slotTimes('oil', TUE)).includes('09:30'), '/api/slots does not offer 9:30')
  const own = await api('GET', `/api/r/${a.token}/slots?date=${TUE}`)
  assert.ok(
    own.body.slots.some((x) => x.time === '09:30'),
    '/api/r/:token/slots offers 9:30 back to its own booking',
  )
  const everyone = (await api('GET', '/api/days?service=oil')).body.days.find((d) => d.date === TUE).available
  const mine = (await api('GET', `/api/r/${a.token}/days`)).body.days.find((d) => d.date === TUE).available
  assert.equal(mine, everyone + 1, 'the day count also frees exactly the own start')
  assert.equal(
    (await api('POST', `/api/r/${a.token}/repick`, { body: { date: TUE, time: '09:30' } })).status,
    200,
    'control: repick agrees the time is free',
  )
})

test('PIN change refusals: a wrong current PIN carries field current; a dead session has none', async () => {
  // API.md clarification 21.
  await reset()
  const token = await signin()
  const wrong = await api('PUT', '/api/shop/pin', { token, body: { current: '1111', next: '1357' } })
  assert.equal(wrong.status, 401)
  assert.deepEqual(wrong.body, { error: 'That PIN is not right.', code: 'unauthorized', field: 'current' })
  assert.equal((await api('POST', '/api/shop/signout', { token })).status, 200)
  const dead = await api('PUT', '/api/shop/pin', { token, body: { current: '2468', next: '1357' } })
  assert.equal(dead.status, 401)
  assert.deepEqual(dead.body, { error: 'Please sign in again.', code: 'unauthorized' })
  assert.ok(!('field' in dead.body), 'a dead session names no field, so the app signs out')
})
