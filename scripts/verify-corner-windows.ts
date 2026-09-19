import { readFileSync } from 'node:fs'
import { defaultsFor } from '../src/lib/market.ts'
import { evaluateAlerts, extractCorners, extractGoals } from '../src/lib/rules.ts'
import type { MomentumPayload } from '../src/lib/types.ts'
import {
  CORNER_WINDOWS,
  GOAL_WINDOWS,
  REGULATION_END,
  cornerHalfOf,
  goalHalfOf,
  inCornerWindow,
  inGoalsWindow,
  inMarketClockWindow,
  isStoppageClock,
} from '../src/lib/windows.ts'

const celtic = JSON.parse(
  readFileSync('public/demo/celtic-ferenc-momentum.json', 'utf8'),
) as MomentumPayload
const drava = JSON.parse(
  readFileSync('public/demo/drava-bistrica-momentum.json', 'utf8'),
) as MomentumPayload

const goalsHt = defaultsFor('goals', 'ht')
const goalsFt = defaultsFor('goals', 'ft')
const goals = goalsHt
const goalsBundle = { ht: goalsHt, ft: goalsFt }
const ht = defaultsFor('corners', 'ht')
const ft = defaultsFor('corners', 'ft')
const bundle = { ht, ft }

const fails: string[] = []

function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

function spikeAt(min: number, period: number): MomentumPayload {
  const prev = Math.max(0, min - 1)
  return {
    timeline: [
      { min: prev, period, value: { value: 0 } },
      { min, period, value: { value: 95 } },
    ],
    events: [],
  }
}

function checkDemo(name: string, payload: MomentumPayload) {
  const goalEval = evaluateAlerts(payload, goals, undefined, goalsBundle)
  const cornerEval = evaluateAlerts(payload, ht, undefined, bundle)
  const outsideCorners = cornerEval.alerts.filter(
    (a) => cornerHalfOf(a.min, a.period) === null,
  )
  const outsideGoals = goalEval.alerts.filter(
    (a) => goalHalfOf(a.min, a.period) === null,
  )
  const htAlerts = cornerEval.alerts.filter((a) => a.cornerHalf === 'ht')
  const ftAlerts = cornerEval.alerts.filter((a) => a.cornerHalf === 'ft')
  const htOnly = evaluateAlerts(payload, ht)
  const ftOnly = evaluateAlerts(payload, ft)
  const allCorners = payload.events.filter((e) => e.type === 14)
  const windowCorners = extractCorners(payload, cornerEval.points)
  const goalsN = extractGoals(payload, goalEval.points).length

  const mixed = evaluateAlerts(payload, ht).alerts.some(
    (a) => a.cornerHalf === 'ft',
  )

  console.log(`\n== ${name} ==`)
  console.log(`goals alerts: ${goalEval.alerts.length} (events ${goalsN})`)
  console.log(
    `corners alerts: ${cornerEval.alerts.length} (HT ${htAlerts.length} / FT ${ftAlerts.length})`,
  )
  console.log(
    `corners events: ${allCorners.length} total / ${windowCorners.length} in windows`,
  )
  console.log(`outside-window corner alerts: ${outsideCorners.length}`)
  console.log(`outside-window goal alerts: ${outsideGoals.length}`)
  console.log(`HT-only eval alerts: ${htOnly.alerts.length} (should all be HT)`)
  console.log(`FT-only eval alerts: ${ftOnly.alerts.length} (should all be FT)`)
  console.log(`HT settings leaked FT half: ${mixed}`)

  expect(outsideCorners.length === 0, `${name}: corner alerts outside windows`)
  expect(outsideGoals.length === 0, `${name}: goal alerts outside windows`)
  expect(
    !goalEval.alerts.some((a) => a.period === 2 && a.min > 90),
    `${name}: goal alert in FT stoppage`,
  )
  expect(
    !goalEval.alerts.some((a) => a.period === 1 && a.min > 45),
    `${name}: goal alert in HT stoppage`,
  )
  expect(
    !htOnly.alerts.some((a) => a.cornerHalf !== 'ht'),
    `${name}: HT eval mixed`,
  )
  expect(
    !ftOnly.alerts.some((a) => a.cornerHalf !== 'ft'),
    `${name}: FT eval mixed`,
  )
  expect(
    windowCorners.length ===
      allCorners.filter((e) => cornerHalfOf(e.min, e.period)).length,
    `${name}: extractCorners window filter mismatch`,
  )
}

