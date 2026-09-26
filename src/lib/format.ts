import type { Fixture, Side } from './types'

const LISBON = 'Europe/Lisbon'

export function lisbonToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LISBON,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function formatKickoff(seconds: number): string {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: LISBON,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(seconds * 1000))
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: LISBON,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (diff < 5) return 'agora'
  if (diff < 60) return `há ${diff}s`
  const min = Math.floor(diff / 60)
  if (min < 60) return `há ${min} min`
  const hours = Math.floor(min / 60)
  return `há ${hours} h`
}

export function sideLabel(side: Side): string {
  return side === 'home' ? 'Casa' : 'Fora'
}

export function periodLabel(period: number): string {
  if (period === 1) return '1.ª parte'
  if (period === 2) return '2.ª parte'
  return `${period}.ª parte`
}

export function minuteLabel(min: number, period: number): string {
  return `${min}' · ${periodLabel(period)}`
}

export function formatSigned(value: number): string {
  if (value > 0) return `+${value}`
  return String(value)
}

export function matchPhase(fixture: Fixture): 'live' | 'finished' | 'upcoming' {
  if (fixture.state === 1) return 'live'
  if (fixture.state === 2 || fixture.status >= 100) return 'finished'
  return 'upcoming'
}

export function phaseLabel(fixture: Fixture): string {
  const phase = matchPhase(fixture)
  if (phase === 'live') {
    if (fixture.liveElapsedSeconds !== null) {
      const minute = Math.max(1, Math.floor(fixture.liveElapsedSeconds / 60) + 1)
      return `${minute}'`
    }
    return 'Ao vivo'
  }
  if (phase === 'finished') return fixture.scoreIsFt ? 'FT' : 'Terminado'
  return formatKickoff(fixture.dateSeconds)
}

export function scoreLabel(home: number | null, away: number | null): string {
  if (home === null || away === null) return '–'
  return `${home}–${away}`
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1).replace('.', ',')}%`
}
