// Pure slot maths (src/slots.js). No Worker, no D1. Run: node --test tests/slots.test.mjs
// Clock: Mon 2026-09-14 11:30Z = 9:00 AM NDT (UTC-2:30), the same instant the app's Playwright suite pins.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  availableStarts,
  dayInfo,
  listDays,
  nextSlots,
  holdsFrom,
  inWindow,
  localToInstant,
  localDate,
  timeLabel,
  dayLabel,
  slotLabel,
  startNumber,
  pickBays,
  occupancy,
  parseTime,
} from '../src/slots.js'

const NOW = Date.parse('2026-09-14T11:30:00Z')
const TUE = '2026-09-15'
const weekday = { open: '08:00', close: '17:00' }

const settings = (over = {}) => ({
  timezone: 'America/St_Johns',
  bays: 3,
  slot_step_min: 30,
  lead_time_min: 60,
  max_per_slot: 2,
  window_days: 14,
  hours: { 0: null, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: { open: '09:00', close: '13:00' } },
  closures: [],
  ...over,
})

const oil = { id: 'oil', name: 'Oil change', minutes: 30, bays_needed: 1 }
const brakes = { id: 'brakes', name: 'Brakes', minutes: 120, bays_needed: 1 }
const truck = { id: 'truck-rv', name: 'Truck or RV service', minutes: 120, bays_needed: 2 }

let seq = 0
function req(status, date, time, minutes, bays, offer) {
  const start = parseTime(time)
  const row = { id: `t${++seq}`, status, date, start_min: start, end_min: start + minutes, bays: JSON.stringify(bays) }
  if (offer) {
    const os = parseTime(offer.time)
    Object.assign(row, { offer_date: offer.date, offer_start_min: os, offer_end_min: os + minutes, offer_bays: JSON.stringify(offer.bays) })
  }
  return row
}

const times = (s, service, date, holds = [], now = NOW) => availableStarts({ settings: s, service, date, now, holds }).map((x) => x.time)
const slotAt = (s, service, date, time, holds = [], now = NOW) =>
  availableStarts({ settings: s, service, date, now, holds }).find((x) => x.time === time)

