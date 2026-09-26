/**
 * Quality overlay (notification filter on top of the locked rules):
 *  - unit: each rule (corners HT ≤38', goals HT Spike85∧(Swing70∨Sust4@30)
 *    ∧ |diff|≤1, FT pressing side not winning / side-unknown), env switch;
 *  - poller: base alerts still stored + settled when blocked, one notified
 *    per match×market×half (derived from stored alerts, survives restart),
 *    markets independent, "✅ Filtro" line, QUALITY_OVERLAY=off sends all.
 * Locked definitions are asserted unchanged.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-quality-overlay'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
writeFileSync(join(dataDir, 'market.json'), JSON.stringify({ market: 'corners' }))
process.env.DATA_DIR = REL_DATA
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'
delete process.env.TELEGRAM_ENABLED
delete process.env.WEB_PUSH_ENABLED
delete process.env.POLLER_ENABLED
delete process.env.QUALITY_OVERLAY

type Fixture = import('../src/lib/types.ts').Fixture
type FeedAlert = import('../src/lib/types.ts').FeedAlert
type MomentumPayload = import('../src/lib/types.ts').MomentumPayload

const Q = await import('../src/lib/qualityOverlay.ts')
const { defaultsFor } = await import('../src/lib/market.ts')
const { CORNER_WINDOWS, GOAL_WINDOWS } = await import('../src/lib/windows.ts')
const poller = await import('../server/poller.ts')
const store = await import('../server/store.ts')
const tips = await import('../server/tips.ts')
const telegram = await import('../server/telegram.ts')
const outcomes = await import('../server/telegramOutcomes.ts')
const qo = await import('../server/qualityOverlay.ts')

const fails: string[] = []
const expect = (cond: boolean, msg: string) => {
  if (!cond) fails.push(msg)
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── Locked definitions untouched ───────────────────────────────────────────
{
  const g = defaultsFor('goals', 'ht')
  const gf = defaultsFor('goals', 'ft')
  const ch = defaultsFor('corners', 'ht')
  const cf = defaultsFor('corners', 'ft')
  expect(
    g.primaryKind === 'combo' && g.spikeThreshold === 80 && g.swingComboThreshold === 50 &&
      g.sustainedThreshold === 30 && g.sustainedComboMinutes === 3 && gf.spikeThreshold === 80,
    'goals locked Primary unchanged (Spike80 ∧ (Swing50 ∨ Sust3@30))',
  )
  expect(
    ch.primaryKind === 'sustained' && ch.sustainedSecondaryThreshold === 20 && ch.sustainedSecondaryMinutes === 2,
    'corners HT locked Primary unchanged (Sust 2@20)',
  )
  expect(cf.primaryKind === 'combo' && cf.spikeThreshold === 80, 'corners FT locked Primary unchanged')
  expect(
    GOAL_WINDOWS.ht.from === 20 && GOAL_WINDOWS.ht.to === 42 && GOAL_WINDOWS.ft.from === 70 &&
      GOAL_WINDOWS.ft.to === 90 && CORNER_WINDOWS.ht.from === 32 && CORNER_WINDOWS.ht.to === 42 &&
      CORNER_WINDOWS.ft.from === 82 && CORNER_WINDOWS.ft.to === 87,
    'windows unchanged',
  )
}

// ── Unit: rules ────────────────────────────────────────────────────────────
const base = {
  rule: 'primary' as const,
  side: 'home' as const,
  momentum: 90,
  delta1: 75,
  sustainedLength: 1,
  goalsTally: { home: 0, away: 0 },
}
const R = Q.OVERLAY_REASON
const reasons = (over: Partial<Parameters<typeof Q.overlayRuleReasons>[0]>) =>
  Q.overlayRuleReasons({ market: 'goals', half: 'ht', min: 30, ...base, ...over })

// Corners HT: minute ≤ 38 only (momentum/score irrelevant).
expect(eq(reasons({ market: 'corners', min: 32, momentum: 20, delta1: 0 }), []), 'corners HT 32 passes')
expect(eq(reasons({ market: 'corners', min: 38 }), []), 'corners HT 38 passes')
expect(eq(reasons({ market: 'corners', min: 39 }), [R.cornersHtLate]), 'corners HT 39 blocked')
expect(eq(reasons({ market: 'corners', min: 42, goalsTally: { home: 3, away: 0 } }), [R.cornersHtLate]), 'corners HT 42 blocked')

// Goals HT: Spike≥85 ∧ (Swing≥70 ∨ Sustained ≥4 @30) ∧ |diff| ≤ 1.
expect(eq(reasons({ momentum: 85, delta1: 70 }), []), 'goals HT 85/Δ70 passes (inclusive)')
expect(eq(reasons({ momentum: -92, delta1: -71, side: 'away' }), []), 'goals HT away uses |v|, |Δ1|')
expect(eq(reasons({ momentum: 84, delta1: 80 }), [R.goalsHtSpike]), 'goals HT |v|84 blocked')
expect(eq(reasons({ momentum: 90, delta1: 69, sustainedLength: 3 }), [R.goalsHtNoSwingOrSustained]), 'goals HT Δ69 + sust3 blocked')
expect(eq(reasons({ momentum: 90, delta1: 10, sustainedLength: 4 }), []), 'goals HT sust4 passes without swing')
expect(eq(reasons({ momentum: 90, delta1: null, sustainedLength: 4 }), []), 'goals HT null Δ1 + sust4 passes')
expect(eq(reasons({ goalsTally: { home: 1, away: 0 } }), []), 'goals HT 1-0 passes')
expect(eq(reasons({ goalsTally: { home: 0, away: 2 } }), [R.goalDiff]), 'goals HT 0-2 blocked')
expect(eq(reasons({ goalsTally: null }), [R.scoreUnknown]), 'goals HT unknown score blocked')
expect(
  eq(reasons({ momentum: 80, delta1: 50, sustainedLength: 3, goalsTally: { home: 2, away: 0 } }), [
    R.goalsHtSpike,
    R.goalsHtNoSwingOrSustained,
    R.goalDiff,
  ]),
  'goals HT lists every failed condition',
)

// FT goals + FT corners: pressing side not winning.
for (const market of ['goals', 'corners'] as const) {
  const ft = (over: Partial<Parameters<typeof Q.overlayRuleReasons>[0]>) =>
    reasons({ market, half: 'ft', min: market === 'goals' ? 80 : 84, momentum: 60, delta1: 5, ...over })
  expect(eq(ft({ goalsTally: { home: 0, away: 0 } }), []), `${market} FT draw passes`)
  expect(eq(ft({ goalsTally: { home: 0, away: 1 } }), []), `${market} FT home pressing while losing passes`)
  expect(eq(ft({ goalsTally: { home: 2, away: 1 } }), [R.pressingSideWinning]), `${market} FT home pressing while winning blocked`)
  expect(eq(ft({ side: 'away', goalsTally: { home: 2, away: 1 } }), []), `${market} FT away pressing while losing passes`)
  expect(eq(ft({ side: 'away', goalsTally: { home: 0, away: 1 } }), [R.pressingSideWinning]), `${market} FT away pressing while winning blocked`)
  expect(eq(ft({ side: null }), [R.sideUnknown]), `${market} FT side unknown → side-unknown`)
  expect(eq(ft({ goalsTally: null }), [R.scoreUnknown]), `${market} FT unknown score blocked`)
}
expect(eq(reasons({ rule: 'secondary' }), [R.notPrimary]), 'non-Primary never notified by the overlay')

const d = Q.overlayDecision({ market: 'corners', half: 'ht', min: 39, ...base }, true)
expect(d.version === Q.QUALITY_OVERLAY_VERSION && d.pass === false && d.enforced === true, 'decision shape')
const capped = Q.withCapReason({ version: 'v', pass: true, reasons: [], enforced: true })
expect(capped.pass === false && eq(capped.reasons, [R.cap]), 'cap reason')

// Env switch.
for (const v of [undefined, '', 'on', 'ON', '1', 'true', 'yes']) expect(Q.parseQualityOverlayEnv(v) === true, `QUALITY_OVERLAY=${v} → on`)
for (const v of ['off', 'OFF', '0', 'false', 'no', 'disabled']) expect(Q.parseQualityOverlayEnv(v) === false, `QUALITY_OVERLAY=${v} → off`)
process.env.QUALITY_OVERLAY = 'off'
expect(qo.qualityOverlayEnabled() === false, 'server reads QUALITY_OVERLAY live (off)')
delete process.env.QUALITY_OVERLAY
expect(qo.qualityOverlayEnabled() === true, 'server default on')

// ── Poller integration ─────────────────────────────────────────────────────
function fixture(id: string, upTo: number, finished = false): Fixture {
  return {
    id,
    team1: 'Home FC',
    team2: 'Away FC',
    team1Id: 'h',
    team2Id: 'a',
    competition: 'Overlay League',
    category: 'test',
    status: finished ? 100 : 1,
    state: finished ? 2 : 1,
    dateSeconds: 0,
    liveElapsedSeconds: finished ? null : upTo * 60,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: finished,
  }
}

/**
 * Goals HT (20–42): 25' +95 (Δ90) pass → notified; 28' +95 pass → capped;
 * 30' +82 (base fires, |v|<85) → blocked; [restart] 34' +96 pass → capped.
 * Corners HT: 36'/37' +30 → Sustained 2@20 at 37' → passes (≤38) → notified.
 * Home scores at 31'. Goals FT (70–90): 75' +95 home pressing at 1-0 →
 * blocked (winning); 78' −95 away pressing → notified; 81' −95 → capped.
 */
