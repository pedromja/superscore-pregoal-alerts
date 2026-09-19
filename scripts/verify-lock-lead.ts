/**
 * Lead-time floor, stoppage 96', lock (apply / put params / Settings save),
 * and window helpers after the 18/set backtest.
 */
import {
  isPreferredLead,
  isUsableLead,
  MIN_LEAD_MIN,
  outcomeForAlert,
  PREFERRED_LEAD_MAX,
} from '../src/lib/horizons.ts'
import { MIN_NOTIFY_LEAD_MIN } from '../src/lib/notifyLead.ts'
import {
  DEFINITIONS_LOCKED,
  LOCK_APPLY_ERROR_PT,
  LOCK_SAVE_ERROR_PT,
  LOCK_WARNING_PT,
} from '../src/lib/lock.ts'
import { defaultsFor } from '../src/lib/market.ts'
import { evaluateAlerts } from '../src/lib/rules.ts'
import { loadSettings, saveSettings } from '../src/lib/settings.ts'
import type { GoalEvent, MomentumPayload, TimelinePoint } from '../src/lib/types.ts'
import {
  GOAL_WINDOWS,
  REGULATION_END,
  goalHalfOf,
  inGoalsWindow,
  inMarketClockWindow,
  isStoppageClock,
} from '../src/lib/windows.ts'
import { applyProposal, currentSettings, putParams } from '../server/learn.ts'
import { loadParams, saveParams } from '../server/store.ts'

const fails: string[] = []

function expect(cond: boolean, message: string) {
  if (!cond) fails.push(message)
}

function mockLocalStorage() {
  const mem = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, String(value))
      },
      removeItem: (key: string) => {
        mem.delete(key)
      },
      clear: () => mem.clear(),
    },
  })
}

function spikeAt(min: number, period: number): MomentumPayload {
  const prev = Math.max(0, min - 1)
  return {
    timeline: [
      { min: prev, period, value: { value: 0 } },
      { min, period, value: { value: 95 } },
    ],
    events: [],
  }
}

const points: TimelinePoint[] = [
  {
    index: 0,
    min: 80,
    period: 2,
    value: 90,
    delta1: 90,
    absValue: 90,
    absDelta1: 90,
    side: 'home',
    sustainedLength: 1,
  },
  {
    index: 1,
    min: 81,
    period: 2,
    value: 40,
    delta1: -50,
    absValue: 40,
    absDelta1: 50,
    side: 'home',
    sustainedLength: 0,
  },
]

const laterGoal: GoalEvent[] = [{ min: 81, period: 2, side: 'home', index: 1 }]
const sameMinuteGoal: GoalEvent[] = [{ min: 80, period: 2, side: 'home', index: 0 }]

expect(MIN_LEAD_MIN === 1, 'MIN_LEAD_MIN is 1')
expect(MIN_NOTIFY_LEAD_MIN === MIN_LEAD_MIN, 'live notify floor matches MIN_LEAD_MIN')
expect(PREFERRED_LEAD_MAX === 2, 'PREFERRED_LEAD_MAX is 2')
expect(!isUsableLead(0), 'lead 0 is not usable')
expect(!isUsableLead(null), 'null lead is not usable')
expect(!isUsableLead(-1), 'negative lead is not usable')
expect(isUsableLead(1), 'lead 1 is usable')
expect(isPreferredLead(1), 'lead 1 is preferred')
expect(isPreferredLead(2), 'lead 2 is preferred')
expect(!isPreferredLead(3), 'lead 3 is outside preferred band')

const hit1 = outcomeForAlert(
  { min: 80, period: 2, side: 'home' },
  laterGoal,
  points,
  { minLead: MIN_LEAD_MIN, deadlineCap: GOAL_WINDOWS.ft.to },
)
expect(hit1.leadTime5 === 1, `lead 1 counted, got ${hit1.leadTime5}`)
expect(hit1.hit5 === true, 'lead 1 is a short hit')

const sameMin = outcomeForAlert(
  { min: 80, period: 2, side: 'home' },
  sameMinuteGoal,
  points,
  { minLead: MIN_LEAD_MIN },
)
expect(sameMin.leadTime5 === null, 'same-minute goal is not a lead')
expect(sameMin.hit5 === false, 'same-minute goal is not a hit')

const coincident = outcomeForAlert(
  { min: 80, period: 2, side: 'home', coincident: true },
  laterGoal,
  points,
)
expect(coincident.leadTime5 === 0, 'coincident leadTime is 0')
expect(coincident.hit5 === false, 'coincident is not credited')
expect(!isUsableLead(coincident.leadTime5), 'coincident 0-lead rejected in metrics')

const postEvent = outcomeForAlert(
  { min: 81, period: 2, side: 'home' },
  sameMinuteGoal,
  points,
)
expect(postEvent.hit5 === false, 'post-event alert is not a hit')
expect(postEvent.leadTime5 === null, 'post-event has no lead')

