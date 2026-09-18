import { marketCopy } from '../src/lib/market.ts'
import { RULE_SHORT } from '../src/lib/rules.ts'
import { alertNotificationCopy, sampleFeedAlert } from '../src/lib/tally.ts'
import type { FeedAlert } from '../src/lib/types.ts'

const fail: string[] = []

function expect(cond: boolean, message: string) {
  if (!cond) fail.push(message)
}

const screenshot: FeedAlert = {
  ...sampleFeedAlert('goals'),
  matchLabel: 'Bandirmaspor vs Umraniyespor',
  rule: 'secondary',
  ruleName: 'Secundária',
  min: 88,
  period: 2,
  side: 'away',
  momentum: -51,
  goalsTally: { home: 0, away: 0 },
  cornersTally: { home: 4, away: 2 },
}

const screenshotCopy = alertNotificationCopy(screenshot)
expect(
  screenshotCopy.title === 'Golo · Golos 0-0 · Cantos 4-2',
  `goals title got "${screenshotCopy.title}"`,
)
expect(
  screenshotCopy.body === "Bandirmaspor vs Umraniyespor · 88' · Fora · v -51",
  `goals body got "${screenshotCopy.body}"`,
)
expect(
  !screenshotCopy.title.startsWith('Secundária'),
  'goals title must not start with rule priority',
)

const corner: FeedAlert = {
  ...sampleFeedAlert('corners', 'ft'),
  matchLabel: 'Bandirmaspor vs Umraniyespor',
  rule: 'primary',
  min: 84,
  period: 2,
  side: 'home',
  momentum: 72,
  goalsTally: { home: 1, away: 0 },
  cornersTally: { home: 5, away: 3 },
}

const cornerCopy = alertNotificationCopy(corner)
expect(
  cornerCopy.title === 'Canto · Golos 1-0 · Cantos 5-3',
  `corners title got "${cornerCopy.title}"`,
)
expect(
  cornerCopy.body === "Bandirmaspor vs Umraniyespor · 84' · Casa · v +72",
  `corners body got "${cornerCopy.body}"`,
)
expect(
  !Object.values(RULE_SHORT).some((label) => cornerCopy.title.startsWith(label)),
  'corners title must not start with rule priority',
)

const noTallies: FeedAlert = {
  ...sampleFeedAlert('goals'),
  goalsTally: undefined,
  cornersTally: undefined,
}
const noTalliesCopy = alertNotificationCopy(noTallies)
expect(
  noTalliesCopy.title === 'Golo · Celtic vs Ferencváros',
  `missing tallies title got "${noTalliesCopy.title}"`,
)
expect(
  noTalliesCopy.body === "38' · Fora · v -61",
  `missing tallies body got "${noTalliesCopy.body}"`,
)

expect(marketCopy('goals').pushPrefix === 'Golo', 'goals pushPrefix must be Golo')
expect(marketCopy('corners').pushPrefix === 'Canto', 'corners pushPrefix must be Canto')

if (fail.length) {
  console.error('FAIL')
  for (const line of fail) console.error(`- ${line}`)
  process.exit(1)
}

console.log('ok')
console.log(`goals:  ${screenshotCopy.title}`)
console.log(`        ${screenshotCopy.body}`)
console.log(`corners: ${cornerCopy.title}`)
console.log(`         ${cornerCopy.body}`)
