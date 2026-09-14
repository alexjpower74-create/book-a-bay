// Book a Bay Worker: the API in docs/API.md. Static files in ../app/public are served by [assets];
// only /api/* reaches this code.

import { now as clockNow, clientIp, isTestMode } from './clock.js'
import {
  CELL_MIN, parseTime, formatTime, isDate, addDays, timeLabel, dayLabel, slotLabel,
  dayInfo, today as shopToday, inWindow, candidateStarts, holdsFrom, occupancy, pickBays,
  availableStarts, listDays, nextSlots, startNumber
} from './slots.js'

const HOLD_RETRIES = 3 // after the first try (API.md "The race")
const SESSION_DAYS = 14

// ---- responses ----

class HttpError extends Error {
  constructor (status, code, error, extra = {}) {
    super(error)
    this.status = status
    this.body = { error, code, ...extra }
  }
}

function json (status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

const badRequest = (field, error) => new HttpError(400, 'bad_request', error, { field })
const notFound = error => new HttpError(404, 'not_found', error)

async function readJson (request) {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    const body = JSON.parse(text)
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch {}
  throw new HttpError(400, 'bad_request', 'That request could not be read. Please try again.')
}

// ---- small helpers ----

function randomUrlSafe (bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomHex (bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex (text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('')
}

const iso = ms => new Date(ms).toISOString()
const parseArr = v => (typeof v === 'string' ? JSON.parse(v) : v)

// ---- settings and holds ----

async function loadSettings (db) {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'default:%'").all()
  const s = {}
  for (const row of results) s[row.key] = JSON.parse(row.value)
  return s
}

async function loadHolds (db, fromDate) {
  const [reqs, blocks] = await db.batch([
    db.prepare(`SELECT id, status, date, start_min, end_min, bays, offer_date, offer_start_min, offer_end_min, offer_bays
                FROM requests WHERE status IN ('requested', 'offered', 'confirmed') AND (date >= ?1 OR offer_date >= ?1)`).bind(fromDate),
    db.prepare('SELECT id, date, start_min, end_min, bays FROM blocks WHERE date >= ?1').bind(fromDate)
  ])
  return holdsFrom(reqs.results, blocks.results)
}

function activeService (settings, id) {
  const service = settings.services.find(s => s.id === id && s.active)
  if (!service) throw badRequest('service', 'Please pick a service.')
  return service
}

function windowDate (settings, now, date) {
  if (!isDate(date)) throw badRequest('date', 'Please pick a day.')
  if (!inWindow(settings, now, date)) throw badRequest('date', 'That day is not open for booking online.')
  return date
}

/** Statements that write a hold's cells and (for requests) its numbered start. */
function holdStatements (db, plan) {
  const stmts = []
  for (const bay of plan.bays) {
    for (let c = plan.start_min / CELL_MIN; c < plan.end_min / CELL_MIN; c++) {
      stmts.push(db.prepare('INSERT INTO cells (date, bay, cell, owner) VALUES (?1, ?2, ?3, ?4)').bind(plan.date, bay, c, plan.owner))
    }
  }
  if (plan.n) {
    stmts.push(db.prepare('INSERT INTO starts (date, start_min, n, owner) VALUES (?1, ?2, ?3, ?4)').bind(plan.date, plan.start_min, plan.n, plan.owner))
  }
  return stmts
}

const isUniqueViolation = e => /UNIQUE constraint failed/i.test(String(e?.message || e) + String(e?.cause?.message || ''))

// ---- request views ----

const statusUrl = token => `/r/?t=${token}`

function when (date, startMin, endMin) {
  return { date, time: formatTime(startMin), end: formatTime(endMin), label: slotLabel(date, startMin) }
}

function offerOf (row) {
  if (row.status !== 'offered' || !row.offer_date) return null
  return when(row.offer_date, row.offer_start_min, row.offer_end_min)
}

function customerOf (row) {
  return { name: row.name, phone: row.phone, year: row.year, make: row.make, model: row.model, note: row.note }
}

function customerView (row, settings) {
  return {
    id: row.id,
    status: row.status,
    service: { id: row.service_id, name: row.service_name, minutes: row.minutes },
    ...when(row.date, row.start_min, row.end_min),
    offer: offerOf(row),
    shop_note: row.shop_note,
    customer: customerOf(row),
    shop: { name: settings.shop_name, sample: true },
    ics_url: row.status === 'confirmed' ? `/api/r/${row.token}/ics` : null,
    updated_at: row.updated_at
  }
}

/** Ready-made texts for the shop to copy into its own phone. Nothing is ever sent by the system. */
function messages (row, settings) {
  const shop = settings.shop_name.split(' — ')[0]
  const first = row.name.replace(/\s*\(sample\)\s*$/i, '').trim().split(/\s+/)[0] || 'there'
  const service = row.service_name.charAt(0).toLowerCase() + row.service_name.slice(1)
  const at = (date, min) => `${dayLabel(date)} at ${timeLabel(min)}`
  const link = statusUrl(row.token)
  const note = row.shop_note ? ` ${row.shop_note}` : ''
  const hi = `Hi ${first}, it's ${shop}.`
  switch (row.status) {
    case 'requested':
      return [{ key: 'received', label: 'Text to say we got it', text: `${hi} We got your request for your ${service} on ${at(row.date, row.start_min)}. We'll confirm soon. Details: ${link}` },
        { key: 'confirmed', label: 'Text to confirm', text: `${hi} Your ${service} is booked for ${at(row.date, row.start_min)}. Details: ${link}` },
        { key: 'declined', label: 'Text to decline', text: `${hi} Sorry, we can't take your ${service} on ${at(row.date, row.start_min)}.${note} Details: ${link}` }]
    case 'confirmed':
      return [{ key: 'confirmed', label: 'Text to confirm', text: `${hi} Your ${service} is booked for ${at(row.date, row.start_min)}. Details: ${link}` }]
    case 'offered':
      return [{ key: 'offered', label: 'Text with the new time', text: `${hi} We can't do ${at(row.date, row.start_min)}, but we can take your ${service} on ${at(row.offer_date, row.offer_start_min)}.${note} Accept it or pick another time here: ${link}` }]
    case 'declined':
      return [{ key: 'declined', label: 'Text to decline', text: `${hi} Sorry, we can't take your ${service} on ${at(row.date, row.start_min)}.${note} Details: ${link}` }]
    default:
      return []
  }
}

function shopView (row, settings) {
  return {
    id: row.id,
    status: row.status,
    service: { id: row.service_id, name: row.service_name, minutes: row.minutes, bays_needed: row.bays_needed },
    ...when(row.date, row.start_min, row.end_min),
    bays: parseArr(row.bays),
    offer: offerOf(row),
    customer: customerOf(row),
    shop_note: row.shop_note,
    status_url: statusUrl(row.token),
    created_at: row.created_at,
    updated_at: row.updated_at,
    pushed_at: row.pushed_at,
    messages: messages(row, settings)
  }
}

// ---- customer routes ----

async function getShop (c) {
  const settings = await loadSettings(c.db)
  return json(200, {
    name: settings.shop_name,
    sample: true,
    timezone: settings.timezone,
    today: shopToday(settings, c.now),
    now: iso(c.now),
    window_days: settings.window_days,
    bays: settings.bays,
    services: settings.services.filter(s => s.active).map(({ id, name, minutes, bays_needed }) => ({ id, name, minutes, bays_needed }))
  })
}

async function getDays (c) {
  const settings = await loadSettings(c.db)
  const service = activeService(settings, c.url.searchParams.get('service'))
  const holds = await loadHolds(c.db, shopToday(settings, c.now))
  return json(200, { service: service.id, days: listDays({ settings, service, now: c.now, holds }) })
}

async function getSlots (c) {
  const settings = await loadSettings(c.db)
  const service = activeService(settings, c.url.searchParams.get('service'))
  const date = windowDate(settings, c.now, c.url.searchParams.get('date'))
  const info = dayInfo(settings, date)
  const holds = await loadHolds(c.db, shopToday(settings, c.now))
  const slots = info.open ? availableStarts({ settings, service, date, now: c.now, holds }).map(({ time, label }) => ({ time, label })) : []
  return json(200, { service: service.id, date, open: info.open, reason: info.reason, slots })
}

function validateCustomer (body) {
  const text = key => {
    const v = body[key]
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string') throw badRequest(key, 'Please check this field.')
    return v.trim()
  }
  const name = text('name')
  if (!name) throw badRequest('name', 'Please enter your name.')
  if (name.length > 80) throw badRequest('name', 'Please keep your name to 80 characters or fewer.')
  const phone = text('phone')
  if (phone.length < 7 || phone.length > 32 || !/^[0-9 +\-().]+$/.test(phone) || (phone.match(/\d/g) || []).length < 7) {
    throw badRequest('phone', 'Please enter a phone number the shop can call, like 709-555-0142.')
  }
  const year = text('year')
  if (year && !/^\d{4}$/.test(year)) throw badRequest('year', 'Year should be 4 digits, like 2016.')
  const make = text('make')
  if (!make) throw badRequest('make', 'Please enter the make, like Toyota.')
  if (make.length > 32) throw badRequest('make', 'Please keep the make to 32 characters or fewer.')
  const model = text('model')
  if (model.length > 40) throw badRequest('model', 'Please keep the model to 40 characters or fewer.')
  const note = text('note')
  if (note.length > 280) throw badRequest('note', 'Please keep the note to 280 characters or fewer.')
  return { name, phone, year, make, model, note }
}

async function postRequest (c) {
  const body = await readJson(c.request)
  const db = c.db
  const settings = await loadSettings(db)
  const service = activeService(settings, body.service)
  const date = windowDate(settings, c.now, body.date)
  const start = parseTime(body.time)
  if (start === null || !candidateStarts(settings, service, date).includes(start)) {
    throw badRequest('time', 'That time is not open for booking. Please pick another.')
  }
  const customer = validateCustomer(body)
  const today = shopToday(settings, c.now)

  const id = `r_${randomHex(8)}`
  const token = randomUrlSafe(24)
  const stamp = iso(c.now)
  const end = start + service.minutes
  const insertRequest = db.prepare(
    `INSERT INTO requests (id, token, status, service_id, service_name, minutes, bays_needed, date, start_min, end_min, bays,
                           name, phone, year, make, model, note, shop_note, created_at, updated_at)
     VALUES (?1, ?2, 'requested', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, '', ?17, ?17)`)

  for (let attempt = 0; attempt <= HOLD_RETRIES; attempt++) {
    const holds = await loadHolds(db, today)
    const slot = availableStarts({ settings, service, date, now: c.now, holds }).find(s => s.start_min === start)
    if (!slot) break
    const { results: numbered } = await db.prepare('SELECT n FROM starts WHERE date = ?1 AND start_min = ?2').bind(date, start).all()
    const n = startNumber(numbered.map(r => r.n), settings.max_per_slot)
    if (!n) break
    const plan = { owner: `r:${id}`, date, start_min: start, end_min: end, bays: slot.bays, n }
    const stmts = [
      insertRequest.bind(id, token, service.id, service.name, service.minutes, service.bays_needed, date, start, end,
        JSON.stringify(plan.bays), customer.name, customer.phone, customer.year, customer.make, customer.model, customer.note, stamp),
      ...holdStatements(db, plan)
    ]
    let committed = false
    // The race guard. In scope: db, plan, stmts; sets committed. D1 runs a batch as one transaction and the UNIQUE
    // indexes on cells and starts make the second of two racing batches fail and roll back completely.
    // tests/negative-race.mjs replaces exactly this region with an unguarded check-then-insert; keep the markers.
    // RACE-GUARD:BEGIN
    try {
      await db.batch(stmts)
      committed = true
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
    }
    // RACE-GUARD:END
    if (committed) {
      return json(201, { id, token, status: 'requested', status_url: statusUrl(token) })
    }
  }

  const holds = await loadHolds(db, today)
  const next = nextSlots({ settings, service, date, start_min: start, now: c.now, holds })
  throw new HttpError(409, 'taken', 'Sorry, that time was just taken.', { next })
}

async function getStatus (c) {
  const row = await c.db.prepare('SELECT * FROM requests WHERE token = ?1').bind(c.params[0]).first()
  if (!row) throw notFound('We could not find that booking. Please check the link the shop sent you.')
  const settings = await loadSettings(c.db)
  return json(200, customerView(row, settings))
}

// ---- shop routes ----

function b64ToBytes (b64) {
  return Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))
}

async function verifyPin (pin, stored) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin) || !stored) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(stored.salt), iterations: stored.iterations }, key, 256))
  const want = b64ToBytes(stored.hash)
  if (want.length !== bits.length) return false
  let diff = 0
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i]
  return diff === 0
}

