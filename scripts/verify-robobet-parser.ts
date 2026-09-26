import { pickAsianSnapshot, pickLimitSnapshot, pickMaisUmOdd, type SuperbetEvent } from '../src/lib/oddsMarkets.ts'
import {
  parseRobobetText,
  quoteFromIngestBody,
} from '../src/lib/robobet.ts'
import { fixtureMatchesQuote } from '../src/lib/tips.ts'

const SAMPLE = `
🏆 Liga: Premier League
⚽ Jogo: Team A v Team B
⏰ Tempo: 25'
🔢 Placar: 0-0
📊 Mercado: Escanteios - Mais de 5 (1T) — linha 4.5
💰 Pre-jogo: 1,90
💰 Ao Vivo: 2,10
💰 Odd Ao Vivo: 2,00
`.trim()

const SAMPLE_GOALS = `
Liga: Liga Portugal
Jogo: Porto vs Benfica
Tempo: 67'
Placar: 1-0
Mercado: Gols - Mais de 1.5
Odd Ao Vivo: 1,85
`.trim()

const fail: string[] = []

const parsed = parseRobobetText(SAMPLE, 'A')
if (parsed.odd !== 2) fail.push(`odd got ${parsed.odd} expected 2`)
if (parsed.league !== 'Premier League') fail.push(`liga ${parsed.league}`)
if (parsed.home !== 'Team A' || parsed.away !== 'Team B') {
  fail.push(`teams ${parsed.home} ${parsed.away}`)
}
if (parsed.minute !== 25) fail.push(`minute ${parsed.minute}`)
if (parsed.scoreHome !== 0 || parsed.scoreAway !== 0) fail.push('placar')
if (parsed.market !== 'corners') fail.push(`market ${parsed.market}`)
if (parsed.linha !== 4.5) fail.push(`linha ${parsed.linha} expected 4.5 (prefer linha over Mais de 5)`)
if (parsed.half !== 'ht') fail.push(`half ${parsed.half}`)
if (SAMPLE.includes('Pre-jogo: 1,90') && parsed.odd === 1.9) {
  fail.push('used Pre-jogo as tip odd')
}
if (parsed.odd === 2.1) fail.push('used Ao Vivo 1X2 as tip odd')

const noLive = parseRobobetText(`
💰 Pre-jogo: 1,90
💰 Ao Vivo: 2,10
📊 Mercado: Gols - Ambos marcam (JT)
`)
if (noLive.odd !== null) fail.push('1X2 Ao Vivo must not become tip odd')

const ingest = quoteFromIngestBody({
  texto_alerta: SAMPLE_GOALS,
  odd: '1,85',
  linha: 1.5,
  mercado: 'Gols - Mais de 1.5',
  liga: 'Liga Portugal',
  jogo: 'Porto vs Benfica',
})
if (ingest.odd !== 1.85) fail.push(`ingest odd ${ingest.odd}`)
if (ingest.market !== 'goals') fail.push(`ingest market ${ingest.market}`)
if (ingest.home !== 'Porto') fail.push(`ingest home ${ingest.home}`)

const event: SuperbetEvent = {
  event_id: 1,
  markets: [
    {
      name: 'Final',
      id: 547,
      odds: [
        { price: 1.8, metadata: { name: '1' }, status: 1, display: true },
        { price: 3.4, metadata: { name: 'X' }, status: 1, display: true },
        { price: 4.0, metadata: { name: '2' }, status: 1, display: true },
      ],
    },
    {
      name: 'Total goluri',
      id: 200734,
      odds: [
        { price: 1.8, metadata: { name: 'Sub 1.5' }, status: 1, display: true },
        { price: 1.95, metadata: { name: 'Peste 1.5' }, status: 1, display: true },
        { price: 1.4, metadata: { name: 'Peste 2.5' }, status: 1, display: true },
      ],
    },
    {
      name: 'Handicap asiatic',
      id: 12,
      odds: [
        { price: 1.91, metadata: { name: '1 (-0.5)' }, status: 1, display: true },
        { price: 1.89, metadata: { name: '2 (+0.5)' }, status: 1, display: true },
      ],
    },
    {
      name: 'Prima repriză - Total cornere',
      id: 878,
      odds: [
        { price: 1.72, metadata: { name: 'Peste 4.5' }, status: 1, display: true },
        { price: 2.02, metadata: { name: 'Sub 4.5' }, status: 1, display: true },
      ],
    },
  ],
}

const goalsPick = pickMaisUmOdd(event, 'goals', 'ft', 1)
if (!goalsPick || goalsPick.odd !== 1.95 || goalsPick.line !== 1.5) {
  fail.push(`goals mais-um pick ${JSON.stringify(goalsPick)}`)
}
const only1x2 = pickMaisUmOdd(
  { event_id: 2, markets: [event.markets![0]] },
  'goals',
  'ft',
  0,
)
if (only1x2) fail.push('1X2 Final must not be used as mais-um odd')

const cornersPick = pickMaisUmOdd(event, 'corners', 'ht', 4)
if (!cornersPick || cornersPick.line !== 4.5 || cornersPick.odd !== 1.72) {
  fail.push(`corners HT pick ${JSON.stringify(cornersPick)}`)
}

const limitGoals = pickLimitSnapshot(event, 'goals', 'ft', 1)
if (!limitGoals?.prices.some((p) => p.side === 'over' && p.line === 1.5 && p.price === 1.95)) {
  fail.push(`limit goals ${JSON.stringify(limitGoals)}`)
}
const asianGoals = pickAsianSnapshot(event, 'goals', 'ft')
if (!asianGoals || asianGoals.marketName !== 'Handicap asiatic') {
  fail.push(`asian goals ${JSON.stringify(asianGoals)}`)
}

const score = fixtureMatchesQuote('FC Porto', 'SL Benfica', 'Porto', 'Benfica')
if (score < 0.58) fail.push(`fuzzy score ${score}`)

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log('OK: Odd Ao Vivo parse, ignore 1X2 Pre-jogo/Ao Vivo, linha from Mercado, SuperScore Over current+0.5')
console.log(JSON.stringify({
  odd: parsed.odd,
  linha: parsed.linha,
  market: parsed.market,
  home: parsed.home,
  away: parsed.away,
  goalsPick,
  cornersPick,
}, null, 2))
