// Shop side /shop/: PIN sign-in, pending requests on top (Confirm / Decline / Offer another time, texts to copy),
// a Today / Week board by bay, Block out time, Shop Board hand-off, and Settings.
// Nothing is ever sent to a customer: the shop copies ready-made texts into its own phone.
// Dates come from the board response (`today`, `from`), never the browser clock. The board polls every 15 s and never
// redraws while a picker, a note, a menu or the block-out form is open.
import { api, session, SIGNED_OUT } from '/api.js'
import { esc, duration, band, clock, dayChips, timeButtons, showShop, copyText, STATUS, icon, addDays, toMin, hhmm, fullLink } from '/ui.js'
import { mountSettings } from '/shop-settings.js'

const POLL_MS = 15000
const ROW_PX = 44 // one 30-minute row on the Today grid
const root = document.getElementById('shop')
const nav = document.getElementById('nav')
const signoutBtn = document.getElementById('signout')

const app = { view: 'board', signinError: '' }
const b = {
  mode: 'day', date: null, data: null, error: '', busy: false,
  bay: 1, // the bay shown on a phone
  menu: null, // id of the board item whose details are open
  open: null, // { ctx, id, kind: 'decline' | 'cancel' | 'offer' } or { kind: 'block-form' }
  offer: null, // { id, service, days, date, dayLabel, slots, time, label, error }
  note: '',
  blockForm: null,
  recent: [], // requests just acted on, so their new texts are at hand
  cardMsg: {}, // request or block id -> { kind: 'ok' | 'error', text }
  exportMsg: '',
}
let seq = 0
let offerSeq = 0

const btn = (act, label, cls = '') => `<button type="button" class="btn ${cls}" data-act="${act}">${label}</button>`
const alertBox = (text) => `<div class="alert" role="alert">${esc(text)}</div>`
const bayColor = (n) => `var(--bay-${((n - 1) % 6) + 1})`

/* ---- shell --------------------------------------------------------------- */

function render() {
  const signedIn = !!session.get()
  nav.hidden = !signedIn
  signoutBtn.hidden = !signedIn
  for (const t of nav.querySelectorAll('button')) t.setAttribute('aria-selected', String(t.dataset.view === app.view))
  if (!signedIn) return renderSignin()
  if (app.view === 'settings') return mountSettings(root)
  renderBoard()
}

function renderSignin() {
  root.innerHTML = `<section class="panel glass signin">
    <h3>Shop sign in</h3>
    <p class="sub">Enter the shop PIN to see booking requests and the board.</p>
    <form id="signin-form" class="form" novalidate>
      <div class="field"><label for="pin">PIN</label>
        <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8"></div>
      <div class="alert" id="signin-error" role="alert"${app.signinError ? '' : ' hidden'}>${esc(app.signinError)}</div>
      <button type="submit" class="btn primary big wide" id="signin-btn">Sign in</button>
    </form>
  </section>`
}

async function signin(pin) {
  const button = document.getElementById('signin-btn')
  const box = document.getElementById('signin-error')
  button.disabled = true
  button.textContent = 'Signing in…'
  try {
    const r = await api.signin(pin)
    session.set(r.token)
    app.signinError = ''
    app.view = 'board'
    b.data = null
    render()
    loadBoard()
  } catch (e) {
    app.signinError = e.message
    box.textContent = e.message
    box.hidden = false
    button.disabled = false
    button.textContent = 'Sign in'
    const input = document.getElementById('pin')
    input.value = ''
    input.focus()
  }
}

/* ---- board data ---------------------------------------------------------- */

async function loadBoard({ quiet = false } = {}) {
  const mine = ++seq
  try {
    const d = await api.board(b.date, b.mode === 'week' ? 7 : 1)
    if (mine !== seq) return
    if (quiet && (b.menu || b.open || b.busy)) return // never replace an open picker, note, menu or form
    b.data = d
    b.date = d.from
    b.error = ''
  } catch (e) {
    if (mine !== seq || e.status === 401) return
    if (quiet && b.data) return
    b.error = e.message
  }
  if (app.view === 'board' && session.get()) renderBoard()
}

