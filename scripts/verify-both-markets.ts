/**
 * Both markets every tick: one live match fires a goals AND a corners alert
 * with the same rule-level id in the same tick. Both must be delivered to
 * Telegram, stored, tipped and settled independently, regardless of the UI
 * view preference in data/market.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-both-markets'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
// Production had corners selected for a week: the view must not matter.
writeFileSync(join(dataDir, 'market.json'), JSON.stringify({ market: 'corners' }))
process.env.DATA_DIR = REL_DATA
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'
delete process.env.TELEGRAM_ENABLED
delete process.env.WEB_PUSH_ENABLED
delete process.env.POLLER_ENABLED

type Fixture = import('../src/lib/types.ts').Fixture
type FeedAlert = import('../src/lib/types.ts').FeedAlert
type MomentumPayload = import('../src/lib/types.ts').MomentumPayload

const poller = await import('../server/poller.ts')
const store = await import('../server/store.ts')
const tips = await import('../server/tips.ts')
const telegram = await import('../server/telegram.ts')
const outcomes = await import('../server/telegramOutcomes.ts')
const { currentSettings } = await import('../server/learn.ts')
const { defaultsFor } = await import('../src/lib/market.ts')

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

const FID = 'both-markets-fixture'
const ALERT = 'primary-1-38-37'

function fixture(finished = false): Fixture {
  return {
    id: FID,
    team1: 'Home FC',
    team2: 'Away FC',
    team1Id: 'h',
    team2Id: 'a',
    competition: 'Both Markets League',
    category: 'test',
    status: finished ? 100 : 1,
    state: finished ? 2 : 1,
    dateSeconds: 0,
    liveElapsedSeconds: finished ? null : 38 * 60,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: finished,
  }
}

/**
 * P1 1'..38': flat, then 37' = +25 and 38' = +95 (Δ70). At 38':
 * goals HT primary Combo (Spike80 ∧ Swing50) and corners HT primary
 * Sustained (|v|≥20 ×2) both fire → same id `primary-1-38-37`.
 * Both also pass the quality overlay (default on): goals HT |v|95≥85 ∧
 * |Δ1|70≥70 at 0-0; corners HT minute 38 ≤ 38.
 */
function payload(upTo: number, cornerAt40 = false): MomentumPayload {
  const timeline = []
  for (let min = 1; min <= upTo; min += 1) {
    const value = min === 37 ? 25 : min === 38 ? 95 : 0
    timeline.push({ min, period: min <= 45 ? 1 : 2, value: { value } })
  }
  return {
    timeline,
    events: cornerAt40 ? [{ type: 14, side: 1, min: 40, period: 1 }] : [],
  }
}

let current = payload(30)
let currentFixture = fixture()
const calls: { method: string; body: Record<string, unknown> }[] = []
let nextMessageId = 500

