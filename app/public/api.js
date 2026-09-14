// The app's only door to the Worker: same-origin fetch('/api/…') per docs/API.md. A failed call throws ApiError whose
// message is the API's own `error` text, shown to people as is. `?mock=1` swaps in api.mock.js for development
// (remembered for the tab; `?mock=0` turns it off). Playwright never uses the mock.

const MOCK_KEY = 'book-a-bay:mock'
const mode = new URLSearchParams(location.search).get('mock')
let mocked = false
try {
  if (mode === '1') sessionStorage.setItem(MOCK_KEY, '1')
  if (mode === '0') sessionStorage.removeItem(MOCK_KEY)
  mocked = sessionStorage.getItem(MOCK_KEY) === '1'
} catch { mocked = mode === '1' }
const mock = mocked ? await import('/api.mock.js') : null

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Something went wrong (error ${status}). Please try again.`)
    this.status = status
    this.code = body?.code || 'error'
    this.field = body?.field || null
    this.body = body || {}
  }
}

async function call(method, path, body) {
  let status, data
  if (mock) {
    ;({ status, body: data } = await mock.handle(method, path, body))
  } else {
    let res
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
    } catch {
      throw new ApiError(0, { error: 'Could not reach the shop. Check your connection and try again.', code: 'network' })
    }
    status = res.status
    data = await res.json().catch(() => null)
  }
  if (status >= 200 && status < 300) return data
  throw new ApiError(status, data)
}

const q = encodeURIComponent

export const api = {
  mocked,
  shop: () => call('GET', '/api/shop'),
  days: (service) => call('GET', `/api/days?service=${q(service)}`),
  slots: (service, date) => call('GET', `/api/slots?service=${q(service)}&date=${q(date)}`),
  request: (body) => call('POST', '/api/requests', body),
  view: (token) => call('GET', `/api/r/${q(token)}`),
  accept: (token) => call('POST', `/api/r/${q(token)}/accept`, {}),
  repick: (token, date, time) => call('POST', `/api/r/${q(token)}/repick`, { date, time }),
  cancel: (token) => call('POST', `/api/r/${q(token)}/cancel`, {}),
}
