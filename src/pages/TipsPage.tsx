import { useEffect, useState } from 'react'
import { pct } from '../lib/format'
import {
  computeLeagueFollowup,
  ENTRY_LABELS,
  ENTRY_ORDER,
  formatOddPt,
  type EntryType,
  type LeagueRow,
  type RoiRow,
  type Tip,
} from '../lib/tips'
import { DEFAULT_TIP_OVERLAY, type TipOverlay } from '../lib/tipOverlay'
import {
  applyTipOverlay,
  fetchTips,
  patchTelegramLeague,
  type OverlayPayload,
  type TipsPayload,
} from '../lib/tipsApi'
import {
  DEFAULT_LEAGUE_TG_GATE,
  type LeagueTelegramFile,
  type LeagueTgMarket,
} from '../lib/leagueTelegram'
import { CORNER_WINDOWS, GOAL_WINDOWS } from '../lib/windows'
import { TIP_ODD_ISSUE_LABELS, tipFlatPnl, tipOddIssue } from '../lib/tipPnl'

function statusLabel(status: Tip['status']): string {
  if (status === 'won') return 'Ganha'
  if (status === 'lost') return 'Perdida'
  return 'Aberta'
}

function pnlText(tip: Tip): string {
  if (tip.status === 'open') return '—'
  const issue = tip.oddIssue !== undefined ? tip.oddIssue : tipOddIssue(tip)
  if (issue) return `— (${TIP_ODD_ISSUE_LABELS[issue]}, fora do ROI)`
  const pnl = tipFlatPnl(tip)
  if (pnl === null) return '—'
  const sign = pnl >= 0 ? '+' : ''
  return `${sign}${pnl.toFixed(2).replace('.', ',')} u`
}

