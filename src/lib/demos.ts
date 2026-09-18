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
