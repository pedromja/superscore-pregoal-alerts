import { useEffect, useState } from 'react'
import { pct } from '../lib/format'
import { formatOddPt, type LeagueRow, type RoiRow, type Tip } from '../lib/tips'
import { fetchTips, type TipsPayload } from '../lib/tipsApi'

function statusLabel(status: Tip['status']): string {
  if (status === 'won') return 'Ganha'
  if (status === 'lost') return 'Perdida'
  return 'Aberta'
}

function pnlText(tip: Tip): string {
  if (tip.status === 'open' || tip.pnl === null) return '—'
  const sign = tip.pnl >= 0 ? '+' : ''
  return `${sign}${tip.pnl.toFixed(2).replace('.', ',')} u`
}

function TipRow({ tip }: { tip: Tip }) {
  const tone =
    tip.status === 'won'
      ? 'text-lime'
      : tip.status === 'lost'
        ? 'text-rose-300'
        : 'text-emerald-100/80'
  return (
    <article className="rounded-2xl border border-line bg-panel/80 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-emerald-50">{tip.matchLabel}</p>
          <p className="mt-0.5 text-xs text-emerald-100/50">{tip.league}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
          {statusLabel(tip.status)}
        </span>
      </div>
      <p className="mt-2 font-mono text-xs text-lime">
        Odd {formatOddPt(tip.odd)}
        {tip.line !== null ? ` · linha ${String(tip.line).replace('.', ',')}` : ''}
        {` · ${tip.market === 'corners' ? 'Cantos' : 'Golos'} ${tip.half.toUpperCase()}`}
      </p>
      <p className="mt-1 text-xs text-emerald-100/55">
        {tip.minute}' · {tip.sourceLabel} · PnL {pnlText(tip)}
      </p>
    </article>
  )
}

function RoiTable({ rows }: { rows: RoiRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-emerald-100/45">
          <tr>
            <th className="py-2 pr-3 font-medium">Tipo</th>
            <th className="py-2 pr-3 font-medium">Tips</th>
            <th className="py-2 pr-3 font-medium">W–L</th>
            <th className="py-2 pr-3 font-medium">PnL</th>
            <th className="py-2 font-medium">ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line/80">
              <td className="py-2 pr-3 font-semibold">{row.label}</td>
              <td className="py-2 pr-3 font-mono">{row.tips}</td>
              <td className="py-2 pr-3 font-mono">
                {row.won}–{row.lost}
                {row.open ? ` · ${row.open} ab.` : ''}
              </td>
              <td className="py-2 pr-3 font-mono">
                {row.pnl.toFixed(2).replace('.', ',')} u
              </td>
              <td className="py-2 font-mono">
                {row.roi === null ? '—' : pct(row.roi)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LeagueTable({ rows }: { rows: LeagueRow[] }) {
  if (!rows.length) {
    return (
      <p className="text-sm text-emerald-100/50">
        Ainda sem follow-up por liga. As tips liquidadas aparecem aqui.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-emerald-100/45">
          <tr>
            <th className="py-2 pr-3 font-medium">Liga</th>
            <th className="py-2 pr-3 font-medium">Tips</th>
            <th className="py-2 pr-3 font-medium">W–L</th>
            <th className="py-2 pr-3 font-medium">PnL</th>
            <th className="py-2 font-medium">ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.league} className="border-t border-line/80">
              <td className="py-2 pr-3">{row.league}</td>
              <td className="py-2 pr-3 font-mono">{row.tips}</td>
              <td className="py-2 pr-3 font-mono">
                {row.won}–{row.lost}
              </td>
              <td className="py-2 pr-3 font-mono">
                {row.pnl.toFixed(2).replace('.', ',')} u
              </td>
              <td className="py-2 font-mono">
                {row.roi === null ? '—' : pct(row.roi)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TipsPage() {
  const [data, setData] = useState<TipsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const payload = await fetchTips()
      if (cancelled) return
      if (!payload) {
        setError('API de tips indisponível')
        return
      }
      setError(null)
      setData(payload)
    }
    void load()
    const tick = window.setInterval(() => void load(), 15000)
    return () => {
      cancelled = true
      window.clearInterval(tick)
    }
  }, [])

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">Tips · ROI</h2>
        <p className="mt-1 max-w-3xl text-sm text-emerald-100/60">
          Só há tip e Web Push quando existe odd de «mais um golo/canto». Fonte 1:
          SuperScore (Over current+0,5 / mercados Superbet ligados ao{' '}
          <span className="font-mono">event_id</span>). Fonte 2: Telegram RoboBet, só a
          linha <span className="font-mono">Odd Ao Vivo</span> — nunca Pre-jogo nem Ao
          Vivo 1X2. Stake 1u; ganho +(odd−1), perda −1. Liquidação pelo horizonte do
          alerta (evento depois do minuto, dentro da janela).
        </p>
        {error ? <p className="mt-2 text-sm text-rose-200">{error}</p> : null}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">
          ROI por tipo × parte
        </h3>
        <div className="mt-3">
          <RoiTable rows={data?.roi ?? []} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-sm font-semibold tracking-wide uppercase">
            Tips abertas
          </h3>
          <div className="mt-3 grid gap-2">
            {(data?.open ?? []).length === 0 ? (
              <p className="text-sm text-emerald-100/50">Nenhuma tip aberta.</p>
            ) : (
              data?.open.map((tip) => <TipRow key={tip.id} tip={tip} />)
            )}
          </div>
        </section>
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-sm font-semibold tracking-wide uppercase">
            Tips liquidadas
          </h3>
          <div className="mt-3 grid gap-2">
            {(data?.settled ?? []).length === 0 ? (
              <p className="text-sm text-emerald-100/50">Ainda sem liquidações.</p>
            ) : (
              data?.settled.slice(0, 24).map((tip) => <TipRow key={tip.id} tip={tip} />)
            )}
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">
          Acompanhamento por liga
        </h3>
        <div className="mt-3">
          <LeagueTable rows={data?.leagues ?? []} />
        </div>
      </section>
    </div>
  )
}
