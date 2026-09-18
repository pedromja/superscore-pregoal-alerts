import { Pause, Play, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AlertMetrics } from '../components/AlertCard'
import { MomentumChart } from '../components/MomentumChart'
import { fetchDemoMomentum, fetchFixtures, fetchMomentum } from '../lib/api'
import { DEMO_MATCHES } from '../lib/demos'
import {
  formatSigned,
  minuteLabel,
  scoreLabel,
  sideLabel,
} from '../lib/format'
import { marketCopy, parseMarket } from '../lib/market'
import { evaluateAlerts, evaluateReplay, RULE_SHORT } from '../lib/rules'
import type {
  AlertSettings,
  CornersByHalf,
  DemoMatch,
  Fixture,
  MomentumPayload,
} from '../lib/types'
import { CORNER_WINDOWS, GOAL_WINDOWS } from '../lib/windows'

type Props = {
  settings: AlertSettings
  cornersByHalf: CornersByHalf
  date: string
  onDate: (value: string) => void
}

export function ReplayPage({ settings, cornersByHalf, date, onDate }: Props) {
  const market = parseMarket(settings.market)
  const copy = marketCopy(market)
  const byHalf = market === 'corners' ? cornersByHalf : undefined
  const [fixtureId, setFixtureId] = useState('')
  const [fixtures, setFixtures] = useState<Fixture[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [payload, setPayload] = useState<MomentumPayload | null>(null)
  const [label, setLabel] = useState('Celtic vs Ferencváros')
  const [note, setNote] = useState(DEMO_MATCHES[0].note)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)

  async function loadDemo(demo: DemoMatch) {
    setLoading(true)
    setError(null)
    setPlaying(false)
    try {
      const data = await fetchDemoMomentum(demo.file)
      setPayload(data)
      setLabel(`${demo.team1} vs ${demo.team2} · ${demo.scoreHome}–${demo.scoreAway}`)
      setNote(demo.note)
      setFixtureId(demo.fixtureId ?? demo.id)
      setCursor(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha a carregar amostra')
    } finally {
      setLoading(false)
    }
  }

  async function loadRemote(id: string, matchLabel?: string) {
    setLoading(true)
    setError(null)
    setPlaying(false)
    try {
      const data = await fetchMomentum(id)
      if (!data.timeline?.length) throw new Error('Série de momentum vazia')
      setPayload(data)
      setLabel(matchLabel ?? `Jogo ${id}`)
      setNote('Carregado da API SuperScore. Pré-alerta exige minuto estritamente anterior ao evento.')
      setCursor(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha a obter momentum')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDemo(DEMO_MATCHES[0])
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoadingList(true)
    setListError(null)
    fetchFixtures(date, 'ro')
      .then((list) => {
        if (!cancelled) setFixtures(list.filter((f) => f.state === 2 || f.status >= 100))
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFixtures([])
          setListError(err instanceof Error ? err.message : 'Lista indisponível')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false)
      })
    return () => {
      cancelled = true
    }
  }, [date])

  const full = useMemo(
    () => (payload ? evaluateReplay(payload, settings, byHalf) : null),
    [payload, settings, byHalf],
  )

  const liveSlice = useMemo(() => {
    if (!payload || cursor === null) return full
    const { points, alerts } = evaluateAlerts(payload, settings, cursor, byHalf)
    return { ...full!, points, alerts }
  }, [payload, settings, cursor, full, byHalf])

  useEffect(() => {
    if (!playing || !full) return
    const max = full.points.length - 1
    const tick = window.setInterval(() => {
      setCursor((prev) => {
        const next = (prev ?? -1) + 1
        if (next >= max) {
          setPlaying(false)
          return max
        }
        return next
      })
    }, 220)
    return () => window.clearInterval(tick)
  }, [playing, full])

  const result = liveSlice

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">Replay / treino</h2>
        <p className="mt-1 max-w-3xl text-sm text-emerald-100/60">
          Corre as regras no timeline completo. Um disparo no mesmo minuto do{' '}
          {copy.noun} é coincidente — não entra como sucesso. Só conta{' '}
          <span className="text-emerald-50">
            alert_minute &lt; {copy.noun}_minute
          </span>
          {market === 'corners'
            ? ` nas janelas ${CORNER_WINDOWS.ht.shortLabel} (W=${CORNER_WINDOWS.ht.shortHorizon}) e ${CORNER_WINDOWS.ft.shortLabel} (W=${CORNER_WINDOWS.ft.shortHorizon}).`
            : ` nas janelas ${GOAL_WINDOWS.ht.shortLabel} / ${GOAL_WINDOWS.ft.shortLabel} (sem prolongamento), horizonte de ${settings.evaluationWindow} min.`}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {DEMO_MATCHES.map((demo) => (
            <button
              key={demo.id}
              type="button"
              onClick={() => void loadDemo(demo)}
              className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-lime/50 hover:text-lime"
            >
              {demo.team1} vs {demo.team2}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
          <label className="block text-[11px] uppercase tracking-wider text-emerald-100/45">
            ID do jogo SuperScore
            <input
              value={fixtureId}
              onChange={(e) => setFixtureId(e.target.value)}
              placeholder="ex. 34OXUvbRzi05vbQ8FOZsz"
              className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 font-mono text-sm outline-none focus:border-lime/50"
            />
          </label>
          <button
            type="button"
            onClick={() => fixtureId && void loadRemote(fixtureId)}
            className="rounded-xl bg-lime px-4 py-2 text-sm font-semibold text-pitch"
          >
            Carregar da API
          </button>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-[160px_minmax(0,1fr)]">
          <label className="block text-[11px] uppercase tracking-wider text-emerald-100/45">
            Data (lista)
            <input
              type="date"
              value={date}
              onChange={(e) => onDate(e.target.value)}
              className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 text-sm outline-none focus:border-lime/50"
            />
          </label>
          <label className="block text-[11px] uppercase tracking-wider text-emerald-100/45">
            Jogos terminados
            <select
              defaultValue=""
              onChange={(e) => {
                const id = e.target.value
                const f = fixtures.find((x) => x.id === id)
                if (f) {
                  setFixtureId(f.id)
                  void loadRemote(f.id, `${f.team1} vs ${f.team2}`)
                }
              }}
              className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 text-sm outline-none focus:border-lime/50"
            >
              <option value="" disabled>
                {loadingList
                  ? 'A carregar lista…'
                  : listError
                    ? listError
                    : fixtures.length
                      ? 'Escolher jogo terminado'
                      : 'Sem jogos terminados'}
              </option>
              {fixtures.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.team1} {scoreLabel(f.scoreHome, f.scoreAway)} {f.team2} ·{' '}
                  {f.competition}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {error ? (
        <p className="rounded-2xl border border-rose-500/30 bg-rose-950/20 p-4 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      {loading || !result ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-12 text-center text-sm text-emerald-100/50">
          A preparar replay…
        </p>
      ) : (
        <>
          <section className="rounded-2xl border border-line bg-panel p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs tracking-wider text-lime uppercase">
                  Série
                </p>
                <h3 className="text-xl font-semibold">{label}</h3>
                <p className="max-w-2xl text-sm text-emerald-100/55">{note}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCursor(0)
                    setPlaying(true)
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-lime px-3 py-1.5 text-sm font-semibold text-pitch"
                >
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                  {playing ? 'A reproduzir' : 'Reproduzir'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false)
                    setCursor(null)
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  <RotateCcw size={14} />
                  Completo
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat
                label={copy.toggle}
                value={`${result.goals.length}`}
              />
              <Stat
                label="Pré-alerta (W)"
                value={`${full?.goalsHit ?? 0}/${result.goals.length}`}
              />
              <Stat
                label="Lead mediana"
                value={full?.medianLead != null ? `${full.medianLead} min` : '—'}
              />
              <Stat
                label="Coincidentes"
                value={`${full?.coincidentAlerts.length ?? 0}`}
              />
            </div>

            <div className="mt-4">
              <MomentumChart
                points={result.points}
                goals={result.goals}
                alerts={result.alerts}
                cursorIndex={cursor ?? undefined}
              />
            </div>
            {cursor !== null && result.points[cursor] ? (
              <p className="mt-2 font-mono text-xs text-emerald-100/50">
                Cursor {result.points[cursor].min}' · v{' '}
                {formatSigned(result.points[cursor].value)} · Δ1{' '}
                {result.points[cursor].delta1 === null
                  ? '—'
                  : formatSigned(result.points[cursor].delta1)}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-emerald-100/40">
              Verde = alerta · Rosa = mesmo minuto de um {copy.noun} · Traço ciano/âmbar
              = {copy.noun} casa/fora.
            </p>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold tracking-wide uppercase">
                {copy.toggle} e antecedência
              </h3>
              {full?.perGoal.map((row) => (
                <article
                  key={`${row.goal.period}-${row.goal.min}-${row.goalNumber}`}
                  className="rounded-2xl border border-line bg-panel p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">
                        {copy.nounCap} {row.goalNumber} · {sideLabel(row.goal.side)} ·{' '}
                        {minuteLabel(row.goal.min, row.goal.period)}
                      </p>
                      <p className="font-mono text-xs text-emerald-100/45">
                        {copy.toggle} {row.scoreAfter.home}–{row.scoreAfter.away}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        row.hit
                          ? 'bg-lime/15 text-lime'
                          : 'bg-emerald-900/80 text-emerald-100/60'
                      }`}
                    >
                      {row.hit
                        ? `Pré-alerta ${row.bestLead} min`
                        : 'Sem pré-alerta'}
                    </span>
                  </div>
                  {row.preAlerts.length ? (
                    <ul className="mt-2 space-y-1 text-xs text-emerald-100/75">
                      {row.preAlerts.map((a) => (
                        <li key={`${row.goalNumber}-${a.id}`}>
                          {RULE_SHORT[a.rule]} aos {a.min}' (lead {a.leadMin}{' '}
                          min) · v {formatSigned(a.momentum)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-emerald-100/45">
                      Nenhum disparo do mesmo lado nos {settings.evaluationWindow}{' '}
                      minutos anteriores.
                    </p>
                  )}
                  {row.coincidentAlerts.length ? (
                    <p className="mt-2 text-xs text-rose-300">
                      Coincidente no minuto do {copy.noun}:{' '}
                      {row.coincidentAlerts
                        .map((a) => RULE_SHORT[a.rule])
                        .join(', ')}{' '}
                      · v {formatSigned(row.goal ? row.coincidentAlerts[0].momentum : 0)}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold tracking-wide uppercase">
                Todos os disparos
              </h3>
              {result.alerts.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-emerald-100/45">
                  Nenhuma regra disparou nesta série com os limiares atuais.
                </p>
              ) : (
                result.alerts
                  .slice()
                  .reverse()
                  .map((alert) => {
                    const coincident = (full?.coincidentAlerts ?? []).some(
                      (c) => c.id === alert.id,
                    )
                    return (
                      <article
                        key={alert.id}
                        className="rounded-2xl border border-line bg-panel p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold">
                            {RULE_SHORT[alert.rule]} · {minuteLabel(alert.min, alert.period)} ·{' '}
                            {sideLabel(alert.side)}
                          </p>
                          {coincident ? (
                            <span className="text-[11px] font-semibold text-rose-300">
                              Coincidente
                            </span>
                          ) : null}
                        </div>
                        <AlertMetrics alert={alert} />
                      </article>
                    )
                  })
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-pitch px-3 py-2">
      <p className="text-[10px] tracking-wider text-emerald-100/40 uppercase">
        {label}
      </p>
      <p className="font-mono text-lg text-emerald-50">{value}</p>
    </div>
  )
}