function findRequest(id, ctx) {
  if (ctx === 'recent') return b.recent.find((r) => r.id === id)
  const d = b.data
  if (!d) return null
  return (
    d.pending.find((r) => r.id === id) ||
    d.days.flatMap((day) => day.items).find((it) => it.kind === 'request' && it.request.id === id)?.request ||
    b.recent.find((r) => r.id === id)
  )
}

function findItem(id) {
  for (const day of b.data?.days || []) {
    for (const it of day.items) {
      if (it.kind === 'request' && it.request.id === id) return { day, ...it }
      if (it.kind === 'block' && it.block.id === id) return { day, ...it }
    }
  }
  return null
}

// Where an item sits: an offered request holds its offer time (clarification 5).
function place(it) {
  if (it.kind === 'block') return { time: it.block.time, end: it.block.end, bays: it.block.bays }
  const r = it.request
  if (r.status === 'offered' && r.offer) return { time: r.offer.time, end: r.offer.end, bays: r.offer.bays || r.bays || [] }
  return { time: r.time, end: r.end, bays: r.bays || [] }
}

/* ---- board rendering ----------------------------------------------------- */

function renderBoard() {
  if (!b.data) {
    root.innerHTML = b.error
      ? `<section class="panel glass"><div class="alert" role="alert"><p>${esc(b.error)}</p>${btn('reload', 'Try again')}</div></section>`
      : `<section class="panel glass"><p class="loading" role="status">Loading the board…</p></section>`
    return
  }
  const d = b.data
  root.innerHTML = recentSection() + pendingSection(d) + boardSection(d)
}

function recentSection() {
  if (!b.recent.length) return ''
  return `<section class="recent" aria-labelledby="recent-h">
    <div class="section-head"><h3 id="recent-h">Just done</h3></div>
    <div class="cards">${b.recent.map((r) => requestCard(r, 'recent')).join('')}</div>
  </section>`
}

function pendingSection(d) {
  return `<section class="pending" aria-labelledby="pending-h">
    <div class="section-head"><h3 id="pending-h">Waiting for you</h3><b class="count" id="pending-count">${d.pending.length}</b></div>
    ${d.pending.length
      ? `<div class="cards">${d.pending.map((r) => requestCard(r, 'pending')).join('')}</div>`
      : `<p class="empty panel glass">Nothing waiting. New booking requests show up here.</p>`}
  </section>`
}

