/**
 * League hit-rate line on Telegram alerts (offline, mocked Bot API):
 * - ≥3 settled non-VOID alerts of league+market ⇒ `📊 Uruguai · Liga X (golos): 4/6 · 67 %`
 *   before "Abrir no monitor"; <3 ⇒ no line;
 * - VOID / unsettled / coincident excluded, current alert excluded;
 * - goals and corners separate, HT+FT together, league key = follow-up key;
 * - index updates on settle / VOID / removal, and the line survives the
 *   odds and result edits (it is part of the base text);
 * - the lookup is cheap (timed).
 *
 * TELEGRAM_LEAGUE_STATS=0 makes it fail (no line).
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-telegram-league-stats'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'
delete process.env.TELEGRAM_ENABLED
delete process.env.WEB_PUSH_ENABLED
delete process.env.TELEGRAM_LEAGUE_STATS_MIN
process.env.QUALITY_OVERLAY = 'off'
process.env.VOID_CHECK = '0'

type FeedAlert = import('../src/lib/types.ts').FeedAlert
type Fixture = import('../src/lib/types.ts').Fixture
type LoggedAlert = import('../server/types.ts').LoggedAlert

const poller = await import('../server/poller.ts')
const store = await import('../server/store.ts')
const tips = await import('../server/tips.ts')
const telegram = await import('../server/telegram.ts')
const edits = await import('../server/telegramEdits.ts')
const outcomes = await import('../server/telegramOutcomes.ts')
const league = await import('../server/leagueStats.ts')
const { defaultsFor } = await import('../src/lib/market.ts')
const { sampleFeedAlert } = await import('../src/lib/tally.ts')

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

type Call = { method: string; body: Record<string, unknown> }
const calls: Call[] = []
let nextMessageId = 900
telegram.setTelegramFetchForTests(async (input, init) => {
  const method = String(input).split('/').at(-1) ?? ''
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  calls.push({ method, body })
  if (method === 'sendMessage') {
    nextMessageId += 1
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }))
  }
  return new Response(JSON.stringify({ ok: true, result: true }))
})
tips.setAttachOddsForTests(async ({ alerts }) => alerts)

function fixture(id: string, competition: string, category = 'Uruguay'): Fixture {
  return {
    id,
    team1: 'Casa',
    team2: 'Fora',
    team1Id: 'h',
    team2Id: 'a',
    competition,
    category,
    status: 1,
    state: 1,
    dateSeconds: 0,
    liveElapsedSeconds: 38 * 60,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: false,
  }
}

function saveFixture(id: string, competition: string) {
  store.saveMatch({
    fixture: fixture(id, competition),
    payload: { timeline: [], events: [] },
    finished: true,
    updatedAt: new Date().toISOString(),
  })
}

let seq = 0
function logged(
  fixtureId: string,
  outcome: 'green' | 'red' | 'open',
  extra: Partial<LoggedAlert> = {},
): LoggedAlert {
  seq += 1
  const hit = outcome === 'green' ? true : outcome === 'red' ? false : null
  return {
    id: `${fixtureId}:primary-1-${seq}-${seq}`,
    fixtureId,
    matchLabel: 'Casa vs Fora',
    minute: 30,
    period: 1,
    index: seq,
    side: 'home',
    ruleId: 'primary',
    features: { v: 30, delta1: null, sustained: 2 },
    thresholdsSnapshot: {},
    ts: new Date().toISOString(),
    coincident: false,
    hit,
    leadMin: null,
    hit5: hit,
    hitLong: hit,
    longDeadline: 45,
    leadTime5: hit ? 2 : null,
    leadTimeLong: hit ? 2 : null,
    labeledAt: null,
    feedback: null,
    sentPush: false,
    // The league line counts the bet outcome (end of the half), not hit5.
    betOutcome:
      hit === null
        ? undefined
        : {
            status: hit ? 'green' : 'red',
            rule: 'half-end-v1',
            baseline: 0,
            total: hit ? 1 : 0,
            targetPeriod: 1,
            event: hit ? { min: 40, period: 1, side: 'home' } : null,
            endMin: hit ? null : 47,
            reason: hit ? 'event' : 'period-over',
            decidedAt: new Date().toISOString(),
          },
    ...extra,
  }
}

function sendable(fixtureId: string, market: 'goals' | 'corners'): FeedAlert {
  return {
    ...sampleFeedAlert(market, 'ht'),
    id: 'primary-1-36-35',
    fixtureId,
    matchLabel: 'Casa vs Fora',
    min: 36,
    period: 1,
    index: 35,
    side: 'home',
    momentum: 40,
    coincident: false,
    market,
    cornerHalf: 'ht',
    goalsTally: { home: 0, away: 0 },
    cornersTally: { home: 2, away: 2 },
    firedAt: new Date().toISOString(),
    rule: 'primary',
  }
}

async function send(fixtureId: string, competition: string, market: 'goals' | 'corners') {
  const before = calls.length
  const points = [{ period: 1, min: 38 }]
  await poller.processEvaluatedAlerts({
    fixture: fixture(fixtureId, competition),
    market,
    settings: defaultsFor(market, 'ht'),
    byHalf: { ht: defaultsFor(market, 'ht'), ft: defaultsFor(market, 'ft') },
    fresh: [sendable(fixtureId, market)],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points,
  })
  await poller.waitForOddsAttachForTests()
  await edits.waitForTelegramEditsForTests()
  const msg = calls.slice(before).find((c) => c.method === 'sendMessage')
  return String(msg?.body.text ?? '')
}

const leagueLine = (text: string) => text.split('\n').find((l) => l.startsWith('📊')) ?? null

try {
  // ── Seed history (through the store hooks, then boot prime) ─────────────
  for (let i = 1; i <= 8; i += 1) saveFixture(`lx${i}`, 'Liga X')
  saveFixture('ly1', 'Liga Y')
  saveFixture('ly2', ' Liga Y ') // same follow-up key after trim
  saveFixture('lz1', 'Liga Z')
  // Goals Liga X: HT 3 green + 1 red, FT 1 green + 1 red ⇒ 4/6 (halves together)
  store.saveAlerts(
    [
      logged('lx1', 'green'),
      logged('lx2', 'green'),
      logged('lx3', 'green'),
      logged('lx4', 'red'),
      logged('lx5', 'open'), // unsettled → excluded
      logged('lx6', 'green', { void: true, voidReason: 'linha já batida ao enviar' }), // VOID → excluded
      logged('lx7', 'green', { coincident: true }), // coincident → excluded
    ],
    'goals',
    'ht',
  )
  // Corners Liga X: 2/5 ⇒ separate from goals
  store.saveAlerts(
    [logged('lx1', 'green'), logged('lx2', 'red'), logged('lx3', 'red'), logged('lx4', 'green'), logged('lx5', 'red')],
    'corners',
    'ht',
  )
  // Liga Y goals: only 2 settled ⇒ no line
  // (same FT file also holds Liga X FT: 1 green + 1 red)
  store.saveAlerts(
    [logged('lx8', 'green'), logged('lx1', 'red'), logged('ly1', 'green'), logged('ly2', 'red'), logged('ly1', 'open')],
    'goals',
    'ft',
  )
  // Before the boot prime no line is shown (index not ready).
  expect(
    league.leagueLineForAlert({ market: 'goals', fixtureId: 'lx9', competition: 'Liga X', category: 'Uruguay', half: 'ht', alertId: 'lx9:a' }) === null,
    'no line before the index is primed',
  )
  league.resetLeagueStatsForTests()
  await league.primeLeagueStats({ matchesDir: join(dataDir, 'matches'), loadAlerts: store.loadAlerts })
  expect(league.leagueStatsReady(), 'index primed')

  // ── ≥3 ⇒ line with correct numbers; markets separate ────────────────────
  // League key = country + name here (no competition id on these fixtures).
  const X = league.leagueForFixture('lx1')
  const Y = league.leagueForFixture('ly1')
  expect(X === 'cn:uruguay|liga x', `Liga X key is country + name, got ${X}`)
  expect(Y !== null && league.leagueForFixture('ly2') === Y, 'trimmed name → same league key')
  const goalsX = league.leagueStatsFor('goals', X)
  expect(goalsX.green === 4 && goalsX.settled === 6, `goals Liga X 4/6, got ${JSON.stringify(goalsX)}`)
  const cornersX = league.leagueStatsFor('corners', X)
  expect(cornersX.green === 2 && cornersX.settled === 5, `corners Liga X 2/5, got ${JSON.stringify(cornersX)}`)
  const XL = league.leagueLabelFor(X ?? '')
  expect(XL === 'Uruguai · Liga X', `label country · league, got ${XL}`)
  expect(league.formatLeagueLine('goals', goalsX, 3, XL) === '📊 Uruguai · Liga X (golos): 4/6 · 67 %', `goals line, got ${league.formatLeagueLine('goals', goalsX, 3, XL)}`)
  expect(league.formatLeagueLine('corners', cornersX, 3, XL) === '📊 Uruguai · Liga X (cantos): 2/5 · 40 %', 'corners line')

  // ── <3 ⇒ nothing; unknown league ⇒ nothing ──────────────────────────────
  const goalsY = league.leagueStatsFor('goals', Y)
  expect(goalsY.settled === 2, `Liga Y (trimmed key) 2 settled, got ${goalsY.settled}`)
  expect(league.formatLeagueLine('goals', goalsY) === null, '<3 → no line')
  expect(league.formatLeagueLine('corners', league.leagueStatsFor('corners', Y)) === null, 'no corners history → no line')

  // ── Real send: line in the base text before "Abrir no monitor" ──────────
  const text = await send('lx-live', 'Liga X', 'goals')
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.startsWith('📊'))
  expect(leagueLine(text) === '📊 Uruguai · Liga X (golos): 4/6 · 67 %', `goals alert carries the league line, got ${JSON.stringify(text)}`)
  expect(at >= 0 && lines[at + 1]?.includes('Abrir no monitor'), 'league line sits right before "Abrir no monitor"')
  const cornersText = await send('lx-live2', 'Liga X', 'corners')
  expect(leagueLine(cornersText) === '📊 Uruguai · Liga X (cantos): 2/5 · 40 %', `corners alert uses corners stats, got ${leagueLine(cornersText)}`)
  const yText = await send('ly-live', 'Liga Y', 'goals')
  expect(yText.length > 0 && leagueLine(yText) === null, 'Liga Y alert (2 settled) has no league line')
  const zText = await send('lz-live', 'Liga Z', 'goals')
  expect(zText.length > 0 && leagueLine(zText) === null, 'league without history → no line')

  // ── Line survives the odds/result edits (base text) ─────────────────────
  const rec = store.getTelegramMessage('lx-live:primary-1-36-35')
  expect(Boolean(rec?.text?.includes('📊 Uruguai · Liga X (golos): 4/6 · 67 %')), 'stored base text keeps the league line')
  const liveKey = 'lx-live:primary-1-36-35'
  const patched = store.patchLoggedAlert(liveKey, {
    hit5: false,
    hitLong: false,
    longDeadline: 42,
    betOutcome: {
      status: 'red',
      rule: 'half-end-v1',
      baseline: 0,
      total: 0,
      targetPeriod: 1,
      event: null,
      endMin: 48,
      reason: 'period-over',
      decidedAt: new Date().toISOString(),
    },
  })
  expect(Boolean(patched), 'live alert stored')
  const before = calls.length
  outcomes.enqueueTelegramOutcome(liveKey)
  outcomes.scheduleTelegramOutcomeFlush()
  await outcomes.waitForTelegramOutcomesForTests()
  await edits.waitForTelegramEditsForTests()
  const resultEdit = calls.slice(before).find((c) => c.method === 'editMessageText')
  {
    expect(
      Boolean(resultEdit) && String(resultEdit?.body.text).includes('📊 Uruguai · Liga X (golos): 4/6 · 67 %') &&
        String(resultEdit?.body.text).trimEnd().endsWith("<b>🔴 RED</b> · sem golo até ao intervalo (45+3')"),
      `result edit keeps the league line, got ${JSON.stringify(resultEdit?.body.text)}`,
    )
  }

  // ── Current alert excluded; updates on settle / VOID / removal ─────────
  const cur = logged('lx1', 'green')
  const ht = store.loadAlerts('goals', 'ht')
  store.saveAlerts([...ht, cur], 'goals', 'ht')
  const withCur = league.leagueStatsFor('goals', X)
  // the RED settle above also counts (the live alert is stored and settled)
  const expectSettled = goalsX.settled + 1 + 1
  expect(withCur.settled === expectSettled, `settle adds to the sample, got ${JSON.stringify(withCur)} want ${expectSettled}`)
  // A learning label alone (hit5, no bet outcome) is not a settled bet.
  const labelOnly = logged('lx1', 'green', { betOutcome: undefined })
  store.saveAlerts([...store.loadAlerts('goals', 'ht'), labelOnly], 'goals', 'ht')
  expect(league.leagueStatsFor('goals', X).settled === withCur.settled, 'hit5 without betOutcome is not counted')
  store.saveAlerts(store.loadAlerts('goals', 'ht').filter((a) => a.id !== labelOnly.id), 'goals', 'ht')
  const excl = league.leagueStatsFor('goals', X, league.leagueContribKey('goals', 'ht', cur.id))
  expect(excl.settled === withCur.settled - 1 && excl.green === withCur.green - 1, 'current alert excluded from its own line')
  store.saveAlerts(store.loadAlerts('goals', 'ht').map((a) => (a.id === cur.id ? { ...a, void: true } : a)), 'goals', 'ht')
  expect(league.leagueStatsFor('goals', X).settled === withCur.settled - 1, 'VOID later removes it from the sample')
  store.saveAlerts(store.loadAlerts('goals', 'ht').filter((a) => a.fixtureId !== 'lx2'), 'goals', 'ht')
  expect(league.leagueStatsFor('goals', X).settled === withCur.settled - 2, 'removed alerts leave the sample')
  store.saveAlerts([], 'goals', 'ht')
  store.saveAlerts([], 'goals', 'ft')
  expect(league.leagueStatsFor('goals', X).settled === 0, 'learn reset empties the goals sample')
  expect(league.leagueStatsFor('corners', X).settled === 5, 'corners untouched by goals reset')

  // ── League learned later (alert saved before its match snapshot) ────────
  store.saveAlerts([logged('late1', 'green'), logged('late1', 'green'), logged('late1', 'red')], 'goals', 'ht')
  expect(league.leagueForFixture('late1') === null, 'unknown league waits')
  saveFixture('late1', 'Liga W')
  const w = league.leagueStatsFor('goals', league.leagueForFixture('late1'))
  expect(w.settled === 3 && w.green === 2, `resolved once the fixture league is known, got ${JSON.stringify(w)}`)

  // ── Cost: 10k alerts observe + 10k lookups ──────────────────────────────
  league.resetLeagueStatsForTests({ primed: true })
  for (let i = 0; i < 200; i += 1) league.noteFixtureLeague(`p${i}`, { competition: `Liga ${i % 40}`, category: 'Chile' })
  const big = Array.from({ length: 10_000 }, (_, i) => logged(`p${i % 200}`, i % 3 === 0 ? 'green' : i % 5 === 0 ? 'open' : 'red'))
  let t = performance.now()
  league.observeAlerts(big, 'corners', 'ht')
  const firstMs = performance.now() - t
  t = performance.now()
  league.observeAlerts(big, 'corners', 'ht')
  const againMs = performance.now() - t
  t = performance.now()
  for (let i = 0; i < 10_000; i += 1) {
    league.leagueLineForAlert({ market: 'corners', fixtureId: `p${i % 200}`, competition: `Liga ${i % 40}`, category: 'Chile', half: 'ht', alertId: 'x' })
  }
  const lookupUs = ((performance.now() - t) * 1000) / 10_000
  console.log(`cost: observe 10k first ${firstMs.toFixed(1)} ms, re-observe ${againMs.toFixed(1)} ms, lookup ${lookupUs.toFixed(2)} µs`)
  expect(againMs < 100, `re-observe 10k alerts under 100 ms, got ${againMs}`)
  expect(lookupUs < 200, `lookup under 200 µs, got ${lookupUs}`)
} finally {
  telegram.setTelegramFetchForTests(null)
  tips.setAttachOddsForTests(null)
}

if (fails.length) {
  console.error(`FAIL (${fails.length})`)
  for (const f of fails) console.error(` - ${f}`)
  process.exit(1)
}
console.log('OK: league line ≥3 settled (4/6 · 67 %), <3 none, VOID/unsettled/coincident/current excluded, markets separate, halves together, survives edits, cheap lookup')
process.exit(0)