async function signin (c) {
  const body = await readJson(c.request)
  const settings = await loadSettings(c.db)
  if (!(await verifyPin(body.pin, settings.pin))) {
    throw new HttpError(401, 'unauthorized', 'That PIN is not right.')
  }
  const token = randomUrlSafe(32)
  const expires = iso(c.now + SESSION_DAYS * 86400000)
  await c.db.batch([
    c.db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(iso(c.now)),
    c.db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?1, ?2)').bind(await sha256Hex(token), expires)
  ])
  return json(200, { token, expires_at: expires })
}

async function requireShop (c) {
  const m = /^Bearer\s+(\S+)$/.exec(c.request.headers.get('Authorization') || '')
  if (m) {
    const row = await c.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(m[1])).first()
    if (row && row.expires_at > iso(c.now)) return
  }
  throw new HttpError(401, 'unauthorized', 'Please sign in again.')
}

async function shopBoard (c) {
  const settings = await loadSettings(c.db)
  const today = shopToday(settings, c.now)
  const from = c.url.searchParams.get('date') || today
  if (!isDate(from)) throw badRequest('date', 'Please pick a day.')
  const daysParam = c.url.searchParams.get('days') || '1'
  if (daysParam !== '1' && daysParam !== '7') throw badRequest('days', 'Show 1 day or 7 days.')
  const to = addDays(from, Number(daysParam) - 1)

  const [pending, holding, blocks] = await c.db.batch([
    c.db.prepare(`SELECT * FROM requests WHERE status IN ('requested', 'offered') AND (date >= ?1 OR offer_date >= ?1)
                  ORDER BY created_at, id`).bind(today),
    c.db.prepare(`SELECT * FROM requests WHERE status IN ('requested', 'offered', 'confirmed')
                  AND ((date BETWEEN ?1 AND ?2) OR (offer_date BETWEEN ?1 AND ?2))`).bind(from, to),
    c.db.prepare('SELECT * FROM blocks WHERE date BETWEEN ?1 AND ?2').bind(from, to)
  ])

  const days = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const info = dayInfo(settings, d)
    const items = []
    for (const row of holding.results) {
      const offered = row.status === 'offered'
      if ((offered ? row.offer_date : row.date) !== d) continue
      items.push({ sort: [offered ? row.offer_start_min : row.start_min, parseArr(offered ? row.offer_bays : row.bays)[0]], item: { kind: 'request', request: shopView(row, settings) } })
    }
    for (const b of blocks.results) {
      if (b.date !== d) continue
      const bays = parseArr(b.bays)
      items.push({ sort: [b.start_min, bays[0]], item: { kind: 'block', block: { id: b.id, ...when(b.date, b.start_min, b.end_min), bays, label: b.label } } })
    }
    items.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1])
    days.push({ date: d, label: dayLabel(d), open: info.open, reason: info.reason, hours: info.hours, items: items.map(x => x.item) })
  }

  return json(200, {
    from, to, bays: settings.bays, today,
    pending: pending.results.map(r => shopView(r, settings)),
    days
  })
}

