// In-browser stand-in for the Worker, for development only (open a page with ?mock=1). Same shapes as docs/API.md
// for the customer routes, a small copy of the slot rules, and state in sessionStorage so a status link survives
// navigation in the same tab. Playwright specs never use this: they run against the real Worker.
// Dev knobs: ?taken=1 makes the next booking lose the race (409 taken). Demo tokens: demo-requested,
// demo-confirmed, demo-offered, demo-declined. The clock is fixed, like the tests' X-Test-Now.

const NOW = '2026-09-14T11:30:00.000Z' // Mon Sep 14, 9:00 AM in Newfoundland (NDT, UTC-2:30)
const ZONE_OFFSET_MIN = -150
const STORE_KEY = 'book-a-bay:mock-store'
const TAKEN_KEY = 'book-a-bay:mock-taken'
const SHOP_NAME = 'SAMPLE Auto Service — Grand Falls-Windsor (demo)'
const DAY_MS = 86400000

const hours = (open, close) => ({ open, close })
const SETTINGS = {
  bays: 3, slot_step_min: 30, lead_time_min: 60, max_per_slot: 2, window_days: 14,
  hours: { 0: null, 1: hours('08:00', '17:00'), 2: hours('08:00', '17:00'), 3: hours('08:00', '17:00'), 4: hours('08:00', '17:00'), 5: hours('08:00', '17:00'), 6: hours('09:00', '13:00') },
  closures: [{ date: '2026-09-21', reason: 'Staff training (sample)' }],
  services: [
    { id: 'oil', name: 'Oil change', minutes: 30, bays_needed: 1, active: true },
    { id: 'tires', name: 'Tire swap', minutes: 45, bays_needed: 1, active: true },
    { id: 'diagnostic', name: 'Diagnostic', minutes: 60, bays_needed: 1, active: true },
    { id: 'brakes', name: 'Brakes', minutes: 120, bays_needed: 1, active: true },
  ],
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const msOf = (date) => Date.parse(`${date}T00:00:00Z`)
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const addDays = (date, n) => isoDay(msOf(date) + n * DAY_MS)
const weekday = (date) => new Date(msOf(date)).getUTCDay()
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const clockLabel = (m) => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`
const dayLabel = (date) => `${WD[weekday(date)]} ${MON[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`

const LOCAL_NOW_MS = Date.parse(NOW) + ZONE_OFFSET_MIN * 60000
const TODAY = isoDay(LOCAL_NOW_MS)
const NOW_MIN = Math.floor((LOCAL_NOW_MS - msOf(TODAY)) / 60000)

try {
  if (new URLSearchParams(location.search).get('taken') === '1') sessionStorage.setItem(TAKEN_KEY, '1')
} catch {}

/* ---- store --------------------------------------------------------------- */

function seed() {
  const customer = (name, phone, year, make, model, note = '') => ({ name, phone, year, make, model, note })
  const make = (token, status, serviceId, date, time, bays, extra = {}) => {
    const sv = SETTINGS.services.find((x) => x.id === serviceId)
    const start = toMin(time)
    return {
      id: `r_${token.replace('demo-', '')}`, token, status, service: { id: sv.id, name: sv.name, minutes: sv.minutes, bays_needed: sv.bays_needed },
      date, start, end: start + sv.minutes, bays, offer: null, shop_note: '', updated_at: NOW, ...extra,
    }
  }
  return {
    blocks: [{ date: '2026-09-19', start: toMin('09:00'), end: toMin('13:00'), bays: [1, 2, 3] }],
    requests: [
      make('demo-requested', 'requested', 'oil', '2026-09-15', '09:30', [1], { customer: customer('Pat Sample (sample)', '709-555-0142', '2016', 'Toyota', 'Corolla', 'Oil light came on yesterday.') }),
      make('demo-confirmed', 'confirmed', 'brakes', '2026-09-16', '10:00', [1], { customer: customer('Jordan Sample (sample)', '709-555-0187', '2019', 'Ford', 'F-150', 'Grinding noise from the front when braking.') }),
      make('demo-offered', 'offered', 'tires', '2026-09-15', '08:00', [2], {
        customer: customer('Casey Sample (sample)', '709-555-0119', '2014', 'Honda', 'Civic', 'Swap to winter tires, they are in the trunk.'),
        offer: { date: '2026-09-17', start: toMin('13:30'), end: toMin('14:15'), bays: [1] },
        shop_note: 'Tuesday morning is full. Thursday afternoon works if that suits you.',
      }),
      make('demo-declined', 'declined', 'diagnostic', '2026-09-18', '14:00', [1], {
        customer: customer('Robin Sample (sample)', '709-555-0164', '', 'Subaru', 'Outback'),
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
  const info = dayInfo(date)
  if (!info.open || !inWindow(date)) return []
  const held = holds(store, excludeId)
  const dayIdx = Math.round((msOf(date) - msOf(TODAY)) / DAY_MS)
  const out = []
  for (let start = toMin(info.hours.open); start + service.minutes <= toMin(info.hours.close); start += SETTINGS.slot_step_min) {
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

function validate(b) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const name = str(b.name), phone = str(b.phone), year = str(b.year), make = str(b.make), model = str(b.model), note = str(b.note)
  if (!name || name.length > 80) return ['Please enter your name (up to 80 characters).', 'name']
  if (phone.length < 7 || phone.length > 32 || /[^0-9 +\-().]/.test(phone) || (phone.match(/\d/g) || []).length < 7) return ['That phone number does not look right.', 'phone']
  if (year && !/^\d{4}$/.test(year)) return ['The year should be 4 numbers.', 'year']
  if (!make || make.length > 32) return ['Please enter the make (up to 32 characters).', 'make']
  if (model.length > 40) return ['The model can be up to 40 characters.', 'model']
  if (note.length > 280) return ['Your note can be up to 280 characters.', 'note']
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
const bad = (error, field) => res(400, { error, code: 'bad_request', ...(field ? { field } : {}) })
const notFound = () => res(404, { error: 'We could not find that booking. Check the link the shop sent you.', code: 'not_found' })
const badState = (error) => res(409, { error, code: 'bad_state' })

export async function handle(method, path, body = {}) {
  await new Promise((r) => setTimeout(r, 150))
  const url = new URL(path, 'http://mock')
  const p = url.pathname
  const store = load()
  const active = SETTINGS.services.filter((x) => x.active)
  const service = (id) => active.find((x) => x.id === id)

  if (method === 'GET' && p === '/api/shop') {
    return res(200, {
      name: SHOP_NAME, sample: true, timezone: 'America/St_Johns', today: TODAY, now: NOW, window_days: SETTINGS.window_days, bays: SETTINGS.bays,
      services: active.map(({ id, name, minutes, bays_needed }) => ({ id, name, minutes, bays_needed })),
    })
  }

  if (method === 'GET' && p === '/api/days') {
    const sv = service(url.searchParams.get('service'))
    if (!sv) return bad('We could not find that service.', 'service')
    const days = Array.from({ length: SETTINGS.window_days }, (_, i) => {
      const date = addDays(TODAY, i)
      const info = dayInfo(date)
      return { date, label: dayLabel(date), open: info.open, reason: info.reason, available: info.open ? slotsFor(store, sv, date).length : 0 }
    })
    return res(200, { service: sv.id, days })
  }

  if (method === 'GET' && p === '/api/slots') {
    const sv = service(url.searchParams.get('service'))
    const date = url.searchParams.get('date') || ''
    if (!sv) return bad('We could not find that service.', 'service')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inWindow(date)) return bad('Please pick a day in the next two weeks.', 'date')
    const info = dayInfo(date)
    return res(200, { service: sv.id, date, open: info.open, reason: info.reason, slots: slotsFor(store, sv, date).map(({ time, label }) => ({ time, label })) })
  }

  if (method === 'POST' && p === '/api/requests') {
    const sv = service(body.service)
    if (!sv) return bad('We could not find that service.', 'service')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') || !inWindow(body.date)) return bad('Please pick a day in the next two weeks.', 'date')
    const invalid = validate(body)
    if (invalid) return bad(...invalid)
    const start = toMin(body.time || '00:00')
    const open = slotsFor(store, sv, body.date).some((x) => x.start === start)
    if (!open || takeRaceFlag()) {
      return res(409, { error: 'Sorry, that time was just taken.', code: 'taken', next: nextAfter(store, sv, body.date, start) })
    }
    const t = token()
    const r = {
      id: `r_${t.slice(0, 10)}`, token: t, status: 'requested', service: { id: sv.id, name: sv.name, minutes: sv.minutes, bays_needed: sv.bays_needed },
      date: body.date, start, end: start + sv.minutes, bays: freeBays(holds(store), body.date, start, sv.minutes, sv.bays_needed), offer: null, shop_note: '',
      customer: Object.fromEntries(['name', 'phone', 'year', 'make', 'model', 'note'].map((k) => [k, String(body[k] || '').trim()])), updated_at: NOW,
    }
    store.requests.push(r)
    save(store)
    return res(201, { id: r.id, token: t, status: r.status, status_url: `/r/?t=${t}` })
  }

  const m = p.match(/^\/api\/r\/([^/]+)(?:\/(accept|repick|cancel|ics))?$/)
  if (m) {
    const r = store.requests.find((x) => x.token === decodeURIComponent(m[1]))
    if (!r) return notFound()
    const action = m[2]
    if (method === 'GET' && !action) return res(200, view(r))
    if (method === 'GET' && action === 'ics') {
      if (r.status !== 'confirmed') return badState('The calendar file is ready once the shop confirms.')
      return res(200, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    }
    if (method === 'POST' && action === 'accept') {
      if (r.status !== 'offered' || !r.offer) return badState('There is no new time to accept on this booking.')
      Object.assign(r, { date: r.offer.date, start: r.offer.start, end: r.offer.end, bays: r.offer.bays, offer: null, status: 'confirmed' })
    } else if (method === 'POST' && action === 'repick') {
      if (!['requested', 'offered'].includes(r.status)) return badState('This booking cannot be moved any more.')
      const sv = SETTINGS.services.find((x) => x.id === r.service.id)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') || !inWindow(body.date)) return bad('Please pick a day in the next two weeks.', 'date')
      const start = toMin(body.time || '00:00')
      const open = slotsFor(store, sv, body.date, r.id).some((x) => x.start === start)
      if (!open || takeRaceFlag()) {
        return res(409, { error: 'Sorry, that time was just taken.', code: 'taken', next: nextAfter(store, sv, body.date, start, r.id) })
      }
      const bays = freeBays(holds(store, r.id), body.date, start, sv.minutes, sv.bays_needed)
      Object.assign(r, { date: body.date, start, end: start + sv.minutes, bays, offer: null, status: 'requested' })
    } else if (method === 'POST' && action === 'cancel') {
      if (!['requested', 'offered', 'confirmed'].includes(r.status)) return badState('This booking is already closed.')
      r.status = 'cancelled'
      r.offer = null
    } else {
      return res(404, { error: 'Not found.', code: 'not_found' })
    }
    r.updated_at = NOW
    save(store)
    return res(200, view(r))
  }

  return res(404, { error: 'Not found.', code: 'not_found' })
}
