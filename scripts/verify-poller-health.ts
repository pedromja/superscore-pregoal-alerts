import { POLLER_INTERVAL_MS } from '../server/config.ts'
import {
  getPollerStatus,
  lastErrorAfterFixtureFailures,
  processEvaluatedAlerts,
  resetPollerRuntimeForTests,
  setPollerDepsForTests,
  setPollerLimitsForTests,
  setPollerSendTelegramForTests,
  tick,
} from '../server/poller.ts'
import { sendPushToAll } from '../server/push.ts'
import {
  JsonBackoff,
  POLLER_CONCURRENCY_DEFAULT,
  POLLER_INTERVAL_MS_DEFAULT,
  POLLER_LIVE_LIMIT_DEFAULT,
  clockFromElapsed,
  flattenLiveTargets,
  selectLiveTargets,
  withTimeout,
  TimeoutError,
} from '../server/pollerHealth.ts'
import { defaultsFor } from '../src/lib/market.ts'
import { sampleFeedAlert } from '../src/lib/tally.ts'
import {
  isRoutineJsonError,
  parseUpstreamJson,
  UpstreamJsonError,
} from '../server/ss.ts'
import {
  loadAlerts,
  loadGoals,
  loadHistory,
  loadProposal,
  loadSubscriptions,
  markAlertPushed,
  saveAlerts,
  saveGoals,
  saveHistory,
  saveProposal,
  saveSubscriptions,
  upsertAlerts,
} from '../server/store.ts'
import { resetLearnStats } from '../server/learn.ts'
import type { LoggedAlert } from '../server/types.ts'
import type { Fixture } from '../src/lib/types.ts'

const fail: string[] = []

function check(cond: boolean, msg: string) {
  if (!cond) fail.push(msg)
}

try {
  parseUpstreamJson('{"ok":true}', 'https://example.test/ok')
} catch (err) {
  fail.push(`valid JSON threw ${err instanceof Error ? err.message : err}`)
}

const parsed = parseUpstreamJson(
  '{"competitions":[]}',
  'https://example.test/fixtures',
) as { competitions: unknown[] }
check(Array.isArray(parsed.competitions), 'parsed fixtures object')

let truncated: unknown
try {
  parseUpstreamJson('{"timeline":[', 'https://example.test/momentum', 'fix-1')
} catch (err) {
  truncated = err
}
check(truncated instanceof UpstreamJsonError, 'truncated JSON is UpstreamJsonError')
check(
  truncated instanceof Error && /JSON truncado/.test(truncated.message),
  `truncated message: ${truncated instanceof Error ? truncated.message : truncated}`,
)
check(
  truncated instanceof UpstreamJsonError && truncated.url.includes('momentum'),
  'truncated error keeps URL',
)
check(
  truncated instanceof UpstreamJsonError && truncated.fixtureId === 'fix-1',
  'truncated error keeps fixture id',
)
check(isRoutineJsonError(truncated), 'truncated JSON is routine')

let empty: unknown
try {
  parseUpstreamJson('   ', 'https://example.test/empty')
} catch (err) {
  empty = err
}
check(empty instanceof UpstreamJsonError && /JSON vazio/.test(empty.message), 'empty JSON')
check(isRoutineJsonError(empty), 'empty JSON is routine')

let invalid: unknown
try {
  parseUpstreamJson('<html>', 'https://example.test/html')
} catch (err) {
  invalid = err
}
check(invalid instanceof Error && /JSON inválido/.test(invalid.message), 'html is invalid JSON')
check(isRoutineJsonError(invalid), 'invalid JSON is routine')
check(
  !isRoutineJsonError(new Error('Momentum 502')),
  'HTTP errors are not routine JSON',
)

