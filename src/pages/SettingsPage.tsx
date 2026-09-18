import { TRAINING } from '../lib/demos'
import { pct } from '../lib/format'
import { DEFAULT_SETTINGS } from '../lib/rules'
import type { AlertSettings } from '../lib/types'

type Props = {
  settings: AlertSettings
  onChange: (next: AlertSettings) => void
}

export function SettingsPage({ settings, onChange }: Props) {
  const set = <K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) =>
    onChange({ ...settings, [key]: value })

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="space-y-4 rounded-2xl border border-line bg-panel p-4">
        <div>
          <h2 className="text-lg font-semibold">Definições das regras</h2>
          <p className="mt-1 text-sm text-emerald-100/60">
            Defaults treinados em 100 jogos / 737 golos. Gravados neste
            browser (`localStorage`). Um pico no minuto do golo nunca conta
            como pré-alerta.
          </p>
        </div>

        <div className="space-y-3">
          <Toggle
            checked={settings.enablePrimary}
            onChange={(v) => set('enablePrimary', v)}
            title="Primária (recomendada)"
            detail="Spike80 AND (Swing50 OR Sustained3)"
          />
          <Toggle
            checked={settings.enableSecondary}
            onChange={(v) => set('enableSecondary', v)}
            title="Secundária"
            detail="Swing |Δ1| ≥ limiar secundário — antecipação mais pura"
          />
          <Toggle
            checked={settings.enableFallback}
            onChange={(v) => set('enableFallback', v)}
            title="Reserva"
            detail="Pressão sustentada no mesmo lado durante N minutos"
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <NumberField
            label="Spike |v|"
            value={settings.spikeThreshold}
            min={40}
            max={100}
            onChange={(v) => set('spikeThreshold', v)}
          />
          <NumberField
            label="Swing combo |Δ1|"
            value={settings.swingComboThreshold}
            min={20}
            max={90}
            onChange={(v) => set('swingComboThreshold', v)}
          />
          <NumberField
            label="Swing secundário |Δ1|"
            value={settings.swingSecondaryThreshold}
            min={30}
            max={100}
            onChange={(v) => set('swingSecondaryThreshold', v)}
          />
          <NumberField
            label="Sustained |v|"
            value={settings.sustainedThreshold}
            min={10}
            max={80}
            onChange={(v) => set('sustainedThreshold', v)}
          />
          <NumberField
            label="Sustained combo (min)"
            value={settings.sustainedComboMinutes}
            min={2}
            max={8}
            onChange={(v) => set('sustainedComboMinutes', v)}
          />
          <NumberField
            label="Sustained reserva (min)"
            value={settings.sustainedFallbackMinutes}
            min={3}
            max={10}
            onChange={(v) => set('sustainedFallbackMinutes', v)}
          />
          <NumberField
            label="Janela de avaliação W"
            value={settings.evaluationWindow}
            min={3}
            max={10}
            onChange={(v) => set('evaluationWindow', v)}
          />
        </div>

        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_SETTINGS })}
          className="rounded-xl border border-line px-4 py-2 text-sm hover:border-lime/50"
        >
          Repor defaults do treino
        </button>
      </section>

      <aside className="space-y-3">
        <article className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-xs tracking-wider text-lime uppercase">
            Treino
          </p>
          <p className="mt-1 text-sm text-emerald-100/70">
            {TRAINING.nMatches} jogos · {TRAINING.nGoals} golos · {TRAINING.dates}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-rose-200/90">
            {TRAINING.coincidence.spike70OnlyAtGoal.toString().replace('.', ',')}%
            dos golos têm Spike70 só no minuto do golo (sem pré-5). Não use
            Spike70 sozinho.
          </p>
        </article>
        <MetricCard
          title="Primária"
          precision={TRAINING.primary.precision}
          recall={TRAINING.primary.recall}
          alerts={TRAINING.primary.alertsPerMatch}
          fp={TRAINING.primary.fpPerMatch}
          lead={TRAINING.primary.medianLead}
          hit={TRAINING.primary.pct1to5}
        />
        <MetricCard
          title="Secundária"
          precision={TRAINING.secondary.precision}
          recall={TRAINING.secondary.recall}
          alerts={TRAINING.secondary.alertsPerMatch}
          fp={TRAINING.secondary.fpPerMatch}
          lead={TRAINING.secondary.medianLead}
          hit={TRAINING.secondary.pct1to5}
        />
        <MetricCard
          title="Reserva"
          precision={TRAINING.fallback.precision}
          recall={TRAINING.fallback.recall}
          alerts={TRAINING.fallback.alertsPerMatch}
          fp={TRAINING.fallback.fpPerMatch}
          lead={TRAINING.fallback.medianLead}
          hit={TRAINING.fallback.pct1to5}
        />
      </aside>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  detail: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-pitch px-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-lime"
      />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-emerald-100/55">{detail}</span>
      </span>
    </label>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block rounded-xl border border-line bg-pitch px-3 py-3">
      <span className="flex items-center justify-between text-xs text-emerald-100/55">
        {label}
        <span className="font-mono text-emerald-50">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-lime"
      />
    </label>
  )
}

function MetricCard({
  title,
  precision,
  recall,
  alerts,
  fp,
  lead,
  hit,
}: {
  title: string
  precision: number
  recall: number
  alerts: number
  fp: number
  lead: number
  hit: number
}) {
  return (
    <article className="rounded-2xl border border-line bg-panel p-4">
      <p className="text-sm font-semibold">{title}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs text-emerald-100/70">
        <div>Precisão {pct(precision)}</div>
        <div>Recall {pct(recall)}</div>
        <div>{alerts} alt/jogo</div>
        <div>{fp} FP/jogo</div>
        <div>Lead {lead} min</div>
        <div>{String(hit).replace('.', ',')}% golos 1–5</div>
      </dl>
    </article>
  )
}
