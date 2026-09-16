// Customer status page /r/?t=<token>: what happened to the request, and the customer's own actions on it.
// Polls every 15 s and when the tab comes back into view; never redraws while the customer has a picker or a
// cancel question open.
import { api } from '/api.js'
import { esc, duration, clock, dayChips, timeButtons, showShop, STATUS, icon } from '/ui.js'

const POLL_MS = 15000
const root = document.getElementById('status')
const token = new URLSearchParams(location.search).get('t') || ''

const v = {
  shop: null,
  req: null,
  error: '',
  busy: false,
  actionError: '',
  mode: null, // null | 'pick' | 'cancel'
  pick: null, // { days, date, dayLabel, slots, time, label, error }
  taken: null, // { message, next }
}
let pickSeq = 0

/* ---- data ---------------------------------------------------------------- */

async function refresh() {
  if (!token) {
    v.error = 'This link is missing its booking code. Check the link the shop sent you.'
    return render()
  }
  if (v.busy || v.mode) return
  try {
    const r = await api.view(token)
    if (v.busy || v.mode) return
    const changed = JSON.stringify(r) !== JSON.stringify(v.req)
    v.req = r
    v.error = ''
    showShop(r.shop)
    if (changed) render()
  } catch (e) {
    // Keep showing the last good view through a network blip; a dead link replaces it.
    if (!v.req || e.status === 404) {
      v.req = null
      v.error = e.message
      render()
    }
  }
}

async function run(action) {
  v.busy = true
  v.actionError = ''
  for (const b of root.querySelectorAll('button')) b.disabled = true
  let recheck = false
  try {
    v.req = await action()
    Object.assign(v, { mode: null, pick: null, taken: null })
  } catch (e) {
    if (e.code === 'taken') {
      v.taken = { message: e.message, next: Array.isArray(e.body.next) ? e.body.next.slice(0, 3) : [] }
      if (v.pick) v.pick.time = null
    } else {
      v.actionError = e.message
      Object.assign(v, { mode: null, pick: null, taken: null })
      recheck = true
    }
  } finally {
    v.busy = false
  }
  render()
  if (recheck) refresh()
}

function loadPickDays() {
  const mine = ++pickSeq
  api.pickDays(token).then(
    (r) => {
      if (mine === pickSeq && v.pick) {
        v.pick.days = r.days
        render()
      }
    },
    (e) => {
      if (mine === pickSeq && v.pick) {
        v.pick.error = e.message
        render()
      }
    },
  )
}

function loadPickSlots() {
  const mine = ++pickSeq
  const p = v.pick
  api.pickSlots(token, p.date).then(
    (r) => {
      if (mine === pickSeq && v.pick === p) {
        p.slots = r
        render()
      }
    },
    (e) => {
      if (mine === pickSeq && v.pick === p) {
        p.error = e.message
        render()
      }
    },
  )
}

/* ---- rendering ----------------------------------------------------------- */

function render() {
  if (!v.req) {
    root.innerHTML = v.error
      ? `<section class="panel glass"><h3>We could not open that booking</h3><p class="sub">${esc(v.error)}</p>
         <div class="actions"><a class="btn primary big" href="/">Book a time</a></div></section>`
      : `<section class="panel glass"><p class="loading" role="status">Loading your booking…</p></section>`
    return
  }
  const r = v.req
  const c = r.customer || {}
  const st = STATUS[r.status] || { label: r.status, text: '' }
  const vehicle = [c.year, c.make, c.model].filter(Boolean).join(' ')
  root.innerHTML = `
    <section class="panel glass status-card">
      <p class="eyebrow">Status</p>
      <div class="pill" data-status="${esc(r.status)}" id="status-pill"><i></i><span>${esc(st.label)}</span></div>
      <p class="lede">${esc(st.text)}</p>
      ${
        r.status === 'offered' && r.offer
          ? `<div class="offer"><p class="eyebrow">New time from the shop</p><p class="when">${esc(r.offer.label)}</p>
        <p class="range">${clock(r.offer.time)} to ${clock(r.offer.end)}</p></div>`
          : ''
      }
      ${r.shop_note ? `<div class="shop-note"><b>Note from the shop</b><p>${esc(r.shop_note)}</p></div>` : ''}
      ${v.actionError ? `<div class="alert" role="alert">${esc(v.actionError)}</div>` : ''}
      ${v.mode === 'pick' ? picker() : ''}
      ${actions(r)}
    </section>
    <section class="panel glass">
      <h3>Booking details</h3>
      <dl class="details">
        <div><dt>Service</dt><dd>${esc(r.service.name)} <small>${duration(r.service.minutes)}</small></dd></div>
        <div><dt>${r.status === 'offered' ? 'You asked for' : 'When'}</dt><dd>${esc(r.label)} <small>to ${clock(r.end)}</small></dd></div>
        <div><dt>Vehicle</dt><dd>${esc(vehicle)}</dd></div>
        <div><dt>Name</dt><dd>${esc(c.name)}</dd></div>
        <div><dt>Phone</dt><dd>${esc(c.phone)}</dd></div>
        ${c.note ? `<div class="wide"><dt>Your note</dt><dd>${esc(c.note)}</dd></div>` : ''}
      </dl>
    </section>
    <p class="foot">This page checks for updates every 15 seconds.</p>`
}

