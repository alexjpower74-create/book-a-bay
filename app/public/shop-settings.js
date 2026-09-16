// Shop settings: booking rules, opening hours with Closed toggles, closed days, services (add, edit, take offline) and
// the PIN. Saves the whole object with PUT /api/shop/settings; the API's refusals are shown next to the part they name.
import { api } from '/api.js'
import { esc, duration, clock, hhmm } from '/ui.js'

const WEEK = [
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['0', 'Sunday'],
]
const RULE_FIELDS = ['shop_name', 'timezone', 'bays', 'slot_step_min', 'lead_time_min', 'max_per_slot', 'window_days']

function sectionOf(err) {
  if (err.code === 'bays_in_use') return 'rules'
  const f = String(err.field || '')
  if (f.startsWith('services')) return 'services'
  if (f.startsWith('hours')) return 'hours'
  if (f.startsWith('closures')) return 'closures'
  if (RULE_FIELDS.some((k) => f.startsWith(k))) return 'rules'
  return 'top'
}

const range = (a, z, step = 1) => Array.from({ length: Math.floor((z - a) / step) + 1 }, (_, i) => a + i * step)

export function mountSettings(root) {
  const el = document.createElement('div')
  el.className = 'settings-wrap'
  root.replaceChildren(el)
  const st = {
    draft: null,
    loadError: '',
    errors: {},
    saving: false,
    saved: '',
    pin: { current: '', next: '', error: '', ok: '', busy: false },
  }

  el.innerHTML = `<section class="panel glass"><p class="loading" role="status">Loading settings…</p></section>`
  api.settings().then(
    (s) => {
      st.draft = structuredClone(s)
      render()
    },
    (e) => {
      if (e.status !== 401) el.innerHTML = `<section class="panel glass"><div class="alert" role="alert">${esc(e.message)}</div></section>`
    },
  )

  const select = (attrs, value, options) =>
    `<select ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
  const withCurrent = (options, value, label) =>
    options.some(([v]) => String(v) === String(value)) ? options : [...options, [value, label(value)]].sort((x, y) => x[0] - y[0])
  const sectionError = (key) => (st.errors[key] ? `<div class="alert" role="alert" data-error="${key}">${esc(st.errors[key])}</div>` : '')

  function render() {
    const s = st.draft
    const marks = range(5 * 60, 23 * 60, 15).map((m) => [hhmm(m), clock(hhmm(m))])
    const lead = withCurrent(
      [
        [0, 'Any time'],
        [30, '30 minutes from now'],
        [60, '1 hour from now'],
        [120, '2 hours from now'],
        [240, '4 hours from now'],
        [1440, '1 day ahead'],
        [2880, '2 days ahead'],
      ],
      s.lead_time_min,
      (v) => `${duration(v)} from now`,
    )
    const windowOpts = withCurrent(
      [
        [7, '1 week'],
        [14, '2 weeks'],
        [21, '3 weeks'],
        [30, '30 days'],
        [45, '45 days'],
        [60, '60 days'],
      ],
      s.window_days,
      (v) => `${v} days`,
    )
    const lengths = range(15, 480, 15).map((m) => [m, duration(m)])

    el.innerHTML = `
    <form id="settings-form" class="settings" novalidate>
      <div class="settings-head"><h2 class="title">Settings</h2><p class="sub">Changes apply to new bookings as soon as you save. Bookings already made keep their service and time.</p></div>
      ${st.errors.top ? `<div class="alert" role="alert" data-error="top">${esc(st.errors.top)}</div>` : ''}

      <section class="panel glass" data-section="rules">
        <h3>Booking rules</h3>
        ${sectionError('rules')}
        <div class="grid3">
          <div class="field wide"><label for="s-name">Shop name</label><input id="s-name" data-s="shop_name" maxlength="80" value="${esc(s.shop_name)}"></div>
          <div class="field"><label for="s-bays">Bays</label>${select(
            'id="s-bays" data-s="bays"',
            s.bays,
            range(1, 10).map((n) => [n, n === 1 ? '1 bay' : `${n} bays`]),
          )}</div>
          <div class="field"><label for="s-step">Start times every</label>${select('id="s-step" data-s="slot_step_min"', s.slot_step_min, [
            [15, '15 minutes'],
            [30, '30 minutes'],
            [60, 'hour'],
          ])}</div>
          <div class="field"><label for="s-lead">Earliest booking</label>${select('id="s-lead" data-s="lead_time_min"', s.lead_time_min, lead)}</div>
          <div class="field"><label for="s-max">Bookings per start time</label>${select(
            'id="s-max" data-s="max_per_slot"',
            s.max_per_slot,
            range(1, 10).map((n) => [n, String(n)]),
          )}</div>
          <div class="field"><label for="s-window">Customers can book up to</label>${select('id="s-window" data-s="window_days"', s.window_days, windowOpts)}</div>
        </div>
      </section>

      <section class="panel glass" data-section="hours">
        <h3>Opening hours</h3>
        ${sectionError('hours')}
        ${WEEK.map(([k, name]) => {
          const h = s.hours[k]
          return `<div class="hours-row" data-day="${k}">
            <span class="dname">${name}</span>
            <label class="check"><input type="checkbox" data-s="closed" data-day="${k}"${h ? '' : ' checked'}> Closed</label>
            <div class="times2">${
              h
                ? `${select(`data-s="open" data-day="${k}" aria-label="${name} opens"`, h.open, withCurrent(marks, h.open, clock))}<span>to</span>${select(`data-s="close" data-day="${k}" aria-label="${name} closes"`, h.close, withCurrent(marks, h.close, clock))}`
                : `<span class="muted">Closed all day</span>`
            }</div>
          </div>`
        }).join('')}
      </section>

      <section class="panel glass" data-section="closures">
        <h3>Closed days</h3>
        <p class="sub">Holidays and other days the shop is shut. Customers see the reason.</p>
        ${sectionError('closures')}
        ${
          s.closures
            .map(
              (c, i) => `<div class="list-row closure-row">
            <div class="field"><label for="c-date-${i}">Day</label><input type="date" id="c-date-${i}" data-s="closure-date" data-i="${i}" value="${esc(c.date)}"></div>
            <div class="field"><label for="c-reason-${i}">Reason</label><input id="c-reason-${i}" data-s="closure-reason" data-i="${i}" maxlength="60" value="${esc(c.reason)}"></div>
            <button type="button" class="btn quiet" data-sact="closure-remove" data-i="${i}">Remove</button>
          </div>`,
            )
            .join('') || '<p class="muted">No closed days.</p>'
        }
        <div class="actions"><button type="button" class="btn" data-sact="closure-add">Add a closed day</button></div>
      </section>

      <section class="panel glass" data-section="services">
        <h3>Services</h3>
        <p class="sub">Take a service offline to stop new bookings for it. Existing bookings keep it.</p>
        ${sectionError('services')}
        ${s.services
          .map(
            (sv, i) => `<div class="list-row service-row${sv.active ? '' : ' inactive'}">
            <div class="field"><label for="sv-name-${i}">Name</label><input id="sv-name-${i}" data-s="svc-name" data-i="${i}" maxlength="40" value="${esc(sv.name)}"></div>
            <div class="field"><label for="sv-min-${i}">How long</label>${select(`id="sv-min-${i}" data-s="svc-minutes" data-i="${i}"`, sv.minutes, withCurrent(lengths, sv.minutes, duration))}</div>
            <div class="field"><label for="sv-bays-${i}">Bays needed</label>${select(
              `id="sv-bays-${i}" data-s="svc-bays" data-i="${i}"`,
              sv.bays_needed,
              range(1, Math.max(s.bays, sv.bays_needed)).map((n) => [n, String(n)]),
            )}</div>
            <label class="check"><input type="checkbox" data-s="svc-active" data-i="${i}"${sv.active ? ' checked' : ''}> Bookable online</label>
            ${sv._new ? `<button type="button" class="btn quiet" data-sact="service-remove" data-i="${i}">Remove</button>` : ''}
          </div>`,
          )
          .join('')}
        <div class="actions"><button type="button" class="btn" data-sact="service-add">Add a service</button></div>
      </section>

      <div class="savebar glass">
        <span class="saved" id="settings-saved" role="status">${esc(st.saved)}</span>
        <button type="submit" class="btn primary big" id="settings-save"${st.saving ? ' disabled' : ''}>${st.saving ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>

    <form id="pin-form" class="panel glass pin-form" novalidate>
      <h3>Change PIN</h3>
      <p class="sub">4 to 8 digits. Anyone with the PIN can see customers' names and phone numbers.</p>
      <div class="grid2">
        <div class="field"><label for="pin-current">Current PIN</label><input id="pin-current" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" value="${esc(st.pin.current)}"></div>
        <div class="field"><label for="pin-next">New PIN</label><input id="pin-next" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" value="${esc(st.pin.next)}"></div>
      </div>
      ${st.pin.error ? `<div class="alert" role="alert">${esc(st.pin.error)}</div>` : ''}
      ${st.pin.ok ? `<div class="okmsg" role="status">${esc(st.pin.ok)}</div>` : ''}
      <div class="actions"><button type="submit" class="btn primary"${st.pin.busy ? ' disabled' : ''}>Change PIN</button></div>
    </form>`
  }

  function edit(e, committed) {
    const t = e.target
    if (!st.draft || t.closest('#pin-form')) return
    const s = st.draft
    const k = t.dataset.s
    const i = Number(t.dataset.i)
    const day = t.dataset.day
    if (!k) return
    st.saved = ''
    switch (k) {
      case 'shop_name':
        s.shop_name = t.value
        break
      case 'bays':
      case 'slot_step_min':
      case 'lead_time_min':
      case 'max_per_slot':
      case 'window_days':
        s[k] = Number(t.value)
        if (k === 'bays' && committed) render()
        break
      case 'closed':
        s.hours[day] = t.checked ? null : { open: '08:00', close: '17:00' }
        render()
        break
      case 'open':
      case 'close':
        s.hours[day][k] = t.value
        break
      case 'closure-date':
        s.closures[i].date = t.value
        break
      case 'closure-reason':
        s.closures[i].reason = t.value
        break
      case 'svc-name':
        s.services[i].name = t.value
        break
      case 'svc-minutes':
        s.services[i].minutes = Number(t.value)
        break
      case 'svc-bays':
        s.services[i].bays_needed = Number(t.value)
        break
      case 'svc-active':
        s.services[i].active = t.checked
        if (committed) render()
        break
    }
  }
  el.addEventListener('input', (e) => {
    if (e.target.tagName !== 'SELECT' && e.target.type !== 'checkbox') edit(e, false)
  })
  el.addEventListener('change', (e) => edit(e, true))

  el.addEventListener('click', (e) => {
    const t = e.target.closest('button[data-sact]')
    if (!t || !st.draft) return
    const s = st.draft
    const i = Number(t.dataset.i)
    st.saved = ''
    if (t.dataset.sact === 'closure-add') s.closures.push({ date: '', reason: '' })
    if (t.dataset.sact === 'closure-remove') s.closures.splice(i, 1)
    if (t.dataset.sact === 'service-add') s.services.push({ id: '', name: '', minutes: 60, bays_needed: 1, active: true, _new: true })
    if (t.dataset.sact === 'service-remove') s.services.splice(i, 1)
    render()
    if (t.dataset.sact === 'service-add') document.getElementById(`sv-name-${s.services.length - 1}`)?.focus()
    if (t.dataset.sact === 'closure-add') document.getElementById(`c-date-${s.closures.length - 1}`)?.focus()
  })

  el.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (e.target.id === 'settings-form') return save()
    if (e.target.id === 'pin-form') return changePin()
  })

  async function save() {
    if (st.saving) return
    const s = st.draft
    // A new service gets its id from its name, kept unique; ids of saved services never change.
    const used = new Set(s.services.filter((x) => x.id).map((x) => x.id))
    for (const sv of s.services) {
      if (sv.id) continue
      const base =
        sv.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 28) || 'service'
      let id = base
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`
      used.add(id)
      sv.id = id
    }
    const body = { ...s, services: s.services.map(({ _new, ...sv }) => sv) }
    st.saving = true
    st.errors = {}
    render()
    try {
      const saved = await api.saveSettings(body)
      st.draft = structuredClone(saved)
      st.saved = 'Saved.'
    } catch (err) {
      if (err.status === 401) return
      st.errors[sectionOf(err)] = err.message
    } finally {
      st.saving = false
    }
    if (!el.isConnected) return
    render()
    const shown = el.querySelector('[data-error]')
    if (shown) shown.scrollIntoView({ block: 'center' })
  }

  async function changePin() {
    const p = st.pin
    p.current = document.getElementById('pin-current').value
    p.next = document.getElementById('pin-next').value
    p.ok = ''
    p.error = !/^\d{4,8}$/.test(p.next) ? 'The new PIN has to be 4 to 8 digits.' : ''
    if (p.error) return render()
    p.busy = true
    render()
    try {
      await api.changePin(p.current, p.next)
      Object.assign(p, { current: '', next: '', ok: 'PIN changed. Use the new PIN next time you sign in.' })
    } catch (err) {
      p.error = err.message
    } finally {
      p.busy = false
    }
    if (el.isConnected) render()
  }
}
