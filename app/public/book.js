// Customer booking page: Pick a service → Pick a day → Pick a time → Your details → Request sent.
// Days, times and labels all come from the API; the browser clock is never used for shop dates.
import { api } from '/api.js'
import { esc, duration, band, dayChips, timeButtons, showShop, copyText, icon } from '/ui.js'

const root = document.getElementById('booking')
const progress = document.getElementById('progress')
const STEPS = [['service', 'Service'], ['day', 'Day'], ['time', 'Time'], ['details', 'Details']]
const FIELDS = ['name', 'phone', 'year', 'make', 'model', 'note']

// Same limits as POST /api/requests, worded for the customer.
const RULES = {
  name: (v) => (!v ? 'Please enter your name.' : v.length > 80 ? 'Your name can be up to 80 characters.' : ''),
  phone: (v) =>
    !v
      ? 'Please enter a phone number so the shop can reach you.'
      : v.length > 32 || /[^0-9 +\-().]/.test(v) || (v.match(/\d/g) || []).length < 7
        ? 'That phone number does not look right. Try it like 709-555-0142.'
        : '',
  year: (v) => (v && !/^\d{4}$/.test(v) ? 'The year should be 4 numbers, like 2016.' : ''),
  make: (v) => (!v ? 'Please enter the make, like Toyota or Ford.' : v.length > 32 ? 'The make can be up to 32 characters.' : ''),
  model: (v) => (v.length > 40 ? 'The model can be up to 40 characters.' : ''),
  note: (v) => (v.length > 280 ? 'Your note can be up to 280 characters.' : ''),
}

const s = {
  shop: null, step: 'service', loading: false, error: '',
  service: null, days: null, date: null, dayLabel: '', slots: null, time: null, when: '',
  form: Object.fromEntries(FIELDS.map((f) => [f, ''])), touched: new Set(),
  taken: null, sendError: '', sending: false, sent: null,
}
let seq = 0
let focusPending = false

/* ---- rendering ----------------------------------------------------------- */

function render() {
  renderProgress()
  root.innerHTML =
    s.step === 'service' ? serviceStep() : s.step === 'day' ? dayStep() : s.step === 'time' ? timeStep() : s.step === 'details' ? detailsStep() : sentStep()
  if (s.step === 'details') fillForm()
  if (focusPending && !s.loading) {
    focusPending = false
    root.querySelector('h3')?.focus({ preventScroll: true })
    if (root.getBoundingClientRect().top < 0) root.scrollIntoView({ block: 'start' })
  }
}

function renderProgress() {
  const at = s.step === 'sent' ? STEPS.length : STEPS.findIndex(([k]) => k === s.step)
  progress.innerHTML = STEPS.map(([key, label], i) => {
    const state = i < at ? 'done' : i === at ? 'current' : 'todo'
    const open = state === 'done' && s.step !== 'sent'
    return `<li><button type="button" data-go="${key}" data-state="${state}"${state === 'current' ? ' aria-current="step"' : ''}${open ? '' : ' disabled'}>
      <b>${state === 'done' ? icon.check : i + 1}</b><span>${label}</span></button></li>`
  }).join('')
}

const head = (title, sub) => `<h3 tabindex="-1">${title}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}`

function waiting() {
  if (s.loading) return `<p class="loading" role="status">Loading…</p>`
  if (s.error) return `<div class="alert" role="alert"><p>${esc(s.error)}</p><button type="button" class="btn" data-retry>Try again</button></div>`
  return ''
}

function serviceStep() {
  const wait = waiting()
  if (wait || !s.shop) return head('Pick a service') + wait
  if (!s.shop.services.length) return head('Pick a service') + `<p class="empty">The shop is not taking online bookings right now.</p>`
  return (
    head('Pick a service', 'Choose what you need done. Times are about how long the job takes.') +
    `<div class="services">${s.shop.services
      .map(
        (sv) => `<button type="button" class="service" data-service="${esc(sv.id)}" data-band="${band(sv.minutes)}" aria-pressed="${s.service?.id === sv.id}">
          <span class="txt"><b>${esc(sv.name)}</b><span class="dur">${duration(sv.minutes)}</span></span><span class="go">${icon.chevron}</span></button>`,
      )
      .join('')}</div>`
  )
}

function dayStep() {
  const top = head('Pick a day', `${esc(s.service.name)}, ${duration(s.service.minutes)}. Greyed-out days are closed or full.`)
  const back = `<div class="nav"><button type="button" class="btn quiet" data-go="service">${icon.back} Change service</button></div>`
  return top + (waiting() || `<div class="days">${dayChips(s.days.days, s.shop.today, s.date)}</div>`) + back
}

function timeStep() {
  const top = head('Pick a time', `${esc(s.service.name)} on ${esc(s.dayLabel)}.`)
  const back = `<div class="nav"><button type="button" class="btn quiet" data-go="day">${icon.back} Change day</button></div>`
  let body = waiting()
  if (!body) {
    body = !s.slots.open
      ? `<p class="empty">${esc(s.slots.reason || 'The shop is closed that day.')} Please pick another day.</p>`
      : s.slots.slots.length
        ? `<div class="times">${timeButtons(s.slots.slots, s.time)}</div>`
        : `<p class="empty">No times left on ${esc(s.dayLabel)}. Please pick another day.</p>`
  }
  return top + body + back
}

