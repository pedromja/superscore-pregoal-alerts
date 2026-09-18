import type { DemoMatch } from './types'

export const DEMO_MATCHES: DemoMatch[] = [
  {
    id: 'celtic-ferenc',
    fixtureId: null,
    team1: 'Celtic',
    team2: 'Ferencváros',
    competition: 'Amostra offline',
    date: '2026-09-17',
    scoreHome: 1,
    scoreAway: 3,
    file: '/demo/celtic-ferenc-momentum.json',
    note: 'Quatro golos. Vários picos coincidem com o minuto do golo — o replay marca-os à parte.',
  },
  {
    id: 'drava-bistrica',
    fixtureId: '34OXUvbRzi05vbQ8FOZsz',
    team1: 'Drava Ptuj',
    team2: 'NK Bistrica',
    competition: 'Taça · 2026-09-16',
    date: '2026-09-16',
    scoreHome: 1,
    scoreAway: 12,
    file: '/demo/drava-bistrica-momentum.json',
    note: 'Caso de treino: o golo fora aos 13\' tem pré-alerta Sustained; o dos 86\' entra por Swing.',
  },
]

export const TRAINING = {
  nMatches: 100,
  nGoals: 737,
  dates: '2026-09-08 → 2026-09-17',
  coincidence: {
    spike70AtGoal: 68.52,
    spike70Pre5: 50.75,
    spike70OnlyAtGoal: 41.11,
  },
  primary: {
    precision: 0.3661,
    recall: 0.3392,
    alertsPerMatch: 6.91,
    fpPerMatch: 4.38,
    medianLead: 1,
    pct1to5: 33.92,
    pct1to3: 27.54,
  },
  secondary: {
    precision: 0.2803,
    recall: 0.3121,
    alertsPerMatch: 7.92,
    fpPerMatch: 5.7,
    medianLead: 2,
    pct1to5: 31.21,
  },
  fallback: {
    precision: 0.3175,
    recall: 0.2592,
    alertsPerMatch: 13.86,
    fpPerMatch: 9.46,
    medianLead: 2.5,
    pct1to5: 25.92,
  },
}

export const TRAINING_CORNERS_HT = {
  nMatches: 95,
  nEvents: 89,
  dates: '2026-09-08 → 2026-09-17',
  window: '35–45',
  coincidence: {
    spike70AtEvent: 21.35,
    spike70Pre5: 47.19,
    spike70OnlyAtEvent: 21.35,
  },
  primary: {
    precision: 0.2403,
    recall: 0.4831,
    alertsPerMatch: 3.811,
    fpPerMatch: 2.895,
    medianLead: 2,
    pct1to5: 48.31,
    pct1to3: 44.94,
  },
  secondary: {
    precision: 0.2353,
    recall: 0.3146,
    alertsPerMatch: 1.789,
    fpPerMatch: 1.368,
    medianLead: 2,
    pct1to5: 31.46,
  },
  fallback: {
    precision: 0.264,
    recall: 0.2809,
    alertsPerMatch: 2.074,
    fpPerMatch: 1.526,
    medianLead: 2,
    pct1to5: 28.09,
  },
}

export const TRAINING_CORNERS_FT = {
  nMatches: 95,
  nEvents: 52,
  dates: '2026-09-08 → 2026-09-17',
  window: '85–90',
  coincidence: {
    spike70AtEvent: 21.15,
    spike70Pre5: 38.46,
    spike70OnlyAtEvent: 21.15,
  },
  primary: {
    precision: 0.1667,
    recall: 0.1346,
    alertsPerMatch: 0.505,
    fpPerMatch: 0.421,
    medianLead: 1.5,
    pct1to5: 17.31,
    pct1to3: 13.46,
  },
  secondary: {
    precision: 0.1312,
    recall: 0.4038,
    alertsPerMatch: 2.326,
    fpPerMatch: 2.021,
    medianLead: 1,
    pct1to5: 42.31,
  },
  fallback: {
    precision: 0.1613,
    recall: 0.0962,
    alertsPerMatch: 0.326,
    fpPerMatch: 0.274,
    medianLead: 2,
    pct1to5: 11.54,
  },
}

export const TRAINING_CORNERS = TRAINING_CORNERS_HT
