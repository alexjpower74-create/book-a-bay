// "Now" and the client IP. The X-Test-Now / X-Test-IP headers are honoured only when the Worker runs with
// var TEST_MODE=1 (tests pass --var TEST_MODE:1). Without it both headers are ignored, so a customer cannot
// move the shop's clock or dodge a rate limit.

export function isTestMode (env) {
  return String(env?.TEST_MODE ?? '') === '1'
}

export function now (request, env) {
  if (isTestMode(env)) {
    const header = request.headers.get('X-Test-Now')
    if (header) {
      const ms = Date.parse(header)
      if (Number.isFinite(ms)) return ms
    }
  }
  return Date.now()
}

export function clientIp (request, env) {
  if (isTestMode(env)) {
    const header = request.headers.get('X-Test-IP')
    if (header) return header
  }
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}
