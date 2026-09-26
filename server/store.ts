import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMarket } from '../src/lib/market.ts'
import type {
  AlertSettings,
  CornerHalf,
  Fixture,
  Market,
  MomentumPayload,
} from '../src/lib/types.ts'
import { parseCornerHalf, parseCornerHalfOpt } from '../src/lib/windows.ts'
import { DATA_DIR, MATCHES_DIR } from './config.ts'
import type { RobobetQuote } from '../src/lib/robobet.ts'
import type { Tip } from '../src/lib/tips.ts'
import {
  DEFAULT_TIP_OVERLAY,
  normalizeTipOverlay,
  type TipOverlay,
  type TipOverlayProposal,
} from '../src/lib/tipOverlay.ts'
import type { OddsObservation } from '../src/lib/oddsObserve.ts'
import { oddsLogKey } from '../src/lib/oddsObserve.ts'
import type { GoalRecord, LoggedAlert, ParamVersion, PushSub, StoredMatch } from './types.ts'
import { marketFromTelegramText, parseAlertKey } from './alertKeys.ts'

const TIP_OVERLAY_FILE = 'tip_overlay.json'
const TIP_OVERLAY_PROPOSAL_FILE = 'tip_overlay_proposal.json'
const ODDS_LOG_FILE = 'odds_observations.json'
const ODDS_LOG_CAP = 4000
const TELEGRAM_MAP_FILE = 'telegram_messages.json'
const TELEGRAM_MAP_CAP = 4000

export type LearnScope = 'goals_ht' | 'goals_ft' | 'corners_ht' | 'corners_ft'

const FILES: Record<
  LearnScope,
  {
    alerts: string
    events: string
    params: string
    history: string
    proposal: string
  }
> = {
  goals_ht: {
    alerts: 'alerts.json',
    events: 'goals.json',
    params: 'params.json',
    history: 'params_history.json',
    proposal: 'proposal.json',
  },
  goals_ft: {
    alerts: 'alerts_goals_ft.json',
    events: 'goals_ft.json',
    params: 'params_goals_ft.json',
    history: 'params_history_goals_ft.json',
    proposal: 'proposal_goals_ft.json',
  },
  corners_ht: {
    alerts: 'alerts_corners_ht.json',
    events: 'corners_ht.json',
    params: 'params_corners_ht.json',
    history: 'params_history_corners_ht.json',
    proposal: 'proposal_corners_ht.json',
  },
  corners_ft: {
    alerts: 'alerts_corners_ft.json',
    events: 'corners_ft.json',
    params: 'params_corners_ft.json',
    history: 'params_history_corners_ft.json',
    proposal: 'proposal_corners_ft.json',
  },
}

export function learnScope(
  market: Market = 'goals',
  half?: CornerHalf | null,
): LearnScope {
  const h = parseCornerHalf(half)
  if (parseMarket(market) === 'corners') {
    return h === 'ft' ? 'corners_ft' : 'corners_ht'
  }
  return h === 'ft' ? 'goals_ft' : 'goals_ht'
}

function readJson<T>(file: string, fallback: T): T {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(join(DATA_DIR, file), JSON.stringify(value, null, 2))
}

export function loadActiveMarket(): Market {
  return parseMarket(readJson<{ market?: string }>('market.json', {}).market)
}

export function saveActiveMarket(market: Market): void {
  writeJson('market.json', { market: parseMarket(market) })
}

export function loadSubscriptions(): PushSub[] {
  return readJson('subscriptions.json', [])
}

export function saveSubscriptions(items: PushSub[]): void {
  writeJson('subscriptions.json', items)
}

export function loadRobobetQuotes(): RobobetQuote[] {
  return readJson('robobet_tips.json', [])
}

export function saveRobobetQuotes(items: RobobetQuote[]): void {
  writeJson('robobet_tips.json', items)
}

export function loadTips(): Tip[] {
  return readJson('tips.json', [])
}

export function saveTips(items: Tip[]): void {
  writeJson('tips.json', items.slice(-2000))
}

export function appendTipSkip(entry: unknown): void {
  const items = readJson<unknown[]>('tip_skips.json', [])
  items.push(entry)
  writeJson('tip_skips.json', items.slice(-200))
}

