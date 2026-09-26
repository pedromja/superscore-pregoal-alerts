import { composeOddsObservation, maisUmPriceOf } from '../src/lib/oddsObserve.ts'
import type { OddsSnapshot } from '../src/lib/oddsObserve.ts'
import {
  buildSokkerProOddsKey,
  collectOddsMap,
  flattenMiniFixtures,
  matchSokkerProFixture,
  parseSokkerProOddsKey,
  parseSokkerProPrice,
  pickSokkerProMaisUm,
  wantedMaisUmLine,
} from '../src/lib/sokkerpro.ts'
import { ALERT_ODD_GATE_ENABLED } from '../src/lib/tipOverlay.ts'

const fail: string[] = []

function check(cond: boolean, msg: string) {
  if (!cond) fail.push(msg)
}

check(ALERT_ODD_GATE_ENABLED === false, 'ALERT_ODD_GATE must stay off')

check(parseSokkerProPrice('1.90#0') === 1.9, `parse 1.90#0 got ${parseSokkerProPrice('1.90#0')}`)
check(parseSokkerProPrice('1,85#1') === 1.85, 'parse comma decimal before #')
check(parseSokkerProPrice(2.05) === 2.05, 'parse number')
check(parseSokkerProPrice('1#0') === null, 'price 1 is not usable')
check(parseSokkerProPrice('abc') === null, 'invalid price')
check(parseSokkerProPrice('2.10#0#x') === 2.1, 'only the token before first #')

check(
  buildSokkerProOddsKey({ family: 'goals', side: 'over', line: 2.5 }) ===
    'BET365_GOLS_OVER_2_5',
  'GOLS OVER 2.5 key',
)
check(
  buildSokkerProOddsKey({ family: 'goals', side: 'under', line: 2.5 }) ===
    'BET365_GOLS_UNDER_2_5',
  'GOLS UNDER 2.5 key',
)
check(
  buildSokkerProOddsKey({ family: 'corners', side: 'over', line: 9 }) ===
    'BET365_CANTO_OVER_9',
  'singular CANTO OVER 9',
)
check(
  buildSokkerProOddsKey({ family: 'corners', side: 'under', line: 10 }) ===
    'BET365_CANTO_UNDER_10',
  'singular CANTO UNDER 10',
)
check(
  buildSokkerProOddsKey({ family: 'goals', side: 'over', line: 0.5, period: 'ht', live: true }) ===
    'BET365_GOLS_HT_OVER_0_5_LIVE',
  'HT LIVE key',
)

const parsedCanto = parseSokkerProOddsKey('BET365_CANTO_OVER_9')
check(parsedCanto?.family === 'corners' && parsedCanto.line === 9 && parsedCanto.side === 'over', 'parse CANTO key')
check(wantedMaisUmLine(1) === 1.5, 'mais-um goals line is current+0.5')
check(wantedMaisUmLine(8) === 8.5, 'mais-um corners line is current+0.5')

const board = flattenMiniFixtures({
  data: {
    sortedCategorizedFixtures: [
      {
        fixtures: [
          {
            fixtureId: 4242,
            localTeamName: 'FC Porto',
            visitorTeamName: 'SL Benfica',
            status: '2nd',
            minute: 67,
            BET365_GOLS_OVER_1_5_LIVE: '1.70#0',
          },
          {
            fixtureId: 7,
            localTeamName: 'Other',
            visitorTeamName: 'Side',
            status: 'NS',
          },
        ],
      },
    ],
  },
})
check(board.length === 2, `flatten board ${board.length}`)
const matched = matchSokkerProFixture(board, 'Porto', 'Benfica')
check(matched?.fixtureId === '4242', `fuzzy fixture match got ${matched?.fixtureId}`)

const nestedOdds = collectOddsMap({
  data: {
    preOdds: {
      BET365_GOLS_OVER_2_5: '1.90#0',
      BET365_GOLS_UNDER_2_5: '1.85#0',
    },
  },
})
check(nestedOdds.BET365_GOLS_OVER_2_5 === '1.90#0', 'collect nested preodds keys')

const latestWins = collectOddsMap({
  preodds: [
    {
      created_at: '2026-09-18T15:00:00.000Z',
      BET365_GOLS_OVER_2_5: '2.67#0',
      BET365_CANTO_OVER_9: '2.50#0',
    },
    {
      created_at: '2026-09-17T05:00:00.000Z',
      BET365_GOLS_OVER_2_5: '2.10#0',
      BET365_CANTO_OVER_9: '1.80#0',
    },
  ],
})
check(latestWins.BET365_GOLS_OVER_2_5 === '2.67#0', `latest snapshot wins, got ${latestWins.BET365_GOLS_OVER_2_5}`)
check(latestWins.BET365_CANTO_OVER_9 === '2.50#0', 'latest CANTO snapshot')