function summary() {
  return `<div class="summary"><span>${esc(s.service.name)}</span><span>${duration(s.service.minutes)}</span><span data-when>${esc(s.when)}</span></div>`
}

function takenBlock() {
  if (!s.taken) return ''
  const n = s.taken.next.length
  const lead = ['There are no other times open for this service right now.', 'Here is the next one:', 'Here are the next two:', 'Here are the next three:'][n]
  return `<div class="taken" id="taken" role="alert" tabindex="-1"><p>${esc(s.taken.message)} ${lead}</p>${
    n
      ? `<div class="alts">${s.taken.next.map((x, i) => `<button type="button" class="btn alt" data-alt="${i}">${esc(x.label)}</button>`).join('')}</div>`
      : `<button type="button" class="btn" data-go="day">Pick another day</button>`
  }</div>`
}

function field(name, label, { type = 'text', attrs = '', hint = '', optional = false, area = false } = {}) {
  const described = `e-${name}${hint ? ` h-${name}` : ''}`
  const control = area
    ? `<textarea id="f-${name}" name="${name}" ${attrs} aria-describedby="${described}"></textarea>`
    : `<input id="f-${name}" name="${name}" type="${type}" ${attrs} aria-describedby="${described}">`
  return `<div class="field"><label for="f-${name}">${label}${optional ? ' <small>(optional)</small>' : ''}${
    name === 'note' ? ' <span class="count" id="note-count"></span>' : ''
  }</label>${control}${hint ? `<p class="hint" id="h-${name}">${hint}</p>` : ''}<p class="err" id="e-${name}" hidden></p></div>`
}

function detailsStep() {
  return (
    head('Your details', 'The shop uses these to confirm your time.') +
    summary() +
    takenBlock() +
    `<form class="form" id="details" novalidate>
      <div class="grid2">
        ${field('name', 'Your name', { attrs: 'autocomplete="name" maxlength="80"' })}
        ${field('phone', 'Phone', { type: 'tel', attrs: 'autocomplete="tel" inputmode="tel" maxlength="32"', hint: 'The shop may call or text you about your booking.' })}
      </div>
      <fieldset>
        <legend>Your vehicle</legend>
        <div class="grid3">
          ${field('year', 'Year', { attrs: 'inputmode="numeric" maxlength="4" autocomplete="off"', optional: true })}
          ${field('make', 'Make', { attrs: 'maxlength="32" autocomplete="off"' })}
          ${field('model', 'Model', { attrs: 'maxlength="40" autocomplete="off"', optional: true })}
        </div>
      </fieldset>
      ${field('note', 'Anything the shop should know?', { area: true, attrs: 'maxlength="280" rows="3"', optional: true })}
      <div class="alert" id="send-error" role="alert" hidden></div>
      <button type="submit" class="btn primary big wide" id="send">Send request</button>
    </form>`
  )
}

function sentStep() {
  const url = location.origin + s.sent.status_url
  return `<div class="sent-mark">${icon.checkBig}</div>
    ${head('Request sent', 'The shop will confirm your time. Keep this link to check on it.')}
    <div class="summary"><span>${esc(s.sent.service)}</span><span>${esc(s.sent.when)}</span></div>
    <label class="link-label" for="status-link">Your status link</label>
    <div class="link-box">
      <input id="status-link" readonly value="${esc(url)}">
      <button type="button" class="btn primary" data-copy>Copy link</button>
    </div>
    <p class="copy-note" id="copy-note" role="status"></p>
    <div class="actions">
      <a class="btn big" href="${esc(s.sent.status_url)}">Check on your request</a>
      <button type="button" class="btn quiet big" data-again>Book something else</button>
    </div>`
}

/* ---- form ---------------------------------------------------------------- */

function fillForm() {
  for (const f of FIELDS) {
    const el = document.getElementById(`f-${f}`)
    el.value = s.form[f]
    if (s.touched.has(f)) showError(f, RULES[f](s.form[f].trim()))
  }
  noteCount()
  updateSend()
}

// A plain focus() lets WebKit park the field under the sticky header; centre it instead.
function focusField(el) {
  if (!el) return
  el.focus({ preventScroll: true })
  ;(el.closest('.field') || el).scrollIntoView({ block: 'center' })
}

function showError(f, msg) {
  const input = document.getElementById(`f-${f}`)
  const err = document.getElementById(`e-${f}`)
  if (!input) return
  err.textContent = msg
  err.hidden = !msg
  if (msg) input.setAttribute('aria-invalid', 'true')
  else input.removeAttribute('aria-invalid')
}

function noteCount() {
  const el = document.getElementById('note-count')
  if (el) el.textContent = s.form.note.length > 200 ? `${s.form.note.length} / 280` : ''
}

function updateSend() {
  const btn = document.getElementById('send')
  const box = document.getElementById('send-error')
  if (!btn) return
  btn.disabled = s.sending
  btn.textContent = s.sending ? 'Sending…' : 'Send request'
  box.textContent = s.sendError
  box.hidden = !s.sendError
}

