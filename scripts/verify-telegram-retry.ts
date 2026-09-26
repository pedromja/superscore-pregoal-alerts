/**
 * Telegram live-alert retry: bounded backoff for transient failures only
 * (network, 429 + retry_after, 5xx); no retry on other 4xx or timeouts;
 * lead gate re-checked before every retry; no duplicate deliveries.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-telegram-retry'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'
delete process.env.TELEGRAM_ENABLED
delete process.env.WEB_PUSH_ENABLED
delete process.env.TELEGRAM_RETRY_MAX_ATTEMPTS
delete process.env.TELEGRAM_RETRY_BASE_MS
delete process.env.TELEGRAM_RETRY_MAX_AGE_MS

type FeedAlert = import('../src/lib/types.ts').FeedAlert
type Fixture = import('../src/lib/types.ts').Fixture
type TelegramSendResult = import('../server/telegram.ts').TelegramSendResult

const poller = await import('../server/poller.ts')
const store = await import('../server/store.ts')
const tips = await import('../server/tips.ts')
const telegram = await import('../server/telegram.ts')
const retry = await import('../server/telegramRetry.ts')
const { defaultsFor } = await import('../src/lib/market.ts')
const { sampleFeedAlert } = await import('../src/lib/tally.ts')

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

const fail = (extra: Partial<TelegramSendResult>): TelegramSendResult => ({
  sent: 0,
  skipped: false,
  reason: 'x',
  ...extra,
})

// ── 1. Pure policy ──────────────────────────────────────────────────────────
const policy = { maxAttempts: 4, baseDelayMs: 2000, maxAgeMs: 60_000 }
const net = fail({ retryable: true, failureKind: 'network' })
const d1 = retry.nextTelegramRetry({ attempts: 1, result: net, elapsedMs: 0, policy })
const d2 = retry.nextTelegramRetry({ attempts: 2, result: net, elapsedMs: 2000, policy })
const d3 = retry.nextTelegramRetry({ attempts: 3, result: net, elapsedMs: 8000, policy })
const d4 = retry.nextTelegramRetry({ attempts: 4, result: net, elapsedMs: 26_000, policy })
expect(d1.retry && d1.delayMs === 2000, `backoff 1 = 2s, got ${JSON.stringify(d1)}`)
expect(d2.retry && d2.delayMs === 6000, `backoff 2 = 6s, got ${JSON.stringify(d2)}`)
expect(d3.retry && d3.delayMs === 18_000, `backoff 3 = 18s, got ${JSON.stringify(d3)}`)
expect(!d4.retry && /esgotou 4/.test(d4.reason), `max 4 attempts, got ${JSON.stringify(d4)}`)
const rl = retry.nextTelegramRetry({
  attempts: 1,
  result: fail({ retryable: true, failureKind: 'rate-limit', retryAfterMs: 7000 }),
  elapsedMs: 0,
  policy,
})
expect(rl.retry && rl.delayMs === 7000, `429 honours retry_after, got ${JSON.stringify(rl)}`)
const rlLong = retry.nextTelegramRetry({
  attempts: 1,
  result: fail({ retryable: true, failureKind: 'rate-limit', retryAfterMs: 120_000 }),
  elapsedMs: 0,
  policy,
})
expect(!rlLong.retry && /lead expirado/.test(rlLong.reason), '429 beyond the lead budget → give up')
const late = retry.nextTelegramRetry({ attempts: 3, result: net, elapsedMs: 50_000, policy })
expect(!late.retry, 'no attempt may start after maxAge')
expect(!retry.nextTelegramRetry({ attempts: 1, result: fail({ retryable: false, failureKind: 'client' }), elapsedMs: 0, policy }).retry, '4xx final')
expect(!retry.nextTelegramRetry({ attempts: 1, result: fail({ retryable: false, failureKind: 'timeout' }), elapsedMs: 0, policy }).retry, 'timeout final')
expect(!retry.nextTelegramRetry({ attempts: 1, result: { sent: 0, skipped: true }, elapsedMs: 0, policy }).retry, 'skip final')
expect(retry.DEFAULT_TELEGRAM_RETRY_POLICY.maxAttempts === 4, 'default max attempts 4')
expect(retry.DEFAULT_TELEGRAM_RETRY_POLICY.maxAgeMs === 60_000, 'default max age 60s')

// ── 2. Classification of real Bot API failures ─────────────────────────────
telegram.resetTelegramStatusForTests()
async function classify(fetchImpl: typeof fetch): Promise<TelegramSendResult> {
  telegram.setTelegramFetchForTests(fetchImpl)
  return telegram.sendTelegramAlert({ title: 'Golo', body: 'b', url: '/#/monitor', alertKey: 'classify' })
}
const cNet = await classify(async () => {
  throw new TypeError('fetch failed')
})
expect(cNet.retryable === true && cNet.failureKind === 'network', `fetch failed → network retryable, got ${JSON.stringify(cNet)}`)
const c429 = await classify(async () =>
  new Response(
    JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }),
    { status: 429 },
  ),
)
expect(c429.retryable === true && c429.retryAfterMs === 7000, `429 → retry_after 7s, got ${JSON.stringify(c429)}`)
const c502 = await classify(async () => new Response('<html>Bad Gateway</html>', { status: 502 }))
expect(c502.retryable === true && c502.failureKind === 'server', `502 → server retryable, got ${JSON.stringify(c502)}`)
const c400 = await classify(async () =>
  new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 }),
)
expect(c400.retryable === false && c400.failureKind === 'client', `400 → final, got ${JSON.stringify(c400)}`)
const c403 = await classify(async () =>
  new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), { status: 403 }),
)
expect(c403.retryable === false, '403 → final')
const cTimeout = await classify(async () => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
})
expect(cTimeout.retryable === false && cTimeout.failureKind === 'timeout', `timeout → final (may be delivered), got ${JSON.stringify(cTimeout)}`)

// ── 3. Poller integration (real sendTelegramAlert, mocked Bot API) ────────
let fakeNow = 1_000_000
const sleeps: number[] = []
let beforeRetry: (() => void) | null = null

function setup() {
  poller.resetPollerRuntimeForTests()
  retry.setTelegramRetryForTests({
    sleep: async (ms) => {
      sleeps.push(ms)
      fakeNow += ms
      beforeRetry?.()
    },
    now: () => fakeNow,
  })
  tips.setAttachOddsForTests(async ({ alerts }) =>
    alerts.map((alert: FeedAlert) => ({
      ...alert,
      odds: {
        ts: alert.firedAt,
        fixtureId: alert.fixtureId,
        matchLabel: alert.matchLabel,
        league: 'Retry League',
        market: 'goals',
        half: 'ht',
        bucket: 'goals_ht',
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
  sleeps.length = 0
  beforeRetry = null
}

function fixture(id: string): Fixture {
  return {
    id,
    team1: 'Home FC',
    team2: 'Away FC',
    team1Id: 'h',
    team2Id: 'a',
    competition: 'Retry League',
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

function alertFor(fixtureId: string): FeedAlert {
  return {
    ...sampleFeedAlert('goals', 'ht'),
    id: 'primary-1-38-37',
    fixtureId,
    matchLabel: 'Home FC vs Away FC',
    min: 38,
    period: 1,
    index: 37,
    side: 'home',
    coincident: false,
    market: 'goals',
    cornerHalf: 'ht',
    firedAt: new Date().toISOString(),
    rule: 'primary',
  }
}

function snapshot(fixtureId: string, upTo: number, goalAt?: number) {
  const timeline = []
  for (let min = 1; min <= upTo; min += 1) timeline.push({ min, period: 1, value: { value: 0 } })
  store.saveMatch({
    fixture: fixture(fixtureId),
    payload: { timeline, events: goalAt ? [{ type: 4, side: 1, min: goalAt, period: 1 }] : [] },
    finished: false,
    updatedAt: new Date().toISOString(),
  })
}

async function runAlert(fixtureId: string): Promise<number> {
  const n = await poller.processEvaluatedAlerts({
    fixture: fixture(fixtureId),
    market: 'goals',
    settings: defaultsFor('goals', 'ht'),
    byHalf: { ht: defaultsFor('goals', 'ht'), ft: defaultsFor('goals', 'ft') },
    fresh: [alertFor(fixtureId)],
    first: false,
    finished: false,
    payload: { timeline: [], events: [] },
    events: [],
    points: [{ period: 1, min: 38 }],
  })
  await poller.waitForOddsAttachForTests()
  await retry.waitForTelegramRetriesForTests()
  return n
}

function scriptedFetch(steps: (() => Response | Promise<Response>)[]) {
  const calls: Record<string, unknown>[] = []
  let messageId = 7000
  telegram.setTelegramFetchForTests(async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')))
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!
    const res = await step()
    if (res.status === 200) {
      messageId += 1
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 })
    }
    return res
  })
  return calls
}
const OK = () => new Response('{}', { status: 200 })
const NETFAIL = () => {
  throw new TypeError('fetch failed')
}

try {
  // a) fetch failed ×2 then OK → delivered once, bookkeeping as inline.
  setup()
  const fa = 'retry-net'
  snapshot(fa, 38)
  const callsA = scriptedFetch([NETFAIL, NETFAIL, OK])
  const inline = await runAlert(fa)
  expect(inline === 0, `inline attempt failed → not counted inline, got ${inline}`)
  expect(callsA.length === 3, `3 attempts (1 + 2 retries), got ${callsA.length}`)
  expect(JSON.stringify(sleeps) === '[2000,6000]', `backoff 2s,6s, got ${JSON.stringify(sleeps)}`)
  const recA = store.getTelegramMessage(`${fa}:primary-1-38-37`)
  expect(Boolean(recA && recA.messageId > 0), 'record stored after retry delivery')
  const loggedA = store.loadAlerts('goals', 'ht').find((a) => a.id === `${fa}:primary-1-38-37`)
  expect(Boolean(loggedA?.sentPush), 'alert marked delivered after retry')
  expect(loggedA?.telegramMessageId === recA?.messageId, 'alert linked to the retried message')
  expect(poller.getPollerStatus().alertsSent === 1, 'late delivery counted in status')
  expect(store.loadTips().some((t) => t.id === `tip-${fa}-primary-1-38-37`), 'tip opened after late delivery')
  expect(retry.getTelegramRetryStats().delivered === 1, 'retry stats delivered')
  // Same alert on the next tick: sent key blocks a second message.
  await runAlert(fa)
  expect(callsA.length === 3, `no duplicate after retry delivery, got ${callsA.length}`)

  // b) 400 → final, no retry.
  setup()
  const callsB = scriptedFetch([
    () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 }),
    OK,
  ])
  await runAlert('retry-400')
  expect(callsB.length === 1, `no retry on 400, got ${callsB.length}`)

  // c) timeout → final (may already be delivered; avoid duplicates).
  setup()
  const callsC = scriptedFetch([
    () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    },
    OK,
  ])
  await runAlert('retry-timeout')
  expect(callsC.length === 1, `no retry on timeout, got ${callsC.length}`)

  // d) 429 retry_after=3 → waits exactly 3s, then delivered.
  setup()
  const callsD = scriptedFetch([
    () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }),
        { status: 429 },
      ),
    OK,
  ])
  await runAlert('retry-429')
  expect(callsD.length === 2 && JSON.stringify(sleeps) === '[3000]', `429 waits retry_after, got ${callsD.length} ${JSON.stringify(sleeps)}`)

  // e) 5xx → retried.
  setup()
  const callsE = scriptedFetch([() => new Response('<html>502</html>', { status: 502 }), OK])
  await runAlert('retry-502')
  expect(callsE.length === 2, `5xx retried, got ${callsE.length}`)

  // f) Lead gate: the goal arrives before the retry → dropped, never delivered.
  setup()
  const ff = 'retry-lead'
  snapshot(ff, 38)
  beforeRetry = () => snapshot(ff, 39, 39)
  const callsF = scriptedFetch([NETFAIL, OK])
  await runAlert(ff)
  expect(callsF.length === 1, `goal before retry → no late alert, got ${callsF.length}`)
  expect(/lead/.test(retry.getTelegramRetryStats().lastDropReason ?? ''), `drop reason lead, got ${retry.getTelegramRetryStats().lastDropReason}`)
  expect(!store.loadAlerts('goals', 'ht').find((a) => a.id === `${ff}:primary-1-38-37`)?.sentPush, 'dropped alert not marked delivered')

  // g) Half-time passed before the retry → dropped.
  setup()
  const fg = 'retry-period'
  snapshot(fg, 38)
  beforeRetry = () =>
    store.saveMatch({
      fixture: fixture(fg),
      payload: { timeline: [{ min: 46, period: 2, value: { value: 0 } }], events: [] },
      finished: false,
      updatedAt: new Date().toISOString(),
    })
  const callsG = scriptedFetch([NETFAIL, OK])
  await runAlert(fg)
  expect(callsG.length === 1, `period change → dropped, got ${callsG.length}`)

  // h) Persistent network failure → bounded (4 attempts within 60s), then give up.
  setup()
  const callsH = scriptedFetch([NETFAIL])
  await runAlert('retry-down')
  expect(callsH.length === 4, `bounded to 4 attempts, got ${callsH.length}`)
  expect(JSON.stringify(sleeps) === '[2000,6000,18000]', `backoff series, got ${JSON.stringify(sleeps)}`)
  expect(/esgotou/.test(retry.getTelegramRetryStats().lastDropReason ?? ''), 'gave up after max attempts')

  // i) Single-flight: a second chain for the same key is refused.
  setup()
  let release: () => void = () => undefined
  retry.setTelegramRetryForTests({ sleep: () => new Promise<void>((r) => (release = r)), now: () => fakeNow })
  const job = {
    key: 'single-flight',
    firstAttemptAt: fakeNow,
    send: async () => ({ sent: 1, skipped: false }),
    dropReason: () => null,
    onDelivered: () => undefined,
  }
  expect(retry.scheduleTelegramRetry(job, net) === true, 'first chain scheduled')
  expect(retry.scheduleTelegramRetry(job, net) === false, 'duplicate chain refused')
  release()
  await retry.waitForTelegramRetriesForTests()
  expect(retry.getTelegramRetryStats().delivered === 1, 'single chain delivered once')
} finally {
  poller.resetPollerRuntimeForTests()
  telegram.setTelegramFetchForTests(null)
  tips.setAttachOddsForTests(null)
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-telegram-retry')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log(
  'OK: Telegram retry — network/429(retry_after)/5xx retried with 2s/6s/18s backoff (≤4 attempts, ≤60s), 4xx/timeout final, lead gate re-checked, no duplicates',
)