const goalsMap = {
  BET365_GOLS_OVER_1_5: '1.95#0',
  BET365_GOLS_UNDER_1_5: '1.80#0',
  BET365_GOLS_OVER_1_5_LIVE: '1.88#0',
  BET365_GOLS_UNDER_1_5_LIVE: '1.84#0',
  BET365_GOLS_OVER_2_5: '1.40#0',
}
const goalsPick = pickSokkerProMaisUm(goalsMap, 'goals', 'ft', 1)
check(goalsPick?.line === 1.5, `goals mais-um line ${goalsPick?.line}`)
check(goalsPick?.odd === 1.88, `prefer LIVE over preodds, got ${goalsPick?.odd}`)
check(goalsPick?.rawKey === 'BET365_GOLS_OVER_1_5_LIVE', `raw key ${goalsPick?.rawKey}`)
check(goalsPick?.underOdd === 1.84, `twin live under ${goalsPick?.underOdd}`)
// Pre-match (preodds) prices are stale for "current total + 0.5": never used.
check(
  pickSokkerProMaisUm({ BET365_GOLS_OVER_1_5: '1.95#0' }, 'goals', 'ft', 1) === null,
  'pre-match price must not be the live +0.5 odd',
)

// Only the exact next line: integer / other lines are a different bet.
const cornersMap = {
  BET365_CANTO_OVER_8_LIVE: '1.50#0',
  BET365_CANTO_OVER_9_LIVE: '1.91#0',
  BET365_CANTO_UNDER_9_LIVE: '1.89#0',
  BET365_CANTO_OVER_10_LIVE: '1.60#0',
}
check(pickSokkerProMaisUm(cornersMap, 'corners', 'ft', 8) === null, 'no CANTO 8.5 ⇒ no pick (not the nearest line)')
const cornersPick = pickSokkerProMaisUm({ ...cornersMap, BET365_CANTO_OVER_8_5_LIVE: '1.30#0' }, 'corners', 'ft', 8)
check(cornersPick?.line === 8.5, `CANTO exact 8.5, got ${cornersPick?.line}`)
check(cornersPick?.odd === 1.3, `CANTO over 8.5 price ${cornersPick?.odd}`)
check(cornersPick?.rawKey === 'BET365_CANTO_OVER_8_5_LIVE', `CANTO raw key ${cornersPick?.rawKey}`)

const htMap = {
  BET365_GOLS_OVER_0_5_LIVE: '1.20#0',
  BET365_GOLS_HT_OVER_0_5_LIVE: '1.75#0',
}
const htPick = pickSokkerProMaisUm(htMap, 'goals', 'ht', 0)
check(htPick?.rawKey === 'BET365_GOLS_HT_OVER_0_5_LIVE', `HT takes the HT key, got ${htPick?.rawKey}`)
const ftIgnoresHt = pickSokkerProMaisUm(htMap, 'goals', 'ft', 0)
check(ftIgnoresHt?.rawKey === 'BET365_GOLS_OVER_0_5_LIVE', `FT takes the full-match key, got ${ftIgnoresHt?.rawKey}`)
check(
  pickSokkerProMaisUm({ BET365_GOLS_OVER_0_5_LIVE: '1.20#0' }, 'goals', 'ht', 0) === null,
  'HT alert must not fall back to the full-match key',
)
check(
  pickSokkerProMaisUm({ BET365_GOLS_2T_OVER_0_5_LIVE: '1.20#0' }, 'goals', 'ft', 0) === null,
  '2nd-half-only key is not the full-match line',
)

const ssLimit: OddsSnapshot = {
  kind: 'limit',
  marketName: 'Total goluri',
  line: 1.5,
  prices: [
    { name: 'Peste 1.5', price: 1.95, line: 1.5, side: 'over' },
    { name: 'Sub 1.5', price: 1.8, line: 1.5, side: 'under' },
  ],
}
const sproPick = pickSokkerProMaisUm(goalsMap, 'goals', 'ft', 1)
const basePartial = {
  ts: '2026-09-18T12:00:00.000Z',
  fixtureId: 'ss-1',
  matchLabel: 'Porto vs Benfica',
  league: 'Liga Portugal',
  market: 'goals' as const,
  half: 'ft' as const,
  minute: 67,
  period: 2,
  alertId: 'primary-2-67-0',
  currentTotal: 1,
}

  const ssHit = composeOddsObservation({
  partial: basePartial,
  limit: ssLimit,
  asian: null,
  sokkerpro: sproPick,
  robobet: { odd: 2.2, line: 1.5 },
})
check(ssHit.source === 'mixed', `SS+SPro+RB source ${ssHit.source}`)
const ssPrice = maisUmPriceOf(ssHit)
check(ssPrice?.source === 'superscore' && ssPrice.odd === 1.95, `cascade SS wins ${JSON.stringify(ssPrice)}`)