export function loadTipOverlay(): TipOverlay {
  const stored = readJson<unknown>(TIP_OVERLAY_FILE, null)
  if (stored == null) {
    writeJson(TIP_OVERLAY_FILE, DEFAULT_TIP_OVERLAY)
    return { ...DEFAULT_TIP_OVERLAY, buckets: { ...DEFAULT_TIP_OVERLAY.buckets } }
  }
  return normalizeTipOverlay(stored)
}

export function saveTipOverlay(overlay: TipOverlay): void {
  writeJson(TIP_OVERLAY_FILE, normalizeTipOverlay(overlay))
}

export function loadTipOverlayProposal(): TipOverlayProposal | null {
  return readJson<TipOverlayProposal | null>(TIP_OVERLAY_PROPOSAL_FILE, null)
}

export function saveTipOverlayProposal(item: TipOverlayProposal | null): void {
  writeJson(TIP_OVERLAY_PROPOSAL_FILE, item)
}

export type OddsLogFile = {
  updatedAt: string
  items: OddsObservation[]
}

export function loadOddsObservations(): OddsObservation[] {
  const raw = readJson<OddsLogFile | OddsObservation[]>(ODDS_LOG_FILE, { updatedAt: '', items: [] })
  if (Array.isArray(raw)) return raw
  return raw.items ?? []
}

export function appendOddsObservation(entry: OddsObservation): void {
  const items = loadOddsObservations()
  items.push(entry)
  writeJson(ODDS_LOG_FILE, {
    updatedAt: entry.ts,
    items: items.slice(-ODDS_LOG_CAP),
  })
}

export function oddsObservationsForKey(
  market: OddsObservation['market'],
  half: OddsObservation['half'],
  league: string,
): OddsObservation[] {
  const key = oddsLogKey(market, half, league)
  return loadOddsObservations().filter(
    (row) => oddsLogKey(row.market, row.half, row.league) === key,
  )
}

export function loadAlerts(
  market: Market = 'goals',
  half?: CornerHalf | null,
): LoggedAlert[] {
  return readJson(FILES[learnScope(market, half)].alerts, [])
}

export function saveAlerts(
  items: LoggedAlert[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].alerts, items)
}

export function loadGoals(
  market: Market = 'goals',
  half?: CornerHalf | null,
): GoalRecord[] {
  return readJson(FILES[learnScope(market, half)].events, [])
}

export function saveGoals(
  items: GoalRecord[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].events, items)
}

export function loadSent(): string[] {
  return readJson('sent.json', [])
}

export function saveSent(items: string[]): void {
  writeJson('sent.json', items.slice(-4000))
}

export function loadPrimed(): string[] {
  return readJson('primed.json', [])
}

export function savePrimed(items: string[]): void {
  writeJson('primed.json', items)
}

export function loadParams(
  market: Market = 'goals',
  half?: CornerHalf | null,
): AlertSettings | null {
  return readJson<AlertSettings | null>(FILES[learnScope(market, half)].params, null)
}

export function saveParams(
  settings: AlertSettings,
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  const h = parseCornerHalf(half ?? settings.cornerHalf)
  writeJson(FILES[learnScope(market, h)].params, {
    ...settings,
    market,
    cornerHalf: h,
  })
}

export function loadHistory(
  market: Market = 'goals',
  half?: CornerHalf | null,
): ParamVersion[] {
  return readJson(FILES[learnScope(market, half)].history, [])
}

export function saveHistory(
  items: ParamVersion[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].history, items)
}

export function loadProposal(
  market: Market = 'goals',
  half?: CornerHalf | null,
): ParamVersion | null {
  return readJson<ParamVersion | null>(FILES[learnScope(market, half)].proposal, null)
}

export function saveProposal(
  item: ParamVersion | null,
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].proposal, item)
}

export type ResetLearnMarket = 'goals' | 'corners' | 'all'

const RESET_SCOPE: Record<
  Exclude<ResetLearnMarket, 'all'>,
  LearnScope[]
> = {
  goals: ['goals_ht', 'goals_ft'],
  corners: ['corners_ht', 'corners_ft'],
}

