// Book a Bay Worker: the API in docs/API.md. Static files in ../app/public are served by [assets];
// only /api/* reaches this code.

import { now as clockNow, clientIp, isTestMode } from './clock.js'
import {
  CELL_MIN, parseTime, formatTime, isDate, addDays, timeLabel, dayLabel, slotLabel, localToInstant,
  dayInfo, today as shopToday, inWindow, candidateStarts, holdsFrom, occupancy, pickBays,
  availableStarts, listDays, nextSlots, startNumber
} from './slots.js'
import { shopBoardItem, toCsv } from './shopboard.js'

const HOLD_RETRIES = 3 // after the first try (API.md "The race")
const SESSION_DAYS = 14
const SIGNIN_LIMIT = { tries: 5, minutes: 15 }
const REQUEST_LIMIT = { tries: 12, minutes: 60 }
const PIN_ITERATIONS = 100000 // the Workers runtime cap for PBKDF2
const TIMEZONE = 'America/St_Johns'

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

const toB64 = bytes => btoa(String.fromCharCode(...bytes))
const fromB64 = b64 => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0))

function randomUrlSafe (bytes) {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
const allBays = settings => Array.from({ length: settings.bays }, (_, i) => i + 1)

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

/** A date and grid time for a service (rules 1-3 without holds), or 400 naming the field. */
function pickedTime (settings, now, service, body) {
  const date = windowDate(settings, now, body.date)
  const start = parseTime(body.time)
  if (start === null || !candidateStarts(settings, service, date).includes(start)) {
    throw badRequest('time', 'That time is not open for booking. Please pick another.')
  }
  return { date, start }
}

/** Statements that write a new hold's cells and (for requests) its numbered start. */
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

const errorText = e => String(e?.message || e) + String(e?.cause?.message || '')
const isUniqueViolation = e => /UNIQUE constraint failed/i.test(errorText(e))
// json() of a non-JSON string raises "malformed JSON", which rolls the whole batch back: the in-transaction guards use it.
const isGuardRefusal = e => /malformed JSON/i.test(errorText(e))
/** A hold lost to another writer: a racing hold on the same cells or start, or a bay removed by a settings save. */
const lostHold = e => isUniqueViolation(e) || isGuardRefusal(e)

// Bays in flight (API.md clarification 16). Every batch that writes cells carries this statement, bound to the highest bay
// it writes. It reads the bay count stored in settings at commit, inside the same transaction, and raises if that bay is gone,
// so either a settings save lowering bays commits first and this writer re-reads and retries, or this writer commits first and
// the save answers bays_in_use. tests/negative-bays.mjs replaces this line to show the double outcome; keep it as is.
const BAY_GUARD_SQL = "SELECT json(CASE WHEN ?1 > (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'bays') THEN 'bay removed' ELSE '0' END)"
const bayGuard = (db, bays) => db.prepare(BAY_GUARD_SQL).bind(Math.max(...bays))

/** Every hold overlapping [start, end) on the given bays of a date, named for people. */
async function conflictsAt (db, date, start, end, bays, exclude = null) {
  const [reqs, blocks] = await db.batch([
    db.prepare(`SELECT * FROM requests WHERE status IN ('requested', 'offered', 'confirmed') AND (date = ?1 OR offer_date = ?1)`).bind(date),
    db.prepare('SELECT * FROM blocks WHERE date = ?1').bind(date)
  ])
  const out = []
  const add = (owner, id, name, holdDate, s, e, holdBays) => {
    if (owner === exclude || holdDate !== date || s >= end || e <= start) return
    const overlap = holdBays.filter(b => bays.includes(b))
    if (overlap.length) out.push({ id, name, label: slotLabel(holdDate, s), bays: overlap })
  }
  for (const r of reqs.results) {
    const offered = r.status === 'offered'
    add(`r:${r.id}`, r.id, r.name, offered ? r.offer_date : r.date, offered ? r.offer_start_min : r.start_min,
      offered ? r.offer_end_min : r.end_min, parseArr(offered ? r.offer_bays : r.bays))
  }
  for (const b of blocks.results) add(`b:${b.id}`, b.id, b.label, b.date, b.start_min, b.end_min, parseArr(b.bays))
  return out
}

function busyError (conflicts) {
  const first = conflicts[0]
  const error = first ? `That time is already held on Bay ${first.bays[0]} by ${first.name} (${first.label}).` : 'That time is already held.'
  return new HttpError(409, 'busy', error, { conflicts })
}

function takenError ({ settings, service, date, start, now, holds, exclude = null }) {
  const next = nextSlots({ settings, service, date, start_min: start, now, holds, exclude })
  return new HttpError(409, 'taken', 'Sorry, that time was just taken.', { next })
}

// ---- race-safe status changes (API.md clarification 7) ----

// Every status change is one DB.batch(). The UPDATE only applies from the allowed statuses and stamps a fresh `rev`;
// every hold statement in the same batch checks that rev, so holds are released or placed only if this change happened.
// A conditional UPDATE that matches 0 rows does not abort a batch, which is why the hold statements need their own
// condition. tests/negative-status.mjs replaces IF_APPLIED to show what goes wrong without it; keep the line as is.
const IF_APPLIED = ' AND (SELECT rev FROM requests WHERE id = ?2) = ?3'

function releaseStatements (db, id, rev) {
  return ['cells', 'starts'].map(t => db.prepare(`DELETE FROM ${t} WHERE owner = ?1${IF_APPLIED}`).bind(`r:${id}`, id, rev))
}

function placeStatements (db, id, rev, plan) {
  const applied = '(SELECT rev FROM requests WHERE id = ?5) = ?6'
  const stmts = []
  for (const bay of plan.bays) {
    for (let cell = plan.start_min / CELL_MIN; cell < plan.end_min / CELL_MIN; cell++) {
      stmts.push(db.prepare(`INSERT INTO cells (date, bay, cell, owner) SELECT ?1, ?2, ?3, ?4 WHERE ${applied}`)
        .bind(plan.date, bay, cell, `r:${id}`, id, rev))
    }
  }
  stmts.push(db.prepare(`INSERT INTO starts (date, start_min, n, owner) SELECT ?1, ?2, ?3, ?4 WHERE ${applied}`)
    .bind(plan.date, plan.start_min, plan.n, `r:${id}`, id, rev))
  return stmts
}

/** Returns true when the transition applied. `set` may use ?4 onwards, bound from `binds`. */
async function changeStatus (db, { id, from, set, binds = [], now, holds = () => [] }) {
  const rev = randomHex(8)
  const statuses = from.map(s => `'${s}'`).join(', ')
  const update = db.prepare(`UPDATE requests SET ${set}, rev = ?1, updated_at = ?2 WHERE id = ?3 AND status IN (${statuses})`)
    .bind(rev, iso(now), id, ...binds)
  const [result] = await db.batch([update, ...holds(rev)])
  return result.meta.changes === 1
}

async function refusal (db, id, verb) {
  const row = await db.prepare('SELECT status FROM requests WHERE id = ?1').bind(id).first()
  if (!row) return notFound('That booking is not on the board any more.')
  return new HttpError(409, 'bad_state', `This booking is ${row.status}, so it cannot be ${verb}.`)
}

/**
 * Move a request's hold to (date, start) and change its status in one batch, retrying like POST /api/requests when a
 * racing batch wins. Returns { moved: true, applied } or { moved: false, holds } when the time is not free.
 */
async function moveHold (c, settings, row, { date, start, from, set, binds }) {
  const db = c.db
  const owner = `r:${row.id}`
  const today = shopToday(settings, c.now)
  const service = { minutes: row.minutes, bays_needed: row.bays_needed }
  for (let attempt = 0; attempt <= HOLD_RETRIES; attempt++) {
    if (attempt) settings = await loadSettings(db) // a lost hold may mean the bay count changed
    const holds = await loadHolds(db, today)
    const slot = availableStarts({ settings, service, date, now: c.now, holds, exclude: owner }).find(s => s.start_min === start)
    if (!slot) return { moved: false, holds, settings }
    const { results } = await db.prepare('SELECT n FROM starts WHERE date = ?1 AND start_min = ?2 AND owner != ?3').bind(date, start, owner).all()
    const n = startNumber(results.map(r => r.n), settings.max_per_slot)
    if (!n) return { moved: false, holds, settings }
    const plan = { date, start_min: start, end_min: slot.end_min, bays: slot.bays, n }
    try {
      const applied = await changeStatus(db, {
        id: row.id, from, set, binds: binds(plan), now: c.now,
        holds: rev => [bayGuard(db, plan.bays), ...releaseStatements(db, row.id, rev), ...placeStatements(db, row.id, rev, plan)]
      })
      return { moved: true, applied, settings }
    } catch (e) {
      if (!lostHold(e)) throw e
    }
  }
  settings = await loadSettings(db)
  return { moved: false, holds: await loadHolds(db, today), settings }
}

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

/**
 * Ready-made texts for the shop to copy into its own phone. Nothing is ever sent by the system.
 * The service name is always used as a name ("your Brakes booking"), so every service reads right.
 */
function messages (row, settings) {
  const shop = settings.shop_name.split(' — ')[0]
  const first = row.name.replace(/\s*\(sample\)\s*$/i, '').trim().split(/\s+/)[0] || 'there'
  const service = row.service_name
  const at = (date, min) => `${dayLabel(date)} at ${timeLabel(min)}`
  const link = statusUrl(row.token)
  const note = row.shop_note ? ` ${row.shop_note}` : ''
  const hi = `Hi ${first}, it's ${shop}.`
  const texts = {
    received: { label: 'Text to say we got it', text: `${hi} We got your request for ${service} on ${at(row.date, row.start_min)}. We'll confirm it soon. Details: ${link}` },
    confirmed: { label: 'Text to confirm', text: `${hi} Your ${service} booking is confirmed for ${at(row.date, row.start_min)}. Details: ${link}` },
    declined: { label: 'Text to decline', text: `${hi} Sorry, we can't fit in your ${service} booking on ${at(row.date, row.start_min)}.${note} Details: ${link}` },
    offered: row.offer_date && { label: 'Text with the new time', text: `${hi} We can't do ${at(row.date, row.start_min)} for your ${service} booking, but we can take you on ${at(row.offer_date, row.offer_start_min)}.${note} Accept it or pick another time here: ${link}` }
  }
  const keys = { requested: ['received', 'confirmed', 'declined'], confirmed: ['confirmed'], offered: ['offered'], declined: ['declined'] }[row.status] || []
  return keys.filter(k => texts[k]).map(k => ({ key: k, ...texts[k] }))
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

const blockView = b => ({ id: b.id, ...when(b.date, b.start_min, b.end_min), bays: parseArr(b.bays), label: b.label })

async function rowById (db, id) {
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first()
  if (!row) throw notFound('That booking is not on the board any more.')
  return row
}

async function rowByToken (db, token) {
  const row = await db.prepare('SELECT * FROM requests WHERE token = ?1').bind(token).first()
  if (!row) throw notFound('We could not find that booking. Please check the link the shop sent you.')
  return row
}

// ---- rate guards ----

async function recentAttempts (db, kind, key, now, minutes) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind = ?1 AND key = ?2 AND created_at > ?3')
    .bind(kind, key, iso(now - minutes * 60000)).first()
  return row.n
}

function recordAttempt (db, kind, key, now) {
  return db.batch([
    db.prepare('INSERT INTO attempts (kind, key, created_at) VALUES (?1, ?2, ?3)').bind(kind, key, iso(now)),
    db.prepare('DELETE FROM attempts WHERE created_at < ?1').bind(iso(now - 86400000))
  ])
}

async function guardSignin (c) {
  if (await recentAttempts(c.db, 'signin', c.ip, c.now, SIGNIN_LIMIT.minutes) >= SIGNIN_LIMIT.tries) {
    throw new HttpError(429, 'rate_limited', 'Too many wrong PINs. Please wait 15 minutes and try again.')
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

async function slotsResponse (c, settings, service, serviceId, exclude) {
  const date = windowDate(settings, c.now, c.url.searchParams.get('date'))
  const info = dayInfo(settings, date)
  const holds = await loadHolds(c.db, shopToday(settings, c.now))
  const slots = info.open ? availableStarts({ settings, service, date, now: c.now, holds, exclude }).map(({ time, label }) => ({ time, label })) : []
  return json(200, { service: serviceId, date, open: info.open, reason: info.reason, slots })
}

async function getSlots (c) {
  const settings = await loadSettings(c.db)
  const service = activeService(settings, c.url.searchParams.get('service'))
  return slotsResponse(c, settings, service, service.id, null)
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
  let settings = await loadSettings(db)
  const service = activeService(settings, body.service)
  const { date, start } = pickedTime(settings, c.now, service, body)
  const customer = validateCustomer(body)
  const today = shopToday(settings, c.now)

  if (await recentAttempts(db, 'request', c.ip, c.now, REQUEST_LIMIT.minutes) >= REQUEST_LIMIT.tries) {
    throw new HttpError(429, 'rate_limited', "That's a lot of requests from one place. Please call the shop, or try again in an hour.")
  }
  await recordAttempt(db, 'request', c.ip, c.now)

  const id = `r_${randomHex(8)}`
  const token = randomUrlSafe(24)
  const stamp = iso(c.now)
  const end = start + service.minutes
  const insertRequest = db.prepare(
    `INSERT INTO requests (id, token, status, service_id, service_name, minutes, bays_needed, date, start_min, end_min, bays,
                           name, phone, year, make, model, note, shop_note, created_at, updated_at)
     VALUES (?1, ?2, 'requested', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, '', ?17, ?17)`)

  for (let attempt = 0; attempt <= HOLD_RETRIES; attempt++) {
    if (attempt) settings = await loadSettings(db) // a lost hold may mean the bay count changed
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
      bayGuard(db, plan.bays),
      ...holdStatements(db, plan)
    ]
    let committed = false
    // The race guard. In scope: db, plan, stmts; sets committed. D1 runs a batch as one transaction and the UNIQUE
    // indexes on cells and starts make the second of two racing batches fail and roll back completely; the bay guard in
    // stmts does the same when a settings save removed the bay first. Either loss re-reads and retries.
    // tests/negative-race.mjs replaces exactly this region with an unguarded check-then-insert; keep the markers.
    // RACE-GUARD:BEGIN
    try {
      await db.batch(stmts)
      committed = true
    } catch (e) {
      if (!lostHold(e)) throw e
    }
    // RACE-GUARD:END
    if (committed) {
      return json(201, { id, token, status: 'requested', status_url: statusUrl(token) })
    }
  }

  settings = await loadSettings(db)
  throw takenError({ settings, service, date, start, now: c.now, holds: await loadHolds(db, today) })
}

async function getStatus (c) {
  const row = await rowByToken(c.db, c.params[0])
  return json(200, customerView(row, await loadSettings(c.db)))
}

async function acceptOffer (c) {
  const row = await rowByToken(c.db, c.params[0])
  // The hold already sits at the offered time; accepting only moves the request's own date and time onto it.
  const applied = await changeStatus(c.db, {
    id: row.id, from: ['offered'], now: c.now,
    set: "status = 'confirmed', date = offer_date, start_min = offer_start_min, end_min = offer_end_min, bays = offer_bays, offer_date = NULL, offer_start_min = NULL, offer_end_min = NULL, offer_bays = NULL"
  })
  if (!applied) throw await refusal(c.db, row.id, 'accepted')
  return json(200, customerView(await rowById(c.db, row.id), await loadSettings(c.db)))
}

async function repickTime (c) {
  const body = await readJson(c.request)
  const settings = await loadSettings(c.db)
  const row = await rowByToken(c.db, c.params[0])
  const from = ['requested', 'offered']
  if (!from.includes(row.status)) throw await refusal(c.db, row.id, 'moved to another time')
  const service = { minutes: row.minutes, bays_needed: row.bays_needed }
  const { date, start } = pickedTime(settings, c.now, service, body)
  const r = await moveHold(c, settings, row, {
    date, start, from,
    set: "status = 'requested', date = ?4, start_min = ?5, end_min = ?6, bays = ?7, offer_date = NULL, offer_start_min = NULL, offer_end_min = NULL, offer_bays = NULL",
    binds: p => [p.date, p.start_min, p.end_min, JSON.stringify(p.bays)]
  })
  if (!r.moved) throw takenError({ settings: r.settings, service, date, start, now: c.now, holds: r.holds, exclude: `r:${row.id}` })
  if (!r.applied) throw await refusal(c.db, row.id, 'moved to another time')
  return json(200, customerView(await rowById(c.db, row.id), r.settings))
}

async function customerCancel (c) {
  const row = await rowByToken(c.db, c.params[0])
  const applied = await changeStatus(c.db, {
    id: row.id, from: ['requested', 'offered', 'confirmed'], now: c.now, set: "status = 'cancelled'",
    holds: rev => releaseStatements(c.db, row.id, rev)
  })
  if (!applied) throw await refusal(c.db, row.id, 'cancelled')
  return json(200, customerView(await rowById(c.db, row.id), await loadSettings(c.db)))
}

function icsText (s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** RFC 5545 lines are at most 75 octets; longer ones continue on lines starting with a space. */
function foldLine (line) {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const parts = []
  let current = ''
  let limit = 75
  for (const ch of line) {
    if (enc.encode(current + ch).length > limit) {
      parts.push(current)
      current = ch
      limit = 74
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts.join('\r\n ')
}

async function getIcs (c) {
  const row = await rowByToken(c.db, c.params[0])
  if (row.status !== 'confirmed') {
    throw new HttpError(409, 'bad_state', 'The calendar file is ready once the shop confirms your booking.')
  }
  const settings = await loadSettings(c.db)
  const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Book a Bay//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${row.id}@book-a-bay`,
    `DTSTAMP:${stamp(c.now)}`,
    `DTSTART:${stamp(localToInstant(row.date, row.start_min, settings.timezone))}`,
    `DTEND:${stamp(localToInstant(row.date, row.end_min, settings.timezone))}`,
    `SUMMARY:${icsText(`${row.service_name} at ${settings.shop_name}`)}`,
    `DESCRIPTION:${icsText(`Booked with Book a Bay. Check your booking: ${c.url.origin}${statusUrl(row.token)}`)}`,
    'END:VEVENT', 'END:VCALENDAR'
  ]
  return new Response(lines.map(foldLine).join('\r\n') + '\r\n', {
    status: 200,
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="booking.ics"', 'cache-control': 'no-store' }
  })
}

// ---- shop routes ----

async function derivePin (pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

async function hashPin (pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { alg: 'PBKDF2-SHA256', iterations: PIN_ITERATIONS, salt: toB64(salt), hash: toB64(await derivePin(pin, salt, PIN_ITERATIONS)) }
}

async function verifyPin (pin, stored) {
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin) || !stored) return false
  const bits = await derivePin(pin, fromB64(stored.salt), stored.iterations)
  const want = fromB64(stored.hash)
  if (want.length !== bits.length) return false
  let diff = 0
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i]
  return diff === 0
}

async function signin (c) {
  const body = await readJson(c.request)
  await guardSignin(c)
  const settings = await loadSettings(c.db)
  if (!(await verifyPin(body.pin, settings.pin))) {
    await recordAttempt(c.db, 'signin', c.ip, c.now)
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
    const hash = await sha256Hex(m[1])
    const row = await c.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1').bind(hash).first()
    if (row && row.expires_at > iso(c.now)) {
      c.session = hash
      return
    }
  }
  throw new HttpError(401, 'unauthorized', 'Please sign in again.')
}

async function signout (c) {
  await c.db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(c.session).run()
  return json(200, { ok: true })
}

async function changePin (c) {
  const body = await readJson(c.request)
  await guardSignin(c)
  const settings = await loadSettings(c.db)
  if (!(await verifyPin(body.current, settings.pin))) {
    await recordAttempt(c.db, 'signin', c.ip, c.now)
    throw new HttpError(401, 'unauthorized', 'That PIN is not right.')
  }
  if (typeof body.next !== 'string' || !/^\d{4,8}$/.test(body.next)) throw badRequest('next', 'Your new PIN should be 4 to 8 digits.')
  const upsert = "INSERT INTO settings (key, value) VALUES ('pin', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  await c.db.batch([
    c.db.prepare(upsert).bind(JSON.stringify(await hashPin(body.next))),
    // Every other signed-in device has to sign in again with the new PIN; this one stays signed in.
    c.db.prepare('DELETE FROM sessions WHERE token_hash != ?1').bind(c.session)
  ])
  return json(200, { ok: true })
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
      items.push({ sort: [b.start_min, parseArr(b.bays)[0]], item: { kind: 'block', block: blockView(b) } })
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

function shopNote (body) {
  if (body.note === undefined || body.note === null) return null
  if (typeof body.note !== 'string' || body.note.trim().length > 280) throw badRequest('note', 'Please keep the note to 280 characters or fewer.')
  return body.note.trim()
}

async function shopSimpleChange (c, { from, status, verb, release }) {
  const body = await readJson(c.request)
  const note = shopNote(body)
  const id = c.params[0]
  const applied = await changeStatus(c.db, {
    id, from, now: c.now, set: `status = '${status}', shop_note = COALESCE(?4, shop_note)`, binds: [note],
    holds: release ? rev => releaseStatements(c.db, id, rev) : () => []
  })
  if (!applied) throw await refusal(c.db, id, verb)
  return json(200, shopView(await rowById(c.db, id), await loadSettings(c.db)))
}

const confirmRequest = c => shopSimpleChange(c, { from: ['requested'], status: 'confirmed', verb: 'confirmed', release: false })
const declineRequest = c => shopSimpleChange(c, { from: ['requested', 'offered'], status: 'declined', verb: 'declined', release: true })
const shopCancel = c => shopSimpleChange(c, { from: ['confirmed'], status: 'cancelled', verb: 'cancelled', release: true })

async function offerTime (c) {
  const body = await readJson(c.request)
  const db = c.db
  const settings = await loadSettings(db)
  const row = await rowById(db, c.params[0])
  const from = ['requested', 'offered']
  if (!from.includes(row.status)) throw await refusal(db, row.id, 'offered another time')
  const note = shopNote(body)
  const service = { minutes: row.minutes, bays_needed: row.bays_needed }
  const { date, start } = pickedTime(settings, c.now, service, body)
  const r = await moveHold(c, settings, row, {
    date, start, from,
    set: "status = 'offered', offer_date = ?4, offer_start_min = ?5, offer_end_min = ?6, offer_bays = ?7, shop_note = COALESCE(?8, shop_note)",
    binds: p => [p.date, p.start_min, p.end_min, JSON.stringify(p.bays), note]
  })
  if (!r.moved) {
    const owner = `r:${row.id}`
    const end = start + row.minutes
    if (!pickBays(occupancy(r.holds, date, owner), r.settings.bays, row.bays_needed, start, end)) {
      throw busyError(await conflictsAt(db, date, start, end, allBays(r.settings), owner))
    }
    throw takenError({ settings: r.settings, service, date, start, now: c.now, holds: r.holds, exclude: owner })
  }
  if (!r.applied) throw await refusal(db, row.id, 'offered another time')
  return json(200, shopView(await rowById(db, row.id), r.settings))
}

async function shopSlots (c) {
  const settings = await loadSettings(c.db)
  const exclude = c.url.searchParams.get('exclude')
  if (exclude) {
    // The request's own snapshot of its service, so a renamed or deactivated service can still be moved.
    const row = await rowById(c.db, exclude)
    return slotsResponse(c, settings, { minutes: row.minutes, bays_needed: row.bays_needed }, row.service_id, `r:${row.id}`)
  }
  const service = activeService(settings, c.url.searchParams.get('service'))
  return slotsResponse(c, settings, service, service.id, null)
}

async function createBlock (c) {
  const body = await readJson(c.request)
  const db = c.db
  const settings = await loadSettings(db)
  const today = shopToday(settings, c.now)
  if (!isDate(body.date) || body.date < today) throw badRequest('date', 'Pick a day from today on.')
  const start = parseTime(body.time)
  const end = parseTime(body.end)
  if (start === null || start % CELL_MIN) throw badRequest('time', 'Start time goes on the quarter hour, like 12:00 or 12:15.')
  if (end === null || end % CELL_MIN || end <= start) throw badRequest('end', 'End time goes on the quarter hour and after the start.')
  let bays
  if (body.bays === 'all') {
    bays = allBays(settings)
  } else if (Array.isArray(body.bays) && body.bays.length && body.bays.every(b => Number.isInteger(b) && b >= 1 && b <= settings.bays) && new Set(body.bays).size === body.bays.length) {
    bays = [...body.bays].sort((a, b) => a - b)
  } else {
    throw badRequest('bays', `Pick one or more bays from 1 to ${settings.bays}, or all bays.`)
  }
  const label = body.label === undefined ? 'Walk-in' : body.label
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 40) throw badRequest('label', 'Give the block-out a short name, up to 40 characters.')

  const conflicts = await conflictsAt(db, body.date, start, end, bays)
  if (conflicts.length) throw busyError(conflicts)
  const id = `b_${randomHex(8)}`
  const block = { id, date: body.date, start_min: start, end_min: end, bays: JSON.stringify(bays), label: label.trim() }
  try {
    await db.batch([
      db.prepare('INSERT INTO blocks (id, date, start_min, end_min, bays, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(id, block.date, start, end, block.bays, block.label, iso(c.now)),
      bayGuard(db, bays),
      ...holdStatements(db, { owner: `b:${id}`, date: block.date, start_min: start, end_min: end, bays, n: null })
    ])
  } catch (e) {
    if (isGuardRefusal(e)) throw badRequest('bays', 'The number of bays just changed. Please pick the bays again.')
    if (!isUniqueViolation(e)) throw e
    throw busyError(await conflictsAt(db, body.date, start, end, bays))
  }
  return json(201, { block: blockView(block) })
}

async function deleteBlock (c) {
  const id = c.params[0]
  const [removed] = await c.db.batch([
    c.db.prepare('DELETE FROM blocks WHERE id = ?1').bind(id),
    c.db.prepare('DELETE FROM cells WHERE owner = ?1').bind(`b:${id}`)
  ])
  if (removed.meta.changes !== 1) throw notFound('That block-out is already gone.')
  return json(200, { ok: true })
}

// ---- settings ----

const SETTINGS_KEYS = ['shop_name', 'timezone', 'bays', 'slot_step_min', 'lead_time_min', 'max_per_slot', 'window_days', 'hours', 'closures', 'services']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const settingsView = s => Object.fromEntries(SETTINGS_KEYS.map(k => [k, s[k]]))

function validateSettings (b) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(b)) throw new HttpError(400, 'bad_request', 'Settings could not be read. Please try again.')
  const int = (key, lo, hi, error) => {
    if (!Number.isInteger(b[key]) || b[key] < lo || b[key] > hi) throw badRequest(key, error)
    return b[key]
  }
  const out = {}
  if (typeof b.shop_name !== 'string' || !b.shop_name.trim() || b.shop_name.trim().length > 80) throw badRequest('shop_name', 'The shop name should be 1 to 80 characters.')
  out.shop_name = b.shop_name.trim()
  if (b.timezone !== TIMEZONE) throw badRequest('timezone', 'The time zone stays Newfoundland time (America/St_Johns) for now.')
  out.timezone = TIMEZONE
  out.bays = int('bays', 1, 10, 'Bays should be a number from 1 to 10.')
  if (![15, 30, 60].includes(b.slot_step_min)) throw badRequest('slot_step_min', 'Times should be offered every 15, 30 or 60 minutes.')
  out.slot_step_min = b.slot_step_min
  out.lead_time_min = int('lead_time_min', 0, 2880, 'Lead time should be 0 to 2880 minutes (2 days).')
  out.max_per_slot = int('max_per_slot', 1, 10, 'Bookings per time should be 1 to 10.')
  out.window_days = int('window_days', 1, 60, 'Customers can book 1 to 60 days ahead.')

  if (!isObj(b.hours) || Object.keys(b.hours).sort().join() !== '0,1,2,3,4,5,6') throw badRequest('hours', 'Opening hours need an entry for every day of the week.')
  out.hours = {}
  for (let d = 0; d < 7; d++) {
    const h = b.hours[String(d)]
    if (h === null) { out.hours[String(d)] = null; continue }
    const open = isObj(h) ? parseTime(h.open) : null
    const close = isObj(h) ? parseTime(h.close) : null
    if (open === null || close === null || open % CELL_MIN || close % CELL_MIN || open >= close) {
      throw badRequest('hours', `${DAY_NAMES[d]} needs an open time before the close time, on the quarter hour, or Closed.`)
    }
    out.hours[String(d)] = { open: h.open, close: h.close }
  }

  if (!Array.isArray(b.closures) || b.closures.length > 100) throw badRequest('closures', 'Up to 100 closed dates.')
  const seen = new Set()
  out.closures = b.closures.map(cl => {
    if (!isObj(cl) || !isDate(cl.date)) throw badRequest('closures', 'Each closed date needs a real date.')
    if (seen.has(cl.date)) throw badRequest('closures', `${dayLabel(cl.date)} is listed twice.`)
    seen.add(cl.date)
    if (typeof cl.reason !== 'string' || !cl.reason.trim() || cl.reason.trim().length > 60) throw badRequest('closures', `Give ${dayLabel(cl.date)} a reason, up to 60 characters.`)
    return { date: cl.date, reason: cl.reason.trim() }
  }).sort((x, y) => (x.date < y.date ? -1 : 1))

  if (!Array.isArray(b.services) || b.services.length < 1 || b.services.length > 30) throw badRequest('services', 'List 1 to 30 services.')
  const ids = new Set()
  out.services = b.services.map(s => {
    if (!isObj(s) || typeof s.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(s.id)) throw badRequest('services', 'Each service needs an id of lowercase letters, digits and dashes.')
    if (ids.has(s.id)) throw badRequest('services', `Two services use the id ${s.id}.`)
    ids.add(s.id)
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.trim().length > 40) throw badRequest('services', 'Each service needs a name, up to 40 characters.')
    const name = s.name.trim()
    if (!Number.isInteger(s.minutes) || s.minutes < 15 || s.minutes > 480 || s.minutes % 15) throw badRequest('services', `${name} should take 15 to 480 minutes, in 15-minute steps.`)
    if (!Number.isInteger(s.bays_needed) || s.bays_needed < 1 || s.bays_needed > out.bays) throw badRequest('services', `${name} needs 1 to ${out.bays} bays.`)
    if (typeof s.active !== 'boolean') throw badRequest('services', `Say whether ${name} is offered.`)
    return { id: s.id, name, minutes: s.minutes, bays_needed: s.bays_needed, active: s.active }
  })
  return out
}

