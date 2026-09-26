import {
  HORIZON_LONG_CAP,
  horizonOptionsForMarket,
  outcomeForAlert,
  type HorizonOutcome,
} from '../src/lib/horizons.ts'
import { parseMarket } from '../src/lib/market.ts'
import { extractMarketEvents, normalizeTimeline } from '../src/lib/rules.ts'
import type { MomentumPayload } from '../src/lib/types.ts'
import { parseCornerHalf } from '../src/lib/windows.ts'
import { currentSettings } from './learn.ts'
import { fetchMomentumServer } from './ss.ts'
import {
  findLoggedAlert,
  getTelegramMessage,
  loadMatch,
  patchLoggedAlert,
  saveMatch,
  telegramOutcomeAlreadySent,
} from './store.ts'
import {
  ALREADY_RESOLVED_TEXT,
  answerTelegramCallback,
  formatTelegramOutcomeHtml,
  isAllowedTelegramChat,
  parseResolveCallbackData,
  PENDING_RESOLVE_TEXT,
  sendTelegramText,
} from './telegram.ts'
import {
  enqueueTelegramOutcome,
  scheduleTelegramOutcomeFlush,
} from './telegramOutcomes.ts'
import type { LoggedAlert } from './types.ts'
import { VOID_LINE_TEXT } from './telegramCompose.ts'
import { inlineEditsActive, telegramRecordEditable } from './telegramEdits.ts'
import { loggedAlertKey } from './alertKeys.ts'

export type ResolveNowKind = 'green' | 'red' | 'pending' | 'missing' | 'already' | 'void'

export type ResolveNowDecision = {
  kind: Exclude<ResolveNowKind, 'missing' | 'already' | 'void'>
  outcome: HorizonOutcome
}

type FetchMomentumFn = typeof fetchMomentumServer
let fetchMomentum: FetchMomentumFn = fetchMomentumServer

export function setResolveFetchMomentumForTests(
  fn: FetchMomentumFn | null,
): void {
  fetchMomentum = fn ?? fetchMomentumServer
}

function periodCap(period: number): number {
  return period <= 1 ? 45 : 90
}

/** Clock must pass this minute before a no-event is a real miss (no false RED). */
export function settleDeadlineMin(
  alertMin: number,
  period: number,
  deadlineCap?: number,
): number {
  const cap = deadlineCap ?? periodCap(period)
  return Math.min(alertMin + HORIZON_LONG_CAP, cap)
}

export function decideResolveNow(
  outcome: HorizonOutcome,
  clock: { min: number; period: number } | null,
  finished: boolean,
  alert: { min: number; period: number },
  deadlineCap?: number,
): ResolveNowDecision['kind'] {
  if (outcome.hit5 === true || outcome.hitLong === true) return 'green'
  if (finished) return 'red'
  if (!clock) return 'pending'
  if (clock.period > alert.period) return 'red'
  if (clock.period < alert.period) return 'pending'
  const deadline = settleDeadlineMin(alert.min, alert.period, deadlineCap)
  if (clock.min > deadline) return 'red'
  return 'pending'
}

export function evaluatePayloadForAlert(
  alert: LoggedAlert,
  payload: MomentumPayload,
  finished: boolean,
): ResolveNowDecision {
  const market = parseMarket(alert.market)
  const half = parseCornerHalf(alert.cornerHalf)
  const settings = currentSettings(market, half)
  const points = normalizeTimeline(payload, settings.sustainedThreshold)
  const events = extractMarketEvents(payload, points, market, half)
  const horizon = horizonOptionsForMarket(market, half)
  const outcome = outcomeForAlert(
    {
      min: alert.minute,
      period: alert.period,
      side: alert.side,
      coincident: alert.coincident,
    },
    events,
    points,
    horizon,
  )
  const clock = points.at(-1) ?? null
  const kind = decideResolveNow(
    outcome,
    clock,
    finished,
    { min: alert.minute, period: alert.period },
    horizon.deadlineCap,
  )
  return { kind, outcome }
}

async function loadLivePayload(
  fixtureId: string,
): Promise<{ payload: MomentumPayload; finished: boolean } | null> {
  const stored = loadMatch(fixtureId)
  try {
    const payload = await fetchMomentum(fixtureId)
    if (stored) {
      saveMatch({
        ...stored,
        payload,
        updatedAt: new Date().toISOString(),
      })
    }
    return { payload, finished: stored?.finished ?? false }
  } catch {
    if (!stored) return null
    return { payload: stored.payload, finished: stored.finished }
  }
}

function persistResolvedLabels(
  alert: LoggedAlert,
  outcome: HorizonOutcome,
): LoggedAlert {
  const hit5 = outcome.hit5
  const hitLong = outcome.hitLong
  const next = patchLoggedAlert(loggedAlertKey(alert), {
    hit: hit5,
    hit5,
    hitLong,
    longDeadline: outcome.longDeadline,
    leadTime5: outcome.leadTime5,
    leadTimeLong: outcome.leadTimeLong,
    leadMin: outcome.leadTime5,
    labeledAt: new Date().toISOString(),
  })
  return next ?? { ...alert, hit: hit5, hit5, hitLong }
}

