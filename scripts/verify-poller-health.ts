import { lastErrorAfterFixtureFailures } from '../server/poller.ts'
import { sendPushToAll } from '../server/push.ts'
import {
  isRoutineJsonError,
  parseUpstreamJson,
  UpstreamJsonError,
} from '../server/ss.ts'
import {
  loadAlerts,
  loadSubscriptions,
  markAlertPushed,
  saveAlerts,
  saveSubscriptions,
  upsertAlerts,
} from '../server/store.ts'
import type { LoggedAlert } from '../server/types.ts'

const fail: string[] = []

function check(cond: boolean, msg: string) {
  if (!cond) fail.push(msg)
}

try {
  parseUpstreamJson('{"ok":true}', 'https://example.test/ok')
} catch (err) {
  fail.push(`valid JSON threw ${err instanceof Error ? err.message : err}`)
}

const parsed = parseUpstreamJson(
  '{"competitions":[]}',
  'https://example.test/fixtures',
) as { competitions: unknown[] }
check(Array.isArray(parsed.competitions), 'parsed fixtures object')

let truncated: unknown
try {
  parseUpstreamJson('{"timeline":[', 'https://example.test/momentum', 'fix-1')
} catch (err) {
  truncated = err
}
check(truncated instanceof UpstreamJsonError, 'truncated JSON is UpstreamJsonError')
check(
  truncated instanceof Error && /JSON truncado/.test(truncated.message),
  `truncated message: ${truncated instanceof Error ? truncated.message : truncated}`,
)
check(
  truncated instanceof UpstreamJsonError && truncated.url.includes('momentum'),
  'truncated error keeps URL',
)
check(
  truncated instanceof UpstreamJsonError && truncated.fixtureId === 'fix-1',
  'truncated error keeps fixture id',
)
check(isRoutineJsonError(truncated), 'truncated JSON is routine')

let empty: unknown
try {
  parseUpstreamJson('   ', 'https://example.test/empty')
} catch (err) {
  empty = err
}
check(empty instanceof UpstreamJsonError && /JSON vazio/.test(empty.message), 'empty JSON')
check(isRoutineJsonError(empty), 'empty JSON is routine')

let invalid: unknown
try {
  parseUpstreamJson('<html>', 'https://example.test/html')
} catch (err) {
  invalid = err
}
check(invalid instanceof Error && /JSON inválido/.test(invalid.message), 'html is invalid JSON')
check(isRoutineJsonError(invalid), 'invalid JSON is routine')
check(
  !isRoutineJsonError(new Error('Momentum 502')),
  'HTTP errors are not routine JSON',
)

check(
  lastErrorAfterFixtureFailures([], 8) === null,
  'no errors → lastError null',
)
check(
  lastErrorAfterFixtureFailures(
    [
      {
        fixtureId: 'a',
        matchLabel: 'A vs B',
        message: 'JSON truncado (jogo a)',
        routineJson: true,
        url: 'https://example.test/a',
      },
    ],
    8,
  ) === null,
  'one truncated fixture in a mostly-ok tick does not sticky lastError',
)
const allTruncated = lastErrorAfterFixtureFailures(
  [
    {
      fixtureId: 'a',
      matchLabel: 'A vs B',
      message: 'JSON truncado (jogo a)',
      routineJson: true,
    },
    {
      fixtureId: 'b',
      matchLabel: 'C vs D',
      message: 'JSON truncado (jogo b)',
      routineJson: true,
    },
  ],
  2,
)
check(
  allTruncated === 'JSON truncado (jogo a)',
  `all fixtures truncated should surface lastError, got ${allTruncated}`,
)
const mixed = lastErrorAfterFixtureFailures(
  [
    {
      fixtureId: 'a',
      matchLabel: 'A vs B',
      message: 'JSON truncado (jogo a)',
      routineJson: true,
    },
    {
      fixtureId: 'b',
      matchLabel: 'C vs D',
      message: 'Momentum 502',
      routineJson: false,
    },
  ],
  8,
)
check(
  mixed === '1/8 jogos: Momentum 502',
  `serious partial error should be scoped, got ${mixed}`,
)
check(
  lastErrorAfterFixtureFailures(
    [
      {
        fixtureId: 'a',
        matchLabel: 'A vs B',
        message: 'JSON truncado (jogo a)',
        routineJson: true,
      },
    ],
    0,
  ) === null,
  'empty target list with leftover errors still clears',
)

const sample: LoggedAlert = {
  id: 'health-test:primary-1-38-0',
  fixtureId: 'health-test',
  matchLabel: 'Teste vs Teste',
  minute: 38,
  period: 1,
  index: 0,
  side: 'away',
  ruleId: 'primary',
  market: 'goals',
  features: { v: -61, delta1: -63, sustained: 1 },
  thresholdsSnapshot: {},
  ts: new Date().toISOString(),
  coincident: false,
  hit: null,
  leadMin: null,
  hit5: null,
  hitLong: null,
  longDeadline: null,
  leadTime5: null,
  leadTimeLong: null,
  labeledAt: null,
  feedback: null,
  sentPush: false,
}

const previous = loadAlerts('goals')
try {
  saveAlerts(
    previous.filter((a) => a.id !== sample.id),
    'goals',
  )
  upsertAlerts([{ ...sample, sentPush: false }], 'goals')
  check(
    loadAlerts('goals').find((a) => a.id === sample.id)?.sentPush === false,
    'initial ingest sentPush false',
  )
  check(markAlertPushed(sample.id, 'goals'), 'markAlertPushed finds the row')
  check(
    loadAlerts('goals').find((a) => a.id === sample.id)?.sentPush === true,
    'markAlertPushed sets sentPush',
  )
  upsertAlerts([{ ...sample, sentPush: false, matchLabel: 'Teste vs Teste 2' }], 'goals')
  const after = loadAlerts('goals').find((a) => a.id === sample.id)
  check(after?.sentPush === true, 're-ingest must not clobber sentPush true')
  check(after?.matchLabel === 'Teste vs Teste 2', 're-ingest still updates other fields')
} finally {
  saveAlerts(
    previous.filter((a) => a.id !== sample.id),
    'goals',
  )
}

const previousSubs = loadSubscriptions()
try {
  saveSubscriptions([])
  const pushResult = await sendPushToAll({
    title: 'teste',
    body: 'sem subscritores',
    url: '/#/monitor',
    alertKey: 'health-test:primary-1-38-0',
    tag: 'pregoal:test',
  })
  check(pushResult.sent === 0, 'no subscribers → sent 0')
  check(pushResult.attempted === 0, 'no subscribers → attempted 0')
  check(
    pushResult.errors.includes('sem subscritores'),
    `missing-sub reason logged, got ${pushResult.errors.join(',')}`,
  )
} finally {
  saveSubscriptions(previousSubs)
}

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log(
  'OK: truncated JSON is scoped, lastError clears on partial success, sentPush persists after push',
)
