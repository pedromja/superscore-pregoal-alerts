/**
 * Flat 1u stake: pnl derived from odd + status (stored pnl ignored), invalid /
 * missing odds in W–L but out of PnL/ROI, AUTO league gate on the same ROI.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL_DATA = 'node_modules/.tmp/verify-flat-stake'
const dir = join(root, REL_DATA)
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(dir, 'matches'), { recursive: true })
process.env.DATA_DIR = REL_DATA
delete process.env.TELEGRAM_BOT_TOKEN

const { flatStakePnl, tipFlatPnl, tipOddIssue } = await import('../src/lib/tipPnl.ts')
const { computeLeagueFollowup, computeRoi } = await import('../src/lib/tips.ts')
type Tip = import('../src/lib/tips.ts').Tip

const fail: string[] = []
const near = (a: number | null, b: number | null, msg: string) => {
  if (a === null || b === null ? a !== b : Math.abs(a - b) > 1e-9) fail.push(`${msg}: got ${a}, want ${b}`)
}

near(flatStakePnl(1.8, 'won'), 0.8, 'won')
near(flatStakePnl(1.8, 'lost'), -1, 'lost')
near(flatStakePnl(1.9, 'half_won'), 0.45, 'half-won')
near(flatStakePnl(1.9, 'half_lost'), -0.5, 'half-lost')
near(flatStakePnl(1.9, 'push'), 0, 'push')
near(flatStakePnl(null, 'won'), null, 'missing odd')
near(flatStakePnl(1, 'won'), null, 'odd 1 is not an odd')

let n = 0
function tip(p: Partial<Tip>): Tip {
  n += 1
  return {
    id: `t${n}`, ts: '2026-09-27T10:00:00Z', league: 'L', home: 'A', away: 'B',
    market: 'corners', half: 'ht', minute: 35, period: 1, odd: 1.5, line: 4.5, stake: 1,
    status: 'won', pnl: 99, rule: 'primary', scores: { home: 0, away: 0 }, fixtureId: `f${n}`,
    matchLabel: 'A vs B', alertId: `a${n}`, source: 'superscore',
    sourceLabel: 'SuperScore · Prima repriză - Total cornere · Asiático · Prima repriză - Handicap cornere',
    cornersTally: { home: 2, away: 2 }, goalsTally: { home: 0, away: 0 },
    settledAt: '2026-09-27T10:10:00Z', longDeadline: null, leagueKey: 'id:X', leagueLabel: 'X · Liga',
    ...p,
  } as Tip
}

const good = tip({})
near(tipFlatPnl(good), 0.5, 'stored pnl 99 ignored, flat 1u')
if (tipOddIssue(good) !== null) fail.push('valid HT match total flagged')
const team = tip({ odd: 25, sourceLabel: 'SuperScore · Total cornere Liechtenstein · Asiático · Handicap cornere' })
if (tipOddIssue(team) !== 'team-total') fail.push(`team total not flagged: ${tipOddIssue(team)}`)
const period = tip({ market: 'goals', half: 'ft', odd: 17, line: 2.5, goalsTally: { home: 1, away: 1 }, sourceLabel: 'SuperScore · A doua repriză - Total goluri · Asiático · x' })
if (tipOddIssue(period) !== 'wrong-period') fail.push(`2nd-half market for FT not flagged: ${tipOddIssue(period)}`)
const line = tip({ source: 'sokkerpro', sourceLabel: 'SokkerPro O/U · Over 9', line: 9, odd: 1.8 })
if (tipOddIssue(line) !== 'wrong-line') fail.push(`alt line not flagged: ${tipOddIssue(line)}`)
const missing = tip({ odd: 0 as unknown as number, status: 'lost' })
if (tipOddIssue(missing) !== 'missing') fail.push('missing odd not flagged')
const ftOk = tip({ market: 'goals', half: 'ft', odd: 2.1, line: 2.5, goalsTally: { home: 2, away: 0 }, sourceLabel: 'SuperScore · Total goluri · Peste 2.5' })
if (tipOddIssue(ftOk) !== null) fail.push(`valid FT match total flagged: ${tipOddIssue(ftOk)}`)
const lost = tip({ status: 'lost', odd: 1.4 })
const open = tip({ status: 'open', pnl: null })
const voided = tip({ void: true, odd: 3 })

const all = [good, team, line, missing, lost, open, voided]
const ht = computeRoi(all).find((r) => r.key === 'corners_ht')!
// W–L counts every settled non-VOID tip: good,team,line (won) + missing,lost (lost)
if (ht.won !== 3 || ht.lost !== 2) fail.push(`W–L ${ht.won}-${ht.lost}, want 3-2`)
if (ht.priced !== 2 || ht.noOdd !== 3 || ht.staked !== 2) fail.push(`priced/noOdd/staked ${ht.priced}/${ht.noOdd}/${ht.staked}`)
near(ht.pnl, -0.5, 'row pnl (0.5 - 1)')
near(ht.roi, -0.25, 'row roi = pnl / priced')
if (ht.open !== 1 || ht.tips !== 6) fail.push(`tips/open ${ht.tips}/${ht.open}`)
const lg = computeLeagueFollowup(all, 'corners')[0]
near(lg.pnl, -0.5, 'league pnl')
near(lg.roi, -0.25, 'league roi')

// AUTO gate reads the same flat ROI (valid-odd tips only).
const { shouldSendTelegramForAlert, patchLeagueTelegramGate } = await import('../server/leagueTelegram.ts')
const gateTips: Tip[] = []
for (let i = 0; i < 8; i++) gateTips.push(tip({ fixtureId: 'g', status: i < 6 ? 'won' : 'lost', odd: 1.3 }))
// 6×0.3 − 2 = −0.2 → ROI −2.5 % → AUTO off. A stored pnl of +5 each must not matter.
for (const t of gateTips) t.pnl = 5
// Inflated team-total wins must not lift the ROI either.
for (let i = 0; i < 5; i++) gateTips.push(tip({ status: 'won', odd: 25, sourceLabel: 'SuperScore · Total cornere Foo · x' }))
writeFileSync(join(dir, 'tips.json'), JSON.stringify(gateTips))
patchLeagueTelegramGate({ key: 'id:X', market: 'corners', auto: true, minRoi: 0.05 })
const decision = shouldSendTelegramForAlert({ fixtureId: 'nope', market: 'corners', competitionId: 'X' })
if (decision.send) fail.push('AUTO gate used inflated/stored pnl (should be off at ROI −2.5 %)')
patchLeagueTelegramGate({ key: 'id:X', market: 'corners', minRoi: 0.0001 })
writeFileSync(join(dir, 'tips.json'), JSON.stringify(gateTips.map((t) => (t.status === 'lost' ? { ...t, status: 'won' } : t))))
if (!shouldSendTelegramForAlert({ fixtureId: 'nope', market: 'corners', competitionId: 'X' }).send) {
  fail.push('AUTO gate should send with 8 valid wins')
}

if (fail.length) {
  console.error('FAIL flat stake:\n- ' + fail.join('\n- '))
  process.exit(1)
}
console.log('OK: flat 1u stake (won odd−1, lost −1, half ±, push 0), stored pnl ignored, team-total/other-period/other-line/missing odds in W–L but out of PnL/ROI, VOID out, AUTO gate on the same ROI')
