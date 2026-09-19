import { RefreshCw, Radio, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCard } from '../components/AlertCard'
import { MomentumChart } from '../components/MomentumChart'
import { fetchFixtures, fetchMomentum } from '../lib/api'
import { DEMO_MATCHES } from '../lib/demos'
import {
  formatKickoff,
  matchPhase,
  minuteLabel,
  phaseLabel,
  scoreLabel,
} from '../lib/format'
import { marketCopy, parseMarket } from '../lib/market'
import {
  loadFeed,
  loadPrimed,
  loadSeen,
  saveFeed,
  savePrimed,
  saveSeen,
} from '../lib/monitorStore'
import {
  alertDomId,
  feedAlertKey,
  ruleNotifyEnabled,
  showAlertNotification,
} from '../lib/notifications'
import { postAlerts, postFeedback, fetchPollerStatus } from '../lib/learnApi'
import { evaluateAlerts, extractMarketEvents, settingsForAlert } from '../lib/rules'
import { withMatchTallies } from '../lib/tally'
import type {
  AlertSettings,
  CornersByHalf,
  FeedAlert,
  Fixture,
  MomentumPayload,
} from '../lib/types'
import { CORNER_WINDOWS, GOAL_WINDOWS, cornerHalfOf, goalHalfOf } from '../lib/windows'

type Props = {
  settings: AlertSettings
  cornersByHalf: CornersByHalf
  date: string
  onDate: (value: string) => void
  focusAlertKey?: string | null
  onFocusConsumed?: () => void
}

const POLL_MS = 12000