check(
  lastErrorAfterFixtureFailures([], 8) === null,
  'no errors → lastError null',
)
check(
  lastErrorAfterFixtureFailures(
    [
      {
        fixtureId: 'a',
        matchLabel: 'A vs B',
        message: 'JSON truncado (jogo a)',
        routineJson: true,
        url: 'https://example.test/a',
      },
    ],
    8,
  ) === null,
  'one truncated fixture in a mostly-ok tick does not sticky lastError',
)
const allTruncated = lastErrorAfterFixtureFailures(
  [
    {
      fixtureId: 'a',
      matchLabel: 'A vs B',
      message: 'JSON truncado (jogo a)',
      routineJson: true,
    },
    {
      fixtureId: 'b',
      matchLabel: 'C vs D',
      message: 'JSON truncado (jogo b)',
      routineJson: true,
    },
  ],
  2,
)
check(
  allTruncated === 'JSON truncado (jogo a)',
  `all fixtures truncated should surface lastError, got ${allTruncated}`,
)
const mixed = lastErrorAfterFixtureFailures(
  [
    {
      fixtureId: 'a',
      matchLabel: 'A vs B',
      message: 'JSON truncado (jogo a)',
      routineJson: true,
    },
    {
      fixtureId: 'b',
      matchLabel: 'C vs D',
      message: 'Momentum 502',
      routineJson: false,
    },
  ],
  8,
)
check(
  mixed === '1/8 jogos: Momentum 502',
  `serious partial error should be scoped, got ${mixed}`,
)
check(
  lastErrorAfterFixtureFailures(
    [
      {
        fixtureId: 'a',
        matchLabel: 'A vs B',
        message: 'JSON truncado (jogo a)',
        routineJson: true,
      },
    ],
    0,
  ) === null,
  'empty target list with leftover errors still clears',
)

const sample: LoggedAlert = {
  id: 'health-test:primary-1-38-0',
  fixtureId: 'health-test',
  matchLabel: 'Teste vs Teste',
  minute: 38,
  period: 1,
  index: 0,
  side: 'away',
  ruleId: 'primary',
  market: 'goals',
  features: { v: -61, delta1: -63, sustained: 1 },
  thresholdsSnapshot: {},
  ts: new Date().toISOString(),
  coincident: false,
  hit: null,
  leadMin: null,
  hit5: null,
  hitLong: null,
  longDeadline: null,
  leadTime5: null,
  leadTimeLong: null,
  labeledAt: null,
  feedback: null,
  sentPush: false,
}

const previous = loadAlerts('goals')
try {
  saveAlerts(
    previous.filter((a) => a.id !== sample.id),
    'goals',
  )
  upsertAlerts([{ ...sample, sentPush: false }], 'goals')
  check(
    loadAlerts('goals').find((a) => a.id === sample.id)?.sentPush === false,
    'initial ingest sentPush false',
  )
  check(markAlertPushed(sample.id, 'goals'), 'markAlertPushed finds the row')
  check(
    loadAlerts('goals').find((a) => a.id === sample.id)?.sentPush === true,
    'markAlertPushed sets sentPush',
  )
  upsertAlerts(
    [
      {
        ...sample,
        sentPush: false,
        matchLabel: 'Teste vs Teste 2',
        telegramMessageId: undefined,
        telegramOutcomeSentAt: null,
      },
    ],
    'goals',
  )
  const after = loadAlerts('goals').find((a) => a.id === sample.id)
  check(after?.sentPush === true, 're-ingest must not clobber sentPush true')
  check(after?.matchLabel === 'Teste vs Teste 2', 're-ingest still updates other fields')
  upsertAlerts(
    [{ ...sample, sentPush: true, telegramMessageId: 77, telegramOutcomeSentAt: '2026-01-01T00:00:00.000Z' }],
    'goals',
  )
  upsertAlerts(
    [{ ...sample, sentPush: false, telegramMessageId: undefined, telegramOutcomeSentAt: null }],
    'goals',
  )
  const afterTg = loadAlerts('goals').find((a) => a.id === sample.id)
  check(afterTg?.telegramMessageId === 77, 're-ingest must keep telegramMessageId')
  check(
    afterTg?.telegramOutcomeSentAt === '2026-01-01T00:00:00.000Z',
    're-ingest must keep telegramOutcomeSentAt',
  )
  const withOdds = {
    ...sample,
    sentPush: false,
    odds: {
      ts: sample.ts,
      fixtureId: sample.fixtureId,
      matchLabel: sample.matchLabel,
      league: 'Teste',
      market: 'goals' as const,
      half: 'ft' as const,
      bucket: 'goals_ft' as const,
      minute: sample.minute,
      period: sample.period,
      alertId: sample.id,
      currentTotal: 0,
      source: 'superscore' as const,
      sourceLabel: 'SuperScore',
      limit: null,
      asian: null,
      sokkerpro: null,
      robobet: null,
    },
  }
  upsertAlerts([withOdds], 'goals')
  check(
    loadAlerts('goals').find((a) => a.id === sample.id)?.odds?.source === 'superscore',
    're-ingest with odds stores observation',
  )
  upsertAlerts([{ ...sample, sentPush: false, odds: undefined }], 'goals')
  check(
    loadAlerts('goals').find((a) => a.id === sample.id)?.odds?.source === 'superscore',
    're-ingest without odds must keep previous observation',
  )
} finally {
  saveAlerts(
    previous.filter((a) => a.id !== sample.id),
    'goals',
  )
}

