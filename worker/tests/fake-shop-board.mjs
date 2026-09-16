// A fake Shop Board for contract tests: `PUT /api/bookings/:id` with Shop Board's own validation and occupancy answers.
// Transcribed from the Shop Board repo at commit 25c6faa (`git -C "<Shop Board>" rev-parse --short HEAD`, 2026-09-14):
//   shared/domain.ts     SLOTS, EST_TIMES, MAX_FIELD_LENGTH, FIELDS, PLACEMENT, isId, isISODate, isISOStamp, isSlot,
//                        isBay, isMergeField, validatePatch, emptyBooking (bay '1'), rowsOf, spanOf, busyUntil, collision,
//                        busyMessage
//   worker/src/index.ts  save(): 400 { error }; a row held by another id -> 409 { error: "<slot> is taken", code: "taken",
//                        conflict: { slot, bay } }; a longer job running through the row -> 409 { error: busyMessage(…, 'Bay'),
//                        code: "busy", conflict: { slot, bay, until, with } }; otherwise 200 { id, booking, rejected }.
// The lead confirmed those bodies against a throwaway local clone at the same commit.
// Not modelled: the per-cell stamp merge (a patch simply overwrites the fields it names), drag swaps, deletes, live sync.
// Test-only extras: GET /__health, POST /__reset, GET /__bookings.
// Run on its own: PORT=7304 node tests/fake-shop-board.mjs

import http from 'node:http'
import { fileURLToPath } from 'node:url'

export const SLOTS = ['8:00', '9:00', '10:00', '11:00', '12:00 PM', '12:30 PM', '1:00', '2:00', '3:00', '4:00', '5:00']
export const EST_TIMES = ['', '30m', '1h', '2h', '3h', '4h', 'Day']
const FIELDS = ['name', 'phone', 'year', 'make', 'model', 'issue', 'estTime']
const PLACEMENT = ['date', 'slot', 'bay']
const MERGE_FIELDS = [...FIELDS, ...PLACEMENT]
const MAX_FIELD_LENGTH = { name: 80, phone: 32, year: 8, make: 32, model: 40, issue: 280, estTime: 8 }
const MAX_BAYS = 10

const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v)
function isISODate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
function isISOStamp(v) {
  if (typeof v !== 'string') return false
  const t = Date.parse(v)
  return !Number.isNaN(t) && new Date(t).toISOString() === v
}
const isSlot = (v) => typeof v === 'string' && SLOTS.includes(v)
const isBay = (v) => typeof v === 'string' && /^([1-9]|10)$/.test(v)
const isMergeField = (v) => typeof v === 'string' && MERGE_FIELDS.includes(v)

/** Shop Board's validatePatch: null when well formed, otherwise the reason. */
export function validatePatch(patch) {
  if (!isId(patch.id)) return 'id must be 6-64 characters of [A-Za-z0-9_-]'
  if (!isISOStamp(patch.at)) return 'at must be an ISO timestamp'
  if (typeof patch.by !== 'string' || patch.by.length === 0 || patch.by.length > 40) return 'by must be a name of 1-40 characters'
  const entries = Object.entries(patch.fields ?? {})
  if (entries.length === 0) return 'fields must contain at least one field'
  for (const [field, value] of entries) {
    if (!isMergeField(field)) return `unknown field ${field}`
    if (typeof value !== 'string') return `${field} must be a string`
    if (field === 'date' && !isISODate(value)) return 'date must be YYYY-MM-DD'
    if (field === 'slot' && !isSlot(value)) return `slot must be one of ${SLOTS.join(', ')}`
    if (field === 'bay' && !isBay(value)) return `bay must be 1-${MAX_BAYS}`
    if (field === 'estTime' && !EST_TIMES.includes(value)) return `estTime must be one of ${EST_TIMES.filter(Boolean).join(', ')} or empty`
    if (field in MAX_FIELD_LENGTH && value.length > MAX_FIELD_LENGTH[field])
      return `${field} must be at most ${MAX_FIELD_LENGTH[field]} characters`
  }
  return null
}

