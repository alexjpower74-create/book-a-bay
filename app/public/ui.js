// Small shared pieces for the pages: escaping, labels, day chips and time buttons, the shop header, copy to clipboard.
// No clock in here: every date and label comes from the API.

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function duration(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (!h) return `${m} min`
  return `${h} hr${h > 1 ? 's' : ''}${m ? ` ${m} min` : ''}`
}

// Shop Board's duration bands: cyan short, violet medium, magenta long.
export const band = (min) => (min <= 45 ? 'short' : min <= 90 ? 'mid' : 'long')

// "13:30" → "1:30 PM" (string formatting only, the times are already shop local).
export function clock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export const STATUS = {
  requested: { label: 'Requested', text: 'The shop has your request and will confirm your time. Keep this link to check on it.' },
  confirmed: { label: 'Confirmed', text: 'You are booked in. See you then.' },
  declined: { label: 'Declined', text: 'Sorry, the shop cannot take this booking.' },
  offered: { label: 'New time offered', text: 'The shop cannot do the time you asked for, but they have offered another one.' },
  cancelled: { label: 'Cancelled', text: 'This booking is cancelled.' },
}

const svg = (d, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
export const icon = {
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  back: svg('<path d="m15 6-6 6 6 6"/>', 18),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14),
  checkBig: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 28),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
}

// days: the `days` array from GET /api/days. Closed days are disabled and show their reason; open days with nothing left say Full.
export function dayChips(days, today, selected) {
  return days
    .map((d) => {
      const [wd, ...rest] = d.label.split(' ')
      const kind = !d.open ? 'closed' : d.available > 0 ? 'open' : 'full'
      const note = kind === 'closed' ? d.reason || 'Closed' : kind === 'full' ? 'Full' : `${d.available} ${d.available === 1 ? 'time' : 'times'}`
      return `<button type="button" class="day" data-date="${esc(d.date)}" data-kind="${kind}" aria-pressed="${d.date === selected}"${kind === 'open' ? '' : ' disabled'}>
        <span class="wd">${d.date === today ? 'Today' : esc(wd)}</span><span class="dm">${esc(rest.join(' '))}</span><span class="av">${esc(note)}</span></button>`
    })
    .join('')
}

export function timeButtons(slots, selected) {
  return slots
    .map((t) => `<button type="button" class="time" data-time="${esc(t.time)}" aria-pressed="${t.time === selected}">${esc(t.label)}</button>`)
    .join('')
}

// Every screen names the shop and carries the SAMPLE badge while the API says it is the sample shop.
export function showShop(shop) {
  if (!shop) return
  for (const el of document.querySelectorAll('[data-shop-name]')) el.textContent = shop.name
  for (const el of document.querySelectorAll('[data-sample]')) el.hidden = !shop.sample
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'
    document.body.append(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    ta.remove()
    return ok
  }
}
