/**
 * Fast live-score gate: SokkerPro mini board for golos; SuperScore type=14
 * tally re-check for cantos. Does not change locked windows / Web Push.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultsFor } from '../src/lib/market.ts'
import {
  alreadyHitSuppressReason,
  cornerAlreadyHitReason,
  fastScoreFromBoard,
  goalAlreadyHitReason,
  latestCornerTotal,
  provenLeadOnFastGoal,
  superscoreCornerTotal,
  superscoreGoalTotal,
  type FastScore,
} from '../src/lib/fastScore.ts'
import { DEFINITIONS_LOCKED } from '../src/lib/lock.ts'
import { MIN_NOTIFY_LEAD_MIN } from '../src/lib/notifyLead.ts'
import {
  flattenMiniFixtures,
  matchSokkerProFixture,
  matchSokkerProFixtureOriented,
} from '../src/lib/sokkerpro.ts'
import { sampleFeedAlert } from '../src/lib/tally.ts'
import type { FeedAlert, Fixture, Market, MomentumPayload } from '../src/lib/types.ts'
import {
  CORNER_WINDOWS,
  GOAL_WINDOWS,
  REGULATION_END,
} from '../src/lib/windows.ts'
import {
  getPollerStatus,
  processEvaluatedAlerts,
  resetPollerRuntimeForTests,
  setPollerCornerRefetchForTests,
  setPollerGetFastScoreForTests,
  setPollerSendTelegramForTests,
} from '../server/poller.ts'
import {
  getFastScore,
  peekCachedSokkerProFixtures,
  resetSokkerProStateForTests,
  seedSokkerProBoardForTests,
  setSokkerProLiveScoreEnabledForTests,
  setSokkerProNowForTests,
} from '../server/sokkerpro.ts'
import { loadAlerts, loadSent, saveAlerts, saveSent } from '../server/store.ts'
import { webPushEnabled } from '../server/config.ts'

const fail: string[] = []

function check(cond: boolean, msg: string) {
  if (!cond) fail.push(msg)
}

const samplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/sokkerpro-mini-sample.json',
)
const sampleRaw = JSON.parse(readFileSync(samplePath, 'utf8')) as unknown
const board = flattenMiniFixtures(sampleRaw)

check(board.length >= 7, `sample flattened ${board.length}`)

const porto = board.find((f) => f.fixtureId === '4242-live')
check(porto?.scoresLocalTeam === 1 && porto.scoresVisitorTeam === 0, 'Porto sample 1-0')
check(porto?.minute === 67 && porto.status === '2nd', 'Porto clock 67 2nd')
check(porto?.startingAtTimestamp === 1_789_822_800, 'Porto kickoff timestamp')

const liberec = board.find((f) => f.fixtureId === '19736218')
check(liberec?.isGoal === '1789828478', `is_goal timestamp, got ${liberec?.isGoal}`)
check(liberec?.isGoalTeam === 'away', `is_goal_team away, got ${liberec?.isGoalTeam}`)
check(liberec?.scoresLocalTeam === 4 && liberec.scoresVisitorTeam === 1, 'Liberec 4-1')

const ns = board.find((f) => f.fixtureId === '19882016')
check(ns?.minute === null, 'NS blank minute is null, not 0')
check(ns?.isGoal === null, 'empty is_goal is null')
check(ns?.scoresLocalTeam === 0 && ns.scoresVisitorTeam === 0, 'NS blank scores → 0-0')

const byName = matchSokkerProFixture(board, 'Porto', 'Benfica')
check(byName?.fixtureId === '4242-live', `live Porto preferred without kickoff, got ${byName?.fixtureId}`)

const laterKick = matchSokkerProFixture(board, 'Porto', 'Benfica', 1_789_909_200)
check(laterKick?.fixtureId === '4242-later', `kickoff picks later Porto, got ${laterKick?.fixtureId}`)

const liveKick = matchSokkerProFixture(board, 'FC Porto', 'SL Benfica', 1_789_822_800)
check(liveKick?.fixtureId === '4242-live', `kickoff picks live Porto, got ${liveKick?.fixtureId}`)

const sudan = fastScoreFromBoard(board, {
  team1: 'Sudan U20',
  team2: 'Uganda U20',
  dateSeconds: 1_789_822_800,
})
check(sudan?.source === 'sokkerpro', 'source sokkerpro')
check(sudan?.home === 0 && sudan?.away === 1, `Sudan score ${sudan?.home}-${sudan?.away}`)
check(sudan?.minute === 73 && sudan?.status === '2nd', 'Sudan clock')
check(!sudan?.isGoal, 'Sudan is_goal unset')

const swapped = fastScoreFromBoard(board, {
  team1: 'Celtic',
  team2: 'Ferencváros',
  dateSeconds: 1_789_822_800,
})
check(swapped?.home === 2 && swapped?.away === 0, `swapped Celtic is home 2-0, got ${swapped?.home}-${swapped?.away}`)

const orientedSwap = matchSokkerProFixtureOriented(board, 'Celtic', 'Ferencváros')
check(orientedSwap?.swapped === true, 'Celtic/Ferenc is swapped vs SokkerPro')

const angola = fastScoreFromBoard(board, {
  team1: 'Angola U20',
  team2: 'Swaziland U20',
  dateSeconds: 1_789_822_800,
})
check(angola?.home === 4 && angola?.away === 0, 'Angola 4-0')

check(
  superscoreGoalTotal({ min: 35, period: 1, goalsTally: { home: 1, away: 0 } }) === 1,
  'SS tally from alert copy',
)
check(
  superscoreGoalTotal({ min: 35, period: 1 }, [
    { min: 20, period: 1 },
    { min: 40, period: 1 },
  ]) === 1,
  'SS tally from extracted events up to alert min',
)

check(
  goalAlreadyHitReason({ ssGoals: 1, fast: angola!, alertMin: 75 }) ===
    'already-hit-fast-score',
  'SP 4 > SS 1 → already-hit-fast-score',
)
check(
  goalAlreadyHitReason({ ssGoals: 4, fast: angola!, alertMin: 75 }) === null,
  'equal totals and no is_goal → send',
)
check(
  goalAlreadyHitReason({ ssGoals: 5, fast: angola!, alertMin: 75 }) === null,
  'SP behind SuperScore → fall through',
)
check(
  goalAlreadyHitReason({ ssGoals: 1, fast: null, alertMin: 75 }) === null,
  'missing SokkerPro → fall through',
)

const justGoal: FastScore = {
  home: 1,
  away: 0,
  minute: 29,
  status: '1st',
  isGoal: '1789828480',
  isGoalTeam: 'home',
  source: 'sokkerpro',
}
check(
  goalAlreadyHitReason({ ssGoals: 1, fast: justGoal, alertMin: 29 }) ===
    'already-hit-is-goal',
  'is_goal at same minute → already-hit-is-goal',
)
check(
  goalAlreadyHitReason({ ssGoals: 1, fast: justGoal, alertMin: 28 }) === null,
  'is_goal with proven ≥1′ lead → send',
)
check(
  !provenLeadOnFastGoal(29, 29),
  'same-minute is_goal is not a proven lead',
)
check(provenLeadOnFastGoal(28, 29) === true, '1′ clock gap is a proven lead')
check(provenLeadOnFastGoal(27, null) === false, 'no SokkerPro minute → cannot prove lead')

const noClock: FastScore = { ...justGoal, minute: null }
check(
  goalAlreadyHitReason({ ssGoals: 1, fast: noClock, alertMin: 20 }) ===
    'already-hit-is-goal',
  'is_goal without minute defaults to suppress',
)

const liberecFast = fastScoreFromBoard(board, {
  team1: 'Slovan Liberec W',
  team2: 'Viktoria Plzeň W',
  dateSeconds: 1_789_822_800,
})
check(
  alreadyHitSuppressReason({
    market: 'goals',
    alert: { min: 77, period: 2, goalsTally: { home: 4, away: 0 } },
    fast: liberecFast,
  }) === 'already-hit-fast-score',
  'Liberec SP 5 > SS 4',
)
check(
  alreadyHitSuppressReason({
    market: 'goals',
    alert: { min: 79, period: 2, goalsTally: { home: 4, away: 1 } },
    fast: liberecFast,
  }) === 'already-hit-is-goal',
  'Liberec equal score but is_goal at 79′ vs alert 79′',
)
check(
  alreadyHitSuppressReason({
    market: 'goals',
    alert: { min: 77, period: 2, goalsTally: { home: 4, away: 1 } },
    fast: liberecFast,
  }) === null,
  'Liberec equal score + 2′ lead on is_goal → send',
)

const cornerPayload: MomentumPayload = {
  timeline: [],
  events: [
    { type: 14, side: 1, min: 34, period: 1 },
    { type: 14, side: 2, min: 36, period: 1 },
    { type: 14, side: 1, min: 39, period: 1 },
  ],
}
check(latestCornerTotal(cornerPayload) === 3, 'latest corner tally counts all type=14')
check(
  superscoreCornerTotal({ cornersTally: { home: 1, away: 1 } }) === 2,
  'alert-time corner tally',
)
check(
  cornerAlreadyHitReason({ alertCorners: 2, latestCorners: 3 }) ===
    'already-hit-corner-tally',
  'later SuperScore corner → already-hit-corner-tally',
)
check(
  alreadyHitSuppressReason({
    market: 'corners',
    alert: { min: 38, period: 1, cornersTally: { home: 1, away: 1 } },
    fast: null,
    latestCorners: 3,
  }) === 'already-hit-corner-tally',
  'corners gate ignores SokkerPro score',
)
check(
  alreadyHitSuppressReason({
    market: 'corners',
    alert: { min: 38, period: 1, cornersTally: { home: 2, away: 1 } },
    fast: angola,
    latestCorners: 3,
  }) === null,
  'corners same tally → no extra suppress (even if SP has goals)',
)
check(
  alreadyHitSuppressReason({
    market: 'corners',
    alert: { min: 38, period: 1, cornersTally: { home: 1, away: 1 } },
    fast: null,
    latestCorners: null,
  }) === null,
  'corners without latest tally → fall through',
)

resetSokkerProStateForTests()
setSokkerProNowForTests(new Date('2026-09-19T15:00:00.000Z'))
seedSokkerProBoardForTests('2026-09-19', board)
check(peekCachedSokkerProFixtures().length === board.length, 'seeded board is peekable')
const cached = getFastScore({
  team1: 'Angola U20',
  team2: 'Swaziland U20',
  dateSeconds: 1_789_822_800,
})
check(cached?.home === 4 && cached.away === 0, 'getFastScore reads cache, no HTTP')

setSokkerProLiveScoreEnabledForTests(false)
check(
  getFastScore({
    team1: 'Angola U20',
    team2: 'Swaziland U20',
    dateSeconds: 1_789_822_800,
  }) === null,
  'live-score off → null',
)
setSokkerProLiveScoreEnabledForTests(true)
check(
  getFastScore({
    team1: 'No Such',
    team2: 'Team Pair',
    dateSeconds: 1_789_822_800,
  }) === null,
  'name miss → null (fall through)',
)

function liveFixture(id: string, teams: { team1: string; team2: string }, kickoff = 1_789_822_800): Fixture {
  return {
    id,
    team1: teams.team1,
    team2: teams.team2,
    team1Id: `${id}-h`,
    team2Id: `${id}-a`,
    competition: 'Fast score test',
    category: 'test',
    status: 1,
    state: 1,
    dateSeconds: kickoff,
    liveElapsedSeconds: 75 * 60,
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
    goals?: { home: number; away: number }
    corners?: { home: number; away: number }
    half?: 'ht' | 'ft'
  },
): FeedAlert {
  const market = opts.market ?? 'goals'
  const half = opts.half ?? (opts.period === 2 ? 'ft' : 'ht')
  return {
    ...sampleFeedAlert(market, half),
    id: `primary-${opts.period}-${opts.min}-0`,
    fixtureId,
    matchLabel: 'Fast vs Score',
    min: opts.min,
    period: opts.period,
    index: 0,
    coincident: false,
    market,
    cornerHalf: market === 'corners' ? half : undefined,
    goalsTally: opts.goals ?? { home: 0, away: 0 },
    cornersTally: opts.corners ?? { home: 0, away: 0 },
    firedAt: new Date().toISOString(),
  }
}

const previousSent = loadSent()
const previousGoalsHt = loadAlerts('goals', 'ht')
const previousGoalsFt = loadAlerts('goals', 'ft')
const previousCornersHt = loadAlerts('corners', 'ht')
const previousCornersFt = loadAlerts('corners', 'ft')
const suppressLogs: string[] = []
const origInfo = console.info
console.info = (...args: unknown[]) => {
  const line = args.map(String).join(' ')
  const match = line.match(
    /suppress (already-hit-fast-score|already-hit-is-goal|already-hit-corner-tally)/,
  )
  if (match) suppressLogs.push(match[1]!)
  origInfo.apply(console, args)
}

let telegramCalls = 0
resetPollerRuntimeForTests()
setPollerSendTelegramForTests(async () => {
  telegramCalls += 1
  return { sent: 1, skipped: false }
})

try {
  seedSokkerProBoardForTests('2026-09-19', board)
  setSokkerProNowForTests(new Date('2026-09-19T15:00:00.000Z'))

  const lateId = `fs-late-${Date.now()}`
  const lateSent = await processEvaluatedAlerts({
    fixture: liveFixture(lateId, { team1: 'Angola U20', team2: 'Swaziland U20' }),
    market: 'goals',
    settings: defaultsFor('goals', 'ft'),
    byHalf: undefined,
    fresh: [
      alertAt(lateId, {
        min: 75,
        period: 2,
        goals: { home: 1, away: 0 },
      }),
    ],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 2, min: 75 }],
  })
  check(lateSent === 0, `SP ahead of SS must not telegram, got ${lateSent}`)
  check(telegramCalls === 0, 'already-hit-fast-score must not call sendTelegram')
  check(suppressLogs.includes('already-hit-fast-score'), 'logs already-hit-fast-score')
  check(getPollerStatus().suppressedAlreadyHit >= 1, 'status.suppressedAlreadyHit increments')
  check(
    getPollerStatus().lastAlreadyHitReason === 'already-hit-fast-score',
    `lastAlreadyHitReason ${getPollerStatus().lastAlreadyHitReason}`,
  )
  check(
    loadAlerts('goals', 'ft').some((a) => a.id === `${lateId}:primary-2-75-0`),
    'late goal alert still ingested for learning',
  )

  const flagId = `fs-flag-${Date.now()}`
  const beforeFlag = telegramCalls
  const flagSent = await processEvaluatedAlerts({
    fixture: liveFixture(flagId, {
      team1: 'Welwyn Garden City',
      team2: 'Stotfold FC',
    }, 1_789_826_400),
    market: 'goals',
    settings: defaultsFor('goals', 'ht'),
    byHalf: undefined,
    fresh: [
      alertAt(flagId, {
        min: 29,
        period: 1,
        goals: { home: 1, away: 0 },
        half: 'ht',
      }),
    ],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 1, min: 29 }],
  })
  check(flagSent === 0, `is_goal same minute blocked, got ${flagSent}`)
  check(telegramCalls === beforeFlag, 'already-hit-is-goal must not telegram')
  check(suppressLogs.includes('already-hit-is-goal'), 'logs already-hit-is-goal')

  const okId = `fs-ok-${Date.now()}`
  const beforeOk = telegramCalls
  const okSent = await processEvaluatedAlerts({
    fixture: liveFixture(okId, { team1: 'Sudan U20', team2: 'Uganda U20' }),
    market: 'goals',
    settings: defaultsFor('goals', 'ft'),
    byHalf: undefined,
    fresh: [
      alertAt(okId, {
        min: 72,
        period: 2,
        goals: { home: 0, away: 1 },
      }),
    ],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 2, min: 72 }],
  })
  check(okSent === 1, `equal SP/SS and no is_goal still sent, got ${okSent}`)
  check(telegramCalls === beforeOk + 1, 'clean fast-score match still telegrams')

  const missId = `fs-miss-${Date.now()}`
  const beforeMiss = telegramCalls
  const missSent = await processEvaluatedAlerts({
    fixture: liveFixture(missId, { team1: 'Unknown FC', team2: 'Ghost United' }),
    market: 'goals',
    settings: defaultsFor('goals', 'ft'),
    byHalf: undefined,
    fresh: [
      alertAt(missId, {
        min: 75,
        period: 2,
        goals: { home: 0, away: 0 },
      }),
    ],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 2, min: 75 }],
  })
  check(missSent === 1, `unmatched SokkerPro falls through, got ${missSent}`)
  check(telegramCalls === beforeMiss + 1, 'name miss still telegrams')

  setPollerGetFastScoreForTests(() => {
    throw new Error('getFastScore must not run for corners')
  })
  const cornerId = `fs-cn-${Date.now()}`
  const beforeCorner = telegramCalls
  const cornerSent = await processEvaluatedAlerts({
    fixture: liveFixture(cornerId, { team1: 'Angola U20', team2: 'Swaziland U20' }),
    market: 'corners',
    settings: defaultsFor('corners', 'ht'),
    byHalf: {
      ht: defaultsFor('corners', 'ht'),
      ft: defaultsFor('corners', 'ft'),
    },
    fresh: [
      alertAt(cornerId, {
        market: 'corners',
        min: 38,
        period: 1,
        corners: { home: 1, away: 1 },
        half: 'ht',
      }),
    ],
    first: false,
    finished: false,
    payload: cornerPayload,
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  check(cornerSent === 0, `latest SuperScore corners 3>2 blocked, got ${cornerSent}`)
  check(telegramCalls === beforeCorner, 'already-hit-corner-tally must not telegram')
  check(suppressLogs.includes('already-hit-corner-tally'), 'logs already-hit-corner-tally')
  setPollerGetFastScoreForTests(null)

  const refetchId = `fs-cn-refetch-${Date.now()}`
  let refetchCalls = 0
  setPollerCornerRefetchForTests(async () => {
    refetchCalls += 1
    return {
      timeline: [],
      events: [
        { type: 14, side: 1, min: 34, period: 1 },
        { type: 14, side: 1, min: 40, period: 1 },
      ],
    }
  })
  const beforeRefetch = telegramCalls
  const refetchSent = await processEvaluatedAlerts({
    fixture: liveFixture(refetchId, { team1: 'RoPo', team2: 'Villan Pojat' }),
    market: 'corners',
    settings: defaultsFor('corners', 'ht'),
    byHalf: {
      ht: defaultsFor('corners', 'ht'),
      ft: defaultsFor('corners', 'ft'),
    },
    fresh: [
      alertAt(refetchId, {
        market: 'corners',
        min: 38,
        period: 1,
        corners: { home: 1, away: 0 },
        half: 'ht',
      }),
    ],
    first: false,
    finished: false,
    payload: { timeline: [], events: [{ type: 14, side: 1, min: 34, period: 1 }] },
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  check(refetchCalls === 1, `optional corner refetch ran once, got ${refetchCalls}`)
  check(refetchSent === 0, `refetch tally 2>1 blocked, got ${refetchSent}`)
  check(telegramCalls === beforeRefetch, 'refetch already-hit must not telegram')
  setPollerCornerRefetchForTests(null)

  const failOpenId = `fs-failopen-${Date.now()}`
  setPollerGetFastScoreForTests(() => null)
  const beforeFailOpen = telegramCalls
  const failOpenSent = await processEvaluatedAlerts({
    fixture: liveFixture(failOpenId, { team1: 'Angola U20', team2: 'Swaziland U20' }),
    market: 'goals',
    settings: defaultsFor('goals', 'ft'),
    byHalf: undefined,
    fresh: [
      alertAt(failOpenId, {
        min: 75,
        period: 2,
        goals: { home: 0, away: 0 },
      }),
    ],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 2, min: 75 }],
  })
  check(failOpenSent === 1, `SokkerPro unavailable must not block, got ${failOpenSent}`)
  check(telegramCalls === beforeFailOpen + 1, 'fail-open still telegrams')
  setPollerGetFastScoreForTests(null)

  check(!webPushEnabled(), 'Web Push stays dormant')
  check(DEFINITIONS_LOCKED, 'definitions stay locked')
  check(GOAL_WINDOWS.ht.from === 20 && GOAL_WINDOWS.ht.to === 42, 'goals HT 20–42 unchanged')
  check(GOAL_WINDOWS.ft.from === 70 && GOAL_WINDOWS.ft.to === 90, 'goals FT 70–90 unchanged')
  check(GOAL_WINDOWS.ft.to === REGULATION_END[2], 'FT goals still ends at 90')
  check(
    CORNER_WINDOWS.ht.from === 32 && CORNER_WINDOWS.ht.to === 42,
    'corners HT 32–42 unchanged',
  )
  check(
    CORNER_WINDOWS.ft.from === 82 && CORNER_WINDOWS.ft.to === 87,
    'corners FT 82–87 unchanged',
  )
  check(MIN_NOTIFY_LEAD_MIN === 1, 'notify lead floor unchanged')
  check(
    defaultsFor('goals', 'ht').spikeThreshold === 80,
    'goals HT Spike threshold unchanged',
  )
} finally {
  console.info = origInfo
  setPollerSendTelegramForTests(null)
  setPollerGetFastScoreForTests(null)
  setPollerCornerRefetchForTests(null)
  resetPollerRuntimeForTests()
  resetSokkerProStateForTests()
  saveSent(previousSent)
  saveAlerts(previousGoalsHt, 'goals', 'ht')
  saveAlerts(previousGoalsFt, 'goals', 'ft')
  saveAlerts(previousCornersHt, 'corners', 'ht')
  saveAlerts(previousCornersFt, 'corners', 'ft')
}

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log(
  'OK: SokkerPro fast score matches sample board; already-hit-fast-score / is-goal / corner-tally; fail-open; windows+push unchanged',
)