export function MonitorPage({
  settings,
  cornersByHalf,
  date,
  onDate,
  focusAlertKey,
  onFocusConsumed,
}: Props) {
  const market = parseMarket(settings.market)
  const copy = marketCopy(market)
  const [region, setRegion] = useState('ro')
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [watchLive, setWatchLive] = useState(true)
  const [feed, setFeed] = useState<FeedAlert[]>(() => loadFeed(parseMarket(settings.market)))
  const [payload, setPayload] = useState<MomentumPayload | null>(null)
  const [payloadError, setPayloadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [highlightKey, setHighlightKey] = useState<string | null>(
    focusAlertKey ?? null,
  )
  const [pollerLine, setPollerLine] = useState<string | null>(null)
  const seen = useRef(loadSeen(parseMarket(settings.market)))
  const primed = useRef(loadPrimed(parseMarket(settings.market)))

  const selected = fixtures.find((f) => f.id === selectedId) ?? null

  async function loadFixtures(silent = false) {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const list = await fetchFixtures(date, region)
      setFixtures(list)
      setSelectedId((current) => {
        if (current && list.some((f) => f.id === current)) return current
        const live = list.find((f) => f.state === 1)
        return live?.id ?? list[0]?.id ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha a obter jogos')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadFixtures()
  }, [date, region])

  useEffect(() => {
    const tick = window.setInterval(() => void loadFixtures(true), 30000)
    return () => window.clearInterval(tick)
  }, [date, region])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function readPoller() {
      const status = await fetchPollerStatus()
      if (cancelled || !status) return
      const last = status.lastTickAt
        ? new Date(status.lastTickAt).toLocaleTimeString('pt-PT')
        : '—'
      setPollerLine(
        status.enabled
          ? `Servidor: ${status.liveWatched} ao vivo · ${status.inWindowThisTick ?? 0} em janela · tick ${last} · ${status.alertsSent} avisos`
          : 'Poller do servidor desligado',
      )
    }
    void readPoller()
    const tick = window.setInterval(() => void readPoller(), 20000)
    return () => {
      cancelled = true
      window.clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    seen.current = loadSeen(market)
    primed.current = loadPrimed(market)
    setFeed(loadFeed(market))
  }, [market])

  useEffect(() => {
    saveFeed(feed, market)
  }, [feed])

  useEffect(() => {
    if (!focusAlertKey) return
    setHighlightKey(focusAlertKey)
    const fixtureId = focusAlertKey.split(':')[0]
    if (fixtureId) setSelectedId(fixtureId)
    const timer = window.setTimeout(() => {
      const el = document.getElementById(alertDomId(focusAlertKey))
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      onFocusConsumed?.()
    }, 80)
    return () => window.clearTimeout(timer)
  }, [focusAlertKey, feed, onFocusConsumed])

  const byHalf = cornersByHalf

  function ingest(
    fixture: Fixture,
    data: MomentumPayload,
    markSelected: boolean,
  ) {
    const { points, alerts } = evaluateAlerts(data, settings, undefined, byHalf)
    const events = extractMarketEvents(data, points, market)
    const eventKeys = new Set(events.map((g) => `${g.period}-${g.min}-${g.index}`))
    const firstSnapshot = !primed.current.has(fixture.id)
    const fresh: FeedAlert[] = []
    for (const alert of alerts) {
      const key = `${fixture.id}:${alert.id}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      fresh.push(
        withMatchTallies(
          {
            ...alert,
            fixtureId: fixture.id,
            matchLabel: `${fixture.team1} vs ${fixture.team2}`,
            firedAt: new Date().toISOString(),
            coincident: eventKeys.has(`${alert.period}-${alert.min}-${alert.index}`),
            market,
          },
          data,
        ),
      )
    }
    if (firstSnapshot) {
      primed.current.add(fixture.id)
      savePrimed(primed.current, market)
    }
    saveSeen(seen.current, market)
    if (fresh.length) {
      setFeed((prev) => [...fresh.reverse(), ...prev].slice(0, 80))
      void postAlerts(fresh, market)
      if (!firstSnapshot) {
        for (const alert of fresh) {
          if (alert.coincident) continue
          if (!ruleNotifyEnabled(settingsForAlert(alert, settings, byHalf), alert.rule)) continue
          void showAlertNotification(alert)
        }
      }
    }
    if (markSelected) {
      setPayload(data)
      setPayloadError(null)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function poll() {
      const targets: Fixture[] = []
      if (selected) targets.push(selected)
      if (watchLive) {
        for (const f of fixtures) {
          if (f.state === 1 && f.id !== selected?.id) targets.push(f)
          if (targets.length >= 8) break
        }
      }
      if (!targets.length) return
      await Promise.all(
        targets.map(async (fixture) => {
          try {
            const data = await fetchMomentum(fixture.id)
            if (!cancelled) ingest(fixture, data, fixture.id === selected?.id)
          } catch (err) {
            if (!cancelled && fixture.id === selected?.id) {
              setPayload(null)
              setPayloadError(
                err instanceof Error ? err.message : 'Momentum indisponível',
              )
            }
          }
        }),
      )
    }

    void poll()
    const tick = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(tick)
    }
  }, [selectedId, watchLive, fixtures, settings, cornersByHalf])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return fixtures
    return fixtures.filter(
      (f) =>
        f.team1.toLowerCase().includes(q) ||
        f.team2.toLowerCase().includes(q) ||
        f.competition.toLowerCase().includes(q),
    )
  }, [fixtures, query])

  const liveCount = fixtures.filter((f) => f.state === 1).length
  const chart = payload
    ? evaluateAlerts(payload, settings, undefined, byHalf)
    : { points: [], alerts: [] }
  const goals = payload ? extractMarketEvents(payload, chart.points, market) : []
  const clockPoint = chart.points.at(-1)
  const liveHalf = clockPoint
    ? market === 'corners'
      ? cornerHalfOf(clockPoint.min, clockPoint.period)
      : goalHalfOf(clockPoint.min, clockPoint.period)
    : null
  const clockWindows = market === 'corners' ? CORNER_WINDOWS : GOAL_WINDOWS
  const liveWindowLabel = !clockPoint
    ? null
    : liveHalf
      ? `Janela ${clockWindows[liveHalf].shortLabel}`
      : `Fora das janelas ${clockWindows.ht.shortLabel} / ${clockWindows.ft.shortLabel}`

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section className="space-y-3">
        <div className="rounded-2xl border border-line bg-panel p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] uppercase tracking-wider text-emerald-100/45">
              Data (Lisboa)
              <input
                type="date"
                value={date}
                onChange={(e) => onDate(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 text-sm text-emerald-50 outline-none focus:border-lime/50"
              />
            </label>
            <label className="block text-[11px] uppercase tracking-wider text-emerald-100/45">
              Região
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 text-sm text-emerald-50 outline-none focus:border-lime/50"
              >
                <option value="ro">ro (treino)</option>
                <option value="pt">pt</option>
                <option value="uk">uk</option>
                <option value="int">int</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-emerald-100/80">
              <input
                type="checkbox"
                checked={watchLive}
                onChange={(e) => setWatchLive(e.target.checked)}
                className="accent-lime"
              />
              Vigiar jogos ao vivo
            </label>
            <button
              type="button"
              onClick={() => void loadFixtures()}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-emerald-100/70 hover:border-lime/40"
            >
              <RefreshCw size={12} />
              Atualizar
            </button>
          </div>
          <p className="mt-2 text-xs text-emerald-100/45">
            {liveCount} ao vivo · {fixtures.length} jogos
            {pollerLine ? ` · ${pollerLine}` : ''}
          </p>
        </div>

        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute top-2.5 left-3 text-emerald-100/35"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar equipa ou prova"
            className="w-full rounded-xl border border-line bg-panel py-2 pr-3 pl-8 text-sm outline-none focus:border-lime/50"
          />
        </div>

        <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-emerald-100/50">
              A carregar jogos…
            </p>
          ) : error ? (
            <div className="rounded-2xl border border-rose-500/30 bg-rose-950/20 p-4 text-sm text-rose-200">
              <p>{error}</p>
              <p className="mt-2 text-xs text-rose-100/70">
                A API pode estar indisponível. Use Replay com as amostras Celtic
                ou Drava Ptuj.
              </p>
              <p className="mt-2 text-xs text-emerald-100/50">
                Amostras offline: {DEMO_MATCHES.map((d) => d.team1).join(', ')}
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-emerald-100/50">
              Sem jogos para esta data.
            </p>
          ) : (
            filtered.map((fixture) => {
              const phase = matchPhase(fixture)
              const active = fixture.id === selectedId
              return (
                <button
                  key={fixture.id}
                  type="button"
                  onClick={() => setSelectedId(fixture.id)}
                  className={`w-full rounded-2xl border p-3 text-left transition ${
                    active
                      ? 'border-lime/50 bg-lime/5'
                      : 'border-line bg-panel hover:border-lime/25'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-100/45">
                    <span className="truncate">{fixture.competition}</span>
                    <span
                      className={
                        phase === 'live'
                          ? 'font-semibold text-lime'
                          : 'font-mono'
                      }
                    >
                      {phase === 'live' ? (
                        <span className="inline-flex items-center gap-1">
                          <Radio size={11} />
                          {phaseLabel(fixture)}
                        </span>
                      ) : (
                        phaseLabel(fixture)
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-semibold">
                    {fixture.team1}{' '}
                    <span className="font-mono text-emerald-100/70">
                      {scoreLabel(fixture.scoreHome, fixture.scoreAway)}
                    </span>{' '}
                    {fixture.team2}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-emerald-100/40">
                    {formatKickoff(fixture.dateSeconds)} · {fixture.id}
                  </p>
                </button>
              )
            })
          )}
        </div>
      </section>

      <section className="space-y-4">
        <div className="rounded-2xl border border-line bg-panel p-4">
          {selected ? (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs tracking-wider text-lime uppercase">
                    Jogo vigiado
                  </p>
                  <h2 className="text-xl font-semibold">
                    {selected.team1} vs {selected.team2}
                  </h2>
                  <p className="text-sm text-emerald-100/55">
                    {selected.competition} · {phaseLabel(selected)} ·{' '}
                    {scoreLabel(selected.scoreHome, selected.scoreAway)}
                  </p>
                </div>
                <p className="font-mono text-xs text-emerald-100/40">
                  poll {POLL_MS / 1000}s
                  {liveWindowLabel ? ` · ${liveWindowLabel}` : ''}
                </p>
              </div>
              <div className="mt-4">
                {payloadError ? (
                  <p className="rounded-xl border border-rose-500/30 bg-rose-950/20 px-3 py-4 text-sm text-rose-200">
                    {payloadError}
                  </p>
                ) : (
                  <MomentumChart
                    points={chart.points}
                    goals={goals}
                    alerts={chart.alerts}
                  />
                )}
              </div>
              {goals.length > 0 ? (
                <p className="mt-3 text-xs text-emerald-100/50">
                  {copy.toggle} na série:{' '}
                  {goals
                    .map(
                      (g) =>
                        `${g.side === 'home' ? 'C' : 'F'} ${minuteLabel(g.min, g.period)}`,
                    )
                    .join(' · ')}
                </p>
              ) : null}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-emerald-100/50">
              Escolha um jogo para vigiar o momentum.
            </p>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold tracking-wide uppercase">
              Feed de alertas
            </h3>
            <button
              type="button"
              onClick={() => {
                setFeed([])
                saveFeed([], market)
                setHighlightKey(null)
              }}
              className="text-xs text-emerald-100/45 hover:text-emerald-50"
            >
              Limpar
            </button>
          </div>
          {feed.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-sm text-emerald-100/45">
              Ainda sem disparos. Os alertas aparecem quando Spike, Swing ou
              Sustained cruzam os limiares — sempre com o lado do sinal do
              momentum.               Mercado activo: {copy.toggle}
              {` · só nas janelas ${clockWindows.ht.shortLabel} e ${clockWindows.ft.shortLabel} (sem prolongamento).`}
            </p>
          ) : (
            <div className="grid gap-2">
              {feed.map((alert) => {
                const key = feedAlertKey(alert)
                return (
                  <AlertCard
                    key={`${key}-${alert.firedAt}`}
                    alert={alert}
                    market={market}
                    now={now}
                    highlighted={highlightKey === key}
                    onFeedback={(id, vote) =>
                      void postFeedback(id, vote, market, alert.cornerHalf)
                    }
                  />
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