checkDemo('celtic', celtic)
checkDemo('drava', drava)

const cornerMinuteProbe: Array<{
  min: number
  period: number
  expect: 'ht' | 'ft' | null
}> = [
  { min: 20, period: 1, expect: null },
  { min: 31, period: 1, expect: null },
  { min: 32, period: 1, expect: 'ht' },
  { min: 42, period: 1, expect: 'ht' },
  { min: 43, period: 1, expect: null },
  { min: 45, period: 1, expect: null },
  { min: 46, period: 1, expect: null },
  { min: 46, period: 2, expect: null },
  { min: 81, period: 2, expect: null },
  { min: 82, period: 2, expect: 'ft' },
  { min: 86, period: 2, expect: 'ft' },
  { min: 87, period: 2, expect: 'ft' },
  { min: 88, period: 2, expect: null },
  { min: 90, period: 2, expect: null },
  { min: 91, period: 2, expect: null },
  { min: 96, period: 2, expect: null },
]
for (const row of cornerMinuteProbe) {
  const got = cornerHalfOf(row.min, row.period)
  expect(
    got === row.expect,
    `corner half ${row.period}/${row.min} got ${got} expected ${row.expect}`,
  )
}

const goalMinuteProbe: Array<{
  min: number
  period: number
  expect: 'ht' | 'ft' | null
}> = [
  { min: 19, period: 1, expect: null },
  { min: 20, period: 1, expect: 'ht' },
  { min: 42, period: 1, expect: 'ht' },
  { min: 43, period: 1, expect: null },
  { min: 45, period: 1, expect: null },
  { min: 46, period: 1, expect: null },
  { min: 69, period: 2, expect: null },
  { min: 70, period: 2, expect: 'ft' },
  { min: 88, period: 2, expect: 'ft' },
  { min: 90, period: 2, expect: 'ft' },
  { min: 91, period: 2, expect: null },
  { min: 96, period: 2, expect: null },
]
for (const row of goalMinuteProbe) {
  const got = goalHalfOf(row.min, row.period)
  expect(
    got === row.expect,
    `goal half ${row.period}/${row.min} got ${got} expected ${row.expect}`,
  )
}

expect(isStoppageClock(96, 2), '96\' P2 is stoppage')
expect(isStoppageClock(46, 1), '46\' P1 is stoppage')
expect(!isStoppageClock(45, 1), '45\' P1 is not stoppage')
expect(!isStoppageClock(90, 2), '90\' P2 is not stoppage')
expect(isStoppageClock(91, 2), '91\' P2 is stoppage')
expect(!inGoalsWindow(96, 2), '96\' goals window rejected')
expect(!inCornerWindow(96, 2), '96\' corners window rejected')
expect(!inMarketClockWindow('goals', 96, 2), '96\' goals clock rejected')
expect(!inMarketClockWindow('corners', 96, 2), '96\' corners clock rejected')
expect(inGoalsWindow(88, 2), '88\' goals in 70–90')
expect(inGoalsWindow(42, 1), '42\' HT goals ok')
expect(!inGoalsWindow(43, 1), '43\' HT goals out')
expect(inCornerWindow(86, 2), '86\' corners ok')
expect(!inCornerWindow(96, 2), '96\' corners out')

