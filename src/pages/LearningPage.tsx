import { useEffect, useState } from 'react'
import {
  applyLearnProposal,
  fetchLearn,
  isCornersLearn,
  postFeedback,
  recalculateLearn,
  seedLearnDemos,
  type DualMetrics,
  type LearnPayload,
  type RuleMetrics,
} from '../lib/learnApi'
import { pct } from '../lib/format'
import { defaultsFor, marketCopy } from '../lib/market'
import type { AlertSettings, CornerHalf, CornersByHalf } from '../lib/types'
import { CORNER_WINDOWS } from '../lib/windows'

type Props = {
  settings: AlertSettings
  cornersByHalf: CornersByHalf
  onChange: (next: AlertSettings) => void
  onChangeCorners: (next: CornersByHalf) => void
}

export function LearningPage({
  settings,
  cornersByHalf,
  onChange,
  onChangeCorners,
}: Props) {
  const [goalsData, setGoalsData] = useState<LearnPayload | null>(null)
  const [htData, setHtData] = useState<LearnPayload | null>(null)
  const [ftData, setFtData] = useState<LearnPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const market = settings.market
  const copy = marketCopy(market)

  async function reload() {
    setError(null)
    try {
      const payload = await fetchLearn(market)
      if (isCornersLearn(payload)) {
        setHtData(payload.ht)
        setFtData(payload.ft)
        setGoalsData(null)
      } else {
        setGoalsData(payload)
        setHtData(null)
        setFtData(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Servidor indisponível')
    }
  }

  useEffect(() => {
    void reload()
  }, [market])

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operação falhou')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">Aprendizagem · {copy.toggle}</h2>
        <p className="mt-1 max-w-3xl text-sm text-emerald-100/60">
          {market === 'corners'
            ? 'Cantos: HT (35–45, W=5) e FT (85–90, W=3) nunca misturam limiares nem amostras. Fora destas janelas não há aprendizagem. HIT exige alert_min < canto_min no mesmo mercado/janela.'
            : `Dois horizontes por alerta (${copy.noun} do mesmo lado, nunca no minuto do ${copy.noun}): ≤5 min e ≤15 min ou fim da parte/jogo.`}{' '}
          {goalsData?.summary.scoreNote ??
            htData?.summary.scoreNote ??
            'O score de otimização é 0,4×precisão(curto) + 0,6×precisão(longo).'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run('seed', () => seedLearnDemos(market))}
            className="rounded-xl border border-line px-3 py-2 text-sm hover:border-lime/50"
          >
            Importar amostras Celtic/Drava
          </button>
          {market === 'corners' ? (
            <>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('recalc-ht', async () => {
                    await recalculateLearn(market, 'ht')
                  })
                }
                className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch"
              >
                Recalcular HT
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('recalc-ft', async () => {
                    await recalculateLearn(market, 'ft')
                  })
                }
                className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch"
              >
                Recalcular FT
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run('recalc', async () => {
                  await recalculateLearn(market)
                })
              }
              className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch"
            >
              Recalcular
            </button>
          )}
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-xl border border-line px-3 py-2 text-sm"
          >
            Atualizar
          </button>
        </div>
        {busy ? (
          <p className="mt-2 text-xs text-emerald-100/50">A {busy}…</p>
        ) : null}
        {error ? (
          <p className="mt-2 text-sm text-rose-200">{error}</p>
        ) : null}
      </section>

      {market === 'corners' ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <HalfLearn
            half="ht"
            data={htData}
            settings={cornersByHalf.ht}
            error={error}
            busy={Boolean(busy)}
            run={run}
            onApply={(applied) =>
              onChangeCorners({
                ...cornersByHalf,
                ht: {
                  ...cornersByHalf.ht,
                  ...applied,
                  market: 'corners',
                  cornerHalf: 'ht',
                },
              })
            }
          />
          <HalfLearn
            half="ft"
            data={ftData}
            settings={cornersByHalf.ft}
            error={error}
            busy={Boolean(busy)}
            run={run}
            onApply={(applied) =>
              onChangeCorners({
                ...cornersByHalf,
                ft: {
                  ...cornersByHalf.ft,
                  ...applied,
                  market: 'corners',
                  cornerHalf: 'ft',
                },
              })
            }
          />
        </div>
      ) : goalsData ? (
        <LearnBody
          data={goalsData}
          settings={settings}
          run={run}
          onApply={(applied) =>
            onChange({
              ...defaultsFor('goals'),
              ...applied,
              market: 'goals',
              notificationsEnabled: settings.notificationsEnabled,
              notifyPrimary: settings.notifyPrimary,
              notifySecondary: settings.notifySecondary,
              notifyFallback: settings.notifyFallback,
            })
          }
        />
      ) : (
        <p className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-sm text-emerald-100/50">
          {error
            ? 'Arranque o servidor (`npm run dev`) para ver métricas.'
            : 'A carregar métricas…'}
        </p>
      )}
    </div>
  )
}