function requestCard(r, ctx) {
  const c = r.customer || {}
  const vehicle = [c.year, c.make, c.model].filter(Boolean).join(' ')
  const open = b.open && b.open.id === r.id && b.open.ctx === ctx ? b.open.kind : null
  const msg = b.cardMsg[r.id]
  const where = place({ kind: 'request', request: r })
  const acts = []
  if (!open && ctx !== 'recent') {
    if (r.status === 'requested') acts.push(btn('confirm', 'Confirm', 'primary'))
    if (r.status === 'requested' || r.status === 'offered') {
      acts.push(btn('offer', r.status === 'offered' ? 'Offer a different time' : 'Offer another time'), btn('decline', 'Decline'))
    }
    if (r.status === 'confirmed') acts.push(btn('push', 'Send to Shop Board'), btn('cancel', 'Cancel booking', 'quiet'))
  }
  const head = ctx === 'recent' ? btn('dismiss', 'Hide', 'quiet small') : ctx === 'item' ? btn('close-item', 'Close', 'quiet small') : ''
  return `<article class="card glass req" data-id="${esc(r.id)}" data-ctx="${ctx}" data-status="${esc(r.status)}"${open ? ' data-open="1"' : ''}>
    <header class="card-head">
      <span class="chip" data-status="${esc(r.status)}"><i></i>${esc(STATUS[r.status]?.label || r.status)}</span>
      <span class="when">${esc(r.label)}</span>${head}
    </header>
    <h4>${esc(c.name)}</h4>
    <p class="meta"><span class="svc" data-band="${band(r.service.minutes)}">${esc(r.service.name)}</span> · ${duration(r.service.minutes)}${vehicle ? ` · ${esc(vehicle)}` : ''}</p>
    <p class="meta"><a href="tel:${esc(String(c.phone || '').replace(/[^0-9+]/g, ''))}">${esc(c.phone)}</a>${where.bays.length ? ` · Bay ${where.bays.join(' + ')}` : ''}</p>
    ${r.status === 'offered' && r.offer ? `<p class="offered">Offered <b>${esc(r.offer.label)}</b>. Waiting on the customer.</p>` : ''}
    ${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}
    ${r.shop_note ? `<p class="meta">Your note: ${esc(r.shop_note)}</p>` : ''}
    ${msg ? (msg.kind === 'ok' ? `<div class="okmsg" role="status">${esc(msg.text)}</div>` : alertBox(msg.text)) : ''}
    ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
    ${open === 'decline' || open === 'cancel' ? notePanel(r, open) : ''}
    ${open === 'offer' ? offerPanel(r) : ''}
    ${textsBlock(r)}
  </article>`
}

function textsBlock(r) {
  if (!r.messages?.length) return ''
  return `<div class="texts"><p class="eyebrow">Texts to send from your phone</p>${r.messages
    .map(
      (m) => `<div class="text-row"><div class="text-body"><b>${esc(m.label)}</b><p>${esc(fullLink(m.text, r.status_url))}</p></div>
        <button type="button" class="btn copy" data-act="copy-text" data-key="${esc(m.key)}">Copy text</button></div>`,
    )
    .join('')}</div>`
}

function notePanel(r, kind) {
  const decline = kind === 'decline'
  return `<div class="panel-in">
    <div class="field"><label for="note-${esc(r.id)}">${decline ? 'Note for the customer' : 'Why are you cancelling?'} <small>(optional)</small></label>
      <input id="note-${esc(r.id)}" data-note maxlength="280" value="${esc(b.note)}"></div>
    <p class="hint">It shows on their status page and in the text.</p>
    <div class="actions">${btn(decline ? 'decline-send' : 'cancel-send', decline ? 'Decline request' : 'Cancel booking', 'danger')}${btn('close', 'Never mind')}</div>
  </div>`
}

function offerPanel(r) {
  const o = b.offer
  let body = ''
  if (!o.days) body = o.error ? alertBox(o.error) : `<p class="loading" role="status">Loading days…</p>`
  else {
    body = `<p class="step-label">Offer another time: pick a day</p><div class="days">${dayChips(o.days, b.data.today, o.date, { shop: true })}</div>`
    if (o.date && !o.error) {
      body += !o.slots
        ? `<p class="loading" role="status">Loading times…</p>`
        : o.slots.slots.length
          ? `<p class="step-label">Pick a time on ${esc(o.dayLabel)}</p><div class="times">${timeButtons(o.slots.slots, o.time)}</div>`
          : `<p class="empty">No free bay time on ${esc(o.dayLabel)}.</p>`
    }
    if (o.error) body += alertBox(o.error)
  }
  return `<div class="panel-in picker">${body}
    <div class="field"><label for="offer-note-${esc(r.id)}">Note for the customer <small>(optional)</small></label>
      <input id="offer-note-${esc(r.id)}" data-note maxlength="280" value="${esc(b.note)}"></div>
    <div class="actions">${o.time ? `<button type="button" class="btn primary" data-act="offer-send">Offer ${esc(o.label)}</button>` : ''}${btn('close', 'Never mind')}</div>
  </div>`
}

