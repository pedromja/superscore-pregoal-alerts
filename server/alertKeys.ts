import type { Market } from '../src/lib/types.ts'

/**
 * Cross-market identity for a live alert.
 *
 * Goals and corners windows overlap (HT 32–42, and FT 82–87 inside 70–90), and
 * the rule-level alert id (`primary-1-38-37`) does not carry the market, so the
 * same fixture can fire the "same" id in both markets in one tick.
 *
 * Convention (same as `sentKey` / `primedKey` / push tags since the start):
 * - goals keep the legacy, unprefixed form → every stored goals key still
 *   matches byte-for-byte;
 * - corners are prefixed with `corners:`.
 *
 * `LoggedAlert.id` (`fixtureId:alertId`) is NOT changed: learning stores are
 * already split per market+half file, so ids there never collide, and keeping
 * them stable means alerts that are live across a deploy are not duplicated.
 * Only the stores shared by both markets (telegram_messages.json, tips.json,
 * outcome/callback keys) use the market-qualified key below.
 */
export const CORNERS_KEY_PREFIX = 'corners:'
export const GOALS_KEY_PREFIX = 'goals:'

/** `fixtureId:alertId` — the per-market-store id (and the UI monitor key). */
export function loggedAlertId(fixtureId: string, alertId: string): string {
  return `${fixtureId}:${alertId}`
}

/** Market-qualified key for stores shared by both markets. */
export function alertKeyFor(
  market: Market | undefined,
  fixtureId: string,
  alertId: string,
): string {
  return qualifyLoggedId(market, loggedAlertId(fixtureId, alertId))
}

export function qualifyLoggedId(market: Market | undefined, loggedId: string): string {
  return market === 'corners' ? `${CORNERS_KEY_PREFIX}${loggedId}` : loggedId
}

/** Market-qualified key of a stored alert. */
export function loggedAlertKey(alert: { id: string; market?: Market }): string {
  return qualifyLoggedId(alert.market, alert.id)
}

/**
 * Split a key into its market (when explicit) and the per-store id.
 * Unprefixed keys are goals in the new format but may also be legacy corners
 * keys written before this change; `market` is null for those so callers can
 * disambiguate with the stored record.
 */
export function parseAlertKey(key: string): {
  market: Market | null
  loggedId: string
} {
  if (key.startsWith(CORNERS_KEY_PREFIX)) {
    return { market: 'corners', loggedId: key.slice(CORNERS_KEY_PREFIX.length) }
  }
  if (key.startsWith(GOALS_KEY_PREFIX)) {
    return { market: 'goals', loggedId: key.slice(GOALS_KEY_PREFIX.length) }
  }
  return { market: null, loggedId: key }
}

/**
 * Legacy telegram_messages.json records carry no market. The live alert text
 * always starts with the bold market noun (`<b>Golo · …` / `<b>Canto · …`).
 */
export function marketFromTelegramText(text: string | undefined | null): Market | null {
  if (!text) return null
  if (text.startsWith('<b>Canto')) return 'corners'
  if (text.startsWith('<b>Golo')) return 'goals'
  return null
}

/** Tip id: goals keep the legacy `tip-<fixture>-<alert>`; corners are prefixed. */
export function tipIdFor(market: Market, fixtureId: string, alertId: string): string {
  return market === 'corners'
    ? `tip-corners-${fixtureId}-${alertId}`
    : `tip-${fixtureId}-${alertId}`
}