async function confirmRequest (c) {
  const id = c.params[0]
  const row = await c.db.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first()
  if (!row) throw notFound('That request is not on the board any more.')
  const badState = () => new HttpError(409, 'bad_state', `This request is ${row.status}, so it cannot be confirmed.`)
  if (row.status !== 'requested') throw badState()
  const res = await c.db.prepare("UPDATE requests SET status = 'confirmed', updated_at = ?1 WHERE id = ?2 AND status = 'requested'")
    .bind(iso(c.now), id).run()
  if (res.meta.changes !== 1) throw badState()
  const settings = await loadSettings(c.db)
  const updated = await c.db.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first()
  return json(200, shopView(updated, settings))
}

// ---- test-only routes (TEST_MODE=1) ----

async function testReset (c) {
  await c.db.batch([
    ...['requests', 'cells', 'starts', 'blocks', 'sessions', 'attempts'].map(t => c.db.prepare(`DELETE FROM ${t}`)),
    c.db.prepare("DELETE FROM settings WHERE key NOT LIKE 'default:%'"),
    c.db.prepare("INSERT INTO settings (key, value) SELECT substr(key, 9), value FROM settings WHERE key LIKE 'default:%'")
  ])
  return json(200, { ok: true })
}

// A believable SAMPLE week. `day` = days after today, moved forward to the first date where the time fits.
const SEED = [
  { day: 1, time: '08:00', service: 'oil', status: 'confirmed', name: 'Pat Sample (sample)', phone: '709-555-0142', year: '2016', make: 'Toyota', model: 'Corolla', note: '' },
  { day: 1, time: '09:00', service: 'brakes', status: 'requested', name: 'Jordan Byrne (sample)', phone: '709-555-0117', year: '2019', make: 'Honda', model: 'Civic', note: 'Squeal from the front left wheel.' },
  { day: 1, time: '13:00', service: 'truck-rv', status: 'confirmed', name: 'Chris Hynes (sample)', phone: '709-555-0163', year: '2014', make: 'Ford', model: 'F-150', note: '' },
  { day: 2, time: '10:00', service: 'tire-swap', status: 'requested', name: 'Sam Oake (sample)', phone: '709-555-0128', year: '2021', make: 'Hyundai', model: 'Elantra', note: 'Winter tires are in the trunk.' },
  { day: 2, time: '14:00', service: 'diagnostic', status: 'offered', offer: { day: 3, time: '09:00' }, name: 'Terry Pardy (sample)', phone: '709-555-0181', year: '2012', make: 'Chevrolet', model: 'Silverado', note: 'Check engine light is on.', shop_note: 'We are booked that afternoon. Can you come in the next morning?' },
  { day: 3, time: '11:00', service: 'oil', status: 'requested', name: 'Morgan Lush (sample)', phone: '709-555-0199', year: '2018', make: 'Subaru', model: 'Outback', note: '' },
  { day: 4, time: '08:30', service: 'brakes', status: 'confirmed', name: 'Robin Keats (sample)', phone: '709-555-0134', year: '2017', make: 'Kia', model: 'Soul', note: '' }
]

