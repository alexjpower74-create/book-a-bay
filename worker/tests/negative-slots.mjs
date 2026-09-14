// npm run negative:slots — M1 negative controls (a) and (b) for the pure slot tests.
// For each: copy src/ and tests/ to worker/.negative/<name>, run the named test on the untouched copy (must pass),
// apply one break (must match exactly once), run it again (must fail). Output is appended to tests/negative-control.log.

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const logFile = join(root, 'tests', 'negative-control.log')

const CONTROLS = [
  {
    name: 'a-closures',
    break: 'dayInfo ignores settings.closures',
    file: 'src/slots.js',
    find: 'const closure = (settings.closures || []).find(c => c.date === date)',
    replace: 'const closure = undefined /* NEGATIVE CONTROL (a): closures ignored */',
    test: 'a closure date is closed with its reason'
  },
  {
    name: 'b-bays',
    break: 'pickBays ignores settings.bays (always looks at 10 bays)',
    file: 'src/slots.js',
    find: 'for (let bay = 1; bay <= bayCount; bay++)',
    replace: 'for (let bay = 1; bay <= 10 /* NEGATIVE CONTROL (b): bay count ignored */; bay++)',
    test: 'the bay-count change'
  }
]

const lines = []
const say = s => { console.log(s); lines.push(s) }
const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const runTest = (dir, name) => {
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', `^${escape(name)}`, 'tests/slots.test.mjs'], { cwd: dir, encoding: 'utf8' })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

let allOk = true
for (const c of CONTROLS) {
  say(`\n=== negative:slots ${c.name} ${new Date().toISOString()} (HEAD ${sha}, working tree) ===`)
  const dir = join(root, '.negative', c.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const sub of ['src', 'tests', 'package.json']) cpSync(join(root, sub), join(dir, sub), { recursive: true })

  const before = runTest(dir, c.test)
  const ran = /ℹ tests 1\b/.test(before.output)
  say(`control (unbroken copy): "${c.test}" exit ${before.status}${ran ? '' : ' (test did not run!)'}`)

  const path = join(dir, c.file)
  const src = readFileSync(path, 'utf8')
  const count = src.split(c.find).length - 1
  if (count !== 1) {
    say(`verdict: ERROR break "${c.break}" matched ${count} times in ${c.file}`)
    allOk = false
    continue
  }
  writeFileSync(path, src.replace(c.find, c.replace))
  say(`break: ${c.file}: ${c.find}  ->  ${c.replace}`)
  const after = runTest(dir, c.test)
  say(after.output.trimEnd())
  const ok = before.status === 0 && ran && after.status !== 0 && after.output.includes(`✖ ${c.test}`)
  say(ok ? `verdict: RED as expected. "${c.test}" fails when ${c.break}.` : `verdict: NOT RED as required (unbroken exit ${before.status}, broken exit ${after.status}).`)
  allOk &&= ok
}

// The log is committed: never write this machine's folder names into it.
appendFileSync(logFile, lines.join('\n').replaceAll(pathToFileURL(resolve(root, '..')).href, 'file://<repo>').replaceAll(resolve(root, '..'), '<repo>') + '\n')
process.exit(allOk ? 0 : 1)
