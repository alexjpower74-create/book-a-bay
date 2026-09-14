// npm test: unit tests (pure slot maths; Shop Board mapping + contract against the fake), then the API tests against a
// TEST_MODE Worker on PORT (default 7302) whose SHOP_BOARD_URL points at the fake Shop Board on 7304.
// If nothing answers on PORT: wipe worker/.state-<PORT>, apply migrations there, start wrangler dev, and stop it at the end.
// If something already answers, it is used as is (its state is not wiped under it; every API test resets first). The push
// tests need that Worker to have been started with SHOP_BOARD_URL=http://127.0.0.1:7304.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 7302)
const BASE = `http://127.0.0.1:${PORT}`
const FAKE_PORT = Number(process.env.FAKE_SHOP_BOARD_PORT || 7304)
const FAKE = `http://127.0.0.1:${FAKE_PORT}`
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }

const step = (cmd, args, extraEnv = {}) =>
  spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...env, ...extraEnv } }).status ?? 1

async function answers (url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok
  } catch { return false }
}

async function waitFor (url, isGone) {
  for (let i = 0; i < 120 && !isGone(); i++) {
    if (await answers(url)) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

function stopper (child, state) {
  return async () => {
    if (state.exited) return
    const gone = new Promise(r => child.once('exit', r))
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await Promise.race([gone, new Promise(r => setTimeout(r, 5000))])
    if (!state.exited) try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
}

export async function startWorker ({ dir = root, port, log, vars = {} }) {
  const state = join(dir, `.state-${port}`)
  rmSync(state, { recursive: true, force: true })
  const migrate = spawnSync('wrangler', ['d1', 'migrations', 'apply', 'book-a-bay', '--local', '--persist-to', state],
    { cwd: dir, env, encoding: 'utf8' })
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  mkdirSync(dirname(log), { recursive: true })
  const out = openSync(log, 'w')
  const varArgs = Object.entries({ TEST_MODE: '1', ...vars }).flatMap(([k, v]) => ['--var', `${k}:${v}`])
  const child = spawn('wrangler', ['dev', '--local', '--port', String(port), '--inspector-port', String(port + 10),
    '--persist-to', state, ...varArgs, '--show-interactive-dev-session=false'],
  { cwd: dir, env, detached: true, stdio: ['ignore', out, out] })
  const s = { exited: false }
  child.on('exit', () => { s.exited = true })
  const base = `http://127.0.0.1:${port}`
  const up = await waitFor(`${base}/api/shop`, () => s.exited)
  if (!up) {
    await stopper(child, s)()
    throw new Error(`wrangler dev did not come up on ${port}; see ${log}`)
  }
  return { base, stop: stopper(child, s) }
}

export async function startFake ({ port, log }) {
  mkdirSync(dirname(log), { recursive: true })
  const out = openSync(log, 'w')
  const child = spawn(process.execPath, [join(root, 'tests', 'fake-shop-board.mjs')],
    { cwd: root, env: { ...env, PORT: String(port) }, detached: true, stdio: ['ignore', out, out] })
  const s = { exited: false }
  child.on('exit', () => { s.exited = true })
  if (!(await waitFor(`http://127.0.0.1:${port}/__health`, () => s.exited))) throw new Error(`fake Shop Board did not start on ${port}`)
  return { stop: stopper(child, s) }
}

async function main () {
  console.log('\n== unit: tests/slots.test.mjs tests/shopboard.test.mjs ==')
  if (step(process.execPath, ['--test', '--test-concurrency=1', 'tests/slots.test.mjs', 'tests/shopboard.test.mjs']) !== 0) process.exit(1)

  let fake = null
  let worker = null
  let status = 1
  try {
    if (await answers(`${FAKE}/__health`)) {
      console.log(`\n== using the fake Shop Board already answering on ${FAKE} ==`)
    } else {
      console.log(`\n== starting the fake Shop Board on ${FAKE_PORT} ==`)
      fake = await startFake({ port: FAKE_PORT, log: join(root, '.logs', `fake-shop-board-${FAKE_PORT}.log`) })
    }
    if (await answers(`${BASE}/api/shop`)) {
      console.log(`\n== using the Worker already answering on ${BASE} ==`)
    } else {
      console.log(`\n== starting wrangler dev on ${PORT} (TEST_MODE=1, SHOP_BOARD_URL=${FAKE}, state .state-${PORT}) ==`)
      worker = await startWorker({ port: PORT, log: join(root, '.logs', `wrangler-${PORT}.log`), vars: { SHOP_BOARD_URL: FAKE } })
    }
    console.log('\n== api: tests/api.test.mjs ==')
    status = step(process.execPath, ['--test', 'tests/api.test.mjs'], { BASE, PORT: String(PORT), FAKE_SHOP_BOARD: FAKE })
  } finally {
    if (worker) await worker.stop()
    if (fake) await fake.stop()
  }
  process.exit(status)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