function actions(r) {
  const out = []
  if (r.status === 'offered' && v.mode !== 'pick') {
    out.push(`<button type="button" class="btn primary big" data-act="accept">Accept this time</button>`)
    out.push(`<button type="button" class="btn big" data-act="pick">Pick another time</button>`)
  }
  if (r.status === 'confirmed' && r.ics_url) {
    out.push(`<a class="btn primary big" href="${esc(r.ics_url)}" id="add-to-calendar">${icon.calendar} Add to calendar</a>`)
  }
  if (r.status === 'declined' || r.status === 'cancelled') {
    out.push(`<a class="btn primary big" href="/">Book another time</a>`)
  }
  if (['requested', 'offered', 'confirmed'].includes(r.status) && v.mode !== 'pick') {
    out.push(
      v.mode === 'cancel'
        ? `<div class="confirm"><p>Cancel this booking? The shop will see that you cancelled.</p>
            <div class="actions"><button type="button" class="btn danger big" data-act="cancel-yes">Yes, cancel it</button>
            <button type="button" class="btn big" data-act="cancel-no">Keep it</button></div></div>`
        : `<button type="button" class="btn quiet big" data-act="cancel">Cancel my request</button>`,
    )
  }
  return out.length ? `<div class="actions">${out.join('')}</div>` : ''
}

function picker() {
  const p = v.pick
  const today = v.shop?.today
  let body
  if (p.error) body = `<div class="alert" role="alert">${esc(p.error)}</div>`
  else if (!p.days) body = `<p class="loading" role="status">Loading days…</p>`
  else {
    body = `<p class="step-label">Pick a day</p><div class="days">${dayChips(p.days, today, p.date)}</div>`
    if (p.date) {
      body += !p.slots
        ? `<p class="loading" role="status">Loading times…</p>`
        : p.slots.slots.length
          ? `<p class="step-label">Pick a time on ${esc(p.dayLabel)}</p><div class="times">${timeButtons(p.slots.slots, p.time)}</div>`
          : `<p class="empty">No times left on ${esc(p.dayLabel)}. Please pick another day.</p>`
    }
  }
  if (v.taken) {
    const n = v.taken.next.length
    const lead = [
      'There are no other times open right now.',
      'Here is the next one:',
      'Here are the next two:',
      'Here are the next three:',
    ][n]
    body += `<div class="taken" role="alert"><p>${esc(v.taken.message)} ${lead}</p>${
      n
        ? `<div class="alts">${v.taken.next.map((x, i) => `<button type="button" class="btn alt" data-act="alt" data-i="${i}">${esc(x.label)}</button>`).join('')}</div>`
        : ''
    }</div>`
  }
  return `<div class="picker">${body}
    <div class="actions">
      ${p.time ? `<button type="button" class="btn primary big" data-act="repick">Ask for ${esc(p.label)}</button>` : ''}
      <button type="button" class="btn big" data-act="pick-close">Never mind</button>
    </div></div>`
}

/* ---- events -------------------------------------------------------------- */

root.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b || b.disabled || v.busy) return
  const p = v.pick
  if (b.dataset.date && p) {
    const d = p.days.find((x) => x.date === b.dataset.date)
    Object.assign(p, { date: d.date, dayLabel: d.label, slots: null, time: null, label: '', error: '' })
    v.taken = null
    render()
    return loadPickSlots()
  }
  if (b.dataset.time && p) {
    const t = p.slots.slots.find((x) => x.time === b.dataset.time)
    Object.assign(p, { time: t.time, label: `${p.dayLabel}, ${t.label}` })
    v.taken = null
    return render()
  }
  switch (b.dataset.act) {
    case 'accept':
      return run(() => api.accept(token))
    case 'pick':
      Object.assign(v, {
        mode: 'pick',
        actionError: '',
        taken: null,
        pick: { days: null, date: null, dayLabel: '', slots: null, time: null, label: '', error: '' },
      })
      render()
      return loadPickDays()
    case 'pick-close':
      Object.assign(v, { mode: null, pick: null, taken: null })
      render()
      return refresh()
    case 'repick':
      return run(() => api.repick(token, p.date, p.time))
    case 'alt': {
      const x = v.taken.next[Number(b.dataset.i)]
      return run(() => api.repick(token, x.date, x.time))
    }
    case 'cancel':
      v.mode = 'cancel'
      v.actionError = ''
      return render()
    case 'cancel-no':
      v.mode = null
      render()
      return refresh()
    case 'cancel-yes':
      return run(() => api.cancel(token))
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh()
})
setInterval(refresh, POLL_MS)

api.shop().then(
  (shop) => {
    v.shop = shop
    if (!v.req) showShop(shop)
  },
  () => {},
)
render()
refresh()
