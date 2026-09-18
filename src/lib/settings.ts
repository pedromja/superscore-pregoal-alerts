import { defaultsFor, parseMarket } from './market'
import type { AlertSettings, CornerHalf, CornersByHalf, Market } from './types'
import { parseCornerHalf } from './windows'

const MARKET_KEY = 'superscore.pregoal.market.v1'
const SETTINGS_KEYS: Record<Market, string> = {
  goals: 'superscore.pregoal.settings.v1',
  corners: 'superscore.pregoal.settings.corners.v1',
}
const CORNER_SETTINGS_KEYS: Record<CornerHalf, string> = {
  ht: 'superscore.pregoal.settings.corners.ht.v1',
  ft: 'superscore.pregoal.settings.corners.ft.v1',
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
  if (m === 'corners') {
    const h = parseCornerHalf(half ?? 'ht')
    const defaults = defaultsFor('corners', h)
    const parsed =
      readJson<Partial<AlertSettings>>(CORNER_SETTINGS_KEYS[h]) ??
      (h === 'ht' ? readJson<Partial<AlertSettings>>(SETTINGS_KEYS.corners) : null)
    return { ...defaults, ...parsed, market: 'corners', cornerHalf: h }
  }
  const defaults = defaultsFor('goals')
  const parsed = readJson<Partial<AlertSettings>>(SETTINGS_KEYS.goals)
  return { ...defaults, ...parsed, market: 'goals' }
}

export function saveSettings(settings: AlertSettings): void {
  const market = parseMarket(settings.market)
  if (market === 'corners') {
    const half = parseCornerHalf(settings.cornerHalf)
    const next = { ...settings, market, cornerHalf: half }
    localStorage.setItem(CORNER_SETTINGS_KEYS[half], JSON.stringify(next))
    saveMarket('corners')
    return
  }
  const next = { ...settings, market: 'goals' as const }
  localStorage.setItem(SETTINGS_KEYS.goals, JSON.stringify(next))
  saveMarket('goals')
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
