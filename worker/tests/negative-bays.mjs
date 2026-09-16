// npm run negative:bays — proves the bays-in-flight test can fail (API.md clarification 16).
//
// The booking's read-then-batch gap is only a few milliseconds locally, so with the guard removed and no added latency the
// test stayed green in 10 runs, twice (both recorded in negative-control.log as NOT RED). This runner therefore adds an honest
// `await scheduler.wait(25)` between the booking's read and its batch, in the copies only (the same stand-in for network
// latency that negative:race uses), and runs two copies on 7305, one after the other:
//   1. control: the wait added, the guard kept. The test must PASS, so the wait alone does not break anything.
//   2. break:   the wait added, BAY_GUARD_SQL replaced by a statement that checks nothing (it keeps its one binding).
//      The test must FAIL with at least one run ending bays=2 with a hold on bay 3.
// Both copies use the same send timing, a sweep across the window where the double booking can happen: with 25 ms of
// latency before the booking batch, the save must commit while a booking that already read "3 bays" is still waiting, i.e.
// the bookings go out a little ahead of the save. 20 runs, 2 ms apart: bookings 40 ms ahead down to 2 ms ahead. The earlier
// sweeps are in the log as NOT RED: step 3 ms (control saw only save-first runs), and 20 runs of (run - 5) * 9 ms, which put
// the save far ahead in most runs and caught 1 doubled run in 10, then 0 in 20.
// Exits 0 only if both hold. Overrides: BAYS_RACE_RUNS (default 20), NEGATIVE_BAYS_WAIT_MS (default 25),
// BAYS_RACE_STAGGER_STEP_MS (default 2 here), BAYS_RACE_STAGGER_OFFSET (default 20 here).

import { join } from 'node:path'
import { copyWorker, createLog, patchFile, runNode } from './negative-lib.mjs'
import { startWorker } from './run.mjs'

const PORT = 7305
const RUNS = Number(process.env.BAYS_RACE_RUNS || 20)
const WAIT_MS = Number(process.env.NEGATIVE_BAYS_WAIT_MS ?? 25)
const STEP_MS = Number(process.env.BAYS_RACE_STAGGER_STEP_MS || 2)
const OFFSET = Number(process.env.BAYS_RACE_STAGGER_OFFSET || 20)
const FIND = `const BAY_GUARD_SQL = "SELECT json(CASE WHEN ?1 > (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'bays') THEN 'bay removed' ELSE '0' END)"`
const BREAK = 'const BAY_GUARD_SQL = "SELECT ?1 AS unguarded" /* NEGATIVE CONTROL: bay guard removed */'
const TEST = 'lowering bays while bookings are in flight'

const log = createLog('negative:bays')

async function runCopy(name, { removeGuard }) {
  const copy = copyWorker(name)
  if (removeGuard) {
    patchFile(copy, 'src/index.js', FIND, BREAK, 'BAY_GUARD_SQL')
    log.say(`[${name}] break: src/index.js: ${FIND}  ->  ${BREAK}`)
  } else {
    log.say(`[${name}] guard kept`)
  }
  if (WAIT_MS > 0) {
    patchFile(
      copy,
      'src/index.js',
      '    let committed = false\n',
      `    let committed = false\n    await scheduler.wait(${WAIT_MS}) /* NEGATIVE CONTROL: latency between read and batch */\n`,
      'latency before the booking batch',
    )
    log.say(`[${name}] extra: await scheduler.wait(${WAIT_MS}) between the booking's read and its batch (this copy only)`)
  }
  const worker = await startWorker({ dir: copy, port: PORT, log: join(copy, '.logs', `wrangler-${PORT}.log`) })
  try {
    const run = runNode(copy, ['--test', '--test-name-pattern', `^${TEST}`, 'tests/api.test.mjs'], {
      BASE: worker.base,
      BAYS_RACE_RUNS: String(RUNS),
      BAYS_RACE_STAGGER_STEP_MS: String(STEP_MS),
      BAYS_RACE_STAGGER_OFFSET: String(OFFSET),
    })
    log.say(run.output.trimEnd())
    const outcomes = ((/BAYS-RACE outcomes=(\S+)/.exec(run.output) || [])[1] || '').split(',').filter(Boolean)
    return { status: run.status, output: run.output, outcomes }
  } finally {
    await worker.stop()
  }
}

let verdictOk = false
try {
  log.say(
    `runs: ${RUNS} per copy, send stagger (run - ${OFFSET}) * ${STEP_MS} ms (bookings ${OFFSET * STEP_MS} ms ahead down to ${(OFFSET - RUNS + 1) * STEP_MS} ms ahead), added latency ${WAIT_MS} ms`,
  )
  const control = await runCopy('bays-control', { removeGuard: false })
  const controlOk = control.status === 0 && control.output.includes(`✔ ${TEST}`) && control.outcomes.length === RUNS
  log.say(
    controlOk
      ? `control: PASSES with the same latency and the guard kept (${control.outcomes.filter((o) => o.startsWith('save409')).length} booking-first, ${control.outcomes.filter((o) => o.startsWith('save200')).length} save-first runs).`
      : `control: DID NOT PASS (exit ${control.status}); the added latency alone breaks the test, so a red below would prove nothing.`,
  )

  const broken = await runCopy('bays', { removeGuard: true })
  const doubled = broken.outcomes.filter((o) => /bays2:\d+w:bay3/.test(o)).length
  const brokenRed = broken.status !== 0 && broken.output.includes(`✖ ${TEST}`) && doubled > 0
  verdictOk = controlOk && brokenRed
  log.say(
    verdictOk
      ? `verdict: RED as expected. With the same latency, the guarded copy passed and the unguarded copy let ${doubled} of ${RUNS} runs save bays=2 while a booking held bay 3.`
      : `verdict: NOT RED as required (control ${controlOk ? 'passed' : 'failed'}, broken exit ${broken.status}, doubled runs ${doubled}).`,
  )
} catch (e) {
  log.say(`verdict: ERROR ${e.stack || e.message}`)
} finally {
  log.flush()
}
process.exit(verdictOk ? 0 : 1)
