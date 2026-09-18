import type {
  AlertSettings,
  CornerHalf,
  CornersByHalf,
  Market,
  RuleId,
  RuleKind,
} from './types'
import { CORNER_WINDOWS, GOAL_WINDOWS, parseCornerHalf } from './windows'

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
      `Momentum de ataque assinado (−100 fora / +100 casa). Golos só alertam na 1.ª parte aos ${GOAL_WINDOWS.ht.from}–${GOAL_WINDOWS.ht.to} e na 2.ª aos ${GOAL_WINDOWS.ft.from}–${GOAL_WINDOWS.ft.to} (relógio absoluto). Prolongamento (P1>45 / P2>90) está banido. Um spike no minuto do golo é coincidente, não um acerto.`,
    pushPrefix: 'Golo',
    pushTag: 'pregoal',
  },
  corners: {
    toggle: 'Cantos',
    noun: 'canto',
    nounPlural: 'cantos',
    nounCap: 'Canto',
    title: 'Alertas pré-canto',
    blurb:
      `Momentum de ataque assinado (−100 fora / +100 casa). Cantos só alertam na 1.ª parte aos ${CORNER_WINDOWS.ht.from}–${CORNER_WINDOWS.ht.to} e na 2.ª aos ${CORNER_WINDOWS.ft.from}–${CORNER_WINDOWS.ft.to} (relógio absoluto). Prolongamento (P1>45 / P2>90) está banido. Fora destas janelas não há avaliação, push nem aprendizagem. O minuto ao vivo escolhe os parâmetros HT ou FT.`,
    pushPrefix: 'Canto',
    pushTag: 'precantos',
  },
} as const

const SHARED_FLAGS = {
  enablePrimary: true,
  enableSecondary: true,
  enableFallback: true,
  notificationsEnabled: true,
  notifyPrimary: true,
  notifySecondary: false,
  notifyFallback: false,
} as const

/** HT 20–42 — backtest lead≥1, 18/set/2026 (880 jogos SuperScore ro). Locked. */
export const GOAL_HT_THRESHOLDS = {
  primaryKind: 'combo' as const,
  secondaryKind: 'swing' as const,
  fallbackKind: 'sustainedFallback' as const,
  spikeThreshold: 80,
  swingComboThreshold: 50,
  swingSecondaryThreshold: 60,
  sustainedThreshold: 30,
  sustainedComboMinutes: 3,
  sustainedFallbackMinutes: 5,
  fallbackSpikeThreshold: 80,
  fallbackSustainedThreshold: 30,
  sustainedSecondaryThreshold: 30,
  sustainedSecondaryMinutes: 5,
  evaluationWindow: 5,
}

/** FT 70–90 — mesmo combo; reserva Sustained 5@30 (med lead 2). Locked. */
export const GOAL_FT_THRESHOLDS = {
  ...GOAL_HT_THRESHOLDS,
}

/** HT 32–42, W=5 — backtest 18/set (Sust sec. 2@20). Locked. */
export const CORNER_HT_THRESHOLDS = {
  primaryKind: 'sustained' as const,
  secondaryKind: 'combo' as const,
  fallbackKind: 'sustainedFallback' as const,
  spikeThreshold: 60,
  swingComboThreshold: 40,
  swingSecondaryThreshold: 60,
  sustainedThreshold: 25,
  sustainedComboMinutes: 3,
  sustainedFallbackMinutes: 4,
  fallbackSpikeThreshold: 70,
  fallbackSustainedThreshold: 30,
  sustainedSecondaryThreshold: 20,
  sustainedSecondaryMinutes: 2,
  evaluationWindow: CORNER_WINDOWS.ht.shortHorizon,
}

/** FT 82–87, W=3 — backtest 18/set (Sust sec. 2@20). Locked. */
export const CORNER_FT_THRESHOLDS = {
  primaryKind: 'combo' as const,
  secondaryKind: 'sustained' as const,
  fallbackKind: 'spike' as const,
  spikeThreshold: 80,
  swingComboThreshold: 50,
  swingSecondaryThreshold: 60,
  sustainedThreshold: 30,
  sustainedComboMinutes: 3,
  sustainedFallbackMinutes: 4,
  fallbackSpikeThreshold: 85,
  fallbackSustainedThreshold: 30,
  sustainedSecondaryThreshold: 20,
  sustainedSecondaryMinutes: 2,
  evaluationWindow: CORNER_WINDOWS.ft.shortHorizon,
}

