// API tests against a running Worker started with --var TEST_MODE:1 (tests/run.mjs does that).
// BASE defaults to http://127.0.0.1:$PORT (7302). Clock pinned to Mon 2026-09-14 9:00 AM NDT.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { now as clockNow, clientIp } from '../src/clock.js'

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 7302}`
const NOW_ISO = '2026-09-14T11:30:00.000Z'
const TUE = '2026-09-15'
const SHOP_NAME = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'

async function api (method, path, { body, token, ip = '10.0.0.1', headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'X-Test-Now': NOW_ISO,
      'X-Test-IP': ip,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json, text, headers: res.headers }
}

const reset = async () => assert.equal((await api('POST', '/api/test/reset')).status, 200)
const booking = (service, date, time, over = {}) => ({
  service, date, time, name: 'Pat Sample (sample)', phone: '709-555-0142', year: '2016', make: 'Toyota', model: 'Corolla', note: '', ...over
})
const slotTimes = async (service, date) => (await api('GET', `/api/slots?service=${service}&date=${date}`)).body.slots.map(s => s.time)
async function signin () {
  const r = await api('POST', '/api/shop/signin', { body: { pin: '2468' } })
  assert.equal(r.status, 200, r.text)
  return r.body.token
}

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
    { id: 'truck-rv', name: 'Truck or RV service', minutes: 120, bays_needed: 2 }
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
  assert.deepEqual(body.days.find(d => d.date === '2026-09-20'), { date: '2026-09-20', label: 'Sun Sep 20', open: false, reason: 'Closed Sundays', available: 0 })
  assert.deepEqual(body.days.find(d => d.date === '2026-09-21'), { date: '2026-09-21', label: 'Mon Sep 21', open: false, reason: 'Staff training (sample)', available: 0 })
  assert.equal(body.days.at(-1).date, '2026-09-27')
  const bad = await api('GET', '/api/days?service=nope')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'bad_request')
  assert.equal(bad.body.field, 'service')
})

test('GET /api/slots matches API.md and refuses bad input', async () => {
  await reset()
  const { status, body } = await api('GET', `/api/slots?service=oil&date=${TUE}`)
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(body), ['service', 'date', 'open', 'reason', 'slots'])
  assert.equal(body.open, true)
  assert.equal(body.reason, null)
  assert.deepEqual(body.slots.slice(0, 2), [{ time: '08:00', label: '8:00 AM' }, { time: '08:30', label: '8:30 AM' }])
  assert.equal(body.slots.length, 18)
  const sunday = await api('GET', '/api/slots?service=oil&date=2026-09-20')
  assert.deepEqual(sunday.body, { service: 'oil', date: '2026-09-20', open: false, reason: 'Closed Sundays', slots: [] })
  for (const [q, field] of [['service=nope&date=2026-09-15', 'service'], ['service=oil&date=2026-9-15', 'date'],
    ['service=oil&date=2026-09-28', 'date'], ['service=oil&date=2026-09-13', 'date'], ['service=oil&date=2026-02-30', 'date']]) {
    const r = await api('GET', `/api/slots?${q}`)
    assert.equal(r.status, 400, q)
    assert.equal(r.body.code, 'bad_request', q)
    assert.equal(r.body.field, field, q)
    assert.equal(typeof r.body.error, 'string')
  }
})

test('POST /api/requests: 201, the time\'s capacity drops, the status view says requested', async () => {
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
  assert.deepEqual(Object.keys(view.body).sort(),
    ['customer', 'date', 'end', 'ics_url', 'id', 'label', 'offer', 'service', 'shop', 'shop_note', 'status', 'time', 'updated_at'])
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
  assert.deepEqual(view.body.customer, { name: 'Pat Sample (sample)', phone: '709-555-0142', year: '2016', make: 'Toyota', model: 'Corolla', note: 'Rattle at the back.' })
  assert.equal(view.body.updated_at, NOW_ISO)

  assert.equal((await api('GET', '/api/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 404)
})

test('POST /api/requests refuses bad input with the field named', async () => {
  await reset()
  const cases = [
    [{ phone: '555' }, 'phone'], [{ phone: 'call me maybe' }, 'phone'], [{ name: '' }, 'name'], [{ make: '' }, 'make'],
    [{ year: '16' }, 'year'], [{ note: 'x'.repeat(281) }, 'note'], [{ time: '09:10' }, 'time'], [{ time: '16:30', service: 'brakes' }, 'time'],
    [{ date: '2026-09-20' }, 'time'], [{ date: '2026-10-30' }, 'date'], [{ service: 'nope' }, 'service']
  ]
  for (const [over, field] of cases) {
    const r = await api('POST', '/api/requests', { body: { ...booking('oil', TUE, '09:30'), ...over } })
    assert.equal(r.status, 400, JSON.stringify(over))
    assert.equal(r.body.code, 'bad_request')
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
  assert.equal((await api('GET', '/api/shop/board')).status, 401)
  assert.equal((await api('GET', '/api/shop/board', { token: 'not-a-real-token' })).status, 401)
  assert.equal((await api('POST', '/api/shop/requests/r_abc/confirm')).status, 401)
})

test('right PIN gives a token; confirm makes the status view confirmed with ics_url', async () => {
  await reset()
  const r = await api('POST', '/api/shop/signin', { body: { pin: '2468' } })
  assert.equal(r.status, 200)
  assert.match(r.body.token, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(r.body.expires_at, '2026-09-28T11:30:00.000Z')
  const token = r.body.token

  const created = (await api('POST', '/api/requests', { body: booking('oil', TUE, '09:30') })).body
  const board = await api('GET', `/api/shop/board?date=${TUE}`, { token })
  assert.equal(board.status, 200)
  assert.deepEqual(Object.keys(board.body).sort(), ['bays', 'days', 'from', 'pending', 'to', 'today'])
  assert.equal(board.body.from, TUE)
  assert.equal(board.body.to, TUE)
  assert.equal(board.body.today, '2026-09-14')
  const pending = board.body.pending.find(p => p.id === created.id)
  assert.ok(pending, 'the new request is pending')
  assert.deepEqual(Object.keys(pending).sort(), ['bays', 'created_at', 'customer', 'date', 'end', 'id', 'label', 'messages', 'offer',
    'pushed_at', 'service', 'shop_note', 'status', 'status_url', 'time', 'updated_at'])
  assert.deepEqual(pending.bays, [1])
  assert.deepEqual(pending.service, { id: 'oil', name: 'Oil change', minutes: 30, bays_needed: 1 })
  assert.equal(pending.status_url, created.status_url)
  const confirmText = pending.messages.find(m => m.key === 'confirmed')
  assert.equal(confirmText.text, `Hi Pat, it's SAMPLE Auto Service. Your oil change is booked for Tue Sep 15 at 9:30 AM. Details: ${created.status_url}`)
  assert.deepEqual(board.body.days[0].hours, { open: '08:00', close: '17:00' })

  const confirmed = await api('POST', `/api/shop/requests/${created.id}/confirm`, { token })
  assert.equal(confirmed.status, 200, confirmed.text)
  assert.equal(confirmed.body.status, 'confirmed')

  const view = (await api('GET', `/api/r/${created.token}`)).body
  assert.equal(view.status, 'confirmed')
  assert.equal(view.ics_url, `/api/r/${created.token}/ics`)

  const again = await api('POST', `/api/shop/requests/${created.id}/confirm`, { token })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'bad_state')
  assert.equal((await api('POST', '/api/shop/requests/r_doesnotexist/confirm', { token })).status, 404)

  const after = (await api('GET', `/api/shop/board?date=${TUE}`, { token })).body
  assert.ok(!after.pending.some(p => p.id === created.id), 'confirmed is no longer pending')
  const item = after.days[0].items.find(i => i.kind === 'request' && i.request.id === created.id)
  assert.equal(item.request.status, 'confirmed')
  assert.equal(item.request.time, '09:30')
})

