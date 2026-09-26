/**
 * POLLER_ENABLED=false (or 0/off) must start with no ticks: no fixture
 * fetch, no evaluate, no Telegram, no data writes. Used for safe cutover.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-poller-enabled'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
process.env.POLLER_ENABLED = 'false'
process.env.TELEGRAM_BOT_TOKEN = 'TEST_TOKEN_DO_NOT_USE'
process.env.TELEGRAM_CHAT_ID = '-1001234567890'

const config = await import('../server/config.ts')
const poller = await import('../server/poller.ts')
const telegram = await import('../server/telegram.ts')

const fails: string[] = []
const expect = (cond: boolean, msg: string) => {
  if (!cond) fails.push(msg)
}

const p = config.parseEnabledFlag
expect(p(undefined) === true && p('') === true && p('  ') === true, 'unset → default on')
expect(p(undefined, false) === false, 'unset → explicit fallback')
for (const off of ['0', 'false', 'FALSE', 'off', 'Off', 'no', 'disabled', ' false ']) {
  expect(p(off) === false, `${JSON.stringify(off)} → off`)
}
for (const on of ['1', 'true', 'on', 'yes']) expect(p(on) === true, `${on} → on`)
expect(config.POLLER_ENABLED === false, 'POLLER_ENABLED=false parsed as off')

let fixtureFetches = 0
let momentumFetches = 0
let telegramCalls = 0
telegram.setTelegramFetchForTests(async () => {
  telegramCalls += 1
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
})
poller.setPollerDepsForTests({
  fetchFixtures: async () => {
    fixtureFetches += 1
    return []
  },
  warmup: async () => undefined,
  fetchMomentum: async () => {
    momentumFetches += 1
    return { timeline: [], events: [] }
  },
})
try {
  await poller.tick()
  poller.startPoller()
  await new Promise((r) => setTimeout(r, 50))
  expect(fixtureFetches === 0 && momentumFetches === 0, 'no fetch when disabled')
  expect(telegramCalls === 0, 'no Telegram when disabled')
  expect(poller.getPollerStatus().enabled === false, 'status.enabled false')
  expect(poller.getPollerStatus().lastTickAt === null, 'no tick recorded')
  // vapid.json is created at import when missing (web-push keys), not by the poller.
  const written = existsSync(dataDir)
    ? readdirSync(dataDir).filter((f) => f !== 'matches' && f !== 'vapid.json')
    : []
  expect(written.length === 0, `no data files written, got ${written.join(',')}`)
} finally {
  poller.resetPollerRuntimeForTests()
  telegram.setTelegramFetchForTests(null)
  rmSync(dataDir, { recursive: true, force: true })
}

if (fails.length) {
  console.error('FAIL verify-poller-enabled')
  for (const f of fails) console.error(' -', f)
  process.exit(1)
}
console.log('OK: POLLER_ENABLED=false/0/off → no ticks, no fetch, no Telegram, no data writes')
