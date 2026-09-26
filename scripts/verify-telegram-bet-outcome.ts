/**
 * Bet outcome ("+0.5" on the market total, decided at the END OF THE HALF):
 * - GREEN as soon as one more event (both teams) appears, stoppage included
 *   (45+2 / 90+4); detail `canto aos 45+2'`;
 * - RED only once the half is confirmed over (later-period data / finished),
 *   never on the clock; pending while the half runs; stale/timeout fallbacks;
 * - learning labels (hit5 / hitLong / metrics) untouched;
 * - stats (overlay, tips ROI, league line) use betOutcome;
 * - boot re-settle: report + serialized, rate-limited edits (no new messages);
 * - odds: only the next-event line of the alert's period (Penarol case).
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-telegram-bet-outcome'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'
delete process.env.TELEGRAM_ENABLED
delete process.env.WEB_PUSH_ENABLED
delete process.env.TELEGRAM_INLINE_EDITS

type LoggedAlert = import('../server/types.ts').LoggedAlert
type StoredMatch = import('../server/types.ts').StoredMatch
type Tip = import('../src/lib/tips.ts').Tip
type OddsObservation = import('../src/lib/oddsObserve.ts').OddsObservation

const bo = await import('../src/lib/betOutcome.ts')
const store = await import('../server/store.ts')
const betSettle = await import('../server/betSettle.ts')
const betIndex = await import('../server/betIndex.ts')
const telegram = await import('../server/telegram.ts')
const outcomes = await import('../server/telegramOutcomes.ts')
const edits = await import('../server/telegramEdits.ts')
const compose = await import('../server/telegramCompose.ts')
const learn = await import('../server/learn.ts')
const qo = await import('../server/qualityOverlay.ts')
const league = await import('../server/leagueStats.ts')
const { computeRoi } = await import('../src/lib/tips.ts')
const oddsMarkets = await import('../src/lib/oddsMarkets.ts')
const { maisUmPriceOf } = await import('../src/lib/oddsObserve.ts')

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

type Call = { method: string; body: Record<string, unknown>; at: number }
const calls: Call[] = []
let nextMessageId = 900
telegram.setTelegramFetchForTests(async (input, init) => {
  const method = String(input).split('/').at(-1) ?? ''
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  calls.push({ method, body, at: Date.now() })
  if (method === 'sendMessage') {
    nextMessageId += 1
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }))
  }
  return new Response(JSON.stringify({ ok: true, result: true }))
})
const byMethod = (method: string, from = 0) => calls.slice(from).filter((c) => c.method === method)

const NOW = Date.now()
const corner = (min: number, period: number, side = 1) => ({ type: 14, side, min, period })
const goal = (min: number, period: number, side = 1) => ({ type: 4, side, min, period })
const pts = (from: number, to: number, period: number) => {
  const out: { min: number; period: number }[] = []
  for (let m = from; m <= to; m += 1) out.push({ min: m, period })
  return out
}
const decide = (over: Partial<Parameters<typeof bo.computeBetOutcome>[0]>) =>
  bo.computeBetOutcome({
    market: 'corners',
    half: 'ht',
    alertMin: 36,
    alertPeriod: 1,
    events: [],
    points: [],
    finished: false,
    updatedAtMs: NOW,
    kickoffMs: NOW - 50 * 60_000,
    nowMs: NOW,
    ...over,
  })

try {
  // ── 1. Pure rule ─────────────────────────────────────────────────────────
  const base3 = [corner(10, 1), corner(20, 1, 2), corner(30, 1)]
  // pending while the half is in progress, also into stoppage (clock never decides)
  let d = decide({ events: base3, points: pts(1, 44, 1) })
  expect(d.status === 'pending' && d.baseline === 3, `HT at 44' no corner → pending, got ${JSON.stringify(d)}`)
  d = decide({ events: base3, points: pts(1, 47, 1) })
  expect(d.status === 'pending', `HT at 45+2 no corner → still pending (no RED on the clock), got ${d.status}`)
  // GREEN on a stoppage-time corner (45+2)
  d = decide({ events: [...base3, corner(47, 1, 2)], points: pts(1, 47, 1) })
  expect(d.status === 'green' && d.event?.min === 47 && d.event?.side === 'away', `GREEN on 45+2 corner, got ${JSON.stringify(d)}`)
  expect(bo.isBetDecided(d) && bo.formatBetDetail(d, 'corners') === "canto aos 45+2'", `detail canto aos 45+2', got ${bo.isBetDecided(d) && bo.formatBetDetail(d, 'corners')}`)
  // both teams count
  d = decide({ events: [...base3, corner(40, 1, 2)], points: pts(1, 41, 1) })
  expect(d.status === 'green' && d.event?.side === 'away', 'away corner counts (both teams)')
  d = decide({ events: [...base3, corner(40, 1, 1)], points: pts(1, 41, 1) })
  expect(d.status === 'green' && d.event?.side === 'home', 'home corner counts (both teams)')
  // other market's events never count
  d = decide({ events: [...base3, goal(40, 1)], points: pts(1, 41, 1) })
  expect(d.status === 'pending', 'a goal does not settle a corners bet')
  // RED only once the half is confirmed over: 2nd-half data appears
  d = decide({ events: base3, points: [...pts(1, 47, 1), ...pts(46, 47, 2)] })
  expect(d.status === 'red' && bo.isBetDecided(d) && d.reason === 'period-over' && d.endMin === 47, `HT RED after 2nd half data, got ${JSON.stringify(d)}`)
  expect(bo.isBetDecided(d) && bo.formatBetDetail(d, 'corners') === "sem canto até ao intervalo (45+2')", `RED detail, got ${bo.isBetDecided(d) && bo.formatBetDetail(d, 'corners')}`)
  // 2nd-half corner never rescues an HT bet
  d = decide({ events: [...base3, corner(50, 2)], points: [...pts(1, 46, 1), ...pts(46, 50, 2)] })
  expect(d.status === 'red', `2nd-half corner does not count for HT, got ${d.status}`)
  // FT: GREEN on 90+4, RED only when finished, never at 90'
  const ftBase = { half: 'ft' as const, alertMin: 80, alertPeriod: 2, market: 'goals' as const }
  d = decide({ ...ftBase, events: [goal(30, 1)], points: [...pts(1, 47, 1), ...pts(46, 95, 2)] })
  expect(d.status === 'pending', `FT at 90+5 not finished → pending, got ${d.status}`)
  d = decide({ ...ftBase, events: [goal(30, 1), goal(94, 2, 2)], points: [...pts(1, 47, 1), ...pts(46, 95, 2)] })
  expect(d.status === 'green' && bo.isBetDecided(d) && bo.formatBetDetail(d, 'goals') === "golo aos 90+4'", `GREEN on 90+4 goal, got ${bo.isBetDecided(d) && bo.formatBetDetail(d, 'goals')}`)
  d = decide({ ...ftBase, events: [goal(30, 1)], points: [...pts(1, 47, 1), ...pts(46, 95, 2)], finished: true })
  expect(d.status === 'red' && bo.isBetDecided(d) && bo.formatBetDetail(d, 'goals') === "sem golo até ao fim (90+5')", `FT RED on finished, got ${bo.isBetDecided(d) && bo.formatBetDetail(d, 'goals')}`)
  // extra time (period 3) never counts for FT
  d = decide({ ...ftBase, events: [goal(30, 1), goal(100, 3)], points: [...pts(46, 94, 2), ...pts(91, 100, 3)] })
  expect(d.status === 'red', `extra-time goal does not count, got ${d.status}`)
  // stale fallback: no data for 30 min with the clock past the regular end
  d = decide({ ...ftBase, events: [goal(30, 1)], points: pts(46, 93, 2), updatedAtMs: NOW - 31 * 60_000 })
  expect(d.status === 'red' && bo.isBetDecided(d) && d.reason === 'stale', `stale after 90+3 → RED, got ${JSON.stringify(d)}`)
  d = decide({ ...ftBase, events: [goal(30, 1)], points: pts(46, 85, 2), updatedAtMs: NOW - 31 * 60_000 })
  expect(d.status === 'pending', `stale at 85' (before the regular end) stays pending, got ${d.status}`)
  d = decide({ ...ftBase, events: [goal(30, 1)], points: pts(46, 85, 2), updatedAtMs: NOW - 31 * 60_000, kickoffMs: NOW - 5 * 3600_000 })
  expect(d.status === 'red' && bo.isBetDecided(d) && d.reason === 'timeout', 'hard timeout settles on the last known count')
  // printed baseline: an event between the alert minute and the send is already in it
  d = decide({ events: [...base3, corner(37, 1)], points: pts(1, 40, 1), baseline: 4 })
  expect(d.status === 'pending', `printed total 4 includes the 37' corner → not GREEN, got ${d.status}`)
  // lagging printed tally never turns a pre-alert event into GREEN
  d = decide({ events: base3, points: pts(1, 40, 1), baseline: 2 })
  expect(d.status === 'pending', `pre-alert corner (lagging tally) is not GREEN, got ${d.status}`)
  // no event coverage at all → never RED
  d = decide({ events: [], points: [...pts(1, 47, 1), ...pts(46, 60, 2)], baseline: 0 })
  expect(d.status === 'pending' && 'noCoverage' in d && d.noCoverage === true, `no events in the feed → undecided, got ${JSON.stringify(d)}`)

  // ── 2. Store settle: labels untouched, stats on betOutcome ──────────────
  const FX = 'bet-fx-1'
  const match = (over: Partial<StoredMatch> & { events: ReturnType<typeof corner>[]; points: { min: number; period: number }[] }): StoredMatch => ({
    fixture: {
      id: FX,
      team1: 'CA Penarol',
      team2: 'Boston River',
      competition: 'Liga Bet',
      category: 'Uruguay',
      status: 7,
      state: 1,
      dateSeconds: Math.floor((NOW - 60 * 60_000) / 1000),
      liveElapsedSeconds: 0,
      scoreHome: 0,
      scoreAway: 0,
      scoreIsFt: false,
    } as StoredMatch['fixture'],
    payload: { events: over.events, timeline: over.points.map((p) => ({ ...p, value: { value: 10 } })) } as StoredMatch['payload'],
    finished: over.finished ?? false,
    updatedAt: new Date(NOW).toISOString(),
  })
  let seq = 0
  const alertAt = (minute: number, labels: { hit5: boolean | null; hitLong: boolean | null }, extra: Partial<LoggedAlert> = {}): LoggedAlert => {
    seq += 1
    return {
      id: `${FX}:primary-1-${minute}-${seq}`,
      fixtureId: FX,
      matchLabel: 'CA Penarol vs Boston River',
      minute,
      period: 1,
      index: seq,
      side: 'home',
      ruleId: 'primary',
      market: 'corners',
      cornerHalf: 'ht',
      features: { v: 60, delta1: 50, sustained: 2 },
      thresholdsSnapshot: {},
      ts: new Date(NOW - 30 * 60_000).toISOString(),
      coincident: false,
      hit: labels.hit5,
      leadMin: null,
      hit5: labels.hit5,
      hitLong: labels.hitLong,
      longDeadline: 42,
      leadTime5: labels.hit5 ? 3 : null,
      leadTimeLong: labels.hitLong ? 3 : null,
      labeledAt: labels.hit5 == null ? null : new Date(NOW - 5 * 60_000).toISOString(),
      feedback: null,
      sentPush: true,
      overlay: { pass: true, enforced: true, reasons: [], v: 1 } as unknown as LoggedAlert['overlay'],
      ...extra,
    }
  }
  // Penarol-like: HT alerts at 34' and 36' (3 corners), learning said RED ("sem canto até 42'"),
  // one corner arrives at 45+2 → bet GREEN.
  const a34 = alertAt(34, { hit5: false, hitLong: false }, { telegramMessageId: 2775, telegramChatId: '-1001234567890', telegramSentAt: new Date(NOW - 20 * 60_000).toISOString() })
  const a36 = alertAt(36, { hit5: false, hitLong: false }, { telegramMessageId: 2776, telegramChatId: '-1001234567890', telegramSentAt: new Date(NOW - 20 * 60_000).toISOString() })
  const aOld = alertAt(35, { hit5: true, hitLong: true }, { ts: new Date(NOW - 20 * 3600_000).toISOString(), telegramMessageId: 2700, telegramChatId: '-1001234567890', telegramSentAt: new Date(NOW - 20 * 3600_000).toISOString() })
  store.saveAlerts([a34, a36, aOld], 'corners', 'ht')
  for (const a of [a34, a36, aOld]) {
    store.upsertTelegramMessage(`corners:${a.id}`, {
      messageId: a.telegramMessageId!,
      chatId: '-1001234567890',
      text: `<b>Canto · Golos 0-0 · Cantos 2-1</b>\nCA Penarol vs Boston River · ${a.minute}'\n<a href="https://x/#/m">Abrir no monitor</a>`,
      sentAt: a.telegramSentAt!,
      outcomeSentAt: null,
      market: 'corners',
    } as never)
  }
  const tip: Tip = {
    id: `tip-${FX}`,
    ts: a36.ts,
    league: 'Liga Bet',
    home: 'CA Penarol',
    away: 'Boston River',
    market: 'corners',
    half: 'ht',
    minute: 36,
    period: 1,
    odd: 2.5,
    line: 3.5,
    stake: 1,
    status: 'lost',
    pnl: -1,
    rule: 'primary',
    scores: { home: 0, away: 0 },
    fixtureId: FX,
    matchLabel: 'CA Penarol vs Boston River',
    alertId: 'primary-1-36-2',
    source: 'superscore',
    sourceLabel: 'SuperScore',
    cornersTally: { home: 2, away: 1 },
    settledAt: new Date(NOW - 5 * 60_000).toISOString(),
    longDeadline: 42,
  }
  store.saveTips([tip])
  const labelsBefore = store.loadAlerts('corners', 'ht').map((a) => [a.id, a.hit, a.hit5, a.hitLong, a.leadTime5, a.leadTimeLong, a.labeledAt, a.longDeadline])
  const metricsBefore = JSON.stringify(learn.computeMetrics(learn.currentSettings('corners', 'ht')).global)

  // In progress at 45+1: nothing decided, nothing sent.
  betIndex.observeBetPending(store.loadAlerts('corners', 'ht'), 'corners', 'ht')
  const callsBefore = calls.length
  betSettle.noteBetCandidate(match({ events: base3, points: pts(1, 46, 1) }))
  let r = betSettle.flushBetSettlements({ sweep: false, nowMs: NOW })
  expect(r.decided === 0, `half in progress → no decision, got ${JSON.stringify(r)}`)
  // Corner at 45+2 → GREEN for both, only recently-sent alerts notified.
  betSettle.noteBetCandidate(match({ events: [...base3, corner(47, 1, 2)], points: pts(1, 47, 1) }))
  r = betSettle.flushBetSettlements({ sweep: false, nowMs: NOW })
  await outcomes.waitForTelegramOutcomesForTests()
  await edits.waitForTelegramEditsForTests()
  expect(r.decided === 3 && r.green === 3 && r.notified === 2, `stoppage corner → GREEN for all, 2 recent notified, got ${JSON.stringify(r)}`)
  const after = store.loadAlerts('corners', 'ht')
  const s36 = after.find((a) => a.id === a36.id)
  expect(s36?.betOutcome?.status === 'green' && s36.betOutcome.event?.min === 47, 'betOutcome stored separately')
  const labelsAfter = after.map((a) => [a.id, a.hit, a.hit5, a.hitLong, a.leadTime5, a.leadTimeLong, a.labeledAt, a.longDeadline])
  expect(JSON.stringify(labelsAfter) === JSON.stringify(labelsBefore), 'learning labels (hit5/hitLong/lead/labeledAt) unchanged')
  expect(JSON.stringify(learn.computeMetrics(learn.currentSettings('corners', 'ht')).global) === metricsBefore, 'learning metrics unchanged')
  const resultEdits = byMethod('editMessageText', callsBefore)
  expect(resultEdits.length === 2 && resultEdits.every((c) => String(c.body.text).trimEnd().endsWith("<b>🟢 GREEN</b> · canto aos 45+2'")), `result edited in place: ${JSON.stringify(resultEdits.map((c) => String(c.body.text).split('\n').at(-1)))}`)
  expect(byMethod('sendMessage', callsBefore).length === 0, 'no new Telegram messages')
  expect(!resultEdits.some((c) => c.body.message_id === 2700), 'alert sent 20 h ago is not notified live')
  // Stats on betOutcome: overlay, tips ROI, league line
  const ov = qo.overlayStatsFor(after, 'corners', 'ht')
  expect(ov.base.won === 3 && ov.base.settled === 3, `overlay stats count bet GREEN (learning said RED for 2), got ${JSON.stringify(ov.base)}`)
  const t = store.loadTips()[0]
  expect(t.status === 'won' && t.pnl === 1.5 && t.legacyStatus === 'lost' && t.betOutcome?.status === 'green', `tip re-settled lost→won by the bet rule, got ${JSON.stringify({ s: t.status, p: t.pnl, l: t.legacyStatus })}`)
  const roi = computeRoi(store.loadTips()).find((row) => row.tips > 0)
  expect(Boolean(roi) && (roi?.won ?? 0) === 1, `tips ROI uses the bet outcome, got ${JSON.stringify(roi)}`)
  store.saveMatch(match({ events: [...base3, corner(47, 1, 2)], points: pts(1, 47, 1) }))
  league.resetLeagueStatsForTests()
  await league.primeLeagueStats({ matchesDir: join(dataDir, 'matches'), loadAlerts: store.loadAlerts })
  const ls = league.leagueStatsFor('corners', 'Liga Bet')
  expect(ls.settled === 3 && ls.green === 3, `league line counts bet outcomes, got ${JSON.stringify(ls)}`)

  // ── 3. Boot re-settle + corrective edits ─────────────────────────────────
  const FX2 = 'bet-fx-2'
  const m2: StoredMatch = { ...match({ events: base3, points: [...pts(1, 48, 1), ...pts(46, 60, 2)] }), fixture: { ...match({ events: [], points: [] }).fixture, id: FX2 } }
  store.saveMatch(m2)
  // learning GREEN (corner at 50' within 15 min horizon) but the HT bet is RED
  const b1 = { ...alertAt(40, { hit5: false, hitLong: true }), id: `${FX2}:primary-1-40-90`, fixtureId: FX2, telegramMessageId: 3001, telegramChatId: '-1001234567890', telegramSentAt: new Date(NOW - 3600_000).toISOString() }
  const b2 = { ...alertAt(41, { hit5: false, hitLong: false }), id: `${FX2}:primary-1-41-91`, fixtureId: FX2, telegramMessageId: 3002, telegramChatId: '-1001234567890', telegramSentAt: new Date(NOW - 3600_000).toISOString() }
  const b3 = { ...alertAt(42, { hit5: null, hitLong: null }), id: `${FX2}:primary-1-42-92`, fixtureId: FX2, telegramMessageId: 3003, telegramChatId: '-1001234567890', telegramSentAt: new Date(NOW - 3 * 86400_000).toISOString() }
  m2.payload.events = [...base3, corner(50, 2)]
  store.saveMatch(m2)
  store.saveAlerts([...store.loadAlerts('corners', 'ht'), b1, b2, b3], 'corners', 'ht')
  for (const a of [b1, b2, b3]) {
    store.upsertTelegramMessage(`corners:${a.id}`, {
      messageId: a.telegramMessageId,
      chatId: '-1001234567890',
      text: `<b>Canto</b>\nX vs Y · ${a.minute}'`,
      sentAt: a.telegramSentAt,
      outcomeSentAt: a.hitLong != null ? new Date(NOW - 10 * 60_000).toISOString() : null,
      resultLine: a.hitLong ? "<b>🟢 GREEN</b> · 50'" : a.hitLong === false ? "<b>🔴 RED</b> · sem canto até 42'" : undefined,
      finalized: a.hitLong != null,
      market: 'corners',
    } as never)
  }
  const report = betSettle.resettleAllBets({ nowMs: NOW })
  expect(report.alerts.decided === 3 && report.alerts.red === 3, `re-settle decides 3 RED, got ${JSON.stringify(report.alerts)}`)
  expect(report.alerts.greenToRed === 1 && report.alerts.wasUnsettled === 1 && report.alerts.sameAsOld === 1, `transitions counted, got ${JSON.stringify(report.alerts)}`)
  expect(report.sent48h.decided === 2 && report.sent48h.greenToRed === 1 && report.editKeys.length === 2, `only alerts sent ≤48 h get edits, got ${JSON.stringify(report.sent48h)} ${report.editKeys.length}`)
  const again = betSettle.resettleAllBets({ nowMs: NOW })
  expect(again.alerts.decided === 0 && again.editKeys.length === 0, 're-settle is idempotent')
  betSettle.setResettleEditDelayForTests(60)
  const beforeEdits = calls.length
  const editRes = await betSettle.runResettleEdits(report.editKeys, (key) => store.findLoggedAlert(key)?.alert ?? null)
  const reEdits = byMethod('editMessageText', beforeEdits)
  expect(editRes.edited === 2 && reEdits.length === 2, `2 corrective edits, got ${JSON.stringify(editRes)}`)
  expect(byMethod('sendMessage', beforeEdits).length === 0, 're-settle sends no new messages')
  expect(reEdits.every((c) => String(c.body.text).trimEnd().endsWith("<b>🔴 RED</b> · sem canto até ao intervalo (45+3')")), `corrected text, got ${JSON.stringify(reEdits.map((c) => String(c.body.text).split('\n').at(-1)))}`)
  expect(reEdits.length === 2 && reEdits[1].at - reEdits[0].at >= 55, `edits are spaced (rate limit), gap ${reEdits.length === 2 ? reEdits[1].at - reEdits[0].at : -1} ms`)
  betSettle.setResettleEditDelayForTests(null)

  // Odds lines from the old picker come off recently sent messages (edit only).
  const legacyKey = `corners:${b1.id}`
  const strictKey = `corners:${b2.id}`
  store.upsertTelegramMessage(legacyKey, { oddsLine: '💰 Odd +0.5 cantos (Over 3.5): 10.50 (SuperScore)', oddsAt: new Date(NOW - 3600_000).toISOString(), lastEditText: 'shown with the 10.50 line' })
  store.upsertTelegramMessage(strictKey, { oddsLine: '💰 Odd +0.5 cantos (Over 3.5): 2.60 (SuperScore)', oddsAt: new Date().toISOString(), oddsRule: edits.ODDS_LINE_RULE })
  const stripped = edits.stripLegacyOddsLines({ nowMs: NOW })
  expect(stripped.length === 1 && stripped[0] === legacyKey, `only the old-picker odds line is stripped, got ${JSON.stringify(stripped)}`)
  expect(store.getTelegramMessage(legacyKey)?.oddsLine === null && Boolean(store.getTelegramMessage(legacyKey)?.legacyOddsLine), 'legacy line kept for audit only')
  const beforeStrip = calls.length
  const stripRes = await edits.runSpacedEdits(stripped, 'odds-legacy', 1)
  const stripEdit = byMethod('editMessageText', beforeStrip)
  expect(stripRes.edited === 1 && stripEdit.length === 1 && !String(stripEdit[0].body.text).includes('10.50') && String(stripEdit[0].body.text).includes('🔴 RED'), `message re-edited without the wrong odd, got ${JSON.stringify(stripEdit.map((c) => c.body.text))}`)
  expect(byMethod('sendMessage', beforeStrip).length === 0, 'odds strip sends no new messages')
  expect(edits.stripLegacyOddsLines({ nowMs: NOW }).length === 0, 'odds strip is idempotent')

  // ── 4. Odds: next-event line of the alert's period only ─────────────────
  const offer = (name: string, odds: [string, number][]) => ({
    name,
    odds: odds.map(([label, price]) => ({ price, metadata: { name: label }, status: 1, display: true })),
  })
  const penarol = {
    event_id: 14826801,
    markets: [
      offer('Prima repriză - Total cornere CA Penarol', [['Peste 3.5', 10.5], ['Sub 3.5', 1.02]]),
      offer('Handicap cornere', [['CA Penarol (2.5)', 1.85], ['Boston River (-2.5)', 1.87]]),
      offer('Total cornere', [['Peste 3.5', 1.05], ['Peste 8.5', 1.9], ['Sub 8.5', 1.9]]),
      offer('A doua repriză - Total cornere', [['Peste 3.5', 1.4]]),
    ],
  }
  expect(oddsMarkets.pickMaisUmOdd(penarol, 'corners', 'ht', 3) === null, 'Penarol: team total / full-match / 2nd-half markets never give the HT +0.5 odd')
  expect(oddsMarkets.pickLimitSnapshot(penarol, 'corners', 'ht', 3) === null, 'Penarol: no HT limit snapshot')
  expect(oddsMarkets.pickAsianSnapshot(penarol, 'corners', 'ht', 3) === null, 'Penarol: corner handicap is not an Asian total')
  const withHt = { ...penarol, markets: [...penarol.markets, offer('Prima repriză - Total cornere', [['Peste 2.5', 1.01], ['Peste 3.5', 2.6], ['Sub 3.5', 1.45], ['Peste 4.5', 6]])] }
  const htPick = oddsMarkets.pickMaisUmOdd(withHt, 'corners', 'ht', 3)
  expect(htPick?.odd === 2.6 && htPick.line === 3.5 && htPick.marketName === 'Prima repriză - Total cornere', `HT picks the 1st-half match total Over 3.5, got ${JSON.stringify(htPick)}`)
  const ftPick = oddsMarkets.pickMaisUmOdd(withHt, 'corners', 'ft', 8)
  expect(ftPick?.odd === 1.9 && ftPick.marketName === 'Total cornere', `FT picks the full-match total Over 8.5, got ${JSON.stringify(ftPick)}`)
  const ft3 = oddsMarkets.pickMaisUmOdd(withHt, 'corners', 'ft', 3)
  expect(ft3?.marketName === 'Total cornere' && ft3.odd === 1.05, `FT never uses a 2nd-half-only or HT market, got ${JSON.stringify(ft3)}`)
  expect(oddsMarkets.pickMaisUmOdd(withHt, 'corners', 'ht', 2) === null || oddsMarkets.pickMaisUmOdd(withHt, 'corners', 'ht', 2)?.line === 2.5, 'exact line only (total 2 → Over 2.5)')
  // A stored observation from the old picker (team market Over 3.5 @10.50) is not shown any more.
  const oldObs: OddsObservation = {
    ts: '', fixtureId: FX, matchLabel: 'CA Penarol vs Boston River', league: 'Primera Division', market: 'corners', half: 'ht', bucket: 'corners_ht',
    minute: 36, period: 1, alertId: 'primary-1-36-35', currentTotal: 3, source: 'superscore', sourceLabel: '',
    limit: { kind: 'limit', marketName: 'Prima repriză - Total cornere CA Penarol', line: 3.5, prices: [{ name: 'Peste 3.5', price: 10.5, line: 3.5, side: 'over' }] },
    asian: { kind: 'asian', marketName: 'Handicap cornere', line: 2.5, prices: [{ name: 'CA Penarol (2.5)', price: 1.85, line: 2.5, side: 'home' }, { name: 'Boston River (-2.5)', price: 1.87, line: -2.5, side: 'away' }] },
    sokkerpro: null, robobet: null,
  }
  expect(maisUmPriceOf(oldObs) === null, 'old team-market observation gives no tip/Telegram odd')
  expect(compose.formatTelegramOddsLine(oldObs, 'corners') === null, 'Penarol odds line suppressed (nothing rather than a wrong odd)')
  const goodObs: OddsObservation = { ...oldObs, limit: { kind: 'limit', marketName: 'Prima repriză - Total cornere', line: 3.5, prices: [{ name: 'Peste 3.5', price: 2.6, line: 3.5, side: 'over' }] }, asian: null }
  expect(compose.formatTelegramOddsLine(goodObs, 'corners') === '💰 Odd +0.5 cantos (Over 3.5): 2.60 (SuperScore)', `valid HT line shown, got ${compose.formatTelegramOddsLine(goodObs, 'corners')}`)
  expect(compose.formatTelegramOddsLine({ ...goodObs, half: 'ft', bucket: 'corners_ft' }, 'corners') === null, 'HT market on an FT alert is not shown')
  expect(compose.formatTelegramOddsLine({ ...goodObs, robobet: { odd: 1.7, line: 4.5 }, limit: null }, 'corners') === null, 'RoboBet on another line is not shown')
} finally {
  telegram.setTelegramFetchForTests(null)
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-telegram-bet-outcome')
  for (const f of fails) console.error(' - ' + f)
  process.exit(1)
}
console.log('OK: bet outcome at the end of the half (stoppage GREEN, RED only after the half is over, pending in play, both teams), labels untouched, stats on betOutcome, re-settle edits rate-limited, odds only for the right period/line')
