// npm run negative:shopboard — M2 negative controls for the Shop Board adapter. See negative-lib.mjs.
// (d) one mapping row broken: 12:45 lands on 12:00 PM -> the mapping test must go red.
// (e) the fake accepts an invalid slot -> the contract test must go red (a lenient fake would prove nothing about pushes).

import { runUnitControls } from './negative-lib.mjs'

const ok = runUnitControls('negative:shopboard', [
  {
    name: 'd-mapping-row',
    break: "the 12:30 PM row starts at 12:46, so 12:45 maps to '12:00 PM'",
    file: 'src/shopboard.js',
    find: "['12:30 PM', 750]",
    replace: "['12:30 PM', 766 /* NEGATIVE CONTROL (d) */]",
    testFile: 'tests/shopboard.test.mjs',
    test: 'the mapping table'
  },
  {
    name: 'e-fake-slot',
    break: 'the fake Shop Board accepts any slot',
    file: 'tests/fake-shop-board.mjs',
    find: "if (field === 'slot' && !isSlot(value))",
    replace: "if (field === 'slot' && false /* NEGATIVE CONTROL (e) */)",
    testFile: 'tests/shopboard.test.mjs',
    test: 'contract: the fake refuses what Shop Board refuses'
  }
])
process.exit(ok ? 0 : 1)