const VALUES: Record<number, number> = {
  24: 5, 25: 95, 27: 10, 28: 95, 29: 0, 30: 82, 33: 0, 34: 96, 36: 30, 37: 30,
  74: 0, 75: 95, 77: 0, 78: -95, 80: 0, 81: -95,
}
function payload(upTo: number, values = VALUES, goalAt31 = true): MomentumPayload {
  const timeline = []
  for (let min = 1; min <= upTo; min += 1) {
    timeline.push({ min, period: min <= 45 ? 1 : 2, value: { value: values[min] ?? 0 } })
  }
  const events = goalAt31 && upTo >= 31 ? [{ type: 4, side: 1, min: 31, period: 1 }] : []
  return { timeline, events }
}

const FID = 'overlay-fixture'
let currentFixture = fixture(FID, 20)
let current = payload(20)
const calls: { method: string; body: Record<string, unknown> }[] = []
let nextMessageId = 900
const sends = () => calls.filter((c) => c.method === 'sendMessage' && !String(c.body.text).includes('GREEN') && !String(c.body.text).includes('RED'))

function installDeps() {
  poller.setPollerDepsForTests({
    fetchFixtures: async () => [currentFixture],
    warmup: async () => undefined,
    fetchMomentum: async () => current,
  })
}
async function tickAt(upTo: number, finished = false) {
  current = payload(upTo)
  currentFixture = fixture(currentFixture.id, upTo, finished)
  await poller.tick()
  await poller.waitForOddsAttachForTests()
}
const goalsHt = (id: string) => store.loadAlerts('goals', 'ht').find((a) => a.id === `${FID}:${id}`)
const goalsFt = (id: string) => store.loadAlerts('goals', 'ft').find((a) => a.id === `${FID}:${id}`)

