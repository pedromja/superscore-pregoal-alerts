/**
 * Unique league key for the 📊 line and the league follow-up (offline):
 * - same league name in two countries ⇒ two buckets (never merged by name);
 * - SuperScore competition id ⇒ `id:<id>`; a country+name with exactly one
 *   known id resolves to it; with two ids it is ambiguous ⇒ not counted;
 * - old stored matches without the id are backfilled once per day from a
 *   (mocked) fixtures-by-date feed into data/competitions.json; a failed day
 *   falls back to country + name;
 * - label `Inglaterra · Premier League`, ≥3 settled non-VOID rule kept;
 * - tips follow-up grouped by the same key (stored tips backfilled).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-league-key'
const dataDir = join(root, REL_DATA)
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(join(dataDir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
delete process.env.TELEGRAM_BOT_TOKEN
process.env.TELEGRAM_ENABLED = '0'
process.env.WEB_PUSH_ENABLED = '0'
delete process.env.TELEGRAM_LEAGUE_STATS_MIN
process.env.QUALITY_OVERLAY = 'off'
process.env.VOID_CHECK = '0'

type LoggedAlert = import('../server/types.ts').LoggedAlert
type Tip = import('../src/lib/tips.ts').Tip

const store = await import('../server/store.ts')
const league = await import('../server/leagueStats.ts')
const comps = await import('../server/competitions.ts')
const serverTips = await import('../server/tips.ts')
const { computeLeagueFollowup } = await import('../src/lib/tips.ts')
const { fixtureLeagueKey, leagueDisplayLabel } = await import('../src/lib/leagueKey.ts')

const fails: string[] = []
function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

// 2026-09-20 12:00 and 2026-09-21 12:00 UTC (Lisbon days 20 and 21)
const DAY20 = Date.UTC(2026, 8, 20, 12) / 1000
const DAY21 = Date.UTC(2026, 8, 21, 12) / 1000

/** Old stored snapshot (written before competitionId was kept). */
function oldMatch(id: string, category: string, competition: string, dateSeconds: number, competitionId?: string) {
  const fixture: Record<string, unknown> = {
    id, team1: 'Casa', team2: 'Fora', team1Id: 'h', team2Id: 'a', competition, category,
    status: 3, state: 3, dateSeconds, liveElapsedSeconds: 0, scoreHome: 0, scoreAway: 0, scoreIsFt: true,
  }
  if (competitionId) fixture.competitionId = competitionId
  writeFileSync(join(dataDir, 'matches', `${id}.json`), JSON.stringify({ fixture, payload: { timeline: [], events: [] }, finished: true, updatedAt: new Date().toISOString() }))
}

let seq = 0
function settled(fixtureId: string, green: boolean, extra: Partial<LoggedAlert> = {}): LoggedAlert {
  seq += 1
  return {
    id: `${fixtureId}:primary-1-${seq}-${seq}`, fixtureId, matchLabel: 'Casa vs Fora', minute: 30, period: 1, index: seq,
    side: 'home', ruleId: 'primary', features: { v: 30, delta1: null, sustained: 2 }, thresholdsSnapshot: {},
    ts: new Date().toISOString(), coincident: false, hit: green, leadMin: null, hit5: green, hitLong: green,
    longDeadline: 45, leadTime5: null, leadTimeLong: null, labeledAt: null, feedback: null, sentPush: false,
    betOutcome: {
      status: green ? 'green' : 'red', rule: 'half-end-v1', baseline: 0, total: green ? 1 : 0, targetPeriod: 1,
      event: green ? { min: 40, period: 1, side: 'home' } : null, endMin: green ? null : 47,
      reason: green ? 'event' : 'period-over', decidedAt: new Date().toISOString(),
    },
    ...extra,
  }
}

// ── Pure key helpers ───────────────────────────────────────────────────────
expect(fixtureLeagueKey({ competitionId: '17', category: 'England', competition: 'Premier League' }) === 'id:17', 'id key')
expect(fixtureLeagueKey({ category: 'England', competition: 'Premier League' }) === 'cn:england|premier league', 'country + name key')
expect(fixtureLeagueKey({ competition: 'Premier League' }) === null, 'bare name is never a key')
expect(leagueDisplayLabel({ category: 'England', competition: 'Premier League' }) === 'Inglaterra · Premier League', 'PT country label')