async function testSeed (c) {
  const body = await readJson(c.request)
  const settings = await loadSettings(c.db)
  if (body.today !== undefined && !isDate(body.today)) throw badRequest('today', 'today must be YYYY-MM-DD.')
  const today = body.today || shopToday(settings, c.now)
  const db = c.db
  await db.batch(['requests', 'cells', 'starts', 'blocks'].map(t => db.prepare(`DELETE FROM ${t}`)))

  const holds = []
  const stamp = iso(c.now)
  const fits = (service, dayOffset, time) => {
    for (let i = dayOffset; i < dayOffset + 14; i++) {
      const date = addDays(today, i)
      if (candidateStarts(settings, service, date).includes(parseTime(time))) return date
    }
    return null
  }
  const place = (service, date, start, owner) => {
    const occ = occupancy(holds, date)
    const bays = pickBays(occ, settings.bays, service.bays_needed, start, start + service.minutes)
    if (!bays) return null
    const plan = { owner, date, start_min: start, end_min: start + service.minutes, bays, n: (occ.starts.get(start) || 0) + 1 }
    holds.push({ owner, kind: 'request', date, start_min: plan.start_min, end_min: plan.end_min, bays })
    return plan
  }

  const stmts = []
  let count = 0
  for (const s of SEED) {
    const service = settings.services.find(x => x.id === s.service)
    if (!service) continue
    const id = `r_${randomHex(8)}`
    const date = fits(service, s.day, s.time)
    if (!date) continue
    const start = parseTime(s.time)
    let heldPlan
    let offer = null
    if (s.offer) {
      const offerDate = fits(service, s.offer.day, s.offer.time)
      if (!offerDate) continue
      heldPlan = place(service, offerDate, parseTime(s.offer.time), `r:${id}`)
      offer = heldPlan
    } else {
      heldPlan = place(service, date, start, `r:${id}`)
    }
    if (!heldPlan) continue
    // An offered request keeps its original bays on the row; only the offer holds time.
    const bays = offer
      ? (pickBays(occupancy(holds, date, `r:${id}`), settings.bays, service.bays_needed, start, start + service.minutes) || heldPlan.bays)
      : heldPlan.bays
    stmts.push(db.prepare(
      `INSERT INTO requests (id, token, status, service_id, service_name, minutes, bays_needed, date, start_min, end_min, bays,
                             offer_date, offer_start_min, offer_end_min, offer_bays,
                             name, phone, year, make, model, note, shop_note, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23)`)
      .bind(id, randomUrlSafe(24), s.status, service.id, service.name, service.minutes, service.bays_needed, date, start, start + service.minutes,
        JSON.stringify(bays), offer ? offer.date : null, offer ? offer.start_min : null, offer ? offer.end_min : null,
        offer ? JSON.stringify(offer.bays) : null, s.name, s.phone, s.year, s.make, s.model, s.note, s.shop_note || '', stamp))
    stmts.push(...holdStatements(db, heldPlan))
    count++
  }

  // One walk-in block over lunch on the first open weekday after today.
  const blockDate = fits({ minutes: 60 }, 1, '12:00')
  if (blockDate) {
    const id = `b_${randomHex(8)}`
    const bays = Array.from({ length: settings.bays }, (_, i) => i + 1)
    const free = bays.every(bay => !occupancy(holds, blockDate).cells.get(bay)?.has(48))
    if (free) {
      stmts.push(db.prepare('INSERT INTO blocks (id, date, start_min, end_min, bays, label, created_at) VALUES (?1, ?2, 720, 780, ?3, ?4, ?5)')
        .bind(id, blockDate, JSON.stringify(bays), 'Walk-in', stamp))
      stmts.push(...holdStatements(db, { owner: `b:${id}`, date: blockDate, start_min: 720, end_min: 780, bays, n: null }))
    }
  }

  if (stmts.length) await db.batch(stmts)
  return json(200, { ok: true, today, requests: count })
}