const SCOPE_REF: Record<LearnScope, { market: Market; half?: CornerHalf }> = {
  goals_ht: { market: 'goals', half: 'ht' },
  goals_ft: { market: 'goals', half: 'ft' },
  corners_ht: { market: 'corners', half: 'ht' },
  corners_ft: { market: 'corners', half: 'ft' },
}

/** Files we deliberately do not wipe on learn reset (avoid push storms / lost overlay). */
export const LEARN_RESET_KEPT = [
  'params*.json (limiares no disco — o poller usa defaults locked do código enquanto DEFINITIONS_LOCKED)',
  'sent.json (anti re-spam de push)',
  'primed.json',
  'subscriptions.json / vapid.json',
  'tip_overlay.json / tip_overlay_proposal.json',
  'tips.json / robobet_tips.json / odds_observations.json',
  'matches/*.json (arquivo de momentum)',
  'telegram_messages.json (message_id + outcome sent — anti re-envio GREEN/RED)',
] as const

function scopesForReset(market: ResetLearnMarket): LearnScope[] {
  return market === 'all'
    ? ['goals_ht', 'goals_ft', 'corners_ht', 'corners_ft']
    : RESET_SCOPE[market]
}

export function resetLearnStore(market: ResetLearnMarket = 'all'): {
  market: ResetLearnMarket
  scopes: LearnScope[]
  cleared: string[]
  kept: readonly string[]
} {
  const scopes = scopesForReset(market)
  const cleared: string[] = []
  for (const scope of scopes) {
    const { market: m, half } = SCOPE_REF[scope]
    const files = FILES[scope]
    saveAlerts([], m, half)
    saveGoals([], m, half)
    saveHistory([], m, half)
    saveProposal(null, m, half)
    cleared.push(files.alerts, files.events, files.history, files.proposal)
  }
  return { market, scopes, cleared, kept: LEARN_RESET_KEPT }
}

export function saveMatch(match: StoredMatch): void {
  writeFileSync(
    join(MATCHES_DIR, `${match.fixture.id}.json`),
    JSON.stringify(match),
  )
}

export function loadMatch(fixtureId: string): StoredMatch | null {
  const path = join(MATCHES_DIR, `${matchPath(fixtureId)}`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredMatch
  } catch {
    return null
  }
}

function matchPath(fixtureId: string): string {
  return `${fixtureId}.json`
}

export function listMatches(): StoredMatch[] {
  if (!existsSync(MATCHES_DIR)) return []
  return readdirSync(MATCHES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadMatch(name.replace(/\.json$/, '')))
    .filter((m): m is StoredMatch => m !== null)
}

/** Compare two stored alerts ignoring `ts` (bumped on every re-evaluation). */
function sameStoredAlert(a: LoggedAlert, b: LoggedAlert): boolean {
  return JSON.stringify({ ...a, ts: '' }) === JSON.stringify({ ...b, ts: '' })
}

/**
 * Merge re-evaluated alerts into the per-market/half store. The poller calls
 * this for every in-window fixture on every tick with the match's full alert
 * list, so a no-op merge (only `ts` would move) skips the rewrite of what can
 * be a 12 MB file. `preloaded` avoids a second parse when the caller already
 * read the store.
 */
export function upsertAlerts(
  incoming: LoggedAlert[],
  market: Market = 'goals',
  half?: CornerHalf | null,
  preloaded?: LoggedAlert[],
): LoggedAlert[] {
  const h = parseCornerHalf(half)
  const alerts = preloaded ?? loadAlerts(market, h)
  const byId = new Map(alerts.map((a) => [a.id, a]))
  let changed = false
  for (const item of incoming) {
    const prev = byId.get(item.id)
    const merged: LoggedAlert =
      prev
        ? {
            ...item,
            ...prev,
            ...item,
            feedback: prev.feedback ?? item.feedback,
            sentPush: Boolean(prev.sentPush || item.sentPush),
            telegramMessageId: item.telegramMessageId ?? prev.telegramMessageId,
            telegramOutcomeSentAt:
              item.telegramOutcomeSentAt ?? prev.telegramOutcomeSentAt,
            hit: item.hit ?? prev.hit,
            hit5: item.hit5 ?? prev.hit5,
            hitLong: item.hitLong ?? prev.hitLong,
            labeledAt: item.labeledAt ?? prev.labeledAt,
            leadMin: item.leadMin ?? prev.leadMin,
            leadTime5: item.leadTime5 ?? prev.leadTime5,
            leadTimeLong: item.leadTimeLong ?? prev.leadTimeLong,
            longDeadline: item.longDeadline ?? prev.longDeadline,
            odds: item.odds ?? prev.odds,
            // First overlay decision sticks (cap/notified are patched later).
            ...(prev.overlay ?? item.overlay
              ? { overlay: prev.overlay ?? item.overlay }
              : {}),
            market,
            cornerHalf: h ?? item.cornerHalf,
          }
        : { ...item, market, cornerHalf: h ?? item.cornerHalf }
    if (!prev || !sameStoredAlert(prev, merged)) {
      byId.set(item.id, merged)
      changed = true
    }
  }
  if (!changed) return alerts
  const next = [...byId.values()]
  saveAlerts(next, market, h)
  return next
}