expect(
  evaluateAlerts(spikeAt(96, 2), goalsFt).alerts.length === 0,
  'evaluate 96\' goals rejected',
)
expect(
  evaluateAlerts(spikeAt(96, 2), goals, undefined, goalsBundle).alerts.length === 0,
  'evaluate 96\' goals bundle rejected',
)
expect(
  evaluateAlerts(spikeAt(88, 2), goalsFt).alerts.length > 0,
  'evaluate 88\' goals ok (70–90)',
)
expect(
  evaluateAlerts(spikeAt(42, 1), goalsHt).alerts.length > 0,
  'evaluate 42\' HT goals ok',
)
expect(
  evaluateAlerts(spikeAt(43, 1), goalsHt).alerts.length === 0,
  'evaluate 43\' HT goals out',
)
expect(
  evaluateAlerts(spikeAt(86, 2), ft).alerts.length > 0,
  'evaluate 86\' corners ok',
)
expect(
  evaluateAlerts(spikeAt(96, 2), ft).alerts.length === 0,
  'evaluate 96\' corners out',
)
expect(
  evaluateAlerts(spikeAt(96, 2), ht, undefined, bundle).alerts.length === 0,
  'evaluate 96\' corners bundle out',
)
expect(
  evaluateAlerts(spikeAt(91, 2), goalsFt).alerts.length === 0,
  'evaluate 91\' goals rejected (FT does not extend past 90)',
)
expect(
  evaluateAlerts(spikeAt(91, 2), ft).alerts.length === 0,
  'evaluate 91\' corners rejected (P2>90 hard-ban)',
)
expect(
  evaluateAlerts(spikeAt(46, 1), goalsHt).alerts.length === 0,
  'evaluate 46\' HT goals rejected (P1>45 hard-ban)',
)
expect(
  evaluateAlerts(spikeAt(46, 1), ht).alerts.length === 0,
  'evaluate 46\' HT corners rejected (P1>45 hard-ban)',
)
expect(
  evaluateAlerts(spikeAt(90, 2), goalsFt).alerts.length > 0,
  'evaluate 90\' goals ok (FT window includes 90, not past it)',
)

if (GOAL_WINDOWS.ft.to !== REGULATION_END[2] || GOAL_WINDOWS.ft.to > 90) {
  fails.push('Goals FT window must be 70–90 and must not extend past 90')
}
if (GOAL_WINDOWS.ht.to > REGULATION_END[1]) {
  fails.push('Goals HT window must not extend into P1 stoppage')
}

if (CORNER_WINDOWS.ht.from !== 32 || CORNER_WINDOWS.ht.to !== 42) {
  fails.push('HT corner window bounds changed')
}
if (CORNER_WINDOWS.ft.from !== 82 || CORNER_WINDOWS.ft.to !== 87) {
  fails.push('FT corner window bounds changed')
}
if (GOAL_WINDOWS.ht.from !== 20 || GOAL_WINDOWS.ht.to !== 42) {
  fails.push('HT goal window bounds changed')
}
if (GOAL_WINDOWS.ft.from !== 70 || GOAL_WINDOWS.ft.to !== 90) {
  fails.push('FT goal window bounds changed')
}
if (
  ht.primaryKind !== 'sustained' ||
  ht.evaluationWindow !== 5 ||
  ht.spikeThreshold !== 60 ||
  ht.swingComboThreshold !== 40 ||
  ht.sustainedThreshold !== 25 ||
  ht.sustainedSecondaryThreshold !== 20 ||
  ht.sustainedSecondaryMinutes !== 2 ||
  ht.fallbackSustainedThreshold !== 30 ||
  ht.sustainedFallbackMinutes !== 4
) {
  fails.push('HT thresholds changed')
}
if (
  ft.primaryKind !== 'combo' ||
  ft.fallbackKind !== 'spike' ||
  ft.evaluationWindow !== 3 ||
  ft.spikeThreshold !== 80 ||
  ft.swingComboThreshold !== 50 ||
  ft.sustainedThreshold !== 30 ||
  ft.sustainedSecondaryThreshold !== 20 ||
  ft.sustainedSecondaryMinutes !== 2 ||
  ft.fallbackSpikeThreshold !== 85
) {
  fails.push('FT thresholds changed')
}
if (
  goals.spikeThreshold !== 80 ||
  goals.primaryKind !== 'combo' ||
  goals.sustainedFallbackMinutes !== 5 ||
  defaultsFor('goals', 'ft').sustainedFallbackMinutes !== 5
) {
  fails.push('goal defaults changed')
}

if (fails.length) {
  console.error('\nFAIL', fails)
  process.exit(1)
}
console.log('\nOK: window gating, HT/FT isolation, goal 20–42/70–90, stoppage ban')
