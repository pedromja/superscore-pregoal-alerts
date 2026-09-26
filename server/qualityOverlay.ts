/**
 * Server side of the quality overlay (see src/lib/qualityOverlay.ts):
 * env switch, annotation of evaluated alerts, the one-per-match×half cap
 * derived from stored alerts (survives restarts) and precision stats.
 */
import {
  overlayDecision,
  parseQualityOverlayEnv,
  QUALITY_OVERLAY_LIMITS,
  QUALITY_OVERLAY_VERSION,
} from '../src/lib/qualityOverlay.ts'
import type { AlertOverlay, CornerHalf, FeedAlert, Market } from '../src/lib/types.ts'
import { cornerHalfOf, goalHalfOf } from '../src/lib/windows.ts'
import { loadAlerts } from './store.ts'
import type { LoggedAlert } from './types.ts'

/** `QUALITY_OVERLAY=on|off`, default on. Read live so tests/ops can flip it. */
export function qualityOverlayEnabled(): boolean {
  return parseQualityOverlayEnv(process.env.QUALITY_OVERLAY)
}

export function alertHalf(market: Market, alert: Pick<FeedAlert, 'cornerHalf' | 'min' | 'period'>): CornerHalf | null {
  if (alert.cornerHalf === 'ht' || alert.cornerHalf === 'ft') return alert.cornerHalf
  return market === 'corners'
    ? cornerHalfOf(alert.min, alert.period)
    : goalHalfOf(alert.min, alert.period)
}

/** Rule-level overlay for one evaluated alert (cap is applied at claim time). */
export function overlayForFeedAlert(market: Market, alert: FeedAlert, enforced = qualityOverlayEnabled()): AlertOverlay {
  const half = alertHalf(market, alert)
  if (!half) {
    return { version: QUALITY_OVERLAY_VERSION, pass: false, reasons: ['out-of-window'], enforced }
  }
  return overlayDecision(
    {
      market,
      half,
      rule: alert.rule,
      min: alert.min,
      side: alert.side,
      momentum: alert.momentum,
      delta1: alert.delta1,
      sustainedLength: alert.sustainedLength,
      goalsTally: alert.goalsTally ?? null,
    },
    enforced,
  )
}

export function annotateOverlay(market: Market, alerts: FeedAlert[]): FeedAlert[] {
  const enforced = qualityOverlayEnabled()
  return alerts.map((alert) => ({ ...alert, overlay: overlayForFeedAlert(market, alert, enforced) }))
}

/** Overlay-passed alerts already claimed for notification in this match×half. */
export function overlayNotifiedCount(stored: LoggedAlert[], fixtureId: string): number {
  let n = 0
  for (const a of stored) {
    if (a.fixtureId === fixtureId && a.overlay?.pass && a.overlay.notified) n += 1
  }
  return n
}

export function overlayCapReached(stored: LoggedAlert[], fixtureId: string, claimedNow = 0): boolean {
  return overlayNotifiedCount(stored, fixtureId) + claimedNow >= QUALITY_OVERLAY_LIMITS.maxNotifiedPerMatchHalf
}

export type OverlayBucket = {
  alerts: number
  settled: number
  won: number
  precision: number | null
}

function bucket(items: LoggedAlert[]): OverlayBucket {
  const settled = items.filter((a) => a.hit5 !== null || a.hitLong !== null)
  const won = settled.filter((a) => a.hit5 === true || a.hitLong === true).length
  return {
    alerts: items.length,
    settled: settled.length,
    won,
    precision: settled.length ? Math.round((won / settled.length) * 1000) / 1000 : null,
  }
}

export type OverlayScopeStats = {
  market: Market
  half: CornerHalf
  /** Primary alerts stored before the overlay existed (no decision recorded). */
  legacyWithoutOverlay: number
  /** Every Primary alert with an overlay decision (what the locked rule fired). */
  base: OverlayBucket
  /** …of which the overlay passed. */
  overlayPass: OverlayBucket
  /** …of which delivered (Telegram/push) — base when off, overlay when on. */
  delivered: OverlayBucket
  /** Passed + claimed for notification (the cap counts these). */
  overlayNotified: OverlayBucket
  blockReasons: Record<string, number>
  /** Primary alerts flagged VOID (line beaten at send) — excluded from every bucket. */
  voided: number
}

export function overlayStatsFor(alerts: LoggedAlert[], market: Market, half: CornerHalf): OverlayScopeStats {
  const allPrimary = alerts.filter((a) => a.ruleId === 'primary')
  // VOID alerts stay stored (audit) but never count as won/settled.
  const primary = allPrimary.filter((a) => !a.void)
  const withOverlay = primary.filter((a) => a.overlay)
  const blockReasons: Record<string, number> = {}
  for (const a of withOverlay) {
    if (a.overlay!.pass) continue
    for (const r of a.overlay!.reasons) blockReasons[r] = (blockReasons[r] ?? 0) + 1
  }
  return {
    market,
    half,
    legacyWithoutOverlay: primary.length - withOverlay.length,
    base: bucket(withOverlay),
    overlayPass: bucket(withOverlay.filter((a) => a.overlay!.pass)),
    delivered: bucket(withOverlay.filter((a) => a.sentPush)),
    overlayNotified: bucket(withOverlay.filter((a) => a.overlay!.pass && a.overlay!.notified)),
    blockReasons,
    voided: allPrimary.length - primary.length,
  }
}

export function overlayStats(market: Market, half: CornerHalf): OverlayScopeStats {
  return overlayStatsFor(loadAlerts(market, half), market, half)
}

export function overlayConfig() {
  return {
    enabled: qualityOverlayEnabled(),
    version: QUALITY_OVERLAY_VERSION,
    limits: QUALITY_OVERLAY_LIMITS,
    env: 'QUALITY_OVERLAY',
  }
}
