import { defaultsFor, parseMarket } from './market'
import type { AlertSettings, Market } from './types'

const MARKET_KEY = 'superscore.pregoal.market.v1'
const SETTINGS_KEYS: Record<Market, string> = {
  goals: 'superscore.pregoal.settings.v1',
  corners: 'superscore.pregoal.settings.corners.v1',
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

export function loadSettings(market?: Market): AlertSettings {
  const m = parseMarket(market ?? loadMarket())
  const defaults = defaultsFor(m)
  try {
    const raw = localStorage.getItem(SETTINGS_KEYS[m])
    if (!raw) return { ...defaults }
    const parsed = JSON.parse(raw) as Partial<AlertSettings>
    return { ...defaults, ...parsed, market: m }
  } catch {
    return { ...defaults }
  }
}

export function saveSettings(settings: AlertSettings): void {
  const market = parseMarket(settings.market)
  const next = { ...settings, market }
  localStorage.setItem(SETTINGS_KEYS[market], JSON.stringify(next))
  saveMarket(market)
}