async function send() {
  const values = Object.fromEntries(FIELDS.map((f) => [f, s.form[f].trim()]))
  let first = null
  for (const f of FIELDS) {
    s.touched.add(f)
    const msg = RULES[f](values[f])
    showError(f, msg)
    if (msg && !first) first = f
  }
  if (first) return focusField(document.getElementById(`f-${first}`))

  s.sending = true
  s.sendError = ''
  updateSend()
  try {
    const r = await api.request({ service: s.service.id, date: s.date, time: s.time, ...values })
    s.sent = { ...r, service: s.service.name, when: s.when }
    s.sending = false
    s.taken = null
    go('sent')
  } catch (e) {
    s.sending = false
    if (e.code === 'taken') {
      s.taken = { message: e.message, next: Array.isArray(e.body.next) ? e.body.next.slice(0, 3) : [] }
      render()
      focusField(document.getElementById('taken'))
    } else if (e.field && FIELDS.includes(e.field)) {
      updateSend()
      showError(e.field, e.message)
      focusField(document.getElementById(`f-${e.field}`))
    } else if (['service', 'date', 'time'].includes(e.field)) {
      // The choice itself went stale (e.g. the shop changed its hours): say so and offer the way back.
      s.sendError = e.message
      updateSend()
      const box = document.getElementById('send-error')
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'btn'
      back.dataset.go = e.field === 'time' ? 'time' : e.field === 'date' ? 'day' : 'service'
      back.textContent = e.field === 'time' ? 'Pick another time' : e.field === 'date' ? 'Pick another day' : 'Pick a service'
      box.append(document.createElement('br'), back)
    } else {
      s.sendError = e.message
      updateSend()
    }
  }
}

/* ---- navigation ---------------------------------------------------------- */

function go(step) {
  s.step = step
  s.error = ''
  focusPending = true
  if (step === 'day') return load(() => api.days(s.service.id), (r) => (s.days = r))
  if (step === 'time') return load(() => api.slots(s.service.id, s.date), (r) => (s.slots = r))
  render()
}

function load(fetcher, apply) {
  const mine = ++seq
  s.loading = true
  render()
  fetcher().then(
    (r) => {
      if (mine !== seq) return
      apply(r)
      s.loading = false
      render()
    },
    (e) => {
      if (mine !== seq) return
      s.loading = false
      s.error = e.message
      render()
    },
  )
}

async function init() {
  s.loading = true
  s.error = ''
  render()
  try {
    s.shop = await api.shop()
    showShop(s.shop)
  } catch (e) {
    s.error = e.message
  }
  s.loading = false
  render()
}

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b || b.disabled) return
  const d = b.dataset
  if (d.service) {
    s.service = s.shop.services.find((x) => x.id === d.service)
    Object.assign(s, { date: null, time: null, taken: null })
    return go('day')
  }
  if (d.date) {
    const day = s.days.days.find((x) => x.date === d.date)
    Object.assign(s, { date: day.date, dayLabel: day.label, time: null, taken: null })
    return go('time')
  }
  if (d.time) {
    const slot = s.slots.slots.find((x) => x.time === d.time)
    Object.assign(s, { time: slot.time, when: `${s.dayLabel}, ${slot.label}`, taken: null })
    return go('details')
  }
  if (d.alt !== undefined) {
    const x = s.taken.next[Number(d.alt)]
    Object.assign(s, { date: x.date, time: x.time, when: x.label, dayLabel: x.label.split(',')[0], slots: null, taken: null, sendError: '' })
    render()
    return document.getElementById('send')?.focus()
  }
  if (d.go) return go(d.go)
  if (d.retry !== undefined) return s.shop ? go(s.step) : init()
  if (d.copy !== undefined) {
    const ok = await copyText(document.getElementById('status-link').value)
    const note = document.getElementById('copy-note')
    if (ok) {
      b.textContent = 'Copied'
      note.textContent = 'The link is copied. Paste it somewhere safe, like a note or a text to yourself.'
      setTimeout(() => { if (b.isConnected) b.textContent = 'Copy link' }, 2500)
    } else {
      document.getElementById('status-link').select()
      note.textContent = 'Select the link above and copy it.'
    }
    return
  }
  if (d.again !== undefined) {
    Object.assign(s, { service: null, date: null, time: null, taken: null, sent: null, sendError: '' })
    return go('service')
  }
})

progress.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-go]')
  if (b && !b.disabled) go(b.dataset.go)
})

root.addEventListener('submit', (e) => {
  e.preventDefault()
  if (!s.sending) send()
})

root.addEventListener('input', (e) => {
  const f = e.target.name
  if (!FIELDS.includes(f)) return
  s.form[f] = e.target.value
  if (f === 'note') noteCount()
  if (s.touched.has(f)) showError(f, RULES[f](e.target.value.trim()))
})

root.addEventListener('focusout', (e) => {
  const f = e.target.name
  if (!FIELDS.includes(f) || !e.target.value) return
  s.touched.add(f)
  showError(f, RULES[f](e.target.value.trim()))
})

init()