/** "Bay 3 has 2 bookings from Tue Sep 15. Move or decline them first." for the lowest removed bay that holds time. */
function baysInUseMessage (holds, newBays) {
  const onBay = new Map()
  for (const h of holds) {
    for (const bay of h.bays) {
      if (bay <= newBays) continue
      const e = onBay.get(bay) || { count: 0, first: h.date }
      e.count++
      if (h.date < e.first) e.first = h.date
      onBay.set(bay, e)
    }
  }
  if (!onBay.size) return null
  const bay = Math.min(...onBay.keys())
  const { count, first } = onBay.get(bay)
  return `Bay ${bay} has ${count} ${count === 1 ? 'booking' : 'bookings'} from ${dayLabel(first)}. Move or decline ${count === 1 ? 'it' : 'them'} first.`
}

async function getSettings (c) {
  return json(200, settingsView(await loadSettings(c.db)))
}

async function putSettings (c) {
  const next = validateSettings(await readJson(c.request))
  const db = c.db
  const current = await loadSettings(db)
  const today = shopToday(current, c.now)
  const baysInUse = async () => new HttpError(409, 'bays_in_use',
    baysInUseMessage(await loadHolds(db, today), next.bays) || 'A bay you are removing still has bookings. Move or decline them first.')
  if (next.bays < current.bays && baysInUseMessage(await loadHolds(db, today), next.bays)) throw await baysInUse()

  const upsert = 'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  try {
    await db.batch([
      // Race guard for lowering bays: if a hold landed on a removed bay after the check above, json() of a non-JSON
      // string raises an error, which rolls the whole batch back.
      db.prepare("SELECT json(CASE WHEN EXISTS (SELECT 1 FROM cells WHERE bay > ?1 AND date >= ?2) THEN 'bays in use' ELSE '0' END)").bind(next.bays, today),
      ...SETTINGS_KEYS.map(k => db.prepare(upsert).bind(k, JSON.stringify(next[k])))
    ])
  } catch (e) {
    if (isGuardRefusal(e)) throw await baysInUse()
    throw e
  }
  return json(200, settingsView(await loadSettings(db)))
}

