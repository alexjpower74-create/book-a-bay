// Shop Board adapter: maps a confirmed request to the patch Shop Board's `PUT /api/bookings/:id` takes.
// Pure. Shop Board's rows and est. times are fixed (docs/API.md "Shop Board adapter"; Shop Board shared/domain.ts SLOTS, EST_TIMES).

import { timeLabel } from './slots.js'

/** Shop Board rows, top to bottom, with the minute each one starts. */
export const SHOP_BOARD_ROWS = [
  ['8:00', 480], ['9:00', 540], ['10:00', 600], ['11:00', 660], ['12:00 PM', 720], ['12:30 PM', 750],
  ['1:00', 780], ['2:00', 840], ['3:00', 900], ['4:00', 960], ['5:00', 1020]
]

export const CSV_COLUMNS = ['id', 'date', 'slot', 'bay', 'name', 'phone', 'year', 'make', 'model', 'issue', 'estTime']

/** The latest Shop Board row at or before the start; before 8:00 is the 8:00 row, after 5:00 PM the 5:00 row. */
export function slotFor (startMin) {
  let slot = SHOP_BOARD_ROWS[0][0]
  for (const [label, min] of SHOP_BOARD_ROWS) if (min <= startMin) slot = label
  return slot
}

export function estTimeFor (minutes) {
  if (minutes <= 30) return '30m'
  if (minutes <= 60) return '1h'
  if (minutes <= 120) return '2h'
  if (minutes <= 180) return '3h'
  if (minutes <= 240) return '4h'
  return 'Day'
}

export function shopBoardId (requestId) {
  return `bab-${requestId.replace(/^r_/, '')}`
}

const cut = (value, max) => String(value ?? '').slice(0, max)

/** `row` is a requests-table row. `at` is the ISO time of the write. */
export function toPatch (row, at) {
  const bays = typeof row.bays === 'string' ? JSON.parse(row.bays) : row.bays
  let issue = `${row.service_name} (booked online for ${timeLabel(row.start_min)})`
  if (row.note) issue += ` — ${row.note}`
  return {
    fields: {
      date: row.date,
      slot: slotFor(row.start_min),
      bay: String(bays[0]),
      name: cut(row.name, 80),
      phone: cut(row.phone, 32),
      year: cut(row.year, 8),
      make: cut(row.make, 32),
      model: cut(row.model, 40),
      issue: cut(issue, 280),
      estTime: estTimeFor(row.minutes)
    },
    at,
    by: 'Book a Bay'
  }
}

export function shopBoardItem (row, at) {
  return { id: shopBoardId(row.id), patch: toPatch(row, at) }
}

const csvCell = v => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function toCsv (items) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const { id, patch } of items) {
    lines.push(CSV_COLUMNS.map(k => csvCell(k === 'id' ? id : String(patch.fields[k] ?? ''))).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
