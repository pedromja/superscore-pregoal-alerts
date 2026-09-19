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
  getTelegramStatus,
  resetTelegramStatusForTests,
  resolveMonitorUrl,
  sendTelegramAlert,
  setTelegramFetchForTests,
} from '../server/telegram.ts'
import { loadSent, saveSent, sentKey } from '../server/store.ts'

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
const previousSent = loadSent()

function restoreEnv() {
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = previousToken
  if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID
  else process.env.TELEGRAM_CHAT_ID = previousChat
  if (previousEnabled === undefined) delete process.env.TELEGRAM_ENABLED
  else process.env.TELEGRAM_ENABLED = previousEnabled
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
  }
  expect(body.chat_id === '-1001234567890', `chat_id got ${body.chat_id}`)
  expect(body.parse_mode === 'HTML', `parse_mode got ${body.parse_mode}`)
  expect(body.disable_web_page_preview === true, 'preview disabled')
  expect(body.text?.includes('<b>Canto · Golos 1-0 · Cantos 5-3</b>') === true, 'html title')
  expect(body.text?.includes('Primária') === true, 'html rule')
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
} finally {
  setTelegramFetchForTests(null)
  setPollerSendTelegramForTests(null)
  setPollerSendPushForTests(null)
  restoreEnv()
  saveSent(previousSent)
}

if (fail.length) {
  console.error('FAIL')
  for (const line of fail) console.error(`- ${line}`)
  process.exit(1)
}

console.log('ok')
console.log('telegram: skip when unconfigured, HTML format, Bot API mock, poller first-channel')
