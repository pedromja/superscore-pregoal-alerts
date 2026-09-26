/**
 * Which fixtures still have alerts without a bet outcome, per store scope.
 * Fed by store.saveAlerts (the file is written whole), so the settle step only
 * loads a scope when one of its fixtures can still change. No store import.
 */
import { parseMarket } from '../src/lib/market.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { parseCornerHalf } from '../src/lib/windows.ts'
import type { LoggedAlert } from './types.ts'

/** What the settle step needs to know whether a stored alert can be decided now. */
export type PendingBetLite = { minute: number; period: number; baseline: number | null }

const pendingByScope = new Map<string, Map<string, PendingBetLite[]>>()

export function betScopeKey(market: Market, half?: CornerHalf | null): string {
  return `${parseMarket(market)}|${parseCornerHalf(half)}`
}

/** Needs a bet decision: not VOID, not coincident, none stored yet. */
export function betPending(alert: Pick<LoggedAlert, 'void' | 'coincident' | 'betOutcome'>): boolean {
  return !alert.void && !alert.coincident && !alert.betOutcome
}

/** Older undecided alerts (e.g. no event coverage) are not swept any more. */
export const BET_PENDING_MAX_AGE_MS = 24 * 60 * 60_000

export function observeBetPending(
  alerts: LoggedAlert[],
  market: Market,
  half?: CornerHalf | null,
  nowMs = Date.now(),
): void {
  const byFixture = new Map<string, PendingBetLite[]>()
  for (const a of alerts) {
    if (!betPending(a)) continue
    const at = Date.parse(a.ts)
    if (Number.isFinite(at) && nowMs - at > BET_PENDING_MAX_AGE_MS) continue
    const list = byFixture.get(a.fixtureId) ?? []
    list.push({ minute: a.minute, period: a.period, baseline: a.sendSnapshot?.totalAtAlert ?? null })
    byFixture.set(a.fixtureId, list)
  }
  pendingByScope.set(betScopeKey(market, half), byFixture)
}

export function scopesWithPending(fixtureId: string): { market: Market; half: CornerHalf }[] {
  const out: { market: Market; half: CornerHalf }[] = []
  for (const [scope, byFixture] of pendingByScope) {
    if (!byFixture.has(fixtureId)) continue
    const [m, h] = scope.split('|')
    out.push({ market: parseMarket(m), half: parseCornerHalf(h) })
  }
  return out
}

export function pendingBetsFor(market: Market, half: CornerHalf, fixtureId: string): PendingBetLite[] {
  return pendingByScope.get(betScopeKey(market, half))?.get(fixtureId) ?? []
}

export function pendingFixtures(): Set<string> {
  const out = new Set<string>()
  for (const byFixture of pendingByScope.values()) for (const id of byFixture.keys()) out.add(id)
  return out
}

export function betIndexPrimed(): boolean {
  return pendingByScope.size > 0
}

export function resetBetIndexForTests(): void {
  pendingByScope.clear()
}