test('the race: 8 customers send for the last free place at one time, exactly one wins', async () => {
  await reset()
  // Bays 1 and 2 are held 8:00-10:00 by two brake jobs; at 9:00 only bay 3 is left, and nothing starts at 9:00 yet.
  for (let i = 0; i < 2; i++) {
    const r = await api('POST', '/api/requests', { body: booking('brakes', TUE, '08:00', { name: `Brake Racer ${i} (sample)` }), ip: `10.9.0.${i}` })
    assert.equal(r.status, 201, r.text)
  }
  assert.ok((await slotTimes('oil', TUE)).includes('09:00'), 'precondition: oil at 9:00 is offered')
  assert.ok(!(await slotTimes('truck-rv', TUE)).includes('09:00'), 'precondition: only one bay is free at 9:00')

  const racers = Array.from({ length: 8 }, (_, i) =>
    api('POST', '/api/requests', { body: booking('oil', TUE, '09:00', { name: `Racer ${i} (sample)` }), ip: `10.8.0.${i}` }))
  const results = await Promise.all(racers)
  const winners = results.filter(r => r.status === 201)
  const losers = results.filter(r => r.status === 409)
  console.log(`RACE winners=${winners.length} losers=${losers.length} statuses=${results.map(r => r.status).join(',')}`)

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
  const atNine = board.days[0].items.filter(i => i.kind === 'request' && i.request.time === '09:00')
  assert.equal(atNine.length, 1, 'the board shows one holding item at 9:00')
  assert.equal(atNine[0].request.id, winners[0].body.id)
  assert.deepEqual(atNine[0].request.bays, [3])
})