try {
  // The locked definitions are the ones in use (nothing changed here).
  for (const m of ['goals', 'corners'] as const) {
    for (const h of ['ht', 'ft'] as const) {
      const s = currentSettings(m, h)
      const d = defaultsFor(m, h)
      expect(
        s.spikeThreshold === d.spikeThreshold &&
          s.primaryKind === d.primaryKind &&
          s.sustainedSecondaryMinutes === d.sustainedSecondaryMinutes,
        `${m} ${h} locked defaults in use`,
      )
    }
  }

  poller.resetPollerRuntimeForTests()
  telegram.resetTelegramStatusForTests()
  outcomes.resetTelegramOutcomesForTests()
  telegram.setTelegramFetchForTests(async (input, init) => {
    const method = String(input).split('/').at(-1) ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })
    nextMessageId += 1
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: nextMessageId } }),
      { status: 200 },
    )
  })
  tips.setAttachOddsForTests(async ({ alerts }) =>
    alerts.map((alert: FeedAlert) => ({
      ...alert,
      odds: {
        ts: alert.firedAt,
        fixtureId: FID,
        matchLabel: alert.matchLabel,
        league: 'Both Markets League',
        market: alert.market ?? 'goals',
        half: 'ht',
        bucket: alert.market === 'corners' ? 'corners_ht' : 'goals_ht',
        minute: alert.min,
        period: alert.period,
        alertId: alert.id,
        currentTotal: 0,
        source: 'robobet',
        sourceLabel: 'RoboBet · teste',
        limit: null,
        asian: null,
        robobet: { odd: alert.market === 'corners' ? 2.1 : 1.9, line: 0.5 },
      } as FeedAlert['odds'],
    })),
  )
  poller.setPollerDepsForTests({
    fetchFixtures: async () => [currentFixture],
    warmup: async () => undefined,
    fetchMomentum: async () => current,
  })

  // Tick 1 — first sight primes both markets, no push.
  await poller.tick()
  expect(store.isPrimed(FID), 'goals primed on first sight')
  expect(store.isPrimed(`corners:${FID}`), 'corners primed on first sight')
  expect(calls.length === 0, `no send on first sight, got ${calls.length}`)

  // Tick 2 — both markets fire primary-1-38-37 in the same tick.
  current = payload(38)
  await poller.tick()
  await poller.waitForOddsAttachForTests()
  const sends = calls.filter((c) => c.method === 'sendMessage')
  expect(sends.length === 2, `two Telegram alerts (goal + corner), got ${sends.length}`)
  const texts = sends.map((c) => String(c.body.text))
  expect(texts.some((t) => t.startsWith('<b>Golo')), 'goal alert delivered')
  expect(texts.some((t) => t.startsWith('<b>Canto')), 'corner alert delivered')
  expect(texts.every((t) => t.split('\n')[1] === '✅ Filtro'), 'both alerts carry the ✅ Filtro line')
  const callbacks = sends.map(
    (c) =>
      (c.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
        .inline_keyboard[0]![0]!.callback_data,
  )
  expect(callbacks.includes(`rn:${FID}:${ALERT}`), `goals callback legacy key, got ${callbacks}`)
  expect(callbacks.includes(`rn:corners:${FID}:${ALERT}`), `corners callback qualified, got ${callbacks}`)
  expect(poller.getPollerStatus().alertsSent === 2, `status.alertsSent 2, got ${poller.getPollerStatus().alertsSent}`)

  const map = store.loadTelegramMessages()
  const gRec = map[`${FID}:${ALERT}`]
  const cRec = map[`corners:${FID}:${ALERT}`]
  expect(Boolean(gRec && cRec), 'one Telegram record per market')
  expect(gRec?.market === 'goals' && cRec?.market === 'corners', 'records carry market')
  expect(gRec?.messageId !== cRec?.messageId, 'distinct message ids')

  const gAlert = store.loadAlerts('goals', 'ht').find((a) => a.id === `${FID}:${ALERT}`)
  const cAlert = store.loadAlerts('corners', 'ht').find((a) => a.id === `${FID}:${ALERT}`)
  expect(Boolean(gAlert?.sentPush) && gAlert?.telegramMessageId === gRec?.messageId, 'goals alert stored + linked to its message')
  expect(Boolean(cAlert?.sentPush) && cAlert?.telegramMessageId === cRec?.messageId, 'corners alert stored + linked to its message')
  const sent = store.loadSent()
  expect(sent.includes(`${FID}:${ALERT}`), 'goals sent key')
  expect(sent.includes(`corners:ht:${FID}:${ALERT}`), 'corners sent key')

  const openTips = store.loadTips().filter((t) => t.fixtureId === FID)
  expect(openTips.length === 2, `one tip per market, got ${openTips.length}`)
  expect(openTips.some((t) => t.id === `tip-${FID}-${ALERT}` && t.market === 'goals'), 'goals tip')
  expect(openTips.some((t) => t.id === `tip-corners-${FID}-${ALERT}` && t.market === 'corners'), 'corners tip')

  // Tick 3 — same snapshot again: sent keys block re-sends in both markets.
  await poller.tick()
  await poller.waitForOddsAttachForTests()
  expect(calls.filter((c) => c.method === 'sendMessage').length === 2, 'no duplicate sends on re-tick')

  // Tick 4 — full time: a corner at 40' (lead 2) and no goal.
  // Corners → GREEN, goals → RED, each replied to its own message.
  current = payload(90, true)
  currentFixture = fixture(true)
  await poller.tick()
  await poller.waitForOddsAttachForTests()
  await outcomes.waitForTelegramOutcomesForTests()

  const gDone = store.loadAlerts('goals', 'ht').find((a) => a.id === `${FID}:${ALERT}`)
  const cDone = store.loadAlerts('corners', 'ht').find((a) => a.id === `${FID}:${ALERT}`)
  expect(gDone?.hit5 === false, `goals alert settled RED, got ${gDone?.hit5}`)
  expect(cDone?.hit5 === true, `corners alert settled GREEN, got ${cDone?.hit5}`)
  expect(store.loadGoals('corners', 'ht').some((g) => g.fixtureId === FID && g.min === 40), 'corner event learned (corners store)')
  expect(!store.loadGoals('goals', 'ht').some((g) => g.fixtureId === FID), 'no goal event in goals store')

  const outcomeSends = calls.slice(2).filter((c) => c.method === 'sendMessage')
  const red = outcomeSends.find((c) => String(c.body.text).includes('RED'))
  const green = outcomeSends.find((c) => String(c.body.text).includes('GREEN'))
  expect(outcomeSends.length === 2, `two outcome notices, got ${outcomeSends.length}`)
  expect(Boolean(red && String(red.body.text).includes('Golo')), 'RED is the goals outcome')
  expect(Boolean(green && String(green.body.text).includes('Canto')), 'GREEN is the corners outcome')
  expect(red?.body.reply_to_message_id === gRec?.messageId, 'RED replies to the goals message')
  expect(green?.body.reply_to_message_id === cRec?.messageId, 'GREEN replies to the corners message')

  const settledTips = store.loadTips().filter((t) => t.fixtureId === FID)
  expect(settledTips.find((t) => t.market === 'corners')?.status === 'won', 'corners tip won')
  expect(settledTips.find((t) => t.market === 'goals')?.status === 'lost', 'goals tip lost')

  // View preference stays whatever the UI set; it did not gate anything.
  expect(store.loadActiveMarket() === 'corners', 'market.json untouched by the poller')
} finally {
  poller.resetPollerRuntimeForTests()
  telegram.setTelegramFetchForTests(null)
  tips.setAttachOddsForTests(null)
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-both-markets')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log(
  'OK: goals + corners evaluated every tick (view=corners), same-id alerts delivered, tipped and settled independently (RED goals / GREEN corners)',
)