function boardSection(d) {
  const first = d.days[0]
  const last = d.days[d.days.length - 1]
  const range = b.mode === 'day' ? first?.label : `${first?.label} to ${last?.label}`
  return `<section class="panel glass board" aria-labelledby="board-h">
    <div class="board-head">
      <h3 id="board-h" class="sr-only">Board</h3>
      <div class="seg" role="tablist" aria-label="Board view">
        <button type="button" role="tab" data-mode="day" aria-selected="${b.mode === 'day'}">Today</button>
        <button type="button" role="tab" data-mode="week" aria-selected="${b.mode === 'week'}">Week</button>
      </div>
      <div class="datenav">
        <button type="button" class="btn icon" data-nav="-1" aria-label="${b.mode === 'day' ? 'Day before' : 'Week before'}">${icon.back}</button>
        <span class="range" id="board-range">${esc(range)}</span>
        <button type="button" class="btn icon" data-nav="1" aria-label="${b.mode === 'day' ? 'Next day' : 'Next week'}">${icon.chevron}</button>
        ${d.from !== d.today ? `<button type="button" class="btn quiet" data-nav="today">Back to today</button>` : ''}
      </div>
      <span class="grow"></span>
      <div class="board-tools">
        ${btn('block-open', 'Block out time')}
        <button type="button" class="btn quiet" data-export="json">Download for Shop Board (JSON)</button>
        <button type="button" class="btn quiet" data-export="csv">CSV</button>
      </div>
    </div>
    ${b.exportMsg ? alertBox(b.exportMsg) : ''}
    ${b.open?.kind === 'block-form' ? blockForm(d) : ''}
    ${b.mode === 'day' ? dayView(d) : weekView(d)}
    ${itemMenu()}
  </section>`
}

function itemLabel(it) {
  if (it.kind === 'block') return { title: it.block.label || 'Blocked', sub: `${clock(it.block.time)} to ${clock(it.block.end)}`, status: 'block', id: it.block.id }
  const r = it.request
  const p = place(it)
  return { title: r.customer?.name || '', sub: `${r.service.name} · ${clock(p.time)} to ${clock(p.end)}`, status: r.status, id: r.id }
}

function dayView(d) {
  const day = d.days[0]
  const bays = Array.from({ length: d.bays }, (_, i) => i + 1)
  if (!bays.includes(b.bay)) b.bay = 1
  const count = (n) => day.items.filter((it) => place(it).bays.includes(n)).length
  const seg = `<div class="tabs bayseg" role="tablist" aria-label="Bay">${bays
    .map((n) => `<button type="button" role="tab" data-bay="${n}" style="--c: ${bayColor(n)}" aria-selected="${n === b.bay}"><i></i>Bay ${n}<b>${count(n)}</b></button>`)
    .join('')}</div>`
  if (!day.open || !day.hours) {
    return `<p class="empty closed-day">${esc(day.label)}: ${esc(day.reason || 'Closed')}.</p>${day.items.length ? weekView({ ...d, days: [day] }) : ''}`
  }
  const open = Math.min(toMin(day.hours.open), ...day.items.map((it) => toMin(place(it).time)))
  const close = Math.max(toMin(day.hours.close), ...day.items.map((it) => toMin(place(it).end)))
  const start = Math.floor(open / 30) * 30
  const rows = []
  for (let m = start; m < close; m += 30) rows.push(m)
  const lane = (n) =>
    day.items
      .filter((it) => place(it).bays.includes(n))
      .map((it) => {
        const p = place(it)
        const l = itemLabel(it)
        const top = ((toMin(p.time) - start) / 30) * ROW_PX
        const height = Math.max(((toMin(p.end) - toMin(p.time)) / 30) * ROW_PX - 4, 24)
        return `<button type="button" class="item" data-item="${esc(l.id)}" data-status="${l.status}" style="top:${top}px;height:${height}px" aria-pressed="${b.menu === l.id}">
          <b>${esc(l.title)}</b><span>${esc(l.sub)}</span></button>`
      })
      .join('')
  return `${seg}<div class="daygrid" style="--bays:${d.bays}; --row:${ROW_PX}px">
    <div class="timecol"><div class="bayhead"></div>${rows.map((m) => `<div class="tlabel">${m % 60 === 0 ? clock(hhmm(m)) : ''}</div>`).join('')}</div>
    ${bays
      .map(
        (n) => `<div class="baycol${n === b.bay ? ' is-shown' : ''}" data-bay-col="${n}" style="--c: ${bayColor(n)}">
          <div class="bayhead"><i></i>Bay ${n}</div>
          <div class="lane">${rows.map((m) => `<div class="gridrow${m % 60 === 0 ? ' hour' : ''}"></div>`).join('')}${lane(n)}</div>
        </div>`,
      )
      .join('')}
  </div>`
}

