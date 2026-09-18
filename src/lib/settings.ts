import { DEFAULT_SETTINGS } from './rules'
import type { AlertSettings } from './types'

const KEY = 'superscore.pregoal.settings.v1'

export function loadSettings(): AlertSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AlertSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: AlertSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings))
}
