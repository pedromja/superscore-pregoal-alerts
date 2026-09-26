/**
 * Live notify min-lead: never Telegram/push without an actionable clock lead.
 * Evaluate/learning still records the raw alert.
 */
import { defaultsFor } from '../src/lib/market.ts'
import {
  MIN_NOTIFY_LEAD_MIN,
  notifySuppressReason,
  parseMinNotifyLeadMin,
} from '../src/lib/notifyLead.ts'
import { sampleFeedAlert } from '../src/lib/tally.ts'
import type { FeedAlert, Fixture, GoalEvent, Market } from '../src/lib/types.ts'
import {
  CORNER_WINDOWS,
  GOAL_WINDOWS,
  REGULATION_END,
  inMarketClockWindow,
} from '../src/lib/windows.ts'
import { MIN_LEAD_MIN } from '../src/lib/horizons.ts'
import { DEFINITIONS_LOCKED } from '../src/lib/lock.ts'
import {
  processEvaluatedAlerts,
  resetPollerRuntimeForTests,
  setPollerSendTelegramForTests,
} from '../server/poller.ts'
import { loadAlerts, loadSent, saveAlerts, saveSent } from '../server/store.ts'

// Base delivery pipeline with sample alerts the quality overlay would filter;
// the overlay has its own test (verify-quality-overlay). Read live per call.
process.env.QUALITY_OVERLAY = 'off'

const fails: string[] = []

function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

function liveFixture(id: string, market: Market = 'goals'): Fixture {
  return {
    id,
    team1: 'Chungnam Asan',
    team2: 'Cheonan City',
    team1Id: `${id}-h`,
    team2Id: `${id}-a`,
    competition: 'K League 2',
    category: 'test',
    status: 1,
    state: 1,
    dateSeconds: 0,
    liveElapsedSeconds: market === 'corners' ? 38 * 60 : 35 * 60,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: false,
  }
}

function alertAt(
  fixtureId: string,
  opts: {
    market?: Market
    min: number
    period: number
    index: number
    side?: FeedAlert['side']
    coincident?: boolean
    half?: 'ht' | 'ft'
  },
): FeedAlert {
  const market = opts.market ?? 'goals'
  const half = opts.half ?? (opts.period === 2 ? 'ft' : 'ht')
  return {
    ...sampleFeedAlert(market, half),
    id: `primary-${opts.period}-${opts.min}-${opts.index}`,
    fixtureId,
    matchLabel: 'Chungnam Asan vs Cheonan City',
    min: opts.min,
    period: opts.period,
    index: opts.index,
    side: opts.side ?? 'home',
    coincident: opts.coincident ?? false,
    market,
    cornerHalf: market === 'corners' ? half : undefined,
    firedAt: new Date().toISOString(),
    rule: 'primary',
    ruleName: 'Spike80',
    momentum: 80,
  }
}

function goal(
  min: number,
  period: number,
  index: number,
  side: GoalEvent['side'] = 'home',
): GoalEvent {
  return { min, period, index, side }
}

const previousSent = loadSent()
const previousGoals = loadAlerts('goals')
const previousCornersHt = loadAlerts('corners', 'ht')
const previousCornersFt = loadAlerts('corners', 'ft')

const suppressLogs: string[] = []
const origInfo = console.info
console.info = (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  const match = line.match(
    /suppress (coincident-same-min|lead-lt-1|goal-at-clock)/,
  )
  if (match) suppressLogs.push(match[1]!)
  origInfo.apply(console, args)
}

expect(MIN_NOTIFY_LEAD_MIN === 1, 'MIN_NOTIFY_LEAD_MIN default is 1')
expect(MIN_NOTIFY_LEAD_MIN === MIN_LEAD_MIN, 'notify floor matches locked backtest')
expect(parseMinNotifyLeadMin(undefined) === 1, 'unset env → 1')
expect(parseMinNotifyLeadMin('') === 1, 'empty env → 1')
expect(parseMinNotifyLeadMin('2') === 2, 'env override 2')
expect(parseMinNotifyLeadMin('0') === 0, 'env 0 allowed')
expect(parseMinNotifyLeadMin('nope') === 1, 'invalid env → 1')
expect(parseMinNotifyLeadMin('-3') === 1, 'negative env → 1')