export function upsertGoals(
  incoming: GoalRecord[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  const h = parseCornerHalf(half)
  const goals = loadGoals(market, h)
  const key = (g: GoalRecord) => `${g.fixtureId}:${g.period}:${g.min}:${g.side}`
  const byId = new Map(goals.map((g) => [key(g), g]))
  for (const item of incoming) {
    byId.set(key(item), {
      ...byId.get(key(item)),
      ...item,
      market,
      cornerHalf: h ?? item.cornerHalf,
    })
  }
  saveGoals([...byId.values()], market, h)
}

export function sentKey(
  market: Market,
  fixtureId: string,
  alertId: string,
  half?: CornerHalf | null,
): string {
  if (market === 'goals') return `${fixtureId}:${alertId}`
  const h = parseCornerHalfOpt(half)
  return h ? `corners:${h}:${fixtureId}:${alertId}` : `corners:${fixtureId}:${alertId}`
}

export function primedKey(market: Market, fixtureId: string): string {
  return market === 'goals' ? fixtureId : `${market}:${fixtureId}`
}

export function markSent(key: string): boolean {
  const sent = loadSent()
  if (sent.includes(key)) return false
  sent.push(key)
  saveSent(sent)
  return true
}

export function markAlertPushed(
  alertId: string,
  market: Market = 'goals',
  half?: CornerHalf | null,
): boolean {
  const m = parseMarket(market)
  if (!parseCornerHalfOpt(half)) {
    const ht = markAlertPushed(alertId, m, 'ht')
    const ft = markAlertPushed(alertId, m, 'ft')
    return ht || ft
  }
  // Both markets keep one store per half (goals FT = alerts_goals_ft.json).
  const h = parseCornerHalf(half)
  const alerts = loadAlerts(m, h)
  const loggedId = parseAlertKey(alertId).loggedId
  const idx = alerts.findIndex((a) => a.id === loggedId)
  if (idx < 0) return false
  if (alerts[idx].sentPush) return true
  alerts[idx] = { ...alerts[idx], sentPush: true }
  saveAlerts(alerts, m, h)
  return true
}

export type TelegramMessageRecord = {
  messageId: number
  chatId: string
  text: string
  sentAt: string
  outcomeSentAt?: string | null
  callbackToken?: string
  /** Written since both markets run every tick; legacy records infer it from `text`. */
  market?: Market
  /**
   * Inline-edit state. `text` stays the base HTML sent with the alert; every
   * edit is rebuilt as text + oddsLine + (VOID line | resultLine), so edits
   * never clobber each other.
   */
  /** Odds line (HTML) once attachOdds found a price; null = window expired, none. */
  oddsLine?: string | null
  oddsAt?: string
  /** GREEN/RED line (HTML), frozen when the outcome was claimed. */
  resultLine?: string | null
  /** Last text Telegram accepted via editMessageText (skip identical edits). */
  lastEditText?: string
  /** Keyboard removed (result or VOID shown). */
  finalized?: boolean
  editedAt?: string
  lastEditError?: string | null
}

const TELEGRAM_EDIT_FIELDS = [
  'oddsLine',
  'oddsAt',
  'resultLine',
  'lastEditText',
  'finalized',
  'editedAt',
  'lastEditError',
] as const satisfies readonly (keyof TelegramMessageRecord)[]

const TELEGRAM_SCOPES: { market: Market; half: CornerHalf }[] = [
  { market: 'goals', half: 'ht' },
  { market: 'goals', half: 'ft' },
  { market: 'corners', half: 'ht' },
  { market: 'corners', half: 'ft' },
]

function capTelegramMap(
  map: Record<string, TelegramMessageRecord>,
): Record<string, TelegramMessageRecord> {
  const entries = Object.entries(map)
  if (entries.length <= TELEGRAM_MAP_CAP) return map
  entries.sort((a, b) => (a[1].sentAt < b[1].sentAt ? -1 : 1))
  return Object.fromEntries(entries.slice(-TELEGRAM_MAP_CAP))
}

export function loadTelegramMessages(): Record<string, TelegramMessageRecord> {
  return readJson<Record<string, TelegramMessageRecord>>(TELEGRAM_MAP_FILE, {})
}

export function saveTelegramMessages(
  map: Record<string, TelegramMessageRecord>,
): void {
  writeJson(TELEGRAM_MAP_FILE, capTelegramMap(map))
}

/** Market of a telegram_messages.json record (explicit, or inferred for legacy rows). */
export function telegramRecordMarket(
  rec: Pick<TelegramMessageRecord, 'market' | 'text'> | null | undefined,
): Market | null {
  if (!rec) return null
  return rec.market ?? marketFromTelegramText(rec.text)
}

/**
 * Storage key of an alert's record. Corners keys are `corners:`-prefixed now;
 * records written before that live under the unprefixed key. Fall back to the
 * legacy key only when that record is itself a corners record, so a goals
 * record with the same fixture/alert id can never be picked up by corners.
 */
function telegramRecordKey(
  map: Record<string, TelegramMessageRecord>,
  alertKey: string,
): string {
  if (map[alertKey]) return alertKey
  const { market, loggedId } = parseAlertKey(alertKey)
  if (market && loggedId !== alertKey) {
    const legacy = map[loggedId]
    if (legacy && telegramRecordMarket(legacy) === market) return loggedId
  }
  return alertKey
}

export function getTelegramMessage(
  alertKey: string,
): TelegramMessageRecord | null {
  const map = loadTelegramMessages()
  return map[telegramRecordKey(map, alertKey)] ?? null
}

export function findAlertKeyByCallbackToken(token: string): string | null {
  if (!token) return null
  const map = loadTelegramMessages()
  if (map[token]) return token
  for (const [key, rec] of Object.entries(map)) {
    if (rec.callbackToken === token) return key
  }
  return null
}

export function upsertTelegramMessage(
  alertKey: string,
  patch: Partial<TelegramMessageRecord>,
): TelegramMessageRecord {
  const map = loadTelegramMessages()
  const key = telegramRecordKey(map, alertKey)
  const stored = map[key]
  const storedMarket = telegramRecordMarket(stored)
  const otherMarket = Boolean(
    stored && patch.market && storedMarket && storedMarket !== patch.market,
  )
  // Never merge into a record of the other market. A legacy (unprefixed)
  // corners record that a new goals alert collides with is kept under its
  // qualified key so its outcome/callback still resolve.
  if (otherMarket && storedMarket === 'corners' && !parseAlertKey(key).market) {
    const qualified = `corners:${key}`
    if (!map[qualified]) map[qualified] = { ...stored!, market: 'corners' }
  }
  const prev = otherMarket ? undefined : stored
  const market = patch.market ?? prev?.market
  // Edit-state fields: an explicit value in the patch (null included) wins.
  const editState: Partial<TelegramMessageRecord> = {}
  for (const field of TELEGRAM_EDIT_FIELDS) {
    const value = patch[field] !== undefined ? patch[field] : prev?.[field]
    if (value !== undefined) (editState as Record<string, unknown>)[field] = value
  }
  const next: TelegramMessageRecord = {
    ...editState,
    messageId: patch.messageId ?? prev?.messageId ?? 0,
    chatId: patch.chatId ?? prev?.chatId ?? '',
    text: patch.text ?? prev?.text ?? '',
    sentAt: patch.sentAt ?? prev?.sentAt ?? new Date().toISOString(),
    outcomeSentAt:
      patch.outcomeSentAt !== undefined
        ? patch.outcomeSentAt
        : (prev?.outcomeSentAt ?? null),
    callbackToken: patch.callbackToken ?? prev?.callbackToken,
    ...(market ? { market } : {}),
  }
  map[key] = next
  saveTelegramMessages(map)
  return next
}

/**
 * Scopes to search for an alert key: an explicit `corners:` prefix pins the
 * market; an unprefixed key is goals (new format) or a legacy key of either
 * market, so the stored Telegram record's market (if any) is tried first and
 * the legacy goals→corners order is kept otherwise.
 */
function scopesForAlertKey(alertKey: string): {
  loggedId: string
  scopes: { market: Market; half: CornerHalf }[]
} {
  const { market, loggedId } = parseAlertKey(alertKey)
  if (market) {
    return { loggedId, scopes: TELEGRAM_SCOPES.filter((s) => s.market === market) }
  }
  const hint = telegramRecordMarket(loadTelegramMessages()[alertKey])
  if (hint === 'corners') {
    return {
      loggedId,
      scopes: [
        ...TELEGRAM_SCOPES.filter((s) => s.market === 'corners'),
        ...TELEGRAM_SCOPES.filter((s) => s.market !== 'corners'),
      ],
    }
  }
  return { loggedId, scopes: TELEGRAM_SCOPES }
}

export function findLoggedAlert(
  alertKey: string,
): { alert: LoggedAlert; market: Market; half: CornerHalf } | null {
  const { loggedId, scopes } = scopesForAlertKey(alertKey)
  for (const { market, half } of scopes) {
    const alert = loadAlerts(market, half).find((a) => a.id === loggedId)
    if (alert) return { alert, market, half }
  }
  return null
}

export function patchLoggedAlert(
  alertKey: string,
  patch: Partial<LoggedAlert>,
): LoggedAlert | null {
  const found = findLoggedAlert(alertKey)
  if (!found) return null
  const alerts = loadAlerts(found.market, found.half)
  const idx = alerts.findIndex((a) => a.id === found.alert.id)
  if (idx < 0) return null
  alerts[idx] = { ...alerts[idx], ...patch }
  saveAlerts(alerts, found.market, found.half)
  return alerts[idx]
}

export function markAlertTelegramMessage(
  alertId: string,
  messageId: number,
  market?: Market,
  half?: CornerHalf | null,
  extra: Partial<LoggedAlert> = {},
): boolean {
  const patch: Partial<LoggedAlert> = { ...extra, telegramMessageId: messageId }
  if (market && parseCornerHalfOpt(half)) {
    const alerts = loadAlerts(market, half)
    const loggedId = parseAlertKey(alertId).loggedId
    const idx = alerts.findIndex((a) => a.id === loggedId)
    if (idx < 0) return false
    alerts[idx] = { ...alerts[idx], ...patch }
    saveAlerts(alerts, market, half)
    return true
  }
  return patchLoggedAlert(alertId, patch) !== null
}

export function telegramOutcomeAlreadySent(alertKey: string): boolean {
  const rec = getTelegramMessage(alertKey)
  if (rec?.outcomeSentAt) return true
  return Boolean(findLoggedAlert(alertKey)?.alert.telegramOutcomeSentAt)
}

/** Claim the outcome slot so two flushes cannot double-send. */
export function claimTelegramOutcome(alertKey: string): boolean {
  if (telegramOutcomeAlreadySent(alertKey)) return false
  const at = new Date().toISOString()
  upsertTelegramMessage(alertKey, { outcomeSentAt: at })
  patchLoggedAlert(alertKey, { telegramOutcomeSentAt: at })
  return true
}

export function clearTelegramOutcomeClaim(alertKey: string): void {
  upsertTelegramMessage(alertKey, { outcomeSentAt: null })
  patchLoggedAlert(alertKey, { telegramOutcomeSentAt: null })
}

export function primeFixture(id: string): boolean {
  const primed = loadPrimed()
  if (primed.includes(id)) return false
  primed.push(id)
  savePrimed(primed)
  return true
}

export function isPrimed(id: string): boolean {
  return loadPrimed().includes(id)
}

export type { Fixture, MomentumPayload }