// ---- Shop Board ----

async function exportShopBoard (c) {
  const settings = await loadSettings(c.db)
  const from = c.url.searchParams.get('from') || shopToday(settings, c.now)
  if (!isDate(from)) throw badRequest('from', 'Pick a start date.')
  const to = c.url.searchParams.get('to') || addDays(from, 59)
  if (!isDate(to) || to < from) throw badRequest('to', 'Pick an end date on or after the start date.')
  const format = c.url.searchParams.get('format') || 'json'
  if (format !== 'json' && format !== 'csv') throw badRequest('format', 'Download as json or csv.')
  const { results } = await c.db.prepare("SELECT * FROM requests WHERE status = 'confirmed' AND date BETWEEN ?1 AND ?2 ORDER BY date, start_min, id")
    .bind(from, to).all()
  const at = iso(c.now)
  const items = results.map(r => shopBoardItem(r, at))
  const filename = `shop-board-${from}-to-${to}.${format}`
  if (format === 'csv') {
    return new Response(toCsv(items), {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' }
    })
  }
  return new Response(JSON.stringify({ format: 'shop-board-patches/v1', target: 'PUT /api/bookings/:id', items }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' }
  })
}

async function pushToShopBoard (c) {
  const base = c.env.SHOP_BOARD_URL
  if (!base) throw new HttpError(501, 'not_configured', 'Shop Board is not connected yet. Use "Download for Shop Board" instead.')
  const row = await c.db.prepare('SELECT * FROM requests WHERE id = ?1').bind(c.params[0]).first()
  if (!row) throw notFound('That booking is not on the board any more.')
  if (row.status !== 'confirmed') throw new HttpError(409, 'bad_state', 'Only confirmed bookings can be sent to Shop Board.')
  const { id, patch } = shopBoardItem(row, iso(c.now))
  let res
  let body = null
  try {
    res = await fetch(`${String(base).replace(/\/+$/, '')}/api/bookings/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(10000)
    })
    const text = await res.text()
    try { body = JSON.parse(text) } catch { body = text }
  } catch {
    throw new HttpError(502, 'shop_board_error', 'Could not reach Shop Board. Please try again.', { shop_board: { status: 0, body: null } })
  }
  if (!res.ok) {
    const said = body && typeof body === 'object' && body.error ? body.error : `error ${res.status}`
    throw new HttpError(502, 'shop_board_error', `Shop Board did not take it: ${said}`, { shop_board: { status: res.status, body } })
  }
  await c.db.prepare('UPDATE requests SET pushed_at = ?1 WHERE id = ?2').bind(iso(c.now), row.id).run()
  return json(200, { pushed: true, shop_board: { status: res.status, body } })
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

/** The raw hold rows of one owner, so tests can check holds against status. */
async function testHolds (c) {
  const owner = c.url.searchParams.get('owner') || ''
  const [cells, starts] = await c.db.batch([
    c.db.prepare('SELECT date, bay, cell FROM cells WHERE owner = ?1 ORDER BY date, bay, cell').bind(owner),
    c.db.prepare('SELECT date, start_min, n FROM starts WHERE owner = ?1 ORDER BY date, start_min').bind(owner)
  ])
  return json(200, { owner, cells: cells.results, starts: starts.results })
}

// A believable SAMPLE week. `day` = days after today, moved forward to the first date where the time fits.
// Listed oldest request first: created_at is spread back from now in this order, so the pending list reads true.
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
  for (const [index, s] of SEED.entries()) {
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
    const created = iso(c.now - (SEED.length - index) * 97 * 60000)
    stmts.push(db.prepare(
      `INSERT INTO requests (id, token, status, service_id, service_name, minutes, bays_needed, date, start_min, end_min, bays,
                             offer_date, offer_start_min, offer_end_min, offer_bays,
                             name, phone, year, make, model, note, shop_note, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?23)`)
      .bind(id, randomUrlSafe(24), s.status, service.id, service.name, service.minutes, service.bays_needed, date, start, start + service.minutes,
        JSON.stringify(bays), offer ? offer.date : null, offer ? offer.start_min : null, offer ? offer.end_min : null,
        offer ? JSON.stringify(offer.bays) : null, s.name, s.phone, s.year, s.make, s.model, s.note, s.shop_note || '', created))
    stmts.push(...holdStatements(db, heldPlan))
    count++
  }

  // One walk-in block over lunch on the first open weekday after today.
  const blockDate = fits({ minutes: 60 }, 1, '12:00')
  if (blockDate) {
    const id = `b_${randomHex(8)}`
    const bays = allBays(settings)
    const free = bays.every(bay => !occupancy(holds, blockDate).cells.get(bay)?.has(48))
    if (free) {
      stmts.push(db.prepare('INSERT INTO blocks (id, date, start_min, end_min, bays, label, created_at) VALUES (?1, ?2, 720, 780, ?3, ?4, ?5)')
        .bind(id, blockDate, JSON.stringify(bays), 'Walk-in', iso(c.now)))
      stmts.push(...holdStatements(db, { owner: `b:${id}`, date: blockDate, start_min: 720, end_min: 780, bays, n: null }))
    }
  }

  if (stmts.length) await db.batch(stmts)
  return json(200, { ok: true, today, requests: count })
}

// ---- router ----

const TOKEN = '([A-Za-z0-9_-]{16,128})'
const REQUEST_ID = '(r_[A-Za-z0-9]{1,64})'

const routes = [
  ['GET', /^\/api\/shop$/, getShop],
  ['GET', /^\/api\/days$/, getDays],
  ['GET', /^\/api\/slots$/, getSlots],
  ['POST', /^\/api\/requests$/, postRequest],
  ['GET', new RegExp(`^/api/r/${TOKEN}$`), getStatus],
  ['POST', new RegExp(`^/api/r/${TOKEN}/accept$`), acceptOffer],
  ['POST', new RegExp(`^/api/r/${TOKEN}/repick$`), repickTime],
  ['POST', new RegExp(`^/api/r/${TOKEN}/cancel$`), customerCancel],
  ['GET', new RegExp(`^/api/r/${TOKEN}/ics$`), getIcs],
  ['POST', /^\/api\/shop\/signin$/, signin],
  ['POST', /^\/api\/shop\/signout$/, signout, { shop: true }],
  ['PUT', /^\/api\/shop\/pin$/, changePin, { shop: true }],
  ['GET', /^\/api\/shop\/board$/, shopBoard, { shop: true }],
  ['GET', /^\/api\/shop\/slots$/, shopSlots, { shop: true }],
  ['POST', new RegExp(`^/api/shop/requests/${REQUEST_ID}/confirm$`), confirmRequest, { shop: true }],
  ['POST', new RegExp(`^/api/shop/requests/${REQUEST_ID}/decline$`), declineRequest, { shop: true }],
  ['POST', new RegExp(`^/api/shop/requests/${REQUEST_ID}/offer$`), offerTime, { shop: true }],
  ['POST', new RegExp(`^/api/shop/requests/${REQUEST_ID}/cancel$`), shopCancel, { shop: true }],
  ['POST', new RegExp(`^/api/shop/requests/${REQUEST_ID}/push$`), pushToShopBoard, { shop: true }],
  ['POST', /^\/api\/shop\/blocks$/, createBlock, { shop: true }],
  ['DELETE', /^\/api\/shop\/blocks\/(b_[A-Za-z0-9]{1,64})$/, deleteBlock, { shop: true }],
  ['GET', /^\/api\/shop\/settings$/, getSettings, { shop: true }],
  ['PUT', /^\/api\/shop\/settings$/, putSettings, { shop: true }],
  ['GET', /^\/api\/shop\/export\/shop-board$/, exportShopBoard, { shop: true }],
  ['POST', /^\/api\/test\/reset$/, testReset, { test: true }],
  ['POST', /^\/api\/test\/seed$/, testSeed, { test: true }],
  ['GET', /^\/api\/test\/holds$/, testHolds, { test: true }]
]

export default {
  async fetch (request, env) {
    const url = new URL(request.url)
    try {
      for (const [method, pattern, handler, opts = {}] of routes) {
        const m = pattern.exec(url.pathname)
        if (!m || request.method !== method) continue
        // Test routes do not exist without TEST_MODE=1: refused here, before anything touches the database.
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