// ── Stored history (old files, no ids) ─────────────────────────────────────
// England Premier League (id 17 in the feed): e1..e4 on day 20
for (let i = 1; i <= 4; i += 1) oldMatch(`e${i}`, 'England', 'Premier League', DAY20)
// Egypt "Premier League" (id 808): g1..g3 on day 20
for (let i = 1; i <= 3; i += 1) oldMatch(`g${i}`, 'Egypt', 'Premier League', DAY20)
// Argentina "Primera Division": two competitions share country+name (ids 155, 703)
oldMatch('a1', 'Argentina', 'Primera Division', DAY20, '155')
oldMatch('a2', 'Argentina', 'Primera Division', DAY20, '703')
oldMatch('a3', 'Argentina', 'Primera Division', DAY21) // no id, day 21 feed fails ⇒ ambiguous
oldMatch('a4', 'Argentina', 'Primera Division', DAY21)
oldMatch('a5', 'Argentina', 'Primera Division', DAY21)
// Chile "Cup" on the failing day, unambiguous ⇒ country + name fallback
for (let i = 1; i <= 3; i += 1) oldMatch(`c${i}`, 'Chile', 'Cup', DAY21)

const fetched: string[] = []
const fetchDay = async (date: string) => {
  fetched.push(date)
  if (date === '2026-09-21') throw new Error('feed down')
  return [
    ...[1, 2, 3, 4].map((i) => ({ id: `e${i}`, competitionId: '17', category: 'England', competition: 'Premier League' })),
    ...[1, 2, 3].map((i) => ({ id: `g${i}`, competitionId: '808', category: 'Egypt', competition: 'Premier League' })),
    { id: 'a1', competitionId: '155', category: 'Argentina', competition: 'Primera Division' },
    { id: 'a2', competitionId: '703', category: 'Argentina', competition: 'Primera Division' },
  ]
}

// Corners: England 3🟢/1🔴, Egypt 1🟢/2🔴 (+1 VOID), Argentina a3..a5 3🟢 (ambiguous), Chile 2🟢 only
store.saveAlerts(
  [
    settled('e1', true), settled('e2', true), settled('e3', true), settled('e4', false),
    settled('g1', true), settled('g2', false), settled('g3', false), settled('g3', true, { void: true }),
    settled('a3', true), settled('a4', true), settled('a5', true),
    settled('c1', true), settled('c2', true),
  ],
  'corners',
  'ht',
)
// Tips stored before the league key existed (no leagueKey)
const baseTip = (id: string, fixtureId: string, status: 'won' | 'lost', leagueName: string): Tip => ({
  id, ts: new Date().toISOString(), league: leagueName, home: 'Casa', away: 'Fora', market: 'corners', half: 'ht',
  minute: 30, period: 1, odd: 1.8, line: 4.5, stake: 1, status, pnl: status === 'won' ? 0.8 : -1, rule: 'primary',
  scores: { home: 0, away: 0 }, fixtureId, matchLabel: 'Casa vs Fora', alertId: `${fixtureId}:x`, source: 'superscore',
  sourceLabel: 'SuperScore', settledAt: new Date().toISOString(), longDeadline: 45,
} as Tip)
store.saveTips([
  baseTip('t1', 'e1', 'won', 'Premier League'),
  baseTip('t2', 'e2', 'lost', 'Premier League'),
  baseTip('t3', 'g1', 'won', 'Premier League'),
  baseTip('t4', 'a3', 'won', 'Primera Division'),
])

league.resetLeagueStatsForTests()
comps.resetCompetitionsForTests()
await league.primeLeagueStats({ matchesDir: join(dataDir, 'matches'), loadAlerts: store.loadAlerts, fetchDay })

// ── Backfill ───────────────────────────────────────────────────────────────
expect(JSON.stringify([...fetched].sort()) === JSON.stringify(['2026-09-20', '2026-09-21']), `one request per missing day, got ${JSON.stringify(fetched)}`)
const sidecarPath = join(dataDir, 'competitions.json')
const side = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : null
expect(side?.fixtures?.e1?.competitionId === '17' && side?.fixtures?.g2?.competitionId === '808', 'sidecar stores backfilled ids')
expect(Array.isArray(side?.fetchedDates) && side.fetchedDates.includes('2026-09-20') && !side.fetchedDates.includes('2026-09-21'), 'failed day not marked fetched')
expect(!JSON.parse(readFileSync(join(dataDir, 'matches', 'e1.json'), 'utf8')).fixture.competitionId, 'match files are not rewritten')

