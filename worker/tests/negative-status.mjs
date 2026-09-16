// npm run negative:status — proves the Confirm + Decline race test can fail.
// Copies worker/ to worker/.negative/status and makes the hold release unconditional (the DELETEs no longer check that
// this status change's rev was written), starts that copy on 7305, and runs only the status race test against it.
// Exits 0 only if that test fails with a run that ends confirmed but holds nothing.

import { join } from 'node:path'
import { copyWorker, createLog, patchFile, runNode } from './negative-lib.mjs'
import { startWorker } from './run.mjs'

const PORT = 7305
const FIND = "const IF_APPLIED = ' AND (SELECT rev FROM requests WHERE id = ?2) = ?3'"
// Keeps both bind parameters in use (D1 refuses unused bindings) but no longer depends on the status change.
const BREAK = "const IF_APPLIED = ' AND ?2 IS NOT NULL AND ?3 IS NOT NULL' /* NEGATIVE CONTROL: release is unconditional */"

const log = createLog('negative:status')
let verdictOk = false
let worker = null
try {
  const copy = copyWorker('status')
  patchFile(copy, 'src/index.js', FIND, BREAK, 'IF_APPLIED')
  log.say(`break: src/index.js: ${FIND}  ->  ${BREAK}`)
  worker = await startWorker({ dir: copy, port: PORT, log: join(copy, '.logs', `wrangler-${PORT}.log`) })
  log.say(`started the broken copy on ${worker.base}`)
  const run = runNode(copy, ['--test', '--test-name-pattern', '^Confirm and Decline at once', 'tests/api.test.mjs'], { BASE: worker.base })
  log.say(run.output.trimEnd())
  const outcomes = (/STATUS-RACE outcomes=(\S+)/.exec(run.output) || [])[1] || ''
  verdictOk = run.status !== 0 && /✖ Confirm and Decline at once/.test(run.output) && /confirmed:0c0s/.test(outcomes)
  log.say(
    verdictOk
      ? 'verdict: RED as expected. With an unconditional release, a Decline that lost to Confirm still deleted the holds: the booking reads confirmed while its bay time is free for someone else.'
      : `verdict: NOT RED as required (test exit ${run.status}, outcomes ${outcomes || 'none'}).`,
  )
} catch (e) {
  log.say(`verdict: ERROR ${e.stack || e.message}`)
} finally {
  if (worker) await worker.stop()
  log.flush()
}
process.exit(verdictOk ? 0 : 1)