function weekView(d) {
  return `<div class="week">${d.days
    .map(
      (day) => `<div class="wday${day.date === d.today ? ' today' : ''}">
        <button type="button" class="wday-head" data-goto-day="${esc(day.date)}"><b>${esc(day.label)}</b>
          <small>${day.open && day.hours ? `${clock(day.hours.open)} to ${clock(day.hours.close)}` : esc(day.reason || 'Closed')}</small></button>
        ${day.items.length
          ? day.items
              .map((it) => {
                const l = itemLabel(it)
                return `<button type="button" class="witem" data-item="${esc(l.id)}" data-status="${l.status}" aria-pressed="${b.menu === l.id}">
                  <span class="t">${clock(place(it).time)}</span><span class="n">${esc(l.title)}</span><span class="s">${esc(it.kind === 'block' ? `Bays ${place(it).bays.join(', ')}` : it.request.service.name)}</span></button>`
              })
              .join('')
          : `<p class="wempty">${day.open ? 'Nothing booked' : ''}</p>`}
      </div>`,
    )
    .join('')}</div>`
}

function itemMenu() {
  if (!b.menu) return ''
  const it = findItem(b.menu)
  if (!it) return ''
  if (it.kind === 'request') return `<div class="menu" id="item-menu">${requestCard(it.request, 'item')}</div>`
  const bl = it.block
  const msg = b.cardMsg[bl.id]
  return `<div class="menu" id="item-menu"><article class="card glass" data-block="${esc(bl.id)}" data-status="block">
    <header class="card-head"><span class="chip" data-status="block"><i></i>Blocked out</span><span class="when">${esc(it.day.label)}, ${clock(bl.time)} to ${clock(bl.end)}</span>${btn('close-item', 'Close', 'quiet small')}</header>
    <h4>${esc(bl.label || 'Blocked')}</h4>
    <p class="meta">Bay ${bl.bays.join(' + ')}</p>
    ${msg ? alertBox(msg.text) : ''}
    <div class="actions">${btn('block-remove', 'Remove this block', 'danger')}</div>
  </article></div>`
}

