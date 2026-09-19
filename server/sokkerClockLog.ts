import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  alertClockProbe,
  goalTransitionOf,
  scoreSnapFromFast,
  type AlertClockProbe,
  type SokkerClockObservation,
} from '../src/lib/clockProbe.ts'
import type { FastScore } from '../src/lib/fastScore.ts'
import type { FeedAlert, Fixture, Market, MomentumPayload } from '../src/lib/types.ts'
import { DATA_DIR } from './config.ts'

const FILE = 'sokker_clock.json'
const CAP = 8_000

type ClockLogFile = {
  updatedAt: string
  items: SokkerClockObservation[]
}

const lastScore = new Map<string, { home: number; away: number }>()
let mem: ClockLogFile | null = null

function pathOf(): string {
  return join(DATA_DIR, FILE)
}

function loadFile(): ClockLogFile {
  if (mem) return mem
  const path = pathOf()
  if (!existsSync(path)) {
    mem = { updatedAt: '', items: [] }
    return mem
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ClockLogFile
    mem = { updatedAt: raw.updatedAt ?? '', items: raw.items ?? [] }
  } catch {
    mem = { updatedAt: '', items: [] }
  }
  return mem
}

function persist(file: ClockLogFile): void {
  mem = file
  mkdirSync(dirname(pathOf()), { recursive: true })
  writeFileSync(pathOf(), JSON.stringify(file, null, 2))
}

export function resetSokkerClockLogForTests(): void {
  lastScore.clear()
  mem = { updatedAt: '', items: [] }
}

export function loadSokkerClockLog(): SokkerClockObservation[] {
  return loadFile().items
}

export function appendSokkerClockObservation(
  row: SokkerClockObservation,
): SokkerClockObservation {
  const file = loadFile()
  file.items.push(row)
  file.updatedAt = row.ts
  file.items = file.items.slice(-CAP)
  persist(file)
  return row
}

/**
 * Cache-only. Records the SokkerPro score each tick and emits a transition
 * when the total rises (prospective ground-truth golo).
 */
export function observeSokkerClock(args: {
  fixture: Pick<Fixture, 'id' | 'team1' | 'team2'>
  fast: FastScore | null
  payload?: MomentumPayload | null
}): SokkerClockObservation {
  const clock = args.payload?.timeline?.at(-1)
  const prev = lastScore.get(args.fixture.id) ?? null
  const next = args.fast ? { home: args.fast.home, away: args.fast.away } : null
  const transition =
    next && args.fast
      ? goalTransitionOf(prev, next, {
          sokkerMinute: args.fast.minute,
          isGoal: args.fast.isGoal,
          isGoalTeam: args.fast.isGoalTeam,
        })
      : null
  if (next) lastScore.set(args.fixture.id, next)
  const row: SokkerClockObservation = {
    ts: new Date().toISOString(),
    fixtureId: args.fixture.id,
    matchLabel: `${args.fixture.team1} vs ${args.fixture.team2}`,
    ssClockMin: clock?.min ?? null,
    ssClockPeriod: clock?.period ?? null,
    matched: Boolean(args.fast),
    fast: scoreSnapFromFast(args.fast),
    prevScore: prev,
    transition,
  }
  return appendSokkerClockObservation(row)
}

export function probeForAlert(
  alert: Pick<FeedAlert, 'market' | 'goalsTally' | 'cornersTally' | 'firedAt'>,
  fast: FastScore | null,
  market: Market,
): AlertClockProbe {
  return alertClockProbe({
    ts: alert.firedAt,
    fast,
    ssGoals: (alert.goalsTally?.home ?? 0) + (alert.goalsTally?.away ?? 0),
    ssCorners: (alert.cornersTally?.home ?? 0) + (alert.cornersTally?.away ?? 0),
    market,
  })
}

export function transitionsForFixture(fixtureId: string): SokkerClockObservation[] {
  return loadSokkerClockLog().filter((row) => row.fixtureId === fixtureId && row.transition)
}
