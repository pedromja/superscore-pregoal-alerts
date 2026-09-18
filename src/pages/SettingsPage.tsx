import { NotificationBar } from '../components/NotificationBar'
import {
  TRAINING,
  TRAINING_CORNERS_FT,
  TRAINING_CORNERS_HT,
} from '../lib/demos'
import { pct } from '../lib/format'
import {
  DEFINITIONS_LOCKED,
  LOCK_SESSION_NOTE_PT,
  LOCK_UNLOCK_LABEL_PT,
  LOCK_WARNING_PT,
} from '../lib/lock'
import { defaultsFor, marketCopy, ruleDetails, syncNotifyFlags } from '../lib/market'
import { useState } from 'react'
import type { AlertSettings, CornerHalf, CornersByHalf, RuleKind } from '../lib/types'
import { CORNER_WINDOWS, GOAL_WINDOWS } from '../lib/windows'

type Props = {
  settings: AlertSettings
  cornersByHalf: CornersByHalf
  onChange: (next: AlertSettings) => void
  onChangeCorners: (next: CornersByHalf) => void
}

export function SettingsPage({
  settings,
  cornersByHalf,
  onChange,
  onChangeCorners,
}: Props) {
  const copy = marketCopy(settings.market)
  const [unlocked, setUnlocked] = useState(false)
  const locked = DEFINITIONS_LOCKED && !unlocked
  const windows = settings.market === 'corners' ? CORNER_WINDOWS : GOAL_WINDOWS

  return (
    <div className="space-y-4">
      <NotificationBar settings={settings} onChange={onChange} />
      {DEFINITIONS_LOCKED ? (
        <section className="rounded-2xl border border-amber-400/40 bg-amber-950/20 p-4">
          <h2 className="text-lg font-semibold text-amber-100">Definições bloqueadas</h2>
          <p className="mt-1 text-sm text-amber-100/80">{LOCK_WARNING_PT}</p>
          <label className="mt-3 flex items-start gap-2 text-sm text-amber-50">
            <input
              type="checkbox"
              checked={unlocked}
              onChange={(e) => setUnlocked(e.target.checked)}
              className="mt-0.5 accent-lime"
            />
            <span>{LOCK_UNLOCK_LABEL_PT}</span>
          </label>
          {unlocked ? (
            <p className="mt-2 text-xs text-amber-100/70">{LOCK_SESSION_NOTE_PT}</p>
          ) : null}
        </section>
      ) : null}
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">
          Definições das regras · {copy.toggle}
        </h2>
        <p className="mt-1 text-sm text-emerald-100/60">
          HT e FT têm limiares separados. Relógio absoluto:{' '}
          <strong>
            {windows.ht.from}–{windows.ht.to}
          </strong>{' '}
          (1.ª parte) ou{' '}
          <strong>
            {windows.ft.from}–{windows.ft.to}
          </strong>{' '}
          (2.ª parte). Prolongamento (P1&gt;45 / P2&gt;90) está banido. Lead útil
          ≥ 1 min (ideal 1–2). Fora destas janelas não há avaliação, push nem
          amostras de aprendizagem.
        </p>
      </section>
      <div className={`grid gap-4 xl:grid-cols-2 ${locked ? 'pointer-events-none opacity-60' : ''}`}>
        <HalfEditor
          half="ht"
          settings={cornersByHalf.ht}
          locked={locked}
          onChange={(next) =>
            onChangeCorners({
              ...cornersByHalf,
              ht: syncNotifyFlags(settings, {
                ...next,
                market: settings.market,
                cornerHalf: 'ht',
              }),
            })
          }
        />
        <HalfEditor
          half="ft"
          settings={cornersByHalf.ft}
          locked={locked}
          onChange={(next) =>
            onChangeCorners({
              ...cornersByHalf,
              ft: syncNotifyFlags(settings, {
                ...next,
                market: settings.market,
                cornerHalf: 'ft',
              }),
            })
          }
        />
      </div>
    </div>
  )
}

function HalfEditor({
  half,
  settings,
  onChange,
  locked = false,
}: {
  half: CornerHalf
  settings: AlertSettings
  onChange: (next: AlertSettings) => void
  locked?: boolean
}) {
  const window =
    settings.market === 'corners' ? CORNER_WINDOWS[half] : GOAL_WINDOWS[half]
  return (
    <div className="space-y-3">
      <RuleEditor
        settings={settings}
        onChange={locked ? () => undefined : onChange}
        title={`${window.shortLabel}`}
        blurb={`Relógio absoluto, period ${window.period}. W=${settings.evaluationWindow}. Limiares do backtest 18/set (lead ≥1 min).`}
      />
      <TrainingAside settings={settings} compact />
    </div>
  )
}