try {
  poller.resetPollerRuntimeForTests()
  telegram.resetTelegramStatusForTests()
  outcomes.resetTelegramOutcomesForTests()
  telegram.setTelegramFetchForTests(async (input, init) => {
    const method = String(input).split('/').at(-1) ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })
    nextMessageId += 1
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }), { status: 200 })
  })
  tips.setAttachOddsForTests(async ({ alerts }) =>
    alerts.map((alert: FeedAlert) => ({
      ...alert,
      odds: {
        ts: alert.firedAt,
        fixtureId: alert.fixtureId,
        matchLabel: alert.matchLabel,
        league: 'Overlay League',
        market: alert.market ?? 'goals',
        half: alert.cornerHalf ?? 'ht',
        bucket: `${alert.market ?? 'goals'}_${alert.cornerHalf ?? 'ht'}`,
        minute: alert.min,
        period: alert.period,
        alertId: alert.id,
        currentTotal: 0,
        source: 'robobet',
        sourceLabel: 'RoboBet · teste',
        limit: null,
        asian: null,
        robobet: { odd: 1.9, line: 0.5 },
      } as FeedAlert['odds'],
    })),
  )
  installDeps()

  await tickAt(20) // prime
  expect(sends().length === 0, 'no send on first sight')

  await tickAt(25)
  const a25 = goalsHt('primary-1-25-24')
  expect(sends().length === 1, `25': one goals alert sent, got ${sends().length}`)
  expect(String(sends()[0]?.body.text).split('\n')[1] === '✅ Filtro', '25\': Telegram has the ✅ Filtro line')
  expect(a25?.overlay?.pass === true && a25.overlay.notified === true && a25.overlay.enforced === true, `25': overlay pass+notified, got ${JSON.stringify(a25?.overlay)}`)
  expect(a25?.overlay?.version === Q.QUALITY_OVERLAY_VERSION, '25\': overlay version stored')

  await tickAt(28)
  const a28 = goalsHt('primary-1-28-27')
  expect(sends().length === 1, `28': capped, no send, got ${sends().length}`)
  expect(a28?.overlay?.pass === false && eq(a28.overlay.reasons, [R.cap]) && !a28.overlay.notified, `28': cap reason stored, got ${JSON.stringify(a28?.overlay)}`)

  await tickAt(30)
  const a30 = goalsHt('primary-1-30-29')
  expect(Boolean(a30), '30\': base alert stored although overlay blocks it')
  expect(sends().length === 1, `30': blocked, no send, got ${sends().length}`)
  expect(a30?.overlay?.pass === false && eq(a30.overlay.reasons, [R.goalsHtSpike]), `30': spike reason, got ${JSON.stringify(a30?.overlay)}`)

  // Restart: in-memory runtime gone; the cap comes from stored alerts.
  poller.resetPollerRuntimeForTests()
  installDeps()
  await tickAt(34)
  const a34 = goalsHt('primary-1-34-33')
  expect(sends().length === 1, `34' after restart: still capped, got ${sends().length}`)
  expect(a34?.overlay?.pass === false && a34.overlay.reasons.includes(R.cap), `34': cap after restart, got ${JSON.stringify(a34?.overlay)}`)

  // Corners are independent of the goals cap.
  await tickAt(37)
  const c37 = store.loadAlerts('corners', 'ht').find((a) => a.id === `${FID}:primary-1-37-36`)
  expect(sends().length === 2, `37': corners alert sent, got ${sends().length}`)
  expect(String(sends()[1]?.body.text).startsWith('<b>Canto'), '37\': it is the corners alert')
  expect(c37?.overlay?.pass === true && c37.overlay.notified === true, `37': corners overlay pass, got ${JSON.stringify(c37?.overlay)}`)
  const nonPrimary = store.loadAlerts('corners', 'ht').filter((a) => a.fixtureId === FID && a.ruleId !== 'primary')
  expect(nonPrimary.every((a) => a.overlay?.reasons.includes(R.notPrimary)), 'non-Primary alerts carry not-primary')

  // FT goals: pressing side winning is blocked, own FT cap.
  await tickAt(75)
  const f75 = goalsFt('primary-2-75-74')
  expect(sends().length === 2, `75': home pressing at 1-0 blocked, got ${sends().length}`)
  expect(f75?.overlay?.pass === false && eq(f75.overlay.reasons, [R.pressingSideWinning]), `75': reason, got ${JSON.stringify(f75?.overlay)}`)
  await tickAt(78)
  const f78 = goalsFt('primary-2-78-77')
  expect(sends().length === 3, `78': away pressing while losing sent, got ${sends().length}`)
  expect(f78?.overlay?.pass === true && f78.overlay.notified === true, `78': pass, got ${JSON.stringify(f78?.overlay)}`)
  await tickAt(81)
  const f81 = goalsFt('primary-2-81-80')
  expect(sends().length === 3, `81': FT capped, got ${sends().length}`)
  expect(f81?.overlay?.pass === false && eq(f81.overlay.reasons, [R.cap]), `81': cap, got ${JSON.stringify(f81?.overlay)}`)

  // Full time: base alerts (blocked or not) are all settled and learned.
  await tickAt(90, true)
  await outcomes.waitForTelegramOutcomesForTests()
  for (const [label, a] of [
    ['25', goalsHt('primary-1-25-24')],
    ['28', goalsHt('primary-1-28-27')],
    ['30', goalsHt('primary-1-30-29')],
    ['34', goalsHt('primary-1-34-33')],
  ] as const) {
    expect(a?.hit5 !== null && a?.hit5 !== undefined, `${label}': settled (hit5=${a?.hit5})`)
  }
  expect(goalsHt('primary-1-30-29')?.hit5 === true, '30\' blocked alert settled GREEN (goal 31\') — learning keeps it')
  expect(goalsHt('primary-1-28-27')?.hit5 === true, '28\' capped alert settled GREEN')
  expect(goalsHt('primary-1-30-29')?.overlay?.pass === false, 'settlement keeps the overlay decision')
  expect(store.loadGoals('goals', 'ht').some((g) => g.fixtureId === FID && g.min === 31), 'goal learned')
  const fixtureTips = store.loadTips().filter((t) => t.fixtureId === FID)
  expect(fixtureTips.length === 3, `tips only for notified alerts (25' goals, 37' corners, 78' goals), got ${fixtureTips.length}`)
  // Outcomes are appended to the delivered alert messages (inline edits).
  const outcomeEdits = new Set(
    calls
      .filter((c) => c.method === 'editMessageText' && /GREEN|RED/.test(String(c.body.text)))
      .map((c) => c.body.message_id),
  )
  expect(outcomeEdits.size === 3, `outcome edits only for delivered alerts, got ${outcomeEdits.size}`)
  const outcomeSends = calls.filter((c) => c.method === 'sendMessage' && /GREEN|RED/.test(String(c.body.text)))
  expect(outcomeSends.length === 0, `no outcome messages (edited inline), got ${outcomeSends.length}`)

  // Stats: overlay vs base per market×half.
  const s = qo.overlayStats('goals', 'ht')
  expect(s.base.alerts === 4 && s.overlayPass.alerts === 1 && s.overlayNotified.alerts === 1 && s.delivered.alerts === 1, `goals HT stats counts, got ${JSON.stringify(s)}`)
  // won = GREEN (hit5 ∨ hitLong): 25' (long window), 28', 30'; 34' after the goal is RED.
  expect(s.base.settled === 4 && s.base.won === 3 && s.overlayPass.won === 1 && s.overlayPass.settled === 1, `goals HT won/settled, got ${JSON.stringify(s.base)} ${JSON.stringify(s.overlayPass)}`)
  expect(s.blockReasons[R.cap] === 2 && s.blockReasons[R.goalsHtSpike] === 1, `block reasons, got ${JSON.stringify(s.blockReasons)}`)

  // QUALITY_OVERLAY=off: base behaviour, decision still stored.
  process.env.QUALITY_OVERLAY = 'off'
  const FID2 = 'overlay-off-fixture'
  currentFixture = fixture(FID2, 20)
  const before = sends().length
  await tickAt(20)
  await tickAt(30)
  const offAlerts = store.loadAlerts('goals', 'ht').filter((a) => a.fixtureId === FID2 && a.ruleId === 'primary')
  const offSends = sends().slice(before)
  expect(offSends.length === 3, `off: every base Primary sent (25', 28', 30'), got ${offSends.length}`)
  expect(offSends.every((c) => !String(c.body.text).includes('✅ Filtro')), 'off: no ✅ Filtro line')
  const off30 = offAlerts.find((a) => a.id === `${FID2}:primary-1-30-29`)
  expect(off30?.overlay?.pass === false && off30.overlay.enforced === false && Boolean(off30.sentPush), `off: blocked-by-rule alert delivered, decision stored, got ${JSON.stringify(off30?.overlay)}`)
  delete process.env.QUALITY_OVERLAY
} finally {
  delete process.env.QUALITY_OVERLAY
  poller.resetPollerRuntimeForTests()
  telegram.setTelegramFetchForTests(null)
  tips.setAttachOddsForTests(null)
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-quality-overlay')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log(
  'OK: quality overlay — rules (corners HT ≤38, goals HT 85/70/sust4/diff≤1, FT pressing side not winning, side-unknown), 1 per match×market×half from stored alerts (survives restart), blocked alerts stored+settled, env switch, ✅ Filtro line',
)