function blockForm(d) {
  const f = b.blockForm
  const marks = []
  for (let m = 6 * 60; m <= 22 * 60; m += 15) marks.push(hhmm(m))
  const options = (sel) => marks.map((t) => `<option value="${t}"${t === sel ? ' selected' : ''}>${clock(t)}</option>`).join('')
  const bays = Array.from({ length: d.bays }, (_, i) => i + 1)
  return `<form class="blockform panel-in" id="block-form" novalidate>
    <h4>Block out time</h4>
    <p class="sub">For walk-ins, breaks or anything else that needs a bay. Customers cannot book that time.</p>
    <div class="grid4">
      <div class="field"><label for="bf-date">Day</label><input type="date" id="bf-date" name="date" min="${esc(d.today)}" value="${esc(f.date)}"></div>
      <div class="field"><label for="bf-time">From</label><select id="bf-time" name="time">${options(f.time)}</select></div>
      <div class="field"><label for="bf-end">To</label><select id="bf-end" name="end">${options(f.end)}</select></div>
      <div class="field"><label for="bf-label">Label</label><input id="bf-label" name="label" maxlength="60" value="${esc(f.label)}"></div>
    </div>
    <fieldset class="baypick"><legend>Bays</legend>
      <label class="check"><input type="checkbox" name="all"${f.all ? ' checked' : ''}> All bays</label>
      ${bays.map((n) => `<label class="check"><input type="checkbox" name="bay" value="${n}"${f.all || f.bays.includes(n) ? ' checked' : ''}${f.all ? ' disabled' : ''}> Bay ${n}</label>`).join('')}
    </fieldset>
    ${f.error ? `<div class="alert" role="alert"><p>${esc(f.error)}</p>${f.conflicts?.length ? `<ul>${f.conflicts.map((c) => `<li>${esc(c.name)}, ${esc(c.label)}, bay ${esc((c.bays || []).join(' + '))}</li>`).join('')}</ul>` : ''}</div>` : ''}
    <div class="actions"><button type="submit" class="btn primary">Block out this time</button>${btn('block-close', 'Never mind')}</div>
  </form>`
}

/* ---- actions ------------------------------------------------------------- */

function lock() {
  b.busy = true
  for (const x of root.querySelectorAll('button')) x.disabled = true
}

async function act(fn, id, okText) {
  lock()
  try {
    const r = await fn()
    Object.assign(b, { open: null, offer: null, note: '', menu: null })
    if (r?.id) {
      b.recent = [r, ...b.recent.filter((x) => x.id !== r.id)].slice(0, 3)
      b.cardMsg[r.id] = { kind: 'ok', text: okText }
    }
  } catch (e) {
    if ((e.code === 'taken' || e.code === 'busy') && b.offer) {
      b.offer.error = e.message
      b.offer.time = null
      b.offer.slots = null
      b.busy = false
      renderBoard()
      return loadOfferSlots()
    }
    b.cardMsg[id] = { kind: 'error', text: e.message }
    Object.assign(b, { open: null, offer: null, note: '' })
  } finally {
    b.busy = false
  }
  await loadBoard()
}

async function simple(fn, id, { ok, closeMenu = false } = {}) {
  lock()
  try {
    await fn()
    if (ok) b.cardMsg[id] = { kind: 'ok', text: ok }
    else delete b.cardMsg[id]
    if (closeMenu) b.menu = null
  } catch (e) {
    b.cardMsg[id] = { kind: 'error', text: e.message }
  } finally {
    b.busy = false
  }
  await loadBoard()
}

function loadOfferDays() {
  const mine = ++offerSeq
  const o = b.offer
  api.days(o.service).then(
    (r) => { if (mine === offerSeq && b.offer === o) { o.days = r.days; renderBoard() } },
    (e) => { if (mine === offerSeq && b.offer === o) { o.error = e.message; renderBoard() } },
  )
}

function loadOfferSlots() {
  const mine = ++offerSeq
  const o = b.offer
  api.shopSlots(o.service, o.date, o.id).then(
    (r) => { if (mine === offerSeq && b.offer === o) { o.slots = r; renderBoard() } },
    (e) => { if (mine === offerSeq && b.offer === o) { o.error = e.message; renderBoard() } },
  )
}

async function exportFile(format) {
  const d = b.data
  try {
    const { text, type } = await api.exportShopBoard(d.from, d.to, format)
    const blob = new Blob([text], { type: type || (format === 'csv' ? 'text/csv' : 'application/json') })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `shop-board-${d.from}${d.to !== d.from ? `-to-${d.to}` : ''}.${format}`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    b.exportMsg = ''
  } catch (e) {
    b.exportMsg = e.message
  }
  renderBoard()
}

