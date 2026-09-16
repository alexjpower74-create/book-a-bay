// npm run demo: Book a Bay on this computer with the SAMPLE shop and a SAMPLE week of bookings.
// Local only. TEST_MODE is on so the seed route exists; never deploy with it (docs/DEPLOY.md).
// Usage: npm run demo            keeps the bookings from last time (seeds only the first time)
//        npm run demo -- --fresh starts again from the SAMPLE week
// PORT (default 7301) picks the port; the wrangler inspector uses PORT + 10.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = join(dirname(fileURLToPath(import.meta.url)), 'worker')
const PORT = Number(process.env.PORT || 7301)
const BASE = `http://127.0.0.1:${PORT}`
const state = join(worker, '.state-demo')
const fresh = process.argv.includes('--fresh') || !existsSync(state)
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }

if (fresh) {
  rmSync(state, { recursive: true, force: true })
  const m = spawnSync('wrangler', ['d1', 'migrations', 'apply', 'book-a-bay', '--local', '--persist-to', state], {
    cwd: worker,
    env,
    stdio: 'inherit',
  })
  if (m.status !== 0) process.exit(m.status ?? 1)
}

const child = spawn(
  'wrangler',
  [
    'dev',
    '--local',
    '--port',
    String(PORT),
    '--inspector-port',
    String(PORT + 10),
    '--persist-to',
    state,
    '--var',
    'TEST_MODE:1',
    '--show-interactive-dev-session=false',
  ],
  { cwd: worker, env, stdio: ['ignore', 'ignore', 'inherit'], detached: true },
)
const stop = () => {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', (code) => {
  console.error(`wrangler dev stopped (${code}).`)
  process.exit(code ?? 1)
})

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/api/shop`)).ok) break
  } catch {}
  if (i > 120) {
    console.error(`The Worker did not answer on ${BASE}.`)
    stop()
  }
  await new Promise((r) => setTimeout(r, 500))
}

if (fresh) {
  const r = await fetch(`${BASE}/api/test/seed`, { method: 'POST', body: '{}' })
  const body = await r.json().catch(() => ({}))
  console.log(r.ok ? `Seeded ${body.requests} SAMPLE requests from ${body.today}.` : `Seeding failed: ${JSON.stringify(body)}`)
}

console.log(`
Book a Bay is running (SAMPLE data, local only).
  Customer booking page  ${BASE}/
  Shop side              ${BASE}/shop/   PIN 2468
Press Ctrl+C to stop.`)
