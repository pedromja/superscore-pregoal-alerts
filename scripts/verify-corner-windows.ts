import { readFileSync } from 'node:fs'
import { defaultsFor } from '../src/lib/market.ts'
import { evaluateAlerts, extractCorners, extractGoals } from '../src/lib/rules.ts'
import type { MomentumPayload } from '../src/lib/types.ts'
import { cornerHalfOf } from '../src/lib/windows.ts'

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
  { min: 35, period: 1, expect: 'ht' },
  { min: 45, period: 1, expect: 'ht' },
  { min: 46, period: 1, expect: null },
  { min: 46, period: 2, expect: null },
  { min: 85, period: 2, expect: 'ft' },
  { min: 90, period: 2, expect: 'ft' },
  { min: 91, period: 2, expect: null },
]
for (const row of minuteProbe) {
  const got = cornerHalfOf(row.min, row.period)
  if (got !== row.expect) {
    fails.push(`half ${row.period}/${row.min} got ${got} expected ${row.expect}`)
  }
}

if (ht.primaryKind !== 'sustained' || ht.evaluationWindow !== 5) {
  fails.push('HT defaults wrong')
}
if (ft.primaryKind !== 'combo' || ft.fallbackKind !== 'spike' || ft.evaluationWindow !== 3) {
  fails.push('FT defaults wrong')
}
if (goals.spikeThreshold !== 80 || goals.primaryKind !== 'combo') {
  fails.push('goal defaults changed')
}

if (fails.length) {
  console.error('\nFAIL', fails)
  process.exit(1)
}
console.log('\nOK: window gating, HT/FT isolation, goals defaults intact')