const previousSubs = loadSubscriptions()
try {
  saveSubscriptions([])
  const pushResult = await sendPushToAll({
    title: 'teste',
    body: 'sem subscritores',
    url: '/#/monitor',
    alertKey: 'health-test:primary-1-38-0',
    tag: 'pregoal:test',
  })
  check(pushResult.sent === 0, 'no subscribers → sent 0')
  check(pushResult.attempted === 0, 'no subscribers → attempted 0')
  check(
    pushResult.errors.includes('sem subscritores'),
    `missing-sub reason logged, got ${pushResult.errors.join(',')}`,
  )
} finally {
  saveSubscriptions(previousSubs)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function liveFixture(
  id: string,
  elapsedSeconds: number | null,
  extras: Partial<Fixture> = {},
): Fixture {
  return {
    id,
    team1: `Home ${id}`,
    team2: `Away ${id}`,
    team1Id: `${id}-h`,
    team2Id: `${id}-a`,
    competition: 'Test',
    category: 'test',
    status: 1,
    state: 1,
    dateSeconds: 0,
    liveElapsedSeconds: elapsedSeconds,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: false,
    ...extras,
  }
}

check(clockFromElapsed(32 * 60)?.min === 32, 'clock 32:00 → min 32')
check(clockFromElapsed(32 * 60)?.period === 1, 'clock 32:00 → period 1')
check(clockFromElapsed(82 * 60)?.min === 82, 'clock 82:00 → min 82')
check(clockFromElapsed(82 * 60)?.period === 2, 'clock 82:00 → period 2')

check(POLLER_INTERVAL_MS_DEFAULT === 15_000, 'interval default constant is 15s')
check(POLLER_LIVE_LIMIT_DEFAULT === 32, 'live-limit default is 32')
check(POLLER_CONCURRENCY_DEFAULT === 8, 'concurrency default is 8')
check(
  POLLER_INTERVAL_MS ===
    Number(process.env.POLLER_INTERVAL_MS || POLLER_INTERVAL_MS_DEFAULT),
  `POLLER_INTERVAL_MS env wins or defaults to 15s, got ${POLLER_INTERVAL_MS}`,
)
if (!process.env.POLLER_INTERVAL_MS) {
  check(POLLER_INTERVAL_MS === 15_000, 'unset env → interval 15000')
}

{
  const lastOkAt = new Map<string, number>()
  const now = 1_000_000
  const live = [
    liveFixture('early', 10 * 60),
    liveFixture('ht-window', 36 * 60),
    liveFixture('mid', 55 * 60),
    liveFixture('ft-window', 84 * 60),
    liveFixture('late-first', 40 * 60),
    liveFixture('stoppage', 91 * 60),
  ]
  const corners = selectLiveTargets({
    live,
    market: 'corners',
    limit: 2,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: () => false,
  })
  const cornerIn = corners.inWindow.map((f) => f.id)
  check(
    cornerIn.includes('ft-window') &&
      cornerIn.includes('ht-window') &&
      cornerIn.includes('late-first'),
    `in-window corners always selected even when > LIVE_LIMIT, got ${cornerIn}`,
  )
  check(
    !cornerIn.includes('early') && !cornerIn.includes('mid') && !cornerIn.includes('stoppage'),
    `out-of-window / 91' not treated as in-window, got ${cornerIn}`,
  )
  check(corners.fill.length === 0, 'no fill slots when in-window already exceeds limit')
  check(corners.inWindow[0]?.id === 'ft-window', `late FT corner first, got ${cornerIn}`)

  const goals = selectLiveTargets({
    live,
    market: 'goals',
    limit: 2,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: () => false,
  })
  const goalIn = goals.inWindow.map((f) => f.id)
  check(
    goalIn.includes('ft-window') &&
      goalIn.includes('ht-window') &&
      goalIn.includes('late-first'),
    `in-window goals always selected even when > LIVE_LIMIT, got ${goalIn}`,
  )
  check(goals.inWindow[0]?.id === 'ft-window', `late FT goal first, got ${goalIn}`)
  check(!goalIn.includes('stoppage'), "91' is not an in-window goal fixture")

  const skipped = flattenLiveTargets(
    selectLiveTargets({
      live,
      market: 'corners',
      limit: 10,
      now,
      tickIndex: 0,
      lastOkAt,
      isBackedOff: (id) => id === 'ht-window',
    }),
  )
  check(
    !skipped.some((f) => f.id === 'ht-window'),
    'backed-off window game is not selected',
  )

  const many = Array.from({ length: 30 }, (_, i) =>
    liveFixture(`g${String(i).padStart(2, '0')}`, 12 * 60),
  )
  const rot0 = selectLiveTargets({
    live: many,
    market: 'goals',
    limit: 5,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: () => false,
  })
  const rot1 = selectLiveTargets({
    live: many,
    market: 'goals',
    limit: 5,
    now,
    tickIndex: 1,
    lastOkAt,
    isBackedOff: () => false,
  })
  check(rot0.inWindow.length === 0, 'early clocks are fill, not in-window')
  check(rot0.fill.length === 5, 'out-of-window fill respects LIVE_LIMIT')
  check(
    rot0.fill.map((f) => f.id).join(',') !== rot1.fill.map((f) => f.id).join(','),
    `rotation should move fill set ${rot0.fill.map((f) => f.id)} vs ${rot1.fill.map((f) => f.id)}`,
  )

  const mixed = [
    liveFixture('win-a', 85 * 60),
    liveFixture('win-b', 83 * 60),
    liveFixture('win-c', 36 * 60),
    ...Array.from({ length: 20 }, (_, i) => liveFixture(`fill-${String(i).padStart(2, '0')}`, 12 * 60)),
  ]
  const overLimit = selectLiveTargets({
    live: mixed,
    market: 'goals',
    limit: 4,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: () => false,
  })
  check(overLimit.inWindow.length === 3, `all 3 in-window kept, got ${overLimit.inWindow.length}`)
  check(overLimit.fill.length === 1, `remaining 1 fill slot, got ${overLimit.fill.length}`)
  check(
    overLimit.inWindow.every((f) => f.id.startsWith('win-')),
    'in-window ids only',
  )
}

{
  const backoff = new JsonBackoff(45_000, 10 * 60 * 1000)
  const t0 = 1_000_000
  backoff.noteFailure('a', t0)
  check(!backoff.isBlocked('a', t0 + 1), 'first empty JSON still retries next tick')
  backoff.noteFailure('a', t0 + 45_000)
  check(backoff.isBlocked('a', t0 + 45_001), 'second consecutive empty JSON backs off')
  check(backoff.isBlocked('a', t0 + 45_000 + 44_000), 'backoff lasts an interval')
  check(!backoff.isBlocked('a', t0 + 45_000 + 45_001), 'backoff expires after interval')
  backoff.noteSuccess('a')
  check(!backoff.isBlocked('a', t0 + 45_000 + 1), 'success clears backoff')
}

{
  let timedOut = false
  const hang = new Promise<string>((resolve) => {
    setTimeout(() => resolve('late'), 200)
  })
  try {
    await withTimeout(hang, 20, 'Timeout 20ms (jogo x)')
  } catch (err) {
    timedOut = err instanceof TimeoutError
  }
  check(timedOut, 'withTimeout rejects with TimeoutError')
}

try {
  resetPollerRuntimeForTests()
  setPollerLimitsForTests({
    fixtureTimeoutMs: 40,
    tickWatchdogMs: 2_000,
    liveLimit: 30,
    finishedLimit: 0,
    concurrency: 2,
  })

  const processed: string[] = []
  const thirty = Array.from({ length: 30 }, (_, i) =>
    liveFixture(`live-${String(i).padStart(2, '0')}`, 15 * 60),
  )
  setPollerDepsForTests({
    fetchFixtures: async () => thirty,
    processFixture: async (fixture) => {
      processed.push(fixture.id)
      return 0
    },
    warmup: async () => null,
  })
  await tick()
  const covered = getPollerStatus()
  check(processed.length === 30, `widened live coverage, processed ${processed.length}`)
  check(covered.liveWatched === 30, `liveWatched 30, got ${covered.liveWatched}`)
  check(covered.liveProcessed === 30, `liveProcessed 30, got ${covered.liveProcessed}`)
  check(covered.intervalMs === POLLER_INTERVAL_MS, `status.intervalMs, got ${covered.intervalMs}`)
  check(covered.inWindowThisTick === 0, `early clocks → 0 in-window, got ${covered.inWindowThisTick}`)
  check(covered.tickInFlight === false, 'coverage tick not in flight')
  check(typeof covered.lastTickDurationMs === 'number', 'lastTickDurationMs set')
  check(covered.lastTickAt != null, 'lastTickAt advances after healthy tick')

  resetPollerRuntimeForTests()
  setPollerLimitsForTests({
    fixtureTimeoutMs: 200,
    tickWatchdogMs: 2_000,
    liveLimit: 4,
    finishedLimit: 0,
    concurrency: 1,
    inWindowConcurrency: 4,
  })
  const order: string[] = []
  setPollerDepsForTests({
    fetchFixtures: async () => [
      liveFixture('fill-slow', 12 * 60),
      liveFixture('ht-window', 36 * 60),
      liveFixture('ft-window', 85 * 60),
      liveFixture('fill-early', 10 * 60),
    ],
    processFixture: async (fixture) => {
      order.push(`start:${fixture.id}`)
      if (fixture.id === 'fill-slow') await delay(40)
      order.push(`end:${fixture.id}`)
      return 0
    },
    warmup: async () => null,
  })
  await tick()
  const afterOrder = getPollerStatus()
  check(afterOrder.inWindowThisTick === 2, `inWindowThisTick 2, got ${afterOrder.inWindowThisTick}`)
  const firstFillStart = order.findIndex((e) => e.startsWith('start:fill-'))
  const lastWindowEnd = Math.max(
    order.lastIndexOf('end:ht-window'),
    order.lastIndexOf('end:ft-window'),
  )
  check(
    lastWindowEnd >= 0 && firstFillStart > lastWindowEnd,
    `in-window finishes before fill starts, order ${order.join(',')}`,
  )

  resetPollerRuntimeForTests()
  setPollerLimitsForTests({
    fixtureTimeoutMs: 50,
    tickWatchdogMs: 2_000,
    liveLimit: 8,
    finishedLimit: 0,
    concurrency: 2,
  })
  const seen: string[] = []
  setPollerDepsForTests({
    fetchFixtures: async () => [liveFixture('ok', 70 * 60), liveFixture('hung', 70 * 60)],
    processFixture: async (fixture, signal) => {
      if (fixture.id === 'hung') {
        await new Promise<never>((_, reject) => {
          const fail = () => reject(new Error('aborted'))
          if (signal?.aborted) fail()
          signal?.addEventListener('abort', fail, { once: true })
        })
      }
      seen.push(fixture.id)
      return 0
    },
    warmup: async () => null,
  })
  const t0 = Date.now()
  await tick()
  const elapsed = Date.now() - t0
  const afterTimeout = getPollerStatus()
  check(seen.includes('ok'), 'fixture timeout still processes the healthy game')
  check(!seen.includes('hung'), 'hung fixture does not complete after timeout')
  check(elapsed < 800, `fixture timeout should not block tick, took ${elapsed}ms`)
  check(afterTimeout.tickInFlight === false, 'inFlight cleared after fixture timeout')
  check(
    afterTimeout.lastFixtureError?.fixtureId === 'hung',
    `lastFixtureError hung, got ${afterTimeout.lastFixtureError?.fixtureId}`,
  )
  check(
    /Timeout/.test(afterTimeout.lastFixtureError?.message ?? ''),
    `timeout message, got ${afterTimeout.lastFixtureError?.message}`,
  )

  resetPollerRuntimeForTests()
  setPollerLimitsForTests({
    fixtureTimeoutMs: 2_000,
    tickWatchdogMs: 80,
    liveLimit: 4,
    finishedLimit: 0,
    concurrency: 1,
  })
  let fetchCalls = 0
  setPollerDepsForTests({
    fetchFixtures: (signal) => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return new Promise((_, reject) => {
          const fail = () => reject(new Error('tick-abort'))
          if (signal?.aborted) fail()
          signal?.addEventListener('abort', fail, { once: true })
        })
      }
      return Promise.resolve([liveFixture('after-hang', 20 * 60)])
    },
    processFixture: async () => 0,
    warmup: async () => null,
  })
  const hungTick = tick()
  await delay(30)
  check(getPollerStatus().tickInFlight === true, 'watchdog: tick in flight while hung')
  await hungTick
  const afterHang = getPollerStatus()
  check(afterHang.tickInFlight === false, 'watchdog cleared inFlight')
  check(afterHang.lastHangAt != null, 'lastHangAt recorded')
  const recovered = tick()
  await recovered
  check(fetchCalls >= 2, `next interval runs after hang, fetchCalls ${fetchCalls}`)
  check(getPollerStatus().tickInFlight === false, 'recovered tick finished')
  check(getPollerStatus().lastTickAt != null, 'recovered tick advances lastTickAt')

  resetPollerRuntimeForTests()
  setPollerLimitsForTests({
    fixtureTimeoutMs: 200,
    tickWatchdogMs: 2_000,
    liveLimit: 4,
    finishedLimit: 0,
    concurrency: 1,
  })
  const emptyCalls: string[] = []
  const emptyErr = new UpstreamJsonError(
    'JSON vazio (jogo empty-1)',
    'https://example.test/momentum',
    'empty-1',
  )
  setPollerDepsForTests({
    fetchFixtures: async () => [
      liveFixture('empty-1', 20 * 60),
      liveFixture('healthy', 20 * 60),
    ],
    processFixture: async (fixture) => {
      emptyCalls.push(fixture.id)
      if (fixture.id === 'empty-1') throw emptyErr
      return 0
    },
    warmup: async () => null,
  })
  await tick()
  await tick()
  const callsAfterTwo = emptyCalls.filter((id) => id === 'empty-1').length
  check(callsAfterTwo === 2, `empty JSON retried once, got ${callsAfterTwo}`)
  await tick()
  const callsAfterThree = emptyCalls.filter((id) => id === 'empty-1').length
  check(
    callsAfterThree === 2,
    `empty JSON backed off on third tick, got ${callsAfterThree}`,
  )
  check(
    emptyCalls.filter((id) => id === 'healthy').length === 3,
    'healthy fixture still scanned while empty-json game is in backoff',
  )
} finally {
  resetPollerRuntimeForTests()
}

