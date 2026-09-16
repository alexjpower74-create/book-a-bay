// npm run negative:slots — M1 negative controls (a) and (b) for the pure slot tests. See negative-lib.mjs.

import { runUnitControls } from './negative-lib.mjs'

const ok = runUnitControls('negative:slots', [
  {
    name: 'a-closures',
    break: 'dayInfo ignores settings.closures',
    file: 'src/slots.js',
    find: 'const closure = (settings.closures || []).find(c => c.date === date)',
    replace: 'const closure = undefined /* NEGATIVE CONTROL (a): closures ignored */',
    testFile: 'tests/slots.test.mjs',
    test: 'a closure date is closed with its reason',
  },
  {
    name: 'b-bays',
    break: 'pickBays ignores settings.bays (always looks at 10 bays)',
    file: 'src/slots.js',
    find: 'for (let bay = 1; bay <= bayCount; bay++)',
    replace: 'for (let bay = 1; bay <= 10 /* NEGATIVE CONTROL (b): bay count ignored */; bay++)',
    testFile: 'tests/slots.test.mjs',
    test: 'the bay-count change',
  },
])
process.exit(ok ? 0 : 1)
