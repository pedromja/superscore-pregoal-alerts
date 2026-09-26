import { sampleFeedAlert } from '../src/lib/tally.ts'
import type { FeedAlert, Fixture } from '../src/lib/types.ts'
import { defaultsFor } from '../src/lib/market.ts'
import {
  processEvaluatedAlerts,
  setPollerSendPushForTests,
  setPollerSendTelegramForTests,
  waitForOddsAttachForTests,
} from '../server/poller.ts'
import {
  escapeTelegramHtml,
  formatTelegramHtml,
  formatTelegramOutcomeHtml,
  getTelegramStatus,
  PENDING_RESOLVE_TEXT,
  RESOLVE_NOW_LABEL,
  resetTelegramStatusForTests,
  resolveMonitorUrl,
  resolveNowKeyboard,
  sendTelegramAlert,
  setTelegramFetchForTests,
  telegramOutcomeIsHit,
} from '../server/telegram.ts'
import {
  decideResolveNow,
  handleCallbackQuery,
  setResolveFetchMomentumForTests,
  settleDeadlineMin,
} from '../server/telegramResolve.ts'
import {
  acceptTelegramWebhook,
  telegramWebhookAuthorized,
} from '../server/telegramUpdates.ts'
import { telegramWebhookSecret } from '../server/config.ts'
import { saveMatch } from '../server/store.ts'
import {
  enqueueAndFlushTelegramOutcomes,
  resetTelegramOutcomesForTests,
  waitForTelegramOutcomesForTests,
} from '../server/telegramOutcomes.ts'
import {
  getTelegramMessage,
  loadAlerts,
  loadSent,
  loadTelegramMessages,
  saveAlerts,
  saveSent,
  saveTelegramMessages,
  sentKey,
  telegramOutcomeAlreadySent,
  upsertAlerts,
} from '../server/store.ts'
import type { BetOutcome } from '../src/lib/betOutcome.ts'

function testBetOutcome(status: 'green' | 'red'): BetOutcome {
  return {
    status,
    rule: 'half-end-v1',
    baseline: 0,
    total: status === 'green' ? 1 : 0,
    targetPeriod: 1,
    event: status === 'green' ? { min: 40, period: 1, side: 'home' } : null,
    endMin: 47,
    reason: status === 'green' ? 'event' : 'period-over',
    decidedAt: new Date().toISOString(),
  }
}
import type { LoggedAlert } from '../server/types.ts'

// Base delivery pipeline with sample alerts the quality overlay would filter;
// the overlay has its own test (verify-quality-overlay). Read live per call.
process.env.QUALITY_OVERLAY = 'off'

const fail: string[] = []

function expect(cond: boolean, message: string) {
  if (!cond) fail.push(message)
}