export async function resolveAlertNow(alertKey: string): Promise<{
  kind: ResolveNowKind
  alert: LoggedAlert | null
  text: string
}> {
  const found = findLoggedAlert(alertKey)
  if (!found) return { kind: 'missing', alert: null, text: PENDING_RESOLVE_TEXT }
  if (found.alert.void) {
    return { kind: 'void', alert: found.alert, text: VOID_LINE_TEXT }
  }
  if (telegramOutcomeAlreadySent(alertKey)) {
    return {
      kind: 'already',
      alert: found.alert,
      text: ALREADY_RESOLVED_TEXT,
    }
  }

  const live = await loadLivePayload(found.alert.fixtureId)
  if (!live) {
    return { kind: 'pending', alert: found.alert, text: PENDING_RESOLVE_TEXT }
  }

  const decision = evaluatePayloadForAlert(
    found.alert,
    live.payload,
    live.finished,
  )
  if (decision.kind === 'pending') {
    return { kind: 'pending', alert: found.alert, text: PENDING_RESOLVE_TEXT }
  }

  const labeled = persistResolvedLabels(found.alert, decision.outcome)
  enqueueTelegramOutcome(loggedAlertKey(labeled))
  scheduleTelegramOutcomeFlush()
  return {
    kind: decision.kind,
    alert: labeled,
    text: formatTelegramOutcomeHtml(labeled),
  }
}

type TelegramCallbackQuery = {
  id?: string
  data?: string
  message?: {
    message_id?: number
    chat?: { id?: number | string }
  }
}

/** Toast shown when "Resolver agora" is pressed (answerCallbackQuery). */
export function resolveToastText(kind: ResolveNowKind): string {
  switch (kind) {
    case 'green':
      return 'Resolvido: GREEN'
    case 'red':
      return 'Resolvido: RED'
    case 'already':
      return ALREADY_RESOLVED_TEXT
    case 'void':
      return VOID_LINE_TEXT
    default:
      return PENDING_RESOLVE_TEXT
  }
}

/** Telegram expects an answer within seconds; slower resolutions answer early. */
const CALLBACK_ANSWER_MS = 8_000
let callbackAnswerMs = CALLBACK_ANSWER_MS

export function setCallbackAnswerMsForTests(ms: number | null): void {
  callbackAnswerMs = ms ?? CALLBACK_ANSWER_MS
}

export async function handleCallbackQuery(
  query: TelegramCallbackQuery,
): Promise<{ kind: ResolveNowKind | 'ignored'; alertKey?: string }> {
  const chatId = query.message?.chat?.id
  if (!isAllowedTelegramChat(chatId)) {
    return { kind: 'ignored' }
  }
  const alertKey = parseResolveCallbackData(String(query.data || ''))
  if (!alertKey) {
    if (query.id) void answerTelegramCallback(query.id)
    return { kind: 'ignored' }
  }

  const inline = inlineEditsActive() && telegramRecordEditable(getTelegramMessage(alertKey))
  if (!inline && query.id) {
    // Legacy flow (no editable message / inline edits off): unchanged.
    void answerTelegramCallback(query.id, 'A verificar…')
  }

  // Inline flow: one toast with the outcome (answered early if slow).
  let answered = !inline
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = resolveAlertNow(alertKey)
  if (inline && query.id) {
    timer = setTimeout(() => {
      if (answered) return
      answered = true
      void answerTelegramCallback(query.id!, 'A verificar…')
    }, callbackAnswerMs)
  }
  let result: Awaited<ReturnType<typeof resolveAlertNow>>
  try {
    result = await work
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!answered && query.id) {
    answered = true
    void answerTelegramCallback(query.id, resolveToastText(result.kind))
  }

  if (result.kind === 'already' || result.kind === 'void') {
    return { kind: result.kind, alertKey }
  }
  if (result.kind === 'pending' || result.kind === 'missing') {
    // Too early: inline flow keeps it as a toast only (no edit, no message).
    if (!inline) {
      const rec = getTelegramMessage(alertKey)
      const replyTo =
        query.message?.message_id ??
        (rec?.messageId && rec.messageId > 0 ? rec.messageId : undefined)
      await sendTelegramText({
        alertKey,
        text: PENDING_RESOLVE_TEXT,
        replyToMessageId: replyTo,
      })
    }
    return { kind: result.kind, alertKey }
  }
  // GREEN/RED: the outcome flush edits the alert (or replies for legacy alerts).
  return { kind: result.kind, alertKey }
}

export function handleTelegramUpdate(update: unknown): Promise<void> {
  const body =
    update && typeof update === 'object'
      ? (update as { callback_query?: TelegramCallbackQuery })
      : {}
  if (!body.callback_query) return Promise.resolve()
  return handleCallbackQuery(body.callback_query).then(() => undefined)
}
