// Slot maths: docs/API.md "Slot rules" 1-7, implemented once, pure (no D1, no clock, no fetch).
// Times are shop local: date "YYYY-MM-DD", minutes after midnight. Instants are epoch milliseconds.

export const CELL_MIN = 15
export const HOLDING = ['requested', 'offered', 'confirmed']

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = n => String(n).padStart(2, '0')

// ---- dates, times, labels ----

export function parseTime (s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof s === 'string' ? s : '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

export function formatTime (min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`
}

export function isDate (s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

export function addDays (date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function weekday (date) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function timeLabel (min) {
  const h = Math.floor(min / 60)
  return `${h % 12 || 12}:${pad(min % 60)} ${h < 12 ? 'AM' : 'PM'}`
}

export function dayLabel (date) {
  const [, m, d] = date.split('-').map(Number)
  return `${DOW[weekday(date)]} ${MONTH[m - 1]} ${d}`
}

export function slotLabel (date, min) {
  return `${dayLabel(date)}, ${timeLabel(min)}`
}

// ---- time zone (Intl only; the Worker's own zone is UTC and must not matter) ----

const formatters = new Map()
function zoneParts (ms, tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
    formatters.set(tz, f)
  }
  const p = {}
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value
  return p
}

function zoneOffsetMs (ms, tz) {
  const p = zoneParts(ms, tz)
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** The instant of a shop-local date and minute. */
export function localToInstant (date, min, tz) {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, min)
  const offset = zoneOffsetMs(guess, tz)
  let t = guess - offset
  const offset2 = zoneOffsetMs(t, tz)
  if (offset2 !== offset) t = guess - offset2
  return t
}

/** The shop-local date of an instant. */
export function localDate (ms, tz) {
  const p = zoneParts(ms, tz)
  return `${p.year}-${p.month}-${p.day}`
}

// ---- rules ----

/** Rule 1: is the date open, and if not, why. */
export function dayInfo (settings, date) {
  const closure = (settings.closures || []).find(c => c.date === date)
  if (closure) return { open: false, reason: closure.reason, hours: null }
  const hours = settings.hours[String(weekday(date))]
  if (!hours) return { open: false, reason: `Closed ${WEEKDAY[weekday(date)]}s`, hours: null }
  return { open: true, reason: null, hours: { open: hours.open, close: hours.close } }
}

export function today (settings, nowMs) {
  return localDate(nowMs, settings.timezone)
}

/** The window_days dates starting today. */
export function windowDates (settings, nowMs) {
  const first = today(settings, nowMs)
  return Array.from({ length: settings.window_days }, (_, i) => addDays(first, i))
}

/** Rule 3, date part. */
export function inWindow (settings, nowMs, date) {
  const first = today(settings, nowMs)
  return date >= first && date < addDays(first, settings.window_days)
}

/** Rule 2: candidate starts for a service on a date, before any holds or the clock. */
export function candidateStarts (settings, service, date) {
  const info = dayInfo(settings, date)
  if (!info.open) return []
  const open = parseTime(info.hours.open)
  const close = parseTime(info.hours.close)
  const out = []
  for (let s = open; s + service.minutes <= close; s += settings.slot_step_min) out.push(s)
  return out
}

/**
 * Rule 6: what holds bay time. `requests` are rows shaped like the requests table (bays / offer_bays may be JSON
 * strings or arrays); `blocks` like the blocks table. Offered requests hold their offer, not their original time.
 */
export function holdsFrom (requests = [], blocks = []) {
  const arr = v => (typeof v === 'string' ? JSON.parse(v) : v)
  const holds = []
  for (const r of requests) {
    if (!HOLDING.includes(r.status)) continue
    if (r.status === 'offered') {
      holds.push({ owner: `r:${r.id}`, kind: 'request', date: r.offer_date, start_min: r.offer_start_min, end_min: r.offer_end_min, bays: arr(r.offer_bays) })
    } else {
      holds.push({ owner: `r:${r.id}`, kind: 'request', date: r.date, start_min: r.start_min, end_min: r.end_min, bays: arr(r.bays) })
    }
  }
  for (const b of blocks) {
    holds.push({ owner: `b:${b.id}`, kind: 'block', date: b.date, start_min: b.start_min, end_min: b.end_min, bays: arr(b.bays) })
  }
  return holds
}

/** Held cells per bay and holding-request starts for one date. `exclude` is an owner ("r:<id>") treated as free. */
export function occupancy (holds, date, exclude = null) {
  const cells = new Map()
  const starts = new Map()
  for (const h of holds) {
    if (h.date !== date || h.owner === exclude) continue
    for (const bay of h.bays) {
      if (!cells.has(bay)) cells.set(bay, new Set())
      for (let c = h.start_min / CELL_MIN; c < h.end_min / CELL_MIN; c++) cells.get(bay).add(c)
    }
    if (h.kind === 'request') starts.set(h.start_min, (starts.get(h.start_min) || 0) + 1)
  }
  return { cells, starts }
}

/** Rule 5: the lowest-numbered `needed` bays among 1..bayCount with every cell of [start, end) free, or null. */
export function pickBays (occ, bayCount, needed, start, end) {
  const free = []
  for (let bay = 1; bay <= bayCount; bay++) {
    const held = occ.cells.get(bay)
    let ok = true
    for (let c = start / CELL_MIN; c < end / CELL_MIN; c++) {
      if (held && held.has(c)) { ok = false; break }
    }
    if (ok) {
      free.push(bay)
      if (free.length === needed) return free
    }
  }
  return null
}

/** Rules 1-6 together: the starts a customer can book. Each is { time, label, start_min, end_min, bays }. */
export function availableStarts ({ settings, service, date, now, holds, exclude = null }) {
  if (!inWindow(settings, now, date)) return []
  const occ = occupancy(holds, date, exclude)
  const earliest = now + settings.lead_time_min * 60000
  const out = []
  for (const s of candidateStarts(settings, service, date)) {
    if (localToInstant(date, s, settings.timezone) < earliest) continue
    if ((occ.starts.get(s) || 0) >= settings.max_per_slot) continue
    const end = s + service.minutes
    const bays = pickBays(occ, settings.bays, service.bays_needed, s, end)
    if (!bays) continue
    out.push({ time: formatTime(s), label: timeLabel(s), start_min: s, end_min: end, bays })
  }
  return out
}

/** GET /api/days: every date in the window with its open state and how many starts are left. `exclude` frees one owner's hold. */
export function listDays ({ settings, service, now, holds, exclude = null }) {
  return windowDates(settings, now).map(date => {
    const info = dayInfo(settings, date)
    return {
      date,
      label: dayLabel(date),
      open: info.open,
      reason: info.reason,
      available: info.open ? availableStarts({ settings, service, date, now, holds, exclude }).length : 0
    }
  })
}

/** `next`: up to `count` available starts chronologically after (date, start_min): rest of that day, then later days.
 *  `exclude` ("r:<id>") treats that request's own hold as free, for moving a booking. */
export function nextSlots ({ settings, service, date, start_min, now, holds, exclude = null, count = 3 }) {
  const out = []
  for (const d of windowDates(settings, now)) {
    if (d < date) continue
    for (const slot of availableStarts({ settings, service, date: d, now, holds, exclude })) {
      if (d === date && slot.start_min <= start_min) continue
      out.push({ date: d, time: slot.time, label: slotLabel(d, slot.start_min) })
      if (out.length === count) return out
    }
  }
  return out
}

/** The smallest start number 1..max not already taken (the `starts.n` column), or null when the slot is full. */
export function startNumber (takenNumbers, max) {
  const taken = new Set(takenNumbers)
  for (let n = 1; n <= max; n++) if (!taken.has(n)) return n
  return null
}