const ssOnly = composeOddsObservation({
  partial: basePartial,
  limit: ssLimit,
  asian: null,
  sokkerpro: null,
  robobet: null,
})
check(ssOnly.source === 'superscore', `SS-only source ${ssOnly.source}`)
check(maisUmPriceOf(ssOnly)?.source === 'superscore', 'SS-only mais-um source')

const sproHit = composeOddsObservation({
  partial: basePartial,
  limit: null,
  asian: null,
  sokkerpro: sproPick,
  robobet: { odd: 2.2, line: 1.5 },
})
check(sproHit.source === 'mixed', `SPro+RB source ${sproHit.source}`)
check(/SokkerPro O\/U/.test(sproHit.sourceLabel), `SPro label ${sproHit.sourceLabel}`)
const sproPrice = maisUmPriceOf(sproHit)
check(
  sproPrice?.source === 'sokkerpro' && sproPrice.odd === 1.88 && sproPrice.line === 1.5,
  `cascade SPro before RoboBet ${JSON.stringify(sproPrice)}`,
)
check(sproHit.limit?.marketName === 'SokkerPro O/U', 'SPro fills limit snapshot')
check(sproHit.sokkerpro?.rawKey === 'BET365_GOLS_OVER_1_5_LIVE', 'stores raw key')

const rbHit = composeOddsObservation({
  partial: basePartial,
  limit: null,
  asian: null,
  sokkerpro: null,
  robobet: { odd: 2.2, line: 1.5 },
})
check(rbHit.source === 'robobet', `RB-only source ${rbHit.source}`)
check(maisUmPriceOf(rbHit)?.source === 'robobet', 'cascade RoboBet last')

const none = composeOddsObservation({
  partial: basePartial,
  limit: null,
  asian: null,
  sokkerpro: null,
  robobet: null,
})
check(none.source === 'none', 'empty stays none')
check(maisUmPriceOf(none) === null, 'missing odd does not invent a tip price')

const asianOnly: OddsSnapshot = {
  kind: 'asian',
  marketName: 'Handicap asiatic',
  line: -0.5,
  prices: [{ name: '1 (-0.5)', price: 1.91, line: -0.5, side: 'home' }],
}
const asianPlusSpro = composeOddsObservation({
  partial: basePartial,
  limit: null,
  asian: asianOnly,
  sokkerpro: sproPick,
  robobet: null,
})
check(asianPlusSpro.source === 'mixed', 'asian SS + SPro limit is mixed')
check(maisUmPriceOf(asianPlusSpro)?.source === 'sokkerpro', 'mais-um from SPro when SS has no over')

const {
  beginSokkerProTick,
  fetchSokkerProBoard,
  loadSokkerProMatchOdds,
  resetSokkerProStateForTests,
  setSokkerProFetchForTests,
  setSokkerProNowForTests,
  warmupSokkerProBoard,
} = await import('../server/sokkerpro.ts')