// ── Same name, two countries ⇒ two buckets ─────────────────────────────────
const E = league.leagueForFixture('e1')
const G = league.leagueForFixture('g1')
expect(E === 'id:17' && G === 'id:808', `keys by competition id, got ${E} / ${G}`)
const eng = league.leagueStatsFor('corners', E)
const egy = league.leagueStatsFor('corners', G)
expect(eng.green === 3 && eng.settled === 4, `England PL 3/4, got ${JSON.stringify(eng)}`)
expect(egy.green === 1 && egy.settled === 3, `Egypt PL 1/3 (VOID excluded), got ${JSON.stringify(egy)}`)
expect(
  league.formatLeagueLine('corners', eng, 3, league.leagueLabelFor(E ?? '')) === '📊 Inglaterra · Premier League (cantos): 3/4 · 75 %',
  `England line, got ${league.formatLeagueLine('corners', eng, 3, league.leagueLabelFor(E ?? ''))}`,
)
expect(
  league.formatLeagueLine('corners', egy, 3, league.leagueLabelFor(G ?? '')) === '📊 Egito · Premier League (cantos): 1/3 · 33 %',
  'Egypt line',
)

// ── Ambiguous country+name (2 ids, no own id) ⇒ not counted ───────────────
expect(league.leagueForFixture('a3') === null, `ambiguous fixture has no league, got ${league.leagueForFixture('a3')}`)
expect(league.leagueStatsFor('corners', 'id:155').settled === 0 && league.leagueStatsFor('corners', 'id:703').settled === 0, 'ambiguous alerts not counted under any id')
expect(!league.leagueStatsSnapshot().some((r) => r.label.includes('Primera Division')), 'no Primera Division bucket')

// ── Failed day, unambiguous ⇒ country + name; ≥3 rule ─────────────────────
const C = league.leagueForFixture('c1')
expect(C === 'cn:chile|cup', `fallback country + name, got ${C}`)
expect(league.formatLeagueLine('corners', league.leagueStatsFor('corners', C), 3, 'Chile · Cup') === null, '2 settled → no line')
store.saveAlerts([...store.loadAlerts('corners', 'ht'), settled('c3', false)], 'corners', 'ht')
expect(league.formatLeagueLine('corners', league.leagueStatsFor('corners', C), 3, league.leagueLabelFor(C ?? '')) === '📊 Chile · Cup (cantos): 2/3 · 67 %', '3 settled → line')

// ── Live alert line (fixture with id; same pair as a single known id) ─────
const live = league.leagueLineForAlert({ market: 'corners', fixtureId: 'e-live', competition: 'Premier League', category: 'England', competitionId: '17', half: 'ht', alertId: 'e-live:a' })
expect(live === '📊 Inglaterra · Premier League (cantos): 3/4 · 75 %', `live line, got ${live}`)
const noId = league.leagueLineForAlert({ market: 'corners', fixtureId: 'g-live', competition: 'Premier League', category: 'Egypt', half: 'ht', alertId: 'g-live:a' })
expect(noId === '📊 Egito · Premier League (cantos): 1/3 · 33 %', `single known id resolves the pair, got ${noId}`)
const bare = league.leagueLineForAlert({ market: 'corners', fixtureId: 'x-live', competition: 'Premier League', half: 'ht', alertId: 'x-live:a' })
expect(bare === null, 'bare name (no country, no id) → no line')

// ── Tips follow-up by the same key ─────────────────────────────────────────
const n = serverTips.backfillTipLeagues()
expect(n === 3, `3 stored tips get a unique league (ambiguous one skipped), got ${n}`)
const rows = computeLeagueFollowup(store.loadTips())
const byLabel = new Map(rows.map((r) => [r.league, r]))
expect(rows.length === 2, `two league rows (England / Egypt), got ${JSON.stringify(rows.map((r) => r.league))}`)
expect(byLabel.get('Inglaterra · Premier League')?.tips === 2 && byLabel.get('Inglaterra · Premier League')?.key === 'id:17', 'England row has its 2 tips')
expect(byLabel.get('Egito · Premier League')?.tips === 1, 'Egypt row separate')

// ── Re-boot: sidecar reused, only the failed day retried ─────────────────
fetched.length = 0
league.resetLeagueStatsForTests()
comps.resetCompetitionsForTests()
await league.primeLeagueStats({ matchesDir: join(dataDir, 'matches'), loadAlerts: store.loadAlerts, fetchDay })
expect(JSON.stringify(fetched) === JSON.stringify(['2026-09-21']), `re-boot only retries the failed day, got ${JSON.stringify(fetched)}`)
expect(league.leagueForFixture('e3') === 'id:17', 'ids from the sidecar after re-boot')
expect(league.leagueStatsFor('corners', 'id:17').settled === 4, 'same counts after re-boot')

if (fails.length) {
  console.error(`FAIL (${fails.length})`)
  for (const f of fails) console.error(` - ${f}`)
  process.exit(1)
}
console.log('OK: league key by competition id / country+name (same name in 2 countries split, ambiguous not counted), backfill once per day into competitions.json, label with PT country, ≥3 rule, tips follow-up by key')
process.exit(0)
