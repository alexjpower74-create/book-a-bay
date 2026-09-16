// Shared plumbing for the negative controls: copy worker/ to a throwaway folder, apply one literal break that must
// match exactly once, run a test there, and append a scrubbed record to tests/negative-control.log.
// The shipped code never contains a switch for any of these breaks; they exist only in the copies.

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const logFile = join(root, 'tests', 'negative-control.log')

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function replaceOnce(text, find, replacement, what) {
  const count = typeof find === 'string' ? text.split(find).length - 1 : (text.match(new RegExp(find.source, 'g')) || []).length
  if (count !== 1) throw new Error(`${what}: expected exactly one match, found ${count}`)
  return text.replace(find, () => replacement)
}

export function patchFile(dir, file, find, replacement, what) {
  const path = join(dir, file)
  writeFileSync(path, replaceOnce(readFileSync(path, 'utf8'), find, replacement, what))
}

/** A fresh copy of worker/ at worker/.negative/<name>, with the assets directory made absolute so it still resolves. */
export function copyWorker(name) {
  const dir = join(root, '.negative', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // Node refuses to cpSync a directory into its own subdirectory, so copy the top-level entries one by one.
  for (const entry of readdirSync(root)) {
    if (/^(\.state-|\.logs|\.negative|\.wrangler|node_modules)/.test(entry)) continue
    cpSync(join(root, entry), join(dir, entry), { recursive: true })
  }
  patchFile(
    dir,
    'wrangler.toml',
    'directory = "../app/public"',
    `directory = ${JSON.stringify(resolve(root, '..', 'app', 'public'))}`,
    'wrangler.toml assets directory',
  )
  return dir
}

export function runNode(dir, args, env = {}) {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

export function createLog(title) {
  const lines = []
  const say = (s) => {
    console.log(s)
    lines.push(s)
  }
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  say(`\n=== ${title} ${new Date().toISOString()} (HEAD ${sha}, working tree) ===`)
  return {
    say,
    // The log is committed: never write this machine's folder names into it (plain or file:// URL form).
    flush: () =>
      appendFileSync(
        logFile,
        lines
          .join('\n')
          .replaceAll(pathToFileURL(resolve(root, '..')).href, 'file://<repo>')
          .replaceAll(resolve(root, '..'), '<repo>') + '\n',
      ),
  }
}

/**
 * Pure-test controls. Each: run the named test on the untouched copy (must pass), apply the break, run it again
 * (that exact test must show ✖; a file that no longer parses is not accepted as red).
 */
export function runUnitControls(title, controls) {
  let allOk = true
  for (const c of controls) {
    const log = createLog(`${title} ${c.name}`)
    try {
      const dir = copyWorker(`${title}-${c.name}`)
      const args = ['--test', '--test-name-pattern', `^${escapeRe(c.test)}`, c.testFile]
      const before = runNode(dir, args)
      const passedBefore = before.status === 0 && before.output.includes(`✔ ${c.test}`)
      log.say(`control (unbroken copy): "${c.test}" ${passedBefore ? 'passes' : `DID NOT PASS (exit ${before.status})`}`)
      patchFile(dir, c.file, c.find, c.replace, `${c.name} break`)
      log.say(`break: ${c.file}: ${c.find}  ->  ${c.replace}`)
      const after = runNode(dir, args)
      log.say(after.output.trimEnd())
      const ok = passedBefore && after.status !== 0 && after.output.includes(`✖ ${c.test}`)
      log.say(
        ok
          ? `verdict: RED as expected. "${c.test}" fails when ${c.break}.`
          : `verdict: NOT RED as required (unbroken ${passedBefore ? 'passed' : 'did not pass'}, broken exit ${after.status}).`,
      )
      allOk &&= ok
    } catch (e) {
      log.say(`verdict: ERROR ${e.message}`)
      allOk = false
    }
    log.flush()
  }
  return allOk
}