const previousGoalsAlerts = loadAlerts('goals')
const previousGoalsEvents = loadGoals('goals')
const previousGoalsHistory = loadHistory('goals')
const previousGoalsProposal = loadProposal('goals')
try {
  let denied = false
  try {
    resetLearnStats({ confirm: false, market: 'goals' })
  } catch {
    denied = true
  }
  check(denied, 'reset without confirm:true is rejected')
  upsertAlerts([{ ...sample, id: 'reset-test:primary-1-38-0' }], 'goals')
  check(
    loadAlerts('goals').some((a) => a.id === 'reset-test:primary-1-38-0'),
    'reset fixture alert stored',
  )
  const result = resetLearnStats({ confirm: true, market: 'goals' })
  check(result.market === 'goals', 'reset market goals')
  check(loadAlerts('goals').length === 0, 'reset clears goal alerts')
  check(loadGoals('goals').length === 0, 'reset clears goal outcomes')
  check(loadHistory('goals').length === 0, 'reset clears goal history')
  check(loadProposal('goals') === null, 'reset clears goal proposal')
  check(
    result.kept.some((line) => line.includes('sent.json')),
    'reset documents that sent-keys stay',
  )
} finally {
  saveAlerts(previousGoalsAlerts, 'goals')
  saveGoals(previousGoalsEvents, 'goals')
  saveHistory(previousGoalsHistory, 'goals')
  saveProposal(previousGoalsProposal, 'goals')
}

