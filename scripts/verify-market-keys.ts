/**
 * Market-unique alert/tip keys + compatible reading of production data.
 *
 * Uses an anonymised slice of the real production state
 * (scripts/fixtures/prod-state-sample.json) that contains a genuine
 * collision: fixture 1ERahgfdCBILANABtA7gqP fired `primary-1-38-37` in BOTH
 * the goals and the corners learning store, and its Telegram record (legacy,
 * unprefixed key, no `market`) is the corners message.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-market-keys'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
const sample = JSON.parse(
  readFileSync(join(root, 'scripts/fixtures/prod-state-sample.json'), 'utf8'),
) as Record<string, unknown>
for (const [file, value] of Object.entries(sample)) {
  writeFileSync(join(dataDir, file), JSON.stringify(value, null, 2))
}
const originalBytes = new Map(
  Object.keys(sample).map((f) => [f, readFileSync(join(dataDir, f), 'utf8')]),
)
process.env.DATA_DIR = REL_DATA
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const keys = await import('../server/alertKeys.ts')
const store = await import('../server/store.ts')
const tips = await import('../server/tips.ts')
const outcomes = await import('../server/telegramOutcomes.ts')
type LoggedAlert = import('../server/types.ts').LoggedAlert

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

const F = '1ERahgfdCBILANABtA7gqP'
const A = 'primary-1-38-37'
const K = `${F}:${A}`
const CK = `corners:${K}`
const tg = sample['telegram_messages.json'] as Record<string, { text: string }>
const goalsRecordKey = Object.keys(tg).find((k) => tg[k]!.text.startsWith('<b>Golo'))!

try {
  // 1. Production files load unchanged (no migration on read).
  const n = (f: string) => (sample[f] as unknown[]).length
  expect(store.loadAlerts('goals', 'ht').length === n('alerts.json'), 'goals HT alerts load')
  expect(store.loadAlerts('goals', 'ft').length === n('alerts_goals_ft.json'), 'goals FT alerts load')
  expect(store.loadAlerts('corners', 'ht').length === n('alerts_corners_ht.json'), 'corners HT alerts load')
  expect(store.loadAlerts('corners', 'ft').length === n('alerts_corners_ft.json'), 'corners FT alerts load')
  expect(Object.keys(store.loadTelegramMessages()).length === Object.keys(tg).length, 'telegram map loads')
  expect(store.loadTips().length === n('tips.json'), 'tips load')
  expect(store.loadSent().length === n('sent.json'), 'sent loads')
  expect(store.loadPrimed().length === n('primed.json'), 'primed loads')
  for (const [f, bytes] of originalBytes) {
    const now = readFileSync(join(dataDir, f), 'utf8')
    expect(now === bytes, `${f} untouched by reads`)
  }

  // 2. Key formats: goals legacy byte-for-byte, corners prefixed.
  expect(keys.alertKeyFor('goals', F, A) === K, 'goals alert key unchanged (legacy)')
  expect(keys.alertKeyFor('corners', F, A) === CK, 'corners alert key prefixed')
  expect(keys.tipIdFor('goals', F, A) === `tip-${F}-${A}`, 'goals tip id unchanged (legacy)')
  expect(keys.tipIdFor('corners', F, A) === `tip-corners-${F}-${A}`, 'corners tip id prefixed')
  expect(keys.parseAlertKey(CK).market === 'corners' && keys.parseAlertKey(CK).loggedId === K, 'parse corners key')
  expect(keys.parseAlertKey(K).market === null, 'unprefixed key has no explicit market')
  expect(keys.marketFromTelegramText('<b>Canto · x</b>') === 'corners', 'infer corners from text')
  expect(keys.marketFromTelegramText('<b>Golo · x</b>') === 'goals', 'infer goals from text')

  // sent.json / primed.json were already market-unique — make sure it stays so.
  const sg = store.sentKey('goals', F, A, 'ht')
  const sc = store.sentKey('corners', F, A, 'ht')
  expect(sg === K, `goals sent key legacy, got ${sg}`)
  expect(sc === `corners:ht:${K}`, `corners sent key, got ${sc}`)
  expect(sg !== sc, 'sent keys differ per market')
  expect(store.primedKey('goals', F) !== store.primedKey('corners', F), 'primed keys differ per market')
  expect(store.primedKey('goals', F) === F, 'goals primed key legacy')
  const sent = store.loadSent()
  // Production already holds BOTH claims for this alert, as separate entries.
  expect(sent.includes(sc) && sent.includes(sg), 'goals and corners claims coexist in sent.json')
  expect(!sent.includes(`corners:${K}`), 'no half-less corners key in sample')

  // 3. Legacy telegram record: resolves for corners, never for goals-by-prefix.
  expect(store.getTelegramMessage(CK)?.messageId === 2303, 'corners key falls back to legacy record')
  expect(store.getTelegramMessage(K)?.messageId === 2303, 'legacy key still reads its record')
  expect(store.getTelegramMessage(`goals:${K}`) === null, 'explicit goals key does not pick corners record')
  const byCorners = store.findLoggedAlert(CK)
  expect(byCorners?.market === 'corners', `corners key → corners alert, got ${byCorners?.market}`)
  const byLegacy = store.findLoggedAlert(K)
  expect(
    byLegacy?.market === 'corners',
    `legacy key with a corners record → corners alert (was goals before), got ${byLegacy?.market}`,
  )
  expect(store.findLoggedAlert(`goals:${K}`)?.market === 'goals', 'explicit goals key → goals alert')
  expect(store.findLoggedAlert(goalsRecordKey)?.market === 'goals', 'legacy goals record → goals alert')

  // 4. Outcome claim on a legacy corners record writes in place, patches corners only.
  const goalsBefore = store.loadAlerts('goals', 'ht').find((a) => a.id === K)
  expect(store.telegramOutcomeAlreadySent(CK) === true, 'legacy corners outcome (sent in prod) visible via corners key')
  expect(store.claimTelegramOutcome(CK) === false, 'no second outcome for the legacy corners alert')
  store.clearTelegramOutcomeClaim(CK)
  expect(!store.loadTelegramMessages()[CK], 'clear wrote to the legacy record, no new key')
  expect(store.telegramOutcomeAlreadySent(CK) === false, 'cleared legacy corners outcome')
  expect(store.claimTelegramOutcome(CK) === true, 'claim corners outcome')
  const mapAfter = store.loadTelegramMessages()
  expect(!mapAfter[CK], 'claim did not create a duplicate record under the new key')
  expect(Boolean(mapAfter[K]?.outcomeSentAt), 'claim stored on the legacy record')
  expect(
    Boolean(store.loadAlerts('corners', 'ht').find((a) => a.id === K)?.telegramOutcomeSentAt),
    'corners logged alert patched',
  )
  const goalsAfter = store.loadAlerts('goals', 'ht').find((a) => a.id === K)
  expect(
    (goalsAfter?.telegramOutcomeSentAt ?? null) === (goalsBefore?.telegramOutcomeSentAt ?? null),
    'goals logged alert with the same id untouched',
  )
  store.clearTelegramOutcomeClaim(CK)
  expect(store.telegramOutcomeAlreadySent(CK) === false, 'clear claim')

  // 5. Outcome queue uses market-qualified keys.
  outcomes.resetTelegramOutcomesForTests()
  const settled = (market: 'goals' | 'corners'): LoggedAlert => ({
    ...(store.loadAlerts(market, 'ht').find((a) => a.id === K) as LoggedAlert),
    hit5: true,
    hitLong: true,
    betOutcome: {
      status: 'green',
      rule: 'half-end-v1',
      baseline: 0,
      total: 1,
      targetPeriod: 1,
      event: { min: 40, period: 1, side: 'home' },
      endMin: null,
      reason: 'event',
      decidedAt: new Date().toISOString(),
    },
    telegramOutcomeSentAt: null,
  })
  const queued = outcomes.enqueueSettledTelegramOutcomes([settled('goals'), settled('corners')])
  expect(queued.includes(K) && queued.includes(CK), `both markets queued separately, got ${queued}`)
  outcomes.resetTelegramOutcomesForTests()

  // 6. A new goals alert colliding with the legacy corners record keeps both.
  store.upsertTelegramMessage(K, { messageId: 9001, text: '<b>Golo · test</b>', market: 'goals' })
  const collided = store.loadTelegramMessages()
  expect(collided[K]?.messageId === 9001 && collided[K]?.market === 'goals', 'goals record written')
  expect(!collided[K]?.outcomeSentAt, 'goals record does not inherit corners outcome state')
  expect(collided[CK]?.messageId === 2303, 'legacy corners record preserved under corners: key')
  expect(store.findLoggedAlert(CK)?.market === 'corners', 'corners still resolves after collision')
  expect(store.findLoggedAlert(K)?.market === 'goals', 'goals resolves after collision')

  // 7. Tips: one market cannot block/overwrite the other.
  const legacyTips = store.loadTips()
  const cornersTip = legacyTips.find((t) => t.market === 'corners')!
  expect(
    tips.tipAlreadyOpen(cornersTip.fixtureId, cornersTip.alertId, 'corners'),
    'legacy corners tip found for corners',
  )
  expect(
    !tips.tipAlreadyOpen(cornersTip.fixtureId, cornersTip.alertId, 'goals'),
    'legacy corners tip does not block goals',
  )
  expect(
    tips.tipAlreadyOpen(cornersTip.fixtureId, cornersTip.alertId),
    'market-less check keeps legacy behaviour',
  )
  const fixture = {
    id: 'tipfix',
    team1: 'H',
    team2: 'A',
    team1Id: '',
    team2Id: '',
    competition: 'L',
    category: 't',
    status: 1,
    state: 1,
    dateSeconds: 0,
    liveElapsedSeconds: 38 * 60,
    scoreHome: 0,
    scoreAway: 0,
    scoreIsFt: false,
  }
  const base = {
    id: A,
    rule: 'primary' as const,
    ruleName: 'x',
    min: 38,
    period: 1,
    index: 37,
    side: 'home' as const,
    momentum: 80,
    delta1: 10,
    sustainedLength: 3,
    signals: {
      spike: true,
      swingCombo: true,
      swingSecondary: false,
      sustainedCombo: true,
      sustainedFallback: false,
      fallbackSpike: true,
      sustainedSecondary: false,
    },
    fixtureId: 'tipfix',
    matchLabel: 'H vs A',
    firedAt: new Date().toISOString(),
    coincident: false,
  }
  const odd = { odd: 1.8, line: 0.5, source: 'superscore' as const, sourceLabel: 'SS' }
  const gTip = tips.createTipFromAlert({
    fixture,
    alert: { ...base, market: 'goals', cornerHalf: 'ht' },
    odd,
  })
  const cTip = tips.createTipFromAlert({
    fixture,
    alert: { ...base, market: 'corners', cornerHalf: 'ht' },
    odd,
  })
  const after = store.loadTips()
  expect(gTip.id === `tip-tipfix-${A}` && cTip.id === `tip-corners-tipfix-${A}`, 'tip ids per market')
  expect(after.length === legacyTips.length + 2, `both tips kept, got ${after.length - legacyTips.length}`)
  expect(
    legacyTips.every((t) => after.some((x) => x.id === t.id)),
    'legacy tip ids unchanged',
  )
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-market-keys')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log(
  'OK: market-unique alert/tip keys; production sample loads unchanged; legacy corners Telegram record resolves to corners; goals/corners never suppress each other',
)
