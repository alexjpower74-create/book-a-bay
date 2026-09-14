// In-browser stand-in for the Worker, for development only (open a page with ?mock=1). It follows what bb1's real
// Worker answers (checked against it on 2026-09-14): the same shapes, codes, field names and error texts, the SAMPLE
// defaults (services, hours, the Sep 21 closure), 400 `field: time` for an off-grid time and 409 `taken` for a grid time
// that is gone. State lives in sessionStorage so a status link survives navigation in the same tab.
// Playwright specs never use this: they run against the real Worker.
// Dev knobs: ?taken=1 makes the next booking lose the race; ?full=1 fills Sat Sep 19 with a walk-in block.
// Demo tokens (16+ characters, like real ones): demo-requested-sample, demo-confirmed-sample, demo-offered-sample,
// demo-declined-sample. The clock is fixed, like the tests' X-Test-Now.
// accept / repick / cancel / ics follow docs/API.md; the real Worker adds them in bb1 M2.

const NOW = '2026-09-14T11:30:00.000Z' // Mon Sep 14, 9:00 AM in Newfoundland (NDT, UTC-2:30)
const ZONE_OFFSET_MIN = -150
const STORE_KEY = 'book-a-bay:mock-store'
const TAKEN_KEY = 'book-a-bay:mock-taken'
const FULL_KEY = 'book-a-bay:mock-full'
const SHOP_NAME = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'
const DAY_MS = 86400000

