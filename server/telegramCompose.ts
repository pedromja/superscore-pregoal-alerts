/**
 * Pure text composition for inline-edited Telegram alerts.
 *
 * The message is always rebuilt from state, never patched in place:
 *
 *   <base HTML sent with the alert>
 *   💰 Odd …                      (optional, once attachOdds found a price)
 *   ⚪ VOID … | 🟢 GREEN … | 🔴 RED …  (optional, one status line)
 *
 * so odds / VOID / result edits can arrive in any order without clobbering
 * each other. VOID always wins over GREEN/RED (a VOID message never shows a
 * result).
 */
import { marketCopy, parseMarket } from '../src/lib/market.ts'
import { maisUmPriceOf, type OddsObservation } from '../src/lib/oddsObserve.ts'
import type { Market } from '../src/lib/types.ts'
import { escapeTelegramHtml } from './telegram.ts'

export const VOID_LINE_TEXT = '⚪ VOID · linha já batida ao enviar'

const SOURCE_NAME: Record<string, string> = {
  superscore: 'SuperScore',
  sokkerpro: 'SokkerPro',
  robobet: 'RoboBet',
}

function fmtLine(n: number): string {
  return String(Math.round(n * 100) / 100)
}

function fmtOdd(n: number): string {
  return n.toFixed(2)
}

/**
 * One odds line (HTML), e.g. `💰 Odd +0.5 golos (Over 1.5): 1.85 (SuperScore) · Asiático Over 1.25 1.90 / Under 1.25 1.95`.
 * Uses the same "mais um" pick as tips (SuperScore → SokkerPro → RoboBet).
 * Returns null when nothing usable was observed (then no line is appended).
 */
export function formatTelegramOddsLine(
  obs: OddsObservation | null | undefined,
  market?: Market,
): string | null {
  if (!obs) return null
  const m = parseMarket(market ?? obs.market)
  const noun = marketCopy(m).nounPlural
  const picked = maisUmPriceOf(obs)
  const parts: string[] = []
  if (picked) {
    const rel =
      picked.line != null && Number.isFinite(obs.currentTotal)
        ? picked.line - obs.currentTotal
        : null
    const lineLabel = rel != null && rel > 0 ? `+${fmtLine(rel)} ${noun}` : noun
    const abs = picked.line != null ? ` (Over ${fmtLine(picked.line)})` : ''
    const source = SOURCE_NAME[picked.source] ?? picked.source
    parts.push(`💰 Odd ${lineLabel}${abs}: ${fmtOdd(picked.odd)} (${source})`)
  }
  const asian = obs.asian?.prices.filter((p) => p.price > 1).slice(0, 2) ?? []
  if (asian.length) {
    const compact = asian.map((p) => `${p.name} ${fmtOdd(p.price)}`).join(' / ')
    parts.push(picked ? `Asiático ${compact}` : `💰 Asiático ${compact}`)
  }
  if (!parts.length) return null
  return escapeTelegramHtml(parts.join(' · '))
}

export type ResultLineInput = {
  hit5: boolean | null
  hitLong: boolean | null
  minute: number
  period?: number
  market?: Market
  leadTime5?: number | null
  leadTimeLong?: number | null
  longDeadline?: number | null
}

/**
 * GREEN/RED line appended to the alert. GREEN carries the event minute
 * (alert minute + lead), RED the deadline it ran to, e.g. `🟢 GREEN · 81'`,
 * `🔴 RED · sem golo até 45'`.
 */
export function formatTelegramResultLine(alert: ResultLineInput): string {
  const hit = alert.hit5 === true || alert.hitLong === true
  if (hit) {
    const lead =
      alert.hit5 === true && alert.leadTime5 != null
        ? alert.leadTime5
        : alert.hitLong === true && alert.leadTimeLong != null
          ? alert.leadTimeLong
          : null
    const minute = lead != null ? alert.minute + lead : null
    return minute != null ? `<b>🟢 GREEN</b> · ${minute}'` : '<b>🟢 GREEN</b>'
  }
  const noun = marketCopy(parseMarket(alert.market)).noun
  const detail =
    alert.longDeadline != null ? ` · sem ${noun} até ${alert.longDeadline}'` : ''
  return `<b>🔴 RED</b>${escapeTelegramHtml(detail)}`
}

export type VoidLineInput = {
  market?: Market
  event?: { min: number; period: number } | null
}

/** `⚪ VOID · linha já batida ao enviar · golo aos 36'` (detail when known). */
export function formatTelegramVoidLine(input: VoidLineInput = {}): string {
  const noun = marketCopy(parseMarket(input.market)).noun
  const detail = input.event ? ` · ${noun} aos ${input.event.min}'` : ''
  return `<b>⚪ VOID</b>${escapeTelegramHtml(VOID_LINE_TEXT.slice('⚪ VOID'.length) + detail)}`
}

export type AlertMessageState = {
  baseText: string
  oddsLine?: string | null
  voidLine?: string | null
  resultLine?: string | null
}

/** base + odds + (VOID | result). VOID replaces any result. */
export function composeTelegramAlertText(state: AlertMessageState): string {
  const lines = [state.baseText.trimEnd()]
  if (state.oddsLine) lines.push(state.oddsLine)
  const status = state.voidLine || state.resultLine
  if (status) lines.push(status)
  return lines.join('\n')
}

/** Keyboard goes away once a final status (VOID / result) is shown. */
export function composedMessageIsFinal(state: AlertMessageState): boolean {
  return Boolean(state.voidLine || state.resultLine)
}
