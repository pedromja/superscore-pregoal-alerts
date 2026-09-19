import {
  getPollerStatus,
  lastErrorAfterFixtureFailures,
  resetPollerRuntimeForTests,
  setPollerDepsForTests,
  setPollerLimitsForTests,
  tick,
} from '../server/poller.ts'
import { sendPushToAll } from '../server/push.ts'
import {
  JsonBackoff,
  clockFromElapsed,
  selectLiveTargets,
  withTimeout,
  TimeoutError,
} from '../server/pollerHealth.ts'
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

{
  const lastOkAt = new Map<string, number>()
  const now = 1_000_000
  const live = [
    liveFixture('early', 10 * 60),
    liveFixture('ht-window', 36 * 60),
    liveFixture('mid', 55 * 60),
    liveFixture('ft-window', 84 * 60),
    liveFixture('late-first', 40 * 60),
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
  check(
    corners.map((f) => f.id).join(',') === 'ft-window,ht-window',
    `corners priority windows first, got ${corners.map((f) => f.id)}`,
  )
  const goals = selectLiveTargets({
    live,
    market: 'goals',
    limit: 2,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: () => false,
  })
  check(
    goals[0]?.id === 'ft-window',
    `goals prefers late 2nd-half pressure, got ${goals.map((f) => f.id)}`,
  )
  const skipped = selectLiveTargets({
    live,
    market: 'corners',
    limit: 10,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: (id) => id === 'ht-window',
  })
  check(
    !skipped.some((f) => f.id === 'ht-window'),
    'backed-off window game is not selected',
  )
  const many = Array.from({ length: 30 }, (_, i) => liveFixture(`g${String(i).padStart(2, '0')}`, 12 * 60))
  const rot0 = selectLiveTargets({
    live: many,
    market: 'goals',
    limit: 5,
    now,
    tickIndex: 0,
    lastOkAt,
    isBackedOff: () => false,
  }).map((f) => f.id)
  const rot1 = selectLiveTargets({
    live: many,
    market: 'goals',
    limit: 5,
    now,
    tickIndex: 1,
    lastOkAt,
    isBackedOff: () => false,
  }).map((f) => f.id)
  check(rot0.length === 5, 'fill limit 5')
  check(rot0.join(',') !== rot1.join(','), `rotation should move fill set ${rot0} vs ${rot1}`)
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
  check(covered.tickInFlight === false, 'coverage tick not in flight')
  check(typeof covered.lastTickDurationMs === 'number', 'lastTickDurationMs set')
  check(covered.lastTickAt != null, 'lastTickAt advances after healthy tick')

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

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log(
  'OK: truncated JSON is scoped, lastError clears on partial success, sentPush persists after push, watchdog/fixture timeout/empty-json backoff',
)
