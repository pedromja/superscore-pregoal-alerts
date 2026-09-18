import { useEffect, useState } from 'react'
import {
  applyLearnProposal,
  fetchLearn,
  postFeedback,
  recalculateLearn,
  seedLearnDemos,
  type LearnPayload,
  type RuleMetrics,
} from '../lib/learnApi'
import { pct } from '../lib/format'
import { DEFAULT_SETTINGS } from '../lib/rules'
import type { AlertSettings } from '../lib/types'

type Props = {
  settings: AlertSettings
  onChange: (next: AlertSettings) => void
}

export function LearningPage({ settings, onChange }: Props) {
  const [data, setData] = useState<LearnPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function reload() {
    setError(null)
    try {
      setData(await fetchLearn())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Servidor indisponível')
    }
  }

  useEffect(() => {
    void reload()
  }, [])

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

  const proposal = data?.proposal

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">Aprendizagem</h2>
        <p className="mt-1 max-w-3xl text-sm text-emerald-100/60">
          O servidor etiqueta cada alerta: acerto se um golo do mesmo lado
          ocorrer nos {data?.summary.window ?? 5} minutos seguintes (não no
          minuto do golo). O recálculo procura limiares em torno dos defaults
          do treino e só aplica sozinho se a precisão subir ≥1pp sem o recall
          cair mais de 3pp.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run('seed', () => seedLearnDemos())}
            className="rounded-xl border border-line px-3 py-2 text-sm hover:border-lime/50"
          >
            Importar amostras Celtic/Drava
          </button>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run('recalc', async () => { await recalculateLearn() })}
            className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch"
          >
            Recalcular
          </button>
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

      {!data ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-sm text-emerald-100/50">
          {error
            ? 'Arranque o servidor (`npm run dev`) para ver métricas.'
            : 'A carregar métricas…'}
        </p>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-4">
            <Metric title="Global" m={data.summary.global} />
            <Metric title="Primária" m={data.summary.byRule.primary} />
            <Metric title="Secundária" m={data.summary.byRule.secondary} />
            <Metric title="Reserva" m={data.summary.byRule.fallback} />
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
                <Diff
                  label="Antes"
                  m={proposal.before}
                  s={settings}
                />
                <Diff
                  label="Depois"
                  m={proposal.after}
                  s={proposal.settings}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={proposal.applied}
                  onClick={() =>
                    void run('apply', async () => {
                      const applied = await applyLearnProposal(proposal.id)
                      onChange({
                        ...settings,
                        ...applied.settings,
                        notificationsEnabled: settings.notificationsEnabled,
                        notifyPrimary: settings.notifyPrimary,
                        notifySecondary: settings.notifySecondary,
                        notifyFallback: settings.notifyFallback,
                      })
                    })
                  }
                  className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch disabled:opacity-40"
                >
                  {proposal.applied ? 'Já aplicada' : 'Aplicar proposta'}
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ ...settings, ...DEFAULT_SETTINGS })}
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
                    </p>
                    <p className="font-mono text-[11px] text-emerald-100/45">
                      v {alert.features.v} · hit{' '}
                      {alert.hit === null ? '—' : alert.hit ? 'sim' : 'não'}
                      {alert.leadMin ? ` · lead ${alert.leadMin}` : ''}
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
                    {row.ts} · {row.reason} · spike {row.settings.spikeThreshold} ·{' '}
                    {row.note}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}

function fmt(n: number | null): string {
  return n === null ? '—' : pct(n)
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
  m: RuleMetrics
  s: AlertSettings
}) {
  return (
    <div className="rounded-xl border border-line bg-pitch px-3 py-2 text-xs">
      <p className="font-semibold">{label}</p>
      <p className="mt-1 font-mono text-emerald-100/70">
        spike {s.spikeThreshold} · swing {s.swingComboThreshold}/{s.swingSecondaryThreshold} ·
        sust {s.sustainedThreshold}×{s.sustainedComboMinutes}/{s.sustainedFallbackMinutes}
      </p>
      <p className="mt-1">
        P {fmt(m.precision)} · R {fmt(m.recall)} · {m.alertsPerMatch.toFixed(1)} alt/jogo
      </p>
    </div>
  )
}