{
  resetPollerRuntimeForTests()
  let telegramCalls = 0
  setPollerSendTelegramForTests(async () => {
    telegramCalls += 1
    return { sent: 1, skipped: false }
  })
  const payload = { timeline: [], events: [] }
  const stoppageId = `ban-91-${Date.now()}`
  const stoppageSent = await processEvaluatedAlerts({
    fixture: liveFixture(stoppageId, 91 * 60),
    market: 'goals',
    settings: defaultsFor('goals'),
    byHalf: undefined,
    fresh: [
      {
        ...sampleFeedAlert('goals'),
        id: 'primary-2-91-0',
        fixtureId: stoppageId,
        matchLabel: 'Stoppage vs Test',
        min: 91,
        period: 2,
        coincident: false,
        market: 'goals',
        firedAt: new Date().toISOString(),
      },
    ],
    first: false,
    finished: false,
    payload,
    events: [],
    points: [{ period: 2, min: 91 }],
  })
  check(stoppageSent === 0, `91' must not telegram, got ${stoppageSent}`)
  check(telegramCalls === 0, `91' must not call sendTelegram, got ${telegramCalls}`)

  const liveId = `hint-${Date.now()}`
  const hintSent = await processEvaluatedAlerts({
    fixture: liveFixture(liveId, 85 * 60),
    market: 'goals',
    settings: defaultsFor('goals'),
    byHalf: undefined,
    fresh: [
      {
        ...sampleFeedAlert('goals'),
        id: 'primary-2-85-0',
        fixtureId: liveId,
        matchLabel: 'Hint vs Test',
        min: 85,
        period: 2,
        coincident: false,
        market: 'goals',
        firedAt: new Date().toISOString(),
      },
    ],
    first: false,
    finished: false,
    payload,
    events: [],
    points: [{ period: 2, min: 85 }],
  })
  const hint = getPollerStatus().lastAlertLatencyHint
  check(hintSent === 1, `in-window alert telegram, got ${hintSent}`)
  check(hint?.clockMin === 85, `latency hint clockMin 85, got ${hint?.clockMin}`)
  check(hint?.period === 2, `latency hint period 2, got ${hint?.period}`)
  check(typeof hint?.sentAt === 'string' && hint.sentAt.length > 0, 'latency hint sentAt')
  check(hint?.fixtureId === liveId, 'latency hint fixtureId')
  setPollerSendTelegramForTests(null)
  resetPollerRuntimeForTests()
}

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log(
  'OK: truncated JSON is scoped, lastError clears on partial success, sentPush persists after push, watchdog/fixture timeout/empty-json backoff, in-window always selected',
)
