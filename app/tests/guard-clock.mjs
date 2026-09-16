// Guard: shop dates come from the API, never the browser clock. Fails on `new Date()` or `Date.now()` anywhere in
// app/public. It first proves it can fail: the pattern must catch known-bad lines, or the run is VOID (exit 2).
// Usage: node tests/guard-clock.mjs [dir]
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BAD = /\bnew\s+Date\s*\(\s*\)|\bDate\.now\s*\(/
const KNOWN_BAD = ['const today = new Date()', 'let t = Date.now()', 'x = new Date( )']
const KNOWN_OK = ['const d = new Date(ms)', "Date.parse('2026-09-14')"]
if (!KNOWN_BAD.every((l) => BAD.test(l)) || KNOWN_OK.some((l) => BAD.test(l))) {
  console.error('VOID: the clock pattern does not separate known-bad from known-good lines')
  process.exit(2)
}

const dir = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const hits = []
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) await walk(p)
    else if (/\.(m?js|html)$/.test(e.name)) {
      ;(await readFile(p, 'utf8')).split('\n').forEach((line, i) => {
        if (BAD.test(line)) hits.push(`${path.relative(dir, p)}:${i + 1}: ${line.trim()}`)
      })
    }
  }
}
await walk(dir)
if (hits.length) {
  console.error(`FAIL: browser clock used for dates in ${dir}\n${hits.join('\n')}`)
  process.exit(1)
}
console.log(`PASS: no browser clock in ${dir} (pattern self-test caught ${KNOWN_BAD.length} known-bad lines)`)
