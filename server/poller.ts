import { evaluateAlerts, extractGoals } from '../src/lib/rules.ts'
import type { FeedAlert, Fixture } from '../src/lib/types.ts'
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
  loadSent,
  markSent,
  primeFixture,
  saveMatch,
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

function copyFor(alert: FeedAlert): { title: string; body: string } {
  const side = alert.side === 'home' ? 'Casa' : 'Fora'
  const sign = alert.momentum > 0 ? `+${alert.momentum}` : String(alert.momentum)
  const rule =
    alert.rule === 'primary'
      ? 'Primária'
      : alert.rule === 'secondary'
        ? 'Secundária'
        : 'Reserva'
  return {
    title: `${rule} · ${alert.matchLabel}`,
    body: `${alert.min}' · ${side} · v ${sign}`,
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

  const settings = currentSettings()
  const { points, alerts } = evaluateAlerts(payload, settings)
  const goals = extractGoals(payload, points)
  const goalKeys = new Set(goals.map((g) => `${g.period}-${g.min}-${g.index}`))
  const first = !isPrimed(fixture.id)
  if (first) primeFixture(fixture.id)

  const fresh: FeedAlert[] = alerts.map((alert) => ({
    ...alert,
    fixtureId: fixture.id,
    matchLabel: `${fixture.team1} vs ${fixture.team2}`,
    firedAt: new Date().toISOString(),
    coincident: goalKeys.has(`${alert.period}-${alert.min}-${alert.index}`),
  }))

  if (first) {
    for (const alert of fresh) markSent(`${fixture.id}:${alert.id}`)
    if (finished) {
      ingestFeedAlerts(fresh, settings, false)
      labelMatch({
        fixture,
        payload,
        finished,
        updatedAt: new Date().toISOString(),
      })
    }
    return 0
  }

  ingestFeedAlerts(fresh, settings, false)
  if (finished) {
    labelMatch({
      fixture,
      payload,
      finished,
      updatedAt: new Date().toISOString(),
    })
  }

  let sent = 0
  for (const alert of fresh) {
    if (alert.coincident) continue
    if (alert.rule === 'secondary' && !settings.notifySecondary) continue
    if (alert.rule === 'fallback' && !settings.notifyFallback) continue
    if (alert.rule === 'primary' && !settings.notifyPrimary) continue
    const key = `${fixture.id}:${alert.id}`
    if (loadSent().includes(key)) continue
    if (!markSent(key)) continue
    const copy = copyFor(alert)
    await sendPushToAll({
      title: copy.title,
      body: copy.body,
      url: `/#/monitor?alert=${encodeURIComponent(key)}`,
      alertKey: key,
      tag: `pregoal:${key}`,
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
