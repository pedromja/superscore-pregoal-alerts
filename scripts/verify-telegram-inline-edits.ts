/**
 * Inline Telegram edits (offline, mocked Bot API):
 * - "Resolver agora" / automatic settle append 🟢/🔴 to the original alert
 *   (editMessageText, keyboard removed) — no new message;
 * - alerts without an editable message keep the old reply behaviour;
 * - odds line edited in after attachOdds, the send never waits for odds;
 * - quick VOID check (event before the send clock ⇒ VOID, excluded from
 *   stats; after the send / same minute ⇒ not VOID);
 * - odds + VOID + result composed from state, edits serialised per message;
 * - "message is not modified" and edit failures handled without loops.
 *
 * Run with TELEGRAM_INLINE_EDITS=0 or VOID_CHECK=0 to see it fail (the env
 * value from the shell is respected for the main sections).
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-telegram-inline-edits'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
// Fake credentials only; every Bot API call goes to the mock below.
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'
delete process.env.TELEGRAM_ENABLED
delete process.env.WEB_PUSH_ENABLED
delete process.env.TELEGRAM_ODDS_EDIT_MAX_MS
process.env.QUALITY_OVERLAY = 'off'
const shellInlineEdits = process.env.TELEGRAM_INLINE_EDITS
const shellVoidCheck = process.env.VOID_CHECK

type FeedAlert = import('../src/lib/types.ts').FeedAlert
type Fixture = import('../src/lib/types.ts').Fixture
type OddsObservation = import('../src/lib/oddsObserve.ts').OddsObservation

const poller = await import('../server/poller.ts')
type BetOutcome = import('../src/lib/betOutcome.ts').BetOutcome
function greenBet(min: number, period = 1): BetOutcome {
  return { status: 'green', rule: 'half-end-v1', baseline: 0, total: 1, targetPeriod: 1, event: { min, period, side: 'away' }, endMin: null, reason: 'event', decidedAt: new Date().toISOString() }
}
function redBet(endMin: number): BetOutcome {
  return { status: 'red', rule: 'half-end-v1', baseline: 0, total: 0, targetPeriod: 1, event: null, endMin, reason: 'period-over', decidedAt: new Date().toISOString() }
}
const store = await import('../server/store.ts')
const tips = await import('../server/tips.ts')
const telegram = await import('../server/telegram.ts')
const edits = await import('../server/telegramEdits.ts')
const compose = await import('../server/telegramCompose.ts')
const voidMod = await import('../server/telegramVoid.ts')
const outcomes = await import('../server/telegramOutcomes.ts')
const resolve = await import('../server/telegramResolve.ts')
const learn = await import('../server/learn.ts')
const qo = await import('../server/qualityOverlay.ts')
const { computeRoi, computeLeagueFollowup } = await import('../src/lib/tips.ts')
const { defaultsFor } = await import('../src/lib/market.ts')
const { sampleFeedAlert } = await import('../src/lib/tally.ts')

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

const CHAT = '-1001234567890'
type Call = { method: string; body: Record<string, unknown> }
const calls: Call[] = []
let nextMessageId = 500
let editHandler: (body: Record<string, unknown>) => Response | Promise<Response> = () =>
  json({ ok: true, result: true })
let inflightEdits = 0
let maxInflightEdits = 0

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

telegram.setTelegramFetchForTests(async (input, init) => {
  const method = String(input).split('/').at(-1) ?? ''
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  calls.push({ method, body })
  if (method === 'sendMessage') {
    nextMessageId += 1
    return json({ ok: true, result: { message_id: nextMessageId } })
  }
  if (method === 'editMessageText') {
    inflightEdits += 1
    maxInflightEdits = Math.max(maxInflightEdits, inflightEdits)
    try {
      return await editHandler(body)
    } finally {
      inflightEdits -= 1
    }
  }
  return json({ ok: true, result: true })
})

const byMethod = (method: string, from = 0) => calls.slice(from).filter((c) => c.method === method)
const editsOf = (messageId: number | undefined, from = 0) =>
  byMethod('editMessageText', from).filter((c) => c.body.message_id === messageId)
const lastLine = (text: unknown) => String(text ?? '').trimEnd().split('\n').at(-1) ?? ''
const keyboardLen = (c: Call | undefined) =>
  (c?.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard?.length

function fixture(id: string): Fixture {
  return {
    id,
    team1: 'Deportivo Pereira',
    team2: 'Internacional de Bogota',
    team1Id: 'h',
    team2Id: 'a',
    competition: 'Inline League',
    category: 'test',
    status: 1,
    state: 1,
    dateSeconds: 0,
    liveElapsedSeconds: 38 * 60,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: false,
  }
}

function alertFor(fixtureId: string, min = 36): FeedAlert {
  return {
    ...sampleFeedAlert('goals', 'ht'),
    id: `primary-1-${min}-${min - 1}`,
    fixtureId,
    matchLabel: 'Deportivo Pereira vs Internacional de Bogota',
    min,
    period: 1,
    index: min - 1,
    side: 'away',
    momentum: -51,
    coincident: false,
    market: 'goals',
    cornerHalf: 'ht',
    goalsTally: { home: 0, away: 0 },
    cornersTally: { home: 2, away: 2 },
    firedAt: new Date().toISOString(),
    rule: 'primary',
  }
}

function ssObservation(alert: FeedAlert): OddsObservation {
  return {
    ts: alert.firedAt,
    fixtureId: alert.fixtureId,
    matchLabel: alert.matchLabel,
    league: 'Inline League',
    market: 'goals',
    half: 'ht',
    bucket: 'goals_ht',
    minute: alert.min,
    period: alert.period,
    alertId: alert.id,
    currentTotal: 0,
    source: 'superscore',
    sourceLabel: 'SuperScore · Total de golos',
    limit: {
      kind: 'limit',
      marketName: 'Prima repriză - Total goluri',
      line: 0.5,
      prices: [
        { name: 'Over 0.5', price: 1.85, line: 0.5, side: 'over' },
        { name: 'Under 0.5', price: 1.95, line: 0.5, side: 'under' },
      ],
    },
    asian: {
      kind: 'asian',
      marketName: 'Prima repriză - Total goluri asiatice',
      line: 0.75,
      prices: [
        { name: 'Over 0.75', price: 1.9, line: 0.75, side: 'over' },
        { name: 'Under 0.75', price: 1.9, line: 0.75, side: 'under' },
      ],
    },
    sokkerpro: null,
    robobet: null,
  }
}

function withImmediateOdds() {
  tips.setAttachOddsForTests(async ({ alerts }) =>
    alerts.map((alert: FeedAlert) => ({ ...alert, odds: ssObservation(alert) })),
  )
}

function timeline(upTo: number) {
  const rows = []
  for (let min = 20; min <= upTo; min += 1) rows.push({ min, period: 1, value: { value: -50 } })
  return rows
}

function saveStoredMatch(fixtureId: string, upTo: number, goals: { min: number; side?: number }[] = []) {
  store.saveMatch({
    fixture: fixture(fixtureId),
    payload: {
      timeline: timeline(upTo),
      events: goals.map((g) => ({ type: 4, side: g.side ?? 2, min: g.min, period: 1 })),
    },
    finished: false,
    updatedAt: new Date().toISOString(),
  })
}

function setup(opts: { voidCheck?: boolean } = {}) {
  poller.resetPollerRuntimeForTests()
  edits.resetTelegramEditsForTests()
  outcomes.resetTelegramOutcomesForTests()
  telegram.resetTelegramStatusForTests()
  editHandler = () => json({ ok: true, result: true })
  maxInflightEdits = 0
  if (shellInlineEdits === undefined) delete process.env.TELEGRAM_INLINE_EDITS
  else process.env.TELEGRAM_INLINE_EDITS = shellInlineEdits
  if (opts.voidCheck === false) process.env.VOID_CHECK = '0'
  else if (shellVoidCheck === undefined) delete process.env.VOID_CHECK
  else process.env.VOID_CHECK = shellVoidCheck
  voidMod.setVoidCheckForTests({
    delayMs: 1,
    unref: false,
    fetchMomentum: async () => {
      throw new Error('no fresh feed in this section')
    },
  })
  resolve.setResolveFetchMomentumForTests(async () => {
    throw new Error('use stored match')
  })
  resolve.setCallbackAnswerMsForTests(null)
  withImmediateOdds()
}

async function sendAlert(fixtureId: string, min = 36, clockMin = 38) {
  const before = calls.length
  const sent = await poller.processEvaluatedAlerts({
    fixture: fixture(fixtureId),
    market: 'goals',
    settings: defaultsFor('goals', 'ht'),
    byHalf: { ht: defaultsFor('goals', 'ht'), ft: defaultsFor('goals', 'ft') },
    fresh: [alertFor(fixtureId, min)],
    first: false,
    finished: false,
    payload: { timeline: timeline(clockMin), events: [] },
    events: [],
    points: [{ period: 1, min: clockMin }],
  })
  const send = byMethod('sendMessage', before)[0]
  const key = `${fixtureId}:primary-1-${min}-${min - 1}`
  return { sent, key, send, messageId: nextMessageId, before }
}

async function settleAll() {
  await poller.waitForOddsAttachForTests()
  await voidMod.waitForVoidChecksForTests()
  await outcomes.waitForTelegramOutcomesForTests()
  await edits.waitForTelegramEditsForTests()
}

const logged = (key: string) => store.findLoggedAlert(key)?.alert

try {
  // ── 1. Pure composition ──────────────────────────────────────────────────
  const base = '<b>Golo · Golos 0-0 · Cantos 2-2</b>\n✅ Filtro\nA vs B · 36\' · Fora · v -51\nPrimária\n<a href="https://x/#/m">Abrir no monitor</a>'
  const odds = compose.formatTelegramOddsLine(ssObservation(alertFor('c')), 'goals')
  expect(
    odds === '💰 Odd +0.5 golos (Over 0.5): 1.85 (SuperScore) · Asiático Over 0.75 1.90 / Under 0.75 1.90',
    `odds line, got ${odds}`,
  )
  expect(compose.formatTelegramOddsLine(null) === null, 'no observation → no odds line')
  const green = compose.formatTelegramResultLine({ hit5: true, hitLong: true, minute: 79, leadTime5: 2, market: 'goals' })
  expect(green === "<b>🟢 GREEN</b> · 81'", `green line, got ${green}`)
  const red = compose.formatTelegramResultLine({ hit5: false, hitLong: false, minute: 36, longDeadline: 42, market: 'goals' })
  expect(red === "<b>🔴 RED</b> · sem golo até 42'", `red line, got ${red}`)
  const voidLine = compose.formatTelegramVoidLine({ market: 'goals', event: { min: 37, period: 1 } })
  expect(voidLine === "<b>⚪ VOID</b> · linha já batida ao enviar · golo aos 37'", `void line, got ${voidLine}`)
  const all = compose.composeTelegramAlertText({ baseText: base, oddsLine: odds, voidLine: null, resultLine: green })
  expect(all === `${base}\n${odds}\n${green}`, 'base + odds + result, in that order')
  const voided = compose.composeTelegramAlertText({ baseText: base, oddsLine: odds, voidLine, resultLine: green })
  expect(voided === `${base}\n${odds}\n${voidLine}`, 'VOID replaces the result line (never GREEN/RED on VOID)')
  expect(compose.composeTelegramAlertText({ baseText: base }) === base, 'base alone unchanged')
  expect(!compose.composedMessageIsFinal({ baseText: base, oddsLine: odds }), 'odds alone keeps the button')
  expect(compose.composedMessageIsFinal({ baseText: base, resultLine: green }), 'result is final')

  // ── 2. Pure VOID rule ────────────────────────────────────────────────────
  const snap = { clockMin: 38, clockPeriod: 1, totalAtAlert: 0 }
  const goal = (min: number, period = 1, side = 2) => ({ type: 4, side, min, period })
  expect(voidMod.decideVoid({ market: 'goals', events: [goal(37)], snapshot: snap }).result === 'void', 'goal 37\' < send clock 38\' → void')
  expect(voidMod.decideVoid({ market: 'goals', events: [goal(39)], snapshot: snap }).result === 'clean', 'goal 39\' after send → clean')
  expect(voidMod.decideVoid({ market: 'goals', events: [goal(38)], snapshot: snap }).result === 'same-minute', 'same minute → not void')
  expect(voidMod.decideVoid({ market: 'goals', events: [goal(20, 1, 1)], snapshot: { ...snap, totalAtAlert: 1 } }).result === 'clean', 'goal already in the printed score → clean')
  expect(voidMod.decideVoid({ market: 'goals', events: [{ type: 14, side: 1, min: 30, period: 1 }], snapshot: snap }).result === 'clean', 'corner ignored for goals')
  expect(voidMod.decideVoid({ market: 'corners', events: [{ type: 14, side: 1, min: 37, period: 1 }], snapshot: { ...snap, totalAtAlert: 0 } }).result === 'void', 'corner type 14 before send → corners void')
  expect(voidMod.decideVoid({ market: 'goals', events: [goal(46, 2)], snapshot: snap }).result === 'clean', 'later period → clean')
  expect(voidMod.decideVoid({ market: 'goals', events: null, snapshot: snap }).result === 'no-data', 'no feed → no-data')

  // ── 3. Send is immediate; odds line edited in later ─────────────────────
  setup({ voidCheck: false })
  let releaseOdds: () => void = () => undefined
  const oddsGate = new Promise<void>((r) => (releaseOdds = r))
  tips.setAttachOddsForTests(async ({ alerts }) => {
    await oddsGate
    return alerts.map((alert: FeedAlert) => ({ ...alert, odds: ssObservation(alert) }))
  })
  const s3 = await sendAlert('ie-odds')
  expect(s3.sent === 1, `alert sent while odds still pending, got ${s3.sent}`)
  expect(Boolean(s3.send), 'sendMessage happened before odds')
  expect(byMethod('editMessageText', s3.before).length === 0, 'no edit before odds resolve')
  const baseText = String(s3.send?.body.text)
  expect(!baseText.includes('💰'), 'no odds on the critical path')
  const rec3 = store.getTelegramMessage(s3.key)
  expect(rec3?.messageId === s3.messageId && rec3?.chatId === CHAT, 'message_id + chat_id stored')
  const alert3 = logged(s3.key)
  expect(alert3?.telegramMessageId === s3.messageId && alert3?.telegramChatId === CHAT, 'alert carries message_id + chat_id')
  expect(alert3?.sendSnapshot?.clockMin === 38 && alert3?.sendSnapshot?.totalAtAlert === 0, `send snapshot stored, got ${JSON.stringify(alert3?.sendSnapshot)}`)
  releaseOdds()
  await settleAll()
  const oddsEdits = editsOf(s3.messageId, s3.before)
  expect(oddsEdits.length === 1, `one odds edit, got ${oddsEdits.length}`)
  expect(oddsEdits[0]?.body.text === `${baseText}\n${odds}`, `odds appended after all text, got ${oddsEdits[0]?.body.text}`)
  expect(oddsEdits[0]?.body.parse_mode === 'HTML', 'edit keeps HTML parse mode')
  expect(keyboardLen(oddsEdits[0]) === 1, 'odds edit keeps Resolver agora')
  // Later attaches (next ticks) never touch the captured odds line.
  await sendAlert('ie-odds')
  await settleAll()
  expect(editsOf(s3.messageId, s3.before).length === 1, 'odds line captured once')

  // ── 4. Resolver agora: GREEN appended via edit, no new message ──────────
  setup({ voidCheck: false })
  const s4 = await sendAlert('ie-green')
  await settleAll()
  saveStoredMatch('ie-green', 41, [{ min: 38 }])
  const before4 = calls.length
  const cb = await resolve.handleCallbackQuery({
    id: 'cb-green',
    data: `rn:${s4.key}`,
    message: { message_id: s4.messageId, chat: { id: CHAT } },
  })
  await settleAll()
  expect(cb.kind === 'green', `callback green, got ${cb.kind}`)
  expect(byMethod('sendMessage', before4).length === 0, 'no new message on resolve')
  const toast = byMethod('answerCallbackQuery', before4)
  expect(toast.length === 1 && toast[0]?.body.text === 'Resolvido: GREEN', `one toast "Resolvido: GREEN", got ${JSON.stringify(toast.map((t) => t.body.text))}`)
  const greenEdit = editsOf(s4.messageId, before4).at(-1)
  const s4base = String(s4.send?.body.text)
  expect(
    greenEdit?.body.text === `${s4base}\n${odds}\n<b>🟢 GREEN</b> · golo aos 38'`,
    `GREEN appended after odds, got ${greenEdit?.body.text}`,
  )
  expect(keyboardLen(greenEdit) === 0, 'button removed after resolution')
  expect(store.telegramOutcomeAlreadySent(s4.key), 'outcome claimed once')
  const before4b = calls.length
  const again = await resolve.handleCallbackQuery({
    id: 'cb-again',
    data: `rn:${s4.key}`,
    message: { message_id: s4.messageId, chat: { id: CHAT } },
  })
  await settleAll()
  expect(again.kind === 'already', `second press already, got ${again.kind}`)
  expect(byMethod('editMessageText', before4b).length === 0 && byMethod('sendMessage', before4b).length === 0, 'second press: no edit, no message')
  expect(byMethod('answerCallbackQuery', before4b)[0]?.body.text === telegram.ALREADY_RESOLVED_TEXT, 'second press toast já resolvido')

  // ── 5. Too early: toast only ─────────────────────────────────────────────
  setup({ voidCheck: false })
  const s5 = await sendAlert('ie-early')
  await settleAll()
  saveStoredMatch('ie-early', 38)
  const before5 = calls.length
  const early = await resolve.handleCallbackQuery({
    id: 'cb-early',
    data: `rn:${s5.key}`,
    message: { message_id: s5.messageId, chat: { id: CHAT } },
  })
  await settleAll()
  expect(early.kind === 'pending', `early press pending, got ${early.kind}`)
  expect(byMethod('answerCallbackQuery', before5)[0]?.body.text === resolve.PART_IN_PROGRESS_TEXT, `pending toast (parte a decorrer), got ${byMethod('answerCallbackQuery', before5)[0]?.body.text}`)
  expect(byMethod('editMessageText', before5).length === 0 && byMethod('sendMessage', before5).length === 0, 'too early: no edit, no message')

  // Slow resolution: Telegram gets "A verificar…" early, exactly one answer.
  resolve.setCallbackAnswerMsForTests(5)
  resolve.setResolveFetchMomentumForTests(async () => {
    await new Promise((r) => setTimeout(r, 40))
    throw new Error('slow feed, use stored match')
  })
  const before5b = calls.length
  await resolve.handleCallbackQuery({
    id: 'cb-slow',
    data: `rn:${s5.key}`,
    message: { message_id: s5.messageId, chat: { id: CHAT } },
  })
  await settleAll()
  const slow = byMethod('answerCallbackQuery', before5b)
  expect(slow.length === 1 && slow[0]?.body.text === 'A verificar…', `slow resolve answered once early, got ${JSON.stringify(slow.map((t) => t.body.text))}`)
  resolve.setCallbackAnswerMsForTests(null)

  // ── 6. Automatic settle (RED) edits the alert too ───────────────────────
  const before6 = calls.length
  store.patchLoggedAlert(s5.key, { hit: false, hit5: false, hitLong: false, longDeadline: 42, labeledAt: new Date().toISOString(), betOutcome: redBet(47) })
  outcomes.enqueueAndFlushTelegramOutcomes([logged(s5.key)!])
  await settleAll()
  const redEdit = editsOf(s5.messageId, before6).at(-1)
  expect(lastLine(redEdit?.body.text) === "<b>🔴 RED</b> · sem golo até ao intervalo (45+2')", `auto settle RED appended, got ${redEdit?.body.text}`)
  expect(byMethod('sendMessage', before6).length === 0, 'auto settle: no new message')

  // ── 7. Fallback: alert without an editable message → old reply ──────────
  setup({ voidCheck: false })
  const legacyKey = 'ie-legacy:primary-1-38-37'
  store.upsertAlerts(
    [
      {
        id: legacyKey,
        fixtureId: 'ie-legacy',
        matchLabel: 'Old FC vs Legacy FC',
        minute: 38,
        period: 1,
        index: 37,
        side: 'away',
        ruleId: 'primary',
        market: 'goals',
        cornerHalf: 'ht',
        features: { v: -61, delta1: -63, sustained: 1 },
        thresholdsSnapshot: {},
        ts: new Date().toISOString(),
        coincident: false,
        hit: true,
        leadMin: 2,
        hit5: true,
        hitLong: true,
        longDeadline: 42,
        leadTime5: 2,
        leadTimeLong: 2,
        labeledAt: new Date().toISOString(),
        feedback: null,
        sentPush: true,
        telegramMessageId: 77,
        telegramOutcomeSentAt: null,
        betOutcome: greenBet(40),
      },
    ],
    'goals',
    'ht',
  )
  const before7 = calls.length
  outcomes.enqueueAndFlushTelegramOutcomes([logged(legacyKey)!])
  await settleAll()
  const legacyReply = byMethod('sendMessage', before7)
  expect(legacyReply.length === 1 && legacyReply[0]?.body.reply_to_message_id === 77, 'legacy alert: GREEN replied to message 77')
  expect(String(legacyReply[0]?.body.text).includes('🟢 GREEN'), 'legacy reply text GREEN')
  expect(byMethod('editMessageText', before7).length === 0, 'legacy alert: no edit')

  // ── 8. "message is not modified" + failed edit → graceful ──────────────
  setup({ voidCheck: false })
  const s8 = await sendAlert('ie-notmod')
  await settleAll()
  editHandler = () =>
    json(
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
      },
      400,
    )
  store.upsertTelegramMessage(s8.key, { lastEditText: undefined, oddsLine: '💰 Odd +0.5 golos: 1.70 (RoboBet)' })
  const before8 = calls.length
  const nm = await edits.requestTelegramAlertEdit(s8.key, 'test')
  expect(nm.kind === 'not-modified', `not modified handled, got ${nm.kind}`)
  expect(editsOf(s8.messageId, before8).length === 1, 'not modified: exactly one call, no retry')
  const nm2 = await edits.requestTelegramAlertEdit(s8.key, 'test')
  expect(nm2.kind === 'unchanged' && editsOf(s8.messageId, before8).length === 1, 'same state again: no API call')
  editHandler = () => json({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, 400)
  store.patchLoggedAlert(s8.key, { hit: true, hit5: true, hitLong: true, leadTime5: 3, labeledAt: new Date().toISOString(), betOutcome: greenBet(41) })
  const before8b = calls.length
  outcomes.enqueueAndFlushTelegramOutcomes([logged(s8.key)!])
  await settleAll()
  expect(editsOf(s8.messageId, before8b).length === 1, `failed edit tried once, got ${editsOf(s8.messageId, before8b).length}`)
  const fb = byMethod('sendMessage', before8b)
  expect(fb.length === 1 && fb[0]?.body.reply_to_message_id === s8.messageId, 'failed edit → one reply fallback (old behaviour)')
  expect(Boolean(store.getTelegramMessage(s8.key)?.lastEditError), 'edit error recorded on the record')

  // Transient edit failures (fetch failed / 5xx) retry with backoff, bounded.
  edits.setEditRetryDelaysForTests([1, 1])
  let flaky = 2
  editHandler = () => {
    if (flaky > 0) {
      flaky -= 1
      throw new TypeError('fetch failed')
    }
    return json({ ok: true, result: true })
  }
  store.upsertTelegramMessage(s8.key, { lastEditText: undefined, oddsLine: '💰 Odd +0.5 golos: 1.75 (RoboBet)' })
  const before8c = calls.length
  const flakyRes = await edits.requestTelegramAlertEdit(s8.key, 'test')
  expect(flakyRes.kind === 'edited' && editsOf(s8.messageId, before8c).length === 3, `network error retried until edited (3 calls), got ${flakyRes.kind} / ${editsOf(s8.messageId, before8c).length}`)
  editHandler = () => json({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502)
  store.upsertTelegramMessage(s8.key, { lastEditText: undefined, oddsLine: '💰 Odd +0.5 golos: 1.80 (RoboBet)' })
  const before8d = calls.length
  const down = await edits.requestTelegramAlertEdit(s8.key, 'test')
  expect(down.kind === 'failed' && editsOf(s8.messageId, before8d).length === 3, `5xx: bounded to 3 calls, got ${editsOf(s8.messageId, before8d).length}`)
  editHandler = () => json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 400)
  store.upsertTelegramMessage(s8.key, { lastEditText: undefined, oddsLine: '💰 Odd +0.5 golos: 1.90 (RoboBet)' })
  const before8e = calls.length
  await edits.requestTelegramAlertEdit(s8.key, 'test')
  expect(editsOf(s8.messageId, before8e).length === 1, '400 is final: one call')
  edits.setEditRetryDelaysForTests(null)

  // ── 9. VOID: event before the send ⇒ VOID, edited, excluded from stats ──
  setup()
  voidMod.setVoidCheckForTests({
    delayMs: 1,
    unref: false,
    fetchMomentum: async () => ({ timeline: timeline(39), events: [{ type: 4, side: 1, min: 37, period: 1 }] }),
  })
  const s9 = await sendAlert('ie-void')
  await settleAll()
  const a9 = logged(s9.key)
  expect(a9?.void === true, `alert marked VOID, got ${JSON.stringify(a9?.voidCheck)}`)
  expect(Boolean(a9?.voidAt) && /linha já batida/.test(a9?.voidReason ?? ''), `void reason + timestamp, got ${a9?.voidReason}`)
  expect(a9?.voidCheck?.source === 'superscore-fresh' && a9?.voidCheck?.event?.min === 37, 'void check audit (source, event)')
  const voidEdit = editsOf(s9.messageId, s9.before).at(-1)
  const s9base = String(s9.send?.body.text)
  expect(
    voidEdit?.body.text === `${s9base}\n${odds}\n<b>⚪ VOID</b> · linha já batida ao enviar · golo aos 37'`,
    `odds + VOID composed, got ${voidEdit?.body.text}`,
  )
  expect(keyboardLen(voidEdit) === 0, 'VOID removes the button')
  const tip9 = store.loadTips().find((t) => t.fixtureId === 'ie-void')
  expect(tip9?.void === true, 'tip of a VOID alert flagged (still stored)')
  // Settles GREEN later: no GREEN/RED edit on a VOID message, not counted.
  const before9 = calls.length
  store.patchLoggedAlert(s9.key, { hit: true, hit5: true, hitLong: true, leadTime5: 2, labeledAt: new Date().toISOString(), betOutcome: greenBet(40) })
  outcomes.enqueueAndFlushTelegramOutcomes([logged(s9.key)!])
  await settleAll()
  expect(byMethod('editMessageText', before9).length === 0 && byMethod('sendMessage', before9).length === 0, 'VOID alert gets no outcome edit/message')
  const cb9 = await resolve.handleCallbackQuery({ id: 'cb-void', data: `rn:${s9.key}`, message: { message_id: s9.messageId, chat: { id: CHAT } } })
  expect(cb9.kind === 'void', `Resolver on VOID → void, got ${cb9.kind}`)
  expect(String(byMethod('answerCallbackQuery', before9).at(-1)?.body.text).includes('VOID'), 'VOID toast')
  // Stats exclusion.
  const stored = store.loadAlerts('goals', 'ht')
  const counted = stored.filter((a) => !a.coincident && !a.void)
  const metrics = learn.computeMetrics(learn.currentSettings('goals', 'ht'))
  expect(metrics.global.wLong.alerts === counted.length, `learn summary excludes VOID (${metrics.global.wLong.alerts} vs ${counted.length})`)
  expect(!metrics.global.wLong.alerts || counted.length === stored.filter((a) => !a.coincident).length - 1, 'exactly one VOID excluded')
  const ov = qo.overlayStatsFor(stored, 'goals', 'ht')
  expect(ov.voided === 1, `overlay stats count voided, got ${ov.voided}`)
  expect(ov.base.alerts === stored.filter((a) => a.ruleId === 'primary' && a.overlay && !a.void).length, 'overlay buckets exclude VOID')
  const allTips = store.loadTips()
  const roiTips = computeRoi(allTips).reduce((n, r) => n + r.tips, 0)
  expect(roiTips === allTips.filter((t) => !t.void).length, 'tips ROI excludes VOID tip')
  const leagueTips = computeLeagueFollowup(allTips).reduce((n, r) => n + r.tips, 0)
  expect(leagueTips === allTips.filter((t) => !t.void).length, 'league follow-up excludes VOID tip')

  // ── 10. Event after the send / same minute ⇒ not VOID ───────────────────
  setup()
  voidMod.setVoidCheckForTests({
    delayMs: 1,
    unref: false,
    fetchMomentum: async () => ({ timeline: timeline(40), events: [{ type: 4, side: 2, min: 39, period: 1 }] }),
  })
  const s10 = await sendAlert('ie-after')
  await settleAll()
  const a10 = logged(s10.key)
  expect(a10?.void !== true && a10?.voidCheck?.result === 'clean', `after-send goal → clean, got ${JSON.stringify(a10?.voidCheck)}`)
  expect(!editsOf(s10.messageId, s10.before).some((c) => String(c.body.text).includes('VOID')), 'no VOID edit for a legit alert')
  setup()
  voidMod.setVoidCheckForTests({
    delayMs: 1,
    unref: false,
    fetchMomentum: async () => ({ timeline: timeline(40), events: [{ type: 4, side: 2, min: 38, period: 1 }] }),
  })
  const s10b = await sendAlert('ie-same')
  await settleAll()
  expect(logged(s10b.key)?.void !== true && logged(s10b.key)?.voidCheck?.result === 'same-minute', 'same-minute goal → not VOID (ambiguous)')
  // Fresh feed down → poller's stored snapshot is used.
  setup()
  voidMod.setVoidCheckForTests({
    delayMs: 1,
    unref: false,
    fetchMomentum: async () => {
      throw new Error('down')
    },
  })
  saveStoredMatch('ie-stored', 39, [{ min: 37, side: 1 }])
  const s10c = await sendAlert('ie-stored')
  await settleAll()
  expect(logged(s10c.key)?.void === true && logged(s10c.key)?.voidCheck?.source === 'superscore-stored', 'stored snapshot fallback detects VOID')

  // ── 11. Edits are serialised per message and never clobber each other ───
  setup({ voidCheck: false })
  const s11 = await sendAlert('ie-serial')
  await settleAll()
  store.upsertTelegramMessage(s11.key, { oddsLine: null, lastEditText: undefined })
  editHandler = async () => {
    await new Promise((r) => setTimeout(r, 15))
    return json({ ok: true, result: true })
  }
  const before11 = calls.length
  store.upsertTelegramMessage(s11.key, { oddsLine: '💰 Odd +0.5 golos: 2.00 (SokkerPro)' })
  const e1 = edits.requestTelegramAlertEdit(s11.key, 'odds')
  store.upsertTelegramMessage(s11.key, { resultLine: "<b>🟢 GREEN</b> · 40'" })
  const e2 = edits.requestTelegramAlertEdit(s11.key, 'resultado')
  await Promise.all([e1, e2])
  expect(maxInflightEdits === 1, `edits never overlap, max in flight ${maxInflightEdits}`)
  const serial = editsOf(s11.messageId, before11)
  expect(
    lastLine(serial.at(-1)?.body.text) === "<b>🟢 GREEN</b> · 40'" &&
      String(serial.at(-1)?.body.text).includes('💰 Odd +0.5 golos: 2.00 (SokkerPro)'),
    `final edit keeps odds + result, got ${serial.at(-1)?.body.text}`,
  )

  // ── 12. Switches: TELEGRAM_INLINE_EDITS=0 → old reply; VOID_CHECK=0 → none
  setup({ voidCheck: false })
  process.env.TELEGRAM_INLINE_EDITS = '0'
  const s12 = await sendAlert('ie-off')
  await settleAll()
  expect(byMethod('editMessageText', s12.before).length === 0, 'inline edits off: no odds edit')
  store.patchLoggedAlert(s12.key, { hit: true, hit5: true, hitLong: true, leadTime5: 2, labeledAt: new Date().toISOString(), betOutcome: greenBet(40) })
  const before12 = calls.length
  outcomes.enqueueAndFlushTelegramOutcomes([logged(s12.key)!])
  await settleAll()
  expect(byMethod('sendMessage', before12)[0]?.body.reply_to_message_id === s12.messageId, 'inline edits off: GREEN as a reply (old behaviour)')
  process.env.VOID_CHECK = '0'
  expect(
    voidMod.scheduleVoidCheck({ alertKey: 'x', market: 'goals', fixtureId: 'x', alertId: 'x', snapshot: { sentAt: '', clockMin: 1, clockPeriod: 1, totalAtAlert: 0 } }) === false,
    'VOID_CHECK=0 schedules nothing',
  )
} finally {
  poller.resetPollerRuntimeForTests()
  edits.resetTelegramEditsForTests()
  telegram.setTelegramFetchForTests(null)
  tips.setAttachOddsForTests(null)
  voidMod.setVoidCheckForTests(null)
  resolve.setResolveFetchMomentumForTests(null)
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-telegram-inline-edits')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log(
  'OK: result/odds/VOID appended by editMessageText (no new message), legacy reply fallback, odds never delay the send, VOID before-send only and excluded from stats, edits serialised, not-modified handled',
)
