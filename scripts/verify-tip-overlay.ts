import { defaultsFor } from '../src/lib/market.ts'
import { oddPassesOverlay, DEFAULT_TIP_OVERLAY, normalizeTipOverlay } from '../src/lib/tipOverlay.ts'
import { applyProposal, recalculate } from '../server/learn.ts'
import { applyTipOverlay } from '../server/tips.ts'

const fail: string[] = []

const overlay = DEFAULT_TIP_OVERLAY
if (overlay.requireOdd !== true) fail.push('requireOdd default')
if (overlay.minOdd !== null || overlay.maxOdd !== null) fail.push('global min/max must stay null')
for (const key of ['goals_ht', 'goals_ft', 'corners_ht', 'corners_ft'] as const) {
  const row = overlay.buckets[key]
  if (!row.enable) fail.push(`${key} should start enabled`)
  if (row.minOdd !== null || row.maxOdd !== null) fail.push(`${key} min/max must stay null`)
}

const noOdd = oddPassesOverlay(overlay, 'goals_ht', null)
if (noOdd.ok) fail.push('requireOdd must block missing odd')

const withOdd = oddPassesOverlay(overlay, 'goals_ft', 1.85)
if (!withOdd.ok) fail.push('valid odd should pass when min/max are null')

const disabled = normalizeTipOverlay({
  ...overlay,
  buckets: { ...overlay.buckets, corners_ht: { enable: false, minOdd: null, maxOdd: null } },
})
const blockedBucket = oddPassesOverlay(disabled, 'corners_ht', 1.9)
if (blockedBucket.ok || !blockedBucket.permanent) fail.push('disabled bucket must skip permanently')

const ranged = normalizeTipOverlay({
  requireOdd: true,
  minOdd: 1.5,
  maxOdd: 2.2,
  buckets: overlay.buckets,
})
if (oddPassesOverlay(ranged, 'goals_ht', 1.4).ok) fail.push('global minOdd should reject 1.4')
if (!oddPassesOverlay(ranged, 'goals_ht', 1.8).ok) fail.push('1.8 should pass global range')
if (oddPassesOverlay(ranged, 'goals_ht', 2.5).ok) fail.push('global maxOdd should reject 2.5')

const bucketRange = normalizeTipOverlay({
  requireOdd: true,
  minOdd: 1.2,
  maxOdd: 3,
  buckets: {
    ...overlay.buckets,
    corners_ft: { enable: true, minOdd: 1.7, maxOdd: 2.0 },
  },
})
if (oddPassesOverlay(bucketRange, 'corners_ft', 1.5).ok) fail.push('bucket minOdd overrides global')
if (!oddPassesOverlay(bucketRange, 'corners_ft', 1.85).ok) fail.push('bucket range should accept 1.85')
if (oddPassesOverlay(bucketRange, 'goals_ht', 1.5).ok === false) fail.push('goals_ht should still use global 1.2–3')

const goals = defaultsFor('goals')
const ht = defaultsFor('corners', 'ht')
const ft = defaultsFor('corners', 'ft')
if (goals.spikeThreshold !== 80 || goals.swingComboThreshold !== 50 || goals.sustainedComboMinutes !== 3) {
  fail.push('goal Spike/Swing/Sustained defaults changed')
}
if (ht.primaryKind !== 'sustained' || ht.evaluationWindow !== 5 || ht.spikeThreshold !== 60) {
  fail.push('HT corner defaults changed')
}
if (ft.primaryKind !== 'combo' || ft.fallbackKind !== 'spike' || ft.evaluationWindow !== 3 || ft.fallbackSpikeThreshold !== 85) {
  fail.push('FT corner defaults changed')
}

let threw = false
try {
  applyProposal('latest', 'manual', 'goals', undefined, {})
} catch (err) {
  threw = err instanceof Error && /confirmação explícita/i.test(err.message)
}
if (!threw) fail.push('applyProposal must require confirm:true')

let autoThrew = false
try {
  applyProposal('latest', 'auto', 'goals', undefined, { confirm: true })
} catch (err) {
  autoThrew = err instanceof Error && /Auto-aplicar está desligado/i.test(err.message)
}
if (!autoThrew) fail.push('applyProposal(reason=auto) must stay disabled')

let overlayThrew = false
try {
  applyTipOverlay({ overlay: DEFAULT_TIP_OVERLAY })
} catch (err) {
  overlayThrew = err instanceof Error && /confirmação explícita/i.test(err.message)
}
if (!overlayThrew) fail.push('applyTipOverlay must require confirm:true')

const recalc = recalculate('test-overlay-guard', 'goals')
if (recalc.applied) fail.push('recalculate must not silent-apply')

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log('OK: tip overlay store, requireOdd, null min/max, bucket gates, learning confirm-only, base rules untouched')
