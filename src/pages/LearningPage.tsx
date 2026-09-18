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
import {
  DEFINITIONS_LOCKED,
  LOCK_SESSION_NOTE_PT,
  LOCK_UNLOCK_LABEL_PT,
  LOCK_WARNING_PT,
} from '../lib/lock'
import { defaultsFor, marketCopy } from '../lib/market'
import type { AlertSettings, CornerHalf, CornersByHalf } from '../lib/types'
import { CORNER_WINDOWS, GOAL_WINDOWS } from '../lib/windows'

type Props = {
  settings: AlertSettings
  cornersByHalf: CornersByHalf
  onChange: (next: AlertSettings) => void
  onChangeCorners: (next: CornersByHalf) => void
}

export function LearningPage({
  settings,
  cornersByHalf,
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
            ? `Cantos: HT (${CORNER_WINDOWS.ht.from}–${CORNER_WINDOWS.ht.to}, W=${CORNER_WINDOWS.ht.shortHorizon}) e FT (${CORNER_WINDOWS.ft.from}–${CORNER_WINDOWS.ft.to}, W=${CORNER_WINDOWS.ft.shortHorizon}) nunca misturam limiares nem amostras. Prolongamento (P1>45 / P2>90) está banido. HIT exige lead ≥1 min no mesmo mercado/janela.`
            : `Golos: ${GOAL_WINDOWS.ht.shortLabel} e ${GOAL_WINDOWS.ft.shortLabel} no relógio absoluto; prolongamento (P1>45 / P2>90) está banido. HIT exige lead ≥1 min (ideal 1–2). HT e FT não misturam amostras.`}{' '}
          {goalsData?.summary.scoreNote ??
            htData?.summary.scoreNote ??
            'O score de otimização é 0,4×precisão(curto) + 0,6×precisão(longo). Definições locked: aplicar exige desbloquear + confirmar.'}
        </p>
        {DEFINITIONS_LOCKED ? (
          <p className="mt-3 rounded-xl border border-amber-400/40 bg-amber-950/20 px-3 py-2 text-sm text-amber-100/85">
            {LOCK_WARNING_PT}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run('seed', () => seedLearnDemos(market))}
            className="rounded-xl border border-line px-3 py-2 text-sm hover:border-lime/50"
          >
            Importar amostras Celtic/Drava
          </button>
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
                  market,
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
                  market,
                  cornerHalf: 'ft',
                },
              })
            }
          />
        </div>
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
  const window =
    settings.market === 'corners' ? CORNER_WINDOWS[half] : GOAL_WINDOWS[half]
  const horizon =
    settings.market === 'corners'
      ? CORNER_WINDOWS[half].shortHorizon
      : settings.evaluationWindow
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold tracking-wide text-lime uppercase">
        {window.label} · W={horizon}
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
  const [confirmApply, setConfirmApply] = useState(false)
  const [unlockApply, setUnlockApply] = useState(false)

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
        alertas por etiquetar · auto-aplicar desligado
        {data.autoAfter ? ` (guarda ≥${data.autoAfter} outcomes só marca elegibilidade)` : ''}
        . As regras base não mudam sem confirmação.
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-emerald-100/80">
              <input
                type="checkbox"
                checked={confirmApply}
                disabled={proposal.applied}
                onChange={(e) => setConfirmApply(e.target.checked)}
                className="accent-lime"
              />
              Confirmo aplicar às regras activas (não é automático)
            </label>
            {DEFINITIONS_LOCKED ? (
              <label className="flex items-start gap-2 text-sm text-amber-100/90">
                <input
                  type="checkbox"
                  checked={unlockApply}
                  disabled={proposal.applied}
                  onChange={(e) => setUnlockApply(e.target.checked)}
                  className="mt-0.5 accent-lime"
                />
                <span>
                  {LOCK_UNLOCK_LABEL_PT}
                  <span className="mt-1 block text-xs text-amber-100/70">
                    {LOCK_SESSION_NOTE_PT}
                  </span>
                </span>
              </label>
            ) : null}
            <button
              type="button"
              disabled={
                proposal.applied ||
                !confirmApply ||
                (DEFINITIONS_LOCKED && !unlockApply)
              }
              onClick={() =>
                void run('apply', async () => {
                  const applied = await applyLearnProposal(
                    proposal.id,
                    market,
                    half,
                    DEFINITIONS_LOCKED ? unlockApply : false,
                  )
                  setConfirmApply(false)
                  setUnlockApply(false)
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
