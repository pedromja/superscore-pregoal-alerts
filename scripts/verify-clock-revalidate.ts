/**
 * Clock revalidation: SokkerPro timeline parse, SuperScore vs SokkerPro
 * lead recompute, published-hist sensitivity, prospective score log.
 * Must not touch locked windows / thresholds.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  leadOfAlert,
  pairEventClocks,
  recommendClockFix,
  revalidateBucket,
  shiftEventsEarlier,
  shiftPublishedLeadHist,
} from '../src/lib/clockRevalidate.ts'
import {
  alertClockProbe,
  goalTransitionOf,
} from '../src/lib/clockProbe.ts'
import { DEFINITIONS_LOCKED } from '../src/lib/lock.ts'
import { defaultsFor, GOAL_HT_THRESHOLDS } from '../src/lib/market.ts'
import { GOAL_WINDOWS } from '../src/lib/windows.ts'
import { evaluateAlerts, extractMarketEvents } from '../src/lib/rules.ts'
import {
  classifySokkerTimelineKind,
  hasSokkerEventTimeline,
  parseSokkerFixtureDetail,
  sokkerClockOf,
  sokkerEventsAsGoals,
  SOKKER_TYPE_CORNER,
  SOKKER_TYPE_GOAL,
  SOKKER_TYPE_PENALTY,
} from '../src/lib/sokkerTimeline.ts'
import type { GoalEvent, MomentumPayload } from '../src/lib/types.ts'
import {
  observeSokkerClock,
  probeForAlert,
  resetSokkerClockLogForTests,
  loadSokkerClockLog,
} from '../server/sokkerClockLog.ts'
import { toLoggedAlert } from '../server/learn.ts'
import { sampleFeedAlert } from '../src/lib/tally.ts'

const fail: string[] = []
function check(cond: boolean, msg: string) {
  if (!cond) fail.push(msg)
}

const here = dirname(fileURLToPath(import.meta.url))
const sample = parseSokkerFixtureDetail(
  JSON.parse(readFileSync(join(here, 'fixtures/sokkerpro-timeline-sample.json'), 'utf8')),
)
check(sample !== null, 'sample detail parses')
check(hasSokkerEventTimeline(sample), 'sample has event timeline')
check(sample?.localTeamId === '111', 'local team id')
check(
  classifySokkerTimelineKind(SOKKER_TYPE_GOAL, '1st Goal') === 'goal',
  'type 14 is goal (SokkerPro, not SuperScore corner)',
)
check(classifySokkerTimelineKind(SOKKER_TYPE_PENALTY, '1st Penalty') === 'goal', 'penalty is goal')
check(classifySokkerTimelineKind(SOKKER_TYPE_CORNER, '1st Corner') === 'corner', 'type 126 is corner')
check(classifySokkerTimelineKind(18, '1st Substitution') === 'other', 'sub is other')

const htStop = sokkerClockOf({ minute: 45, extraMinute: 1, minuteTotal: 46 })
check(htStop?.period === 1 && htStop.min === 46, `HT stoppage clock ${JSON.stringify(htStop)}`)
const ft = sokkerClockOf({ minute: 74, extraMinute: null, minuteTotal: 74 })
check(ft?.period === 2 && ft.min === 74, 'FT absolute clock')
const ftStop = sokkerClockOf({ minute: 90, extraMinute: 1, minuteTotal: 91 })
check(ftStop?.period === 2 && ftStop.min === 91, 'FT stoppage')

const goals = sokkerEventsAsGoals(sample!, 'goal', false)
check(goals.length === 7, `7 scoring events (6 goals + 1 penalty), got ${goals.length}`)
check(goals[0].side === 'away' && goals[0].min === 6, 'first goal away 6')
const pen = goals.find((g) => g.min === 33)
check(pen?.side === 'away', 'penalty counts as away goal')
const homeGoal = goals.find((g) => g.min === 80)
check(homeGoal?.side === 'home', '80′ home')
const swapped = sokkerEventsAsGoals(sample!, 'goal', true)
check(swapped[0].side === 'home', 'swapped flips first goal to home')
const corners = sokkerEventsAsGoals(sample!, 'corner', false)
check(corners.length === 2 && corners[1].min === 83, 'two corners, 83′ home-side')

const demo = JSON.parse(
  readFileSync(join(here, '../public/demo/drava-bistrica-momentum.json'), 'utf8'),
) as MomentumPayload
const settings = defaultsFor('goals', 'ht')
const { points, alerts: fired } = evaluateAlerts(demo, settings)
const ssHt = extractMarketEvents(demo, points, 'goals', 'ht')
check(ssHt.length >= 1, 'demo has HT window goals')
check(fired.length >= 1, 'demo fires HT alerts')

const lateSp: GoalEvent[] = ssHt.map((e) => ({ ...e, min: e.min - 2 }))
const alert = fired.find((a) => a.period === 1 && a.min >= 20 && a.min <= 42) ?? fired[0]
const oldLead = leadOfAlert(alert, ssHt, points, 'goals', 'ht')
const newLead = leadOfAlert(alert, lateSp, points, 'goals', 'ht')
check(oldLead.usable || oldLead.coincident || oldLead.lead !== undefined, 'old lead computed')
if (oldLead.usable && oldLead.lead !== null && oldLead.lead <= 2) {
  check(
    !newLead.usable || (newLead.lead !== null && newLead.lead <= oldLead.lead),
    `shifted SP clock must not inflate lead (old ${oldLead.lead} new ${newLead.lead})`,
  )
}

const compare = revalidateBucket(
  [{ payload: demo, sokkerEvents: sokkerEventsAsGoals(sample!, 'goal', false) }],
  'goals',
  'ht',
)
check(compare.old.alerts === compare.neu.alerts, 'same SuperScore alerts on both clocks')
check(compare.market === 'goals' && compare.half === 'ht', 'bucket identity')
check(DEFINITIONS_LOCKED === true, 'lock stays on')
check(GOAL_WINDOWS.ht.from === 20 && GOAL_WINDOWS.ht.to === 42, 'HT window untouched')
check(GOAL_WINDOWS.ft.from === 70 && GOAL_WINDOWS.ft.to === 90, 'FT window untouched')
check(GOAL_HT_THRESHOLDS.spikeThreshold === 80, 'locked spike untouched')

const pairing = pairEventClocks(
  [
    { min: 36, period: 1, side: 'home', index: 1 },
    { min: 41, period: 1, side: 'home', index: 2 },
    { min: 74, period: 2, side: 'away', index: 3 },
  ],
  [
    { min: 34, period: 1, side: 'home', index: 1 },
    { min: 40, period: 1, side: 'home', index: 2 },
    { min: 74, period: 2, side: 'away', index: 3 },
  ],
)
check(pairing.medianOffset === 1, `median offset 1, got ${pairing.medianOffset}`)
check(pairing.paired[0].offset === 2, 'first pair SS 36 vs SP 34')
check(pairing.lateShare !== null && pairing.lateShare > 0.6, 'most pairs SS later by ≥1')

const hist = { '1': 383, '2': 67, '3': 45, '4': 55 }
const alerts = 2177
const d1 = shiftPublishedLeadHist(hist, 1, alerts)
check(d1.collapsed === 383, `D=1 drops lead=1 (${d1.collapsed})`)
check(d1.newHits === 67 + 45 + 55, `D=1 remaining hits ${d1.newHits}`)
check(d1.oldPreferred === 383 + 67, 'preferred 1–2')
check(d1.newPreferred === 67 + 45, 'after D=1 preferred is old 2–3')
check(
  Math.abs((d1.newPrecision ?? 0) - d1.newHits / alerts) < 1e-9,
  'precision uses full alert denominator',
)

const published = JSON.parse(
  readFileSync(join(here, '../backtest-data/backtest-results.json'), 'utf8'),
) as {
  results: Record<string, { best: { metrics: { alerts: number; leadHist: Record<string, number> } } }>
}
const gh = published.results.goals_ht.best.metrics
const pub = shiftPublishedLeadHist(gh.leadHist, 1, gh.alerts)
check(pub.collapsed === 383, 'published HT hist lead=1 is 383')
check(pub.oldHits === 768, `published HT hits ${pub.oldHits}`)

const shifted = shiftEventsEarlier(
  [{ min: 36, period: 1, side: 'home', index: 0 }],
  2,
)
check(shifted[0].min === 34, 'shiftEventsEarlier')

const recKeep = recommendClockFix({
  matchedMatches: 0,
  medianOffset: null,
  collapsedShare: null,
  precisionDelta: null,
  cornersLiveClock: 'none',
  prospectiveReady: true,
})
check(recKeep.lockedUntouched === true, 'recommend never unlocks')
check(recKeep.action === 'keep', 'no sample → keep')

const recTight = recommendClockFix({
  matchedMatches: 80,
  medianOffset: 2,
  collapsedShare: 0.4,
  precisionDelta: -0.15,
  cornersLiveClock: 'none',
  prospectiveReady: true,
})
check(recTight.action === 'tighten-notify-suppress', `big bias → tighten, got ${recTight.action}`)
check(/não/i.test(recTight.headlinePt), 'PT says do not silently change defs')

resetSokkerClockLogForTests()
const t1 = observeSokkerClock({
  fixture: { id: 'fix-1', team1: 'A', team2: 'B' },
  fast: {
    home: 0,
    away: 0,
    minute: 33,
    status: '1st',
    source: 'sokkerpro',
  },
})
check(t1.transition === null, 'first snap no transition')
const t2 = observeSokkerClock({
  fixture: { id: 'fix-1', team1: 'A', team2: 'B' },
  fast: {
    home: 0,
    away: 1,
    minute: 34,
    status: '1st',
    isGoal: '123',
    isGoalTeam: 'away',
    source: 'sokkerpro',
  },
})
check(t2.transition?.kind === 'goal', 'score 0-0 → 0-1 is goal')
check(t2.transition?.side === 'away', 'transition away')
check(t2.transition?.sokkerMinute === 34, 'transition minute 34')
check(loadSokkerClockLog().length === 2, 'log has 2 rows')

const trans = goalTransitionOf({ home: 1, away: 0 }, { home: 1, away: 1 }, { sokkerMinute: 70 })
check(trans?.side === 'away', 'delta away')
check(goalTransitionOf({ home: 1, away: 0 }, { home: 1, away: 0 }, { sokkerMinute: 70 }) === null, 'no score change')

const probe = alertClockProbe({
  fast: t2.fast,
  ssGoals: 0,
  ssCorners: 0,
  market: 'goals',
})
check(probe.matched === true && probe.source === 'sokkerpro', 'probe matched')
check(probe.ssGoals === 0, 'ss tally at fire')

const feed = {
  ...sampleFeedAlert('goals', 'ht'),
  fixtureId: 'fix-1',
  matchLabel: 'A vs B',
  firedAt: '2026-09-19T12:00:00.000Z',
  coincident: false,
  market: 'goals' as const,
  fastScore: t2.fast,
  clockProbe: probeForAlert(
    { market: 'goals', goalsTally: { home: 0, away: 0 }, cornersTally: { home: 0, away: 0 }, firedAt: '2026-09-19T12:00:00.000Z' },
    t2.fast,
    'goals',
  ),
}
const logged = toLoggedAlert(feed, settings, false)
check(logged.fastScore?.away === 1, 'logged alert keeps fastScore')
check(logged.clockProbe?.matched === true, 'logged alert keeps clockProbe')
check(logged.hit5 === null, 'ingest does not pre-label vs SokkerPro')

check(GOAL_HT_THRESHOLDS.sustainedComboMinutes === 3, 'locked sust minutes')

if (fail.length) {
  console.error(fail.map((m) => `FAIL ${m}`).join('\n'))
  process.exit(1)
}
console.log(
  'OK: SokkerPro timeline clock, lead recompute, published-hist sensitivity, prospective log; locked defs untouched',
)