function miniPayload(
  fixtures: Array<{
    fixtureId: string | number
    localTeamName: string
    visitorTeamName: string
    status?: string
  }>,
) {
  return {
    data: {
      sortedCategorizedFixtures: [{ fixtures }],
    },
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function runBoardCacheTests(): Promise<void> {
  const now = new Date('2026-09-18T15:00:00.000Z')
  const todayUrl = 'https://m2.sokkerpro.com/home/fixtures/2026-09-18/utc/mini'
  const yesterdayUrl = 'https://m2.sokkerpro.com/home/fixtures/2026-09-17/utc/mini'
  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '))
  }

  try {
    resetSokkerProStateForTests()
    setSokkerProNowForTests(now)
    const urls: string[] = []
    let inflightStarted = 0
    let releaseInflight: (() => void) | null = null
    const inflightGate = new Promise<void>((resolve) => {
      releaseInflight = resolve
    })
    setSokkerProFetchForTests(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/utc/mini')) {
        inflightStarted += 1
        await inflightGate
        return jsonRes(
          miniPayload([
            {
              fixtureId: '4242',
              localTeamName: 'FC Porto',
              visitorTeamName: 'SL Benfica',
              status: '2nd',
            },
          ]),
        )
      }
      if (url.includes('/preodds')) {
        return jsonRes({
          preodds: [{ created_at: '2026-09-18T12:00:00.000Z', BET365_GOLS_OVER_1_5: '1.90#0' }],
        })
      }
      return jsonRes({ success: false }, 404)
    })

    const p1 = fetchSokkerProBoard('2026-09-18')
    const p2 = fetchSokkerProBoard('2026-09-18')
    check(inflightStarted === 1, `inflight coalesces board fetch, started ${inflightStarted}`)
    releaseInflight?.()
    const [a, b] = await Promise.all([p1, p2])
    check(a?.length === 1 && b?.length === 1, 'inflight callers share the board')
    await fetchSokkerProBoard('2026-09-18')
    check(
      urls.filter((u) => u === todayUrl).length === 1,
      `cache reuses today mini, got ${urls.filter((u) => u === todayUrl).length}`,
    )

    resetSokkerProStateForTests()
    setSokkerProNowForTests(now)
    urls.length = 0
    inflightStarted = 0
    setSokkerProFetchForTests(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url === todayUrl) {
        return jsonRes(
          miniPayload([
            {
              fixtureId: '4242',
              localTeamName: 'FC Porto',
              visitorTeamName: 'SL Benfica',
              status: '2nd',
            },
            {
              fixtureId: '7',
              localTeamName: 'Sporting',
              visitorTeamName: 'Braga',
              status: '1st',
            },
          ]),
        )
      }
      if (url.includes('/preodds')) {
        return jsonRes({
          preodds: [{ created_at: '2026-09-18T12:00:00.000Z', BET365_GOLS_OVER_1_5: '1.90#0' }],
        })
      }
      return jsonRes({ success: false }, 404)
    })
    await warmupSokkerProBoard()
    const first = await loadSokkerProMatchOdds('Porto', 'Benfica')
    const second = await loadSokkerProMatchOdds('Sporting', 'Braga')
    check(first?.fixture.fixtureId === '4242', 'warmup match Porto')
    check(second?.fixture.fixtureId === '7', 'warmup match Sporting')
    check(
      urls.filter((u) => u.includes('/utc/mini')).length === 1,
      `one mini for two fixtures, got ${urls.filter((u) => u.includes('/utc/mini')).length}`,
    )
    check(
      urls.filter((u) => u === yesterdayUrl).length === 0,
      'yesterday skipped when today has the match',
    )
    check(
      urls.filter((u) => u.includes('/preodds')).length === 2,
      'preodds still per fixture',
    )

    resetSokkerProStateForTests()
    setSokkerProNowForTests(now)
    urls.length = 0
    warns.length = 0
    setSokkerProFetchForTests(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/utc/mini')) {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }
      return jsonRes({ success: false }, 404)
    })
    await warmupSokkerProBoard()
    await loadSokkerProMatchOdds('Porto', 'Benfica')
    await loadSokkerProMatchOdds('Sporting', 'Braga')
    check(
      urls.filter((u) => u === todayUrl).length === 1,
      `timeout: today fetched once, got ${urls.filter((u) => u === todayUrl).length}`,
    )
    check(
      urls.filter((u) => u === yesterdayUrl).length === 0,
      'timeout: do not serial-wait yesterday',
    )
    const boardWarns = warns.filter((w) => w.includes('/utc/mini'))
    check(boardWarns.length === 1, `timeout: one board warn per tick, got ${boardWarns.length}`)

    beginSokkerProTick()
    await loadSokkerProMatchOdds('Porto', 'Benfica')
    check(
      urls.filter((u) => u === todayUrl).length === 2,
      'next tick retries a failed mini once',
    )
    check(
      warns.filter((w) => w.includes('/utc/mini')).length === 2,
      'next tick may log the retry once',
    )

    resetSokkerProStateForTests()
    setSokkerProNowForTests(now)
    urls.length = 0
    setSokkerProFetchForTests(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url === todayUrl) {
        return jsonRes(
          miniPayload([
            {
              fixtureId: '99',
              localTeamName: 'Other',
              visitorTeamName: 'Side',
              status: 'NS',
            },
          ]),
        )
      }
      if (url === yesterdayUrl) {
        return jsonRes(
          miniPayload([
            {
              fixtureId: '100',
              localTeamName: 'FC Porto',
              visitorTeamName: 'SL Benfica',
              status: 'FT',
            },
          ]),
        )
      }
      return jsonRes({ preodds: [] })
    })
    const late = await loadSokkerProMatchOdds('Porto', 'Benfica')
    check(late?.fixture.fixtureId === '100', `yesterday used on name miss, got ${late?.fixture.fixtureId}`)
    check(
      urls.filter((u) => u === todayUrl).length === 1 &&
        urls.filter((u) => u === yesterdayUrl).length === 1,
      'name miss: today then yesterday, not parallel double-timeout',
    )
  } finally {
    console.warn = origWarn
    resetSokkerProStateForTests()
  }
}

await runBoardCacheTests()

if (fail.length) {
  console.error('FAIL', fail)
  process.exit(1)
}
console.log('OK: SokkerPro parse/keys/CANTO nearest, cascade SS → SPro → RoboBet, ALERT_ODD_GATE off')
console.log(
  JSON.stringify(
    {
      goalsPick,
      cornersPick,
      ssPrice,
      sproPrice,
      sourceLabel: sproHit.sourceLabel,
    },
    null,
    2,
  ),
)
