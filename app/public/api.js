// The app's only door to the Worker: same-origin fetch('/api/…') per docs/API.md. A failed call throws ApiError whose
// message is the API's own `error` text, shown to people as is. Shop routes carry the session token from localStorage
// (`book-a-bay:shop-token`); a 401 on them clears it and fires SIGNED_OUT. `?mock=1` swaps in api.mock.js for development
// (remembered for the tab; `?mock=0` turns it off). Playwright never uses the mock.

const MOCK_KEY = 'book-a-bay:mock'
const TOKEN_KEY = 'book-a-bay:shop-token'
export const SIGNED_OUT = 'book-a-bay:signed-out'

const mode = new URLSearchParams(location.search).get('mock')
let mocked = false
try {
  if (mode === '1') sessionStorage.setItem(MOCK_KEY, '1')
  if (mode === '0') sessionStorage.removeItem(MOCK_KEY)
  mocked = sessionStorage.getItem(MOCK_KEY) === '1'
} catch {
  mocked = mode === '1'
}
const mock = mocked ? await import('/api.mock.js') : null

export const session = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) || ''
    } catch {
      return ''
    }
  },
  set(token) {
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {}
  },
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Something went wrong (error ${status}). Please try again.`)
    this.status = status
    this.code = body?.code || 'error'
    this.field = body?.field || null
    this.body = body || {}
  }
}

const isShop = (path) => path.startsWith('/api/shop/') && !path.startsWith('/api/shop/signin')

async function send(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  const token = session.get()
  if (token && isShop(path)) headers.authorization = `Bearer ${token}`
  if (mock) {
    const r = await mock.handle(method, path, body, headers)
    const raw = typeof r.body === 'string'
    return { status: r.status, data: raw ? null : r.body, text: raw ? r.body : JSON.stringify(r.body), type: r.type || 'application/json' }
  }
  let res
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
  } catch {
    throw new ApiError(0, { error: 'Could not reach the shop. Check your connection and try again.', code: 'network' })
  }
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data, text, type: res.headers.get('content-type') || '' }
}

async function call(method, path, body) {
  const r = await send(method, path, body)
  if (r.status >= 200 && r.status < 300) return r.data
  // A dead session anywhere on the shop side signs the shop out; a wrong current PIN on the PIN form does not.
  // Only the PIN form's own refusal names field: current (clarification 21); every other 401 is a session that ended.
  if (r.status === 401 && isShop(path) && !(path === '/api/shop/pin' && r.data?.field === 'current')) {
    session.clear()
    window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: r.data?.error || '' }))
  }
  throw new ApiError(r.status, r.data)
}

const q = encodeURIComponent
const req = (id) => `/api/shop/requests/${q(id)}`

export const api = {
  mocked,
  // customer
  shop: () => call('GET', '/api/shop'),
  days: (service) => call('GET', `/api/days?service=${q(service)}`),
  slots: (service, date) => call('GET', `/api/slots?service=${q(service)}&date=${q(date)}`),
  request: (body) => call('POST', '/api/requests', body),
  view: (token) => call('GET', `/api/r/${q(token)}`),
  accept: (token) => call('POST', `/api/r/${q(token)}/accept`, {}),
  repick: (token, date, time) => call('POST', `/api/r/${q(token)}/repick`, { date, time }),
  cancel: (token) => call('POST', `/api/r/${q(token)}/cancel`, {}),
  // Moving an existing booking: its own service snapshot, its own hold free (clarification 19).
  pickDays: (token) => call('GET', `/api/r/${q(token)}/days`),
  pickSlots: (token, date) => call('GET', `/api/r/${q(token)}/slots?date=${q(date)}`),
  // shop
  signin: (pin) => call('POST', '/api/shop/signin', { pin }),
  signout: () => call('POST', '/api/shop/signout', {}),
  board: (date, days) => call('GET', `/api/shop/board?${date ? `date=${q(date)}&` : ''}days=${days}`),
  confirm: (id) => call('POST', `${req(id)}/confirm`, {}),
  decline: (id, note) => call('POST', `${req(id)}/decline`, note ? { note } : {}),
  offer: (id, date, time, note) => call('POST', `${req(id)}/offer`, { date, time, ...(note ? { note } : {}) }),
  cancelBooking: (id, note) => call('POST', `${req(id)}/cancel`, note ? { note } : {}),
  push: (id) => call('POST', `${req(id)}/push`, {}),
  shopDays: (exclude) => call('GET', `/api/shop/days?exclude=${q(exclude)}`),
  shopSlots: (service, date, exclude) => call('GET', `/api/shop/slots?service=${q(service)}&date=${q(date)}&exclude=${q(exclude)}`),
  addBlock: (block) => call('POST', '/api/shop/blocks', block),
  removeBlock: (id) => call('DELETE', `/api/shop/blocks/${q(id)}`),
  settings: () => call('GET', '/api/shop/settings'),
  saveSettings: (settings) => call('PUT', '/api/shop/settings', settings),
  changePin: (current, next) => call('PUT', '/api/shop/pin', { current, next }),
  // The export is a file, not JSON to show: hand back the raw text and type.
  async exportShopBoard(from, to, format) {
    const path = `/api/shop/export/shop-board?from=${q(from)}&to=${q(to)}&format=${q(format)}`
    const r = await send('GET', path)
    if (r.status >= 200 && r.status < 300) return { text: r.text, type: r.type }
    if (r.status === 401) {
      session.clear()
      window.dispatchEvent(new CustomEvent(SIGNED_OUT, { detail: r.data?.error || '' }))
    }
    throw new ApiError(r.status, r.data)
  },
}