const hours = (open, close) => ({ open, close })
// worker/migrations/0002_defaults.sql
const SETTINGS = {
  bays: 3, slot_step_min: 30, lead_time_min: 60, max_per_slot: 2, window_days: 14,
  hours: { 0: null, 1: hours('08:00', '17:00'), 2: hours('08:00', '17:00'), 3: hours('08:00', '17:00'), 4: hours('08:00', '17:00'), 5: hours('08:00', '17:00'), 6: hours('09:00', '13:00') },
  closures: [{ date: '2026-09-21', reason: 'Staff training (sample)' }],
  services: [
    { id: 'oil', name: 'Oil change', minutes: 30, bays_needed: 1, active: true },
    { id: 'tire-swap', name: 'Tire swap', minutes: 45, bays_needed: 1, active: true },
    { id: 'brakes', name: 'Brakes', minutes: 120, bays_needed: 1, active: true },
    { id: 'diagnostic', name: 'Diagnostic', minutes: 60, bays_needed: 1, active: true },
    { id: 'truck-rv', name: 'Truck or RV service', minutes: 120, bays_needed: 2, active: true },
  ],
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const msOf = (date) => Date.parse(`${date}T00:00:00Z`)
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const addDays = (date, n) => isoDay(msOf(date) + n * DAY_MS)
const weekday = (date) => new Date(msOf(date)).getUTCDay()
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(msOf(s)) && isoDay(msOf(s)) === s
const parseTime = (s) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof s === 'string' ? s : '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const toMin = (hhmm) => parseTime(hhmm)
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const clockLabel = (m) => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`
const dayLabel = (date) => `${WD[weekday(date)]} ${MON[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`

const LOCAL_NOW_MS = Date.parse(NOW) + ZONE_OFFSET_MIN * 60000
const TODAY = isoDay(LOCAL_NOW_MS)
const NOW_MIN = Math.floor((LOCAL_NOW_MS - msOf(TODAY)) / 60000)

try {
  const params = new URLSearchParams(location.search)
  if (params.get('taken') === '1') sessionStorage.setItem(TAKEN_KEY, '1')
  if (params.get('full') === '1' && sessionStorage.getItem(FULL_KEY) !== '1') {
    sessionStorage.setItem(FULL_KEY, '1')
    sessionStorage.removeItem(STORE_KEY)
  }
} catch {}

/* ---- store --------------------------------------------------------------- */

function seed() {
  const customer = (name, phone, year, make, model, note = '') => ({ name, phone, year, make, model, note })
  const make = (token, status, serviceId, date, time, bays, extra = {}) => {
    const sv = SETTINGS.services.find((x) => x.id === serviceId)
    const start = toMin(time)
    return {
      id: `r_${token.split('-')[1]}0000000000`.slice(0, 18), token, status,
      service: { id: sv.id, name: sv.name, minutes: sv.minutes, bays_needed: sv.bays_needed },
      date, start, end: start + sv.minutes, bays, offer: null, shop_note: '', updated_at: NOW, ...extra,
    }
  }
  let full = false
  try { full = sessionStorage.getItem(FULL_KEY) === '1' } catch {}
  return {
    blocks: full ? [{ date: '2026-09-19', start: toMin('09:00'), end: toMin('13:00'), bays: [1, 2, 3] }] : [],
    requests: [
      make('demo-requested-sample', 'requested', 'oil', '2026-09-15', '09:30', [1], { customer: customer('Pat Sample (sample)', '709-555-0142', '2016', 'Toyota', 'Corolla', 'Oil light came on yesterday.') }),
      make('demo-confirmed-sample', 'confirmed', 'brakes', '2026-09-16', '10:00', [1], { customer: customer('Jordan Byrne (sample)', '709-555-0117', '2019', 'Honda', 'Civic', 'Squeal from the front left wheel.') }),
      make('demo-offered-sample', 'offered', 'tire-swap', '2026-09-15', '08:00', [2], {
        customer: customer('Sam Oake (sample)', '709-555-0128', '2021', 'Hyundai', 'Elantra', 'Winter tires are in the trunk.'),
        offer: { date: '2026-09-17', start: toMin('13:30'), end: toMin('14:15'), bays: [1] },
        shop_note: 'We are booked that morning. Can you come in Thursday afternoon?',
      }),
      make('demo-declined-sample', 'declined', 'diagnostic', '2026-09-18', '14:00', [1], {
        customer: customer('Terry Pardy (sample)', '709-555-0181', '2012', 'Chevrolet', 'Silverado', 'Check engine light is on.'),
        shop_note: 'Sorry, our diagnostic tech is away that week. Please try the week after.',
      }),
    ],
  }
}

function load() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  const store = seed()
  save(store)
  return store
}

function save(store) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(store)) } catch {}
}

/* ---- slot rules (docs/API.md "Slot rules") --------------------------------- */

function holds(store, excludeId) {
  const out = store.blocks.map((b) => ({ ...b, isRequest: false }))
  for (const r of store.requests) {
    if (r.id === excludeId) continue
    if (r.status === 'requested' || r.status === 'confirmed') out.push({ date: r.date, start: r.start, end: r.end, bays: r.bays, isRequest: true })
    if (r.status === 'offered' && r.offer) out.push({ ...r.offer, isRequest: true })
  }
  return out
}

function dayInfo(date) {
  const wd = weekday(date)
  const h = SETTINGS.hours[wd]
  if (!h) return { open: false, reason: `Closed ${WEEKDAY[wd]}s`, hours: null }
  const closure = SETTINGS.closures.find((c) => c.date === date)
  if (closure) return { open: false, reason: closure.reason, hours: null }
  return { open: true, reason: null, hours: h }
}

function inWindow(date) {
  const idx = Math.round((msOf(date) - msOf(TODAY)) / DAY_MS)
  return idx >= 0 && idx < SETTINGS.window_days
}

// Every start on the day's grid, before holds and lead time (a time off this grid is a 400, not a 409).
function candidateStarts(service, date) {
  const info = dayInfo(date)
  if (!info.open) return []
  const out = []
  for (let start = toMin(info.hours.open); start + service.minutes <= toMin(info.hours.close); start += SETTINGS.slot_step_min) out.push(start)
  return out
}

function freeBays(held, date, start, minutes, need) {
  const busy = new Set()
  for (const h of held) {
    if (h.date !== date) continue
    for (let m = h.start; m < h.end; m += 15) for (const bay of h.bays) busy.add(`${bay}:${m}`)
  }
  const free = []
  for (let bay = 1; bay <= SETTINGS.bays && free.length < need; bay++) {
    let ok = true
    for (let m = start; m < start + minutes && ok; m += 15) ok = !busy.has(`${bay}:${m}`)
    if (ok) free.push(bay)
  }
  return free.length >= need ? free : null
}

function slotsFor(store, service, date, excludeId) {
  if (!inWindow(date)) return []
  const held = holds(store, excludeId)
  const dayIdx = Math.round((msOf(date) - msOf(TODAY)) / DAY_MS)
  const out = []
  for (const start of candidateStarts(service, date)) {
    if (dayIdx * 1440 + start < NOW_MIN + SETTINGS.lead_time_min) continue
    if (held.filter((h) => h.isRequest && h.date === date && h.start === start).length >= SETTINGS.max_per_slot) continue
    if (!freeBays(held, date, start, service.minutes, service.bays_needed)) continue
    out.push({ time: hhmm(start), label: clockLabel(start), start })
  }
  return out
}

function nextAfter(store, service, date, start, excludeId) {
  const out = []
  for (let d = date; inWindow(d) && out.length < 3; d = addDays(d, 1)) {
    for (const s of slotsFor(store, service, d, excludeId)) {
      if (d === date && s.start <= start) continue
      out.push({ date: d, time: s.time, label: `${dayLabel(d)}, ${s.label}` })
      if (out.length === 3) break
    }
  }
  return out
}

/* ---- views --------------------------------------------------------------- */

function view(r) {
  return {
    id: r.id, status: r.status,
    service: { id: r.service.id, name: r.service.name, minutes: r.service.minutes },
    date: r.date, time: hhmm(r.start), end: hhmm(r.end), label: `${dayLabel(r.date)}, ${clockLabel(r.start)}`,
    offer: r.status === 'offered' && r.offer ? { date: r.offer.date, time: hhmm(r.offer.start), end: hhmm(r.offer.end), label: `${dayLabel(r.offer.date)}, ${clockLabel(r.offer.start)}` } : null,
    shop_note: r.shop_note, customer: r.customer, shop: { name: SHOP_NAME, sample: true },
    ics_url: r.status === 'confirmed' ? `/api/r/${r.token}/ics` : null, updated_at: r.updated_at,
  }
}

// worker/src/index.js validateCustomer, same order and texts.
function validateCustomer(b) {
  const text = (k) => (typeof b[k] === 'string' ? b[k].trim() : '')
  const name = text('name'), phone = text('phone'), year = text('year'), make = text('make'), model = text('model'), note = text('note')
  if (!name) return ['name', 'Please enter your name.']
  if (name.length > 80) return ['name', 'Please keep your name to 80 characters or fewer.']
  if (phone.length < 7 || phone.length > 32 || !/^[0-9 +\-().]+$/.test(phone) || (phone.match(/\d/g) || []).length < 7) {
    return ['phone', 'Please enter a phone number the shop can call, like 709-555-0142.']
  }
  if (year && !/^\d{4}$/.test(year)) return ['year', 'Year should be 4 digits, like 2016.']
  if (!make) return ['make', 'Please enter the make, like Toyota.']
  if (make.length > 32) return ['make', 'Please keep the make to 32 characters or fewer.']
  if (model.length > 40) return ['model', 'Please keep the model to 40 characters or fewer.']
  if (note.length > 280) return ['note', 'Please keep the note to 280 characters or fewer.']
  return null
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function takeRaceFlag() {
  try {
    if (sessionStorage.getItem(TAKEN_KEY) !== '1') return false
    sessionStorage.removeItem(TAKEN_KEY)
    return true
  } catch { return false }
}

/* ---- router -------------------------------------------------------------- */

const res = (status, body) => ({ status, body })
const bad = (field, error) => res(400, { error, code: 'bad_request', field })
const NOT_FOUND = res(404, { error: 'Not found.', code: 'not_found' })
const badState = (error) => res(409, { error, code: 'bad_state' })

function checkServiceDate(active, body) {
  const sv = active.find((x) => x.id === body.service)
  if (!sv) return { fail: bad('service', 'Please pick a service.') }
  if (!isDate(body.date)) return { fail: bad('date', 'Please pick a day.') }
  if (!inWindow(body.date)) return { fail: bad('date', 'That day is not open for booking online.') }
  return { sv }
}

export async function handle(method, path, body = {}) {
  await new Promise((r) => setTimeout(r, 150))
  const url = new URL(path, 'http://mock')
  const p = url.pathname
  const store = load()
  const active = SETTINGS.services.filter((x) => x.active)
  const qs = (k) => url.searchParams.get(k)

  if (method === 'GET' && p === '/api/shop') {
    return res(200, {
      name: SHOP_NAME, sample: true, timezone: 'America/St_Johns', today: TODAY, now: NOW, window_days: SETTINGS.window_days, bays: SETTINGS.bays,
      services: active.map(({ id, name, minutes, bays_needed }) => ({ id, name, minutes, bays_needed })),
    })
  }

  if (method === 'GET' && p === '/api/days') {
    const sv = active.find((x) => x.id === qs('service'))
    if (!sv) return bad('service', 'Please pick a service.')
    const days = Array.from({ length: SETTINGS.window_days }, (_, i) => {
      const date = addDays(TODAY, i)
      const info = dayInfo(date)
      return { date, label: dayLabel(date), open: info.open, reason: info.reason, available: info.open ? slotsFor(store, sv, date).length : 0 }
    })
    return res(200, { service: sv.id, days })
  }

  if (method === 'GET' && p === '/api/slots') {
    const { sv, fail } = checkServiceDate(active, { service: qs('service'), date: qs('date') })
    if (fail) return fail
    const date = qs('date')
    const info = dayInfo(date)
    return res(200, { service: sv.id, date, open: info.open, reason: info.reason, slots: slotsFor(store, sv, date).map(({ time, label }) => ({ time, label })) })
  }

  if (method === 'POST' && p === '/api/requests') {
    const { sv, fail } = checkServiceDate(active, body)
    if (fail) return fail
    const start = parseTime(body.time)
    if (start === null || !candidateStarts(sv, body.date).includes(start)) return bad('time', 'That time is not open for booking. Please pick another.')
    const invalid = validateCustomer(body)
    if (invalid) return bad(...invalid)
    if (!slotsFor(store, sv, body.date).some((x) => x.start === start) || takeRaceFlag()) {
      return res(409, { error: 'Sorry, that time was just taken.', code: 'taken', next: nextAfter(store, sv, body.date, start) })
    }
    const t = token()
    const r = {
      id: `r_${t.slice(0, 16)}`, token: t, status: 'requested', service: { id: sv.id, name: sv.name, minutes: sv.minutes, bays_needed: sv.bays_needed },
      date: body.date, start, end: start + sv.minutes, bays: freeBays(holds(store), body.date, start, sv.minutes, sv.bays_needed), offer: null, shop_note: '',
      customer: Object.fromEntries(['name', 'phone', 'year', 'make', 'model', 'note'].map((k) => [k, String(body[k] || '').trim()])), updated_at: NOW,
    }
    store.requests.push(r)
    save(store)
    return res(201, { id: r.id, token: t, status: r.status, status_url: `/r/?t=${t}` })
  }

  // The real router only matches tokens of 16-128 url-safe characters; anything else is a plain "Not found.".
  const m = p.match(/^\/api\/r\/([A-Za-z0-9_-]{16,128})(?:\/(accept|repick|cancel|ics))?$/)
  if (!m) return NOT_FOUND
  const r = store.requests.find((x) => x.token === m[1])
  if (!r) return res(404, { error: 'We could not find that booking. Please check the link the shop sent you.', code: 'not_found' })
  const action = m[2]
  if (method === 'GET' && !action) return res(200, view(r))
  if (method === 'GET' && action === 'ics') {
    if (r.status !== 'confirmed') return badState('The calendar file is ready once the shop confirms.')
    return res(200, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
  }
  if (method === 'POST' && action === 'accept') {
    if (r.status !== 'offered' || !r.offer) return badState(`This request is ${r.status}, so there is no new time to accept.`)
    Object.assign(r, { date: r.offer.date, start: r.offer.start, end: r.offer.end, bays: r.offer.bays, offer: null, status: 'confirmed' })
  } else if (method === 'POST' && action === 'repick') {
    if (!['requested', 'offered'].includes(r.status)) return badState(`This request is ${r.status}, so it cannot be moved.`)
    const sv = SETTINGS.services.find((x) => x.id === r.service.id)
    if (!isDate(body.date)) return bad('date', 'Please pick a day.')
    if (!inWindow(body.date)) return bad('date', 'That day is not open for booking online.')
    const start = parseTime(body.time)
    if (start === null || !candidateStarts(sv, body.date).includes(start)) return bad('time', 'That time is not open for booking. Please pick another.')
    if (!slotsFor(store, sv, body.date, r.id).some((x) => x.start === start) || takeRaceFlag()) {
      return res(409, { error: 'Sorry, that time was just taken.', code: 'taken', next: nextAfter(store, sv, body.date, start, r.id) })
    }
    const bays = freeBays(holds(store, r.id), body.date, start, sv.minutes, sv.bays_needed)
    Object.assign(r, { date: body.date, start, end: start + sv.minutes, bays, offer: null, status: 'requested' })
  } else if (method === 'POST' && action === 'cancel') {
    if (!['requested', 'offered', 'confirmed'].includes(r.status)) return badState(`This request is ${r.status}, so it cannot be cancelled.`)
    r.status = 'cancelled'
    r.offer = null
  } else {
    return NOT_FOUND
  }
  r.updated_at = NOW
  save(store)
  return res(200, view(r))
}