const spike = {
  min: 35,
  period: 1,
  index: 10,
  side: 'home' as const,
}

expect(
  notifySuppressReason({ ...spike, coincident: true }, [
    goal(35, 1, 10),
  ]) === 'coincident-same-min',
  'same-index coincident → coincident-same-min',
)
expect(
  notifySuppressReason(spike, [goal(35, 1, 12)]) === 'coincident-same-min',
  'same-minute different index → coincident-same-min',
)
expect(
  notifySuppressReason(spike, [goal(35, 1, 10)]) === 'coincident-same-min',
  'same-minute same index (no flag) → coincident-same-min',
)
expect(
  notifySuppressReason(spike, [goal(35.4, 1, 14)]) === 'lead-lt-1',
  'clock lead 0.4 → lead-lt-1',
)
expect(
  notifySuppressReason(
    { min: 34, period: 1, index: 10, side: 'home' },
    [goal(35, 1, 10)],
  ) === 'lead-lt-1',
  'index lead 0 → lead-lt-1',
)
expect(
  notifySuppressReason(
    { min: 34, period: 1, index: 8, side: 'home' },
    [goal(35, 1, 12)],
    { min: 35, period: 1 },
  ) === 'goal-at-clock',
  'goal already at current clock minute → goal-at-clock',
)
expect(
  notifySuppressReason(spike, [goal(36, 1, 14)], { min: 35, period: 1 }) ===
    null,
  'lead ≥1 and no goal at clock → notify',
)
expect(
  notifySuppressReason(spike, [goal(34, 1, 8)], { min: 35, period: 1 }) ===
    null,
  'earlier goal does not suppress a later spike',
)
expect(
  notifySuppressReason(
    { min: 34, period: 1, index: 8, side: 'home' },
    [goal(35, 1, 12, 'away')],
    { min: 35, period: 1 },
  ) === null,
  'other-side goal at clock does not goal-at-clock suppress',
)
expect(
  notifySuppressReason(
    { min: 38, period: 1, index: 4, side: 'away' },
    [goal(38, 1, 7, 'home')],
  ) === 'coincident-same-min',
  'same-minute any side is coincident for notify',
)
expect(
  notifySuppressReason(
    spike,
    [goal(36, 1, 14)],
    { min: 35, period: 1 },
    2,
  ) === 'lead-lt-1',
  'env minLead 2 treats clock lead 1 as lead-lt-1',
)

resetPollerRuntimeForTests()
let telegramCalls = 0
setPollerSendTelegramForTests(async () => {
  telegramCalls += 1
  return { sent: 1, skipped: false }
})

async function runTick(args: {
  id: string
  market?: Market
  alert: FeedAlert
  events: GoalEvent[]
  clockMin: number
  clockPeriod: number
  first?: boolean
}): Promise<number> {
  const market = args.market ?? 'goals'
  return processEvaluatedAlerts({
    fixture: liveFixture(args.id, market),
    market,
    settings: defaultsFor(market, args.alert.cornerHalf ?? 'ht'),
    byHalf:
      market === 'corners'
        ? {
            ht: defaultsFor('corners', 'ht'),
            ft: defaultsFor('corners', 'ft'),
          }
        : undefined,
    fresh: [args.alert],
    first: args.first ?? false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: args.events,
    points: [{ period: args.clockPeriod, min: args.clockMin }],
  })
}

