// npm run negative:race — proves the race test can fail.
// Copies worker/ to worker/.negative/race, replaces the RACE-GUARD region with an unguarded read-check-then-insert
// (separate awaited statements, 25 ms of honest "latency" between check and insert), adds a migration that drops
// the UNIQUE indexes on cells and starts, starts that copy on 7305, and runs only the race test against it.
// Exits 0 only if the race test fails with more than one winner. Output is appended to tests/negative-control.log.
// The shipped code has no switch for this: the break exists only in the throwaway copy.

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startWorker } from './run.mjs'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const copy = join(root, '.negative', 'race')
const PORT = 7305
const logFile = join(root, 'tests', 'negative-control.log')

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

function replaceOnce (text, pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, 'g')) || []
  if (matches.length !== 1) throw new Error(`${what}: expected exactly one match, found ${matches.length}`)
  return text.replace(pattern, () => replacement)
}

const lines = []
const say = s => { console.log(s); lines.push(s) }
const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
say(`\n=== negative:race ${new Date().toISOString()} (HEAD ${sha}, working tree) ===`)

let verdictOk = false
let worker = null
try {
  rmSync(copy, { recursive: true, force: true })
  mkdirSync(copy, { recursive: true })
  // Node refuses to cpSync a directory into its own subdirectory, so copy the top-level entries one by one.
  for (const entry of readdirSync(root)) {
    if (/^(\.state-|\.logs|\.negative|\.wrangler|node_modules)/.test(entry)) continue
    cpSync(join(root, entry), join(copy, entry), { recursive: true })
  }

  const tomlPath = join(copy, 'wrangler.toml')
  writeFileSync(tomlPath, replaceOnce(readFileSync(tomlPath, 'utf8'), /directory = "\.\.\/app\/public"/,
    `directory = ${JSON.stringify(resolve(root, '..', 'app', 'public'))}`, 'wrangler.toml assets directory'))

  const indexPath = join(copy, 'src', 'index.js')
  const guarded = readFileSync(indexPath, 'utf8')
  writeFileSync(indexPath, replaceOnce(guarded, /\/\/ RACE-GUARD:BEGIN[\s\S]*?\/\/ RACE-GUARD:END/, UNGUARDED, 'RACE-GUARD region'))

  writeFileSync(join(copy, 'migrations', '0003_negative_drop_unique.sql'),
    '-- NEGATIVE CONTROL ONLY (never shipped): no UNIQUE guard on held cells or numbered starts.\nDROP INDEX cells_unique;\nDROP INDEX starts_unique;\n')

  say('break: RACE-GUARD region -> unguarded SELECT check, await scheduler.wait(25), INSERTs one by one; UNIQUE indexes cells_unique and starts_unique dropped')
  worker = await startWorker({ dir: copy, port: PORT, log: join(copy, '.logs', `wrangler-${PORT}.log`) })
  say(`started the broken copy on ${worker.base}`)

  const run = spawnSync(process.execPath, ['--test', '--test-name-pattern', '^the race', 'tests/api.test.mjs'], {
    cwd: copy, encoding: 'utf8', env: { ...process.env, BASE: worker.base }
  })
  const output = `${run.stdout}${run.stderr}`
  say(output.trimEnd())

  const winners = Number((/RACE winners=(\d+)/.exec(output) || [])[1] ?? NaN)
  const raceFailed = run.status !== 0 && /✖ the race/.test(output)
  verdictOk = raceFailed && winners > 1
  say(verdictOk
    ? `verdict: RED as expected. Without the batch + UNIQUE guard ${winners} customers all got a 201 for the one free place. The race test measures the guard.`
    : `verdict: NOT RED as required (test exit ${run.status}, winners ${winners}). This negative control did not show a double booking.`)
} catch (e) {
  say(`verdict: ERROR ${e.stack || e.message}`)
} finally {
  if (worker) await worker.stop()
  // The log is committed: never write this machine's folder names into it.
  appendFileSync(logFile, lines.join('\n').replaceAll(pathToFileURL(resolve(root, '..')).href, 'file://<repo>').replaceAll(resolve(root, '..'), '<repo>') + '\n')
}
process.exit(verdictOk ? 0 : 1)