export function isMarket(value: unknown): value is Market {
  return value === 'goals' || value === 'corners'
}

export function parseMarket(value: unknown, fallback: Market = 'goals'): Market {
  return isMarket(value) ? value : fallback
}

export function defaultsFor(
  market: Market = 'goals',
  half: CornerHalf = 'ht',
): AlertSettings {
  const h = parseCornerHalf(half)
  if (market === 'corners') {
    const thresholds = h === 'ft' ? CORNER_FT_THRESHOLDS : CORNER_HT_THRESHOLDS
    return {
      market: 'corners',
      cornerHalf: h,
      ...thresholds,
      ...SHARED_FLAGS,
    }
  }
  const thresholds = h === 'ft' ? GOAL_FT_THRESHOLDS : GOAL_HT_THRESHOLDS
  return {
    market: 'goals',
    cornerHalf: h,
    ...thresholds,
    ...SHARED_FLAGS,
  }
}

export function defaultCornersByHalf(): CornersByHalf {
  return {
    ht: defaultsFor('corners', 'ht'),
    ft: defaultsFor('corners', 'ft'),
  }
}

export function defaultGoalsByHalf(): CornersByHalf {
  return {
    ht: defaultsFor('goals', 'ht'),
    ft: defaultsFor('goals', 'ft'),
  }
}

export function defaultHalves(market: Market): CornersByHalf {
  return market === 'corners' ? defaultCornersByHalf() : defaultGoalsByHalf()
}

export function eventTypeFor(market: Market): number {
  return MARKET_EVENT_TYPE[market]
}

export function marketCopy(market: Market = 'goals') {
  return MARKET_COPY[parseMarket(market)]
}

function kindLabel(kind: RuleKind, s: AlertSettings): string {
  switch (kind) {
    case 'combo':
      return s.market === 'corners'
        ? `Spike${s.spikeThreshold} ∧ (Swing${s.swingComboThreshold} ∨ Sustained${s.sustainedComboMinutes}@${s.sustainedThreshold})`
        : `Spike${s.spikeThreshold} ∧ (Swing${s.swingComboThreshold} ∨ Sustained${s.sustainedComboMinutes})`
    case 'comboFallback':
      return `Spike${s.fallbackSpikeThreshold} ∧ (Swing${s.swingComboThreshold} ∨ Sustained${s.sustainedComboMinutes}@${s.sustainedThreshold})`
    case 'sustained':
      return `Sustained |v|≥${s.sustainedSecondaryThreshold} ×${s.sustainedSecondaryMinutes}`
    case 'sustainedFallback':
      return `Sustained |v|≥${s.fallbackSustainedThreshold} ×${s.sustainedFallbackMinutes}`
    case 'spike':
      return `Spike |v|≥${s.fallbackSpikeThreshold}`
    case 'swing':
      return `Swing |Δ1|≥${s.swingSecondaryThreshold}`
  }
}

export function kindsOf(settings: Partial<AlertSettings> & Pick<AlertSettings, 'market'> | AlertSettings): {
  primary: RuleKind
  secondary: RuleKind
  fallback: RuleKind
} {
  const market = parseMarket(settings.market)
  const defaults = defaultsFor(market, settings.cornerHalf)
  return {
    primary: settings.primaryKind ?? defaults.primaryKind,
    secondary: settings.secondaryKind ?? defaults.secondaryKind,
    fallback: settings.fallbackKind ?? defaults.fallbackKind,
  }
}

export function ruleLabels(
  settings: Pick<AlertSettings, 'market'> & Partial<AlertSettings>,
): Record<RuleId, string> {
  const s = {
    ...defaultsFor(parseMarket(settings.market), settings.cornerHalf),
    ...settings,
  }
  const kinds = kindsOf(s)
  return {
    primary: `Primária · ${kindLabel(kinds.primary, s)}`,
    secondary: `Secundária · ${kindLabel(kinds.secondary, s)}`,
    fallback: `Reserva · ${kindLabel(kinds.fallback, s)}`,
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

export function syncNotifyFlags(
  source: AlertSettings,
  target: AlertSettings,
): AlertSettings {
  return {
    ...target,
    notificationsEnabled: source.notificationsEnabled,
    notifyPrimary: source.notifyPrimary,
    notifySecondary: source.notifySecondary,
    notifyFallback: source.notifyFallback,
  }
}
