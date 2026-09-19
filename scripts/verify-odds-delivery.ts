import { defaultsFor } from '../src/lib/market.ts'
import { composeOddsObservation, type OddsObservation } from '../src/lib/oddsObserve.ts'
import { sampleFeedAlert } from '../src/lib/tally.ts'
import type { FeedAlert, Fixture } from '../src/lib/types.ts'
import {
  processEvaluatedAlerts,
  setPollerSendPushForTests,
  waitForOddsAttachForTests,
} from '../server/poller.ts'
import {
  loadAlerts,
  loadSent,
  loadTips,
  saveAlerts,
  saveSent,
  saveTips,
  sentKey,
} from '../server/store.ts'
import { setAttachOddsForTests } from '../server/tips.ts'

const fail: string[] = []

function check(cond: boolean, msg: string) {
  if (!cond) fail.push(msg)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function testFixture(id: string): Fixture {
  return {
    id,
    team1: 'Home FC',
    team2: 'Away FC',
    team1Id: 'h',
    team2Id: 'a',
    competition: 'Odds Sep Test',
    category: 'test',
    status: 1,
    state: 1,
    dateSeconds: 0,
    liveElapsedSeconds: 2000,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: false,
  }
}

function testAlert(fixtureId: string, id: string): FeedAlert {
  return {
    ...sampleFeedAlert('goals'),
    id,
    fixtureId,
    matchLabel: 'Home FC vs Away FC',
    coincident: false,
    market: 'goals',
    firedAt: new Date().toISOString(),
  }
}

function ssObservation(alert: FeedAlert, fixture: Fixture): OddsObservation {
  return composeOddsObservation({
    partial: {
      ts: alert.firedAt,
      fixtureId: fixture.id,
      matchLabel: alert.matchLabel,
      league: fixture.competition,
      market: 'goals',
      half: 'ft',
      minute: alert.min,
      period: alert.period,
      alertId: alert.id,
      currentTotal: 0,
    },
    limit: {
      kind: 'limit',
      marketName: 'Over/Under 0.5',
      line: 0.5,
      prices: [{ name: 'Over', price: 1.85, line: 0.5, side: 'over' }],
    },
    asian: null,
    sokkerpro: null,
    robobet: null,
  })
}

const previousSent = loadSent()
const previousTips = loadTips()
const previousAlerts = loadAlerts('goals')
const fixtureId = `odds-sep-${Date.now()}`
const alertId = `primary-1-38-0`
const loggedId = `${fixtureId}:${alertId}`
const fixture = testFixture(fixtureId)
const fresh = [testAlert(fixtureId, alertId)]
const settings = defaultsFor('goals')
const payload = { timeline: [], events: [] }

let pushCount = 0
let oddsResolved = false
let pushBeforeOdds = false

try {
  setPollerSendPushForTests(async () => {
    pushCount += 1
    pushBeforeOdds = !oddsResolved
    const openTips = loadTips().filter((t) => t.fixtureId === fixtureId)
    check(openTips.length === 0, 'tip must not open before odds resolve')
    return { sent: 1, removed: 0, attempted: 1, errors: [] }
  })
  setAttachOddsForTests(async (args) => {
    await delay(60)
    oddsResolved = true
    return args.alerts.map((alert) => ({
      ...alert,
      odds: ssObservation(alert, args.fixture),
    }))
  })

  const sent = await processEvaluatedAlerts({
    fixture,
    market: 'goals',
    settings,
    byHalf: undefined,
    fresh,
    first: false,
    finished: false,
    payload,
    events: [],
    points: [{ period: 1, min: 38 }],
  })

  check(sent === 1, `first push sent count, got ${sent}`)
  check(pushCount === 1, `push once before odds, got ${pushCount}`)
  check(pushBeforeOdds, 'push must not wait for SuperScore/SokkerPro HTTP')
  check(!oddsResolved, 'processEvaluatedAlerts must return before odds attach finishes')
  check(
    loadTips().filter((t) => t.fixtureId === fixtureId).length === 0,
    'no tip until resolved odd exists',
  )
  check(
    loadSent().includes(sentKey('goals', fixtureId, alertId)),
    'sent key marked immediately',
  )

  await waitForOddsAttachForTests()
  check(oddsResolved, 'odds attach eventually runs')
  check(pushCount === 1, `async odds must not push again, got ${pushCount}`)
  const stored = loadAlerts('goals').find((a) => a.id === loggedId)
  check(stored?.odds?.source === 'superscore', 'stored alert gets odds after attach')
  const tip = loadTips().find((t) => t.fixtureId === fixtureId && t.alertId === alertId)
  check(Boolean(tip), 'tip opens only after resolved odd')
  check(tip?.odd === 1.85, `tip odd 1.85, got ${tip?.odd}`)
  check(tip?.source === 'superscore', `tip source superscore, got ${tip?.source}`)

  const sentAgain = await processEvaluatedAlerts({
    fixture,
    market: 'goals',
    settings,
    byHalf: undefined,
    fresh,
    first: false,
    finished: false,
    payload,
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await waitForOddsAttachForTests()
  check(sentAgain === 0, `second tick must not send, got ${sentAgain}`)
  check(pushCount === 1, `sent keys dedupe async enrich, got ${pushCount}`)
  check(
    loadTips().filter((t) => t.fixtureId === fixtureId && t.alertId === alertId).length === 1,
    'async enrich must not duplicate tips',
  )

  const primedId = `odds-sep-prime-${Date.now()}`
  const primedAlert = testAlert(primedId, alertId)
  const primedPushesBefore = pushCount
  const primedSent = await processEvaluatedAlerts({
    fixture: testFixture(primedId),
    market: 'goals',
    settings,
    byHalf: undefined,
    fresh: [primedAlert],
    first: true,
    finished: false,
    payload,
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await waitForOddsAttachForTests()
  check(primedSent === 0, 'first/prime tick does not push')
  check(pushCount === primedPushesBefore, 'first/prime tick must not call sendPush')
  check(
    loadTips().filter((t) => t.fixtureId === primedId).length === 0,
    'primed alerts do not open tips',
  )

  const lateId = `odds-sep-late-${Date.now()}`
  const lateAlert = {
    ...testAlert(lateId, 'primary-2-96-0'),
    id: 'primary-2-96-0',
    min: 96,
    period: 2,
  }
  const lateBefore = pushCount
  const lateSent = await processEvaluatedAlerts({
    fixture: testFixture(lateId),
    market: 'goals',
    settings,
    byHalf: undefined,
    fresh: [lateAlert],
    first: false,
    finished: false,
    payload,
    events: [],
    points: [{ period: 2, min: 96 }],
  })
  await waitForOddsAttachForTests()
  check(lateSent === 0, `96' stoppage must not push, got ${lateSent}`)
  check(pushCount === lateBefore, '96\' stoppage must not call sendPush')
} finally {
  setPollerSendPushForTests(null)
  setAttachOddsForTests(null)
  saveSent(previousSent)
  saveTips(previousTips)
  saveAlerts(previousAlerts, 'goals')
}

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log(
  'OK: push does not wait for odds HTTP, sent keys block double-send, tips open after odd',
)