test('an open day has the full grid in slot_step_min steps', () => {
  const t = times(settings(), oil, TUE)
  assert.equal(t[0], '08:00')
  assert.equal(t[1], '08:30')
  assert.equal(t.at(-1), '16:30')
  assert.equal(t.length, 18)
  const hourly = times(settings({ slot_step_min: 60 }), oil, TUE)
  assert.deepEqual(hourly, ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'])
  assert.equal(times(settings({ slot_step_min: 15 }), oil, TUE).length, 35)
  assert.deepEqual(times(settings(), oil, '2026-09-19'), ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'])
})

test('lead time drops starts earlier than now + lead_time_min', () => {
  const today = '2026-09-14' // now is 9:00 AM
  assert.equal(times(settings(), oil, today)[0], '10:00')
  assert.equal(times(settings({ lead_time_min: 0 }), oil, today)[0], '09:00')
  assert.equal(times(settings({ lead_time_min: 90 }), oil, today)[0], '10:30')
  assert.equal(times(settings({ lead_time_min: 60 * 24 }), oil, today).length, 0)
})

test('Sunday is closed with its reason and has no slots', () => {
  const info = dayInfo(settings(), '2026-09-20')
  assert.deepEqual(info, { open: false, reason: 'Closed Sundays', hours: null })
  assert.deepEqual(times(settings(), oil, '2026-09-20'), [])
  const day = listDays({ settings: settings(), service: oil, now: NOW, holds: [] }).find((d) => d.date === '2026-09-20')
  assert.deepEqual(day, { date: '2026-09-20', label: 'Sun Sep 20', open: false, reason: 'Closed Sundays', available: 0 })
  assert.equal(dayInfo(settings({ hours: { ...settings().hours, 3: null } }), '2026-09-16').reason, 'Closed Wednesdays')
})

test('a closure date is closed with its reason', () => {
  const closures = [{ date: '2026-09-16', reason: 'Staff training (sample)' }]
  assert.equal(dayInfo(settings(), '2026-09-16').open, true) // the same Wednesday without the closure
  assert.deepEqual(dayInfo(settings({ closures }), '2026-09-16'), { open: false, reason: 'Staff training (sample)', hours: null })
  assert.deepEqual(times(settings({ closures }), oil, '2026-09-16'), [])
  const day = listDays({ settings: settings({ closures }), service: oil, now: NOW, holds: [] }).find((d) => d.date === '2026-09-16')
  assert.equal(day.open, false)
  assert.equal(day.reason, 'Staff training (sample)')
  assert.equal(day.available, 0)
})

test('a 2 h service is not offered where it would pass closing', () => {
  const t = times(settings(), brakes, TUE)
  assert.equal(t.at(-1), '15:00')
  assert.ok(!t.includes('15:30'))
  assert.equal(times(settings(), brakes, '2026-09-19').at(-1), '11:00') // Saturday closes at 1:00 PM
})

test('the bay-count change: capacity follows settings.bays, not the bays that happen to hold time', () => {
  // Holds fill bays 1 and 2 across 10:00 (different starts, so max_per_slot is not what removes it).
  const full12 = holdsFrom([req('confirmed', TUE, '09:00', 120, [1]), req('requested', TUE, '09:30', 120, [2])])
  assert.equal(slotAt(settings({ bays: 2 }), oil, TUE, '10:00', full12), undefined, 'bays: 2 -> 10:00 is gone')
  assert.deepEqual(slotAt(settings({ bays: 3 }), oil, TUE, '10:00', full12)?.bays, [3], 'bays: 3 -> 10:00 is back, on bay 3')

  // A hold on bay 3 does not use capacity once bays: 2.
  const bay1and3 = holdsFrom([req('confirmed', TUE, '09:00', 120, [1]), req('confirmed', TUE, '10:00', 60, [3])])
  assert.deepEqual(slotAt(settings({ bays: 2 }), oil, TUE, '10:00', bay1and3)?.bays, [2])
  const onlyBay3 = holdsFrom([req('confirmed', TUE, '10:00', 120, [3])])
  assert.deepEqual(slotAt(settings({ bays: 2 }), truck, TUE, '10:00', onlyBay3)?.bays, [1, 2])
  assert.equal(slotAt(settings({ bays: 1 }), oil, TUE, '10:00', full12), undefined)
})

test('bays_needed: 2 needs two free bays at once', () => {
  const bay2 = holdsFrom([req('confirmed', TUE, '10:00', 60, [2])])
  assert.deepEqual(slotAt(settings(), truck, TUE, '10:00', bay2)?.bays, [1, 3])
  const bays12 = holdsFrom([req('confirmed', TUE, '10:00', 60, [1]), req('confirmed', TUE, '11:00', 60, [2])])
  assert.equal(slotAt(settings(), truck, TUE, '10:00', bays12), undefined, 'only bay 3 is free all the way through')
  assert.deepEqual(slotAt(settings(), oil, TUE, '10:00', bays12)?.bays, [2], 'a 1-bay service still fits')
  assert.deepEqual(slotAt(settings(), truck, TUE, '12:00', bays12)?.bays, [1, 2])
})

test('max_per_slot caps holding requests starting at the same time, shop-wide', () => {
  const two = holdsFrom([req('confirmed', TUE, '10:00', 30, [1]), req('requested', TUE, '10:00', 30, [2])])
  const s5 = settings({ bays: 5 })
  assert.equal(slotAt(s5, oil, TUE, '10:00', two), undefined, 'max 2 reached although bays 3-5 are free')
  assert.deepEqual(slotAt({ ...s5, max_per_slot: 3 }, oil, TUE, '10:00', two)?.bays, [3])
  assert.ok(slotAt(s5, oil, TUE, '10:30', two), 'the next start is not capped')
  const blocks = holdsFrom(
    [],
    [
      { id: 'b1', date: TUE, start_min: 600, end_min: 630, bays: '[1]' },
      { id: 'b2', date: TUE, start_min: 600, end_min: 630, bays: '[2]' },
    ],
  )
  assert.deepEqual(slotAt(settings(), oil, TUE, '10:00', blocks)?.bays, [3], 'block-outs hold bays but are not bookings in the cap')
  assert.equal(startNumber([1], 2), 2)
  assert.equal(startNumber([2], 2), 1, 'a released number is reused')
  assert.equal(startNumber([1, 2], 2), null)
})

test('declined and cancelled requests hold nothing', () => {
  const rows = [1, 2, 3].flatMap((bay) => [req('declined', TUE, '10:00', 60, [bay]), req('cancelled', TUE, '10:00', 60, [bay])])
  assert.equal(holdsFrom(rows).length, 0)
  assert.deepEqual(slotAt(settings(), oil, TUE, '10:00', holdsFrom(rows))?.bays, [1])
  const held = [1, 2, 3].map((bay) => req('confirmed', TUE, '10:00', 60, [bay]))
  assert.equal(
    slotAt(settings({ max_per_slot: 5 }), oil, TUE, '10:00', holdsFrom(held)),
    undefined,
    'control: the same rows confirmed do hold',
  )
})

test('an offered request holds its offer time, not its original time', () => {
  const offered = holdsFrom([req('offered', TUE, '10:00', 60, [1], { date: TUE, time: '13:00', bays: [1] })])
  const s1 = settings({ bays: 1 })
  assert.ok(slotAt(s1, oil, TUE, '10:00', offered), 'original 10:00 is free')
  assert.equal(slotAt(s1, oil, TUE, '13:00', offered), undefined, 'offered 13:00 is held')
  const elsewhere = holdsFrom([req('offered', TUE, '10:00', 60, [1], { date: '2026-09-16', time: '10:00', bays: [1] })])
  assert.equal(slotAt(s1, oil, '2026-09-16', '10:00', elsewhere), undefined, 'the hold moves to the offered date')
  assert.ok(slotAt(s1, oil, TUE, '10:00', elsewhere))
})

test('window edges: today is in, today + window_days is out, yesterday is out', () => {
  const s = settings()
  assert.equal(inWindow(s, NOW, '2026-09-14'), true)
  assert.equal(inWindow(s, NOW, '2026-09-27'), true)
  assert.equal(inWindow(s, NOW, '2026-09-28'), false)
  assert.equal(inWindow(s, NOW, '2026-09-13'), false)
  assert.deepEqual(times(s, oil, '2026-09-28'), [], 'Mon Sep 28 is open but past the window')
  assert.equal(times(settings({ window_days: 15 }), oil, '2026-09-28')[0], '08:00')
  const days = listDays({ settings: s, service: oil, now: NOW, holds: [] })
  assert.equal(days.length, 14)
  assert.equal(days[0].date, '2026-09-14')
  assert.equal(days.at(-1).date, '2026-09-27')
  // Late evening in NL is already the next UTC day; "today" must follow the shop, not UTC.
  const lateSun = Date.parse('2026-09-14T02:00:00Z') // Sun Sep 13, 11:30 PM NDT
  assert.equal(localDate(lateSun, 'America/St_Johns'), '2026-09-13')
  assert.equal(inWindow(s, lateSun, '2026-09-13'), true)
})

test('next: up to three starts after the requested one, rest of the day first, then later days', () => {
  const s = settings()
  const n = nextSlots({ settings: s, service: oil, date: TUE, start_min: parseTime('09:00'), now: NOW, holds: [] })
  assert.deepEqual(n, [
    { date: TUE, time: '09:30', label: 'Tue Sep 15, 9:30 AM' },
    { date: TUE, time: '10:00', label: 'Tue Sep 15, 10:00 AM' },
    { date: TUE, time: '10:30', label: 'Tue Sep 15, 10:30 AM' },
  ])
  const late = nextSlots({ settings: s, service: oil, date: '2026-09-19', start_min: parseTime('12:00'), now: NOW, holds: [] })
  assert.deepEqual(
    late.map((x) => `${x.date} ${x.time}`),
    ['2026-09-19 12:30', '2026-09-21 08:00', '2026-09-21 08:30'],
    'skips Sunday',
  )
  const closures = [{ date: '2026-09-21', reason: 'Staff training (sample)' }]
  const late2 = nextSlots({
    settings: settings({ closures }),
    service: oil,
    date: '2026-09-19',
    start_min: parseTime('12:30'),
    now: NOW,
    holds: [],
  })
  assert.equal(late2[0].date, '2026-09-22', 'skips Sunday and the Monday closure')
  assert.equal(nextSlots({ settings: s, service: oil, date: '2026-09-27', start_min: 0, now: NOW, holds: [] }).length, 0)
})

test('NL time zone maths through Intl (NDT UTC-2:30 in September, NST UTC-3:30 in December)', () => {
  assert.equal(new Date(localToInstant('2026-09-15', 570, 'America/St_Johns')).toISOString(), '2026-09-15T12:00:00.000Z')
  assert.equal(new Date(localToInstant('2026-12-15', 570, 'America/St_Johns')).toISOString(), '2026-12-15T13:00:00.000Z')
  assert.equal(new Date(localToInstant('2026-11-01', 180, 'America/St_Johns')).toISOString(), '2026-11-01T06:30:00.000Z') // after fall back
  assert.equal(localDate(Date.parse('2026-09-15T02:29:00Z'), 'America/St_Johns'), '2026-09-14')
  assert.equal(localDate(Date.parse('2026-09-15T02:30:00Z'), 'America/St_Johns'), '2026-09-15')
})

test('labels are for people', () => {
  assert.equal(timeLabel(0), '12:00 AM')
  assert.equal(timeLabel(570), '9:30 AM')
  assert.equal(timeLabel(720), '12:00 PM')
  assert.equal(timeLabel(810), '1:30 PM')
  assert.equal(dayLabel('2026-09-15'), 'Tue Sep 15')
  assert.equal(slotLabel('2026-09-15', 570), 'Tue Sep 15, 9:30 AM')
})

test('pickBays takes the lowest-numbered free bays', () => {
  const occ = occupancy(holdsFrom([req('confirmed', TUE, '10:00', 30, [1])]), TUE)
  assert.deepEqual(pickBays(occ, 3, 1, 600, 630), [2])
  assert.deepEqual(pickBays(occ, 3, 2, 600, 630), [2, 3])
  assert.equal(pickBays(occ, 3, 3, 600, 630), null)
  assert.deepEqual(pickBays(occ, 3, 3, 630, 660), [1, 2, 3], 'the end is exclusive')
})
