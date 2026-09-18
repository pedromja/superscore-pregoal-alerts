import { pushTagFor } from '../src/lib/market.ts'
import { evaluateAlerts, extractMarketEvents, settingsForAlert } from '../src/lib/rules.ts'
import { alertNotificationCopy, withMatchTallies } from '../src/lib/tally.ts'
import type { CornersByHalf, FeedAlert, Fixture } from '../src/lib/types.ts'
import {
  POLLER_ENABLED,
  POLLER_INTERVAL_MS,
  POLLER_REGION,
} from './config.ts'
import { currentSettings, ingestFeedAlerts, labelMatch } from './learn.ts'
import { sendPushToAll } from './push.ts'
import { fetchFixturesServer, fetchMomentumServer, lisbonDate } from './ss.ts'
import {
  isPrimed,
  loadActiveMarket,
  loadSent,
  markSent,
  primedKey,
  primeFixture,
  saveMatch,
  sentKey,
} from './store.ts'
import type { PollerStatus } from './types.ts'

const status: PollerStatus = {
  enabled: POLLER_ENABLED,
  region: POLLER_REGION,
  intervalMs: POLLER_INTERVAL_MS,
  lastTickAt: null,
  lastError: null,
  liveWatched: 0,
  alertsSent: 0,
}

export function getPollerStatus(): PollerStatus {
  return { ...status }
}

function cornersBundle(): CornersByHalf {
  return {
    ht: currentSettings('corners', 'ht'),
    ft: currentSettings('corners', 'ft'),
  }
}

async function processFixture(fixture: Fixture): Promise<number> {
  const payload = await fetchMomentumServer(fixture.id)
  const finished = fixture.state === 2 || fixture.status >= 100
  saveMatch({
    fixture,
    payload,
    finished,
    updatedAt: new Date().toISOString(),
  })

  const market = loadActiveMarket()
  const settings = currentSettings(market)
  const byHalf = market === 'corners' ? cornersBundle() : undefined
  const { points, alerts } = evaluateAlerts(payload, settings, undefined, byHalf)
  const events = extractMarketEvents(
    payload,
    points,
    market,
    market === 'corners' ? undefined : settings.cornerHalf,
  )
  const eventKeys = new Set(events.map((g) => `${g.period}-${g.min}-${g.index}`))
  const primedId = primedKey(market, fixture.id)
  const first = !isPrimed(primedId)
  if (first) primeFixture(primedId)

  const fresh: FeedAlert[] = alerts.map((alert) =>
    withMatchTallies(
      {
        ...alert,
        fixtureId: fixture.id,
        matchLabel: `${fixture.team1} vs ${fixture.team2}`,
        firedAt: new Date().toISOString(),
        coincident: eventKeys.has(`${alert.period}-${alert.min}-${alert.index}`),
        market,
      },
      payload,
    ),
  )

  if (first) {
    for (const alert of fresh) {
      markSent(sentKey(market, fixture.id, alert.id, alert.cornerHalf))
    }
    if (finished) {
      ingestFeedAlerts(fresh, settings, false, market)
      labelMatch(
        {
          fixture,
          payload,
          finished,
          updatedAt: new Date().toISOString(),
        },
        undefined,
        market,
      )
    }
    return 0
  }

  ingestFeedAlerts(fresh, settings, false, market)
  if (finished) {
    labelMatch(
      {
        fixture,
        payload,
        finished,
        updatedAt: new Date().toISOString(),
      },
      undefined,
      market,
    )
  }

  let sent = 0
  for (const alert of fresh) {
    if (alert.coincident) continue
    const notify = settingsForAlert(alert, settings, byHalf)
    if (alert.rule === 'secondary' && !notify.notifySecondary) continue
    if (alert.rule === 'fallback' && !notify.notifyFallback) continue
    if (alert.rule === 'primary' && !notify.notifyPrimary) continue
    if (!notify.notificationsEnabled) continue
    const key = sentKey(market, fixture.id, alert.id, alert.cornerHalf)
    if (loadSent().includes(key)) continue
    if (!markSent(key)) continue
    const copy = alertNotificationCopy(alert)
    const alertKey = `${fixture.id}:${alert.id}`
    await sendPushToAll({
      title: copy.title,
      body: copy.body,
      url: `/#/monitor?alert=${encodeURIComponent(alertKey)}`,
      alertKey,
      tag: pushTagFor(market, key),
    })
    sent += 1
  }
  return sent
}

export async function tick(): Promise<void> {
  if (!POLLER_ENABLED) return
  try {
    const fixtures = await fetchFixturesServer(lisbonDate(), POLLER_REGION)
    const live = fixtures.filter((f) => f.state === 1)
    const recentDone = fixtures
      .filter((f) => f.state === 2 || f.status >= 100)
      .slice(0, 6)
    const targets = [...live.slice(0, 8), ...recentDone]
    status.liveWatched = live.length
    let sent = 0
    for (const fixture of targets) {
      try {
        sent += await processFixture(fixture)
      } catch (err) {
        status.lastError =
          err instanceof Error ? err.message : 'Falha num jogo'
      }
    }
    status.alertsSent += sent
    status.lastTickAt = new Date().toISOString()
    if (targets.length) status.lastError = status.lastError
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : 'Tick falhou'
    status.lastTickAt = new Date().toISOString()
  }
}

export function startPoller(): void {
  if (!POLLER_ENABLED) return
  void tick()
  setInterval(() => {
    void tick()
  }, POLLER_INTERVAL_MS)
}