async function submitBlock() {
  const f = b.blockForm
  const bays = f.all ? 'all' : [...f.bays].sort((x, y) => x - y)
  f.conflicts = null
  if (!f.date) f.error = 'Pick the day to block out.'
  else if (toMin(f.end) <= toMin(f.time)) f.error = 'The end time has to be after the start time.'
  else if (bays !== 'all' && !bays.length) f.error = 'Pick at least one bay.'
  else f.error = ''
  if (f.error) return renderBoard()
  lock()
  try {
    await api.addBlock({ date: f.date, time: f.time, end: f.end, bays, label: f.label.trim() || 'Walk-in' })
    b.open = null
    if (b.mode === 'day') b.date = f.date
  } catch (e) {
    f.error = e.message
    f.conflicts = e.body?.conflicts || null
  } finally {
    b.busy = false
  }
  await loadBoard()
}

/* ---- events -------------------------------------------------------------- */

root.addEventListener('click', async (e) => {
  if (app.view !== 'board' || !session.get()) return
  const t = e.target.closest('button')
  if (!t || t.disabled || b.busy) return
  const card = t.closest('[data-id]')
  const id = card?.dataset.id
  const ctx = card?.dataset.ctx
  const d = t.dataset

  if (d.mode) {
    Object.assign(b, { mode: d.mode, menu: null, open: null, offer: null })
    return loadBoard()
  }
  if (d.nav) {
    b.date = d.nav === 'today' ? b.data.today : addDays(b.data.from, Number(d.nav) * (b.mode === 'week' ? 7 : 1))
    Object.assign(b, { menu: null, open: b.open?.kind === 'block-form' ? b.open : null, offer: null })
    return loadBoard()
  }
  if (d.gotoDay) {
    Object.assign(b, { mode: 'day', date: d.gotoDay, menu: null, open: null, offer: null })
    return loadBoard()
  }
  if (d.bay) {
    b.bay = Number(d.bay)
    return renderBoard()
  }
  if (d.item) {
    b.menu = b.menu === d.item ? null : d.item
    if (b.open?.ctx === 'item') Object.assign(b, { open: null, offer: null })
    renderBoard()
    document.getElementById('item-menu')?.scrollIntoView({ block: 'nearest' })
    return
  }
  if (d.export) return exportFile(d.export)
  if (d.date && b.offer && t.closest('.picker')) {
    const day = b.offer.days.find((x) => x.date === d.date)
    Object.assign(b.offer, { date: day.date, dayLabel: day.label, slots: null, time: null, label: '', error: '' })
    renderBoard()
    return loadOfferSlots()
  }
  if (d.time && b.offer && t.closest('.picker')) {
    const slot = b.offer.slots.slots.find((x) => x.time === d.time)
    Object.assign(b.offer, { time: slot.time, label: `${b.offer.dayLabel}, ${slot.label}`, error: '' })
    return renderBoard()
  }

  const r = id ? findRequest(id, ctx) : null
  switch (d.act) {
    case 'reload':
      return loadBoard()
    case 'confirm':
      return act(() => api.confirm(id), id, 'Confirmed. Copy the text below and send it from your phone.')
    case 'decline':
    case 'cancel':
      Object.assign(b, { open: { ctx, id, kind: d.act }, offer: null, note: '' })
      renderBoard()
      return document.getElementById(`note-${id}`)?.focus()
    case 'decline-send':
      return act(() => api.decline(id, b.note.trim()), id, 'Declined. Copy the text below and send it from your phone.')
    case 'cancel-send':
      return act(() => api.cancelBooking(id, b.note.trim()), id, 'Cancelled. That time is free again.')
    case 'offer':
      Object.assign(b, {
        open: { ctx, id, kind: 'offer' },
        note: '',
        offer: { id, service: r.service.id, days: null, date: null, dayLabel: '', slots: null, time: null, label: '', error: '' },
      })
      renderBoard()
      return loadOfferDays()
    case 'offer-send':
      return act(() => api.offer(id, b.offer.date, b.offer.time, b.note.trim()), id, 'New time offered. It shows on their status page. Copy the text below and send it from your phone.')
    case 'close':
      Object.assign(b, { open: null, offer: null, note: '' })
      return renderBoard()
    case 'copy-text': {
      const m = r?.messages?.find((x) => x.key === d.key)
      if (!m) return
      const ok = await copyText(fullLink(m.text, r.status_url))
      t.textContent = ok ? 'Copied' : 'Could not copy'
      setTimeout(() => { if (t.isConnected) t.textContent = 'Copy text' }, 2500)
      return
    }
    case 'push':
      return simple(() => api.push(id), id, { ok: 'Sent to Shop Board.' })
    case 'dismiss':
      b.recent = b.recent.filter((x) => x.id !== id)
      delete b.cardMsg[id]
      return renderBoard()
    case 'close-item':
      Object.assign(b, { menu: null, open: b.open?.ctx === 'item' ? null : b.open, offer: b.open?.ctx === 'item' ? null : b.offer })
      return renderBoard()
    case 'block-open':
      b.blockForm = { date: b.data.from < b.data.today ? b.data.today : b.data.from, time: '12:00', end: '13:00', all: true, bays: [], label: 'Walk-in', error: '', conflicts: null }
      Object.assign(b, { open: { kind: 'block-form' }, offer: null, menu: null })
      renderBoard()
      return document.getElementById('block-form')?.scrollIntoView({ block: 'nearest' })
    case 'block-close':
      b.open = null
      return renderBoard()
    case 'block-remove': {
      const blockId = t.closest('[data-block]').dataset.block
      return simple(() => api.removeBlock(blockId), blockId, { closeMenu: true })
    }
  }
})

