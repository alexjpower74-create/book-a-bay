// Shop Board adapter (src/shopboard.js, pure) and a contract test against tests/fake-shop-board.mjs on 7304.
// Run: node --test tests/shopboard.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { slotFor, estTimeFor, shopBoardId, toPatch, shopBoardItem, toCsv, CSV_COLUMNS } from '../src/shopboard.js'
import { parseTime } from '../src/slots.js'
import { startFakeShopBoard, validatePatch, SLOTS } from './fake-shop-board.mjs'

const FAKE_PORT = Number(process.env.FAKE_SHOP_BOARD_PORT || 7304)
const AT = '2026-09-14T11:30:00.000Z'

const row = (over = {}) => ({
  id: 'r_0123456789abcdef', service_name: 'Oil change', minutes: 30, date: '2026-09-15', start_min: 570, bays: '[2]',
  name: 'Pat Sample (sample)', phone: '709-555-0142', year: '2016', make: 'Toyota', model: 'Corolla', note: '', ...over
})

let fake = null
async function fakeUrl () {
  if (!fake) fake = await startFakeShopBoard({ port: FAKE_PORT })
  await fetch(`${fake.url}/__reset`, { method: 'POST' })
  return fake.url
}
after(async () => { if (fake) await fake.close() })

async function put (base, id, body) {
  const res = await fetch(`${base}/api/bookings/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

test('the mapping table: start time to Shop Board row, minutes to est. time', () => {
  const rows = [['09:30', '9:00'], ['12:15', '12:00 PM'], ['12:45', '12:30 PM'], ['13:30', '1:00'], ['07:45', '8:00'], ['17:30', '5:00'],
    ['08:00', '8:00'], ['12:30', '12:30 PM'], ['16:59', '4:00'], ['17:00', '5:00']]
  for (const [time, slot] of rows) assert.equal(slotFor(parseTime(time)), slot, `${time} -> ${slot}`)
  const est = [[30, '30m'], [45, '1h'], [60, '1h'], [120, '2h'], [200, '4h'], [300, 'Day'], [15, '30m'], [180, '3h'], [240, '4h']]
  for (const [minutes, e] of est) assert.equal(estTimeFor(minutes), e, `${minutes} min -> ${e}`)
  for (const [time] of rows) assert.ok(SLOTS.includes(slotFor(parseTime(time))), 'every mapped row is a real Shop Board row')
})

test('toPatch maps a request row field for field, cut to Shop Board limits', () => {
  assert.equal(shopBoardId('r_0123456789abcdef'), 'bab-0123456789abcdef')
  assert.deepEqual(toPatch(row(), AT), {
    fields: { date: '2026-09-15', slot: '9:00', bay: '2', name: 'Pat Sample (sample)', phone: '709-555-0142', year: '2016', make: 'Toyota',
      model: 'Corolla', issue: 'Oil change (booked online for 9:30 AM)', estTime: '30m' },
    at: AT,
    by: 'Book a Bay'
  })
  const noted = toPatch(row({ note: 'Rattle at the back.', bays: [1, 2], service_name: 'Truck or RV service', minutes: 120, start_min: 765 }), AT)
  assert.equal(noted.fields.issue, 'Truck or RV service (booked online for 12:45 PM) — Rattle at the back.')
  assert.equal(noted.fields.bay, '1', 'first assigned bay')
  assert.equal(noted.fields.slot, '12:30 PM')
  assert.equal(noted.fields.estTime, '2h')
  const long = toPatch(row({ name: 'n'.repeat(90), model: 'm'.repeat(50), note: 'x'.repeat(400) }), AT)
  assert.equal(long.fields.name.length, 80)
  assert.equal(long.fields.model.length, 40)
  assert.equal(long.fields.issue.length, 280)
  const item = shopBoardItem(row(), AT)
  assert.equal(validatePatch({ id: item.id, ...item.patch }), null, "Shop Board's own rules accept the mapped patch")
})

test('CSV export has the Shop Board columns and quotes what needs quoting', () => {
  const csv = toCsv([shopBoardItem(row({ note: 'Said "soon", please' }), AT)])
  const lines = csv.split('\r\n')
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  assert.equal(lines[0], 'id,date,slot,bay,name,phone,year,make,model,issue,estTime')
  assert.equal(lines[1], 'bab-0123456789abcdef,2026-09-15,9:00,2,Pat Sample (sample),709-555-0142,2016,Toyota,Corolla,"Oil change (booked online for 9:30 AM) — Said ""soon"", please",30m')
  assert.equal(lines[2], '')
})

test('contract: the fake refuses what Shop Board refuses (validatePatch at 25c6faa)', async () => {
  const base = await fakeUrl()
  const good = () => ({ fields: { date: '2026-09-15', slot: '9:00', bay: '1', name: 'Pat Sample (sample)', estTime: '30m' }, at: AT, by: 'Book a Bay' })
  const refusals = [
    ['bab-okay-01', b => { b.fields.slot = '9:30' }, 'slot must be one of 8:00, 9:00, 10:00, 11:00, 12:00 PM, 12:30 PM, 1:00, 2:00, 3:00, 4:00, 5:00'],
    ['bab-okay-02', b => { b.fields.slot = '12:00' }, /^slot must be one of/],
    ['bab-okay-03', b => { b.fields.estTime = '45m' }, 'estTime must be one of 30m, 1h, 2h, 3h, 4h, Day or empty'],
    ['bab-okay-04', b => { b.fields.bay = '11' }, 'bay must be 1-10'],
    ['bab-okay-05', b => { b.fields.date = '2026-9-15' }, 'date must be YYYY-MM-DD'],
    ['bab-okay-06', b => { b.at = '2026-09-14T11:30:00Z' }, 'at must be an ISO timestamp'],
    ['bab-okay-07', b => { b.fields.name = 'n'.repeat(81) }, 'name must be at most 80 characters'],
    ['bab-okay-08', b => { b.fields.colour = 'red' }, 'unknown field colour'],
    ['bab-okay-09', b => { delete b.fields.slot }, 'A new booking must include date and slot'],
    ['ab', () => {}, 'Bad booking id']
  ]
  for (const [id, mutate, error] of refusals) {
    const body = good()
    mutate(body)
    const r = await put(base, id, body)
    assert.equal(r.status, 400, `${id}: ${JSON.stringify(body.fields)}`)
    if (error instanceof RegExp) assert.match(r.body.error, error)
    else assert.equal(r.body.error, error)
  }
  assert.equal((await put(base, 'bab-okay-10', good())).status, 200, 'control: the same patch without the fault is accepted')
})

test('contract: mapped patches land, an occupied row is 409 taken, a covering job is 409 busy', async () => {
  const base = await fakeUrl()
  // Every row of the mapping table, each on its own date so none collide: all must pass Shop Board's rules.
  const starts = ['09:30', '12:15', '12:45', '13:30', '07:45', '17:30']
  for (const [i, time] of starts.entries()) {
    const item = shopBoardItem(row({ id: `r_map${i}000000`, date: `2026-10-0${i + 1}`, start_min: parseTime(time), minutes: [30, 45, 60, 120, 200, 300][i] }), AT)
    const r = await put(base, item.id, item.patch)
    assert.equal(r.status, 200, `${time}: ${JSON.stringify(r.body)}`)
    assert.deepEqual(Object.keys(r.body), ['id', 'booking', 'rejected'])
    assert.equal(r.body.id, item.id)
    assert.equal(r.body.booking.slot, item.patch.fields.slot)
    assert.deepEqual(r.body.rejected, [])
  }

  const first = shopBoardItem(row({ id: 'r_first0000000', bays: '[2]' }), AT) // 9:30 -> 9:00 row, bay 2
  assert.equal((await put(base, first.id, first.patch)).status, 200)
  assert.equal((await put(base, first.id, first.patch)).status, 200, 'the same id again is not a collision with itself')
  const second = shopBoardItem(row({ id: 'r_second000000', bays: '[2]', start_min: 555 }), AT) // 9:15 -> the same row
  assert.deepEqual(await put(base, second.id, second.patch), {
    status: 409, body: { error: '9:00 is taken', code: 'taken', conflict: { slot: '9:00', bay: '2' } }
  })

  const long = { fields: { date: '2026-09-15', slot: '12:30 PM', bay: '2', name: 'Long job (sample)', estTime: '2h' }, at: AT, by: 'Front desk' }
  assert.equal((await put(base, 'sb-long-job-1', long)).status, 200)
  // 2h is 3 Shop Board rows (rowsOf), and after 12:30 PM the rows are 1:00 and 2:00, so the job runs until the 3:00 row.
  const covered = shopBoardItem(row({ id: 'r_covered00000', bays: '[2]', start_min: 780 }), AT) // 1:00 row, inside that span
  assert.deepEqual(await put(base, covered.id, covered.patch), {
    status: 409,
    body: { error: 'Bay 2 is busy until 3:00 with Long job (sample)', code: 'busy', conflict: { slot: '12:30 PM', bay: '2', until: '3:00', with: 'Long job (sample)' } }
  })
})