function HalfLearn({
  half,
  data,
  settings,
  error,
  busy,
  run,
  onApply,
}: {
  half: CornerHalf
  data: LearnPayload | null
  settings: AlertSettings
  error: string | null
  busy: boolean
  run: (label: string, fn: () => Promise<void>) => Promise<void>
  onApply: (settings: AlertSettings) => void
}) {
  const window = CORNER_WINDOWS[half]
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold tracking-wide text-lime uppercase">
        {window.label} · W={window.shortHorizon}
      </p>
      {!data ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-emerald-100/50">
          {error
            ? 'Arranque o servidor (`npm run dev`) para ver métricas.'
            : busy
              ? 'A carregar…'
              : 'A carregar métricas…'}
        </p>
      ) : (
        <LearnBody
          data={data}
          settings={settings}
          run={run}
          half={half}
          onApply={onApply}
        />
      )}
    </div>
  )
}

function LearnBody({
  data,
  settings,
  run,
  onApply,
  half,
}: {
  data: LearnPayload
  settings: AlertSettings
  run: (label: string, fn: () => Promise<void>) => Promise<void>
  onApply: (settings: AlertSettings) => void
  half?: CornerHalf
}) {
  const proposal = data.proposal
  const market = settings.market
  const shortLabel = `≤${data.summary.horizonShort} min`

  return (
    <>
      <div className="grid gap-2 lg:grid-cols-2">
        <HorizonBlock title={shortLabel} dualKey="w5" data={data} />
        <HorizonBlock
          title="≤15 min ou fim da janela/parte"
          dualKey="wLong"
          data={data}
        />
      </div>
      <p className="text-xs text-emerald-100/45">
        {data.summary.matches} jogos no arquivo · {data.summary.unlabeled}{' '}
        alertas por etiquetar · auto após {data.autoAfter} outcomes
      </p>

      {proposal ? (
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-sm font-semibold tracking-wide uppercase">
            Proposta de limiares
          </h3>
          <p className="mt-1 text-sm text-emerald-100/65">{proposal.note}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Diff label="Antes" m={asDual(proposal.before)} s={settings} />
            <Diff label="Depois" m={asDual(proposal.after)} s={proposal.settings} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={proposal.applied}
              onClick={() =>
                void run('apply', async () => {
                  const applied = await applyLearnProposal(proposal.id, market, half)
                  onApply(applied.settings)
                })
              }
              className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch disabled:opacity-40"
            >
              {proposal.applied ? 'Já aplicada' : 'Aplicar proposta'}
            </button>
            <button
              type="button"
              onClick={() =>
                onApply({
                  ...defaultsFor(market, half),
                  notificationsEnabled: settings.notificationsEnabled,
                  notifyPrimary: settings.notifyPrimary,
                  notifySecondary: settings.notifySecondary,
                  notifyFallback: settings.notifyFallback,
                })
              }
              className="rounded-xl border border-line px-3 py-2 text-sm"
            >
              Voltar aos defaults de treino (UI)
            </button>
          </div>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold tracking-wide uppercase">
          Alertas recentes
        </h3>
        {data.recentAlerts.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-emerald-100/45">
            Ainda sem log. Importe as amostras ou deixe o poller correr.
          </p>
        ) : (
          data.recentAlerts.slice(0, 20).map((alert) => (
            <article
              key={alert.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-panel px-3 py-2"
            >
              <div>
                <p className="text-sm font-semibold">
                  {alert.matchLabel} · {alert.minute}' · {alert.ruleId}
                  {alert.cornerHalf ? ` · ${alert.cornerHalf.toUpperCase()}` : ''}
                </p>
                <p className="font-mono text-[11px] text-emerald-100/45">
                  v {alert.features.v} · {shortLabel}{' '}
                  {yn(alert.hit5 ?? alert.hit)}
                  {alert.leadTime5 ? ` (${alert.leadTime5}')` : ''} · longo{' '}
                  {yn(alert.hitLong)}
                  {alert.leadTimeLong ? ` (${alert.leadTimeLong}')` : ''}
                  {alert.longDeadline != null ? ` · prazo ${alert.longDeadline}'` : ''}
                </p>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  className={`rounded-lg px-2 py-1 text-sm ${alert.feedback === 'up' ? 'bg-lime/20 text-lime' : 'border border-line'}`}
                  onClick={() =>
                    void run('fb', () =>
                      postFeedback(
                        alert.id,
                        alert.feedback === 'up' ? null : 'up',
                        market,
                        half ?? alert.cornerHalf,
                      ),
                    )
                  }
                >
                  👍
                </button>
                <button
                  type="button"
                  className={`rounded-lg px-2 py-1 text-sm ${alert.feedback === 'down' ? 'bg-rose-500/20 text-rose-300' : 'border border-line'}`}
                  onClick={() =>
                    void run('fb', () =>
                      postFeedback(
                        alert.id,
                        alert.feedback === 'down' ? null : 'down',
                        market,
                        half ?? alert.cornerHalf,
                      ),
                    )
                  }
                >
                  👎
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      {data.history.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold tracking-wide uppercase">
            Histórico de parâmetros
          </h3>
          <ul className="space-y-2 text-xs text-emerald-100/70">
            {data.history.map((row) => (
              <li key={row.id} className="rounded-xl border border-line bg-panel px-3 py-2">
                {row.ts} · {row.reason} · spike {row.settings.spikeThreshold} · {row.note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

function asDual(m: DualMetrics | RuleMetrics): DualMetrics {
  if (m && typeof m === 'object' && 'w5' in m) return m
  const single = m as RuleMetrics
  return { w5: single, wLong: single }
}

function yn(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v ? 'sim' : 'não'
}

function fmt(n: number | null): string {
  return n === null ? '—' : pct(n)
}

function HorizonBlock({
  title,
  dualKey,
  data,
}: {
  title: string
  dualKey: keyof DualMetrics
  data: LearnPayload
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-line bg-panel/60 p-3">
      <p className="text-xs font-semibold tracking-wider text-lime uppercase">
        {title}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Metric title="Global" m={data.summary.global[dualKey]} />
        <Metric title="Primária" m={data.summary.byRule.primary[dualKey]} />
        <Metric title="Secundária" m={data.summary.byRule.secondary[dualKey]} />
        <Metric title="Reserva" m={data.summary.byRule.fallback[dualKey]} />
      </div>
    </div>
  )
}

function Metric({ title, m }: { title: string; m: RuleMetrics }) {
  return (
    <article className="rounded-2xl border border-line bg-panel p-3">
      <p className="text-xs tracking-wider text-emerald-100/40 uppercase">
        {title}
      </p>
      <p className="mt-1 font-mono text-lg">
        {fmt(m.precision)} / {fmt(m.recall)}
      </p>
      <p className="text-[11px] text-emerald-100/50">
        {m.alerts} alt · {m.alertsPerMatch.toFixed(1)} /jogo · lead{' '}
        {m.medianLead ?? '—'}
      </p>
    </article>
  )
}

function Diff({
  label,
  m,
  s,
}: {
  label: string
  m: DualMetrics
  s: AlertSettings
}) {
  return (
    <div className="rounded-xl border border-line bg-pitch px-3 py-2 text-xs">
      <p className="font-semibold">{label}</p>
      <p className="mt-1 font-mono text-emerald-100/70">
        spike {s.spikeThreshold} · swing {s.swingComboThreshold}
        {s.market === 'corners'
          ? ` · fb ${s.fallbackSpikeThreshold} · sust ${s.sustainedThreshold}×${s.sustainedComboMinutes}/${s.sustainedSecondaryMinutes}`
          : `/${s.swingSecondaryThreshold} · sust ${s.sustainedThreshold}×${s.sustainedComboMinutes}/${s.sustainedFallbackMinutes}`}
      </p>
      <p className="mt-1">
        Curto P {fmt(m.w5.precision)} · R {fmt(m.w5.recall)}
      </p>
      <p>
        Longo P {fmt(m.wLong.precision)} · R {fmt(m.wLong.recall)} ·{' '}
        {m.wLong.alertsPerMatch.toFixed(1)} alt/jogo
      </p>
    </div>
  )
}