root.addEventListener('input', (e) => {
  if (e.target.matches('[data-note]')) b.note = e.target.value
  const f = b.blockForm
  if (f && e.target.closest('#block-form')) {
    const { name, value } = e.target
    if (name === 'date' || name === 'time' || name === 'end' || name === 'label') f[name] = value
  }
})

root.addEventListener('change', (e) => {
  const f = b.blockForm
  if (!f || !e.target.closest('#block-form')) return
  const { name, value, checked } = e.target
  if (name === 'all') {
    f.all = checked
    f.bays = checked ? [] : Array.from({ length: b.data.bays }, (_, i) => i + 1)
    renderBoard()
  } else if (name === 'bay') {
    const n = Number(value)
    f.bays = checked ? [...new Set([...f.bays, n])] : f.bays.filter((x) => x !== n)
  } else if (name in f) {
    f[name] = value
  }
})

root.addEventListener('submit', (e) => {
  e.preventDefault()
  if (e.target.id === 'signin-form') return signin(document.getElementById('pin').value)
  if (e.target.id === 'block-form' && !b.busy) return submitBlock()
})

nav.addEventListener('click', (e) => {
  const t = e.target.closest('button[data-view]')
  if (!t || t.dataset.view === app.view) return
  app.view = t.dataset.view
  Object.assign(b, { menu: null, open: null, offer: null })
  render()
  if (app.view === 'board') loadBoard()
})

signoutBtn.addEventListener('click', async () => {
  try { await api.signout() } catch {}
  session.clear()
  Object.assign(b, { data: null, recent: [], cardMsg: {}, menu: null, open: null, offer: null })
  app.signinError = ''
  app.view = 'board'
  render()
})

window.addEventListener(SIGNED_OUT, (e) => {
  app.signinError = e.detail || 'Please sign in again.'
  Object.assign(b, { data: null, menu: null, open: null, offer: null, busy: false })
  app.view = 'board'
  render()
})

setInterval(() => {
  if (session.get() && app.view === 'board' && document.visibilityState === 'visible') loadBoard({ quiet: true })
}, POLL_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session.get() && app.view === 'board') loadBoard({ quiet: true })
})

api.shop().then(showShop, () => {})
render()
if (session.get()) loadBoard()
