import { defaultsFor } from '../src/lib/market.ts'
import {
  pickAsianSnapshot,
  pickLimitSnapshot,
  pickMaisUmOdd,
  type SuperbetEvent,
} from '../src/lib/oddsMarkets.ts'
import { maisUmPriceOf, oddsLogKey } from '../src/lib/oddsObserve.ts'
import {
  ALERT_ODD_GATE_ENABLED,
  DEFAULT_TIP_OVERLAY,
  normalizeTipOverlay,
  oddPassesOverlay,
} from '../src/lib/tipOverlay.ts'
import { applyProposal, recalculate } from '../server/learn.ts'
import { applyTipOverlay } from '../server/tips.ts'

const fail: string[] = []

if (ALERT_ODD_GATE_ENABLED) fail.push('ALERT_ODD_GATE_ENABLED must be false')

const overlay = DEFAULT_TIP_OVERLAY
if (overlay.requireOdd !== false) fail.push('requireOdd default must be false (no alert gate)')
if (overlay.minOdd !== null || overlay.maxOdd !== null) fail.push('do not invent global min/max')
for (const key of ['goals_ht', 'goals_ft', 'corners_ht', 'corners_ft'] as const) {
  const row = overlay.buckets[key]
  if (!row.enable) fail.push(`${key} must stay enabled — do not apply corners OFF overlay`)
  if (row.minOdd !== null || row.maxOdd !== null) fail.push(`${key} min/max must stay null`)
}
if (overlay.buckets.goals_ht.minOdd === 3 || overlay.minOdd === 3) {
  fail.push('do not apply backtest goals minOdd≥3')
}

const noOdd = oddPassesOverlay(overlay, 'goals_ht', null)
if (!noOdd.ok) fail.push('missing odd must not fail default overlay (alerts stay ungated)')

const futureGate = normalizeTipOverlay({ ...overlay, requireOdd: true })
if (oddPassesOverlay(futureGate, 'goals_ht', null).ok) {
  fail.push('requireOdd helper should still detect missing odd for future learning proposals')
}

const event: SuperbetEvent = {
  event_id: 9,
  markets: [
    {
      name: 'Final',
      odds: [
        { price: 1.8, metadata: { name: '1' }, status: 1, display: true },
        { price: 3.4, metadata: { name: 'X' }, status: 1, display: true },
      ],
    },
    {
      name: 'Total goluri',
      odds: [
        { price: 1.8, metadata: { name: 'Sub 1.5' }, status: 1, display: true },
        { price: 1.95, metadata: { name: 'Peste 1.5' }, status: 1, display: true },
        { price: 2.1, metadata: { name: 'Sub 0.5' }, status: 1, display: true },
        { price: 1.65, metadata: { name: 'Peste 0.5' }, status: 1, display: true },
      ],
    },
    {
      name: 'Handicap asiatic',
      odds: [
        { price: 1.92, metadata: { name: '1 (-0.5)' }, status: 1, display: true },
        { price: 1.88, metadata: { name: '2 (+0.5)' }, status: 1, display: true },
      ],
    },
    {
      name: 'Prima repriză - Total cornere',
      odds: [
        { price: 1.72, metadata: { name: 'Peste 4.5' }, status: 1, display: true },
        { price: 2.02, metadata: { name: 'Sub 4.5' }, status: 1, display: true },
      ],
    },
    {
      name: 'Handicap asiatic cornere',
      odds: [
        { price: 1.8, metadata: { name: '1 (-1.5)' }, status: 1, display: true },
        { price: 2.0, metadata: { name: '2 (+1.5)' }, status: 1, display: true },
      ],
    },
  ],
}

const limit = pickLimitSnapshot(event, 'goals', 'ft', 1)
if (!limit || limit.line !== 1.5) fail.push(`limit line ${JSON.stringify(limit)}`)
const over = limit?.prices.find((p) => p.side === 'over' && p.line === 1.5)
const under = limit?.prices.find((p) => p.side === 'under' && p.line === 1.5)
if (!over || over.price !== 1.95) fail.push('limit over 1.5')
if (!under || under.price !== 1.8) fail.push('limit under 1.5')

const asian = pickAsianSnapshot(event, 'goals', 'ft')
if (!asian || asian.marketName !== 'Handicap asiatic') {
  fail.push(`asian goals ${JSON.stringify(asian)}`)
}
if (!asian?.prices.some((p) => p.side === 'home' && p.line === -0.5 && p.price === 1.92)) {
  fail.push('asian home -0.5')
}

const cornersAsian = pickAsianSnapshot(event, 'corners', 'ht')
if (!cornersAsian || !/cornere/.test(cornersAsian.marketName)) {
  fail.push(`asian corners ${JSON.stringify(cornersAsian)}`)
}

if (pickMaisUmOdd({ event_id: 2, markets: [event.markets![0]] }, 'goals', 'ft', 0)) {
  fail.push('1X2 must not become mais-um')
}

if (maisUmPriceOf({
  ts: '',
  fixtureId: 'x',
  matchLabel: '',
  league: 'Liga',
  market: 'goals',
  half: 'ht',
  bucket: 'goals_ht',
  minute: 20,
  period: 1,
  alertId: 'a',
  currentTotal: 1,
  source: 'none',
  sourceLabel: '',
  limit: null,
  asian: null,
  robobet: null,
}) !== null) {
  fail.push('missing odd observation must not invent a tip price')
}

if (oddsLogKey('goals', 'ht', 'Premier League') !== 'goals|ht|Premier League') {
  fail.push('odds log key')
}

const goals = defaultsFor('goals')
const ht = defaultsFor('corners', 'ht')
const ft = defaultsFor('corners', 'ft')
if (goals.spikeThreshold !== 80 || goals.swingComboThreshold !== 50 || goals.sustainedComboMinutes !== 3) {
  fail.push('goal Spike/Swing/Sustained defaults changed')
}
if (ht.primaryKind !== 'sustained' || ht.evaluationWindow !== 5 || ht.spikeThreshold !== 60) {
  fail.push('HT corner defaults changed')
}
if (ft.primaryKind !== 'combo' || ft.fallbackKind !== 'spike' || ft.evaluationWindow !== 3) {
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
console.log('OK: alerts ungated, odds observed (limit+asian), no backtest overlay, learning confirm-only')