function rowsOf(estTime) {
  switch (estTime) {
    case '1h':
      return 2
    case '2h':
      return 3
    case '3h':
      return 4
    case '4h':
      return 5
    case 'Day':
      return SLOTS.length
    default:
      return 1
  }
}
function spanOf(slot, estTime) {
  const i = SLOTS.indexOf(slot)
  if (i < 0) return []
  return SLOTS.slice(i, Math.min(SLOTS.length, i + rowsOf(estTime)))
}
function busyUntil(b) {
  const span = spanOf(b.slot, b.estTime)
  return SLOTS[SLOTS.indexOf(span[span.length - 1]) + 1] ?? null
}
function collision(candidate, others) {
  const mine = new Set(spanOf(candidate.slot, candidate.estTime))
  const hit = others
    .filter((o) => o.id !== candidate.id && o.date === candidate.date && o.bay === candidate.bay)
    .filter((o) => spanOf(o.slot, o.estTime).some((row) => mine.has(row)))
    .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot))[0]
  return hit ? { with: hit, until: busyUntil(hit) } : null
}
function busyMessage(c, bayLabel) {
  const who = c.with.name || c.with.make || 'another booking'
  return `${bayLabel} ${c.with.bay} is busy ${c.until ? `until ${c.until}` : 'for the rest of the day'} with ${who}`
}
function emptyBooking(id, date, slot, by, at, bay = '1') {
  return {
    id,
    date,
    slot,
    bay,
    name: '',
    phone: '',
    year: '',
    make: '',
    model: '',
    issue: '',
    estTime: '',
    updatedBy: by,
    updatedAt: at,
    stamps: {},
  }
}

export function startFakeShopBoard({ port = 7304, host = '127.0.0.1' } = {}) {
  const bookings = new Map()

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const fail = (res, error, status, extra = {}) => send(res, status, { error, ...extra })

  function save(res, id, body) {
    if (!isId(id)) return fail(res, 'Bad booking id', 400)
    if (!body) return fail(res, 'Body must be a JSON object', 400)
    const patch = { id, fields: body.fields ?? {}, at: String(body.at ?? ''), by: String(body.by ?? '') }
    if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) return fail(res, 'fields must be an object', 400)
    const invalid = validatePatch(patch)
    if (invalid) return fail(res, invalid, 400)

    const existing = bookings.get(id) ?? null
    if (!existing && !(typeof patch.fields.date === 'string' && typeof patch.fields.slot === 'string')) {
      return fail(res, 'A new booking must include date and slot', 400)
    }
    const base = existing ?? emptyBooking(id, patch.fields.date, patch.fields.slot, patch.by, patch.at)
    const next = { ...base, ...patch.fields, updatedBy: patch.by, updatedAt: patch.at }
    if (FIELDS.every((f) => !next[f])) {
      const deleted = bookings.delete(id)
      return send(res, 200, { id, deleted, booking: null, rejected: [] })
    }

    const moving = !!existing && (existing.date !== next.date || existing.slot !== next.slot || existing.bay !== next.bay)
    const all = [...bookings.values()]
    const occupant = all.find((b) => b.date === next.date && b.slot === next.slot && b.bay === next.bay && b.id !== id)
    if (occupant) {
      // Shop Board swaps two cars on a drag (moving); the fake refuses both ways, which is all Book a Bay ever meets.
      return fail(res, `${next.slot} is taken`, 409, {
        code: 'taken',
        conflict: { slot: next.slot, bay: next.bay },
        ...(moving ? { moving: true } : {}),
      })
    }
    const clash = collision(
      next,
      all.filter((b) => b.date === next.date),
    )
    if (clash) {
      return fail(res, busyMessage(clash, 'Bay'), 409, {
        code: 'busy',
        conflict: { slot: clash.with.slot, bay: clash.with.bay, until: clash.until, with: clash.with.name },
      })
    }
    bookings.set(id, next)
    return send(res, 200, { id, booking: next, rejected: [] })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake')
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (url.pathname === '/__health') return send(res, 200, { ok: true, fake: 'shop-board' })
      if (url.pathname === '/__reset' && req.method === 'POST') {
        bookings.clear()
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/__bookings') return send(res, 200, { bookings: [...bookings.values()] })
      const m = /^\/api\/bookings\/([^/]+)$/.exec(url.pathname)
      if (m && req.method === 'PUT') {
        let body = null
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
        } catch {}
        return save(res, decodeURIComponent(m[1]), body)
      }
      return fail(res, 'Not found', 404)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () =>
      resolve({
        url: `http://${host}:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    )
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7304)
  startFakeShopBoard({ port }).then(({ url }) => console.log(`fake Shop Board listening on ${url}`))
}