function testFixture(id: string): Fixture {
  return {
    id,
    team1: 'Home FC',
    team2: 'Away FC',
    team1Id: 'h',
    team2Id: 'a',
    competition: 'Telegram Test',
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

const previousToken = process.env.TELEGRAM_BOT_TOKEN
const previousChat = process.env.TELEGRAM_CHAT_ID
const previousEnabled = process.env.TELEGRAM_ENABLED
const previousWebhook = process.env.TELEGRAM_WEBHOOK_SECRET
const previousSent = loadSent()
const previousTelegramMap = loadTelegramMessages()
const previousGoalAlerts = loadAlerts('goals')

function restoreEnv() {
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = previousToken
  if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID
  else process.env.TELEGRAM_CHAT_ID = previousChat
  if (previousEnabled === undefined) delete process.env.TELEGRAM_ENABLED
  else process.env.TELEGRAM_ENABLED = previousEnabled
  if (previousWebhook === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET
  else process.env.TELEGRAM_WEBHOOK_SECRET = previousWebhook
  resetTelegramStatusForTests()
}

try {
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  delete process.env.TELEGRAM_ENABLED
  resetTelegramStatusForTests()

  let fetchCalls = 0
  setTelegramFetchForTests(async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })

  const skipped = await sendTelegramAlert({
    title: 'Golo · Golos 1-0 · Cantos 3-2',
    body: "Celtic vs Ferencváros · 38' · Fora · v -61",
    url: '/#/monitor?alert=demo',
    alertKey: 'skip-unconfigured',
    ruleLabel: 'Primária',
  })
  expect(skipped.skipped === true, 'unconfigured send is skipped')
  expect(skipped.sent === 0, 'unconfigured send does not count')
  expect(skipped.reason === 'não configurado', `skip reason, got ${skipped.reason}`)
  expect(fetchCalls === 0, 'unconfigured must not call Bot API')
  const unconfiguredStatus = getTelegramStatus()
  expect(unconfiguredStatus.configured === false, 'status.configured false without env')
  expect(unconfiguredStatus.enabled === false, 'status.enabled false without env')
  expect(!unconfiguredStatus.lastError, 'skip must not set lastError')

  expect(
    escapeTelegramHtml('A & B <C> "x"') === 'A &amp; B &lt;C&gt; &quot;x&quot;',
    `html escape got "${escapeTelegramHtml('A & B <C> "x"')}"`,
  )

  const html = formatTelegramHtml({
    title: 'Golo · Golos 1-0 · Cantos 3-2',
    body: "Bandirmaspor vs Umraniyespor · 88' · Fora · v -51",
    url: '/#/monitor?alert=demo-teste%3Aprimary-1-38-0',
    alertKey: 'demo-teste:primary-1-38-0',
    ruleLabel: 'Secundária',
  })
  expect(html.includes('<b>Golo · Golos 1-0 · Cantos 3-2</b>'), 'title is bold HTML')
  expect(html.includes('Bandirmaspor vs Umraniyespor · 88\''), 'body mirrored')
  expect(html.includes('Secundária'), 'rule label included')
  expect(html.includes('Abrir no monitor'), 'monitor link label')
  const monitor = resolveMonitorUrl('/#/monitor?alert=demo')
  expect(Boolean(monitor && monitor.startsWith('http')), `monitor url got ${monitor}`)
  expect(html.includes(monitor ? monitor.replace(/&/g, '&amp;') : 'missing'), 'escaped href')

  process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
  process.env.TELEGRAM_CHAT_ID = '-1001234567890'
  resetTelegramStatusForTests()

  process.env.TELEGRAM_ENABLED = '0'
  resetTelegramStatusForTests()
  const disabled = await sendTelegramAlert({
    title: 'Golo',
    body: 'off',
    url: '/#/monitor',
    alertKey: 'disabled',
  })
  expect(disabled.skipped === true, 'TELEGRAM_ENABLED=0 skips even with creds')
  expect(disabled.reason === 'desligado', `disabled reason, got ${disabled.reason}`)
  expect(fetchCalls === 0, 'disabled must not call Bot API')
  delete process.env.TELEGRAM_ENABLED
  resetTelegramStatusForTests()

  const captured: { url: string; body: unknown }[] = []
  setTelegramFetchForTests(async (input, init) => {
    fetchCalls += 1
    const url = String(input)
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
    })
  })

  const sent = await sendTelegramAlert({
    title: 'Canto · Golos 1-0 · Cantos 5-3',
    body: "Home FC vs Away FC · 84' · Casa · v +72",
    url: '/#/monitor?alert=fix%3Aprimary-2-84-0',
    alertKey: 'fix:primary-2-84-0',
    ruleLabel: 'Primária',
  })
  expect(sent.sent === 1, `configured send counts, got ${sent.sent}`)
  expect(sent.skipped === false, 'successful send is not skipped')
  expect(fetchCalls === 1, `Bot API once, got ${fetchCalls}`)
  expect(
    captured[0]?.url ===
      'https://api.telegram.org/botTEST_TOKEN_DO_NOT_USE/sendMessage',
    `bot url got ${captured[0]?.url}`,
  )
  const body = captured[0]?.body as {
    chat_id?: string
    parse_mode?: string
    text?: string
    disable_web_page_preview?: boolean
    reply_markup?: {
      inline_keyboard?: { text?: string; callback_data?: string }[][]
    }
  }
  expect(body.chat_id === '-1001234567890', `chat_id got ${body.chat_id}`)
  expect(body.parse_mode === 'HTML', `parse_mode got ${body.parse_mode}`)
  expect(body.disable_web_page_preview === true, 'preview disabled')
  expect(body.text?.includes('<b>Canto · Golos 1-0 · Cantos 5-3</b>') === true, 'html title')
  expect(body.text?.includes('Primária') === true, 'html rule')
  const btn = body.reply_markup?.inline_keyboard?.[0]?.[0]
  expect(btn?.text === RESOLVE_NOW_LABEL, `inline button, got ${btn?.text}`)
  expect(
    String(btn?.callback_data || '').startsWith('rn:'),
    `callback_data prefix, got ${btn?.callback_data}`,
  )
  const okStatus = getTelegramStatus()
  expect(okStatus.configured === true, 'status.configured after send')
  expect(okStatus.enabled === true, 'status.enabled after send')
  expect(Boolean(okStatus.lastSendAt), 'lastSendAt set')
  expect(okStatus.lastError === null, 'lastError cleared on success')

  setTelegramFetchForTests(async () => {
    fetchCalls += 1
    return new Response(
      JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }),
      { status: 400 },
    )
  })
  const failed = await sendTelegramAlert({
    title: 'Golo',
    body: 'fail',
    url: '/#/monitor',
    alertKey: 'http-fail',
  })
  expect(failed.sent === 0, 'API error does not count as sent')
  expect(failed.skipped === false, 'API error is not a skip')
  expect(
    failed.reason?.includes('chat not found') === true,
    `error reason, got ${failed.reason}`,
  )
  expect(getTelegramStatus().lastError?.includes('chat not found') === true, 'lastError stored')

  setTelegramFetchForTests(async () => {
    fetchCalls += 1
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  const timed = await sendTelegramAlert({
    title: 'Golo',
    body: 'timeout',
    url: '/#/monitor',
    alertKey: 'timeout-fail',
  })
  expect(timed.sent === 0, 'timeout does not throw')
  expect(/timeout/i.test(timed.reason || ''), `timeout reason, got ${timed.reason}`)
  expect(/timeout/i.test(getTelegramStatus().lastError || ''), 'timeout lastError')

  setTelegramFetchForTests(async () => {
    fetchCalls += 1
    throw new Error(`fetch failed https://api.telegram.org/botTEST_TOKEN_DO_NOT_USE/sendMessage`)
  })
  const leaked = await sendTelegramAlert({
    title: 'Golo',
    body: 'leak',
    url: '/#/monitor',
    alertKey: 'leak-token',
  })
  expect(
    !leaked.reason?.includes('TEST_TOKEN_DO_NOT_USE'),
    `token must not appear in reason: ${leaked.reason}`,
  )
  expect(
    !getTelegramStatus().lastError?.includes('TEST_TOKEN_DO_NOT_USE'),
    'token must not appear in lastError',
  )

  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  resetTelegramStatusForTests()
  setTelegramFetchForTests(null)

  let telegramCount = 0
  let pushCount = 0
  setPollerSendTelegramForTests(async () => {
    telegramCount += 1
    return { sent: 1, skipped: false }
  })
  setPollerSendPushForTests(async () => {
    pushCount += 1
    return { sent: 1, removed: 0, attempted: 1, errors: [] }
  })

  const fixtureId = `tg-poller-${Date.now()}`
  const alertId = 'primary-1-38-0'
  const sentFirst = await processEvaluatedAlerts({
    fixture: testFixture(fixtureId),
    market: 'goals',
    settings: defaultsFor('goals'),
    byHalf: undefined,
    fresh: [testAlert(fixtureId, alertId)],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await waitForOddsAttachForTests()
  expect(sentFirst === 1, `poller telegram sent count, got ${sentFirst}`)
  expect(telegramCount === 1, `telegram once, got ${telegramCount}`)
  expect(pushCount === 0, `web push dormant by default, got ${pushCount}`)
  expect(
    loadSent().includes(sentKey('goals', fixtureId, alertId)),
    'sent key marked so the same alert is not double-sent',
  )

  const sentAgain = await processEvaluatedAlerts({
    fixture: testFixture(fixtureId),
    market: 'goals',
    settings: defaultsFor('goals'),
    byHalf: undefined,
    fresh: [testAlert(fixtureId, alertId)],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await waitForOddsAttachForTests()
  expect(sentAgain === 0, `second tick must not send, got ${sentAgain}`)
  expect(telegramCount === 1, `sent keys block double telegram, got ${telegramCount}`)

  setPollerSendTelegramForTests(null)
  setPollerSendPushForTests(null)
  const unsetId = `tg-unset-${Date.now()}`
  const unsetSent = await processEvaluatedAlerts({
    fixture: testFixture(unsetId),
    market: 'goals',
    settings: defaultsFor('goals'),
    byHalf: undefined,
    fresh: [testAlert(unsetId, alertId)],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await waitForOddsAttachForTests()
  expect(unsetSent === 0, `unconfigured poller does not crash, sent ${unsetSent}`)

  const green = formatTelegramOutcomeHtml({
    hit5: true,
    hitLong: false,
    market: 'goals',
    cornerHalf: 'ht',
    matchLabel: 'Celtic vs Ferencváros',
    minute: 38,
  })
  expect(telegramOutcomeIsHit({ hit5: true, hitLong: false }) === true, 'hit5 is a hit')
  expect(telegramOutcomeIsHit({ hit5: false, hitLong: true }) === true, 'hitLong is a hit')
  expect(telegramOutcomeIsHit({ hit5: false, hitLong: false }) === false, 'both false is a miss')
  expect(green.includes('🟢 GREEN'), `green badge, got ${green}`)
  expect(green.includes('Golo'), `green market Golo, got ${green}`)
  expect(green.includes('HT'), `green half, got ${green}`)
  expect(green.includes('Celtic vs Ferencváros'), `green match, got ${green}`)
  expect(green.includes("38'"), `green minute, got ${green}`)
  const red = formatTelegramOutcomeHtml({
    hit5: false,
    hitLong: false,
    market: 'corners',
    cornerHalf: 'ft',
    matchLabel: 'Home FC vs Away FC',
    minute: 84,
  })
  expect(red.includes('🔴 RED'), `red badge, got ${red}`)
  expect(red.includes('Canto'), `red market Canto, got ${red}`)
  expect(red.includes('FT'), `red half, got ${red}`)
  expect(red.includes('Home FC vs Away FC'), `red match, got ${red}`)
  expect(red.includes("84'"), `red minute, got ${red}`)

  process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
  process.env.TELEGRAM_CHAT_ID = '-1001234567890'
  delete process.env.TELEGRAM_ENABLED
  resetTelegramStatusForTests()
  resetTelegramOutcomesForTests()

  const outcomeCalls: { url: string; body: Record<string, unknown> }[] = []
  setTelegramFetchForTests(async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    outcomeCalls.push({ url, body })
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 4242 } }),
      { status: 200 },
    )
  })

  const persistKey = `tg-msgid-${Date.now()}:primary-1-38-0`
  const persistSend = await sendTelegramAlert({
    title: 'Golo · Golos 1-0 · Cantos 3-2',
    body: "Home FC vs Away FC · 38' · Fora · v -61",
    url: '/#/monitor?alert=persist',
    alertKey: persistKey,
    ruleLabel: 'Primária',
  })
  expect(persistSend.sent === 1, 'persist send counts')
  expect(persistSend.messageId === 4242, `messageId returned, got ${persistSend.messageId}`)
  expect(
    getTelegramMessage(persistKey)?.messageId === 4242,
    'message_id stored in telegram_messages.json',
  )

  const liveId = `tg-live-${Date.now()}`
  const liveAlertId = 'primary-1-38-0'
  const liveKey = `${liveId}:${liveAlertId}`
  setPollerSendTelegramForTests(null)
  setPollerSendPushForTests(null)
  const liveSent = await processEvaluatedAlerts({
    fixture: testFixture(liveId),
    market: 'goals',
    settings: defaultsFor('goals'),
    byHalf: undefined,
    fresh: [testAlert(liveId, liveAlertId)],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await waitForOddsAttachForTests()
  await waitForTelegramOutcomesForTests()
  expect(liveSent === 1, `live poller sent, got ${liveSent}`)
  const storedLive = loadAlerts('goals').find((a) => a.id === liveKey)
  expect(storedLive?.telegramMessageId === 4242, `alert telegramMessageId, got ${storedLive?.telegramMessageId}`)
  expect(getTelegramMessage(liveKey)?.messageId === 4242, 'side map keyed by alertKey')

  function outcomeSample(id: string, extra: Partial<LoggedAlert> = {}): LoggedAlert {
    return {
      id,
      fixtureId: id.split(':')[0] ?? id,
      matchLabel: 'Celtic vs Ferencváros',
      minute: 38,
      period: 1,
      index: 0,
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
      longDeadline: 45,
      leadTime5: 2,
      leadTimeLong: 2,
      labeledAt: new Date().toISOString(),
      feedback: null,
      sentPush: true,
      telegramMessageId: 77,
      telegramOutcomeSentAt: null,
      ...extra,
      // GREEN/RED shown on Telegram = bet outcome (end of the half); mirror the sample's label.
      betOutcome:
        'betOutcome' in extra
          ? extra.betOutcome
          : !('hit5' in extra)
            ? testBetOutcome('green')
            : extra.hit5 == null
              ? undefined
              : testBetOutcome(extra.hit5 ? 'green' : 'red'),
    }
  }

  const onceId = `tg-once-${Date.now()}:primary-1-38-0`
  upsertAlerts([outcomeSample(onceId)], 'goals', 'ht')
  const beforeOnce = outcomeCalls.length
  enqueueAndFlushTelegramOutcomes([outcomeSample(onceId)])
  await waitForTelegramOutcomesForTests()
  const afterOnce = outcomeCalls.length
  expect(afterOnce === beforeOnce + 1, `outcome send once, delta ${afterOnce - beforeOnce}`)
  const reply = outcomeCalls[afterOnce - 1]
  expect(
    String(reply?.url || '').endsWith('/sendMessage'),
    `outcome uses sendMessage, got ${reply?.url}`,
  )
  expect(
    reply?.body.reply_to_message_id === 77,
    `reply_to_message_id, got ${reply?.body.reply_to_message_id}`,
  )
  expect(
    String(reply?.body.text || '').includes('🟢 GREEN'),
    `outcome text green, got ${reply?.body.text}`,
  )
  expect(telegramOutcomeAlreadySent(onceId) === true, 'telegramOutcomeSentAt claimed')

  enqueueAndFlushTelegramOutcomes([outcomeSample(onceId)])
  await waitForTelegramOutcomesForTests()
  expect(outcomeCalls.length === afterOnce, 'already-sent outcome is not sent again')

  const skipId = `tg-skip-${Date.now()}:primary-1-38-0`
  upsertAlerts(
    [
      outcomeSample(skipId, {
        telegramOutcomeSentAt: '2026-01-01T00:00:00.000Z',
      }),
    ],
    'goals',
    'ht',
  )
  const beforeSkip = outcomeCalls.length
  enqueueAndFlushTelegramOutcomes([
    outcomeSample(skipId, {
      telegramOutcomeSentAt: '2026-01-01T00:00:00.000Z',
    }),
  ])
  await waitForTelegramOutcomesForTests()
  expect(outcomeCalls.length === beforeSkip, 'pre-marked outcome is skipped')

  const kb = resolveNowKeyboard('fix:primary-1-38-0')
  expect(kb.inline_keyboard[0][0].text === RESOLVE_NOW_LABEL, 'keyboard label')
  expect(
    decideResolveNow(
      { hit5: true, hitLong: false, longDeadline: 45, leadTime5: 2, leadTimeLong: null },
      { min: 40, period: 1 },
      false,
      { min: 38, period: 1 },
      42,
    ) === 'green',
    'event in horizon is green',
  )
  expect(
    decideResolveNow(
      { hit5: false, hitLong: false, longDeadline: 45, leadTime5: null, leadTimeLong: null },
      { min: 40, period: 1 },
      false,
      { min: 38, period: 1 },
      42,
    ) === 'pending',
    'no event before deadline is pending (no false red)',
  )
  expect(
    decideResolveNow(
      { hit5: false, hitLong: false, longDeadline: 45, leadTime5: null, leadTimeLong: null },
      { min: 43, period: 1 },
      false,
      { min: 38, period: 1 },
      42,
    ) === 'red',
    'past settle deadline is red',
  )
  expect(
    decideResolveNow(
      { hit5: false, hitLong: false, longDeadline: 45, leadTime5: null, leadTimeLong: null },
      { min: 40, period: 1 },
      true,
      { min: 38, period: 1 },
      42,
    ) === 'red',
    'finished match without event is red',
  )
  expect(settleDeadlineMin(38, 1, 42) === 42, 'HT cap wins over +15')

  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret'
  expect(telegramWebhookAuthorized('test-webhook-secret') === true, 'webhook secret ok')
  expect(telegramWebhookAuthorized('nope') === false, 'webhook secret rejects')
  expect(telegramWebhookSecret() === 'test-webhook-secret', 'explicit webhook secret')
  expect(acceptTelegramWebhook('nope', {}) === false, 'bad secret rejected')
  expect(
    acceptTelegramWebhook('test-webhook-secret', { update_id: 1 }) === true,
    'good secret accepted and returns immediately',
  )

  setResolveFetchMomentumForTests(async () => {
    throw new Error('use stored match')
  })

  function resolveFixtureMatch(
    fixtureId: string,
    opts: { clockMin: number; goalMin?: number; finished?: boolean },
  ) {
    const timeline = []
    for (let min = 20; min <= opts.clockMin; min += 1) {
      timeline.push({ min, period: 1, value: { value: -50 } })
    }
    saveMatch({
      fixture: testFixture(fixtureId),
      payload: {
        timeline,
        events:
          opts.goalMin != null
            ? [{ type: 4, side: 2, min: opts.goalMin, period: 1 }]
            : [],
      },
      finished: Boolean(opts.finished),
      updatedAt: new Date().toISOString(),
    })
  }

  const pendingFix = `tg-pending-${Date.now()}`
  const pendingKey = `${pendingFix}:primary-1-38-0`
  upsertAlerts(
    [outcomeSample(pendingKey, { hit: null, hit5: null, hitLong: null, labeledAt: null })],
    'goals',
    'ht',
  )
  resolveFixtureMatch(pendingFix, { clockMin: 40 })
  const beforePending = outcomeCalls.length
  const pendingCb = await handleCallbackQuery({
    id: 'cb-pending',
    data: `rn:${pendingKey}`,
    message: { message_id: 77, chat: { id: '-1001234567890' } },
  })
  await waitForTelegramOutcomesForTests()
  expect(pendingCb.kind === 'pending', `pending kind, got ${pendingCb.kind}`)
  const pendingMsg = outcomeCalls.slice(beforePending).find((c) =>
    String(c.body.text || '').includes(PENDING_RESOLVE_TEXT),
  )
  expect(Boolean(pendingMsg), 'pending replies ainda sem resolução')
  expect(!telegramOutcomeAlreadySent(pendingKey), 'pending must not mark settled')

  const unknownCb = await handleCallbackQuery({
    id: 'cb-unknown',
    data: `rn:${pendingKey}`,
    message: { message_id: 77, chat: { id: '999' } },
  })
  expect(unknownCb.kind === 'ignored', `unknown chat ignored, got ${unknownCb.kind}`)

  const greenFix = `tg-green-${Date.now()}`
  const greenKey = `${greenFix}:primary-1-38-0`
  upsertAlerts(
    [outcomeSample(greenKey, { hit: null, hit5: null, hitLong: null, labeledAt: null })],
    'goals',
    'ht',
  )
  resolveFixtureMatch(greenFix, { clockMin: 41, goalMin: 40 })
  const beforeGreen = outcomeCalls.length
  const greenCb = await handleCallbackQuery({
    id: 'cb-green',
    data: `rn:${greenKey}`,
    message: { message_id: 77, chat: { id: '-1001234567890' } },
  })
  await waitForTelegramOutcomesForTests()
  expect(greenCb.kind === 'green', `green kind, got ${greenCb.kind}`)
  expect(telegramOutcomeAlreadySent(greenKey) === true, 'green marks outcome sent')
  const greenMsg = outcomeCalls.slice(beforeGreen).some((c) =>
    String(c.body.text || '').includes('🟢 GREEN'),
  )
  expect(greenMsg, 'green reply includes 🟢 GREEN')

  const alreadyCb = await handleCallbackQuery({
    id: 'cb-already',
    data: `rn:${greenKey}`,
    message: { message_id: 77, chat: { id: '-1001234567890' } },
  })
  expect(alreadyCb.kind === 'already', `already kind, got ${alreadyCb.kind}`)

  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_CHAT_ID
  resetTelegramStatusForTests()
  const quietId = `tg-quiet-${Date.now()}:primary-1-38-0`
  upsertAlerts([outcomeSample(quietId)], 'goals', 'ht')
  const beforeQuiet = outcomeCalls.length
  enqueueAndFlushTelegramOutcomes([outcomeSample(quietId)])
  await waitForTelegramOutcomesForTests()
  expect(outcomeCalls.length === beforeQuiet, 'unconfigured outcome skips quietly')
  expect(
    !telegramOutcomeAlreadySent(quietId),
    'unconfigured skip must not claim telegramOutcomeSentAt',
  )
} finally {
  setTelegramFetchForTests(null)
  setPollerSendTelegramForTests(null)
  setPollerSendPushForTests(null)
  setResolveFetchMomentumForTests(null)
  resetTelegramOutcomesForTests()
  restoreEnv()
  saveSent(previousSent)
  saveTelegramMessages(previousTelegramMap)
  saveAlerts(previousGoalAlerts, 'goals')
}

if (fail.length) {
  console.error('FAIL')
  for (const line of fail) console.error(`- ${line}`)
  process.exit(1)
}

console.log('ok')
console.log('telegram: skip when unconfigured, HTML format, Bot API mock, poller first-channel, outcome GREEN/RED once, Resolver agora')