function RuleEditor({
  settings,
  onChange,
  title,
  blurb,
}: {
  settings: AlertSettings
  onChange: (next: AlertSettings) => void
  title: string
  blurb: string
}) {
  const set = <K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) =>
    onChange({ ...settings, [key]: value })
  const details = ruleDetails(settings)
  const kinds = {
    primary: settings.primaryKind,
    secondary: settings.secondaryKind,
    fallback: settings.fallbackKind,
  }

  return (
    <section className="space-y-4 rounded-2xl border border-line bg-panel p-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-emerald-100/60">{blurb}</p>
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
        {needsComboFields(kinds) ? (
          <>
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
              label="Sustained combo |v|"
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
          </>
        ) : null}
        {kinds.secondary === 'swing' ? (
          <NumberField
            label="Swing secundário |Δ1|"
            value={settings.swingSecondaryThreshold}
            min={30}
            max={100}
            onChange={(v) => set('swingSecondaryThreshold', v)}
          />
        ) : null}
        {kinds.primary === 'sustained' || kinds.secondary === 'sustained' ? (
          <>
            <NumberField
              label="Sustained |v|"
              value={settings.sustainedSecondaryThreshold}
              min={10}
              max={80}
              onChange={(v) => set('sustainedSecondaryThreshold', v)}
            />
            <NumberField
              label="Sustained (min)"
              value={settings.sustainedSecondaryMinutes}
              min={2}
              max={8}
              onChange={(v) => set('sustainedSecondaryMinutes', v)}
            />
          </>
        ) : null}
        {kinds.fallback === 'sustainedFallback' ? (
          <>
            {settings.market === 'corners' ? (
              <NumberField
                label="Sustained reserva |v|"
                value={settings.fallbackSustainedThreshold}
                min={10}
                max={80}
                onChange={(v) => set('fallbackSustainedThreshold', v)}
              />
            ) : null}
            <NumberField
              label="Sustained reserva (min)"
              value={settings.sustainedFallbackMinutes}
              min={2}
              max={10}
              onChange={(v) => set('sustainedFallbackMinutes', v)}
            />
          </>
        ) : null}
        {kinds.fallback === 'spike' || kinds.fallback === 'comboFallback' ? (
          <NumberField
            label="Spike reserva |v|"
            value={settings.fallbackSpikeThreshold}
            min={50}
            max={100}
            onChange={(v) => set('fallbackSpikeThreshold', v)}
          />
        ) : null}
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
            ...defaultsFor(settings.market, settings.cornerHalf),
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
  )
}

function needsComboFields(kinds: {
  primary: RuleKind
  secondary: RuleKind
  fallback: RuleKind
}): boolean {
  return (
    kinds.primary === 'combo' ||
    kinds.secondary === 'combo' ||
    kinds.fallback === 'comboFallback'
  )
}

function TrainingAside({
  settings,
  compact = false,
}: {
  settings: AlertSettings
  compact?: boolean
}) {
  const copy = marketCopy(settings.market)
  const training =
    settings.market === 'corners'
      ? settings.cornerHalf === 'ft'
        ? TRAINING_CORNERS_FT
        : TRAINING_CORNERS_HT
      : TRAINING
  const nEvents =
    settings.market === 'corners'
      ? training === TRAINING
        ? TRAINING.nGoals
        : (training as typeof TRAINING_CORNERS_HT).nEvents
      : TRAINING.nGoals
  const coincidence =
    settings.market === 'corners'
      ? (training as typeof TRAINING_CORNERS_HT).coincidence.spike70AtEvent
      : TRAINING.coincidence.spike70OnlyAtGoal
  const windowLabel =
    settings.market === 'corners'
      ? CORNER_WINDOWS[settings.cornerHalf === 'ft' ? 'ft' : 'ht'].shortLabel
      : `${GOAL_WINDOWS.ht.shortLabel} / ${GOAL_WINDOWS.ft.shortLabel}`

  return (
    <aside className="space-y-3">
      <article className="rounded-2xl border border-line bg-panel p-4">
        <p className="text-xs tracking-wider text-lime uppercase">
          Treino · {windowLabel}
        </p>
        <p className="mt-1 text-sm text-emerald-100/70">
          {training.nMatches} jogos · {nEvents} {copy.nounPlural} · {training.dates}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-rose-200/90">
          {coincidence.toString().replace('.', ',')}% dos {copy.nounPlural}
          {settings.market === 'corners' ? ' na janela' : ''} têm Spike70 no
          minuto do {copy.noun}. Não use Spike70 sozinho.
        </p>
      </article>
      {!compact ? (
        <>
          <MetricCard
            title="Primária"
            nounPlural={copy.nounPlural}
            precision={training.primary.precision}
            recall={training.primary.recall}
            alerts={training.primary.alertsPerMatch}
            fp={training.primary.fpPerMatch}
            lead={training.primary.medianLead}
            hit={training.primary.pct1to5}
            hitLabel={settings.evaluationWindow === 3 ? '1–3' : '1–5'}
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
            hitLabel={settings.evaluationWindow === 3 ? '1–3' : '1–5'}
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
            hitLabel={settings.evaluationWindow === 3 ? '1–3' : '1–5'}
          />
        </>
      ) : (
        <MetricCard
          title="Primária"
          nounPlural={copy.nounPlural}
          precision={training.primary.precision}
          recall={training.primary.recall}
          alerts={training.primary.alertsPerMatch}
          fp={training.primary.fpPerMatch}
          lead={training.primary.medianLead}
          hit={training.primary.pct1to5}
          hitLabel={settings.evaluationWindow === 3 ? '1–3' : '1–5'}
        />
      )}
    </aside>
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
  hitLabel = '1–5',
}: {
  title: string
  nounPlural: string
  precision: number
  recall: number
  alerts: number
  fp: number
  lead: number
  hit: number
  hitLabel?: string
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
          {String(hit).replace('.', ',')}% {nounPlural} {hitLabel}
        </div>
      </dl>
    </article>
  )
}
