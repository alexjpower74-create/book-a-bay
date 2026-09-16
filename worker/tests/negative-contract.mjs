// npm run negative:contract — negative controls for API.md clarifications 17, 18, 19 and 21 (the cross-review findings).
// For each break: start an untouched copy on 7305 and run the named API test (must pass), then start a copy with the one
// literal break (must match exactly once) and run it again (that exact test must show ✖). Appends to negative-control.log.

import { join } from 'node:path'
import { copyWorker, createLog, escapeRe, patchFile, runNode } from './negative-lib.mjs'
import { startWorker } from './run.mjs'

const PORT = 7305

const CONTROLS = [
  {
    name: 'offer-bays',
    break: 'the shop view offer no longer carries bays',
    find: '    bays: parseArr(row.bays),\n    offer: offerOf(row, { bays: true }),',
    replace: '    bays: parseArr(row.bays),\n    offer: offerOf(row) /* NEGATIVE CONTROL: shop offer without bays */,',
    test: 'shop view: an offered request carries the bays its offer holds',
  },
  {
    name: 'token-pattern',
    break: "the router's old token pattern {16,128} is back",
    find: "const TOKEN = '([^/]*)'",
    replace: "const TOKEN = '([A-Za-z0-9_-]{16,128})' /* NEGATIVE CONTROL: old strict pattern */",
    test: 'every miss under /api/r/ is 404 with the booking text',
  },
  {
    name: 'own-hold',
    break: "/api/r/:token/slots counts the request's own hold again",
    find: 'row.service_id, ownHold)',
    replace: 'row.service_id, null /* NEGATIVE CONTROL: own hold counted */)',
    test: "a time blocked only by the request's own hold is offered to that request",
  },
  {
    name: 'pin-field',
    break: 'the wrong-current-PIN 401 no longer carries field: current',
    find: "'That PIN is not right.', { field: 'current' })",
    replace: "'That PIN is not right.' /* NEGATIVE CONTROL: no field */)",
    test: 'PIN change refusals: a wrong current PIN carries field current',
  },
]

async function runTest(name, c, broken) {
  const copy = copyWorker(name)
  if (broken) patchFile(copy, 'src/index.js', c.find, c.replace, `${c.name} break`)
  const worker = await startWorker({ dir: copy, port: PORT, log: join(copy, '.logs', `wrangler-${PORT}.log`) })
  try {
    return runNode(copy, ['--test', '--test-name-pattern', `^${escapeRe(c.test)}`, 'tests/api.test.mjs'], { BASE: worker.base })
  } finally {
    await worker.stop()
  }
}

let allOk = true
for (const c of CONTROLS) {
  const log = createLog(`negative:contract ${c.name}`)
  try {
    const before = await runTest(`contract-${c.name}-control`, c, false)
    const passedBefore = before.status === 0 && before.output.includes(`✔ ${c.test}`)
    log.say(`control (unbroken copy on ${PORT}): "${c.test}" ${passedBefore ? 'passes' : `DID NOT PASS (exit ${before.status})`}`)
    log.say(`break: src/index.js: ${c.find.replace(/\n/g, '⏎')}  ->  ${c.replace.replace(/\n/g, '⏎')}`)
    const after = await runTest(`contract-${c.name}`, c, true)
    log.say(after.output.trimEnd())
    const ok = passedBefore && after.status !== 0 && after.output.includes(`✖ ${c.test}`)
    log.say(
      ok
        ? `verdict: RED as expected. "${c.test}" fails when ${c.break}.`
        : `verdict: NOT RED as required (unbroken ${passedBefore ? 'passed' : 'did not pass'}, broken exit ${after.status}).`,
    )
    allOk &&= ok
  } catch (e) {
    log.say(`verdict: ERROR ${e.stack || e.message}`)
    allOk = false
  }
  log.flush()
}
process.exit(allOk ? 0 : 1)
