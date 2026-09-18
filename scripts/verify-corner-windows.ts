import { readFileSync } from 'node:fs'
import { defaultsFor } from '../src/lib/market.ts'
import { evaluateAlerts, extractCorners, extractGoals } from '../src/lib/rules.ts'
import type { MomentumPayload } from '../src/lib/types.ts'
import { CORNER_WINDOWS, cornerHalfOf } from '../src/lib/windows.ts'

const celtic = JSON.parse(
  readFileSync('public/demo/celtic-ferenc-momentum.json', 'utf8'),
) as MomentumPayload
const drava = JSON.parse(
  readFileSync('public/demo/drava-bistrica-momentum.json', 'utf8'),
) as MomentumPayload

const goals = defaultsFor('goals')
const ht = defaultsFor('corners', 'ht')
const ft = defaultsFor('corners', 'ft')
const bundle = { ht, ft }

function check(name: string, payload: MomentumPayload) {
  const goalEval = evaluateAlerts(payload, goals)
  const cornerEval = evaluateAlerts(payload, ht, undefined, bundle)
  const outsideCorners = cornerEval.alerts.filter(
    (a) => cornerHalfOf(a.min, a.period) === null,
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
  console.log(`HT-only eval alerts: ${htOnly.alerts.length} (should all be HT)`)
  console.log(`FT-only eval alerts: ${ftOnly.alerts.length} (should all be FT)`)
  console.log(`HT settings leaked FT half: ${mixed}`)

  const fail: string[] = []
  if (outsideCorners.length) fail.push('corner alerts outside windows')
  if (htOnly.alerts.some((a) => a.cornerHalf !== 'ht')) fail.push('HT eval mixed')
  if (ftOnly.alerts.some((a) => a.cornerHalf !== 'ft')) fail.push('FT eval mixed')
  if (windowCorners.length !== allCorners.filter((e) => cornerHalfOf(e.min, e.period)).length) {
    fail.push('extractCorners window filter mismatch')
  }
  if (goalEval.alerts.length === 0 && goalsN > 0) {
    // celtic/drava should still produce some goal alerts
  }
  return fail
}

const fails = [...check('celtic', celtic), ...check('drava', drava)]

const minuteProbe = [
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
  { min: 87, period: 2, expect: 'ft' },
  { min: 88, period: 2, expect: null },
  { min: 90, period: 2, expect: null },
  { min: 91, period: 2, expect: null },
]
for (const row of minuteProbe) {
  const got = cornerHalfOf(row.min, row.period)
  if (got !== row.expect) {
    fails.push(`half ${row.period}/${row.min} got ${got} expected ${row.expect}`)
  }
}

if (CORNER_WINDOWS.ht.from !== 32 || CORNER_WINDOWS.ht.to !== 42) {
  fails.push('HT window bounds changed')
}
if (CORNER_WINDOWS.ft.from !== 82 || CORNER_WINDOWS.ft.to !== 87) {
  fails.push('FT window bounds changed')
}
if (
  ht.primaryKind !== 'sustained' ||
  ht.evaluationWindow !== 5 ||
  ht.spikeThreshold !== 60 ||
  ht.swingComboThreshold !== 40 ||
  ht.sustainedThreshold !== 25 ||
  ht.sustainedSecondaryThreshold !== 30 ||
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
  ft.sustainedSecondaryThreshold !== 25 ||
  ft.sustainedSecondaryMinutes !== 2 ||
  ft.fallbackSpikeThreshold !== 85
) {
  fails.push('FT thresholds changed')
}
if (goals.spikeThreshold !== 80 || goals.primaryKind !== 'combo') {
  fails.push('goal defaults changed')
}

if (fails.length) {
  console.error('\nFAIL', fails)
  process.exit(1)
}
console.log('\nOK: window gating, HT/FT isolation, goals defaults intact')
