import { NotificationBar } from '../components/NotificationBar'
import { TRAINING, TRAINING_CORNERS } from '../lib/demos'
import { pct } from '../lib/format'
import { defaultsFor, marketCopy, ruleDetails } from '../lib/market'
import type { AlertSettings } from '../lib/types'

type Props = {
  settings: AlertSettings
  onChange: (next: AlertSettings) => void
}

export function SettingsPage({ settings, onChange }: Props) {
  const set = <K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) =>
    onChange({ ...settings, [key]: value })
  const copy = marketCopy(settings.market)
  const details = ruleDetails(settings)
  const training = settings.market === 'corners' ? TRAINING_CORNERS : TRAINING
  const nEvents =
    settings.market === 'corners'
      ? TRAINING_CORNERS.nEvents
      : TRAINING.nGoals
  const coincidence =
    settings.market === 'corners'
      ? TRAINING_CORNERS.coincidence.spike70OnlyAtEvent
      : TRAINING.coincidence.spike70OnlyAtGoal

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
      <NotificationBar settings={settings} onChange={onChange} />
      <section className="space-y-4 rounded-2xl border border-line bg-panel p-4">
        <div>
          <h2 className="text-lg font-semibold">Definições das regras</h2>
          <p className="mt-1 text-sm text-emerald-100/60">
            Defaults treinados para {copy.nounPlural}. Gravados neste browser
            (`localStorage`), separados de {settings.market === 'corners' ? 'golos' : 'cantos'}.
            Um pico no minuto do {copy.noun} nunca conta como pré-alerta.
          </p>
        </div>

        <div className="space-y-3">
          <Toggle
            checked={settings.enablePrimary}
            onChange={(v) => set('enablePrimary', v)}
            title="Primária (recomendada)"
            detail={details.primary}
          />
          <Toggle
            checked={settings.enableSecondary}
            onChange={(v) => set('enableSecondary', v)}
            title="Secundária"
            detail={details.secondary}
          />
          <Toggle
            checked={settings.enableFallback}
            onChange={(v) => set('enableFallback', v)}
            title="Reserva"
            detail={details.fallback}
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
          {settings.market === 'corners' ? (
            <NumberField
              label="Spike reserva |v|"
              value={settings.fallbackSpikeThreshold}
              min={50}
              max={90}
              onChange={(v) => set('fallbackSpikeThreshold', v)}
            />
          ) : (
            <NumberField
              label="Swing secundário |Δ1|"
              value={settings.swingSecondaryThreshold}
              min={30}
              max={100}
              onChange={(v) => set('swingSecondaryThreshold', v)}
            />
          )}
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
          {settings.market === 'corners' ? (
            <>
              <NumberField
                label="Sustained secundário |v|"
                value={settings.sustainedSecondaryThreshold}
                min={10}
                max={40}
                onChange={(v) => set('sustainedSecondaryThreshold', v)}
              />
              <NumberField
                label="Sustained secundário (min)"
                value={settings.sustainedSecondaryMinutes}
                min={3}
                max={8}
                onChange={(v) => set('sustainedSecondaryMinutes', v)}
              />
            </>
          ) : (
            <NumberField
              label="Sustained reserva (min)"
              value={settings.sustainedFallbackMinutes}
              min={3}
              max={10}
              onChange={(v) => set('sustainedFallbackMinutes', v)}
            />
          )}
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
          onClick={() =>
            onChange({
              ...defaultsFor(settings.market),
              notificationsEnabled: settings.notificationsEnabled,
              notifyPrimary: settings.notifyPrimary,
              notifySecondary: settings.notifySecondary,
              notifyFallback: settings.notifyFallback,
            })
          }
          className="rounded-xl border border-line px-4 py-2 text-sm hover:border-lime/50"
        >
          Repor defaults do treino
        </button>
      </section>
      </div>

      <aside className="space-y-3">
        <article className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-xs tracking-wider text-lime uppercase">
            Treino · {copy.toggle}
          </p>
          <p className="mt-1 text-sm text-emerald-100/70">
            {training.nMatches} jogos · {nEvents} {copy.nounPlural} · {training.dates}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-rose-200/90">
            {coincidence.toString().replace('.', ',')}% dos {copy.nounPlural} têm
            Spike70 só no minuto do {copy.noun} (sem pré-5). Não use Spike70
            sozinho.
          </p>
        </article>
        <MetricCard
          title="Primária"
          nounPlural={copy.nounPlural}
          precision={training.primary.precision}
          recall={training.primary.recall}
          alerts={training.primary.alertsPerMatch}
          fp={training.primary.fpPerMatch}
          lead={training.primary.medianLead}
          hit={training.primary.pct1to5}
        />
        <MetricCard
          title="Secundária"
          nounPlural={copy.nounPlural}
          precision={training.secondary.precision}
          recall={training.secondary.recall}
          alerts={training.secondary.alertsPerMatch}
          fp={training.secondary.fpPerMatch}
          lead={training.secondary.medianLead}
          hit={training.secondary.pct1to5}
        />
        <MetricCard
          title="Reserva"
          nounPlural={copy.nounPlural}
          precision={training.fallback.precision}
          recall={training.fallback.recall}
          alerts={training.fallback.alertsPerMatch}
          fp={training.fallback.fpPerMatch}
          lead={training.fallback.medianLead}
          hit={training.fallback.pct1to5}
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
  nounPlural,
  precision,
  recall,
  alerts,
  fp,
  lead,
  hit,
}: {
  title: string
  nounPlural: string
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
        <div>
          {String(hit).replace('.', ',')}% {nounPlural} 1–5
        </div>
      </dl>
    </article>
  )
}
