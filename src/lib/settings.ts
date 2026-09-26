import { defaultsFor, parseMarket } from './market'
import { DEFINITIONS_LOCKED } from './lock'
import type { AlertSettings, CornerHalf, CornersByHalf, Market } from './types'
import { parseCornerHalf } from './windows'

const MARKET_KEY = 'superscore.pregoal.market.v1'
const SETTINGS_KEYS: Record<Market, string> = {
  goals: 'superscore.pregoal.settings.v1',
  corners: 'superscore.pregoal.settings.corners.v1',
}
const HALF_SETTINGS_KEYS: Record<Market, Record<CornerHalf, string>> = {
  goals: {
    ht: 'superscore.pregoal.settings.goals.ht.v1',
    ft: 'superscore.pregoal.settings.goals.ft.v1',
  },
  corners: {
    ht: 'superscore.pregoal.settings.corners.ht.v1',
    ft: 'superscore.pregoal.settings.corners.ft.v1',
  },
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function notifyFrom(
  parsed: Partial<AlertSettings> | null,
  defaults: AlertSettings,
): Pick<
  AlertSettings,
  | 'notificationsEnabled'
  | 'notifyPrimary'
  | 'notifySecondary'
  | 'notifyFallback'
> {
  return {
    notificationsEnabled:
      parsed?.notificationsEnabled ?? defaults.notificationsEnabled,
    notifyPrimary: parsed?.notifyPrimary ?? defaults.notifyPrimary,
    notifySecondary: parsed?.notifySecondary ?? defaults.notifySecondary,
    notifyFallback: parsed?.notifyFallback ?? defaults.notifyFallback,
  }
}

export function loadMarket(): Market {
  try {
    return parseMarket(localStorage.getItem(MARKET_KEY))
  } catch {
    return 'goals'
  }
}

export function saveMarket(market: Market): void {
  localStorage.setItem(MARKET_KEY, parseMarket(market))
}

export function loadSettings(market?: Market, half?: CornerHalf): AlertSettings {
  const m = parseMarket(market ?? loadMarket())
  const h = parseCornerHalf(half ?? 'ht')
  const defaults = defaultsFor(m, h)
  const parsed =
    readJson<Partial<AlertSettings>>(HALF_SETTINGS_KEYS[m][h]) ??
    (m === 'corners' && h === 'ht'
      ? readJson<Partial<AlertSettings>>(SETTINGS_KEYS.corners)
      : m === 'goals'
        ? readJson<Partial<AlertSettings>>(SETTINGS_KEYS.goals)
        : null)
  const notify = notifyFrom(parsed, defaults)
  if (DEFINITIONS_LOCKED) {
    return { ...defaults, ...notify, market: m, cornerHalf: h }
  }
  return { ...defaults, ...parsed, ...notify, market: m, cornerHalf: h }
}

export function saveSettings(settings: AlertSettings): void {
  const market = parseMarket(settings.market)
  const half = parseCornerHalf(settings.cornerHalf)
  const next = { ...settings, market, cornerHalf: half }
  if (DEFINITIONS_LOCKED) {
    const current = loadSettings(market, half)
    const locked = {
      ...current,
      notificationsEnabled: next.notificationsEnabled,
      notifyPrimary: next.notifyPrimary,
      notifySecondary: next.notifySecondary,
      notifyFallback: next.notifyFallback,
    }
    localStorage.setItem(HALF_SETTINGS_KEYS[market][half], JSON.stringify(locked))
    saveMarket(market)
    return
  }
  localStorage.setItem(HALF_SETTINGS_KEYS[market][half], JSON.stringify(next))
  saveMarket(market)
}

export function loadCornersByHalf(): CornersByHalf {
  return {
    ht: loadSettings('corners', 'ht'),
    ft: loadSettings('corners', 'ft'),
  }
}

export function saveCornersByHalf(bundle: CornersByHalf): void {
  saveSettings({ ...bundle.ht, market: 'corners', cornerHalf: 'ht' })
  saveSettings({ ...bundle.ft, market: 'corners', cornerHalf: 'ft' })
}

export function loadGoalsByHalf(): CornersByHalf {
  return {
    ht: loadSettings('goals', 'ht'),
    ft: loadSettings('goals', 'ft'),
  }
}

export function saveGoalsByHalf(bundle: CornersByHalf): void {
  saveSettings({ ...bundle.ht, market: 'goals', cornerHalf: 'ht' })
  saveSettings({ ...bundle.ft, market: 'goals', cornerHalf: 'ft' })
}

export function loadHalves(market: Market): CornersByHalf {
  return market === 'corners' ? loadCornersByHalf() : loadGoalsByHalf()
}
