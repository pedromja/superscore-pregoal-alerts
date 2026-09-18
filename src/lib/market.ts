import type { AlertSettings, Market, RuleId } from './types'

export const MARKETS: Market[] = ['goals', 'corners']

export const MARKET_EVENT_TYPE: Record<Market, number> = {
  goals: 4,
  corners: 14,
}

export const MARKET_COPY = {
  goals: {
    toggle: 'Golos',
    noun: 'golo',
    nounPlural: 'golos',
    nounCap: 'Golo',
    title: 'Alertas pré-golo',
    blurb:
      'Momentum de ataque assinado (−100 fora / +100 casa). As regras disparam antes do golo — um spike no minuto do golo é coincidente, não um acerto.',
    pushPrefix: 'Golos',
    pushTag: 'pregoal',
  },
  corners: {
    toggle: 'Cantos',
    noun: 'canto',
    nounPlural: 'cantos',
    nounCap: 'Canto',
    title: 'Alertas pré-canto',
    blurb:
      'Momentum de ataque assinado (−100 fora / +100 casa). As regras disparam antes do canto — um spike no minuto do canto é coincidente, não um acerto.',
    pushPrefix: 'Cantos',
    pushTag: 'precantos',
  },
} as const

const SHARED_FLAGS = {
  enablePrimary: true,
  enableSecondary: true,
  enableFallback: true,
  evaluationWindow: 5,
  notificationsEnabled: true,
  notifyPrimary: true,
  notifySecondary: false,
  notifyFallback: false,
} as const

const GOAL_THRESHOLDS = {
  spikeThreshold: 80,
  swingComboThreshold: 50,
  swingSecondaryThreshold: 60,
  sustainedThreshold: 30,
  sustainedComboMinutes: 3,
  sustainedFallbackMinutes: 4,
  fallbackSpikeThreshold: 80,
  sustainedSecondaryThreshold: 30,
  sustainedSecondaryMinutes: 5,
} as const

const CORNER_THRESHOLDS = {
  spikeThreshold: 60,
  swingComboThreshold: 40,
  swingSecondaryThreshold: 60,
  sustainedThreshold: 25,
  sustainedComboMinutes: 3,
  sustainedFallbackMinutes: 5,
  fallbackSpikeThreshold: 70,
  sustainedSecondaryThreshold: 20,
  sustainedSecondaryMinutes: 5,
} as const

export function isMarket(value: unknown): value is Market {
  return value === 'goals' || value === 'corners'
}

export function parseMarket(value: unknown, fallback: Market = 'goals'): Market {
  return isMarket(value) ? value : fallback
}

export function defaultsFor(market: Market = 'goals'): AlertSettings {
  const thresholds = market === 'corners' ? CORNER_THRESHOLDS : GOAL_THRESHOLDS
  return {
    market,
    ...thresholds,
    ...SHARED_FLAGS,
  }
}

export function eventTypeFor(market: Market): number {
  return MARKET_EVENT_TYPE[market]
}

export function marketCopy(market: Market = 'goals') {
  return MARKET_COPY[parseMarket(market)]
}

export function ruleLabels(settings: Pick<AlertSettings, 'market'> & Partial<AlertSettings>): Record<RuleId, string> {
  const s = { ...defaultsFor(parseMarket(settings.market)), ...settings }
  if (s.market === 'corners') {
    return {
      primary: `Primária · Spike${s.spikeThreshold} ∧ (Swing${s.swingComboThreshold} ∨ Sustained${s.sustainedComboMinutes}@${s.sustainedThreshold})`,
      secondary: `Secundária · Sustained |v|≥${s.sustainedSecondaryThreshold} ×${s.sustainedSecondaryMinutes}`,
      fallback: `Reserva · Spike${s.fallbackSpikeThreshold} ∧ (Swing${s.swingComboThreshold} ∨ Sustained${s.sustainedComboMinutes}@${s.sustainedThreshold})`,
    }
  }
  return {
    primary: `Primária · Spike${s.spikeThreshold} ∧ (Swing${s.swingComboThreshold} ∨ Sustained${s.sustainedComboMinutes})`,
    secondary: `Secundária · Swing |Δ1|≥${s.swingSecondaryThreshold}`,
    fallback: `Reserva · Sustained |v|≥${s.sustainedThreshold} ×${s.sustainedFallbackMinutes}`,
  }
}

export function ruleDetails(settings: AlertSettings): Record<RuleId, string> {
  const labels = ruleLabels(settings)
  return {
    primary: labels.primary.replace(/^Primária · /, ''),
    secondary: labels.secondary.replace(/^Secundária · /, ''),
    fallback: labels.fallback.replace(/^Reserva · /, ''),
  }
}

export function pushTagFor(market: Market, key: string): string {
  return `${marketCopy(market).pushTag}:${key}`
}