// ---- router ----

const routes = [
  ['GET', /^\/api\/shop$/, getShop],
  ['GET', /^\/api\/days$/, getDays],
  ['GET', /^\/api\/slots$/, getSlots],
  ['POST', /^\/api\/requests$/, postRequest],
  ['GET', /^\/api\/r\/([A-Za-z0-9_-]{16,128})$/, getStatus],
  ['POST', /^\/api\/shop\/signin$/, signin],
  ['GET', /^\/api\/shop\/board$/, shopBoard, { shop: true }],
  ['POST', /^\/api\/shop\/requests\/(r_[A-Za-z0-9]{1,64})\/confirm$/, confirmRequest, { shop: true }],
  ['POST', /^\/api\/test\/reset$/, testReset, { test: true }],
  ['POST', /^\/api\/test\/seed$/, testSeed, { test: true }]
]

export default {
  async fetch (request, env) {
    const url = new URL(request.url)
    try {
      for (const [method, pattern, handler, opts = {}] of routes) {
        const m = pattern.exec(url.pathname)
        if (!m || request.method !== method) continue
        if (opts.test && !isTestMode(env)) break
        const c = { request, env, db: env.DB, url, params: m.slice(1), now: clockNow(request, env), ip: clientIp(request, env) }
        if (opts.shop) await requireShop(c)
        return await handler(c)
      }
      throw notFound('Not found.')
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, e.body)
      console.error(e)
      return json(500, { error: 'Something went wrong on our side. Please try again.', code: 'server_error' })
    }
  }
}

