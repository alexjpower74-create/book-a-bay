// npm run negative:race — proves the race test can fail.
// Copies worker/ to worker/.negative/race, replaces the RACE-GUARD region with an unguarded read-check-then-insert
// (separate awaited statements, 25 ms of honest "latency" between check and insert), adds a migration that drops
// the UNIQUE indexes on cells and starts, starts that copy on 7305, and runs only the race test against it.
// Exits 0 only if the race test fails with more than one winner. Output is appended to tests/negative-control.log.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { copyWorker, createLog, patchFile, runNode } from './negative-lib.mjs'
import { startWorker } from './run.mjs'

const PORT = 7305

const UNGUARDED = `// RACE-GUARD:BEGIN (NEGATIVE CONTROL: unguarded read-check-then-insert)
    {
      const bayList = plan.bays.map(Number).join(',')
      const held = await db.prepare(\`SELECT COUNT(*) AS c FROM cells WHERE date = ?1 AND bay IN (\${bayList}) AND cell >= ?2 AND cell < ?3\`)
        .bind(plan.date, plan.start_min / 15, plan.end_min / 15).first('c')
      const numbered = await db.prepare('SELECT COUNT(*) AS c FROM starts WHERE date = ?1 AND start_min = ?2 AND n = ?3')
        .bind(plan.date, plan.start_min, plan.n).first('c')
      if (!held && !numbered) {
        await scheduler.wait(25) // stands in for network latency between the check and the write
        for (const s of stmts) await s.run()
        committed = true
      }
    }
    // RACE-GUARD:END`

const log = createLog('negative:race')
let verdictOk = false
let worker = null
try {
  const copy = copyWorker('race')
  patchFile(copy, 'src/index.js', /\/\/ RACE-GUARD:BEGIN[\s\S]*?\/\/ RACE-GUARD:END/, UNGUARDED, 'RACE-GUARD region')
  writeFileSync(
    join(copy, 'migrations', '0099_negative_drop_unique.sql'),
    '-- NEGATIVE CONTROL ONLY (never shipped): no UNIQUE guard on held cells or numbered starts.\nDROP INDEX cells_unique;\nDROP INDEX starts_unique;\n',
  )
  log.say(
    'break: RACE-GUARD region -> unguarded SELECT check, await scheduler.wait(25), INSERTs one by one; UNIQUE indexes cells_unique and starts_unique dropped',
  )

  worker = await startWorker({ dir: copy, port: PORT, log: join(copy, '.logs', `wrangler-${PORT}.log`) })
  log.say(`started the broken copy on ${worker.base}`)
  const run = runNode(copy, ['--test', '--test-name-pattern', '^the race', 'tests/api.test.mjs'], { BASE: worker.base })
  log.say(run.output.trimEnd())

  const winners = Number((/RACE winners=(\d+)/.exec(run.output) || [])[1] ?? NaN)
  verdictOk = run.status !== 0 && /✖ the race/.test(run.output) && winners > 1
  log.say(
    verdictOk
      ? `verdict: RED as expected. Without the batch + UNIQUE guard ${winners} customers all got a 201 for the one free place. The race test measures the guard.`
      : `verdict: NOT RED as required (test exit ${run.status}, winners ${winners}). This negative control did not show a double booking.`,
  )
} catch (e) {
  log.say(`verdict: ERROR ${e.stack || e.message}`)
} finally {
  if (worker) await worker.stop()
  log.flush()
}
process.exit(verdictOk ? 0 : 1)