expect(isStoppageClock(96, 2), "96' P2 is stoppage")
expect(isStoppageClock(91, 2), "91' P2 is stoppage")
expect(isStoppageClock(46, 1), "46' P1 is stoppage")
expect(!inGoalsWindow(96, 2), "96' outside goals window")
expect(!inMarketClockWindow('goals', 96, 2), "96' goals clock rejected")
expect(!inMarketClockWindow('corners', 96, 2), "96' corners clock rejected")
expect(!inMarketClockWindow('goals', 91, 2), "91' goals clock rejected")
expect(!inMarketClockWindow('corners', 91, 2), "91' corners clock rejected")
expect(goalHalfOf(96, 2) === null, "96' has no goal half")
expect(
  evaluateAlerts(spikeAt(96, 2), defaultsFor('goals', 'ft')).alerts.length === 0,
  "evaluateAlerts rejects 96' (Yeovil failure: goal already in, markets gone)",
)
expect(
  evaluateAlerts(spikeAt(91, 2), defaultsFor('goals', 'ft')).alerts.length === 0,
  "evaluateAlerts rejects 91' — FT does not extend past 90",
)
expect(
  evaluateAlerts(spikeAt(90, 2), defaultsFor('goals', 'ft')).alerts.length > 0,
  "evaluateAlerts allows 90' FT goals",
)
expect(GOAL_WINDOWS.ft.to === REGULATION_END[2], 'FT goals to === 90')
expect(GOAL_WINDOWS.ft.to <= 90, 'FT goals window never extends past 90')

expect(DEFINITIONS_LOCKED, 'DEFINITIONS_LOCKED is on after adopt')
expect(/Pedro/i.test(LOCK_WARNING_PT), 'lock warning addresses Pedro')
expect(/1 minuto/i.test(LOCK_WARNING_PT), 'lock warning mentions 1 minute lead')
expect(/mercados/i.test(LOCK_WARNING_PT), 'lock warning mentions markets gone')
expect(/Yeovil/i.test(LOCK_WARNING_PT), 'lock warning cites Yeovil 96\'')

let applyBlocked = false
try {
  applyProposal('latest', 'manual', 'goals', 'ht', { confirm: true })
} catch (err) {
  applyBlocked =
    err instanceof Error && err.message === LOCK_APPLY_ERROR_PT
}
expect(applyBlocked, 'apply without unlock is blocked')

const prevHt = loadParams('goals', 'ht')
const prevFt = loadParams('goals', 'ft')
try {
  let putBlocked = false
  try {
    putParams(
      { ...defaultsFor('goals', 'ht'), spikeThreshold: 99 },
      { confirm: true },
    )
  } catch (err) {
    putBlocked = err instanceof Error && err.message === LOCK_SAVE_ERROR_PT
  }
  expect(putBlocked, 'PUT params without unlock is blocked')

  const afterDenied = currentSettings('goals', 'ht')
  expect(
    afterDenied.spikeThreshold === defaultsFor('goals', 'ht').spikeThreshold,
    'denied PUT does not change live settings',
  )

  const liveAfterUnlockWrite = putParams(
    { ...defaultsFor('goals', 'ht'), spikeThreshold: 99 },
    { confirm: true, unlock: true },
  )
  expect(
    liveAfterUnlockWrite.spikeThreshold ===
      defaultsFor('goals', 'ht').spikeThreshold,
    'unlock PUT writes disk but live currentSettings stays on locked defaults',
  )
  const stored = loadParams('goals', 'ht')
  expect(
    stored?.spikeThreshold === 99,
    'unlock PUT records params on disk for audit',
  )
} finally {
  if (prevHt) saveParams(prevHt, 'goals', 'ht')
  else saveParams(defaultsFor('goals', 'ht'), 'goals', 'ht')
  if (prevFt) saveParams(prevFt, 'goals', 'ft')
}

mockLocalStorage()
saveSettings({
  ...defaultsFor('goals', 'ht'),
  spikeThreshold: 99,
  notificationsEnabled: false,
})
const loaded = loadSettings('goals', 'ht')
expect(
  loaded.spikeThreshold === defaultsFor('goals', 'ht').spikeThreshold,
  'Settings save while locked ignores threshold edits',
)
expect(
  loaded.notificationsEnabled === false,
  'Settings save while locked still persists notify flags',
)

expect(defaultsFor('goals', 'ht').sustainedFallbackMinutes === 5, 'goals HT reserva 5 min')
expect(defaultsFor('goals', 'ft').sustainedFallbackMinutes === 5, 'goals FT reserva 5 min')
expect(defaultsFor('corners', 'ht').sustainedSecondaryThreshold === 20, 'corners HT sust sec 20')
expect(defaultsFor('corners', 'ft').sustainedSecondaryThreshold === 20, 'corners FT sust sec 20')
expect(GOAL_WINDOWS.ht.from === 20 && GOAL_WINDOWS.ht.to === 42, 'goals HT window 20–42')
expect(GOAL_WINDOWS.ft.from === 70 && GOAL_WINDOWS.ft.to === 90, 'goals FT window 70–90')

if (fails.length) {
  console.error('\nFAIL', fails)
  process.exit(1)
}
console.log(
  'OK: lead<1 rejected, 96\' banned, lock blocks apply/manual save, windows locked',
)
