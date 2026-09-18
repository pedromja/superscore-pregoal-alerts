import { marketCopy, parseMarket } from '../lib/market'
import { formatRelative, formatSigned, minuteLabel, sideLabel } from '../lib/format'
import { alertDomId, feedAlertKey } from '../lib/notifications'
import { RULE_SHORT } from '../lib/rules'
import type { FeedAlert, FiredAlert, Market, Side } from '../lib/types'

function SideChip({ side }: { side: Side }) {
  const home = side === 'home'
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ${
        home
          ? 'bg-cyan-400/15 text-home'
          : 'bg-amber-400/15 text-away'
      }`}
    >
      {sideLabel(side)}
    </span>
  )
}

function RuleChip({ rule, coincident }: { rule: FeedAlert['rule']; coincident?: boolean }) {
  const tone = coincident
    ? 'bg-rose-500/15 text-rose-300'
    : rule === 'primary'
      ? 'bg-lime/15 text-lime'
      : rule === 'secondary'
        ? 'bg-sky-400/15 text-sky-300'
        : 'bg-emerald-700/40 text-emerald-200'
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {RULE_SHORT[rule]}
    </span>
  )
}

export function AlertMetrics({ alert }: { alert: FiredAlert }) {
  return (
    <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] text-emerald-100/70">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-emerald-100/40">v</div>
        {formatSigned(alert.momentum)}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-emerald-100/40">Δ1</div>
        {alert.delta1 === null ? '—' : formatSigned(alert.delta1)}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-emerald-100/40">Sust.</div>
        {alert.sustainedLength} min
      </div>
    </div>
  )
}

export function AlertCard({
  alert,
  now,
  highlighted = false,
  market,
  onFeedback,
}: {
  alert: FeedAlert
  now?: number
  highlighted?: boolean
  market?: Market
  onFeedback?: (id: string, vote: 'up' | 'down') => void
}) {
  const copy = marketCopy(parseMarket(market ?? alert.market))
  return (
    <article
      id={alertDomId(feedAlertKey(alert))}
      className={`rounded-2xl border p-3 shadow-[inset_0_1px_0_rgba(182,243,76,0.04)] ${
        highlighted
          ? 'border-lime bg-lime/10 ring-2 ring-lime/40'
          : 'border-line bg-panel/80'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-50">{alert.matchLabel}</p>
          <p className="mt-1 text-xs text-emerald-100/55">
            {minuteLabel(alert.min, alert.period)}
            {alert.firedAt ? ` · ${formatRelative(alert.firedAt, now)}` : null}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          <RuleChip rule={alert.rule} coincident={alert.coincident} />
          <SideChip side={alert.side} />
        </div>
      </div>
      {alert.coincident ? (
        <p className="mt-2 text-xs text-rose-300/90">
          Pico no minuto do {copy.noun} — coincidente, não conta como pré-alerta.
        </p>
      ) : null}
      <AlertMetrics alert={alert} />
      {onFeedback ? (
        <div className="mt-2 flex gap-1">
          <button
            type="button"
            className="rounded-lg border border-line px-2 py-0.5 text-xs hover:border-lime/50"
            onClick={() => onFeedback(`${alert.fixtureId}:${alert.id}`, 'up')}
          >
            👍 útil
          </button>
          <button
            type="button"
            className="rounded-lg border border-line px-2 py-0.5 text-xs hover:border-rose-400/50"
            onClick={() => onFeedback(`${alert.fixtureId}:${alert.id}`, 'down')}
          >
            👎 falso
          </button>
        </div>
      ) : null}
    </article>
  )
}