try {
  const sameIndexId = `lead-same-idx-${Date.now()}`
  const beforeSameIndex = telegramCalls
  const sameIndexSent = await runTick({
    id: sameIndexId,
    alert: alertAt(sameIndexId, {
      min: 35,
      period: 1,
      index: 10,
      coincident: true,
    }),
    events: [goal(35, 1, 10)],
    clockMin: 35,
    clockPeriod: 1,
  })
  expect(sameIndexSent === 0, `same-index coincident still blocked, got ${sameIndexSent}`)
  expect(telegramCalls === beforeSameIndex, 'same-index must not call sendTelegram')
  expect(
    suppressLogs.includes('coincident-same-min'),
    'same-index logs coincident-same-min',
  )

  const sameMinId = `lead-same-min-${Date.now()}`
  const beforeSameMin = telegramCalls
  const sameMinLogs = suppressLogs.length
  const sameMinSent = await runTick({
    id: sameMinId,
    alert: alertAt(sameMinId, { min: 35, period: 1, index: 10 }),
    events: [goal(35, 1, 13)],
    clockMin: 35,
    clockPeriod: 1,
  })
  expect(sameMinSent === 0, `same-minute different index blocked, got ${sameMinSent}`)
  expect(telegramCalls === beforeSameMin, 'same-minute must not call sendTelegram')
  expect(
    suppressLogs.slice(sameMinLogs).includes('coincident-same-min'),
    'same-minute logs coincident-same-min',
  )
  expect(
    loadAlerts('goals').some((a) => a.id === `${sameMinId}:primary-1-35-10`),
    'same-minute raw alert still ingested for learning',
  )

  const lead0Id = `lead-zero-${Date.now()}`
  const beforeLead0 = telegramCalls
  const lead0Logs = suppressLogs.length
  const lead0Sent = await runTick({
    id: lead0Id,
    alert: alertAt(lead0Id, { min: 34, period: 1, index: 10 }),
    events: [goal(35, 1, 10)],
    clockMin: 34,
    clockPeriod: 1,
  })
  expect(lead0Sent === 0, `lead 0 blocked, got ${lead0Sent}`)
  expect(telegramCalls === beforeLead0, 'lead 0 must not call sendTelegram')
  expect(
    suppressLogs.slice(lead0Logs).includes('lead-lt-1'),
    'lead 0 logs lead-lt-1',
  )

  const clockGoalId = `lead-clock-${Date.now()}`
  const beforeClock = telegramCalls
  const clockLogs = suppressLogs.length
  const clockSent = await runTick({
    id: clockGoalId,
    alert: alertAt(clockGoalId, { min: 34, period: 1, index: 8 }),
    events: [goal(35, 1, 12)],
    clockMin: 35,
    clockPeriod: 1,
  })
  expect(clockSent === 0, `goal-at-clock blocked, got ${clockSent}`)
  expect(telegramCalls === beforeClock, 'goal-at-clock must not call sendTelegram')
  expect(
    suppressLogs.slice(clockLogs).includes('goal-at-clock'),
    'current-clock goal logs goal-at-clock',
  )

  const lead1Id = `lead-ok-${Date.now()}`
  const beforeLead1 = telegramCalls
  const lead1Sent = await runTick({
    id: lead1Id,
    alert: alertAt(lead1Id, { min: 34, period: 1, index: 8 }),
    events: [goal(36, 1, 14)],
    clockMin: 34,
    clockPeriod: 1,
  })
  expect(lead1Sent === 1, `lead ≥1 still sent, got ${lead1Sent}`)
  expect(telegramCalls === beforeLead1 + 1, 'lead ≥1 calls sendTelegram')

  const noEventId = `lead-none-${Date.now()}`
  const beforeNone = telegramCalls
  const noneSent = await runTick({
    id: noEventId,
    alert: alertAt(noEventId, { min: 35, period: 1, index: 10 }),
    events: [],
    clockMin: 35,
    clockPeriod: 1,
  })
  expect(noneSent === 1, `no nearby event still sent, got ${noneSent}`)
  expect(telegramCalls === beforeNone + 1, 'clean spike calls sendTelegram')

  const cornerSameId = `lead-cn-same-${Date.now()}`
  const beforeCornerSame = telegramCalls
  const cornerSameSent = await runTick({
    id: cornerSameId,
    market: 'corners',
    alert: alertAt(cornerSameId, {
      market: 'corners',
      min: 38,
      period: 1,
      index: 4,
      half: 'ht',
    }),
    events: [goal(38, 1, 9)],
    clockMin: 38,
    clockPeriod: 1,
  })
  expect(cornerSameSent === 0, `corners same-minute blocked, got ${cornerSameSent}`)
  expect(telegramCalls === beforeCornerSame, 'corners same-minute must not telegram')
  expect(
    loadAlerts('corners', 'ht').some(
      (a) => a.id === `${cornerSameId}:primary-1-38-4`,
    ),
    'corners same-minute raw alert still ingested',
  )

  const cornerLeadId = `lead-cn-ok-${Date.now()}`
  const beforeCornerLead = telegramCalls
  const cornerLeadSent = await runTick({
    id: cornerLeadId,
    market: 'corners',
    alert: alertAt(cornerLeadId, {
      market: 'corners',
      min: 38,
      period: 1,
      index: 4,
      half: 'ht',
    }),
    events: [goal(40, 1, 10)],
    clockMin: 38,
    clockPeriod: 1,
  })
  expect(cornerLeadSent === 1, `corners lead ≥1 still sent, got ${cornerLeadSent}`)
  expect(telegramCalls === beforeCornerLead + 1, 'corners lead ≥1 calls sendTelegram')

  const stoppageId = `lead-stop-${Date.now()}`
  const beforeStop = telegramCalls
  const stoppageSent = await runTick({
    id: stoppageId,
    alert: alertAt(stoppageId, { min: 96, period: 2, index: 0, half: 'ft' }),
    events: [],
    clockMin: 96,
    clockPeriod: 2,
  })
  expect(stoppageSent === 0, `stoppage ban unchanged, got ${stoppageSent}`)
  expect(telegramCalls === beforeStop, '96\' must not call sendTelegram')
  expect(!inMarketClockWindow('goals', 96, 2), '96\' still outside goals window')
  expect(!inMarketClockWindow('corners', 91, 2), '91\' still outside corners window')

  expect(DEFINITIONS_LOCKED, 'definitions stay locked')
  expect(GOAL_WINDOWS.ht.from === 20 && GOAL_WINDOWS.ht.to === 42, 'goals HT 20–42 unchanged')
  expect(GOAL_WINDOWS.ft.from === 70 && GOAL_WINDOWS.ft.to === 90, 'goals FT 70–90 unchanged')
  expect(GOAL_WINDOWS.ft.to === REGULATION_END[2], 'FT goals still ends at 90')
  expect(
    CORNER_WINDOWS.ht.from === 32 && CORNER_WINDOWS.ht.to === 42,
    'corners HT 32–42 unchanged',
  )
  expect(
    CORNER_WINDOWS.ft.from === 82 && CORNER_WINDOWS.ft.to === 87,
    'corners FT 82–87 unchanged',
  )
  expect(
    defaultsFor('goals', 'ht').spikeThreshold === 80,
    'goals HT Spike threshold unchanged',
  )
  expect(
    defaultsFor('goals', 'ft').spikeThreshold === 80,
    'goals FT Spike threshold unchanged',
  )
} finally {
  console.info = origInfo
  setPollerSendTelegramForTests(null)
  resetPollerRuntimeForTests()
  saveSent(previousSent)
  saveAlerts(previousGoals, 'goals')
  saveAlerts(previousCornersHt, 'corners', 'ht')
  saveAlerts(previousCornersFt, 'corners', 'ft')
}

if (fails.length) {
  console.error('\nFAIL', fails)
  process.exit(1)
}
console.log(
  'OK: same-index/same-minute/lead<1/goal-at-clock suppressed; lead≥1 sent; corners+stoppage+windows unchanged',
)