function noOddText(n: number): string {
  return n ? ` · ${n} s/ odd` : ''
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
          <p className="mt-0.5 text-xs text-emerald-100/50">{tip.leagueLabel || tip.league}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
          {tip.void ? `VOID · ${statusLabel(tip.status)}` : statusLabel(tip.status)}
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
                {noOddText(row.noOdd)}
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

function LeagueTable({
  rows,
  market,
  file,
  onPatch,
}: {
  rows: LeagueRow[]
  market: LeagueTgMarket
  file: LeagueTelegramFile | undefined
  onPatch: (key: string, patch: { tg?: boolean; auto?: boolean; minRoi?: number }) => void
}) {
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
            <th className="py-2 pr-3 font-medium">ROI</th>
            <th className="py-2 pr-3 font-medium">TG</th>
            <th className="py-2 pr-3 font-medium">AUTO</th>
            <th className="py-2 font-medium">min ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const gate = file?.leagues[row.key]?.[market] ?? DEFAULT_LEAGUE_TG_GATE
            return (
            <tr key={row.key} className="border-t border-line/80">
              <td className="py-2 pr-3">{row.league}</td>
              <td className="py-2 pr-3 font-mono">{row.tips}</td>
              <td className="py-2 pr-3 font-mono">
                {row.won}–{row.lost}
                {noOddText(row.noOdd)}
              </td>
              <td className="py-2 pr-3 font-mono">
                {row.pnl.toFixed(2).replace('.', ',')} u
              </td>
              <td className="py-2 pr-3 font-mono">
                {row.roi === null ? '—' : pct(row.roi)}
              </td>
              <td className="py-2 pr-3">
                <input
                  type="checkbox"
                  className="accent-lime"
                  checked={gate.tg}
                  disabled={gate.auto}
                  title="Telegram desta liga. Não pára as tips."
                  onChange={(e) => onPatch(row.key, { tg: e.target.checked })}
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  type="checkbox"
                  className="accent-lime"
                  checked={gate.auto}
                  title="Liga/desliga TG se ROI ≥ min e n≥8"
                  onChange={(e) => onPatch(row.key, { auto: e.target.checked })}
                />
              </td>
              <td className="py-2">
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  className="w-16 rounded border border-line bg-pitch px-1 py-0.5 font-mono text-xs"
                  value={Math.round(gate.minRoi * 1000) / 10}
                  title="Mínimo ROI % (AUTO)"
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(',', '.'))
                    if (!Number.isFinite(n) || n <= 0) return
                    onPatch(row.key, { minRoi: n / 100 })
                  }}
                />
                <span className="ml-0.5 text-[10px] text-emerald-100/40">%</span>
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function TipsPage() {
  const [data, setData] = useState<TipsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tgMarket, setTgMarket] = useState<LeagueTgMarket>('corners')
  const [tgFile, setTgFile] = useState<LeagueTelegramFile | undefined>(undefined)

  async function load() {
    const payload = await fetchTips()
    if (!payload) {
      setError('API de tips indisponível')
      return
    }
    setError(null)
    setData(payload)
    setTgFile(payload.telegramLeagues)
  }

  useEffect(() => {
    let cancelled = false
    async function tick() {
      const payload = await fetchTips()
      if (cancelled) return
      if (!payload) {
        setError('API de tips indisponível')
        return
      }
      setError(null)
      setData(payload)
      setTgFile(payload.telegramLeagues)
    }
    void tick()
    const id = window.setInterval(() => void tick(), 15000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="text-lg font-semibold">Tips · ROI</h2>
        <p className="mt-1 max-w-3xl text-sm text-emerald-100/60">
          Overlay em <span className="font-mono">data/tip_overlay.json</span>, separado
          dos <span className="font-mono">params*.json</span>. Alertas e Telegram
          disparam pelas regras de sinal (Spike/Swing/Sustained) — a odd{' '}
          <strong>não</strong> os bloqueia. Observamos limite (mais-um / over
          current±0,5) e asiático quando o SuperScore/Superbet os tem; se faltar,
          usamos <strong>SokkerPro O/U</strong> (referência Over/Under pública, não
          next-goal / next-canto) e por fim RoboBet Odd Ao Vivo. Grava-se em{' '}
          <span className="font-mono">data/odds_observations.json</span>. Tip/ROI
          anexa a odd se existir; sem odd o alerta continua. Regras de odd vêm
          mais tarde via aprendizagem + confirmação. Não se aplica o overlay de
          backtest (golos minOdd≥3 / cantos OFF). Janelas Golos{' '}
          {GOAL_WINDOWS.ht.shortLabel} / {GOAL_WINDOWS.ft.shortLabel} (sem
          prolongamento). Janelas Cantos {CORNER_WINDOWS.ht.shortLabel} /{' '}
          {CORNER_WINDOWS.ft.shortLabel}. Limiares Spike/Swing/Sustained
          inalterados.
        </p>
        {error ? <p className="mt-2 text-sm text-rose-200">{error}</p> : null}
      </section>

      <OverlayPanel payload={data?.overlay ?? null} onSaved={() => void load()} />

      {(data?.observations ?? []).length ? (
        <section className="rounded-2xl border border-line bg-panel p-4">
          <h3 className="text-sm font-semibold tracking-wide uppercase">
            Odds observadas (não filtram alertas)
          </h3>
          <ul className="mt-3 space-y-2 text-xs text-emerald-100/70">
            {(data?.observations ?? []).slice(0, 12).map((row) => (
              <li key={`${row.fixtureId}:${row.alertId}:${row.ts}`} className="rounded-xl border border-line bg-pitch px-3 py-2 font-mono">
                {row.league} · {row.market}/{row.half} · {row.minute}' · {row.sourceLabel}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-line bg-panel p-4">
        <h3 className="text-sm font-semibold tracking-wide uppercase">
          ROI por tipo × parte
        </h3>
        <p className="mt-1 text-xs text-emerald-100/45">
          Stake fixa 1u por tip: ganha = odd − 1, perdida = −1, VOID/push = 0 (fora).
          ROI = PnL ÷ tips liquidadas com odd válida. «s/ odd» = odd em falta ou de
          outro mercado (total de equipa, outra parte, outra linha): conta no W–L,
          fica fora do PnL/ROI. Odds nunca são inventadas.
        </p>
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
        <p className="mt-1 text-xs text-emerald-100/45">
          Ordenado por ROI (stake fixa 1u). TG/AUTO só cortam o Telegram — as tips
          continuam a gravar. AUTO exige n≥8 tips liquidadas com odd válida e ROI ≥
          mínimo (default 5%).
        </p>
        <div className="mt-2 flex gap-2">
          {(['corners', 'goals'] as LeagueTgMarket[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setTgMarket(m)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                tgMarket === m ? 'bg-lime text-pitch' : 'border border-line text-emerald-100/70'
              }`}
            >
              {m === 'corners' ? 'Cantos' : 'Golos'}
            </button>
          ))}
        </div>
        <div className="mt-3">
          <LeagueTable
            market={tgMarket}
            file={tgFile}
            rows={computeLeagueFollowup(
              [...(data?.open ?? []), ...(data?.settled ?? [])],
              tgMarket,
            )}
            onPatch={(key, patch) => {
              void patchTelegramLeague({ key, market: tgMarket, ...patch }).then(setTgFile)
            }}
          />
        </div>
      </section>
    </div>
  )
}

function oddField(value: number | null): string {
  return value === null ? '' : String(value)
}

function parseOddInput(value: string): number | null {
  const trimmed = value.trim().replace(',', '.')
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 1 ? n : null
}

function OverlayPanel({
  payload,
  onSaved,
}: {
  payload: OverlayPayload | null
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<TipOverlay>(payload?.active ?? DEFAULT_TIP_OVERLAY)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeKey = JSON.stringify(payload?.active ?? null)
  useEffect(() => {
    setDraft(payload?.active ?? DEFAULT_TIP_OVERLAY)
    setConfirm(false)
  }, [activeKey])

  function setBucket(
    key: EntryType,
    patch: Partial<TipOverlay['buckets'][EntryType]>,
  ) {
    setDraft((prev) => ({
      ...prev,
      buckets: { ...prev.buckets, [key]: { ...prev.buckets[key], ...patch } },
    }))
  }

  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h3 className="text-sm font-semibold tracking-wide uppercase">
        Overlay de odd (não altera regras base)
      </h3>
      <p className="mt-1 text-sm text-emerald-100/60">
        {payload?.note ??
          'Ficheiro separado de params*.json. min/max vazios = sem corte até o backtest.'}
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.requireOdd}
          onChange={(e) => setDraft((prev) => ({ ...prev, requireOdd: e.target.checked }))}
          className="accent-lime"
        />
        requireOdd — futuro (agora NÃO filtra alertas/push)
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] uppercase tracking-wider text-emerald-100/45">
          minOdd global
          <input
            value={oddField(draft.minOdd)}
            placeholder="vazio (aguarda backtest)"
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, minOdd: parseOddInput(e.target.value) }))
            }
            className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 text-sm text-emerald-50 outline-none focus:border-lime/50"
          />
        </label>
        <label className="text-[11px] uppercase tracking-wider text-emerald-100/45">
          maxOdd global
          <input
            value={oddField(draft.maxOdd)}
            placeholder="vazio (aguarda backtest)"
            onChange={(e) =>
              setDraft((prev) => ({ ...prev, maxOdd: parseOddInput(e.target.value) }))
            }
            className="mt-1 w-full rounded-xl border border-line bg-pitch px-3 py-2 text-sm text-emerald-50 outline-none focus:border-lime/50"
          />
        </label>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {ENTRY_ORDER.map((key) => {
          const row = draft.buckets[key]
          return (
            <div key={key} className="rounded-xl border border-line bg-pitch px-3 py-2">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={row.enable}
                  onChange={(e) => setBucket(key, { enable: e.target.checked })}
                  className="accent-lime"
                />
                {ENTRY_LABELS[key]}
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  value={oddField(row.minOdd)}
                  placeholder="min"
                  onChange={(e) => setBucket(key, { minOdd: parseOddInput(e.target.value) })}
                  className="rounded-lg border border-line bg-panel px-2 py-1 font-mono text-xs"
                />
                <input
                  value={oddField(row.maxOdd)}
                  placeholder="max"
                  onChange={(e) => setBucket(key, { maxOdd: parseOddInput(e.target.value) })}
                  className="rounded-lg border border-line bg-panel px-2 py-1 font-mono text-xs"
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-emerald-100/80">
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
            className="accent-lime"
          />
          Confirmo gravar o overlay (não filtra alertas agora; regras de odd só após aprendizagem + confirmação)
        </label>
        <button
          type="button"
          disabled={!confirm || busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            void applyTipOverlay(draft, payload?.proposal?.id)
              .then(() => {
                setConfirm(false)
                onSaved()
              })
              .catch((err) =>
                setError(err instanceof Error ? err.message : 'Falha a aplicar overlay'),
              )
              .finally(() => setBusy(false))
          }}
          className="rounded-xl bg-lime px-3 py-2 text-sm font-semibold text-pitch disabled:opacity-40"
        >
          Confirmar overlay
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-rose-200">{error}</p> : null}
    </section>
  )
}
